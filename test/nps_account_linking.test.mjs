import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, call } from './_harness.mjs';
import { importDepositoryStatement } from '../app/src/main/assets/www/js/backend/cas.js';
import { calculatePortfolioRebalance } from '../app/src/main/assets/www/js/backend/wealth_intel.js';

describe('NPS Account and Holdings Linking & De-duplication', () => {
  let db;

  beforeEach(async () => {
    db = await freshBackend();
  });

  it('prevents double counting of NPS in Net Worth when both Account and Holdings exist', async () => {
    // 1. User has a bank account of ₹1,00,000 and an NPS account entry of ₹5,00,000
    db.run(
      "INSERT INTO asset_accounts (member_id, name, category, balance) VALUES (1, 'HDFC Bank', 'Bank', 100000)",
    );
    const npsAccId = db.run(
      "INSERT INTO asset_accounts (member_id, name, category, balance, linked_holding_type, linked_pran) VALUES (1, 'NPS Account', 'NPS', 500000, 'nps', '110012345678')",
    ).lastInsertRowid;

    // 2. User also imports eCAS statement with 2 NPS schemes totaling ₹5,00,000
    db.run(
      "INSERT INTO nps_holdings (member_id, pran, scheme, fund_manager, tier, asset_class, units, nav, current_value, invested_value, last_updated)"
      + " VALUES (1, '110012345678', 'HDFC Pension Fund Scheme E', 'HDFC', 'I', 'Equity', 10000, 30, 300000, 250000, '2026-01-15')",
    );
    db.run(
      "INSERT INTO nps_holdings (member_id, pran, scheme, fund_manager, tier, asset_class, units, nav, current_value, invested_value, last_updated)"
      + " VALUES (1, '110012345678', 'HDFC Pension Fund Scheme C', 'HDFC', 'I', 'Corporate Debt', 8000, 25, 200000, 180000, '2026-01-15')",
    );

    // Call get_summary
    const summary = await call('get_summary', { member_id: 1 });

    // Verify: NPS total must be ₹5,00,000 (NOT ₹10,00,000!)
    assert.equal(summary.asset_totals.NPS, 500000);
    assert.equal(summary.asset_totals.Bank, 100000);
    // Total assets must be ₹1,00,000 (Bank) + ₹5,00,000 (NPS) = ₹6,00,000
    assert.equal(summary.total_assets, 600000);
  });

  it('links an existing account to NPS holdings and syncs balance via link_nps_account', async () => {
    // Seed NPS holdings
    db.run(
      "INSERT INTO nps_holdings (member_id, pran, scheme, fund_manager, tier, asset_class, units, nav, current_value, invested_value, last_updated)"
      + " VALUES (1, '110099887766', 'SBI Pension Fund Scheme E', 'SBI', 'I', 'Equity', 5000, 40, 200000, 150000, '2026-01-15')",
    );
    db.run(
      "INSERT INTO nps_holdings (member_id, pran, scheme, fund_manager, tier, asset_class, units, nav, current_value, invested_value, last_updated)"
      + " VALUES (1, '110099887766', 'SBI Pension Fund Scheme G', 'SBI', 'I', 'Govt Bonds', 3000, 50, 150000, 120000, '2026-01-15')",
    );

    // User has an existing account with outdated balance
    const accId = db.run(
      "INSERT INTO asset_accounts (member_id, name, category, balance) VALUES (1, 'My Pension', 'Other', 50000)",
    ).lastInsertRowid;

    // Link account
    const linkRes = await call('link_nps_account', {
      member_id: 1,
      account_id: accId,
      pran: '110099887766',
    });

    assert.equal(linkRes.status, 'success');
    assert.equal(linkRes.balance, 350000); // 200k + 150k

    // Verify account was updated
    const updatedAcc = db.get('SELECT * FROM asset_accounts WHERE id = ?', [accId]);
    assert.equal(updatedAcc.category, 'NPS');
    assert.equal(updatedAcc.linked_holding_type, 'nps');
    assert.equal(updatedAcc.linked_pran, '110099887766');
    assert.equal(updatedAcc.balance, 350000);

    // Unlink account
    const unlinkRes = await call('link_nps_account', {
      member_id: 1,
      account_id: accId,
      unlink: true,
    });
    assert.equal(unlinkRes.status, 'success');
    const unlinkedAcc = db.get('SELECT * FROM asset_accounts WHERE id = ?', [accId]);
    assert.equal(unlinkedAcc.linked_holding_type, '');
  });

  it('creates a new linked NPS account when no account ID is passed', async () => {
    db.run(
      "INSERT INTO nps_holdings (member_id, pran, scheme, fund_manager, tier, asset_class, units, nav, current_value, invested_value, last_updated)"
      + " VALUES (1, 'PRAN777', 'ICICI Prudential Scheme E', 'ICICI', 'I', 'Equity', 4000, 50, 200000, 150000, '2026-01-15')",
    );

    const res = await call('link_nps_account', {
      member_id: 1,
      pran: 'PRAN777',
      name: 'NPS Tier 1 ICICI',
      institution: 'CRA-NSDL',
    });

    assert.equal(res.status, 'success');
    assert.ok(res.account_id > 0);
    assert.equal(res.balance, 200000);

    const newAcc = db.get('SELECT * FROM asset_accounts WHERE id = ?', [res.account_id]);
    assert.equal(newAcc.name, 'NPS Tier 1 ICICI');
    assert.equal(newAcc.category, 'NPS');
    assert.equal(newAcc.linked_holding_type, 'nps');
    assert.equal(newAcc.linked_pran, 'PRAN777');
    assert.equal(newAcc.balance, 200000);
  });

  it('automatically updates linked NPS account balance when fresh CAS is imported', () => {
    // 1. Pre-create linked NPS account
    const accId = db.run(
      "INSERT INTO asset_accounts (member_id, name, category, balance, linked_holding_type, linked_pran)"
      + " VALUES (1, 'NPS Corpus', 'NPS', 100000, 'nps', '110055555555')",
    ).lastInsertRowid;

    // 2. Simulate parsed CAS payload with new NPS values (total ₹4,20,000)
    const casData = {
      accounts: [],
      nps: {
        pran: '110055555555',
        schemes: [
          { scheme: 'UTI Scheme E', fund_manager: 'UTI', tier: 'I', asset_class: 'Equity', units: 10000, nav: 30, value: 300000 },
          { scheme: 'UTI Scheme C', fund_manager: 'UTI', tier: 'I', asset_class: 'Corporate Debt', units: 6000, nav: 20, value: 120000 },
        ],
      },
    };

    importDepositoryStatement(db, casData, 1, '2026-02-01');

    // Verify account balance auto-updated to ₹4,20,000
    const acc = db.get('SELECT balance FROM asset_accounts WHERE id = ?', [accId]);
    assert.equal(acc.balance, 420000);
  });

  it('prevents double counting of NPS in wealth rebalancer', () => {
    db.run(
      "INSERT INTO asset_accounts (member_id, name, category, balance, linked_holding_type)"
      + " VALUES (1, 'NPS Account', 'NPS', 300000, 'nps')",
    );
    db.run(
      "INSERT INTO nps_holdings (member_id, pran, scheme, current_value) VALUES (1, 'P1', 'Scheme E', 300000)",
    );

    const rebalance = calculatePortfolioRebalance(db, { member_id: 1 });
    // Total debt assets should count the 300k NPS once, not twice (300k, not 600k)
    assert.equal(rebalance.current_allocation.debt.value, 300000);
  });
});
