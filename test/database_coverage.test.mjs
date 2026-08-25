import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, ok, monthsAgo } from './_harness.mjs';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('database.js comprehensive CRUD and edge coverage', () => {
  it('covers all custom category management actions', async () => {
    // Add category
    const addRes = await ok(null, 'save_category', {
      category: { name: 'Gym & Fitness', type: 'Expense', color: '#10B981', icon: 'fitness_center' },
    });
    assert.equal(addRes.status, 'success');

    // Duplicate verification
    const catList = await ok(null, 'get_categories');
    assert.ok(catList.categories.some((c) => c.name === 'Gym & Fitness'));

    // Update category
    const updateRes = await ok(null, 'save_category', {
      original_name: 'Gym & Fitness',
      category: { name: 'Fitness & Sports', type: 'Expense', color: '#059669', icon: 'sports' },
    });
    assert.equal(updateRes.status, 'success');

    // Delete category
    const delRes = await ok(null, 'delete_category', { name: 'Fitness & Sports' });
    assert.equal(delRes.status, 'success');
  });

  it('covers all record types CRUD (account, sip, loan, card, subscription, goal)', async () => {
    const types = ['account', 'sip', 'loan', 'card', 'subscription', 'goal'];

    for (const record_type of types) {
      const getInitial = await ok(null, 'list_records', { record_type });
      assert.equal(getInitial.status, 'success');
      assert.ok(Array.isArray(getInitial.records));
    }

    // Save and update account
    const acc = await ok(null, 'save_record', {
      record_type: 'account',
      record: { name: 'SBI Savings', category: 'Bank', balance: 50000, institution: 'SBI' },
    });
    assert.ok(acc.record_id);

    const accUpdate = await ok(null, 'save_record', {
      record_type: 'account',
      record_id: acc.record_id,
      record: { id: acc.record_id, name: 'SBI Main Savings', category: 'Bank', balance: 60000, institution: 'SBI' },
    });
    assert.equal(accUpdate.record_id, acc.record_id);

    // Save and update card
    const card = await ok(null, 'save_record', {
      record_type: 'card',
      record: { card_name: 'Infinia', bank: 'HDFC', last_4: '1234', total_limit: 500000, current_balance: 45000 },
    });
    assert.ok(card.record_id);

    // Save and update goal
    const goal = await ok(null, 'save_record', {
      record_type: 'goal',
      record: { title: 'Emergency Fund', target_amount: 300000, current_amount: 150000, target_date: '2027-12-31' },
    });
    assert.ok(goal.record_id);

    // Delete records
    assert.equal((await ok(null, 'delete_record', { record_type: 'account', record_id: acc.record_id })).status, 'success');
    assert.equal((await ok(null, 'delete_record', { record_type: 'card', record_id: card.record_id })).status, 'success');
    assert.equal((await ok(null, 'delete_record', { record_type: 'goal', record_id: goal.record_id })).status, 'success');
  });

  it('covers transaction splits and cashbacks', async () => {
    const today = monthsAgo(0);
    const tx = await ok(null, 'save_transaction', {
      transaction: {
        date: today,
        amount: 3000,
        category: 'Food & Dining',
        type: 'Expense',
        merchant: 'Dinner with friends',
        splits: [
          { person_name: 'Alice', share_amount: 1000, is_paid: 1 },
          { person_name: 'Bob', share_amount: 1000, is_paid: 0 },
        ],
        cashbacks: [
          { source_name: 'Cred', cashback_amount: 150 },
        ],
      },
    });
    assert.ok(tx.transaction_id);

    const detail = await ok(null, 'get_transactions', { limit: 10 });
    const saved = detail.transactions.find((t) => t.id === tx.transaction_id);
    assert.ok(saved);
    assert.equal(saved.splits.length, 2);
    assert.equal(saved.cashbacks.length, 1);
    // Net personal amount: 3000 - 150 (cashback) - 1000 (paid split) = 1850
    assert.equal(saved.net_personal_amount, 1850);

    // Delete transaction
    const delTx = await ok(null, 'delete_transaction', { id: tx.transaction_id });
    assert.equal(delTx.status, 'success');
  });

  it('covers family member management', async () => {
    const member = await ok(null, 'add_family_member', {
      member: { name: 'Partner', relationship: 'Spouse', avatar_color: '#3B82F6' },
    });
    assert.ok(member.member_id);

    const members = await ok(null, 'get_family_members');
    assert.ok(members.members.length >= 2);

    const delMember = await ok(null, 'delete_family_member', { member_id: member.member_id });
    assert.equal(delMember.status, 'success');
  });

  it('covers app settings updates and reads', async () => {
    await ok(null, 'update_setting', { key: 'currency', value: 'USD' });
    await ok(null, 'update_setting', { key: 'appearance', value: 'dark' });
    const settings = await ok(null, 'get_settings');
    assert.equal(settings.settings.currency, 'USD');
    assert.equal(settings.settings.appearance, 'dark');
  });

  it('covers holding listings, price changes and commitment projections', async () => {
    // List holdings & investments
    const folios = await ok(null, 'list_folios');
    assert.equal(folios.status, 'success');
    assert.ok(Array.isArray(folios.folios));

    const demat = await ok(null, 'list_demat_holdings');
    assert.equal(demat.status, 'success');
    assert.ok(Array.isArray(demat.holdings));

    const nps = await ok(null, 'list_nps_holdings');
    assert.equal(nps.status, 'success');

    const inv = await ok(null, 'list_investments');
    assert.equal(inv.status, 'success');

    // Save SIP record to test commitment projections and price history
    const sip = await ok(null, 'save_record', {
      record_type: 'sip',
      record: {
        scheme_name: 'Nifty Index Fund',
        monthly_amount: 10000,
        debit_day: 5,
        is_active: 1,
      },
    });

    const priceHist = await ok(null, 'get_price_history', {
      kind: 'sip',
      record_id: sip.record_id,
    });
    assert.equal(priceHist.status, 'success');

    const proj = await ok(null, 'project_commitments', { months_ahead: 6 });
    assert.equal(proj.status, 'success');
  });

  it('covers backup export, import and clear data', async () => {
    const backup = await ok(null, 'export_backup', { password: 'BackupPassword123' });
    assert.equal(backup.status, 'success');
    assert.ok(backup.backup_payload);

    const imported = await ok(null, 'import_backup', {
      backup_payload: backup.backup_payload,
      password: 'BackupPassword123',
    });
    assert.equal(imported.status, 'success');

    const cleared = await ok(null, 'clear_data', { kinds: ['goals', 'budgets', 'events'] });
    assert.equal(cleared.status, 'success');
  });

  it('verifies expanded default categories and Transport & Fuel migration', async () => {
    const res = await ok(null, 'get_categories');
    assert.equal(res.status, 'success');
    const names = res.categories.map((c) => c.name);

    // Verify presence of new categories
    const expected = [
      'Groceries', 'Dining', 'Shopping', 'Transport', 'Fuel',
      'Medical', 'Health', 'School', 'Education', 'Kids & Baby',
      'Pets', 'Fitness', 'Entertainment', 'Subscriptions', 'Utilities',
      'Rent & Housing', 'Maintenance & Repairs', 'Personal Care', 'Travel',
      'Gifts & Donations', 'Insurance & Tax', 'Loans & EMI', 'Investment Outflow',
      'Salary', 'Freelance', 'Business Income', 'Rental Income',
      'Interest & Dividends', 'Refunds & Cashback', 'Gifts Received', 'Other Income',
      'Transfer', 'Credit Card',
    ];

    for (const name of expected) {
      assert.ok(names.includes(name), `Missing default category: ${name}`);
    }

    // Verify Transport is present and Transport & Fuel is migrated
    assert.ok(names.includes('Transport'));
    assert.ok(names.includes('Fuel'));
    assert.ok(names.includes('Medical'));
    assert.ok(names.includes('School'));
    assert.ok(names.includes('Subscriptions'));

    const ccCat = res.categories.find((c) => c.name === 'Credit Card');
    assert.equal(ccCat.color, '#F59E0B');
  });
});
