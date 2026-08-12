/*
 * Finding the commitments nobody typed in, and following them as they get dearer.
 *
 * A household does not have a list of its subscriptions. It has a bank account that is
 * debited by the same shop for the same amount on roughly the same day, over and over, and
 * a person who is surprised twice a year. So the list is derived: group what was already
 * recorded by who was paid, look for a rhythm, and offer what turns up.
 *
 * Two things make that harder than grouping by name. A price is not constant, because
 * everything renews dearer, and a SIP is often deliberately stepped up. So the amounts are
 * read as a run of levels rather than as one number, and a change of level is reported as
 * what it is: a price rise on a subscription, a step-up on an instalment. Once a commitment
 * is tracked, the same reading is what notices that the recorded amount has gone stale.
 *
 * Nothing here writes without being asked. Detection returns candidates; the user decides.
 */

import { fail } from './errors.js';
import { merchantKey } from './merchants.js';
import {
  addMonths, daysBetween, isoDate, memberClause, number, parseISO, today,
} from './periods.js';

/**
 * The rhythms worth recognising, with the window of gaps that counts as each one.
 *
 * The windows are generous because a debit lands on the next working day: a monthly
 * mandate can be 28 days apart one month and 34 the next without being anything other
 * than monthly.
 */
export const CADENCES = [
  {
    key: 'weekly', label: 'Weekly', days: 7, min: 6, max: 9, perYear: 52, months: 0, cycle: 'Monthly',
  },
  {
    key: 'fortnightly', label: 'Every two weeks', days: 14, min: 12, max: 17, perYear: 26, months: 0, cycle: 'Monthly',
  },
  {
    key: 'monthly', label: 'Monthly', days: 30, min: 24, max: 38, perYear: 12, months: 1, cycle: 'Monthly',
  },
  {
    key: 'quarterly', label: 'Quarterly', days: 91, min: 78, max: 104, perYear: 4, months: 3, cycle: 'Quarterly',
  },
  {
    key: 'half_yearly', label: 'Half-yearly', days: 182, min: 160, max: 205, perYear: 2, months: 6, cycle: 'Half-yearly',
  },
  {
    key: 'annual', label: 'Yearly', days: 365, min: 320, max: 410, perYear: 1, months: 12, cycle: 'Annual',
  },
];

/** How many months a billing cycle skips, for walking future dates. */
const CYCLE_MONTHS = {
  Monthly: 1, Quarterly: 3, 'Half-yearly': 6, Annual: 12,
};

/** A level change smaller than this is the same price paid on a different day. */
const PRICE_TOLERANCE = 0.02;

/* -------------------------------------------------------------- detection */

/** The median of a list of numbers, which a stray double charge cannot drag around. */
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/**
 * Amounts in date order, read as a run of price levels.
 *
 * A subscription that cost 149 for eight months and 199 for four is two levels and one
 * rise, not twelve numbers. A grocery bill is twelve levels, which is how this tells the
 * two apart: something that changes price every single time is not a subscription.
 */
function priceLevels(entries) {
  const levels = [];
  for (const entry of entries) {
    const current = levels[levels.length - 1];
    if (current && Math.abs(entry.amount - current.amount)
      <= Math.max(current.amount * PRICE_TOLERANCE, 1)) {
      current.amounts.push(entry.amount);
      current.amount = mean(current.amounts);
      current.to = entry.date;
      current.times += 1;
      continue;
    }
    levels.push({
      amount: entry.amount,
      amounts: [entry.amount],
      from: entry.date,
      to: entry.date,
      times: 1,
    });
  }
  return levels.map((level) => ({
    amount: Math.round(level.amount * 100) / 100,
    from: level.from,
    to: level.to,
    times: level.times,
  }));
}

/** The cadence a set of gaps looks like, or null when they look like nothing. */
function cadenceFor(gaps) {
  const spacing = gaps.filter((gap) => gap > 0);
  if (!spacing.length) return null;

  const typical = median(spacing);
  const cadence = CADENCES.find((entry) => typical >= entry.min && typical <= entry.max);
  if (!cadence) return null;

  // Regular enough to be a mandate rather than a habit. Two thirds of the gaps have to
  // sit inside the cadence window, which lets one missed or double month through.
  const inside = spacing.filter((gap) => gap >= cadence.min && gap <= cadence.max).length;
  if (inside / spacing.length < 0.66) return null;

  return { cadence, typical, regularity: inside / spacing.length };
}

