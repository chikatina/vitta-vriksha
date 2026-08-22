/* Every holding as a card, searchable and sortable. */

import { Bridge } from '../bridge.js';
import {
  icon, h, toast, sheet, emptyState, errorBlock, selectField, bindSelectFields,
  taxDisclaimerCard, pickFile, saveFile, showProgressModal,
} from '../ui.js';
import {
  formatBucketLabel, formatBucketTitle, formatCurrency, formatDate, describePeriod, todayISO,
} from '../formatters.js';
import {
  barSeriesChart, lineSeriesChart, donutChart, bindChartSelect, sparkline,
} from '../charts.js';
import { GRANULARITY_OPTIONS } from './drilldown.js';

/*
 * How the list can be ordered.
 *
 * A holding with no known cost sorts last on the money orderings rather than as zero: it
 * is not worth nothing, it is unknown, and letting it sit at the bottom of a profit sort
 * is closer to the truth than pretending it broke even.
 */
const SORTS = [
  { value: 'value', label: 'Value', numeric: true },
  { value: 'pnl', label: 'Profit', numeric: true, needsCost: true },
  { value: 'pnl_percent', label: 'Return %', numeric: true, needsCost: true },
  { value: 'name', label: 'Name', numeric: false },
  { value: 'asset_class', label: 'Class', numeric: false },
  { value: 'units', label: 'Units', numeric: true },
];

// Kept between renders so filing a cost comes back to the same place in the same order.
const view = {
  sort: 'value',
  ascending: false,
  assetClass: 'all',
  portfolio: 'all',
  query: '',
  // The allocation panel and the contribution chart, which have their own state because
  // they are read rather than searched.
  groupBy: 'asset_class',
  granularity: 'month',
  flowMetric: 'invest_flows',
};

/**
 * The three ways a portfolio is worth cutting up.
 *
 * Class answers "how much of this is equity", portfolio answers "which broker holds it",
 * and fund house answers "how exposed am I to one manager". They are the same holdings
 * grouped by a different column, so it is one panel with a chooser rather than three.
 */
const GROUPINGS = [
  { value: 'asset_class', label: 'Class' },
  { value: 'portfolio', label: 'Portfolio' },
  { value: 'amc', label: 'Fund house' },
];

/** What the movement chart can show. All of it comes from statement lines. */
const FLOW_CHARTS = [
  { metric: 'invest_flows', label: 'Bought and sold', type: 'bars' },
  { metric: 'invest_by_scheme', label: 'By scheme', type: 'bars' },
  { metric: 'invest_cumulative', label: 'Net put in', type: 'line' },
];

const GROUP_PALETTE = ['#3B82F6', '#8B5CF6', '#14B8A6', '#F59E0B', '#EC4899', '#06B6D4', '#64748B'];

function compare(a, b, key, ascending) {
  const column = SORTS.find((s) => s.value === key);
  if (column?.needsCost) {
    if (!a.has_cost && !b.has_cost) return 0;
    if (!a.has_cost) return 1;
    if (!b.has_cost) return -1;
  }
  const result = column?.numeric
    ? Number(a[key]) - Number(b[key])
    : String(a[key]).localeCompare(String(b[key]));
  return ascending ? result : -result;
}

function units(value) {
  // Units run from three whole shares to a fund balance with four decimals, and trailing
  // zeroes on the first case are noise.
  const number = Number(value) || 0;
  return Number.isInteger(number) ? String(number) : number.toFixed(3);
}

/** Everything a search should look through, including what is not on the card. */
function haystack(holding) {
  return `${holding.name} ${holding.asset_class} ${holding.portfolio} ${holding.amc} `
    + `${holding.symbol} ${holding.isin} ${holding.account}`.toLowerCase();
}

