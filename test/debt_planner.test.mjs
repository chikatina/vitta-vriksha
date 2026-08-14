import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { call, freshBackend, ok } from './_harness.mjs';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('debt_planner.js: Avalanche vs Snowball, Home Loan Prepayment, CC Optimizer, DTI Ratio', () => {
  it('calculates Debt Avalanche vs Snowball roadmap and savings', async (t) => {
    // Add 2 debts: Personal Loan (high rate 14%, 200,000) and Car Loan (low rate 8.5%, 300,000)
    await ok(t, 'save_record', {
      table: 'loans',
      record: {
        name: 'Personal Loan',
        principal: 200000,
        current_outstanding: 200000,
        interest_rate: 14.0,
        monthly_emi: 6000,
        direction: 'borrowed',
      },
    });

    await ok(t, 'save_record', {
      table: 'loans',
      record: {
        name: 'Car Loan',
        principal: 300000,
        current_outstanding: 300000,
        interest_rate: 8.5,
        monthly_emi: 7000,
        direction: 'borrowed',
      },
    });

    const roadmap = await ok(t, 'get_debt_roadmap', { extra_monthly: 5000 });
    assert.equal(roadmap.status, 'success');
    assert.equal(roadmap.debt_count, 2);
    assert.equal(roadmap.total_debt, 500000);
    assert.ok(roadmap.avalanche.total_interest <= roadmap.snowball.total_interest);
    assert.ok(roadmap.avalanche.debt_free_date);
    assert.ok(roadmap.snowball.debt_free_date);
  });

  it('calculates 1 extra EMI / year and annual 5% step-up savings for Home Loans', async (t) => {
    const partPay = await ok(t, 'get_home_loan_part_payment', {
      principal: 5000000,
      annual_rate: 8.5,
      tenure_years: 20,
      extra_emis_per_year: 1,
      annual_step_up_pct: 5,
    });

    assert.equal(partPay.status, 'success');
    assert.ok(partPay.base_emi > 40000);
    assert.ok(partPay.extra_emi_scenario.years_saved > 2);
    assert.ok(partPay.extra_emi_scenario.interest_saved > 500000);
    assert.ok(partPay.step_up_scenario.years_saved > 5);
  });

  it('recommends optimal Credit Card for max grace period and flags high utilization', async (t) => {
    await ok(t, 'save_record', {
      table: 'credit_cards',
      record: {
        card_name: 'HDFC Regalia Gold',
        credit_limit: 300000,
        current_balance: 120000, // 40% (high utilization > 30%)
        billing_cycle_day: 15,
        due_day: 5,
      },
    });

    await ok(t, 'save_record', {
      table: 'credit_cards',
      record: {
        card_name: 'SBI Cashback Card',
        credit_limit: 150000,
        current_balance: 10000, // < 10% (healthy)
        billing_cycle_day: 28,
        due_day: 18,
      },
    });

    const optimizer = await ok(t, 'get_credit_card_optimizer', {});
    assert.equal(optimizer.status, 'success');
    assert.equal(optimizer.cards.length, 2);
    assert.ok(optimizer.best_card_to_use_today);
    assert.equal(optimizer.high_utilization_count, 1);
  });

  it('computes Debt-to-Income (DTI) ratio accurately', async (t) => {
    await ok(t, 'save_record', {
      table: 'loans',
      record: { name: 'Home Loan', monthly_emi: 25000, current_outstanding: 2500000, direction: 'borrowed' },
    });

    await ok(t, 'save_transaction', {
      transaction: { date: '2026-08-01', amount: 100000, category: 'Salary', type: 'Income', merchant: 'Company' },
    });

    const dti = await ok(t, 'get_dti_ratio', {});
    assert.equal(dti.status, 'success');
    assert.equal(dti.monthly_debt_obligations, 25000);
    assert.equal(dti.monthly_net_income, 100000);
    assert.equal(dti.dti_percent, 25);
    assert.equal(dti.risk_category, 'Healthy');
  });
});
