import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { call, freshBackend, ok } from './_harness.mjs';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

const today = new Date().toISOString().slice(0, 10);

describe('wealth_intel.js: Tax Harvesting, Portfolio Rebalancer, Yield, Direct Drag, SGB, Real Return', () => {
  it('calculates ₹1.25 Lakh tax-free LTCG harvesting opportunities', async (t) => {
    // Add sample mutual fund folios with unrealized gains
    await ok(t, 'save_record', {
      table: 'mf_folios',
      record: {
        scheme_name: 'Mirae Asset Large Cap Fund',
        folio_number: '12345/01',
        purchase_cost: 200000,
        current_value: 320000, // Gain = 120,000
        last_updated: today,
      },
    });

    await ok(t, 'save_record', {
      table: 'mf_folios',
      record: {
        scheme_name: 'Parag Parikh Flexi Cap Fund',
        folio_number: '98765/02',
        purchase_cost: 300000,
        current_value: 450000, // Gain = 150,000
        last_updated: today,
      },
    });

    const harvesting = await ok(t, 'get_tax_harvesting', {});
    assert.equal(harvesting.status, 'success');
    assert.equal(harvesting.exemption_limit, 125000);
    assert.equal(harvesting.harvestable_ltcg, 125000); // capped at 1.25L
    assert.equal(harvesting.tax_saved_by_harvesting, 15625); // 12.5% of 1.25L = 15,625
    assert.ok(harvesting.harvestable_folios.length >= 2);
  });

  it('calculates portfolio target allocation and SIP rebalancing route', async (t) => {
    // Current allocation: 500,000 Equity (MF), 100,000 Debt (Bank), 20,000 Gold
    await ok(t, 'save_record', {
      table: 'mf_folios',
      record: { scheme_name: 'Nifty 50 Index', folio_number: '111', purchase_cost: 400000, current_value: 500000 },
    });
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'Fixed Deposit', category: 'Bank', balance: 100000 },
    });
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'SGB Tranche 1', category: 'Gold', balance: 20000 },
    });

    const rebalance = await ok(t, 'get_portfolio_rebalance', {
      target_equity: 60,
      target_debt: 30,
      target_gold: 10,
      monthly_sip_budget: 30000,
    });

    assert.equal(rebalance.status, 'success');
    assert.equal(rebalance.total_portfolio_value, 620000);
    assert.ok(rebalance.current_allocation.equity.percent > 70); // currently overweight
    assert.ok(rebalance.sip_rebalancing_plan.length > 0);
  });

  it('calculates 12-month passive dividend & interest yield run-rate', async (t) => {
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 4500, category: 'Dividend', type: 'Income', merchant: 'TCS Dividend' },
    });
    await ok(t, 'save_transaction', {
      transaction: { date: today, amount: 1500, category: 'Interest', type: 'Income', merchant: 'Bank Interest' },
    });

    const yieldRes = await ok(t, 'get_passive_yield', {});
    assert.equal(yieldRes.status, 'success');
    assert.equal(yieldRes.total_passive_12m, 6000);
    assert.equal(yieldRes.monthly_run_rate, 500);
  });

  it('computes Direct vs Regular Mutual Fund commission drag', async (t) => {
    const drag = await ok(t, 'get_direct_vs_regular_drag', {
      monthly_sip: 10000,
      expected_cagr: 12,
      years: 20,
    });
    assert.equal(drag.status, 'success');
    assert.ok(drag.direct_final_wealth > drag.regular_final_wealth);
    assert.ok(drag.commission_lost_to_distributor > 1000000); // > 10 Lakhs saved!
  });

  it('computes Sovereign Gold Bond (SGB) 2.5% semi-annual interest schedule', async (t) => {
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'SGB 2021-22 Series IV', category: 'Gold', balance: 200000 },
    });

    const sgb = await ok(t, 'get_sgb_schedule', {});
    assert.equal(sgb.status, 'success');
    assert.equal(sgb.total_sgb_value, 200000);
    assert.equal(sgb.annual_interest_payout, 5000);
    assert.equal(sgb.semi_annual_payout, 2500);
  });

  it('computes inflation-adjusted real returns (Fisher equation)', async (t) => {
    const real = await ok(t, 'get_real_return', {
      nominal_return: 14,
      inflation_rate: 6,
    });
    assert.equal(real.status, 'success');
    assert.equal(real.real_return_percent, 7.5);
    assert.equal(real.purchasing_power_growth, 'expanding');
  });
});
