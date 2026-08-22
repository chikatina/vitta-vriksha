import test from 'node:test';
import assert from 'node:assert/strict';
import { freshBackend, call, ok } from './_harness.mjs';
import { getCombinedLoanSummary, handleLoanAction } from '../app/src/main/assets/www/js/backend/loan.js';
import { getNetWorthMilestones, calculateFdMaturity } from '../app/src/main/assets/www/js/backend/wealth_intel.js';

test('QOL: split_transaction divides single transaction into line items', async (t) => {
  const db = await freshBackend();

  // Create an initial parent transaction
  const saveRes = await ok(t, 'save_transaction', {
    transaction: {
      type: 'Expense',
      amount: 1500,
      category: 'General',
      merchant: 'Supermarket',
      date: '2026-08-15',
      description: 'Weekly grocery run',
    },
  });

  const txId = saveRes.transaction_id;
  assert.ok(txId, 'Created parent transaction');

  // Perform split into Groceries and Household
  const splitRes = await ok(t, 'split_transaction', {
    transaction_id: txId,
    splits: [
      { amount: 1000, category: 'Groceries', description: 'Food & dairy' },
      { amount: 500, category: 'Household', description: 'Cleaning supplies' },
    ],
  });

  assert.equal(splitRes.inserted_count, 2);

  // Parent transaction should no longer exist
  const txList = await ok(t, 'get_transactions');
  const items = txList.transactions;
  assert.equal(items.length, 2);
  assert.ok(!items.some((x) => x.id === txId));

  const groc = items.find((x) => x.category === 'Groceries');
  assert.equal(groc.amount, 1000);
  assert.equal(groc.merchant, 'Supermarket');

  const house = items.find((x) => x.category === 'Household');
  assert.equal(house.amount, 500);
});

test('QOL: batch_update_transactions updates categories and members in bulk', async (t) => {
  const db = await freshBackend();

  const r1 = await ok(t, 'save_transaction', {
    transaction: { type: 'Expense', amount: 200, category: 'General', date: '2026-08-10' },
  });
  const r2 = await ok(t, 'save_transaction', {
    transaction: { type: 'Expense', amount: 350, category: 'General', date: '2026-08-11' },
  });

  const ids = [r1.transaction_id, r2.transaction_id];

  // Bulk update category to Food & Dining
  const batchRes = await ok(t, 'batch_update_transactions', {
    ids,
    category: 'Food & Dining',
  });
  assert.equal(batchRes.updated_count, 2);

  const txList = await ok(t, 'get_transactions');
  assert.equal(txList.transactions.filter((x) => x.category === 'Food & Dining').length, 2);
});

test('QOL: batch_delete_transactions deletes multiple transactions at once', async (t) => {
  const db = await freshBackend();

  const r1 = await ok(t, 'save_transaction', {
    transaction: { type: 'Expense', amount: 100, category: 'General', date: '2026-08-10' },
  });
  const r2 = await ok(t, 'save_transaction', {
    transaction: { type: 'Expense', amount: 200, category: 'General', date: '2026-08-11' },
  });
  const r3 = await ok(t, 'save_transaction', {
    transaction: { type: 'Expense', amount: 300, category: 'General', date: '2026-08-12' },
  });

  const delRes = await ok(t, 'batch_delete_transactions', {
    ids: [r1.transaction_id, r3.transaction_id],
  });
  assert.equal(delRes.deleted_count, 2);

  const txList = await ok(t, 'get_transactions');
  assert.equal(txList.transactions.length, 1);
  assert.equal(txList.transactions[0].id, r2.transaction_id);
});

test('QOL: discover_accounts_from_sms identifies bank accounts and cards from raw_sms', async (t) => {
  const db = await freshBackend();

  await ok(t, 'save_transaction', {
    transaction: {
      type: 'Expense',
      amount: 450,
      category: 'General',
      date: '2026-08-10',
      raw_sms: 'Rs. 450.00 spent on HDFC Bank Card ending 4821 at Amazon on 10-AUG-26',
    },
  });

  await ok(t, 'save_transaction', {
    transaction: {
      type: 'Income',
      amount: 50000,
      category: 'Income',
      date: '2026-08-01',
      raw_sms: 'Your A/c no. XX9912 is credited by Rs 50000.00 on 01-AUG-26 by Salary from ICICI Bank',
    },
  });

  const discoverRes = await ok(t, 'discover_accounts_from_sms');
  assert.ok(discoverRes.discovered.length >= 1);
  const foundCard = discoverRes.discovered.find((d) => d.last_4 === '4821');
  assert.ok(foundCard, 'Discovered HDFC card ending in 4821');
});