/** When the next one is due, walking forward from the last one that landed. */
function nextDue(lastDate, cadence) {
  const last = parseISO(lastDate);
  if (!last) return '';
  const now = parseISO(today());
  let candidate = cadence.months
    ? addMonths(last, cadence.months)
    : new Date(last.getTime() + cadence.days * 86400000);

  // A commitment that has not been paid for a while still has a next date in the future,
  // which is more useful than reporting one that has already gone by.
  let guard = 0;
  while (candidate < now && guard < 120) {
    candidate = cadence.months
      ? addMonths(candidate, cadence.months)
      : new Date(candidate.getTime() + cadence.days * 86400000);
    guard += 1;
  }
  return isoDate(candidate);
}

/** Yearly rate of change implied by the first and last level, compounded. */
function annualisedChange(levels) {
  if (levels.length < 2) return 0;
  const first = levels[0];
  const last = levels[levels.length - 1];
  if (first.amount <= 0 || last.amount <= 0) return 0;

  const days = daysBetween(first.from, last.from);
  const years = days && days > 0 ? days / 365 : 0;
  if (years < 0.25) return 0;

  const factor = (last.amount / first.amount) ** (1 / years);
  return Math.round((factor - 1) * 1000) / 10;
}

/**
 * The commitments hiding in the history.
 *
 * Only outgoing money is considered: income arrives on a rhythm too, and a salary is not a
 * subscription. Investment outflows are kept, because a SIP is exactly what this is for,
 * and they are told apart at the end by what the transactions were filed as.
 */
