import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, call } from './_harness.mjs';
import {
  parseAccountDetailsFromText,
  extractAccountBalanceFromText,
} from '../app/src/main/assets/www/js/backend/database.js';
import { parseSmsText, handleSmsAction } from '../app/src/main/assets/www/js/backend/sms.js';

describe('Home Loan Overdraft (OD), Negative Balance & Mandate Reconciliation', () => {
  let db;

  beforeEach(async () => {
    db = await freshBackend();
  });

  async function ingestAlert(body, sender) {
    const parsed = await parseSmsText(body, sender);
    return await handleSmsAction({
      action: 'classify_alert',
      body,
      sender,
      amount: parsed.amount,
      category: parsed.category,
      type: parsed.type,
      merchant: parsed.merchant,
      date: parsed.date,
    });
  }

  it('extracts negative balance and detects loan from BOI OD account SMS', () => {
    const text = 'BOI - Rs 71068.00 has been Credited (NACH DR OW) in your account XXXX0039 on 21-09-2026.Avl Bal -9898954.00.Download BOI Mobile App - Bank of India';
    const balance = extractAccountBalanceFromText(text);
    assert.equal(balance, -9898954.00);

    const details = parseAccountDetailsFromText(text, 'BOI');
    assert.equal(details.last4, '0039');
    assert.equal(details.isLoan, true);
    assert.equal(details.instrument_type, 'loan');
    assert.equal(details.account_balance, -9898954.00);
    assert.equal(details.current_outstanding, 9898954.00);
    assert.equal(details.issuer, 'Bank of India');
  });

  it('extracts Dr suffix balance as negative and flags loan status', () => {
    const text = 'A/c XX0039 Avl Bal INR 50,000.00 Dr as on 15-Oct-26';
    const balance = extractAccountBalanceFromText(text);
    assert.equal(balance, -50000.00);

    const details = parseAccountDetailsFromText(text, 'BOI');
    assert.equal(details.isLoan, true);
    assert.equal(details.instrument_type, 'loan');
    assert.equal(details.current_outstanding, 50000.00);
  });

  it('discovers loan account from SMS inbox with EMI and debit day', async () => {
    const messages = [
      'BOI - Rs 71068.00 has been Credited (NACH DR OW) in your account XXXX0039 on 21-08-2026.Avl Bal -9965000.00.Download BOI Mobile App - Bank of India',
      'BOI - Rs 71068.00 has been Credited (NACH DR OW) in your account XXXX0039 on 21-09-2026.Avl Bal -9898954.00.Download BOI Mobile App - Bank of India',
      'Your a/c XX4142 is debited for Rs. 500.00 on 22-09-2026. Avl Bal Rs 25000.00',
    ];

    for (const body of messages) {
      await ingestAlert(body, 'BOIIND');
    }

    const discRes = await call('discover_accounts_from_sms');
    assert.equal(discRes.status, 'success');

    const discovered = discRes.discovered || [];
    const boiLoan = discovered.find((d) => d.last_4 === '0039');
    assert.ok(boiLoan, 'BOI 0039 loan should be discovered');
    assert.equal(boiLoan.kind, 'loan');
    assert.equal(boiLoan.instrument_type, 'loan');
    assert.equal(boiLoan.monthly_emi, 71068);
    assert.equal(boiLoan.current_outstanding, 9898954);
    assert.equal(boiLoan.debit_day, 21);

    const boiSavings = discovered.find((d) => d.last_4 === '4142');
    assert.ok(boiSavings, 'BOI 4142 savings account should be discovered');
    assert.equal(boiSavings.kind, 'account');
  });

  it('adds discovered loan to database and verifies positive current_outstanding', async () => {
    const loanPayload = {
      name: 'Bank of India Home Loan (OD)',
      lender: 'Bank of India',
      account_number: 'XXXX0039',
      last_4: '0039',
      current_outstanding: 9898954,
      principal_amount: 9898954,
      monthly_emi: 71068,
      interest_rate: 8.4,
      direction: 'borrowed',
      loan_type: 'Home',
    };

    const saveRes = await call('save_record', {
      record_type: 'loan',
      record: loanPayload,
    });
    assert.equal(saveRes.status, 'success');
    assert.ok(saveRes.id > 0);

    const listRes = await call('list_records', { record_type: 'loan' });
    assert.equal(listRes.status, 'success');
    assert.equal(listRes.records.length, 1);
    const saved = listRes.records[0];
    assert.equal(saved.last_4, '0039');
    assert.equal(saved.account_number, 'XXXX0039');
    assert.equal(saved.current_outstanding, 9898954);
    assert.equal(saved.monthly_emi, 71068);
  });

  it('bilaterally pairs Standard Chartered ECS debit and BOI 0039 NACH credit into a loan transfer', async () => {
    // 1. Create checking account XX2219 and loan XX0039
    await call('save_record', {
      record_type: 'account',
      record: {
        name: 'Standard Chartered Salary',
        institution: 'Standard Chartered',
        category: 'Bank',
        account_number: 'XX2219',
        balance: 150000,
      },
    });

    const loanRes = await call('save_record', {
      record_type: 'loan',
      record: {
        name: 'BOI Home Loan OD',
        lender: 'Bank of India',
        account_number: '0039',
        last_4: '0039',
        current_outstanding: 9965000,
        monthly_emi: 71068,
      },
    });
    const loanId = loanRes.id || loanRes.record_id;

    // 2. Ingest Standard Chartered debit message (which has NO mention of 0039)
    const scbMsg = 'Your a/c XX2219 is debited for INR 71,068.00 on 21-Sep-2026 towards ECS.';
    const scbRes = await ingestAlert(scbMsg, 'SCBANK');
    assert.equal(scbRes.status, 'success');

    // 3. Ingest BOI OD credit message
    const boiMsg = 'BOI - Rs 71068.00 has been Credited (NACH DR OW) in your account XXXX0039 on 21-09-2026.Avl Bal -9898954.00.Download BOI Mobile App - Bank of India';
    const boiRes = await ingestAlert(boiMsg, 'BOIIND');
    assert.equal(boiRes.status, 'success');

    // 4. Run reconciliation
    const reconRes = await call('reconcile_existing_transactions');
    assert.equal(reconRes.status, 'success');

    // 5. Verify transactions
    const txRes = await call('get_transactions', { limit: 10 });
    const txs = txRes.transactions || [];
    assert.equal(txs.length, 2);

    for (const t of txs) {
      assert.equal(t.type, 'Transfer');
      assert.equal(t.category, 'Loans & EMI');
      assert.equal(t.loan_id, loanId);
    }

    // 6. Verify loan outstanding updated from the negative balance in SMS
    const loanList = await call('list_records', { record_type: 'loan' });
    assert.equal(loanList.records[0].current_outstanding, 9898954.00);
  });

  it('pairs arbitrary prepayment into loan without fixed date constraint', async () => {
    // 1. Setup accounts
    await call('save_record', {
      record_type: 'account',
      record: {
        name: 'Standard Chartered Salary',
        institution: 'Standard Chartered',
        category: 'Bank',
        account_number: 'XX2219',
        balance: 500000,
      },
    });

    const loanRes = await call('save_record', {
      record_type: 'loan',
      record: {
        name: 'BOI Home Loan OD',
        lender: 'Bank of India',
        account_number: '0039',
        last_4: '0039',
        current_outstanding: 9898954,
        monthly_emi: 71068,
      },
    });
    const loanId = loanRes.id || loanRes.record_id;

    // 2. Prepayment of arbitrary amount (e.g. ₹50,000 on 14-Oct)
    const debitMsg = 'Your a/c XX2219 is debited for INR 50,000.00 on 14-Oct-2026 towards Prepayment.';
    await ingestAlert(debitMsg, 'SCBANK');

    const creditMsg = 'BOI - Rs 50000.00 has been Credited in your account XXXX0039 on 14-10-2026.Avl Bal -9848954.00.';
    await ingestAlert(creditMsg, 'BOIIND');

    // 3. Reconcile
    await call('reconcile_existing_transactions');

    // 4. Verify paired transfer
    const txRes = await call('get_transactions', { limit: 10 });
    const txs = txRes.transactions || [];
    assert.equal(txs.length, 2);

    for (const t of txs) {
      assert.equal(t.type, 'Transfer');
      assert.equal(t.category, 'Loans & EMI');
      assert.equal(t.loan_id, loanId);
    }

    const loanList = await call('list_records', { record_type: 'loan' });
    assert.equal(loanList.records[0].current_outstanding, 9848954.00);
  });

  it('classifies standalone NACH credit directly as Transfer / Loans & EMI', async () => {
    const loanRes = await call('save_record', {
      record_type: 'loan',
      record: {
        name: 'BOI Home Loan OD',
        lender: 'Bank of India',
        account_number: '0039',
        last_4: '0039',
        current_outstanding: 9965000,
        monthly_emi: 71068,
      },
    });
    const loanId = loanRes.id || loanRes.record_id;

    const boiMsg = 'BOI - Rs 71068.00 has been Credited (NACH DR OW) in your account XXXX0039 on 21-09-2026.Avl Bal -9898954.00.Download BOI Mobile App - Bank of India';
    const parsed = await parseSmsText(boiMsg, 'BOIIND');

    assert.equal(parsed.status, 'classified');
    assert.equal(parsed.type, 'Transfer');
    assert.equal(parsed.category, 'Loans & EMI');
    assert.equal(parsed.amount, 71068);
    assert.equal(parsed.loan_id, loanId);
  });
});
