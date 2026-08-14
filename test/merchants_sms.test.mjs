import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, ok } from './_harness.mjs';
import {
  merchantKey, notATransaction, extractMerchant, categoryForMerchant,
} from '../app/src/main/assets/www/js/backend/merchants.js';
import {
  parseSmsText, handleSmsAction,
} from '../app/src/main/assets/www/js/backend/sms.js';
import { handleDbAction } from '../app/src/main/assets/www/js/backend/database.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('merchants.js keyword index & merchant parser', () => {
  it('generates consistent, normalized merchant keys', () => {
    assert.equal(merchantKey('CAS*CITYFLO'), 'cityflo');
    assert.equal(merchantKey('Cityflo Technologies Pvt Ltd'), 'cityflo');
    assert.equal(merchantKey('UPI/swiggy@icici'), 'swiggy icici');
    assert.equal(merchantKey('ZOMATO LIMITED'), 'zomato');
    assert.equal(merchantKey(''), '');
    assert.equal(merchantKey(null), '');
  });
  it('filters out non-transactions (OTP, promo, self transfer, reminder, mandate setups)', () => {
    assert.equal(notATransaction('Your OTP for transaction is 123456. Do not share.'), 'otp');
    assert.equal(notATransaction('Rs. 5,000.00 was debited. OTP for this is 123456.'), 'otp');
    assert.equal(notATransaction('Dear customer, your credit card bill of Rs 5000 is due on 20 Aug.'), 'reminder');
    assert.equal(notATransaction('Payment reminder: Your EMI of Rs. 12,500 is due on 05-Sep.'), 'reminder');
    assert.equal(notATransaction('Gentle reminder: Please pay bill of Rs 850 by 15-Aug to avoid late fee.'), 'reminder');
    assert.equal(notATransaction('Your mobile pack of Rs 299 is expiring today. Recharge now to continue.'), 'reminder');
    assert.equal(notATransaction('Pre-debit notification: A/c xx1234 will be debited for Rs 5,000 on 15-Aug towards NACH Mandate.'), 'reminder');
    assert.equal(notATransaction('Autopay reminder: Rs 1,200 will be auto-debited on 18-Aug.'), 'reminder');
    assert.equal(notATransaction('Mandate alert: Rs 2,500 is scheduled for deduction on 16-Aug.'), 'reminder');
    assert.equal(notATransaction('Payment of Rs 500 failed due to network error.'), 'failed');
    assert.equal(notATransaction('Fastag recharge successful of Rs 1000'), 'self-transfer');
    assert.equal(notATransaction('Payment of Rs 5000 was credited to your card'), 'card-payment');
    assert.equal(notATransaction('Exclusive offer! Get 50% discount on shopping.'), 'promo');
    
    // ACH / NACH Mandate Registration and Setup (should NOT be recorded as transactions)
    assert.equal(notATransaction('Dear Customer, Mandate with UMRN HDFC123456 for Rs. 5000 has been registered towards HDFC MF.'), 'mandate-setup');
    assert.equal(notATransaction('e-Mandate registered: Mandate for Rs 10,000 on your A/c xx5678 has been created successfully.'), 'mandate-setup');
    assert.equal(notATransaction('NACH Mandate of Rs 3,000 set up successfully on your account.'), 'mandate-setup');
    assert.equal(notATransaction('Your mandate request for Rs 2000 has been received and approved.'), 'mandate-setup');

    // Real transactions
    assert.equal(notATransaction('Rs. 450.00 spent on your Card ending 1234 at SWIGGY on 12-Aug.'), '');
    assert.equal(notATransaction('Rs. 5,000.00 spent on card ending 1234 without PIN/OTP.'), '');
    assert.equal(notATransaction('INR 1,200.00 debited from a/c xx1234 at AMAZON INDIA.'), '');
    assert.equal(notATransaction('A/c xx1234 debited by Rs 5,000.00 on 15-Aug-2026. Info: ACH D- HDFC MUTUAL FUND.'), '');
  });

  it('extracts merchant counterparty correctly from various SMS formats', () => {
    assert.equal(extractMerchant('Rs 340 spent at SWIGGY on 12-Aug-26'), 'SWIGGY');
    assert.equal(extractMerchant('Rs 500 debited via upi/zepto@hdfc on 10-08-2026'), 'zepto@hdfc');
    assert.equal(extractMerchant('Rs 120 paid to UBER INDIA on 12-Aug'), 'UBER INDIA');
    assert.equal(extractMerchant('Rs 1500 debited at APOLLO PHARMACY.'), 'APOLLO PHARMACY');
    assert.equal(extractMerchant('Rs 200 debited info:NETFLIX;'), 'NETFLIX');
    assert.equal(extractMerchant('A/c debited by Rs 5000. Info: ACH D- HDFC MUTUAL FUND;'), 'HDFC MUTUAL FUND');
    assert.equal(extractMerchant('Payment of Rs 1000 credited to your account'), '');
  });

  it('categorizes merchant via keyword index', () => {
    assert.equal(categoryForMerchant('Swiggy'), 'Dining');
    assert.equal(categoryForMerchant('Uber'), 'Transport & Fuel');
    assert.equal(categoryForMerchant('Netflix'), 'Entertainment');
    assert.equal(categoryForMerchant('Apollo Pharmacy'), 'Health');
    assert.equal(categoryForMerchant('Amazon'), 'Shopping');
    assert.equal(categoryForMerchant('Unknown Vendor', 'Swiggy order delivered'), 'Dining');
    assert.equal(categoryForMerchant('', ''), '');
  });
});

