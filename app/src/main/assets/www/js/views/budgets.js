/*
 * Budgets: where this month's money went, category caps, daily run-rate,
 * and multi-month Salary vs Investment Outflow trend.
 */

import { Bridge } from '../bridge.js';
import { icon, h, sheet, toast, confirmDialog, emptyState } from '../ui.js';
import { formatCurrency, formatPercent, formatMonthKey, todayISO } from '../formatters.js';
import { donutChart, barSeriesChart, bindChartSelect } from '../charts.js';
import { openCategoryTrend, openSliceSheet } from './drilldown.js';

const ICON_CHOICES = [
  'shopping_cart', 'restaurant', 'fastfood', 'local_cafe', 'bolt', 'home', 'directions_car',
  'local_gas_station', 'directions_bus', 'train', 'local_taxi', 'flight', 'hotel', 'luggage',
  'medical_services', 'local_hospital', 'local_pharmacy', 'fitness_center', 'spa',
  'shopping_bag', 'checkroom', 'diamond', 'movie', 'theaters', 'sports_esports',
  'sports_soccer', 'headphones', 'menu_book', 'school', 'child_care', 'pets', 'cake',
  'celebration', 'redeem', 'volunteer_activism', 'shield', 'build', 'wifi', 'water_drop',
  'subscriptions', 'credit_card', 'real_estate_agent', 'work', 'computer', 'savings',
  'trending_up', 'payments', 'receipt_long', 'sell', 'star',
];

const COLOR_CHOICES = [
  '#88A838', '#988818', '#F8C828', '#083828', '#10B981', '#14B8A6', '#06B6D4', '#3B82F6',
  '#6366F1', '#8B5CF6', '#D946EF', '#EC4899', '#EF4444', '#F97316', '#64748B',
];

const TYPES = ['Expense', 'Income', 'Investment'];

