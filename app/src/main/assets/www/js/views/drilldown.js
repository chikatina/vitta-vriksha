/*
 * The sheets you land in when you tap a number.
 *
 * Every chart in the app now leads somewhere, and where it leads is one of three sheets: a
 * period, a slice of a period, or the transactions themselves. They are here rather than in
 * the screens that open them because the route into them is not a screen: a bar on Home, a
 * slice of the Budgets donut and a row in the Insights breakdown all mean "show me what
 * this is made of", and it would be the same sheet written three times.
 *
 * Each one fetches before it opens rather than after. A sheet that animates up empty and
 * fills in a moment later reads as a stutter on a phone, and the queries are indexed and
 * local, so there is nothing to wait for worth showing a spinner over.
 */

import { Bridge } from '../bridge.js';
import {
  h, icon, sheet, emptyState, errorBlock,
} from '../ui.js';
import {
  formatBucketLabel, formatBucketTitle, formatCurrency, formatDelta, formatRelativeDate,
  describePeriod,
} from '../formatters.js';
import {
  barList, barSeriesChart, bindChartSelect, donutChart,
} from '../charts.js';
import { categoryIndex, transactionRow, bindTransactionRows } from './shared.js';

/** Which flow a screen is looking at, and how each is worded. */
export const FLOWS = [
  { value: 'spend', label: 'Spent', metric: 'spend_total', dimensionMetric: 'spend_by_category' },
  { value: 'income', label: 'Received', metric: 'income_expense', dimensionMetric: 'income_by_category' },
  { value: 'invest', label: 'Invested', metric: 'investment_growth', dimensionMetric: 'invest_by_scheme' },
  { value: 'transfer', label: 'Moved', metric: 'spend_total', dimensionMetric: 'spend_by_category' },
];

const money = (app, value) => formatCurrency(value, app.currency, app.locale);

/**
 * A stand-in for the app that closes the sheet before the editor opens.
 *
 * Everything above a row was counted before the edit, so leaving the sheet up would show
 * sums that no longer match the rows under them. `bindTransactionRows` only ever calls
 * `addTransaction`, so this is the whole surface it needs.
 */
function editThenClose(app, close) {
  return {
    addTransaction: async (tx) => {
      close(null);
      await app.addTransaction(tx);
    },
  };
}

/** One labelled figure, the same shape the holding sheet uses. */
function fact(label, value, className = '') {
  return `
    <div class="fact">
      <span class="fact-label">${h(label)}</span>
      <span class="fact-value ${className}">${value}</span>
    </div>`;
}

/**
 * A comparison against the period before, in words.
 *
 * A percentage on its own is ambiguous about which way is good: more income and more
 * spending are the same arrow and opposite news. So the class comes from what is being
 * compared rather than from the sign.
 */
function deltaLine(percent, { moreIsWorse = true } = {}) {
  if (percent === null || percent === undefined || !Number.isFinite(Number(percent))) {
    return '<span class="caption">Nothing to compare with yet</span>';
  }
  const value = Number(percent);
  if (Math.abs(value) < 0.5) return '<span class="caption">About the same as last time</span>';

  const worse = moreIsWorse ? value > 0 : value < 0;
  return `
    <span class="caption ${worse ? 'expense' : 'income'}">
      ${icon(value > 0 ? 'north_east' : 'south_west', 'icon-sm')}
      ${h(formatDelta(Math.abs(value)))} ${value > 0 ? 'more' : 'less'} than last time
    </span>`;
}

/* ------------------------------------------------------ the transactions list */

/**
 * The rows themselves, grouped by day.
 *
 * This is the bottom of every drilldown: whatever was tapped, it ends here, with the
 * individual entries and the ability to correct one. Editing closes the sheet, because the
 * figures above it were fetched before the edit and would now be wrong.
 */
export async function openTransactionsSheet(app, {
  title, subtitle = '', filters = {}, limit = 400,
}) {
  const res = await Bridge.db('get_transactions', {
    member_id: app.memberFilter, limit, ...filters,
  });

  if (res.status !== 'success') {
    await sheet(title, errorBlock(res));
    return;
  }

  const rows = res.transactions || [];
  const categoryRes = await Bridge.db('get_categories');
  const categories = categoryIndex(categoryRes.categories || []);

  const days = new Map();
  rows.forEach((tx) => {
    const key = tx.date || 'undated';
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(tx);
  });

  const total = rows.reduce((sum, tx) => sum + Number(tx.net_personal_amount ?? tx.amount), 0);

  const body = `
    ${subtitle ? `<p class="caption" style="margin:-6px 0 14px">${h(subtitle)}</p>` : ''}

    ${rows.length ? `
      <div class="grid-2" style="margin-bottom:14px">
        <div class="stat">
          <span class="caption">Entries</span>
          <span class="stat-value">${rows.length}${res.capped ? '+' : ''}</span>
        </div>
        <div class="stat">
          <span class="caption">Together</span>
          <span class="stat-value">${h(money(app, total))}</span>
        </div>
      </div>

      ${res.capped ? `
        <div class="banner">${icon('info')}<span class="banner-main"><span class="banner-body">
          Showing the most recent ${limit}. Narrow the period to see the rest.
        </span></span></div>` : ''}

      <div data-rows>
        ${[...days.entries()].map(([date, items]) => `
          <div class="section">
            <div class="list-divider">
              <span>${h(formatRelativeDate(date))}</span>
              <span class="numeric">${h(money(app, items.reduce((sum, tx) => sum
    + Number(tx.net_personal_amount ?? tx.amount), 0)))}</span>
            </div>
            <div class="list">
              ${items.map((tx) => transactionRow(tx, app, categories, { showDate: false })).join('')}
            </div>
          </div>`).join('')}
      </div>`
    : `<div class="card-flat">${emptyState('receipt_long', 'Nothing here',
    'No transactions match that period and filter.')}</div>`}`;

  await sheet(title, body, {
    autofocus: false,
    onMount(node, close) {
      const host = node.querySelector('[data-rows]');
      if (!host) return;
      // The rows open the editor. Whatever is above them was counted before the edit, so
      // the sheet closes and the screen behind it refreshes rather than showing stale sums.
      bindTransactionRows(host, {
        ...app,
        addTransaction: async (tx) => {
          close(null);
          await app.addTransaction(tx);
        },
      }, rows);
    },
  });
}

