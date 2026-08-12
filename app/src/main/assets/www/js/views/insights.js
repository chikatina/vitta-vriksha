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
  barSeriesChart, lineSeriesChart, barList, heatCalendar, bindChartSelect,
} from '../charts.js';
import { memberChips, bindMemberChips } from './shared.js';
import {
  openPeriodSheet, openSliceSheet, openTransactionsSheet, GRANULARITY_OPTIONS,
} from './drilldown.js';

const FLOW_TABS = [
  { value: 'spend', label: 'Out' },
  { value: 'income', label: 'In' },
  { value: 'invest', label: 'Invested' },
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
    { metric: 'invest_flows', label: 'Bought and sold', type: 'bars' },
    { metric: 'invest_by_scheme', label: 'Scheme', type: 'bars' },
    { metric: 'investment_growth', label: 'Put in', type: 'line' },
    { metric: 'invest_cumulative', label: 'Net into funds', type: 'line' },
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
    selectedIndex = buckets.length - 1;
  }
  const selected = buckets[selectedIndex];
  insightsView.selectedBucket = selected;

  const [summary, breakdown, calendar] = await Promise.all([
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
  ]);

  if (summary.status !== 'success') {
    host.innerHTML = errorBlock(summary);
    return;
  }

  const rows = breakdown.status === 'success' ? breakdown.rows : [];
  const isPercent = series.unit === 'percent';
  const format = (value) => (isPercent ? formatPercent(value, 0) : money(app, value));

  const headline = {
    spend: { value: summary.expense, label: 'Spent', className: 'expense', change: summary.change.expense, worse: true },
    income: { value: summary.income, label: 'Received', className: 'income', change: summary.change.income, worse: false },
    invest: { value: summary.invested, label: 'Invested', className: '', change: summary.change.invested, worse: false },
  }[insightsView.flow];

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

    <div class="card">
      <span class="overline">${h(headline.label)} in ${h(describePeriod(selected, insightsView.granularity))}</span>
      <div class="display ${headline.className}">${h(money(app, headline.value))}</div>
      <div class="row" style="gap:10px;margin-top:6px;flex-wrap:wrap">
        ${changeChip(headline.change, headline.worse)}
        <span class="caption">${summary.count} ${summary.count === 1 ? 'entry' : 'entries'}</span>
        <span class="caption">${h(money(app, summary.average_daily))} a day</span>
      </div>
      <div class="fact-grid" style="margin-top:14px">
        <div class="fact">
          <span class="fact-label">Kept</span>
          <span class="fact-value ${summary.net >= 0 ? 'income' : 'expense'}">${h(money(app, summary.net))}</span>
        </div>
        <div class="fact">
          <span class="fact-label">Kept of income</span>
          <span class="fact-value">${summary.savings_rate === null ? '-' : h(formatPercent(summary.savings_rate))}</span>
        </div>
        <div class="fact">
          <span class="fact-label">Biggest category</span>
          <span class="fact-value">${h(summary.top_category ? summary.top_category.name : '-')}</span>
        </div>
        <div class="fact">
          <span class="fact-label">Heaviest day</span>
          <span class="fact-value">${h(summary.busiest_day ? formatRelativeDate(summary.busiest_day.date) : '-')}</span>
        </div>
      </div>
      <button class="btn btn-tonal btn-block" data-detail style="margin-top:14px">
        ${icon('query_stats')}Period breakdown
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
        ${rows.length ? barList(rows.slice(0, 12).map((row) => ({
    key: row.key,
    label: row.label,
    value: row.total,
    color: row.color,
    formatted: money(app, row.total),
    sub: `${row.count} ${row.count === 1 ? 'entry' : 'entries'} · ${row.share.toFixed(0)}%`,
  })), { selectable: true })
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
      insightsView.selectedBucket = null;
    }
    repaint();
  });
  host.querySelector('[data-newer]').addEventListener('click', () => {
    if (selectedIndex < buckets.length - 1) {
      insightsView.selectedBucket = buckets[selectedIndex + 1];
    } else if (insightsView.offset > 0) {
      insightsView.offset -= 1;
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
