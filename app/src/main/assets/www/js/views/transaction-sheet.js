/* Add or edit a transaction. This is the sheet the floating button opens. */

import { Bridge } from '../bridge.js';
import {
  sheet, icon, h, toast, confirmDialog, selectField, bindSelectFields, promptDialog, scrollSelectedIntoView,
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
  const [categoryRes, memberRes, accountsRes, cardsRes] = await Promise.all([
    Bridge.db('get_categories'),
    Bridge.db('get_family_members'),
    Bridge.db('list_records', { type: 'asset_account' }),
    Bridge.db('list_records', { type: 'card' }),
  ]);

  const categories = categoryRes.categories || [];
  const members = memberRes.members || [];
  const accounts = accountsRes.records || [];
  const cards = cardsRes.records || [];

  let initialInstrument = '';
  if (existing?.card_id) initialInstrument = `card:${existing.card_id}`;
  else if (existing?.account_id) initialInstrument = `acc:${existing.account_id}`;

  const instrumentOptions = [
    { value: '', label: 'None / Cash' },
    ...accounts.map((a) => ({ value: `acc:${a.id}`, label: `${a.name}${a.account_number ? ` (··${a.account_number.slice(-4)})` : ''}` })),
    ...cards.map((c) => ({ value: `card:${c.id}`, label: `${c.card_name}${c.last_4 ? ` (··${c.last_4})` : ''}` })),
  ];

  const draft = {
    id: existing?.id || null,
    type: existing?.type || 'Expense',
    amount: existing?.amount ?? '',
    category: existing?.category || '',
    merchant: existing?.merchant || '',
    date: existing?.date || todayISO(),
    member_id: existing?.member_id || members[0]?.id || 1,
    account_id: existing?.account_id || null,
    card_id: existing?.card_id || null,
    instrument: initialInstrument,
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
        : type === 'Transfer' ? c.type === 'Transfer'
          : c.type === 'Expense'
  ));

  if (!draft.category) draft.category = forType(draft.type)[0]?.name || '';

  const typeClass = (t) => (t === 'Income' ? 'income' : t === 'Investment' ? 'invested' : t === 'Transfer' ? 'transfer' : t === 'Expense' ? 'expense' : '');

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

    ${existing && (existing.is_ignored || existing.is_duplicate) ? `
      <div class="card-flat" style="margin-bottom:var(--gap-3);background:var(--surface-container-highest);border-left:3px solid var(--outline)">
        <div class="row" style="gap:6px;margin-bottom:2px;color:var(--on-surface-variant);font-weight:600;font-size:12px">
          ${icon('visibility_off', 'icon-sm')}<span>${existing.is_duplicate ? 'Duplicate Transaction (Ignored)' : 'Ignored / Discarded Transaction'}</span>
        </div>
        <div class="caption" style="color:var(--on-surface-variant);font-size:12px">
          This entry is excluded from spending totals, analytics, and monthly budgets.
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
      ${selectField({
    key: 'instrument',
    label: 'Account / Card',
    id: 'txInstrument',
    value: draft.instrument,
    options: instrumentOptions,
  })}
    </div>
    ${app.familyEnabled && members.length > 1 ? `
    <div class="field" style="margin-top:var(--gap-2)">
      ${selectField({
    key: 'member',
    label: 'Whose',
    id: 'txMember',
    value: draft.member_id,
    options: members.map((m) => ({ value: m.id, label: m.name })),
  })}
    </div>` : ''}

    <details class="accordion" style="margin-top:var(--gap-2)">
      <summary class="accordion-header">
        <span>Splits & Cashbacks</span>
        ${icon('expand_more', 'icon-sm')}
      </summary>
      <div class="accordion-content" style="display:flex;flex-direction:column;gap:12px;padding-top:10px">
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

    <label class="card-flat" style="margin-top:var(--gap-2);display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--surface-container-high);border-radius:var(--radius-sm);cursor:pointer">
      <div style="flex:1;margin-right:12px">
        <div style="font-size:13px;font-weight:600">Apply to all from this merchant</div>
        <div class="caption" style="font-size:11.5px;color:var(--on-surface-variant)">Update rule for other past & future transactions</div>
      </div>
      <input type="checkbox" id="txApplyToAll" ${existing ? '' : 'checked'} style="width:18px;height:18px;cursor:pointer">
    </label>

    ${existing ? `
      ${existing.is_ignored || existing.is_duplicate ? `
        <div class="row" style="gap:8px;margin-top:var(--gap-2)">
          <button type="button" class="btn btn-tonal btn-block" data-restore>
            ${icon('settings_backup_restore', 'icon-sm')}Restore to Ledger
          </button>
          <button type="button" class="btn btn-danger-text btn-block" data-delete>
            ${icon('delete', 'icon-sm')}Delete
          </button>
        </div>` : `
        <div class="row" style="gap:6px;margin-top:var(--gap-2);flex-wrap:wrap">
          <button type="button" class="btn btn-tonal btn-sm" style="flex:1" data-ignore>
            ${icon('visibility_off', 'icon-sm')}Ignore
          </button>
          <button type="button" class="btn btn-tonal btn-sm" style="flex:1" data-duplicate>
            ${icon('content_copy', 'icon-sm')}Duplicate
          </button>
          <button type="button" class="btn btn-tonal btn-sm" style="flex:1" data-split-categories>
            ${icon('account_tree', 'icon-sm')}Split
          </button>
          <button type="button" class="btn btn-danger-text btn-sm" data-delete>
            ${icon('delete', 'icon-sm')}Delete
          </button>
        </div>`}` : ''}`;

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

        scrollSelectedIntoView($('[data-categories]'), { behavior: 'smooth' });
        setTimeout(() => scrollSelectedIntoView($('[data-categories]'), { behavior: 'smooth' }), 50);

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

        const applyToAll = Boolean(node.querySelector('#txApplyToAll')?.checked);
        const instVal = $('[data-instrument]')?.value || '';
        let accountId = null;
        let cardId = null;
        if (instVal.startsWith('acc:')) accountId = Number(instVal.slice(4));
        else if (instVal.startsWith('card:')) cardId = Number(instVal.slice(5));

        const payload = {
          id: draft.id,
          type: draft.type === 'Investment' ? 'Expense' : draft.type,
          is_investment_outflow: draft.type === 'Investment',
          amount,
          category: draft.category,
          merchant: $('[data-merchant]').value.trim(),
          date: $('[data-date]').value || todayISO(),
          member_id: Number($('[data-member]')?.value || draft.member_id),
          account_id: accountId,
          card_id: cardId,
          description: $('[data-note]').value.trim(),
          raw_sms: draft.raw_sms,
          currency: app.currency,
          splits: draft.splits,
          cashbacks: draft.cashbacks,
          apply_to_all: applyToAll,
          override_single: !applyToAll,
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

      const ignoreButton = $('[data-ignore]');
      if (ignoreButton) {
        ignoreButton.addEventListener('click', async () => {
          const merchantName = $('[data-merchant]').value.trim() || draft.merchant;
          let createRule = false;
          if (merchantName) {
            createRule = await confirmDialog(
              'Discard / Ignore Message?',
              `Exclude this entry from your ledger and spending totals.${merchantName ? `\n\nCreate a standing rule to also ignore future messages from "${h(merchantName)}"?` : ''}`,
              { confirmLabel: merchantName ? 'Ignore & Create Rule' : 'Ignore', cancelLabel: 'Cancel' },
            );
            if (createRule === null) return;
          } else {
            const confirmed = await confirmDialog('Ignore this transaction?', 'It will be excluded from spending totals and budgets.', { confirmLabel: 'Ignore' });
            if (!confirmed) return;
          }

          const res = await Bridge.db('ignore_transaction', {
            transaction_id: draft.id,
            create_rule: Boolean(createRule && merchantName),
            merchant: merchantName,
          });
          if (res && res.status === 'success') {
            toast(createRule ? `Transaction ignored and rule created for "${merchantName}".` : 'Transaction ignored.', 'success');
            close(true);
          }
        });
      }

      const duplicateButton = $('[data-duplicate]');
      if (duplicateButton) {
        duplicateButton.addEventListener('click', async () => {
          const confirmed = await confirmDialog(
            'Mark as Duplicate?',
            'This transaction will be marked as duplicate, excluded from totals, and remembered so future imports will not duplicate it.',
            { confirmLabel: 'Mark Duplicate', danger: true },
          );
          if (!confirmed) return;

          const res = await Bridge.db('mark_transaction_duplicate', {
            transaction_id: draft.id,
            create_rule: true,
          });
          if (res && res.status === 'success') {
            toast('Marked as duplicate.', 'success');
            close(true);
          }
        });
      }

      const restoreButton = $('[data-restore]');
      if (restoreButton) {
        restoreButton.addEventListener('click', async () => {
          const res = await Bridge.db('restore_transaction', { transaction_id: draft.id });
          if (res && res.status === 'success') {
            toast('Transaction restored to active ledger.', 'success');
            close(true);
          }
        });
      }

      const splitCatBtn = $('[data-split-categories]');
      if (splitCatBtn) {
        splitCatBtn.addEventListener('click', async () => {
          const total = Number(draft.amount) || 0;
          if (!(total > 0)) {
            toast('Transaction amount must be greater than 0.', 'error');
            return;
          }

          const catOptions = categories.map((c) => ({ value: c.name, label: c.name }));
          const defaultCat = draft.category || categories[0]?.name || 'Groceries';
          const splitBody = `
            <div class="caption" style="margin-bottom:var(--gap-3)">
              Divide this ${h(formatCurrency(total, app.currency, app.locale))} transaction across multiple categories.
            </div>
            <div id="splitRows" style="display:flex;flex-direction:column;gap:10px">
              <div class="split-line row" style="gap:8px;align-items:center">
                <div style="flex:1;min-width:120px">
                  ${selectField({ key: 'split_cat', value: defaultCat, compact: true, options: catOptions })}
                </div>
                <input class="input split-amt" type="number" inputmode="decimal" placeholder="Amount" value="${Math.round(total / 2)}" style="max-width:110px">
                <input class="input split-note" type="text" placeholder="Note" style="flex:1">
              </div>
              <div class="split-line row" style="gap:8px;align-items:center">
                <div style="flex:1;min-width:120px">
                  ${selectField({ key: 'split_cat', value: defaultCat, compact: true, options: catOptions })}
                </div>
                <input class="input split-amt" type="number" inputmode="decimal" placeholder="Amount" value="${total - Math.round(total / 2)}" style="max-width:110px">
                <input class="input split-note" type="text" placeholder="Note" style="flex:1">
              </div>
            </div>
            <button type="button" class="btn btn-text btn-sm" id="addSplitLine" style="margin-top:8px">
              ${icon('add', 'icon-sm')}Add another line
            </button>
            <div class="card-flat" style="margin-top:var(--gap-3);background:var(--surface-container-highest)">
              <div class="row-between">
                <span class="caption">Allocated:</span>
                <span id="allocatedText" style="font-weight:700">${h(formatCurrency(total, app.currency, app.locale))}</span>
              </div>
              <div class="row-between" style="margin-top:4px">
                <span class="caption">Remaining:</span>
                <span id="remainingText" style="font-weight:700">₹0</span>
              </div>
            </div>`;

          await sheet('Split Transaction', splitBody, {
            actions: `
              <button class="btn btn-outlined" data-split-cancel>Cancel</button>
              <button class="btn btn-filled" data-split-confirm>${icon('check')}Apply Split</button>`,
            onMount(splitNode, splitClose) {
              bindSelectFields(splitNode);
              const rowsHost = splitNode.querySelector('#splitRows');
              const addLineBtn = splitNode.querySelector('#addSplitLine');
              const allocSpan = splitNode.querySelector('#allocatedText');
              const remSpan = splitNode.querySelector('#remainingText');

              const recalculate = () => {
                let sum = 0;
                splitNode.querySelectorAll('.split-amt').forEach((inp) => {
                  sum += Number(inp.value) || 0;
                });
                allocSpan.textContent = formatCurrency(sum, app.currency, app.locale);
                const rem = total - sum;
                remSpan.textContent = formatCurrency(rem, app.currency, app.locale);
                remSpan.style.color = Math.abs(rem) < 0.01 ? 'var(--income)' : 'var(--expense)';
              };

              splitNode.addEventListener('input', recalculate);

              addLineBtn.addEventListener('click', () => {
                const line = document.createElement('div');
                line.className = 'split-line row';
                line.style.gap = '8px';
                line.style.alignItems = 'center';
                line.innerHTML = `
                  <div style="flex:1;min-width:120px">
                    ${selectField({ key: 'split_cat', value: defaultCat, compact: true, options: catOptions })}
                  </div>
                  <input class="input split-amt" type="number" inputmode="decimal" placeholder="Amount" value="0" style="max-width:110px">
                  <input class="input split-note" type="text" placeholder="Note" style="flex:1">
                  <button type="button" class="icon-button" style="color:var(--expense)" aria-label="Remove line">${icon('close', 'icon-sm')}</button>`;
                bindSelectFields(line);
                line.querySelector('button').addEventListener('click', () => {
                  line.remove();
                  recalculate();
                });
                rowsHost.appendChild(line);
                recalculate();
              });

              splitNode.querySelector('[data-split-cancel]').addEventListener('click', () => splitClose(null));
              splitNode.querySelector('[data-split-confirm]').addEventListener('click', async () => {
                const lines = [];
                let sum = 0;
                splitNode.querySelectorAll('.split-line').forEach((l) => {
                  const catBtn = l.querySelector('.select-button');
                  const cat = catBtn ? catBtn.value : defaultCat;
                  const amt = Number(l.querySelector('.split-amt').value) || 0;
                  const note = l.querySelector('.split-note').value.trim();
                  if (amt > 0) {
                    lines.push({ category: cat, amount: amt, description: note || draft.description });
                    sum += amt;
                  }
                });

                if (Math.abs(sum - total) > 0.01) {
                  toast(`Split total (${formatCurrency(sum, app.currency, app.locale)}) must match original amount (${formatCurrency(total, app.currency, app.locale)}).`, 'error');
                  return;
                }

                if (lines.length < 2) {
                  toast('Please create at least 2 split lines.', 'error');
                  return;
                }

                const res = await Bridge.db('split_transaction', {
                  transaction_id: draft.id,
                  splits: lines,
                });

                if (res && res.status === 'success') {
                  toast(`Split into ${lines.length} transactions successfully.`, 'success');
                  splitClose(true);
                  close(true);
                } else {
                  toast(res?.message || 'Could not split transaction.', 'error');
                }
              });
            },
          });
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
