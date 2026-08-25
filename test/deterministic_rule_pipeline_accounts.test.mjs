import test from 'node:test';
import assert from 'node:assert/strict';
import { freshBackend } from './_harness.mjs';
import {
  parseAccountDetailsFromText,
  extractAccountBalanceFromText,
  discoverAccountsFromSms,
  addDiscoveredAccounts,
  handleDbAction,
} from '../app/src/main/assets/www/js/backend/database.js';
import { notATransaction } from '../app/src/main/assets/www/js/backend/merchants.js';
import { extractTransactionAmount } from '../app/src/main/assets/www/js/backend/sms.js';

test('Deterministic Noise Gate: Filters non-transaction SMS messages', () => {
  // Mandates & pre-debit notifications
  assert.ok(
    Boolean(notATransaction('Mandate creation request for Rs 1,500.00 is initiated on A/c ending 1234 towards Netflix.')),
  );
  assert.ok(
    Boolean(notATransaction('Pre-debit notification: A/c xx5678 will be debited for Rs 5,000.00 on 15-Aug towards NACH Mandate.')),
  );
  assert.ok(
    Boolean(notATransaction('Reminder: E-mandate for Rs 999 is scheduled for deduction on 20-Aug from A/c XX4321.')),
  );

  // Statement generated alerts with total/min due
  assert.ok(
    Boolean(notATransaction('e-Statement for your Card ending 9876 is generated. Total Amt Due: Rs 14,500.00, Min Due: Rs 1,000 by 25-Aug.')),
  );

  // OTPs and logins
  assert.equal(
    notATransaction('OTP for your transaction of INR 450.00 at Swiggy is 849201. Do not share OTP with anyone.'),
    'otp',
  );

  // Spam & Promos
  assert.equal(
    notATransaction('Congratulations! You have pre-approved loan of Rs 5,00,000. Apply now at http://bank.co/loan'),
    'promo',
  );
});

test('Disambiguation: Extract transaction amount vs available balance', () => {
  const smsText = 'Dear SBI User, A/c 1234 debited by Rs.2,450.00 on 12Aug24 transfer to Amazon. Avl Bal: Rs.54,320.50 - SBI';
  const txnAmount = extractTransactionAmount(smsText);
  const avlBalance = extractAccountBalanceFromText(smsText);

  assert.equal(txnAmount, 2450.0);
  assert.equal(avlBalance, 54320.5);
});

test('Account Distinction: Debit Card vs Bank Account vs Credit Card', () => {
  // 1. Debit Card
  const debitSms = 'Txn of Rs 1,200.00 done using HDFC Bank Debit Card ending 4411 on 10-Aug at BigBasket. Avl Bal Rs 25,000.00';
  const debitInfo = parseAccountDetailsFromText(debitSms, 'HDFCBK');
  assert.equal(debitInfo.isDebitCard, true);
  assert.equal(debitInfo.isCreditCard, false);
  assert.equal(debitInfo.instrument_type, 'debit_card');
  assert.equal(debitInfo.debit_card_last_4, '4411');
  assert.equal(debitInfo.account_balance, 25000.0);

  // 2. Bank Account
  const bankSms = 'Dear Customer, A/c *8899 has been credited with Rs 45,000.00 on 01-Aug-24 by SALARY. Clear Bal Rs 1,12,000.00';
  const bankInfo = parseAccountDetailsFromText(bankSms, 'ICICIB');
  assert.equal(bankInfo.isBankAccount, true);
  assert.equal(bankInfo.isCreditCard, false);
  assert.equal(bankInfo.instrument_type, 'bank_account');
  assert.equal(bankInfo.account_number, '8899');
  assert.equal(bankInfo.account_balance, 112000.0);

  // 3. Credit Card
  const ccSms = 'Spent Rs 3,499.00 on ICICI Bank Coral Credit Card ending 7733 at Croma. Avail Limit: Rs 1,45,000.00, Total Limit: Rs 2,00,000.00';
  const ccInfo = parseAccountDetailsFromText(ccSms, 'ICICIB');
  assert.equal(ccInfo.isCreditCard, true);
  assert.equal(ccInfo.isDebitCard, false);
  assert.equal(ccInfo.instrument_type, 'credit_card');
  assert.equal(ccInfo.last4, '7733');
  assert.equal(ccInfo.available_limit, 145000.0);
  assert.equal(ccInfo.total_limit, 200000.0);

  // 4. Meal Card
  const mealSms = 'Your Pluxee card ending 6012 was debited for Rs 320.00 at FreshMenu. Avl Bal Rs 2,150.00';
  const mealInfo = parseAccountDetailsFromText(mealSms, 'PLUXEE');
  assert.equal(mealInfo.isFoodCard, true);
  assert.equal(mealInfo.instrument_type, 'meal_card');
  assert.equal(mealInfo.account_balance, 2150.0);
});

