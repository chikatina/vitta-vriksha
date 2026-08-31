/* Ledger: every transaction, grouped by day, with search, Date/Week/Month/All navigation, filters, and batch actions. */

import { Bridge } from '../bridge.js';
import {
  icon, h, emptyState, openMenu, sheet, toast, confirmDialog, selectField, bindSelectFields,
} from '../ui.js';
import {
  formatCurrency, formatRelativeDate, formatMonthKey, formatBucketTitle,
  formatDate, todayISO,
} from '../formatters.js';
import {
  categoryIndex, transactionRow,
  memberChips, bindMemberChips,
} from './shared.js';

const FILTERS = [
  { id: 'all', label: 'All', icon: 'receipt_long' },
  { id: 'Expense', label: 'Spent', icon: 'north_east' },
  { id: 'Income', label: 'Received', icon: 'south_west' },
  { id: 'Investment', label: 'Invested', icon: 'trending_up' },
  { id: 'upi', label: 'UPI', icon: 'payments' },
  { id: 'large', label: '> ₹2k', icon: 'bolt' },
  { id: 'uncategorized', label: 'Uncategorized', icon: 'help' },
  { id: 'duplicates', label: 'Duplicates', icon: 'content_copy' },
  { id: 'ignored', label: 'Ignored', icon: 'visibility_off' },
];

