import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, call } from './_harness.mjs';
import {
  extractUtr, duplicateOfFast, handleSmsAction,
} from '../app/src/main/assets/www/js/backend/sms.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('extractUtr reference & UTR extractor', () => {
  it('extracts UPI reference numbers from various bank alerts', () => {
    assert.equal(extractUtr('Paid Rs 340 via UPI Ref 423871928371 to Swiggy'), '423871928371');
    assert.equal(extractUtr('Rs 500 debited via upi/423871928371 on 10-08-2026'), '423871928371');
    assert.equal(extractUtr('A/c xx1234 debited by Rs 120. UPI/423871928371/Payment to Tea Stall'), '423871928371');
    assert.equal(extractUtr('UPI Ref no 987654321098 for Rs 2500'), '987654321098');
  });

  it('extracts RRN, UTR and Transaction IDs correctly', () => {
    assert.equal(extractUtr('Rs 1500 debited. RRN: 423871928371.'), '423871928371');
    assert.equal(extractUtr('Rs 200 debited. Ref no: 423871928371.'), '423871928371');
    assert.equal(extractUtr('Rs 5000 credited via UTR HDFC423871928371.'), 'HDFC423871928371');
    assert.equal(extractUtr('Txn ID: 948271048291 for Rs 850'), '948271048291');
    assert.equal(extractUtr('Rs. 15,000.00 debited on 12-Aug-2026. Info: ACH D- ICCL / 948271.'), '948271');
  });

  it('returns empty string for texts without reference numbers', () => {
    assert.equal(extractUtr('Rs 450 spent at Dominos on 12-Aug.'), '');
    assert.equal(extractUtr(''), '');
    assert.equal(extractUtr(null), '');
  });
});

describe('duplicateOf & duplicateOfFast with rich twin metadata', () => {
  it('detects exact-utr match with 100% confidence score', () => {
    const existingSms = 'Rs 340 debited from A/c xx1234 on 24-Aug-2026 via UPI Ref 423871928371.';
    const incomingSms = 'Paid Rs 340 to Swiggy on 24-Aug-2026 via UPI Ref 423871928371.';

    const txByDateAmount = new Map([
      ['2026-08-24:340', [
        {
          id: 42,
          date: '2026-08-24',
          amount: 340,
          merchant: 'UPI-DEBIT',
          category: 'Shopping',
          raw_sms: existingSms,
          utr: '423871928371',
          instrument_name: 'HDFC Bank ··1234',
        },
      ]],
    ]);

    const twin = duplicateOfFast(txByDateAmount, {
      date: '2026-08-24',
      amount: 340,
      body: incomingSms,
    });

    assert.ok(twin);
    assert.equal(twin.id, 42);
    assert.equal(twin.match_reason, 'exact-utr');
    assert.equal(twin.match_score, 100);
    assert.equal(twin.instrument_name, 'HDFC Bank ··1234');
  });

  it('detects date-amount candidate when UTR is absent', () => {
    const existingSms = 'Rs 150 debited from A/c xx1234 on 24-Aug-2026 at Coffee Shop.';
    const incomingSms = 'Rs 150 spent on Card xx5678 on 24-Aug-2026 at Starbucks.';

    const txByDateAmount = new Map([
      ['2026-08-24:150', [
        {
          id: 99,
          date: '2026-08-24',
          amount: 150,
          merchant: 'Coffee Shop',
          category: 'Dining',
          raw_sms: existingSms,
          utr: '',
          instrument_name: 'HDFC Bank ··1234',
        },
      ]],
    ]);

    const twin = duplicateOfFast(txByDateAmount, {
      date: '2026-08-24',
      amount: 150,
      body: incomingSms,
    });

    assert.ok(twin);
    assert.equal(twin.id, 99);
    assert.equal(twin.match_reason, 'date-amount');
    assert.equal(twin.match_score, 85);
  });
});

