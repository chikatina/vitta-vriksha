/*
 * The drilldown, the detector and the step-ups.
 *
 *     ./scripts/dev test
 *
 * These cover what the charts and the recurring-payment screen are drawn from: bucketing by
 * day, week and month, the breakdowns behind a tapped bar, and the arithmetic that says what
 * a stepped-up commitment will cost. Each test gets its own in-memory database.
 *
 * Dates are built relative to today, because everything here is "the last six months" and a
 * fixed date would start failing on its own six months after it was written.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { call, freshBackend, monthsAgo, ok } from './_harness.mjs';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

const pad = (value) => String(value).padStart(2, '0');
const iso = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** A date `days` back from today. */
function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return iso(date);
}

const thisMonth = () => monthsAgo(0).slice(0, 7);

function spend(t, {
  date, amount, category = 'Groceries', merchant, description, investment,
}) {
  const shop = merchant !== undefined ? merchant : (category === 'Groceries' ? 'A supermarket' : `${category} Store`);
  return ok(t, 'save_transaction', {
    transaction: {
      date,
      amount,
      category,
      type: investment ? 'Investment' : 'Expense',
      merchant: shop,
      description: description || '',
      is_investment_outflow: investment ? 1 : 0,
    },
  });
}

describe('bucketing by day, week and month', () => {
  it('buckets the same money three ways', async (t) => {
    await spend(t, { date: daysAgo(1), amount: 300 });
    await spend(t, { date: daysAgo(2), amount: 700 });

    for (const granularity of ['day', 'week', 'month']) {
      const series = await ok(t, 'get_series', {
        metric: 'spend_total', granularity, periods: 8,
      });
      assert.equal(series.granularity, granularity);
      assert.equal(series.buckets.length, 8);
      const total = series.series[0].values.reduce((sum, value) => sum + value, 0);
      assert.equal(total, 1000, granularity);
    }
  });

  it('names a day bucket by its date and a month bucket by its month', async (t) => {
    const day = await ok(t, 'get_series', { metric: 'spend_total', granularity: 'day', periods: 3 });
    assert.match(day.buckets[2], /^\d{4}-\d{2}-\d{2}$/);

    const month = await ok(t, 'get_series', { metric: 'spend_total', granularity: 'month', periods: 3 });
    assert.match(month.buckets[2], /^\d{4}-\d{2}$/);
  });

  it('starts every week on a Monday', async (t) => {
    const weeks = await ok(t, 'get_series', { metric: 'spend_total', granularity: 'week', periods: 4 });
    for (const key of weeks.buckets) {
      const [year, month, dayOfMonth] = key.split('-').map(Number);
      assert.equal(new Date(year, month - 1, dayOfMonth).getDay(), 1, key);
    }
  });

  it('steps the window back by the offset', async (t) => {
    const now = await ok(t, 'get_series', { metric: 'spend_total', granularity: 'month', periods: 3 });
    const back = await ok(t, 'get_series', {
      metric: 'spend_total', granularity: 'month', periods: 3, offset: 2,
    });
    assert.equal(back.buckets[2], now.buckets[0]);
    assert.equal(back.offset, 2);
  });

  it('refuses a bucket size it does not have', async (t) => {
    const result = await call('get_series', { metric: 'spend_total', granularity: 'fortnight' });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'GRANULARITY_UNKNOWN');
    // Nothing is broken by the refusal.
    await ok(t, 'get_series', { metric: 'spend_total' });
  });

  /**
   * A running total that starts at nothing when the window opens is not a running total: it
   * says a household with a decade of history began saving six months ago.
   */
  it('carries earlier history into a running total', async (t) => {
    await ok(t, 'save_transaction', {
      transaction: {
        date: monthsAgo(10), amount: 50000, category: 'Salary', type: 'Income',
      },
    });
    await spend(t, { date: monthsAgo(1), amount: 1000 });

    const series = await ok(t, 'get_series', {
      metric: 'cumulative_savings', granularity: 'month', periods: 3,
    });
    // The income is outside the window, so only the carry-in can account for it.
    assert.equal(series.series[0].values[0], 50000);
    assert.equal(series.series[0].values.at(-1), 49000);
  });

  it('reports a rate as a percentage rather than as money', async (t) => {
    await ok(t, 'save_transaction', {
      transaction: { date: monthsAgo(0), amount: 100000, category: 'Salary', type: 'Income' },
    });
    await spend(t, { date: monthsAgo(0), amount: 40000 });

    const series = await ok(t, 'get_series', { metric: 'savings_rate', granularity: 'month', periods: 2 });
    assert.equal(series.unit, 'percent');
    assert.equal(Math.round(series.series[0].values.at(-1)), 60);
  });
});