function addDays(isoStr, n) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoStr));
  if (!match) return isoStr;
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + n);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addMonths(monthStr, n) {
  const match = /^(\d{4})-(\d{2})/.exec(String(monthStr));
  if (!match) return monthStr;
  const d = new Date(Number(match[1]), Number(match[2]) - 1 + n, 1);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function getWeekMonday(isoStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoStr));
  if (!match) return isoStr;
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const shift = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - shift);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function renderLedger(container, app) {
  const today = todayISO();
  const currentMonthKey = today.slice(0, 7);
  const currentWeekMonday = getWeekMonday(today);

  let scope = app.ledgerScope || 'month';
  let activeMonth = app.ledgerMonthValue || currentMonthKey;
  let activeWeek = app.ledgerWeekValue || currentWeekMonday;
  let activeDay = app.ledgerDayValue || today;

  const [txRes, categoryRes, memberRes] = await Promise.all([
    Bridge.db('get_transactions', { member_id: app.memberFilter, include_ignored: true, limit: 2000 }),
    Bridge.db('get_categories'),
    Bridge.db('get_family_members'),
  ]);

  const all = txRes.transactions || [];
  const rawCategories = categoryRes.categories || [];
  const categories = categoryIndex(rawCategories);
  const members = memberRes.members || [];

  let filter = app.ledgerFilter || 'all';
  let query = (app.ledgerSearch || '').toLowerCase();

  // Multi-select state
  let selectMode = false;
  const selectedIds = new Set();

  // Cursor-based pagination state (used in "All" scope)
  let hasMore = txRes.capped || false;
  let isLoadingMore = false;

  function computeDupKeyCounts(list) {
    const counts = new Map();
    for (const tx of list) {
      if (!tx.is_ignored && !tx.is_duplicate && tx.amount > 0 && tx.date) {
        const key = `${tx.date}:${tx.amount}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return counts;
  }

  let dupKeyCounts = computeDupKeyCounts(all);

  async function loadMore() {
    if (isLoadingMore || !hasMore) return;
    isLoadingMore = true;
    paint();

    const lastTx = all[all.length - 1];
    const res = await Bridge.db('get_transactions', {
      member_id: app.memberFilter,
      include_ignored: true,
      limit: 2000,
      cursor_date: lastTx.date,
      cursor_id: lastTx.id,
    });

    if (res.status === 'success' && res.transactions.length) {
      all.push(...res.transactions);
      hasMore = res.capped;
      dupKeyCounts = computeDupKeyCounts(all);
    } else {
      hasMore = false;
    }

    isLoadingMore = false;
    paint();
  }

  // Calculate median expense amount for anomaly detection
  const expenseAmounts = all
    .filter((t) => t.type === 'Expense' && !t.is_investment_outflow && t.amount > 0)
    .map((t) => t.amount)
    .sort((a, b) => a - b);
  const medianExpense = expenseAmounts.length ? expenseAmounts[Math.floor(expenseAmounts.length / 2)] : 500;
  const anomalyThreshold = Math.max(3000, medianExpense * 2.5);

  // Discover all months and weeks with transactions
  const monthSet = new Set([currentMonthKey]);
  const weekSet = new Set([currentWeekMonday]);
  const daySet = new Set([today]);

  all.forEach((tx) => {
    if (tx.date && tx.date.length >= 10) {
      daySet.add(tx.date.slice(0, 10));
      weekSet.add(getWeekMonday(tx.date));
      monthSet.add(tx.date.slice(0, 7));
    }
  });

  const availableMonths = [...monthSet].sort().reverse();
  const availableWeeks = [...weekSet].sort().reverse();
  const availableDays = [...daySet].sort().reverse();

  container.innerHTML = `
    <div class="sticky-header">
      ${memberChips(app, members)}

      <div class="ledger-scope-bar" data-scope-bar>
        <button type="button" class="ledger-scope-btn" data-scope="all" aria-selected="${scope === 'all'}">
          ${icon('history', 'icon-sm')}All
        </button>
        <button type="button" class="ledger-scope-btn" data-scope="month" aria-selected="${scope === 'month'}">
          ${icon('calendar_month', 'icon-sm')}Month
        </button>
        <button type="button" class="ledger-scope-btn" data-scope="week" aria-selected="${scope === 'week'}">
          ${icon('event', 'icon-sm')}Week
        </button>
        <button type="button" class="ledger-scope-btn" data-scope="day" aria-selected="${scope === 'day'}">
          ${icon('today', 'icon-sm')}Day
        </button>
      </div>

      <div class="ledger-month-nav" data-period-nav style="${scope === 'all' ? 'display:none;' : ''}">
        <button type="button" class="ledger-month-btn" data-period-prev aria-label="Previous">
          ${icon('chevron_left')}
        </button>
        <button type="button" class="ledger-month-label-btn" data-period-select>
          <span data-period-icon>${icon(scope === 'day' ? 'today' : scope === 'week' ? 'event' : 'calendar_month')}</span>
          <span data-period-label></span>
          ${icon('expand_more', 'icon-sm')}
        </button>
        <input type="date" data-native-date-picker style="position:absolute;opacity:0;pointer-events:none;width:0;height:0">
        <button type="button" class="ledger-month-btn" data-period-next aria-label="Next">
          ${icon('chevron_right')}
        </button>
      </div>

      <div class="row" style="gap:6px;margin-bottom:var(--gap-2);align-items:center;min-width:0;width:100%;box-sizing:border-box">
        <div class="ledger-search-box" style="margin-bottom:0">
          <span class="ledger-search-icon">${icon('search', 'icon-sm')}</span>
          <input class="ledger-search-input" data-search type="search"
                 placeholder="Search..."
                 value="${h(app.ledgerSearch || '')}" autocomplete="off">
          <button type="button" class="ledger-search-clear ${app.ledgerSearch ? '' : 'hidden'}"
                  data-clear-search aria-label="Clear search">
            ${icon('close', 'icon-sm')}
          </button>
        </div>
        <button type="button" class="btn btn-sm ${selectMode ? 'btn-filled' : 'btn-tonal'}" data-toggle-select style="flex-shrink:0;height:38px;padding:0 10px;font-size:12px;gap:4px">
          ${icon(selectMode ? 'check' : 'check_circle', 'icon-sm')}<span>${selectMode ? 'Done' : 'Select'}</span>
        </button>
      </div>

      <div class="chip-scroller" data-filters>
        ${FILTERS.map((f) => `
          <button class="chip" data-filter="${f.id}" aria-selected="${f.id === filter}">
            ${icon(f.icon, 'icon-sm')}${h(f.label)}
          </button>`).join('')}
        <button class="chip" data-insights>${icon('query_stats', 'icon-sm')}Trends</button>
      </div>

      <div data-stats-strip></div>
    </div>

    <div data-results></div>
    <div data-batch-bar-host></div>`;

  const results = container.querySelector('[data-results]');
  const batchBarHost = container.querySelector('[data-batch-bar-host]');
  const statsStrip = container.querySelector('[data-stats-strip]');
  const searchInput = container.querySelector('[data-search]');
  const clearSearchBtn = container.querySelector('[data-clear-search]');
  const selectToggleBtn = container.querySelector('[data-toggle-select]');
  const periodNav = container.querySelector('[data-period-nav]');
  const prevBtn = container.querySelector('[data-period-prev]');
  const nextBtn = container.querySelector('[data-period-next]');
  const periodSelectBtn = container.querySelector('[data-period-select]');
  const periodLabelSpan = container.querySelector('[data-period-label]');
  const periodIconSpan = container.querySelector('[data-period-icon]');
  const nativeDatePicker = container.querySelector('[data-native-date-picker]');

  const getPeriodLabel = () => {
    if (scope === 'day') {
      const rel = formatRelativeDate(activeDay);
      return rel === formatDate(activeDay) ? rel : `${rel} (${formatDate(activeDay)})`;
    }
    if (scope === 'week') {
      const isCurrent = activeWeek === currentWeekMonday;
      const title = formatBucketTitle(activeWeek, 'week');
      return isCurrent ? `${title} · This week` : title;
    }
    if (scope === 'month') {
      return activeMonth === currentMonthKey ? `${formatMonthKey(activeMonth)} · Current` : formatMonthKey(activeMonth);
    }
    return 'All time';
  };

  const updatePeriodNavUI = () => {
    if (periodNav) {
      periodNav.style.display = scope === 'all' ? 'none' : 'flex';
    }
    if (periodIconSpan) {
      periodIconSpan.innerHTML = icon(scope === 'day' ? 'today' : 'calendar_month');
    }
    if (periodLabelSpan) {
      periodLabelSpan.textContent = getPeriodLabel();
    }
    if (nativeDatePicker) {
      nativeDatePicker.value = activeDay;
    }

    if (scope === 'day') {
      if (nextBtn) nextBtn.disabled = activeDay >= today;
    } else if (scope === 'week') {
      if (nextBtn) nextBtn.disabled = activeWeek >= currentWeekMonday;
    } else if (scope === 'month') {
      if (nextBtn) nextBtn.disabled = activeMonth >= currentMonthKey;
    }
  };

  const matches = () => all.filter((tx) => {
    if (scope === 'day') {
      if (tx.date !== activeDay) return false;
    } else if (scope === 'week') {
      const monday = activeWeek;
      const sunday = addDays(monday, 6);
      if (!tx.date || tx.date < monday || tx.date > sunday) return false;
    } else if (scope === 'month') {
      if (!tx.date || !tx.date.startsWith(activeMonth)) return false;
    }

    const isIgnored = Boolean(tx.is_ignored || tx.is_duplicate);
    if (filter === 'ignored') {
      if (!isIgnored) return false;
    } else {
      if (isIgnored) return false;
    }

    if (filter === 'duplicates') {
      const key = `${tx.date}:${tx.amount}`;
      if ((dupKeyCounts.get(key) || 0) < 2) return false;
    }
    if (filter === 'Investment' && !tx.is_investment_outflow && tx.type !== 'Investment') return false;
    if (filter === 'Expense' && (tx.type !== 'Expense' || tx.is_investment_outflow)) return false;
    if (filter === 'Income' && tx.type !== 'Income') return false;
    if (filter === 'upi') {
      const text = `${tx.raw_sms || ''} ${tx.description || ''} ${tx.merchant || ''}`.toLowerCase();
      if (!text.includes('upi') && !text.includes('@') && !text.includes('vpa')) return false;
    } else if (filter === 'large') {
      if ((tx.amount || 0) < 2000) return false;
    } else if (filter === 'uncategorized') {
      if (tx.category && tx.category !== 'Uncategorized' && tx.category !== 'Other' && tx.category !== 'General') return false;
    }

    if (!query) return true;
    const haystack = `${tx.merchant || ''} ${tx.category || ''} ${tx.description || ''} ${tx.raw_sms || ''}`.toLowerCase();
    return haystack.includes(query);
  });

  const paintBatchBar = (rows) => {
    if (!selectMode) {
      batchBarHost.innerHTML = '';
      return;
    }

    const count = selectedIds.size;
    batchBarHost.innerHTML = `
      <div class="batch-action-bar">
        <div class="row" style="gap:6px;align-items:center">
          <span style="font-weight:700;font-size:13px">${count} selected</span>
          <button class="btn btn-text btn-xs" data-batch-select-all style="padding:2px 6px">
            ${count === rows.length ? 'Deselect all' : 'Select all'}
          </button>
        </div>
        <div class="row" style="gap:6px">
          <button class="btn btn-tonal btn-sm" data-batch-cat ${count ? '' : 'disabled'}>
            ${icon('label', 'icon-sm')}Category
          </button>
          <button class="btn btn-tonal btn-sm" data-batch-member ${count ? '' : 'disabled'}>
            ${icon('group', 'icon-sm')}Member
          </button>
          <button class="btn btn-tonal btn-sm" data-batch-ignore ${count ? '' : 'disabled'}>
            ${icon('visibility_off', 'icon-sm')}Ignore
          </button>
          <button class="btn btn-danger btn-sm" data-batch-del ${count ? '' : 'disabled'}>
            ${icon('delete', 'icon-sm')}
          </button>
        </div>
      </div>`;

    batchBarHost.querySelector('[data-batch-select-all]').addEventListener('click', () => {
      const allSelected = selectedIds.size === rows.length;
      if (allSelected) {
        selectedIds.clear();
      } else {
        rows.forEach((r) => selectedIds.add(r.id));
      }
      results.querySelectorAll('[data-transaction]').forEach((row) => {
        const id = Number(row.dataset.transaction);
        const isSelected = selectedIds.has(id);
        row.classList.toggle('selected-row', isSelected);
        if (isSelected) {
          row.style.background = 'var(--accent-container)';
          row.style.borderRadius = 'var(--radius-sm)';
        } else {
          row.style.background = '';
          row.style.borderRadius = '';
        }
        const chkBox = row.querySelector('.selection-checkbox');
        if (chkBox) {
          chkBox.style.color = isSelected ? 'var(--accent)' : 'var(--outline-strong)';
          chkBox.innerHTML = icon(isSelected ? 'check_box' : 'check_box_outline_blank', 'icon-md');
        }
      });
      paintBatchBar(rows);
    });

    const catBtn = batchBarHost.querySelector('[data-batch-cat]');
    if (catBtn) {
      catBtn.addEventListener('click', async () => {
        if (!selectedIds.size) return;
        const categoryOptions = rawCategories.map((c) => ({ value: c.name, label: c.name }));
        const picked = await sheet('Move to Category', `
          <div class="field">
            <label class="field-label">Select destination category</label>
            <div class="list" style="margin-top:var(--gap-2);max-height:300px;overflow-y:auto">
              ${rawCategories.map((c) => `
                <button class="list-row" data-choose-cat="${h(c.name)}">
                  <span class="avatar avatar-sm" style="background:${h(c.color)}">${icon(c.icon || 'sell')}</span>
                  <span class="list-row-main"><span class="list-row-title">${h(c.name)}</span></span>
                  ${icon('chevron_right', 'icon-sm')}
                </button>`).join('')}
            </div>
          </div>`, {
          onMount(node, close) {
            node.querySelectorAll('[data-choose-cat]').forEach((btn) => {
              btn.addEventListener('click', () => close(btn.dataset.chooseCat));
            });
          },
        });

        if (picked) {
          await Bridge.db('batch_update_transactions', {
            ids: [...selectedIds],
            category: picked,
          });
          toast(`Updated ${selectedIds.size} transactions.`, 'success');
          selectedIds.clear();
          selectMode = false;
          selectToggleBtn.innerHTML = `${icon('check_circle', 'icon-sm')}<span>Select</span>`;
          selectToggleBtn.className = 'btn btn-sm btn-tonal';
          app.refresh();
        }
      });
    }

    const memberBtn = batchBarHost.querySelector('[data-batch-member]');
    if (memberBtn) {
      memberBtn.addEventListener('click', async () => {
        if (!selectedIds.size) return;
        const picked = await sheet('Reassign Member', `
          <div class="field">
            <label class="field-label">Assign to profile</label>
            <div class="list" style="margin-top:var(--gap-2)">
              ${members.map((m) => `
                <button class="list-row" data-choose-member="${m.id}">
                  <span class="avatar avatar-sm" style="background:${h(m.avatar_color)}">${icon('person')}</span>
                  <span class="list-row-main"><span class="list-row-title">${h(m.name)}</span></span>
                  ${icon('chevron_right', 'icon-sm')}
                </button>`).join('')}
            </div>
          </div>`, {
          onMount(node, close) {
            node.querySelectorAll('[data-choose-member]').forEach((btn) => {
              btn.addEventListener('click', () => close(Number(btn.dataset.chooseMember)));
            });
          },
        });

        if (picked) {
          await Bridge.db('batch_update_transactions', {
            ids: [...selectedIds],
            member_id: picked,
          });
          toast(`Reassigned ${selectedIds.size} transactions.`, 'success');
          selectedIds.clear();
          selectMode = false;
          selectToggleBtn.innerHTML = `${icon('check_circle', 'icon-sm')}<span>Select</span>`;
          selectToggleBtn.className = 'btn btn-sm btn-tonal';
          app.refresh();
        }
      });
    }

    const ignoreBtn = batchBarHost.querySelector('[data-batch-ignore]');
    if (ignoreBtn) {
      ignoreBtn.addEventListener('click', async () => {
        if (!selectedIds.size) return;
        const confirmed = await confirmDialog(
          `Ignore ${selectedIds.size} transactions?`,
          'These records will be excluded from spending totals, analytics, and budgets.',
          { confirmLabel: `Ignore (${selectedIds.size})` },
        );
        if (!confirmed) return;
        await Bridge.db('batch_update_transactions', { ids: [...selectedIds], is_ignored: 1 });
        toast(`Ignored ${selectedIds.size} transactions.`, 'success');
        selectedIds.clear();
        selectMode = false;
        selectToggleBtn.innerHTML = `${icon('check_circle', 'icon-sm')}<span>Select</span>`;
        selectToggleBtn.className = 'btn btn-sm btn-tonal';
        app.refresh();
      });
    }

    const delBtn = batchBarHost.querySelector('[data-batch-del]');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!selectedIds.size) return;
        const confirmed = await confirmDialog(
          `Delete ${selectedIds.size} transactions?`,
          'These records will be permanently removed from your ledger.',
          { confirmLabel: `Delete (${selectedIds.size})`, danger: true },
        );
        if (!confirmed) return;
        await Bridge.db('batch_delete_transactions', { ids: [...selectedIds] });
        toast(`Deleted ${selectedIds.size} transactions.`, 'success');
        selectedIds.clear();
        selectMode = false;
        selectToggleBtn.innerHTML = `${icon('check_circle', 'icon-sm')}<span>Select</span>`;
        selectToggleBtn.className = 'btn btn-sm btn-tonal';
        app.refresh();
      });
    }
  };

  const paint = () => {
    const rows = matches();

    // Stats strip
    if (rows.length && (scope !== 'all' || query || filter !== 'all')) {
      const inc = rows.filter((r) => r.type === 'Income').reduce((s, r) => s + (r.net_personal_amount ?? r.amount), 0);
      const exp = rows.filter((r) => r.type === 'Expense' && !r.is_investment_outflow).reduce((s, r) => s + (r.net_personal_amount ?? r.amount), 0);
      const inv = rows.filter((r) => r.is_investment_outflow || r.type === 'Investment').reduce((s, r) => s + (r.net_personal_amount ?? r.amount), 0);

      statsStrip.innerHTML = `
        <div class="row" style="gap:8px;padding:4px 0 8px;font-size:12px;color:var(--on-surface-variant);flex-wrap:wrap">
          <span>${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}</span>
          ${exp > 0 ? `<span>· Spent <strong class="expense">${h(formatCurrency(exp, app.currency, app.locale))}</strong></span>` : ''}
          ${inc > 0 ? `<span>· Inflow <strong class="income">${h(formatCurrency(inc, app.currency, app.locale))}</strong></span>` : ''}
          ${inv > 0 ? `<span>· Invested <strong class="invested">${h(formatCurrency(inv, app.currency, app.locale))}</strong></span>` : ''}
        </div>`;
    } else {
      statsStrip.innerHTML = '';
    }

    if (!rows.length) {
      const periodDesc = scope !== 'all' ? ` in ${getPeriodLabel()}` : '';
      results.innerHTML = `
        <div class="card" style="text-align:center;padding:var(--gap-5) var(--gap-4)">
          ${all.length
    ? emptyState('search', 'No transactions found', query ? `No matches for "${h(app.ledgerSearch)}"${periodDesc}. Try adjusting your search or filters.` : `No transactions recorded${periodDesc}.`)
    : emptyState('receipt_long', 'Your ledger is empty', 'Every transaction you add or import will appear here.')}
          <div class="row" style="justify-content:center;gap:var(--gap-2);margin-top:var(--gap-3);flex-wrap:wrap">
            ${query || scope !== 'all' || filter !== 'all' ? `
              <button class="btn btn-tonal btn-sm" data-empty-clear>
                ${icon('refresh', 'icon-sm')}Show all time
              </button>` : ''}
            <button class="btn btn-filled btn-sm" data-empty-add>
              ${icon('add', 'icon-sm')}Add transaction
            </button>
          </div>
        </div>`;

      const emptyClear = results.querySelector('[data-empty-clear]');
      if (emptyClear) {
        emptyClear.addEventListener('click', async () => {
          query = '';
          app.ledgerSearch = '';
          searchInput.value = '';
          clearSearchBtn.classList.add('hidden');
          scope = 'all';
          app.ledgerScope = 'all';
          filter = 'all';
          app.ledgerFilter = 'all';
          container.querySelectorAll('[data-scope]').forEach((c) => {
            c.setAttribute('aria-selected', String(c.dataset.scope === 'all'));
          });
          container.querySelectorAll('[data-filter]').forEach((c) => {
            c.setAttribute('aria-selected', String(c.dataset.filter === 'all'));
          });
          const res = await Bridge.db('get_transactions', {
            member_id: app.memberFilter, include_ignored: true, limit: 2000,
          });
          all.length = 0;
          if (res.transactions) all.push(...res.transactions);
          hasMore = res.capped || false;
          dupKeyCounts = computeDupKeyCounts(all);
          updatePeriodNavUI();
          paint();
        });
      }

      const emptyAdd = results.querySelector('[data-empty-add]');
      if (emptyAdd) {
        emptyAdd.addEventListener('click', () => app.addTransaction());
      }
      paintBatchBar(rows);
      return;
    }

    // Group by day
    results.innerHTML = filter === 'duplicates' ? `
      <div class="card-flat" style="border-left:3px solid var(--warning);background:var(--surface-container-high);padding:10px 12px;margin-bottom:var(--gap-3)">
        <div class="row-between" style="align-items:center">
          <div class="row" style="gap:6px;align-items:center">
            <span style="color:var(--warning);display:flex">${icon('content_copy', 'icon-sm')}</span>
            <span style="font-weight:700;font-size:13px">Potential Duplicates (${rows.length} entries)</span>
          </div>
        </div>
        <div class="caption" style="font-size:11.5px;margin-top:2px">
          Transactions sharing the same amount and date in your ledger. Tap any entry to edit or mark as duplicate.
        </div>
      </div>` : '';

    const days = new Map();
    rows.forEach((tx) => {
      const key = tx.date || 'undated';
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(tx);
    });

    const dayEntries = [...days.entries()];
    const DAY_CHUNK = 25;
    let renderedDayIndex = 0;
    let dayObserver = null;

    const renderDayBatch = () => {
      const sentinel = results.querySelector('[data-day-sentinel]');
      if (sentinel) {
        if (dayObserver) dayObserver.disconnect();
        sentinel.remove();
      }

      if (renderedDayIndex >= dayEntries.length) return;

      const slice = dayEntries.slice(renderedDayIndex, renderedDayIndex + DAY_CHUNK);
      renderedDayIndex += slice.length;

      const batchHtml = slice.map(([date, items]) => {
        const dayTotal = items.reduce((total, tx) => total
          + (tx.type === 'Income' ? 1 : -1) * (tx.net_personal_amount ?? tx.amount), 0);

        const rel = formatRelativeDate(date);
        const isNamed = rel === 'Today' || rel === 'Yesterday';
        const formattedDate = date !== 'undated' ? formatDate(date) : '';
        const titleText = isNamed && formattedDate ? `${rel} · ${formattedDate}` : (rel || 'Undated');

        return `
          <div class="ledger-day-group">
            <div class="ledger-day-header">
              <div class="ledger-day-title">
                <span class="ledger-day-calendar">${icon('event', 'icon-sm')}</span>
                <span class="ledger-day-date">${h(titleText)}</span>
                <span class="ledger-day-count">(${items.length})</span>
              </div>
              <span class="ledger-day-total ${dayTotal >= 0 ? 'income' : 'expense'}">
                ${dayTotal >= 0 ? '+' : '-'}${h(formatCurrency(Math.abs(dayTotal), app.currency, app.locale))}
              </span>
            </div>
            <div class="list">
              ${items.map((tx) => {
                const isAnomaly = tx.type === 'Expense' && !tx.is_investment_outflow && tx.amount >= anomalyThreshold;
                const isSelected = selectedIds.has(tx.id);
                return transactionRow(tx, app, categories, {
                  showDate: false,
                  selectable: selectMode,
                  selected: isSelected,
                  isAnomaly,
                });
              }).join('')}
            </div>
          </div>`;
      }).join('');

      let sentinelHtml = '';
      if (renderedDayIndex < dayEntries.length) {
        sentinelHtml = `
          <div data-day-sentinel style="padding:14px 0;text-align:center">
            <button type="button" class="btn btn-tonal btn-sm" data-load-more-days style="margin:0 auto">
              ${icon('expand_more', 'icon-sm')}Show more (${dayEntries.length - renderedDayIndex} days remaining)
            </button>
          </div>`;
      }

      results.insertAdjacentHTML('beforeend', batchHtml + sentinelHtml);

      // Wire row clicks for freshly added rows
      const byId = new Map(rows.map((t) => [String(t.id), t]));
      results.querySelectorAll('[data-transaction]:not([data-bound])').forEach((row) => {
        row.setAttribute('data-bound', '1');
        row.addEventListener('click', () => {
          const id = Number(row.dataset.transaction);
          if (selectMode) {
            if (selectedIds.has(id)) {
              selectedIds.delete(id);
            } else {
              selectedIds.add(id);
            }
            const isSelected = selectedIds.has(id);
            row.classList.toggle('selected-row', isSelected);
            if (isSelected) {
              row.style.background = 'var(--accent-container)';
              row.style.borderRadius = 'var(--radius-sm)';
            } else {
              row.style.background = '';
              row.style.borderRadius = '';
            }
            const chkBox = row.querySelector('.selection-checkbox');
            if (chkBox) {
              chkBox.style.color = isSelected ? 'var(--accent)' : 'var(--outline-strong)';
              chkBox.innerHTML = icon(isSelected ? 'check_box' : 'check_box_outline_blank', 'icon-md');
            }
            paintBatchBar(rows);
          } else {
            const tx = byId.get(String(id));
            if (tx) app.addTransaction(tx);
          }
        });
      });

      const nextSentinel = results.querySelector('[data-day-sentinel]');
      if (nextSentinel) {
        const moreBtn = nextSentinel.querySelector('[data-load-more-days]');
        if (moreBtn) {
          moreBtn.addEventListener('click', renderDayBatch);
        }
        if (typeof IntersectionObserver !== 'undefined') {
          dayObserver = new IntersectionObserver((entries) => {
            if (entries[0] && entries[0].isIntersecting) {
              renderDayBatch();
            }
          }, { rootMargin: '250px' });
          dayObserver.observe(nextSentinel);
        }
      }
    };

    results.innerHTML = '';
    renderDayBatch();

    // Cursor-based "Load more" for All scope
    if (scope === 'all' && !query && filter === 'all') {
      if (isLoadingMore) {
        results.insertAdjacentHTML('beforeend', `
          <div style="padding:14px 0;text-align:center">
            <button type="button" class="btn btn-tonal btn-sm" disabled style="margin:0 auto">
              ${icon('autorenew', 'icon-sm')}Loading more...
            </button>
          </div>`);
      } else if (hasMore) {
        const loadMoreDiv = document.createElement('div');
        loadMoreDiv.style.cssText = 'padding:14px 0;text-align:center';
        loadMoreDiv.innerHTML = `
          <button type="button" class="btn btn-tonal btn-sm" data-load-more-tx style="margin:0 auto">
            ${icon('expand_more', 'icon-sm')}Load more transactions
          </button>`;
        results.appendChild(loadMoreDiv);
        loadMoreDiv.querySelector('[data-load-more-tx]').addEventListener('click', loadMore);
      }
    }

    paintBatchBar(rows);
  };

  // Toggle select mode
  selectToggleBtn.addEventListener('click', () => {
    selectMode = !selectMode;
    if (!selectMode) selectedIds.clear();
    selectToggleBtn.innerHTML = `${icon(selectMode ? 'check' : 'check_circle', 'icon-sm')}<span>${selectMode ? 'Done' : 'Select'}</span>`;
    selectToggleBtn.className = `btn btn-sm ${selectMode ? 'btn-filled' : 'btn-tonal'}`;
    paint();
  });

  // Period navigation
  async function refetchForScope() {
    if (scope === 'month') {
      const [year, month] = activeMonth.split('-').map(Number);
      const nm = month === 12 ? 1 : month + 1;
      const ny = month === 12 ? year + 1 : year;
      const p2 = (v) => String(v).padStart(2, '0');
      const res = await Bridge.db('get_transactions', {
        member_id: app.memberFilter, include_ignored: true,
        from: `${activeMonth}-01`, to: `${ny}-${p2(nm)}-01`,
      });
      all.length = 0;
      if (res.transactions) all.push(...res.transactions);
      hasMore = false;
    } else if (scope === 'week') {
      const res = await Bridge.db('get_transactions', {
        member_id: app.memberFilter, include_ignored: true,
        from: activeWeek, to: addDays(activeWeek, 7),
      });
      all.length = 0;
      if (res.transactions) all.push(...res.transactions);
      hasMore = false;
    } else if (scope === 'day') {
      const res = await Bridge.db('get_transactions', {
        member_id: app.memberFilter, include_ignored: true,
        from: activeDay, to: addDays(activeDay, 1),
      });
      all.length = 0;
      if (res.transactions) all.push(...res.transactions);
      hasMore = false;
    } else if (scope === 'all') {
      const res = await Bridge.db('get_transactions', {
        member_id: app.memberFilter, include_ignored: true, limit: 2000,
      });
      all.length = 0;
      if (res.transactions) all.push(...res.transactions);
      hasMore = res.capped || false;
    }
    dupKeyCounts = computeDupKeyCounts(all);
  }

  // Scope switcher (All / Month / Week / Day)
  container.querySelectorAll('[data-scope]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      scope = btn.dataset.scope;
      app.ledgerScope = scope;
      container.querySelectorAll('[data-scope]').forEach((b) => {
        b.setAttribute('aria-selected', String(b.dataset.scope === scope));
      });
      await refetchForScope();
      updatePeriodNavUI();
      paint();
    });
  });

  if (prevBtn) {
    prevBtn.addEventListener('click', async () => {
      if (scope === 'day') {
        activeDay = addDays(activeDay, -1);
        app.ledgerDayValue = activeDay;
      } else if (scope === 'week') {
        activeWeek = addDays(activeWeek, -7);
        app.ledgerWeekValue = activeWeek;
      } else if (scope === 'month') {
        activeMonth = addMonths(activeMonth, -1);
        app.ledgerMonthValue = activeMonth;
      }
      await refetchForScope();
      updatePeriodNavUI();
      paint();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', async () => {
      if (scope === 'day') {
        activeDay = addDays(activeDay, 1);
        app.ledgerDayValue = activeDay;
      } else if (scope === 'week') {
        activeWeek = addDays(activeWeek, 7);
        app.ledgerWeekValue = activeWeek;
      } else if (scope === 'month') {
        activeMonth = addMonths(activeMonth, 1);
        app.ledgerMonthValue = activeMonth;
      }
      await refetchForScope();
      updatePeriodNavUI();
      paint();
    });
  }

  if (periodSelectBtn) {
    periodSelectBtn.addEventListener('click', async () => {
      if (scope === 'day') {
        if (nativeDatePicker && typeof nativeDatePicker.showPicker === 'function') {
          try {
            nativeDatePicker.showPicker();
            return;
          } catch {
            // fallback
          }
        }
        const dayOptions = [
          { value: today, label: `Today (${formatDate(today)})` },
          { value: addDays(today, -1), label: `Yesterday (${formatDate(addDays(today, -1))})` },
          ...availableDays.filter((d) => d !== today && d !== addDays(today, -1)).map((d) => ({
            value: d,
            label: formatDate(d),
          })),
        ];
        const picked = await openMenu(periodSelectBtn, dayOptions, activeDay);
        if (picked) {
          activeDay = picked;
          app.ledgerDayValue = picked;
          await refetchForScope();
          updatePeriodNavUI();
          paint();
        }
      } else if (scope === 'week') {
        const weekOptions = availableWeeks.map((w) => ({
          value: w,
          label: w === currentWeekMonday ? `${formatBucketTitle(w, 'week')} (This week)` : formatBucketTitle(w, 'week'),
        }));
        const picked = await openMenu(periodSelectBtn, weekOptions, activeWeek);
        if (picked) {
          activeWeek = picked;
          app.ledgerWeekValue = picked;
          await refetchForScope();
          updatePeriodNavUI();
          paint();
        }
      } else if (scope === 'month') {
        const monthOptions = availableMonths.map((m) => ({
          value: m,
          label: m === currentMonthKey ? `${formatMonthKey(m)} (Current)` : formatMonthKey(m),
        }));
        const picked = await openMenu(periodSelectBtn, monthOptions, activeMonth);
        if (picked) {
          activeMonth = picked;
          app.ledgerMonthValue = picked;
          await refetchForScope();
          updatePeriodNavUI();
          paint();
        }
      }
    });
  }

  if (nativeDatePicker) {
    nativeDatePicker.addEventListener('change', async (e) => {
      if (e.target.value) {
        activeDay = e.target.value;
        app.ledgerDayValue = activeDay;
        await refetchForScope();
        updatePeriodNavUI();
        paint();
      }
    });
  }

  // Search input
  let searchDebounceTimer = null;
  searchInput.addEventListener('input', (e) => {
    const val = e.target.value;
    app.ledgerSearch = val;
    clearSearchBtn.classList.toggle('hidden', !val.trim());
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      query = val.toLowerCase().trim();
      paint();
    }, 150);
  });

  clearSearchBtn.addEventListener('click', () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    query = '';
    app.ledgerSearch = '';
    searchInput.value = '';
    clearSearchBtn.classList.add('hidden');
    searchInput.focus();
    paint();
  });

  // Filter chips
  container.querySelectorAll('[data-filter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      filter = chip.dataset.filter;
      app.ledgerFilter = filter;
      container.querySelectorAll('[data-filter]').forEach((c) => {
        c.setAttribute('aria-selected', String(c.dataset.filter === filter));
      });
      paint();
    });
  });

  const trendsBtn = container.querySelector('[data-insights]');
  if (trendsBtn) {
    trendsBtn.addEventListener('click', () => {
      app.open('insights');
    });
  }

  bindMemberChips(container, app);
  updatePeriodNavUI();
  paint();
}
