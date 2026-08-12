import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, ok, call, monthsAgo } from './_harness.mjs';
import {
  normaliseGranularity, bucketKeys, windowRange,
} from '../app/src/main/assets/www/js/backend/periods.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('periods.js period calculation', () => {
  it('normalises granularity with fallbacks', () => {
    assert.equal(normaliseGranularity('day'), 'day');
    assert.equal(normaliseGranularity('days'), 'day');
    assert.equal(normaliseGranularity('week'), 'week');
    assert.equal(normaliseGranularity('weeks'), 'week');
    assert.equal(normaliseGranularity('month'), 'month');
    assert.equal(normaliseGranularity('months'), 'month');
    assert.equal(normaliseGranularity('unknown'), null);
  });

  it('computes bucketKeys and windowRanges', () => {
    const bucketsMonth = bucketKeys('month', 6, 0);
    assert.equal(bucketsMonth.length, 6);
    const rangeMonth = windowRange('month', bucketsMonth);
    assert.equal(rangeMonth.length, 2);
    assert.ok(rangeMonth[0] < rangeMonth[1]);

    const bucketsWeek = bucketKeys('week', 8, 0);
    assert.equal(bucketsWeek.length, 8);
    const rangeWeek = windowRange('week', bucketsWeek);
    assert.equal(rangeWeek.length, 2);

    const bucketsDay = bucketKeys('day', 30, 0);
    assert.equal(bucketsDay.length, 30);
    const rangeDay = windowRange('day', bucketsDay);
    assert.equal(rangeDay.length, 2);
  });
});

describe('analytics.js metric and breakdown coverage', () => {
  it('computes all breakdown dimensions (category, merchant, member, weekday)', async () => {
    const today = monthsAgo(0);
    await ok(null, 'save_transaction', {
      transaction: { date: today, amount: 1500, category: 'Food & Dining', type: 'Expense', merchant: 'Swiggy' },
    });
    await ok(null, 'save_transaction', {
      transaction: { date: today, amount: 800, category: 'Transportation', type: 'Expense', merchant: 'Uber' },
    });
    await ok(null, 'save_transaction', {
      transaction: { date: today, amount: 50000, category: 'Salary', type: 'Income', merchant: 'Company' },
    });

    const catBreakdown = await ok(null, 'get_breakdown', { dimension: 'category' });
    assert.equal(catBreakdown.status, 'success');
    assert.ok(catBreakdown.rows.length > 0);

    const merBreakdown = await ok(null, 'get_breakdown', { dimension: 'merchant' });
    assert.equal(merBreakdown.status, 'success');
    assert.ok(merBreakdown.rows.length > 0);

    const memBreakdown = await ok(null, 'get_breakdown', { dimension: 'member' });
    assert.equal(memBreakdown.status, 'success');

    const dayBreakdown = await ok(null, 'get_breakdown', { dimension: 'weekday' });
    assert.equal(dayBreakdown.status, 'success');
  });

  it('computes all series metrics across periods', async () => {
    const metrics = [
      'income_expense',
      'spend_total',
      'net_flow',
      'spend_by_category',
      'spend_by_merchant',
      'spend_by_member',
      'cumulative_savings',
    ];

    for (const metric of metrics) {
      const res = await ok(null, 'get_series', {
        metric,
        granularity: 'month',
        periods: 4,
      });
      assert.equal(res.status, 'success', `failed metric ${metric}`);
      assert.equal(res.buckets.length, 4);
    }
  });

  it('computes period summaries and delta comparisons', async () => {
    const today = monthsAgo(0);
    const summary = await ok(null, 'get_period_summary', {
      granularity: 'month',
      bucket: today.slice(0, 7),
    });
    assert.equal(summary.status, 'success');
    assert.equal(typeof summary.expense, 'number');
    assert.equal(typeof summary.income, 'number');
    assert.ok(summary.savings_rate === null || typeof summary.savings_rate === 'number');
  });

  it('handles range resolution edge cases and filtered series', async () => {
    const today = monthsAgo(0);
    // Filtered by category and merchant
    const filtered = await ok(null, 'get_series', {
      metric: 'spend_total',
      granularity: 'month',
      category: 'Food & Dining',
      merchant: 'Swiggy',
      member_id: 1,
    });
    assert.equal(filtered.status, 'success');

    // Invalid granularity error
    const err = await call('get_period_summary', {
      granularity: 'invalid_granularity',
    });
    assert.equal(err.status, 'error');
    assert.equal(err.code, 'GRANULARITY_UNKNOWN');
  });
});
