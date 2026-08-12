import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateFireProjections, handleFireAction } from '../app/src/main/assets/www/js/backend/fire.js';
import { calculateEmi, optimizePrepayment, handleLoanAction } from '../app/src/main/assets/www/js/backend/loan.js';

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

  it('optimizes prepayment with zero extra payments', () => {
    const res = optimizePrepayment(1000000, 8.0, 120, 0, 0);
    assert.equal(res.interest_saved, 0);
    assert.equal(res.months_saved, 0);
  });

  it('handles loan action dispatcher', async () => {
    const res = await handleLoanAction({
      principal: '2000000',
      rate: '8.5',
      tenure_months: '120',
      extra_monthly: '5000',
    });
    assert.equal(res.status, 'success');
    assert.ok(res.interest_saved > 0);
  });
});