export function findRecurring(db, args = {}) {
  const months = Math.max(3, Math.min(60, Number.parseInt(args.months ?? 15, 10) || 15));
  const minTimes = Math.max(2, Math.min(12, Number.parseInt(args.min_occurrences ?? 3, 10) || 3));

  const start = addMonths(parseISO(today()), -months);
  const from = isoDate(start);
  const [clause, params] = memberClause(args.member_id, 'AND');

  const rows = db.all(
    'SELECT id, date, amount, category, type, merchant, merchant_key, member_id,'
    + ' COALESCE(is_investment_outflow, 0) AS is_investment_outflow FROM transactions'
    + ` WHERE date >= ? AND type != 'Income' AND type != 'Transfer'`
    + " AND COALESCE(merchant, '') != ''"
    + `${clause} ORDER BY date ASC, id ASC`,
    [from, ...params],
  );

  const groups = new Map();
  for (const row of rows) {
    const key = row.merchant_key || merchantKey(row.merchant);
    if (!key) continue;
    const group = groups.get(key) || {
      key, name: row.merchant, entries: [], investment: 0, categories: new Map(), members: new Map(),
    };
    group.name = row.merchant || group.name;
    group.entries.push({ date: String(row.date).slice(0, 10), amount: number(row.amount), id: row.id });
    if (row.is_investment_outflow) group.investment += 1;
    group.categories.set(row.category, (group.categories.get(row.category) || 0) + 1);
    group.members.set(row.member_id, (group.members.get(row.member_id) || 0) + 1);
    groups.set(key, group);
  }

  const dismissed = new Set(
    db.all('SELECT merchant_key FROM recurring_dismissed').map((row) => row.merchant_key),
  );
  const linked = trackedIndex(db, args.member_id);

  const found = [];
  for (const group of groups.values()) {
    if (group.entries.length < minTimes) continue;

    const gaps = [];
    for (let i = 1; i < group.entries.length; i += 1) {
      gaps.push(daysBetween(group.entries[i - 1].date, group.entries[i].date) ?? 0);
    }
    const rhythm = cadenceFor(gaps);
    if (!rhythm) continue;

    const levels = priceLevels(group.entries);
    // Four different prices in a run of a dozen charges is a shop, not a plan. A real
    // price rise is rare, and a step-up happens once a year.
    if (levels.length > 3) continue;

    const current = levels[levels.length - 1];
    const last = group.entries[group.entries.length - 1];
    const commonest = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0];
    const kind = group.investment * 2 >= group.entries.length ? 'sip' : 'subscription';
    const dayOfMonth = median(group.entries
      .map((entry) => (parseISO(entry.date) || { getDate: () => 1 }).getDate()));

    const candidate = {
      merchant_key: group.key,
      name: group.name,
      kind,
      cadence: rhythm.cadence.key,
      cadence_label: rhythm.cadence.label,
      billing_cycle: rhythm.cadence.cycle,
      typical_gap: Math.round(rhythm.typical),
      regularity: Math.round(rhythm.regularity * 100),
      times: group.entries.length,
      amount: current.amount,
      first_amount: levels[0].amount,
      first_seen: group.entries[0].date,
      last_seen: last.date,
      next_due: nextDue(last.date, rhythm.cadence),
      day_of_month: Math.max(1, Math.min(28, Math.round(dayOfMonth))),
      category: commonest(group.categories)?.[0] || '',
      member_id: commonest(group.members)?.[0] ?? null,
      yearly: Math.round(current.amount * rhythm.cadence.perYear * 100) / 100,
      levels,
      changes: levels.slice(1).map((level, position) => ({
        date: level.from,
        from: levels[position].amount,
        to: level.amount,
        percent: levels[position].amount > 0
          ? Math.round(((level.amount - levels[position].amount) / levels[position].amount) * 1000) / 10
          : 0,
      })),
      annual_change_percent: annualisedChange(levels),
      dismissed: dismissed.has(group.key),
      tracked: null,
    };

    const match = linked.get(group.key);
    if (match) {
      candidate.tracked = match;
      // What is on file against what is actually being debited. This is the whole point of
      // reading the levels: a plan whose price went up eight months ago is a plan whose
      // recorded cost has been wrong for eight months.
      candidate.recorded_amount = match.amount;
      candidate.drift = match.amount > 0
        ? Math.round(((current.amount - match.amount) / match.amount) * 1000) / 10
        : 0;
      candidate.needs_update = Math.abs(current.amount - match.amount)
        > Math.max(match.amount * PRICE_TOLERANCE, 1);
    }

    found.push(candidate);
  }

  found.sort((a, b) => b.yearly - a.yearly);

  const untracked = found.filter((entry) => !entry.tracked && !entry.dismissed);
  return {
    from,
    to: today(),
    months,
    candidates: untracked,
    tracked: found.filter((entry) => entry.tracked),
    dismissed: found.filter((entry) => entry.dismissed && !entry.tracked),
    yearly_untracked: untracked.reduce((sum, entry) => sum + entry.yearly, 0),
    scanned: rows.length,
  };
}

/** What is already on file, keyed by the vendor it was filed against. */
function trackedIndex(db, memberId) {
  const [clause, params] = memberClause(memberId);
  const index = new Map();

  for (const row of db.all(`SELECT * FROM sips${clause}`, params)) {
    const key = row.linked_merchant_key || merchantKey(row.scheme_name);
    if (key) {
      index.set(key, {
        kind: 'sip', id: row.id, name: row.scheme_name, amount: number(row.monthly_amount),
      });
    }
  }
  for (const row of db.all(`SELECT * FROM subscriptions${clause}`, params)) {
    const key = row.linked_merchant_key || merchantKey(row.name);
    if (key) {
      index.set(key, {
        kind: 'subscription', id: row.id, name: row.name, amount: number(row.cost),
      });
    }
  }
  return index;
}

/* ---------------------------------------------------------------- tracking */

/**
 * Files a detected commitment as a real record.
 *
 * The levels come across too, so a plan that has already been through two price rises
 * arrives with those rises on its history rather than as a figure with no past.
 */
