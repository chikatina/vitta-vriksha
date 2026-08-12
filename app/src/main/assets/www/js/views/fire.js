/* Retirement targets and the path to them. */

import { Bridge } from '../bridge.js';
import { icon, h, errorBlock } from '../ui.js';
import { formatCurrency } from '../formatters.js';
import { areaChart } from '../charts.js';

const INPUTS = [
  { id: 'fireAge', label: 'Your age', value: 30 },
  { id: 'fireRetireAge', label: 'Retire at', value: 50 },
  { id: 'fireExpenses', label: 'Monthly spending', value: 60000 },
  { id: 'fireSavings', label: 'Monthly saving', value: 40000 },
];

export async function renderFire(container, app) {
  container.innerHTML = `
    <div class="card">
      <div class="card-title">Retirement targets</div>
      <p class="caption" style="margin-bottom:16px">
        Estimated using standard safe withdrawal rate adjusted for inflation.
      </p>

      <div class="grid-2">
        ${INPUTS.map((input) => `
          <div class="field">
            <label class="field-label" for="${input.id}">${h(input.label)}</label>
            <input class="input numeric" id="${input.id}" type="number" inputmode="numeric" value="${input.value}">
          </div>`).join('')}
      </div>

      <button class="btn btn-filled btn-block" data-calc style="margin-top:16px">
        ${icon('rocket_launch')}Calculate
      </button>
    </div>

    <div data-output></div>`;

  const calculate = async () => {
    const read = (id) => Number(document.getElementById(id).value) || 0;
    const output = container.querySelector('[data-output]');

    const res = await Bridge.call('fire', {
      current_age: read('fireAge'),
      target_retirement_age: read('fireRetireAge'),
      monthly_expenses: read('fireExpenses'),
      monthly_savings: read('fireSavings'),
    });

    if (res.status !== 'success') {
      output.innerHTML = `<div class="card">${errorBlock(res, { compact: true })}</div>`;
      return;
    }

    const money = (v) => formatCurrency(v, app.currency, app.locale);
    const curve = (res.projection_curve || []).map((point) => ({
      label: `Age ${point.age}`,
      value: point.projected_net_worth,
    }));

    output.innerHTML = `
      <div class="card-accent">
        <span class="overline" style="color:inherit;opacity:0.7">Target corpus</span>
        <div class="balance-amount" style="font-size:30px">${h(money(res.fire_number))}</div>
        <div class="caption" style="color:inherit;opacity:0.85;margin-top:4px">
          ${res.is_fire_achievable
            ? `On track to reach ${money(res.projected_corpus_at_retirement)} at retirement.`
            : `Projected ${money(res.projected_corpus_at_retirement)} at retirement (short of target).`}
        </div>
      </div>

      ${curve.length > 1 ? `
        <div class="card">
          <div class="card-title">Projected corpus</div>
          ${areaChart(curve)}
          <div class="row-between caption" style="margin-top:8px">
            <span>${h(curve[0].label)}</span>
            <span>${h(curve[curve.length - 1].label)}</span>
          </div>
        </div>` : ''}

      <div class="grid-2">
        <div class="stat">
          <span class="caption">Lean</span>
          <span class="stat-value">${h(money(res.lean_fire))}</span>
          <span class="caption">Basic expenses</span>
        </div>
        <div class="stat">
          <span class="caption">Fat</span>
          <span class="stat-value">${h(money(res.fat_fire))}</span>
          <span class="caption">Comfortable lifestyle</span>
        </div>
        <div class="stat" style="grid-column:1/-1">
          <span class="caption">Coast</span>
          <span class="stat-value">${h(money(res.coast_fire))}</span>
          <span class="caption">
            Corpus needed today to compound into target with no further additions.
          </span>
        </div>
      </div>`;
  };

  container.querySelector('[data-calc]').addEventListener('click', calculate);
  await calculate();
}
