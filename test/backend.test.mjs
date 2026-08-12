/*
 * The backend tests.
 *
 *     ./scripts/dev test
 *
 * Every test gets its own database, held in memory, so nothing here touches a real
 * install. These are the same tests the Python layer had, ported alongside it: they were
 * the specification for the rewrite, and a behaviour that changed silently would have
 * shown up here first.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  call, cas, crypto, database, errors, fire, freshBackend, loan, monthsAgo, ok,
  persistingBackend, reminders, sms,
} from './_harness.mjs';

beforeEach(async () => {
  await freshBackend();
});

describe('saving', () => {
  /**
   * Every screen asks for several things at once. This is what broke on the device: the
   * saves were scheduled in a way that left all but the last caller waiting on a promise
   * nothing would ever settle, so the screen cleared itself and stopped there. No error,
   * because nothing threw.
   */
  it('settles every caller when several actions run at once', async () => {
    await persistingBackend();

    const replies = await Promise.all([
      call('get_summary'),
      call('get_transactions'),
      call('get_categories'),
      call('list_records', { record_type: 'account' }),
      call('get_series', { metric: 'income_expense', months: 6 }),
    ]);

    for (const reply of replies) assert.equal(reply.status, 'success');
  });

  /** Settles the save that creating the schema earns, so a test starts from rest. */
  async function settled() {
    const backend = await persistingBackend();
    await backend.db.flush();
    backend.writes.length = 0;
    return backend;
  }

  it('coalesces a burst of writes into one save', async () => {
    const { writes } = await settled();

    await Promise.all([
      call('save_transaction', { transaction: { amount: 1, category: 'Groceries', type: 'Expense' } }),
      call('save_transaction', { transaction: { amount: 2, category: 'Groceries', type: 'Expense' } }),
      call('save_transaction', { transaction: { amount: 3, category: 'Groceries', type: 'Expense' } }),
    ]);

    assert.equal(writes.length, 1, 'three writes at once should cost one save');
    assert.equal((await call('get_transactions')).transactions.length, 3);
  });

  it('does not rewrite the file for a read', async () => {
    const { writes } = await settled();

    await call('get_summary');
    await call('get_transactions');
    assert.equal(writes.length, 0, 'reading changes nothing, so nothing should be written');

    await call('save_transaction', {
      transaction: { amount: 1, category: 'Groceries', type: 'Expense' },
    });
    assert.equal(writes.length, 1);

    await call('get_summary');
    assert.equal(writes.length, 1, 'a read after a write should not save again');
  });

  it('brings a pending save forward when flushed', async () => {
    const { db, writes } = await settled();

    db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('theme', 'dark')");
    const pending = db.schedulePersist();

    await db.flush();
    assert.equal(writes.length, 1, 'flushing should not wait out the pause');
    // The caller that was already waiting is settled by the same save.
    await pending;
  });
});

describe('the household member a write belongs to', () => {
  /**
   * A household whose first member is not member number one.
   *
   * `family_members` is `AUTOINCREMENT`, which promises never to reuse an id, so once the
   * seeded member has been deleted the one that replaces it is numbered two. This is what
   * a real device looked like, and every write that assumed a one failed the foreign key
   * with nothing but a bare constraint error to show for it.
   *
   * Reached by emptying the table rather than by resetting the app, which no longer leads
   * here: a factory reset deletes the database file outright now, so what comes back is a
   * genuinely new database and its first member is numbered one again. The bug this guards
   * against is not about resetting, it is about assuming an id, and anybody who deletes a
   * profile and adds another still arrives exactly here.
   */
  async function afterAReset(t) {
    const db = database.currentDatabase();
    db.run('DELETE FROM family_members');
    // The next action reseeds, the way the app's next call does.
    database.initDb(db, true);
    const { members } = await ok(t, 'get_family_members');
    assert.equal(members.length, 1);
    assert.notEqual(members[0].id, 1, 'the reseeded member should not reuse the first id');
    return members[0].id;
  }

  it('files a transaction against whoever is actually there', async (t) => {
    const memberId = await afterAReset(t);

    await ok(t, 'save_transaction', {
      transaction: { amount: 250, category: 'Dining', type: 'Expense' },
    });

    const { transactions } = await ok(t, 'get_transactions');
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].member_id, memberId);
  });

  it('files a record against whoever is actually there', async (t) => {
    const memberId = await afterAReset(t);

    await ok(t, 'save_record', {
      record_type: 'account', record: { name: 'Bank', category: 'Bank', balance: 1000 },
    });

    const { records } = await ok(t, 'list_records', { record_type: 'account' });
    assert.equal(records[0].member_id, memberId);
  });

  it('ignores a member id that names nobody', async (t) => {
    const memberId = await afterAReset(t);

    await ok(t, 'save_transaction', {
      transaction: { amount: 100, category: 'Dining', type: 'Expense', member_id: 999 },
    });

    const { transactions } = await ok(t, 'get_transactions');
    assert.equal(transactions[0].member_id, memberId);
  });

  it('honours a member id that names somebody', async (t) => {
    await ok(t, 'update_setting', { key: 'family_features_enabled', value: '1' });
    const added = await ok(t, 'add_family_member', { member: { name: 'Someone else' } });

    await ok(t, 'save_transaction', {
      transaction: {
        amount: 100, category: 'Dining', type: 'Expense', member_id: added.member_id,
      },
    });

    const { transactions } = await ok(t, 'get_transactions');
    assert.equal(transactions[0].member_id, added.member_id);
  });

  it('makes the first person added the primary when there is nobody', async (t) => {
    database.currentDatabase().run('DELETE FROM family_members');
    const added = await ok(t, 'add_family_member', { member: { name: 'Only person' } });

    const { members } = await ok(t, 'get_family_members');
    assert.equal(members.length, 1);
    assert.equal(members[0].id, added.member_id);
    assert.equal(members[0].is_primary, 1);
  });

  it('records the currency in force rather than a constant', async (t) => {
    // The column exists so a historic entry keeps the currency it was made in. Writing a
    // literal into it would have made the column a lie.
    await ok(t, 'update_setting', { key: 'currency', value: 'SGD' });
    await ok(t, 'save_transaction', {
      transaction: { amount: 10, category: 'Dining', type: 'Expense' },
    });
    await ok(t, 'save_record', {
      record_type: 'account', record: { name: 'Bank', category: 'Bank', balance: 1 },
    });

    assert.equal((await ok(t, 'get_transactions')).transactions[0].currency, 'SGD');
    assert.equal(
      (await ok(t, 'list_records', { record_type: 'account' })).records[0].currency,
      'SGD',
    );

    // Changing it later leaves what is already recorded alone.
    await ok(t, 'update_setting', { key: 'currency', value: 'INR' });
    assert.equal((await ok(t, 'get_transactions')).transactions[0].currency, 'SGD');
  });

  it('creates the household member rather than failing a write without one', async (t) => {
    database.currentDatabase().run('DELETE FROM family_members');

    await ok(t, 'save_transaction', {
      transaction: { amount: 100, category: 'Dining', type: 'Expense' },
    });

    const { members } = await ok(t, 'get_family_members');
    assert.equal(members.length, 1);
    assert.equal((await ok(t, 'get_transactions')).transactions[0].member_id, members[0].id);
  });
});

