/*
 * Everything the charts and the drilldowns are drawn from.
 *
 * Three actions, and they compose. `get_series` says how a number moved over a run of
 * buckets, `get_breakdown` says what one window was made of, and `get_period_summary` says
 * how that window compares with the one before it. A screen that lets you tap a bar and
 * see what is inside it is those three in sequence, which is why they share a vocabulary:
 * a granularity, a bucket key, and a half-open date range.
 *
 * Buckets are days, weeks or months, so the same code draws a daily chart and a five year
 * one. The bucketing happens here rather than in SQL because a week that starts on Monday
 * is not something strftime can be asked for portably, and doing it in one place means the
 * day chart and the week chart cannot disagree about which day a transaction landed on.
 */

import { fail } from './errors.js';
import {
  bucketFor, bucketKeys, bucketRange, memberClause, monthBounds, normaliseGranularity,
  number, parseISO, previousWindow, spanDays, windowRange,
} from './periods.js';

const PALETTE = ['#3B82F6', '#8B5CF6', '#14B8A6', '#F59E0B', '#EC4899', '#06B6D4', '#64748B'];
const OTHER_COLOR = '#94A3B8';

/** How much history a chart shows by default, and the most it will draw. */
const DEFAULT_PERIODS = { day: 30, week: 12, month: 6 };
const MAX_PERIODS = { day: 92, week: 53, month: 60 };

/** How many named series a stacked chart carries before the rest become one band. */
const TOP_SERIES = 5;

/** Is investments kept separate from expenses? */
export function isExcludingInvestments(db) {
  const row = db.get("SELECT value FROM app_settings WHERE key = 'exclude_investments_from_expenses'");
  return row ? row.value !== '0' : true;
}