export function trackRecurring(db, args = {}) {
  const kind = args.kind === 'sip' ? 'sip' : 'subscription';
  const name = String(args.name ?? '').trim();
  const amount = number(args.amount);
  const key = String(args.merchant_key ?? '').trim() || merchantKey(name);

  if (!name) return fail('NAME_REQUIRED', 'A commitment needs a name.');
  if (!(amount > 0)) return fail('AMOUNT_INVALID', 'A commitment needs an amount above zero.');

  const memberId = resolveMember(db, args.member_id);
  const changes = Array.isArray(args.changes) ? args.changes : [];
  let recordId;

  if (kind === 'sip') {
    recordId = db.run(
      'INSERT INTO sips (member_id, scheme_name, monthly_amount, debit_day, step_up_percent,'
      + ' is_active, start_date, step_up_month, linked_merchant_key)'
      + ' VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
      [memberId, name, amount,
        Math.max(1, Math.min(28, Number.parseInt(args.day_of_month ?? 5, 10) || 5)),
        number(args.step_up_percent), String(args.start_date || args.first_seen || today()),
        Number.parseInt(args.step_up_month ?? 0, 10) || 0, key],
    ).lastInsertRowid;
  } else {
    const cycle = CYCLE_MONTHS[args.billing_cycle] ? args.billing_cycle : 'Monthly';
    recordId = db.run(
      'INSERT INTO subscriptions (member_id, name, cost, billing_cycle, next_billing_date,'
      + ' category, auto_debit, annual_change_percent, price_since, linked_merchant_key)'
      + ' VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      [memberId, name, amount, cycle, String(args.next_due || today()),
        String(args.category || 'Subscriptions'), number(args.annual_change_percent),
        String(args.price_since || args.last_seen || today()), key],
    ).lastInsertRowid;
  }

  for (const change of changes) {
    const before = number(change.from);
    const after = number(change.to);
    if (!(after > 0) || !(before > 0)) continue;
    db.run(
      'INSERT INTO price_changes (kind, record_id, date, from_amount, to_amount, source, note)'
      + " VALUES (?, ?, ?, ?, ?, 'detected', ?)",
      [kind, recordId, String(change.date || today()), before, after,
        'Read from the transactions that were already recorded.'],
    );
  }

  return { kind, record_id: recordId, changes_recorded: changes.length };
}

/** The member a write belongs to, without assuming the household starts at one. */
function resolveMember(db, requested) {
  const wanted = Number.parseInt(requested, 10);
  if (Number.isFinite(wanted)) {
    const match = db.get('SELECT id FROM family_members WHERE id = ?', [wanted]);
    if (match) return match.id;
  }
  const primary = db.get('SELECT id FROM family_members ORDER BY is_primary DESC, id ASC LIMIT 1');
  return primary ? primary.id : null;
}

/** Stops offering a vendor as a commitment. Reversible, which is why it is a row. */
export function dismissRecurring(db, args = {}) {
  const key = String(args.merchant_key ?? '').trim();
  if (!key) return fail('MERCHANT_UNKNOWN', 'Which vendor was not given.');

  if (args.restore) {
    db.run('DELETE FROM recurring_dismissed WHERE merchant_key = ?', [key]);
    return { merchant_key: key, dismissed: false };
  }

  db.run(
    'INSERT OR REPLACE INTO recurring_dismissed (merchant_key, kind, dismissed_at)'
    + ' VALUES (?, ?, ?)',
    [key, String(args.kind || ''), today()],
  );
  return { merchant_key: key, dismissed: true };
}

/* ------------------------------------------------------- price rises and dips */

/**
 * Records that something now costs what it now costs.
 *
 * The old figure is kept rather than overwritten, so a year later the app can say what a
 * plan cost when it was taken out and what has happened to it since. That history is also
 * what the yearly rate of change is worked out from, which is how a projection knows a
 * streaming plan rises and a mandate does not.
 */
