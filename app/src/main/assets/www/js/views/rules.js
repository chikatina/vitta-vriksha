/* SMS rules: how a bank alert becomes a transaction. */

import { Bridge } from '../bridge.js';
import {
  icon, h, toast, sheet, confirmDialog, emptyState, errorBlock, selectField, bindSelectFields,
} from '../ui.js';
import { formatCurrency } from '../formatters.js';
import { bindCategoryField, categoryOptions } from './category-field.js';

/* What the classifier decided, said in words a person can act on. */
const REASONS = {
  'possible-duplicate': 'Possible duplicate entry',
  ready: 'Matches a rule',
  'no-rule': 'No matching rule',
  'no-amount': 'No amount found',
  reminder: 'Reminder notice',
  otp: 'OTP message',
  promo: 'Promotional message',
  failed: 'Failed / reversed payment',
  balance: 'Balance update',
  request: 'Payment request',
  'card-payment': 'Credit card bill payment',
  'self-transfer': 'Self-transfer',
};

// Which slice of the inbox the screen is showing. Kept here so a refresh after filing
// something comes back to the same place rather than jumping to the top.
let reviewFilter = 'pending';
let activeTab = 'messages';

export async function renderRules(container, app) {
  const granted = Bridge.checkPermission('SMS');

  const [ruleRes, categoryRes, reviewRes] = await Promise.all([
    Bridge.call('sms', { action: 'get_rules' }),
    Bridge.db('get_categories'),
    granted ? Bridge.call('sms', { action: 'review', days: 0, filter: reviewFilter })
      : Promise.resolve({ items: [], counts: {} }),
  ]);

  const rules = ruleRes.rules || [];
  const categories = categoryRes.categories || [];
  const review = reviewRes.items || [];
  const counts = reviewRes.counts || {};

  container.innerHTML = `
    <div class="sticky-header">
      <div class="chip-scroller" data-page-tabs style="margin-bottom: 0;">
        <button type="button" class="chip" data-tab-select="messages" aria-selected="${activeTab === 'messages'}">
          ${icon('sms', 'icon-sm')}Alerts
        </button>
        <button type="button" class="chip" data-tab-select="rules" aria-selected="${activeTab === 'rules'}">
          ${icon('rule', 'icon-sm')}Rules
        </button>
      </div>
    </div>

    <!-- MESSAGES TAB CONTENT -->
    <div data-tab-content="messages" style="display: ${activeTab === 'messages' ? 'block' : 'none'}">
      ${granted ? '' : `
        <div class="card">
          <div class="row" style="gap:12px;align-items:flex-start;margin-bottom:14px">
            <span class="avatar" style="background:var(--warning-container);color:var(--warning)">
              ${icon('sms')}
            </span>
            <span class="list-row-main">
              <span class="list-row-title">Turn on bank SMS tracking</span>
              <span class="caption">
                Allow SMS access to parse bank transaction alerts locally on this device.
              </span>
            </span>
          </div>
          <button class="btn btn-filled btn-block" data-allow>
            ${icon('check_circle')}${Bridge.permissionIsBlocked('SMS') ? 'Open settings' : 'Allow SMS access'}
          </button>
        </div>`}

      ${granted ? `
        <div class="card">
          <div class="card-title">Sync SMS</div>
          <p class="caption" style="margin-bottom:14px">
            Sync incoming SMS alerts and auto-file recognized transactions.
          </p>
          <button class="btn btn-filled btn-block" data-sync>
            ${icon('autorenew')}Sync new messages
          </button>
          <button class="btn btn-tonal btn-block" data-import style="margin-top:10px">
            ${icon('history')}Scan last 90 days
          </button>
          <div class="caption" data-import-result style="margin-top:10px"></div>
        </div>` : ''}

      ${granted ? `
        <div class="section">
          <div class="section-header">
            <span class="title">Messages</span>
            <span class="caption">${counts.pending || 0} waiting · ${counts.filed || 0} filed</span>
          </div>
          <div class="chip-scroller review-filters" data-filters>
            ${[['pending', 'Waiting'], ['filed', 'Filed'], ['all', 'Everything']].map(([value, label]) => `
              <button type="button" class="chip" data-filter="${value}"
                      aria-selected="${reviewFilter === value}">${label}</button>`).join('')}
          </div>
          ${review.length ? `
            <div class="list">
              ${review.slice(0, 60).map((item, index) => `
                <div class="list-row">
                  <span class="avatar avatar-sm ${item.state === 'filed' ? 'avatar-filed' : 'avatar-waiting'}">
                    ${icon(item.state === 'filed' ? 'check' : (item.state === 'ignored' ? 'visibility_off' : 'help'))}
                  </span>
                  <span class="list-row-main">
                    <span class="list-row-title">
                      ${item.amount ? h(formatCurrency(item.amount, app.currency, app.locale)) : 'Amount unclear'}
                      ${item.merchant ? ` · ${h(item.merchant)}` : ''}
                    </span>
                    <span class="list-row-sub">
                      ${item.state === 'filed'
      ? `Filed as ${h(item.category)} · ${h(item.type)}`
      : h(REASONS[item.reason] || item.reason)}
                    </span>
                    <span class="caption">${h(item.body.slice(0, 110))}</span>
                  </span>
                  ${item.state === 'filed' ? `
                    <button class="btn btn-tonal btn-sm" data-edit="${index}">Change</button>
                    <button class="icon-button" data-duplicate="${index}" aria-label="Mark as a duplicate">
                      ${icon('content_copy')}
                    </button>`
      : `
                    <button class="btn btn-tonal btn-sm" data-classify="${index}">File</button>
                    <button class="icon-button" data-ignore="${index}" aria-label="Ignore this message">
                      ${icon('close')}
                    </button>`}
                </div>`).join('')}
            </div>`
      : `<div class="card">
                <div class="caption">
                  ${reviewFilter === 'pending'
        ? 'Nothing waiting. Every alert the app read was either filed or recognised as something that did not move money.'
        : 'No messages of this kind in the last 90 days.'}
                </div>
              </div>`}
        </div>` : ''}
    </div>

    <!-- RULES TAB CONTENT -->
    <div data-tab-content="rules" style="display: ${activeTab === 'rules' ? 'block' : 'none'}">
      <div class="card">
        <div class="card-title">SMS Rules</div>
        <p class="caption">
          Keywords match incoming bank SMS to auto-categorize transactions.
        </p>
      </div>

      <div class="card">
        <div class="card-title">Try a message</div>
        <div class="field">
          <textarea class="textarea" data-test rows="3"
            placeholder="Paste a bank SMS, for example: Rs 25,000.00 credited to A/C xx5678"></textarea>
        </div>
        <button class="btn btn-tonal btn-block" data-run style="margin-top:12px">${icon('science')}Test it</button>
        <div data-result style="margin-top:12px"></div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="title">Rules</span>
          <button class="btn btn-text btn-sm" data-add>${icon('add', 'icon-sm')}New</button>
        </div>
        ${rules.length ? `
          <div class="list">
            ${rules.map((rule) => `
              <div class="list-row">
                <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface-variant)">
                  ${icon(rule.transaction_type === 'Income' ? 'south_west' : (rule.transaction_type === 'Ignore' ? 'block' : 'north_east'))}
                </span>
                <span class="list-row-main">
                  <span class="list-row-title">${h(rule.rule_name)}</span>
                  <span class="list-row-sub">
                    Matches "${h(rule.body_trigger)}" · ${h(rule.category_name)}
                  </span>
                </span>
                <button class="icon-button" data-delete="${rule.id}" aria-label="Delete rule">${icon('delete')}</button>
              </div>`).join('')}
          </div>`
      : `<div class="card">${emptyState('rule', 'No rules', 'Add one to start classifying alerts.')}</div>`}
      </div>
    </div>`;

  // Tab switching click handlers
  container.querySelectorAll('[data-tab-select]').forEach((tabButton) => {
    tabButton.addEventListener('click', () => {
      const selected = tabButton.dataset.tabSelect;
      activeTab = selected;

      // Update button visual state
      container.querySelectorAll('[data-tab-select]').forEach((btn) => {
        btn.setAttribute('aria-selected', btn.dataset.tabSelect === selected ? 'true' : 'false');
      });

      // Update content section visibility
      container.querySelectorAll('[data-tab-content]').forEach((div) => {
        div.style.display = div.dataset.tabContent === selected ? 'block' : 'none';
      });
    });
  });

  const allowButton = container.querySelector('[data-allow]');
  if (allowButton) {
    allowButton.addEventListener('click', async () => {
      if (Bridge.permissionIsBlocked('SMS')) {
        Bridge.openAppSettings();
        return;
      }
      allowButton.disabled = true;
      const okay = await Bridge.requestPermission('SMS');
      if (okay) toast('Bank SMS tracking is on.', 'success');
      app.refresh();
    });
  }

  /*
   * The incremental sync. Covers the stretch since the last one rather than a fixed three
   * months, so the usual case reads a handful of messages instead of a thousand.
   */
  const syncButton = container.querySelector('[data-sync]');
  if (syncButton) {
    syncButton.addEventListener('click', async () => {
      const output = container.querySelector('[data-import-result]');
      syncButton.disabled = true;
      syncButton.textContent = 'Reading';

      const res = await Bridge.call('sms', {
        action: 'reimport',
        member_id: app.memberFilter === 'all' ? 1 : Number(app.memberFilter),
      });

      syncButton.disabled = false;
      syncButton.innerHTML = `${icon('autorenew')}Sync new messages`;

      if (res.status !== 'success') {
        output.innerHTML = errorBlock(res, { compact: true });
        return;
      }

      output.textContent = res.read === 0
        ? `Nothing new in the last ${res.days} ${res.days === 1 ? 'day' : 'days'}.`
        : `Read ${res.read} from the last ${res.days} ${res.days === 1 ? 'day' : 'days'}, `
          + `filed ${res.imported}. ${res.skipped} were already there.`;
      if (res.imported) toast(`Filed ${res.imported} transactions.`, 'success');
      if (res.imported || res.duplicates) app.refresh();
    });
  }

  const importButton = container.querySelector('[data-import]');
  if (importButton) {
    importButton.addEventListener('click', async () => {
      const output = container.querySelector('[data-import-result]');

      const range = await sheet('Import bank messages', `
        <div class="field">
          <label class="field-label">How far back would you like to scan?</label>
          <div class="list" style="margin-top:var(--gap-3)">
            <button type="button" class="list-row" data-range="0">
              <span class="avatar avatar-sm" style="background:var(--accent-container);color:var(--on-accent-container)">
                ${icon('all_inclusive', 'icon-sm')}
              </span>
              <span class="list-row-main">
                <span class="list-row-title">All time</span>
                <span class="list-row-sub">Scan your entire SMS history from day one</span>
              </span>
              ${icon('chevron_right', 'icon-sm')}
            </button>
            <button type="button" class="list-row" data-range="365">
              <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface)">
                ${icon('calendar_month', 'icon-sm')}
              </span>
              <span class="list-row-main">
                <span class="list-row-title">Last 1 year</span>
                <span class="list-row-sub">Past 365 days</span>
              </span>
              ${icon('chevron_right', 'icon-sm')}
            </button>
            <button type="button" class="list-row" data-range="180">
              <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface)">
                ${icon('date_range', 'icon-sm')}
              </span>
              <span class="list-row-main">
                <span class="list-row-title">Last 6 months</span>
                <span class="list-row-sub">Past 180 days</span>
              </span>
              ${icon('chevron_right', 'icon-sm')}
            </button>
            <button type="button" class="list-row" data-range="90">
              <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface)">
                ${icon('schedule', 'icon-sm')}
              </span>
              <span class="list-row-main">
                <span class="list-row-title">Last 90 days</span>
                <span class="list-row-sub">Past 3 months</span>
              </span>
              ${icon('chevron_right', 'icon-sm')}
            </button>
            <button type="button" class="list-row" data-range="30">
              <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface)">
                ${icon('today', 'icon-sm')}
              </span>
              <span class="list-row-main">
                <span class="list-row-title">Last 30 days</span>
                <span class="list-row-sub">Past month</span>
              </span>
              ${icon('chevron_right', 'icon-sm')}
            </button>
          </div>
        </div>`, {
        onMount(node, close) {
          node.querySelectorAll('[data-range]').forEach((btn) => {
            btn.addEventListener('click', () => close(Number(btn.dataset.range)));
          });
        },
      });

      if (range === null || range === undefined) return;

      importButton.disabled = true;
      importButton.textContent = 'Reading';

      const res = await Bridge.call('sms', {
        action: 'reimport',
        days: range,
        member_id: app.memberFilter === 'all' ? 1 : Number(app.memberFilter),
      });

      importButton.disabled = false;
      importButton.innerHTML = `${icon('history')}Import past messages`;

      if (res.status !== 'success') {
        output.innerHTML = errorBlock(res, { compact: true });
        return;
      }

      const rangeLabel = range === 0 ? 'all time' : `the last ${range} days`;
      output.textContent = `Read ${res.read} messages from ${rangeLabel}, filed ${res.imported}. `
        + `${res.skipped} were already there, ${res.unmatched} matched no rule`
        + `${res.duplicates ? `, and ${res.duplicates} look like a second message about a payment `
          + 'already recorded, so they are waiting below rather than filed twice' : ''}.`;
      if (res.imported) toast(`Filed ${res.imported} transactions.`, 'success');
      if (res.imported || res.duplicates) app.refresh();
    });
  }

  const runButton = container.querySelector('[data-run]');
  if (runButton) {
    runButton.addEventListener('click', async () => {
      const text = container.querySelector('[data-test]').value.trim();
      const output = container.querySelector('[data-result]');

      if (!text) {
        output.innerHTML = '<div class="caption">Paste a message first.</div>';
        return;
      }

      const res = await Bridge.call('sms', {
        action: 'parse_text', sms_text: text,
      });

      if (res.status !== 'success') {
        output.innerHTML = errorBlock(res, { compact: true });
        return;
      }

      output.innerHTML = res.matched_rule
        ? `<div class="card-flat">
             <div class="row-between" style="margin-bottom:6px">
               <span class="title">${h(formatCurrency(res.amount, app.currency, app.locale))}</span>
               <span class="badge ${res.type === 'Income' ? 'badge-income' : 'badge-expense'}">${h(res.type)}</span>
             </div>
             <div class="caption">Matched "${h(res.matched_rule)}", filed under ${h(res.category)}.</div>
           </div>`
        : `<div class="card-flat"><div class="caption">No rule matched that message.</div></div>`;
    });
  }

  container.querySelectorAll('[data-filter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      reviewFilter = chip.dataset.filter;
      app.refresh();
    });
  });

  container.querySelectorAll('[data-classify]').forEach((button) => {
    button.addEventListener('click', () => alertSheet(app, categories, review[Number(button.dataset.classify)]));
  });

  container.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => alertSheet(app, categories, review[Number(button.dataset.edit)]));
  });

  container.querySelectorAll('[data-ignore]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = review[Number(button.dataset.ignore)];
      const res = await Bridge.call('sms', { action: 'ignore_alert', body: item.body });
      if (res.status === 'success') {
        toast('Message ignored.', 'success');
        app.refresh();
      } else {
        toast(res.message || 'Could not ignore that message.', 'error');
      }
    });
  });

  container.querySelectorAll('[data-duplicate]').forEach((button) => {
    button.addEventListener('click', async () => {
      const item = review[Number(button.dataset.duplicate)];
      const confirmed = await confirmDialog(
        'Mark as a duplicate?',
        'The transaction it created is removed from your ledger, and this message will not '
        + 'be filed again by a later import.',
        { confirmLabel: 'Remove', danger: true },
      );
      if (!confirmed) return;

      const res = await Bridge.call('sms', { action: 'mark_duplicate', body: item.body });
      if (res.status === 'success') {
        toast(res.removed ? 'Duplicate removed.' : 'Message will not be filed again.', 'success');
        app.refresh();
      } else {
        toast(res.message || 'Could not remove that.', 'error');
      }
    });
  });

  const addButton = container.querySelector('[data-add]');
  if (addButton) {
    addButton.addEventListener('click', () => addRule(app, categories));
  }

  container.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const confirmed = await confirmDialog('Delete this rule?', 'Messages it matched will no longer be classified.',
        { confirmLabel: 'Delete', danger: true });
      if (!confirmed) return;

      const res = await Bridge.call('sms', {
        action: 'delete_rule', rule_id: Number(btn.dataset.delete),
      });
      if (res.status === 'success') {
        toast('Rule deleted.', 'success');
        app.refresh();
      } else {
        toast(res.message || 'Could not delete that rule.', 'error');
      }
    });
  });
}

