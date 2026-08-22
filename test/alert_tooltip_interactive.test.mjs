import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend } from './_harness.mjs';
import { renderAlertTooltip } from '../app/src/main/assets/www/js/views/alert-tooltip.js';
import { handleDbAction } from '../app/src/main/assets/www/js/backend/database.js';
import { handleSmsAction } from '../app/src/main/assets/www/js/backend/sms.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('Interactive Transaction Alert Tooltip', () => {
  const mockApp = {
    currency: 'INR',
    locale: 'en-IN',
    pendingAlerts: [],
  };

  const sampleCategories = [
    { name: 'Shopping', type: 'Expense' },
    { name: 'Food & Dining', type: 'Expense' },
    { name: 'Groceries', type: 'Expense' },
    { name: 'Salary', type: 'Income' },
    { name: 'Mutual Funds', type: 'Investment' },
  ];

  it('renders nothing when there are no alerts', () => {
    const html = renderAlertTooltip([], sampleCategories, mockApp);
    assert.equal(html, '');
  });

  it('renders interactive card with amount, merchant, category dropdown, accept, discard, edit buttons', () => {
    const alerts = [
      {
        amount: 2499,
        type: 'Expense',
        category: 'Shopping',
        merchant: 'Amazon',
        date: '2026-08-20',
        raw_sms: 'Alert: Rs 2,499.00 spent on HDFC Card 8899 at Amazon.',
        card_name: 'HDFC Infinia',
        account_last4: '8899',
      },
    ];

    const html = renderAlertTooltip(alerts, sampleCategories, mockApp);
    assert.ok(html.includes('interactive-alert-card'));
    assert.ok(html.includes('2,499'));
    assert.ok(html.includes('Amazon'));
    assert.ok(html.includes('HDFC Infinia ···· 8899'));
    assert.ok(html.includes('select-button'));
    assert.ok(html.includes('data-field="alert_category"'));
    assert.ok(html.includes('data-accept-alert'));
    assert.ok(html.includes('data-discard-alert'));
    assert.ok(html.includes('data-edit-alert'));
    assert.ok(html.includes('Shopping'));
  });

  it('renders multi-alert counter and navigation when multiple alerts exist', () => {
    const alerts = [
      { amount: 1500, type: 'Expense', category: 'Dining', merchant: 'Swiggy' },
      { amount: 350, type: 'Expense', category: 'Transport', merchant: 'Uber' },
    ];

    const html = renderAlertTooltip(alerts, sampleCategories, mockApp);
    assert.ok(html.includes('1 of 2'));
    assert.ok(html.includes('data-prev-alert'));
    assert.ok(html.includes('data-next-alert'));
  });

  it('classify_alert backend action saves transaction and learns merchant rule', async () => {
    const rawSms = 'Alert: Rs 1,850.00 spent on ICICI Bank Card at Starbucks on 20-Aug-2026.';
    const res = await handleSmsAction({
      action: 'classify_alert',
      body: rawSms,
      amount: 1850,
      category: 'Food & Dining',
      merchant: 'Starbucks',
      type: 'Expense',
      date: '2026-08-20',
      apply_to_all: true,
    });

    assert.equal(res.status, 'success');

    // Verify transaction exists in db
    const txRes = await handleDbAction({ action: 'get_transactions', limit: 10 });
    const tx = txRes.transactions.find((t) => t.merchant === 'Starbucks');
    assert.ok(tx);
    assert.equal(tx.amount, 1850);
    assert.equal(tx.category, 'Food & Dining');

    // Verify merchant rule was learned
    const rules = await handleSmsAction({ action: 'get_merchant_rules' });
    assert.equal(rules.status, 'success');
    const rule = rules.rules.find((r) => r.merchant_key === 'starbucks');
    assert.ok(rule);
    assert.equal(rule.category_name, 'Food & Dining');
  });

  it('ignore_alert backend action records ignored SMS', async () => {
    const rawSms = 'OTP 123456 for logging into NetBanking';
    const res = await handleSmsAction({
      action: 'ignore_alert',
      body: rawSms,
      merchant: 'NetBanking',
    });

    assert.equal(res.status, 'success');
  });
});
