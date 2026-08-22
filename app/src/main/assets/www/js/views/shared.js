/* Fragments used by more than one view. */

import { icon, h } from '../ui.js';
import { formatCurrency, formatRelativeDate } from '../formatters.js';

/** Indexes categories by name so rows can find their icon and colour in one lookup. */
export function categoryIndex(categories) {
  const map = new Map();
  categories.forEach((c) => map.set(c.name, c));
  return map;
}

export function categoryLook(categories, name) {
  return categories.get(name) || { icon: 'sell', color: 'var(--on-surface-faint)', name };
}

/**
 * One transaction row. Signed and coloured by direction, with the amount the user
 * actually bore when splits or cashbacks are attached.
 */
export function transactionRow(tx, app, categories, { showDate = true, selectable = false, selected = false, isAnomaly = false } = {}) {
  const look = categoryLook(categories, tx.category);
  const isIncome = tx.type === 'Income';
  const isInvested = Boolean(tx.is_investment_outflow);
  const net = tx.net_personal_amount ?? tx.amount;
  const adjusted = Math.abs(net - tx.amount) > 0.005;

  let amountClass = 'expense';
  let sign = '-';
  if (isIncome) {
    amountClass = 'income';
    sign = '+';
  } else if (isInvested) {
    amountClass = 'invested';
    sign = '';
  } else if (tx.type === 'Transfer') {
    amountClass = 'transfer';
    sign = '';
  }

  const isIgnored = Boolean(tx.is_ignored || tx.is_duplicate);
  const noteSnippet = tx.description ? tx.description : null;

  let instrumentBadge = null;
  if (tx.card_name || tx.card_bank) {
    instrumentBadge = `${tx.card_name || tx.card_bank}${tx.card_last_4 ? ` (${tx.card_last_4})` : ''}`;
  } else if (tx.account_name || tx.account_institution) {
    instrumentBadge = `${tx.account_name || tx.account_institution}${tx.account_number ? ` (${tx.account_number.slice(-4)})` : ''}`;
  }

  const meta = [
    showDate ? formatRelativeDate(tx.date) : null,
    tx.category,
    instrumentBadge,
    isInvested ? 'Invested' : (tx.type === 'Transfer' ? 'Moved' : null),
    isIgnored ? `<span class="badge" style="background:var(--surface-container-highest);color:var(--outline);font-size:10.5px;padding:1px 6px">${tx.is_duplicate ? 'Duplicate' : 'Ignored'}</span>` : null,
    isAnomaly && !isIgnored ? '<span class="badge-anomaly">High</span>' : null,
    tx.splits?.length ? `split ${tx.splits.length}` : null,
    noteSnippet ? `${noteSnippet.slice(0, 22)}${noteSnippet.length > 22 ? '…' : ''}` : null,
  ].filter(Boolean).join(' · ');

  return `
    <button class="list-row ${selected ? 'selected-row' : ''}" data-transaction="${tx.id}" style="${selected ? 'background:var(--accent-container);border-radius:var(--radius-sm);' : ''}${isIgnored ? 'opacity:0.65;' : ''}">
      ${selectable ? `
        <span class="selection-checkbox" style="margin-right:8px;display:flex;align-items:center;color:${selected ? 'var(--accent)' : 'var(--outline-strong)'}">
          ${icon(selected ? 'check_box' : 'check_box_outline_blank', 'icon-md')}
        </span>` : ''}
      <span class="avatar" style="background:${h(look.color)}">${icon(look.icon || 'sell')}</span>
      <span class="list-row-main">
        <span class="list-row-title">${h(tx.merchant || tx.category)}</span>
        <span class="list-row-sub">${meta}</span>
      </span>
      <span class="list-row-trailing">
        <span class="list-row-amount ${amountClass}" style="${isIgnored ? 'text-decoration:line-through;color:var(--outline)' : ''}">${sign}${h(formatCurrency(net, app.currency, app.locale))}</span>
        ${adjusted ? `<span class="list-row-sub" style="text-decoration:line-through">${h(formatCurrency(tx.amount, app.currency, app.locale))}</span>` : ''}
      </span>
    </button>`;
}

/** Wires every transaction row inside a container to open the edit sheet. */
export function bindTransactionRows(container, app, transactions) {
  const byId = new Map(transactions.map((t) => [String(t.id), t]));
  container.querySelectorAll('[data-transaction]').forEach((row) => {
    row.addEventListener('click', () => {
      const tx = byId.get(row.dataset.transaction);
      if (tx) app.addTransaction(tx);
    });
  });
}

/** A tappable row that leads into a sub-page. */
export function navRow(page, glyph, title, sub, trailing = '') {
  return `
    <button class="list-row" data-page="${h(page)}">
      <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface-variant)">${icon(glyph)}</span>
      <span class="list-row-main">
        <span class="list-row-title">${h(title)}</span>
        ${sub ? `<span class="list-row-sub">${h(sub)}</span>` : ''}
      </span>
      ${trailing ? `<span class="caption">${h(trailing)}</span>` : ''}
      ${icon('chevron_right', 'icon-sm')}
    </button>`;
}

export function bindNavRows(container, app) {
  container.querySelectorAll('[data-page]').forEach((row) => {
    row.addEventListener('click', () => app.open(row.dataset.page));
  });
}

/** Chips that scope a view to one household member. */
export function memberChips(app, members) {
  if (!app.familyEnabled || members.length < 2) return '';
  return `
    <div class="chip-scroller" data-members>
      <button class="chip" data-member="all" aria-selected="${app.memberFilter === 'all'}">Everyone</button>
      ${members.map((m) => `
        <button class="chip" data-member="${m.id}" aria-selected="${String(app.memberFilter) === String(m.id)}">
          <span class="legend-dot" style="background:${h(m.avatar_color)}"></span>${h(m.name)}
        </button>`).join('')}
    </div>`;
}

export function bindMemberChips(container, app) {
  container.querySelectorAll('[data-member]').forEach((chip) => {
    chip.addEventListener('click', () => {
      app.memberFilter = chip.dataset.member;
      app.refresh();
    });
  });
}
