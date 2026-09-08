# Vitta Vriksha Design & Style System

The official design system, UI style guide, copywriting standards, and iconography conventions for **Vitta Vriksha**.

---

## 1. Core Design Principles

### 1.1. Brevity & Word Reduction ("Show, Don't Tell")
- **Eliminate Wordiness**: Replace multi-sentence explanations with compact badges, intuitive visual affordances, and structured tabular data.
- **Microcopy Standard**:
  - **Buttons**: Use 1–2 word action verbs (e.g. `Add`, `Save`, `Link`, `Delete`, `Ignore`). Never use full sentences (avoid *"Click here to add your account"*).
  - **Subtitles & Captions**: Max 1 line. Use centered bullet dots `·` for separating metadata (e.g. `HDFC Bank · Debit Card · ending 5678`).
  - **Empty States**: 1 Material Symbol icon + 1 short title (2–3 words) + 1 concise suggestion.
  - **Confirmation Dialogs**: Direct question title + 1 concise sentence explaining the consequence + high-contrast action button.
- **No Exclamation Marks**: Keep UI copy neutral, calm, and objective. Financial interfaces should inspire confidence, not excitement.
- **No Emojis**: Emojis render inconsistently across Android OS versions and look toy-like. Use vector Material Symbols Outlined icons for all visual metaphors.

### 1.2. Icon-First Affordances for Simple Actions
- Common, repeated user actions must leverage universal Material Symbols icons with clear semantics rather than cluttering the screen with text.
- Use `.icon-button` (36×36px / 40×40px tap target) for row-level secondary actions (e.g., delete, ignore, copy, open).
- Use `icon(name, 'icon-sm')` inside compact tonal chips and action buttons.

---

## 2. Iconography Standards & Action Map