/* ------------------------------------------------------------- one period */

/**
 * What one day, week or month was made of.
 *
 * Opened by tapping a bar. The headline is the three flows and how they compare with the
 * period before, then the categories inside it, and each of those leads one level further
 * down. That chain is the whole feature: a bar is not a dead end any more.
 */
export async function openPeriodSheet(app, {
  granularity = 'month', bucket, flow = 'spend',
}) {
  const [summary, breakdown] = await Promise.all([
    Bridge.db('get_period_summary', { granularity, bucket, member_id: app.memberFilter }),
    Bridge.db('get_breakdown', {
      dimension: 'category', granularity, bucket, flow, member_id: app.memberFilter,
    }),
  ]);

  const title = formatBucketTitle(bucket, granularity);
  if (summary.status !== 'success') {
    await sheet(title, errorBlock(summary));
    return;
  }

  const rows = breakdown.status === 'success' ? breakdown.rows : [];
  const flowLabel = FLOWS.find((entry) => entry.value === flow)?.label || 'Spent';
  const isNetPositive = Number(summary.net || 0) >= 0;
  const periodLabel = describePeriod(bucket, granularity);

  const body = `
    <div style="display:flex;flex-direction:column;gap:14px">
      <!-- 1. Hero Cashflow & Net Flow Card -->
      <div class="period-hero-card">
        <div class="row-between" style="align-items:flex-start;gap:8px">
          <div>
            <span class="caption" style="font-size:12px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Net Kept</span>
            <div class="display ${isNetPositive ? 'income' : 'expense'}" style="font-size:26px;font-weight:800;margin-top:2px">
              ${isNetPositive ? '+' : ''}${h(money(app, summary.net))}
            </div>
          </div>
          <span class="badge ${isNetPositive ? 'badge-income' : 'badge-expense'}" style="flex-shrink:0;font-weight:700;padding:4px 8px">
            ${summary.savings_rate !== null ? `${summary.savings_rate}% Kept` : (isNetPositive ? 'Surplus' : 'Deficit')}
          </span>
        </div>

        <div style="padding-top:2px">
          ${deltaLine(summary.change.expense)}
        </div>

        <div class="period-flow-grid">
          <div class="period-flow-item">
            <span class="caption" style="font-size:11px">Spent (Outflow)</span>
            <span style="font-weight:700;font-size:15px;color:var(--expense)">${h(money(app, summary.expense))}</span>
          </div>
          <div class="period-flow-item">
            <span class="caption" style="font-size:11px">Received (Income)</span>
            <span style="font-weight:700;font-size:15px;color:var(--income)">${h(money(app, summary.income))}</span>
          </div>
          ${summary.invested ? `
            <div class="period-flow-item">
              <span class="caption" style="font-size:11px">Invested</span>
              <span style="font-weight:700;font-size:15px;color:var(--investment)">${h(money(app, summary.invested))}</span>
            </div>` : ''}
          ${summary.transferred ? `
            <div class="period-flow-item">
              <span class="caption" style="font-size:11px">Transfers</span>
              <span style="font-weight:700;font-size:15px;color:var(--accent)">${h(money(app, summary.transferred))}</span>
            </div>` : ''}
        </div>
      </div>

      <!-- 2. Financial Metrics Grid -->
      <div class="fact-grid" style="margin:0">
        <div class="fact">
          <span class="fact-label">Daily Average</span>
          <span class="fact-value">${h(money(app, summary.average_daily))} <span style="font-size:11px;font-weight:normal;color:var(--on-surface-variant)">/ day</span></span>
        </div>
        <div class="fact">
          <span class="fact-label">Total Entries</span>
          <span class="fact-value">${summary.count} <span style="font-size:11px;font-weight:normal;color:var(--on-surface-variant)">txns</span></span>
        </div>
        ${summary.top_category ? `
          <div class="fact">
            <span class="fact-label">Top Category</span>
            <span class="fact-value" title="${h(summary.top_category.name)}">${h(summary.top_category.name)}</span>
          </div>` : ''}
        ${summary.busiest_day ? `
          <div class="fact">
            <span class="fact-label">Peak Spend Day</span>
            <span class="fact-value">${h(formatRelativeDate(summary.busiest_day.date))}</span>
          </div>` : ''}
      </div>

      <!-- 3. Largest Single Expense Card -->
      ${summary.biggest ? `
        <div>
          <div class="section-header" style="margin-bottom:6px">
            <span class="title" style="font-size:13.5px">Largest single entry</span>
          </div>
          <div class="period-spotlight-card" data-open-biggest="${summary.biggest.id}">
            <span class="avatar avatar-sm avatar-expense" style="flex-shrink:0">
              ${icon('trending_up', 'icon-sm')}
            </span>
            <div style="flex:1;min-width:0">
              <div style="font-weight:700;font-size:14px;color:var(--on-surface);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                ${h(summary.biggest.merchant || summary.biggest.category)}
              </div>
              <div class="caption" style="font-size:11.5px;color:var(--on-surface-variant);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                ${h(summary.biggest.category)}${summary.biggest.date ? ` · ${h(formatRelativeDate(summary.biggest.date))}` : ''}
              </div>
            </div>
            <div style="font-size:15px;font-weight:700;color:var(--expense);font-variant-numeric:tabular-nums;flex-shrink:0;text-align:right">
              ${h(money(app, summary.biggest.amount))}
            </div>
          </div>
        </div>` : ''}

      <!-- 4. Category Breakdown -->
      <div>
        <div class="section-header" style="margin-bottom:8px">
          <span class="title">${h(flowLabel)} by category</span>
          <span class="caption">${h(money(app, breakdown.total || 0))}</span>
        </div>
        <div data-categories>
          ${rows.length ? `
            ${donutChart(rows.slice(0, 7).map((row) => ({
    key: row.key,
    label: row.label,
    value: row.total,
    color: row.color,
    formatted: money(app, row.total),
  })), {
    centerLabel: 'Total',
    centerValue: money(app, breakdown.total || 0),
    selectable: true,
  })}`
            : `<div class="card-flat"><div class="caption">No categorized entries in this period.</div></div>`}
        </div>
      </div>

      <!-- 5. View All Entries Button -->
      <button class="btn btn-tonal btn-block" data-all style="margin-top:4px">
        ${icon('receipt_long')}View all entries in ${h(periodLabel)}
      </button>
    </div>`;

  await sheet(title, body, {
    autofocus: false,
    onMount(node, close) {
      const openBiggestBtn = node.querySelector('[data-open-biggest]');
      if (openBiggestBtn && summary.biggest) {
        openBiggestBtn.addEventListener('click', async () => {
          close(null);
          await app.addTransaction(summary.biggest);
        });
      }

      bindChartSelect(node.querySelector('[data-categories]'), async (key) => {
        const row = rows.find((entry) => entry.key === key);
        if (!row) return;
        close(null);
        await openSliceSheet(app, {
          dimension: 'category',
          key: row.key,
          label: row.label,
          granularity,
          bucket,
          flow,
        });
      });

      node.querySelector('[data-all]').addEventListener('click', async () => {
        close(null);
        await openTransactionsSheet(app, {
          title,
          subtitle: `Entries in ${describePeriod(bucket, granularity)}`,
          filters: { from: summary.from, to: summary.to },
        });
      });
    },
  });
}