test('Account Discovery: Populates extracted latest balance', async () => {
  const db = await freshBackend();

  // Ingest sample transaction with raw SMS containing available balance
  db.run(
    `INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, raw_sms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      1,
      '2026-08-20',
      1500,
      'INR',
      'Expense',
      'Groceries',
      'Zepto',
      'Txn of Rs 1500.00 on HDFC Bank Debit Card ending 9012 at Zepto. Avl Bal Rs 38,500.00',
      new Date().toISOString(),
    ],
  );

  const discovery = discoverAccountsFromSms(db);
  assert.equal(discovery.status, 'success');
  assert.equal(discovery.discovered.length, 1);

  const item = discovery.discovered[0];
  assert.equal(item.is_debit_card, true);
  assert.equal(item.debit_card_last_4, '9012');
  assert.equal(item.balance, 38500.0);
  assert.equal(item.category, 'Bank');

  // Add discovered account
  const addRes = addDiscoveredAccounts(db, { accounts: [item] });
  assert.equal(addRes.status, 'success');
  assert.equal(addRes.added, 1);

  // Verify created account has the extracted balance
  const createdAcc = db.get('SELECT * FROM asset_accounts WHERE debit_card_last_4 = ?', ['9012']);
  assert.ok(createdAcc);
  assert.equal(createdAcc.balance, 38500.0);
  assert.equal(createdAcc.category, 'Bank');
});

test('Balance Reconciliation: Direct transactions update account and card balances', async () => {
  const db = await freshBackend();

  // Create an initial bank account
  const accRes = db.run(
    'INSERT INTO asset_accounts (member_id, name, category, institution, account_number, balance) VALUES (?, ?, ?, ?, ?, ?)',
    [1, 'HDFC Savings', 'Bank', 'HDFC Bank', '5566', 10000.0],
  );
  const accId = accRes.lastInsertRowid;

  // 1. Direct Expense transaction
  const txRes = await handleDbAction({
    action: 'save_transaction',
    transaction: {
      account_id: accId,
      amount: 1500,
      type: 'Expense',
      category: 'Shopping',
      merchant: 'Decathlon',
      date: '2026-08-21',
    },
  });
  assert.equal(txRes.status, 'success');

  let updatedAcc = db.get('SELECT balance FROM asset_accounts WHERE id = ?', [accId]);
  assert.equal(updatedAcc.balance, 8500.0);

  // 2. Direct Income transaction
  await handleDbAction({
    action: 'save_transaction',
    transaction: {
      account_id: accId,
      amount: 5000,
      type: 'Income',
      category: 'Salary',
      merchant: 'Employer',
      date: '2026-08-22',
    },
  });

  updatedAcc = db.get('SELECT balance FROM asset_accounts WHERE id = ?', [accId]);
  assert.equal(updatedAcc.balance, 13500.0);

  // 3. Delete transaction reverts the balance
  await handleDbAction({ action: 'delete_transaction', transaction_id: txRes.transaction_id });
  updatedAcc = db.get('SELECT balance FROM asset_accounts WHERE id = ?', [accId]);
  assert.equal(updatedAcc.balance, 15000.0);
});