describe('settings and the PIN', () => {
  it('seeds settings that can be read back', async (t) => {
    const { settings } = await ok(t, 'get_settings');
    assert.equal(settings.currency, 'INR');
    assert.equal(settings.setup_complete, '0');
  });

  it('never hands the PIN hash to the UI', async (t) => {
    await ok(t, 'set_pin', { new_pin: '4821' });
    const { settings } = await ok(t, 'get_settings');
    assert.ok(!('pin_hash' in settings));
    assert.ok(!('pin_code' in settings));
    assert.equal(settings.pin_is_set, '1');
  });

  it('verifies a PIN', async (t) => {
    await ok(t, 'set_pin', { new_pin: '4821' });
    assert.equal((await call('verify_pin', { pin: '4821' })).valid, true);
    assert.equal((await call('verify_pin', { pin: '0000' })).valid, false);
  });

  it('stores a PIN salted, so two hashes of one PIN differ', async () => {
    const first = await crypto.hashPin('4821');
    const second = await crypto.hashPin('4821');
    assert.notEqual(first, second);
    assert.equal(await crypto.pinMatches('4821', first), true);
    assert.equal(await crypto.pinMatches('9999', first), false);
  });

  it('locks a data key behind a PIN, and moves it without re-encrypting anything', async () => {
    /*
     * The PIN never encrypts the records. A random key does, and the PIN only encrypts
     * that key, so changing the PIN rewrites ninety bytes rather than the whole database.
     * A rewrite of the whole database is the one moment years of records could be lost.
     */
    const dataKey = crypto.newDataKey();
    assert.equal(dataKey.length, 32);

    const envelope = await crypto.wrapDataKey(dataKey, '4821');
    assert.deepEqual([...await crypto.unwrapDataKey(envelope, '4821')], [...dataKey]);

    // The envelope's own tag is what rejects a wrong PIN. There is nothing else to check.
    await assert.rejects(() => crypto.unwrapDataKey(envelope, '9999'));

    // Two envelopes of one key differ, so neither reveals that they hold the same thing.
    const second = await crypto.wrapDataKey(dataKey, '4821');
    assert.notEqual(envelope, second);

    // Changing the PIN keeps the key, so everything already encrypted still opens.
    const moved = await crypto.rewrapDataKey(envelope, '4821', '1234');
    assert.deepEqual([...await crypto.unwrapDataKey(moved, '1234')], [...dataKey]);
    await assert.rejects(() => crypto.unwrapDataKey(moved, '4821'), 'the old PIN stops working');

    // A failed change leaves the old envelope untouched rather than half written.
    await assert.rejects(() => crypto.rewrapDataKey(envelope, '0000', '1234'));
    assert.deepEqual([...await crypto.unwrapDataKey(envelope, '4821')], [...dataKey]);
  });

  it('requires the old PIN to change it', async (t) => {
    await ok(t, 'set_pin', { new_pin: '4821' });
    assert.equal((await call('set_pin', { new_pin: '1111', current_pin: '0000' })).status, 'error');
    assert.equal((await call('verify_pin', { pin: '4821' })).valid, true);
    await ok(t, 'set_pin', { new_pin: '1111', current_pin: '4821' });
    assert.equal((await call('verify_pin', { pin: '1111' })).valid, true);
  });

  it('refuses a PIN that is too short or not a number', async () => {
    assert.equal((await call('set_pin', { new_pin: '12' })).status, 'error');
    assert.equal((await call('set_pin', { new_pin: 'abcd' })).status, 'error');
  });

  it('locks the database file behind the PIN', async () => {
    const { vault } = await import('./_harness.mjs');
    localStorage.clear();

    assert.equal(vault.vaultExists(), false);
    await vault.createVault('4821');
    assert.equal(vault.vaultExists(), true);
    assert.equal(vault.isUnlocked(), true);

    const plain = new TextEncoder().encode('SQLite format 3 and some records');
    const sealed = await vault.seal(plain);
    assert.equal(vault.looksSealed(sealed), true);
    assert.equal(vault.looksSealed(plain), false, 'a plaintext database is recognised as one');
    // The records must not be sitting in the file for anyone who opens it.
    assert.equal(new TextDecoder().decode(sealed).includes('some records'), false);

    assert.deepEqual([...await vault.unseal(sealed)], [...plain]);
    // A file an earlier build wrote in the clear still opens, rather than bricking the app.
    assert.deepEqual([...await vault.unseal(plain)], [...plain]);

    vault.lockVault();
    assert.equal(vault.isUnlocked(), false);
    await assert.rejects(() => vault.seal(plain), 'a locked app cannot write');

    await assert.rejects(() => vault.unlockVault('9999'));
    await vault.unlockVault('4821');
    assert.deepEqual([...await vault.unseal(sealed)], [...plain]);
  });

  it('changes the PIN without touching what is already encrypted', async () => {
    const { vault } = await import('./_harness.mjs');
    localStorage.clear();
    await vault.createVault('4821');

    const plain = new TextEncoder().encode('records written under the old PIN');
    const sealed = await vault.seal(plain);

    await vault.changeVaultPin('4821', '1234');
    vault.lockVault();

    await assert.rejects(() => vault.unlockVault('4821'), 'the old PIN stops working');
    await vault.unlockVault('1234');
    // The key never changed, so everything written before the change still opens.
    assert.deepEqual([...await vault.unseal(sealed)], [...plain]);
  });

  it('makes each wrong PIN cost more, and does not trust the clock', async () => {
    const { vault } = await import('./_harness.mjs');
    localStorage.clear();
    await vault.createVault('4821');
    vault.lockVault();

    // Four free tries, because people mistype.
    for (let i = 0; i < 4; i += 1) await assert.rejects(() => vault.unlockVault('0000'));
    assert.equal(vault.lockoutRemaining(), 0);

    // The fifth starts costing.
    await assert.rejects(() => vault.unlockVault('0000'));
    const waiting = vault.lockoutRemaining();
    assert.ok(waiting > 0, 'a penalty is running');

    // The right PIN is refused while the penalty runs, so waiting is the only way through.
    await assert.rejects(() => vault.unlockVault('4821'));

    /*
     * Winding the clock back to escape the wait. The app writes down when it last looked,
     * so a clock that has gone backwards pushes the deadline back by as much, leaving the
     * wait exactly as long as it was.
     */
    const realNow = Date.now;
    Date.now = () => realNow() - 3600_000;
    try {
      assert.ok(vault.lockoutRemaining() > 0, 'moving the clock back did not open it');
    } finally {
      Date.now = realNow;
    }

    // The count only ever rises, so the next wrong guess still costs more than the last.
    assert.equal(vault.failedAttempts(), 5);
  });

  it('shuts the app for a week on the tenth wrong PIN', async () => {
    const { vault } = await import('./_harness.mjs');
    localStorage.clear();
    await vault.createVault('4821');
    vault.lockVault();

    /*
     * Ten wrong tries, ignoring the waits between them, which is what somebody with a
     * debugger and a clock would do. The count is what carries: it only rises, and only a
     * right PIN clears it, so the tenth is the tenth however the waiting was skipped.
     */
    for (let i = 0; i < 10; i += 1) {
      localStorage.setItem('vv.vault.attempts',
        JSON.stringify({ ...JSON.parse(localStorage.getItem('vv.vault.attempts') || '{}'), until: 0 }));
      await assert.rejects(() => vault.unlockVault('0000'));
    }

    assert.equal(vault.failedAttempts(), 10);
    const week = 7 * 24 * 3600_000;
    const waiting = vault.lockoutRemaining();
    assert.ok(waiting > week - 60_000 && waiting <= week, `shut for a week, got ${waiting}ms`);

    // Nothing was erased. The records are still there for whoever remembers the PIN.
    localStorage.setItem('vv.vault.attempts', JSON.stringify({ failed: 10, until: 0, seen: Date.now() }));
    await vault.unlockVault('4821');
    assert.equal(vault.isUnlocked(), true);
    assert.equal(vault.failedAttempts(), 0, 'and the right PIN clears the count');
  });

  it('keeps the rules readable so a forgotten PIN costs the ledger and not the machinery', async (t) => {
    const { vault } = await import('./_harness.mjs');
    const db = database.currentDatabase();
    localStorage.clear();

    db.run(
      "INSERT INTO sms_rules (rule_name, sender_keyword, body_trigger, transaction_type,"
      + " category_name, regex_pattern) VALUES ('Mine', '', 'zzz', 'Expense', 'Dining', 'Rs')",
    );
    db.run(
      "INSERT INTO merchant_rules (merchant_key, category_name, transaction_type)"
      + " VALUES ('cityflo', 'Travel', 'Expense')",
    );
    vault.mirrorConfig(db);

    const mirrored = vault.readMirroredConfig();
    assert.ok(mirrored, 'the mirror was written');
    assert.ok(mirrored.merchant_rules.some((row) => row.merchant_key === 'cityflo'));
    // Nothing about the money is in there.
    assert.equal('transactions' in mirrored, false);

    // Everything gone, as after a reset that followed a forgotten PIN.
    db.run('DELETE FROM sms_rules');
    db.run('DELETE FROM merchant_rules');

    const restored = vault.restoreMirroredConfig(db);
    assert.ok(restored > 0);
    assert.equal(db.get("SELECT category_name FROM merchant_rules WHERE merchant_key = 'cityflo'").category_name, 'Travel');
    assert.ok(db.all("SELECT id FROM sms_rules WHERE rule_name = 'Mine'").length, 'the rule came back');
  });

  /*
   * The change-PIN path, which has two records of the PIN that have to stay in step.
   *
   * Worth its own test because getting it wrong is silent: the lock screen would accept
   * the new PIN, having checked it against the hash, and then fail to decrypt a single
   * record with it. Nothing would report an error until the user next locked the app.
   */
  it('moves the key wrapping when the PIN changes, not just the hash', async () => {
    const { vault } = await import('./_harness.mjs');
    // One call, the way setup does it: the wrapping and the hash are both written here.
    await ok(null, 'create_vault', { new_pin: '1111' });

    await ok(null, 'set_pin', { new_pin: '2222', current_pin: '1111' });

    // Both records now describe 2222: the hash the screen checks, and the wrapping that
    // actually opens the records.
    const checked = await call('verify_pin', { pin: '2222' });
    assert.equal(checked.valid, true);

    vault.lockVault();
    await assert.rejects(() => vault.unlockVault('1111'), 'the old PIN no longer opens it');
    assert.equal(await vault.unlockVault('2222'), true);
  });

  it('refuses to change the PIN when the current one is wrong, and leaves both records alone', async () => {
    const { vault } = await import('./_harness.mjs');
    // One call, the way setup does it: the wrapping and the hash are both written here.
    await ok(null, 'create_vault', { new_pin: '1111' });

    const refused = await call('set_pin', { new_pin: '3333', current_pin: '9999' });
    assert.equal(refused.status, 'error');
    assert.equal(refused.code, 'PIN_WRONG');

    vault.lockVault();
    assert.equal(await vault.unlockVault('1111'), true, 'the old PIN still works');
    assert.equal((await call('verify_pin', { pin: '1111' })).valid, true);
  });

  it('refuses every action while locked, and says so rather than failing inside the crypto', async () => {
    const { vault } = await import('./_harness.mjs');
    await ok(null, 'create_vault', { new_pin: '1111' });
    vault.lockVault();

    const refused = await call('get_summary');
    assert.equal(refused.status, 'error');
    assert.equal(refused.code, 'LOCKED');

    // The one question that still has an answer.
    const status = await call('vault_status');
    assert.equal(status.status, 'success');
    assert.equal(status.exists, true);
    assert.equal(status.unlocked, false);
  });

  it('will not remove the PIN, even given the right one', async (t) => {
    /*
     * A PIN that only hid the screen was fair to remove. A PIN the records are encrypted
     * with is not: removing it would either strand them behind a key nobody holds or
     * rewrite them in the clear, and the second is worse, because the app would carry on
     * describing itself as private. Changing it is the supported move.
     */
    await ok(t, 'set_pin', { new_pin: '4821' });

    const wrong = await call('clear_pin', { current_pin: '0000' });
    assert.equal(wrong.code, 'PIN_WRONG', 'a wrong PIN still fails as a wrong PIN');

    const right = await call('clear_pin', { current_pin: '4821' });
    assert.equal(right.code, 'PIN_REQUIRED');

    // Still set, and still the way in.
    assert.equal((await call('verify_pin', { pin: '4821' })).valid, true);
  });

  it('refuses to write a private setting directly', async () => {
    const result = await call('update_setting', { key: 'pin_hash', value: 'x' });
    assert.equal(result.status, 'error');
  });
});

describe('transactions', () => {
  it('takes splits and cashback off what you actually bore', async (t) => {
    await ok(t, 'save_transaction', {
      transaction: {
        date: '2026-08-10',
        amount: 3000,
        category: 'Dining',
        merchant: 'A restaurant',
        type: 'Expense',
        splits: [
          { person_name: 'Rahul', share_amount: 1000, is_paid: 1 },
          { person_name: 'Priya', share_amount: 1000, is_paid: 1 },
        ],
        cashbacks: [{ source_name: 'Card cashback', cashback_amount: 150 }],
      },
    });

    const { transactions } = await ok(t, 'get_transactions');
    // 3000 spent, 2000 recovered from friends, 150 back on the card.
    assert.equal(transactions[0].net_personal_amount, 850);
  });

  it('does not count an unpaid split as recovered', async (t) => {
    await ok(t, 'save_transaction', {
      transaction: {
        amount: 1000,
        category: 'Dining',
        type: 'Expense',
        splits: [{ person_name: 'Rahul', share_amount: 500, is_paid: 0 }],
      },
    });
    const { transactions } = await ok(t, 'get_transactions');
    assert.equal(transactions[0].net_personal_amount, 1000);
  });

  it('refuses a zero or negative amount', async () => {
    assert.equal((await call('save_transaction', { transaction: { amount: 0 } })).status, 'error');
    assert.equal((await call('save_transaction', { transaction: { amount: -5 } })).status, 'error');
  });

  it('replaces the splits on an edit rather than adding to them', async (t) => {
    const created = await ok(t, 'save_transaction', {
      transaction: {
        amount: 1000,
        category: 'Dining',
        type: 'Expense',
        splits: [{ person_name: 'Rahul', share_amount: 500, is_paid: 1 }],
      },
    });
    await ok(t, 'save_transaction', {
      transaction: {
        id: created.transaction_id, amount: 1000, category: 'Dining', type: 'Expense', splits: [],
      },
    });
    const { transactions } = await ok(t, 'get_transactions');
    assert.deepEqual(transactions[0].splits, []);
    assert.equal(transactions[0].net_personal_amount, 1000);
  });

  it('keeps money moved into an investment out of spending', async (t) => {
    await ok(t, 'save_transaction', {
      transaction: {
        amount: 10000, category: 'Investment Outflow', type: 'Expense',
        is_investment_outflow: true,
      },
    });
    await ok(t, 'save_transaction', {
      transaction: { amount: 2000, category: 'Groceries', type: 'Expense' },
    });

    const summary = await ok(t, 'get_summary');
    assert.equal(summary.this_month.expense, 2000);
    assert.equal(summary.this_month.invested, 10000);
  });
});

