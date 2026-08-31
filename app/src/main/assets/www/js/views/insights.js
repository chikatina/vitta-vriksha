/*
 * Insights: the screen where a number can be taken apart.
 *
 * Three controls decide what is on it. What you are looking at (money out, money in, money
 * invested), how finely it is cut (days, weeks, months), and which period is selected. Every
 * panel below reads from those three, so moving one moves the whole screen rather than
 * loading a different report.
 *
 * The chart is the navigation. Tapping a bar selects that period, which is what makes
 * stepping back through a year a series of taps rather than a series of round trips through
 * a date picker. Tapping a row in the breakdown goes one level deeper, into the sheets in
 * drilldown.js, and those eventually bottom out in the transactions themselves.
 *
 * The state below outlives a render on purpose: coming back from a drilldown sheet should
 * land on the period you left, not on this month.
 */

import { Bridge } from '../bridge.js';
import {
  h, icon, errorBlock, selectField, bindSelectFields,
} from '../ui.js';
import {
  formatBucketLabel, formatBucketTitle, formatCurrency, formatDelta, formatPercent,
  describePeriod, formatRelativeDate,
} from '../formatters.js';
import {
  barSeriesChart, lineSeriesChart, donutChart, heatCalendar, bindChartSelect,
} from '../charts.js';
import { memberChips, bindMemberChips } from './shared.js';
import {
  openPeriodSheet, openSliceSheet, openTransactionsSheet, GRANULARITY_OPTIONS,
} from './drilldown.js';

const FLOW_TABS = [
  { value: 'spend', label: 'Out' },
  { value: 'income', label: 'In' },
  { value: 'invest', label: 'Invested' },
  { value: 'transfer', label: 'Moved' },
];

/**
 * The charts each flow can be drawn as.
 *
 * A list per flow rather than one list filtered, because the interesting questions differ:
 * spending wants to be broken up, income wants to be compared with spending, and investing
 * wants to be accumulated.
 */
const CHARTS = {
  spend: [
    { metric: 'spend_total', label: 'Total', type: 'bars' },
    { metric: 'spend_by_category', label: 'Category', type: 'bars' },
    { metric: 'spend_by_merchant', label: 'Shop', type: 'bars' },
    { metric: 'monthly_debt', label: 'Debt & EMIs', type: 'stacked' },
    { metric: 'spend_by_member', label: 'Person', type: 'bars', family: true },
    { metric: 'income_expense', label: 'In and out', type: 'bars' },
    { metric: 'savings_rate', label: 'Kept %', type: 'line' },
  ],
  income: [
    { metric: 'income_by_category', label: 'Source', type: 'bars' },
    { metric: 'income_expense', label: 'In and out', type: 'bars' },
    { metric: 'net_flow', label: 'Kept', type: 'bars' },
    { metric: 'cumulative_savings', label: 'Running total', type: 'line' },
  ],
  invest: [
    { metric: 'investment_growth', label: 'Put in', type: 'line' },
    { metric: 'invest_flows', label: 'Bought and sold', type: 'bars' },
    { metric: 'invest_by_scheme', label: 'Scheme', type: 'bars' },
    { metric: 'invest_cumulative', label: 'Net into funds', type: 'line' },
  ],
  transfer: [
    { metric: 'transfer_total', label: 'Total', type: 'bars' },
    { metric: 'transfer_by_category', label: 'Category', type: 'bars' },
    { metric: 'transfer_by_merchant', label: 'Counterparty', type: 'bars' },
  ],
};

/** How much history each granularity offers, and what it starts on. */
const RANGES = {
  day: [14, 30, 60, 92],
  week: [8, 13, 26, 53],
  month: [6, 12, 24, 60],
};

const DIMENSIONS = [
  { value: 'category', label: 'Category' },
  { value: 'merchant', label: 'Shop' },
  { value: 'member', label: 'Person', family: true },
  { value: 'weekday', label: 'Weekday' },
  { value: 'type', label: 'Kind' },
];

/*
 * What the screen is showing, kept between visits.
 *
 * Also what a widget on Home writes into before opening this screen, which is how tapping
 * a panel arrives at the same chart rather than at the default one.
 */
export const insightsView = {
  flow: 'spend',
  granularity: 'month',
  offset: 0,
  periods: 6,
  metric: 'spend_total',
  dimension: 'category',
  selectedBucket: null,
  _restoreIndex: null,
};

