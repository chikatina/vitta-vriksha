import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDate, cleanAmount, parsePhonePeStatement, parseGPayStatement, parseCsvStatements,
} from '../app/src/main/assets/www/js/backend/statement_parser.js';

test('Statement Parser: Date & Amount Normalization', () => {
  assert.equal(normalizeDate('2026-10-15'), '2026-10-15');
  assert.equal(normalizeDate('15/10/2026'), '2026-10-15');
  assert.equal(normalizeDate('15-10-2026'), '2026-10-15');
  assert.equal(normalizeDate('15 Oct 2026'), '2026-10-15');
  assert.equal(normalizeDate('Oct 15, 2026'), '2026-10-15');

  assert.equal(cleanAmount('₹1,450.50'), 1450.5);
  assert.equal(cleanAmount('Rs. 250'), 250);
  assert.equal(cleanAmount('99.00'), 99);
  assert.equal(cleanAmount(''), 0);
});

test('Statement Parser: PhonePe statement row parsing', () => {
  const lines = [
    'PhonePe Transaction Statement',
    'Oct 12, 2026 14:22:10',
    'Paid to Starbucks DEBIT ₹ 450.00 UTR: 428612345678',
    'Oct 14, 2026 09:15:00',
    'Received from Alice CREDIT ₹ 2,000.00 UTR: 428687654321',
  ];

  const txs = parsePhonePeStatement(lines);
  assert.equal(txs.length, 2);

  assert.equal(txs[0].date, '2026-10-12');
  assert.equal(txs[0].amount, 450);
  assert.equal(txs[0].type, 'Expense');
  assert.equal(txs[0].ref_id, '428612345678');
  assert.ok(txs[0].merchant.toLowerCase().includes('starbucks'));

  assert.equal(txs[1].date, '2026-10-14');
  assert.equal(txs[1].amount, 2000);
  assert.equal(txs[1].type, 'Income');
  assert.equal(txs[1].ref_id, '428687654321');
});

test('Statement Parser: Google Pay statement parsing', () => {
  const lines = [
    'Google Pay Transaction History',
    '15 Oct 2026, 12:30 PM Payment to Swiggy ₹320.00 Completed Google Pay Transaction ID: CICAgIC123456',
  ];

  const txs = parseGPayStatement(lines);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].date, '2026-10-15');
  assert.equal(txs[0].amount, 320);
  assert.equal(txs[0].type, 'Expense');
  assert.ok(txs[0].merchant.toLowerCase().includes('swiggy'));
});

test('Statement Parser: CSV Statement parsing (Cashew / Generic)', () => {
  const csv = `Date,Title,Amount,Category,Type
2026-10-10,Tokyo Hotel,15000,Travel,Expense
2026-10-11,Ramen Dining,2200,Dining,Expense
2026-10-12,Salary Credit,85000,Salary,Income`;

  const txs = parseCsvStatements(csv);
  assert.equal(txs.length, 3);
  assert.equal(txs[0].date, '2026-10-10');
  assert.equal(txs[0].amount, 15000);
  assert.equal(txs[0].type, 'Expense');

  assert.equal(txs[2].date, '2026-10-12');
  assert.equal(txs[2].amount, 85000);
  assert.equal(txs[2].type, 'Income');
});
