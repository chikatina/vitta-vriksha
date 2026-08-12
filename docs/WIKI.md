# Vitta Vriksha developer guide

How the app is put together and where to change things. For what the app does from a
user's point of view, see the [README](../README.md).

## 1. The one rule

The Kotlin layer is a shell. It hosts a WebView, brokers biometrics and permissions, and
carries one JSON string each way. Nothing decides anything there.

Everything the user sees lives in `app/src/main/assets/www`. Everything that computes or
persists lives in `app/src/main/python`. When you are unsure where something belongs, ask
which of those two it is, and put it there.

## 2. Layout

```
app/src/main/
  assets/www/
    index.html                 app shell markup, deliberately almost empty
    css/style.css              design tokens and every component style
    fonts/                     subsetted Material Symbols
    js/
      app.js                   router, shared state, theme
      bridge.js                the only place that talks to Kotlin
      ui.js                    toasts, dialogs, sheets, icon helper
      charts.js                SVG charts
      formatters.js            money and dates
      icon-codepoints.js       generated, do not edit
      brand-mark.js            generated, do not edit
      views/                   one module per screen
      views/widgets.js         dashboard widget catalogue
  java/org/chikatistudio/vittavriksha/
    MainActivity.kt            WebView setup, asset loader, insets
    WebAppInterface.kt         the @JavascriptInterface surface
    BiometricHelper.kt
    SmsReceiver.kt
    TransactionNotificationListener.kt
    ReminderNotificationManager.kt
  python/
    database_manager.py        schema, migrations, every CRUD action
    sms_rule_engine.py
    fire_calculator.py
    loan_optimizer.py
    reminder_engine.py
    cas_parser_bridge.py
    test_backend.py
tools/                         generators: font subset, icon map, brand mark, PNGs
```

## 3. The bridge

One method carries everything:

```js
Bridge.invokePython(module, functionName, argsObject)   // -> parsed JSON
Bridge.db(action, args)                                 // shorthand for database_manager
```

On the Python side, an entry point takes one JSON string and returns one JSON string:

```python
def handle_db_action(json_args_str: str) -> str:
    ...  # {"status": "success", ...} or a coded error, see below
```

Do not add a method to `WebAppInterface` for something a Python action can do. The
JavaScript interface is an attack surface and a versioning problem; the action table is
neither. The exceptions are things Python cannot reach: biometrics, permissions and system
settings.

Permissions are asynchronous in a way that is easy to get wrong. The system dialog outlives
the call that opened it, so `Bridge.requestPermission(name)` returns a promise that
`MainActivity.onRequestPermissionsResult` settles through `window.onPermissionResult`. Do
not poll on a timer. `permissionIsBlocked(name)` reports "don't ask again", where the right
move is `openAppSettings()` rather than asking again pointlessly. `window.onAppResumed`
fires on return from the background, which is when a permission changed in system settings
becomes visible.

`app.db(action, args)` wraps `Bridge.db` and turns an error reply into a toast, returning
`null`. Most view code should use it and check for `null`.

### Error codes

Every failure carries a stable code from `app/src/main/python/errors.py` alongside the
human message, and often a hint saying what to do about it:

```json
{"status": "error", "code": "CAS_UNREADABLE_LAYOUT",
 "message": "The PDF opened, but the statement was not laid out the way this parser expects.",
 "hint": "Ask CAMS or KFintech for a DETAILED statement rather than a summary...",
 "detail": "CASParseError: Unable to parse investor data", "backend": "pdfminer"}
```

The message is for a person and may be reworded at any time. The code is for the app and
for a bug report, and does not change. Build replies with `fail(code, message, hint,
**extra)`; an unregistered code is turned into `INTERNAL` with a loud message rather than
reaching a user blank, and a test asserts every call site uses a registered one.

`errorBlock(res)` in `ui.js` renders the message, the hint, the code as a chip and any raw
`detail`, so a user can quote the code. `app.db()` logs the code even when it only toasts
the message, which keeps "it said that did not work" traceable in logcat. The browser mock
in `bridge.js` returns the same codes, so the UI can be exercised against real error shapes.

Only CAMS and KFintech statements can be imported. The reason is a closed loop, and it was
measured rather than assumed:

| casparser | NSDL reader | pydantic | installable here |
| --- | --- | --- | --- |
| 0.4.2 (what ships) | no | none | yes |
| 0.6.x | no | v1 | yes |
| 0.7.4 | no | v2 | no |
| 0.8.0 and later | yes | v2 | no |

pydantic v2 needs `pydantic-core`, a Rust extension, and pip reports it has "no matching
distributions available for your environment". So every version that can read NSDL cannot be
installed, and every version that installs cannot read NSDL.

Verify what ships by unzipping `assets/chaquopy/requirements-common.imy` out of the APK
rather than trusting a local `pip show`. A development machine with 0.8.x installed will
happily import `process_nsdl_text`, `NSDLCASData` and `FileType.NSDL`, none of which exist on
device, and the crash only appears in the app. A test asserts the bridge references none of
them.

Two findings for anyone revisiting this: Chaquopy offers Python 3.12 for arm64-v8a and
x86_64 only, and `pypdfium2` has an Android wheel. A purpose-written NSDL reader on
pypdfium2, bypassing casparser entirely, is the one route that could work.

The statement importer runs a pre-flight before casparser sees the file.
`_preflight` extracts the first few pages with pdfminer, scores the text against the
markers in `STATEMENT_MARKERS`, and refuses what cannot work: a depository statement
(`CAS_DEPOSITORY_UNSUPPORTED`) or a PDF with no text layer (`CAS_NO_TEXT_LAYER`). Scoring
beats first-match because an NSDL statement can carry a camsonline URL, and a tie goes to
the depository, since misreading that direction is what produces a misleading error.

The `diagnose` action reports what a file looks like without importing it: issuer, whether
it looks like a mutual fund statement, how much text it has, the backend in use, and a
sample with digits, PANs and email addresses stripped. The CAS screen offers it after a
failed import so a user can send back something actionable.

The classification below is where this earns its keep. casparser signals most failures by
message text rather than exception type, so `cas_parser_bridge._classify` maps each known
message to a code and an actionable hint. `CAS_UNREADABLE_LAYOUT`, from casparser's
"Unable to parse investor data", is the common one: the PDF opened, so the password was
right, but the layout heuristics did not find the investor block. That usually means a
summary rather than a detailed statement, a depository (NSDL or CDSL) statement rather than
a CAMS or KFintech one, or a scanned PDF with no text layer. The reply also reports which
PDF backend is in use, since casparser's pdfminer fallback refuses depository statements
outright and PyMuPDF is not currently in the build.

### Adding an action

1. Write `_my_action(cursor, args)` in `database_manager.py`. Return a dict. Return
   `fail(code, message, hint)` to fail, which rolls the transaction back.
2. Register it in the `ACTIONS` table.
3. Add a branch to the mock in `bridge.js` so the browser workflow keeps working.
4. Add a test.

## 4. Records

Accounts, loans, cards, subscriptions, SIPs, goals and events all share one code path.
Python declares each type in `RECORD_TYPES` as a table, its writable columns and an
ordering. JavaScript declares each in `RECORD_CONFIG` in `views/records.js` as a set of
form fields and how a row reads.

Adding a new kind of record means adding two config entries. It does not mean writing a
screen. Columns not in the declared list are ignored on save, so a client cannot write to
anything it was not given.

## 5. The dashboard

Home is assembled from `views/widgets.js`. Each catalogue entry declares:

```js
my_widget: {
  label, description, icon,      // shown in the layout editor
  needs: ['summary', 'series:spend_by_category'],
  pinned: true,                  // cannot be removed
  needsFamily: true,             // only offered when household mode is on
  render(data, app) { ... },     // return '' to stay hidden
  bind(node, data, app) { ... }, // optional, after the markup is in the document
}
```

Home collects the union of every `needs` and fetches each one once, so ten widgets do not
mean ten copies of the same query. The layout lives in the `home_widgets` setting as a JSON
array of ids; an empty or corrupt value falls back to `DEFAULT_LAYOUT`.

Chart data comes from one action:

```
get_series { metric, months, member_id }
  -> { buckets: ['2026-03', ...], series: [{ key, label, color|role, values: [...] }],
       stacked: bool, empty: bool }
```

Every metric returns that shape, which is why a stacked bar, a grouped bar and a line can
all consume it. Adding a chart is usually a new metric in `_get_series` plus a catalogue
entry, not new plumbing. A series carries either an explicit `color` or a semantic `role`
(`income`, `expense`, `accent`) that the chart maps to a design token.

