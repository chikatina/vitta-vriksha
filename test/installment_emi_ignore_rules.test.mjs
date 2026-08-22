import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, call } from './_harness.mjs';
import { parseSmsText } from '../app/src/main/assets/www/js/backend/sms.js';
import { findRecurring } from '../app/src/main/assets/www/js/backend/recurring.js';

describe('Installment as EMI, Message Discard/Ignore, Duplicate Marking & Rule Engine', () => {
  let db;

  beforeEach(async () => {
    db = await freshBackend();
  });

  it('classifies installment, instalment, and mandate SMS as Loans & EMI', async () => {
    const texts = [
      'Your A/C xx1234 is debited for Rs 15,400.00 on 05-Jan-26 towards Loan Installment Ref: HDFC0098',
      'Rs. 8,250.00 debited from A/c 5678 on 10/01/2026 for monthly instalment Bajaj Finance Ltd',
      'Alert: Rs 22,000.00 debited via NACH mandate for Tata Capital home loan on 07-Jan-26',
      'INR 5,500.00 has been debited towards personal loan EMI payment for A/c xx4321',
    ];

    for (const text of texts) {
      const res = await parseSmsText(text, 'HDFCBK');
      assert.equal(res.status, 'classified');
      assert.equal(res.category, 'Loans & EMI');
      assert.equal(res.type, 'Expense');
      assert.ok(res.amount > 0);
    }
  });

  it('detects installments in recurring as kind=loan and enables loan clubbing', async () => {
    // Seed 3 monthly installment transactions
    const dates = ['2026-01-05', '2026-02-05', '2026-03-05'];
    for (const date of dates) {
      db.run(
        "INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, merchant_key, is_investment_outflow)"
        + " VALUES (1, ?, 18500, 'INR', 'Expense', 'Loans & EMI', 'HDFC Bank Home Loan Installment', 'hdfc bank home loan installment', 0)",
        [date],
      );
    }

    const recurring = findRecurring(db, { member_id: 1, min_times: 2 });
    const match = (recurring.candidates || recurring.found || []).find((r) => r.merchant_key === 'hdfc bank home loan installment');
    assert.ok(match, 'Recurring installment detected');
    assert.equal(match.kind, 'loan', 'Installment recurring kind must be loan');
    assert.equal(match.amount, 18500);
  });

  it('supports ignoring a transaction and excluding it from default get_transactions', async () => {
    // 1. Insert a transaction
    const txId = db.run(
      "INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, is_ignored)"
      + " VALUES (1, '2026-02-10', 1200, 'INR', 'Expense', 'Shopping', 'Spam Vendor', 0)",
    ).lastInsertRowid;

    // Verify it is returned initially
    let list = await call('get_transactions', { member_id: 1 });
    assert.ok(list.transactions.some((t) => t.id === txId));

    // 2. Ignore transaction
    const ignoreRes = await call('ignore_transaction', {
      transaction_id: txId,
      create_rule: true,
      merchant: 'Spam Vendor',
    });
    assert.equal(ignoreRes.status, 'success');

    // 3. Default get_transactions should now exclude the ignored transaction
    list = await call('get_transactions', { member_id: 1 });
    assert.ok(!list.transactions.some((t) => t.id === txId));

    // 4. Querying specifically with filter='ignored' returns it
    const ignoredList = await call('get_transactions', { member_id: 1, filter: 'ignored' });
    assert.ok(ignoredList.transactions.some((t) => t.id === txId));

    // 5. Restoring transaction brings it back
    const restoreRes = await call('restore_transaction', { transaction_id: txId });
    assert.equal(restoreRes.status, 'success');
    list = await call('get_transactions', { member_id: 1 });
    assert.ok(list.transactions.some((t) => t.id === txId));
  });

  it('rule engine learns ignore rule and auto-discards future matching SMS', async () => {
    // 1. Create a standing ignore rule for merchant "Lottery Club"
    db.run(
      "INSERT INTO merchant_rules (merchant_key, category_name, transaction_type, display_name, updated_at)"
      + " VALUES ('lottery club', 'Ignore', 'Ignore', 'Lottery Club', '2026-02-01T00:00:00.000Z')",
    );

    // 2. An incoming SMS for Lottery Club should be classified as Ignore
    const smsText = 'Rs. 500.00 debited from A/c xx1234 on 15-Feb-26 at Lottery Club Ref: 987654';
    const res = await parseSmsText(smsText, 'HDFCBK');

    assert.equal(res.status, 'classified');
    assert.equal(res.type, 'Ignore');
    assert.equal(res.category, 'Ignore');
    assert.equal(res.not_a_transaction, 'ignored-rule');
  });

  it('marks transaction as duplicate and records raw SMS in ignored_alerts', async () => {
    const rawSms = 'Rs 450.00 debited from account 9999 on 12-Feb-2026 at Cafe Coffee Day';
    const txId = db.run(
      "INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, raw_sms, is_duplicate)"
      + " VALUES (1, '2026-02-12', 450, 'INR', 'Expense', 'Dining', 'Cafe Coffee Day', ?, 0)",
      [rawSms],
    ).lastInsertRowid;

    // Mark as duplicate
    const dupRes = await call('mark_transaction_duplicate', { transaction_id: txId });
    assert.equal(dupRes.status, 'success');

    // Verify ignored_alerts has the raw SMS
    const ignoredAlert = db.get('SELECT * FROM ignored_alerts WHERE body = ?', [rawSms]);
    assert.ok(ignoredAlert, 'Raw SMS should be in ignored_alerts');

    // Default get_transactions excludes duplicate
    const list = await call('get_transactions', { member_id: 1 });
    assert.ok(!list.transactions.some((t) => t.id === txId));
  });

  it('supports batch update for is_ignored and is_duplicate', async () => {
    const tx1 = db.run("INSERT INTO transactions (member_id, date, amount, currency, type, category) VALUES (1, '2026-02-01', 100, 'INR', 'Expense', 'Food')").lastInsertRowid;
    const tx2 = db.run("INSERT INTO transactions (member_id, date, amount, currency, type, category) VALUES (1, '2026-02-02', 200, 'INR', 'Expense', 'Food')").lastInsertRowid;

    const batchRes = await call('batch_update_transactions', {
      ids: [tx1, tx2],
      is_ignored: 1,
    });
    assert.equal(batchRes.status, 'success');
    assert.equal(batchRes.updated_count, 2);

    const rows = db.all('SELECT id, is_ignored FROM transactions WHERE id IN (?, ?)', [tx1, tx2]);
    assert.equal(rows[0].is_ignored, 1);
    assert.equal(rows[1].is_ignored, 1);
  });

  it('supports transfer rules to Demat and NPS accounts', async () => {
    const dematSms = 'Rs 50,000.00 debited from A/C xx4455 on 18-Feb-2026 towards Demat Zerodha Broking';
    const res = await parseSmsText(dematSms, 'HDFCBK');
    assert.equal(res.status, 'classified');
    assert.equal(res.type, 'Transfer');
    assert.equal(res.category, 'Transfer');
  });
});
