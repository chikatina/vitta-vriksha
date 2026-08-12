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
export function transactionRow(tx, app, categories, { showDate = true } = {}) {
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
  }

  const noteSnippet = tx.description ? tx.description : (tx.raw_sms ? tx.raw_sms : null);
  const meta = [
    showDate ? formatRelativeDate(tx.date) : null,
    tx.category,
    isInvested ? 'Invested' : null,
    tx.splits?.length ? `split ${tx.splits.length}` : null,
    noteSnippet ? `${noteSnippet.slice(0, 40)}${noteSnippet.length > 40 ? '…' : ''}` : null,
  ].filter(Boolean).join(' · ');

  return `
    <button class="list-row" data-transaction="${tx.id}">
      <span class="avatar" style="background:${h(look.color)}">${icon(look.icon || 'sell')}</span>
      <span class="list-row-main">
        <span class="list-row-title">${h(tx.merchant || tx.category)}</span>
        <span class="list-row-sub">${h(meta)}</span>
      </span>
      <span class="list-row-trailing">
        <span class="list-row-amount ${amountClass}">${sign}${h(formatCurrency(net, app.currency, app.locale))}</span>
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