/**
 * Turns one reviewed alert into a transaction, and into a rule for the next one.
 *
 * Everything the classifier managed to work out is filled in already, so the common case
 * is checking a category and pressing the button. What it could not work out, chiefly the
 * amount on a message whose wording nobody has taught it, is left for the user to type.
 */
async function alertSheet(app, categories, item) {
  if (!item) return;

  const filed = item.state === 'filed';
  const startType = filed ? item.type : (item.suggested_type || 'Expense');
  const startCategory = filed ? item.category : (item.suggested_category || '');

  const saved = await sheet(filed ? 'Change this transaction' : 'File this alert', `
    <div class="card-flat">
      <div class="caption">${h(item.body)}</div>
    </div>
    <div class="field">
      <label class="field-label" for="alertAmount">Amount</label>
      <input class="input" id="alertAmount" data-amount type="number" step="0.01" inputmode="decimal"
             value="${item.amount || ''}" placeholder="0.00" ${filed ? 'readonly' : ''}>
    </div>
    <div class="row" style="gap:12px;align-items:flex-end">
      ${selectField({
    key: 'type',
    label: 'Direction',
    id: 'alertType',
    value: startType,
    half: true,
    options: [
      { value: 'Expense', label: 'Money out' },
      { value: 'Income', label: 'Money in' },
      { value: 'Investment', label: 'Invested, such as a SIP' },
    ],
  })}
      ${selectField({
    key: 'category',
    label: 'Category',
    id: 'alertCategory',
    half: true,
    value: startCategory,
    options: categoryOptions(categories, startType),
  })}
    </div>
    <div class="field">
      <label class="field-label" for="alertMerchant">Merchant</label>
      <input class="input" id="alertMerchant" data-merchant type="text" autocomplete="off"
             value="${h(item.merchant || '')}" placeholder="Who was paid (optional)">
      <span class="caption">
        Naming one teaches the app: the next alert from the same merchant files itself,
        and anything already recorded under that name moves with it.
      </span>
    </div>
    <div class="field">
      <label class="field-label" for="alertNote">Note / Description</label>
      <input class="input" id="alertNote" data-note type="text" autocomplete="off"
             value="${h(item.description || '')}" placeholder="Optional note or description">
    </div>`, {
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-save>${filed ? 'Save' : 'File it'}</button>`,
    onMount(node, close) {
      bindSelectFields(node);
      const category = bindCategoryField(node, {
        id: 'alertCategory',
        half: true,
        categories,
        type: () => node.querySelector('#alertType').value,
      });
      node.querySelector('#alertType').addEventListener('change', () => category.setType());

      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      node.querySelector('[data-save]').addEventListener('click', async () => {
        const common = {
          type: node.querySelector('#alertType').value,
          category: category.value,
          merchant: node.querySelector('[data-merchant]').value.trim(),
          description: node.querySelector('[data-note]')?.value.trim() || '',
        };
        const res = await Bridge.call('sms', filed
          ? { action: 'reclassify_alert', transaction_id: item.transaction_id, ...common }
          : {
            action: 'classify_alert',
            body: item.body,
            sender: item.sender,
            date: item.date,
            amount: Number(node.querySelector('[data-amount]').value),
            member_id: app.memberFilter === 'all' ? 1 : Number(app.memberFilter),
            ...common,
          });

        if (res.status !== 'success') {
          toast(res.message || 'Could not save that.', 'error');
          return;
        }
        const also = Number(res.also_categorised || 0);
        const done = filed ? 'Updated.' : 'Filed.';
        toast(also > 0
          ? `${done} ${also} other ${also === 1 ? 'transaction' : 'transactions'} from the same merchant moved too.`
          : done, 'success');
        close(true);
      });
    },
  });

  if (saved) app.refresh();
}

async function addRule(app, categories) {
  const saved = await sheet('New rule', `
    <div class="field">
      <label class="field-label" for="ruleName">Name</label>
      <input class="input" id="ruleName" data-name type="text" placeholder="Salary credited" autocomplete="off">
    </div>
    <div class="field">
      <label class="field-label" for="ruleTrigger">Phrase to look for</label>
      <input class="input" id="ruleTrigger" data-trigger type="text" placeholder="credited" autocomplete="off">
      <span class="caption">Case does not matter. Keep it short and distinctive.</span>
    </div>
    <div class="row" style="gap:12px;align-items:flex-end">
      ${selectField({
    key: 'type',
    label: 'Direction',
    id: 'ruleType',
    value: 'Expense',
    half: true,
    options: [
      { value: 'Expense', label: 'Money out' },
      { value: 'Income', label: 'Money in' },
      { value: 'Ignore', label: 'Ignore message' },
    ],
  })}
      <div id="ruleCategoryWrapper" style="flex:1;min-width:0;">
        ${selectField({
    key: 'category',
    label: 'Category',
    id: 'ruleCategory',
    half: true,
    value: categoryOptions(categories, 'Expense')[0]?.value || 'Groceries',
    options: categoryOptions(categories, 'Expense'),
  })}
      </div>
    </div>
    <div class="field">
      <label class="field-label" for="ruleSender">Sender contains</label>
      <input class="input" id="ruleSender" data-sender type="text" placeholder="HDFCBK (optional)" autocomplete="off">
    </div>`, {
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-save>Add rule</button>`,
    onMount(node, close) {
      bindSelectFields(node);
      const categoryWrapper = node.querySelector('#ruleCategoryWrapper');
      const category = bindCategoryField(node, {
        id: 'ruleCategory',
        half: true,
        categories,
        type: () => node.querySelector('#ruleType').value,
      });

      const updateCategoryVisibility = () => {
        const type = node.querySelector('#ruleType').value;
        if (type === 'Ignore') {
          categoryWrapper.style.display = 'none';
        } else {
          categoryWrapper.style.display = 'block';
          category.setType();
        }
      };

      node.querySelector('#ruleType').addEventListener('change', updateCategoryVisibility);

      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      node.querySelector('[data-save]').addEventListener('click', async () => {
        const name = node.querySelector('[data-name]').value.trim();
        const trigger = node.querySelector('[data-trigger]').value.trim();
        const type = node.querySelector('#ruleType').value;

        if (!name || !trigger) {
          toast('A rule needs a name and a phrase.', 'error');
          return;
        }

        const categoryName = type === 'Ignore'
          ? 'Ignore'
          : (category.value || (type === 'Income' ? 'Salary' : 'Groceries'));

        const res = await Bridge.call('sms', {
          action: 'add_rule',
          rule: {
            rule_name: name,
            body_trigger: trigger,
            transaction_type: type,
            category_name: categoryName,
            sender_keyword: node.querySelector('[data-sender]').value.trim(),
          },
        });

        if (res.status === 'success') {
          toast('Rule added.', 'success');
          close(true);
        } else {
          toast(res.message || 'Could not save that rule.', 'error');
        }
      });
    },
  });

  if (saved) app.refresh();
}
