import { Bridge } from '../bridge.js';
import {
  icon, h, toast, sheet, confirmDialog, emptyState, errorBlock, selectField, bindSelectFields, showProgressModal,
} from '../ui.js';
import { formatCurrency, formatDate } from '../formatters.js';
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
let reviewSubFilter = 'all';
let selectMode = false;
const selectedIndices = new Set();
let activeTab = 'messages';

function pickCategorySheet(app, categories, currentCategory, onPicked) {
  sheet('Choose Category', `
    <div class="field">
      <label class="field-label">Select Category</label>
      <div class="list" style="margin-top:var(--gap-2);max-height:340px;overflow-y:auto">
        ${categories.map((c) => `
          <button type="button" class="list-row" data-choose-category="${h(c.name)}" ${c.name === currentCategory ? 'data-selected="true"' : ''} style="cursor:pointer;width:100%;text-align:left;display:flex;align-items:center;gap:10px">
            <span class="avatar avatar-sm" style="background:${h(c.color || 'var(--accent-container)')};color:${h(c.on_color || 'var(--on-accent-container)')}">
              ${icon(c.icon || 'sell', 'icon-sm')}
            </span>
            <span class="list-row-main" style="flex:1">
              <span class="list-row-title">${h(c.name)}</span>
              ${c.type ? `<span class="list-row-sub">${h(c.type)}</span>` : ''}
            </span>
            ${c.name === currentCategory ? `<span style="color:var(--accent);display:flex">${icon('check', 'icon-sm')}</span>` : ''}
          </button>`).join('')}
      </div>
    </div>`, {
    onMount(node, close) {
      const selected = node.querySelector('[data-selected="true"]');
      if (selected) {
        setTimeout(() => {
          try {
            selected.scrollIntoView({ block: 'center', behavior: 'smooth' });
          } catch {
            selected.scrollIntoView();
          }
        }, 50);
      }
      node.querySelectorAll('[data-choose-category]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const picked = btn.dataset.chooseCategory;
          if (picked) onPicked(picked);
          close();
        });
      });
    },
  });
}

function renderDuplicateCard(item, itemIndex, categories, isSelectMode, isSelected, app) {
  const twin = item.duplicate_twin || {};
  const isExactUtr = twin.match_reason === 'exact-utr';
  const matchReasonText = isExactUtr
    ? 'Exact Reference / UTR Match'
    : (twin.merchant && item.merchant && twin.merchant.toLowerCase() === item.merchant.toLowerCase()
      ? 'Same Merchant, Amount & Date'
      : 'Same Amount & Date as Recorded Entry');

  const incomingAmount = item.amount ? formatCurrency(item.amount, app.currency, app.locale) : '0';
  const existingAmount = twin.amount ? formatCurrency(twin.amount, app.currency, app.locale) : incomingAmount;

  const incomingMerchant = item.merchant || 'Unknown Merchant';
  const existingMerchant = twin.merchant || 'Recorded Transaction';

  const incomingCat = item.chosenCategory || item.suggested_category || 'Shopping';
  const existingCat = twin.category || 'Shopping';

  const incomingInst = item.account_name || (item.card_id ? 'Credit Card' : (item.account_id ? 'Bank A/c' : ''));
  const existingInst = twin.instrument_name || '';

  return `
    <div class="duplicate-compare-card ${isExactUtr ? 'high-confidence' : ''}" data-item-row="${itemIndex}">
      <div class="row-between" style="align-items:center;gap:6px;flex-wrap:wrap">
        <div class="row" style="gap:6px;align-items:center;min-width:0">
          ${isSelectMode ? `
            <input type="checkbox" data-select-item="${itemIndex}" ${isSelected ? 'checked' : ''} style="width:18px;height:18px;margin:0 2px 0 0;cursor:pointer;flex-shrink:0;accent-color:var(--accent)">` : ''}
          <span class="avatar avatar-sm avatar-warning" style="flex-shrink:0">
            ${icon('content_copy', 'icon-sm')}
          </span>
          <div style="min-width:0">
            <div class="row" style="gap:6px;align-items:center">
              <span style="font-weight:700;font-size:14px;color:var(--on-surface)">Potential Duplicate</span>
              <span class="badge ${isExactUtr ? 'badge-income' : 'badge-warning'}" style="font-size:10px;padding:1px 6px">
                ${isExactUtr ? '100% Match' : 'Possible Twin'}
              </span>
            </div>
            <span class="caption" style="font-size:11px;color:var(--on-surface-variant)">${h(matchReasonText)}</span>
          </div>
        </div>
        <button type="button" class="btn btn-outlined btn-xs" data-compare-duplicate="${itemIndex}" style="gap:3px;padding:3px 8px;font-size:11px">
          ${icon('tune', 'icon-sm')}Compare
        </button>
      </div>

      <div class="twin-split-grid">
        <!-- EXISTING IN LEDGER -->
        <div class="twin-panel existing">
          <div class="twin-panel-header">
            <span>Existing Record</span>
            <span class="badge badge-tonal" style="font-size:9.5px;padding:0 4px">In Ledger</span>
          </div>
          <div class="row-between" style="align-items:baseline;gap:4px">
            <span class="display expense" style="font-size:16px;font-weight:700">
              -${h(existingAmount)}
            </span>
            <span class="caption" style="font-size:11px">${h(formatDate(twin.date || item.date))}</span>
          </div>
          <div class="twin-panel-title">${h(existingMerchant)}</div>
          <div class="row" style="gap:4px;flex-wrap:wrap;margin-top:2px">
            <span class="badge badge-tonal" style="font-size:10.5px">${h(existingCat)}</span>
            ${existingInst ? `<span class="badge badge-tonal" style="font-size:10.5px">${h(existingInst)}</span>` : ''}
          </div>
          ${twin.raw_sms ? `
            <details style="margin-top:4px;font-size:11px">
              <summary style="cursor:pointer;opacity:0.75">Show Original SMS</summary>
              <div class="sms-raw-box">${h(twin.raw_sms)}</div>
            </details>` : ''}
        </div>

        <!-- INCOMING ALERT -->
        <div class="twin-panel incoming">
          <div class="twin-panel-header">
            <span>Incoming SMS</span>
            <span class="badge badge-income" style="font-size:9.5px;padding:0 4px">New Alert</span>
          </div>
          <div class="row-between" style="align-items:baseline;gap:4px">
            <span class="display expense" style="font-size:16px;font-weight:700">
              -${h(incomingAmount)}
            </span>
            <span class="caption" style="font-size:11px">${h(formatDate(item.date))}</span>
          </div>
          <div class="twin-panel-title">${h(incomingMerchant)}</div>
          <div class="row" style="gap:4px;flex-wrap:wrap;margin-top:2px">
            <span class="badge badge-tonal" style="font-size:10.5px">${h(incomingCat)}</span>
            ${incomingInst ? `<span class="badge badge-tonal" style="font-size:10.5px">${h(incomingInst)}</span>` : ''}
          </div>
          <details style="margin-top:4px;font-size:11px" open>
            <summary style="cursor:pointer;opacity:0.75">Incoming SMS</summary>
            <div class="sms-raw-box">${h(item.body)}</div>
          </details>
        </div>
      </div>

      <!-- 3-WAY INSTANT ACTION BAR -->
      <div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;padding-top:6px;border-top:1px solid var(--outline-variant);flex-wrap:wrap">
        <button type="button" class="btn btn-tonal btn-xs" data-discard-duplicate="${itemIndex}" style="gap:3px;padding:5px 10px;font-size:11.5px" title="Ignore incoming SMS as duplicate">
          ${icon('visibility_off', 'icon-sm')}Discard
        </button>
        <button type="button" class="btn btn-filled btn-xs" data-merge-duplicate="${itemIndex}" style="gap:3px;padding:5px 10px;font-size:11.5px;background:var(--accent);color:var(--on-accent)" title="Merge details into existing transaction">
          ${icon('autorenew', 'icon-sm')}Merge
        </button>
        <button type="button" class="btn btn-outlined btn-xs" data-keep-both="${itemIndex}" style="gap:3px;padding:5px 10px;font-size:11.5px" title="Keep both as separate transactions">
          ${icon('add', 'icon-sm')}Keep Both
        </button>
      </div>
    </div>`;
}