/* --------------------------------------------------- one slice of a period */

/**
 * One category, shop or person, inside one period.
 *
 * The trend behind it is the reason this is not just a filtered list: a category is only
 * alarming or not in comparison with the months before it, and the twelve buckets of
 * history come from the same aggregate the chart above was drawn from.
 */
export async function openSliceSheet(app, {
  dimension = 'category', key, label, granularity = 'month', bucket, flow = 'spend',
}) {
  const filters = { flow };
  if (dimension === 'category') filters.category = key;
  if (dimension === 'merchant') filters.merchant = key;
  if (dimension === 'weekday') filters.weekday = key;
  // One person's slice has to narrow the rows to that person, whatever the screen behind
  // this sheet was scoped to.
  if (dimension === 'member') filters.member_id = key;

  const range = { granularity, bucket };
  const trendArgs = {
    metric: flow === 'income' ? 'income_by_category' : 'spend_total',
    granularity,
    periods: granularity === 'day' ? 30 : 12,
    member_id: app.memberFilter,
  };
  if (dimension === 'category') trendArgs.category = key;
  if (dimension === 'merchant') trendArgs.merchant = key;

  /*
   * The breakdown first, on its own, because it is what settles the dates.
   *
   * A bucket key is a range, but only the backend knows where a week starts, so the
   * transaction query waits for the reply that states the window rather than the view
   * working it out a second time and risking a different answer.
   */
  const summary = await Bridge.db('get_breakdown', {
    dimension, ...range, flow, member_id: app.memberFilter,
  });
  const window = summary.status === 'success' ? { from: summary.from, to: summary.to } : {};

  const [trend, merchants, transactions] = await Promise.all([
    Bridge.db('get_series', trendArgs),
    dimension === 'category'
      ? Bridge.db('get_breakdown', {
        dimension: 'merchant', ...range, flow, category: key, member_id: app.memberFilter, limit: 8,
      })
      : Promise.resolve(null),
    Bridge.db('get_transactions', {
      member_id: app.memberFilter, limit: 200, ...filters, ...window,
    }),
  ]);

  const mine = summary.status === 'success'
    ? summary.rows.find((row) => row.key === String(key))
    : null;
  const title = label || mine?.label || String(key);

  const trendValues = trend.status === 'success' && trend.series.length
    ? trend.series[0].values
    : [];
  const average = trendValues.length
    ? trendValues.reduce((sum, value) => sum + value, 0) / trendValues.length
    : 0;
  const latest = trendValues.length ? trendValues[trendValues.length - 1] : 0;

  const rows = transactions.status === 'success' ? transactions.transactions : [];
  const categoryRes = await Bridge.db('get_categories');
  const categories = categoryIndex(categoryRes.categories || []);

  const body = `
    <div class="card-flat">
      <div class="row-between">
        <span class="caption">In ${h(describePeriod(bucket, granularity))}</span>
        <span class="title">${h(money(app, mine ? mine.total : 0))}</span>
      </div>
      <div class="row-between" style="margin-top:6px">
        <span class="caption">Usual for a ${h(granularity)}</span>
        <span class="caption numeric">${h(money(app, average))}</span>
      </div>
      ${average > 0 ? `
        <div style="margin-top:10px">
          ${deltaLine(((latest - average) / average) * 100)}
        </div>` : ''}
    </div>

    ${mine ? `
      <div class="fact-grid">
        ${fact('Entries', String(mine.count))}
        ${fact('Each time', money(app, mine.average))}
        ${fact('Share of the period', `${mine.share.toFixed(0)}%`)}
        ${fact('Last one', h(formatRelativeDate(mine.last)))}
      </div>` : ''}

    ${trend.status === 'success' && !trend.empty ? `
      <div class="card-flat" style="margin-top:4px">
        <div class="card-title">
          <span>Last ${trend.buckets.length} ${h(granularity)}s</span>
        </div>
        ${barSeriesChart(
    trend.buckets.map((entry, i) => formatBucketLabel(entry, granularity, i)),
    trend.series,
    { format: (value) => money(app, value), keys: trend.buckets, height: 130 },
  )}
      </div>` : ''}

    ${merchants && merchants.status === 'success' && merchants.rows.length > 1 ? `
      <div class="section-header" style="margin-top:12px"><span class="title">Where it went</span></div>
      ${barList(merchants.rows.map((row) => ({
    key: row.key,
    label: row.label,
    value: row.total,
    formatted: money(app, row.total),
    sub: `${row.count} ${row.count === 1 ? 'time' : 'times'}`,
  })), { selectable: true })}` : ''}

    <div class="section-header" style="margin-top:14px">
      <span class="title">Entries</span>
      <span class="caption">${rows.length}${transactions.capped ? '+' : ''}</span>
    </div>
    ${rows.length ? `
      <div class="list" data-rows>
        ${rows.map((tx) => transactionRow(tx, app, categories)).join('')}
      </div>`
    : `<div class="card-flat"><div class="caption">No entries in this period.</div></div>`}`;

  await sheet(title, body, {
    autofocus: false,
    onMount(node, close) {
      const host = node.querySelector('[data-rows]');
      if (host) {
        bindTransactionRows(host, editThenClose(app, close), rows);
      }

      // The trend is tappable too, so a spike three months back is one tap away rather
      // than a trip back to the chart to change the period first.
      bindChartSelect(node, async (tapped) => {
        if (!trend.buckets.includes(tapped)) return;
        close(null);
        await openSliceSheet(app, {
          dimension, key, label: title, granularity, bucket: tapped, flow,
        });
      });
    },
  });
}