describe('taking a period apart', () => {
  beforeEach(async (t) => {
    await spend(t, { date: monthsAgo(0), amount: 2000, category: 'Groceries', merchant: 'A supermarket' });
    await spend(t, { date: monthsAgo(0), amount: 500, category: 'Dining', merchant: 'A cafe' });
    await spend(t, { date: monthsAgo(0), amount: 250, category: 'Dining', merchant: 'A cafe' });
    await ok(t, 'save_transaction', {
      transaction: {
        date: monthsAgo(0), amount: 80000, category: 'Salary', type: 'Income', merchant: 'Work',
      },
    });
  });

  it('ranks the categories in a month and states each share', async (t) => {
    const breakdown = await ok(t, 'get_breakdown', {
      dimension: 'category', granularity: 'month', bucket: thisMonth(),
    });

    assert.equal(breakdown.total, 2750);
    assert.equal(breakdown.rows[0].label, 'Groceries');
    assert.equal(breakdown.rows[0].total, 2000);
    assert.equal(Math.round(breakdown.rows[0].share), 73);
    // Two visits to the cafe are one row of two entries.
    assert.equal(breakdown.rows[1].count, 2);
    assert.equal(breakdown.rows[1].average, 375);
  });

  it('keeps income out of a spending breakdown and finds it under its own flow', async (t) => {
    const spending = await ok(t, 'get_breakdown', { dimension: 'category', flow: 'spend' });
    assert.ok(!spending.rows.some((row) => row.label === 'Salary'));

    const income = await ok(t, 'get_breakdown', { dimension: 'category', flow: 'income' });
    assert.equal(income.total, 80000);
  });

  it('groups a shop without regard to case, and keeps the name it printed', async (t) => {
    await spend(t, { date: monthsAgo(0), amount: 100, merchant: 'A SUPERMARKET' });
    const breakdown = await ok(t, 'get_breakdown', { dimension: 'merchant' });
    const supermarket = breakdown.rows.find((row) => row.key === 'a supermarket');
    assert.equal(supermarket.total, 2100);
    assert.match(supermarket.label, /supermarket/i);
  });

  it('orders a day breakdown by date rather than by size', async (t) => {
    await spend(t, { date: daysAgo(0), amount: 10 });
    const breakdown = await ok(t, 'get_breakdown', { dimension: 'day' });
    const keys = breakdown.rows.map((row) => row.key);
    assert.deepEqual(keys, [...keys].sort());
  });

  it('names the weekdays', async (t) => {
    const breakdown = await ok(t, 'get_breakdown', { dimension: 'weekday' });
    for (const row of breakdown.rows) {
      assert.match(row.label, /day$/);
    }
  });

  it('refuses a dimension it does not have', async () => {
    const result = await call('get_breakdown', { dimension: 'phase of the moon' });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'DIMENSION_UNKNOWN');
  });

  it('refuses a range that ends before it starts', async () => {
    const result = await call('get_breakdown', {
      dimension: 'category', from: '2026-08-01', to: '2026-07-01',
    });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'RANGE_INVALID');
  });

  it('summarises a month and compares it with the month before', async (t) => {
    await spend(t, { date: monthsAgo(1), amount: 1000 });

    const summary = await ok(t, 'get_period_summary', {
      granularity: 'month', bucket: thisMonth(),
    });

    assert.equal(summary.expense, 2750);
    assert.equal(summary.income, 80000);
    assert.equal(summary.net, 77250);
    assert.equal(summary.top_category.name, 'Groceries');
    assert.equal(summary.biggest.amount, 2000);
    assert.equal(summary.previous.expense, 1000);
    assert.equal(Math.round(summary.change.expense), 175);
    assert.equal(Math.round(summary.savings_rate), 97);
  });

  it('reports no comparison rather than a made up one', async (t) => {
    const summary = await ok(t, 'get_period_summary', {
      granularity: 'month', bucket: thisMonth(),
    });
    assert.equal(summary.previous.expense, 0);
    assert.equal(summary.change.expense, null);
  });

  it('summarises one day as readily as one month', async (t) => {
    const summary = await ok(t, 'get_period_summary', {
      granularity: 'day', bucket: monthsAgo(0),
    });
    assert.equal(summary.days, 1);
    assert.equal(summary.expense, 2750);
  });
});

