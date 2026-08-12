/*
 * The Home dashboard is a list of widget instances the user assembles.
 *
 * An instance, not a widget: the same panel can appear twice with different settings, so
 * "spending by category over six months" and "spending by category over two years" are two
 * cards on the same screen. That is why a layout entry is an object with its own id and its
 * own options rather than a widget name. A layout written by an older build is a list of
 * names, and `readLayout` still accepts one.
 *
 * Each entry declares what it needs as a function of its options, and Home batches those
 * needs so a screenful of panels costs one round of queries however many panels there are.
 * Two instances that want the same thing share one fetch, which is the reason a need is a
 * string key rather than a call.
 *
 * On charting libraries: something like Perspective would bring its own WASM runtime and
 * expect a CDN or a bundler. This app has neither, and no INTERNET permission to fetch one
 * with, so the charts are drawn as SVG against aggregates SQLite already computes. That
 * keeps the APK the size it is and the data on the device.
 */

import { Bridge } from '../bridge.js';
import { icon, h, emptyState } from '../ui.js';
import {
  formatBucketLabel, formatCurrency, formatDelta, formatMonthKey, formatPercent,
  formatRelativeDate, describePeriod,
} from '../formatters.js';
import {
  barSeriesChart, lineSeriesChart, donutChart, barList, legend, heatCalendar, sparkline,
  bindChartSelect,
} from '../charts.js';
import { categoryIndex, transactionRow, bindTransactionRows } from './shared.js';
import { openPeriodSheet, openSliceSheet, openTransactionsSheet } from './drilldown.js';
import { focusInsights } from './insights.js';

const UPCOMING_ICONS = {
  sip: 'trending_up',
  subscription: 'subscriptions',
  loan: 'account_balance',
  card: 'credit_card',
};

/* ----------------------------------------------------------------- options */

/**
 * How much history a chart shows, as one choice rather than two.
 *
 * A granularity and a count as separate controls lets somebody ask for six days or
 * twenty-four weeks of a daily chart, neither of which is what they meant. Pairing them
 * means every option in the list is a period that makes sense.
 */
const SPANS = [
  { value: 'day:14', label: 'Last 14 days' },
  { value: 'day:30', label: 'Last 30 days' },
  { value: 'week:8', label: 'Last 8 weeks' },
  { value: 'week:13', label: 'Last 13 weeks' },
  { value: 'month:6', label: 'Last 6 months' },
  { value: 'month:12', label: 'Last 12 months' },
  { value: 'month:24', label: 'Last 24 months' },
];

const SPAN_OPTION = { key: 'span', label: 'Period', default: 'month:6', choices: SPANS };

const STYLE_OPTION = {
  key: 'style',
  label: 'Drawn as',
  default: 'bars',
  choices: [
    { value: 'bars', label: 'Bars' },
    { value: 'line', label: 'Line' },
  ],
};

const FLOW_OPTION = {
  key: 'flow',
  label: 'Money',
  default: 'spend',
  choices: [
    { value: 'spend', label: 'Going out' },
    { value: 'income', label: 'Coming in' },
    { value: 'invest', label: 'Invested' },
  ],
};

const WINDOW_OPTION = {
  key: 'window',
  label: 'Period',
  default: 'month',
  choices: [
    { value: 'day', label: 'Today' },
    { value: 'week', label: 'This week' },
    { value: 'month', label: 'This month' },
  ],
};

const COUNT_OPTION = {
  key: 'count',
  label: 'How many rows',
  default: '5',
  choices: ['3', '5', '8', '12'].map((value) => ({ value, label: `${value} rows` })),
};

/** The charts a free-form panel can be pointed at. Keys match the backend catalogue. */
const METRIC_OPTION = {
  key: 'metric',
  label: 'What to chart',
  default: 'spend_total',
  choices: [
    { value: 'spend_total', label: 'Total spent' },
    { value: 'income_expense', label: 'Money in and out' },
    { value: 'net_flow', label: 'Kept each period' },
    { value: 'savings_rate', label: 'Share of income kept' },
    { value: 'spend_by_category', label: 'Spending by category' },
    { value: 'spend_by_merchant', label: 'Spending by shop' },
    { value: 'income_by_category', label: 'Income by source' },
    { value: 'cumulative_savings', label: 'Running total kept' },
    { value: 'investment_growth', label: 'Invested so far' },
    { value: 'invest_flows', label: 'Funds bought and sold' },
    { value: 'invest_by_scheme', label: 'Funds bought, by scheme' },
  ],
};

/** Reads a span option into the two things a query needs. */
function readSpan(options) {
  const [granularity, periods] = String(options.span || SPAN_OPTION.default).split(':');
  return {
    granularity: ['day', 'week', 'month'].includes(granularity) ? granularity : 'month',
    periods: Number.parseInt(periods, 10) || 6,
  };
}

const seriesNeed = (metric, options) => {
  const { granularity, periods } = readSpan(options);
  return `series:${metric}:${granularity}:${periods}`;
};

const breakdownNeed = (dimension, options) => `breakdown:${dimension}:${options.window || 'month'}:${options.flow || 'spend'}`;

const periodNeed = (options) => `period:${options.window || 'month'}`;

const money = (app, value) => formatCurrency(value, app.currency, app.locale);

function card(title, body, { action = '' } = {}) {
  return `
    <div class="card">
      <div class="card-title"><span>${h(title)}</span>${action}</div>
      ${body}
    </div>`;
}

/** The little chevron that says a card leads to the full screen. */
function drillAction(label = 'Open') {
  return `<button class="btn btn-text btn-sm" data-drill>${h(label)}${icon('chevron_right', 'icon-sm')}</button>`;
}

/**
 * A chart panel, since six of them differ only in which metric they draw.
 *
 * The card leads to Insights pointed at the same chart, and each bar leads to the sheet for
 * that period, so nothing on the dashboard is a dead end.
 */
