import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, Database } from './_harness.mjs';
import {
  APP_VERSION_NAME,
  APP_VERSION_CODE,
  MIGRATIONS,
  getDatabaseVersion,
  setDatabaseVersion,
  runMigrations,
  getVersionInfo,
  handleDbAction,
  initDb,
  useDatabase,
} from '../app/src/main/assets/www/js/backend/database.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('Database Schema Versioning & Sequential Migrations', () => {
  describe('Constants & Registry Integrity', () => {
    it('defines current app version name and version code', () => {
      assert.equal(typeof APP_VERSION_NAME, 'string');
      assert.equal(APP_VERSION_NAME, '1.0.5');
      assert.equal(typeof APP_VERSION_CODE, 'number');
      assert.equal(APP_VERSION_CODE, 11);
    });

    it('has sequentially ordered migrations up to APP_VERSION_CODE', () => {
      assert.ok(Array.isArray(MIGRATIONS));
      assert.ok(MIGRATIONS.length >= APP_VERSION_CODE);

      for (let i = 0; i < MIGRATIONS.length; i++) {
        const mig = MIGRATIONS[i];
        assert.equal(mig.versionCode, i + 1, `Migration at index ${i} must have versionCode ${i + 1}`);
        assert.ok(typeof mig.versionName === 'string' && mig.versionName.length > 0);
        assert.ok(typeof mig.description === 'string' && mig.description.length > 0);
        assert.ok(typeof mig.up === 'function', `Migration ${mig.versionCode} must provide an up(db) function`);
      }
    });
  });

  describe('Fresh Database Initialization', () => {
    it('stamps current version code and version name in app_settings and PRAGMA user_version', () => {
      const ver = getDatabaseVersion(db);
      assert.equal(ver.versionCode, APP_VERSION_CODE);
      assert.equal(ver.versionName, APP_VERSION_NAME);
      assert.equal(ver.userVersion, APP_VERSION_CODE);

      const codeRow = db.get("SELECT value FROM app_settings WHERE key = 'app_version_code'");
      assert.equal(codeRow.value, String(APP_VERSION_CODE));

      const nameRow = db.get("SELECT value FROM app_settings WHERE key = 'app_version'");
      assert.equal(nameRow.value, APP_VERSION_NAME);

      const schemaRow = db.get("SELECT value FROM app_settings WHERE key = 'schema_version'");
      assert.equal(schemaRow.value, String(APP_VERSION_CODE));
    });

    it('get_version_info DB action returns complete version metadata', async () => {
      const res = await handleDbAction({ action: 'get_version_info' });
      assert.equal(res.status, 'success');
      assert.equal(res.app_version, APP_VERSION_NAME);
      assert.equal(res.app_version_code, APP_VERSION_CODE);
      assert.equal(res.db_version, APP_VERSION_NAME);
      assert.equal(res.db_version_code, APP_VERSION_CODE);
      assert.equal(res.user_version, APP_VERSION_CODE);
      assert.equal(res.schema_version, APP_VERSION_CODE);
      assert.equal(res.is_latest, true);
    });
  });

  describe('getDatabaseVersion & setDatabaseVersion', () => {
    it('sets and reads version code and version name correctly', () => {
      setDatabaseVersion(db, 3, '1.0.2');
      const ver = getDatabaseVersion(db);
      assert.equal(ver.versionCode, 3);
      assert.equal(ver.versionName, '1.0.2');
      assert.equal(ver.userVersion, 3);

      const lastMig = db.get("SELECT value FROM app_settings WHERE key = 'last_migration_at'");
      assert.ok(lastMig && lastMig.value);
    });
  });

  describe('Sequential Migration Execution on Upgrade', () => {
    it('executes migrations sequentially from an older version code to current', async () => {
      // Create a fresh blank database simulating an older install at v1.0.2 (versionCode 3)
      const oldDb = await Database.open();
      oldDb.persist = false;
      useDatabase(oldDb);

      // Create base legacy tables
      oldDb.exec(`
        CREATE TABLE family_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          relationship TEXT NOT NULL,
          avatar_color TEXT DEFAULT '#10B981',
          is_primary INTEGER DEFAULT 0,
          notes TEXT,
          created_at TEXT
        );
        CREATE TABLE asset_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER DEFAULT 1,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          balance REAL DEFAULT 0.0
        );
        CREATE TABLE transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER DEFAULT 1,
          date TEXT NOT NULL,
          amount REAL NOT NULL,
          type TEXT NOT NULL,
          category TEXT NOT NULL,
          merchant TEXT
        );
        CREATE TABLE loans (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER DEFAULT 1,
          name TEXT NOT NULL,
          loan_type TEXT NOT NULL,
          principal_amount REAL NOT NULL,
          current_outstanding REAL NOT NULL,
          interest_rate REAL NOT NULL,
          tenure_months INTEGER NOT NULL,
          start_date TEXT NOT NULL,
          monthly_emi REAL NOT NULL
        );
        CREATE TABLE credit_cards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER DEFAULT 1,
          card_name TEXT NOT NULL,
          bank TEXT NOT NULL,
          last_4 TEXT,
          total_limit REAL NOT NULL,
          current_balance REAL DEFAULT 0.0
        );
        CREATE TABLE custom_categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          type TEXT NOT NULL,
          color TEXT DEFAULT '#10B981',
          icon TEXT DEFAULT 'sell'
        );
        CREATE TABLE app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      // Set old version code = 3 (v1.0.2)
      setDatabaseVersion(oldDb, 3, '1.0.2');

      // Add a transaction with raw SMS
      oldDb.run(
        "INSERT INTO transactions (member_id, date, amount, type, category, merchant) VALUES (1, '2026-08-01', 500, 'Expense', 'Dining', 'Cafe')",
      );

      // Verify that columns from v4 and v5 do not exist yet in transactions or credit_cards
      const txColsBefore = oldDb.all('PRAGMA table_info(transactions)').map((r) => r.name);
      assert.ok(!txColsBefore.includes('card_id'));

      const ccColsBefore = oldDb.all('PRAGMA table_info(credit_cards)').map((r) => r.name);
      assert.ok(!ccColsBefore.includes('available_limit'));

      // Run sequential migrations from 3 -> 9
      const applied = runMigrations(oldDb, 3, 9);
      assert.equal(applied.length, 6);
      assert.equal(applied[0].versionCode, 4);
      assert.equal(applied[1].versionCode, 5);
      assert.equal(applied[2].versionCode, 6);
      assert.equal(applied[3].versionCode, 7);
      assert.equal(applied[4].versionCode, 8);
      assert.equal(applied[5].versionCode, 9);

      // Verify version was upgraded to 9
      const verAfter = getDatabaseVersion(oldDb);
      assert.equal(verAfter.versionCode, 9);
      assert.equal(verAfter.versionName, '1.0.5');

      // Verify new tables and columns exist after migrations
      const txColsAfter = oldDb.all('PRAGMA table_info(transactions)').map((r) => r.name);
      assert.ok(txColsAfter.includes('card_id'));
      assert.ok(txColsAfter.includes('is_ignored'));
      assert.ok(txColsAfter.includes('is_duplicate'));

      const ccColsAfter = oldDb.all('PRAGMA table_info(credit_cards)').map((r) => r.name);
      assert.ok(ccColsAfter.includes('available_limit'));
      assert.ok(ccColsAfter.includes('updated_at'));

      const hasStockTxTable = Boolean(oldDb.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stock_transactions'"));
      assert.ok(hasStockTxTable);
    });

    it('initDb automatically detects older version and runs pending migrations', async () => {
      const upgradeDb = await Database.open();
      upgradeDb.persist = false;
      useDatabase(upgradeDb);

      // Create minimal DB simulating version 2
      upgradeDb.exec(`
        CREATE TABLE family_members (id INTEGER PRIMARY KEY, name TEXT, relationship TEXT, avatar_color TEXT, is_primary INTEGER, notes TEXT, created_at TEXT);
        CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO family_members (name, relationship, avatar_color, is_primary, created_at) VALUES ('You', 'Self', '#88A838', 1, '2026-08-01');
      `);
      setDatabaseVersion(upgradeDb, 2, '1.0.1');

      // Run initDb
      initDb(upgradeDb, true);

      const ver = getDatabaseVersion(upgradeDb);
      assert.equal(ver.versionCode, APP_VERSION_CODE);
      assert.equal(ver.versionName, APP_VERSION_NAME);

      // Verify version info action works
      const info = await handleDbAction({ action: 'get_version_info' });
      assert.equal(info.status, 'success');
      assert.equal(info.db_version_code, APP_VERSION_CODE);
      assert.equal(info.is_latest, true);
    });
  });
});
