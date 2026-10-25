import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, call } from './_harness.mjs';
import {
  parseAccountDetailsFromText,
  extractAccountBalanceFromText,
} from '../app/src/main/assets/www/js/backend/database.js';
import { parseSmsText, handleSmsAction } from '../app/src/main/assets/www/js/backend/sms.js';
import { notATransaction } from '../app/src/main/assets/www/js/backend/merchants.js';

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

  it('classifies 7 Lakh Yes Bank credit card loan confirmation offer as promo (not a transaction)', () => {
    const text = 'Alert Confirm your EMI tenure to process for the loan of INR 7,00,000.00 on YES BANK Credit Card x5340 here: ccybl.in/YESBNK/MAP6DTlbWX -YES BANK LTD';
    const reason = notATransaction(text);
    assert.equal(reason, 'promo');
  });

  it('excludes ignored transactions from dashboard summary and spending anomalies', async () => {
    // 1. Ingest a large expense transaction of 7,00,000
    const today = new Date().toISOString().slice(0, 10);
    const saveRes = await call('save_transaction', {
      transaction: {
        date: today,
        amount: 700000,
        type: 'Expense',
        category: 'Loans & EMI',
        merchant: 'YES BANK',
      },
    });
    const txId = saveRes.transaction_id || saveRes.id;
    assert.ok(txId > 0);

    // Verify it initially shows up on dashboard summary
    let summary = await call('get_summary');
    assert.ok(summary.this_month.expense >= 700000);

    // Verify it initially shows in spending anomalies
    let anomaliesRes = await call('get_spending_anomalies');
    assert.equal(anomaliesRes.status, 'success');
    assert.ok(anomaliesRes.current_total_spend >= 700000);
    assert.ok(anomaliesRes.anomalies.some((a) => a.category === 'Loans & EMI'));

    // 2. Ignore the transaction
    const ignoreRes = await call('ignore_transaction', { id: txId });
    assert.equal(ignoreRes.status, 'success');

    // 3. Verify dashboard summary no longer counts the 7 Lakh transaction
    summary = await call('get_summary');
    assert.equal(summary.this_month.expense, 0);

    // 4. Verify spending anomalies no longer count the 7 Lakh transaction
    anomaliesRes = await call('get_spending_anomalies');
    assert.equal(anomaliesRes.status, 'success');
    assert.equal(anomaliesRes.current_total_spend, 0);
    assert.equal(anomaliesRes.anomalies.length, 0);
  });

  it('guards against Credit Card category for ECS/NACH loan transfers even when destination was registered as card', async () => {
    // User accidentally registered card ending 0039
    await call('save_record', {
      record_type: 'card',
      record: {
        card_name: 'BOI Card 0039',
        bank: 'Bank of India',
        last_4: '0039',
        current_balance: 0,
      },
    });

    await call('save_record', {
      record_type: 'account',
      record: {
        name: 'SCB Account',
        institution: 'Standard Chartered',
        category: 'Bank',
        account_number: 'XX2219',
        balance: 200000,
      },
    });

    const scbMsg = 'Your a/c XX2219 is debited for INR 71,068.00 on 21-Sep-2026 towards ECS.';
    await ingestAlert(scbMsg, 'SCBANK');

    const boiMsg = 'BOI - Rs 71068.00 has been Credited (NACH DR OW) in your account XXXX0039 on 21-09-2026.Avl Bal -9898954.00.Download BOI Mobile App - Bank of India';
    await ingestAlert(boiMsg, 'BOIIND');

    await call('reconcile_existing_transactions');

    const txRes = await call('get_transactions', { limit: 10 });
    const txs = txRes.transactions || [];
    assert.equal(txs.length, 2);
    for (const t of txs) {
      assert.equal(t.category, 'Loans & EMI', 'ECS / NACH must be categorized as Loans & EMI, never Credit Card');
    }
  });

  it('converts credit card to loan with convert_record to_type: loan', async () => {
    const cardRes = await call('save_record', {
      record_type: 'card',
      record: {
        card_name: 'BOI OD Card 0039',
        bank: 'Bank of India',
        last_4: '0039',
        current_balance: 9898954,
      },
    });
    const cardId = cardRes.id || cardRes.record_id;

    // Add a transaction linked to the card
    const txRes = await call('save_transaction', {
      transaction: {
        date: '2026-09-21',
        amount: 71068,
        type: 'Transfer',
        category: 'Loans & EMI',
        card_id: cardId,
      },
    });
    const txId = txRes.transaction_id || txRes.id;
    assert.ok(txId > 0);

    // Convert card to loan
    const convertRes = await call('convert_record', {
      from_type: 'card',
      to_type: 'loan',
      id: cardId,
    });
    assert.equal(convertRes.status, 'success');
    assert.equal(convertRes.target_type, 'loan');
    const newLoanId = convertRes.new_id;
    assert.ok(newLoanId > 0);

    // Verify card is deleted
    const cardList = await call('list_records', { record_type: 'card' });
    assert.equal(cardList.records.find((c) => c.id === cardId), undefined);

    // Verify loan is created
    const loanList = await call('list_records', { record_type: 'loan' });
    const newLoan = loanList.records.find((l) => l.id === newLoanId);
    assert.ok(newLoan);
    assert.equal(newLoan.last_4, '0039');
    assert.equal(newLoan.current_outstanding, 9827886);

    // Verify transaction is migrated to loan_id
    const updatedTxRes = await call('get_transactions', { limit: 10 });
    const updatedTx = updatedTxRes.transactions.find((t) => t.id === txId);
    assert.ok(updatedTx);
    assert.equal(updatedTx.loan_id, newLoanId);
    assert.equal(updatedTx.card_id, null);
  });
});