/* ------------------------------------------------- a category, on its own */

/**
 * A category across time, rather than inside one period.
 *
 * Reached from Budgets, where the question is not "what did this cost in August" but "is
 * this getting worse". So the trend is the headline and the cap is checked against it.
 */
export async function openCategoryTrend(app, category, { onEdit } = {}) {
  const [trend, breakdown] = await Promise.all([
    Bridge.db('get_series', {
      metric: 'spend_total', granularity: 'month', periods: 12, category: category.name, member_id: app.memberFilter,
    }),
    Bridge.db('get_breakdown', {
      dimension: 'merchant', granularity: 'month', flow: 'spend', category: category.name,
      member_id: app.memberFilter, limit: 8,
    }),
  ]);

  const values = trend.status === 'success' && trend.series.length ? trend.series[0].values : [];
  const months = trend.status === 'success' ? trend.buckets : [];
  const spent = values.length ? values[values.length - 1] : 0;
  const average = values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
  const cap = Number(category.monthly_budget) || 0;
  const used = cap > 0 ? (spent / cap) * 100 : 0;

  const body = `
    <div class="card-flat">
      <div class="row-between">
        <span class="caption">This month</span>
        <span class="title">${h(money(app, spent))}</span>
      </div>
      <div class="row-between" style="margin-top:6px">
        <span class="caption">Monthly average over a year</span>
        <span class="caption numeric">${h(money(app, average))}</span>
      </div>
      ${cap > 0 ? `
        <div class="progress" style="margin-top:12px">
          <div class="progress-bar ${used > 100 ? 'over' : ''}" style="width:${Math.min(100, used)}%"></div>
        </div>
        <div class="caption" style="margin-top:8px">
          ${used > 100
    ? `Over the ${h(money(app, cap))} cap by ${h(money(app, spent - cap))}.`
    : `${h(money(app, cap - spent))} left of the ${h(money(app, cap))} cap.`}
        </div>`
    : '<div class="caption" style="margin-top:10px">No cap set for this category.</div>'}
    </div>

    ${trend.status === 'success' && !trend.empty ? `
      <div class="card-flat">
        <div class="card-title"><span>Month by month</span></div>
        ${barSeriesChart(
    months.map((entry, i) => formatBucketLabel(entry, 'month', i)),
    trend.series,
    { format: (value) => money(app, value), keys: months, height: 140 },
  )}
        <p class="caption" style="margin-top:10px">Tap a month to see what made it up.</p>
      </div>`
    : `<div class="card-flat">${emptyState('query_stats', 'No history yet',
    'Once there are a few months of entries in this category, the trend shows here.')}</div>`}

    ${breakdown.status === 'success' && breakdown.rows.length ? `
      <div class="section-header" style="margin-top:12px"><span class="title">This month, by shop</span></div>
      ${barList(breakdown.rows.map((row) => ({
    key: row.key,
    label: row.label,
    value: row.total,
    formatted: money(app, row.total),
    sub: `${row.count} ${row.count === 1 ? 'time' : 'times'}`,
  })), { selectable: true })}` : ''}

    ${onEdit ? `
      <button class="btn btn-outlined btn-block" data-edit style="margin-top:16px;flex-shrink:0;min-height:44px">
        ${icon('edit')}Edit this category
      </button>` : ''}`;

  await sheet(category.name, body, {
    autofocus: false,
    onMount(node, close) {
      bindChartSelect(node, async (key) => {
        close(null);
        if (months.includes(key)) {
          await openSliceSheet(app, {
            dimension: 'category',
            key: category.name,
            label: category.name,
            granularity: 'month',
            bucket: key,
          });
          return;
        }
        // A shop rather than a month: the same category, narrowed one step further.
        await openTransactionsSheet(app, {
          title: category.name,
          subtitle: `Everything filed under ${category.name} at this shop`,
          filters: { category: category.name, merchant: key },
        });
      });

      const edit = node.querySelector('[data-edit]');
      if (edit) {
        edit.addEventListener('click', () => {
          close(null);
          onEdit();
        });
      }
    },
  });
}

