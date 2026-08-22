# Vitta Vriksha - AI Coding & Style Guidelines (AGENTS.md)

This document contains mandatory guidelines, architectural rules, and UI/UX constraints that all AI coding assistants and agent frameworks must strictly follow when working on Vitta Vriksha.

---

## 1. Core Architecture & Stack

- **Architecture**: Two-layer, single-process offline-first Android application.
  - **Web Layer (`assets/www/`)**: Pure HTML + CSS + ES Modules. Contains all UI, business logic, SQLite WASM, pdf.js, WebCrypto.
  - **Native Shell (`app/src/main/java/.../WebAppInterface.kt`)**: Kotlin shell handling biometrics, file bytes, permissions, SMS receiver, alarms.
- **Backend Routing**: `js/backend/index.js` routes action names and plain payload objects to handlers and returns plain objects.
- **Bridge Pattern**: Views only communicate with the backend via `js/bridge.js` (`Bridge.db(action, args)` for SQLite and `Bridge.call(module, args)` for other modules).
- **Offline & Zero Network**: No network permissions. Everything is computed and stored on-device.

---

## 2. Non-Negotiable Coding Conventions

- **No Third-Party JavaScript**: Do not add npm packages, CDN scripts, or external JS in `js/`. The only bundled dependencies live in `assets/www/vendor/` (`sqlite.wasm`, `pdf.js`, `casparser.js`, `isin.db`).
- **No Build / Bundler Step**: The web layer is pure ESM served by `WebViewAssetLoader`. Do not introduce Webpack, Vite, or Babel.
- **No Emojis Anywhere**:
  - Never use emojis in UI, code, comments, commit messages, or documentation.
  - All icons must use `icon(name, className)` from `assets/www/js/ui.js` mapped in `assets/www/js/icon-codepoints.js`.
- **Currency & Money Formatting**:
  - Never render raw numbers for currency.
  - Always format money using `formatCurrency(val)` from `assets/www/js/formatters.js`.
- **Form Controls & Dropdowns**:
  - **Never use `<select>` elements**: Native dropdowns in WebView ignore theme styling.
  - Always use `selectField()` and `bindSelectFields()` from `assets/www/js/ui.js`.
  - Never use `alert()`, `confirm()`, or `prompt()`. Use `showDialog()`, `showToast()`, and `showSheet()` from `ui.js`.
- **Error Handling**:
  - Backend actions return `{status: "success", ...}` or fail with `fail(code, message, hint)` from `errors.js`.
  - Register any new error code in `errors.js` first.
  - Render failures in UI using `errorBlock(res)` so hints and error codes are visible to the user.
- **Database Migrations & Schema**:
  - Schema changes go into `initDb()` in `database.js` and must be additive to support in-place upgrades.
  - Do not use backticks inside SQL comments (the schema is inside a template literal).

---

## 3. UI Design System & Styling (STYLE_GUIDELINES.md)

- **Design Tokens**: All styling must live in `assets/www/css/style.css` using CSS custom properties (`var(--primary)`, `var(--expense)`, etc.).
- **No Inline Styles**: Do not use inline `style="..."` for component layout or color overrides; define reusable CSS classes instead.
- **Semantic Financial Palette**:
  - **Expense (Money Out)**: `--expense` (`#B3261E`), `.badge-expense`, `-₹X` sign.
  - **Income (Money In)**: `--income` (`#0F7A4A`), `.badge-income`, `+₹X` sign.
  - **Investment / Transfer**: `--investment` (`#B45309`), `.badge-accent`, neutral sign.
- **Z-Index Stacking Architecture (9XX Rule)**:
  - `--z-app-bar`: `10`
  - `--z-nav`: `50`
  - `--z-scrim`: `500`
  - `--z-sheet`: `600`
  - `--z-dialog`: `700`
  - **`--z-menu-scrim`**: **`990`** (Tap dismisser for exposed dropdowns)
  - **`--z-menu`**: **`999`** (Exposed dropdown menus and pickers - float above dialogs & sheets)
  - `--z-overlay`: `1000` (Lock screen / PIN)
  - `--z-toast`: `1100` (Notifications)
- **UI Copywriting & Microcopy**:
  - **Brevity & Conciseness**: 1-2 word action verbs for buttons (`Save`, `Add`, `Link`, `Ignore`).
  - **Neutral Prose**: No exclamation marks, no em dashes (`—`), no hype words.
  - **Subtitle separator**: Use centered bullet dots `·` (e.g., `HDFC Bank · Debit Card · ending 5678`).

---

## 4. Heavy Operations & Visual Feedback

- Any CPU-intensive or multi-step operation (CAS PDF parsing, tradebook CSV parsing, bulk SMS scan/reimport, DB encryption/restore) **MUST** provide immediate visual feedback using:
  - `showProgressModal(title, options)` from `ui.js`, or
  - Staged `.progress-bar` elements.
- Never block the UI thread or merely disable buttons during long-running tasks.

---

## 5. Critical Gotchas & Things That Will Bite You

- **Container Query Bug**: `container.querySelectorAll('[data-thing] button')` does not restrict the ancestor half to `container`. Because `<html>` carries `data-appearance` and `data-accent`, always query direct attributes on the target elements.
- **Asset MIME Types**: Assets are served via `https://appassets.androidplatform.net/assets/www/` by `WebViewAssetLoader`. Use relative paths. Do not delete MIME corrections in `MainActivity.kt` or `.wasm`/`.mjs` modules will fail to load.
- **PIN Verification**: PIN is stored as a PBKDF2 hash. Never compare PINs in JavaScript; call `verify_pin` action.
- **Debounced DB Writes**: Database file saves rewrite the entire file debounced. The ISIN database is a separate, read-only SQLite database so its 5MB is not rewritten on every transaction save.
- **Price Changes vs Edits**: `apply_price_change` must create a row in `price_changes` and update the subscription amount to preserve historical rate projections.
- **SMS Classification**: SMS classification rules run in JavaScript. Kotlin's `SmsReceiver` only queues raw messages; the app drains and classifies them via JS on launch.

---

## 6. Verification & Test Commands

- Check coding & styling standards: `node tools/check-style-guidelines.mjs` (or `npm run lint` / `./scripts/dev lint`)
- Run backend tests: `./scripts/dev test` (or `npm test` / `node --test test/*.test.mjs`)
- Serve UI & backend locally in browser: `./scripts/dev web`
- Toolchain diagnostic: `./scripts/dev doctor`
- Build & install debug APK: `./scripts/dev run`
- Build & deploy release APK: `npm run deploy:release` (or `.\tools\deploy-release.ps1`)