All icons must be resolved through `icon(name, className)` and must exist in [`assets/www/js/icon-codepoints.js`](file:///d:/Projects/moneytree/app/src/main/assets/www/js/icon-codepoints.js).

### 2.1. Standard Action Mapping

| Action | Material Symbol | CSS Class / Element | Usage Context |
| :--- | :--- | :--- | :--- |
| **Add / Create** | `add` | `.btn-filled`, `.btn-text`, `.fab` | New record, transaction, SIP, rule |
| **Edit / Modify** | `edit` | `.icon-button`, `.btn-tonal` | Edit transaction, rename account |
| **Delete / Remove** | `delete` | `.icon-button`, `.btn-danger-text` | Permanent removal (shows confirmation) |
| **Ignore / Discard** | `visibility_off` | `.icon-button`, `.chip` | Exclude SMS alert or transaction from ledger |
| **Restore / Undo** | `settings_backup_restore` | `.btn-tonal`, `.chip` | Restore ignored transaction or rule |
| **Link / Combine** | `open_in_new` | `.btn-tonal`, `.btn-filled` | 2-way Debit Card linking, eCAS linking |
| **Transfer / Cycle** | `autorenew` | `.avatar`, `.badge` | Demat/NPS transfers, recurring schedules |
| **Confirm / Done** | `check_circle` / `check` | `.badge`, `.btn-filled` | Saved state, batch selection, verification |
| **Search** | `search` | `.input-icon`, `.icon-button` | Transaction filtering, fund search |
| **Filter / Sort** | `filter_list` / `sort` | `.chip`, `.icon-button` | Ledger filter sheet, period picker |
| **Details / Info** | `info` | `.icon-button`, `.banner` | Tooltips, calculation explainers |
| **Settings** | `tune` / `settings` | `.nav-row`, `.icon-button` | App preferences, rule configurations |
| **Copy** | `content_copy` | `.icon-button` | Copy PRAN, folio, digest |
| **Security / Lock** | `lock` / `fingerprint` | `.overlay-screen`, `.icon` | PIN vault, biometric authentication |

### 2.2. Financial Domain & Instrument Glyphs

| Financial Concept | Glyph Name | Color Token | Context |
| :--- | :--- | :--- | :--- |
| **Bank Account** | `account_balance` | `--on-surface` | Savings, Current, Salary accounts |
| **Credit Card** | `credit_card` | `--expense` | Credit cards, limit & balance tracking |
| **Debit Card** | `payments` | `--accent` | Physical & virtual debit cards |
| **Digital Wallet** | `account_balance_wallet` | `--tertiary` | Paytm, Amazon Pay, UPI wallets |
| **Meal Card** | `restaurant` | `--primary` | Sodexo, Pluxee, Zaggle food cards |
| **Mutual Funds / SIP** | `trending_up` | `--income` | MFs, Index Funds, SIP mandates |
| **Stocks / Demat** | `stacked_bar_chart` | `--income` | Equity portfolios, broker holdings |
| **Retirement (NPS/EPF)** | `savings` | `--investment` | NPS tiers, provident fund corpus |
| **Loans & EMIs** | `account_balance` | `--expense` | Home/Car/Personal loans, loan clubbing |
| **Fixed Deposits (FD/RD)** | `savings` / `today` | `--investment` | Term deposits, maturity tracking |
| **Goals** | `flag` / `shield` | `--accent` | Emergency fund, savings targets |

---

## 3. Financial Semantic Colors & Tokens

The application strictly enforces a semantic 3-tier financial palette:

| Financial Direction | Text / Stroke Token | Background / Container Token | Sign / Semantics |
| :--- | :--- | :--- | :--- |
| **Expense (Money Out)** | `--expense` (`#B3261E`) | `--error-container` / `.badge-expense` | Minus sign `-₹X`, red badge, debt bar |
| **Income (Money In)** | `--income` (`#0F7A4A`) | `--income-container` / `.badge-income` | Plus sign `+₹X`, green badge |
| **Investment / Transfer** | `--investment` (`#B45309`) | `--accent-container` / `.badge-accent` | Gold/Amber text, orange badge, neutral flow |

### Chart & Series Semantics:
```javascript
const ROLE_COLORS = {
  income: 'var(--income)',
  expense: 'var(--expense)',
  investment: 'var(--investment)',
  invested: 'var(--investment)',
};
```

---

## 4. UI Components & Layout Guidelines

### 4.1. Segmented Tabs (`.tabs-bar` & `.chip`)
Use horizontal scrollable chip bars for switching view modes or categories:
- Active Chip: `background: var(--primary); color: var(--on-primary); font-weight: 700;`
- Inactive Chip: `background: var(--surface-container-high); color: var(--on-surface);`
- Count Badge: Compact pill showing record counts (`badge-income` for actionable alerts).

```html
<div class="tabs-bar" style="display:flex;gap:6px;overflow-x:auto;padding-bottom:10px;scrollbar-width:none">
  <button class="chip active">
    ${icon('account_balance', 'icon-sm')}<span>Bank Accounts</span>
    <span class="badge">4</span>
  </button>
  <button class="chip">
    ${icon('credit_card', 'icon-sm')}<span>Credit Cards</span>
    <span class="badge">2</span>
  </button>
</div>
```

### 4.2. List Rows (`.list` & `.list-row`)
List rows are the primary presentation unit for transactions, accounts, and rules:
- **Left**: `.avatar.avatar-sm` (40×40px, rounded-full, with domain glyph).
- **Middle**: `.list-row-main` with `.list-row-title` (14–15px semi-bold) and `.list-row-sub` (12px muted with `·` separators).
- **Right**: `.list-row-amount` (formatted with `font-variant-numeric: tabular-nums; font-weight: 650;`) or action buttons.

### 4.3. Form Inputs & Pickers
1. **Never use native `<select>`**: Always use `selectField()` and `bindSelectFields()` from `ui.js` to render Material 3 exposed dropdowns.
2. **Numeric Fields**: Use `inputmode="decimal" step="any"` and `.numeric` styling for amounts.
3. **Switch Rows**: Use `.switch-row` with native clean toggle switches for binary settings.

### 4.4. Z-Index Stacking Architecture
To prevent layering bugs where popovers or dialogs get clipped:

| Token | Z-Index | Component |
| :--- | :--- | :--- |
| `--z-app-bar` | `10` | Top App Bar |
| `--z-nav` | `50` | Bottom Navigation Bar |
| `--z-fab` | `55` | Floating Action Button |
| `--z-scrim` | `500` | Dimmed Backdrop |
| `--z-sheet` | `600` | Sliding Bottom Sheets |
| `--z-dialog` | `700` | Modal Confirmation Dialogs |
| `--z-overlay` | `1000` | Lock Screen & Fullscreen Onboarding |
| `--z-toast` | `1100` | Ephemeral Notifications |
| **`--z-menu-scrim`** | **`990`** | **Dropdown tap dismisser (9XX Rule)** |
| **`--z-menu`** | **`999`** | **Exposed Dropdown Menus & Pickers (9XX Rule)** |

---

## 5. UI Copywriting Style Guide

### 5.1. Concise Copy Comparison Examples

| Area | Wordy / Cluttered Copy | Clean / Compact Copy |
| :--- | :--- | :--- |
| **Discovered SMS Alert** | *"We detected a new transaction alert from your SMS messages. Would you like to add it as a new bank account or link it to an existing one?"* | `HDFC Bank · Debit Card · ending 5678` <br> `[ Link ]` `[ Add ]` `[ Ignore ]` |
| **Delete Confirmation** | *"Are you completely sure you want to delete this record? This action cannot be reversed and all your data will be permanently wiped out."* | **Title**: `Delete this record?`<br>**Body**: `This cannot be undone.`<br>**Button**: `[ Delete ]` (danger) |
| **Ignore / Discard** | *"Dismiss this message and prevent it from ever showing up again in your ledger or SMS review lists in future scans."* | `Ignore alert and exclude from ledger.` |
| **Credit Card Limit** | *"Your credit card limit is ₹1,50,000 and your current balance is ₹45,000 which means you have utilized 30 percent."* | `₹45,000 / ₹1,50,000 · 30% used` |
| **Empty State** | *"There are no transactions recorded in this period. Tap the plus button below to start tracking your daily expenses."* | `No transactions` <br> `Tap + to record spending.` |

### 5.2. Number & Date Formatting Rules
- **Currency**: Always format through `formatCurrency(val, currency, locale)` (e.g. `₹1,24,500.00` or `₹5,400`).
- **Dates**: Use `formatDate(iso)` (`15 Jan 2026`) or `formatRelativeDate(iso)` (`Today`, `Yesterday`, `In 3 days`).
- **Large Holdings**: Use Indian numeric grouping (`₹1.25 L`, `₹10.50 Cr`) for milestone displays.