describe('the transaction filters behind a drilldown', () => {
  beforeEach(async (t) => {
    await spend(t, { date: monthsAgo(0), amount: 2000, category: 'Groceries', merchant: 'A supermarket' });
    await spend(t, { date: monthsAgo(2), amount: 300, category: 'Dining', merchant: 'A cafe' });
    await ok(t, 'save_transaction', {
      transaction: {
        date: monthsAgo(0), amount: 5000, category: 'Investment Outflow', type: 'Expense',
        is_investment_outflow: true, merchant: 'A fund',
      },
    });
  });

  it('narrows to a date range, exclusive at the end', async (t) => {
    const [from] = [monthsAgo(0).slice(0, 8)];
    const res = await ok(t, 'get_transactions', { from: `${from}01`, to: monthsAgo(0) });
    // The fifteenth is the upper bound, and the upper bound is not included.
    assert.equal(res.transactions.length, 0);
  });

  it('narrows by category, shop and flow', async (t) => {
    assert.equal((await ok(t, 'get_transactions', { category: 'Dining' })).count, 1);
    assert.equal((await ok(t, 'get_transactions', { merchant: 'a SUPERMARKET' })).count, 1);
    assert.equal((await ok(t, 'get_transactions', { flow: 'invest' })).count, 1);
    // An investment outflow is not spending, so it is left out of the spend flow.
    assert.equal((await ok(t, 'get_transactions', { flow: 'spend' })).count, 2);
  });

  it('totals what it returned', async (t) => {
    const res = await ok(t, 'get_transactions', { flow: 'spend' });
    assert.equal(res.totals.expense, 2300);
    assert.equal(res.capped, false);
  });

  it('searches the shop, the note and the category', async (t) => {
    assert.equal((await ok(t, 'get_transactions', { search: 'cafe' })).count, 1);
    assert.equal((await ok(t, 'get_transactions', { search: 'groc' })).count, 1);
  });

  it('says when a list was capped', async (t) => {
    const res = await ok(t, 'get_transactions', { limit: 1 });
    assert.equal(res.count, 1);
    assert.equal(res.capped, true);
  });
});

