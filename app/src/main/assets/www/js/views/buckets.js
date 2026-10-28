/*
 * Custom Buckets and Trips view.
 *
 * Allows grouping transactions for specific events, projects, or trips
 * (e.g., "Trip to Japan 2025", "Home Renovation", "Wedding 2026").
 *
 * Provides dedicated budget tracking, category breakdowns, and direct filtering.
 */

import { Bridge } from '../bridge.js';
import {
  bindSelectFields, confirmDialog, errorBlock, h, icon, selectField, sheet, toast,
} from '../ui.js';
import { formatCurrency } from '../formatters.js';
import { openTransactionSheet } from './transaction-sheet.js';

const BUCKET_ICONS = [
  { value: 'flight', label: 'Flight / International' },
  { value: 'luggage', label: 'Travel / Vacation' },
  { value: 'home', label: 'Home / Renovation' },
  { value: 'shopping_bag', label: 'Shopping / Festive' },
  { value: 'celebration', label: 'Celebration / Event' },
  { value: 'train', label: 'Transit / Commute' },
];

export async function renderBuckets(container, app) {
  container.innerHTML = `
    <div class="app-bar">
      <button type="button" class="icon-btn" id="buckets-back-btn" aria-label="Back">
        ${icon('arrow_back')}
      </button>
      <span class="app-bar-title">Buckets & Trips</span>
      <button type="button" class="btn btn-filled btn-sm" id="buckets-add-btn">
        ${icon('add')} <span>New Bucket</span>
      </button>
    </div>
    <div class="page-content" id="buckets-content">
      <div class="caption" style="text-align:center;padding:24px 0">Loading buckets...</div>
    </div>`;

  const backBtn = container.querySelector('#buckets-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      app.navigate('more');
    });
  }

  const addBtn = container.querySelector('#buckets-add-btn');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      openBucketSheet(app, null, () => renderBuckets(container, app));
    });
  }

  const content = container.querySelector('#buckets-content');
  await loadAndRenderBuckets(content, app);
}