describe('sms.js SMS classifier and dispatcher', () => {
  it('classifies debits, credits, ACH debits and transfers', async () => {
    const debit = await parseSmsText('Rs 550 debited from A/c xx1234 at DOMINOS PIZZA on 12-Aug-2026.');
    assert.equal(debit.type, 'Expense');
    assert.equal(debit.amount, 550);
    assert.equal(debit.merchant, 'DOMINOS PIZZA');
    assert.equal(debit.date, '2026-08-12');

    const achDebit = await parseSmsText('A/c xx1234 debited by Rs 5,000 on 15-Aug-2026. Info: ACH D- HDFC MUTUAL FUND.');
    assert.equal(achDebit.amount, 5000);
    assert.equal(achDebit.type, 'Investment');
    assert.equal(achDebit.category, 'Investment Outflow');
    assert.equal(achDebit.merchant, 'HDFC MUTUAL FUND');

    const icclDebit = await parseSmsText('Rs. 15,000.00 debited from A/c xx5678 on 12-Aug-2026. Info: ACH D- ICCL / 948271.');
    assert.equal(icclDebit.amount, 15000);
    assert.equal(icclDebit.type, 'Investment');
    assert.equal(icclDebit.category, 'Investment Outflow');
    assert.equal(icclDebit.merchant, 'ICCL');

    const sipDebit = await parseSmsText('Dear Customer, Rs 2,500.00 debited from a/c xx9012 for SIP towards NIPPON INDIA MF.');
    assert.equal(sipDebit.amount, 2500);
    assert.equal(sipDebit.type, 'Investment');
    assert.equal(sipDebit.category, 'Investment Outflow');

    const credit = await parseSmsText('INR 50,000.00 credited to A/c xx1234 as Salary for August on 01-Aug-2026.');
    assert.equal(credit.type, 'Income');
    assert.equal(credit.date, '2026-08-01');

    // Mandate setup and reminders return non-transaction
    const mandateAlert = await parseSmsText('Dear Customer, Mandate with UMRN HDFC1234 for Rs. 5000 has been registered towards HDFC MF.');
    assert.equal(mandateAlert.not_a_transaction, 'mandate-setup');
    assert.equal(mandateAlert.amount, 0);

    const reminderAlert = await parseSmsText('Pre-debit notification: Mandate of Rs 5000 will be debited on 15-Aug.');
    assert.equal(reminderAlert.not_a_transaction, 'reminder');
    assert.equal(reminderAlert.amount, 0);
  });

  it('supports Ignore rules that are prioritized on top and filter matching messages', async () => {
    // 1. Add normal Expense rule first
    await handleSmsAction({
      action: 'add_rule',
      rule: { rule_name: 'Regular Spend', body_trigger: 'debited', category_name: 'Shopping', transaction_type: 'Expense' },
    });

    // 2. Add an Ignore rule
    await handleSmsAction({
      action: 'add_rule',
      rule: { rule_name: 'Ignore OTP Alert', body_trigger: 'verification code', category_name: 'Ignore', transaction_type: 'Ignore' },
    });

    // 3. Verify get_rules puts Ignore rule at the very top (first)
    const getRules = await handleSmsAction({ action: 'get_rules' });
    assert.equal(getRules.status, 'success');
    assert.equal(getRules.rules[0].transaction_type, 'Ignore');

    // 4. Verify that an SMS containing BOTH "debited" and "verification code" is ignored (matches Ignore rule first)
    const testMsg = await handleSmsAction({
      action: 'parse_text',
      sms_text: 'Your verification code is 432109. Rs 500 debited.',
    });
    assert.equal(testMsg.not_a_transaction, 'ignored-rule');
    assert.equal(testMsg.type, 'Ignore');
    assert.equal(testMsg.amount, 0);
  });

  it('handles sms action dispatcher for all actions', async () => {
    // Add rule
    const addRuleRes = await handleSmsAction({
      action: 'add_rule',
      rule: {
        rule_name: 'Custom Swiggy',
        body_trigger: 'swiggy',
        category_name: 'Dining',
      },
    });
    assert.equal(addRuleRes.status, 'success');

    const getRules = await handleSmsAction({ action: 'get_rules' });
    assert.equal(getRules.status, 'success');
    assert.ok(Array.isArray(getRules.rules));
    const added = getRules.rules.find((r) => r.rule_name === 'Custom Swiggy');
    assert.ok(added);

    // Delete rule
    const delRuleRes = await handleSmsAction({ action: 'delete_rule', rule_id: added.id });
    assert.equal(delRuleRes.status, 'success');

    // Parse text
    const testMsg = await handleSmsAction({
      action: 'parse_text',
      sms_text: 'Rs 250 spent at STARBUCKS on 12-Aug-2026.',
    });
    assert.equal(testMsg.type, 'Expense');
    assert.equal(testMsg.amount, 250);

    const pending = await handleSmsAction({ action: 'pending_alerts' });
    assert.equal(pending.status, 'success');

    const review = await handleSmsAction({ action: 'review', days: 30, filter: 'all' });
    assert.equal(review.status, 'success');

    // Ignore alert
    const ignoreRes = await handleSmsAction({
      action: 'ignore_alert',
      body: 'Your OTP is 1234',
    });
    assert.equal(ignoreRes.status, 'success');

    // Merchant rules & forget
    const merchantRules = await handleSmsAction({ action: 'get_merchant_rules' });
    assert.equal(merchantRules.status, 'success');

    const forget = await handleSmsAction({ action: 'forget_merchant', merchant_key: 'non_existent' });
    assert.equal(forget.status, 'success');

    // Unknown action
    const unknown = await handleSmsAction({ action: 'non_existent_action' });
    assert.equal(unknown.status, 'error');
  });

  it('deduplicates multiple duplicate messages in the same reimport batch', async () => {
    globalThis.window = {
      AndroidBridge: {
        readSmsInbox: () => JSON.stringify([
          {
            sender: 'HDFCBK',
            body: 'A/c xx1234 debited by Rs 5,000 on 15-Aug-2026. Info: ACH D- HDFC MUTUAL FUND.',
            received_at: 1786780800000,
          },
          {
            sender: 'HDFCBK',
            body: 'Rs 5,000.00 debited from A/c xx1234 on 15-Aug-2026 for ACH mandate.',
            received_at: 1786780800000,
          },
        ]),
      },
    };

    const res = await handleSmsAction({ action: 'reimport', days: 30, member_id: 1 });
    assert.equal(res.status, 'success');
    assert.equal(res.read, 2);
    assert.equal(res.imported, 1);
    assert.equal(res.duplicates, 1);

    delete globalThis.window;
  });

  it('preserves raw_sms and description when classifying alerts and updating transactions', async () => {
    const rawText = 'Rs 750 debited from A/C xx4321 on 12-Aug-2026 for Swiggy. Info: UPI/12345/FoodOrder.';
    const classifyRes = await handleSmsAction({
      action: 'classify_alert',
      body: rawText,
      amount: 750,
      type: 'Expense',
      category: 'Dining',
      merchant: 'Swiggy',
      description: 'UPI/12345/FoodOrder',
      date: '2026-08-12',
      member_id: 1,
    });
    assert.equal(classifyRes.status, 'success');

    const txRes = await handleDbAction({ action: 'get_transactions' });
    const created = txRes.transactions.find((t) => t.amount === 750 && t.merchant === 'Swiggy');
    assert.ok(created);
    assert.equal(created.raw_sms, rawText);
    assert.equal(created.description, 'UPI/12345/FoodOrder');

    // Update the transaction (e.g. recategorize via sheet) and ensure raw_sms is preserved
    const saveRes = await handleDbAction({
      action: 'save_transaction',
      transaction: {
        id: created.id,
        amount: 750,
        type: 'Expense',
        category: 'Food & Drinks',
        merchant: 'Swiggy',
        description: 'Updated note',
        raw_sms: created.raw_sms,
        date: '2026-08-12',
      },
    });
    assert.equal(saveRes.status, 'success');

    const updatedRes = await handleDbAction({ action: 'get_transactions' });
    const updated = updatedRes.transactions.find((t) => t.id === created.id);
    assert.ok(updated);
    assert.equal(updated.category, 'Food & Drinks');
    assert.equal(updated.description, 'Updated note');
    assert.equal(updated.raw_sms, rawText);
  });

  it('supports scanning all time SMS history with days: 0', async () => {
    let capturedDays = null;
    globalThis.window = {
      AndroidBridge: {
        readSmsInbox: (days) => {
          capturedDays = days;
          return JSON.stringify([
            {
              sender: 'SBIBK',
              body: 'Rs 1,200.00 debited from A/c xx9999 on 01-Jan-2024 for Amazon.',
              received_at: 1704067200000,
            },
          ]);
        },
      },
    };

    const res = await handleSmsAction({ action: 'reimport', days: 0, member_id: 1 });
    assert.equal(res.status, 'success');
    assert.equal(capturedDays, 0);
    assert.equal(res.imported, 1);

    const reviewRes = await handleSmsAction({ action: 'review', days: 0 });
    assert.equal(reviewRes.status, 'success');

    delete globalThis.window;
  });
});