function renderAlertCard(item, itemIndex, categories, isSelectMode, isSelected, app) {
  const isPending = item.state === 'pending';
  if (isPending && (item.duplicate_of > 0 || item.reason === 'possible-duplicate')) {
    return renderDuplicateCard(item, itemIndex, categories, isSelectMode, isSelected, app);
  }

  const itemType = isPending ? (item.suggested_type || 'Expense') : item.type;
  const matchingCats = categories.filter((c) => !c.type || c.type === itemType);
  const selectedCat = isPending ? (item.chosenCategory || item.suggested_category || matchingCats[0]?.name || 'Shopping') : item.category;
  const catObj = categories.find((c) => c.name === selectedCat);
  const catIcon = catObj?.icon || 'sell';

  if (!isPending) {
    return `
      <div class="list-row" data-item-row="${itemIndex}" style="align-items:center;gap:var(--gap-3);padding:12px 14px">
        <span class="avatar avatar-sm ${item.state === 'filed' ? 'avatar-filed' : 'avatar-waiting'}">
          ${icon(item.state === 'filed' ? 'check' : 'visibility_off')}
        </span>
        <span class="list-row-main" style="min-width:0;flex:1">
          <span class="list-row-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${item.amount ? h(formatCurrency(item.amount, app.currency, app.locale)) : 'Amount unclear'}
            ${item.merchant ? ` · ${h(item.merchant)}` : ''}
          </span>
          <span class="list-row-sub">
            ${item.state === 'filed'
              ? `Filed as ${h(item.category)} · ${h(item.type)}`
              : h(REASONS[item.reason] || item.reason)}
          </span>
          <span class="caption" style="overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${h(item.body.slice(0, 140))}</span>
        </span>
        ${item.state === 'filed' ? `
          <div class="row" style="gap:4px;flex-shrink:0">
            <button class="btn btn-tonal btn-xs" data-edit="${itemIndex}" style="padding:4px 8px">Change</button>
            <button class="icon-button" data-duplicate="${itemIndex}" aria-label="Mark as a duplicate">
              ${icon('content_copy', 'icon-sm')}
            </button>
          </div>` : ''}
      </div>`;
  }

  return `
    <div class="card-flat" data-item-row="${itemIndex}" style="background:var(--surface-container-high);padding:12px 14px;border-radius:var(--radius-md);border:1px solid var(--outline-variant);display:flex;flex-direction:column;gap:8px;width:100%;box-sizing:border-box">
      <div style="display:flex;align-items:flex-start;gap:10px;width:100%">
        ${isSelectMode ? `
          <input type="checkbox" data-select-item="${itemIndex}" ${isSelected ? 'checked' : ''} style="width:18px;height:18px;margin-top:3px;cursor:pointer;flex-shrink:0;accent-color:var(--accent)">` : ''}
        <span class="avatar avatar-sm ${item.duplicate_of > 0 ? 'avatar-warning' : 'avatar-waiting'}" style="flex-shrink:0;margin-top:2px">
          ${icon(item.duplicate_of > 0 ? 'content_copy' : (item.reason === 'ready' ? 'receipt_long' : 'help'), 'icon-sm')}
        </span>
        <div style="flex:1;min-width:0">
          <div class="row-between" style="align-items:center;gap:6px">
            <span style="font-weight:700;font-size:15px;color:var(--on-surface);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              ${item.amount ? h(formatCurrency(item.amount, app.currency, app.locale)) : 'Amount unclear'}
              ${item.merchant ? ` · ${h(item.merchant)}` : ''}
            </span>
            <span class="badge ${item.reason === 'ready' ? 'badge-income' : (item.duplicate_of > 0 ? 'badge-warning' : 'badge-tonal')}" style="font-size:10px;padding:1px 6px;text-transform:uppercase;letter-spacing:0.3px;flex-shrink:0">
              ${h(REASONS[item.reason] || item.reason)}
            </span>
          </div>
          ${item.date ? `<span class="caption" style="display:block;font-size:11px;color:var(--on-surface-variant);margin-top:1px">${h(formatDate(item.date))}</span>` : ''}
          <div class="caption" style="margin-top:4px;font-size:11.5px;color:var(--on-surface-variant);line-height:1.35;word-break:break-word">${h(item.body.slice(0, 140))}</div>
        </div>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:8px;border-top:1px solid var(--outline-variant);flex-wrap:wrap">
        <button type="button" class="chip chip-sm" data-pick-cat="${itemIndex}" style="font-size:11.5px;display:inline-flex;align-items:center;gap:4px;background:var(--surface-container);border:1px solid var(--outline-variant);border-radius:var(--radius-full);padding:3px 10px;cursor:pointer;max-width:100%;box-sizing:border-box">
          <span style="color:var(--accent);display:flex">${icon(catIcon, 'icon-sm')}</span>
          <span data-cat-label="${itemIndex}" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h(selectedCat)}</span>
          ${icon('expand_more', 'icon-sm')}
        </button>

        <div class="card-actions-row" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <button type="button" class="btn btn-filled btn-xs" data-quick-accept="${itemIndex}" style="gap:3px;padding:4px 8px;font-size:11.5px">
            ${icon('check', 'icon-sm')}Accept
          </button>
          <button type="button" class="btn btn-tonal btn-xs" data-ignore="${itemIndex}" style="gap:3px;padding:4px 8px;font-size:11.5px">
            ${icon('visibility_off', 'icon-sm')}Discard
          </button>
          <button type="button" class="btn btn-outlined btn-xs" data-classify="${itemIndex}" style="gap:3px;padding:4px 8px;font-size:11.5px">
            ${icon('edit', 'icon-sm')}Details
          </button>
        </div>
      </div>
    </div>`;
}