export async function renderBudgets(container, app) {
  const [categoryRes, summaryRes, trendRes] = await Promise.all([
    Bridge.db('get_categories'),
    Bridge.db('get_summary', { member_id: app.memberFilter }),
    Bridge.db('get_salary_investment_trend', { member_id: app.memberFilter }),
  ]);

  const categories = categoryRes.categories || [];
  const budget = Number(summaryRes.monthly_budget || 0);
  const spentThisMonth = Number(summaryRes.this_month?.expense || 0);
  const incomeThisMonth = Number(summaryRes.this_month?.income || 0);
  const investedThisMonth = Number(summaryRes.this_month?.invested || 0);
  const money = (v) => formatCurrency(v, app.currency, app.locale);

  // Daily Safe-to-Spend pacing calculations
  const now = new Date();
  const totalDaysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const currentDay = now.getDate();
  const daysRemaining = Math.max(1, totalDaysInMonth - currentDay + 1);
  const remainingBudget = Math.max(0, budget - spentThisMonth);
  const dailySafeSpend = budget > 0 ? Math.round(remainingBudget / daysRemaining) : 0;
  const isOverBudget = budget > 0 && spentThisMonth > budget;

  const expenses = categories
    .filter((c) => c.type === 'Expense' && c.spent_this_month > 0)
    .sort((a, b) => b.spent_this_month - a.spent_this_month);

  const withCaps = categories.filter((c) => Number(c.monthly_budget) > 0);
  const totalSpent = expenses.reduce((s, c) => s + c.spent_this_month, 0);

  // Multi-month Salary vs Investment Outflow Trend data
  const trendMonths = trendRes.months || [];
  const trendLabels = trendMonths.map((m) => formatMonthKey(m.month_key).slice(0, 3));
  const trendSeries = [
    { name: 'Income (Salary)', color: 'var(--income)', values: trendMonths.map((m) => m.income) },
    { name: 'Invested', color: 'var(--investment)', values: trendMonths.map((m) => m.invested) },
    { name: 'Expenses', color: 'var(--expense)', values: trendMonths.map((m) => m.expense) },
  ];

  container.innerHTML = `
    <div class="card" style="background:linear-gradient(180deg, var(--surface-container-low), var(--surface-container));border:1px solid var(--outline-variant)">
      <div class="row-between" style="margin-bottom:10px">
        <span class="title">Overall Monthly Budget</span>
        <button class="btn btn-text btn-sm" data-set-budget>${budget > 0 ? 'Change limit' : 'Set limit'}</button>
      </div>

      ${budget > 0 ? `
        <div class="row-between" style="align-items:baseline;margin-bottom:8px">
          <span class="display" style="font-size:26px">${h(money(spentThisMonth))}</span>
          <span class="caption">Budget: <strong>${h(money(budget))}</strong></span>
        </div>

        <div class="progress" style="height:10px;margin-bottom:12px">
          <div class="progress-bar ${isOverBudget ? 'over' : ''}"
               style="width:${Math.min(100, (spentThisMonth / budget) * 100)}%"></div>
        </div>

        <div class="grid-2" style="gap:8px;margin-top:var(--gap-2)">
          <div class="card-flat" style="padding:10px;background:var(--surface-container-high);border-radius:var(--radius-sm)">
            <span class="caption" style="font-size:11px;display:block">Daily Safe-to-Spend</span>
            <div style="font-size:16px;font-weight:700;margin:2px 0" class="${isOverBudget ? 'expense' : 'income'}">
              ${isOverBudget ? h(money(0)) : h(money(dailySafeSpend))}<span style="font-size:11px;font-weight:400;color:var(--on-surface-variant)">/day</span>
            </div>
            <span class="caption" style="font-size:11px">${daysRemaining} days left in ${formatMonthKey(todayISO().slice(0, 7)).split(' ')[0]}</span>
          </div>

          <div class="card-flat" style="padding:10px;background:var(--surface-container-high);border-radius:var(--radius-sm)">
            <span class="caption" style="font-size:11px;display:block">Remaining Pool</span>
            <div style="font-size:16px;font-weight:700;margin:2px 0" class="${isOverBudget ? 'expense' : 'on-surface'}">
              ${isOverBudget ? `-${h(money(spentThisMonth - budget))}` : h(money(remainingBudget))}
            </div>
            <span class="caption" style="font-size:11px">${isOverBudget ? 'Over limit' : `${Math.round(((budget - spentThisMonth) / budget) * 100)}% unspent`}</span>
          </div>
        </div>`
      : `<p class="caption" style="margin-bottom:8px">Set a monthly spending limit to activate daily run-rate pacing and safe spending alerts.</p>`}
    </div>

    ${trendMonths.length && trendMonths.some((m) => m.income > 0 || m.invested > 0 || m.expense > 0) ? `
      <div class="card">
        <div class="card-title">
          <span>Salary vs Investment & Spends</span>
          <span class="caption">Past 6 months</span>
        </div>

        <div style="margin-top:8px">
          ${barSeriesChart(trendLabels, trendSeries, {
            format: (v) => money(v),
            height: 165,
            stacked: false,
          })}
        </div>

        <div class="row" style="gap:12px;margin-top:12px;justify-content:center;flex-wrap:wrap">
          <div class="row" style="gap:6px;font-size:12px">
            <span class="legend-dot" style="background:var(--income)"></span><span>Salary / Income</span>
          </div>
          <div class="row" style="gap:6px;font-size:12px">
            <span class="legend-dot" style="background:var(--investment)"></span><span>Investments</span>
          </div>
          <div class="row" style="gap:6px;font-size:12px">
            <span class="legend-dot" style="background:var(--expense)"></span><span>Expenses</span>
          </div>
        </div>
      </div>` : ''}

    ${expenses.length ? `
    <div class="card">
      <div class="card-title">
        <span>This month by category</span>
        <button class="btn btn-text btn-sm" data-insights>${icon('query_stats', 'icon-sm')}Trends</button>
      </div>
      <div data-donut>
        ${donutChart(
          expenses.slice(0, 7).map((c) => ({
            key: c.name, label: c.name, value: c.spent_this_month, color: c.color,
            formatted: money(c.spent_this_month),
          })),
          { centerLabel: 'Spent', centerValue: money(totalSpent), selectable: true },
        )}
      </div>
    </div>` : ''}

    ${withCaps.length ? `
    <div class="section">
      <div class="section-header"><span class="title">Category Limits</span></div>
      <div class="card" style="display:flex;flex-direction:column;gap:14px">
        ${withCaps.map((c) => {
          const cap = Number(c.monthly_budget) || 1;
          const usedPct = Math.round((c.spent_this_month / cap) * 100);
          const isOver = usedPct > 100;
          return `
            <div class="bar-row" style="cursor:pointer" data-edit-cap="${c.id}">
              <div class="bar-head" style="margin-bottom:4px">
                <span class="row" style="gap:8px;min-width:0;align-items:center">
                  <span style="color:${h(c.color)};display:flex">${icon(c.icon || 'sell', 'icon-sm')}</span>
                  <span class="legend-label" style="font-weight:600">${h(c.name)}</span>
                  ${isOver ? `<span class="badge badge-expense" style="font-size:10px;padding:1px 5px">Over cap</span>` : ''}
                </span>
                <span class="legend-value" style="font-size:12px">
                  <strong>${h(money(c.spent_this_month))}</strong> / ${h(money(c.monthly_budget))} (${usedPct}%)
                </span>
              </div>
              <div class="bar-track" style="height:8px">
                <div class="bar-fill" style="width:${Math.min(100, usedPct)}%;background:${isOver ? 'var(--expense)' : (usedPct > 85 ? 'var(--warning)' : h(c.color))}"></div>
              </div>
            </div>`;
        }).join('')}
      </div>
    </div>` : ''}

    <div class="section">
      <div class="section-header">
        <span class="title">Categories</span>
        <button class="btn btn-text btn-sm" data-new>${icon('add', 'icon-sm')}New</button>
      </div>
      ${categories.length ? `
        <div class="list">
          ${categories.map((c) => `
            <button class="list-row" data-category="${c.id}">
              <span class="avatar" style="background:${h(c.color)}">${icon(c.icon || 'sell')}</span>
              <span class="list-row-main">
                <span class="list-row-title">${h(c.name)}</span>
                <span class="list-row-sub">${h(c.type)}${Number(c.monthly_budget) > 0 ? ` · cap ${h(money(c.monthly_budget))}` : ' · tap to set cap'}</span>
              </span>
              <span class="list-row-amount">${c.spent_this_month > 0 ? h(money(c.spent_this_month)) : ''}</span>
            </button>`).join('')}
        </div>`
      : `<div class="card">${emptyState('donut_small', 'No categories', 'Add one to start sorting your spending.')}</div>`}
    </div>`;

  container.querySelector('[data-set-budget]').addEventListener('click', async () => {
    const value = await promptAmount(app, 'Monthly budget', budget || '');
    if (value === null) return;
    const res = await app.db('update_setting', { key: 'monthly_budget', value: String(value) });
    if (res) {
      toast(value > 0 ? 'Budget updated.' : 'Budget cleared.', 'success');
      app.refresh();
    }
  });

  container.querySelector('[data-new]').addEventListener('click', () => openCategorySheet(app, null));

  const insights = container.querySelector('[data-insights]');
  if (insights) insights.addEventListener('click', () => app.go('budgets', 'insights'));

  const thisMonth = todayISO().slice(0, 7);

  const donut = container.querySelector('[data-donut]');
  if (donut) {
    bindChartSelect(donut, (name) => {
      openSliceSheet(app, {
        dimension: 'category', key: name, label: name, granularity: 'month', bucket: thisMonth,
      });
    });
  }

  container.querySelectorAll('[data-edit-cap]').forEach((row) => {
    row.addEventListener('click', () => {
      const category = categories.find((c) => String(c.id) === row.dataset.editCap);
      if (category) openCategorySheet(app, category);
    });
  });

  container.querySelectorAll('[data-category]').forEach((row) => {
    row.addEventListener('click', () => {
      const category = categories.find((c) => String(c.id) === row.dataset.category);
      if (!category) return;
      openCategoryTrend(app, category, { onEdit: () => openCategorySheet(app, category) });
    });
  });
}