/** Which transactions a flow means, as a SQL fragment. */
export function flowClause(db, flow) {
  const excludeInvestments = isExcludingInvestments(db);
  const clauses = {
    // A transfer is the same money in a different pocket, so it is spending in no window.
    spend: excludeInvestments
      ? "type != 'Income' AND type != 'Transfer' AND COALESCE(is_investment_outflow, 0) = 0"
      : "type != 'Income' AND type != 'Transfer'",
    income: "type = 'Income'",
    invest: 'COALESCE(is_investment_outflow, 0) = 1',
    all: "type != 'Transfer'",
  };
  return clauses[flow] || clauses.all;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ----------------------------------------------------------------- fetching */

/**
 * Transactions in a window, pre-aggregated by day and by everything a metric groups on.
 *
 * One query serves every metric. Grouping in SQL by the dimensions rather than reading raw
 * rows keeps the result proportional to how varied the spending is rather than to how much
 * of it there was, and the day is kept so the caller can bucket it into weeks or months
 * without a second trip.
 */
function transactionRows(db, { from, to, memberId, category, merchant, flow = 'all' }) {
  const filters = ['date >= ?', 'date < ?'];
  const params = [from, to];

  const [clause, memberParams] = memberClause(memberId, 'AND');
  if (clause) {
    filters.push('member_id = ?');
    params.push(...memberParams);
  }
  if (category) {
    filters.push('category = ?');
    params.push(String(category));
  }
  if (merchant) {
    filters.push('lower(COALESCE(merchant, \'\')) = ?');
    params.push(String(merchant).toLowerCase());
  }
  if (flow !== 'all') {
    const filter = flowClause(db, flow);
    if (filter) filters.push(filter);
  }

  return db.all(
    'SELECT date, category, type, COALESCE(is_investment_outflow, 0) AS is_investment_outflow,'
    + ' member_id, COALESCE(merchant, \'\') AS merchant, SUM(amount) AS total, COUNT(*) AS times'
    + ` FROM transactions WHERE ${filters.join(' AND ')}`
    + ' GROUP BY date, category, type, is_investment_outflow, member_id, merchant',
    params,
  );
}

/** What a window came to, split the three ways every screen states it. */
export function flowTotals(db, { from, to, memberId, category }) {
  const excludeInvestments = isExcludingInvestments(db);
  const totals = {
    income: 0, expense: 0, invested: 0, count: 0,
  };
  if (!from || !to) return totals;

  for (const row of transactionRows(db, {
    from, to, memberId, category, flow: 'all',
  })) {
    const value = number(row.total);
    totals.count += number(row.times);
    if (row.type === 'Income') totals.income += value;
    else if (row.is_investment_outflow && excludeInvestments) totals.invested += value;
    else totals.expense += value;
  }
  totals.net = totals.income - totals.expense - totals.invested;
  return totals;
}

/** Statement lines for a window, which is where an investment's own history comes from. */
function folioRows(db, { from, to, memberId }) {
  const [clause, params] = memberClause(memberId, 'AND');
  return db.all(
    'SELECT date, scheme_name, isin, amount, units FROM folio_transactions'
    + ` WHERE date >= ? AND date < ?${clause}`,
    [from, to, ...params],
  );
}

/* ------------------------------------------------------------------ metrics */

/**
 * Ranked series from rows that carry a name.
 *
 * The biggest few get a band each and everything else is summed into one, because a
 * stacked chart with nineteen bands is a colour wheel rather than a chart.
 */
function rankedSeries(rows, { keyOf, valueOf, buckets, index, colors = new Map(), limit = TOP_SERIES }) {
  const totals = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === undefined || key === '') continue;
    totals.set(key, (totals.get(key) || 0) + valueOf(row));
  }

  const ranked = [...totals.keys()]
    .sort((a, b) => totals.get(b) - totals.get(a))
    .slice(0, limit);

  const blank = () => buckets.map(() => 0);
  const byKey = new Map(ranked.map((key) => [key, blank()]));
  const other = blank();

  for (const row of rows) {
    const slot = index.get(row.bucket);
    if (slot === undefined) continue;
    const key = keyOf(row);
    if (key === null || key === undefined || key === '') continue;
    (byKey.get(key) || other)[slot] += valueOf(row);
  }

  const series = ranked.map((key, position) => ({
    key: String(key),
    label: String(key),
    color: colors.get(key) || PALETTE[position % PALETTE.length],
    values: byKey.get(key),
  }));

  if (other.some(Boolean)) {
    series.push({
      key: '__other', label: 'Everything else', color: OTHER_COLOR, values: other,
    });
  }
  return series;
}

function categoryColors(db) {
  return new Map(
    db.all('SELECT name, color FROM custom_categories').map((row) => [row.name, row.color]),
  );
}

/**
 * The catalogue.
 *
 * `source` says which table the metric reads, `unit` says how the UI should format it, and
 * `build` turns bucketed rows into named series. A new chart is an entry here.
 */
