import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { call, freshBackend, ok } from './_harness.mjs';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

const today = new Date().toISOString().slice(0, 10);

describe('goals_habits.js: No-Spend Days, Monthly Wrapped, Life Goals, Challenges & Local Sync', () => {
  it('calculates No-Spend Days and streak counts', async (t) => {
    // Save spend on today
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 250, category: 'Groceries', type: 'Expense', merchant: 'Store' },
    });

    const noSpend = await ok(t, 'get_no_spend_days', {});
    assert.equal(noSpend.status, 'success');
    assert.equal(typeof noSpend.no_spend_days_count, 'number');
    assert.equal(typeof noSpend.current_streak, 'number');
    assert.ok(noSpend.days.length > 0);
  });

  it('generates Monthly Finance Wrapped (Money Story) slides', async (t) => {
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 75000, category: 'Salary', type: 'Income', merchant: 'Employer' },
    });
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 15000, category: 'Rent', type: 'Expense', merchant: 'Landlord' },
    });

    const wrapped = await ok(t, 'get_monthly_wrapped', { month_offset: 0 });
    assert.equal(wrapped.status, 'success');
    assert.equal(wrapped.slides.length, 4);
    assert.equal(wrapped.slides[0].id, 'overview');
  });

  it('calculates Life Goals timeline and required monthly SIP', async (t) => {
    const goalsRes = await ok(t, 'get_life_goals', {
      goals: [
        { name: 'House Downpayment', target_amount: 3000000, current_accumulated: 1000000, target_year: 2030 },
        { name: 'New Electric Car', target_amount: 1500000, current_accumulated: 200000, target_year: 2028 },
      ],
      expected_cagr: 12,
    });

    assert.equal(goalsRes.status, 'success');
    assert.equal(goalsRes.goals_count, 2);
    assert.ok(goalsRes.total_monthly_sip_needed > 0);
    assert.ok(goalsRes.goals[0].required_monthly_sip > 0);
  });

  it('evaluates 30-day spending challenge rules', async (t) => {
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 1200, category: 'Dining', type: 'Expense', merchant: 'Restaurant' },
    });

    const challengeRes = await ok(t, 'evaluate_challenge', {
      challenge: {
        name: 'No Dining Out in August',
        start_date: today,
        restricted_category: 'Dining',
      },
    });

    assert.equal(challengeRes.status, 'success');
    assert.equal(challengeRes.total_breaches, 1);
    assert.equal(challengeRes.is_passing, false);
  });

  it('generates local encrypted differential sync bundle', async (t) => {
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'Emergency Bank', category: 'Bank', balance: 100000 },
    });

    const sync = await ok(t, 'get_local_sync_payload', {});
    assert.equal(sync.status, 'success');
    assert.ok(sync.sync_bundle.accounts.length >= 1);
    assert.ok(sync.payload_size_bytes > 0);
  });
});
