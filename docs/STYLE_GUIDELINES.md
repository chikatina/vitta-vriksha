# UI Style & Stacking Guidelines

This document defines the core design tokens, color hierarchy, and stacking context (Z-Index) architecture for **Vitta Vriksha**. Adhere to these standards across all views, sheets, widgets, and components.

---

## 1. Z-Index Stacking Architecture

To prevent layering defects (such as dropdowns or select menus rendering underneath bottom sheets or modal dialogs), all elements must use standard z-index CSS variables defined in `:root`.

| Token | Z-Index Value | Used By | Description |
| :--- | :--- | :--- | :--- |
| `--z-app-bar` | `10` | `.app-bar` | Top title bar and header actions |
| `--z-nav` | `50` | `.nav-bar` | Bottom navigation bar |
| `--z-fab` | `55` | `.fab` | Floating action button (Quick Add) |
| `--z-overlay` | `400` | `.overlay-screen` | Full-screen PIN lock and initial vault setup |
| `--z-scrim` | `500` | `.scrim` | Dimmed backdrop behind sheets and dialogs |
| `--z-sheet` | `600` | `.sheet` | Sliding bottom sheets (e.g. Transaction edit, Drilldown) |
| `--z-dialog` | `700` | `.dialog` | Confirmation and prompt modal dialogs |
| `--z-toast` | `800` | `.toast-host`, `.toast` | Temporary alert banners anchored above nav |
| **`--z-menu-scrim`** | **`990`** | `.menu-scrim` | Transparent dismiss tap-catcher for dropdown menus |
| **`--z-menu`** | **`999`** | `.menu` | **Dropdown menus, select popovers, and option pickers (9XX Level)** |

> [!IMPORTANT]
> **The 9XX Level Rule for Dropdowns & Menus**:
> Dropdown menus and exposed select popovers (`.menu`, `.menu-scrim`) must **ALWAYS** remain at the **9XX level** (`990` - `999`). This guarantees that whenever a select field or dropdown is opened inside a bottom sheet, dialog, or overlay, the menu floats freely on top without being clipped or hidden.

---

## 2. Financial Semantic Color Theme

The app adheres to an intuitive three-tier financial direction palette:

| Flow / Role | Color (Light) | Color (Dark) | Container / Badge BG | Class & Token Names |
| :--- | :--- | :--- | :--- | :--- |
| **Expense / Outflow** | `#B3261E` (Red) | `#FF897D` (Red) | `#FBDAD6` / `#6B1610` | `--expense`, `.expense`, `.badge-expense`, `.amount-input.expense` |
| **Income / Inflow** | `#0F7A4A` (Green) | `#5CD693` (Green) | `#CBF2DC` / `#0C4429` | `--income`, `.income`, `.badge-income`, `.amount-input.income` |
| **Invested / Outflow** | `#B45309` (Amber/Yellow) | `#FBBF24` (Gold/Yellow) | `#FEF3C7` / `#5C3807` | `--investment`, `.invested`, `.investment`, `.badge-investment`, `.amount-input.invested` |

### Rules for Financial Indicators:
1. **Expenses / Spends**: Negative sign `-`, red text or red bar/pill.
2. **Income / Received**: Positive sign `+`, green text or green bar/pill.
3. **Investments / Folios**: Unsigned or positive unit with gold/yellow text (`.invested`) and yellow tags.
4. **Chart Roles**:
   - `charts.js` uses `ROLE_COLORS`: `{ income: 'var(--income)', expense: 'var(--expense)', investment: 'var(--investment)', invested: 'var(--investment)' }`.
   - Analytics series for investments must specify `role: 'investment'`.

---

## 3. Form Controls & Dropdowns (Material 3 Exposed Dropdown Menus)

1. **Never use native `<select>` elements**. A native `<select>` delegates to Android's system dialog, breaking custom themes, typography, and dark mode.
2. **Always use `selectField()` and `bindSelectFields()` from [`ui.js`](file:///d:/Projects/moneytree/app/src/main/assets/www/js/ui.js)**.
3. **Single Open Dropdown Policy**: At most **1 dropdown menu can be open at any time**. Opening any select menu or dropdown automatically closes all other active menus via `closeOpenMenus()`.
4. **Dismissal Behaviors**:
   - Tapping outside the menu on `.menu-scrim` immediately dismisses it.
   - Tapping the same trigger button toggles the open menu closed.
   - Pressing the `Escape` key closes the menu.
   - Window resize, sheet scrolling, or opening any overlay automatically dismisses active menus.
5. **Accessibility & Keyboard Navigation**:
   - Popovers expose `role="listbox"` and `role="option"`.
   - Supports `ArrowUp` and `ArrowDown` to cycle focused options, and `Enter` to select.
6. **Z-Index Layering**: `openMenu()` mounts directly to `document.body` using `--z-menu-scrim: 990` and `--z-menu: 999` to ensure it floats on top of bottom sheets, dialogs, and overlays.

---

## 4. Brand Mark & Assets

1. The brand asset [`assets/www/images/vittvriksha.png`](file:///d:/Projects/moneytree/app/src/main/assets/www/images/vittvriksha.png) is the single source of truth for the logo.
2. Rendered in-app via `brandMark()` in [`brand-mark.js`](file:///d:/Projects/moneytree/app/src/main/assets/www/js/brand-mark.js).
3. Do not run ad-hoc image generation scripts that overwrite official brand assets.
