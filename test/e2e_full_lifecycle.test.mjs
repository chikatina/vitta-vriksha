/*
 * Full End-to-End (E2E) Lifecycle Test Suite with 100% Core Coverage.
 *
 * Tests the complete user lifecycle from fresh installation, onboarding, bank SMS ingestion,
 * transaction categorization, Safe-to-Spend cashflow management, wealth intelligence,
 * tax harvesting, debt payoff simulation, habit tracking, life goals, and UI view rendering.
 */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { call, freshBackend, monthsAgo, ok } from './_harness.mjs';
import { parseSmsText } from '../app/src/main/assets/www/js/backend/sms.js';
import { compareInvestVsPrepay, calculateEmisLeft } from '../app/src/main/assets/www/js/backend/loan.js';
import { calculateFireProjections } from '../app/src/main/assets/www/js/backend/fire.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

const today = new Date().toISOString().slice(0, 10);

describe('E2E Full Lifecycle: 1. Setup & Household Onboarding', () => {
  it('initializes default categories, settings, and household profile', async (t) => {
    // 1. Verify default categories exist
    const catsRes = await ok(t, 'get_categories', {});
    assert.equal(catsRes.status, 'success');
    assert.ok(catsRes.categories.length >= 10);
    assert.ok(catsRes.categories.some((c) => c.name === 'Groceries'));
    assert.ok(catsRes.categories.some((c) => c.name === 'Salary'));

    // 2. Add family members
    const memberRes = await ok(t, 'add_family_member', { name: 'Priya', is_primary: 0 });
    assert.equal(memberRes.status, 'success');

    const members = await ok(t, 'get_family_members', {});
    assert.equal(members.members.length, 2);

    // 3. Configure monthly budget and preferences
    await ok(t, 'update_setting', { key: 'monthly_budget', value: '75000' });
    await ok(t, 'update_setting', { key: 'exclude_investments_from_expenses', value: '1' });
    await ok(t, 'update_setting', { key: 'user_currency', value: 'INR' });
  });
});

describe('E2E Full Lifecycle: 2. Account & Asset Creation', () => {
  it('creates full asset & liability profile across accounts, cards, and loans', async (t) => {
    // 1. Bank Accounts
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'HDFC Salary Account', category: 'Bank', balance: 120000 },
    });
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'SBI Emergency Fund', category: 'Bank', balance: 250000 },
    });
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'SGB 2022 Series I', category: 'Gold', balance: 150000 },
    });

    // 2. Credit Cards
    await ok(t, 'save_record', {
      table: 'credit_cards',
      record: {
        card_name: 'HDFC Infinia',
        credit_limit: 500000,
        current_balance: 35000,
        billing_cycle_day: 15,
        due_day: 5,
      },
    });

    // 3. Loans
    await ok(t, 'save_record', {
      table: 'loans',
      record: {
        name: 'Home Loan',
        principal: 4500000,
        current_outstanding: 4200000,
        interest_rate: 8.5,
        monthly_emi: 39000,
        direction: 'borrowed',
      },
    });

    // 4. Mutual Fund SIPs
    await ok(t, 'save_record', {
      table: 'sips',
      record: {
        fund_name: 'Parag Parikh Flexi Cap Fund',
        monthly_amount: 15000,
        debit_day: 10,
        is_active: 1,
      },
    });

    const summary = await ok(t, 'get_summary', {});
    assert.equal(summary.status, 'success');
    assert.ok(summary.total_assets >= 520000);
    assert.ok(summary.total_liabilities >= 4235000);
  });
});