There is deliberately no charting library. Perspective and its peers ship a WASM runtime
and expect a CDN or a bundler; this app has neither, and no INTERNET permission to fetch one
with. The charts are SVG drawn against aggregates SQLite already computes.

## 6. Navigation

Five destinations, defined in `TABS` in `app.js`: Home, Ledger, Budgets, Wealth, More.
Anything else is a sub-page listed in `PAGES`, which declares its parent tab so the back
button and the highlighted destination stay consistent. Sub-pages are reached with
`app.open('pageId')` and rendered into the same container.

The floating button adds a transaction and hides on More.

## 7. Styling

Everything is driven by custom properties on `<html data-appearance data-accent>`.
Appearance is `light` or `dark`, resolved from `system` at runtime. Accent is one of five
ramps. A component should never hard-code a colour; use the role tokens (`--surface`,
`--on-surface-variant`, `--accent-container`, `--income`, `--expense`).

New markup gets a class in `style.css`. Inline `style=` is used only for values that are
genuinely dynamic, such as a category colour or a bar width.

## 8. Icons

Material Symbols Outlined, bundled rather than fetched, because the app has no network
permission. The full variable font is about 3.9 MB, so `tools/subset-material-symbols.py`
cuts it to the icons actually used, currently around 10 KB.

Icons are addressed by codepoint, not by the usual ligature. Material Symbols performs
name-to-glyph substitution through contextual `rlig` lookups, and those cannot survive a
subset without pulling every icon in the font along with them. The script generates
`js/icon-codepoints.js` so calling code still reads `icon('home')`.

To use an icon that is not bundled yet, add its name to `NAMES` in the script and re-run
it. An unknown name logs a console warning and falls back to a help glyph rather than
rendering an invisible box.

The app's own mark is not an icon from the font. `tools/generate-brand-mark.py` converts
`res/drawable/ic_launcher_foreground.xml` into `js/brand-mark.js`, so the mark on the lock
screen, in setup and on About is the same drawing as the launcher icon. Re-run it after
changing the launcher foreground, and re-run `generate-legacy-launcher-icons.py` too.

## 9. Security

**PIN.** Stored as a PBKDF2-SHA256 hash with a random salt, 120,000 iterations. The hash
never leaves Python: `get_settings` filters `pin_hash` out of its reply, and
`update_setting` refuses to write it. Verification goes through the `verify_pin` action.
Changing or clearing a PIN requires the current one.

**Backups.** AES-GCM with a 256-bit key derived from the user's password through PBKDF2
at 600,000 iterations. A restore only touches tables in `BACKUP_TABLES`, so a crafted
backup file cannot name an arbitrary table.

**Foreign keys.** `BACKUP_TABLES` is in topological order. Insert in that order and delete
in reverse, and constraints hold at every statement. This is why a restore is not simply a
loop over whatever keys the file happens to contain.

**Backups off the device.** `allowBackup` is false and `data_extraction_rules.xml`
excludes everything, so Android's own cloud backup and device transfer never copy the
database. The encrypted export is the only way data leaves.

**WebView.** Assets are served by `WebViewAssetLoader` over
`https://appassets.androidplatform.net/assets/www/`, not `file://`, which keeps the
origin opaque and file access off. Use relative paths.

## 10. Working on the UI without Gradle

Serve `app/src/main/assets/www` over any static server and open it. `bridge.js` detects
the missing `AndroidBridge` and falls back to a localStorage mock covering every action,
so the whole app is clickable. Keep the mock current when you add an action, or the
browser workflow rots.

Biometrics, permissions and CAS parsing are the parts that genuinely need a device.

## 11. Tests

```
python app/src/main/python/test_backend.py
```

Each test gets its own temporary database. Tests cover the PIN lifecycle, split and
cashback arithmetic, the record CRUD surface including its rejection of unknown record
types, the backup round trip and its failure modes, and the migrations that convert an
older install's plaintext PIN and emoji category icons.

## 12. Conventions

- No third-party JavaScript, no bundler, no build step for the web layer.
- No emoji anywhere: UI, code, comments, commits, docs.
- No `alert`, `confirm` or `prompt`. Use `ui.js`.
- Money renders through `formatCurrency`, never raw.
- Schema changes go in `init_db` and must be additive, so existing installs migrate.
- Python actions always return a status. JavaScript always handles the error branch.
