/* Retirement targets, live ledger telemetry, and compounding trajectory. */

import { Bridge } from '../bridge.js';
import {
  icon, h, errorBlock, toast,
} from '../ui.js';
import { formatCurrency } from '../formatters.js';
import { areaChart } from '../charts.js';
import { memberChips, bindMemberChips } from './shared.js';

export async function renderFire(container, app) {
  // 1. Fetch live financial profile for the current member / household
  const profileRes = await Bridge.call('fire', {
    action: 'get_profile',
    member_id: app.memberFilter,
  });

  const profile = profileRes.status === 'success' ? profileRes : {
    net_worth: 1000000,
    monthly_expenses: 50000,
    essential_expenses: 37500,
    discretionary_expenses: 12500,
    monthly_savings: 30000,
    weighted_cagr: 12,
    active_sips_total: 0,
    active_loan_emi: 0,
    loan_months_remaining: 0,
    saved_settings: {},
    family_members: [],
    has_real_data: false,
  };

  const saved = profile.saved_settings || {};
  const currentAgeVal = Number(saved.fire_current_age) || 30;
  const targetAgeVal = Number(saved.fire_target_age) || 50;
  const cagrVal = Number(saved.fire_expected_cagr) || profile.weighted_cagr || 12;
  const inflationVal = Number(saved.fire_inflation_rate) || 6;
  const multiplierVal = Number(saved.fire_multiplier) || 25;
  const stepUpVal = Number(saved.fire_step_up_percent) || 0;

  const memberHtml = memberChips(app, profile.family_members || []);

  container.innerHTML = `
    ${memberHtml ? `<div class="sticky-header">${memberHtml}</div>` : ''}

    ${profile.has_real_data ? `
      <div class="card" data-telemetry-banner style="background:var(--surface-container-low);border:1px solid var(--outline-variant)">
        <div class="row-between" style="margin-bottom:8px">
          <span class="overline" style="margin-bottom:0">Live Financial Telemetry</span>
          <span class="badge badge-income">Connected</span>
        </div>
        <div class="caption" style="margin-bottom:12px">
          Loaded from your assets, active SIPs, and 6-month transaction trends.
        </div>
        <div class="grid-2">
          <div class="stat">
            <span class="caption">Net Worth</span>
            <span class="stat-value">${h(formatCurrency(profile.net_worth, app.currency, app.locale))}</span>
          </div>
          <div class="stat">
            <span class="caption">Monthly Spend</span>
            <span class="stat-value expense">${h(formatCurrency(profile.monthly_expenses, app.currency, app.locale))}</span>
            <span class="caption">${h(formatCurrency(profile.essential_expenses, app.currency, app.locale))} essential · ${h(formatCurrency(profile.discretionary_expenses, app.currency, app.locale))} disc.</span>
          </div>
          <div class="stat">
            <span class="caption">Savings & SIPs</span>
            <span class="stat-value income">${h(formatCurrency(profile.monthly_savings, app.currency, app.locale))}</span>
            <span class="caption">${profile.active_sips_total > 0 ? `${h(formatCurrency(profile.active_sips_total, app.currency, app.locale))} in active SIPs` : 'From ledger cashflow'}</span>
          </div>
          <div class="stat">
            <span class="caption">Portfolio Return</span>
            <span class="stat-value">${profile.weighted_cagr}%</span>
            <span class="caption">Weighted by asset allocation</span>
          </div>
        </div>
      </div>` : ''}

    <div data-output></div>

    <div class="card">
      <div class="row-between" style="margin-bottom:12px">
        <div class="card-title" style="margin-bottom:0">Assumptions & Scenarios</div>
        <button class="btn btn-tonal" data-reset-live style="font-size:12px;padding:4px 10px">
          ${icon('refresh', 'icon-sm')}Reset
        </button>
      </div>

      <div class="field" style="margin-bottom:12px">
        <label class="field-label">Safe Withdrawal Rate (SWR Multiplier)</label>
        <div class="chip-scroller" data-multipliers>
          <button class="chip ${multiplierVal === 25 ? 'active' : ''}" data-multiplier="25" aria-selected="${multiplierVal === 25}">25x (4% Standard)</button>
          <button class="chip ${multiplierVal === 30 ? 'active' : ''}" data-multiplier="30" aria-selected="${multiplierVal === 30}">30x (3.33% Balanced)</button>
          <button class="chip ${multiplierVal === 33 ? 'active' : ''}" data-multiplier="33" aria-selected="${multiplierVal === 33}">33x (3.0% Safe)</button>
        </div>
      </div>

      <div class="grid-2">
        <div class="field">
          <label class="field-label" for="fireAge">Current age</label>
          <input class="input numeric" id="fireAge" type="number" inputmode="numeric" value="${currentAgeVal}">
        </div>
        <div class="field">
          <label class="field-label" for="fireRetireAge">Target retirement age</label>
          <input class="input numeric" id="fireRetireAge" type="number" inputmode="numeric" value="${targetAgeVal}">
        </div>
        <div class="field">
          <label class="field-label" for="fireNetWorth">Current net worth</label>
          <input class="input numeric" id="fireNetWorth" type="number" inputmode="numeric" value="${profile.net_worth}">
        </div>
        <div class="field">
          <label class="field-label" for="fireExpenses">Monthly spending</label>
          <input class="input numeric" id="fireExpenses" type="number" inputmode="numeric" value="${profile.monthly_expenses}">
        </div>
        <div class="field">
          <label class="field-label" for="fireSavings">Monthly savings</label>
          <input class="input numeric" id="fireSavings" type="number" inputmode="numeric" value="${profile.monthly_savings}">
        </div>
        <div class="field">
          <label class="field-label" for="fireStepUp">Annual step-up %</label>
          <input class="input numeric" id="fireStepUp" type="number" inputmode="numeric" value="${stepUpVal}">
        </div>
        <div class="field">
          <label class="field-label" for="fireCagr">Expected portfolio CAGR %</label>
          <input class="input numeric" id="fireCagr" type="number" step="0.1" inputmode="decimal" value="${cagrVal}">
        </div>
        <div class="field">
          <label class="field-label" for="fireInflation">Inflation rate %</label>
          <input class="input numeric" id="fireInflation" type="number" step="0.1" inputmode="decimal" value="${inflationVal}">
        </div>
      </div>

      <div class="row-gap" style="margin-top:16px;gap:8px">
        <button class="btn btn-filled" data-calc style="flex:1">
          ${icon('rocket_launch')}Calculate
        </button>
        <button class="btn btn-outlined" data-save-settings title="Save age and assumptions">
          ${icon('check')}Save
        </button>
      </div>
    </div>`;

  bindMemberChips(container, app);

  let activeMultiplier = multiplierVal;

  const read = (id) => Number(document.getElementById(id)?.value) || 0;
  const money = (v) => formatCurrency(v, app.currency, app.locale);

  const calculate = async () => {
    const output = container.querySelector('[data-output]');

    const res = await Bridge.call('fire', {
      current_age: read('fireAge'),
      target_retirement_age: read('fireRetireAge'),
      current_net_worth: read('fireNetWorth'),
      monthly_expenses: read('fireExpenses'),
      essential_expenses: profile.essential_expenses,
      discretionary_expenses: profile.discretionary_expenses,
      monthly_savings: read('fireSavings'),
      annual_step_up_percent: read('fireStepUp'),
      expected_cagr: read('fireCagr'),
      inflation_rate: read('fireInflation'),
      fire_multiplier: activeMultiplier,
      monthly_emi: profile.active_loan_emi,
      loan_months_remaining: profile.loan_months_remaining,
    });

    if (res.status !== 'success') {
      output.innerHTML = `<div class="card">${errorBlock(res, { compact: true })}</div>`;
      return;
    }

    const curve = (res.projection_curve || []).map((point) => ({
      label: `Age ${point.age}`,
      value: point.projected_net_worth,
    }));

    output.innerHTML = `
      <div class="card-accent">
        <div class="row-between" style="margin-bottom:6px">
          <span class="overline" style="color:inherit;opacity:0.7;margin-bottom:0">Target FIRE Corpus</span>
          <span class="badge ${res.is_fire_achievable ? 'badge-income' : 'badge-expense'}">
            ${res.is_fire_achievable ? 'On Track' : 'Needs Boost'}
          </span>
        </div>
        <div class="balance-amount" style="font-size:32px">${h(money(res.fire_number))}</div>

        <div class="progress" style="height:8px;margin:12px 0 8px 0;background:rgba(255,255,255,0.2)">
          <div class="progress-bar" style="width:${res.progress_percent}%;background:currentColor"></div>
        </div>

        <div class="row-between caption" style="color:inherit;opacity:0.85;margin-bottom:6px">
          <span>${res.progress_percent}% of target accumulated</span>
          <span>${h(money(res.projected_corpus_at_retirement))} at age ${res.retirement_age}</span>
        </div>

        <div class="caption" style="color:inherit;opacity:0.95;margin-top:6px;line-height:1.4">
          ${res.is_fire_achievable
            ? (res.fire_age_reached && res.fire_age_reached < res.retirement_age
              ? `You can achieve Financial Independence at age ${res.fire_age_reached} (${res.retirement_age - res.fire_age_reached} years early!).`
              : `On track to accumulate ${money(res.projected_corpus_at_retirement)} at age ${res.retirement_age} (surplus of ${money(res.surplus_at_retirement)}).`)
            : `Projected ${money(res.projected_corpus_at_retirement)} at age ${res.retirement_age} (${money(res.shortfall_at_retirement)} gap). Increase monthly savings by ${money(res.additional_monthly_savings_needed)} to bridge this gap on time.`}
        </div>

        ${res.is_coast_fire_achieved ? `
          <div class="badge badge-accent" style="margin-top:10px;display:inline-flex;align-items:center;gap:4px">
            ${icon('check_circle', 'icon-sm')} Coast FIRE achieved today!
          </div>` : ''}
      </div>

      ${curve.length > 1 ? `
        <div class="card">
          <div class="row-between" style="margin-bottom:8px">
            <span class="card-title" style="margin-bottom:0">Net Worth Trajectory</span>
            <span class="caption">Real purchasing power</span>
          </div>
          ${areaChart(curve)}
          <div class="row-between caption" style="margin-top:8px">
            <span>${h(curve[0].label)}</span>
            <span>Retire at Age ${res.retirement_age}</span>
            <span>${h(curve[curve.length - 1].label)}</span>
          </div>
        </div>` : ''}

      <div class="grid-2">
        <div class="stat">
          <span class="caption">Lean FIRE</span>
          <span class="stat-value">${h(money(res.lean_fire))}</span>
          <span class="caption">Basic essentials & shelter</span>
        </div>
        <div class="stat">
          <span class="caption">Fat FIRE</span>
          <span class="stat-value">${h(money(res.fat_fire))}</span>
          <span class="caption">Comfort & travel lifestyle</span>
        </div>
        <div class="stat">
          <span class="caption">Coast FIRE</span>
          <span class="stat-value">${h(money(res.coast_fire))}</span>
          <span class="caption">Threshold needed today for zero further savings</span>
        </div>
        <div class="stat">
          <span class="caption">Barista FIRE</span>
          <span class="stat-value">${h(money(res.barista_fire))}</span>
          <span class="caption">Target if 40% covered by part-time work</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Retirement Cashflow & Longevity</div>
        <div class="grid-2" style="margin-bottom:10px">
          <div>
            <span class="caption">Safe Monthly Pension</span>
            <div class="title" style="color:var(--income)">${h(money(res.safe_monthly_withdrawal_at_retirement))}</div>
            <span class="caption">Inflation-adjusted withdrawal</span>
          </div>
          <div>
            <span class="caption">Real Portfolio Growth</span>
            <div class="title" style="color:var(--primary)">+${res.real_return_rate_percent}%/yr</div>
            <span class="caption">Net of ${read('fireInflation')}% inflation</span>
          </div>
        </div>
        ${profile.active_loan_emi > 0 ? `
          <div class="caption" style="padding:8px 0;border-top:1px solid var(--outline-variant)">
            ${icon('account_balance', 'icon-sm')} Active loan EMIs (${money(profile.active_loan_emi)}/mo) conclude before retirement, automatically lowering post-retirement living expenses.
          </div>` : ''}
      </div>`;
  };

  // Multiplier chip selections
  container.querySelectorAll('[data-multiplier]').forEach((chip) => {
    chip.addEventListener('click', () => {
      container.querySelectorAll('[data-multiplier]').forEach((c) => {
        c.classList.remove('active');
        c.setAttribute('aria-selected', 'false');
      });
      chip.classList.add('active');
      chip.setAttribute('aria-selected', 'true');
      activeMultiplier = Number(chip.dataset.multiplier) || 25;
      calculate();
    });
  });

  // Calculate button
  container.querySelector('[data-calc]').addEventListener('click', calculate);

  // Save Settings button
  container.querySelector('[data-save-settings]').addEventListener('click', async () => {
    await Bridge.call('fire', {
      action: 'save_settings',
      fire_current_age: read('fireAge'),
      fire_target_age: read('fireRetireAge'),
      fire_expected_cagr: read('fireCagr'),
      fire_inflation_rate: read('fireInflation'),
      fire_multiplier: activeMultiplier,
      fire_step_up_percent: read('fireStepUp'),
    });
    toast('Retirement settings saved.');
  });

  // Reset to live data
  const resetBtn = container.querySelector('[data-reset-live]');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      document.getElementById('fireNetWorth').value = profile.net_worth;
      document.getElementById('fireExpenses').value = profile.monthly_expenses;
      document.getElementById('fireSavings').value = profile.monthly_savings;
      document.getElementById('fireCagr').value = profile.weighted_cagr || 12;
      document.getElementById('fireInflation').value = 6;
      document.getElementById('fireStepUp').value = 0;
      calculate();
      toast('Reset to live ledger values.');
    });
  }

  await calculate();
}