function chartPanel({
  data, app, options, metric, title, style,
}) {
  const series = data[seriesNeed(metric, options)];
  if (!series || series.status !== 'success' || series.empty) return '';

  const { granularity } = readSpan(options);
  const isPercent = series.unit === 'percent';
  const format = (value) => (isPercent ? formatPercent(value, 0) : money(app, value));
  const labels = series.buckets.map((key, i) => formatBucketLabel(key, granularity, i));
  const drawn = style === 'line'
    ? lineSeriesChart(labels, series.series, {
      format, keys: series.buckets, height: 150,
    })
    : barSeriesChart(labels, series.series, {
      format, keys: series.buckets, height: 150, stacked: series.stacked,
    });

  return card(title || series.label, `
    <div data-chart>${drawn}</div>
    ${series.series.length > 1 ? `<div style="margin-top:12px">${legend(series.series)}</div>` : ''}`, {
    action: drillAction(),
  });
}

/** Wires a chart panel: the card opens Insights, a bar opens that period. */
function bindChartPanel(node, app, options, metric) {
  const { granularity, periods } = readSpan(options);

  const drill = node.querySelector('[data-drill]');
  if (drill) {
    drill.addEventListener('click', () => {
      focusInsights({ metric, granularity, periods, offset: 0 });
      app.go('home', 'insights');
    });
  }

  bindChartSelect(node.querySelector('[data-chart]'), (bucket) => {
    openPeriodSheet(app, { granularity, bucket });
  });
}

/**
 * The catalogue.
 *
 * `needs` lists what the instance wants fetched, given its options. `render` draws it and
 * returns an empty string when there is nothing worth showing, which is how a fresh install
 * avoids a wall of empty cards.
 */
