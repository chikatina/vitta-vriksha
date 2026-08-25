import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, sms } from './_harness.mjs';
import { parseAccountDetailsFromText } from '../app/src/main/assets/www/js/backend/database.js';
import { extractMerchant, categoryForMerchant, notATransaction } from '../app/src/main/assets/www/js/backend/merchants.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('StanChart, ECS Mandates & Comprehensive RBI Bank Knowledge Base', () => {
  describe('StanChart ECS Alert Classification', () => {
    it('classifies Standard Chartered ECS debit alert accurately into Loans & EMI', async () => {
      const msg = 'Your account 270xxxx2219 has been debited on 21/08/2026 by INR 71,068.00 towards ECS.Available Balance:INR 114,151.61 -StanChart';

      assert.equal(notATransaction(msg), '', 'Must be recognized as a completed transaction');

      const parsed = await sms.parseSmsText(msg, 'StanChart');
      assert.equal(parsed.status, 'classified');
      assert.equal(parsed.amount, 71068);
      assert.equal(parsed.type, 'Expense');
      assert.equal(parsed.category, 'Loans & EMI');
      assert.equal(parsed.account_issuer, 'Standard Chartered Bank');
      assert.equal(parsed.account_last4, '2219');
      assert.equal(parsed.date, '2026-08-21');
    });

    it('classifies various ECS, NACH, and ACH mandate debits into Loans & EMI', async () => {
      const cases = [
        {
          text: 'Your A/C 9876 has been debited by Rs.4,500 on 10/08/2026 towards ECS debit. Avl Bal Rs 50,000. -SBI',
          sender: 'SBI',
          expectedAmount: 4500,
          expectedCategory: 'Loans & EMI',
          expectedIssuer: 'State Bank of India',
        },
        {
          text: 'INR 8,250.00 debited from Axis Bank A/c ending 6543 on 15-08-2026 towards ECS. Bal INR 32,100.',
          sender: 'AXISBK',
          expectedAmount: 8250,
          expectedCategory: 'Loans & EMI',
          expectedIssuer: 'Axis Bank',
        },
        {
          text: 'Dear Customer, INR 15,000.00 debited from A/C **1234 on 05-Aug-2026 towards NACH Mandate Bajaj Finserv. Bal INR 90,000.',
          sender: 'HDFCBK',
          expectedAmount: 15000,
          expectedCategory: 'Loans & EMI',
          expectedIssuer: 'HDFC Bank',
        },
        {
          text: 'Acct XX4321 debited for INR 25,000.00 on 12-Aug-2026. Info: ACH D- BAJAJ LOAN EMI. Avl Bal: INR 80,000.00',
          sender: 'ICICIB',
          expectedAmount: 25000,
          expectedCategory: 'Loans & EMI',
          expectedIssuer: 'ICICI Bank',
        },
      ];

      for (const c of cases) {
        const parsed = await sms.parseSmsText(c.text, c.sender);
        assert.equal(parsed.status, 'classified');
        assert.equal(parsed.amount, c.expectedAmount);
        assert.equal(parsed.type, 'Expense');
        assert.equal(parsed.category, c.expectedCategory);
        assert.equal(parsed.account_issuer, c.expectedIssuer);
      }
    });

    it('classifies expanded SIP, FASTag, salary, utility and tax alerts accurately', async () => {
      const cases = [
        {
          text: 'Your account XX1234 debited by INR 5,000.00 towards SIP. Avl Bal INR 45,000.',
          sender: 'HDFCBK',
          expectedAmount: 5000,
          expectedType: 'Investment',
          expectedCategory: 'Investment Outflow',
        },
        {
          text: 'FASTag recharge of INR 1,000.00 debited from A/C 9988.',
          sender: 'ICICIB',
          expectedAmount: 1000,
          expectedType: 'Expense',
          expectedCategory: 'Transport',
        },
        {
          text: 'Salary credit of INR 1,50,000.00 deposited in your A/C 7766 on 31-Aug-2026.',
          sender: 'SBI',
          expectedAmount: 150000,
          expectedType: 'Income',
          expectedCategory: 'Salary',
        },
        {
          text: 'Electricity bill of Rs.2,400 paid via smartpay from A/C 5544.',
          sender: 'AXISBK',
          expectedAmount: 2400,
          expectedType: 'Expense',
          expectedCategory: 'Utilities',
        },
        {
          text: 'Advance tax challan payment of Rs.25,000 debited from A/C 3344.',
          sender: 'KOTAK',
          expectedAmount: 25000,
          expectedType: 'Expense',
          expectedCategory: 'Insurance & Tax',
        },
      ];

      for (const c of cases) {
        const parsed = await sms.parseSmsText(c.text, c.sender);
        assert.equal(parsed.status, 'classified');
        assert.equal(parsed.amount, c.expectedAmount);
        assert.equal(parsed.type, c.expectedType);
        assert.equal(parsed.category, c.expectedCategory);
      }
    });
  });

  describe('RBI Banks & Institutions Detection in parseAccountDetailsFromText', () => {
    it('detects Public Sector, Private, Foreign, SFB, and Payment banks correctly', () => {
      const bankTests = [
        { text: 'StanChart A/C xx2219 debited', sender: 'StanChart', expectedIssuer: 'Standard Chartered Bank', expectedCode: 'SCB' },
        { text: 'Standard Chartered Bank card ending 1122', sender: 'SCB', expectedIssuer: 'Standard Chartered Bank', expectedCode: 'SCB' },
        { text: 'Deutsche Bank A/c 5544 debited', sender: 'Deutsche', expectedIssuer: 'Deutsche Bank', expectedCode: 'DB' },
        { text: 'DBS Bank A/c 9988 credited', sender: 'DBS', expectedIssuer: 'DBS Bank', expectedCode: 'DBS' },
        { text: 'HSBC Bank A/c 7766 debited', sender: 'HSBC', expectedIssuer: 'HSBC Bank', expectedCode: 'HSBC' },
        { text: 'Barclays A/c 3322 credited', sender: 'Barclays', expectedIssuer: 'Barclays', expectedCode: 'BARCLAYS' },
        { text: 'Bank of India A/c 4433 debited', sender: 'BOI', expectedIssuer: 'Bank of India', expectedCode: 'BOI' },
        { text: 'Indian Overseas Bank A/c 1122 debited', sender: 'IOB', expectedIssuer: 'Indian Overseas Bank', expectedCode: 'IOB' },
        { text: 'UCO Bank A/c 8899 credited', sender: 'UCO', expectedIssuer: 'UCO Bank', expectedCode: 'UCO' },
        { text: 'Bank of Maharashtra A/c 5566 debited', sender: 'BOM', expectedIssuer: 'Bank of Maharashtra', expectedCode: 'BOM' },
        { text: 'Punjab & Sind Bank A/c 7788 debited', sender: 'PSB', expectedIssuer: 'Punjab & Sind Bank', expectedCode: 'PSB' },
        { text: 'Central Bank of India A/c 9900 debited', sender: 'CBI', expectedIssuer: 'Central Bank of India', expectedCode: 'CBI' },
        { text: 'Indian Bank A/c 2233 debited', sender: 'IndianBank', expectedIssuer: 'Indian Bank', expectedCode: 'INDIAN' },
        { text: 'South Indian Bank A/c 6655 debited', sender: 'SIB', expectedIssuer: 'South Indian Bank', expectedCode: 'SIB' },
        { text: 'Bandhan Bank A/c 4455 debited', sender: 'Bandhan', expectedIssuer: 'Bandhan Bank', expectedCode: 'BANDHAN' },
        { text: 'City Union Bank A/c 1234 debited', sender: 'CUB', expectedIssuer: 'City Union Bank', expectedCode: 'CUB' },
        { text: 'Karur Vysya Bank A/c 5678 debited', sender: 'KVB', expectedIssuer: 'Karur Vysya Bank', expectedCode: 'KVB' },
        { text: 'Karnataka Bank A/c 9012 debited', sender: 'KTK', expectedIssuer: 'Karnataka Bank', expectedCode: 'KTK' },
        { text: 'DCB Bank A/c 3456 debited', sender: 'DCB', expectedIssuer: 'DCB Bank', expectedCode: 'DCB' },
        { text: 'J&K Bank A/c 7890 debited', sender: 'JKB', expectedIssuer: 'J&K Bank', expectedCode: 'JKB' },
        { text: 'AU Small Finance Bank A/c 4321 debited', sender: 'AUBANK', expectedIssuer: 'AU Small Finance Bank', expectedCode: 'AU' },
        { text: 'Equitas Small Finance Bank A/c 8765 debited', sender: 'EQUITAS', expectedIssuer: 'Equitas Small Finance Bank', expectedCode: 'EQUITAS' },
        { text: 'Ujjivan Small Finance Bank A/c 2109 debited', sender: 'UJJIVAN', expectedIssuer: 'Ujjivan Small Finance Bank', expectedCode: 'UJJIVAN' },
        { text: 'Jana Small Finance Bank A/c 6543 debited', sender: 'JANA', expectedIssuer: 'Jana Small Finance Bank', expectedCode: 'JANA' },
        { text: 'Airtel Payments Bank A/c 0987 credited', sender: 'AIRTEL', expectedIssuer: 'Airtel Payments Bank', expectedCode: 'AIRTEL' },
        { text: 'India Post Payments Bank A/c 5432 debited', sender: 'IPPB', expectedIssuer: 'India Post Payments Bank', expectedCode: 'IPPB' },
        { text: 'Fino Payments Bank A/c 1357 debited', sender: 'FINO', expectedIssuer: 'Fino Payments Bank', expectedCode: 'FINO' },
      ];

      for (const item of bankTests) {
        const info = parseAccountDetailsFromText(item.text, item.sender);
        assert.equal(info.issuer, item.expectedIssuer, `Issuer mismatch for text: "${item.text}"`);
        assert.equal(info.bankCode, item.expectedCode, `BankCode mismatch for text: "${item.text}"`);
      }
    });
  });
});