describe('finding the recurring payments', () => {
  /** A debit on the same day of the month, `count` months running. */
  async function monthly(t, {
    merchant, amount, count = 6, category = 'Entertainment', investment = false, amounts = null,
  }) {
    for (let back = count - 1; back >= 0; back -= 1) {
      await ok(t, 'save_transaction', {
        transaction: {
          date: monthsAgo(back),
          amount: amounts ? amounts[count - 1 - back] : amount,
          category,
          type: 'Expense',
          merchant,
          is_investment_outflow: investment,
        },
      });
    }
  }

  it('finds a monthly subscription and what it costs a year', async (t) => {
    await monthly(t, { merchant: 'A streaming service', amount: 199 });

    const found = await ok(t, 'find_recurring');
    const streaming = found.candidates.find((entry) => /streaming/i.test(entry.name));

    assert.ok(streaming, 'the subscription was not found');
    assert.equal(streaming.cadence, 'monthly');
    assert.equal(streaming.kind, 'subscription');
    assert.equal(streaming.amount, 199);
    assert.equal(streaming.yearly, 199 * 12);
    assert.equal(streaming.times, 6);
    assert.ok(streaming.next_due > monthsAgo(0));
  });

  it('calls an investment mandate a SIP rather than a subscription', async (t) => {
    await monthly(t, {
      merchant: 'An index fund', amount: 10000, category: 'Investment Outflow', investment: true,
    });
    const found = await ok(t, 'find_recurring');
    const sip = found.candidates.find((entry) => /index fund/i.test(entry.name));
    assert.equal(sip.kind, 'sip');
  });

  it('ignores a shop that is simply visited often', async (t) => {
    // Same shop, wildly different amounts, no rhythm to the dates.
    for (const [days, amount] of [[2, 340], [5, 1290], [9, 210], [11, 880], [17, 460]]) {
      await spend(t, { date: daysAgo(days), amount, merchant: 'A supermarket' });
    }
    const found = await ok(t, 'find_recurring');
    assert.ok(!found.candidates.some((entry) => /supermarket/i.test(entry.name)));
  });

  it('reads a price rise as one change rather than as noise', async (t) => {
    await monthly(t, {
      merchant: 'A streaming service',
      amounts: [149, 149, 149, 199, 199, 199],
    });

    const found = await ok(t, 'find_recurring');
    const streaming = found.candidates.find((entry) => /streaming/i.test(entry.name));

    assert.equal(streaming.amount, 199);
    assert.equal(streaming.first_amount, 149);
    assert.equal(streaming.changes.length, 1);
    assert.equal(streaming.changes[0].from, 149);
    assert.equal(streaming.changes[0].to, 199);
    assert.ok(streaming.changes[0].percent > 30);
    // Three months at the new price, so the yearly rate is an extrapolation upwards.
    assert.ok(streaming.annual_change_percent > 0);
  });

  it('treats a rupee of rounding as the same price', async (t) => {
    await monthly(t, {
      merchant: 'A phone plan',
      amounts: [299, 299.5, 299, 300, 299, 299],
    });
    const found = await ok(t, 'find_recurring');
    const plan = found.candidates.find((entry) => /phone plan/i.test(entry.name));
    assert.equal(plan.changes.length, 0);
  });

  it('sets a suggestion aside, and brings it back', async (t) => {
    await monthly(t, { merchant: 'A streaming service', amount: 199 });
    const key = (await ok(t, 'find_recurring')).candidates[0].merchant_key;

    await ok(t, 'dismiss_recurring', { merchant_key: key });
    const after = await ok(t, 'find_recurring');
    assert.equal(after.candidates.length, 0);
    assert.equal(after.dismissed.length, 1);

    await ok(t, 'dismiss_recurring', { merchant_key: key, restore: true });
    assert.equal((await ok(t, 'find_recurring')).candidates.length, 1);
  });

  it('files a candidate as a subscription, with its price history', async (t) => {
    await monthly(t, {
      merchant: 'A streaming service',
      amounts: [149, 149, 149, 199, 199, 199],
    });
    const candidate = (await ok(t, 'find_recurring')).candidates[0];

    const tracked = await ok(t, 'track_recurring', {
      kind: 'subscription',
      merchant_key: candidate.merchant_key,
      name: candidate.name,
      amount: candidate.amount,
      billing_cycle: 'Monthly',
      next_due: candidate.next_due,
      changes: candidate.changes,
      annual_change_percent: 12,
    });

    assert.equal(tracked.changes_recorded, 1);

    const records = await ok(t, 'list_records', { record_type: 'subscription' });
    assert.equal(records.records.length, 1);
    assert.equal(records.records[0].cost, 199);
    assert.equal(records.records[0].annual_change_percent, 12);
    assert.equal(records.records[0].linked_merchant_key, candidate.merchant_key);

    const history = await ok(t, 'get_price_history', {
      kind: 'subscription', record_id: tracked.record_id,
    });
    assert.equal(history.changes.length, 1);
    assert.equal(history.changes[0].source, 'detected');

    // Now that it is on file it is no longer offered, it is reported as tracked.
    const again = await ok(t, 'find_recurring');
    assert.equal(again.candidates.length, 0);
    assert.equal(again.tracked.length, 1);
    assert.equal(again.tracked[0].needs_update, false);
  });

  it('notices that a tracked price no longer matches what is debited', async (t) => {
    await monthly(t, {
      merchant: 'A streaming service',
      amounts: [149, 149, 149, 199, 199, 199],
    });
    const candidate = (await ok(t, 'find_recurring')).candidates[0];

    // Filed at the old price, as somebody who set it up a year ago would have.
    const tracked = await ok(t, 'track_recurring', {
      kind: 'subscription',
      merchant_key: candidate.merchant_key,
      name: candidate.name,
      amount: 149,
      billing_cycle: 'Monthly',
    });

    const found = await ok(t, 'find_recurring');
    assert.equal(found.tracked[0].needs_update, true);
    assert.equal(found.tracked[0].recorded_amount, 149);
    assert.ok(found.tracked[0].drift > 30);

    const applied = await ok(t, 'apply_price_change', {
      kind: 'subscription', record_id: tracked.record_id, amount: 199,
    });
    assert.equal(applied.from_amount, 149);
    assert.equal(applied.to_amount, 199);

    const settled = await ok(t, 'find_recurring');
    assert.equal(settled.tracked[0].needs_update, false);
  });

  it('keeps the old figure when a price changes', async (t) => {
    const record = await ok(t, 'save_record', {
      record_type: 'subscription',
      record: { name: 'A streaming service', cost: 149, next_billing_date: monthsAgo(0) },
    });

    await ok(t, 'apply_price_change', {
      kind: 'subscription', record_id: record.record_id, amount: 199, note: 'Renewal letter',
    });
    await ok(t, 'apply_price_change', {
      kind: 'subscription', record_id: record.record_id, amount: 249,
    });

    const history = await ok(t, 'get_price_history', {
      kind: 'subscription', record_id: record.record_id,
    });
    assert.equal(history.changes.length, 2);
    assert.equal(history.first_amount, 149);
    assert.equal(history.current_amount, 249);
    assert.equal(history.rises, 2);
  });

  it('says nothing changed rather than writing a change of zero', async (t) => {
    const record = await ok(t, 'save_record', {
      record_type: 'subscription',
      record: { name: 'A plan', cost: 199, next_billing_date: monthsAgo(0) },
    });
    const result = await ok(t, 'apply_price_change', {
      kind: 'subscription', record_id: record.record_id, amount: 199,
    });
    assert.equal(result.unchanged, true);
    assert.equal((await ok(t, 'get_price_history', {
      kind: 'subscription', record_id: record.record_id,
    })).changes.length, 0);
  });

  it('takes the price history with the plan when the plan is deleted', async (t) => {
    const record = await ok(t, 'save_record', {
      record_type: 'subscription',
      record: { name: 'A plan', cost: 199, next_billing_date: monthsAgo(0) },
    });
    await ok(t, 'apply_price_change', {
      kind: 'subscription', record_id: record.record_id, amount: 249,
    });
    await ok(t, 'delete_record', { record_type: 'subscription', record_id: record.record_id });

    const history = await ok(t, 'get_price_history', {
      kind: 'subscription', record_id: record.record_id,
    });
    assert.equal(history.changes.length, 0);
  });

  it('refuses a price of nothing', async () => {
    const result = await call('apply_price_change', {
      kind: 'subscription', record_id: 1, amount: 0,
    });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'AMOUNT_INVALID');
  });
});