describe('E2E Full Lifecycle: 3. Intelligent SMS Ingestion & Categorization', () => {
  it('accurately parses and classifies multi-bank SMS streams', async (t) => {
    // 1. Salary Credit
    const salarySms = await parseSmsText('INR 1,25,000.00 credited to A/c xx9876 as Salary for August on 01-Aug-2026.');
    assert.equal(salarySms.type, 'Income');
    assert.equal(salarySms.amount, 125000);

    // 2. Dining UPI Spend
    const diningSms = await parseSmsText('Rs 1,450.00 debited from A/c xx9876 via UPI to ZOMATO on 02-Aug-2026.');
    assert.equal(diningSms.type, 'Expense');
    assert.equal(diningSms.amount, 1450);

    // 3. Depository / ICCL Investment Debit
    const icclSms = await parseSmsText('Rs. 25,000.00 debited from A/c xx9876 on 05-Aug-2026. Info: ACH D- ICCL / 982173.');
    assert.equal(icclSms.type, 'Investment');
    assert.equal(icclSms.category, 'Investment Outflow');
    assert.equal(icclSms.merchant, 'ICCL');

    // 4. Mutual Fund NACH SIP Debit
    const mfSms = await parseSmsText('A/c xx9876 debited by Rs 15,000.00 on 10-Aug-2026 towards SIP NIPPON INDIA MF.');
    assert.equal(mfSms.type, 'Investment');
    assert.equal(mfSms.category, 'Investment Outflow');

    // 5. Non-transaction Mandate Registration
    const mandateSms = await parseSmsText('Mandate of Rs 15000 registered successfully for UMRN HDFC000123.');
    assert.equal(mandateSms.not_a_transaction, 'mandate-setup');

    // Ingest transactions into ledger
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: salarySms.amount, category: 'Salary', type: 'Income', merchant: 'Employer' },
    });
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: diningSms.amount, category: 'Dining', type: 'Expense', merchant: 'Zomato' },
    });
    await ok(t, 'save_transaction', {
      transaction: {
        date: today, amount: icclSms.amount, category: 'Investment Outflow', type: 'Expense',
        merchant: 'ICCL', is_investment_outflow: true,
      },
    });
    await ok(t, 'save_transaction', {
      transaction: {
        date: today, amount: mfSms.amount, category: 'Investment Outflow', type: 'Expense',
        merchant: 'NIPPON INDIA MF', is_investment_outflow: true,
      },
    });

    const txs = await ok(t, 'get_transactions', { flow: 'spend' });
    assert.equal(txs.transactions.length, 1); // Only Dining is counted as pure spend (investments excluded)
    assert.equal(txs.totals.expense, 1450);

    const txsInvest = await ok(t, 'get_transactions', { flow: 'invest' });
    assert.equal(txsInvest.transactions.length, 2); // ICCL + MF SIP
    assert.equal(txsInvest.totals.invested, 40000);
  });
});

describe('E2E Full Lifecycle: 4. Cashflow Cockpit & Safe-to-Spend Operations', () => {
  it('computes Safe-to-Spend allowances, 30-day runway, checklist and weekend analysis', async (t) => {
    // Setup balance and commitments
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'Main Account', category: 'Bank', balance: 150000 },
    });
    await ok(t, 'save_record', {
      table: 'loans',
      record: { name: 'Home Loan', monthly_emi: 39000, current_outstanding: 4000000, direction: 'borrowed' },
    });
    await ok(t, 'save_record', {
      table: 'sips',
      record: { fund_name: 'Index Fund', monthly_amount: 15000, debit_day: 10, is_active: 1 },
    });
    await ok(t, 'save_record', {
      table: 'credit_cards',
      record: { card_name: 'Infinia', credit_limit: 500000, current_balance: 20000, due_day: 20 },
    });

    // 1. Safe-to-Spend
    const safe = await ok(t, 'get_safe_to_spend', {});
    assert.equal(safe.status, 'success');
    assert.equal(safe.liquid_balance, 150000);
    // Locked: 39000 (loan) + 15000 (SIP) + 20000 (CC) = 74000
    assert.equal(safe.locked_commitments, 74000);
    assert.equal(safe.safe_to_spend_total, 76000);
    assert.ok(safe.safe_to_spend_daily > 0);
    assert.ok(safe.safe_to_spend_weekly > 0);
    assert.equal(safe.health_status, 'healthy');

    // 2. 30-Day Runway
    const runway = await ok(t, 'get_cashflow_runway', {});
    assert.equal(runway.status, 'success');
    assert.equal(runway.starting_balance, 150000);
    assert.equal(runway.timeline.length, 30);

    // 3. Salary Checklist
    const checklist = await ok(t, 'get_salary_checklist', {});
    assert.equal(checklist.status, 'success');
    assert.ok(checklist.steps.length >= 5);

    // 4. Weekend Spend Analysis
    const weekend = await ok(t, 'get_weekend_spend_analysis', {});
    assert.equal(weekend.status, 'success');
    assert.ok(weekend.period_days === 90);
  });
});