export async function renderInvestments(container, app) {
  const res = await Bridge.db('list_investments', { member_id: app.memberFilter });

  const all = res.holdings || [];
  const totals = res.totals || { value: 0, invested: 0, pnl: 0, pnl_percent: 0, unpriced: 0 };
  const byClass = res.by_class || {};
  const portfolios = res.portfolios || [];
  const classes = Object.keys(byClass).sort();

  container.innerHTML = `
    <div class="card">
      <div class="caption">Total value</div>
      <div class="display">${h(formatCurrency(totals.value, app.currency, app.locale))}</div>
      ${totals.invested > 0 ? `
        <div class="row-between" style="margin-top:10px">
          <span class="caption">Invested ${h(formatCurrency(totals.invested, app.currency, app.locale))}</span>
          <span class="${totals.pnl >= 0 ? 'holdings-gain' : 'holdings-loss'}">
            ${totals.pnl >= 0 ? '+' : ''}${h(formatCurrency(totals.pnl, app.currency, app.locale))}
            (${totals.pnl >= 0 ? '+' : ''}${totals.pnl_percent.toFixed(1)}%)
          </span>
        </div>` : ''}
      ${totals.unpriced ? `
        <div class="caption" style="margin-top:8px">
          ${totals.unpriced} ${totals.unpriced === 1 ? 'holding has' : 'holdings have'} no buy price recorded. Tap to enter cost.
        </div>` : ''}
      <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn btn-sm btn-filled" data-record-trade style="font-size:12px;padding:6px 12px">
          ${icon('add', 'icon-sm')} Record Trade
        </button>
        <button class="btn btn-sm btn-tonal" data-import-csv style="font-size:12px;padding:6px 12px">
          ${icon('upload_file', 'icon-sm')} Import CSV
        </button>
        <button class="btn btn-sm btn-outlined" data-open-tax style="font-size:12px;padding:6px 12px">
          ${icon('receipt_long', 'icon-sm')} Tax &amp; Capital Gains
        </button>
      </div>
    </div>

    ${all.length ? '<div data-allocation></div>' : ''}
    <div data-flows></div>

    ${all.length ? `
      <div class="section">
        <div class="section-header"><span class="title">Holdings</span></div>
        <div class="holdings-controls">
          <div class="field holdings-search">
            <label class="field-label" for="holdingSearch">Search</label>
            <input class="input" id="holdingSearch" data-search type="search" autocomplete="off"
                   placeholder="Name, class, portfolio or ISIN" value="${h(view.query)}">
          </div>
          ${selectField({
    key: 'sort',
    label: 'Sort by',
    id: 'holdingSort',
    value: view.sort,
    options: SORTS.map((s) => ({ value: s.value, label: s.label })),
  })}
          <button class="icon-button" data-direction
                  aria-label="${view.ascending ? 'Sort descending' : 'Sort ascending'}">
            ${icon(view.ascending ? 'expand_less' : 'expand_more')}
          </button>
        </div>

        <div class="chip-scroller review-filters" data-classes>
          <button type="button" class="chip" data-class="all"
                  aria-selected="${view.assetClass === 'all'}">All ${all.length}</button>
          ${classes.map((name) => `
            <button type="button" class="chip" data-class="${h(name)}"
                    aria-selected="${view.assetClass === name}">${h(name)} ${byClass[name].count}</button>`).join('')}
        </div>

        ${portfolios.length > 1 ? `
          <div class="card">
            ${selectField({
    key: 'portfolio',
    label: 'Portfolio',
    id: 'portfolioFilter',
    value: view.portfolio,
    options: [{ value: 'all', label: 'Every portfolio' },
      ...portfolios.map((name) => ({ value: name, label: name }))],
  })}
          </div>` : ''}

        <div data-list></div>
      </div>`
    : `<div class="card">
         ${emptyState('savings', 'Nothing here yet',
    'Import a statement under CAS to populate holdings.')}
       </div>`}`;

  bindSelectFields(container);

  const allocationHost = container.querySelector('[data-allocation]');
  if (allocationHost) paintAllocation(allocationHost, app, all);
  paintFlows(container.querySelector('[data-flows]'), app);

  const listHost = container.querySelector('[data-list]');

  /*
   * Only the list is repainted when a control changes. Rebuilding the whole screen would
   * throw away the search box the user is typing into, taking the keyboard and the caret
   * with it.
   */
  const paintList = () => {
    if (!listHost) return;
    const query = view.query.trim().toLowerCase();
    const shown = all
      .filter((row) => view.assetClass === 'all' || row.asset_class === view.assetClass)
      .filter((row) => view.portfolio === 'all' || row.portfolio === view.portfolio)
      .filter((row) => !query || haystack(row).includes(query))
      .sort((a, b) => compare(a, b, view.sort, view.ascending));

    const total = shown.reduce((sum, row) => sum + row.value, 0);

    listHost.innerHTML = `
      <div class="row-between" style="margin-bottom:10px">
        <span class="caption">${shown.length} of ${all.length}</span>
        <span class="caption">${h(formatCurrency(total, app.currency, app.locale))}</span>
      </div>
      ${shown.length ? shown.map((holding, index) => `
        <button class="holding-card" data-holding="${index}">
          <span class="holding-top">
            <span class="holding-name">${h(holding.name)}</span>
            <span class="holding-value">${h(formatCurrency(holding.value, app.currency, app.locale))}</span>
          </span>
          <span class="holding-meta">
            <span class="holding-sub">
              ${h(holding.asset_class)} · ${h(holding.portfolio)}
            </span>
            <span class="holding-pnl ${holding.has_cost ? (holding.pnl >= 0 ? 'holdings-gain' : 'holdings-loss') : 'holdings-unknown'}">
              ${holding.has_cost
    ? `${holding.pnl >= 0 ? '+' : ''}${h(formatCurrency(holding.pnl, app.currency, app.locale))}`
      + ` (${holding.pnl >= 0 ? '+' : ''}${holding.pnl_percent.toFixed(1)}%)`
    : 'Cost unknown'}
            </span>
          </span>
          <span class="holding-meta">
            <span class="holding-sub">
              ${units(holding.units)} units at ${h(formatCurrency(holding.nav, app.currency, app.locale))}
            </span>
            <span class="holding-sub">
              ${holding.has_cost
    ? `Invested ${h(formatCurrency(holding.invested, app.currency, app.locale))}`
    : 'Tap to add cost'}
            </span>
          </span>
        </button>`).join('')
    : `<div class="card"><div class="caption">Nothing matches that.</div></div>`}`;

    listHost.querySelectorAll('[data-holding]').forEach((card) => {
      card.addEventListener('click', () => editCost(container, app, shown[Number(card.dataset.holding)]));
    });
  };

  const search = container.querySelector('[data-search]');
  if (search) {
    search.addEventListener('input', () => {
      view.query = search.value;
      paintList();
    });
  }

  const sortField = container.querySelector('#holdingSort');
  if (sortField) {
    sortField.addEventListener('change', () => {
      view.sort = sortField.value;
      // A new ordering starts largest first for money and A to Z for words, which is what
      // people expect without having to think about it.
      view.ascending = !SORTS.find((s) => s.value === view.sort)?.numeric;
      paintList();
      // Redrawn through icon(), which maps a name to the codepoint the subsetted font
      // actually carries. Writing the name straight into the element prints the name.
      const arrow = container.querySelector('[data-direction]');
      if (arrow) arrow.innerHTML = icon(view.ascending ? 'expand_less' : 'expand_more');
    });
  }

  const direction = container.querySelector('[data-direction]');
  if (direction) {
    direction.addEventListener('click', () => {
      view.ascending = !view.ascending;
      direction.innerHTML = icon(view.ascending ? 'expand_less' : 'expand_more');
      direction.setAttribute('aria-label', view.ascending ? 'Sort descending' : 'Sort ascending');
      paintList();
    });
  }

  container.querySelectorAll('[data-class]').forEach((chip) => {
    chip.addEventListener('click', () => {
      view.assetClass = chip.dataset.class;
      container.querySelectorAll('[data-class]').forEach((other) => {
        other.setAttribute('aria-selected', String(other.dataset.class === view.assetClass));
      });
      paintList();
    });
  });

    const portfolioField = container.querySelector('#portfolioFilter');
    if (portfolioField) {
      portfolioField.addEventListener('change', () => {
        view.portfolio = portfolioField.value;
        paintList();
      });
    }

    const recordBtn = container.querySelector('[data-record-trade]');
    if (recordBtn) recordBtn.addEventListener('click', () => openRecordTradeModal(container, app));

    const importBtn = container.querySelector('[data-import-csv]');
    if (importBtn) importBtn.addEventListener('click', () => openImportCsvModal(container, app));

    const taxBtn = container.querySelector('[data-open-tax]');
    if (taxBtn) taxBtn.addEventListener('click', () => openCapitalGainsModal(container, app));

  paintList();
}