export function applyPriceChange(db, args = {}) {
  const kind = args.kind === 'sip' ? 'sip' : 'subscription';
  const id = Number.parseInt(args.record_id, 10);
  const amount = number(args.amount);
  const date = String(args.date || today());

  if (!Number.isFinite(id) || id <= 0) return fail('BAD_REQUEST', 'Which record was not given.');
  if (!(amount > 0)) return fail('AMOUNT_INVALID', 'A new price must be above zero.');

  const table = kind === 'sip' ? 'sips' : 'subscriptions';
  const column = kind === 'sip' ? 'monthly_amount' : 'cost';
  const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!row) return fail('BAD_REQUEST', 'That record no longer exists.');

  const before = number(row[column]);
  if (Math.abs(before - amount) < 0.005) {
    return { kind, record_id: id, unchanged: true, amount };
  }

  db.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [amount, id]);
  if (kind === 'subscription') {
    db.run('UPDATE subscriptions SET price_since = ? WHERE id = ?', [date, id]);
  }
  db.run(
    'INSERT INTO price_changes (kind, record_id, date, from_amount, to_amount, source, note)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    [kind, id, date, before, amount, String(args.source || 'user'), String(args.note || '')],
  );

  return {
    kind,
    record_id: id,
    from_amount: before,
    to_amount: amount,
    percent: before > 0 ? Math.round(((amount - before) / before) * 1000) / 10 : 0,
  };
}

/** Everything recorded about what one commitment has cost over time. */
export function getPriceHistory(db, args = {}) {
  const kind = args.kind === 'sip' ? 'sip' : 'subscription';
  const id = Number.parseInt(args.record_id, 10);
  if (!Number.isFinite(id)) return fail('BAD_REQUEST', 'Which record was not given.');

  const changes = db.all(
    'SELECT * FROM price_changes WHERE kind = ? AND record_id = ? ORDER BY date ASC, id ASC',
    [kind, id],
  );
  const rises = changes.filter((row) => number(row.to_amount) > number(row.from_amount));

  return {
    kind,
    record_id: id,
    changes,
    first_amount: changes.length ? number(changes[0].from_amount) : 0,
    current_amount: changes.length ? number(changes[changes.length - 1].to_amount) : 0,
    rises: rises.length,
    dips: changes.length - rises.length,
  };
}

/* --------------------------------------------------------------- projection */

/**
 * What a commitment costs on a given date, with its step-up applied.
 *
 * A SIP stepped up ten percent a year is not one figure, and neither is a plan that rises
 * with inflation. Both are a base amount, a rate, and the number of anniversaries between
 * then and now, so both are the same arithmetic. A negative rate steps down, which is what
 * somebody winding an instalment back down wants, and the result never goes below zero.
 */
export function steppedAmount(kind, record, onDate) {
  const base = number(kind === 'sip' ? record.monthly_amount : record.cost);
  const rate = number(kind === 'sip' ? record.step_up_percent : record.annual_change_percent);
  if (!base || !rate) return base;

  const since = parseISO(kind === 'sip'
    ? (record.start_date || record.created_at)
    : (record.price_since || record.next_billing_date));
  const target = parseISO(onDate);
  if (!since || !target || target <= since) return base;

  const stepMonth = Number.parseInt(record.step_up_month ?? 0, 10) || 0;
  let steps;
  if (kind === 'sip' && stepMonth >= 1 && stepMonth <= 12) {
    // A step-up pinned to a calendar month, which is how a mandate written to rise every
    // April behaves. Count the Aprils strictly after the start.
    steps = 0;
    let year = since.getFullYear();
    if (since.getMonth() + 1 >= stepMonth) year += 1;
    while (new Date(year, stepMonth - 1, 1) <= target) {
      steps += 1;
      year += 1;
    }
  } else {
    const months = (target.getFullYear() - since.getFullYear()) * 12
      + (target.getMonth() - since.getMonth());
    steps = Math.floor(months / 12);
  }

  if (steps <= 0) return base;
  const stepped = base * ((1 + rate / 100) ** steps);
  return Math.max(0, Math.round(stepped * 100) / 100);
}

/**
 * What the next months look like, with every step-up already applied.
 *
 * The point is the shape rather than the total: a household that has stepped up three SIPs
 * ten percent a year has agreed to a number nobody has added up, and this is what adds it
 * up. EMIs are included because they are the other thing that leaves on a schedule, and
 * leaving them out would make the total look affordable.
 */
