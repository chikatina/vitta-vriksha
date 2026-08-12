# Moving the backend from Python to JavaScript

Status: done. Every phase below has been implemented, including the two that were listed
as later work. What follows is the plan as it was written, with the measured outcome at
the end.

The headline: the debug build went from **74.9 MB uncompressed to 23.7 MB**, which is
10.1 MB on disk and 4.2 MB once the release build has shrunk the resources. All four
statement issuers now import, including the two that never worked.

This replaces the Chaquopy and Python layer with JavaScript running in the WebView that
already hosts the UI. It removes about 59 MB from the APK, deletes a class of dependency
problem that has already cost real time, and makes an iOS build a shell rather than a second
backend.

---

## 1. Why

### The measured cost

Composition of the current debug APK, uncompressed:

| Component | Size | Share |
| --- | --- | --- |
| Chaquopy and the Python runtime | 59.4 MB | 79.4% |
| Our Kotlin plus androidx | 12.9 MB | 17.2% |
| Android resources | 2.2 MB | 3.0% |
| Our web UI | 0.2 MB | 0.3% |
| Everything else | 0.1 MB | 0.1% |
| **Total** | **74.9 MB** | |

Now compare that against what Python is actually used for:

| Job | Lines of Python | Android already provides |
| --- | --- | --- |
| SQLite schema, migrations, CRUD, aggregates | 1197 | SQLite, built in |
| Backup encryption, PIN hashing | (inside the above) | `javax.crypto`, WebCrypto |
| Retirement and prepayment arithmetic | 149 | any language |
| SMS rule matching | 120 | any regex engine |
| Error codes | 74 | any language |
| Reminders | 83 | `AlarmManager` |
| Statement parsing | 484 | nothing: needs a library |

Only the last row genuinely needs a library, and it is the one that does not work.

### The dependency dead end

Statement import cannot be fixed inside this architecture. Measured, not assumed:

| casparser | NSDL reader | pydantic | installable on Chaquopy |
| --- | --- | --- | --- |
| 0.4.2 (what ships today) | no | none | yes |
| 0.6.x | no | v1 | yes |
| 0.7.4 | no | v2 | no |
| 0.8.0 and later | **yes** | v2 | no |

Every release able to read NSDL requires pydantic v2, which requires `pydantic-core`, a Rust
extension. pip's verdict, verbatim:

```
some packages in these conflicts have no matching distributions available
for your environment: pydantic-core
```