const METRICS = {
  income_expense: {
    label: 'Money in and out',
    source: 'transactions',
    build({ rows, blank, index, db }) {
      const excludeInvestments = isExcludingInvestments(db);
      const income = blank();
      const expense = blank();
      const invested = blank();
      for (const row of rows) {
        const slot = index.get(row.bucket);
        if (slot === undefined || row.type === 'Transfer') continue;
        if (row.type === 'Income') income[slot] += number(row.total);
        else if (row.is_investment_outflow && excludeInvestments) invested[slot] += number(row.total);
        else expense[slot] += number(row.total);
      }
      const series = [
        { key: 'income', label: 'Received', role: 'income', values: income },
        { key: 'expense', label: 'Spent', role: 'expense', values: expense },
      ];
      if (invested.some(Boolean)) {
        series.push({ key: 'invested', label: 'Invested', role: 'investment', values: invested });
      }
      return { series };
    },
  },

  spend_total: {
    label: 'Spending',
    source: 'transactions',
    build({ rows, blank, index, db }) {
      const excludeInvestments = isExcludingInvestments(db);
      const spent = blank();
      for (const row of rows) {
        const slot = index.get(row.bucket);
        if (slot === undefined || !isSpend(row, excludeInvestments)) continue;
        spent[slot] += number(row.total);
      }
      return { series: [{ key: 'expense', label: 'Spent', role: 'expense', values: spent }] };
    },
  },

  net_flow: {
    label: 'Kept each period',
    source: 'transactions',
    build({ rows, blank, index }) {
      const net = blank();
      for (const row of rows) {
        const slot = index.get(row.bucket);
        if (slot === undefined || row.type === 'Transfer') continue;
        if (row.type === 'Income') net[slot] += number(row.total);
        else net[slot] -= number(row.total);
      }
      return { series: [{ key: 'net', label: 'Kept', role: 'accent', values: net }] };
    },
  },

  savings_rate: {
    label: 'Share of income kept',
    source: 'transactions',
    unit: 'percent',
    build({ rows, blank, index }) {
      const income = blank();
      const out = blank();
      for (const row of rows) {
        const slot = index.get(row.bucket);
        if (slot === undefined || row.type === 'Transfer') continue;
        if (row.type === 'Income') income[slot] += number(row.total);
        else out[slot] += number(row.total);
      }
      // A period with nothing coming in has no rate rather than a rate of zero, and
      // drawing it as zero would say the household spent everything it earned.
      const values = income.map((earned, i) => (earned > 0
        ? ((earned - out[i]) / earned) * 100
        : 0));
      return { series: [{ key: 'rate', label: 'Kept', role: 'accent', values }] };
    },
  },

  spend_by_category: {
    label: 'Spending by category',
    source: 'transactions',
    stacked: true,
    build({ rows, buckets, index, db }) {
      const excludeInvestments = isExcludingInvestments(db);
      return {
        series: rankedSeries(rows.filter((row) => isSpend(row, excludeInvestments)), {
          keyOf: (row) => row.category,
          valueOf: (row) => number(row.total),
          buckets,
          index,
          colors: categoryColors(db),
        }),
      };
    },
  },

  income_by_category: {
    label: 'Income by category',
    source: 'transactions',
    stacked: true,
    build({ rows, buckets, index, db }) {
      return {
        series: rankedSeries(rows.filter((row) => row.type === 'Income'), {
          keyOf: (row) => row.category,
          valueOf: (row) => number(row.total),
          buckets,
          index,
          colors: categoryColors(db),
        }),
      };
    },
  },

  spend_by_merchant: {
    label: 'Spending by shop',
    source: 'transactions',
    stacked: true,
    build({ rows, buckets, index, db }) {
      const excludeInvestments = isExcludingInvestments(db);
      return {
        series: rankedSeries(rows.filter((row) => isSpend(row, excludeInvestments) && row.merchant), {
          keyOf: (row) => row.merchant,
          valueOf: (row) => number(row.total),
          buckets,
          index,
        }),
      };
    },
  },

  spend_by_member: {
    label: 'Spending by person',
    source: 'transactions',
    stacked: true,
    build({ rows, blank, index, db }) {
      const excludeInvestments = isExcludingInvestments(db);
      const members = db.all(
        'SELECT id, name, avatar_color FROM family_members ORDER BY is_primary DESC, id',
      );
      const byMember = new Map(members.map((member) => [member.id, blank()]));
      for (const row of rows) {
        const slot = index.get(row.bucket);
        if (slot === undefined || !isSpend(row, excludeInvestments)) continue;
        const values = byMember.get(row.member_id);
        if (values) values[slot] += number(row.total);
      }
      return {
        series: members
          .filter((member) => byMember.get(member.id).some(Boolean))
          .map((member, position) => ({
            key: String(member.id),
            label: member.name,
            color: member.avatar_color || PALETTE[position % PALETTE.length],
            values: byMember.get(member.id),
          })),
      };
    },
  },

  cumulative_savings: {
    label: 'Running total kept',
    source: 'transactions',
    cumulative: 'net',
    build({ rows, blank, index, carry, db }) {
      const excludeInvestments = isExcludingInvestments(db);
      const net = blank();
      for (const row of rows) {
        const slot = index.get(row.bucket);
        if (slot === undefined || row.type === 'Transfer') continue;
        if (row.type === 'Income') net[slot] += number(row.total);
        else if (!row.is_investment_outflow || !excludeInvestments) net[slot] -= number(row.total);
      }
      let running = carry;
      return {
        series: [{
          key: 'savings',
          label: 'Kept',
          role: 'accent',
          values: net.map((value) => { running += value; return running; }),
        }],
      };
    },
  },

  investment_growth: {
    label: 'Invested so far',
    source: 'transactions',
    cumulative: 'invested',
    build({ rows, blank, index, carry }) {
      const invested = blank();
      for (const row of rows) {
        const slot = index.get(row.bucket);
        if (slot !== undefined && row.is_investment_outflow) invested[slot] += number(row.total);
      }
      let running = carry;
      return {
        series: [{
          key: 'invested',
          label: 'Put in',
          role: 'investment',
          values: invested.map((value) => { running += value; return running; }),
        }],
      };
    },
  },

  invest_flows: {
    label: 'Bought and sold',
    source: 'folio',
    build({ rows, blank, index }) {
      const bought = blank();
      const sold = blank();
      for (const row of rows) {
        const slot = index.get(row.bucket);
        if (slot === undefined) continue;
        const amount = number(row.amount);
        // A registrar writes a purchase positive and a redemption negative, and the sign
        // is the only thing on the line that says which it was.
        if (amount >= 0) bought[slot] += amount;
        else sold[slot] += Math.abs(amount);
      }
      return {
        series: [
          { key: 'bought', label: 'Bought', role: 'investment', values: bought },
          { key: 'sold', label: 'Sold', role: 'expense', values: sold },
        ],
      };
    },
  },

  invest_cumulative: {
    label: 'Net put into funds',
    source: 'folio',
    cumulative: 'folio',
    build({ rows, blank, index, carry }) {
      const net = blank();
      for (const row of rows) {
        const slot = index.get(row.bucket);
        if (slot !== undefined) net[slot] += number(row.amount);
      }
      let running = carry;
      return {
        series: [{
          key: 'net_invested',
          label: 'Net put in',
          role: 'accent',
          values: net.map((value) => { running += value; return running; }),
        }],
      };
    },
  },

  invest_by_scheme: {
    label: 'Bought, by scheme',
    source: 'folio',
    stacked: true,
    build({ rows, buckets, index }) {
      return {
        series: rankedSeries(rows.filter((row) => number(row.amount) > 0), {
          keyOf: (row) => row.scheme_name,
          valueOf: (row) => number(row.amount),
          buckets,
          index,
        }),
      };
    },
  },
};

