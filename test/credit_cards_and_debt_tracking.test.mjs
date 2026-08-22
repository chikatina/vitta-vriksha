import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend } from './_harness.mjs';
import {
  discoverAccountsFromSms,
  addDiscoveredAccounts,
  combineDiscoveredAccount,
  handleDbAction,
  parseAccountDetailsFromText,
  resolveAccountAndCardFromSms,
  autoUpdateCreditCardFromSms,
} from '../app/src/main/assets/www/js/backend/database.js';
import { parseSmsText, handleSmsAction } from '../app/src/main/assets/www/js/backend/sms.js';
import { calculateDebtSummary } from '../app/src/main/assets/www/js/backend/debt_planner.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('Credit Card Limit Tracking & SMS Linking & Monthly Debt', () => {
  describe('Credit Limit Extraction from SMS', () => {
    it('extracts available credit limit and total limit from standard bank SMS', () => {
      const sms1 = 'Alert: Rs 4,500.00 spent on HDFC Bank Credit Card ending 8899 at Amazon. Avl Limit: Rs 1,45,500.00, Total Limit: Rs 1,50,000.00';
      const parsed1 = parseAccountDetailsFromText(sms1);
      assert.equal(parsed1.issuer, 'HDFC Bank');
      assert.equal(parsed1.last4, '8899');
      assert.equal(parsed1.isCreditCard, true);
      assert.equal(parsed1.available_limit, 145500);
      assert.equal(parsed1.total_limit, 150000);

      const sms2 = 'INR 1,250.00 spent on ICICI Bank Card 4421. Available Credit Limit is INR 75,000.00. Total Outstanding: INR 25,000.00';
      const parsed2 = parseAccountDetailsFromText(sms2);
      assert.equal(parsed2.issuer, 'ICICI Bank');
      assert.equal(parsed2.last4, '4421');
      assert.equal(parsed2.available_limit, 75000);
      assert.equal(parsed2.current_outstanding, 25000);

      const sms3 = 'Axis Bank Card ending 1234: Credit Limit Avail: Rs. 40,000. Min Amount Due: Rs. 1,500.';
      const parsed3 = parseAccountDetailsFromText(sms3);
      assert.equal(parsed3.available_limit, 40000);
      assert.equal(parsed3.min_due, 1500);
    });

    it('parseSmsText returns credit limits and resolved account/card IDs', async () => {
      // Create a credit card
      const cardRes = await handleDbAction({
        action: 'save_record',
        record_type: 'card',
        record: {
          card_name: 'HDFC Regalia',
          bank: 'HDFC Bank',
          last_4: '5566',
          total_limit: 200000,
          available_limit: 180000,
          current_balance: 20000,
        },
      });
      assert.equal(cardRes.status, 'success');

      const sms = 'Alert: Rs 5,000.00 spent on HDFC Bank Card ending 5566 at Croma. Avl Limit: Rs 1,75,000.00';
      const result = await parseSmsText(sms, 'HDFCBK');
      assert.equal(result.amount, 5000);
      assert.equal(result.card_id, cardRes.record_id);
      assert.equal(result.available_limit, 175000);
    });
  });

  describe('Automatic Credit Card Limit & Balance Updating', () => {
    it('autoUpdateCreditCardFromSms updates available limit and current balance', async () => {
      const cardRes = await handleDbAction({
        action: 'save_record',
        record_type: 'card',
        record: {
          card_name: 'SBI SimplyClick',
          bank: 'SBI',
          last_4: '1122',
          total_limit: 100000,
          available_limit: 90000,
          current_balance: 10000,
        },
      });
      const cardId = cardRes.record_id;

      const sms = 'SBI Card 1122: Spent Rs 2,000 at Reliance. Avail Limit: Rs 88,000. Total Credit Limit: Rs 1,00,000.';
      const updated = autoUpdateCreditCardFromSms(db, sms, 'SBICRD', cardId);
      assert.ok(updated);
      assert.equal(updated.card_id, cardId);
      assert.equal(updated.available_limit, 88000);
      assert.equal(updated.current_balance, 12000);

      const listRes = await handleDbAction({ action: 'list_records', record_type: 'card' });
      const cardInDb = listRes.records.find((c) => c.id === cardId);
      assert.equal(cardInDb.available_limit, 88000);
      assert.equal(cardInDb.current_balance, 12000);
      assert.ok(cardInDb.updated_at);
    });

    it('save_transaction with raw_sms auto-links card_id and updates credit card', async () => {
      const cardRes = await handleDbAction({
        action: 'save_record',
        record_type: 'card',
        record: {
          card_name: 'Axis Magnus',
          bank: 'Axis Bank',
          last_4: '3344',
          total_limit: 500000,
          available_limit: 450000,
          current_balance: 50000,
        },
      });
      const cardId = cardRes.record_id;

      const rawSms = 'Spent Rs. 10,000 on Axis Bank Magnus Card ending 3344 at Taj. Avl Limit: Rs. 4,40,000.';
      const txRes = await handleDbAction({
        action: 'save_transaction',
        transaction: {
          amount: 10000,
          category: 'Dining',
          merchant: 'Taj Hotels',
          date: '2026-08-20',
          raw_sms: rawSms,
        },
      });
      assert.equal(txRes.status, 'success');

      const txList = await handleDbAction({ action: 'get_transactions', limit: 10 });
      const savedTx = txList.transactions.find((t) => t.merchant === 'Taj Hotels');
      assert.ok(savedTx);
      assert.equal(savedTx.card_id, cardId);
      assert.equal(savedTx.card_name, 'Axis Magnus');

      const cardList = await handleDbAction({ action: 'list_records', record_type: 'card' });
      const cardInDb = cardList.records.find((c) => c.id === cardId);
      assert.equal(cardInDb.available_limit, 440000);
      assert.equal(cardInDb.current_balance, 60000);
    });
  });

  describe('Account and Card SMS Linking across Instruments', () => {
    it('links bank accounts and debit cards to transactions', async () => {
      const accRes = await handleDbAction({
        action: 'save_record',
        record_type: 'account',
        record: {
          name: 'HDFC Salary A/c',
          category: 'Bank',
          institution: 'HDFC Bank',
          account_number: '9876543210',
          debit_card_last_4: '7788',
          balance: 50000,
        },
      });
      const accId = accRes.record_id;

      const rawSms = 'INR 500.00 debited from A/C XX3210 using Debit Card ending 7788 at Cafe. Avl Bal: INR 49,500.00';
      const resolved = resolveAccountAndCardFromSms(db, rawSms, 'HDFCBK');
      assert.equal(resolved.account_id, accId);
      assert.equal(resolved.card_id, null);

      const txRes = await handleDbAction({
        action: 'save_transaction',
        transaction: {
          amount: 500,
          category: 'Food',
          merchant: 'Cafe',
          date: '2026-08-20',
          raw_sms: rawSms,
        },
      });
      assert.equal(txRes.status, 'success');

      const txList = await handleDbAction({ action: 'get_transactions', account_id: accId });
      assert.equal(txList.transactions.length, 1);
      assert.equal(txList.transactions[0].account_name, 'HDFC Salary A/c');
    });

    it('filters transactions by card_id and searches by card name or last 4', async () => {
      const cardRes = await handleDbAction({
        action: 'save_record',
        record_type: 'card',
        record: {
          card_name: 'ICICI Sapphiro',
          bank: 'ICICI Bank',
          last_4: '9911',
          total_limit: 300000,
          current_balance: 15000,
        },
      });
      const cardId = cardRes.record_id;

      await handleDbAction({
        action: 'save_transaction',
        transaction: {
          amount: 2500,
          category: 'Shopping',
          merchant: 'Zara',
          date: '2026-08-19',
          card_id: cardId,
        },
      });

      const byCardId = (await handleDbAction({ action: 'get_transactions', card_id: cardId })).transactions;
      assert.equal(byCardId.length, 1);
      assert.equal(byCardId[0].merchant, 'Zara');
      assert.equal(byCardId[0].card_name, 'ICICI Sapphiro');

      const searchByCard = (await handleDbAction({ action: 'get_transactions', search: 'Sapphiro' })).transactions;
      assert.equal(searchByCard.length, 1);

      const searchByLast4 = (await handleDbAction({ action: 'get_transactions', search: '9911' })).transactions;
      assert.equal(searchByLast4.length, 1);
    });
  });

  describe('Discovered Accounts & Cards with Limits', () => {
    it('discovers credit cards with available limits and saves them', async () => {
      await handleDbAction({
        action: 'save_transaction',
        transaction: {
          amount: 3200,
          category: 'Electronics',
          merchant: 'Apple Store',
          date: '2026-08-15',
          raw_sms: 'Spent Rs 3,200 on your RBL Bank Credit Card ending 6655 at Apple. Avl Limit: Rs 96,800. Total Limit: Rs 1,00,000.',
        },
      });

      const discovered = discoverAccountsFromSms(db);
      assert.equal(discovered.status, 'success');
      const cardItem = discovered.discovered.find((d) => d.last_4 === '6655');
      assert.ok(cardItem);
      assert.equal(cardItem.kind, 'card');
      assert.equal(cardItem.bank, 'RBL Bank');
      assert.equal(cardItem.total_limit, 100000);
      assert.equal(cardItem.available_limit, 96800);
      assert.equal(cardItem.current_balance, 3200);

      const addRes = addDiscoveredAccounts(db, { accounts: [cardItem] });
      assert.equal(addRes.status, 'success');
      assert.equal(addRes.added, 1);

      const cards = (await handleDbAction({ action: 'list_records', record_type: 'card' })).records;
      const savedCard = cards.find((c) => c.last_4 === '6655');
      assert.ok(savedCard);
      assert.equal(savedCard.total_limit, 100000);
      assert.equal(savedCard.available_limit, 96800);
      assert.equal(savedCard.current_balance, 3200);

      // Verify transaction was backlinked
      const txs = (await handleDbAction({ action: 'get_transactions', card_id: savedCard.id })).transactions;
      assert.equal(txs.length, 1);
      assert.equal(txs[0].card_id, savedCard.id);
    });
  });

  describe('Debt Summary & Analytics', () => {
    it('calculates debt summary with loans and credit cards', async () => {
      // Add a loan
      await handleDbAction({
        action: 'save_record',
        record_type: 'loan',
        record: {
          name: 'Home Loan',
          lender: 'SBI',
          principal_amount: 5000000,
          current_outstanding: 4000000,
          interest_rate: 8.5,
          monthly_emi: 45000,
          tenure_months: 240,
        },
      });

      // Add a credit card
      await handleDbAction({
        action: 'save_record',
        record_type: 'card',
        record: {
          card_name: 'HDFC Infinia',
          bank: 'HDFC Bank',
          last_4: '1234',
          total_limit: 1000000,
          available_limit: 850000,
          current_balance: 150000,
        },
      });

      const debtSummary = calculateDebtSummary(db);
      assert.equal(debtSummary.status, 'success');
      assert.equal(debtSummary.total_debt, 4150000);
      assert.equal(debtSummary.loan_balance, 4000000);
      assert.equal(debtSummary.credit_card_balance, 150000);
      assert.equal(debtSummary.total_credit_limit, 1000000);
      assert.equal(debtSummary.available_credit_limit, 850000);
      assert.equal(debtSummary.overall_utilization_pct, 15);
      assert.equal(debtSummary.loan_monthly_emis, 45000);
      assert.equal(debtSummary.card_min_dues, 7500); // 5% of 150,000
      assert.equal(debtSummary.monthly_debt_obligations, 52500);

      // Verify get_debt_summary DB action
      const dbActionRes = await handleDbAction({ action: 'get_debt_summary' });
      assert.equal(dbActionRes.status, 'success');
      assert.equal(dbActionRes.total_debt, 4150000);

      // Verify get_summary includes debt_summary
      const summary = await handleDbAction({ action: 'get_summary' });
      assert.ok(summary.debt_summary);
      assert.equal(summary.debt_summary.total_debt, 4150000);
      assert.equal(summary.debt_summary.available_credit_limit, 850000);
    });

    it('monthly_debt series in get_series returns loan and card payments', async () => {
      // Add transactions with EMIs and Credit Card payments
      await handleDbAction({
        action: 'save_transaction',
        transaction: {
          amount: 45000,
          category: 'Loan EMI',
          merchant: 'SBI Home Loan',
          date: '2026-08-05',
          type: 'Expense',
        },
      });
      await handleDbAction({
        action: 'save_transaction',
        transaction: {
          amount: 25000,
          category: 'Credit Card',
          merchant: 'HDFC Card Payment',
          date: '2026-08-10',
          type: 'Transfer',
        },
      });

      const series = await handleDbAction({
        action: 'get_series',
        metric: 'monthly_debt',
        granularity: 'month',
        periods: 3,
      });

      assert.equal(series.status, 'success');
      assert.equal(series.metric, 'monthly_debt');
      assert.equal(series.series.length, 2);
      assert.equal(series.series[0].label, 'Loan EMIs');
      assert.equal(series.series[1].label, 'Card payments');

      const augustIdx = series.buckets.indexOf('2026-08');
      if (augustIdx !== -1) {
        assert.equal(series.series[0].values[augustIdx], 45000);
        assert.equal(series.series[1].values[augustIdx], 25000);
      }
    });
  });
});
