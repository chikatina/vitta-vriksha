/* Ledger: every transaction, grouped by day, with search, Date/Week/Month/All navigation, and filters. */

import { Bridge } from '../bridge.js';
import {
  icon, h, emptyState, openMenu,
} from '../ui.js';
import {
  formatCurrency, formatRelativeDate, formatMonthKey, formatBucketTitle,
  formatDate, todayISO,
} from '../formatters.js';
import {
  categoryIndex, transactionRow, bindTransactionRows,
  memberChips, bindMemberChips,
} from './shared.js';

const FILTERS = [
  { id: 'all', label: 'All', icon: 'receipt_long' },
  { id: 'Expense', label: 'Spent', icon: 'north_east' },
  { id: 'Income', label: 'Received', icon: 'south_west' },
  { id: 'Investment', label: 'Invested', icon: 'trending_up' },
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
  const [txRes, categoryRes, memberRes] = await Promise.all([
    Bridge.db('get_transactions', { member_id: app.memberFilter }),
    Bridge.db('get_categories'),
    Bridge.db('get_family_members'),
  ]);

  const all = txRes.transactions || [];
  const categories = categoryIndex(categoryRes.categories || []);
  const members = memberRes.members || [];

  const today = todayISO();
  const currentMonthKey = today.slice(0, 7);
  const currentWeekMonday = getWeekMonday(today);

  let scope = app.ledgerScope || 'month';
  let activeMonth = app.ledgerMonthValue || currentMonthKey;
  let activeWeek = app.ledgerWeekValue || currentWeekMonday;
  let activeDay = app.ledgerDayValue || today;
  let filter = app.ledgerFilter || 'all';
  let query = (app.ledgerSearch || '').toLowerCase();

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
          ${icon('all_inclusive', 'icon-sm')}All
        </button>
        <button type="button" class="ledger-scope-btn" data-scope="month" aria-selected="${scope === 'month'}">
          ${icon('calendar_month', 'icon-sm')}Month
        </button>
        <button type="button" class="ledger-scope-btn" data-scope="week" aria-selected="${scope === 'week'}">
          ${icon('view_week', 'icon-sm')}Week
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
          <span data-period-icon>${icon(scope === 'day' ? 'today' : scope === 'week' ? 'view_week' : 'calendar_month')}</span>
          <span data-period-label></span>
          ${icon('expand_more', 'icon-sm')}
        </button>
        <input type="date" data-native-date-picker style="position:absolute;opacity:0;pointer-events:none;width:0;height:0">
        <button type="button" class="ledger-month-btn" data-period-next aria-label="Next">
          ${icon('chevron_right')}
        </button>
      </div>

      <div class="ledger-search-box">
        <span class="ledger-search-icon">${icon('search', 'icon-sm')}</span>
        <input class="ledger-search-input" data-search type="search"
               placeholder="Search shop, note, or category"
               value="${h(app.ledgerSearch || '')}" autocomplete="off">
        <button type="button" class="ledger-search-clear ${app.ledgerSearch ? '' : 'hidden'}"
                data-clear-search aria-label="Clear search">
          ${icon('close', 'icon-sm')}
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

    <div data-results></div>`;

  const results = container.querySelector('[data-results]');
  const statsStrip = container.querySelector('[data-stats-strip]');
  const searchInput = container.querySelector('[data-search]');
  const clearSearchBtn = container.querySelector('[data-clear-search]');
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
      const sunday = addDays(activeWeek, 6);
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
      periodIconSpan.innerHTML = icon(scope === 'day' ? 'today' : scope === 'week' ? 'view_week' : 'calendar_month');
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

    if (filter === 'Investment' && !tx.is_investment_outflow) return false;
    if (filter === 'Expense' && (tx.type !== 'Expense' || tx.is_investment_outflow)) return false;
    if (filter === 'Income' && tx.type !== 'Income') return false;

    if (!query) return true;
    const haystack = `${tx.merchant || ''} ${tx.category || ''} ${tx.description || ''} ${tx.raw_sms || ''}`.toLowerCase();
    return haystack.includes(query);
  });

  const paint = () => {
    const rows = matches();

    // Paint stats strip
    if (rows.length > 0) {
      const totalOutflow = rows
        .filter((t) => t.type === 'Expense' || t.is_investment_outflow)
        .reduce((s, t) => s + (t.net_personal_amount ?? t.amount), 0);
      const totalInflow = rows
        .filter((t) => t.type === 'Income')
        .reduce((s, t) => s + (t.net_personal_amount ?? t.amount), 0);

      const periodPrefix = scope === 'all' ? '' : `${getPeriodLabel()} · `;
      statsStrip.innerHTML = `
        <div class="ledger-stats-strip">
          <span>${periodPrefix}${rows.length} ${rows.length === 1 ? 'transaction' : 'transactions'}${query ? ` · matching "${h(app.ledgerSearch)}"` : ''}</span>
          <div class="ledger-stats-totals">
            ${totalOutflow > 0 ? `<span class="expense">-${h(formatCurrency(totalOutflow, app.currency, app.locale))}</span>` : ''}
            ${totalInflow > 0 ? `<span class="income">+${h(formatCurrency(totalInflow, app.currency, app.locale))}</span>` : ''}
          </div>
        </div>`;
    } else {
      statsStrip.innerHTML = '';
    }

    if (!rows.length) {
      const periodDesc = scope !== 'all' ? ` in ${getPeriodLabel()}` : '';
      results.innerHTML = `
        <div class="card" style="text-align:center;padding:var(--gap-5) var(--gap-4)">
          ${all.length
    ? emptyState('search_off', 'No transactions found', query ? `No matches for "${h(app.ledgerSearch)}"${periodDesc}. Try adjusting your search or filters.` : `No transactions recorded${periodDesc}.`)
    : emptyState('receipt_long', 'Your ledger is empty', 'Every transaction you add or import will appear here.')}
          <div class="row" style="justify-content:center;gap:var(--gap-2);margin-top:var(--gap-3);flex-wrap:wrap">
            ${query || scope !== 'all' || filter !== 'all' ? `
              <button class="btn btn-tonal btn-sm" data-empty-clear>
                ${icon('clear_all', 'icon-sm')}Show all time
              </button>` : ''}
            <button class="btn btn-filled btn-sm" data-empty-add>
              ${icon('add', 'icon-sm')}Add transaction
            </button>
          </div>
        </div>`;

      const emptyClear = results.querySelector('[data-empty-clear]');
      if (emptyClear) {
        emptyClear.addEventListener('click', () => {
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
          updatePeriodNavUI();
          paint();
        });
      }

      const emptyAdd = results.querySelector('[data-empty-add]');
      if (emptyAdd) {
        emptyAdd.addEventListener('click', () => app.addTransaction());
      }
      return;
    }

    // Group by day so the list reads as a diary rather than an undifferentiated feed.
    const days = new Map();
    rows.forEach((tx) => {
      const key = tx.date || 'undated';
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(tx);
    });

    results.innerHTML = [...days.entries()].map(([date, items]) => {
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
              <span class="ledger-day-calendar">${icon('calendar_today', 'icon-sm')}</span>
              <span class="ledger-day-date">${h(titleText)}</span>
              <span class="ledger-day-count">(${items.length})</span>
            </div>
            <span class="ledger-day-total ${dayTotal >= 0 ? 'income' : 'expense'}">
              ${dayTotal >= 0 ? '+' : '-'}${h(formatCurrency(Math.abs(dayTotal), app.currency, app.locale))}
            </span>
          </div>
          <div class="list">
            ${items.map((tx) => transactionRow(tx, app, categories, { showDate: false })).join('')}
          </div>
        </div>`;
    }).join('');

    bindTransactionRows(results, app, rows);
  };

  // Scope switcher (All / Month / Week / Day)
  container.querySelectorAll('[data-scope]').forEach((btn) => {
    btn.addEventListener('click', () => {
      scope = btn.dataset.scope;
      app.ledgerScope = scope;
      container.querySelectorAll('[data-scope]').forEach((b) => {
        b.setAttribute('aria-selected', String(b.dataset.scope === scope));
      });
      updatePeriodNavUI();
      paint();
    });
  });

  // Period navigation (Prev, Next, Dropdown / Native picker)
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
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
      updatePeriodNavUI();
      paint();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
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
            // fallback to dropdown
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
          updatePeriodNavUI();
          paint();
        }
      }
    });
  }

  if (nativeDatePicker) {
    nativeDatePicker.addEventListener('change', (event) => {
      if (event.target.value) {
        activeDay = event.target.value;
        app.ledgerDayValue = activeDay;
        updatePeriodNavUI();
        paint();
      }
    });
  }

  // Clear search button handler
  if (clearSearchBtn) {
    clearSearchBtn.addEventListener('click', () => {
      query = '';
      app.ledgerSearch = '';
      searchInput.value = '';
      clearSearchBtn.classList.add('hidden');
      searchInput.focus();
      paint();
    });
  }

  container.querySelector('[data-insights]').addEventListener('click', () => app.go('ledger', 'insights'));

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

  let searchTimer;
  searchInput.addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    const raw = event.target.value;
    const value = raw.trim().toLowerCase();
    clearSearchBtn.classList.toggle('hidden', !raw);
    searchTimer = setTimeout(() => {
      query = value;
      app.ledgerSearch = raw;
      paint();
    }, 140);
  });

  updatePeriodNavUI();
  bindMemberChips(container, app);
  paint();
}