/* ---------------------------------------------------------- allocation panel */

/**
 * The holdings grouped by one column, with the totals each group comes to.
 *
 * Worked out here rather than asked for, because the holdings are already in the page: a
 * round trip to group rows the view is holding would be slower and could disagree with the
 * list below it.
 */
function groupHoldings(holdings, key) {
  const groups = new Map();

  for (const holding of holdings) {
    const name = String(holding[key] || '').trim()
      || (key === 'amc' ? 'Not stated' : 'Other');
    const entry = groups.get(name) || {
      name, value: 0, invested: 0, pnl: 0, count: 0, holdings: [],
    };
    entry.value += holding.value;
    entry.count += 1;
    // Only value with a known cost behind it can be compared with that cost.
    if (holding.has_cost) {
      entry.invested += holding.invested;
      entry.pnl += holding.pnl;
    }
    entry.holdings.push(holding);
    groups.set(name, entry);
  }

  return [...groups.values()]
    .sort((a, b) => b.value - a.value)
    .map((group, index) => ({
      ...group,
      color: GROUP_PALETTE[index % GROUP_PALETTE.length],
      pnl_percent: group.invested > 0 ? (group.pnl / group.invested) * 100 : 0,
    }));
}

function paintAllocation(host, app, holdings) {
  const money = (value) => formatCurrency(value, app.currency, app.locale);
  const groups = groupHoldings(holdings, view.groupBy);
  const total = groups.reduce((sum, group) => sum + group.value, 0);

  host.innerHTML = `
    <div class="card">
      <div class="card-title"><span>Allocation</span></div>

      <div class="segmented segmented-sm" data-groupings>
        ${GROUPINGS.map((entry) => `
          <button type="button" data-grouping="${entry.value}"
                  aria-selected="${entry.value === view.groupBy}">${h(entry.label)}</button>`).join('')}
      </div>

      <div data-donut style="margin-top:16px">
        ${donutChart(groups.map((group) => ({
    key: group.name,
    label: group.name,
    value: group.value,
    color: group.color,
    formatted: money(group.value),
  })), { centerLabel: 'Total', centerValue: money(total), selectable: true })}
      </div>

      <div class="list" data-groups style="margin-top:16px">
        ${groups.map((group) => `
          <button class="list-row" data-group="${h(group.name)}">
            <span class="legend-dot" style="background:${h(group.color)};width:12px;height:12px"></span>
            <span class="list-row-main">
              <span class="list-row-title">${h(group.name)}</span>
              <span class="list-row-sub">
                ${group.count} ${group.count === 1 ? 'holding' : 'holdings'} ·
                ${total > 0 ? ((group.value / total) * 100).toFixed(0) : 0}%
              </span>
            </span>
            <span class="list-row-trailing">
              <span class="list-row-amount">${h(money(group.value))}</span>
              ${group.invested > 0 ? `
                <span class="list-row-sub ${group.pnl >= 0 ? 'holdings-gain' : 'holdings-loss'}">
                  ${group.pnl >= 0 ? '+' : ''}${group.pnl_percent.toFixed(1)}%
                </span>` : ''}
            </span>
          </button>`).join('')}
      </div>
    </div>`;

  host.querySelectorAll('[data-grouping]').forEach((button) => {
    button.addEventListener('click', () => {
      view.groupBy = button.dataset.grouping;
      paintAllocation(host, app, holdings);
    });
  });

  const open = (name) => {
    const group = groups.find((entry) => entry.name === name);
    if (group) openGroupSheet(app, group);
  };

  bindChartSelect(host.querySelector('[data-donut]'), open);
  host.querySelectorAll('[data-group]').forEach((row) => {
    row.addEventListener('click', () => open(row.dataset.group));
  });
}

/** What is inside one slice of the allocation. */
async function openGroupSheet(app, group) {
  const money = (value) => formatCurrency(value, app.currency, app.locale);
  const ranked = [...group.holdings].sort((a, b) => b.value - a.value);

  const chosen = await sheet(group.name, `
    <div class="card-flat">
      <div class="row-between">
        <span class="caption">Value</span>
        <span class="title">${h(money(group.value))}</span>
      </div>
      ${group.invested > 0 ? `
        <div class="row-between" style="margin-top:6px">
          <span class="caption">Invested ${h(money(group.invested))}</span>
          <span class="${group.pnl >= 0 ? 'holdings-gain' : 'holdings-loss'}">
            ${group.pnl >= 0 ? '+' : ''}${h(money(group.pnl))} (${group.pnl_percent.toFixed(1)}%)
          </span>
        </div>` : ''}
    </div>

    <div class="list">
      ${ranked.map((holding, index) => `
        <button class="list-row" data-holding="${index}">
          <span class="list-row-main">
            <span class="list-row-title">${h(holding.name)}</span>
            <span class="list-row-sub">
              ${units(holding.units)} units · ${h(holding.portfolio)}
            </span>
          </span>
          <span class="list-row-trailing">
            <span class="list-row-amount">${h(money(holding.value))}</span>
            <span class="list-row-sub ${holding.has_cost ? (holding.pnl >= 0 ? 'holdings-gain' : 'holdings-loss') : ''}">
              ${holding.has_cost ? `${holding.pnl >= 0 ? '+' : ''}${holding.pnl_percent.toFixed(1)}%` : 'cost unknown'}
            </span>
          </span>
        </button>`).join('')}
    </div>`, {
    autofocus: false,
    onMount(node, close) {
      node.querySelectorAll('[data-holding]').forEach((row) => {
        row.addEventListener('click', () => close(ranked[Number(row.dataset.holding)]));
      });
    },
  });

  if (chosen) await editCost(document.getElementById('view'), app, chosen);
}