function isSpend(row, excludeInvestments = true) {
  return row.type !== 'Income' && row.type !== 'Transfer' && (!excludeInvestments || !row.is_investment_outflow);
}

/** The catalogue, for a UI that offers the user a choice of chart. */
export function seriesMetrics() {
  return Object.entries(METRICS).map(([key, spec]) => ({
    key,
    label: spec.label,
    stacked: Boolean(spec.stacked),
    unit: spec.unit || 'money',
    source: spec.source,
  }));
}

/** What was already there before the window opened, so a running total starts honestly. */
function carryInto(db, spec, { from, memberId }) {
  if (!spec.cumulative) return 0;

  if (spec.cumulative === 'folio') {
    const [clause, params] = memberClause(memberId, 'AND');
    return number(db.value(
      `SELECT SUM(amount) FROM folio_transactions WHERE date < ?${clause}`, [from, ...params],
    ));
  }

  const excludeInvestments = isExcludingInvestments(db);
  const [clause, params] = memberClause(memberId, 'AND');
  const rows = db.all(
    'SELECT type, COALESCE(is_investment_outflow, 0) AS is_investment_outflow, SUM(amount) AS total'
    + ` FROM transactions WHERE date < ?${clause}`
    + ' GROUP BY type, is_investment_outflow',
    [from, ...params],
  );

  let running = 0;
  for (const row of rows) {
    const total = number(row.total);
    if (row.type === 'Transfer') continue;
    if (spec.cumulative === 'invested') {
      if (row.is_investment_outflow) running += total;
      continue;
    }
    if (row.type === 'Income') running += total;
    else if (!row.is_investment_outflow || !excludeInvestments) running -= total;
  }
  return running;
}

