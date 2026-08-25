import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { calculateFireProjections, getFireProfile, saveFireSettings, handleFireAction } from '../app/src/main/assets/www/js/backend/fire.js';
import { calculateEmi, calculateEmisLeft, compareInvestVsPrepay, optimizePrepayment, handleLoanAction } from '../app/src/main/assets/www/js/backend/loan.js';
import { freshBackend, ok } from './_harness.mjs';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('fire.js calculator and dispatcher', () => {
  it('calculates FIRE projection with default values', () => {
    const res = calculateFireProjections();
    assert.equal(res.status, 'success');
    assert.equal(res.current_age, 30);
    assert.equal(res.retirement_age, 50);
    assert.equal(res.years_to_retire, 20);
    assert.ok(res.fire_number > 0);
    assert.ok(res.lean_fire > 0);
    assert.ok(res.fat_fire > res.fire_number);
    assert.ok(res.coast_fire > 0);
    assert.ok(res.barista_fire > 0);
    assert.ok(res.projection_curve.length > 0);
    assert.equal(typeof res.is_fire_achievable, 'boolean');
    assert.equal(typeof res.is_coast_fire_achieved, 'boolean');
    assert.ok(res.safe_monthly_withdrawal_at_retirement > 0);
  });

  it('calculates FIRE projection with customized parameters and step-up savings', () => {
    const res = calculateFireProjections({
      current_age: 35,
      target_retirement_age: 45,
      current_net_worth: 5000000,
      monthly_expenses: 80000,
      essential_expenses: 50000,
      discretionary_expenses: 30000,
      monthly_savings: 100000,
      annual_step_up_percent: 10,
      expected_cagr: 14,
      inflation_rate: 7,
      fire_multiplier: 30,
    });
    assert.equal(res.status, 'success');
    assert.equal(res.years_to_retire, 10);
    assert.ok(res.projected_corpus_at_retirement > 5000000);
    assert.ok(res.lean_fire < res.fire_number);
    assert.ok(res.fat_fire > res.fire_number);
    assert.ok(res.real_return_rate_percent > 0);
  });

  it('calculates early FIRE milestone age when goal is achievable ahead of schedule', () => {
    const res = calculateFireProjections({
      current_age: 30,
      target_retirement_age: 60,
      current_net_worth: 20000000,
      monthly_expenses: 50000,
      monthly_savings: 150000,
      expected_cagr: 12,
      inflation_rate: 6,
    });
    assert.equal(res.status, 'success');
    assert.equal(res.is_fire_achievable, true);
    assert.ok(res.fire_age_reached !== null);
    assert.ok(res.fire_age_reached < 60);
    assert.equal(res.is_coast_fire_achieved, true);
  });

  it('calculates shortfall and required additional monthly savings accurately', () => {
    const res = calculateFireProjections({
      current_age: 30,
      target_retirement_age: 40,
      current_net_worth: 100000,
      monthly_expenses: 100000,
      monthly_savings: 5000,
      expected_cagr: 10,
      inflation_rate: 6,
    });
    assert.equal(res.status, 'success');
    assert.equal(res.is_fire_achievable, false);
    assert.ok(res.shortfall_at_retirement > 0);
    assert.ok(res.additional_monthly_savings_needed > 0);
  });

  it('extracts live financial profile from database records in getFireProfile', async (t) => {
    // 1. Seed assets and investments
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'HDFC Savings', category: 'Bank', balance: 250000 },
    });
    await ok(t, 'save_record', {
      table: 'asset_accounts',
      record: { name: 'Sovereign Gold Bond', category: 'Gold', balance: 100000 },
    });
    await ok(t, 'save_record', {
      table: 'mf_folios',
      record: { scheme_name: 'Nifty Index Fund', folio_number: 'MF101', purchase_cost: 400000, current_value: 650000 },
    });
    await ok(t, 'save_record', {
      table: 'sips',
      record: { scheme_name: 'Nifty Index SIP', monthly_amount: 25000, debit_day: 5, is_active: 1 },
    });

    // 2. Seed historical transactions
    const now = new Date();
    const isoCurrent = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-05`;
    await ok(t, 'save_transaction', {
      transaction: { date: isoCurrent, amount: 150000, type: 'Income', category: 'Salary' },
    });
    await ok(t, 'save_transaction', {
      transaction: { date: isoCurrent, amount: 30000, type: 'Expense', category: 'Groceries' }, // Essential
    });
    await ok(t, 'save_transaction', {
      transaction: { date: isoCurrent, amount: 15000, type: 'Expense', category: 'Dining' }, // Discretionary
    });

    const profile = getFireProfile(db);
    assert.equal(profile.status, 'success');
    assert.equal(profile.total_assets, 1000000); // 2.5L Bank + 1.0L Gold + 6.5L MF
    assert.equal(profile.net_worth, 1000000);
    assert.ok(profile.weighted_cagr > 9 && profile.weighted_cagr < 13);
    assert.equal(profile.active_sips_total, 25000);
    assert.ok(profile.monthly_expenses > 0);
    assert.ok(profile.essential_expenses > 0);
    assert.ok(profile.discretionary_expenses > 0);
    assert.equal(profile.has_real_data, true);
  });

  it('saves and reads user retirement settings to persistent app_settings', async (t) => {
    saveFireSettings(db, {
      fire_current_age: 32,
      fire_target_age: 52,
      fire_expected_cagr: 13.5,
      fire_inflation_rate: 6.5,
      fire_multiplier: 30,
      fire_step_up_percent: 5,
    });

    const profile = getFireProfile(db);
    assert.equal(profile.saved_settings.fire_current_age, '32');
    assert.equal(profile.saved_settings.fire_target_age, '52');
    assert.equal(profile.saved_settings.fire_expected_cagr, '13.5');
    assert.equal(profile.saved_settings.fire_multiplier, '30');
    assert.equal(profile.saved_settings.fire_step_up_percent, '5');
  });

  it('handles fire action dispatcher for get_profile, save_settings and calculate', async () => {
    const profileRes = await handleFireAction({ action: 'get_profile' });
    assert.equal(profileRes.status, 'success');
    assert.ok(profileRes.net_worth !== undefined);

    const saveRes = await handleFireAction({
      action: 'save_settings',
      fire_current_age: 34,
      fire_target_age: 54,
    });
    assert.equal(saveRes.status, 'success');

    const calcRes = await handleFireAction({
      current_age: '28',
      target_retirement_age: '55',
      current_net_worth: '2000000',
    });
    assert.equal(calcRes.status, 'success');
    assert.equal(calcRes.current_age, 28);
    assert.equal(calcRes.retirement_age, 55);
  });
});

describe('loan.js calculator and dispatcher', () => {
  it('calculates standard level EMI', () => {
    const emi = calculateEmi(1000000, 8.5, 240);
    assert.ok(emi > 8000 && emi < 9000);
  });

  it('calculates EMIs left accurately', () => {
    const emi = calculateEmi(1000000, 8.5, 240);
    const emisLeft = calculateEmisLeft(1000000, 8.5, emi);
    assert.equal(emisLeft, 240);

    const halfEmis = calculateEmisLeft(500000, 8.5, emi);
    assert.ok(halfEmis < 240 && halfEmis > 50);

    assert.equal(calculateEmisLeft(0, 8.5, emi), 0);
    assert.equal(calculateEmisLeft(100000, 0, 10000), 10);
  });

  it('handles zero or negative rate and tenure edge cases', () => {
    assert.equal(calculateEmi(120000, 0, 12), 10000);
    assert.equal(calculateEmi(120000, -5, 0), 120000);
  });

  it('optimizes prepayment with monthly and annual extra payments', () => {
    const res = optimizePrepayment(5000000, 9.0, 240, 10000, 50000);
    assert.ok(res.base_emi > 0);
    assert.ok(res.total_base_interest > 0);
    assert.ok(res.optimized_tenure_months < 240);
    assert.ok(res.interest_saved > 0);
    assert.ok(res.months_saved > 0);
    assert.ok(res.years_saved > 0);
  });

  it('compares stay invested vs prepay loan strategies', () => {
    // Case 1: High market return (14%) vs lower loan rate (8.5%) -> Stay Invested wins
    const investWins = compareInvestVsPrepay(5000000, 8.5, 240, 10000, 0, 14);
    assert.equal(investWins.winner, 'invest');
    assert.ok(investWins.invest_final_wealth > investWins.prepay_final_wealth);
    assert.ok(investWins.wealth_difference > 0);
    assert.ok(investWins.yearly_timeline.length > 0);

    // Case 2: Low market return (6%) vs high loan rate (11%) -> Prepay wins
    const prepayWins = compareInvestVsPrepay(5000000, 11.0, 240, 10000, 0, 6);
    assert.equal(prepayWins.winner, 'prepay');
    assert.ok(prepayWins.prepay_final_wealth > prepayWins.invest_final_wealth);
  });

  it('optimizes prepayment with zero extra payments', () => {
    const res = optimizePrepayment(1000000, 8.0, 120, 0, 0);
    assert.equal(res.interest_saved, 0);
    assert.equal(res.months_saved, 0);
  });

  it('handles loan action dispatcher for all actions', async () => {
    const res = await handleLoanAction({
      principal: '2000000',
      rate: '8.5',
      tenure_months: '120',
      extra_monthly: '5000',
    });
    assert.equal(res.status, 'success');
    assert.ok(res.interest_saved > 0);

    const compareRes = await handleLoanAction({
      action: 'compare',
      principal: '2000000',
      rate: '8.5',
      tenure_months: '120',
      extra_monthly: '5000',
      invest_return: '12',
    });
    assert.equal(compareRes.status, 'success');
    assert.ok(compareRes.prepay_final_wealth > 0);
    assert.ok(compareRes.invest_final_wealth > 0);

    const emiRes = await handleLoanAction({
      action: 'emis_left',
      principal: '1000000',
      rate: '8.5',
      monthly_emi: '8678',
    });
    assert.equal(emiRes.status, 'success');
    assert.ok(emiRes.emis_left > 0);
  });
});