/* ------------------------------------------------------- contribution panel */

/**
 * What went into the portfolio over time, and out of it.
 *
 * Drawn from statement lines rather than from the holdings, because a holding knows only
 * what it is worth today. That means the panel is empty until somebody imports a detailed
 * registrar statement, which is worth saying plainly rather than showing an empty chart.
 */
async function paintFlows(host, app) {
  const money = (value) => formatCurrency(value, app.currency, app.locale);
  const chart = FLOW_CHARTS.find((entry) => entry.metric === view.flowMetric) || FLOW_CHARTS[0];

  const series = await Bridge.db('get_series', {
    metric: chart.metric,
    granularity: view.granularity,
    member_id: app.memberFilter,
  });

  if (series.status !== 'success' || series.empty) {
    host.innerHTML = `
      <div class="card">
        <div class="card-title"><span>Money in and out of funds</span></div>
        ${emptyState('query_stats', 'No statement history yet',
    'A summary statement says what you hold today and nothing about how it got there. Import '
    + 'a detailed CAMS or KFintech statement and every purchase and redemption is charted here.')}
      </div>`;
    return;
  }

  const buckets = series.buckets;
  const labels = buckets.map((key, i) => formatBucketLabel(key, view.granularity, i));

  host.innerHTML = `
    <div class="card">
      <div class="card-title">
        <span>Money in and out of funds</span>
        <span class="caption">${h(money(series.totals.bought ?? series.totals.net_invested ?? 0))}</span>
      </div>

      <div class="insight-controls">
        <div class="segmented segmented-sm" data-grains>
          ${GRANULARITY_OPTIONS.map((option) => `
            <button type="button" data-grain="${option.value}"
                    aria-selected="${option.value === view.granularity}">${h(option.label)}</button>`).join('')}
        </div>
      </div>

      <div class="chip-scroller" data-charts>
        ${FLOW_CHARTS.map((entry) => `
          <button type="button" class="chip" data-flow-chart="${entry.metric}"
                  aria-selected="${entry.metric === view.flowMetric}">${h(entry.label)}</button>`).join('')}
      </div>

      <div data-flow-chart-host style="margin-top:14px">
        ${chart.type === 'line'
    ? lineSeriesChart(labels, series.series, { format: money, keys: buckets, height: 160 })
    : barSeriesChart(labels, series.series, {
      format: money, keys: buckets, height: 160, stacked: series.stacked,
    })}
      </div>

      <p class="caption" style="margin-top:10px">Tap a period to see the statement lines behind it.</p>
    </div>`;

  host.querySelectorAll('[data-grain]').forEach((button) => {
    button.addEventListener('click', () => {
      view.granularity = button.dataset.grain;
      paintFlows(host, app);
    });
  });

  host.querySelectorAll('[data-flow-chart]').forEach((button) => {
    button.addEventListener('click', () => {
      view.flowMetric = button.dataset.flowChart;
      paintFlows(host, app);
    });
  });

  bindChartSelect(host.querySelector('[data-flow-chart-host]'), (key) => {
    openFolioPeriodSheet(app, key, view.granularity);
  });
}

/** The statement lines behind one bar of the contribution chart. */
async function openFolioPeriodSheet(app, bucket, granularity) {
  const money = (value) => formatCurrency(value, app.currency, app.locale);

  const title = formatBucketTitle(bucket, granularity);

  // The range comes from the backend rather than being worked out here, so a week means the
  // same thing in the sheet as it did in the chart. Without it there is nothing to query
  // for, and querying without a range would list every line ever imported.
  const range = await Bridge.db('get_breakdown', {
    dimension: 'day', granularity, bucket, flow: 'invest',
  });
  if (range.status !== 'success') {
    await sheet(title, errorBlock(range), { autofocus: false });
    return;
  }

  const lines = await Bridge.db('get_folio_transactions', {
    from: range.from, to: range.to, member_id: app.memberFilter,
  });

  if (lines.status !== 'success' || !lines.count) {
    await sheet(title, `
      <div class="card-flat">${emptyState('receipt_long', 'Nothing in this period',
    `No purchases or redemptions were recorded in ${describePeriod(bucket, granularity)}.`)}</div>`,
    { autofocus: false });
    return;
  }

  await sheet(title, `
    <div class="grid-2">
      <div class="stat">
        <span class="caption">Bought</span>
        <span class="stat-value">${h(money(lines.bought))}</span>
      </div>
      <div class="stat">
        <span class="caption">Sold</span>
        <span class="stat-value ${lines.sold ? 'expense' : ''}">${h(money(lines.sold))}</span>
      </div>
    </div>

    ${lines.schemes.length > 1 ? `
      <div class="section-header" style="margin-top:14px"><span class="title">By scheme</span></div>
      <div class="list">
        ${lines.schemes.map((scheme) => `
          <div class="list-row">
            <span class="list-row-main"><span class="list-row-title">${h(scheme.name)}</span></span>
            <span class="list-row-amount ${scheme.total < 0 ? 'holdings-loss' : ''}">
              ${h(money(Math.abs(scheme.total)))}
            </span>
          </div>`).join('')}
      </div>` : ''}

    <div class="section-header" style="margin-top:14px">
      <span class="title">Every line</span>
      <span class="caption">${lines.count}${lines.capped ? '+' : ''}</span>
    </div>
    <div class="list">
      ${lines.transactions.map((line) => `
        <div class="list-row">
          <span class="list-row-main">
            <span class="list-row-title">${h(line.scheme_name || line.isin || 'Movement')}</span>
            <span class="list-row-sub">
              ${h(formatDate(line.date))}${line.description ? ` · ${h(line.description)}` : ''}
            </span>
          </span>
          <span class="list-row-trailing">
            <span class="list-row-amount ${Number(line.amount) < 0 ? 'holdings-loss' : ''}">
              ${h(money(Math.abs(Number(line.amount))))}
            </span>
            <span class="list-row-sub">${units(line.units)} units</span>
          </span>
        </div>`).join('')}
    </div>`, { autofocus: false });
}