/**
 * Aggregated history for a chart.
 *
 * Returns bucket keys and named series, one value per bucket, which is a shape a stacked
 * bar, a grouped bar and a line can all consume without knowing how the numbers were made.
 */
export function getSeries(db, args) {
  const metric = String(args.metric ?? 'income_expense');
  const spec = METRICS[metric];
  if (!spec) return fail('METRIC_UNKNOWN', `Unknown chart metric: ${metric}`);

  const granularity = normaliseGranularity(args.granularity, 'month');
  if (!granularity) {
    return fail('GRANULARITY_UNKNOWN',
      `A chart cannot be bucketed by "${args.granularity}".`,
      'Ask for days, weeks or months.');
  }

  const wanted = Number.parseInt(args.periods ?? args.months ?? DEFAULT_PERIODS[granularity], 10);
  const periods = Math.max(2, Math.min(MAX_PERIODS[granularity],
    Number.isFinite(wanted) ? wanted : DEFAULT_PERIODS[granularity]));
  const offset = Math.max(0, Number.parseInt(args.offset ?? 0, 10) || 0);

  const buckets = bucketKeys(granularity, periods, offset);
  const [from, to] = windowRange(granularity, buckets);
  const index = new Map(buckets.map((key, position) => [key, position]));
  const blank = () => buckets.map(() => 0);

  const raw = spec.source === 'folio'
    ? folioRows(db, { from, to, memberId: args.member_id })
    : transactionRows(db, {
      from, to, memberId: args.member_id, category: args.category, merchant: args.merchant,
    });

  // The bucket is worked out once per row and carried on it, so a metric never has to
  // know how a week was defined.
  const rows = raw.map((row) => ({ ...row, bucket: bucketFor(row.date, granularity) }));

  const built = spec.build({
    rows, buckets, index, blank, db, carry: carryInto(db, spec, { from, memberId: args.member_id }),
  });
  const series = built.series.filter(Boolean);

  return {
    metric,
    label: spec.label,
    unit: spec.unit || 'money',
    granularity,
    periods,
    offset,
    buckets,
    from,
    to,
    series,
    stacked: Boolean(built.stacked ?? spec.stacked),
    totals: Object.fromEntries(series.map((entry) => [
      entry.key, entry.values.reduce((sum, value) => sum + value, 0),
    ])),
    empty: !series.some((entry) => entry.values.some(Boolean)),
  };
}

/* --------------------------------------------------------------- breakdowns */

/**
 * Which window a caller meant.
 *
 * Either a granularity and a bucket key, which is what a chart hands over when a bar is
 * tapped, or a plain pair of dates. Both end up as the same half-open range, so nothing
 * downstream has to care which arrived.
 */
export function resolveRange(args = {}) {
  const granularity = args.granularity ? normaliseGranularity(args.granularity) : null;
  if (args.granularity && !granularity) {
    return { error: fail('GRANULARITY_UNKNOWN', `Not a bucket size: ${args.granularity}`) };
  }

  if (granularity) {
    const bucket = args.bucket
      || bucketKeys(granularity, 1, Math.max(0, Number.parseInt(args.offset ?? 0, 10) || 0))[0];
    const [from, to] = bucketRange(granularity, bucket);
    if (!from) return { error: fail('RANGE_INVALID', `Not a ${granularity} key: ${bucket}`) };
    return { from, to, granularity, bucket };
  }

  if (args.from && args.to) {
    if (!parseISO(args.from) || !parseISO(args.to)) {
      return { error: fail('RANGE_INVALID', 'The dates were not readable.') };
    }
    if (String(args.to) <= String(args.from)) {
      return { error: fail('RANGE_INVALID', 'The range ends before it starts.') };
    }
    return {
      from: String(args.from).slice(0, 10), to: String(args.to).slice(0, 10), granularity: null, bucket: '',
    };
  }

  // Nothing said, so this month, which is what every screen opens on.
  const [from, to] = monthBounds();
  return {
    from, to, granularity: 'month', bucket: from.slice(0, 7),
  };
}