export function projectCommitments(db, args = {}) {
  const months = Math.max(3, Math.min(60, Number.parseInt(args.months ?? 12, 10) || 12));
  const [clause, params] = memberClause(args.member_id);
  const start = parseISO(today());

  const buckets = [];
  for (let i = 0; i < months; i += 1) {
    const date = addMonths(new Date(start.getFullYear(), start.getMonth(), 1), i);
    buckets.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
  }
  const slotFor = (key) => buckets.indexOf(key);
  const blank = () => buckets.map(() => 0);
  const monthKeyOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

  const sips = blank();
  const subscriptions = blank();
  const emis = blank();
  const items = [];

  for (const row of db.all(
    `SELECT * FROM sips${clause}${clause ? ' AND' : ' WHERE'} is_active = 1`, params,
  )) {
    const amounts = buckets.map((key, i) => {
      const date = addMonths(new Date(start.getFullYear(), start.getMonth(), 1), i);
      const day = Math.max(1, Math.min(28, Number.parseInt(row.debit_day ?? 1, 10) || 1));
      const on = isoDate(new Date(date.getFullYear(), date.getMonth(), day));
      return steppedAmount('sip', row, on);
    });
    amounts.forEach((value, i) => { sips[i] += value; });
    items.push(describe('sip', row.id, row.scheme_name, amounts, 'Monthly',
      number(row.step_up_percent)));
  }

  for (const row of db.all(`SELECT * FROM subscriptions${clause}`, params)) {
    const step = CYCLE_MONTHS[row.billing_cycle] || 1;
    const amounts = blank();
    let due = parseISO(row.next_billing_date) || start;

    // A next billing date that has already gone by is walked forward first, so a plan
    // nobody has opened the app to confirm for six months still lands in the right months.
    let guard = 0;
    while (monthKeyOf(due) < buckets[0] && guard < 240) {
      due = addMonths(due, step);
      guard += 1;
    }
    while (monthKeyOf(due) <= buckets[buckets.length - 1] && guard < 240) {
      const slot = slotFor(monthKeyOf(due));
      if (slot >= 0) amounts[slot] += steppedAmount('subscription', row, isoDate(due));
      due = addMonths(due, step);
      guard += 1;
    }
    amounts.forEach((value, i) => { subscriptions[i] += value; });
    items.push(describe('subscription', row.id, row.name, amounts, row.billing_cycle,
      number(row.annual_change_percent)));
  }

  for (const row of db.all(
    `SELECT * FROM loans${clause}${clause ? ' AND' : ' WHERE'} COALESCE(direction, 'borrowed') != 'lent'`,
    params,
  )) {
    const emi = number(row.monthly_emi);
    if (!emi) continue;
    for (let i = 0; i < emis.length; i += 1) emis[i] += emi;
    items.push(describe('loan', row.id, row.name, buckets.map(() => emi), 'Monthly', 0));
  }

  const series = [
    { key: 'sips', label: 'SIPs', color: '#14B8A6', values: sips },
    { key: 'subscriptions', label: 'Subscriptions', color: '#8B5CF6', values: subscriptions },
    { key: 'emis', label: 'EMIs', color: '#F59E0B', values: emis },
  ].filter((entry) => entry.values.some(Boolean));

  const monthlyTotals = buckets.map((_, i) => sips[i] + subscriptions[i] + emis[i]);

  return {
    buckets,
    series,
    stacked: true,
    months,
    monthly_totals: monthlyTotals,
    first_month: monthlyTotals[0] || 0,
    last_month: monthlyTotals[monthlyTotals.length - 1] || 0,
    year_total: monthlyTotals.slice(0, 12).reduce((sum, value) => sum + value, 0),
    items: items.sort((a, b) => b.total - a.total),
  };
}

function describe(kind, id, name, amounts, cycle, changePercent) {
  const paid = amounts.filter(Boolean);
  return {
    kind,
    id,
    name,
    cycle,
    change_percent: changePercent,
    first_amount: paid.length ? paid[0] : 0,
    last_amount: paid.length ? paid[paid.length - 1] : 0,
    total: amounts.reduce((sum, value) => sum + value, 0),
  };
}