/**
 * Records what a holding cost.
 *
 * This is the only number on the card nobody can import for a share: a depository prints
 * today's value and says nothing about what was paid for it.
 */
/**
 * The running total a holding's own lines add up to, oldest first.
 *
 * The history arrives newest first, because that is the order a list wants to read it in.
 * A curve read in that order would show a holding being sold down to nothing.
 */
function cumulative(lines) {
  let running = 0;
  return [...lines].reverse().map((line) => {
    running += Number(line.amount) || 0;
    return running;
  });
}

/* One labelled figure in the detail sheet. */
function fact(label, value, className = '') {
  return `
    <div class="fact">
      <span class="fact-label">${h(label)}</span>
      <span class="fact-value ${className}">${value}</span>
    </div>`;
}

function holdingHistoryChart(lines, money) {
  const sorted = [...lines].reverse();
  let running = 0;
  const points = sorted.map((l) => {
    running += Number(l.amount) || 0;
    return { date: l.date, value: running, nav: l.nav, units: l.units };
  });

  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const width = 320;
  const height = 130;
  const padding = 14;
  const chartW = width - padding * 2;
  const chartH = height - padding * 2;

  const x = (i) => padding + (i / Math.max(points.length - 1, 1)) * chartW;
  const y = (val) => height - padding - ((val - min) / span) * chartH;

  const polyPoints = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const areaPath = `M ${x(0).toFixed(1)},${height - padding} `
    + `L ${polyPoints.split(' ').join(' L ')} `
    + `L ${x(points.length - 1).toFixed(1)},${height - padding} Z`;

  return `
    <div style="background:var(--surface-container-high);border-radius:var(--radius);padding:12px;margin-top:8px">
      <div class="row-between" style="font-size:11px;color:var(--on-surface-variant);margin-bottom:6px">
        <span>${h(points[0].date)} · ${money(points[0].value)}</span>
        <span>${h(points[points.length - 1].date)} · ${money(points[points.length - 1].value)}</span>
      </div>
      <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" style="overflow:visible;display:block">
        <defs>
          <linearGradient id="holdingGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.3" />
            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.0" />
          </linearGradient>
        </defs>
        <path d="${areaPath}" fill="url(#holdingGrad)" />
        <polyline points="${polyPoints}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        ${points.map((p, i) => `
          <circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3" fill="var(--accent)" />
        `).join('')}
      </svg>
    </div>`;
}