describe('records', () => {
  const SAMPLES = {
    account: { name: 'A savings account', category: 'Bank', balance: 150000 },
    loan: {
      name: 'Home', loan_type: 'Home', principal_amount: 5000000,
      current_outstanding: 4200000, interest_rate: 8.5, tenure_months: 240,
      start_date: '2024-01-01', monthly_emi: 43391,
    },
    card: {
      card_name: 'A credit card', bank: 'A bank', total_limit: 300000,
      current_balance: 42000, due_date: 15,
    },
    subscription: {
      name: 'Streaming', cost: 649, billing_cycle: 'Monthly', next_billing_date: '2026-09-15',
    },
    sip: { scheme_name: 'An index fund', monthly_amount: 10000, debit_day: 5 },
    goal: { title: 'House deposit', target_amount: 2500000, target_date: '2030-01-01' },
    event: { title: 'Insurance renewal', event_date: '2026-12-01' },
  };

  for (const [type, record] of Object.entries(SAMPLES)) {
    it(`saves, lists and deletes a ${type}`, async (t) => {
      const created = await ok(t, 'save_record', { record_type: type, record });
      assert.equal((await ok(t, 'list_records', { record_type: type })).records.length, 1);

      await ok(t, 'delete_record', { record_type: type, record_id: created.record_id });
      assert.deepEqual((await ok(t, 'list_records', { record_type: type })).records, []);
    });
  }

  it('refuses a record type it does not know', async (t) => {
    // The type reaches an SQL statement, so it must never be taken on trust.
    for (const bad of ['sips; DROP TABLE sips', '../etc', '', null]) {
      assert.equal((await call('list_records', { record_type: bad })).status, 'error');
    }
    await ok(t, 'list_records', { record_type: 'sip' });
  });

  it('ignores columns that were never declared writable', async (t) => {
    await ok(t, 'save_record', {
      record_type: 'sip',
      record: {
        scheme_name: 'An index fund', monthly_amount: 5000, debit_day: 5,
        id_injected: 'boom', nonexistent_column: 1,
      },
    });
    const { records } = await ok(t, 'list_records', { record_type: 'sip' });
    assert.equal(records[0].scheme_name, 'An index fund');
  });
});

describe('the summary', () => {
  it('takes what you owe off what you have', async (t) => {
    await ok(t, 'save_record', {
      record_type: 'account', record: { name: 'Bank', category: 'Bank', balance: 500000 },
    });
    await ok(t, 'save_record', {
      record_type: 'loan',
      record: {
        name: 'Car', loan_type: 'Car', principal_amount: 400000, current_outstanding: 200000,
        interest_rate: 9, tenure_months: 60, start_date: '2025-01-01', monthly_emi: 8300,
      },
    });

    const summary = await ok(t, 'get_summary');
    assert.equal(summary.total_assets, 500000);
    assert.equal(summary.total_liabilities, 200000);
    assert.equal(summary.net_worth, 300000);
  });

  it('returns six months, the first of which is this one', async (t) => {
    const summary = await ok(t, 'get_summary');
    assert.equal(summary.months.length, 6);
    assert.deepEqual(summary.months[0], summary.this_month);
  });

  it('merges instalments and subscriptions into what is coming', async (t) => {
    await ok(t, 'save_record', {
      record_type: 'sip',
      record: { scheme_name: 'An index fund', monthly_amount: 10000, debit_day: 5 },
    });
    const upcoming = await ok(t, 'get_upcoming', { days: 40 });
    assert.ok(upcoming.upcoming.some((item) => item.kind === 'sip'));
    assert.ok(upcoming.total > 0);
  });
});

describe('the chart aggregates', () => {
  async function seed(t) {
    for (let back = 0; back < 4; back += 1) {
      const date = monthsAgo(back);
      await ok(t, 'save_transaction', {
        transaction: {
          date, amount: 2000 + back * 100, category: 'Groceries', type: 'Expense',
          merchant: 'A supermarket',
        },
      });
      await ok(t, 'save_transaction', {
        transaction: { date, amount: 900, category: 'Dining', type: 'Expense', merchant: 'A cafe' },
      });
      await ok(t, 'save_transaction', {
        transaction: { date, amount: 70000, category: 'Salary', type: 'Income' },
      });
      await ok(t, 'save_transaction', {
        transaction: {
          date, amount: 5000, category: 'Investment Outflow', type: 'Expense',
          is_investment_outflow: true,
        },
      });
    }
  }

  it('gives every metric the same shape', async (t) => {
    await seed(t);
    const metrics = ['income_expense', 'spend_by_category', 'spend_by_member',
      'cumulative_savings', 'investment_growth'];
    for (const metric of metrics) {
      const result = await ok(t, 'get_series', { metric, months: 6 });
      assert.equal(result.buckets.length, 6, metric);
      assert.equal(result.empty, false, metric);
      for (const series of result.series) {
        assert.equal(series.values.length, 6, `${metric}/${series.label}`);
      }
    }
  });

  it('does not count an investment as spending', async (t) => {
    await seed(t);
    const result = await ok(t, 'get_series', { metric: 'income_expense', months: 6 });
    const byKey = Object.fromEntries(result.series.map((s) => [s.key, s.values]));
    // 2000 of groceries and 900 of dining this month, and nothing else.
    assert.equal(byKey.expense.at(-1), 2900);
    assert.equal(byKey.invested.at(-1), 5000);
    assert.equal(byKey.income.at(-1), 70000);
  });

  it('has a category stack that adds up to the month', async (t) => {
    await seed(t);
    const result = await ok(t, 'get_series', { metric: 'spend_by_category', months: 6 });
    assert.equal(result.stacked, true);
    assert.equal(result.series.reduce((total, s) => total + s.values.at(-1), 0), 2900);
  });

  it('only ever accumulates the running total', async (t) => {
    await seed(t);
    const { series } = await ok(t, 'get_series', { metric: 'cumulative_savings', months: 6 });
    const values = series[0].values;
    // Income far exceeds spending here, so the total climbs every month.
    for (let i = 1; i < values.length; i += 1) assert.ok(values[i] >= values[i - 1]);
  });

  it('reports an empty history rather than faking one', async (t) => {
    const result = await ok(t, 'get_series', { metric: 'income_expense', months: 6 });
    assert.equal(result.empty, true);
  });

  it('clamps the bucket count, per granularity', async (t) => {
    assert.equal((await ok(t, 'get_series', { months: 999 })).buckets.length, 60);
    assert.equal((await ok(t, 'get_series', { months: 0 })).buckets.length, 2);
    // A daily chart is capped tighter than a monthly one: a bar per day for five years is
    // eighteen hundred bars in the width of a phone.
    assert.equal((await ok(t, 'get_series', { granularity: 'day', periods: 999 })).buckets.length, 92);
    assert.equal((await ok(t, 'get_series', { granularity: 'week', periods: 999 })).buckets.length, 53);
  });

  it('refuses a metric it does not know', async (t) => {
    const result = await call('get_series', { metric: "'; DROP TABLE transactions" });
    assert.equal(result.status, 'error');
    await ok(t, 'get_transactions');
  });

  it('groups merchants without regard to case', async (t) => {
    for (const merchant of ['DMart', 'dmart', 'DMART']) {
      await ok(t, 'save_transaction', {
        transaction: { amount: 500, category: 'Groceries', type: 'Expense', merchant },
      });
    }
    const { merchants } = await ok(t, 'get_top_merchants', { months: 3 });
    assert.equal(merchants.length, 1);
    assert.equal(merchants[0].times, 3);
    assert.equal(merchants[0].total, 1500);
  });

  it('leaves income and investments out of the merchant ranking', async (t) => {
    await ok(t, 'save_transaction', {
      transaction: { amount: 70000, category: 'Salary', type: 'Income', merchant: 'An employer' },
    });
    await ok(t, 'save_transaction', {
      transaction: {
        amount: 5000, category: 'Investment Outflow', type: 'Expense', merchant: 'A broker',
        is_investment_outflow: true,
      },
    });
    assert.deepEqual((await ok(t, 'get_top_merchants', { months: 3 })).merchants, []);
  });
});

describe('loans, borrowed and lent', () => {
  const loan = (name, direction, outstanding) => ({
    name,
    direction,
    loan_type: 'Personal',
    principal_amount: outstanding,
    current_outstanding: outstanding,
    interest_rate: 9,
    tenure_months: 24,
    start_date: '2025-01-01',
    monthly_emi: 5000,
  });

  it('puts borrowing on one side of the balance and lending on the other', async (t) => {
    await ok(t, 'save_record', { record_type: 'loan', record: loan('Car', 'borrowed', 200000) });
    await ok(t, 'save_record', { record_type: 'loan', record: loan('To a friend', 'lent', 50000) });

    const summary = await ok(t, 'get_summary');
    assert.equal(summary.total_liabilities, 200000);
    assert.equal(summary.asset_totals.Lent, 50000);
    assert.equal(summary.total_assets, 50000);
    assert.equal(summary.net_worth, -150000);
  });

  it('treats a loan with no direction as money owed, the way it used to be', async (t) => {
    const db = database.currentDatabase();
    db.run(
      'INSERT INTO loans (name, loan_type, principal_amount, current_outstanding,'
      + " interest_rate, tenure_months, start_date, monthly_emi, direction)"
      + " VALUES ('Legacy', 'Home', 100000, 90000, 8, 120, '2020-01-01', 1000, NULL)",
    );
    const summary = await ok(t, 'get_summary');
    assert.equal(summary.total_liabilities, 90000);
    assert.ok(!('Lent' in summary.asset_totals));
  });

  it('keeps the direction through a save and a read', async (t) => {
    await ok(t, 'save_record', { record_type: 'loan', record: loan('To a friend', 'lent', 50000) });
    const { records } = await ok(t, 'list_records', { record_type: 'loan' });
    assert.equal(records[0].direction, 'lent');
  });
});