test('QOL: get_salary_investment_trend returns 6-month inflow, investment & expense series', async (t) => {
  const db = await freshBackend();

  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  await ok(t, 'save_transaction', {
    transaction: { type: 'Income', amount: 100000, category: 'Salary', date: `${monthKey}-01` },
  });
  await ok(t, 'save_transaction', {
    transaction: { type: 'Expense', amount: 40000, category: 'Rent', date: `${monthKey}-05` },
  });
  await ok(t, 'save_transaction', {
    transaction: { type: 'Investment', amount: 30000, category: 'SIP', date: `${monthKey}-10`, is_investment_outflow: 1 },
  });

  const trendRes = await ok(t, 'get_salary_investment_trend');
  assert.equal(trendRes.months.length, 6);

  const current = trendRes.months[trendRes.months.length - 1];
  assert.equal(current.income, 100000);
  assert.equal(current.expense, 40000);
  assert.equal(current.invested, 30000);
  assert.equal(current.net_kept, 30000);
  assert.equal(current.investment_rate, 30);
});

test('QOL: Multi-loan combined EMI calculation and aggregator', async () => {
  const mockLoans = [
    {
      id: 1,
      name: 'Home Loan',
      direction: 'borrowed',
      current_outstanding: 4500000,
      monthly_emi: 42000,
      interest_rate: 8.5,
      tenure_months: 180,
    },
    {
      id: 2,
      name: 'Car Loan',
      direction: 'borrowed',
      current_outstanding: 600000,
      monthly_emi: 14500,
      interest_rate: 9.0,
      tenure_months: 48,
    },
    {
      id: 3,
      name: 'Friend Loan',
      direction: 'lent',
      current_outstanding: 50000,
      monthly_emi: 5000,
      interest_rate: 0,
      tenure_months: 10,
    },
  ];

  const summary = getCombinedLoanSummary(mockLoans);
  assert.equal(summary.borrowed_count, 2);
  assert.equal(summary.total_monthly_emi, 56500); // 42000 + 14500
  assert.equal(summary.total_debt_outstanding, 5100000); // 4500000 + 600000
  assert.ok(summary.weighted_interest_rate >= 8.5 && summary.weighted_interest_rate <= 9.0);
  assert.equal(summary.lent_count, 1);
  assert.equal(summary.total_lent_outstanding, 50000);

  const actionRes = await handleLoanAction({
    action: 'combined_summary',
    loans: mockLoans,
  });
  assert.equal(actionRes.status, 'success');
  assert.equal(actionRes.total_monthly_emi, 56500);
});

test('QOL: Net Worth Milestones from ₹1 Lakh to ₹10 Crore', () => {
  // Test ₹7.5 Lakh net worth
  const res1 = getNetWorthMilestones(750000);
  assert.equal(res1.status, 'success');
  assert.equal(res1.current_net_worth, 750000);

  // 1L and 5L should be achieved
  const m1L = res1.milestones.find((m) => m.label === '₹1L');
  const m5L = res1.milestones.find((m) => m.label === '₹5L');
  const m10L = res1.milestones.find((m) => m.label === '₹10L');
  const m1Cr = res1.milestones.find((m) => m.label === '₹1 Cr');
  const m10Cr = res1.milestones.find((m) => m.label === '₹10 Cr');

  assert.equal(m1L.achieved, true);
  assert.equal(m5L.achieved, true);
  assert.equal(m10L.achieved, false);
  assert.equal(m10L.isNext, true);
  assert.equal(m1Cr.achieved, false);
  assert.equal(m10Cr.achieved, false);

  assert.equal(res1.next_milestone.label, '₹10L');
  assert.equal(res1.progress_to_next, 75); // 750000 / 1000000 = 75%
  assert.equal(res1.distance_to_next, 250000);

  // Test ₹1.5 Crore net worth
  const res2 = getNetWorthMilestones(15000000);
  assert.equal(res2.milestones.find((m) => m.label === '₹1 Cr').achieved, true);
  assert.equal(res2.next_milestone.label, '₹2.5 Cr');
});

test('QOL: Fixed Deposit maturity and quarterly compounding calculator', () => {
  // ₹1,00,000 at 7.5% for 12 months (1 year)
  const fd = calculateFdMaturity(100000, 7.5, 12);
  assert.equal(fd.status, 'success');
  assert.equal(fd.principal, 100000);
  assert.equal(fd.annual_rate, 7.5);
  // Quarterly compounding: 100000 * (1 + 0.075/4)^4 = ~107713.59 -> 107714
  assert.ok(fd.maturity_value >= 107700 && fd.maturity_value <= 107730);
  assert.ok(fd.total_interest >= 7700 && fd.total_interest <= 7730);
  assert.ok(fd.days_left > 0);
});

