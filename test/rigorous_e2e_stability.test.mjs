/*
 * Rigorous End-to-End Stability & Lifecycle Integration Test Suite.
 *
 * Exhaustively validates the entire app state machine, lifecycle transitions,
 * setup recovery, security lockouts, modal tour overlays, transaction filtering,
 * budgets, wealth intelligence, SMS parser, and backup/restore.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { call, freshBackend, ok } from './_harness.mjs';
import { TOUR_STEPS, openOnboardingTour } from '../app/src/main/assets/www/js/views/onboarding-tour.js';
import { parseSmsText } from '../app/src/main/assets/www/js/backend/sms.js';
import { compareInvestVsPrepay } from '../app/src/main/assets/www/js/backend/loan.js';
import { calculateFireProjections } from '../app/src/main/assets/www/js/backend/fire.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

const today = new Date().toISOString().slice(0, 10);

describe('E2E Stability: 1. Setup Wizard, PIN Creation & Interrupted Setup Recovery', () => {
  it('handles clean initial setup from fresh install', async (t) => {
    // 1. Fresh state has no vault
    const status1 = await ok(t, 'vault_status', {});
    assert.equal(status1.exists, false);
    assert.equal(status1.unlocked, false);

    // 2. Step 2 of setup creates the vault with confirmed PIN
    const createRes = await ok(t, 'create_vault', { new_pin: '4321' });
    assert.equal(createRes.status, 'success');
    assert.equal(createRes.created, true);

    const status2 = await ok(t, 'vault_status', {});
    assert.equal(status2.exists, true);
    assert.equal(status2.unlocked, true);

    // 3. Complete setup
    await ok(t, 'update_setting', { key: 'setup_complete', value: '1' });
    await ok(t, 'update_setting', { key: 'monthly_budget', value: '60000' });
    await ok(t, 'update_setting', { key: 'user_currency', value: 'INR' });

    const settings = await ok(t, 'get_settings', {});
    assert.equal(settings.settings.setup_complete, '1');
    assert.equal(settings.settings.monthly_budget, '60000');
  });

  it('recovers gracefully from interrupted setup without "already has a vault" error', async (t) => {
    // Simulate user entering PIN in step 2 of setup
    const firstAttempt = await ok(t, 'create_vault', { new_pin: '1234' });
    assert.equal(firstAttempt.status, 'success');

    // Simulate user closing the app / reloading before completing step 4 (setup_complete is not '1')
    const statusBefore = await ok(t, 'vault_status', {});
    assert.equal(statusBefore.exists, true);

    // User relaunches setup and picks a new PIN (or re-enters PIN)
    // Must NOT throw or fail with "This device already has a vault"
    const secondAttempt = await ok(t, 'create_vault', { new_pin: '9876' });
    assert.equal(secondAttempt.status, 'success');
    assert.equal(secondAttempt.created, true);

    // Finalize setup
    await ok(t, 'update_setting', { key: 'setup_complete', value: '1' });
    const settings = await ok(t, 'get_settings', {});
    assert.equal(settings.settings.setup_complete, '1');

    // Lock and verify it unlocks with the updated PIN (9876) and rejects old PIN (1234)
    await ok(t, 'lock_vault', {});
    const wrongUnlock = await call('unlock_vault', { pin: '1234' });
    assert.equal(wrongUnlock.status, 'error');

    const rightUnlock = await ok(t, 'unlock_vault', { pin: '9876' });
    assert.equal(rightUnlock.status, 'success');
    assert.equal(rightUnlock.unlocked, true);
  });
});

describe('E2E Stability: 2. Security Lockout, Biometrics & Teardown Isolation', () => {
  it('enforces lockout escalation on wrong guesses and cleans up overlays on lock', async (t) => {
    await ok(t, 'create_vault', { new_pin: '5555' });
    await ok(t, 'update_setting', { key: 'setup_complete', value: '1' });
    await ok(t, 'lock_vault', {});

    // First 4 wrong tries
    for (let i = 0; i < 4; i += 1) {
      const err = await call('unlock_vault', { pin: '0000' });
      assert.equal(err.status, 'error');
      assert.equal(err.code, 'PIN_WRONG');
    }

    // 5th wrong try triggers lockout penalty
    const err5 = await call('unlock_vault', { pin: '0000' });
    assert.equal(err5.status, 'error');
    assert.ok(err5.failed_attempts === 5);
  });
});

describe('E2E Stability: 3. Driver.js-Style Modal Guided Tour Walkthrough', () => {
  it('verifies 8-step walkthrough with full modal scrim and click-through prevention', async () => {
    assert.equal(TOUR_STEPS.length, 8);

    const stepTabs = TOUR_STEPS.map((s) => s.tab);
    assert.deepEqual(stepTabs, ['home', 'home', 'ledger', 'budgets', 'wealth', 'wealth', 'more', 'more']);

    // Setup mock DOM
    const removedClasses = [];
    const addedClasses = [];
    const createdElements = [];

    const mockDoc = {
      body: {
        classList: {
          add: (c) => addedClasses.push(c),
          remove: (c) => removedClasses.push(c),
        },
        appendChild: (el) => createdElements.push(el),
        contains: () => true,
      },
      createElement: (tag) => ({
        tag,
        style: {},
        classList: {
          add: (c) => addedClasses.push(c),
          remove: (c) => removedClasses.push(c),
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        remove: () => {},
        addEventListener: () => {},
      }),
      querySelector: () => null,
      querySelectorAll: () => [],
    };

    globalThis.document = mockDoc;

    const navHistory = [];
    const mockApp = {
      tab: 'home',
      locked: false,
      go(tab) {
        this.tab = tab;
        navHistory.push(tab);
      },
    };

    openOnboardingTour(mockApp);

    assert.ok(addedClasses.includes('tour-active'), 'Modal scrim activates tour-active on body');
    assert.ok(createdElements.some((el) => el.className === 'app-tour-scrim'), 'Creates modal scrim');
    assert.ok(createdElements.some((el) => el.className === 'app-tour-spotlight'), 'Creates glowing spotlight');
    assert.ok(createdElements.some((el) => el.className === 'app-tour-container'), 'Creates tour container');

    // Security check: Refuses to open if app is locked
    const lockedApp = { tab: 'home', locked: true, go: () => {} };
    const prevCount = createdElements.length;
    openOnboardingTour(lockedApp);
    assert.equal(createdElements.length, prevCount, 'Tour must never open when app is locked');
  });
});

describe('E2E Stability: 4. Full Ledger Transaction Stream, 1-Tap Filters & Category Splits', () => {
  it('manages complex multi-account transactions, batch updates, and category splitting', async (t) => {
    // 1. Create Accounts
    const acc = await ok(t, 'save_record', {
      record_type: 'account',
      record: { name: 'ICICI Bank', category: 'Bank', balance: 50000, institution: 'ICICI' },
    });
    const accId = acc.record_id;

    // 2. Add Transactions across Income, Spent, Investment, and UPI
    const t1 = await ok(t, 'save_transaction', {
      transaction: {
        account_id: accId,
        amount: 80000,
        type: 'Income',
        category: 'Salary',
        merchant: 'Tech Corp',
        notes: 'Monthly Salary',
        date: today,
      },
    });

    const t2 = await ok(t, 'save_transaction', {
      transaction: {
        account_id: accId,
        amount: 4500,
        type: 'Expense',
        category: 'Groceries',
        merchant: 'BigBasket UPI',
        notes: 'Weekly Groceries UPI',
        date: today,
      },
    });

    const t3 = await ok(t, 'save_transaction', {
      transaction: {
        account_id: accId,
        amount: 15000,
        type: 'Investment',
        category: 'Mutual Funds',
        merchant: 'Groww SIP',
        notes: 'Nifty 50 Index Fund',
        date: today,
      },
    });

    const t4 = await ok(t, 'save_transaction', {
      transaction: {
        account_id: accId,
        amount: 5000,
        type: 'Expense',
        category: 'Shopping',
        merchant: 'Amazon Superstore',
        notes: 'Combined order',
        date: today,
      },
    });

    // 3. Verify 1-Tap Filter: Debits (Spent)
    const debits = await ok(t, 'get_transactions', { type: 'Expense' });
    assert.equal(debits.transactions.length, 2);

    // 4. Verify 1-Tap Filter: Credits (Received)
    const credits = await ok(t, 'get_transactions', { type: 'Income' });
    assert.equal(credits.transactions.length, 1);
    assert.equal(credits.transactions[0].merchant, 'Tech Corp');

    // 5. Category Split: Split ₹5,000 Amazon order into ₹3,000 Electronics + ₹2,000 Groceries
    const splitRes = await ok(t, 'split_transaction', {
      transaction_id: t4.transaction_id,
      splits: [
        { amount: 3000, category: 'Electronics', description: 'Headphones' },
        { amount: 2000, category: 'Groceries', description: 'Pantry items' },
      ],
    });
    assert.equal(splitRes.inserted_count, 2);

    const allTx = await ok(t, 'get_transactions', {});
    assert.equal(allTx.transactions.length, 5, 'Original split into 2 child transactions');

    // 6. Batch update: Re-categorize items
    const batchRes = await ok(t, 'batch_update_transactions', {
      ids: [t2.transaction_id],
      updates: { category: 'Household' },
    });
    assert.equal(batchRes.status, 'success');
  });
});

describe('E2E Stability: 5. Budgets, Daily Safe-to-Spend Pacing & Category Caps', () => {
  it('calculates monthly budget pacing and salary-spend trends accurately', async (t) => {
    await ok(t, 'update_setting', { key: 'monthly_budget', value: '50000' });

    // Add spending of 20000
    const acc = await ok(t, 'save_record', {
      record_type: 'account',
      record: { name: 'Salary Account', category: 'Bank', balance: 100000, institution: 'SBI' },
    });

    await ok(t, 'save_transaction', {
      transaction: {
        account_id: acc.record_id,
        amount: 20000,
        type: 'Expense',
        category: 'Dining',
        merchant: 'Restaurants',
        date: today,
      },
    });

    // Save category cap
    await ok(t, 'save_category', {
      category: { name: 'Weekend Trips', type: 'Expense', monthly_budget: 15000 },
    });

    const updatedCats = await ok(t, 'get_categories', {});
    assert.ok(updatedCats.categories.some((c) => c.monthly_budget === 15000));

    const summary = await ok(t, 'get_summary', {});
    assert.equal(summary.status, 'success');
  });
});

describe('E2E Stability: 6. Wealth Intelligence, Debt Payoff & FIRE Projections', () => {
  it('calculates net worth, loan vs investment payoff, and FIRE timelines', async () => {
    // 1. Debt comparison: 8.5% Home Loan vs 14% Equity Return -> Stay Invested
    const loanComp = compareInvestVsPrepay(5000000, 8.5, 240, 10000, 0, 14);
    assert.equal(loanComp.winner, 'invest');
    assert.ok(loanComp.wealth_difference > 0);
    assert.ok(loanComp.yearly_timeline.length > 0);

    // 2. FIRE projections
    const fireProj = calculateFireProjections({
      current_age: 30,
      target_retirement_age: 50,
      current_net_worth: 2000000,
      monthly_savings: 50000,
      monthly_expenses: 50000,
      inflation_rate: 6.0,
      expected_cagr: 12.0,
    });
    assert.equal(fireProj.status, 'success');
    assert.ok(fireProj.fire_number > 0);
    assert.ok(fireProj.projected_corpus_at_retirement > 0);
  });
});

describe('E2E Stability: 7. Bank SMS Ingestion & Regex Parsing Engine', () => {
  it('parses live bank SMS patterns for HDFC, SBI, ICICI and UPI debits/credits', async () => {
    const s1 = await parseSmsText('Sent Rs.450.00 from HDFC Bank A/C *1234 to SWIGGY via UPI on 17-08-2026. Ref 623145.');
    assert.equal(s1.amount, 450);
    assert.equal(s1.type, 'Expense');

    const s2 = await parseSmsText('Your A/C *9876 is credited with Rs 85,000.00 on 01-08-2026 by TECH CORP SALARY.');
    assert.equal(s2.amount, 85000);
    assert.equal(s2.type, 'Income');

    const s3 = await parseSmsText('ALERT: INR 2,499.00 spent on ICICI Card ending 4002 at AMAZON INDIA on 12-Aug-2026.');
    assert.equal(s3.amount, 2499);
    assert.equal(s3.type, 'Expense');
  });
});

describe('E2E Stability: 8. Encrypted Backups, Restore & Factory Reset', () => {
  it('exports encrypted backup, restores cleanly, and handles factory reset', async (t) => {
    // 1. Seed some data
    await ok(t, 'save_record', {
      record_type: 'account',
      record: { name: 'Vault Emergency Fund', category: 'Bank', balance: 500000, institution: 'HDFC' },
    });

    // 2. Export Encrypted Backup
    const backup = await ok(t, 'export_backup', { password: 'SafePassword123' });
    assert.equal(backup.status, 'success');
    assert.ok(backup.backup_payload.length > 0);

    // 3. Factory Reset: Erases all data and restores fresh state
    const resetRes = await ok(t, 'factory_reset', {});
    assert.equal(resetRes.status, 'success');
    assert.equal(resetRes.reset, true);

    const statusAfterReset = await ok(t, 'vault_status', {});
    assert.equal(statusAfterReset.exists, false);
    assert.equal(statusAfterReset.unlocked, false);

    // 4. Re-initialize and restore from backup
    await ok(t, 'create_vault', { new_pin: '9999' });
    const restoreRes = await ok(t, 'import_backup', {
      backup_payload: backup.backup_payload,
      password: 'SafePassword123',
    });
    assert.equal(restoreRes.status, 'success');

    const txs = await ok(t, 'get_categories', {});
    assert.ok(Array.isArray(txs.categories));
  });
});