/** Shared by the screens that offer a granularity choice. */
export const GRANULARITY_OPTIONS = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
];

/**
 * Safe-to-Spend & Cashflow Runway cockpit sheet.
 */
export async function openCashflowSheet(app) {
  const member = app.memberFilter;
  const [safe, initialCustom, checklist] = await Promise.all([
    Bridge.db('get_safe_to_spend', { member_id: member }),
    Bridge.db('get_custom_runway', { member_id: member, burn_period_days: 90 }),
    Bridge.db('get_salary_checklist', { member_id: member }),
  ]);

  if (safe.status !== 'success') {
    await sheet('Cashflow Cockpit', errorBlock(safe));
    return;
  }

  const isDeficit = safe.health_status === 'deficit';
  const isTight = safe.health_status === 'tight';
  const statusColor = isDeficit ? 'var(--expense)' : (isTight ? 'var(--warning, #F59E0B)' : 'var(--income)');

  const formatRunwayLabel = (days, months, years) => {
    if (days <= 0) return '0 Days';
    if (years >= 2) return `${years} Years (${months} mos)`;
    if (months >= 1) return `${months} Months (${days} days)`;
    return `${days} Days`;
  };

  const state = {
    burn_period_days: initialCustom.burn_period_days || 90,
    custom_daily_burn: null,
    include_liquid: initialCustom.custom_configuration?.include_liquid ?? true,
    include_deposits: initialCustom.custom_configuration?.include_deposits ?? true,
    include_mutual_funds: initialCustom.custom_configuration?.include_mutual_funds ?? true,
    include_stocks: initialCustom.custom_configuration?.include_stocks ?? true,
    include_gold: initialCustom.custom_configuration?.include_gold ?? true,
    include_retirement: initialCustom.custom_configuration?.include_retirement ?? false,
    include_other: initialCustom.custom_configuration?.include_other ?? false,
    subtract_liabilities: initialCustom.custom_configuration?.subtract_liabilities ?? true,
    member_id: member,
  };

  const body = `
    <div style="display:flex;flex-direction:column;gap:14px">
      <!-- Financial Runway Forecaster Hero Card -->
      <div class="card-flat" style="background:var(--surface-container-high);border-radius:var(--radius);padding:14px;border-left:4px solid var(--accent)">
        <div class="row-between" style="align-items:center;flex-wrap:wrap;gap:6px">
          <span class="label" style="font-weight:700">Financial Runway</span>
          <span class="badge badge-accent" data-runway-badge style="flex-shrink:0">
            ${h(initialCustom.burn_basis_label)}
          </span>
        </div>
        <div class="display" data-runway-duration style="font-size:28px;color:var(--accent);margin:6px 0">
          ${h(formatRunwayLabel(initialCustom.runway_days, initialCustom.runway_months, initialCustom.runway_years))}
        </div>
        <div class="caption" data-runway-depletion style="margin-bottom:12px">
          ${initialCustom.depletion_date ? `Sustains living expenses until <strong>${h(initialCustom.depletion_date)}</strong>` : 'Funds sustain living expenses indefinitely.'}
        </div>

        <!-- Quick Presets -->
        <div style="margin-bottom:12px">
          <span class="caption" style="display:block;font-size:11px;margin-bottom:6px;font-weight:600">Quick Asset Presets</span>
          <div class="chip-scroller" style="gap:6px">
            <button type="button" class="chip" data-preset="liquid" aria-selected="false">${icon('account_balance_wallet')}Liquid Only</button>
            <button type="button" class="chip" data-preset="emergency" aria-selected="false">${icon('shield')}Emergency Pool</button>
            <button type="button" class="chip" data-preset="investable" aria-selected="true">${icon('trending_up')}Investments</button>
            <button type="button" class="chip" data-preset="net_worth" aria-selected="false">${icon('balance')}Net Worth</button>
          </div>
        </div>

        <!-- Burn rate selection -->
        <div style="margin-bottom:12px">
          <span class="caption" style="display:block;font-size:11px;margin-bottom:6px;font-weight:600">Average Daily Expense (Burn Rate)</span>
          <div class="chip-scroller" style="gap:6px">
            <button type="button" class="chip" data-period="30" aria-selected="${state.burn_period_days === 30}">30D (${h(money(app, initialCustom.historical_burn?.days_30?.daily_average || 0))}/d)</button>
            <button type="button" class="chip" data-period="90" aria-selected="${state.burn_period_days === 90}">90D Smoothed (${h(money(app, initialCustom.historical_burn?.days_90?.daily_average || 0))}/d)</button>
            <button type="button" class="chip" data-period="180" aria-selected="${state.burn_period_days === 180}">180D (${h(money(app, initialCustom.historical_burn?.days_180?.daily_average || 0))}/d)</button>
            <button type="button" class="chip" data-period="365" aria-selected="${state.burn_period_days === 365}">1 Year (${h(money(app, initialCustom.historical_burn?.days_365?.daily_average || 0))}/d)</button>
          </div>
          <div class="row" style="gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
            <input type="number" class="input input-sm" data-custom-burn style="max-width:130px" placeholder="Custom ₹/day" value="${state.custom_daily_burn || ''}">
            <span class="caption" data-burn-summary style="font-size:12px">
              Burn: ${h(money(app, initialCustom.monthly_living_burn))}/mo${initialCustom.monthly_loan_emis > 0 ? ` + ${h(money(app, initialCustom.monthly_loan_emis))}/mo EMIs` : ''} · Total: <strong>${h(money(app, initialCustom.monthly_burn))}/mo</strong> (${h(money(app, initialCustom.daily_burn))}/d)
            </span>
          </div>
        </div>

        <!-- Granular Asset Toggles -->
        <div style="background:var(--surface-container-low);border-radius:var(--radius-sm);padding:10px">
          <span class="caption" style="display:block;font-size:11px;margin-bottom:8px;font-weight:600">Included Assets & Liabilities</span>
          <div class="grid-2" style="gap:8px;font-size:12px">
            <label class="row" style="gap:6px;align-items:center">
              <input type="checkbox" data-toggle="include_liquid" ${state.include_liquid ? 'checked' : ''}>
              <span>Bank & Cash (${h(money(app, initialCustom.asset_breakdown.liquid))})</span>
            </label>
            <label class="row" style="gap:6px;align-items:center">
              <input type="checkbox" data-toggle="include_deposits" ${state.include_deposits ? 'checked' : ''}>
              <span>Fixed Deposits (${h(money(app, initialCustom.asset_breakdown.deposits))})</span>
            </label>
            <label class="row" style="gap:6px;align-items:center">
              <input type="checkbox" data-toggle="include_mutual_funds" ${state.include_mutual_funds ? 'checked' : ''}>
              <span>Mutual Funds (${h(money(app, initialCustom.asset_breakdown.mutual_funds))})</span>
            </label>
            <label class="row" style="gap:6px;align-items:center">
              <input type="checkbox" data-toggle="include_stocks" ${state.include_stocks ? 'checked' : ''}>
              <span>Stocks & Demat (${h(money(app, initialCustom.asset_breakdown.stocks))})</span>
            </label>
            <label class="row" style="gap:6px;align-items:center">
              <input type="checkbox" data-toggle="include_gold" ${state.include_gold ? 'checked' : ''}>
              <span>Gold & SGB (${h(money(app, initialCustom.asset_breakdown.gold))})</span>
            </label>
            <label class="row" style="gap:6px;align-items:center">
              <input type="checkbox" data-toggle="include_retirement" ${state.include_retirement ? 'checked' : ''}>
              <span>NPS & PF (${h(money(app, initialCustom.asset_breakdown.retirement))})</span>
            </label>
          </div>
          <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--outline-variant)">
            <label class="row" style="gap:6px;align-items:center;font-size:12px;color:var(--expense)">
              <input type="checkbox" data-toggle="subtract_liabilities" ${state.subtract_liabilities ? 'checked' : ''}>
              <span>Deduct Card Dues (${h(money(app, initialCustom.liabilities_breakdown.credit_cards))}) & Service Monthly EMIs (+${h(money(app, initialCustom.liabilities_breakdown.monthly_loan_emis))}/mo)</span>
            </label>
          </div>
        </div>

        <!-- Tier Comparison Cards -->
        <div style="margin-top:12px">
          <span class="caption" style="display:block;font-size:11px;margin-bottom:6px;font-weight:600">Runway by Asset Tier</span>
          <div class="grid-2" style="gap:8px">
            <div class="card" style="padding:8px;background:var(--surface-container-low)">
              <span class="caption" style="font-size:11px">Liquid Cash</span>
              <div style="font-weight:700;font-size:13.5px;color:var(--on-surface)" data-tier-liquid>
                ${h(formatRunwayLabel(initialCustom.tiers.liquid_only.runway_days, initialCustom.tiers.liquid_only.runway_months, initialCustom.tiers.liquid_only.runway_years))}
              </div>
              <span class="caption" style="font-size:10.5px">${h(money(app, initialCustom.tiers.liquid_only.net_amount))}</span>
            </div>
            <div class="card" style="padding:8px;background:var(--surface-container-low)">
              <span class="caption" style="font-size:11px">Emergency Pool (+FDs)</span>
              <div style="font-weight:700;font-size:13.5px;color:var(--on-surface)" data-tier-emergency>
                ${h(formatRunwayLabel(initialCustom.tiers.emergency_pool.runway_days, initialCustom.tiers.emergency_pool.runway_months, initialCustom.tiers.emergency_pool.runway_years))}
              </div>
              <span class="caption" style="font-size:10.5px">${h(money(app, initialCustom.tiers.emergency_pool.net_amount))}</span>
            </div>
            <div class="card" style="padding:8px;background:var(--surface-container-low)">
              <span class="caption" style="font-size:11px">Investable Assets</span>
              <div style="font-weight:700;font-size:13.5px;color:var(--on-surface)" data-tier-investable>
                ${h(formatRunwayLabel(initialCustom.tiers.investable.runway_days, initialCustom.tiers.investable.runway_months, initialCustom.tiers.investable.runway_years))}
              </div>
              <span class="caption" style="font-size:10.5px">${h(money(app, initialCustom.tiers.investable.net_amount))}</span>
            </div>
            <div class="card" style="padding:8px;background:var(--surface-container-low)">
              <span class="caption" style="font-size:11px">Total Net Worth</span>
              <div style="font-weight:700;font-size:13.5px;color:var(--on-surface)" data-tier-networth>
                ${h(formatRunwayLabel(initialCustom.tiers.net_worth.runway_days, initialCustom.tiers.net_worth.runway_months, initialCustom.tiers.net_worth.runway_years))}
              </div>
              <span class="caption" style="font-size:10.5px">${h(money(app, initialCustom.tiers.net_worth.net_amount))}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Safe to spend card -->
      <div class="card-flat" style="background:var(--surface-container-high);border-radius:var(--radius);padding:14px;border-left:4px solid ${statusColor}">
        <div class="row-between" style="align-items:center;flex-wrap:wrap;gap:6px">
          <span class="label" style="font-weight:700">Safe-to-Spend Allowance</span>
          <span class="badge" style="flex-shrink:0;background:${isDeficit ? 'var(--expense-container)' : 'var(--surface-container-highest)'};color:${statusColor}">
            ${isDeficit ? 'Deficit' : (isTight ? 'Tight Budget' : 'Safe to Spend')}
          </span>
        </div>
        <div class="display" style="font-size:28px;color:${statusColor};margin:6px 0">
          ${h(money(app, isDeficit ? 0 : safe.safe_to_spend_daily))}<span style="font-size:14px;font-weight:500;color:var(--on-surface-variant)"> / day</span>
        </div>
        <div class="caption" style="${isDeficit ? 'color:var(--expense)' : ''}">
          ${isDeficit
            ? `Short by <strong>${h(money(app, safe.deficit_amount || (safe.locked_commitments - safe.liquid_balance)))}</strong> for upcoming commitments this month.`
            : `${h(money(app, safe.safe_to_spend_weekly))} / week · <strong>${h(money(app, safe.safe_to_spend_total))}</strong> total safe for the next ${safe.days_remaining} days.`}
        </div>
      </div>

      <!-- Commitments breakdown -->
      <div class="card">
        <div class="card-title">Locked Commitments Breakdown</div>
        <div class="list" style="margin-top:8px">
          <div class="list-row">
            <span class="avatar avatar-sm" style="background:var(--surface-container-highest)">${icon('account_balance')}</span>
            <span class="list-row-main">
              <span class="list-row-title">Loan EMIs (${safe.counts.loans})</span>
              <span class="list-row-sub">Active monthly debt instalments</span>
            </span>
            <span class="list-row-amount expense">-${h(money(app, safe.breakdown.loan_emis))}</span>
          </div>
          <div class="list-row">
            <span class="avatar avatar-sm" style="background:var(--surface-container-highest)">${icon('trending_up')}</span>
            <span class="list-row-main">
              <span class="list-row-title">SIP Investments (${safe.counts.sips})</span>
              <span class="list-row-sub">Monthly mutual fund SIPs</span>
            </span>
            <span class="list-row-amount expense">-${h(money(app, safe.breakdown.sips))}</span>
          </div>
          <div class="list-row">
            <span class="avatar avatar-sm" style="background:var(--surface-container-highest)">${icon('credit_card')}</span>
            <span class="list-row-main">
              <span class="list-row-title">Credit Card Dues (${safe.counts.cards})</span>
              <span class="list-row-sub">Outstanding statement balances</span>
            </span>
            <span class="list-row-amount expense">-${h(money(app, safe.breakdown.credit_cards))}</span>
          </div>
          <div class="list-row">
            <span class="avatar avatar-sm" style="background:var(--surface-container-highest)">${icon('receipt_long')}</span>
            <span class="list-row-main">
              <span class="list-row-title">Fixed Bills & Rent (${safe.counts.recurring})</span>
              <span class="list-row-sub">Recurring utilities & subscriptions</span>
            </span>
            <span class="list-row-amount expense">-${h(money(app, safe.breakdown.recurring_bills))}</span>
          </div>
        </div>
      </div>

      <!-- Salary day checklist -->
      <div class="card">
        <div class="card-title">Salary Day Checklist</div>
        <p class="caption" style="margin-bottom:10px">Follow this order when your salary hits your account.</p>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${checklist.steps.map((step, idx) => `
            <div class="list-row" style="background:var(--surface-container-high);border-radius:var(--radius-sm);padding:8px 10px">
              <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--accent)">
                ${icon(step.icon)}
              </span>
              <span class="list-row-main">
                <span class="list-row-title" style="font-weight:600">${idx + 1}. ${h(step.title)}</span>
                <span class="list-row-sub">${h(step.desc)}</span>
              </span>
            </div>`).join('')}
        </div>
      </div>
    </div>`;

  await sheet('Cashflow Cockpit', body, {
    autofocus: false,
    onMount(node) {
      const durationEl = node.querySelector('[data-runway-duration]');
      const depletionEl = node.querySelector('[data-runway-depletion]');
      const badgeEl = node.querySelector('[data-runway-badge]');
      const burnSummaryEl = node.querySelector('[data-burn-summary]');
      const customBurnInput = node.querySelector('[data-custom-burn]');

      const tierLiquidEl = node.querySelector('[data-tier-liquid]');
      const tierEmergencyEl = node.querySelector('[data-tier-emergency]');
      const tierInvestableEl = node.querySelector('[data-tier-investable]');
      const tierNetWorthEl = node.querySelector('[data-tier-networth]');

      const refresh = async () => {
        const res = await Bridge.db('get_custom_runway', state);
        if (!res || res.status !== 'success') return;

        if (durationEl) {
          durationEl.textContent = formatRunwayLabel(res.runway_days, res.runway_months, res.runway_years);
        }
        if (depletionEl) {
          depletionEl.innerHTML = res.depletion_date
            ? `Sustains living expenses until <strong>${h(res.depletion_date)}</strong>`
            : 'Funds sustain living expenses indefinitely.';
        }
        if (badgeEl) {
          badgeEl.textContent = res.burn_basis_label;
        }
        if (burnSummaryEl) {
          const emiText = res.monthly_loan_emis > 0 && state.subtract_liabilities ? ` + ${money(app, res.monthly_loan_emis)}/mo EMIs` : '';
          burnSummaryEl.innerHTML = `Burn: ${money(app, res.monthly_living_burn)}/mo${emiText} · Total: <strong>${money(app, res.monthly_burn)}/mo</strong> (${money(app, res.daily_burn)}/d)`;
        }

        if (tierLiquidEl && res.tiers?.liquid_only) {
          tierLiquidEl.textContent = formatRunwayLabel(res.tiers.liquid_only.runway_days, res.tiers.liquid_only.runway_months, res.tiers.liquid_only.runway_years);
        }
        if (tierEmergencyEl && res.tiers?.emergency_pool) {
          tierEmergencyEl.textContent = formatRunwayLabel(res.tiers.emergency_pool.runway_days, res.tiers.emergency_pool.runway_months, res.tiers.emergency_pool.runway_years);
        }
        if (tierInvestableEl && res.tiers?.investable) {
          tierInvestableEl.textContent = formatRunwayLabel(res.tiers.investable.runway_days, res.tiers.investable.runway_months, res.tiers.investable.runway_years);
        }
        if (tierNetWorthEl && res.tiers?.net_worth) {
          tierNetWorthEl.textContent = formatRunwayLabel(res.tiers.net_worth.runway_days, res.tiers.net_worth.runway_months, res.tiers.net_worth.runway_years);
        }
      };

      // Presets
      node.querySelectorAll('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const preset = btn.dataset.preset;
          if (preset === 'liquid') {
            state.include_liquid = true;
            state.include_deposits = false;
            state.include_mutual_funds = false;
            state.include_stocks = false;
            state.include_gold = false;
            state.include_retirement = false;
            state.include_other = false;
          } else if (preset === 'emergency') {
            state.include_liquid = true;
            state.include_deposits = true;
            state.include_mutual_funds = false;
            state.include_stocks = false;
            state.include_gold = false;
            state.include_retirement = false;
            state.include_other = false;
          } else if (preset === 'investable') {
            state.include_liquid = true;
            state.include_deposits = true;
            state.include_mutual_funds = true;
            state.include_stocks = true;
            state.include_gold = true;
            state.include_retirement = false;
            state.include_other = false;
          } else if (preset === 'net_worth') {
            state.include_liquid = true;
            state.include_deposits = true;
            state.include_mutual_funds = true;
            state.include_stocks = true;
            state.include_gold = true;
            state.include_retirement = true;
            state.include_other = true;
          }

          node.querySelectorAll('[data-preset]').forEach((b) => {
            b.setAttribute('aria-selected', String(b.dataset.preset === preset));
          });

          // Sync checkbox elements
          node.querySelectorAll('[data-toggle]').forEach((chk) => {
            const field = chk.dataset.toggle;
            if (field in state) {
              chk.checked = Boolean(state[field]);
            }
          });

          refresh();
        });
      });

      // Period switches
      node.querySelectorAll('[data-period]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const period = Number(btn.dataset.period);
          state.burn_period_days = period;
          state.custom_daily_burn = null;
          if (customBurnInput) customBurnInput.value = '';

          node.querySelectorAll('[data-period]').forEach((b) => {
            b.setAttribute('aria-selected', String(Number(b.dataset.period) === period));
          });

          refresh();
        });
      });

      // Custom burn input
      if (customBurnInput) {
        customBurnInput.addEventListener('input', () => {
          const val = Number(customBurnInput.value);
          if (val > 0) {
            state.custom_daily_burn = val;
            node.querySelectorAll('[data-period]').forEach((b) => {
              b.setAttribute('aria-selected', 'false');
            });
          } else {
            state.custom_daily_burn = null;
          }
          refresh();
        });
      }

      // Checkboxes
      node.querySelectorAll('[data-toggle]').forEach((chk) => {
        chk.addEventListener('change', () => {
          const field = chk.dataset.toggle;
          if (field in state) {
            state[field] = chk.checked;

            // Clear preset selection if custom checkboxes diverge
            node.querySelectorAll('[data-preset]').forEach((b) => {
              b.setAttribute('aria-selected', 'false');
            });

            refresh();
          }
        });
      });
    },
  });
}

