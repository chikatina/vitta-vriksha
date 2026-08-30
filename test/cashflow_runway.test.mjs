import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { call, freshBackend, monthsAgo, ok } from './_harness.mjs';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

const today = new Date().toISOString().slice(0, 10);

describe('cashflow.js: Safe-to-Spend, Runway, Salary Checklist & Weekend Analysis', () => {
  it('calculates Safe-to-Spend allowance after subtracting locked commitments', async (t) => {
    // 1. Setup liquid asset account (Savings bank: 50,000)
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'HDFC Savings', category: 'Bank', balance: 50000 },
    });

    // 2. Setup loan with monthly EMI (10,000)
    await ok(t, 'save_record', {
      table: 'loans',
      record: {
        name: 'Car Loan',
        principal: 500000,
        current_outstanding: 300000,
        interest_rate: 9.0,
        monthly_emi: 10000,
        direction: 'borrowed',
      },
    });

    // 3. Setup active SIP (5,000)
    await ok(t, 'save_record', {
      table: 'sips',
      record: {
        fund_name: 'Parag Parikh Flexi Cap',
        monthly_amount: 5000,
        debit_day: 10,
        is_active: 1,
      },
    });

    // 4. Setup Credit Card balance (8,000)
    await ok(t, 'save_record', {
      table: 'credit_cards',
      record: {
        card_name: 'ICICI Amazon Pay',
        credit_limit: 100000,
        current_balance: 8000,
        due_day: 20,
      },
    });

    // 5. Setup recurring subscription (1,000)
    await ok(t, 'save_record', {
      table: 'recurring_items',
      record: {
        name: 'Broadband Bill',
        amount: 1000,
        frequency: 'monthly',
        is_active: 1,
        type: 'expense',
      },
    });

    const res = await ok(t, 'get_safe_to_spend', {});
    assert.equal(res.status, 'success');
    assert.equal(res.liquid_balance, 50000);
    // Locked commitments: 10000 (loan) + 5000 (SIP) + 8000 (CC) + 1000 (recurring) = 24,000
    assert.equal(res.locked_commitments, 24000);
    // Safe to spend: 50,000 - 24,000 = 26,000
    assert.equal(res.safe_to_spend_total, 26000);
    assert.ok(res.safe_to_spend_daily > 0);
    assert.ok(res.safe_to_spend_weekly > 0);
    assert.equal(res.health_status, 'healthy');
  });

  it('generates 30-day cashflow runway trajectory with low-balance flags', async (t) => {
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'Salary Account', category: 'Bank', balance: 30000 },
    });

    await ok(t, 'save_record', {
      table: 'sips',
      record: { fund_name: 'HDFC Mid Cap', monthly_amount: 5000, debit_day: 5, is_active: 1 },
    });

    const runway = await ok(t, 'get_cashflow_runway', {});
    assert.equal(runway.status, 'success');
    assert.equal(runway.starting_balance, 30000);
    assert.equal(runway.timeline.length, 30);
    assert.equal(typeof runway.is_runway_safe, 'boolean');
  });

  it('produces an actionable salary day checklist', async (t) => {
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'Bank Account', category: 'Bank', balance: 75000 },
    });

    // Record salary transaction
    await ok(t, 'save_transaction', {
      transaction: {
        date: today,
        amount: 85000,
        category: 'Salary',
        type: 'Income',
        merchant: 'Employer Corp',
      },
    });

    const checklist = await ok(t, 'get_salary_checklist', {});
    assert.equal(checklist.status, 'success');
    assert.ok(checklist.steps.length >= 5);
    assert.equal(checklist.latest_salary.amount, 85000);
  });

  it('analyzes Weekend vs Weekday spending intensity and top categories', async (t) => {
    // Record transactions on specific dates (both weekend and weekday)
    // 2026-08-01 was Saturday (weekend)
    await ok(t, 'save_transaction', {
      transaction: { date: '2026-08-01', amount: 3500, category: 'Dining', type: 'Expense', merchant: 'Fine Dine' },
    });
    // 2026-08-02 was Sunday (weekend)
    await ok(t, 'save_transaction', {
      transaction: { date: '2026-08-02', amount: 2500, category: 'Movies', type: 'Expense', merchant: 'Cinema' },
    });
    // 2026-08-03 was Monday (weekday)
    await ok(t, 'save_transaction', {
      transaction: { date: '2026-08-03', amount: 400, category: 'Groceries', type: 'Expense', merchant: 'Mart' },
    });
    // 2026-08-04 was Tuesday (weekday)
    await ok(t, 'save_transaction', {
      transaction: { date: '2026-08-04', amount: 600, category: 'Groceries', type: 'Expense', merchant: 'Supermarket' },
    });

    const analysis = await ok(t, 'get_weekend_spend_analysis', {});
    assert.equal(analysis.status, 'success');
    assert.equal(analysis.weekend.total, 6000);
    assert.equal(analysis.weekday.total, 1000);
    assert.ok(analysis.weekend.top_categories.length > 0);
    assert.equal(analysis.weekend.top_categories[0].category, 'Dining');
  });

  it('calculates custom runway using the EMI pattern for loan debt', async (t) => {
    // Liquid: 60,000
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'HDFC Savings', category: 'Bank', balance: 60000 },
    });

    // Fixed Deposit: 120,000
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'SBI Fixed Deposit', category: 'FD', balance: 120000 },
    });

    // Mutual Funds: 300,000
    await ok(t, 'save_record', {
      table: 'mf_folios',
      record: { folio_number: '12345/6', scheme_name: 'Nifty 50 Index Fund', current_value: 300000, invested_amount: 250000 },
    });

    // Loan: ₹5,00,000 principal, ₹10,000/month EMI (~₹329/day)
    await ok(t, 'save_record', {
      table: 'loans',
      record: {
        name: 'Car Loan',
        principal: 500000,
        current_outstanding: 400000,
        interest_rate: 9.0,
        monthly_emi: 10000,
        direction: 'borrowed',
      },
    });

    // Credit Card: ₹10,000 statement balance
    await ok(t, 'save_record', {
      table: 'credit_cards',
      record: { card_name: 'Axis Bank CC', credit_limit: 100000, current_balance: 10000, due_day: 15 },
    });

    // Daily living expense override: ₹1,000/day (= ₹30,416/month)
    const runway = await ok(t, 'get_custom_runway', {
      custom_daily_burn: 1000,
      subtract_liabilities: true,
    });

    assert.equal(runway.status, 'success');
    assert.equal(runway.daily_living_burn, 1000);
    assert.equal(runway.monthly_loan_emis, 10000);
    // Total monthly burn = 30,416 + 10,000 = 40,416 (~1329/day)
    assert.equal(runway.monthly_burn, 40416);
    assert.equal(runway.daily_burn, 1329);

    // Liquid funds = 60,000 - 10,000 (card dues) = 50,000
    // Liquid runway = 50,000 / 1329 ≈ 37 days (1.2 months)
    assert.equal(runway.tiers.liquid_only.net_amount, 50000);
    assert.equal(runway.tiers.liquid_only.runway_days, 37);
    assert.equal(runway.tiers.liquid_only.runway_months, 1.2);

    // Emergency pool = (60k + 120k) - 10k = 170,000
    // Emergency runway = 170,000 / 1329 ≈ 127 days (4.2 months)
    assert.equal(runway.tiers.emergency_pool.net_amount, 170000);
    assert.equal(runway.tiers.emergency_pool.runway_days, 127);
    assert.equal(runway.tiers.emergency_pool.runway_months, 4.2);

    // Investable = (60k + 120k + 300k) - 10k = 470,000
    // Investable runway = 470,000 / 1329 ≈ 353 days (11.6 months)
    assert.equal(runway.tiers.investable.net_amount, 470000);
    assert.equal(runway.tiers.investable.runway_days, 353);
    assert.equal(runway.tiers.investable.runway_months, 11.6);
  });
});