`pydantic-core` is absent from all 127 recipes in Chaquopy's package repository, and
`https://chaquo.com/pypi-13.1/pydantic-core/` returns 404. The upstream recipe that would
add it, [chaquo/chaquopy#1413](https://github.com/chaquo/chaquopy/pull/1413), is open and
unmerged.

So the choice is not "Python or JavaScript". It is "own the statement parser, or do not have
one". Once we own the parser, Python's only irreplaceable job is gone, and it is paying
59 MB for nothing.

### Why JavaScript rather than Kotlin

Kotlin is the conventional answer and it is the wrong one here.

The UI is already HTML, CSS and ES modules in a WebView. Putting the logic in the same
language as the UI removes a serialisation boundary rather than moving it. More decisively:
a Kotlin backend has to be written a second time in Swift for iOS, including the statement
parser, which is the hardest and most fragile part. A JavaScript backend is written once.

| | JavaScript in the WebView | Kotlin |
| --- | --- | --- |
| Runs on iOS unchanged | yes, WKWebView | no, port to Swift |
| Statement parser written | once | twice |
| Native code in the app | none | SQLite bindings, PDF library |
| APK | about 17 MB | about 17 MB |
| ABI-specific builds | none needed | none needed |
| SQLite durability | in memory, file persisted through a bridge | native, direct |
| Typing | none by default | static |

Kotlin wins on two points: SQLite is used directly rather than exported as bytes, and the
compiler catches more. Neither outweighs writing the whole backend, parser included, twice.

There is a smaller benefit worth naming: `bridge.js` currently carries a 594 line
hand-written mock of the Python layer so the UI can be opened in a browser. When the backend
is JavaScript, the real backend runs in the browser and the mock is deleted. One
implementation, exercised the same way everywhere.

---

## 2. Evidence

Each of the three assumptions this plan rests on was tested in the Chromium build that
Android's WebView uses. Anyone revisiting this should not have to re-derive them.

### WebCrypto replaces the `cryptography` package

| Measurement | Result |
| --- | --- |
| PBKDF2-SHA256, 120,000 iterations (the PIN hash) | 25 ms |
| PBKDF2-SHA256, 600,000 iterations (the backup key) | 130 ms |
| AES-GCM encrypt, 4 KB payload | under 1 ms |
| Decrypt round trip correct | yes |

This is native and hardware-accelerated, not JavaScript arithmetic, and it is faster than
the Python path. It produces the same salt(16) plus nonce(12) plus ciphertext layout the
current code writes, so **existing encrypted backups stay readable**.

### pdf.js reads encrypted statements and reports positions

| Measurement | Result |
| --- | --- |
| Text extracted from a plain PDF | yes |
| Text extracted from a password protected PDF | yes |
| Per-item positions available | yes, `transform[4]` and `transform[5]` |
| Size | 720 KB plus a 1848 KB worker |

Positions matter: a statement is a table, and reconstructing rows needs coordinates. This is
the same information pdfminer's text boxes provide, which is what the current issuer
detection already relies on.

### SQLite WASM runs the real schema

Tested against a slice of the actual schema, foreign keys included:

| Measurement | Result |
| --- | --- |
| SQLite version | 3.50.4 |
| 5,000 transaction inserts in one transaction | 128 ms |
| The dashboard's group-by aggregate | 11 ms |
| Foreign keys enforced | yes |
| Whole database exported to bytes | 1 ms, 376 KB |
| Restored from those bytes | all 5,000 rows |
| Works without COOP or COEP headers | yes |

That last row matters: `WebViewAssetLoader` cannot set those headers, so the threaded build
would have been unusable. The plain build needs neither.

**The database file format does not change.** SQLite is SQLite, so an existing install's
file opens directly. No data migration, no export and reimport, no risk to anyone's records.

---

## 3. Target architecture

Today:

```
assets/www          HTML, CSS, ES modules            all UI
      |             window.AndroidBridge
Kotlin              WebView, biometrics, permissions thin shell
      |             Chaquopy, 59.4 MB
Python + SQLite     logic and persistence            everything that decides
```

After:

```
assets/www          HTML, CSS, ES modules            UI and all logic
      |             SQLite WASM, pdf.js, WebCrypto   in process, no native code
      |             window.NativeBridge
Kotlin (or Swift)   file bytes, biometrics, permissions, notifications, SMS
```

The native surface shrinks to what a browser genuinely cannot do:

| Native method | Why |
| --- | --- |
| `readDatabase()` returns bytes | durable app-private storage |
| `writeDatabase(bytes)` | the same |
| `authenticateBiometric()` | platform API |
| `checkPermission`, `requestPermission`, `openAppSettings` | platform API |
| `scheduleReminder`, `cancelReminder` | `AlarmManager`, `UNUserNotificationCenter` |
| SMS receiver hands text to JS | Android only, no iOS equivalent |

Six methods and one receiver, versus the current bridge plus an embedded language runtime.

### Persistence design

SQLite WASM holds the database in memory and the file is persisted through the bridge.

Reasons: it keeps the existing file, in the existing app-private location, with the existing
`allowBackup=false` and `data_extraction_rules.xml` exclusions. It avoids the Origin Private
File System, which WKWebView only supports from iOS 17. And it keeps the durability
guarantee where it already is, in native storage, rather than in a WebView-managed store
that the OS may evict under pressure. IndexedDB was rejected for exactly that reason: it is
not an acceptable home for the only copy of someone's financial records.

The cost is that a save rewrites the whole file. Measured at 1 ms to export 376 KB for 5,000
transactions, so the write is dominated by the file I/O and is fine at this scale. Saves are
debounced and happen after a write action, not on a timer.

If the database ever outgrows that, the upgrade path is OPFS with a native fallback, decided
then rather than now.

---

## 4. Phases

Each phase leaves the app working. Python and JavaScript run side by side until phase 6, so
there is no window where the app is broken.

### Phase 1: foundation

- `tools/vendor-libs.py` downloads SQLite WASM and pdf.js into `assets/www/vendor`. Written
  already; the payload is regenerated with one command.
- `js/backend/sqlite.js`: open from bytes, run SQL, export, debounced persist.
- Kotlin `readDatabase` and `writeDatabase` on the bridge, reading and writing the same
  `filesDir/vittavriksha.db` Python uses.
- In a browser, fall back to localStorage for the bytes so the UI still runs offline.

Deliverable: JavaScript can open the database the Python layer created and read from it.

### Phase 2: the data layer

Port `database_manager.py`, 1197 lines, to `js/backend/database.js`.

Mostly mechanical: the SQL strings carry over verbatim and the action table keeps its shape.
`Bridge.db(action, args)` keeps its signature, so **no view code changes**. Schema and
migrations are translated as they stand, not redesigned.

### Phase 3: crypto

PIN hashing and backup encryption move to WebCrypto, byte-compatible with the current
format. Verified by decrypting a backup produced by the Python build.

### Phase 4: calculators

`fire_calculator.py`, `loan_optimizer.py`, `sms_rule_engine.py`, `errors.py`. 343 lines of
arithmetic and regex, no dependencies.

### Phase 5: the statement parser

This is the phase with real unknowns, and the reason any of this is worth doing.

Our own reader on pdf.js: extract positioned text, group it into rows, and match the tables.
CAMS and KFintech first, since those work today and give a regression baseline. NSDL after,
which is the format that has never worked.

Needs a real NSDL statement to develop against. The `diagnose` action already returns a
redacted structural sample, with digits flattened and PAN and email addresses stripped, that
is safe to share. Writing the layout patterns without one produces something that looks
finished and is not.

Where possible, extend to demat equities, which the CAMS path cannot see at all.

### Phase 6: remove Chaquopy

Delete the plugin, `app/src/main/python`, `buildPython`, and the `abiFilters` block. The app
then contains no native code of its own, so one universal APK serves every device and the
Python 3.12 and 3.13 64-bit restriction stops mattering.

Expected: 74.9 MB to about 17 MB.

Also delete the 594 line mock in `bridge.js`.

### Phase 7: tests

Port the 77 tests in `test_backend.py`, 844 lines, to a Node-based runner. The modules are
plain ESM with no DOM dependency, so they run under `node --test` directly. The existing
tests are the specification: port them first and let them fail, then make them pass.

### Phase 8: iOS, later and separately

A WKWebView shell plus the six native methods. Out of scope for this plan, but the reason
for choosing JavaScript, so it should not be quietly dropped.

---

## 5. Risks

| Risk | Handling |
| --- | --- |
| WASM unavailable in an old WebView | WASM has been in Chromium since 2017 and WebView updates through Play. Detect at startup and show a clear message rather than failing obscurely. |
| Whole-file writes do not scale | Measured fine at this size. Debounce writes. OPFS is the escape hatch if it ever matters. |
| A partial write corrupts the database | Write to a temporary file and rename, so a failed save leaves the previous file intact. |
| Statement parsing is harder than expected | It already does not work. Phase 5 can slip without regressing anything, and CAMS is done before NSDL so there is a baseline. |
| Third-party JavaScript in a project that forbids it | Deliberate, documented exception for two libraries nobody should reimplement. The convention in `CLAUDE.md` gets an explicit carve-out naming them. |
| A silent behaviour change during the port | The 77 tests are the contract. Port them first. |
| No rollback | Python stays in the tree until phase 6, and phase 6 is one commit that can be reverted. |

## 6. What does not change

Worth being explicit, because the change sounds larger than it is:

- The database file and its schema. An existing install opens as it is.
- The backup format. Existing encrypted exports still restore.
- The action API, `Bridge.db(action, args)`, so every view keeps working.
- The UI. Not one screen changes.
- The privacy posture: no INTERNET permission, `allowBackup=false`, PIN stored as a hash,
  nothing leaving the device except an export the user asks for.

## 7. The open questions, answered

1. **An NSDL statement to develop against.** Not needed in the end, and the reason is
   worth recording. Rather than writing layout patterns against a sample, the parser was
   ported from `casparser`, whose NSDL and CDSL readers are the product of years of
   working against real files. The port carries their heuristics across intact and, more
   to the point, carries their tests across too: the corner cases those tests describe are
   the sample.

2. **iOS timing.** Someday, so a few Android conveniences were taken. The alarm clock is
   `AlarmManager`, bank alerts come from a broadcast receiver and a notification listener,
   past messages are read from the system inbox, and an export goes out through the share
   sheet. None of them is load-bearing: each is one method on the bridge with a JavaScript
   fallback, and an iOS shell that implements none of them still runs everything else.

3. **Scope of phase 5.** Everything. Mutual funds from all four issuers, demat equities,
   bonds, and National Pension System holdings, plus the capital gains report the
   transaction history makes possible. Three new tables hold what a registrar statement
   never had: `demat_holdings`, `nps_holdings`, and the reference data behind them.

4. **Reminders.** Ported, and wired up rather than left dormant. The engine decides what is
   due, which is arithmetic on dates and belongs in JavaScript, and hands the result to
   `AlarmManager`, which is the only part that has to outlive the process.

## 8. What was actually built

| | Before | After |
| --- | --- | --- |
| Debug APK, uncompressed | 74.9 MB | **23.7 MB** |
| Debug APK, on disk | | **10.1 MB** |
| Release APK, on disk | | **4.2 MB** |
| Native code | Python runtime for four ABIs | none |
| Build needs | JDK, SDK, Python on PATH | JDK, SDK |
| Statement issuers | CAMS, KFintech | CAMS, KFintech, NSDL, CDSL |
| Demat holdings | not readable | shares, bonds, exchange-traded funds |
| Pension holdings | not readable | read |
| Capital gains | none | first in first out, Schedule 112A, quarterly split |
| Backend tests | 77, Python | 90, `node --test` |
| Parser tests | none of our own | 201, in the parser's own repository |

Where the 10.1 MB goes:

| Component | In the APK |
| --- | --- |
| Our Kotlin plus androidx | 4.9 MB |
| Android resources | 1.8 MB |
| Scheme reference database | 1.5 MB |
| SQLite WASM | 0.9 MB |
| pdf.js | 0.6 MB |
| Our web layer | 0.1 MB |
| Statement parser | 0.1 MB |

Two things worth noting against the plan. The estimate was about 17 MB; it came in lower
because dropping the Python runtime also dropped what it pulled in around itself. And the
reference database is new: 1.5 MB buying the scheme codes, types and 2018 valuations that
no statement prints, which is what makes both the demat enrichment and the capital gains
report possible.

### Two things the plan did not anticipate

**The asset loader's content types.** `WebViewAssetLoader` guesses a type from the file
extension and falls back to plain text. A module served as plain text is refused outright
by the engine, and WebAssembly served as plain text drops to a slower compile path. The
app would not have started at all. `MainActivity.withCorrectedMimeType` fixes it, and the
note in `CLAUDE.md` exists so nobody deletes it.

**Where the reference database lives.** It cannot go in the user's own file. A save
rewrites the whole file, and five megabytes of static reference data rewritten on every
transaction would have made every write expensive for no reason. It is a second database,
opened read-only from the assets and never written back.

### The parser

`casparser-js` is its own repository, because it is useful on its own and because its 201
tests have nothing to do with this app. It is a port of `casparser` and `casparser-isin`,
by Sandeep Somasekharan, with two deliberate differences: the PDF reader is pdf.js rather
than PDFium, and the indexation branch for debt schemes now fires, which upstream's
comparison against an enumeration member had made unreachable.

It carries its own decimal type rather than depending on one. Money is the whole subject,
binary floating point cannot hold `0.1`, and the ported arithmetic is scale-sensitive
throughout, so the rules had to match Python's `decimal` module rather than approximate
it.
