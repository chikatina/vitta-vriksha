/*
 * Budgets: where this month's money went, and how each category is tracking against
 * the cap you set for it.
 */

import { Bridge } from '../bridge.js';
import { icon, h, sheet, toast, confirmDialog, emptyState } from '../ui.js';
import { formatCurrency, todayISO } from '../formatters.js';
import { donutChart, bindChartSelect } from '../charts.js';
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
  '#0E6B5A', '#10B981', '#14B8A6', '#06B6D4', '#3B82F6', '#6366F1', '#8B5CF6',
  '#D946EF', '#EC4899', '#FB7185', '#EF4444', '#F97316', '#F59E0B', '#84CC16', '#64748B',
];

const TYPES = ['Expense', 'Income', 'Investment'];

export async function renderBudgets(container, app) {
  const [categoryRes, summaryRes] = await Promise.all([
    Bridge.db('get_categories'),
    Bridge.db('get_summary', { member_id: app.memberFilter }),
  ]);

  const categories = categoryRes.categories || [];
  const budget = Number(summaryRes.monthly_budget || 0);
  const spentThisMonth = Number(summaryRes.this_month?.expense || 0);
  const money = (v) => formatCurrency(v, app.currency, app.locale);

  const expenses = categories
    .filter((c) => c.type === 'Expense' && c.spent_this_month > 0)
    .sort((a, b) => b.spent_this_month - a.spent_this_month);

  const withCaps = categories.filter((c) => Number(c.monthly_budget) > 0);
  const totalSpent = expenses.reduce((s, c) => s + c.spent_this_month, 0);

  container.innerHTML = `
    <div class="card">
      <div class="row-between" style="margin-bottom:12px">
        <span class="title">Overall budget</span>
        <button class="btn btn-text btn-sm" data-set-budget>${budget > 0 ? 'Change' : 'Set'}</button>
      </div>
      ${budget > 0 ? `
        <div class="row-between" style="margin-bottom:10px">
          <span class="display" style="font-size:26px">${h(money(spentThisMonth))}</span>
          <span class="caption">of ${h(money(budget))}</span>
        </div>
        <div class="progress">
          <div class="progress-bar ${spentThisMonth > budget ? 'over' : ''}"
               style="width:${Math.min(100, budget ? (spentThisMonth / budget) * 100 : 0)}%"></div>
        </div>
        <div class="caption" style="margin-top:8px">
          ${spentThisMonth > budget
            ? `Over by ${h(money(spentThisMonth - budget))}.`
            : `${h(money(budget - spentThisMonth))} remaining.`}
        </div>`
      : `<p class="caption">Set a monthly spending limit.</p>`}
    </div>

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
      <div class="section-header"><span class="title">Category limits</span></div>
      <div class="card" style="display:flex;flex-direction:column;gap:16px">
        ${withCaps.map((c) => {
          const used = Number(c.monthly_budget) ? (c.spent_this_month / c.monthly_budget) * 100 : 0;
          return `
            <div class="bar-row">
              <div class="bar-head">
                <span class="row" style="gap:8px;min-width:0">
                  <span style="color:${h(c.color)};display:flex">${icon(c.icon || 'sell', 'icon-sm')}</span>
                  <span class="legend-label">${h(c.name)}</span>
                </span>
                <span class="legend-value">${h(money(c.spent_this_month))} / ${h(money(c.monthly_budget))}</span>
              </div>
              <div class="bar-track">
                <div class="bar-fill" style="width:${Math.min(100, used)}%;background:${used > 100 ? 'var(--expense)' : h(c.color)}"></div>
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
                <span class="list-row-sub">${h(c.type)}${Number(c.monthly_budget) > 0 ? ` · cap ${h(money(c.monthly_budget))}` : ''}</span>
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

  /*
   * A category row leads to its history, not straight to its settings.
   *
   * Tapping a category and being asked to choose an icon was the wrong answer to the
   * question the tap was asking, which is almost always "why is this so high". Editing is
   * still one tap further in, at the bottom of the sheet.
   */
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
      <label class="field-label" for="catBudget">Monthly cap</label>
      <input class="input numeric" id="catBudget" data-budget type="number" inputmode="decimal"
             min="0" placeholder="No cap" value="${draft.monthly_budget || ''}">
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