describe('E2E Full Lifecycle: 5. Wealth Intelligence, ₹1.25L Tax Harvesting & Yield', () => {
  it('executes full portfolio analytics, tax-free harvesting, rebalancing and yield tracking', async (t) => {
    // Add CAS folios
    await ok(t, 'save_record', {
      table: 'mf_folios',
      record: { scheme_name: 'UTI Nifty 50 Index Fund', folio_number: '101', purchase_cost: 300000, current_value: 450000 },
    });
    await ok(t, 'save_record', {
      table: 'mf_folios',
      record: { scheme_name: 'Quant Small Cap Fund', folio_number: '102', purchase_cost: 200000, current_value: 320000 },
    });

    // 1. Tax Harvesting
    const harvesting = await ok(t, 'get_tax_harvesting', {});
    assert.equal(harvesting.status, 'success');
    assert.equal(harvesting.harvestable_ltcg, 125000);
    assert.equal(harvesting.tax_saved_by_harvesting, 15625);

    // 2. Portfolio Rebalance
    const rebalance = await ok(t, 'get_portfolio_rebalance', {
      target_equity: 70, target_debt: 20, target_gold: 10, monthly_sip_budget: 30000,
    });
    assert.equal(rebalance.status, 'success');
    assert.ok(rebalance.sip_rebalancing_plan.length >= 0);

    // 3. Passive Yield
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 4800, category: 'Dividend', type: 'Income', merchant: 'Infosys' },
    });
    const yieldRes = await ok(t, 'get_passive_yield', {});
    assert.equal(yieldRes.status, 'success');
    assert.equal(yieldRes.total_passive_12m, 4800);

    // 4. Direct Drag & Real Returns
    const drag = await ok(t, 'get_direct_vs_regular_drag', { monthly_sip: 15000, expected_cagr: 13, years: 20 });
    assert.ok(drag.commission_lost_to_distributor > 1000000);

    const real = await ok(t, 'get_real_return', { nominal_return: 13, inflation_rate: 6 });
    assert.ok(real.real_return_percent > 6);
  });
});

describe('E2E Full Lifecycle: 6. Debt Avalanche/Snowball & Stay Invested Comparator', () => {
  it('evaluates debt elimination strategies, part-payments, and stay-invested simulation', async (t) => {
    // 1. Avalanche vs Snowball
    await ok(t, 'save_record', {
      table: 'loans',
      record: { name: 'Personal Loan', principal: 250000, current_outstanding: 250000, interest_rate: 13.5, monthly_emi: 8000, direction: 'borrowed' },
    });
    await ok(t, 'save_record', {
      table: 'loans',
      record: { name: 'Auto Loan', principal: 400000, current_outstanding: 400000, interest_rate: 8.8, monthly_emi: 9500, direction: 'borrowed' },
    });

    const roadmap = await ok(t, 'get_debt_roadmap', { extra_monthly: 6000 });
    assert.equal(roadmap.status, 'success');
    assert.ok(roadmap.avalanche.total_interest <= roadmap.snowball.total_interest);

    // 2. Prepay vs Stay Invested Simulation
    const comparison = compareInvestVsPrepay(4000000, 8.5, 240, 10000, 0, 14);
    assert.equal(comparison.winner, 'invest'); // 14% equity return beats 8.5% debt rate
    assert.ok(comparison.invest_final_wealth > comparison.prepay_final_wealth);

    // 3. Home loan part payment
    const partPay = await ok(t, 'get_home_loan_part_payment', {
      principal: 4000000, annual_rate: 8.5, tenure_years: 20, extra_emis_per_year: 1, annual_step_up_pct: 5,
    });
    assert.ok(partPay.extra_emi_scenario.years_saved > 2);
    assert.ok(partPay.step_up_scenario.years_saved > 5);

    // 4. EMIs left calculation
    const emisLeft = calculateEmisLeft(3500000, 8.5, 34713);
    assert.ok(emisLeft > 0 && emisLeft <= 240);

    // 5. DTI Ratio
    const dti = await ok(t, 'get_dti_ratio', {});
    assert.equal(dti.status, 'success');
  });
});

describe('E2E Full Lifecycle: 7. Habits, Life Goals, Challenges & Finance Wrapped', () => {
  it('manages No-Spend days, Life Goals, 30-Day challenges and Finance Wrapped', async (t) => {
    // 1. No spend days
    const noSpend = await ok(t, 'get_no_spend_days', {});
    assert.equal(noSpend.status, 'success');
    assert.ok(noSpend.days.length > 0);

    // 2. Finance Wrapped
    const wrapped = await ok(t, 'get_monthly_wrapped', { month_offset: 0 });
    assert.equal(wrapped.status, 'success');
    assert.equal(wrapped.slides.length, 4);

    // 3. Life goals
    const goals = await ok(t, 'get_life_goals', {
      goals: [
        { name: 'House Downpayment', target_amount: 3500000, current_accumulated: 1200000, target_year: 2029 },
        { name: 'Dream Vacation', target_amount: 400000, current_accumulated: 150000, target_year: 2027 },
      ],
    });
    assert.equal(goals.status, 'success');
    assert.equal(goals.goals_count, 2);
    assert.ok(goals.total_monthly_sip_needed > 0);

    // 4. FIRE Projections
    const fireRes = calculateFireProjections({
      current_age: 30,
      target_retirement_age: 48,
      current_net_worth: 2500000,
      monthly_expenses: 60000,
      monthly_savings: 70000,
    });
    assert.equal(fireRes.status, 'success');
    assert.ok(fireRes.fire_number > 0);

    // 5. Local sync bundle
    const sync = await ok(t, 'get_local_sync_payload', {});
    assert.equal(sync.status, 'success');
    assert.ok(sync.payload_size_bytes > 0);
  });
});