async function promptAmount(app, title, current) {
  const result = await sheet(title, `
    <input class="amount-input numeric" data-amount type="number" inputmode="decimal"
           min="0" step="1" placeholder="0" value="${h(current)}">
    <p class="caption" style="text-align:center">Enter zero to remove the cap.</p>`, {
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-save>Save</button>`,
    onMount(node, close) {
      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));
      node.querySelector('[data-save]').addEventListener('click', () => {
        close({ value: Math.max(0, Number(node.querySelector('[data-amount]').value) || 0) });
      });
    },
  });
  return result ? result.value : null;
}

async function openCategorySheet(app, existing) {
  const draft = {
    id: existing?.id || null,
    name: existing?.name || '',
    type: existing?.type || 'Expense',
    icon: existing?.icon || 'sell',
    color: existing?.color || COLOR_CHOICES[0],
    monthly_budget: existing?.monthly_budget || 0,
  };

  const body = `
    <div class="row" style="gap:14px">
      <span class="avatar" data-preview style="background:${h(draft.color)};width:52px;height:52px">
        ${icon(draft.icon)}
      </span>
      <div class="field" style="flex:1">
        <label class="field-label" for="catName">Name</label>
        <input class="input" id="catName" data-name type="text" value="${h(draft.name)}"
               placeholder="Groceries" autocomplete="off">
      </div>
    </div>

    <div class="field">
      <span class="field-label">Kind</span>
      <div class="segmented" data-types>
        ${TYPES.map((t) => `<button type="button" data-type="${t}" aria-selected="${t === draft.type}">${t}</button>`).join('')}
      </div>
    </div>

    <div class="field">
      <span class="field-label">Colour</span>
      <div class="swatch-grid" data-colors>
        ${COLOR_CHOICES.map((c) => `
          <button type="button" class="swatch" data-color="${c}" style="background:${c}"
                  aria-selected="${c === draft.color}" aria-label="Colour ${c}">${icon('check', 'icon-sm')}</button>`).join('')}
      </div>
    </div>

    <div class="field">
      <span class="field-label">Icon</span>
      <div class="picker-grid" data-icons>
        ${ICON_CHOICES.map((name) => `
          <button type="button" class="picker-cell" data-icon="${name}"
                  aria-selected="${name === draft.icon}" aria-label="${name}">${icon(name)}</button>`).join('')}
      </div>
    </div>

    <div class="field">
      <label class="field-label" for="catBudget">Monthly cap (budget limit)</label>
      <input class="input numeric" id="catBudget" data-budget type="number" inputmode="decimal"
             min="0" placeholder="No cap" value="${draft.monthly_budget || ''}">
      <p class="caption" style="margin-top:4px">Sets a spending limit for this category.</p>
    </div>

    ${existing ? `<button class="btn btn-danger-text btn-block" data-delete>${icon('delete')}Delete category</button>` : ''}`;

  const saved = await sheet(existing ? 'Edit category' : 'New category', body, {
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-save>Save</button>`,
    onMount(node, close) {
      const preview = node.querySelector('[data-preview]');

      const repaint = () => {
        preview.style.background = draft.color;
        preview.innerHTML = icon(draft.icon);
      };

      const wire = (selector, attr, apply) => {
        node.querySelectorAll(selector).forEach((btn) => {
          btn.addEventListener('click', () => {
            apply(btn.dataset[attr]);
            node.querySelectorAll(selector).forEach((b) => {
              b.setAttribute('aria-selected', String(b.dataset[attr] === draft[attr]));
            });
            repaint();
          });
        });
      };

      wire('[data-type]', 'type', (v) => { draft.type = v; });
      wire('[data-color]', 'color', (v) => { draft.color = v; });
      wire('[data-icon]', 'icon', (v) => { draft.icon = v; });

      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));

      node.querySelector('[data-save]').addEventListener('click', async () => {
        const name = node.querySelector('[data-name]').value.trim();
        if (!name) {
          toast('Give the category a name.', 'error');
          return;
        }
        const res = await app.db('save_category', {
          category: {
            ...draft,
            name,
            monthly_budget: Number(node.querySelector('[data-budget]').value) || 0,
          },
        });
        if (res) {
          toast('Category saved.', 'success');
          close(true);
        }
      });

      const deleteButton = node.querySelector('[data-delete]');
      if (deleteButton) {
        deleteButton.addEventListener('click', async () => {
          const confirmed = await confirmDialog('Delete this category?',
            'Transactions already filed under it keep the name, but it will no longer be offered.',
            { confirmLabel: 'Delete', danger: true });
          if (!confirmed) return;
          const res = await app.db('delete_category', { category_id: draft.id });
          if (res) {
            toast('Category deleted.', 'success');
            close(true);
          }
        });
      }
    },
  });

  if (saved) app.refresh();
}