describe('merge_alert and duplicate review lifecycle', () => {
  it('merges incoming SMS into existing transaction and logs ignored_alerts', async () => {
    // 1. Create existing transaction
    const saveRes = await call('save_transaction', {
      transaction: {
        amount: 450,
        type: 'Expense',
        category: 'Shopping',
        merchant: 'UPI-DEBIT',
        date: '2026-08-24',
        raw_sms: 'Rs 450 debited from A/c xx1234 on 24-Aug via UPI Ref 998877665544.',
      },
    });
    assert.equal(saveRes.status, 'success');
    const txId = saveRes.transaction_id;

    // 2. Merge incoming SMS with richer merchant details
    const incomingSms = 'Paid Rs 450 to Swiggy on 24-Aug via UPI Ref 998877665544.';
    const mergeRes = await handleSmsAction({
      action: 'merge_alert',
      transaction_id: txId,
      body: incomingSms,
      merchant: 'Swiggy',
      category: 'Dining',
      apply_to_all: true,
    });
    assert.equal(mergeRes.status, 'success');
    assert.equal(mergeRes.transaction_id, txId);

    // 3. Verify updated transaction
    const txRes = await call('get_transactions', {
      filters: { id: txId },
    });
    assert.equal(txRes.status, 'success');
    const updated = txRes.transactions.find((t) => t.id === txId);
    assert.equal(updated.merchant, 'Swiggy');
    assert.equal(updated.category, 'Dining');

    // 4. Verify incoming SMS was saved in ignored_alerts so it won't trigger again
    const ignoredRows = db.all('SELECT body FROM ignored_alerts WHERE body = ?', [incomingSms]);
    assert.equal(ignoredRows.length, 1);
  });
});

