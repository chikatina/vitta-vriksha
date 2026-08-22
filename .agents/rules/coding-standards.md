# Architecture & Coding Standards

- **Two-Layer Offline Architecture**:
  - `assets/www/` (HTML/CSS/JS ES modules) runs UI and SQLite WASM.
  - Kotlin shell handles hardware/system capabilities via `WebAppInterface.kt`.
  - Zero network permission: everything is computed on-device.
- **No Third-Party JS**: Do not add npm packages or external JS. Bundled dependencies live only in `assets/www/vendor/`.
- **No Build / Bundler Step**: Web layer is pure ESM served by `WebViewAssetLoader`.
- **No Emojis**: Always use `icon(name, className)` from `assets/www/js/ui.js` mapped in `icon-codepoints.js`.
- **Currency & Money**: Always format money with `formatCurrency(val)` from `assets/www/js/formatters.js`.
- **Form Controls**: Never use `<select>`. Always use `selectField()` and `bindSelectFields()` from `ui.js`.
- **Error Handling**: Backend actions return `{status: "success", ...}` or fail with `fail(code, message, hint)` from `errors.js`. Render errors with `errorBlock(res)`.
- **Database Migrations**: Additive schema changes in `initDb()` in `database.js`. No backticks in SQL comments.
- **Gotchas**:
  - Avoid `container.querySelectorAll('[data-thing] button')` due to `<html>` attributes. Query direct attributes instead.
  - Relative paths for asset URLs (`WebViewAssetLoader`).
  - Compare PIN via `verify_pin` backend action (PBKDF2 hash).
  - Price changes must call `apply_price_change` to record history.