describe('deleting data', () => {
  async function seed(t) {
    await ok(t, 'save_transaction', {
      transaction: { amount: 500, category: 'Groceries', type: 'Expense' },
    });
    await ok(t, 'save_record', {
      record_type: 'account', record: { name: 'Bank', category: 'Bank', balance: 1000 },
    });
    await ok(t, 'save_record', {
      record_type: 'goal',
      record: { title: 'A goal', target_amount: 1000, target_date: '2030-01-01' },
    });
  }

  it('deletes one kind and leaves the rest', async (t) => {
    await seed(t);
    const result = await ok(t, 'clear_data', { kinds: ['transactions'] });
    assert.equal(result.cleared, 1);
    assert.deepEqual((await ok(t, 'get_transactions')).transactions, []);
    assert.equal((await ok(t, 'list_records', { record_type: 'account' })).records.length, 1);
    assert.equal((await ok(t, 'list_records', { record_type: 'goal' })).records.length, 1);
  });

  it('deletes several kinds at once', async (t) => {
    await seed(t);
    await ok(t, 'clear_data', { kinds: ['accounts', 'goals'] });
    assert.deepEqual((await ok(t, 'list_records', { record_type: 'account' })).records, []);
    assert.deepEqual((await ok(t, 'list_records', { record_type: 'goal' })).records, []);
    assert.equal((await ok(t, 'get_transactions')).transactions.length, 1);
  });

  it('resets budgets without deleting the categories', async (t) => {
    await ok(t, 'save_category', {
      category: { name: 'Chai', type: 'Expense', monthly_budget: 500 },
    });
    await ok(t, 'update_setting', { key: 'monthly_budget', value: '60000' });

    await ok(t, 'clear_data', { kinds: ['budgets'] });

    const { categories } = await ok(t, 'get_categories');
    assert.ok(categories.some((category) => category.name === 'Chai'));
    assert.ok(categories.every((category) => Number(category.monthly_budget) === 0));
    assert.equal((await ok(t, 'get_settings')).settings.monthly_budget, '0');
  });

  it('brings the defaults back after deleting the categories', async (t) => {
    await ok(t, 'clear_data', { kinds: ['categories'] });
    assert.ok((await ok(t, 'get_categories')).categories.length >= 18);
  });

  it('deletes accounts a transaction still points at', async (t) => {
    // A transaction names the account it came out of. Deleting the accounts straight out
    // fails the foreign key, so the references are released first.
    const created = await ok(t, 'save_record', {
      record_type: 'account', record: { name: 'Bank', category: 'Bank', balance: 1000 },
    });
    await ok(t, 'save_transaction', {
      transaction: {
        amount: 500, category: 'Groceries', type: 'Expense', account_id: created.record_id,
      },
    });

    await ok(t, 'clear_data', { kinds: ['accounts'] });

    assert.deepEqual((await ok(t, 'list_records', { record_type: 'account' })).records, []);
    const { transactions } = await ok(t, 'get_transactions');
    assert.equal(transactions.length, 1, 'the transaction itself is a separate answer');
    assert.equal(transactions[0].account_id, null);
  });

  it('refuses to delete something it has no name for', async () => {
    const result = await call('clear_data', { kinds: ['sqlite_master'] });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'BAD_REQUEST');
  });

  it('refuses an empty request', async () => {
    assert.equal((await call('clear_data', { kinds: [] })).code, 'BAD_REQUEST');
  });
});

describe('holdings', () => {
  it('lists nothing before an import', async (t) => {
    const result = await ok(t, 'list_folios');
    assert.deepEqual(result.folios, []);
    assert.equal(result.total_value, 0);
  });

  it('refreshes a holding on a repeat import rather than duplicating it', async (t) => {
    // The unique index on folio, scheme and ISIN is what makes re-importing a statement
    // update a holding instead of adding a second copy of it.
    const db = database.currentDatabase();
    for (const value of [100000, 125000]) {
      db.run(
        "INSERT INTO mf_folios (folio_number, amc, scheme_name, isin, units, nav,"
        + " current_value, last_updated)"
        + " VALUES ('123/456', 'An AMC', 'An index fund', 'INF001A01011', 100, 250, ?,"
        + " '2026-08-01')"
        + ' ON CONFLICT(folio_number, scheme_name, isin) DO UPDATE SET'
        + ' current_value = excluded.current_value',
        [value],
      );
    }
    const result = await ok(t, 'list_folios');
    assert.equal(result.folios.length, 1);
    assert.equal(result.total_value, 125000);
  });

  it('merges one holding reported by two statements instead of counting it twice', async (t) => {
    /*
     * A registrar and a depository both report units held with an AMC. They agree on the
     * units and disagree on the value, because they were priced on different days, and
     * only the registrar prints what was paid. Two rows would double the money and leave
     * the cost on the row nobody reads.
     */
    const { importDepositoryStatement, importRegistrarStatement } = cas;
    const db = database.currentDatabase();

    importRegistrarStatement(db, {
      folios: [{
        folio: '12345678/90',
        amc: 'An AMC',
        schemes: [{
          scheme: 'An Index Fund - Direct Growth',
          isin: 'INF001A01011',
          close: 1132.515,
          valuation: { value: 280000, cost: 249000 },
        }],
      }],
    }, 1, '2026-07-31');

    importDepositoryStatement(db, {
      accounts: [{
        name: 'Mutual Fund Folios', type: 'NSDL', dp_id: '', client_id: '',
        mutual_funds: [{
          name: 'AN AMC MUTUAL FUND',
          isin: 'INF001A01011',
          balance: 1132.515,
          nav: 260,
          value: 294453,
        }],
        equities: [],
        bonds: [],
      }],
    }, 1, '2026-08-10');

    const rows = db.all('SELECT scheme_name, units, current_value, invested_value FROM mf_folios');
    assert.equal(rows.length, 1, 'one holding, not two');
    assert.equal(rows[0].current_value, 294453, 'the newer statement sets the value');
    assert.equal(rows[0].invested_value, 249000, 'the cost survives from the one that knew it');
    assert.equal(rows[0].units, 1132.515);
  });

  it('matches one scheme written two ways, and refuses two that only look alike', async (t) => {
    const db = database.currentDatabase();

    // One registrar statement, four holdings. A registrar statement is the whole of what
    // is held with the AMCs, so it has to arrive as one snapshot rather than four.
    const scheme = (name, isin, units) => ({
      scheme: name, isin, close: units, valuation: { value: 1000, cost: 900, nav: 100 },
    });
    cas.importRegistrarStatement(db, {
      folios: [{
        folio: 'F1',
        amc: 'An AMC',
        schemes: [
          scheme('Axis Small Cap Fund - Direct Plan Growth', 'INF001A01011', 10),
          scheme('Axis Small Cap Fund - Regular Plan Growth', 'INF001A01029', 20),
          scheme('Nifty 50 Index Fund - Direct Plan - Growth', 'INF001A01037', 30),
          scheme('Axis Small Cap Fund - Direct Growth', 'INF001A01045', 40),
        ],
      }],
    }, 1, '2026-07-31');
    assert.equal(db.all('SELECT id FROM mf_folios').length, 4);

    // Now a depository restating two of them and naming two others that merely resemble
    // one. The ISIN is blank throughout, which is the case the name matching exists for.
    cas.importDepositoryStatement(db, {
      accounts: [{
        name: 'Mutual Fund Folios',
        type: 'NSDL',
        dp_id: '',
        client_id: '',
        mutual_funds: [
          // Same scheme, a word short. The token ratio closes this one.
          { name: 'axis small cap fund direct growth', isin: '', balance: 11, nav: 110, value: 1210 },
          // Same scheme, punctuation only. The ratio scores it 78, so squashing closes it.
          { name: 'Nifty50Index Fund-Direct Plan Growth', isin: '', balance: 31, nav: 110, value: 3410 },
        ],
        equities: [],
        bonds: [],
      }],
    }, 1, '2026-08-10');

    const rows = db.all('SELECT scheme_name, units, invested_value FROM mf_folios');
    assert.equal(rows.length, 4, 'the two restatements merged rather than adding rows');

    // Units move between statements, which is exactly why they cannot identify a holding.
    const axis = rows.find((row) => /axis/i.test(row.scheme_name) && row.units === 11);
    assert.ok(axis, 'the axis holding took the newer units');
    assert.equal(axis.invested_value, 900, 'the cost survives the statement that lacks one');

    const nifty = rows.find((row) => /nifty/i.test(row.scheme_name));
    assert.equal(nifty.units, 31, 'the nifty holding took the newer units too');

    assert.equal(rows.filter((row) => /regular/i.test(row.scheme_name)).length, 1,
      'the regular plan was not swallowed by the direct one');
    // Four distinct ISINs went in and four holdings came out: a name score of 93 between
    // two of them did not overrule the codes that say they are different schemes.
    assert.equal(new Set(rows.map((row) => row.scheme_name)).size, 4);
  });

  it('keeps both statements when two different files arrive the same day', async (t) => {
    /*
     * An upsert that resolves to an update performs no insert, so the rowid the driver
     * reports afterwards belongs to whatever was inserted last. Handing that to the
     * pruner marked the wrong row as kept and deleted the right one, and the second file
     * of the day looked as though it had never been read.
     */
    const db = database.currentDatabase();
    const scheme = (name, isin) => ({
      scheme: name, isin, close: 10, valuation: { value: 1000, cost: 900, nav: 100 },
    });

    cas.importRegistrarStatement(db, {
      folios: [{ folio: 'F1', amc: 'An AMC', schemes: [scheme('A Fund', 'INF001A01011')] }],
    }, 1, '2026-08-11');

    // A second file, a different account, read the same day.
    cas.importDepositoryStatement(db, {
      accounts: [{
        name: 'Zerodha',
        type: 'CDSL',
        dp_id: '12081600',
        client_id: '87743581',
        mutual_funds: [{
          name: 'Another Fund', isin: 'INF001A01029', balance: 20, nav: 100, value: 2000,
        }],
        equities: [],
        bonds: [],
      }],
    }, 1, '2026-08-11');

    const rows = db.all('SELECT scheme_name FROM mf_folios ORDER BY scheme_name');
    assert.equal(rows.length, 2, 'neither file wiped the other');
    assert.deepEqual(rows.map((row) => row.scheme_name), ['A Fund', 'Another Fund']);
  });

  it('takes the newer statement and ignores an older one loaded after it', async (t) => {
    const db = database.currentDatabase();
    const statement = (value, nav, units) => ({
      folios: [{
        folio: 'F1',
        amc: 'An AMC',
        schemes: [{
          scheme: 'A Fund', isin: 'INF001A01011', close: units, valuation: { value, cost: 900, nav },
        }],
      }],
    });

    cas.importRegistrarStatement(db, statement(1000, 100, 10), 1, '2026-07-31');
    // August: the SIP added units and the NAV moved.
    cas.importRegistrarStatement(db, statement(2200, 110, 20), 1, '2026-08-31');

    let row = db.get('SELECT units, nav, current_value, last_updated FROM mf_folios');
    assert.equal(row.units, 20, 'the newer statement wins');
    assert.equal(row.current_value, 2200);
    assert.equal(row.last_updated, '2026-08-31');

    // July again, loaded by mistake after August. It must change nothing.
    cas.importRegistrarStatement(db, statement(1000, 100, 10), 1, '2026-07-31');

    row = db.get('SELECT units, nav, current_value, last_updated FROM mf_folios');
    assert.equal(row.units, 20, 'the older statement did not walk it backwards');
    assert.equal(row.current_value, 2200);
    assert.equal(row.last_updated, '2026-08-31');
  });

  it('treats one fund reported by both statements as one holding', async (t) => {
    /*
     * Units of a fund held in demat are RTA serviced whichever way they are held, so a
     * registrar reports them too and one holding turns up in both statements. Ten did in
     * one real pair of files, six with byte identical unit counts, and keeping the demat
     * scope apart from the AMC scope counted fifteen lakh twice.
     */
    const db = database.currentDatabase();

    cas.importDepositoryStatement(db, {
      accounts: [{
        name: 'Zerodha',
        type: 'CDSL',
        dp_id: '12081600',
        client_id: '87743581',
        mutual_funds: [
          { name: 'A Fund', isin: 'INF001A01011', balance: 102.724, nav: 46, value: 4758 },
          { name: 'A Gold ETF', isin: 'INF204KB17I5', balance: 888, nav: 117, value: 103976 },
        ],
        equities: [],
        bonds: [],
      }, {
        // A second demat account holding the same ETF. Two real holdings, not one.
        name: 'Another broker',
        type: 'NSDL',
        dp_id: 'IN303028',
        client_id: '66816006',
        mutual_funds: [
          { name: 'A Gold ETF', isin: 'INF204KB17I5', balance: 101, nav: 117, value: 11842 },
        ],
        equities: [],
        bonds: [],
      }],
    }, 1, '2026-07-31');
    assert.equal(db.all('SELECT id FROM mf_folios').length, 3);

    // The registrar, ten days later, reporting the same fund it services.
    cas.importRegistrarStatement(db, {
      folios: [{
        folio: '12345/67',
        amc: 'An AMC',
        schemes: [{
          scheme: 'A Fund', isin: 'INF001A01011', close: 102.724,
          valuation: { value: 5014, cost: 4000, nav: 48.8 },
        }],
      }],
    }, 1, '2026-08-10');

    const rows = db.all('SELECT isin, units, current_value, invested_value, scope FROM mf_folios');
    assert.equal(rows.length, 3, 'the fund merged; the two gold holdings stayed apart');

    const fund = rows.find((row) => row.isin === 'INF001A01011');
    assert.equal(fund.current_value, 5014, 'the newer valuation won');
    assert.equal(fund.invested_value, 4000, 'and brought the cost the depository lacks');
    assert.equal(fund.scope, 'with-amc');

    const gold = rows.filter((row) => row.isin === 'INF204KB17I5');
    assert.equal(gold.length, 2, 'two demat accounts are two holdings');
    assert.deepEqual(gold.map((row) => row.units).sort((a, b) => a - b), [101, 888]);
  });

  it('records the transactions a detailed statement carries', async (t) => {
    const db = database.currentDatabase();
    const statement = {
      folios: [{
        folio: 'F1',
        amc: 'An AMC',
        schemes: [{
          scheme: 'A Fund',
          isin: 'INF001A01011',
          close: 30,
          valuation: { value: 3600, cost: 0, nav: 120 },
          transactions: [
            { date: '2026-05-10', description: 'Purchase', type: 'PURCHASE', amount: 1000, units: 10, nav: 100, balance: 10 },
            { date: '2026-06-10', description: 'Purchase', type: 'PURCHASE', amount: 1100, units: 10, nav: 110, balance: 20 },
            { date: '2026-07-10', description: 'Purchase', type: 'PURCHASE', amount: 1200, units: 10, nav: 120, balance: 30 },
            // An opening balance line moves nothing and must not be recorded.
            { date: '2026-05-01', description: 'Opening balance', type: 'OPENING', amount: 0, units: 0, nav: 0, balance: 0 },
          ],
        }],
      }],
    };

    const counts = cas.importRegistrarStatement(db, statement, 1, '2026-07-31');
    assert.equal(counts.transaction_count, 3, 'the opening balance was not a movement');

    // The same statement again. A line is a line however many times the file is read.
    cas.importRegistrarStatement(db, statement, 1, '2026-07-31');
    assert.equal(db.all('SELECT id FROM folio_transactions').length, 3);

    const detail = await call('get_holding_detail', { isin: 'INF001A01011' });
    assert.equal(detail.status, 'success');
    assert.equal(detail.counted, 3);
    assert.equal(detail.invested_from_history, 3300);
    assert.equal(detail.average_cost, 110, 'three instalments at 100, 110 and 120');
    assert.equal(detail.first_seen, '2026-05-10');
    assert.equal(detail.last_seen, '2026-07-10');
  });

  it('forgets a holding a later statement no longer lists', async (t) => {
    /*
     * A statement is a snapshot of a place, not a list of additions. Nothing an import did
     * ever removed a row, so a fund that was sold sat in the table for ever and somebody
     * uploading a statement every month watched their holdings only ever grow.
     */
    const db = database.currentDatabase();
    const scheme = (name, isin) => ({
      scheme: name, isin, close: 10, valuation: { value: 1000, cost: 900, nav: 100 },
    });

    cas.importRegistrarStatement(db, {
      folios: [{
        folio: 'F1',
        amc: 'An AMC',
        schemes: [scheme('A Fund', 'INF001A01011'), scheme('A Sold Fund', 'INF001A01029')],
      }],
    }, 1, '2026-07-31');
    assert.equal(db.all('SELECT id FROM mf_folios').length, 2);

    cas.importRegistrarStatement(db, {
      folios: [{ folio: 'F1', amc: 'An AMC', schemes: [scheme('A Fund', 'INF001A01011')] }],
    }, 1, '2026-08-31');

    const rows = db.all('SELECT scheme_name FROM mf_folios');
    assert.equal(rows.length, 1, 'the sold fund is gone');
    assert.equal(rows[0].scheme_name, 'A Fund');
  });

  it('does not let a depository clear folios it never had sight of', async (t) => {
    /*
     * A depository masks the section listing units held directly with an AMC, so it names
     * some of those folios and not others. Treating that partial list as a snapshot would
     * delete real holdings.
     */
    const db = database.currentDatabase();
    cas.importRegistrarStatement(db, {
      folios: [{
        folio: 'F1',
        amc: 'An AMC',
        schemes: [
          { scheme: 'One Fund', isin: 'INF001A01011', close: 10, valuation: { value: 1000, cost: 900, nav: 100 } },
          { scheme: 'Another Fund', isin: 'INF001A01029', close: 20, valuation: { value: 2000, cost: 1800, nav: 100 } },
        ],
      }],
    }, 1, '2026-07-31');

    cas.importDepositoryStatement(db, {
      accounts: [{
        name: 'Mutual Fund Folios',
        type: 'NSDL',
        dp_id: '',
        client_id: '',
        mutual_funds: [{ name: 'One Fund', isin: 'INF001A01011', balance: 10, nav: 110, value: 1100 }],
        equities: [],
        bonds: [],
      }],
    }, 1, '2026-08-10');

    assert.equal(db.all('SELECT id FROM mf_folios').length, 2,
      'the folio the depository could not see is still there');
  });

  it('does not let a statement without a cost erase one already known', async (t) => {
    const db = database.currentDatabase();
    db.run(
      "INSERT INTO mf_folios (folio_number, amc, scheme_name, isin, units, nav,"
      + " current_value, invested_value, last_updated, source)"
      + " VALUES ('F1', 'An AMC', 'A fund', 'INF001A01011', 10, 100, 1000, 900,"
      + " '2026-07-31', 'registrar')",
    );
    // The same folio again from a source that prints no cost at all.
    cas.importRegistrarStatement(db, {
      folios: [{
        folio: 'F1',
        amc: 'An AMC',
        schemes: [{
          scheme: 'A fund', isin: 'INF001A01011', close: 10, valuation: { value: 1100, cost: 0 },
        }],
      }],
    }, 1, '2026-08-10');

    const row = db.get('SELECT current_value, invested_value FROM mf_folios');
    assert.equal(row.current_value, 1100, 'the newer value lands');
    assert.equal(row.invested_value, 900, 'the cost is not wiped');
  });

  it('keeps two schemes a depository prints under one fund house name', async (t) => {
    /*
     * A depository masks the folio and prints the fund house where a registrar prints the
     * scheme, so two different schemes arrive with the same folio and the same name and
     * differ only by ISIN. Keyed without the ISIN the second overwrote the first, and one
     * real statement lost five holdings out of eighteen that way.
     */
    const db = database.currentDatabase();
    for (const [isin, value] of [['INF001A01011', 300000], ['INF001A01029', 255458]]) {
      db.run(
        "INSERT INTO mf_folios (folio_number, amc, scheme_name, isin, units, nav,"
        + " current_value, last_updated)"
        + " VALUES ('IN30/1234', 'A depository', 'AN AMC MUTUAL FUND', ?, 10, 100, ?,"
        + " '2026-08-01')"
        + ' ON CONFLICT(folio_number, scheme_name, isin) DO UPDATE SET'
        + ' current_value = excluded.current_value',
        [isin, value],
      );
    }
    const result = await ok(t, 'list_folios');
    assert.equal(result.folios.length, 2, 'two schemes, not one overwriting the other');
    assert.equal(result.total_value, 555458);
  });

  it('counts fund holdings towards net worth', async (t) => {
    database.currentDatabase().run(
      "INSERT INTO mf_folios (folio_number, amc, scheme_name, current_value, last_updated)"
      + " VALUES ('1', 'An AMC', 'A fund', 50000, '2026-08-01')",
    );
    const summary = await ok(t, 'get_summary');
    assert.equal(summary.asset_totals.MF, 50000);
    assert.equal(summary.net_worth, 50000);
  });

  it('counts demat and pension holdings towards net worth too', async (t) => {
    const db = database.currentDatabase();
    db.run(
      "INSERT INTO demat_holdings (account_type, dp_id, client_id, kind, isin, name,"
      + " quantity, price, current_value, last_updated)"
      + " VALUES ('NSDL Demat Account', 'IN301151', '12241815', 'equity', 'INE002A01018',"
      + " 'A listed company', 10, 1000, 10000, '2026-08-01')",
    );
    db.run(
      "INSERT INTO nps_holdings (pran, scheme, units, nav, current_value, last_updated)"
      + " VALUES ('110099887766', 'A pension scheme', 100, 30, 3000, '2026-08-01')",
    );

    const summary = await ok(t, 'get_summary');
    assert.equal(summary.asset_totals.Demat, 10000);
    assert.equal(summary.asset_totals.NPS, 3000);
    assert.equal(summary.net_worth, 13000);

    assert.equal((await ok(t, 'list_demat_holdings')).total_value, 10000);
    assert.equal((await ok(t, 'list_nps_holdings')).total_value, 3000);
  });
});