/**
 * Points the screen at one chart, for a caller that knows what it wants shown.
 *
 * Also the guard that keeps the state coherent, since it runs on every render: a metric that
 * does not belong to the chosen flow drags the flow across to the one that owns it, rather
 * than being quietly replaced. A widget for money put into funds should not open a screen
 * showing groceries because it forgot to name the flow as well.
 */
export function focusInsights(preset = {}) {
  Object.assign(insightsView, preset);

  if (!CHARTS[insightsView.flow]) insightsView.flow = 'spend';
  if (!CHARTS[insightsView.flow].some((chart) => chart.metric === insightsView.metric)) {
    const owner = Object.keys(CHARTS)
      .find((flow) => CHARTS[flow].some((chart) => chart.metric === insightsView.metric));
    if (owner) insightsView.flow = owner;
    else insightsView.metric = CHARTS[insightsView.flow][0].metric;
  }

  if (!RANGES[insightsView.granularity]) insightsView.granularity = 'month';
  if (!RANGES[insightsView.granularity].includes(insightsView.periods)) {
    [, insightsView.periods] = RANGES[insightsView.granularity];
  }
  if (!DIMENSIONS.some((entry) => entry.value === insightsView.dimension)) {
    insightsView.dimension = 'category';
  }
}

const money = (app, value) => formatCurrency(value, app.currency, app.locale);

/*
 * The repainter of whichever copy of this screen is on show.
 *
 * The controls in the body have to be able to ask for a repaint, and the guard that keeps
 * two repaints from interleaving belongs to the screen rather than to a control. So the
 * screen publishes its guarded painter here and the body calls it, which also means a body
 * built by an earlier visit cannot repaint over a later one.
 */
let requestPaint = () => {};

function chartsFor(app) {
  return (CHARTS[insightsView.flow] || CHARTS.spend)
    .filter((chart) => !chart.family || app.familyEnabled);
}

export async function renderInsights(container, app) {
  focusInsights({});
  const memberRes = await Bridge.db('get_family_members');

  const memberHtml = memberChips(app, memberRes.members || []);

  container.innerHTML = `
    ${memberHtml ? `<div class="sticky-header">${memberHtml}</div>` : ''}

    <div class="segmented" data-flows>
      ${FLOW_TABS.map((tab) => `
        <button type="button" data-flow="${tab.value}"
                aria-selected="${tab.value === insightsView.flow}">${h(tab.label)}</button>`).join('')}
    </div>

    <div class="insight-controls">
      <div class="segmented segmented-sm" data-grains>
        ${GRANULARITY_OPTIONS.map((option) => `
          <button type="button" data-grain="${option.value}"
                  aria-selected="${option.value === insightsView.granularity}">${h(option.label)}</button>`).join('')}
      </div>
      <div data-range></div>
    </div>

    <div data-body class="insight-body"></div>`;

  const body = container.querySelector('[data-body]');

  const paintRange = () => {
    container.querySelector('[data-range]').innerHTML = selectField({
      key: 'periods',
      label: 'History',
      id: 'insightRange',
      value: String(insightsView.periods),
      options: RANGES[insightsView.granularity].map((count) => ({
        value: String(count),
        label: `${count} ${insightsView.granularity}s`,
      })),
    });
    bindSelectFields(container.querySelector('[data-range]'));
    container.querySelector('#insightRange').addEventListener('change', (event) => {
      insightsView.periods = Number(event.target.value) || RANGES[insightsView.granularity][1];
      paint();
    });
  };

  const select = (attribute, value, after) => {
    container.querySelectorAll(`[data-${attribute}]`).forEach((node) => {
      node.setAttribute('aria-selected', String(node.dataset[attribute] === value));
    });
    after();
  };

  container.querySelectorAll('[data-flow]').forEach((button) => {
    button.addEventListener('click', () => {
      insightsView.flow = button.dataset.flow;
      insightsView._restoreIndex = null;
      focusInsights({ metric: chartsFor(app)[0].metric });
      select('flow', button.dataset.flow, paint);
    });
  });

  container.querySelectorAll('[data-grain]').forEach((button) => {
    button.addEventListener('click', () => {
      insightsView.granularity = button.dataset.grain;
      // The period you were on has no meaning at a different granularity, and neither does
      // the range length, so both go back to what suits the new one.
      insightsView.offset = 0;
      insightsView._restoreIndex = null;
      [, insightsView.periods] = RANGES[insightsView.granularity];
      select('grain', button.dataset.grain, () => {
        paintRange();
        paint();
      });
    });
  });

  /*
   * One repaint at a time, and never a lost tap.
   *
   * Every control writes to the shared state and then asks for a repaint, so two quick taps
   * would otherwise interleave two fetches and let the slower one paint last. The second
   * request is remembered rather than dropped, because the state it wanted is already in
   * `insightsView` and painting it again is what shows the tap worked.
   */
  let painting = false;
  let queued = false;
  async function paint() {
    if (painting) {
      queued = true;
      return;
    }
    painting = true;
    try {
      await paintBody(body, app);
    } finally {
      painting = false;
    }
    if (queued) {
      queued = false;
      await paint();
    }
  }

  requestPaint = paint;
  paintRange();
  bindMemberChips(container, app);
  await paint();
}