/** How each dimension names, colours and labels its rows. */
const DIMENSIONS = {
  category: {
    label: 'Category',
    keyOf: (row) => row.category || 'Uncategorised',
    decorate(db) {
      const look = new Map(db.all('SELECT name, color, icon FROM custom_categories')
        .map((row) => [row.name, row]));
      return (key) => ({
        label: key,
        color: look.get(key)?.color || OTHER_COLOR,
        icon: look.get(key)?.icon || 'sell',
      });
    },
  },
  merchant: {
    label: 'Shop',
    keyOf: (row) => (row.merchant ? row.merchant.toLowerCase() : ''),
    labelOf: (row) => row.merchant,
    decorate: () => (key, label) => ({ label: label || key, icon: 'storefront' }),
  },
  member: {
    label: 'Person',
    keyOf: (row) => String(row.member_id ?? ''),
    decorate(db) {
      const look = new Map(db.all('SELECT id, name, avatar_color FROM family_members')
        .map((row) => [String(row.id), row]));
      return (key) => ({
        label: look.get(key)?.name || 'Somebody',
        color: look.get(key)?.avatar_color || OTHER_COLOR,
        icon: 'person',
      });
    },
  },
  type: {
    label: 'Kind',
    keyOf: (row) => (row.is_investment_outflow ? 'Investment' : row.type || 'Expense'),
    decorate: () => (key) => ({ label: key, icon: 'label' }),
  },
  weekday: {
    label: 'Day of the week',
    keyOf: (row) => {
      const date = parseISO(row.date);
      return date ? String(date.getDay()) : '';
    },
    decorate: () => (key) => ({ label: WEEKDAYS[Number(key)] || '', icon: 'today' }),
    order: (a, b) => Number(a.key) - Number(b.key),
  },
  day: {
    label: 'Day',
    keyOf: (row) => String(row.date).slice(0, 10),
    decorate: () => (key) => ({ label: key, icon: 'today' }),
    order: (a, b) => a.key.localeCompare(b.key),
  },
  week: {
    label: 'Week',
    keyOf: (row) => bucketFor(row.date, 'week'),
    decorate: () => (key) => ({ label: key, icon: 'calendar_month' }),
    order: (a, b) => a.key.localeCompare(b.key),
  },
  month: {
    label: 'Month',
    keyOf: (row) => String(row.date).slice(0, 7),
    decorate: () => (key) => ({ label: key, icon: 'calendar_month' }),
    order: (a, b) => a.key.localeCompare(b.key),
  },
};

/** The dimensions a UI may offer, with the labels it should offer them under. */
export function breakdownDimensions() {
  return Object.entries(DIMENSIONS).map(([key, spec]) => ({ key, label: spec.label }));
}

/**
 * What one window was made of, ranked.
 *
 * The share of the total comes back with each row so a bar does not have to be worked out
 * twice, and the count comes back so a row can say "nine times" rather than only a figure.
 */