async function editCost(container, app, holding) {
  if (!holding) return;

  const money = (value) => h(formatCurrency(value, app.currency, app.locale));
  const gained = holding.pnl >= 0;
  const history = await Bridge.db('get_holding_detail', {
    isin: holding.isin, folio_number: holding.account, member_id: app.memberFilter,
  });
  const lines = history.transactions || [];
  const chartHtml = lines.length >= 2 ? holdingHistoryChart(lines, money) : '';

  const saved = await sheet(holding.name, `
    <!-- Top Summary Card with Editable Cost -->
    <div class="card-flat" style="background:var(--surface-container-high);padding:14px;border-radius:var(--radius);margin-bottom:12px">
      <div class="row-between">
        <div>
          <span class="caption" style="font-size:11px">Current Value</span>
          <div class="title numeric" style="font-size:18px;font-weight:700">${money(holding.value)}</div>
        </div>
        <div style="text-align:right">
          <span class="caption" style="font-size:11px">Unrealised Profit</span>
          <div class="title numeric ${holding.has_cost ? (gained ? 'holdings-gain' : 'holdings-loss') : 'holdings-unknown'}" style="font-size:15px;font-weight:700">
            ${holding.has_cost
    ? `${gained ? '+' : ''}${money(holding.pnl)} (${gained ? '+' : ''}${holding.pnl_percent.toFixed(2)}%)`
    : 'Cost unknown'}
          </div>
        </div>
      </div>

      <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--outline)">
        <div class="row-between" style="align-items:center">
          <label class="field-label" for="holdingCost" style="padding-left:0;margin-bottom:0;font-size:12px;font-weight:600">Total Invested Amount</label>
          <span class="caption" style="font-size:11px">
            ${history.invested_from_history > 0 ? `From history: ${money(history.invested_from_history)}` : 'Editable'}
          </span>
        </div>
        <div class="row" style="gap:8px;margin-top:6px;align-items:center">
          <input class="input numeric" id="holdingCost" data-cost type="number" step="0.01" inputmode="decimal"
                 value="${holding.has_cost ? holding.invested : (history.invested_from_history || '')}" placeholder="0.00" style="flex:1">
          <button class="btn btn-filled btn-sm" data-quick-save style="padding:6px 14px;flex-shrink:0">Save</button>
        </div>
      </div>
    </div>

    <!-- Details Fact Grid -->
    <div class="fact-grid">
      ${fact('Units', units(holding.units))}
      ${fact('NAV', money(holding.nav))}
      ${fact('Invested', holding.has_cost ? money(holding.invested) : '-')}
      ${fact('Average cost', history.average_cost > 0 ? money(history.average_cost) : '-')}
      ${fact('Class', h(holding.asset_class))}
      ${fact('Portfolio', h(holding.portfolio))}
      ${holding.amc ? fact('Fund house', h(holding.amc)) : ''}
      ${holding.account ? fact('Folio / Account', h(holding.account)) : ''}
      ${holding.isin ? fact('ISIN', h(holding.isin)) : ''}
      ${holding.symbol ? fact('Symbol', h(holding.symbol)) : ''}
      ${fact('Valued as of', h(holding.last_updated || '-'))}
    </div>

    ${history.active_tax_lots && history.active_tax_lots.length ? `
      <div class="section-header" style="margin-top:16px"><span class="title">Active Tax Lots (${history.active_tax_lots.length})</span></div>
      <div class="list" style="margin-top:6px">
        ${history.active_tax_lots.map((lot) => `
          <div class="list-row" style="align-items:center">
            <span class="list-row-main">
              <span class="list-row-title">${units(lot.remainingUnits)} units @ ${money(lot.buyPrice)}</span>
              <span class="list-row-sub">Bought ${h(lot.buyDate)} · Held ${lot.daysHeld} days</span>
            </span>
            <span style="text-align:right">
              <span class="badge" style="${lot.isLtcg ? 'background:var(--accent-container);color:var(--on-accent-container)' : 'background:var(--surface-container-highest);color:var(--on-surface-variant)'};font-size:11px;font-weight:700;padding:2px 8px;border-radius:var(--radius-full)">
                ${lot.isLtcg ? `LTCG (${lot.daysHeld}d)` : `STCG (LTCG in ${lot.daysToLtcg}d)`}
              </span>
            </span>
          </div>`).join('')}
      </div>
      ${taxDisclaimerCard({ compact: true })}
    ` : ''}

    <!-- History Header with Interactive Cards/Chart Toggle -->
    <div class="row-between" style="margin-top:16px;align-items:center">
      <div class="section-header" style="margin:0"><span class="title">History (${lines.length})</span></div>
      ${lines.length >= 2 ? `
        <div class="row" style="background:var(--surface-container-high);border-radius:var(--radius-full);padding:2px;gap:2px">
          <button type="button" class="btn btn-sm btn-text" data-tab-history="cards" style="padding:3px 10px;border-radius:var(--radius-full);font-size:11.5px;background:var(--surface)">Cards</button>
          <button type="button" class="btn btn-sm btn-text" data-tab-history="chart" style="padding:3px 10px;border-radius:var(--radius-full);font-size:11.5px">Chart</button>
        </div>` : ''}
    </div>

    <!-- History Chart View -->
    ${lines.length >= 2 ? `
      <div data-view-history="chart" style="display:none">
        ${chartHtml}
      </div>` : ''}

    <!-- History Cards View -->
    <div data-view-history="cards">
      ${lines.length ? `
        <div class="list" style="margin-top:8px">
          ${lines.slice(0, 60).map((line) => `
            <div class="list-row">
              <span class="list-row-main">
                <span class="list-row-title">${h(line.description || line.kind || 'Movement')}</span>
                <span class="list-row-sub">${h(line.date)}${line.nav ? ` · NAV ${money(line.nav)}` : ''}</span>
              </span>
              <span class="list-row-main" style="text-align:right;flex:0 0 auto">
                <span class="list-row-title ${Number(line.amount) < 0 ? 'holdings-loss' : 'holdings-gain'}">
                  ${money(Math.abs(Number(line.amount)))}
                </span>
                <span class="list-row-sub">${units(line.units)} units</span>
              </span>
            </div>`).join('')}
        </div>`
    : `<div class="card-flat" style="margin-top:8px">
           <div class="caption">
             No history recorded. A summary statement says what you hold today and nothing
             about how it got there. Detailed statement from CAMS or KFintech will show all purchases and redemptions.
           </div>
         </div>`}
    </div>`, {
    autofocus: false,
    actions: `
      <button class="btn btn-outlined btn-block" data-cancel>Done</button>`,
    onMount(node, close) {
      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));

      const doSave = async () => {
        const costInput = node.querySelector('[data-cost]');
        const costVal = Number(costInput?.value);
        if (Number.isNaN(costVal)) return;
        const res = await Bridge.db('save_holding_cost', {
          source: holding.source,
          holding_id: holding.id,
          invested_value: costVal,
        });
        if (res.status !== 'success') {
          toast(res.message || 'Could not save that.', 'error');
          return;
        }
        toast('Cost updated successfully.', 'success');
        close(true);
      };

      const quickSaveBtn = node.querySelector('[data-quick-save]');
      if (quickSaveBtn) quickSaveBtn.addEventListener('click', doSave);

      // History view toggle (Cards vs Chart)
      const tabCards = node.querySelector('[data-tab-history="cards"]');
      const tabChart = node.querySelector('[data-tab-history="chart"]');
      const viewCards = node.querySelector('[data-view-history="cards"]');
      const viewChart = node.querySelector('[data-view-history="chart"]');

      if (tabCards && tabChart) {
        tabCards.addEventListener('click', () => {
          tabCards.style.background = 'var(--surface)';
          tabChart.style.background = 'transparent';
          if (viewCards) viewCards.style.display = 'block';
          if (viewChart) viewChart.style.display = 'none';
        });
        tabChart.addEventListener('click', () => {
          tabChart.style.background = 'var(--surface)';
          tabCards.style.background = 'transparent';
          if (viewCards) viewCards.style.display = 'none';
          if (viewChart) viewChart.style.display = 'block';
        });
      }
    },
  });

  if (saved) renderInvestments(container, app);
}

/**
 * Modal to record a stock or mutual fund buy/sell trade.
 */