export const WIDGETS = {
  net_worth: {
    label: 'Net worth',
    description: 'Total assets minus liabilities',
    icon: 'account_balance_wallet',
    options: [
      {
        key: 'breakdown',
        label: 'Layout',
        default: 'assets_liabilities',
        choices: [
          { value: 'assets_liabilities', label: 'Assets vs Owed' },
          { value: 'detailed_grid', label: 'Detailed 4-box' },
          { value: 'asset_classes', label: 'By asset class' },
          { value: 'compact', label: 'Compact' },
        ],
      },
      {
        key: 'show_trend',
        label: 'Trend sparkline',
        default: 'no',
        choices: [
          { value: 'yes', label: 'Show' },
          { value: 'no', label: 'Hide' },
        ],
      },
      {
        key: 'show_delta',
        label: 'Monthly change',
        default: 'no',
        choices: [
          { value: 'yes', label: 'Show' },
          { value: 'no', label: 'Hide' },
        ],
      },
    ],
    needs: (options) => {
      const needs = ['summary'];
      if (options.show_trend === 'yes') needs.push(seriesNeed('net_worth_trend', { span: 'month:6' }));
      return needs;
    },
    pinned: true,
    render(data, app, options) {
      const { summary } = data;
      const breakdown = options.breakdown || 'assets_liabilities';
      const showDelta = options.show_delta === 'yes';
      const showTrend = options.show_trend === 'yes';

      // Delta: this month's income minus expenses, as a rough net worth change proxy.
      const thisMonth = summary.this_month || {};
      const delta = (thisMonth.income || 0) - (thisMonth.expense || 0) - (thisMonth.invested || 0);
      const deltaSign = delta >= 0 ? '+' : '';

      let breakdownHtml = '';
      if (breakdown === 'compact') {
        // Compact: just the headline number, no split.
        breakdownHtml = '';
      } else if (breakdown === 'detailed_grid') {
        // 4-box: Bank, Investments, Debts, Net Saved this month.
        const bank = Number(summary.asset_totals?.Bank || 0);
        const investments = Number(summary.asset_totals?.['Mutual Funds'] || 0)
          + Number(summary.asset_totals?.Demat || 0)
          + Number(summary.asset_totals?.NPS || 0);
        const debts = Number(summary.total_liabilities || 0);
        breakdownHtml = `
          <div class="balance-grid-4">
            <div class="balance-grid-item">
              <div class="caption" style="color:inherit;opacity:0.75">Cash</div>
              <div class="title numeric income">${h(money(app, bank))}</div>
            </div>
            <div class="balance-grid-item">
              <div class="caption" style="color:inherit;opacity:0.75">Invested</div>
              <div class="title numeric invested">${h(money(app, investments))}</div>
            </div>
            <div class="balance-grid-item">
              <div class="caption" style="color:inherit;opacity:0.75">Debts</div>
              <div class="title numeric expense">${h(money(app, debts))}</div>
            </div>
            <div class="balance-grid-item">
              <div class="caption" style="color:inherit;opacity:0.75">Net this month</div>
              <div class="title numeric ${delta >= 0 ? 'income' : 'expense'}">${h(money(app, Math.abs(delta)))}</div>
            </div>
          </div>`;
      } else if (breakdown === 'asset_classes') {
        const totals = summary.asset_totals || {};
        const classes = Object.entries(totals)
          .filter(([, v]) => Number(v) > 0)
          .sort(([, a], [, b]) => Number(b) - Number(a))
          .slice(0, 5);
        breakdownHtml = classes.length ? `
          <div class="balance-split" style="flex-wrap:wrap;gap:var(--gap-2) var(--gap-5)">
            ${classes.map(([name, value]) => `
              <div>
                <div class="caption" style="color:inherit;opacity:0.75">${h(name)}</div>
                <div class="title numeric">${h(money(app, Number(value)))}</div>
              </div>`).join('')}
          </div>` : '';
      } else {
        // Default: assets_liabilities
        breakdownHtml = `
          <div class="balance-split">
            <div>
              <div class="caption" style="color:inherit;opacity:0.75">Assets</div>
              <div class="title numeric">${h(money(app, summary.total_assets || 0))}</div>
            </div>
            <div>
              <div class="caption" style="color:inherit;opacity:0.75">Owed</div>
              <div class="title numeric">${h(money(app, summary.total_liabilities || 0))}</div>
            </div>
          </div>`;
      }

      // Sparkline from series data.
      let trendHtml = '';
      if (showTrend) {
        const series = data[seriesNeed('net_worth_trend', { span: 'month:6' })];
        if (series && series.status === 'success' && !series.empty && series.series?.[0]?.values?.length) {
          trendHtml = `<div class="balance-sparkline-row">${sparkline(series.series[0].values, { width: 120, height: 36 })}</div>`;
        }
      }

      return `
        <div class="balance-card">
          <div class="balance-card-header">
            <span class="overline" style="color:inherit;opacity:0.7">Net worth</span>
            ${showDelta ? `<span class="balance-delta">${h(deltaSign)}${h(money(app, Math.abs(delta)))}</span>` : ''}
          </div>
          <span class="balance-amount">${h(money(app, summary.net_worth || 0))}</span>
          ${trendHtml}
          ${breakdownHtml}
        </div>`;
    },
  },

  month_summary: {
    label: 'This period',
    description: 'Period spending, investments, and income',
    icon: 'calendar_month',
    options: [
      WINDOW_OPTION,
      {
        key: 'show_savings_rate',
        label: 'Savings rate',
        default: 'no',
        choices: [
          { value: 'yes', label: 'Show' },
          { value: 'no', label: 'Hide' },
        ],
      },
    ],
    needs: (options) => [periodNeed(options)],
    render(data, app, options) {
      const summary = data[periodNeed(options)];
      if (!summary || summary.status !== 'success') return '';
      // Two zeroes side by side say nothing a fresh install wanted to know.
      if (!summary.count && !summary.previous.count) return '';

      const window = options.window || 'month';
      const noun = { day: 'today', week: 'this week', month: 'this month' }[window];
      const showInvested = app.settings?.exclude_investments_from_expenses !== '0';
      const showRate = options.show_savings_rate === 'yes';

      const income = summary.income || 0;
      const expense = summary.expense || 0;
      const invested = summary.invested || 0;
      const saved = income - expense - (showInvested ? invested : 0);
      const rate = income > 0 ? (saved / income) * 100 : 0;

      return `
        <div class="${showInvested ? 'grid-3' : 'grid-2'}" data-period>
          <button type="button" class="stat stat-tappable" data-flow="spend">
            <div class="stat-header">
              <span class="stat-icon expense">${icon('north_east', 'icon-sm')}</span>
              <span class="caption">Spent ${h(noun)}</span>
            </div>
            <span class="stat-value expense">${h(money(app, expense))}</span>
            <span class="stat-change">${h(comparison(summary.change.expense))}</span>
          </button>
          ${showInvested ? `
            <button type="button" class="stat stat-tappable" data-flow="invest">
              <div class="stat-header">
                <span class="stat-icon invested">${icon('trending_up', 'icon-sm')}</span>
                <span class="caption">Invested</span>
              </div>
              <span class="stat-value invested">${h(money(app, invested))}</span>
              <span class="stat-change">${h(comparison(summary.change.invested))}</span>
            </button>` : ''}
          <button type="button" class="stat stat-tappable" data-flow="income">
            <div class="stat-header">
              <span class="stat-icon income">${icon('south_west', 'icon-sm')}</span>
              <span class="caption">Received</span>
            </div>
            <span class="stat-value income">${h(money(app, income))}</span>
            <span class="stat-change">${h(comparison(summary.change.income))}</span>
          </button>
        </div>
        ${showRate && income > 0 ? `
          <div class="card" style="margin-top:var(--gap-3);padding:var(--gap-3) var(--gap-4)">
            <div class="row-between">
              <span class="caption">Savings rate</span>
              <span class="title numeric ${rate >= 0 ? 'income' : 'expense'}">${h(formatPercent(rate))}</span>
            </div>
            <div class="progress" style="margin-top:8px">
              <div class="progress-bar ${rate < 0 ? 'over' : ''}" style="width:${Math.min(100, Math.max(0, rate))}%"></div>
            </div>
          </div>` : ''}`;
    },
    bind(node, data, app, options) {
      const summary = data[periodNeed(options)];
      if (!summary || summary.status !== 'success') return;
      node.querySelectorAll('.stat-tappable').forEach((stat) => {
        stat.addEventListener('click', () => openPeriodSheet(app, {
          granularity: summary.granularity,
          bucket: summary.bucket,
          flow: stat.dataset.flow || 'spend',
        }));
      });
    },
  },

  monthly_breakdown: {
    label: 'Monthly breakdown',
    description: 'Full month with savings rate and budget progress',
    icon: 'analytics',
    options: [WINDOW_OPTION],
    needs: (options) => [periodNeed(options), 'summary'],
    render(data, app, options) {
      const summary = data[periodNeed(options)];
      if (!summary || summary.status !== 'success') return '';
      if (!summary.count && !summary.previous.count) return '';

      const { summary: overall } = data;
      const income = summary.income || 0;
      const expense = summary.expense || 0;
      const invested = summary.invested || 0;
      const showInvested = app.settings?.exclude_investments_from_expenses !== '0';
      const saved = income - expense - (showInvested ? invested : 0);
      const rate = income > 0 ? (saved / income) * 100 : 0;
      const budget = Number(overall?.monthly_budget || 0);
      const budgetUsed = budget > 0 ? (expense / budget) * 100 : 0;
      const window = options.window || 'month';
      const noun = { day: 'Today', week: 'This week', month: 'This month' }[window];

      return card(noun, `
        <div class="grid-2" style="margin-bottom:12px">
          <div>
            <div class="caption">Income</div>
            <div class="title numeric income">${h(money(app, income))}</div>
          </div>
          <div>
            <div class="caption">Spent</div>
            <div class="title numeric expense">${h(money(app, expense))}</div>
          </div>
          ${showInvested ? `<div>
            <div class="caption">Invested</div>
            <div class="title numeric invested">${h(money(app, invested))}</div>
          </div>` : ''}
          <div>
            <div class="caption">Kept</div>
            <div class="title numeric ${saved >= 0 ? 'income' : 'expense'}">${h(money(app, saved))}</div>
          </div>
        </div>
        ${income > 0 ? `
          <div class="row-between" style="margin-bottom:4px">
            <span class="caption">Savings rate</span>
            <span class="caption numeric ${rate >= 0 ? 'income' : 'expense'}">${h(formatPercent(rate))}</span>
          </div>
          <div class="progress" style="margin-bottom:10px">
            <div class="progress-bar ${rate < 0 ? 'over' : ''}" style="width:${Math.min(100, Math.max(0, rate))}%"></div>
          </div>` : ''}
        ${budget > 0 ? `
          <div class="row-between" style="margin-bottom:4px">
            <span class="caption">Budget used</span>
            <span class="caption numeric ${budgetUsed > 100 ? 'expense' : ''}">${h(money(app, expense))} of ${h(money(app, budget))}</span>
          </div>
          <div class="progress">
            <div class="progress-bar ${budgetUsed > 100 ? 'over' : ''}" style="width:${Math.min(100, budgetUsed)}%"></div>
          </div>` : ''}`, { action: drillAction() });
    },
    bind(node, data, app, options) {
      const summary = data[periodNeed(options)];
      if (!summary || summary.status !== 'success') return;
      const drill = node.querySelector('[data-drill]');
      if (drill) {
        drill.addEventListener('click', () => openPeriodSheet(app, {
          granularity: summary.granularity,
          bucket: summary.bucket,
          flow: 'spend',
        }));
      }
    },
  },

  accounts_summary: {
    label: 'Accounts overview',
    description: 'Liquid cash vs credit card dues and loans',
    icon: 'account_balance',
    needs: () => ['summary'],
    render({ summary }, app) {
      const bank = Number(summary.asset_totals?.Bank || 0);
      const wallet = Number(summary.asset_totals?.Wallet || 0);
      const liabilities = Number(summary.total_liabilities || 0);
      if (!bank && !wallet && !liabilities) return '';

      const liquid = bank + wallet;

      return card('Accounts', `
        <div class="grid-2">
          <div>
            <div class="caption">Liquid cash</div>
            <div class="title numeric income">${h(money(app, liquid))}</div>
            ${bank ? `<div class="caption">Bank: ${h(money(app, bank))}</div>` : ''}
            ${wallet ? `<div class="caption">Wallet: ${h(money(app, wallet))}</div>` : ''}
          </div>
          <div>
            <div class="caption">Liabilities</div>
            <div class="title numeric expense">${h(money(app, liabilities))}</div>
          </div>
        </div>
        <div class="row-between" style="margin-top:12px;padding-top:10px;border-top:1px solid var(--outline-variant)">
          <span class="caption">Net liquid</span>
          <span class="title numeric ${liquid - liabilities >= 0 ? 'income' : 'expense'}">${h(money(app, liquid - liabilities))}</span>
        </div>`);
    },
  },

  investments_summary: {
    label: 'Portfolio snapshot',
    description: 'Investment totals by asset class',
    icon: 'monitoring',
    needs: () => ['investments'],
    render(data, app) {
      const inv = data.investments;
      if (!inv || !inv.holdings?.length) return '';

      const byClass = Object.entries(inv.by_class || {})
        .sort(([, a], [, b]) => Number(b.value) - Number(a.value));
      if (!byClass.length) return '';

      const { totals } = inv;

      return card('Portfolio', `
        <div class="title numeric" style="margin-bottom:10px">${h(money(app, totals.value || 0))}</div>
        ${byClass.map(([name, bucket]) => `
          <div class="row-between" style="margin-bottom:6px">
            <span class="caption">${h(name)}</span>
            <span class="caption numeric">${h(money(app, bucket.value))}</span>
          </div>`).join('')}
        ${totals.invested ? `
          <div class="row-between" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--outline-variant)">
            <span class="caption">Invested</span>
            <span class="caption numeric">${h(money(app, totals.invested))}</span>
          </div>
          <div class="row-between">
            <span class="caption">Returns</span>
            <span class="caption numeric ${totals.pnl >= 0 ? 'income' : 'expense'}">${h(money(app, totals.pnl))}</span>
          </div>` : ''}`, { action: drillAction('Details') });
    },
    bind(node, data, app) {
      const drill = node.querySelector('[data-drill]');
      if (drill) drill.addEventListener('click', () => app.open('investments'));
    },
  },

  category_card: {
    label: 'Category spotlight',
    description: 'Pin a category to the dashboard with trend',
    icon: 'bookmark',
    repeatable: true,
    options: [
      {
        key: 'category',
        label: 'Category',
        default: 'Groceries',
        choices: [
          'Groceries', 'Food & Dining', 'Shopping', 'Transport', 'Fuel',
          'Rent', 'Utilities', 'Entertainment', 'Health', 'Education',
          'Travel', 'Personal Care', 'Gifts & Charity', 'Bills', 'Investments',
          'Salary', 'Miscellaneous',
        ].map((value) => ({ value, label: value })),
      },
      SPAN_OPTION,
    ],
    needs: (options) => {
      const category = options.category || 'Groceries';
      const { granularity, periods } = readSpan(options);
      return [`series:spend_total:${granularity}:${periods}:${category}`, periodNeed({ window: 'month' })];
    },
    render(data, app, options) {
      const category = options.category || 'Groceries';
      const { granularity, periods } = readSpan(options);
      const seriesKey = `series:spend_total:${granularity}:${periods}:${category}`;
      const series = data[seriesKey];

      let values = [];
      if (series && series.status === 'success' && series.series?.[0]) {
        values = series.series[0].values || [];
      }

      if (!values.length || !values.some((v) => v > 0)) {
        return card(category, `
          <div class="row-between" style="margin-bottom:8px">
            <div>
              <div class="title numeric expense">${h(money(app, 0))}</div>
              <div class="caption">this period</div>
            </div>
            ${sparkline([0, 0], { width: 110, height: 36 })}
          </div>
          <div class="caption">No spending recorded in this period</div>`, { action: drillAction('View') });
      }

      const currentSpend = values[values.length - 1] || 0;
      const total = values.reduce((sum, v) => sum + v, 0);
      const avg = Math.round(total / values.length);

      return card(category, `
        <div class="row-between" style="margin-bottom:8px">
          <div>
            <div class="title numeric expense">${h(money(app, currentSpend))}</div>
            <div class="caption">this period</div>
          </div>
          ${sparkline(values, { width: 110, height: 36 })}
        </div>
        <div class="caption">${h(money(app, avg))} avg over ${values.length} ${granularity}s</div>`, { action: drillAction('View') });
    },
    bind(node, data, app, options) {
      const drill = node.querySelector('[data-drill]');
      if (drill) {
        drill.addEventListener('click', () => {
          app.ledgerFilter = 'all';
          app.ledgerSearch = options.category || 'Groceries';
          app.go('ledger');
        });
      }
    },
  },

  budget: {
    label: 'Budget',
    description: 'Monthly budget progress',
    icon: 'donut_small',
    needs: () => ['summary'],
    render({ summary }, app) {
      const budget = Number(summary.monthly_budget || 0);
      if (!budget) return '';

      const spent = Number(summary.this_month?.expense || 0);
      const used = (spent / budget) * 100;

      return card('Monthly budget', `
        <div class="row-between" style="margin-bottom:10px">
          <span class="title numeric">${h(money(app, spent))}</span>
          <span class="caption numeric">of ${h(money(app, budget))}</span>
        </div>
        <div class="progress">
          <div class="progress-bar ${used > 100 ? 'over' : ''}" style="width:${Math.min(100, used)}%"></div>
        </div>
        <div class="caption" style="margin-top:8px">
          ${used > 100
    ? `Over by ${h(money(app, spent - budget))}.`
    : `${h(money(app, budget - spent))} remaining.`}
        </div>`);
    },
  },

  income_expense: {
    label: 'Income & Expense',
    description: 'Income vs expense by period',
    icon: 'bar_chart',
    options: [SPAN_OPTION],
    needs: (options) => [seriesNeed('income_expense', options)],
    render(data, app, options) {
      return chartPanel({
        data, app, options, metric: 'income_expense', title: 'Income & Expense', style: 'bars',
      });
    },
    bind(node, data, app, options) {
      bindChartPanel(node, app, options, 'income_expense');
    },
  },

  spend_by_category: {
    label: 'Spending by category',
    description: 'Category breakdown by period',
    icon: 'stacked_bar_chart',
    options: [SPAN_OPTION],
    needs: (options) => [seriesNeed('spend_by_category', options)],
    render(data, app, options) {
      return chartPanel({
        data, app, options, metric: 'spend_by_category', title: 'Spending by category', style: 'bars',
      });
    },
    bind(node, data, app, options) {
      bindChartPanel(node, app, options, 'spend_by_category');
    },
  },

  spend_by_member: {
    label: 'Spending by person',
    description: 'Spending per household member',
    icon: 'group',
    needsFamily: true,
    options: [SPAN_OPTION],
    needs: (options) => [seriesNeed('spend_by_member', options)],
    render(data, app, options) {
      return chartPanel({
        data, app, options, metric: 'spend_by_member', title: 'Spending by person', style: 'bars',
      });
    },
    bind(node, data, app, options) {
      bindChartPanel(node, app, options, 'spend_by_member');
    },
  },

  cumulative_savings: {
    label: 'Running savings',
    description: 'Cumulative savings over time',
    icon: 'show_chart',
    options: [SPAN_OPTION],
    needs: (options) => [seriesNeed('cumulative_savings', options)],
    render(data, app, options) {
      const series = data[seriesNeed('cumulative_savings', options)];
      if (!series || series.status !== 'success' || series.empty) return '';
      const latest = series.series[0].values[series.series[0].values.length - 1];

      return card('Running savings', `
        <div class="title numeric ${latest >= 0 ? 'income' : 'expense'}" style="margin-bottom:8px">
          ${h(money(app, latest))}
        </div>
        <div data-chart>
          ${lineSeriesChart(
    series.buckets.map((key, i) => formatBucketLabel(key, readSpan(options).granularity, i)),
    series.series,
    { format: (value) => money(app, value), keys: series.buckets },
  )}
        </div>`, { action: drillAction() });
    },
    bind(node, data, app, options) {
      bindChartPanel(node, app, options, 'cumulative_savings');
    },
  },

  investment_growth: {
    label: 'Invested so far',
    description: 'Cumulative investment outflows',
    icon: 'trending_up',
    options: [SPAN_OPTION],
    needs: (options) => [seriesNeed('investment_growth', options)],
    render(data, app, options) {
      const series = data[seriesNeed('investment_growth', options)];
      if (!series || series.status !== 'success' || series.empty) return '';
      const latest = series.series[0].values[series.series[0].values.length - 1];

      return card('Invested so far', `
        <div class="title numeric" style="margin-bottom:8px">${h(money(app, latest))}</div>
        <div data-chart>
          ${lineSeriesChart(
    series.buckets.map((key, i) => formatBucketLabel(key, readSpan(options).granularity, i)),
    series.series,
    { format: (value) => money(app, value), keys: series.buckets },
  )}
        </div>`, { action: drillAction() });
    },
    bind(node, data, app, options) {
      bindChartPanel(node, app, options, 'investment_growth');
    },
  },

  /*
   * The panel with no fixed subject.
   *
   * Everything above it is a chart somebody thought was worth a name. This one is whichever
   * chart the user wants, added as many times as they like, which is the difference between
   * a dashboard you choose from and one you build.
   */
  custom_chart: {
    label: 'Custom chart',
    description: 'Configurable metric and period chart',
    icon: 'tune',
    repeatable: true,
    options: [METRIC_OPTION, SPAN_OPTION, STYLE_OPTION],
    needs: (options) => [seriesNeed(options.metric || METRIC_OPTION.default, options)],
    render(data, app, options) {
      const metric = options.metric || METRIC_OPTION.default;
      return chartPanel({
        data, app, options, metric, style: options.style || 'bars',
      });
    },
    bind(node, data, app, options) {
      bindChartPanel(node, app, options, options.metric || METRIC_OPTION.default);
    },
  },

  daily_calendar: {
    label: 'Day by day',
    description: 'Daily spending heatmap',
    icon: 'today',
    options: [FLOW_OPTION],
    needs: (options) => [breakdownNeed('day', { ...options, window: 'month' }), periodNeed({ window: 'month' })],
    render(data, app, options) {
      const breakdown = data[breakdownNeed('day', { ...options, window: 'month' })];
      const period = data[periodNeed({ window: 'month' })];
      if (!breakdown || breakdown.status !== 'success' || !breakdown.rows.length) return '';

      const totals = new Map(breakdown.rows.map((row) => [row.key, row.total]));
      const cells = [];
      const start = new Date(`${breakdown.from}T00:00:00`);
      const end = new Date(`${breakdown.to}T00:00:00`);
      for (let cursor = start; cursor < end; cursor.setDate(cursor.getDate() + 1)) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
        cells.push({ date: key, value: totals.get(key) || 0 });
      }

      return card(period && period.status === 'success'
        ? `${formatMonthKey(period.bucket)}, day by day`
        : 'Day by day', `
        <div data-calendar>
          ${heatCalendar(cells, { format: (value) => money(app, value) })}
        </div>
        <div class="row-between" style="margin-top:12px">
          <span class="caption">${h(money(app, breakdown.total))} in ${breakdown.rows.length} days</span>
          <span class="caption">${h(money(app, breakdown.total / breakdown.days))} a day</span>
        </div>`, { action: drillAction() });
    },
    bind(node, data, app, options) {
      bindChartSelect(node.querySelector('[data-calendar]'), (date) => {
        openPeriodSheet(app, { granularity: 'day', bucket: date, flow: options.flow || 'spend' });
      });
      const drill = node.querySelector('[data-drill]');
      if (drill) {
        drill.addEventListener('click', () => {
          focusInsights({
            flow: options.flow || 'spend', granularity: 'month', periods: 6, offset: 0,
          });
          app.go('home', 'insights');
        });
      }
    },
  },

  top_categories: {
    label: 'Top categories',
    description: 'Highest spending categories',
    icon: 'pie_chart',
    options: [WINDOW_OPTION, FLOW_OPTION, COUNT_OPTION],
    needs: (options) => [breakdownNeed('category', options)],
    render(data, app, options) {
      const breakdown = data[breakdownNeed('category', options)];
      if (!breakdown || breakdown.status !== 'success' || !breakdown.rows.length) return '';
      const count = Number.parseInt(options.count ?? COUNT_OPTION.default, 10) || 5;

      return card(`Top categories ${describePeriod(breakdown.bucket, breakdown.granularity)}`, `
        <div data-breakdown>
          ${barList(breakdown.rows.slice(0, count).map((row) => ({
    key: row.key,
    label: row.label,
    value: row.total,
    color: row.color,
    formatted: money(app, row.total),
    sub: `${row.count} ${row.count === 1 ? 'entry' : 'entries'} · ${row.share.toFixed(0)}%`,
  })), { selectable: true })}
        </div>`, { action: drillAction() });
    },
    bind(node, data, app, options) {
      const breakdown = data[breakdownNeed('category', options)];
      if (!breakdown || breakdown.status !== 'success') return;

      bindChartSelect(node.querySelector('[data-breakdown]'), (key) => {
        const row = breakdown.rows.find((entry) => entry.key === key);
        if (!row) return;
        openSliceSheet(app, {
          dimension: 'category',
          key: row.key,
          label: row.label,
          granularity: breakdown.granularity,
          bucket: breakdown.bucket,
          flow: options.flow || 'spend',
        });
      });

      const drill = node.querySelector('[data-drill]');
      if (drill) {
        drill.addEventListener('click', () => {
          focusInsights({
            flow: options.flow || 'spend',
            granularity: breakdown.granularity,
            dimension: 'category',
            offset: 0,
          });
          app.go('home', 'insights');
        });
      }
    },
  },

  category_donut: {
    label: 'Category split',
    description: 'Donut breakdown by category',
    icon: 'donut_small',
    options: [WINDOW_OPTION, FLOW_OPTION],
    needs: (options) => [breakdownNeed('category', options)],
    render(data, app, options) {
      const breakdown = data[breakdownNeed('category', options)];
      if (!breakdown || breakdown.status !== 'success' || !breakdown.rows.length) return '';
      const slices = breakdown.rows.slice(0, 7);

      return card(`Split of ${describePeriod(breakdown.bucket, breakdown.granularity)}`, `
        <div data-donut>
          ${donutChart(slices.map((row) => ({
    key: row.key,
    label: row.label,
    value: row.total,
    color: row.color,
    formatted: money(app, row.total),
  })), {
    centerLabel: 'Total',
    centerValue: money(app, breakdown.total),
    selectable: true,
  })}
        </div>`);
    },
    bind(node, data, app, options) {
      const breakdown = data[breakdownNeed('category', options)];
      if (!breakdown || breakdown.status !== 'success') return;
      bindChartSelect(node.querySelector('[data-donut]'), (key) => {
        const row = breakdown.rows.find((entry) => entry.key === key);
        if (!row) return;
        openSliceSheet(app, {
          dimension: 'category',
          key: row.key,
          label: row.label,
          granularity: breakdown.granularity,
          bucket: breakdown.bucket,
          flow: options.flow || 'spend',
        });
      });
    },
  },

  top_merchants: {
    label: 'Top merchants',
    description: 'Most visited shops and services',
    icon: 'storefront',
    options: [
      {
        key: 'months',
        label: 'Over',
        default: '3',
        choices: ['1', '3', '6', '12'].map((value) => ({ value, label: `${value} months` })),
      },
      COUNT_OPTION,
    ],
    needs: (options) => [`merchants:${options.months || '3'}`],
    render(data, app, options) {
      const merchants = data[`merchants:${options.months || '3'}`];
      const rows = merchants?.merchants || [];
      if (!rows.length) return '';
      const count = Number.parseInt(options.count ?? COUNT_OPTION.default, 10) || 5;

      return card('Top merchants', `
        <p class="caption" style="margin:-8px 0 14px">Last ${merchants.months} months</p>
        <div data-merchants>
          ${barList(rows.slice(0, count).map((m) => ({
    key: m.merchant,
    label: m.merchant,
    value: m.total,
    formatted: money(app, m.total),
    sub: `${m.times} ${m.times === 1 ? 'time' : 'times'}`,
  })), { selectable: true })}
        </div>`);
    },
    bind(node, data, app, options) {
      const months = Number.parseInt(options.months ?? 3, 10) || 3;
      bindChartSelect(node.querySelector('[data-merchants]'), (key) => {
        // The rows are totals over several months, so the list behind one has to cover the
        // same stretch. A month's worth under a three month figure would not add up.
        openTransactionsSheet(app, {
          title: key,
          subtitle: `Transactions for ${key} (last ${months} months)`,
          filters: { merchant: key, from: monthsBackStart(months), flow: 'spend' },
        });
      });
    },
  },

  savings_rate: {
    label: 'Savings rate',
    description: 'Share of income saved each period',
    icon: 'percent',
    options: [SPAN_OPTION],
    needs: (options) => [seriesNeed('savings_rate', options)],
    render(data, app, options) {
      const series = data[seriesNeed('savings_rate', options)];
      if (!series || series.status !== 'success' || series.empty) return '';
      const values = series.series[0].values;
      const latest = values[values.length - 1];
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;

      return card('Savings rate', `
        <div class="row-between">
          <span class="display ${latest >= 0 ? 'income' : 'expense'}" style="font-size:30px">
            ${h(formatPercent(latest))}
          </span>
          ${sparkline(values, { width: 110, height: 40 })}
        </div>
        <div class="caption" style="margin-top:8px">
          ${h(formatPercent(average))} average (last ${values.length} ${readSpan(options).granularity}s)
        </div>`, { action: drillAction() });
    },
    bind(node, data, app, options) {
      bindChartPanel(node, app, options, 'savings_rate');
    },
  },

  commitments: {
    label: 'Monthly commitments',
    description: 'SIPs, subscriptions and EMIs projected',
    icon: 'autorenew',
    options: [
      {
        key: 'months',
        label: 'Look ahead',
        default: '12',
        choices: ['6', '12', '24'].map((value) => ({ value, label: `${value} months` })),
      },
    ],
    needs: (options) => [`projection:${options.months || '12'}`],
    render(data, app, options) {
      const projection = data[`projection:${options.months || '12'}`];
      if (!projection || projection.status !== 'success' || !projection.series.length) return '';

      return card('Committed each month', `
        ${barSeriesChart(
    projection.buckets.map((key) => formatMonthKey(key).slice(0, 3)),
    projection.series,
    { stacked: true, format: (value) => money(app, value), height: 140 },
  )}
        <div style="margin-top:12px">${legend(projection.series)}</div>
        <div class="row-between" style="margin-top:12px">
          <span class="caption">${h(money(app, projection.first_month))} this month</span>
          <span class="caption ${projection.last_month > projection.first_month ? 'expense' : ''}">
            ${h(money(app, projection.last_month))} in ${projection.months} months
          </span>
        </div>`, { action: drillAction() });
    },
    bind(node, data, app) {
      const drill = node.querySelector('[data-drill]');
      if (drill) drill.addEventListener('click', () => app.open('recurring'));
    },
  },

  recurring_found: {
    label: 'Recurring detected',
    description: 'Detected subscriptions and SIPs',
    icon: 'query_stats',
    options: [
      {
        key: 'months',
        label: 'Scan',
        default: '15',
        choices: ['12', '15', '24'].map((value) => ({ value, label: `${value} months` })),
      },
    ],
    needs: (options) => [`recurring:${options.months || '15'}`],
    render(data, app, options) {
      const found = data[`recurring:${options.months || '15'}`];
      if (!found || found.status !== 'success') return '';

      const untracked = found.candidates.length;
      const moved = found.tracked.filter((entry) => entry.needs_update).length;
      if (!untracked && !moved) return '';

      return `
        <div class="banner" data-recurring>
          ${icon('autorenew')}
          <span class="banner-main">
            <span class="banner-title">
              ${untracked ? `${untracked} untracked recurring payment${untracked === 1 ? '' : 's'}` : `${moved} price change${moved === 1 ? '' : 's'}`}
            </span>
            <span class="banner-body">
              ${untracked ? `${h(money(app, found.yearly_untracked))}/yr untracked.` : ''}
              ${moved ? `${moved} plan${moved === 1 ? '' : 's'} price changed.` : ''}
            </span>
          </span>
          <button class="btn btn-tonal" data-open>Review</button>
        </div>`;
    },
    bind(node, data, app) {
      const button = node.querySelector('[data-open]');
      if (button) button.addEventListener('click', () => app.open('recurring'));
    },
  },

  upcoming: {
    label: 'Upcoming payments',
    description: 'SIPs, EMIs and renewals due soon',
    icon: 'event',
    options: [
      {
        key: 'days',
        label: 'Within',
        default: '30',
        choices: ['7', '14', '30', '60'].map((value) => ({ value, label: `${value} days` })),
      },
      COUNT_OPTION,
    ],
    needs: (options) => [`upcoming:${options.days || '30'}`],
    render(data, app, options) {
      const upcoming = data[`upcoming:${options.days || '30'}`];
      const count = Number.parseInt(options.count ?? COUNT_OPTION.default, 10) || 5;
      const items = (upcoming?.upcoming || []).slice(0, count);
      if (!items.length) return '';

      return `
        <div class="section">
          <div class="section-header">
            <span class="title">Coming up</span>
            <span class="caption numeric">
              ${h(money(app, upcoming.total || 0))} in ${options.days || '30'} days
            </span>
          </div>
          <div class="list">
            ${items.map((item) => `
              <div class="list-row">
                <span class="avatar avatar-sm" style="background:var(--surface-container-highest);color:var(--on-surface-variant)">
                  ${icon(UPCOMING_ICONS[item.kind] || 'event')}
                </span>
                <span class="list-row-main">
                  <span class="list-row-title">${h(item.title)}</span>
                  <span class="list-row-sub">${h(item.note)} · ${h(formatRelativeDate(item.date))}</span>
                </span>
                <span class="list-row-amount">${h(money(app, item.amount))}</span>
              </div>`).join('')}
          </div>
        </div>`;
    },
  },

  recent: {
    label: 'Recent transactions',
    description: 'Recent ledger entries',
    icon: 'receipt_long',
    options: [COUNT_OPTION],
    needs: () => ['summary', 'categories'],
    pinned: true,
    render({ summary, categories }, app, options) {
      const count = Number.parseInt(options.count ?? COUNT_OPTION.default, 10) || 5;
      const recent = (summary.recent_transactions || []).slice(0, count);
      const index = categoryIndex(categories || []);

      return `
        <div class="section" data-recent>
          <div class="section-header">
            <span class="title">Recent</span>
            ${recent.length ? '<button class="btn btn-text btn-sm" data-all>See all</button>' : ''}
          </div>
          ${recent.length
    ? `<div class="list">${recent.map((tx) => transactionRow(tx, app, index)).join('')}</div>`
    : `<div class="card">${emptyState('receipt_long', 'No transactions yet',
      'Tap Add to record your transactions.')}</div>`}
        </div>`;
    },
    bind(container, { summary }, app) {
      bindTransactionRows(container, app, summary.recent_transactions || []);
      const all = container.querySelector('[data-all]');
      if (all) all.addEventListener('click', () => app.go('ledger'));
    },
  },
};

