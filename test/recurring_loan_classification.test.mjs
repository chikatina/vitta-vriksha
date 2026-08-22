import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, monthsAgo } from './_harness.mjs';
import {
  findRecurring,
  trackRecurring,
  applyPriceChange,
  getPriceHistory,
  projectCommitments,
} from '../app/src/main/assets/www/js/backend/recurring.js';

describe('Recurring Payment Classification: Loan EMIs, Clubbed Loans & Credit Cards', () => {
  let db;

  beforeEach(async () => {
    db = await freshBackend();
  });

  it('automatically detects Loan EMIs, Credit Cards, SIPs, and Subscriptions from merchant narrations', () => {
    const d1 = monthsAgo(3);
    const d2 = monthsAgo(2);
    const d3 = monthsAgo(1);

    // Seed transactions for different kinds of recurring payments
    const txs = [
      // 1. Loan EMI: HDFC Home Loan
      { date: d1, amount: 35000, merchant: 'HDFC Bank Home Loan EMI', category: 'Loans' },
      { date: d2, amount: 35000, merchant: 'HDFC Bank Home Loan EMI', category: 'Loans' },
      { date: d3, amount: 35000, merchant: 'HDFC Bank Home Loan EMI', category: 'Loans' },
      // 2. Loan EMI: Bajaj Finserv Consumer EMI
      { date: d1, amount: 4200, merchant: 'Bajaj Finance EMI Mandate', category: 'Bills' },
      { date: d2, amount: 4200, merchant: 'Bajaj Finance EMI Mandate', category: 'Bills' },
      { date: d3, amount: 4200, merchant: 'Bajaj Finance EMI Mandate', category: 'Bills' },
      // 3. Investment SIP: Nippon India MF
      { date: d1, amount: 5000, merchant: 'Nippon India Mutual Fund', category: 'Investments', is_investment_outflow: 1 },
      { date: d2, amount: 5000, merchant: 'Nippon India Mutual Fund', category: 'Investments', is_investment_outflow: 1 },
      { date: d3, amount: 5000, merchant: 'Nippon India Mutual Fund', category: 'Investments', is_investment_outflow: 1 },
      // 4. Credit Card: SBI Card payment
      { date: d1, amount: 12500, merchant: 'SBI Credit Card Auto-Debit', category: 'Bills' },
      { date: d2, amount: 12500, merchant: 'SBI Credit Card Auto-Debit', category: 'Bills' },
      { date: d3, amount: 12500, merchant: 'SBI Credit Card Auto-Debit', category: 'Bills' },
      // 5. Subscription: Netflix
      { date: d1, amount: 649, merchant: 'Netflix Entertainment', category: 'Entertainment' },
      { date: d2, amount: 649, merchant: 'Netflix Entertainment', category: 'Entertainment' },
      { date: d3, amount: 649, merchant: 'Netflix Entertainment', category: 'Entertainment' },
    ];

    for (const t of txs) {
      db.run(
        'INSERT INTO transactions (member_id, date, amount, merchant, category, type, is_investment_outflow) VALUES (1, ?, ?, ?, ?, ?, ?)',
        [t.date, t.amount, t.merchant, t.category, 'Expense', t.is_investment_outflow || 0],
      );
    }

    const res = findRecurring(db, { months: 6, min_occurrences: 3 });
    assert.equal(res.candidates.length, 5);

    const hdfcLoan = res.candidates.find((c) => c.name.includes('HDFC'));
    assert.ok(hdfcLoan);
    assert.equal(hdfcLoan.kind, 'loan');
    assert.equal(hdfcLoan.amount, 35000);

    const bajajLoan = res.candidates.find((c) => c.name.includes('Bajaj'));
    assert.ok(bajajLoan);
    assert.equal(bajajLoan.kind, 'loan');
    assert.equal(bajajLoan.amount, 4200);

    const nipponSip = res.candidates.find((c) => c.name.includes('Nippon'));
    assert.ok(nipponSip);
    assert.equal(nipponSip.kind, 'sip');
    assert.equal(nipponSip.amount, 5000);

    const sbiCard = res.candidates.find((c) => c.name.includes('SBI'));
    assert.ok(sbiCard);
    assert.equal(sbiCard.kind, 'card');
    assert.equal(sbiCard.amount, 12500);

    const netflixSub = res.candidates.find((c) => c.name.includes('Netflix'));
    assert.ok(netflixSub);
    assert.equal(netflixSub.kind, 'subscription');
    assert.equal(netflixSub.amount, 649);
  });

  it('tracks a single loan EMI and links it to existing loan', () => {
    // 1. Insert existing loan
    const loanId = db.run(
      'INSERT INTO loans (member_id, name, loan_type, principal_amount, current_outstanding, interest_rate, tenure_months, start_date, monthly_emi, direction)'
      + " VALUES (1, 'HDFC Home Loan', 'Home Loan', 4000000, 3800000, 8.5, 240, '2025-01-01', 34713, 'borrowed')",
    ).lastInsertRowid;

    // 2. Track recurring payment for this loan
    const trackRes = trackRecurring(db, {
      kind: 'loan',
      loan_id: loanId,
      name: 'HDFC Bank NACH',
      amount: 34713,
      day_of_month: 5,
      merchant_key: 'hdfc_bank_nach',
    });

    assert.equal(trackRes.kind, 'loan');
    assert.equal(trackRes.record_id, loanId);

    // Verify loan record was updated with linked_merchant_key and debit_day
    const updatedLoan = db.get('SELECT * FROM loans WHERE id = ?', [loanId]);
    assert.equal(updatedLoan.linked_merchant_key, 'hdfc_bank_nach');
    assert.equal(updatedLoan.monthly_emi, 34713);
    assert.equal(updatedLoan.debit_day, 5);
  });

  it('creates a new loan when tracking a loan EMI', () => {
    const trackRes = trackRecurring(db, {
      kind: 'loan',
      name: 'Tata Capital Personal Loan',
      loan_type: 'Personal Loan',
      amount: 11250,
      principal_amount: 500000,
      current_outstanding: 450000,
      interest_rate: 12.5,
      tenure_months: 60,
      day_of_month: 10,
      lender: 'Tata Capital',
      merchant_key: 'tata_capital_emi',
    });

    assert.equal(trackRes.kind, 'loan');
    assert.ok(trackRes.record_id > 0);

    const newLoan = db.get('SELECT * FROM loans WHERE id = ?', [trackRes.record_id]);
    assert.equal(newLoan.name, 'Tata Capital Personal Loan');
    assert.equal(newLoan.loan_type, 'Personal Loan');
    assert.equal(newLoan.monthly_emi, 11250);
    assert.equal(newLoan.principal_amount, 500000);
    assert.equal(newLoan.interest_rate, 12.5);
    assert.equal(newLoan.lender, 'Tata Capital');
    assert.equal(newLoan.linked_merchant_key, 'tata_capital_emi');
  });

  it('clubs multiple loans from the same lender under a single recurring mandate', () => {
    // User has 2 loans with HDFC: Home Loan (₹32,000) and Top-up Loan (₹8,000)
    // Bank debits ₹40,000 combined under mandate "HDFC_LTD_COMBINED"
    const trackRes = trackRecurring(db, {
      kind: 'loan',
      name: 'HDFC Ltd Combined Mandate',
      amount: 40000,
      day_of_month: 5,
      merchant_key: 'hdfc_ltd_combined',
      clubbed_loans: [
        {
          name: 'HDFC Home Loan',
          loan_type: 'Home Loan',
          emi: 32000,
          principal_amount: 3500000,
          current_outstanding: 3400000,
          interest_rate: 8.5,
          tenure_months: 240,
        },
        {
          name: 'HDFC Top-up Loan',
          loan_type: 'Personal Loan',
          emi: 8000,
          principal_amount: 500000,
          current_outstanding: 480000,
          interest_rate: 9.2,
          tenure_months: 120,
        },
      ],
    });

    assert.equal(trackRes.kind, 'loan');
    assert.equal(trackRes.clubbed_count, 2);

    // Verify both loans exist in database and share the same linked_merchant_key
    const loans = db.all('SELECT * FROM loans WHERE linked_merchant_key = ? ORDER BY id ASC', ['hdfc_ltd_combined']);
    assert.equal(loans.length, 2);
    assert.equal(loans[0].name, 'HDFC Home Loan');
    assert.equal(loans[0].monthly_emi, 32000);
    assert.equal(loans[1].name, 'HDFC Top-up Loan');
    assert.equal(loans[1].monthly_emi, 8000);

    // Verify total commitment projection includes both clubbed loans
    const proj = projectCommitments(db, { months: 12 });
    assert.ok(proj.series.length > 0);
    const emiSeries = proj.series.find((s) => s.key === 'emis');
    assert.ok(emiSeries);
    // Combined EMI per month should be ₹32,000 + ₹8,000 = ₹40,000
    assert.equal(emiSeries.values[0], 40000);
  });

  it('tracks credit card payments and records price changes', () => {
    // 1. Track Credit Card
    const cardRes = trackRecurring(db, {
      kind: 'card',
      name: 'ICICI Amazon Pay Card',
      bank: 'ICICI Bank',
      last_4: '4321',
      amount: 15400,
      total_limit: 250000,
      merchant_key: 'icici_card_mandate',
    });

    assert.equal(cardRes.kind, 'card');
    assert.ok(cardRes.record_id > 0);

    const card = db.get('SELECT * FROM credit_cards WHERE id = ?', [cardRes.record_id]);
    assert.equal(card.card_name, 'ICICI Amazon Pay Card');
    assert.equal(card.current_balance, 15400);
    assert.equal(card.linked_merchant_key, 'icici_card_mandate');

    // 2. Apply Price Change on Card
    const priceRes = applyPriceChange(db, {
      kind: 'card',
      record_id: cardRes.record_id,
      amount: 18200,
      note: 'Higher bill this month',
    });
    assert.equal(priceRes.to_amount, 18200);

    // 3. Verify price history
    const hist = getPriceHistory(db, {
      kind: 'card',
      record_id: cardRes.record_id,
    });
    assert.equal(hist.changes.length, 1);
    assert.equal(hist.current_amount, 18200);
  });

  it('correctly calculates principal and outstanding for clubbed sub-loans without initial principal', () => {
    const trackRes = trackRecurring(db, {
      kind: 'loan',
      name: 'SBI Combined Mandate',
      amount: 45000,
      clubbed_loans: [
        {
          name: 'SBI Home Loan Sub-1',
          emi: 35000,
          interest_rate: 8.5,
          tenure_months: 240,
        },
        {
          name: 'SBI Home Loan Sub-2',
          emi: 10000,
          interest_rate: 8.5,
          tenure_months: 240,
        },
      ],
    });

    assert.equal(trackRes.status, 'success');
    assert.equal(trackRes.clubbed_count, 2);

    const loans = db.all('SELECT * FROM loans WHERE name LIKE ?', ['SBI Home Loan%']);
    assert.equal(loans.length, 2);
    for (const l of loans) {
      assert.ok(l.principal_amount > 0, 'Principal must be greater than 0');
      assert.ok(l.current_outstanding > 0, 'Outstanding must be greater than 0');
      assert.equal(l.monthly_emi > 0, true);
    }
  });
});