async function openRecordTradeModal(container, app) {
  const formHtml = `
    <div class="field">
      <label class="field-label" for="tradeSymbol">Stock Symbol / Scheme Name *</label>
      <input class="input" id="tradeSymbol" placeholder="e.g. INFY, RELIANCE, or Parag Parikh Flexi Cap" required autocomplete="off">
    </div>
    <div class="field">
      <label class="field-label" for="tradeIsin">ISIN (Optional)</label>
      <input class="input" id="tradeIsin" placeholder="e.g. INE009A01021" autocomplete="off">
    </div>
    <div class="row-between" style="gap:10px;align-items:flex-end">
      ${selectField({
        key: 'tradeType',
        id: 'tradeType',
        label: 'Trade Type',
        half: true,
        value: 'BUY',
        options: [
          { value: 'BUY', label: 'BUY' },
          { value: 'SELL', label: 'SELL' },
        ],
      })}
      <div class="field" style="flex:1;min-width:0">
        <label class="field-label" for="tradeDate">Trade Date</label>
        <input class="input" id="tradeDate" type="date" value="${todayISO()}">
      </div>
    </div>
    <div class="row-between" style="gap:10px">
      <div class="field" style="flex:1">
        <label class="field-label" for="tradeQty">Quantity / Units *</label>
        <input class="input numeric" id="tradeQty" type="number" step="0.001" placeholder="10" required>
      </div>
      <div class="field" style="flex:1">
        <label class="field-label" for="tradePrice">Price / Execution Rate *</label>
        <input class="input numeric" id="tradePrice" type="number" step="0.01" placeholder="1500.00" required>
      </div>
    </div>
    <div class="row-between" style="gap:10px">
      <div class="field" style="flex:1">
        <label class="field-label" for="tradeBroker">Broker / Account</label>
        <input class="input" id="tradeBroker" placeholder="Zerodha, Groww, Demat">
      </div>
      <div class="field" style="flex:1">
        <label class="field-label" for="tradeExchange">Exchange</label>
        <input class="input" id="tradeExchange" value="NSE">
      </div>
    </div>
    <div class="field">
      <label class="field-label" for="tradeNotes">Notes (Optional)</label>
      <input class="input" id="tradeNotes" placeholder="Order ID or notes">
    </div>`;

  await sheet('Record Trade', formHtml, {
    actions: `
      <button class="btn btn-filled btn-block" data-submit-trade>${icon('check')} Save Trade</button>
      <button class="btn btn-outlined btn-block" data-cancel style="margin-top:8px">Cancel</button>`,
    onMount(node, close) {
      bindSelectFields(node);
      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      node.querySelector('[data-submit-trade]').addEventListener('click', async () => {
        const symbol = node.querySelector('#tradeSymbol').value.trim();
        const isin = node.querySelector('#tradeIsin').value.trim().toUpperCase();
        const tradeType = node.querySelector('#tradeType').value;
        const tradeDate = node.querySelector('#tradeDate').value;
        const quantity = Number(node.querySelector('#tradeQty').value);
        const price = Number(node.querySelector('#tradePrice').value);
        const broker = node.querySelector('#tradeBroker').value.trim();
        const exchange = node.querySelector('#tradeExchange').value.trim().toUpperCase() || 'NSE';
        const notes = node.querySelector('#tradeNotes').value.trim();

        if (!symbol && !isin) {
          toast('Please enter a Stock Symbol or ISIN.', 'error');
          return;
        }
        if (quantity <= 0 || price <= 0 || Number.isNaN(quantity) || Number.isNaN(price)) {
          toast('Please enter valid Quantity and Price.', 'error');
          return;
        }

        const res = await Bridge.db('add_stock_transaction', {
          member_id: app.memberFilter === 'all' ? 1 : Number(app.memberFilter),
          symbol: symbol || isin,
          isin,
          trade_type: tradeType,
          trade_date: tradeDate,
          quantity,
          price,
          broker,
          exchange,
          notes,
        });

        if (res.status !== 'success') {
          toast(res.message || 'Could not record trade.', 'error');
          return;
        }

        toast('Trade recorded successfully.', 'success');
        close(true);
        renderInvestments(container, app);
      });
    },
  });
}

/**
 * Modal to import a broker tradebook CSV file.
 */
async function openImportCsvModal(container, app) {
  const picked = await pickFile('.csv,text/csv,text/plain');
  if (!picked) return;

  const progress = showProgressModal('Importing Broker Trades', {
    message: `Reading ${picked.name}...`,
    initialPercent: 25,
    detail: 'Parsing tradebook CSV format',
  });

  const stepTimer1 = setTimeout(() => {
    progress.update({
      percent: 60,
      message: 'Allocating trade lots and FIFO holding periods...',
      detail: 'Matching buy and sell orders',
    });
  }, 400);

  const stepTimer2 = setTimeout(() => {
    progress.update({
      percent: 90,
      message: 'Writing stock transactions to vault...',
      detail: 'Saving demat transactions',
    });
  }, 1000);

  let res;
  try {
    res = await Bridge.db('import_stock_transactions', {
      member_id: app.memberFilter === 'all' ? 1 : Number(app.memberFilter),
      csv_text: picked.text,
      broker: picked.name.split('.')[0] || 'Broker',
    });
  } catch (err) {
    res = { status: 'error', message: err.message || 'Could not import tradebook CSV.' };
  } finally {
    clearTimeout(stepTimer1);
    clearTimeout(stepTimer2);
  }

  if (res.status !== 'success') {
    progress.fail(res.message || 'Could not import tradebook CSV.');
    toast(res.message || 'Could not import tradebook CSV.', 'error');
    return;
  }

  progress.complete(`Imported ${res.imported_count} trades!`, 400);
  toast(`Imported ${res.imported_count} trade${res.imported_count === 1 ? '' : 's'} (${res.skipped_count} skipped/duplicates).`, 'success');
  renderInvestments(container, app);
}

/**
 * Full Capital Gains & Indian Income Tax (ITR) filing modal with bold disclaimer and Schedule 112A export.
 */
