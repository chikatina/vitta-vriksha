/*
 * Interactive notification tooltip for direct transaction classification.
 *
 * Allows one-tap accept with category dropdown, discard/ignore, or opening in the
 * transaction editor.
 */

import { Bridge } from '../bridge.js';
import {
  icon, h, toast, selectField, bindSelectFields,
} from '../ui.js';
import { formatCurrency, formatRelativeDate, todayISO } from '../formatters.js';
import { openTransactionSheet } from './transaction-sheet.js';

let activeAlertIndex = 0;

/**
 * Renders the HTML markup for an interactive transaction alert tooltip card.
 */
export function renderAlertTooltip(alerts = [], categories = [], app) {
  if (!alerts || !alerts.length) return '';

  if (activeAlertIndex >= alerts.length) {
    activeAlertIndex = Math.max(0, alerts.length - 1);
  }

  const alert = alerts[activeAlertIndex];
  if (!alert) return '';

  const total = alerts.length;
  const index = activeAlertIndex;

  const isIncome = alert.type === 'Income';
  const isInvest = alert.type === 'Investment' || alert.is_investment_outflow;
  const isTransfer = alert.type === 'Transfer';

  let typeClass = 'expense';
  let sign = '-';
  if (isIncome) {
    typeClass = 'income';
    sign = '+';
  } else if (isInvest) {
    typeClass = 'invested';
    sign = '';
  } else if (isTransfer) {
    typeClass = 'transfer';
    sign = '';
  }

  // Instrument label
  let instrumentLabel = '';
  if (alert.card_name || alert.account_issuer || alert.account_last4) {
    const issuer = alert.card_name || alert.account_issuer || (alert.is_credit_card ? 'Credit Card' : 'Bank');
    const last4 = alert.account_last4 ? ` ···· ${alert.account_last4}` : '';
    instrumentLabel = `${issuer}${last4}`;
  }

  // Filter categories by type
  const targetType = alert.type || 'Expense';
  const matchingCats = categories.filter((c) => !c.type || c.type === targetType);
  const otherCats = categories.filter((c) => c.type && c.type !== targetType);

  const selectedCategory = alert.category || (matchingCats[0]?.name || 'Shopping');

  const categoryOptions = [
    ...matchingCats.map((c) => ({ value: c.name, label: c.name })),
    ...otherCats.map((c) => ({ value: c.name, label: `${c.name} (${c.type})` })),
  ];

  return `
    <div class="interactive-alert-card" data-interactive-alert data-alert-tooltip data-index="${index}">
      <div class="row-between" style="align-items:center;margin-bottom:8px">
        <div class="row" style="gap:8px;align-items:center;min-width:0">
          <span class="avatar avatar-sm" style="background:var(--accent-container);color:var(--on-accent-container);flex-shrink:0">
            ${icon('sms', 'icon-sm')}
          </span>
          <div style="min-width:0">
            <span style="font-weight:700;font-size:13.5px;color:var(--on-surface);white-space:nowrap">New Transaction Alert</span>
            ${total > 1 ? `<span class="badge badge-tonal" style="margin-left:6px;font-size:10.5px;padding:1px 6px">${index + 1} of ${total}</span>` : ''}
          </div>
        </div>
        <div class="row" style="gap:4px;flex-shrink:0">
          ${total > 1 ? `
            <button type="button" class="icon-button" data-prev-alert aria-label="Previous alert" ${index === 0 ? 'disabled style="opacity:0.35"' : ''}>
              ${icon('chevron_left', 'icon-sm')}
            </button>
            <button type="button" class="icon-button" data-next-alert aria-label="Next alert" ${index >= total - 1 ? 'disabled style="opacity:0.35"' : ''}>
              ${icon('chevron_right', 'icon-sm')}
            </button>` : ''}
          <button type="button" class="icon-button" data-dismiss-alert-tooltip aria-label="Dismiss alert banner">
            ${icon('close', 'icon-sm')}
          </button>
        </div>
      </div>

      <div class="alert-preview-body" style="background:var(--surface-container-high);padding:10px 12px;border-radius:var(--radius-sm);margin-bottom:10px;border:1px solid var(--outline-variant)">
        ${alert.duplicate_of || alert.duplicate_warning ? `
          <div class="row" style="gap:6px;align-items:center;background:var(--warning-container);color:var(--warning);padding:4px 8px;border-radius:var(--radius-xs);margin-bottom:8px;font-size:11px;font-weight:600">
            ${icon('content_copy', 'icon-sm')}<span>Potential duplicate of existing transaction</span>
          </div>` : ''}
        <div class="row-between" style="align-items:baseline;margin-bottom:4px">
          <span class="display ${typeClass}" style="font-size:22px;font-weight:700">
            ${sign}${h(formatCurrency(alert.amount || 0, app.currency, app.locale))}
          </span>
          <span class="caption" style="font-size:12px">${h(formatRelativeDate(alert.date) || 'Today')}</span>
        </div>
        <div class="row-between" style="align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-weight:650;font-size:14px;color:var(--on-surface)">
            ${h(alert.merchant || alert.category || 'Transaction')}
          </span>
          ${instrumentLabel ? `<span class="badge badge-tonal" style="font-size:11px">${h(instrumentLabel)}</span>` : ''}
        </div>
        ${alert.raw_sms ? `
          <details class="alert-sms-details" style="margin-top:6px;font-size:11.5px;color:var(--on-surface-variant)">
            <summary style="cursor:pointer;opacity:0.8;font-size:11.5px">Show original SMS</summary>
            <div style="margin-top:4px;user-select:text;word-break:break-word;line-height:1.35;padding:4px 0">${h(alert.raw_sms)}</div>
          </details>` : ''}
      </div>

      <div class="alert-actions-form" style="display:flex;flex-direction:column;gap:8px">
        <div class="row" style="gap:8px;align-items:center">
          <label class="caption" style="font-weight:600;min-width:64px;color:var(--on-surface-variant)">Category:</label>
          <div style="flex:1;min-width:0">
            ${selectField({
              key: 'alert_category',
              id: 'alertCategorySelect',
              value: selectedCategory,
              compact: true,
              options: categoryOptions,
            })}
          </div>
        </div>

        <div class="row" style="gap:6px;margin-top:2px;width:100%;display:flex;flex-wrap:wrap">
          ${alert.duplicate_of ? `
            <button type="button" class="btn btn-filled btn-xs" data-merge-alert style="flex:1;min-width:65px;gap:3px;justify-content:center;padding:5px 4px;font-size:11.5px;background:var(--accent);color:var(--on-accent)">
              ${icon('autorenew', 'icon-sm')}Merge
            </button>` : ''}
          <button type="button" class="btn btn-filled btn-xs" data-accept-alert style="flex:1;min-width:65px;gap:3px;justify-content:center;padding:5px 4px;font-size:11.5px">
            ${icon('check', 'icon-sm')}${alert.duplicate_of ? 'Keep Both' : 'Accept'}
          </button>
          <button type="button" class="btn btn-tonal btn-xs" data-discard-alert style="flex:1;min-width:65px;gap:3px;justify-content:center;padding:5px 4px;font-size:11.5px">
            ${icon('visibility_off', 'icon-sm')}Discard
          </button>
          <button type="button" class="btn btn-outlined btn-xs" data-edit-alert style="flex:1;min-width:65px;gap:3px;justify-content:center;padding:5px 4px;font-size:11.5px">
            ${icon('edit', 'icon-sm')}Details
          </button>
        </div>
      </div>
    </div>`;
}