describe('categories', () => {
  it('seeds defaults whose icons the bundled font can draw', async (t) => {
    const { categories } = await ok(t, 'get_categories');
    assert.ok(categories.length >= 18);
    for (const category of categories) {
      assert.match(category.icon, /^[a-z0-9_]+$/, category.icon);
    }
  });

  it('refuses a duplicate name', async (t) => {
    await ok(t, 'save_category', { category: { name: 'Chai', type: 'Expense' } });
    assert.equal((await call('save_category', { category: { name: 'Chai' } })).status, 'error');
  });

  it('attributes spending to its category', async (t) => {
    await ok(t, 'save_transaction', {
      transaction: { amount: 700, category: 'Groceries', type: 'Expense' },
    });
    const { categories } = await ok(t, 'get_categories');
    const groceries = categories.find((category) => category.name === 'Groceries');
    assert.equal(groceries.spent_this_month, 700);
  });
});

describe('backup', () => {
  async function seed(t) {
    await ok(t, 'set_pin', { new_pin: '4821' });
    await ok(t, 'save_record', {
      record_type: 'account', record: { name: 'Bank', category: 'Bank', balance: 500000 },
    });
    await ok(t, 'save_transaction', {
      transaction: {
        amount: 2500, category: 'Groceries', type: 'Expense', merchant: 'A supermarket',
      },
    });
  }

  it('restores everything it exported', async (t) => {
    await seed(t);
    const exported = await ok(t, 'export_backup', { password: 'hunter2hunter2' });
    const restored = await ok(t, 'import_backup', {
      backup_payload: exported.backup_payload, password: 'hunter2hunter2',
    });
    assert.ok(restored.restored > 0);
    assert.equal((await ok(t, 'get_transactions')).transactions.length, 1);
    assert.equal((await call('verify_pin', { pin: '4821' })).valid, true);
  });

  it('writes the tables in an order the foreign keys survive', async (t) => {
    // Transactions reference household members. Clearing parents before children, or
    // refilling children first, trips the constraint.
    await seed(t);
    const exported = await ok(t, 'export_backup', { password: 'hunter2hunter2' });
    await ok(t, 'import_backup', {
      backup_payload: exported.backup_payload, password: 'hunter2hunter2',
    });
  });

  it('changes nothing when the password is wrong', async (t) => {
    await seed(t);
    const exported = await ok(t, 'export_backup', { password: 'hunter2hunter2' });
    const result = await call('import_backup', {
      backup_payload: exported.backup_payload, password: 'wrong',
    });
    assert.equal(result.status, 'error');
    assert.equal((await ok(t, 'get_transactions')).transactions.length, 1);
  });

  it('refuses a weak export password', async () => {
    assert.equal((await call('export_backup', { password: 'short' })).status, 'error');
    assert.equal((await call('export_backup')).status, 'error');
  });

  it('ignores tables a crafted backup names', async (t) => {
    await seed(t);
    const payload = await crypto.encryptData(
      JSON.stringify({ sqlite_master: [{ name: 'x' }], transactions: [] }), 'hunter2hunter2',
    );
    // Nothing outside the allowed list is touched, so there is nothing to restore.
    const result = await call('import_backup', {
      backup_payload: payload, password: 'hunter2hunter2',
    });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'BACKUP_EMPTY');
  });

  it('reads a backup written before the rewrite', async (t) => {
    // The format did not change: same derivation, same layout, same cipher. An export
    // taken from the previous release has to restore, or the change was not safe to make.
    const payload = await crypto.encryptData(
      JSON.stringify({
        family_members: [{
          id: 1, name: 'You', relationship: 'Self', is_primary: 1, created_at: '2024-01-01',
        }],
        app_settings: [{ key: 'currency', value: 'INR' }],
        transactions: [{
          id: 1, member_id: 1, date: '2025-01-01', amount: 42, type: 'Expense',
          category: 'Groceries',
        }],
      }),
      'hunter2hunter2',
    );
    const restored = await ok(t, 'import_backup', {
      backup_payload: payload, password: 'hunter2hunter2',
    });
    assert.equal(restored.restored, 3);
    assert.equal((await ok(t, 'get_transactions')).transactions.length, 1);
  });

  it('clears everything on a factory reset and reseeds the defaults', async (t) => {
    await seed(t);
    await ok(t, 'factory_reset');
    assert.deepEqual((await ok(t, 'get_transactions')).transactions, []);
    assert.ok((await ok(t, 'get_categories')).categories.length >= 18);
  });
});