describe('step-ups and step-downs', () => {
  /** A mandate that started `years` ago, so its anniversaries have already happened. */
  function sipStartedYearsAgo(years, extra = {}) {
    const start = new Date();
    start.setFullYear(start.getFullYear() - years);
    return {
      record_type: 'sip',
      record: {
        scheme_name: 'An index fund',
        monthly_amount: 10000,
        debit_day: 5,
        start_date: iso(start),
        is_active: 1,
        ...extra,
      },
    };
  }

  it('compounds a step-up once per anniversary', async (t) => {
    await ok(t, 'save_record', sipStartedYearsAgo(2, { step_up_percent: 10 }));

    const projection = await ok(t, 'project_commitments', { months: 12 });
    const sip = projection.items.find((item) => item.kind === 'sip');

    // Two anniversaries gone by, so 10000 has become 12100.
    assert.equal(Math.round(sip.first_amount), 12100);
    assert.equal(projection.buckets.length, 12);
  });

  it('raises the instalment again when the next anniversary falls inside the window', async (t) => {
    // Started eleven months ago, so the first anniversary is a month away.
    const start = new Date();
    start.setMonth(start.getMonth() - 11);
    await ok(t, 'save_record', {
      record_type: 'sip',
      record: {
        scheme_name: 'An index fund',
        monthly_amount: 10000,
        debit_day: 5,
        step_up_percent: 20,
        start_date: iso(start),
        is_active: 1,
      },
    });

    const projection = await ok(t, 'project_commitments', { months: 12 });
    const sip = projection.items.find((item) => item.kind === 'sip');
    assert.equal(Math.round(sip.first_amount), 10000);
    assert.equal(Math.round(sip.last_amount), 12000);
    assert.ok(projection.last_month > projection.first_month);
  });

  it('steps an instalment down when the rate is negative', async (t) => {
    await ok(t, 'save_record', sipStartedYearsAgo(1, { step_up_percent: -25 }));
    const projection = await ok(t, 'project_commitments', { months: 6 });
    const sip = projection.items.find((item) => item.kind === 'sip');
    assert.equal(Math.round(sip.first_amount), 7500);
  });

  it('leaves a mandate with no rate exactly where it is', async (t) => {
    await ok(t, 'save_record', sipStartedYearsAgo(5));
    const projection = await ok(t, 'project_commitments', { months: 12 });
    const sip = projection.items.find((item) => item.kind === 'sip');
    assert.equal(sip.first_amount, 10000);
    assert.equal(sip.last_amount, 10000);
  });

  it('pins a step-up to a calendar month when asked to', async (t) => {
    const start = new Date();
    start.setFullYear(start.getFullYear() - 3);
    start.setMonth(4); // May, so three Aprils have gone by since.
    start.setDate(10);

    await ok(t, 'save_record', {
      record_type: 'sip',
      record: {
        scheme_name: 'A stepped fund',
        monthly_amount: 1000,
        debit_day: 5,
        step_up_percent: 10,
        step_up_month: 4,
        start_date: iso(start),
        is_active: 1,
      },
    });

    const projection = await ok(t, 'project_commitments', { months: 3 });
    const sip = projection.items.find((item) => item.kind === 'sip');
    // Three April rises: 1000 -> 1331.
    assert.equal(Math.round(sip.first_amount), 1331);
  });

  it('applies a yearly rise to a subscription as well', async (t) => {
    const since = new Date();
    since.setFullYear(since.getFullYear() - 2);

    await ok(t, 'save_record', {
      record_type: 'subscription',
      record: {
        name: 'A streaming service',
        cost: 100,
        billing_cycle: 'Monthly',
        next_billing_date: monthsAgo(0),
        annual_change_percent: 10,
        price_since: iso(since),
      },
    });

    const projection = await ok(t, 'project_commitments', { months: 6 });
    const plan = projection.items.find((item) => item.kind === 'subscription');
    assert.equal(Math.round(plan.first_amount), 121);
  });

  it('bills a quarterly plan four times a year, not twelve', async (t) => {
    await ok(t, 'save_record', {
      record_type: 'subscription',
      record: {
        name: 'A quarterly plan',
        cost: 900,
        billing_cycle: 'Quarterly',
        next_billing_date: monthsAgo(0),
      },
    });

    const projection = await ok(t, 'project_commitments', { months: 12 });
    const plan = projection.items.find((item) => item.kind === 'subscription');
    assert.equal(plan.total, 3600);
  });

  it('counts the EMIs as commitments too', async (t) => {
    await ok(t, 'save_record', {
      record_type: 'loan',
      record: {
        name: 'Home loan',
        loan_type: 'Home',
        principal_amount: 5000000,
        current_outstanding: 4000000,
        interest_rate: 8.5,
        tenure_months: 240,
        monthly_emi: 43000,
        start_date: monthsAgo(24),
      },
    });

    const projection = await ok(t, 'project_commitments', { months: 12 });
    assert.ok(projection.series.some((entry) => entry.key === 'emis'));
    assert.equal(projection.year_total, 43000 * 12);
  });

  it('shows the stepped figure in what is coming up, not the original', async (t) => {
    await ok(t, 'save_record', sipStartedYearsAgo(2, { step_up_percent: 10 }));
    const upcoming = await ok(t, 'get_upcoming', { days: 40 });
    const sip = upcoming.upcoming.find((item) => item.kind === 'sip');
    assert.equal(Math.round(sip.amount), 12100);
    assert.match(sip.note, /stepped up/);
  });
});

