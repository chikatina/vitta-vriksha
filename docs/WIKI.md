# Vitta Vriksha Developer Guide

How the app is structured and where to change things. For what the app does from a user's point of view, see the [README](../README.md). For system topology and state machines, see [ARCHITECTURE.md](./ARCHITECTURE.md). For end-to-end feature diagrams, see [FUNCTIONAL_FLOWS.md](./FUNCTIONAL_FLOWS.md).

---

## 1. Core Architecture

Vitta Vriksha is a two-layer, single-process, offline-first personal finance application for Android:

1. **Web Layer (`app/src/main/assets/www/`)**: Pure HTML5, CSS3, and modern ES Modules (ESM). Contains the entire user interface, data visualizations, business arithmetic, SQLite WASM database engine, WebCrypto vault encryption, on-device PDF parsing (pdf.js / casparser.js), and tradebook CSV ingestion.
2. **Native Shell (`app/src/main/java/com/chikatistudio/vittavriksha/`)**: Lightweight Kotlin wrapper that hosts the WebView, brokers device biometrics (BiometricPrompt), system permissions, file bytes, the incoming SMS/notification queue (`AlertQueue`), and OS reminder alarms (`AlarmManager`).

There is **zero network access** and no internet permissions in `AndroidManifest.xml`. Everything is computed and persisted locally on-device.

---

## 2. Directory Layout

```
app/src/main/
  assets/www/
    index.html                 App shell markup, deliberately minimal
    css/style.css              Design tokens, layout, and component stylesheets
    fonts/                     Subsetted Material Symbols Outlined font (woff2)
    vendor/                    Bundled dependencies (sqlite.wasm, pdf.js, casparser.js, isin.db)
    js/
      app.js                   Router, lifecycle state machine, and chrome controller
      bridge.js                Bridge interface connecting UI to backend and native shell
      ui.js                    Toasts, dialogs, sheets, and icon helper
      charts.js                Pure SVG charts with pinch-to-zoom and gestures
      formatters.js            Indian and standard currency/date formatting
      icon-codepoints.js       Generated codepoints mapping, do not edit manually
      brand-mark.js            Generated SVG brand mark, do not edit manually
      views/                   View renderers (home, ledger, budgets, investments, tax, etc.)
      views/widgets.js         Dashboard widget catalogue and layouts
      backend/                 Pure ES Module backend handlers
        index.js               Action router dispatching calls to module handlers
        database.js            SQLite schema, migrations, CRUD queries, aggregations
        vault.js               Encrypted database file vault, master key lifecycle
        crypto.js              WebCrypto PBKDF2 key derivation and AES-GCM encryption
        tax_engine.js          Statutory FIFO capital gains, Section 112A, Budget 2024
        wealth_intel.js        Tax harvesting, portfolio rebalancer, yield, real returns
        debt_planner.js        Avalanche vs Snowball, home loan part-payment, DTI ratio
        cashflow.js            Safe-to-spend, runway trajectory, salary checklist
        sms.js                 SMS/notification batch classifier and parser
        broker_parser.js       Tradebook CSV parser (Zerodha, Groww, Upstox, etc.)
        reminders.js           Instalment, renewal, and check-in reminder scheduler
        isin.js                Mutual fund and stock ISIN resolution and caching
        errors.js              Standardized error code registry and hints
  java/com/chikatistudio/vittavriksha/
    MainActivity.kt            WebView setup, asset loader, insets, back press, lifecycle
    WebAppInterface.kt         The @JavascriptInterface bridge surface
    BiometricHelper.kt         BiometricPrompt fingerprint & face authentication
    AlertQueue.kt              SharedPreferences-backed queue for incoming alerts
    SmsReceiver.kt             Broadcast receiver for financial SMS alerts
    TransactionNotificationListener.kt  Notification listener service for payment apps
    ReminderReceiver.kt        Broadcast receiver for scheduled reminder alarms
    ReminderNotificationManager.kt  System notification builder for reminders & alerts
tools/                         Python generators & Node linters (fonts, icons, style checks)
test/                          Node test harness and comprehensive backend test suites
```

---

## 3. The Bridge Interface

All communication between views and backend actions flows through `js/bridge.js`:

```javascript
// Database queries & mutations
const res = await Bridge.db(action, args);

// Domain module dispatches (e.g. sms, reminders, cas)
const res = await Bridge.call(moduleName, args);
```

On the native side, `WebAppInterface.kt` exposes only the minimal capabilities Web APIs cannot perform alone:
- Biometric authentication (`authenticateBiometric`)
- Persistent encrypted database storage (`readDatabase`, `writeDatabase`)
- Permission requests and status checks (`requestPermission`, `checkPermission`)
- System alarm scheduling (`scheduleReminder`, `cancelReminder`)
- File sharing and downloads (`saveFile`, `shareFile`)
- Background bank alerts draining (`takePendingAlerts`)

### Standardized Error Handling

Every failure returns a structured object with a registered error code and actionable user hint from `js/backend/errors.js`:

```json
{
  "status": "error",
  "code": "BACKUP_DECRYPT_FAILED",
  "message": "Could not decrypt backup file. Please check the password.",
  "hint": "Make sure you entered the exact password used when creating the backup."
}
```

Render failures in the UI using `errorBlock(res)` from `js/ui.js` to expose hints and error codes to the user.

---

## 4. Database & Vault Security

1. **Vault Encryption (`vault.js` & `crypto.js`)**:
   - The SQLite database file is encrypted on disk with AES-256-GCM.
   - Master data key is wrapped using a PBKDF2-derived key (120,000 iterations) from the user's PIN.
   - Changing PIN only requires re-wrapping the 32-byte master key without re-encrypting the entire database.
2. **Encrypted Backups**:
   - Backup files (`.vittavriksha`) are encrypted with AES-256-GCM using PBKDF2 (600,000 iterations).
   - Restores insert tables in strict topological order (`BACKUP_TABLES`) with foreign key validation.
3. **Database Schema & Migrations (`database.js`)**:
   - Schema definitions are in `initDb(db)`.
   - All schema evolutions must be additive to maintain backwards compatibility.

---

## 5. Development & Testing Commands

- **Run all automated tests**:
  ```bash
  npm test
  # or ./scripts/dev test
  ```
- **Check style & architectural guidelines**:
  ```bash
  npm run lint
  # or node tools/check-style-guidelines.mjs
  ```
- **Check local toolchain (Java, Android SDK, Node)**:
  ```bash
  ./scripts/dev doctor
  ```
- **Build and run debug build on connected Android device**:
  ```bash
  ./scripts/dev run
  ```
- **Build release APK**:
  ```bash
  npm run build:release
  ```

---

## 6. Coding & Style Rules (AGENTS.md)

1. **Zero Third-Party JavaScript**: No npm packages in runtime `js/`. Bundled vendor scripts reside only in `vendor/`.
2. **No Emojis Anywhere**: Use `icon(name, className)` with Material Symbols Outlined.
3. **Never Use Native `<select>`**: Use `selectField()` and `bindSelectFields()` from `ui.js`.
4. **Never Use `alert()`, `confirm()`, or `prompt()`**: Use `showDialog()`, `showToast()`, `showSheet()`.
5. **Always Format Currency**: Format money using `formatCurrency(val)` from `formatters.js`.
6. **Z-Index 9XX Rule**: Dropdowns and pickers must use `--z-menu` (999) and `--z-menu-scrim` (990).