describe('migration', () => {
  it('opens a fund table an older build wrote', async (t) => {
    /*
     * The schema block runs before the migrations, so an index declared beside CREATE
     * TABLE is created against a database that has not gained its column yet. That threw
     * "no such column: scope" on the first open and the app would not start.
     */
    const db = database.currentDatabase();
    db.run('DROP TABLE mf_folios');
    db.run(
      'CREATE TABLE mf_folios (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER'
      + ' DEFAULT 1, folio_number TEXT, amc TEXT, scheme_name TEXT NOT NULL, isin TEXT,'
      + ' units REAL DEFAULT 0.0, nav REAL DEFAULT 0.0, current_value REAL DEFAULT 0.0,'
      + ' invested_value REAL DEFAULT 0.0, last_updated TEXT)',
    );
    db.run(
      "INSERT INTO mf_folios (folio_number, amc, scheme_name, isin, units, current_value)"
      + " VALUES ('F1', 'An AMC', 'A fund', 'INF001A01011', 10, 1000)",
    );

    database.initDb(db, true);

    const columns = db.all('PRAGMA table_info(mf_folios)').map((row) => row.name);
    assert.ok(columns.includes('scope'), 'the column arrived');
    assert.ok(columns.includes('source'));
    const kept = db.get('SELECT scheme_name, current_value FROM mf_folios');
    assert.equal(kept.scheme_name, 'A fund', 'and the holding survived');
    assert.equal(kept.current_value, 1000);
  });

  it('removes a plaintext PIN left by an older build', async (t) => {
    const db = database.currentDatabase();
    db.run("DELETE FROM app_settings WHERE key = 'pin_hash'");
    db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('pin_code', '1234')");

    database.initDb(db, true);

    const { settings } = await ok(t, 'get_settings');
    assert.ok(!('pin_code' in settings));
    // There is no way to rehash it without the PIN, so the lock falls back to unset
    // rather than leaving a readable copy in the file.
    assert.equal(settings.pin_is_set, '0');
  });

  it('replaces an emoji category icon', async (t) => {
    const db = database.currentDatabase();
    db.run("UPDATE custom_categories SET icon = ? WHERE name = 'Groceries'", ['\u{1F6D2}']);

    database.initDb(db, true);

    const { categories } = await ok(t, 'get_categories');
    assert.equal(categories.find((c) => c.name === 'Groceries').icon, 'sell');
  });
});

describe('the investments table', () => {
  const seed = (db) => {
    db.run(
      "INSERT INTO mf_folios (member_id, folio_number, amc, scheme_name, isin, units, nav,"
      + " current_value, invested_value) VALUES"
      + " (1, 'F1', 'Quant', 'Quant Mid Cap Fund', 'INF966L01234', 100, 130, 13000, 10000)",
    );
    db.run(
      "INSERT INTO demat_holdings (member_id, account_type, broker, dp_id, client_id, kind,"
      + " isin, name, symbol, quantity, price, current_value) VALUES"
      + " (1, 'NSDL', 'Zerodha', 'IN30', '1234', 'equity', 'INE002A01018', 'RELIANCE INDUSTRIES', 'RELIANCE', 10, 1400, 14000)",
    );
    db.run(
      "INSERT INTO demat_holdings (member_id, account_type, broker, dp_id, client_id, kind,"
      + " isin, name, quantity, price, current_value) VALUES"
      + " (1, 'NSDL', 'Zerodha', 'IN30', '1234', 'bond', 'IN0020230101', 'SOVEREIGN GOLD BOND 2030', 5, 7000, 35000)",
    );
    db.run(
      "INSERT INTO nps_holdings (member_id, pran, scheme, fund_manager, tier, asset_class,"
      + " units, nav, current_value) VALUES"
      + " (1, 'P1', 'HDFC Pension Scheme E', 'HDFC', 'I', 'E', 200, 45, 9000)",
    );
  };

  it('classifies by ISIN and by name, exposure before legal form', async () => {
    const db = database.currentDatabase();
    seed(db);

    const res = await call('list_investments');
    const byName = Object.fromEntries(res.holdings.map((row) => [row.name, row.asset_class]));
    assert.equal(byName['Quant Mid Cap Fund'], 'Mutual funds');
    assert.equal(byName['RELIANCE INDUSTRIES'], 'Stocks');
    assert.equal(byName['HDFC Pension Scheme E'], 'NPS');
    // A sovereign gold bond is a government security on paper and gold in substance.
    // Somebody reading their portfolio wants to see the metal.
    assert.equal(byName['SOVEREIGN GOLD BOND 2030'], 'Commodities');
  });

  it('leaves a holding with no known cost out of the profit rather than calling it a loss', async () => {
    const db = database.currentDatabase();
    seed(db);

    const res = await call('list_investments');
    const fund = res.holdings.find((row) => row.name === 'Quant Mid Cap Fund');
    assert.equal(fund.has_cost, true);
    assert.equal(fund.pnl, 3000);
    assert.equal(Math.round(fund.pnl_percent), 30);

    const share = res.holdings.find((row) => row.name === 'RELIANCE INDUSTRIES');
    assert.equal(share.has_cost, false);
    assert.equal(share.pnl, 0, 'not a loss of the whole value');

    // Only the fund has a cost, so it is the only thing the totals may compare.
    assert.equal(res.totals.invested, 10000);
    assert.equal(res.totals.pnl, 3000);
    assert.equal(res.totals.value, 71000, 'value still counts everything');
    assert.equal(res.totals.unpriced, 3);
  });

  it('records a cost that no depository statement prints', async () => {
    const db = database.currentDatabase();
    seed(db);
    const share = db.get("SELECT id FROM demat_holdings WHERE symbol = 'RELIANCE'");

    const saved = await call('save_holding_cost', {
      source: 'demat', holding_id: share.id, invested_value: 11000,
    });
    assert.equal(saved.status, 'success');

    const res = await call('list_investments');
    const updated = res.holdings.find((row) => row.name === 'RELIANCE INDUSTRIES');
    assert.equal(updated.has_cost, true);
    assert.equal(updated.pnl, 3000);
    assert.equal(res.totals.unpriced, 2);
  });

  it('keeps each depository account as its own portfolio', async () => {
    const db = database.currentDatabase();
    seed(db);
    db.run(
      "INSERT INTO demat_holdings (member_id, account_type, broker, dp_id, client_id, kind,"
      + " isin, name, quantity, price, current_value) VALUES"
      + " (1, 'CDSL', 'Groww', '12088', '9999', 'equity', 'INE009A01021', 'INFOSYS', 5, 1500, 7500)",
    );

    const res = await call('list_investments');
    /*
     * A portfolio is where a holding is kept. The two demat accounts and the pension
     * account are places; the fund house that runs a scheme is not, and listing every AMC
     * separately turned the filter into a list of the schemes it exists to filter.
     */
    assert.deepEqual(res.portfolios, ['Groww', 'HDFC', 'Mutual fund folios', 'Zerodha']);
    const fund = res.holdings.find((row) => row.name === 'Quant Mid Cap Fund');
    assert.equal(fund.portfolio, 'Mutual fund folios');
    assert.equal(fund.amc, 'Quant', 'the fund house is kept, just not as the portfolio');
  });
});

