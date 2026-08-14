import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateFireProjections, handleFireAction } from '../app/src/main/assets/www/js/backend/fire.js';
import { calculateEmi, calculateEmisLeft, compareInvestVsPrepay, optimizePrepayment, handleLoanAction } from '../app/src/main/assets/www/js/backend/loan.js';

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
    assert.ok(res.projection_curve.length > 0);
    assert.equal(typeof res.is_fire_achievable, 'boolean');
  });

  it('calculates FIRE projection with customized parameters', () => {
    const res = calculateFireProjections({
      current_age: 35,
      target_retirement_age: 45,
      current_net_worth: 5000000,
      monthly_expenses: 80000,
      monthly_savings: 100000,
      expected_cagr: 14,
      inflation_rate: 7,
      fire_multiplier: 30,
    });
    assert.equal(res.status, 'success');
    assert.equal(res.years_to_retire, 10);
    assert.ok(res.projected_corpus_at_retirement > 5000000);
  });

  it('handles fire action dispatcher with valid and missing args', async () => {
    const res = await handleFireAction({
      current_age: '28',
      target_retirement_age: '55',
    });
    assert.equal(res.status, 'success');
    assert.equal(res.current_age, 28);
    assert.equal(res.retirement_age, 55);
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
