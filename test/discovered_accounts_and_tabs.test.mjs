import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, call } from './_harness.mjs';

describe('Discovered Accounts Linking, 2-Way Debit Card Association & Ignored Accounts', () => {
  let db;

  beforeEach(async () => {
    db = await freshBackend();
  });

  it('links a discovered debit card to an existing bank account and updates transactions', async () => {
    // 1. Create a bank account
    const accId = db.run(
      "INSERT INTO asset_accounts (member_id, name, category, institution, balance) VALUES (1, 'HDFC Salary A/c', 'Bank', 'HDFC Bank', 75000)",
    ).lastInsertRowid;

    // 2. Insert transactions with raw_sms containing debit card digits 7890
    const rawText = 'Rs 1,200.00 spent on HDFC Bank Debit Card ending 7890 at Swiggy on 10-Feb-2026';
    const txId = db.run(
      "INSERT INTO transactions (member_id, date, amount, currency, type, category, raw_sms, account_id)"
      + " VALUES (1, '2026-02-10', 1200, 'INR', 'Expense', 'Dining', ?, NULL)",
      [rawText],
    ).lastInsertRowid;

    // 3. Call combine_discovered_account to link Debit Card 7890 to the bank account
    const combineRes = await call('combine_discovered_account', {
      target_id: accId,
      target_type: 'account',
      last_4: '7890',
      bank: 'HDFC Bank',
      is_debit_card: true,
    });
    assert.equal(combineRes.status, 'success');

    // 4. Verify asset_accounts updated
    const updatedAcc = db.get('SELECT debit_card_last_4 FROM asset_accounts WHERE id = ?', [accId]);
    assert.equal(updatedAcc.debit_card_last_4, '7890');

    // 5. Verify transaction updated with account_id
    const updatedTx = db.get('SELECT account_id FROM transactions WHERE id = ?', [txId]);
    assert.equal(updatedTx.account_id, accId);

    // 6. Verify discovered accounts no longer lists 7890 because it is linked
    const discRes = await call('discover_accounts_from_sms');
    const has7890 = (discRes.discovered || []).some((d) => d.last_4 === '7890');
    assert.equal(has7890, false, 'Linked debit card should not appear in discovered accounts');
  });

  it('allows ignoring/discarding a discovered account or card so it disappears from discovery', async () => {
    // 1. Insert transaction with unknown card 9999
    db.run(
      "INSERT INTO transactions (member_id, date, amount, currency, type, category, raw_sms)"
      + " VALUES (1, '2026-02-12', 300, 'INR', 'Expense', 'Shopping', 'Alert: INR 300.00 spent on ICICI Bank Card ending 9999 at Store')",
    );

    // Verify it is discovered
    let discRes = await call('discover_accounts_from_sms');
    let has9999 = (discRes.discovered || []).some((d) => d.last_4 === '9999');
    assert.equal(has9999, true, 'ICICI card 9999 should be discovered');

    // 2. Ignore this discovered card
    const ignoreRes = await call('ignore_discovered_account', {
      issuer: 'ICICI Bank',
      last_4: '9999',
      instrument_type: 'credit_card',
    });
    assert.equal(ignoreRes.status, 'success');

    // 3. Verify it is no longer discovered
    discRes = await call('discover_accounts_from_sms');
    has9999 = (discRes.discovered || []).some((d) => d.last_4 === '9999');
    assert.equal(has9999, false, 'Ignored card 9999 must not appear in discovered accounts');

    // 4. Verify get_ignored_discovered_accounts lists it
    const ignoredList = await call('get_ignored_discovered_accounts');
    assert.ok(ignoredList.ignored.some((r) => r.last_4 === '9999'));

    // 5. Restore it
    const restoreRes = await call('restore_discovered_account', {
      issuer: 'ICICI Bank',
      last_4: '9999',
    });
    assert.equal(restoreRes.status, 'success');

    // 6. Verify it is discovered again
    discRes = await call('discover_accounts_from_sms');
    has9999 = (discRes.discovered || []).some((d) => d.last_4 === '9999');
    assert.equal(has9999, true, 'Restored card 9999 should appear again in discovered accounts');
  });

  it('supports combining a discovered card with an existing credit card', async () => {
    // 1. Create a credit card record
    const cardId = db.run(
      "INSERT INTO credit_cards (member_id, card_name, bank, last_4, total_limit, current_balance) VALUES (1, 'SBI Prime', 'SBI', '1111', 100000, 15000)",
    ).lastInsertRowid;

    // 2. Combine discovered card
    const combineRes = await call('combine_discovered_account', {
      target_id: cardId,
      target_type: 'card',
      last_4: '1111',
      bank: 'SBI',
    });
    assert.equal(combineRes.status, 'success');

    // 3. Verify it was recorded in ignored_discovered_accounts
    const ignored = db.get('SELECT * FROM ignored_discovered_accounts WHERE last_4 = ?', ['1111']);
    assert.ok(ignored, 'Combined card should be in ignored_discovered_accounts');
  });

  it('removes discovered accounts when added via add_discovered_accounts or save_record', async () => {
    // 1. Insert SMS with Axis debit card 4444 and HDFC Credit Card 5555
    db.run(
      "INSERT INTO transactions (member_id, date, amount, currency, type, category, raw_sms)"
      + " VALUES (1, '2026-02-14', 1500, 'INR', 'Expense', 'Dining', 'Spent INR 1,500 on Axis Bank Debit Card ending 4444')",
    );
    db.run(
      "INSERT INTO transactions (member_id, date, amount, currency, type, category, raw_sms)"
      + " VALUES (1, '2026-02-14', 4200, 'INR', 'Expense', 'Shopping', 'Alert: INR 4,200 spent on HDFC Bank Credit Card ending 5555')",
    );

    let discRes = await call('discover_accounts_from_sms');
    assert.equal(discRes.discovered.length, 2);

    // 2. Add via add_discovered_accounts
    const addRes = await call('add_discovered_accounts', {
      accounts: discRes.discovered,
    });
    assert.equal(addRes.status, 'success');
    assert.equal(addRes.added, 2);

    // 3. Verify discover_accounts_from_sms is now empty
    discRes = await call('discover_accounts_from_sms');
    assert.equal(discRes.discovered.length, 0, 'Discovered accounts must be empty after adding');

    // 4. Verify asset_accounts and credit_cards were properly inserted
    const axisAcc = db.get('SELECT * FROM asset_accounts WHERE debit_card_last_4 = ?', ['4444']);
    assert.ok(axisAcc, 'Axis Debit Card must be created in asset_accounts');
    assert.equal(axisAcc.category, 'Bank');

    const hdfcCard = db.get('SELECT * FROM credit_cards WHERE last_4 = ?', ['5555']);
    assert.ok(hdfcCard, 'HDFC Credit Card must be created in credit_cards');
  });
});