describe('the calculators', () => {
  it('classifies a debit and a credit from a bank alert', async () => {
    const debit = await sms.parseSmsText(
      'Rs 4,500.00 debited from HDFC Bank A/C *1234 at DMART', 'HDFCBK',
    );
    assert.equal(debit.amount, 4500);
    assert.equal(debit.type, 'Expense');

    const credit = await sms.parseSmsText('Rs 25,000.00 credited to SBI A/C *5678', 'SBIBNK');
    assert.equal(credit.type, 'Income');
  });

  it('falls back to the default pattern when a rule carries a broken one', async () => {
    const db = database.currentDatabase();
    db.run(
      'INSERT INTO sms_rules (rule_name, sender_keyword, body_trigger, transaction_type,'
      + " category_name, regex_pattern) VALUES ('Broken', '', 'zzztrigger', 'Expense',"
      + " 'Groceries', '([unclosed')",
    );
    const result = await sms.parseSmsText('Rs 100.00 zzztrigger somewhere', 'X');
    assert.equal(result.matched_rule, 'Broken');
    assert.equal(result.amount, 100);
  });

  it('reads an amount stated in INR, not only one stated in Rs', async () => {
    // The seeded pattern used to be Rs-only, so every card issuer that writes INR gave
    // an amount of zero and the transaction was filed as worthless.
    const result = await sms.parseSmsText(
      'INR 1,250.00 spent at CROMA on AU Bank Credit Card 1234 on 03-08-2026', 'AUBANK',
    );
    assert.equal(result.amount, 1250);
    assert.equal(result.type, 'Expense');
  });

  it('does not file a reminder as money that already moved', async () => {
    // "will be deducted" contains "deducted". Without a guard this books the payment
    // three days early, and again for real when the debit arrives.
    const reminder = await sms.parseSmsText(
      'Autopay Reminder! Your Credit Card bill amt: Rs.4300.00 will be deducted from'
      + ' HDFC Bank A/C 1234 on 17-Aug', 'HDFCBK',
    );
    assert.equal(reminder.matched_rule, 'Not a transaction');
    assert.equal(reminder.not_a_transaction, 'reminder');
    assert.equal(reminder.amount, 0);
  });

  it('does not book a card bill payment as income', async () => {
    const payment = await sms.parseSmsText(
      'Thank you AU Bank Credit Cardholder! Payment of INR 2,472.00 was credited to your'
      + ' Card xx1234 on 06/08/2026', 'AUBANK',
    );
    // Never income. It is a transfer, which the test below pins in full.
    assert.notEqual(payment.type, 'Income');
    assert.equal(payment.matched_rule, 'Credit card payment');
  });

  it('keeps a real spend that merely mentions OTP in its safety line', async () => {
    // "without PIN/OTP" is how a debit card alert reassures you. Reading that as a one
    // time password threw away 45 genuine spends from one real inbox.
    const spend = await sms.parseSmsText(
      'ALERT:Rs.316.00 spent via HDFC BANK Debit Card xx3120 at BIGBASKET on Aug 4 2026'
      + ' 6:04AM without PIN/OTP.Not you?Call 18001600', 'HDFCBK',
    );
    assert.equal(spend.not_a_transaction, undefined);
    assert.equal(spend.amount, 316);
    assert.equal(spend.category, 'Groceries');
  });

  it('keeps a refund that also quotes the remaining bill', async () => {
    const refund = await sms.parseSmsText(
      'IND*AMAZON refund of Rs 1,556.00 credited to ICICI Bank Credit Card XX4006 on'
      + ' 23-JUL-25. Revised total due Rs 930.60, minimum due Rs .00', 'ICICIT',
    );
    assert.equal(refund.not_a_transaction, undefined);
    assert.equal(refund.amount, 1556);
  });

  it('keeps a cashback credit that opens with congratulations', async () => {
    const cashback = await sms.parseSmsText(
      'Congratulations! Cashback of INR 127 has been credited to your Axis Bank Flipkart'
      + ' Credit Card XX8495 towards your last month spends', 'AXISBK',
    );
    assert.equal(cashback.not_a_transaction, undefined);
    assert.equal(cashback.amount, 127);
  });

  it('recognises a salary that states the verb without a preposition', async () => {
    // "deposited in HDFC Bank" matched, and the same bank's bare "deposited" matched
    // nothing at all, so a salary went unrecorded.
    const bare = await sms.parseSmsText('INR 1,96,563.00 deposited to your account', 'VM-HDFCBK-S');
    assert.equal(bare.amount, 196563);
    assert.equal(bare.type, 'Income');
    assert.equal(bare.category, 'Salary');
  });

  it('files a credit card bill payment as a transfer rather than dropping it', async () => {
    /*
     * Filing it as income would book every rupee already spent as earnings, so it used to
     * be thrown away. That is not right either: the money moved, and a ledger that never
     * shows the card bill cannot explain where the bank balance went.
     */
    const payment = await sms.parseSmsText(
      'Thank you AU Bank Credit Cardholder! Payment of INR 2,472.00 was credited to your'
      + ' Card xx1234 on 06/08/2026', 'AUBANK',
    );
    assert.equal(payment.type, 'Transfer');
    assert.equal(payment.category, 'Transfer');
    assert.equal(payment.amount, 2472);
    assert.equal(payment.not_a_transaction, undefined);
  });

  it('leaves transfers out of what was earned and what was spent', async (t) => {
    const db = database.currentDatabase();
    const when = monthsAgo(1);
    const row = (type, category, amount) => db.run(
      'INSERT INTO transactions (member_id, date, amount, currency, type, category)'
      + " VALUES (1, ?, ?, 'INR', ?, ?)",
      [when, amount, type, category],
    );
    row('Income', 'Salary', 100000);
    row('Expense', 'Groceries', 20000);
    row('Transfer', 'Transfer', 45000);

    const summary = await ok(t, 'get_summary');
    const month = summary.months.find((entry) => entry.month === when.slice(0, 7));
    assert.ok(month, 'the month the rows were written into is in the summary');
    assert.equal(month.income, 100000);
    assert.equal(month.expense, 20000, 'the card bill is not a second month of shopping');
  });

  it('never treats a one time password as a transaction', async () => {
    const otp = await sms.parseSmsText('OTP for txn of Rs.5000 is 123456. Do not share', 'HDFCBK');
    assert.equal(otp.not_a_transaction, 'otp');
  });

  it('keeps a bank-specific rule on its own bank', async () => {
    const db = database.currentDatabase();
    db.run(
      "INSERT INTO sms_rules (rule_name, sender_keyword, body_trigger, transaction_type,"
      + " category_name, regex_pattern) VALUES ('Only ACME', 'ACMEBK', 'zzzunique',"
      + " 'Expense', 'Shopping', 'Rs\\.?\\s*([\\d,]+)')",
    );
    const wrong = await sms.parseSmsText('Rs 100 zzzunique happened', 'HDFCBK');
    assert.notEqual(wrong.matched_rule, 'Only ACME');
    const right = await sms.parseSmsText('Rs 100 zzzunique happened', 'VM-ACMEBK-S');
    assert.equal(right.matched_rule, 'Only ACME');
  });

  it('reads the vendor out of the message and categorises it from the dictionary', async () => {
    const result = await sms.parseSmsText(
      'Rs.499 spent on HDFC Bank Card x1234 at ZOMATO on 12-07-26', 'HDFCBK',
    );
    assert.equal(result.merchant, 'ZOMATO');
    assert.equal(result.merchant_key, 'zomato');
    assert.equal(result.category, 'Dining');
    assert.equal(result.category_source, 'dictionary');
  });

  it('does not match a keyword buried inside a longer word', async () => {
    // "nse" sits inside "expense" and "mall" inside "small". An unbounded table
    // categorises both and is worse than no table at all.
    const result = await sms.parseSmsText('Rs.100 debited towards small expense claim', 'X');
    assert.notEqual(result.category_source, 'dictionary');
  });

  it('learns a category from one correction and applies it to what is already filed', async () => {
    const db = database.currentDatabase();
    const insert = (merchant) => db.run(
      "INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant)"
      + " VALUES (1, '2026-01-01', 250, 'INR', 'Expense', 'Groceries', ?)", [merchant],
    );
    // The same vendor as three different acquirers spell it.
    insert('CAS*CITYFLO');
    insert('Cityflo Technologies Pvt Ltd');
    insert('CITYFLO');
    insert('SOMEWHERE ELSE');

    const learned = await sms.handleSmsAction({
      action: 'learn_category', merchant: 'CITYFLO', category: 'Travel',
    });
    assert.equal(learned.status, 'success');
    assert.equal(learned.merchant_key, 'cityflo');
    assert.equal(learned.applied, 3, 'all three spellings share one key');

    const travel = db.all("SELECT merchant FROM transactions WHERE category = 'Travel'");
    assert.equal(travel.length, 3);
    const untouched = db.get("SELECT category FROM transactions WHERE merchant = 'SOMEWHERE ELSE'");
    assert.equal(untouched.category, 'Groceries');
  });

  it('prefers what it was taught over what the dictionary ships', async () => {
    await sms.handleSmsAction({ action: 'learn_category', merchant: 'ZOMATO', category: 'Entertainment' });
    const result = await sms.parseSmsText('Rs.499 spent on HDFC Bank Card x1234 at ZOMATO on 12-07-26', 'HDFCBK');
    assert.equal(result.category, 'Entertainment');
    assert.equal(result.category_source, 'learned');
  });

  it('turns categorising one transaction into a rule that moves the rest', async () => {
    const db = database.currentDatabase();
    for (const merchant of ['CAS*CITYFLO', 'Cityflo Technologies Pvt Ltd']) {
      db.run(
        "INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant)"
        + " VALUES (1, '2026-01-01', 250, 'INR', 'Expense', 'Groceries', ?)", [merchant],
      );
    }

    const saved = await call('save_transaction', {
      transaction: {
        date: '2026-02-02', amount: 300, type: 'Expense', category: 'Travel', merchant: 'CITYFLO',
      },
    });
    assert.equal(saved.status, 'success');
    assert.equal(saved.also_categorised, 2, 'the two already filed moved with it');

    const travel = db.all("SELECT id FROM transactions WHERE category = 'Travel'");
    assert.equal(travel.length, 3);
    const rule = db.get("SELECT category_name FROM merchant_rules WHERE merchant_key = 'cityflo'");
    assert.equal(rule.category_name, 'Travel');
  });

  it('files a salary deposit as income', async () => {
    // The wording is "deposited", which the native pre-filter did not know, so these
    // never reached the classifier at all on a real device.
    const salary = await sms.parseSmsText(
      'Update! INR 1,96,563.00 deposited in HDFC Bank A/c XX1578 on 31-JUL-26 for NEFT Cr-ACME', 'VM-HDFCBK-S',
    );
    assert.equal(salary.amount, 196563);
    assert.equal(salary.type, 'Income');
    assert.equal(salary.category, 'Salary');
  });

  it('files a meal voucher credit as income, not as another lunch', async () => {
    // The employer funds this card, so the credit is money arriving. Calling it a
    // transfer left every wallet spend as an expense with no inflow behind it.
    const topup = await sms.parseSmsText(
      'Your Pluxee Card has been successfully credited with Rs.2200 towards Meal Wallet on Tue Apr 29 2025', 'VM-PLUXEE-S',
    );
    assert.equal(topup.not_a_transaction, undefined);
    assert.equal(topup.amount, 2200);
    assert.equal(topup.type, 'Income');
    // Dining is an expense category and would be nonsense on an income row.
    assert.equal(topup.category, 'Salary');

    const spend = await sms.parseSmsText(
      'Rs. 30.00 spent from Pluxee Meal wallet, card no.xx3120 on 13-02-2025 18:16:54 at ZOMATO . Avl bal Rs.11145.39', 'VM-PLUXEE-S',
    );
    assert.equal(spend.type, 'Expense');
    assert.equal(spend.amount, 30);
  });

  it('files a reviewed alert and learns a rule from it', async () => {
    const db = database.currentDatabase();
    db.run(
      "INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant)"
      + " VALUES (1, '2026-01-01', 90, 'INR', 'Expense', 'Groceries', 'CAS*KOMOREBI')",
    );

    const res = await sms.handleSmsAction({
      action: 'classify_alert',
      body: 'Rs.450 charged at KOMOREBI on 02-02-26',
      sender: 'VM-HDFCBK-S',
      date: '2026-02-02',
      amount: 450,
      type: 'Expense',
      category: 'Dining',
      merchant: 'KOMOREBI',
    });
    assert.equal(res.status, 'success');
    assert.equal(res.also_categorised, 1, 'the earlier spelling moved with it');

    const filed = db.get("SELECT amount, category FROM transactions WHERE raw_sms LIKE 'Rs.450%'");
    assert.equal(filed.amount, 450);
    assert.equal(filed.category, 'Dining');
    assert.equal(db.all("SELECT id FROM transactions WHERE category = 'Dining'").length, 2);
  });

  it('does not file a second message about a payment already recorded', async () => {
    const db = database.currentDatabase();
    // One payment, already filed from the bank's first message.
    db.run(
      "INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, raw_sms)"
      + " VALUES (1, '2026-08-04', 316, 'INR', 'Expense', 'Utilities', 'CCBBPSNO',"
      + " 'Bill Paid: AU Bank Credit Card Bill of Rs. 316.00 paid on 04-Aug-2026')",
    );

    // The bank's second message about the same payment shares no wording with the first,
    // so matching on the body cannot see it. What they share is the money and the day.
    const res = await sms.handleSmsAction({
      action: 'classify_alert',
      body: 'ALERT:Rs.316.00 spent via HDFC BANK Debit Card xx3120 at CCBBPSNO on Aug 4 2026 without PIN/OTP',
      date: '2026-08-04',
      amount: 316,
      type: 'Expense',
      category: 'Utilities',
      merchant: 'CCBBPSNO',
    });
    // Filing from the review screen is a deliberate act, so it is allowed and reported.
    assert.equal(res.status, 'success');
    assert.equal(res.duplicate_warning, true);
    assert.equal(db.all('SELECT id FROM transactions WHERE amount = 316').length, 2);
  });

  it('will not file a reviewed alert without an amount', async () => {
    const res = await sms.handleSmsAction({
      action: 'classify_alert', body: 'something', amount: 0, category: 'Dining',
    });
    assert.equal(res.status, 'error');
    assert.equal(res.code, 'AMOUNT_INVALID');
  });

  it('narrows the sync window to what has happened since the last one', async () => {
    /*
     * The receiver catches most of what arrives while the app is closed, but not all: the
     * queue holds two hundred, and a force stopped app is sent no broadcasts at all. A
     * sync covers the gap, and covering three months every time to find a day of messages
     * is work nobody needs.
     */
    const db = database.currentDatabase();

    // Never synced. It has to assume the worst and read the lot.
    const first = await sms.handleSmsAction({ action: 'reimport' });
    assert.equal(first.days, 90);

    const stamp = db.get("SELECT value FROM app_settings WHERE key = 'last_sms_sync'");
    assert.ok(stamp && stamp.value, 'the sync point was written');

    // Synced a moment ago: a day, plus one of overlap for anything that landed mid-sync.
    const again = await sms.handleSmsAction({ action: 'reimport' });
    assert.equal(again.days, 2);

    /*
     * Synced a fortnight and an hour ago. The extra hour is deliberate: exactly fourteen
     * days sits on a whole number, and whether the test crosses a millisecond while it
     * runs then decides whether it rounds to fourteen or fifteen. An hour puts it clearly
     * inside the fifteenth day, and the overlap day makes sixteen.
     */
    db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('last_sms_sync', ?)",
      [new Date(Date.now() - (14 * 86400000 + 3600000)).toISOString()]);
    const later = await sms.handleSmsAction({ action: 'reimport' });
    assert.equal(later.days, 16);

    // An explicit window still wins, which is what the read-everything button uses.
    const forced = await sms.handleSmsAction({ action: 'reimport', days: 90 });
    assert.equal(forced.days, 90);
  });

  it('keeps an ignored alert out of the review list', async () => {
    const db = database.currentDatabase();
    await sms.handleSmsAction({ action: 'ignore_alert', body: 'noise from a shop' });
    assert.equal(db.get('SELECT body FROM ignored_alerts').body, 'noise from a shop');
    const list = await sms.handleSmsAction({ action: 'unclassified' });
    assert.equal(list.status, 'success');
    assert.ok(Array.isArray(list.items));
  });

  it('gives a message that names nobody no merchant and no key', async () => {
    // A placeholder here is dangerous, not helpful. "Bank Alert" stood in for 245
    // different counterparties in one real inbox and normalises to a single key, so
    // categorising any one of them would have rewritten the other 244.
    const a = await sms.parseSmsText('INR 1210.00 deducted from HDFC Bank A/C No 1578', 'HDFCBK');
    const b = await sms.parseSmsText('INR 990.00 deducted from HDFC Bank A/C No 1578', 'HDFCBK');
    assert.equal(a.merchant, '');
    assert.equal(a.merchant_key, '');
    assert.equal(b.merchant_key, '');
    assert.equal(a.merchant_key, b.merchant_key, 'both empty, which must not be learnable');

    // And learning from one must not touch the other.
    const db = database.currentDatabase();
    for (const body of [a, b]) {
      db.run(
        'INSERT INTO transactions (member_id, date, amount, currency, type, category,'
        + ' merchant, merchant_key) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
        ['2026-01-01', body.amount, 'INR', 'Expense', 'Groceries', body.merchant, body.merchant_key],
      );
    }
    const refused = await sms.handleSmsAction({
      action: 'learn_category', merchant: '', category: 'Travel',
    });
    assert.equal(refused.status, 'error');
    assert.equal(db.all("SELECT id FROM transactions WHERE category = 'Travel'").length, 0);
  });

  it('refuses to learn from a message that names nobody', async () => {
    const result = await sms.handleSmsAction({ action: 'learn_category', merchant: '', category: 'Travel' });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'MERCHANT_UNKNOWN');
  });

  it('saves interest and time on a prepayment', async () => {
    const result = loan.optimizePrepayment(5000000, 8.5, 240, 5000);
    assert.ok(result.interest_saved > 0);
    assert.ok(result.months_saved > 0);
  });

  it('saves nothing when nothing extra is paid', async () => {
    assert.equal(loan.optimizePrepayment(5000000, 8.5, 240, 0).months_saved, 0);
  });

  it('scales the retirement target with what you spend', async () => {
    const modest = fire.calculateFireProjections({
      current_age: 30, target_retirement_age: 50, current_net_worth: 2000000,
      monthly_expenses: 60000, monthly_savings: 40000,
    });
    const lavish = fire.calculateFireProjections({
      current_age: 30, target_retirement_age: 50, current_net_worth: 2000000,
      monthly_expenses: 120000, monthly_savings: 40000,
    });

    assert.equal(modest.status, 'success');
    assert.ok(lavish.fire_number > modest.fire_number);
    assert.ok(modest.lean_fire < modest.fire_number);
    assert.ok(modest.fat_fire > modest.fire_number);
  });

  it('reports a stale statement and an instalment about to be debited', async (t) => {
    await ok(t, 'save_record', {
      record_type: 'sip',
      record: {
        scheme_name: 'An index fund',
        monthly_amount: 10000,
        debit_day: Math.min(28, new Date().getDate() + 2),
      },
    });
    const result = await reminders.checkReminders();
    assert.equal(result.status, 'success');
    assert.ok(result.reminders.some((reminder) => reminder.type === 'CAS_REFRESH'));
    assert.ok(result.reminders.some((reminder) => reminder.type === 'SIP_DUE'));
  });

  it('says nothing about a statement imported today', async (t) => {
    await ok(t, 'update_setting', {
      key: 'last_cas_upload_date',
      value: new Date().toISOString().slice(0, 10),
    });
    const result = await reminders.checkReminders();
    assert.ok(!result.reminders.some((reminder) => reminder.type === 'CAS_REFRESH'));
  });
});