describe('the investment drilldown', () => {
  /** Statement lines, which only ever arrive through an import. */
  function line(date, amount, units, scheme = 'An index fund') {
    db.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date,'
      + ' description, kind, amount, units, nav) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['12345', 'INF000000001', scheme, date, 'Purchase', 'purchase', amount, units, 100],
    );
  }

  it('charts what was bought and sold, at any granularity', async (t) => {
    line(monthsAgo(1), 5000, 50);
    line(monthsAgo(0), 5000, 45);
    line(monthsAgo(0), -2000, -18);

    const monthly = await ok(t, 'get_series', { metric: 'invest_flows', granularity: 'month', periods: 3 });
    const bought = monthly.series.find((entry) => entry.key === 'bought');
    const sold = monthly.series.find((entry) => entry.key === 'sold');
    assert.equal(bought.values.at(-1), 5000);
    assert.equal(sold.values.at(-1), 2000);

    const weekly = await ok(t, 'get_series', { metric: 'invest_flows', granularity: 'week', periods: 6 });
    assert.equal(weekly.granularity, 'week');
  });

  it('accumulates what is net in the funds', async (t) => {
    line(monthsAgo(2), 5000, 50);
    line(monthsAgo(1), 5000, 45);

    const series = await ok(t, 'get_series', {
      metric: 'invest_cumulative', granularity: 'month', periods: 3,
    });
    assert.equal(series.series[0].values.at(-1), 10000);
  });

  it('lists the statement lines behind one period', async (t) => {
    line(monthsAgo(0), 5000, 50);
    line(monthsAgo(0), -1000, -9, 'Another fund');
    line(monthsAgo(6), 9999, 90);

    const from = `${monthsAgo(0).slice(0, 8)}01`;
    const to = `${monthsAgo(0).slice(0, 8)}28`;
    const res = await ok(t, 'get_folio_transactions', { from, to });

    assert.equal(res.count, 2);
    assert.equal(res.bought, 5000);
    assert.equal(res.sold, 1000);
    assert.equal(res.net, 4000);
    assert.equal(res.schemes.length, 2);
  });

  it('narrows to one scheme', async (t) => {
    line(monthsAgo(0), 5000, 50);
    line(monthsAgo(0), 3000, 27, 'Another fund');
    const res = await ok(t, 'get_folio_transactions', { scheme_name: 'Another fund' });
    assert.equal(res.count, 1);
    assert.equal(res.bought, 3000);
  });
});

describe('the chart catalogue', () => {
  it('offers only metrics the backend can actually draw', async (t) => {
    const catalogue = await ok(t, 'get_chart_catalogue');
    assert.ok(catalogue.metrics.length > 5);
    assert.ok(catalogue.dimensions.length > 3);

    for (const metric of catalogue.metrics) {
      const result = await ok(t, 'get_series', { metric: metric.key, periods: 3 });
      assert.equal(result.buckets.length, 3, metric.key);
    }
    for (const dimension of catalogue.dimensions) {
      await ok(t, 'get_breakdown', { dimension: dimension.key });
    }
  });
});