describe('scan_ledger_duplicates and merge_ledger_transactions', () => {
  it('scans and identifies duplicate clusters in ledger', async () => {
    // Insert 2 transactions with same date and amount
    await call('save_transaction', {
      transaction: {
        amount: 320,
        type: 'Expense',
        category: 'Transport',
        merchant: 'Uber',
        date: '2026-08-24',
        raw_sms: 'Rs 320 debited on 24-Aug for Uber UPI Ref 112233445566',
      },
    });
    await call('save_transaction', {
      transaction: {
        amount: 320,
        type: 'Expense',
        category: 'Transport',
        merchant: 'Uber India',
        date: '2026-08-24',
        raw_sms: 'Paid Rs 320 to Uber on 24-Aug UPI Ref 112233445566',
      },
    });

    const scanRes = await call('scan_ledger_duplicates', {});
    assert.equal(scanRes.status, 'success');
    assert.ok(scanRes.count >= 1);
    const group = scanRes.groups.find((g) => g.amount === 320 && g.date === '2026-08-24');
    assert.ok(group);
    assert.equal(group.transactions.length, 2);
    assert.equal(group.match_type, 'exact-utr');
    assert.equal(group.match_score, 100);
  });

  it('merges two existing ledger transactions cleanly', async () => {
    const tx1 = await call('save_transaction', {
      transaction: {
        amount: 250,
        type: 'Expense',
        category: 'Other',
        merchant: 'Card Debit',
        date: '2026-08-24',
        raw_sms: 'Rs 250 spent on Card xx1234',
      },
    });
    const tx2 = await call('save_transaction', {
      transaction: {
        amount: 250,
        type: 'Expense',
        category: 'Dining',
        merchant: 'Cafe Coffee Day',
        date: '2026-08-24',
        raw_sms: 'Rs 250 paid at CCD',
      },
    });

    const mergeRes = await call('merge_ledger_transactions', {
      primary_id: tx1.transaction_id,
      secondary_id: tx2.transaction_id,
      merchant: 'Cafe Coffee Day',
      category: 'Dining',
    });
    assert.equal(mergeRes.status, 'success');
    assert.equal(mergeRes.is_merged, true);

    // Primary transaction should be updated
    const primary = db.get('SELECT * FROM transactions WHERE id = ?', [tx1.transaction_id]);
    assert.equal(primary.merchant, 'Cafe Coffee Day');
    assert.equal(primary.category, 'Dining');
    assert.equal(primary.is_duplicate, 0);

    // Secondary transaction should be marked duplicate
    const secondary = db.get('SELECT * FROM transactions WHERE id = ?', [tx2.transaction_id]);
    assert.equal(secondary.is_duplicate, 1);
  });

  it('merges multiple duplicate alerts sequentially for Loan & EMI and Investment Outflow without getting stuck', async () => {
    // 1. Existing Loan & EMI transaction
    const loanTx = await call('save_transaction', {
      transaction: {
        date: '2026-08-05',
        amount: 18600,
        type: 'Expense',
        category: 'Loans & EMI',
        merchant: 'Car Loan EMI',
        description: 'Car Loan Monthly EMI',
        raw_sms: '',
      },
    });
    assert.equal(loanTx.status, 'success');
    const loanId = loanTx.transaction_id;

    // Incoming Alert 1
    const sms1 = 'Car Loan EMI of Rs 18,600 debited from A/c xx1234 on 05-Aug-2026. Info: HDFC LOAN\n';
    // Incoming Alert 2
    const sms2 = 'Rs 18,600.00 debited from A/c xx1234 towards HDFC Car Loan on 05-Aug-2026';

    // First merge
    const res1 = await handleSmsAction({
      action: 'merge_alert',
      transaction_id: loanId,
      body: sms1,
      merchant: 'HDFC Car Loan',
      category: 'Loans & EMI',
      type: 'Expense',
      apply_to_all: true,
    });
    assert.equal(res1.status, 'success');

    // Second merge (should succeed cleanly and not get stuck)
    const res2 = await handleSmsAction({
      action: 'merge_alert',
      transaction_id: loanId,
      body: sms2,
      raw_sms: sms2,
      merchant: 'HDFC Car Loan',
      category: 'Loans & EMI',
      type: 'Expense',
      apply_to_all: true,
    });
    assert.equal(res2.status, 'success');

    // Verify both bodies are recorded in ignored_alerts so neither remains in pending list
    const ignoredRows = db.all('SELECT body FROM ignored_alerts');
    const ignoredBodies = ignoredRows.map((r) => r.body);
    assert.ok(ignoredBodies.some((b) => b.includes('Car Loan EMI of Rs 18,600')));
    assert.ok(ignoredBodies.some((b) => b.includes('towards HDFC Car Loan')));

    // 2. Existing Investment Outflow transaction
    const investTx = await call('save_transaction', {
      transaction: {
        date: '2026-08-03',
        amount: 25000,
        type: 'Investment',
        category: 'Investment Outflow',
        merchant: 'Parag Parikh Flexi Cap SIP',
        description: 'Mutual Fund SIP',
        raw_sms: '',
        is_investment_outflow: 1,
      },
    });
    assert.equal(investTx.status, 'success');
    const investId = investTx.transaction_id;

    const sipSms1 = 'ACH Debit of Rs 25,000 for PPFAS Mutual Fund on 03-Aug-2026\r\n';
    const sipSms2 = 'Rs 25,000.00 debited from A/c xx9988 for Parag Parikh Flexi Cap SIP on 03-Aug-2026';

    const sipRes1 = await handleSmsAction({
      action: 'merge_alert',
      transaction_id: investId,
      body: sipSms1,
      category: 'Investment Outflow',
      type: 'Investment',
    });
    assert.equal(sipRes1.status, 'success');

    const sipRes2 = await handleSmsAction({
      action: 'merge_alert',
      transaction_id: investId,
      body: sipSms2,
      category: 'Investment Outflow',
      type: 'Investment',
    });
    assert.equal(sipRes2.status, 'success');

    const finalInvest = db.get('SELECT * FROM transactions WHERE id = ?', [investId]);
    assert.equal(finalInvest.is_investment_outflow, 1);
    assert.equal(finalInvest.type, 'Investment');
  });
});