describe('error handling', () => {
  it('reports an action it does not have', async () => {
    const result = await call('no_such_action');
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'UNKNOWN_ACTION');
    assert.ok(result.message.includes('no_such_action'));
  });

  it('refuses an unregistered code loudly rather than blankly', async () => {
    // A typo at a call site should be obvious, not reach a user as an empty code.
    const result = errors.fail('NOT_A_REAL_CODE', 'something broke');
    assert.equal(result.code, 'INTERNAL');
    assert.ok(result.message.includes('unregistered'));
  });

  it('keeps the hint and any extras', () => {
    const result = errors.fail('CAS_NOT_PDF', 'not a pdf', 'send the PDF', { detail: 'magic bytes' });
    assert.equal(result.code, 'CAS_NOT_PDF');
    assert.equal(result.hint, 'send the PDF');
    assert.equal(result.detail, 'magic bytes');
  });

  it('describes every registered code', () => {
    for (const [code, description] of Object.entries(errors.ERROR_CODES)) {
      assert.match(code, /^[A-Z][A-Z_]+$/, code);
      assert.ok(description.trim(), code);
    }
  });

  it('names the code for each known failure', async (t) => {
    await ok(t, 'set_pin', { new_pin: '4821' });
    const cases = [
      ['PIN_TOO_SHORT', await call('set_pin', { new_pin: '1' })],
      ['PIN_WRONG', await call('set_pin', { new_pin: '9999', current_pin: '0000' })],
      ['PIN_WRONG', await call('clear_pin', { current_pin: '0000' })],
      ['SETTING_PRIVATE', await call('update_setting', { key: 'pin_hash', value: 'x' })],
      ['METRIC_UNKNOWN', await call('get_series', { metric: 'nope' })],
      ['RECORD_TYPE_UNKNOWN', await call('list_records', { record_type: 'nope' })],
      ['RECORD_TYPE_UNKNOWN', await call('save_record', { record_type: 'nope', record: {} })],
      ['RECORD_EMPTY', await call('save_record', { record_type: 'sip', record: { zzz: 1 } })],
      ['AMOUNT_INVALID', await call('save_transaction', { transaction: { amount: 0 } })],
      ['NAME_REQUIRED', await call('add_family_member', { member: { name: '  ' } })],
      ['NAME_REQUIRED', await call('save_category', { category: { name: '' } })],
      ['BACKUP_PASSWORD_WEAK', await call('export_backup', { password: 'short' })],
      ['BACKUP_PASSWORD_MISSING', await call('import_backup', { backup_payload: 'x' })],
      ['UNKNOWN_ACTION', await call('nope')],
    ];

    for (const [expected, result] of cases) {
      assert.equal(result.status, 'error', JSON.stringify(result));
      assert.equal(result.code, expected, result.message);
    }
  });

  it('tells a wrong backup password apart from a bad request', async (t) => {
    await ok(t, 'save_transaction', {
      transaction: { amount: 100, category: 'Groceries', type: 'Expense' },
    });
    const exported = await ok(t, 'export_backup', { password: 'hunter2hunter2' });
    const result = await call('import_backup', {
      backup_payload: exported.backup_payload, password: 'definitely wrong',
    });
    assert.equal(result.code, 'BACKUP_DECRYPT_FAILED');
    assert.ok('hint' in result);
  });

  it('names a duplicate category', async (t) => {
    await ok(t, 'save_category', { category: { name: 'Chai', type: 'Expense' } });
    const result = await call('save_category', { category: { name: 'Chai' } });
    assert.equal(result.code, 'CATEGORY_DUPLICATE');
  });

  it('names the refusal to remove the primary profile', async (t) => {
    const { members } = await ok(t, 'get_family_members');
    const primary = members.find((member) => member.is_primary);
    const result = await call('delete_family_member', { member_id: primary.id });
    assert.equal(result.code, 'MEMBER_PRIMARY');
  });

  it('carries a registered code on every failure', async () => {
    const replies = [
      await call('nope'),
      await call('get_series', { metric: 'nope' }),
      await call('list_records', { record_type: null }),
      await call('save_transaction', { transaction: { amount: -1 } }),
      await call('export_backup'),
      await call('import_backup', { backup_payload: 'not encrypted', password: 'hunter2hunter2' }),
    ];
    for (const reply of replies) {
      assert.equal(reply.status, 'error', JSON.stringify(reply));
      assert.ok('code' in reply, JSON.stringify(reply));
      assert.ok(reply.code in errors.ERROR_CODES, reply.code);
    }
  });
});
