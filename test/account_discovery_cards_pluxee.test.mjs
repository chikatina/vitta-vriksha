/*
 * Comprehensive test suite for Pluxee food cards, credit cards, bank accounts extraction & mapping.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend } from './_harness.mjs';
import {
  discoverAccountsFromSms,
  handleDbAction,
  parseAccountDetailsFromText,
} from '../app/src/main/assets/www/js/backend/database.js';
import { parseSmsText } from '../app/src/main/assets/www/js/backend/sms.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('Pluxee, Food Cards & Credit Cards Extraction and Mapping', () => {
  describe('parseAccountDetailsFromText parsing accuracy', () => {
    it('extracts Pluxee meal card and wallet details', () => {
      const sms1 = 'Spent Rs.350 on Pluxee Card ending 4321 at Subway. Bal: Rs. 1200';
      const res1 = parseAccountDetailsFromText(sms1);
      assert.equal(res1.issuer, 'Pluxee');
      assert.equal(res1.last4, '4321');
      assert.equal(res1.isFoodCard, true);
      assert.equal(res1.cardVariant, 'Meal Card');

      const sms2 = 'Rs.450 debited from Pluxee Meal Wallet **1234 at Swiggy';
      const res2 = parseAccountDetailsFromText(sms2);
      assert.equal(res2.issuer, 'Pluxee');
      assert.equal(res2.last4, '1234');
      assert.equal(res2.isFoodCard, true);
      assert.equal(res2.cardVariant, 'Meal Wallet');

      const sms3 = 'Your Sodexo Card 9876 used for INR 250.00 at Zomato';
      const res3 = parseAccountDetailsFromText(sms3);
      assert.equal(res3.issuer, 'Sodexo');
      assert.equal(res3.last4, '9876');
      assert.equal(res3.isFoodCard, true);
    });

    it('extracts Credit Cards with issuer, variant, and last 4 digits', () => {
      const sms1 = 'Rs. 2,499.00 spent on your HDFC Bank Infinia Card ending 8899 on 18-Aug-2026 at Amazon';
      const res1 = parseAccountDetailsFromText(sms1);
      assert.equal(res1.issuer, 'HDFC Bank');
      assert.equal(res1.last4, '8899');
      assert.equal(res1.isCreditCard, true);
      assert.equal(res1.cardVariant, 'Infinia');

      const sms2 = 'Alert: Spent INR 1,200.00 on ICICI Bank Amazon Pay Credit Card XX4521 at Flipkart';
      const res2 = parseAccountDetailsFromText(sms2);
      assert.ok(res2.issuer === 'ICICI Bank' || res2.issuer === 'Amazon Pay');
      assert.equal(res2.last4, '4521');
      assert.equal(res2.isCreditCard, true);
      assert.ok(res2.cardVariant === 'Amazon Pay' || res2.cardVariant === 'Amazon Pay Card');

      const sms3 = 'Rs 3,200 spent on Axis Bank Flipkart Card ending with 7712';
      const res3 = parseAccountDetailsFromText(sms3);
      assert.equal(res3.issuer, 'Axis Bank');
      assert.equal(res3.last4, '7712');
      assert.equal(res3.isCreditCard, true);
      assert.equal(res3.cardVariant, 'Flipkart Card');

      const sms4 = 'Amex Card ending 1004 used for Rs 4,500 at Apple';
      const res4 = parseAccountDetailsFromText(sms4);
      assert.equal(res4.issuer, 'American Express');
      assert.equal(res4.last4, '1004');
      assert.equal(res4.isCreditCard, true);

      const sms5 = 'Spent Rs 850 on OneCard ending 9922 at Starbucks';
      const res5 = parseAccountDetailsFromText(sms5);
      assert.equal(res5.issuer, 'OneCard');
      assert.equal(res5.last4, '9922');
      assert.equal(res5.isCreditCard, true);
      assert.equal(res5.cardVariant, 'OneCard');
    });

    it('extracts Debit Cards accurately and distinguishes from Credit Cards', () => {
      const sms1 = 'INR 850.00 debited from A/C XX1234 using Debit Card ending 4321 at Supermarket';
      const res1 = parseAccountDetailsFromText(sms1);
      assert.equal(res1.isDebitCard, true);
      assert.equal(res1.isCreditCard, false);
      assert.equal(res1.instrument_type, 'debit_card');
      assert.equal(res1.last4, '4321');
      assert.equal(res1.account_number, '1234');
      assert.equal(res1.debit_card_last_4, '4321');

      const sms2 = 'Rs. 2,000 withdrawn from ATM using HDFC Bank Debit Card ending 9988';
      const res2 = parseAccountDetailsFromText(sms2);
      assert.equal(res2.issuer, 'HDFC Bank');
      assert.equal(res2.isDebitCard, true);
      assert.equal(res2.isCreditCard, false);
      assert.equal(res2.instrument_type, 'debit_card');
      assert.equal(res2.last4, '9988');

      const sms3 = 'Rs 450 spent on your DC ending 7733 at Cafe Coffee Day';
      const res3 = parseAccountDetailsFromText(sms3);
      assert.equal(res3.isDebitCard, true);
      assert.equal(res3.isCreditCard, false);
      assert.equal(res3.last4, '7733');
    });

    it('extracts Wallets and Prepaid Cards accurately', () => {
      const sms1 = 'Rs 150 debited from Paytm Wallet ending 3344 for Uber trip';
      const res1 = parseAccountDetailsFromText(sms1);
      assert.equal(res1.issuer, 'Paytm');
      assert.equal(res1.isWallet, true);
      assert.equal(res1.instrument_type, 'wallet');
      assert.equal(res1.last4, '3344');

      const sms2 = 'INR 500 spent on NCMC Prepaid Card ending 6655 at Metro';
      const res2 = parseAccountDetailsFromText(sms2);
      assert.equal(res2.isPrepaidCard, true);
      assert.equal(res2.instrument_type, 'prepaid_card');
      assert.equal(res2.last4, '6655');
    });

    it('extracts Bank Accounts with bank and last 4 digits', () => {
      const sms1 = 'INR 15,000.00 debited from HDFC Bank A/C XX9012 via UPI to Sagar';
      const res1 = parseAccountDetailsFromText(sms1);
      assert.equal(res1.issuer, 'HDFC Bank');
      assert.equal(res1.last4, '9012');
      assert.equal(res1.isCreditCard, false);
      assert.equal(res1.isDebitCard, false);
      assert.equal(res1.isFoodCard, false);

      const sms2 = 'Rs 50,000 credited to ICICI Bank Account ending 3456 towards Salary';
      const res2 = parseAccountDetailsFromText(sms2);
      assert.equal(res2.issuer, 'ICICI Bank');
      assert.equal(res2.last4, '3456');
      assert.equal(res2.isCreditCard, false);
      assert.equal(res2.isDebitCard, false);
      assert.equal(res2.isFoodCard, false);
    });
  });

  describe('parseSmsText with account metadata integration', () => {
    it('classifies Pluxee transactions with Dining category and account metadata', async () => {
      const res = await parseSmsText('Spent Rs.420 on Pluxee Card ending 5511 at McDonald\'s');
      assert.equal(res.status, 'classified');
      assert.equal(res.amount, 420);
      assert.equal(res.category, 'Dining');
      assert.equal(res.account_last4, '5511');
      assert.equal(res.account_issuer, 'Pluxee');
      assert.equal(res.is_food_card, true);
    });

    it('classifies Credit Card transactions with card metadata', async () => {
      const res = await parseSmsText('Spent INR 3,500.00 on your SBI SimplyCLICK Card ending 2233 at Zara');
      assert.equal(res.status, 'classified');
      assert.equal(res.amount, 3500);
      assert.equal(res.account_last4, '2233');
      assert.equal(res.account_issuer, 'State Bank of India');
      assert.equal(res.is_credit_card, true);
      assert.equal(res.card_variant, 'SimplyCLICK');
    });
  });

  describe('discoverAccountsFromSms end-to-end discovery', () => {
    it('discovers Debit Card, Pluxee meal card, credit card, and bank account from raw SMS in database', async () => {
      // Seed raw SMS transactions
      db.run(
        `INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, raw_sms, created_at)
         VALUES (1, '2026-08-18', 250, 'INR', 'Expense', 'Dining', 'Subway',
                 'Spent Rs.250 on Pluxee Card ending 7788 at Subway', '2026-08-18T10:00:00Z')`
      );
      db.run(
        `INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, raw_sms, created_at)
         VALUES (1, '2026-08-18', 1999, 'INR', 'Expense', 'Shopping', 'Amazon',
                 'Rs 1,999.00 spent on HDFC Bank Infinia Card ending 4411', '2026-08-18T11:00:00Z')`
      );
      db.run(
        `INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, raw_sms, created_at)
         VALUES (1, '2026-08-18', 5000, 'INR', 'Expense', 'Bills', 'BESCOM',
                 'INR 5,000.00 debited from ICICI Bank A/C XX6622', '2026-08-18T12:00:00Z')`
      );
      db.run(
        `INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, raw_sms, created_at)
         VALUES (1, '2026-08-18', 800, 'INR', 'Expense', 'Shopping', 'DMart',
                 'INR 800 spent via HDFC Bank Debit Card ending 3399 at DMart', '2026-08-18T13:00:00Z')`
      );

      const res = discoverAccountsFromSms(db);
      assert.equal(res.status, 'success');
      assert.equal(res.discovered.length, 4);

      const debitItem = res.discovered.find((d) => d.instrument_type === 'debit_card');
      assert.ok(debitItem);
      assert.equal(debitItem.bank, 'HDFC Bank');
      assert.equal(debitItem.last_4, '3399');
      assert.equal(debitItem.category, 'Bank');
      assert.equal(debitItem.is_debit_card, true);

      const pluxeeItem = res.discovered.find((d) => d.bank === 'Pluxee');
      assert.ok(pluxeeItem);
      assert.equal(pluxeeItem.kind, 'account');
      assert.equal(pluxeeItem.category, 'Meal Card');
      assert.equal(pluxeeItem.last_4, '7788');

      const cardItem = res.discovered.find((d) => d.kind === 'card');
      assert.ok(cardItem);
      assert.equal(cardItem.bank, 'HDFC Bank');
      assert.equal(cardItem.last_4, '4411');
      assert.ok(cardItem.card_name.includes('Infinia'));

      const bankItem = res.discovered.find((d) => d.bank === 'ICICI Bank');
      assert.ok(bankItem);
      assert.equal(bankItem.kind, 'account');
      assert.equal(bankItem.category, 'Bank');
      assert.equal(bankItem.last_4, '6622');
    });

    it('saving discovered account auto-backfills transaction account_id', async () => {
      db.run(
        `INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, raw_sms, created_at)
         VALUES (1, '2026-08-18', 350, 'INR', 'Expense', 'Dining', 'Swiggy',
                 'Spent Rs.350 on Pluxee Card ending 8822 at Swiggy', '2026-08-18T10:00:00Z')`
      );

      const txBefore = db.get("SELECT account_id FROM transactions WHERE raw_sms LIKE '%8822%'");
      assert.equal(txBefore.account_id, null);

      const saveRes = await handleDbAction({
        action: 'save_record',
        record_type: 'account',
        record: {
          name: 'Pluxee Food Card (8822)',
          category: 'Meal Card',
          institution: 'Pluxee',
          account_number: '8822',
          balance: 1500,
        },
      });
      assert.equal(saveRes.status, 'success');

      const txAfter = db.get("SELECT account_id FROM transactions WHERE raw_sms LIKE '%8822%'");
      assert.equal(txAfter.account_id, saveRes.record_id);
    });

    it('add_discovered_accounts batch inserts all discovered items in a single transaction', async () => {
      const batchRes = await handleDbAction({
        action: 'add_discovered_accounts',
        accounts: [
          { kind: 'account', suggested_name: 'Axis Bank A/c (1111)', bank: 'Axis Bank', last_4: '1111', balance: 5000 },
          { kind: 'card', suggested_name: 'SBI SimplyCLICK (2222)', bank: 'SBI', last_4: '2222', total_limit: 100000, current_balance: 4500 },
        ],
      });
      assert.equal(batchRes.status, 'success');
      assert.equal(batchRes.added, 2);

      const acc = db.get("SELECT name, institution, account_number FROM asset_accounts WHERE account_number = '1111'");
      assert.ok(acc);
      assert.equal(acc.institution, 'Axis Bank');

      const card = db.get("SELECT card_name, bank, last_4 FROM credit_cards WHERE last_4 = '2222'");
      assert.ok(card);
      assert.equal(card.bank, 'SBI');
    });

    it('combine_discovered_account links discovered last_4 and bank to existing account or card', async () => {
      // Create initial account without last_4
      const accRes = await handleDbAction({
        action: 'save_record',
        record_type: 'account',
        record: { name: 'Main Salary Account', category: 'Savings', institution: 'HDFC', balance: 25000 },
      });
      assert.equal(accRes.status, 'success');

      // Combine with discovered identifier
      const combRes = await handleDbAction({
        action: 'combine_discovered_account',
        target_id: accRes.record_id,
        target_type: 'account',
        last_4: '5566',
        bank: 'HDFC Bank',
      });
      assert.equal(combRes.status, 'success');
      assert.equal(combRes.combined, true);

      const updatedAcc = db.get('SELECT account_number, institution FROM asset_accounts WHERE id = ?', [accRes.record_id]);
      assert.equal(updatedAcc.account_number, '5566');
      assert.ok(updatedAcc.institution === 'HDFC' || updatedAcc.institution === 'HDFC Bank');
    });

    it('combine_discovered_account with is_debit_card links debit_card_last_4 to existing bank account and backfills', async () => {
      // Insert raw SMS transaction with debit card
      db.run(
        `INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, raw_sms, created_at)
         VALUES (1, '2026-08-18', 1200, 'INR', 'Expense', 'Groceries', 'Blinkit',
                 'INR 1200 debited via Debit Card 7744 at Blinkit', '2026-08-18T10:00:00Z')`
      );

      const accRes = await handleDbAction({
        action: 'save_record',
        record_type: 'account',
        record: { name: 'HDFC Primary A/c', category: 'Bank', institution: 'HDFC Bank', account_number: '1234', balance: 40000 },
      });

      // Link Debit Card 7744 to this account
      const combRes = await handleDbAction({
        action: 'combine_discovered_account',
        target_id: accRes.record_id,
        target_type: 'account',
        last_4: '7744',
        bank: 'HDFC Bank',
        is_debit_card: true,
      });
      assert.equal(combRes.status, 'success');

      const updatedAcc = db.get('SELECT account_number, debit_card_last_4 FROM asset_accounts WHERE id = ?', [accRes.record_id]);
      assert.equal(updatedAcc.account_number, '1234');
      assert.equal(updatedAcc.debit_card_last_4, '7744');

      // Check transaction backfilled
      const tx = db.get("SELECT account_id FROM transactions WHERE raw_sms LIKE '%7744%'");
      assert.equal(tx.account_id, accRes.record_id);
    });
  });
});