/** The first day of the month `months - 1` back, which is where a "last N months" figure starts. */
function monthsBackStart(months) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
  return `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;
}

/** A change against the period before, in the few words a stat tile has room for. */
function comparison(percent) {
  if (percent === null || percent === undefined || !Number.isFinite(Number(percent))) {
    return 'nothing to compare';
  }
  const value = Number(percent);
  if (Math.abs(value) < 0.5) return 'level with last time';
  return `${formatDelta(Math.abs(value))} ${value > 0 ? 'more' : 'less'} than last time`;
}

/** What a brand new install sees. */
export const DEFAULT_LAYOUT = [
  'net_worth', 'month_summary', 'monthly_breakdown', 'budget', 'income_expense',
  'top_categories', 'upcoming', 'recurring_found', 'recent',
];

/** Widgets available given the current settings. */
export function availableWidgets(app) {
  return Object.entries(WIDGETS)
    .filter(([, widget]) => !widget.needsFamily || app.familyEnabled)
    .map(([id, widget]) => ({ id, ...widget }));
}

/** The defaults for one widget's options, so a fresh instance is fully specified. */
export function defaultOptions(id) {
  const widget = WIDGETS[id];
  if (!widget || !widget.options) return {};
  return Object.fromEntries(widget.options.map((option) => [option.key, option.default]));
}

/**
 * The saved layout, as instances.
 *
 * Accepts three shapes, because two of them are already in the wild: a list of widget
 * names, which is what earlier builds wrote, and a list of objects, which is what this one
 * writes. Anything naming a widget that no longer exists is dropped rather than blanking
 * the screen.
 */
export function readLayout(app) {
  let saved = [];
  try {
    const parsed = JSON.parse(app.settings.home_widgets || '[]');
    if (Array.isArray(parsed)) saved = parsed;
  } catch {
    // A corrupt layout should not blank the home screen.
  }

  const instances = saved
    .map((entry, index) => {
      const id = typeof entry === 'string' ? entry : entry?.id;
      const widget = WIDGETS[id];
      if (!widget) return null;
      if (widget.needsFamily && !app.familyEnabled) return null;
      return {
        id,
        uid: (typeof entry === 'object' && entry?.uid) || `${id}-${index}`,
        options: { ...defaultOptions(id), ...(typeof entry === 'object' ? entry.options : null) },
      };
    })
    .filter(Boolean);

  if (instances.length) return instances;

  return DEFAULT_LAYOUT
    .filter((id) => !WIDGETS[id].needsFamily || app.familyEnabled)
    .map((id, index) => ({ id, uid: `${id}-${index}`, options: defaultOptions(id) }));
}

export async function saveLayout(app, layout) {
  const payload = layout.map((entry) => ({
    id: entry.id, uid: entry.uid, options: entry.options,
  }));
  app.settings.home_widgets = JSON.stringify(payload);
  return app.db('update_setting', { key: 'home_widgets', value: app.settings.home_widgets });
}

/**
 * Fetches everything the given instances need, once each, in parallel.
 *
 * A need is a string, so two panels wanting six months of category spending produce one
 * key, one query and one reply they both read. That is what keeps a dashboard somebody has
 * filled with eight charts to the same handful of queries as the default four.
 */
export async function loadWidgetData(app, layout) {
  const needs = new Set();
  layout.forEach((entry) => {
    const widget = WIDGETS[entry.id];
    if (!widget) return;
    const declared = typeof widget.needs === 'function'
      ? widget.needs(entry.options || {})
      : widget.needs || [];
    declared.forEach((need) => needs.add(need));
  });

  const member = app.memberFilter;
  const entries = await Promise.all([...needs].map(async (need) => {
    const [kind, ...rest] = need.split(':');

    if (kind === 'summary') return [need, await Bridge.db('get_summary', { member_id: member })];
    if (kind === 'categories') {
      const res = await Bridge.db('get_categories');
      return [need, res.categories || []];
    }
    if (kind === 'upcoming') {
      return [need, await Bridge.db('get_upcoming', { days: Number(rest[0]) || 30, member_id: member })];
    }
    if (kind === 'merchants') {
      return [need, await Bridge.db('get_top_merchants', { months: Number(rest[0]) || 3, limit: 12, member_id: member })];
    }
    if (kind === 'series') {
      const [metric, granularity, periods, ...extra] = rest;
      const category = extra.length ? extra.join(':') : undefined;
      return [need, await Bridge.db('get_series', {
        metric, granularity, periods: Number(periods) || 6, category, member_id: member,
      })];
    }
    if (kind === 'period') {
      return [need, await Bridge.db('get_period_summary', {
        granularity: rest[0] || 'month', member_id: member,
      })];
    }
    if (kind === 'breakdown') {
      const [dimension, granularity, flow] = rest;
      return [need, await Bridge.db('get_breakdown', {
        dimension, granularity, flow, member_id: member,
      })];
    }
    if (kind === 'recurring') {
      return [need, await Bridge.db('find_recurring', {
        months: Number(rest[0]) || 15, member_id: member,
      })];
    }
    if (kind === 'projection') {
      return [need, await Bridge.db('project_commitments', {
        months: Number(rest[0]) || 12, member_id: member,
      })];
    }
    if (kind === 'investments') {
      return [need, await Bridge.db('list_investments', { member_id: member })];
    }
    return [need, null];
  }));

  return Object.fromEntries(entries);
}
