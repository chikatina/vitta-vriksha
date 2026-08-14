/* Add or edit a transaction. This is the sheet the floating button opens. */

import { Bridge } from '../bridge.js';
import {
  sheet, icon, h, toast, confirmDialog, selectField, bindSelectFields, promptDialog,
} from '../ui.js';
import { formatCurrency, todayISO } from '../formatters.js';

const TYPES = [
  { value: 'Expense', label: 'Spent' },
  { value: 'Income', label: 'Received' },
  { value: 'Investment', label: 'Invested' },
  // Money between the household's own pockets, left out of every income and expense
  // total: a card bill paid from a bank account, or a transfer between two accounts.
  { value: 'Transfer', label: 'Moved' },
];

/**
 * Opens the sheet. Pass an existing transaction to edit it.
 * Resolves true when something was written.
 */
export async function openTransactionSheet(app, existing = null) {
  const [categoryRes, memberRes] = await Promise.all([
    Bridge.db('get_categories'),
    Bridge.db('get_family_members'),
  ]);

  const categories = categoryRes.categories || [];
  const members = memberRes.members || [];

  const draft = {
    id: existing?.id || null,
    type: existing?.type || 'Expense',
    amount: existing?.amount ?? '',
    category: existing?.category || '',
    merchant: existing?.merchant || '',
    date: existing?.date || todayISO(),
    member_id: existing?.member_id || members[0]?.id || 1,
    description: existing?.description || '',
    is_investment_outflow: Boolean(existing?.is_investment_outflow),
    splits: existing?.splits ? [...existing.splits] : [],
    cashbacks: existing?.cashbacks ? [...existing.cashbacks] : [],
    raw_sms: existing?.raw_sms || '',
  };

  if (draft.is_investment_outflow) draft.type = 'Investment';

  const forType = (type) => categories.filter((c) => (
    type === 'Income' ? c.type === 'Income'
      : type === 'Investment' ? c.type === 'Investment'
        : c.type === 'Expense'
  ));

  if (!draft.category) draft.category = forType(draft.type)[0]?.name || '';

  const typeClass = (t) => (t === 'Income' ? 'income' : t === 'Investment' ? 'invested' : t === 'Expense' ? 'expense' : '');

  const body = `
    ${draft.raw_sms ? `
      <div class="card-flat" style="margin-bottom:var(--gap-3);background:var(--surface-container-highest);border-left:3px solid var(--accent)">
        <div class="row" style="gap:6px;margin-bottom:4px;color:var(--accent);font-weight:600;font-size:12px">
          ${icon('sms', 'icon-sm')}<span>Original Bank SMS</span>
        </div>
        <div class="caption" style="color:var(--on-surface);user-select:text;word-break:break-word;font-size:13px;line-height:1.4">
          ${h(draft.raw_sms)}
        </div>
      </div>` : ''}

    <div class="segmented" data-types>
      ${TYPES.map((t) => `<button type="button" data-type="${t.value}"
        aria-selected="${t.value === draft.type}">${h(t.label)}</button>`).join('')}
    </div>

    <div>
      <input class="amount-input numeric ${typeClass(draft.type)}" data-amount type="number" inputmode="decimal"
             step="0.01" min="0" placeholder="0" value="${h(draft.amount)}">
      <div class="caption" style="text-align:center" data-amount-hint></div>
    </div>

    <div class="field">
      <span class="field-label">Category</span>
      <div class="chip-scroller" data-categories></div>
    </div>

    <div class="field">
      <label class="field-label" for="txMerchant">Where</label>
      <input class="input" id="txMerchant" data-merchant type="text" autocomplete="off"
             placeholder="Shop, person or description" value="${h(draft.merchant)}">
    </div>

    <div class="grid-2">
      <div class="field">
        <label class="field-label" for="txDate">Date</label>
        <input class="input" id="txDate" data-date type="date" value="${h(draft.date)}">
      </div>
      ${app.familyEnabled && members.length > 1 ? `
      ${selectField({
    key: 'member',
    label: 'Whose',
    id: 'txMember',
    value: draft.member_id,
    options: members.map((member) => ({ value: member.id, label: member.name })),
  })}` : ''}
    </div>

    <details class="card-flat" data-advanced>
      <summary class="title" style="cursor:pointer;list-style:none">
        <span class="row-between">
          <span>Split and cashback</span>
          ${icon('expand_more', 'icon-sm')}
        </span>
      </summary>

      <div style="display:flex;flex-direction:column;gap:12px;margin-top:16px">
        <div class="caption">
          Record what someone else owes you, or money coming back on this spend. Both reduce
          what the transaction actually cost you.
        </div>

        <div class="row" style="gap:8px">
          <input class="input" data-split-name type="text" placeholder="Who owes you">
          <input class="input" data-split-amount type="number" inputmode="decimal" placeholder="Share" style="max-width:110px">
          <button type="button" class="btn btn-tonal btn-sm" data-add-split>${icon('add', 'icon-sm')}</button>
        </div>
        <div data-split-list></div>

        <div class="row" style="gap:8px">
          <input class="input" data-cashback-name type="text" placeholder="Cashback source">
          <input class="input" data-cashback-amount type="number" inputmode="decimal" placeholder="Amount" style="max-width:110px">
          <button type="button" class="btn btn-tonal btn-sm" data-add-cashback>${icon('add', 'icon-sm')}</button>
        </div>
        <div data-cashback-list></div>
      </div>
    </details>

    <div class="field">
      <label class="field-label" for="txNote">Note</label>
      <textarea class="textarea" id="txNote" data-note rows="2"
                placeholder="Anything worth remembering">${h(draft.description)}</textarea>
    </div>

    ${existing ? `<button class="btn btn-danger-text btn-block" data-delete>${icon('delete')}Delete transaction</button>` : ''}`;

  const actions = `
    <button class="btn btn-outlined" data-cancel>Cancel</button>
    <button class="btn btn-filled" data-save>${existing ? 'Save changes' : 'Add'}</button>`;

  const result = await sheet(existing ? 'Edit transaction' : 'New transaction', body, {
    actions,
    autofocus: false,
    onMount(node, close) {
      bindSelectFields(node);
      const $ = (sel) => node.querySelector(sel);

      const paintCategories = () => {
        const list = forType(draft.type);
        if (!list.some((c) => c.name === draft.category)) draft.category = list[0]?.name || '';

        // The last chip makes a category. Running out of them mid-entry is the moment
        // somebody is least willing to go to another screen and come back.
        $('[data-categories]').innerHTML = `${list.map((c) => `
          <button type="button" class="chip" data-category="${h(c.name)}"
                  aria-selected="${c.name === draft.category}">
            ${icon(c.icon || 'sell')}${h(c.name)}
          </button>`).join('')}
          <button type="button" class="chip" data-new-category>${icon('add')}New</button>`;

        $('[data-categories]').querySelectorAll('[data-category]').forEach((chip) => {
          chip.addEventListener('click', () => {
            draft.category = chip.dataset.category;
            paintCategories();
          });
        });

        $('[data-new-category]').addEventListener('click', async () => {
          const name = (await promptDialog('New category', {
            body: `It will be filed under ${draft.type === 'Income' ? 'money in' : 'money out'}.`,
            placeholder: 'Dry cleaning',
          }) || '').trim();
          if (!name) return;

          const res = await app.db('save_category', { category: { name, type: draft.type } });
          // A name that already exists is not a failure: the category the user asked for
          // exists, so select it and say nothing about it.
          if (res.status !== 'success' && res.code !== 'CATEGORY_DUPLICATE') {
            toast(res.message || 'Could not create that category.', 'error');
            return;
          }
          if (!categories.some((c) => c.name === name)) {
            categories.push({ name, type: draft.type, icon: 'sell' });
          }
          draft.category = name;
          paintCategories();
          if (res.status === 'success') toast(`Added "${name}".`, 'success');
        });
      };

      const paintAmountHint = () => {
        const value = Number($('[data-amount]').value);
        $('[data-amount-hint]').textContent = value > 0
          ? formatCurrency(value, app.currency, app.locale)
          : '';
      };

      const paintChips = (selector, items, render, onRemove) => {
        $(selector).innerHTML = items.length
          ? `<div class="row" style="flex-wrap:wrap;gap:6px">${items.map((item, i) => `
              <span class="badge">${h(render(item))}
                <button type="button" data-remove="${i}" aria-label="Remove"
                        style="display:flex">${icon('close', 'icon-sm')}</button>
              </span>`).join('')}</div>`
          : '';
        $(selector).querySelectorAll('[data-remove]').forEach((btn) => {
          btn.addEventListener('click', () => {
            onRemove(Number(btn.dataset.remove));
          });
        });
      };

      const paintSplits = () => paintChips('[data-split-list]', draft.splits,
        (s) => `${s.person_name}: ${formatCurrency(s.share_amount, app.currency, app.locale)}`,
        (i) => { draft.splits.splice(i, 1); paintSplits(); });

      const paintCashbacks = () => paintChips('[data-cashback-list]', draft.cashbacks,
        (c) => `${c.source_name}: ${formatCurrency(c.cashback_amount, app.currency, app.locale)}`,
        (i) => { draft.cashbacks.splice(i, 1); paintCashbacks(); });

      const updateAmountColor = () => {
        const input = $('[data-amount]');
        if (!input) return;
        input.classList.remove('income', 'expense', 'invested', 'investment');
        const cls = typeClass(draft.type);
        if (cls) input.classList.add(cls);
      };

      node.querySelectorAll('[data-type]').forEach((btn) => {
        btn.addEventListener('click', () => {
          draft.type = btn.dataset.type;
          node.querySelectorAll('[data-type]').forEach((b) => {
            b.setAttribute('aria-selected', String(b.dataset.type === draft.type));
          });
          updateAmountColor();
          paintCategories();
        });
      });

      $('[data-amount]').addEventListener('input', paintAmountHint);

      $('[data-add-split]').addEventListener('click', () => {
        const name = $('[data-split-name]').value.trim();
        const amount = Number($('[data-split-amount]').value);
        if (!name || !(amount > 0)) return;
        draft.splits.push({ person_name: name, share_amount: amount, is_paid: 1 });
        $('[data-split-name]').value = '';
        $('[data-split-amount]').value = '';
        paintSplits();
      });

      $('[data-add-cashback]').addEventListener('click', () => {
        const name = $('[data-cashback-name]').value.trim();
        const amount = Number($('[data-cashback-amount]').value);
        if (!name || !(amount > 0)) return;
        draft.cashbacks.push({ source_name: name, cashback_amount: amount });
        $('[data-cashback-name]').value = '';
        $('[data-cashback-amount]').value = '';
        paintCashbacks();
      });

      $('[data-cancel]').addEventListener('click', () => close(null));

      $('[data-save]').addEventListener('click', async () => {
        const amount = Number($('[data-amount]').value);
        if (!(amount > 0)) {
          toast('Enter an amount first.', 'error');
          $('[data-amount]').focus();
          return;
        }
        if (!draft.category) {
          toast('Pick a category first.', 'error');
          return;
        }

        const payload = {
          id: draft.id,
          type: draft.type === 'Investment' ? 'Expense' : draft.type,
          is_investment_outflow: draft.type === 'Investment',
          amount,
          category: draft.category,
          merchant: $('[data-merchant]').value.trim(),
          date: $('[data-date]').value || todayISO(),
          member_id: Number($('[data-member]')?.value || draft.member_id),
          description: $('[data-note]').value.trim(),
          raw_sms: draft.raw_sms,
          currency: app.currency,
          splits: draft.splits,
          cashbacks: draft.cashbacks,
        };

        const res = await app.db('save_transaction', { transaction: payload });
        if (res) {
          // Naming a category for a merchant teaches the app, and the lesson is applied
          // backwards. Say so: silently rewriting rows the user did not open is the kind
          // of helpfulness that reads as a bug.
          const also = Number(res.also_categorised || 0);
          const saved = draft.id ? 'Transaction updated.' : 'Transaction added.';
          toast(also > 0
            ? `${saved} ${also} earlier ${also === 1 ? 'transaction' : 'transactions'} from the same merchant moved too.`
            : saved, 'success');
          close(true);
        }
      });

      const deleteButton = $('[data-delete]');
      if (deleteButton) {
        deleteButton.addEventListener('click', async () => {
          const confirmed = await confirmDialog(
            'Delete this transaction?',
            'It will be removed from your ledger and your totals.',
            { confirmLabel: 'Delete', danger: true },
          );
          if (!confirmed) return;
          const res = await app.db('delete_transaction', { transaction_id: draft.id });
          if (res) {
            toast('Transaction deleted.', 'success');
            close(true);
          }
        });
      }

      paintCategories();
      paintAmountHint();
      paintSplits();
      paintCashbacks();
    },
  });

  return Boolean(result);
}