/**
 * Binds interactive events for the alert tooltip component.
 */
export function bindAlertTooltip(container, app, { onUpdated = null, categories = [] } = {}) {
  const card = container.querySelector('[data-interactive-alert]');
  if (!card) return;

  bindSelectFields(card);

  const alerts = app.pendingAlerts || [];
  if (!alerts.length) return;

  if (activeAlertIndex >= alerts.length) {
    activeAlertIndex = Math.max(0, alerts.length - 1);
  }

  const currentAlert = alerts[activeAlertIndex];
  if (!currentAlert) return;

  const categorySelect = card.querySelector('#alertCategorySelect') || card.querySelector('[data-field="alert_category"]') || card.querySelector('[data-alert-category]');
  if (categorySelect) {
    categorySelect.addEventListener('change', () => {
      currentAlert.category = categorySelect.value;
      const foundCat = categories.find((c) => c.name === categorySelect.value);
      if (foundCat && foundCat.type) {
        currentAlert.type = foundCat.type;
      }
    });
  }

  const mergeBtn = card.querySelector('[data-merge-alert]');
  if (mergeBtn) {
    mergeBtn.addEventListener('click', async () => {
      mergeBtn.disabled = true;
      const chosenCategory = categorySelect ? categorySelect.value : (currentAlert.category || 'Shopping');
      const smsBody = currentAlert.raw_sms || currentAlert.body || '';
      const targetId = currentAlert.duplicate_of || (currentAlert.duplicate_twin && currentAlert.duplicate_twin.id) || 0;

      const res = await Bridge.call('sms', {
        action: 'merge_alert',
        transaction_id: targetId,
        body: smsBody,
        raw_sms: smsBody,
        category: chosenCategory,
        merchant: currentAlert.merchant || '',
        type: currentAlert.type || 'Expense',
        apply_to_all: true,
      });

      if (res && res.status === 'success') {
        toast('Merged into existing transaction.', 'success');
      } else {
        toast(res?.message || 'Could not merge alert.', 'error');
      }

      alerts.splice(activeAlertIndex, 1);
      app.pendingAlerts = alerts;
      if (activeAlertIndex >= alerts.length) {
        activeAlertIndex = Math.max(0, alerts.length - 1);
      }
      if (onUpdated) onUpdated();
      else app.refresh();
    });
  }

  const acceptBtn = card.querySelector('[data-accept-alert]');
  if (acceptBtn) {
    acceptBtn.addEventListener('click', async () => {
      acceptBtn.disabled = true;
      const chosenCategory = categorySelect ? categorySelect.value : (currentAlert.category || 'Shopping');
      const smsBody = currentAlert.raw_sms || currentAlert.body || '';

      const res = await Bridge.call('sms', {
        action: 'classify_alert',
        body: smsBody,
        amount: currentAlert.amount,
        category: chosenCategory,
        merchant: currentAlert.merchant || '',
        type: currentAlert.type || 'Expense',
        date: currentAlert.date,
        account_id: currentAlert.account_id,
        card_id: currentAlert.card_id,
        apply_to_all: true,
        override_duplicate: true,
      });

      if (res && res.status === 'success') {
        const merchantDisplay = currentAlert.merchant ? `for ${currentAlert.merchant}` : '';
        toast(`Filed ${formatCurrency(currentAlert.amount, app.currency, app.locale)} ${merchantDisplay} under "${chosenCategory}".`, 'success');
      } else {
        await app.db('save_transaction', {
          transaction: {
            date: currentAlert.date || todayISO(),
            amount: currentAlert.amount,
            type: currentAlert.type || 'Expense',
            category: chosenCategory,
            merchant: currentAlert.merchant || '',
            raw_sms: smsBody,
            account_id: currentAlert.account_id || null,
            card_id: currentAlert.card_id || null,
            member_id: currentAlert.member_id || 1,
          },
        });
        toast(`Saved transaction under "${chosenCategory}".`, 'success');
      }

      alerts.splice(activeAlertIndex, 1);
      app.pendingAlerts = alerts;

      if (activeAlertIndex >= alerts.length) {
        activeAlertIndex = Math.max(0, alerts.length - 1);
      }

      if (onUpdated) onUpdated();
      else app.refresh();
    });
  }

  const discardBtn = card.querySelector('[data-discard-alert]');
  if (discardBtn) {
    discardBtn.addEventListener('click', async () => {
      discardBtn.disabled = true;
      const smsBody = currentAlert.raw_sms || currentAlert.body || '';
      if (smsBody) {
        await Bridge.call('sms', {
          action: 'ignore_alert',
          body: smsBody,
          merchant: currentAlert.merchant || '',
        });
      }

      toast('Alert discarded / ignored.', 'info');
      alerts.splice(activeAlertIndex, 1);
      app.pendingAlerts = alerts;

      if (activeAlertIndex >= alerts.length) {
        activeAlertIndex = Math.max(0, alerts.length - 1);
      }

      if (onUpdated) onUpdated();
      else app.refresh();
    });
  }

  const editBtn = card.querySelector('[data-edit-alert]');
  if (editBtn) {
    editBtn.addEventListener('click', async () => {
      const chosenCategory = categorySelect ? categorySelect.value : (currentAlert.category || 'Shopping');
      const smsBody = currentAlert.raw_sms || currentAlert.body || '';
      const draft = {
        amount: currentAlert.amount,
        type: currentAlert.type || 'Expense',
        category: chosenCategory,
        merchant: currentAlert.merchant || '',
        date: currentAlert.date || todayISO(),
        raw_sms: smsBody,
        account_id: currentAlert.account_id || null,
        card_id: currentAlert.card_id || null,
        member_id: currentAlert.member_id || 1,
      };

      const saved = await openTransactionSheet(app, draft);
      if (saved) {
        alerts.splice(activeAlertIndex, 1);
        app.pendingAlerts = alerts;
        if (activeAlertIndex >= alerts.length) {
          activeAlertIndex = Math.max(0, alerts.length - 1);
        }
        if (onUpdated) onUpdated();
        else app.refresh();
      }
    });
  }

  const prevBtn = card.querySelector('[data-prev-alert]');
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (activeAlertIndex > 0) {
        activeAlertIndex -= 1;
        if (onUpdated) onUpdated();
        else app.refresh();
      }
    });
  }

  const nextBtn = card.querySelector('[data-next-alert]');
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (activeAlertIndex < alerts.length - 1) {
        activeAlertIndex += 1;
        if (onUpdated) onUpdated();
        else app.refresh();
      }
    });
  }

  const dismissBtn = card.querySelector('[data-dismiss-alert-tooltip]');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
      card.style.opacity = '0';
      card.style.transform = 'translateY(-6px)';
      card.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
      setTimeout(() => {
        card.remove();
      }, 200);
    });
  }
}