describe('exclude_investments_from_expenses toggle', () => {
  it('keeps investments separate when setting is enabled ("1") and merges them when disabled ("0")', async (t) => {
    const today = monthsAgo(0);
    // Regular expense
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 2000, category: 'Groceries', type: 'Expense', merchant: 'Mart' },
    });
    // Investment outflow
    await ok(t, 'save_transaction', {
      transaction: {
        date: today, amount: 5000, category: 'SIP', type: 'Expense', merchant: 'Mutual Fund',
        is_investment_outflow: true,
      },
    });
    // Income
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 10000, category: 'Salary', type: 'Income', merchant: 'Employer' },
    });

    // Case 1: Exclude enabled (default / "1")
    await ok(t, 'update_setting', { key: 'exclude_investments_from_expenses', value: '1' });
    const summaryOn = await ok(t, 'get_period_summary', { granularity: 'month', bucket: today.slice(0, 7) });
    assert.equal(summaryOn.expense, 2000, 'expense should exclude investment outflow');
    assert.equal(summaryOn.invested, 5000, 'invested should report investment outflow');

    const spendSeriesOn = await ok(t, 'get_series', { metric: 'spend_total', granularity: 'month', periods: 2 });
    assert.equal(spendSeriesOn.series[0].values.at(-1), 2000, 'spend_total series should exclude investment outflow');

    const txsOn = await ok(t, 'get_transactions', { flow: 'spend' });
    assert.equal(txsOn.transactions.length, 1, 'spend transactions should only include regular expense');
    assert.equal(txsOn.totals.expense, 2000);

    const txsInvestOn = await ok(t, 'get_transactions', { flow: 'invest' });
    assert.equal(txsInvestOn.transactions.length, 1, 'invest flow should return investment outflow');
    assert.equal(txsInvestOn.totals.invested, 5000);

    // Case 2: Exclude disabled ("0")
    await ok(t, 'update_setting', { key: 'exclude_investments_from_expenses', value: '0' });
    const summaryOff = await ok(t, 'get_period_summary', { granularity: 'month', bucket: today.slice(0, 7) });
    assert.equal(summaryOff.expense, 7000, 'expense should include investment outflow');
    assert.equal(summaryOff.invested, 0, 'invested should be 0 when merged into expenses');

    const spendSeriesOff = await ok(t, 'get_series', { metric: 'spend_total', granularity: 'month', periods: 2 });
    assert.equal(spendSeriesOff.series[0].values.at(-1), 7000, 'spend_total series should include investment outflow');

    const txsOff = await ok(t, 'get_transactions', { flow: 'spend' });
    assert.equal(txsOff.transactions.length, 2, 'spend transactions should include investment outflows');
    assert.equal(txsOff.totals.expense, 7000);
  });

  it('detects category spending spikes and warning trends', async (t) => {
    // Past 3 months: Dining ~ 2,000/mo, Groceries ~ 5,000/mo
    for (let offset = 1; offset <= 3; offset += 1) {
      await spend(t, { date: monthsAgo(offset), amount: 2000, category: 'Dining' });
      await spend(t, { date: monthsAgo(offset), amount: 5000, category: 'Groceries' });
    }

    // Current month: Dining spikes to 6,000 (3x average!), Groceries normal at 5,200
    await spend(t, { date: monthsAgo(0), amount: 6000, category: 'Dining' });
    await spend(t, { date: monthsAgo(0), amount: 5200, category: 'Groceries' });

    const res = await ok(t, 'get_spending_anomalies', {});
    assert.equal(res.status, 'success');
    assert.ok(res.anomalies.length > 0);

    const diningAnomaly = res.anomalies.find((a) => a.category === 'Dining');
    assert.ok(diningAnomaly, 'Dining should be flagged as an anomaly');
    assert.equal(diningAnomaly.current, 6000);
    assert.equal(diningAnomaly.average_3m, 2000);
    assert.equal(diningAnomaly.ratio, 3.0);
    assert.equal(diningAnomaly.excess_amount, 4000);
    assert.equal(diningAnomaly.severity, 'spike');

    const groceriesAnomaly = res.anomalies.find((a) => a.category === 'Groceries');
    assert.ok(!groceriesAnomaly, 'Groceries should NOT be flagged as an anomaly (within normal range)');
  });

  it('strictly isolates transfers and credit card payments from spends and investments', async (t) => {
    const today = monthsAgo(0);
    // 1. Regular expense
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 2500, category: 'Groceries', type: 'Expense', merchant: 'Supermarket' },
    });
    // 2. Credit Card Bill payment (Transfer)
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 15000, category: 'Credit Card', type: 'Transfer', merchant: 'HDFC CC Payment' },
    });
    // 3. Demat transfer (Transfer)
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 10000, category: 'Transfer', type: 'Transfer', merchant: 'Zerodha Funds' },
    });
    // 4. SIP Investment (Investment)
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 5000, category: 'Mutual Funds', type: 'Investment', is_investment_outflow: 1, merchant: 'Nippon India MF' },
    });
    // 5. Salary Income (Income)
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 50000, category: 'Salary', type: 'Income', merchant: 'Employer' },
    });

    const summary = await ok(t, 'get_period_summary', { granularity: 'month', bucket: today.slice(0, 7) });
    assert.equal(summary.expense, 2500, 'Expense should only be regular spend of 2,500');
    assert.equal(summary.invested, 5000, 'Invested should be 5,000');
    assert.equal(summary.transferred, 25000, 'Transferred should be 25,000 (15,000 CC + 10,000 Demat)');
    assert.equal(summary.income, 50000, 'Income should be 50,000');
    assert.equal(summary.net, 42500, 'Net kept should be 50,000 - 2,500 - 5,000 = 42,500');

    // Spend breakdown
    const spendBreakdown = await ok(t, 'get_breakdown', { granularity: 'month', bucket: today.slice(0, 7), flow: 'spend' });
    assert.equal(spendBreakdown.total, 2500, 'Spend breakdown total must not include transfers or investments');

    // Transfer breakdown
    const transferBreakdown = await ok(t, 'get_breakdown', { granularity: 'month', bucket: today.slice(0, 7), flow: 'transfer' });
    assert.equal(transferBreakdown.total, 25000, 'Transfer breakdown total must be 25,000');

    // Investment breakdown
    const investBreakdown = await ok(t, 'get_breakdown', { granularity: 'month', bucket: today.slice(0, 7), flow: 'invest' });
    assert.equal(investBreakdown.total, 5000, 'Invest breakdown total must be 5,000');
  });

  it('discovers SIPs from folio transactions and bank mandate descriptions', async (t) => {
    // 1. Insert 3 monthly folio purchases (CAS import)
    for (const m of [3, 2, 1]) {
      db.run(
        'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, amount, units, kind)'
        + " VALUES (1, '12345/67', 'INF109K012R6', 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth', ?, 5000, 75.5, 'purchase')",
        [monthsAgo(m)],
      );
    }

    // 2. Insert 3 monthly bank mandate debits with description
    for (const m of [3, 2, 1]) {
      await spend(t, {
        date: monthsAgo(m),
        amount: 2500,
        merchant: '',
        description: 'ACH DEBIT BSE STAR MF SIP 1029384',
        category: 'Mutual Funds',
        investment: true,
      });
    }

    const found = await ok(t, 'find_recurring');
    const ppfasSip = found.candidates.find((c) => /Parag Parikh/i.test(c.name));
    assert.ok(ppfasSip, 'Parag Parikh SIP from folio_transactions should be discovered');
    assert.equal(ppfasSip.kind, 'sip');
    assert.equal(ppfasSip.amount, 5000);
    assert.equal(ppfasSip.cadence, 'monthly');

    const bseSip = found.candidates.find((c) => /BSE STAR MF/i.test(c.name));
    assert.ok(bseSip, 'BSE STAR MF SIP from bank description should be discovered');
    assert.equal(bseSip.kind, 'sip');
    assert.equal(bseSip.amount, 2500);
    assert.equal(bseSip.cadence, 'monthly');
  });

  it('guarantees valid color on every breakdown row across all dimensions', async (t) => {
    await spend(t, { date: '2026-08-05', amount: 500, merchant: 'Amazon', category: 'Shopping' });
    await spend(t, { date: '2026-08-10', amount: 800, merchant: 'Swiggy', category: 'Dining' });

    for (const dim of ['category', 'merchant', 'weekday', 'type']) {
      const res = await ok(t, 'get_breakdown', { dimension: dim, granularity: 'month', bucket: '2026-08' });
      assert.ok(res.rows.length > 0, `Dimension ${dim} should have rows`);
      for (const row of res.rows) {
        assert.ok(row.color, `Row ${row.label} in dimension ${dim} must have a valid color`);
        assert.ok(typeof row.color === 'string' && row.color.length > 0);
      }
    }
  });

  it('isolates daily transfer breakdowns strictly to the specified month', async (t) => {
    // July transfer
    await ok(t, 'save_transaction', {
      transaction: { date: '2026-07-15', amount: 15000, category: 'Transfer', type: 'Transfer', merchant: 'Self' },
    });
    // August transfer
    await ok(t, 'save_transaction', {
      transaction: { date: '2026-08-12', amount: 8000, category: 'Transfer', type: 'Transfer', merchant: 'Self' },
    });

    const res = await ok(t, 'get_breakdown', {
      dimension: 'day',
      granularity: 'month',
      bucket: '2026-08',
      flow: 'transfer',
    });

    assert.equal(res.status, 'success');
    assert.equal(res.total, 8000, 'August transfer breakdown must strictly equal 8,000');
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].key, '2026-08-12');
  });
});