export function getBreakdown(db, args) {
  const dimension = String(args.dimension ?? 'category');
  const spec = DIMENSIONS[dimension];
  if (!spec) return fail('DIMENSION_UNKNOWN', `Nothing is grouped by ${dimension}.`);

  const validFlows = new Set(['spend', 'income', 'invest', 'all']);
  const flow = validFlows.has(args.flow) ? String(args.flow) : 'spend';
  const range = resolveRange(args);
  if (range.error) return range.error;

  const rows = transactionRows(db, {
    from: range.from,
    to: range.to,
    memberId: args.member_id,
    category: args.category,
    merchant: args.merchant,
    flow,
  });

  const buckets = new Map();
  let total = 0;
  let count = 0;

  for (const row of rows) {
    const key = spec.keyOf(row);
    if (key === '' || key === null || key === undefined) continue;
    const value = number(row.total);
    const times = number(row.times);
    total += value;
    count += times;

    const entry = buckets.get(key) || {
      key: String(key),
      label: (spec.labelOf ? spec.labelOf(row) : String(key)) || String(key),
      total: 0,
      count: 0,
      first: String(row.date).slice(0, 10),
      last: String(row.date).slice(0, 10),
    };
    entry.total += value;
    entry.count += times;
    if (String(row.date) < entry.first) entry.first = String(row.date).slice(0, 10);
    if (String(row.date) > entry.last) entry.last = String(row.date).slice(0, 10);
    buckets.set(key, entry);
  }

  const decorate = spec.decorate(db);
  const ranked = [...buckets.values()].map((entry) => ({
    ...entry,
    ...decorate(entry.key, entry.label),
    share: total > 0 ? (entry.total / total) * 100 : 0,
    average: entry.count > 0 ? entry.total / entry.count : 0,
  }));

  ranked.sort(spec.order || ((a, b) => b.total - a.total));

  const limit = Number.parseInt(args.limit ?? 0, 10);
  return {
    dimension,
    flow,
    from: range.from,
    to: range.to,
    granularity: range.granularity,
    bucket: range.bucket,
    rows: limit > 0 ? ranked.slice(0, limit) : ranked,
    truncated: limit > 0 ? Math.max(0, ranked.length - limit) : 0,
    total,
    count,
    days: spanDays(range.from, range.to),
  };
}

/* ------------------------------------------------------------ period detail */

/**
 * The headline for one window, and how it compares with the window before it.
 *
 * The comparison is the reason this exists rather than the caller adding up a breakdown:
 * "spent 62,000" says very little on its own, and "spent 62,000, a fifth more than the
 * month before" says most of what somebody opened the screen to find out.
 */
export function getPeriodSummary(db, args) {
  const range = resolveRange(args);
  if (range.error) return range.error;

  const memberId = args.member_id;
  const totals = flowTotals(db, {
    from: range.from, to: range.to, memberId, category: args.category,
  });

  const [previousFrom, previousTo] = previousWindow(range.from, range.to);
  const previous = flowTotals(db, {
    from: previousFrom, to: previousTo, memberId, category: args.category,
  });

  const rows = transactionRows(db, {
    from: range.from, to: range.to, memberId, category: args.category, flow: 'spend',
  });

  const byCategory = new Map();
  const byDay = new Map();
  for (const row of rows) {
    const value = number(row.total);
    byCategory.set(row.category, (byCategory.get(row.category) || 0) + value);
    const day = String(row.date).slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + value);
  }

  const topCategory = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0];
  const busiest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];

  const [clause, params] = memberClause(memberId, 'AND');
  const biggest = db.get(
    'SELECT id, date, amount, category, merchant, description FROM transactions'
    + ` WHERE date >= ? AND date < ? AND ${flowClause(db, 'spend')}${clause}`
    + ' ORDER BY amount DESC LIMIT 1',
    [range.from, range.to, ...params],
  );

  const days = spanDays(range.from, range.to);
  const change = (now, before) => (before > 0 ? ((now - before) / before) * 100 : null);

  return {
    from: range.from,
    to: range.to,
    granularity: range.granularity,
    bucket: range.bucket,
    days,
    income: totals.income,
    expense: totals.expense,
    invested: totals.invested,
    net: totals.net,
    count: totals.count,
    average_daily: totals.expense / days,
    savings_rate: totals.income > 0 ? (totals.net / totals.income) * 100 : null,
    top_category: topCategory ? { name: topCategory[0], total: topCategory[1] } : null,
    busiest_day: busiest ? { date: busiest[0], total: busiest[1] } : null,
    biggest: biggest || null,
    previous: {
      from: previousFrom,
      to: previousTo,
      income: previous.income,
      expense: previous.expense,
      invested: previous.invested,
      net: previous.net,
      count: previous.count,
    },
    change: {
      expense: change(totals.expense, previous.expense),
      income: change(totals.income, previous.income),
      invested: change(totals.invested, previous.invested),
    },
  };
}