async function loadAndRenderBuckets(container, app) {
  const res = await Bridge.db('get_transaction_buckets', { member_id: app.memberFilter });
  if (res && res.status === 'error') {
    container.innerHTML = errorBlock(res);
    return;
  }

  const buckets = res.buckets || [];
  if (!buckets.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${icon('luggage', 'icon-xl')}</div>
        <div class="empty-state-title">No custom buckets yet</div>
        <div class="empty-state-desc">
          Group transactions for specific goals, trips, or events like "Trip to Japan 2025" or "Home Renovation".
        </div>
        <button type="button" class="btn btn-filled" id="empty-add-bucket-btn" style="margin-top:var(--gap-3)">
          ${icon('add')} <span>Create Bucket</span>
        </button>
      </div>`;

    const emptyAddBtn = container.querySelector('#empty-add-bucket-btn');
    if (emptyAddBtn) {
      emptyAddBtn.addEventListener('click', () => {
        openBucketSheet(app, null, () => loadAndRenderBuckets(container, app));
      });
    }
    return;
  }

  const totalBudget = buckets.reduce((sum, b) => sum + (Number(b.target_budget) || 0), 0);
  const totalSpent = buckets.reduce((sum, b) => sum + (Number(b.total_spent) || 0), 0);

  const cardsHtml = buckets.map((b) => {
    const budget = Number(b.target_budget) || 0;
    const spent = Number(b.total_spent) || 0;
    const isOver = budget > 0 && spent > budget;
    const progressPct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
    const count = Number(b.transaction_count) || 0;

    let dateText = '';
    if (b.start_date || b.end_date) {
      dateText = ` · ${b.start_date || 'Start'} to ${b.end_date || 'Present'}`;
    }

    return `
      <div class="card bucket-card" data-bucket-id="${b.id}" style="margin-bottom:var(--gap-3)">
        <div class="row" style="justify-content:space-between;align-items:flex-start">
          <div class="row" style="gap:var(--gap-3);align-items:center">
            <div class="icon-avatar" style="background:color-mix(in srgb, var(--accent) 15%, var(--surface-container));color:var(--accent);width:40px;height:40px;border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center">
              ${icon(b.icon || 'folder')}
            </div>
            <div>
              <div class="title" style="font-weight:600;font-size:16px">${h(b.name)}</div>
              <div class="caption">${h(b.status === 'active' ? 'Active' : 'Archived')} · ${count} transaction${count === 1 ? '' : 's'}${h(dateText)}</div>
            </div>
          </div>
          <button type="button" class="icon-btn edit-bucket-btn" data-id="${b.id}" aria-label="Edit bucket">
            ${icon('edit')}
          </button>
        </div>

        <div style="margin-top:var(--gap-3)">
          <div class="row" style="justify-content:space-between;margin-bottom:6px">
            <span class="caption">Spent: <strong>${formatCurrency(spent)}</strong></span>
            <span class="caption">${budget > 0 ? `Budget: ${formatCurrency(budget)}` : 'No budget set'}</span>
          </div>
          ${budget > 0 ? `
            <div class="progress-bar-bg" style="height:6px;border-radius:3px;background:var(--surface-container-highest);overflow:hidden">
              <div class="progress-bar-fill ${isOver ? 'is-danger' : ''}" style="width:${progressPct}%;height:100%;background:${isOver ? 'var(--expense)' : 'var(--accent)'};border-radius:3px"></div>
            </div>
            <div class="row" style="justify-content:flex-end;margin-top:4px">
              <span class="caption" style="color:${isOver ? 'var(--expense)' : 'var(--on-surface-variant)'}">
                ${isOver ? `Over by ${formatCurrency(spent - budget)}` : `${formatCurrency(budget - spent)} remaining (${progressPct}%)`}
              </span>
            </div>
          ` : ''}
        </div>

        <div class="row" style="justify-content:flex-end;gap:var(--gap-2);margin-top:var(--gap-3);border-top:1px solid var(--outline);padding-top:var(--gap-2)">
          <button type="button" class="btn btn-outlined btn-sm view-ledger-btn" data-id="${b.id}">
            ${icon('receipt_long')} <span>View Transactions</span>
          </button>
          <button type="button" class="btn btn-filled btn-sm add-expense-btn" data-id="${b.id}">
            ${icon('add')} <span>Add Expense</span>
          </button>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `
    <div class="card-accent" style="margin-bottom:var(--gap-3)">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div>
          <div class="caption">Total Tracked in Buckets</div>
          <div class="title" style="font-size:20px;font-weight:700">${formatCurrency(totalSpent)}</div>
        </div>
        ${totalBudget > 0 ? `
          <div style="text-align:right">
            <div class="caption">Allocated Budget</div>
            <div class="title" style="font-size:18px">${formatCurrency(totalBudget)}</div>
          </div>
        ` : ''}
      </div>
    </div>

    <div class="section-header" style="margin-bottom:var(--gap-2)">
      <span class="title">Your Buckets & Trips (${buckets.length})</span>
    </div>

    ${cardsHtml}`;

  // Bind actions
  container.querySelectorAll('.edit-bucket-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const b = buckets.find((item) => String(item.id) === String(id));
      if (b) openBucketSheet(app, b, () => loadAndRenderBuckets(container, app));
    });
  });

  container.querySelectorAll('.view-ledger-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      app.bucketFilter = Number(id);
      app.navigate('ledger');
    });
  });

  container.querySelectorAll('.add-expense-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const written = await openTransactionSheet(app, { bucket_id: Number(id) });
      if (written) loadAndRenderBuckets(container, app);
    });
  });
}

/**
 * Bottom sheet to add or edit a transaction bucket.
 */