/** Everything below the controls, repainted whenever a control moves. */
async function paintBody(host, app) {
  const chart = chartsFor(app).find((entry) => entry.metric === insightsView.metric)
    || chartsFor(app)[0];
  insightsView.metric = chart.metric;

  const series = await Bridge.db('get_series', {
    metric: chart.metric,
    granularity: insightsView.granularity,
    periods: insightsView.periods,
    offset: insightsView.offset,
    member_id: app.memberFilter,
  });

  if (series.status !== 'success') {
    host.innerHTML = errorBlock(series);
    return;
  }

  const buckets = series.buckets;
  let selectedIndex = insightsView.selectedBucket
    ? buckets.indexOf(insightsView.selectedBucket)
    : -1;
  if (selectedIndex === -1) {
    if (insightsView._restoreIndex != null) {
      selectedIndex = Math.min(insightsView._restoreIndex, buckets.length - 1);
      insightsView._restoreIndex = null;
    } else {
      selectedIndex = buckets.length - 1;
    }
  }
  const selected = buckets[selectedIndex];
  insightsView.selectedBucket = selected;

  const [summary, breakdown, calendar, weekendAnalysis] = await Promise.all([
    Bridge.db('get_period_summary', {
      granularity: insightsView.granularity, bucket: selected, member_id: app.memberFilter,
    }),
    Bridge.db('get_breakdown', {
      dimension: insightsView.dimension,
      granularity: insightsView.granularity,
      bucket: selected,
      flow: insightsView.flow,
      member_id: app.memberFilter,
    }),
    insightsView.granularity === 'month'
      ? Bridge.db('get_breakdown', {
        dimension: 'day',
        granularity: 'month',
        bucket: selected,
        flow: insightsView.flow,
        member_id: app.memberFilter,
      })
      : Promise.resolve(null),
    insightsView.flow === 'spend'
      ? Bridge.db('get_weekend_spend_analysis', { member_id: app.memberFilter })
      : Promise.resolve(null),
  ]);

  if (summary.status !== 'success') {
    host.innerHTML = errorBlock(summary);
    return;
  }

  const rows = breakdown.status === 'success' ? breakdown.rows : [];
  const isPercent = series.unit === 'percent';
  const format = (value) => (isPercent ? formatPercent(value, 0) : money(app, value));

  const isCurrentPeriod = insightsView.offset === 0 && selectedIndex === buckets.length - 1;
  const isCurrentMonth = insightsView.granularity === 'month' && isCurrentPeriod;
  const today = new Date();
  const daysPassed = isCurrentMonth ? Math.min(today.getDate(), summary.days || 30) : (summary.days || 30);
  const daysInMonth = summary.days || 30;

  const income = Number(summary.income || 0);
  const expense = Number(summary.expense || 0);
  const invested = Number(summary.invested || 0);
  const transferred = Number(summary.transferred || 0);
  const netKept = Number(summary.net || 0);
  const monthlyBudget = Number(summary.monthly_budget || app.monthlyBudget || 0);
  const previousIncome = Number(summary.previous?.income || 0);

  const headline = {
    spend: { value: summary.expense, label: 'Spent', className: 'expense', change: summary.change?.expense, worse: true },
    income: { value: summary.income, label: 'Received', className: 'income', change: summary.change?.income, worse: false },
    invest: { value: summary.invested, label: 'Invested', className: '', change: summary.change?.invested, worse: false },
    transfer: { value: summary.transferred || (breakdown.status === 'success' ? breakdown.total : 0), label: 'Moved (Transfers)', className: 'transfer', change: null, worse: false },
  }[insightsView.flow] || { value: summary.expense, label: 'Spent', className: 'expense', change: summary.change?.expense, worse: true };

  const rawSavingsRate = summary.savings_rate !== null && summary.savings_rate !== undefined
    ? Number(summary.savings_rate)
    : (income > 0 ? ((income - expense) / income) * 100 : null);
  const savingsRate = rawSavingsRate !== null ? Math.round(rawSavingsRate) : null;

  let healthBadge = '';
  if (isCurrentMonth && income === 0 && (expense > 0 || invested > 0)) {
    // Current month in progress, salary typically arrives at month end
    if (monthlyBudget > 0) {
      const budgetPacingPct = Math.round((expense / monthlyBudget) * 100);
      const expectedPacing = (daysPassed / daysInMonth);
      if (expense <= monthlyBudget * expectedPacing * 1.08) {
        healthBadge = `<span class="badge badge-income" style="flex-shrink:0">${icon('schedule', 'icon-sm')} On Track (${budgetPacingPct}% of Budget)</span>`;
      } else if (expense <= monthlyBudget) {
        healthBadge = `<span class="badge badge-warning" style="flex-shrink:0">${icon('schedule', 'icon-sm')} Pacing High (${budgetPacingPct}% of Budget)</span>`;
      } else {
        healthBadge = `<span class="badge badge-expense" style="flex-shrink:0">${icon('warning', 'icon-sm')} Over Budget (+${money(app, expense - monthlyBudget)})</span>`;
      }
    } else if (previousIncome > 0) {
      const incomePacingPct = Math.round((expense / previousIncome) * 100);
      const expectedPacing = (daysPassed / daysInMonth);
      if (expense <= previousIncome * expectedPacing * 1.08) {
        healthBadge = `<span class="badge badge-income" style="flex-shrink:0">${icon('schedule', 'icon-sm')} On Track · Salary Pending</span>`;
      } else if (expense <= previousIncome) {
        healthBadge = `<span class="badge badge-warning" style="flex-shrink:0">${icon('schedule', 'icon-sm')} Salary Pending (${incomePacingPct}% Spent)</span>`;
      } else {
        healthBadge = `<span class="badge badge-expense" style="flex-shrink:0">${icon('warning', 'icon-sm')} Over Prior Salary (+${money(app, expense - previousIncome)})</span>`;
      }
    } else {
      healthBadge = `<span class="badge badge-neutral" style="flex-shrink:0">${icon('schedule', 'icon-sm')} Month in Progress (Day ${daysPassed}/${daysInMonth})</span>`;
    }
  } else if (savingsRate !== null) {
    if (savingsRate >= 40) {
      healthBadge = `<span class="badge badge-income" style="font-weight:700;flex-shrink:0">${icon('verified_user', 'icon-sm')} Excellent (${savingsRate}% Kept)</span>`;
    } else if (savingsRate >= 20) {
      healthBadge = `<span class="badge badge-income" style="flex-shrink:0">${icon('check_circle', 'icon-sm')} Healthy (${savingsRate}% Kept)</span>`;
    } else if (savingsRate >= 0) {
      healthBadge = `<span class="badge badge-warning" style="flex-shrink:0">${icon('schedule', 'icon-sm')} Tight (${savingsRate}% Kept)</span>`;
    } else if (isCurrentMonth && daysPassed < daysInMonth - 3 && previousIncome > income) {
      healthBadge = `<span class="badge badge-warning" style="flex-shrink:0">${icon('schedule', 'icon-sm')} Salary Pending</span>`;
    } else {
      const totalOutflow = expense + invested;
      const excess = totalOutflow - income;
      if (income > 0) {
        const overRatio = totalOutflow / income;
        if (overRatio <= 2.0) {
          const overPct = Math.round((overRatio - 1) * 100);
          healthBadge = `<span class="badge badge-expense" style="flex-shrink:0">${icon('warning', 'icon-sm')} Deficit (${overPct}% Over)</span>`;
        } else {
          // Large outflow (e.g. EMI or big purchase): show clear rupee excess rather than absurd 1000%
          healthBadge = `<span class="badge badge-expense" style="flex-shrink:0">${icon('warning', 'icon-sm')} Deficit (+${money(app, excess)})</span>`;
        }
      } else {
        healthBadge = `<span class="badge badge-expense" style="flex-shrink:0">${icon('warning', 'icon-sm')} Outflow (${money(app, totalOutflow)})</span>`;
      }
    }
  }

  const effectiveIncome = income > 0 ? income : (isCurrentMonth && previousIncome > 0 ? previousIncome : 0);
  const expPct = effectiveIncome > 0 ? Math.min(100, Math.round((expense / effectiveIncome) * 100)) : (expense > 0 ? 100 : 0);
  const invPct = effectiveIncome > 0 ? Math.min(Math.max(0, 100 - expPct), Math.round((invested / effectiveIncome) * 100)) : 0;
  const keptPct = Math.max(0, 100 - expPct - invPct);

  host.innerHTML = `
    <div class="period-nav">
      <button class="icon-button" data-older aria-label="Earlier period">${icon('chevron_left')}</button>
      <div class="period-nav-main">
        <span class="period-nav-title">${h(formatBucketTitle(selected, insightsView.granularity))}</span>
        <span class="caption">${insightsView.offset === 0 && selectedIndex === buckets.length - 1 ? 'Current' : `${insightsView.offset > 0 ? `${insightsView.offset} ${insightsView.granularity}s ago` : ''}`}</span>
      </div>
      <button class="icon-button" data-newer aria-label="Later period"
              ${insightsView.offset === 0 && selectedIndex === buckets.length - 1 ? 'disabled' : ''}>${icon('chevron_right')}</button>
    </div>

    <div class="card" style="border:1px solid var(--outline-variant);background:linear-gradient(180deg, var(--surface-container-low), var(--surface-container))">
      <div class="row-between" style="align-items:center;margin-bottom:var(--gap-1);flex-wrap:wrap;gap:6px">
        <span class="overline" style="margin-bottom:0">${h(headline.label)} · ${h(formatBucketTitle(selected, insightsView.granularity))}</span>
        ${healthBadge}
      </div>

      <div class="display ${headline.className}" style="font-size:28px;margin-bottom:var(--gap-1)">${h(money(app, headline.value))}</div>

      <div class="row" style="gap:10px;margin-bottom:var(--gap-3);flex-wrap:wrap">
        ${changeChip(headline.change, headline.worse)}
        <span class="caption">${insightsView.flow === 'transfer' ? (summary.transferred_count ?? summary.count) : summary.count} ${(insightsView.flow === 'transfer' ? (summary.transferred_count ?? summary.count) : summary.count) === 1 ? 'entry' : 'entries'}</span>
        <span class="caption">${h(money(app, summary.days > 0 ? Number(headline.value || 0) / summary.days : summary.average_daily))} / day</span>
      </div>

      ${effectiveIncome > 0 ? `
        <div style="margin:var(--gap-3) 0 var(--gap-2)">
          <div class="row-between" style="font-size:11px;font-weight:600;margin-bottom:4px;color:var(--on-surface-variant)">
            <span>${income === 0 && isCurrentMonth ? 'Projected Allocation (vs Prior Salary)' : 'Cashflow Allocation'}</span>
            <span>Spends ${expPct}% ${invPct > 0 ? `· Invest ${invPct}% ` : ''}· Kept ${keptPct}%</span>
          </div>
          <div class="waterfall-bar">
            <div class="wf-expense" style="width:${expPct}%" title="Expenses ${expPct}%"></div>
            ${invPct > 0 ? `<div class="wf-invest" style="width:${invPct}%" title="Investments ${invPct}%"></div>` : ''}
            <div class="wf-kept" style="width:${keptPct}%" title="Kept ${keptPct}%"></div>
          </div>
        </div>` : ''}

      <div class="grid-2" style="gap:8px;margin-top:var(--gap-3)">
        <div class="card-flat" style="padding:10px;background:var(--surface-container-high);border-radius:var(--radius-sm)">
          <span class="caption" style="font-size:11px;display:block">Net Kept (Savings)</span>
          <span class="stat-value ${income > 0 ? (netKept >= 0 ? 'income' : 'expense') : (isCurrentMonth ? '' : 'expense')}" style="font-size:16px;font-weight:700">
            ${income > 0 || !isCurrentMonth ? `${netKept >= 0 ? '+' : ''}${h(money(app, netKept))}` : `${h(money(app, -expense - invested))}`}
          </span>
          <span class="caption" style="font-size:11px;display:block;margin-top:2px">
            ${income > 0
              ? (netKept >= 0
                ? `${savingsRate}% of income`
                : ((expense + invested) <= 2 * income
                  ? `${Math.round(((expense + invested - income) / income) * 100)}% over income`
                  : `+${h(money(app, expense + invested - income))} over income`))
              : (isCurrentMonth && previousIncome > 0
                ? `Projected +${h(money(app, previousIncome - expense - invested))} after salary`
                : (isCurrentMonth ? 'Month in progress · Salary pending' : 'No income recorded'))}
          </span>
        </div>

        <div class="card-flat" style="padding:10px;background:var(--surface-container-high);border-radius:var(--radius-sm)">
          <span class="caption" style="font-size:11px;display:block">Inflow vs Outflow</span>
          <div class="row" style="gap:4px;align-items:baseline;margin-top:2px">
            <span class="income" style="font-weight:700;font-size:13px">${income > 0 ? h(money(app, income)) : (isCurrentMonth && previousIncome > 0 ? `Pending (~${h(money(app, previousIncome))})` : h(money(app, 0)))}</span>
            <span class="caption">/</span>
            <span class="expense" style="font-weight:700;font-size:13px">${h(money(app, expense + invested))}</span>
          </div>
          <span class="caption" style="font-size:11px;display:block;margin-top:2px">
            ${invested > 0 ? `${h(money(app, invested))} invested` : (transferred > 0 ? `${h(money(app, transferred))} moved (excluded)` : 'Total cashflow')}
          </span>
        </div>

        <div class="card-flat" style="padding:10px;background:var(--surface-container-high);border-radius:var(--radius-sm)">
          <span class="caption" style="font-size:11px;display:block">Top Expense Category</span>
          <span class="list-row-title" style="font-size:13px;display:block;margin-top:2px">
            ${h(summary.top_category ? summary.top_category.name : '-')}
          </span>
        </div>

        <div class="card-flat" style="padding:10px;background:var(--surface-container-high);border-radius:var(--radius-sm)">
          <span class="caption" style="font-size:11px;display:block">Peak Spend Day</span>
          <span class="list-row-title" style="font-size:13px;display:block;margin-top:2px">
            ${h(summary.busiest_day ? formatRelativeDate(summary.busiest_day.date) : '-')}
          </span>
        </div>
      </div>

      <button class="btn btn-tonal btn-block row-between" data-detail style="margin-top:14px;padding:12px 14px;border-radius:var(--radius-sm);justify-content:space-between;width:100%;text-align:left">
        <span class="row" style="gap:10px;align-items:center">
          ${icon('pie_chart', 'icon-md')}
          <span>
            <span style="display:block;font-weight:650;font-size:13.5px">Explore Period Breakdown</span>
            <span class="caption" style="display:block;font-size:11.5px">Category splits, top merchants and entries</span>
          </span>
        </span>
        ${icon('chevron_right')}
      </button>
    </div>

    <div class="card">
      <div class="card-title">
        <span>${h(series.label)}</span>
        <span class="caption">${h(summarise(series, format))}</span>
      </div>

      <div class="chip-scroller" data-charts>
        ${chartsFor(app).map((entry) => `
          <button type="button" class="chip" data-chart="${entry.metric}"
                  aria-selected="${entry.metric === insightsView.metric}">${h(entry.label)}</button>`).join('')}
      </div>

      <div data-chart-host style="margin-top:14px">
        ${series.empty
    ? `<div class="caption" style="text-align:center;padding:22px 0">Nothing recorded in this stretch yet.</div>`
    : chart.type === 'line'
      ? lineSeriesChart(
        buckets.map((key, i) => formatBucketLabel(key, insightsView.granularity, i)),
        series.series,
        { format, keys: buckets, selected: selectedIndex, height: 170 },
      )
      : barSeriesChart(
        buckets.map((key, i) => formatBucketLabel(key, insightsView.granularity, i)),
        series.series,
        {
          format, keys: buckets, selected: selectedIndex, height: 170, stacked: series.stacked,
        },
      )}
      </div>

      ${series.series.length > 1 ? `<div style="margin-top:12px">${legendRows(series.series)}</div>` : ''}
    </div>

    ${calendar && calendar.status === 'success' ? `
      <div class="card">
        <div class="card-title">
          <span>Day by day</span>
          <span class="caption">${h(money(app, calendar.total))}</span>
        </div>
        <div data-calendar>
          ${heatCalendar(fillDays(summary.from, summary.to, calendar.rows), {
    format: (value) => money(app, value),
  })}
        </div>
      </div>` : ''}

    ${weekendAnalysis && weekendAnalysis.status === 'success' && (weekendAnalysis.weekend.total > 0 || weekendAnalysis.weekday.total > 0) ? `
      <div class="card">
        <div class="row-between" style="flex-wrap:wrap;gap:8px;align-items:center">
          <span class="card-title" style="margin-bottom:0">Weekend vs Weekday</span>
          <span class="badge ${weekendAnalysis.intensity_ratio >= 1.5 ? 'badge-expense' : 'badge-investment'}" style="white-space:nowrap;flex-shrink:0">
            ${weekendAnalysis.intensity_ratio}× Intensity
          </span>
        </div>
        <p class="caption" style="margin:4px 0 12px">${h(weekendAnalysis.verdict)}</p>

        <div class="grid-2" style="gap:10px;margin-bottom:12px">
          <div class="card-flat" style="background:var(--surface-container-high);padding:10px;border-radius:var(--radius-sm)">
            <span class="caption" style="font-size:11px">Weekend (Fri–Sun)</span>
            <div style="font-weight:700;font-size:15px;color:var(--expense);margin:2px 0">
              ${h(money(app, weekendAnalysis.weekend.daily_average))}<span style="font-size:11px;font-weight:400;color:var(--on-surface-variant)">/day</span>
            </div>
            <span class="caption">${weekendAnalysis.weekend.share_percent}% of total spend</span>
          </div>

          <div class="card-flat" style="background:var(--surface-container-high);padding:10px;border-radius:var(--radius-sm)">
            <span class="caption" style="font-size:11px">Weekday (Mon–Thu)</span>
            <div style="font-weight:700;font-size:15px;color:var(--on-surface);margin:2px 0">
              ${h(money(app, weekendAnalysis.weekday.daily_average))}<span style="font-size:11px;font-weight:400;color:var(--on-surface-variant)">/day</span>
            </div>
            <span class="caption">${weekendAnalysis.weekday.share_percent}% of total spend</span>
          </div>
        </div>

        ${weekendAnalysis.weekend.top_categories.length ? `
          <div style="font-size:12px;font-weight:600;color:var(--on-surface-variant);margin-bottom:6px">Top Weekend Spends:</div>
          <div class="row" style="gap:6px;flex-wrap:wrap">
            ${weekendAnalysis.weekend.top_categories.map((c) => `
              <span class="chip" style="font-size:11.5px;padding:4px 8px;background:var(--surface-container-highest)">
                ${h(c.category)}: ${h(money(app, c.total))} (${c.share}%)
              </span>`).join('')}
          </div>` : ''}
      </div>` : ''}

    <div class="card">
      <div class="card-title">
        <span>Breakdown</span>
        <span class="caption">${h(money(app, breakdown.total || 0))}</span>
      </div>

      <div class="chip-scroller" data-dimensions>
        ${DIMENSIONS.filter((entry) => !entry.family || app.familyEnabled).map((entry) => `
          <button type="button" class="chip" data-dimension="${entry.value}"
                  aria-selected="${entry.value === insightsView.dimension}">${h(entry.label)}</button>`).join('')}
      </div>

      <div data-breakdown style="margin-top:14px">
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
    : `<div class="caption" style="text-align:center;padding:20px 0">
         Nothing to break up in this period.
       </div>`}
      </div>
    </div>

    <button class="btn btn-outlined btn-block" data-entries>
      ${icon('receipt_long')}View all entries in ${h(describePeriod(selected, insightsView.granularity))}
    </button>`;

  /* ------------------------------------------------------------- wiring */

  const repaint = () => requestPaint();

  host.querySelector('[data-older]').addEventListener('click', () => {
    if (selectedIndex > 0) {
      insightsView.selectedBucket = buckets[selectedIndex - 1];
    } else {
      insightsView.offset += 1;
      insightsView._restoreIndex = 0;
      insightsView.selectedBucket = null;
    }
    repaint();
  });
  host.querySelector('[data-newer]').addEventListener('click', () => {
    if (selectedIndex < buckets.length - 1) {
      insightsView.selectedBucket = buckets[selectedIndex + 1];
    } else if (insightsView.offset > 0) {
      insightsView.offset -= 1;
      insightsView._restoreIndex = buckets.length - 1;
      insightsView.selectedBucket = null;
    }
    repaint();
  });

  host.querySelectorAll('[data-chart]').forEach((button) => {
    button.addEventListener('click', () => {
      insightsView.metric = button.dataset.chart;
      repaint();
    });
  });

  host.querySelectorAll('[data-dimension]').forEach((button) => {
    button.addEventListener('click', () => {
      insightsView.dimension = button.dataset.dimension;
      repaint();
    });
  });

  // Tap a chart bar/point to update the selected period in-place
  bindChartSelect(host.querySelector('[data-chart-host]'), (key) => {
    insightsView.selectedBucket = key;
    repaint();
  });

  const calendarHost = host.querySelector('[data-calendar]');
  if (calendarHost) {
    bindChartSelect(calendarHost, (date) => {
      openPeriodSheet(app, { granularity: 'day', bucket: date, flow: insightsView.flow });
    });
  }

  bindChartSelect(host.querySelector('[data-breakdown]'), async (key) => {
    const row = rows.find((entry) => entry.key === key);
    if (!row) return;
    await openSliceSheet(app, {
      dimension: insightsView.dimension,
      key: row.key,
      label: row.label,
      granularity: insightsView.granularity,
      bucket: selected,
      flow: insightsView.flow,
    });
  });

  host.querySelector('[data-detail]').addEventListener('click', () => {
    openPeriodSheet(app, {
      granularity: insightsView.granularity, bucket: selected, flow: insightsView.flow,
    });
  });

  host.querySelector('[data-entries]').addEventListener('click', () => {
    openTransactionsSheet(app, {
      title: formatBucketTitle(selected, insightsView.granularity),
      subtitle: `Everything recorded in ${describePeriod(selected, insightsView.granularity)}`,
      filters: { from: summary.from, to: summary.to },
    });
  });
}

