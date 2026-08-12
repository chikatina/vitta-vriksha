import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend } from './_harness.mjs';
import {
  isUnlocked, unlockVault, lockVault, changeVaultPin,
  vaultExists, createVault, lockoutRemaining, failedAttempts,
} from '../app/src/main/assets/www/js/backend/vault.js';
import { Database } from '../app/src/main/assets/www/js/backend/sqlite.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('vault.js PIN and vault state management', () => {
  it('manages vault lock and unlock state', async () => {
    // When no PIN is set, vaultExists is false
    assert.equal(vaultExists(), false);
    assert.equal(isUnlocked(), false);

    // Setting a PIN
    await createVault('1234');
    assert.equal(vaultExists(), true);
    assert.equal(isUnlocked(), true);

    // Locking
    lockVault();
    assert.equal(isUnlocked(), false);

    // Unlocking with wrong and right PIN
    await assert.rejects(
      async () => unlockVault('0000'),
      /not your PIN/,
    );
    assert.equal(await unlockVault('1234'), true);
    assert.equal(isUnlocked(), true);

    // Changing PIN
    await changeVaultPin('1234', '5678');
    lockVault();
    await assert.rejects(
      async () => unlockVault('1234'),
      /not your PIN/,
    );
    assert.equal(await unlockVault('5678'), true);
  });
});

describe('sqlite.js WASM database binding', () => {
  it('handles transactions, queries, errors and exports', async () => {
    const memoryDb = await Database.open();
    memoryDb.exec('CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT, val REAL)');

    // Transaction
    memoryDb.transaction(() => {
      memoryDb.run('INSERT INTO test_table (name, val) VALUES (?, ?)', ['Item A', 100.5]);
      memoryDb.run('INSERT INTO test_table (name, val) VALUES (?, ?)', ['Item B', 200.75]);
    });

    const rows = memoryDb.all('SELECT * FROM test_table ORDER BY id');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, 'Item A');

    const single = memoryDb.get('SELECT * FROM test_table WHERE id = ?', [1]);
    assert.equal(single.name, 'Item A');

    const val = memoryDb.value('SELECT val FROM test_table WHERE id = ?', [2]);
    assert.equal(val, 200.75);

    // Export and read-only open
    const bytes = memoryDb.export();
    assert.ok(bytes instanceof Uint8Array);
    assert.ok(bytes.length > 0);

    const roDb = await Database.openReadOnly(bytes);
    const roVal = roDb.value('SELECT COUNT(*) FROM test_table');
    assert.equal(roVal, 2);

    roDb.close();
    memoryDb.close();
  });
});