export async function openBucketSheet(app, existing = null, onSaved = null) {
  const isEdit = Boolean(existing && existing.id);
  const title = isEdit ? 'Edit Bucket' : 'New Bucket';

  const initialIcon = existing?.icon || 'luggage';
  const initialStatus = existing?.status || 'active';

  const body = `
    <div class="field">
      <label class="field-label" for="bucket-name">Bucket Name</label>
      <input type="text" id="bucket-name" class="input" placeholder="e.g. Trip To Japan 2025, Home Renovation" value="${h(existing?.name || '')}" required />
    </div>

    <div class="field" style="margin-top:var(--gap-3)">
      <label class="field-label" for="bucket-budget">Target Budget (Optional)</label>
      <input type="number" id="bucket-budget" class="input" placeholder="e.g. 150000" value="${existing?.target_budget ? Number(existing.target_budget) : ''}" min="0" step="any" />
    </div>

    <div class="field" style="margin-top:var(--gap-3)">
      ${selectField({
    key: 'bucket_icon',
    id: 'select_bucket_icon',
    label: 'Icon',
    value: initialIcon,
    options: BUCKET_ICONS,
  })}
    </div>

    <div class="row" style="gap:var(--gap-2);margin-top:var(--gap-3)">
      <div class="field" style="flex:1">
        <label class="field-label" for="bucket-start-date">Start Date</label>
        <input type="date" id="bucket-start-date" class="input" value="${h(existing?.start_date || '')}" />
      </div>
      <div class="field" style="flex:1">
        <label class="field-label" for="bucket-end-date">End Date</label>
        <input type="date" id="bucket-end-date" class="input" value="${h(existing?.end_date || '')}" />
      </div>
    </div>

    <div class="field" style="margin-top:var(--gap-3)">
      ${selectField({
    key: 'bucket_status',
    id: 'select_bucket_status',
    label: 'Status',
    value: initialStatus,
    options: [
      { value: 'active', label: 'Active' },
      { value: 'archived', label: 'Archived' },
    ],
  })}
    </div>

    <div class="field" style="margin-top:var(--gap-3)">
      <label class="field-label" for="bucket-notes">Notes</label>
      <textarea id="bucket-notes" class="input" rows="2" placeholder="Flight details, contractor numbers, itinerary...">${h(existing?.notes || '')}</textarea>
    </div>`;

  const actions = `
    <div style="display:flex;justify-content:space-between;align-items:center;width:100%">
      ${isEdit ? `
        <button type="button" class="btn btn-outlined" data-delete style="color:var(--expense);border-color:var(--expense)">
          ${icon('delete')} <span>Delete</span>
        </button>
      ` : '<div></div>'}
      <div style="display:flex;gap:var(--gap-2)">
        <button type="button" class="btn btn-outlined" data-cancel>Cancel</button>
        <button type="button" class="btn btn-filled" data-save>Save</button>
      </div>
    </div>`;

  await sheet(title, body, {
    actions,
    onMount(node, close) {
      bindSelectFields(node);

      const cancelBtn = node.querySelector('[data-cancel]');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => close(null));
      }

      const saveBtn = node.querySelector('[data-save]');
      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          const nameInput = node.querySelector('#bucket-name');
          const name = nameInput.value.trim();
          if (!name) {
            toast('Please enter a bucket name.', 'danger');
            nameInput.focus();
            return;
          }

          const budgetInput = node.querySelector('#bucket-budget');
          const targetBudget = budgetInput.value ? Number.parseFloat(budgetInput.value) : 0;

          const iconBtn = node.querySelector('.select-button[data-field="bucket_icon"]');
          const selectedIcon = iconBtn?.dataset.value || 'luggage';

          const statusBtn = node.querySelector('.select-button[data-field="bucket_status"]');
          const status = statusBtn?.dataset.value || 'active';

          const startDate = node.querySelector('#bucket-start-date').value || null;
          const endDate = node.querySelector('#bucket-end-date').value || null;
          const notes = node.querySelector('#bucket-notes').value.trim();

          const payload = {
            id: existing?.id || null,
            member_id: app.memberFilter,
            name,
            target_budget: targetBudget,
            icon: selectedIcon,
            status,
            start_date: startDate,
            end_date: endDate,
            notes,
          };

          const res = await Bridge.db('save_transaction_bucket', { bucket: payload });
          if (res && res.status === 'success') {
            toast(isEdit ? 'Bucket updated.' : 'Bucket created.', 'success');
            close(true);
            if (onSaved) onSaved();
          } else {
            toast((res && res.message) || 'Failed to save bucket.', 'danger');
          }
        });
      }

      const deleteBtn = node.querySelector('[data-delete]');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
          const confirmed = await confirmDialog(
            'Delete Bucket?',
            `Delete "${existing.name}"? Transactions in this bucket will remain safe and will simply become untagged.`,
            { confirmLabel: 'Delete', danger: true },
          );
          if (confirmed) {
            const res = await Bridge.db('delete_transaction_bucket', { bucket_id: existing.id });
            if (res && res.status === 'success') {
              toast('Bucket deleted.', 'success');
              close(true);
              if (onSaved) onSaved();
            } else {
              toast((res && res.message) || 'Failed to delete bucket.', 'danger');
            }
          }
        });
      }
    },
  });
}