export async function renderRules(container, app) {
  const granted = Bridge.checkPermission('SMS');
  const smsTrackingActive = granted && Bridge.isSmsTrackingEnabled();

  const [ruleRes, merchantRes, categoryRes, reviewRes, discoverRes] = await Promise.all([
    Bridge.call('sms', { action: 'get_rules' }),
    Bridge.call('sms', { action: 'get_merchant_rules' }),
    Bridge.db('get_categories'),
    granted ? Bridge.call('sms', { action: 'review', days: 0, filter: reviewFilter })
      : Promise.resolve({ items: [], counts: {} }),
    Bridge.db('discover_accounts_from_sms'),
  ]);

  const rules = ruleRes.rules || [];
  const merchantRules = merchantRes.rules || [];
  const categories = categoryRes.categories || [];
  const review = reviewRes.items || [];
  const counts = reviewRes.counts || {};
  const discovered = discoverRes.discovered || [];
  const existingAccounts = discoverRes.existing_accounts || [];
  const existingCards = discoverRes.existing_cards || [];

  const readyList = review.filter((i) => i.state === 'pending' && (i.reason === 'ready' || i.suggested_category) && i.amount > 0);
  const dupList = review.filter((i) => i.state === 'pending' && (i.duplicate_of > 0 || i.reason === 'possible-duplicate'));
  const unclearList = review.filter((i) => i.state === 'pending' && (!i.amount || i.amount <= 0 || i.reason === 'amount-missing' || i.reason === 'no-rule'));
  const allPendingList = review.filter((i) => i.state === 'pending');

  let filteredReview = review;
  if (reviewFilter === 'pending') {
    if (reviewSubFilter === 'ready') filteredReview = readyList;
    else if (reviewSubFilter === 'dups') filteredReview = dupList;
    else if (reviewSubFilter === 'unclear') filteredReview = unclearList;
    else filteredReview = allPendingList;
  }

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
      ${discovered.length ? `
        <div class="card" style="border:1px solid var(--accent);background:var(--surface-container-low)">
          <div class="row-between" style="align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
            <div class="row" style="gap:6px;align-items:center;min-width:0">
              <span style="color:var(--accent);display:flex;flex-shrink:0">${icon('star', 'icon-sm')}</span>
              <span style="font-weight:700;font-size:13.5px;white-space:nowrap">Discovered Accounts</span>
              <span class="badge badge-income" style="font-size:11px;padding:2px 8px">${discovered.length}</span>
            </div>
            <button class="btn btn-filled btn-xs" data-add-all-discovered style="flex-shrink:0">
              ${icon('check_circle', 'icon-sm')}Add All
            </button>
          </div>
          <p class="caption" style="margin-bottom:12px">
            Detected from your SMS alerts. Tap any row to inspect details or combine with an existing account.
          </p>
          <div class="list" style="background:transparent;box-shadow:none;display:flex;flex-direction:column;gap:10px">
            ${discovered.map((d, i) => `
              <div class="card-flat" style="background:var(--surface-container-high);padding:14px;border-radius:var(--radius-md);border:1px solid var(--outline-variant);display:flex;flex-direction:column;gap:10px;width:100%;box-sizing:border-box">
                <div style="display:flex;align-items:flex-start;gap:12px;cursor:pointer" data-inspect-discovered="${i}">
                  <span class="avatar avatar-sm ${d.instrument_type === 'credit_card' ? 'avatar-credit' : (d.instrument_type === 'debit_card' || d.instrument_type === 'prepaid_card' ? 'avatar-debit' : (d.instrument_type === 'wallet' ? 'avatar-wallet' : (d.instrument_type === 'meal_card' ? 'avatar-meal' : 'avatar-bank')))}" style="flex-shrink:0;margin-top:2px">
                    ${icon(
                      d.instrument_type === 'debit_card' ? 'payments' :
                      (d.instrument_type === 'credit_card' ? 'credit_card' :
                      (d.instrument_type === 'meal_card' || d.category === 'Meal Card' ? 'restaurant' :
                      (d.instrument_type === 'wallet' || d.category === 'Wallet' ? 'account_balance_wallet' :
                      (d.instrument_type === 'prepaid_card' || d.category === 'Prepaid Card' ? 'credit_card' : 'account_balance')))),
                      'icon-sm'
                    )}
                  </span>
                  <div style="flex:1;min-width:0">
                    <div class="row-between" style="align-items:center;gap:6px">
                      <div style="font-weight:700;font-size:13.5px;color:var(--on-surface);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                        ${h(d.suggested_name || d.name || d.card_name)}
                      </div>
                      <span class="badge ${d.instrument_type === 'credit_card' ? 'badge-gold' : (d.instrument_type === 'debit_card' || d.instrument_type === 'prepaid_card' ? 'badge-income' : (d.instrument_type === 'wallet' ? 'badge-info' : (d.instrument_type === 'meal_card' ? 'badge-warning' : 'badge-income')))}" style="font-size:10px;padding:1px 6px;text-transform:uppercase;letter-spacing:0.3px;flex-shrink:0">
                        ${h(
                          d.instrument_type === 'debit_card' ? 'Debit Card' :
                          (d.instrument_type === 'credit_card' ? 'Credit Card' :
                          (d.instrument_type === 'meal_card' || d.category === 'Meal Card' ? 'Meal Card' :
                          (d.instrument_type === 'wallet' || d.category === 'Wallet' ? 'Wallet' :
                          (d.instrument_type === 'prepaid_card' || d.category === 'Prepaid Card' ? 'Prepaid' : 'Bank A/c'))))
                        )}
                      </span>
                    </div>
                    <div class="caption" style="font-size:11.5px;margin-top:2px;color:var(--on-surface-variant)">
                      ${h(d.bank || d.institution || 'Bank')} · ending ${h(d.last_4)}
                    </div>
                    ${d.txn_count ? `
                      <div class="caption" style="color:var(--accent);font-size:11px;font-weight:600;margin-top:3px">
                        ${d.txn_count} alert${d.txn_count === 1 ? '' : 's'}${d.total_spent ? ` · ${h(formatCurrency(d.total_spent, app.currency, app.locale))}` : ''}${d.last_seen ? ` · Last active ${h(formatDate(d.last_seen))}` : ''}
                      </div>` : ''}
                  </div>
                </div>

                <div class="discovered-card-actions">
                  <button class="btn btn-tonal btn-xs" data-inspect-discovered="${i}">
                    ${icon('open_in_new', 'icon-sm')}Link / Details
                  </button>
                  <div class="discovered-btn-group">
                    <button class="btn btn-filled btn-xs" data-add-discovered="${i}">
                      ${icon('add', 'icon-sm')}Add
                    </button>
                    <button class="btn btn-outlined btn-xs" data-ignore-discovered="${i}" style="color:var(--on-surface-variant);border-color:var(--outline-variant)">
                      ${icon('visibility_off', 'icon-sm')}Ignore
                    </button>
                  </div>
                </div>
              </div>`).join('')}
          </div>
        </div>` : ''}

      ${granted ? `
        <div class="card">
          <div class="row-between">
            <div style="flex:1;padding-right:12px">
              <div class="card-title" style="margin-bottom:2px">Bank SMS Tracking</div>
              <p class="caption" style="margin-bottom:0">
                ${smsTrackingActive
    ? 'Active · Automatically parsing incoming bank transaction alerts locally.'
    : 'Paused · SMS parsing is turned off and incoming messages are ignored.'}
              </p>
            </div>
            <button class="btn btn-sm ${smsTrackingActive ? 'btn-filled' : 'btn-outlined'}" data-toggle-sms>
              ${smsTrackingActive ? `${icon('check', 'icon-sm')}Active` : 'Paused'}
            </button>
          </div>
        </div>` : `
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

      ${granted && smsTrackingActive ? `
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
            <span class="caption">${counts.pending || 0} waiting · ${counts.filed || 0} filed · ${counts.ignored || 0} ignored</span>
          </div>
          <div class="chip-scroller review-filters" data-filters>
            ${[
              ['pending', `Waiting (${counts.pending || 0})`],
              ['filed', `Filed (${counts.filed || 0})`],
              ['ignored', `Ignored / OTP (${counts.ignored || 0})`],
              ['all', 'Everything'],
            ].map(([value, label]) => `
              <button type="button" class="chip" data-filter="${value}"
                      aria-selected="${reviewFilter === value}">${label}</button>`).join('')}
          </div>

          ${reviewFilter === 'pending' && allPendingList.length > 0 ? `
            <div class="chip-scroller" data-sub-filters style="margin-top:var(--gap-2);margin-bottom:var(--gap-2)">
              <button type="button" class="chip chip-sm" data-sub-filter="all" aria-selected="${reviewSubFilter === 'all'}">
                All (${allPendingList.length})
              </button>
              <button type="button" class="chip chip-sm" data-sub-filter="ready" aria-selected="${reviewSubFilter === 'ready'}">
                ${icon('check_circle', 'icon-sm')}Ready (${readyList.length})
              </button>
              <button type="button" class="chip chip-sm" data-sub-filter="dups" aria-selected="${reviewSubFilter === 'dups'}">
                ${icon('content_copy', 'icon-sm')}Duplicates (${dupList.length})
              </button>
              <button type="button" class="chip chip-sm" data-sub-filter="unclear" aria-selected="${reviewSubFilter === 'unclear'}">
                ${icon('visibility_off', 'icon-sm')}Unclear (${unclearList.length})
              </button>
            </div>` : ''}

          ${(() => {
            if (reviewFilter !== 'pending' || !allPendingList.length) return '';
            return `
              <div class="row" style="gap:6px;margin:8px 0 12px;flex-wrap:wrap;align-items:center;justify-content:space-between">
                <div class="row" style="gap:6px;flex-wrap:wrap;align-items:center">
                  ${readyList.length ? `
                    <button type="button" class="btn btn-filled btn-xs" data-accept-all-ready style="gap:4px">
                      ${icon('check_circle', 'icon-sm')}Accept All Ready (${readyList.length})
                    </button>` : ''}
                  ${dupList.length ? `
                    <button type="button" class="btn btn-tonal btn-xs" data-discard-all-duplicates style="gap:4px">
                      ${icon('content_copy', 'icon-sm')}Discard ${dupList.length} Duplicate${dupList.length === 1 ? '' : 's'}
                    </button>` : ''}
                  ${unclearList.length ? `
                    <button type="button" class="btn btn-tonal btn-xs" data-discard-all-unclear style="gap:4px">
                      ${icon('visibility_off', 'icon-sm')}Discard ${unclearList.length} Unclear
                    </button>` : ''}
                  ${allPendingList.length > 1 ? `
                    <button type="button" class="btn btn-outlined btn-xs" data-discard-all-waiting style="gap:4px">
                      ${icon('delete', 'icon-sm')}Discard All Waiting
                    </button>` : ''}
                </div>
                <button type="button" class="btn btn-sm ${selectMode ? 'btn-filled' : 'btn-tonal'}" data-toggle-select style="gap:4px;height:28px;padding:0 10px;font-size:11.5px">
                  ${icon(selectMode ? 'check' : 'check_circle', 'icon-sm')}<span>${selectMode ? 'Done' : 'Select'}</span>
                </button>
              </div>`;
          })()}

          ${filteredReview.length ? `
            <div class="list" data-stream-container style="background:transparent;box-shadow:none;display:flex;flex-direction:column;gap:10px"></div>
            <div data-stream-sentinel style="height:10px;margin-top:4px"></div>
            <div data-stream-footer style="margin-top:10px;text-align:center"></div>`
          : `<div class="card">
              <div class="caption">
                ${reviewFilter === 'pending'
                  ? 'Nothing waiting. Every alert the app read was either filed or recognised as something that did not move money.'
                  : 'No messages in this filter in the last 90 days.'}
              </div>
            </div>`}
          <div data-batch-bar-host></div>
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
        <div class="card-title">Test an SMS Alert</div>
        <p class="caption" style="margin-bottom:12px">
          Paste a message to see how the classifier and your custom rules will process it.
        </p>
        <div class="row" style="gap:8px;margin-bottom:10px">
          <input type="text" class="input" data-test-sender placeholder="Sender ID (e.g. HDFCBK, ICICIB)" style="flex:1">
          <button type="button" class="btn btn-tonal btn-sm" data-clear-test style="gap:4px">
            ${icon('delete', 'icon-sm')}Clear
          </button>
        </div>
        <div class="field">
          <textarea class="textarea" data-test rows="3"
            placeholder="Paste a bank SMS, for example: ICICI Bank Account XX486 credited:Rs. 25.00 on 10-Jul-26..."></textarea>
        </div>
        <button class="btn btn-filled btn-block" data-run style="margin-top:12px">${icon('science')}Test it</button>
        <div data-result style="margin-top:12px"></div>
      </div>

      <div class="section">
        <div class="section-header">
          <span class="title">SMS Rules</span>
          <button class="btn btn-text btn-sm" data-add>${icon('add', 'icon-sm')}New</button>
        </div>
        ${rules.length ? `
          <div class="list">
            ${rules.map((rule) => `
              <div class="list-row">
                <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface-variant)">
                  ${icon(rule.transaction_type === 'Income' ? 'south_west' : (rule.transaction_type === 'Ignore' ? 'visibility_off' : (rule.transaction_type === 'Transfer' ? 'autorenew' : 'north_east')))}
                </span>
                <span class="list-row-main">
                  <span class="list-row-title">${h(rule.rule_name)}</span>
                  <span class="list-row-sub">
                    Matches "${h(rule.body_trigger)}" · ${rule.transaction_type === 'Ignore' ? '<span class="badge" style="background:var(--surface-container-highest);color:var(--outline);font-size:10px">Auto-Discard</span>' : (rule.transaction_type === 'Transfer' ? '<span class="badge" style="background:var(--accent-container);color:var(--on-accent-container);font-size:10px">Transfer</span>' : h(rule.category_name))}
                  </span>
                </span>
                <button class="icon-button" data-delete="${rule.id}" aria-label="Delete rule">${icon('delete')}</button>
              </div>`).join('')}
          </div>`
      : `<div class="card">${emptyState('rule', 'No rules', 'Add one to start classifying alerts.')}</div>`}
      </div>

      <div class="section" style="margin-top:var(--gap-4)">
        <div class="section-header">
          <span class="title">Learned Counterparty & Discard Rules</span>
        </div>
        <p class="caption" style="margin-bottom:8px">
          Rules learned from your categorization and ignored alerts. Messages matching these merchants will auto-classify or auto-discard.
        </p>
        ${merchantRules.length ? `
          <div class="list">
            ${merchantRules.map((m) => `
              <div class="list-row">
                <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface-variant)">
                  ${icon(m.transaction_type === 'Income' ? 'south_west' : (m.transaction_type === 'Ignore' ? 'visibility_off' : (m.transaction_type === 'Transfer' ? 'autorenew' : 'north_east')))}
                </span>
                <span class="list-row-main">
                  <span class="list-row-title">${h(m.display_name || m.merchant_key)}</span>
                  <span class="list-row-sub">
                    ${m.transaction_type === 'Ignore' ? '<span class="badge" style="background:var(--surface-container-highest);color:var(--outline);font-size:10.5px">Auto-Discard</span>' : (m.transaction_type === 'Transfer' ? '<span class="badge" style="background:var(--accent-container);color:var(--on-accent-container);font-size:10.5px">Transfer (NPS/Demat)</span>' : h(m.category_name))}
                    ${m.hits ? ` · ${m.hits} applied` : ''}
                  </span>
                </span>
                <button class="icon-button" data-forget-merchant="${h(m.merchant_key)}" aria-label="Delete learned rule">${icon('delete')}</button>
              </div>`).join('')}
          </div>`
      : `<div class="card"><div class="caption">No learned counterparty rules yet. Transactions you categorize or ignore with "Create Rule" will appear here.</div></div>`}
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

  const toggleSmsButton = container.querySelector('[data-toggle-sms]');
  if (toggleSmsButton) {
    toggleSmsButton.addEventListener('click', () => {
      const newState = !smsTrackingActive;
      Bridge.setSmsTrackingEnabled(newState);
      toast(newState ? 'Bank SMS tracking is active.' : 'Bank SMS tracking is paused.', 'info');
      app.refresh();
    });
  }

  const allowButton = container.querySelector('[data-allow]');
  if (allowButton) {
    allowButton.addEventListener('click', async () => {
      if (Bridge.permissionIsBlocked('SMS')) {
        Bridge.openAppSettings();
        return;
      }
      allowButton.disabled = true;
      const okay = await Bridge.requestPermission('SMS');
      if (okay) {
        Bridge.setSmsTrackingEnabled(true);
        toast('Bank SMS tracking is on.', 'success');
      }
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
                ${icon('history', 'icon-sm')}
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
                ${icon('event', 'icon-sm')}
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

  container.querySelectorAll('[data-add-discovered]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = discovered[Number(btn.dataset.addDiscovered)];
      if (!item) return;
      btn.disabled = true;
      btn.textContent = '...';

      const isCard = item.kind === 'card' || item.instrument_type === 'credit_card';
      const isDebit = item.is_debit_card || item.instrument_type === 'debit_card';
      const bank = item.bank || item.institution || 'Bank';
      const last4 = item.last_4 || '';

      const recordPayload = isCard ? {
        card_name: item.suggested_name || item.name || `${bank} Credit Card`,
        bank,
        last_4: last4,
        total_limit: 0,
        current_balance: 0,
      } : {
        name: item.suggested_name || item.name || `${bank} Account`,
        category: item.category || (isDebit ? 'Bank' : (item.instrument_type === 'meal_card' ? 'Meal Card' : (item.instrument_type === 'wallet' ? 'Wallet' : 'Bank'))),
        institution: bank,
        account_number: isDebit ? (item.account_number || '') : (last4 || item.account_number || ''),
        debit_card_last_4: isDebit ? (last4 || '') : (item.debit_card_last_4 || ''),
        balance: 0,
      };

      const res = await Bridge.db('save_record', {
        record_type: isCard ? 'card' : 'account',
        record: recordPayload,
      });

      if (res && res.status === 'success') {
        await Bridge.db('ignore_discovered_account', {
          issuer: bank,
          last_4: last4,
          instrument_type: item.instrument_type,
        });
        toast(`Added ${recordPayload.name || recordPayload.card_name}!`, 'success');
        app.refresh();
      } else {
        toast(res?.message || 'Could not add record.', 'error');
        btn.disabled = false;
        btn.innerHTML = `${icon('add', 'icon-sm')}Add`;
      }
    });
  });

  container.querySelectorAll('[data-ignore-discovered]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const item = discovered[Number(btn.dataset.ignoreDiscovered)];
      if (!item) return;

      const confirmed = await confirmDialog(
        'Ignore & Discard Identifier?',
        `Future alerts for "${h(item.bank || item.institution || '')} ending ${h(item.last_4 || '')}" will not be suggested as a new discovered account.`,
        { confirmLabel: 'Discard', danger: true },
      );
      if (!confirmed) return;

      const res = await Bridge.db('ignore_discovered_account', {
        issuer: item.bank || item.institution,
        last_4: item.last_4,
        instrument_type: item.instrument_type,
      });

      if (res && res.status === 'success') {
        toast('Discovered identifier discarded.', 'success');
        app.refresh();
      } else {
        toast(res?.message || 'Could not discard identifier.', 'error');
      }
    });
  });

  const runButton = container.querySelector('[data-run]');
  const testInput = container.querySelector('[data-test]');
  const testSender = container.querySelector('[data-test-sender]');
  const clearTestBtn = container.querySelector('[data-clear-test]');
  const output = container.querySelector('[data-result]');

  if (clearTestBtn) {
    clearTestBtn.addEventListener('click', () => {
      if (testInput) testInput.value = '';
      if (testSender) testSender.value = '';
      if (output) output.innerHTML = '';
    });
  }

  const testMessage = async () => {
    const text = testInput.value.trim();
    if (!text) {
      output.innerHTML = '<div class="caption">Paste a message first.</div>';
      return;
    }

    const sender = testSender ? testSender.value.trim() : '';
    const res = await Bridge.call('sms', {
      action: 'parse_text', sms_text: text, sender,
    });

    if (res.status === 'error') {
      output.innerHTML = errorBlock(res, { compact: true });
      return;
    }

    const isNonTxn = Boolean(res.not_a_transaction);
    const nonTxnLabels = {
      otp: 'OTP / Verification Code (Ignored)',
      reminder: 'Payment Reminder / Due Notice (Ignored)',
      'mandate-setup': 'Mandate Setup Notice (Ignored)',
      promo: 'Promotional Offer (Ignored)',
      failed: 'Failed / Reversed Payment',
      balance: 'Balance Enquiry / Update (Ignored)',
      request: 'Payment Request',
      'ignored-rule': `Matched Ignore Rule ("${res.matched_rule}")`,
    };

    const typeBadgeClass = isNonTxn
      ? 'badge-neutral'
      : (res.type === 'Income' ? 'badge-income' : (res.type === 'Transfer' ? 'badge-neutral' : 'badge-expense'));

    output.innerHTML = `
      <div class="card-flat" style="border:1px solid var(--outline-variant);background:var(--surface-container-highest);margin-top:8px;padding:14px;border-radius:var(--radius-sm)">
        <div class="row-between" style="margin-bottom:8px;align-items:center">
          <span class="title" style="font-size:16px;font-weight:600">
            ${res.amount > 0 ? h(formatCurrency(res.amount, app.currency, app.locale)) : (isNonTxn ? 'Non-Transaction' : 'No amount detected')}
          </span>
          <span class="badge ${typeBadgeClass}">
            ${h(isNonTxn ? (nonTxnLabels[res.not_a_transaction] || res.not_a_transaction) : (res.type || 'Unknown'))}
          </span>
        </div>

        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(130px, 1fr));gap:8px;margin:10px 0;padding:10px;background:var(--surface-container);border-radius:var(--radius-xs);font-size:12px">
          <div>
            <span class="caption" style="display:block;color:var(--outline);font-size:10.5px">CATEGORY</span>
            <span style="font-weight:500">${h(res.category || 'None')}</span>
            ${res.category_source ? `<span class="caption" style="display:block;font-size:10px;color:var(--outline)">(${h(res.category_source)})</span>` : ''}
          </div>
          <div>
            <span class="caption" style="display:block;color:var(--outline);font-size:10.5px">MERCHANT / VENDOR</span>
            <span style="font-weight:500">${h(res.merchant || 'None detected')}</span>
          </div>
          <div>
            <span class="caption" style="display:block;color:var(--outline);font-size:10.5px">RULE MATCHED</span>
            <span style="font-weight:500">${h(res.matched_rule || 'Default Classifier')}</span>
          </div>
          <div>
            <span class="caption" style="display:block;color:var(--outline);font-size:10.5px">ACCOUNT / DATE</span>
            <span style="font-weight:500">${h(res.account_issuer || '')} ${h(res.account_last4 ? `(..${res.account_last4})` : '')} ${res.date ? `· ${h(formatDate(res.date))}` : ''}</span>
          </div>
        </div>

        <div class="row" style="gap:8px;margin-top:10px">
          <button type="button" class="btn btn-filled btn-sm" data-create-from-test style="flex:1;gap:4px">
            ${icon('add', 'icon-sm')}Create Rule from this Alert
          </button>
        </div>
      </div>`;

    const createBtn = output.querySelector('[data-create-from-test]');
    if (createBtn) {
      createBtn.addEventListener('click', () => {
        const words = text.split(/\s+/).filter((w) => w.length > 3 && !/^\d+$/.test(w));
        const suggestedTrigger = words.slice(0, 3).join(' ') || text.slice(0, 20);
        ruleSheet(app, categories, {
          rule_name: res.merchant || 'Bank Alert Rule',
          body_trigger: suggestedTrigger,
          transaction_type: res.type || 'Expense',
          category_name: res.category || (categories[0]?.name || 'General'),
          sender_keyword: sender || '',
        });
      });
    }
  };

  if (runButton) runButton.addEventListener('click', testMessage);
  if (testInput) {
    testInput.addEventListener('input', () => {
      if (testInput.value.length > 15) testMessage();
    });
  }

  container.querySelectorAll('[data-add-discovered]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = discovered[Number(btn.dataset.addDiscovered)];
      if (!item) return;
      btn.disabled = true;
      btn.textContent = 'Adding...';

      const isCard = item.kind === 'card';
      const recordPayload = isCard ? {
        card_name: item.suggested_name || item.card_name,
        bank: item.bank || 'Bank',
        last_4: item.last_4 || '',
        total_limit: item.total_limit || 0,
        current_balance: item.current_balance || 0,
      } : {
        name: item.suggested_name || item.name,
        category: item.category || 'Savings',
        institution: item.bank || item.institution || 'Bank',
        account_number: item.last_4 || item.account_number || '',
        balance: item.balance || 0,
      };

      const res = await Bridge.db('save_record', {
        record_type: isCard ? 'card' : 'account',
        record: recordPayload,
      });

      if (res && res.status === 'success') {
        toast(`Added ${item.suggested_name || item.name || item.card_name}!`, 'success');
        app.refresh();
      } else {
        toast(res?.message || 'Could not add that record.', 'error');
        btn.disabled = false;
        btn.innerHTML = `${icon('add', 'icon-sm')}Add`;
      }
    });
  });

  container.querySelectorAll('[data-inspect-discovered]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(el.dataset.inspectDiscovered);
      const item = discovered[idx];
      if (item) openDiscoveredAccountSheet(app, item, existingAccounts, existingCards);
    });
  });

  const addAllDiscoveredBtn = container.querySelector('[data-add-all-discovered]');
  if (addAllDiscoveredBtn) {
    addAllDiscoveredBtn.addEventListener('click', async () => {
      addAllDiscoveredBtn.disabled = true;
      const progress = showProgressModal('Adding Discovered Accounts', {
        message: `Saving ${discovered.length} accounts & cards to vault...`,
        initialPercent: 40,
        detail: 'Writing records into encrypted SQLite database',
      });

      const res = await Bridge.db('add_discovered_accounts', {
        accounts: discovered,
        member_id: app.memberFilter === 'all' ? 1 : Number(app.memberFilter || 1),
      });

      if (res && res.status === 'success') {
        progress.complete(`Added ${res.added} accounts & cards!`, 350);
        toast(`Successfully added ${res.added} accounts and cards!`, 'success');
      } else {
        progress.fail('Could not add accounts.');
        toast(res?.message || 'Could not add accounts.', 'error');
      }
      app.refresh();
    });
  }

  container.querySelectorAll('[data-filter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      reviewFilter = chip.dataset.filter;
      reviewSubFilter = 'all';
      selectedIndices.clear();
      app.refresh();
    });
  });

  container.querySelectorAll('[data-sub-filter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      reviewSubFilter = chip.dataset.subFilter;
      selectedIndices.clear();
      app.refresh();
    });
  });

  const selectToggleBtn = container.querySelector('[data-toggle-select]');
  if (selectToggleBtn) {
    selectToggleBtn.addEventListener('click', () => {
      selectMode = !selectMode;
      selectedIndices.clear();
      app.refresh();
    });
  }

  // --- Progressive Streaming Renderer ---
  const streamContainer = container.querySelector('[data-stream-container]');
  const streamSentinel = container.querySelector('[data-stream-sentinel]');
  const streamFooter = container.querySelector('[data-stream-footer]');
  let renderedCount = 0;
  const CHUNK_SIZE = 30;

  const updateBatchBar = () => {
    const batchBarHost = container.querySelector('[data-batch-bar-host]');
    if (!batchBarHost) return;
    if (!selectMode) {
      batchBarHost.innerHTML = '';
      return;
    }
    const selCount = selectedIndices.size;
    batchBarHost.innerHTML = `
      <div class="batch-action-bar">
        <div class="row" style="gap:6px;align-items:center;min-width:0">
          <span style="font-weight:700;font-size:13px;white-space:nowrap">${selCount} selected</span>
          <button type="button" class="btn btn-text btn-xs" data-batch-select-all style="padding:2px 6px">
            ${selCount === filteredReview.length ? 'Deselect' : 'Select all'}
          </button>
        </div>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <button type="button" class="btn btn-filled btn-sm" data-batch-accept ${selCount ? '' : 'disabled'}>
            ${icon('check', 'icon-sm')}Accept
          </button>
          <button type="button" class="btn btn-tonal btn-sm" data-batch-ignore ${selCount ? '' : 'disabled'}>
            ${icon('visibility_off', 'icon-sm')}Discard
          </button>
          <button type="button" class="btn btn-tonal btn-sm" data-batch-category ${selCount ? '' : 'disabled'}>
            ${icon('sell', 'icon-sm')}Category
          </button>
        </div>
      </div>`;

    batchBarHost.querySelector('[data-batch-select-all]')?.addEventListener('click', () => {
      if (selectedIndices.size === filteredReview.length) {
        selectedIndices.clear();
      } else {
        filteredReview.forEach((_, idx) => selectedIndices.add(idx));
      }
      container.querySelectorAll('[data-select-item]').forEach((cb) => {
        cb.checked = selectedIndices.has(Number(cb.dataset.selectItem));
      });
      updateBatchBar();
    });

    batchBarHost.querySelector('[data-batch-accept]')?.addEventListener('click', async () => {
      const chosenItems = Array.from(selectedIndices).map((idx) => filteredReview[idx]).filter(Boolean);
      if (!chosenItems.length) return;
      const progress = showProgressModal('Filing Transactions', {
        message: `Filing ${chosenItems.length} selected transactions...`,
        initialPercent: 40,
        detail: 'Writing transactions to database',
      });
      const itemsToClassify = chosenItems.map((item) => ({
        body: item.body,
        amount: item.amount,
        category: item.chosenCategory || item.suggested_category || 'Shopping',
        type: item.suggested_type || item.type || 'Expense',
        merchant: item.merchant || '',
        date: item.date,
        apply_to_all: true,
      }));
      const res = await Bridge.call('sms', { action: 'classify_batch', items: itemsToClassify });
      if (res && res.status === 'success') {
        progress.complete(`Filed ${res.filed || itemsToClassify.length} transactions!`, 300);
        toast(`Filed ${res.filed || itemsToClassify.length} transactions.`, 'success');
        selectedIndices.clear();
        app.refresh();
      } else {
        progress.fail('Failed to file transactions.');
        toast(res?.message || 'Could not file transactions.', 'error');
      }
    });

    batchBarHost.querySelector('[data-batch-ignore]')?.addEventListener('click', async () => {
      const chosenItems = Array.from(selectedIndices).map((idx) => filteredReview[idx]).filter(Boolean);
      if (!chosenItems.length) return;
      const ok = await confirmDialog(
        'Discard Selected Alerts?',
        `Discard ${chosenItems.length} selected alert${chosenItems.length === 1 ? '' : 's'} from the waiting list?`,
        { confirmLabel: 'Discard', danger: true },
      );
      if (!ok) return;
      const res = await Bridge.call('sms', { action: 'ignore_batch', bodies: chosenItems.map((i) => i.body) });
      if (res && res.status === 'success') {
        toast(`Discarded ${chosenItems.length} alerts.`, 'success');
        selectedIndices.clear();
        app.refresh();
      }
    });

    batchBarHost.querySelector('[data-batch-category]')?.addEventListener('click', () => {
      pickCategorySheet(app, categories, 'Shopping', (newCat) => {
        const foundCat = categories.find((c) => c.name === newCat);
        selectedIndices.forEach((idx) => {
          const itm = filteredReview[idx];
          if (itm) {
            itm.chosenCategory = newCat;
            if (foundCat && foundCat.type) itm.suggested_type = foundCat.type;
            const btn = container.querySelector(`[data-pick-cat="${idx}"]`);
            const lbl = btn?.querySelector('[data-cat-label]') || container.querySelector(`[data-cat-label="${idx}"]`);
            if (lbl) lbl.textContent = newCat;
            if (foundCat && foundCat.icon && btn) {
              const iconContainer = btn.querySelector('span:first-child');
              if (iconContainer) iconContainer.innerHTML = icon(foundCat.icon, 'icon-sm');
            }
          }
        });
        toast(`Updated category to "${newCat}" for ${selectedIndices.size} items.`, 'info');
      });
    });
  };

  const bindRowEvents = (parent) => {
    parent.querySelectorAll('[data-pick-cat]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.pickCat);
        const item = filteredReview[idx];
        if (!item) return;
        const current = item.chosenCategory || item.suggested_category || 'Shopping';
        pickCategorySheet(app, categories, current, (newCat) => {
          item.chosenCategory = newCat;
          const foundCat = categories.find((c) => c.name === newCat);
          if (foundCat && foundCat.type) item.suggested_type = foundCat.type;
          const lbl = btn.querySelector('[data-cat-label]') || container.querySelector(`[data-cat-label="${idx}"]`);
          if (lbl) lbl.textContent = newCat;
          if (foundCat && foundCat.icon) {
            const iconContainer = btn.querySelector('span:first-child');
            if (iconContainer) iconContainer.innerHTML = icon(foundCat.icon, 'icon-sm');
          }
        });
      });
    });

    parent.querySelectorAll('[data-select-item]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const idx = Number(cb.dataset.selectItem);
        if (cb.checked) selectedIndices.add(idx);
        else selectedIndices.delete(idx);
        updateBatchBar();
      });
    });

    parent.querySelectorAll('[data-quick-accept]').forEach((button) => {
      button.addEventListener('click', async () => {
        const idx = Number(button.dataset.quickAccept);
        const item = filteredReview[idx];
        if (!item) return;
        button.disabled = true;

        const chosenCat = item.chosenCategory || item.suggested_category || 'Shopping';
        const res = await Bridge.call('sms', {
          action: 'classify_alert',
          body: item.body,
          amount: item.amount,
          category: chosenCat,
          merchant: item.merchant || '',
          type: item.suggested_type || item.type || 'Expense',
          date: item.date,
          apply_to_all: true,
        });

        if (res && res.status === 'success') {
          toast(`Filed ${formatCurrency(item.amount, app.currency, app.locale)} under "${chosenCat}".`, 'success');
          app.refresh();
        } else {
          toast(res?.message || 'Could not file transaction.', 'error');
          button.disabled = false;
        }
      });
    });

    parent.querySelectorAll('[data-ignore]').forEach((button) => {
      button.addEventListener('click', async () => {
        const item = filteredReview[Number(button.dataset.ignore)];
        if (!item) return;
        const merchantName = item.merchant || '';
        let createRule = false;
        if (merchantName) {
          createRule = await confirmDialog(
            'Ignore / Discard Message?',
            `Ignore this alert and exclude from ledger.${merchantName ? `\n\nCreate a standing rule to always auto-discard future messages from "${h(merchantName)}"?` : ''}`,
            { confirmLabel: merchantName ? 'Ignore & Create Rule' : 'Ignore', cancelLabel: 'Cancel' },
          );
          if (createRule === null) return;
        }

        const res = await Bridge.call('sms', {
          action: 'ignore_alert',
          body: item.body,
          create_rule: Boolean(createRule && merchantName),
          merchant: merchantName,
        });
        if (res && res.status === 'success') {
          toast(createRule ? `Message ignored and rule created for "${merchantName}".` : 'Message ignored.', 'success');
          app.refresh();
        } else {
          toast(res?.message || 'Could not ignore that message.', 'error');
        }
      });
    });

    parent.querySelectorAll('[data-classify]').forEach((button) => {
      button.addEventListener('click', () => alertSheet(app, categories, filteredReview[Number(button.dataset.classify)]));
    });

    parent.querySelectorAll('[data-edit]').forEach((button) => {
      button.addEventListener('click', () => alertSheet(app, categories, filteredReview[Number(button.dataset.edit)]));
    });

    parent.querySelectorAll('[data-duplicate]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = filteredReview[Number(btn.dataset.duplicate)];
        if (!item) return;

        const confirmed = await confirmDialog(
          'Mark as duplicate?',
          'This will flag the SMS alert so it does not appear as a pending transaction.',
          { confirmLabel: 'Mark duplicate' },
        );
        if (!confirmed) return;

        const res = await Bridge.call('sms', {
          action: 'mark_duplicate',
          body: item.body,
        });

        if (res && res.status === 'success') {
          toast('Marked as duplicate.', 'success');
          app.refresh();
        } else {
          toast(res?.message || 'Could not mark as duplicate.', 'error');
        }
      });
    });

    parent.querySelectorAll('[data-discard-duplicate]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = filteredReview[Number(btn.dataset.discardDuplicate)];
        if (!item) return;
        btn.disabled = true;

        const res = await Bridge.call('sms', {
          action: 'mark_duplicate',
          body: item.body,
        });

        if (res && res.status === 'success') {
          toast('Discarded duplicate alert.', 'success');
          app.refresh();
        } else {
          toast(res?.message || 'Could not discard alert.', 'error');
          btn.disabled = false;
        }
      });
    });

    parent.querySelectorAll('[data-merge-duplicate]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = filteredReview[Number(btn.dataset.mergeDuplicate)];
        if (!item) return;
        btn.disabled = true;
        const twin = item.duplicate_twin || {};
        const targetId = twin.id || item.duplicate_of;

        const res = await Bridge.call('sms', {
          action: 'merge_alert',
          transaction_id: targetId,
          body: item.body,
          raw_sms: item.body,
          date: item.date,
          amount: item.amount,
          merchant: item.merchant || twin.merchant || '',
          category: item.chosenCategory || item.suggested_category || twin.category || 'Shopping',
          type: item.suggested_type || twin.type || 'Expense',
          apply_to_all: true,
        });

        if (res && res.status === 'success') {
          toast('Merged details into existing transaction.', 'success');
          app.refresh();
        } else {
          toast(res?.message || 'Could not merge alert.', 'error');
          btn.disabled = false;
        }
      });
    });

    parent.querySelectorAll('[data-keep-both]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const item = filteredReview[Number(btn.dataset.keepBoth)];
        if (!item) return;
        btn.disabled = true;

        const chosenCat = item.chosenCategory || item.suggested_category || 'Shopping';
        const res = await Bridge.call('sms', {
          action: 'classify_alert',
          body: item.body,
          amount: item.amount,
          category: chosenCat,
          merchant: item.merchant || '',
          type: item.suggested_type || item.type || 'Expense',
          date: item.date,
          apply_to_all: true,
          override_duplicate: true,
        });

        if (res && res.status === 'success') {
          toast(`Filed ${formatCurrency(item.amount, app.currency, app.locale)} under "${chosenCat}".`, 'success');
          app.refresh();
        } else {
          toast(res?.message || 'Could not file transaction.', 'error');
          btn.disabled = false;
        }
      });
    });

    parent.querySelectorAll('[data-compare-duplicate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = filteredReview[Number(btn.dataset.compareDuplicate)];
        if (item) openDuplicateCompareSheet(app, categories, item);
      });
    });
  };

  const renderNextBatch = () => {
    if (!streamContainer) return;
    const nextSlice = filteredReview.slice(renderedCount, renderedCount + CHUNK_SIZE);
    if (!nextSlice.length) return;

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = nextSlice.map((item, i) => {
      const actualIdx = renderedCount + i;
      return renderAlertCard(item, actualIdx, categories, selectMode, selectedIndices.has(actualIdx), app);
    }).join('');

    bindRowEvents(tempDiv);
    while (tempDiv.firstChild) {
      streamContainer.appendChild(tempDiv.firstChild);
    }
    renderedCount += nextSlice.length;

    if (streamFooter) {
      if (renderedCount < filteredReview.length) {
        streamFooter.innerHTML = `
          <button type="button" class="btn btn-tonal btn-block" data-load-more style="margin-top:8px">
            ${icon('expand_more', 'icon-sm')}Show more (${filteredReview.length - renderedCount} remaining)
          </button>`;
        streamFooter.querySelector('[data-load-more]')?.addEventListener('click', renderNextBatch);
      } else {
        streamFooter.innerHTML = '';
      }
    }
  };

  if (streamContainer && filteredReview.length) {
    renderNextBatch();
    if (window.IntersectionObserver && streamSentinel) {
      const observer = new IntersectionObserver((entries) => {
        if (entries[0]?.isIntersecting && renderedCount < filteredReview.length) {
          renderNextBatch();
        }
      }, { rootMargin: '300px' });
      observer.observe(streamSentinel);
    }
  }

  updateBatchBar();

  const acceptAllReadyBtn = container.querySelector('[data-accept-all-ready]');
  if (acceptAllReadyBtn) {
    acceptAllReadyBtn.addEventListener('click', async () => {
      if (!readyList.length) return;
      acceptAllReadyBtn.disabled = true;
      const progress = showProgressModal('Filing Transactions', {
        message: `Filing ${readyList.length} ready transaction alerts...`,
        initialPercent: 30,
        detail: 'Categorizing and saving to database',
      });
      const itemsToClassify = readyList.map((item) => ({
        body: item.body,
        amount: item.amount,
        category: item.chosenCategory || item.suggested_category || 'Shopping',
        type: item.suggested_type || item.type || 'Expense',
        merchant: item.merchant || '',
        date: item.date,
        apply_to_all: true,
      }));
      const res = await Bridge.call('sms', { action: 'classify_batch', items: itemsToClassify });
      if (res && res.status === 'success') {
        progress.complete(`Filed ${res.filed || itemsToClassify.length} transactions!`, 300);
        toast(`Filed ${res.filed || itemsToClassify.length} transactions.`, 'success');
        app.refresh();
      } else {
        progress.fail('Could not file batch.');
        toast(res?.message || 'Could not file transactions.', 'error');
        acceptAllReadyBtn.disabled = false;
      }
    });
  }

  const discardAllDupsBtn = container.querySelector('[data-discard-all-duplicates]');
  if (discardAllDupsBtn) {
    discardAllDupsBtn.addEventListener('click', async () => {
      if (!dupList.length) return;
      const confirmed = await confirmDialog(
        'Discard All Duplicates?',
        `Discard ${dupList.length} duplicate alert${dupList.length === 1 ? '' : 's'} and preserve existing ledger entries.`,
        { confirmLabel: `Discard ${dupList.length}`, danger: true },
      );
      if (!confirmed) return;

      discardAllDupsBtn.disabled = true;
      const res = await Bridge.call('sms', {
        action: 'ignore_batch',
        bodies: dupList.map((i) => i.body),
      });
      if (res && res.status === 'success') {
        toast(`Discarded ${res.ignored || dupList.length} duplicate alerts.`, 'success');
        app.refresh();
      } else {
        toast(res?.message || 'Could not discard duplicates.', 'error');
        discardAllDupsBtn.disabled = false;
      }
    });
  }

  const discardAllUnclearBtn = container.querySelector('[data-discard-all-unclear]');
  if (discardAllUnclearBtn) {
    discardAllUnclearBtn.addEventListener('click', async () => {
      if (!unclearList.length) return;
      const confirmed = await confirmDialog(
        'Discard All Unclear Alerts?',
        `Discard ${unclearList.length} alert${unclearList.length === 1 ? '' : 's'} with missing or unclear amounts.`,
        { confirmLabel: `Discard ${unclearList.length}`, danger: true },
      );
      if (!confirmed) return;

      discardAllUnclearBtn.disabled = true;
      const res = await Bridge.call('sms', {
        action: 'ignore_batch',
        bodies: unclearList.map((i) => i.body),
      });
      if (res && res.status === 'success') {
        toast(`Discarded ${res.ignored || unclearList.length} unclear alerts.`, 'success');
        app.refresh();
      } else {
        toast(res?.message || 'Could not discard alerts.', 'error');
        discardAllUnclearBtn.disabled = false;
      }
    });
  }

  const discardAllWaitingBtn = container.querySelector('[data-discard-all-waiting]');
  if (discardAllWaitingBtn) {
    discardAllWaitingBtn.addEventListener('click', async () => {
      if (!allPendingList.length) return;
      const confirmed = await confirmDialog(
        'Discard All Waiting Alerts?',
        `Discard all ${allPendingList.length} waiting alert${allPendingList.length === 1 ? '' : 's'}.`,
        { confirmLabel: `Discard All (${allPendingList.length})`, danger: true },
      );
      if (!confirmed) return;

      discardAllWaitingBtn.disabled = true;
      const res = await Bridge.call('sms', {
        action: 'ignore_batch',
        bodies: allPendingList.map((i) => i.body),
      });
      if (res && res.status === 'success') {
        toast(`Discarded ${res.ignored || allPendingList.length} alerts.`, 'success');
        app.refresh();
      } else {
        toast(res?.message || 'Could not discard alerts.', 'error');
        discardAllWaitingBtn.disabled = false;
      }
    });
  }

  container.querySelectorAll('[data-forget-merchant]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.forgetMerchant;
      const confirmed = await confirmDialog('Remove this learned rule?', `Future messages with key "${h(key)}" will no longer match this rule.`, { confirmLabel: 'Remove', danger: true });
      if (!confirmed) return;

      const res = await Bridge.call('sms', { action: 'forget_merchant', merchant_key: key });
      if (res.status === 'success') {
        toast('Learned rule removed.', 'success');
        app.refresh();
      } else {
        toast(res.message || 'Could not delete that rule.', 'error');
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

  bindSelectFields(container);
}

async function openDuplicateCompareSheet(app, categories, item) {
  if (!item) return;
  const twin = item.duplicate_twin || {};
  const isExactUtr = twin.match_reason === 'exact-utr';

  const defaultMerchant = item.merchant || twin.merchant || '';
  const defaultCategory = item.chosenCategory || item.suggested_category || twin.category || 'Shopping';
  const defaultType = item.suggested_type || twin.type || 'Expense';
  const defaultDesc = item.description || twin.description || '';

  const incomingAmount = item.amount ? formatCurrency(item.amount, app.currency, app.locale) : '0';
  const existingAmount = twin.amount ? formatCurrency(twin.amount, app.currency, app.locale) : incomingAmount;

  await sheet('Duplicate Comparison', `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="card-flat" style="border-left:3px solid ${isExactUtr ? 'var(--income)' : 'var(--warning)'};padding:10px 12px;background:var(--surface-container-high)">
        <div class="row-between" style="align-items:center;margin-bottom:2px">
          <span style="font-weight:700;font-size:13.5px;color:var(--on-surface)">
            ${isExactUtr ? 'Exact Reference Match (100%)' : 'Potential Duplicate Detected'}
          </span>
          <span class="badge ${isExactUtr ? 'badge-income' : 'badge-warning'}" style="font-size:10px">
            ${isExactUtr ? 'UTR Match' : 'Same Amount & Date'}
          </span>
        </div>
        <div class="caption" style="font-size:11.5px;color:var(--on-surface-variant)">
          Existing transaction recorded on ${h(formatDate(twin.date || item.date))} for ${h(existingAmount)}.
        </div>
      </div>

      <div class="twin-split-grid">
        <!-- EXISTING -->
        <div class="twin-panel existing">
          <div class="twin-panel-header">
            <span>Existing Record</span>
            <span class="badge badge-tonal" style="font-size:9px">Ledger</span>
          </div>
          <div style="font-weight:700;font-size:14px;color:var(--on-surface)">-${h(existingAmount)}</div>
          <div style="font-size:13px;font-weight:600">${h(twin.merchant || 'Recorded Transaction')}</div>
          <div class="caption" style="font-size:11.5px">${h(twin.category || 'Uncategorized')} · ${h(twin.instrument_name || 'Cash/Account')}</div>
          ${twin.raw_sms ? `
            <div style="margin-top:4px">
              <span class="caption" style="font-size:10.5px;font-weight:600">Original SMS:</span>
              <div class="sms-raw-box">${h(twin.raw_sms)}</div>
            </div>` : ''}
        </div>

        <!-- INCOMING -->
        <div class="twin-panel incoming">
          <div class="twin-panel-header">
            <span>Incoming SMS</span>
            <span class="badge badge-income" style="font-size:9px">New</span>
          </div>
          <div style="font-weight:700;font-size:14px;color:var(--on-surface)">-${h(incomingAmount)}</div>
          <div style="font-size:13px;font-weight:600">${h(item.merchant || 'Unknown Merchant')}</div>
          <div class="caption" style="font-size:11.5px">${h(item.suggested_category || 'Shopping')} · ${h(item.sender || 'SMS Alert')}</div>
          <div style="margin-top:4px">
            <span class="caption" style="font-size:10.5px;font-weight:600">Incoming Alert:</span>
            <div class="sms-raw-box">${h(item.body)}</div>
          </div>
        </div>
      </div>

      <div class="section" style="margin-top:4px">
        <div class="section-header" style="margin-bottom:6px">
          <span class="title" style="font-size:13px">Merge Configuration</span>
        </div>
        <div class="field">
          <label class="field-label" for="mergeMerchant">Merchant to Keep</label>
          <input class="input" id="mergeMerchant" type="text" value="${h(defaultMerchant)}" placeholder="Merchant name">
          ${twin.merchant && item.merchant && twin.merchant !== item.merchant ? `
            <div class="row" style="gap:6px;margin-top:4px;flex-wrap:wrap">
              <button type="button" class="chip chip-sm" data-pick-merchant="${h(item.merchant)}">Use "${h(item.merchant)}"</button>
              <button type="button" class="chip chip-sm" data-pick-merchant="${h(twin.merchant)}">Use "${h(twin.merchant)}"</button>
            </div>` : ''}
        </div>

        <div class="row" style="gap:12px;align-items:flex-end">
          ${selectField({
            key: 'category',
            label: 'Category',
            id: 'mergeCategory',
            half: true,
            value: defaultCategory,
            options: categoryOptions(categories, defaultType),
          })}
          <div class="field" style="flex:1;min-width:0">
            <label class="field-label" for="mergeNote">Note / Description</label>
            <input class="input" id="mergeNote" type="text" value="${h(defaultDesc)}" placeholder="Optional note">
          </div>
        </div>

        <label class="card-flat" style="margin-top:8px;display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--surface-container-high);border-radius:var(--radius-sm);cursor:pointer">
          <div style="flex:1;margin-right:12px">
            <div style="font-size:12.5px;font-weight:600">Apply rule to future alerts</div>
            <div class="caption" style="font-size:11px;color:var(--on-surface-variant)">Auto-categorize matching merchant in future</div>
          </div>
          <input type="checkbox" id="mergeApplyRule" checked style="width:18px;height:18px;cursor:pointer;accent-color:var(--accent)">
        </label>
      </div>
    </div>`, {
    actions: `
      <div style="display:flex;gap:6px;width:100%;flex-wrap:wrap;justify-content:space-between;align-items:center">
        <button class="btn btn-tonal btn-sm" data-sheet-discard style="gap:4px">
          ${icon('visibility_off', 'icon-sm')}Discard (Duplicate)
        </button>
        <div class="row" style="gap:6px">
          <button class="btn btn-outlined btn-sm" data-sheet-keep-both style="gap:4px">
            ${icon('add', 'icon-sm')}Keep Both
          </button>
          <button class="btn btn-filled btn-sm" data-sheet-merge style="gap:4px">
            ${icon('autorenew', 'icon-sm')}Merge & Save
          </button>
        </div>
      </div>`,
    onMount(node, close) {
      bindSelectFields(node);
      node.querySelectorAll('[data-pick-merchant]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const input = node.querySelector('#mergeMerchant');
          if (input) input.value = btn.dataset.pickMerchant;
        });
      });

      node.querySelector('[data-sheet-discard]')?.addEventListener('click', async () => {
        const res = await Bridge.call('sms', {
          action: 'mark_duplicate',
          body: item.body,
        });
        if (res && res.status === 'success') {
          toast('Marked duplicate and discarded.', 'success');
          close(true);
          app.refresh();
        } else {
          toast(res?.message || 'Could not discard alert.', 'error');
        }
      });

      node.querySelector('[data-sheet-keep-both]')?.addEventListener('click', async () => {
        const res = await Bridge.call('sms', {
          action: 'classify_alert',
          body: item.body,
          amount: item.amount,
          category: node.querySelector('#mergeCategory')?.value || defaultCategory,
          merchant: node.querySelector('#mergeMerchant')?.value.trim() || defaultMerchant,
          description: node.querySelector('#mergeNote')?.value.trim() || '',
          type: defaultType,
          date: item.date,
          apply_to_all: Boolean(node.querySelector('#mergeApplyRule')?.checked),
          override_duplicate: true,
        });
        if (res && res.status === 'success') {
          toast('Filed as separate transaction.', 'success');
          close(true);
          app.refresh();
        } else {
          toast(res?.message || 'Could not file transaction.', 'error');
        }
      });

      node.querySelector('[data-sheet-merge]')?.addEventListener('click', async () => {
        const res = await Bridge.call('sms', {
          action: 'merge_alert',
          transaction_id: twin.id || item.duplicate_of,
          body: item.body,
          raw_sms: item.body,
          date: item.date,
          amount: item.amount,
          category: node.querySelector('#mergeCategory')?.value || defaultCategory,
          merchant: node.querySelector('#mergeMerchant')?.value.trim() || defaultMerchant,
          description: node.querySelector('#mergeNote')?.value.trim() || '',
          type: defaultType,
          apply_to_all: Boolean(node.querySelector('#mergeApplyRule')?.checked),
        });
        if (res && res.status === 'success') {
          toast('Merged details into existing transaction.', 'success');
          close(true);
          app.refresh();
        } else {
          toast(res?.message || 'Could not merge alert.', 'error');
        }
      });
    },
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
      { value: 'Expense', label: 'Money out (Expense / EMI)' },
      { value: 'Income', label: 'Money in (Income)' },
      { value: 'Investment', label: 'Invested (SIP / MF)' },
      { value: 'Transfer', label: 'Transferred (Credit Card / Moved)' },
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
    </div>
    <label class="card-flat" style="margin-top:var(--gap-2);display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--surface-container-high);border-radius:var(--radius-sm);cursor:pointer">
      <div style="flex:1;margin-right:12px">
        <div style="font-size:13px;font-weight:600">Apply to all from this merchant</div>
        <div class="caption" style="font-size:11.5px;color:var(--on-surface-variant)">Update rule for other past & future alerts</div>
      </div>
      <input type="checkbox" id="alertApplyToAll" ${filed ? '' : 'checked'} style="width:18px;height:18px;cursor:pointer">
    </label>`, {
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
        const applyToAll = Boolean(node.querySelector('#alertApplyToAll')?.checked);
        const common = {
          type: node.querySelector('#alertType').value,
          category: category.value,
          merchant: node.querySelector('[data-merchant]').value.trim(),
          description: node.querySelector('[data-note]')?.value.trim() || '',
          apply_to_all: applyToAll,
          override_single: !applyToAll,
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
      { value: 'Expense', label: 'Money out (Expense / EMI)' },
      { value: 'Income', label: 'Money in (Income)' },
      { value: 'Investment', label: 'Invested (SIP / MF)' },
      { value: 'Transfer', label: 'Transferred (Credit Card / Moved)' },
      { value: 'Ignore', label: 'Ignore message (Auto-Discard)' },
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

/**
 * Details, Classification and 2-way Link bottom sheet for discovered accounts & cards.
 */
export async function openDiscoveredAccountSheet(app, item, existingAccounts = [], existingCards = []) {
  let selectedInstrument = item.instrument_type || (item.is_debit_card ? 'debit_card' : (item.kind === 'card' ? 'credit_card' : (item.category === 'Meal Card' ? 'meal_card' : (item.category === 'Wallet' ? 'wallet' : 'bank_account'))));

  const discKey = `${item.instrument_type || (item.is_debit_card ? 'debit_card' : (item.kind === 'card' ? 'credit_card' : 'account'))}:${item.bank || item.institution || ''}:${item.last_4 || ''}`.toLowerCase();

  const getGlyph = (inst) => {
    if (inst === 'debit_card') return 'payments';
    if (inst === 'credit_card') return 'credit_card';
    if (inst === 'meal_card') return 'restaurant';
    if (inst === 'wallet') return 'account_balance_wallet';
    if (inst === 'prepaid_card') return 'credit_card';
    return 'account_balance';
  };

  const getLabel = (inst) => {
    if (inst === 'debit_card') return 'Debit Card (Linked to Bank)';
    if (inst === 'credit_card') return 'Credit Card';
    if (inst === 'meal_card') return 'Meal Card / Food Wallet';
    if (inst === 'wallet') return 'Digital Wallet';
    if (inst === 'prepaid_card') return 'Prepaid Card';
    return 'Bank Account';
  };

  const sheetBodyHtml = `
    <div style="display:flex;flex-direction:column;gap:var(--gap-3)">
      <div class="card-flat" style="background:var(--surface-container-high);padding:14px 16px;border-radius:var(--radius-lg);border:1px solid var(--outline-variant)">
        <div class="row" style="gap:12px;align-items:center;margin-bottom:10px">
          <span class="avatar avatar-sm" style="background:var(--accent-container);color:var(--on-accent-container);flex-shrink:0" id="discoveredHeaderGlyph">
            ${icon(getGlyph(selectedInstrument), 'icon-sm')}
          </span>
          <div style="min-width:0;flex:1">
            <div style="font-weight:700;font-size:15px;color:var(--on-surface)">${h(item.suggested_name || item.name || item.card_name)}</div>
            <div class="caption" id="discoveredHeaderSubtitle">${h(item.bank || item.institution || 'Bank')} · ${h(getLabel(selectedInstrument))}</div>
          </div>
        </div>

        <div class="row-between" style="font-size:13px;padding:8px 0;border-top:1px solid var(--outline-variant);color:var(--on-surface-variant)">
          <span>Identifier / Digits</span>
          <span style="font-weight:600;font-variant-numeric:tabular-nums">${h(item.last_4 || 'N/A')}</span>
        </div>
        ${item.txn_count ? `
          <div class="row-between" style="font-size:13px;padding:8px 0;border-top:1px solid var(--outline-variant);color:var(--on-surface-variant)">
            <span>Matched SMS Alerts</span>
            <span style="font-weight:600">${item.txn_count} alert${item.txn_count === 1 ? '' : 's'}</span>
          </div>` : ''}
        ${item.total_spent ? `
          <div class="row-between" style="font-size:13px;padding:8px 0;border-top:1px solid var(--outline-variant);color:var(--on-surface-variant)">
            <span>Total Debits / Spend</span>
            <span style="font-weight:600;color:var(--expense)">${h(formatCurrency(item.total_spent, app.currency, app.locale))}</span>
          </div>` : ''}
        ${item.last_seen ? `
          <div class="row-between" style="font-size:13px;padding:8px 0;border-top:1px solid var(--outline-variant);color:var(--on-surface-variant)">
            <span>Latest Activity</span>
            <span>${h(formatDate(item.last_seen))}</span>
          </div>` : ''}
      </div>

      ${item.sample_sms ? `
        <div>
          <div class="caption" style="font-weight:600;margin-bottom:6px">Sample Raw SMS Alert</div>
          <div class="card-flat" style="font-size:12px;line-height:1.5;background:var(--surface-container-lowest);padding:12px 14px;border-radius:var(--radius-md);border:1px solid var(--outline-variant);font-family:monospace;word-break:break-word">
            ${h(item.sample_sms)}
          </div>
        </div>` : ''}

      <!-- Classification Picker -->
      <div class="field">
        <label class="field-label">How should this card/account be classified?</label>
        ${selectField({
          key: 'instrument_type',
          id: 'selectInstrumentType',
          label: 'Card / Account Type',
          value: selectedInstrument,
          options: [
            { value: 'debit_card', label: 'Debit Card (Links to Bank Account)' },
            { value: 'credit_card', label: 'Credit Card (Standalone Credit Card)' },
            { value: 'bank_account', label: 'Bank Account (Savings / Salary / Current)' },
            { value: 'meal_card', label: 'Meal Card (Sodexo / Pluxee / Zaggle)' },
            { value: 'wallet', label: 'Digital Wallet (Paytm / Amazon Pay)' },
          ],
        })}
      </div>

      <div id="discoveredOptionsContainer"></div>

      <button class="btn btn-danger-text btn-block" data-action-ignore style="margin-top:var(--gap-2)">
        ${icon('visibility_off', 'icon-sm')}Ignore & Discard Identifier
      </button>
    </div>`;

  const renderDynamicOptions = (node, inst) => {
    const container = node.querySelector('#discoveredOptionsContainer');
    if (!container) return;

    const isDebit = inst === 'debit_card';
    const isCredit = inst === 'credit_card';
    const isBank = inst === 'bank_account';

    const headerSubtitle = node.querySelector('#discoveredHeaderSubtitle');
    if (headerSubtitle) headerSubtitle.textContent = `${item.bank || item.institution || 'Bank'} · ${getLabel(inst)}`;
    const headerGlyph = node.querySelector('#discoveredHeaderGlyph');
    if (headerGlyph) headerGlyph.innerHTML = icon(getGlyph(inst), 'icon-sm');

    const bankAccounts = existingAccounts.filter((a) => !a.category || a.category === 'Bank' || a.category === 'Savings' || a.category === 'Current');
    const existingTargetOptions = isCredit
      ? [
          { value: '', label: 'Select existing Credit Card...' },
          ...existingCards.map((c) => ({ value: String(c.id), label: `${c.card_name} (${c.bank || 'Bank'}${c.last_4 ? ` · ${c.last_4}` : ''})` })),
        ]
      : [
          { value: '', label: isDebit ? 'Select existing Bank Account to link this Debit Card...' : 'Select existing Bank Account to combine...' },
          ...bankAccounts.map((a) => ({ value: String(a.id), label: `${a.name} (${a.institution || 'Bank'}${a.account_number ? ` · ${a.account_number}` : ''}${a.debit_card_last_4 ? ` · DC: ${a.debit_card_last_4}` : ''})` })),
        ];

    let html = '';

    if (isDebit) {
      html = `
        <div class="card-flat" style="background:var(--surface-container-high);padding:14px 16px;border-radius:var(--radius-lg);border:1px solid var(--outline-variant);margin-bottom:var(--gap-3)">
          <div style="font-weight:700;font-size:14px;margin-bottom:6px">
            Link to Existing Bank Account (2-Way Linking)
          </div>
          <p class="caption" style="margin-bottom:10px">
            Associates this debit card (ending ${h(item.last_4)}) with your bank account so SMS debits are automatically recorded under that account.
          </p>
          ${selectField({
            key: 'target_existing_id',
            id: 'selectTargetExisting',
            label: 'Select Bank Account',
            value: '',
            options: existingTargetOptions,
          })}
          <button class="btn btn-filled btn-block" data-action-combine style="margin-top:12px">
            ${icon('open_in_new', 'icon-sm')}Link Debit Card to Bank Account
          </button>
        </div>

        <div class="card-flat" style="background:var(--surface-container-high);padding:14px 16px;border-radius:var(--radius-lg);border:1px solid var(--outline-variant)">
          <div style="font-weight:700;font-size:14px;margin-bottom:8px">
            Or: Create New Bank Account with this Debit Card
          </div>
          <div class="field" style="margin-bottom:10px">
            <label class="field-label">Bank Account Name</label>
            <input class="input" type="text" data-field-name value="${h(item.bank ? `${item.bank} Savings` : (item.suggested_name || 'Bank Account'))}" />
          </div>
          <button class="btn btn-outlined btn-block" data-action-add-new>
            ${icon('add', 'icon-sm')}Create as New Bank Account
          </button>
        </div>`;
    } else if (isCredit) {
      html = `
        <div class="card-flat" style="background:var(--surface-container-high);padding:14px 16px;border-radius:var(--radius-lg);border:1px solid var(--outline-variant);margin-bottom:var(--gap-3)">
          <div style="font-weight:700;font-size:14px;margin-bottom:8px">
            Add as New Credit Card
          </div>
          <div class="field" style="margin-bottom:10px">
            <label class="field-label">Card Display Name</label>
            <input class="input" type="text" data-field-name value="${h(item.suggested_name || item.card_name || `${item.bank || 'Bank'} Credit Card`)}" />
          </div>
          <button class="btn btn-filled btn-block" data-action-add-new>
            ${icon('add', 'icon-sm')}Add as New Credit Card
          </button>
        </div>

        ${existingCards.length ? `
          <div class="card-flat" style="background:var(--surface-container-high);padding:14px 16px;border-radius:var(--radius-lg);border:1px solid var(--outline-variant)">
            <div style="font-weight:700;font-size:14px;margin-bottom:6px">
              Or: Combine with Existing Credit Card
            </div>
            <p class="caption" style="margin-bottom:10px">
              Merge this identifier (ending ${h(item.last_4)}) with a credit card you already track.
            </p>
            ${selectField({
              key: 'target_existing_id',
              id: 'selectTargetExisting',
              label: 'Existing Credit Card',
              value: '',
              options: existingTargetOptions,
            })}
            ${item.last_4 ? `
              <label class="row" style="gap:8px;align-items:center;margin-top:10px;cursor:pointer">
                <input type="checkbox" id="chkCombineUpdateDigits" checked style="width:16px;height:16px">
                <span style="font-size:12px">Update target card digits to ${h(item.last_4)} (Replacement Card)</span>
              </label>` : ''}
            <button class="btn btn-outlined btn-block" data-action-combine style="margin-top:12px">
              ${icon('open_in_new', 'icon-sm')}Combine with Credit Card
            </button>
          </div>` : ''}`;
    } else {
      html = `
        <div class="card-flat" style="background:var(--surface-container-high);padding:14px 16px;border-radius:var(--radius-lg);border:1px solid var(--outline-variant);margin-bottom:var(--gap-3)">
          <div style="font-weight:700;font-size:14px;margin-bottom:8px">
            Add as New ${isBank ? 'Bank Account' : (inst === 'meal_card' ? 'Meal Card' : 'Wallet')}
          </div>
          <div class="field" style="margin-bottom:10px">
            <label class="field-label">Display Name</label>
            <input class="input" type="text" data-field-name value="${h(item.suggested_name || item.name || `${item.bank || 'Bank'} Account`)}" />
          </div>
          <button class="btn btn-filled btn-block" data-action-add-new>
            ${icon('add', 'icon-sm')}Add as New ${isBank ? 'Bank Account' : (inst === 'meal_card' ? 'Meal Card' : 'Wallet')}
          </button>
        </div>

        ${bankAccounts.length && isBank ? `
          <div class="card-flat" style="background:var(--surface-container-high);padding:14px 16px;border-radius:var(--radius-lg);border:1px solid var(--outline-variant)">
            <div style="font-weight:700;font-size:14px;margin-bottom:6px">
              Or: Combine with Existing Bank Account
            </div>
            ${selectField({
              key: 'target_existing_id',
              id: 'selectTargetExisting',
              label: 'Existing Bank Account',
              value: '',
              options: existingTargetOptions,
            })}
            ${item.last_4 ? `
              <label class="row" style="gap:8px;align-items:center;margin-top:10px;cursor:pointer">
                <input type="checkbox" id="chkCombineUpdateDigits" checked style="width:16px;height:16px">
                <span style="font-size:12px">Update target account digits to ${h(item.last_4)} (Replacement Account)</span>
              </label>` : ''}
            <button class="btn btn-outlined btn-block" data-action-combine style="margin-top:12px">
              ${icon('open_in_new', 'icon-sm')}Combine with Bank Account
            </button>
          </div>` : ''}`;
    }

    container.innerHTML = html;
    bindSelectFields(container);
    wireOptionActions(node, inst);
  };

  const wireOptionActions = (node, inst) => {
    const isDebit = inst === 'debit_card';
    const isCredit = inst === 'credit_card';

    const addNewBtn = node.querySelector('[data-action-add-new]');
    if (addNewBtn) {
      addNewBtn.addEventListener('click', async () => {
        const customName = node.querySelector('[data-field-name]').value.trim() || item.suggested_name || item.name || item.card_name;

        const recordPayload = isCredit ? {
          card_name: customName,
          bank: item.bank || 'Bank',
          last_4: item.last_4 || '',
          total_limit: item.total_limit || 0,
          available_limit: item.available_limit !== null && item.available_limit !== undefined ? item.available_limit : 0,
          current_balance: item.current_balance || 0,
        } : {
          name: customName,
          category: isDebit ? 'Bank' : (inst === 'meal_card' ? 'Meal Card' : (inst === 'wallet' ? 'Wallet' : 'Bank')),
          institution: item.bank || item.institution || 'Bank',
          account_number: isDebit ? '' : (item.last_4 || ''),
          debit_card_last_4: isDebit ? (item.last_4 || '') : '',
          balance: item.balance || 0,
        };

        const res = await Bridge.db('save_record', {
          record_type: isCredit ? 'card' : 'account',
          record: recordPayload,
        });

        if (res && res.status === 'success') {
          await Bridge.db('ignore_discovered_account', {
            identifier: discKey,
            issuer: item.bank || item.institution,
            last_4: item.last_4,
          });
          toast(`Added ${customName}`, 'success');
          app.refresh();
        } else {
          toast(res?.message || 'Could not add account.', 'error');
        }
      });
    }

    const combineBtn = node.querySelector('[data-action-combine]');
    if (combineBtn) {
      combineBtn.addEventListener('click', async () => {
        const selectBtn = node.querySelector('.select-button[data-field="target_existing_id"]');
        const targetId = selectBtn ? selectBtn.dataset.value : '';
        if (!targetId) {
          toast(isDebit ? 'Please select a bank account to link this debit card.' : 'Please select an existing account to combine with.', 'error');
          return;
        }

        const updateLast4 = Boolean(node.querySelector('#chkCombineUpdateDigits')?.checked);

        const res = await Bridge.db('combine_discovered_account', {
          target_id: Number(targetId),
          target_type: isCredit ? 'card' : 'account',
          last_4: item.last_4 || '',
          bank: item.bank || item.institution || '',
          is_debit_card: isDebit,
          instrument_type: inst,
          update_last_4: updateLast4,
        });

        if (res && res.status === 'success') {
          toast(isDebit ? 'Successfully linked Debit Card to Bank Account!' : 'Successfully combined and linked account!', 'success');
          app.refresh();
        } else {
          toast(res?.message || 'Could not combine account.', 'error');
        }
      });
    }
  };

  sheet('Discovered Account Details', sheetBodyHtml, {
    onMount(node, close) {
      bindSelectFields(node);
      renderDynamicOptions(node, selectedInstrument);

      const typeSelect = node.querySelector('.select-button[data-field="instrument_type"]');
      if (typeSelect) {
        typeSelect.addEventListener('change', () => {
          selectedInstrument = typeSelect.dataset.value;
          renderDynamicOptions(node, selectedInstrument);
        });
      }

      const ignoreBtn = node.querySelector('[data-action-ignore]');
      if (ignoreBtn) {
        ignoreBtn.addEventListener('click', async () => {
          const confirmed = await confirmDialog(
            'Ignore & Discard Identifier?',
            `Future alerts mentioning "${h(item.bank || item.institution || '')} ending ${h(item.last_4 || '')}" will not be suggested as a new discovered account.`,
            { confirmLabel: 'Discard', danger: true },
          );
          if (!confirmed) return;

          const res = await Bridge.db('ignore_discovered_account', {
            identifier: discKey,
            issuer: item.bank || item.institution,
            last_4: item.last_4,
            instrument_type: selectedInstrument,
          });

          if (res && res.status === 'success') {
            toast('Discovered identifier discarded.', 'success');
            close(null);
            app.refresh();
          } else {
            toast(res?.message || 'Could not discard identifier.', 'error');
          }
        });
      }
    },
  });
}