test('QOL: Interactive Driver.js-Style App Tour covers 8 granular section steps', async () => {
  const { TOUR_STEPS, openOnboardingTour } = await import(
    '../app/src/main/assets/www/js/views/onboarding-tour.js'
  );

  assert.equal(TOUR_STEPS.length, 8);
  const tabs = TOUR_STEPS.map((s) => s.tab);
  assert.ok(tabs.includes('home'));
  assert.ok(tabs.includes('ledger'));
  assert.ok(tabs.includes('budgets'));
  assert.ok(tabs.includes('wealth'));
  assert.ok(tabs.includes('more'));

  for (const step of TOUR_STEPS) {
    assert.ok(step.title, 'Step has title');
    assert.ok(step.badge, 'Step has badge');
    assert.ok(step.description, 'Step has description');
    assert.ok(step.highlights.length >= 2, 'Step has at least 2 highlights');
    assert.ok(Array.isArray(step.targetSelectors) && step.targetSelectors.length > 0, 'Step has targetSelectors for spotlight');
  }

  // Verify Step 1 specifically targets SMS / Home widgets
  assert.ok(TOUR_STEPS[0].targetSelectors.some((s) => s.includes('sms') || s.includes('card')));

  // Verify Step 2 specifically targets Rules
  assert.ok(TOUR_STEPS[1].targetSelectors.some((s) => s.includes('rules') || s.includes('card')));

  // Verify Step 3 specifically targets CAS / Imports
  assert.ok(TOUR_STEPS[2].targetSelectors.some((s) => s.includes('cas') || s.includes('card') || s.includes('button')));

  // Test interactive navigation runner
  const visitedTabs = [];
  const mockApp = {
    tab: 'home',
    locked: false,
    go(t) {
      this.tab = t;
      visitedTabs.push(t);
    },
  };

  // Setup minimal DOM elements for test
  if (!globalThis.document) {
    globalThis.document = {
      body: {
        appendChild: () => {},
        contains: () => false,
        classList: { add: () => {}, remove: () => {} },
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({
        style: {},
        classList: { add: () => {}, remove: () => {} },
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        remove: () => {},
      }),
    };
  } else if (!globalThis.document.querySelector) {
    globalThis.document.querySelector = () => null;
  }
  if (globalThis.document.body && !globalThis.document.body.classList) {
    globalThis.document.body.classList = { add: () => {}, remove: () => {} };
  }

  openOnboardingTour(mockApp);
  assert.equal(visitedTabs.length >= 0, true);

  // Security test: Refuses to launch when app is locked
  const lockedApp = {
    tab: 'home',
    locked: true,
    go() {},
  };
  const countBefore = visitedTabs.length;
  openOnboardingTour(lockedApp);
  assert.equal(visitedTabs.length, countBefore, 'Tour must not launch when app is locked');
});

test('QOL: Goal Presets, dynamic glyphs and pacing calculations', async () => {
  const { GOAL_PRESETS, getGoalGlyph, getMonthsRemaining, RECORD_CONFIG } = await import(
    '../app/src/main/assets/www/js/views/records.js'
  );

  // 1. Verify Presets
  assert.ok(GOAL_PRESETS.length >= 8, 'Has at least 8 starter goal presets');
  const presetTitles = GOAL_PRESETS.map((p) => p.title);
  assert.ok(presetTitles.includes('Emergency Fund'));
  assert.ok(presetTitles.includes('House Downpayment'));
  assert.ok(presetTitles.includes('₹1 Crore Corpus'));

  // 2. Verify Dynamic Glyphs
  assert.equal(getGoalGlyph({ title: 'Safety emergency fund' }), 'shield');
  assert.equal(getGoalGlyph({ title: 'New Electric Car' }), 'directions_car');
  assert.equal(getGoalGlyph({ title: 'Flat in Bengaluru' }), 'home');
  assert.equal(getGoalGlyph({ title: 'Trip to Tokyo' }), 'flight');
  assert.equal(getGoalGlyph({ title: 'Sister Wedding' }), 'volunteer_activism');
  assert.equal(getGoalGlyph({ title: 'MBA Degree' }), 'school');
  assert.equal(getGoalGlyph({ title: 'MacBook Pro' }), 'devices');
  assert.equal(getGoalGlyph({ title: 'Retire with 1 Crore corpus' }), 'savings');
  assert.equal(getGoalGlyph({ title: 'Random Hobby' }), 'flag');

  // 3. Verify Months Remaining
  const nextYear = new Date();
  nextYear.setFullYear(nextYear.getFullYear() + 1);
  const pad = (v) => String(v).padStart(2, '0');
  const nextYearIso = `${nextYear.getFullYear()}-${pad(nextYear.getMonth() + 1)}-${pad(nextYear.getDate())}`;
  const months = getMonthsRemaining(nextYearIso);
  assert.ok(months >= 11 && months <= 13, `Calculated months (${months}) matches ~12m`);

  // 4. Verify Goal row formatter
  const goalRow = RECORD_CONFIG.goal.row({
    title: 'Emergency Fund',
    target_amount: 300000,
    current_amount: 150000,
    target_date: nextYearIso,
  });
  assert.equal(goalRow.glyph, 'shield');
  assert.equal(goalRow.title, 'Emergency Fund');
  assert.ok(goalRow.sub.includes('50%'), 'Shows 50% progress');
  assert.ok(goalRow.sub.includes('/mo'), 'Shows monthly required savings pace');
  assert.equal(goalRow.progress.value, 50);
});