/**
 * The one figure a chart's heading can carry.
 *
 * A total for money, and an average for a rate: six months of "sixty percent kept" adds up
 * to three hundred and sixty percent, which is not a number anybody wanted.
 */
function summarise(series, format) {
  const values = series.series.flatMap((entry) => entry.values);
  if (!values.length) return '';
  const total = values.reduce((sum, value) => sum + value, 0);
  return series.unit === 'percent'
    ? `${format(total / series.buckets.length)} on average`
    : format(total);
}

/** The comparison, as a chip rather than a sentence, because it sits beside the figure. */
function changeChip(percent, moreIsWorse) {
  if (percent === null || percent === undefined || !Number.isFinite(Number(percent))) {
    return '<span class="caption">No period before this one</span>';
  }
  const value = Number(percent);
  if (Math.abs(value) < 0.5) return '<span class="badge badge-info">Level with last time</span>';
  const worse = moreIsWorse ? value > 0 : value < 0;
  return `
    <span class="badge ${worse ? 'badge-expense' : 'badge-income'}">
      ${h(formatDelta(value))} on last time
    </span>`;
}

function legendRows(series) {
  return `<div class="row" style="flex-wrap:wrap;gap:10px 14px">${series.map((entry) => `
    <span class="row" style="gap:6px">
      <span class="legend-dot" style="background:${h(entry.color || 'var(--accent)')}"></span>
      <span class="caption">${h(entry.label)}</span>
    </span>`).join('')}</div>`;
}

/**
 * Every day in the window, including the quiet ones.
 *
 * A breakdown only reports days something happened on, and a calendar with the empty days
 * missing is not a calendar: the seventeenth would sit where the fourth should be.
 */
function fillDays(from, to, rows) {
  const totals = new Map((rows || []).map((row) => [row.key, row.total]));
  const cells = [];
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);

  for (let cursor = start; cursor < end; cursor.setDate(cursor.getDate() + 1)) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    cells.push({ date: key, value: totals.get(key) || 0 });
  }
  return cells;
}