async function openCapitalGainsModal(container, app) {
  const report = await Bridge.db('get_capital_gains_report', {
    member_id: app.memberFilter === 'all' ? 1 : Number(app.memberFilter),
  });

  if (report.status !== 'success') {
    toast(report.message || 'Could not compute capital gains report.', 'error');
    return;
  }

  const money = (val) => formatCurrency(val, app.currency, app.locale);
  const years = report.financialYears || [];
  let selectedFy = years[0] || 'FY2024-25';
  let fyData = report.financialYearReports ? report.financialYearReports[selectedFy] : null;

  const buildModalContent = () => {
    fyData = report.financialYearReports ? report.financialYearReports[selectedFy] : null;

    return `
      ${taxDisclaimerCard({ compact: false })}

      ${years.length > 1 ? `
        <div class="row-between" style="align-items:center;margin:12px 0">
          <span class="caption" style="font-weight:600">Financial Year</span>
          <div class="chip-scroller" style="padding:0">
            ${years.map((fy) => `
              <button class="chip" data-fy-btn="${fy}" aria-selected="${fy === selectedFy}">${fy}</button>
            `).join('')}
          </div>
        </div>` : ''}

      ${fyData ? `
        <div class="card-flat" style="background:var(--surface-container-high);padding:14px;border-radius:var(--radius);margin-top:10px">
          <div class="row-between">
            <span class="caption">Realised Gains for ${h(selectedFy)}</span>
            <span class="caption" style="font-weight:700;color:var(--on-surface)">Net: ${money(fyData.netGain)}</span>
          </div>

          <div class="row-between" style="padding:6px 0;margin-top:6px;border-top:1px solid var(--outline)">
            <span class="caption">Short-Term (Sec 111A, &le;1 yr)</span>
            <span class="caption numeric" style="font-weight:600">${money(fyData.stcgEquityBe + fyData.stcgEquityAe)}</span>
          </div>
          ${fyData.stcgEquityAe ? `
            <div class="caption" style="font-size:11px;color:var(--on-surface-variant);padding-left:8px">
              · Post-23-Jul-2024 (@20%): ${money(fyData.stcgEquityAe)}
            </div>` : ''}
          ${fyData.stcgEquityBe ? `
            <div class="caption" style="font-size:11px;color:var(--on-surface-variant);padding-left:8px">
              · Pre-23-Jul-2024 (@15%): ${money(fyData.stcgEquityBe)}
            </div>` : ''}

          <div class="row-between" style="padding:6px 0;margin-top:4px">
            <span class="caption">Long-Term (Sec 112A, &gt;1 yr)</span>
            <span class="caption numeric" style="font-weight:600">${money(fyData.ltcgEquityBe + fyData.ltcgEquityAe)}</span>
          </div>
          <div class="caption" style="font-size:11px;color:var(--on-surface-variant);padding-left:8px">
            · Annual Exemption: ${money(fyData.ltcgExemption)}
          </div>
          <div class="row-between" style="padding:4px 0;padding-left:8px">
            <span class="caption" style="font-size:11px">Taxable LTCG (after exemption):</span>
            <span class="caption numeric" style="font-size:11px;font-weight:600">${money(fyData.taxableLtcg)}</span>
          </div>

          ${fyData.debtGains ? `
            <div class="row-between" style="padding:6px 0">
              <span class="caption">Debt / Slab Rate Gains</span>
              <span class="caption numeric" style="font-weight:600">${money(fyData.debtGains)}</span>
            </div>` : ''}

          <div class="row-between" style="padding:8px 0 0;margin-top:8px;border-top:1px solid var(--outline)">
            <span class="caption" style="font-weight:700">Estimated Capital Gains Tax</span>
            <span class="caption numeric" style="font-weight:700;color:var(--primary)">${money(fyData.estimatedTax)}</span>
          </div>
        </div>

        <!-- 5-Quarter Advance Tax Distribution -->
        <div class="section-header" style="margin-top:14px"><span class="title">Advance Tax 5-Quarter Distribution (Schedule CG Sec F)</span></div>
        <div class="list" style="margin-top:6px">
          ${fyData.quarterlyGains.map((qVal, qIdx) => `
            <div class="list-row">
              <span class="list-row-main"><span class="list-row-sub">${['Upto 15 Jun (15%)', '16 Jun to 15 Sep (45%)', '16 Sep to 15 Dec (75%)', '16 Dec to 15 Mar (100%)', '16 Mar to 31 Mar (100%)'][qIdx]}</span></span>
              <span class="list-row-amount numeric">${money(qVal)}</span>
            </div>`).join('')}
        </div>

        <button class="btn btn-tonal btn-block" data-download-112a style="margin-top:16px">
          ${icon('download')} Export Schedule 112A CSV
        </button>` : `
        <div class="card-flat" style="margin-top:14px">
          <div class="caption">No trade redemptions or realized capital gains recorded in ${h(selectedFy)}.</div>
        </div>`}`;
  };

  await sheet('Capital Gains & Tax Filings', buildModalContent(), {
    autofocus: false,
    actions: `
      <button class="btn btn-outlined btn-block" data-close-tax>Close</button>`,
    onMount(node, close) {
      node.querySelector('[data-close-tax]').addEventListener('click', () => close(null));

      const bindEvents = () => {
        node.querySelectorAll('[data-fy-btn]').forEach((btn) => {
          btn.addEventListener('click', () => {
            selectedFy = btn.dataset.fyBtn;
            node.querySelector('.sheet-body').innerHTML = buildModalContent();
            bindEvents();
          });
        });

        const dlBtn = node.querySelector('[data-download-112a]');
        if (dlBtn && fyData && fyData.schedule112aCsv) {
          dlBtn.addEventListener('click', () => {
            const filename = `schedule-112a-${selectedFy}.csv`;
            const res = saveFile(filename, fyData.schedule112aCsv, 'text/csv');
            if (res && res.success === false) {
              toast(res.error || 'Could not save Schedule 112A file.', 'error');
            } else {
              toast(`Saved ${filename} to Downloads`, 'success');
            }
          });
        }
      };

      bindEvents();
    },
  });
}

