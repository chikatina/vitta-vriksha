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
      assert.equal(APP_VERSION_NAME, '1.0.8');
      assert.equal(typeof APP_VERSION_CODE, 'number');
      assert.equal(APP_VERSION_CODE, 14);
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

    it('seamlessly upgrades from production v1.0.7 (versionCode 13) to v1.0.8', async () => {
      const v107Db = await Database.open();
      v107Db.persist = false;
      useDatabase(v107Db);

      // Create v1.0.7 baseline schema where folio_transactions and stock_transactions
      // do NOT have parent_txn_id or stamp_duty columns, and sip_mandates does not exist.
      v107Db.exec(`
        CREATE TABLE family_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          relationship TEXT NOT NULL,
          avatar_color TEXT DEFAULT '#10B981',
          is_primary INTEGER DEFAULT 0,
          notes TEXT,
          created_at TEXT
        );
        INSERT INTO family_members (name, relationship, avatar_color, is_primary, created_at) VALUES ('You', 'Self', '#88A838', 1, '2026-08-01');

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
          account_id INTEGER,
          card_id INTEGER,
          date TEXT NOT NULL,
          amount REAL NOT NULL,
          currency TEXT DEFAULT 'INR',
          type TEXT NOT NULL,
          category TEXT NOT NULL,
          merchant TEXT,
          merchant_key TEXT,
          description TEXT,
          is_investment_outflow INTEGER DEFAULT 0,
          raw_sms TEXT,
          is_ignored INTEGER DEFAULT 0,
          is_duplicate INTEGER DEFAULT 0,
          created_at TEXT
        );

        CREATE TABLE sips (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER DEFAULT 1,
          name TEXT NOT NULL,
          amount REAL NOT NULL,
          debit_day INTEGER NOT NULL,
          step_up_percent REAL DEFAULT 0.0,
          is_active INTEGER DEFAULT 1,
          start_date TEXT,
          step_up_month INTEGER DEFAULT 0,
          linked_merchant_key TEXT
        );

        CREATE TABLE mf_folios (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER DEFAULT 1,
          folio_number TEXT,
          amc TEXT,
          scheme_name TEXT NOT NULL,
          isin TEXT,
          units REAL DEFAULT 0.0,
          nav REAL DEFAULT 0.0,
          current_value REAL DEFAULT 0.0,
          invested_value REAL DEFAULT 0.0,
          last_updated TEXT,
          source TEXT DEFAULT '',
          scope TEXT DEFAULT ''
        );

        CREATE TABLE folio_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER DEFAULT 1,
          folio_number TEXT,
          isin TEXT,
          scheme_name TEXT,
          date TEXT NOT NULL,
          description TEXT,
          kind TEXT,
          amount REAL DEFAULT 0.0,
          units REAL DEFAULT 0.0,
          nav REAL DEFAULT 0.0,
          balance REAL DEFAULT 0.0,
          last_updated TEXT
        );

        CREATE TABLE stock_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER DEFAULT 1,
          broker TEXT DEFAULT '',
          dp_id TEXT,
          client_id TEXT,
          isin TEXT NOT NULL,
          symbol TEXT NOT NULL,
          exchange TEXT DEFAULT 'NSE',
          trade_type TEXT NOT NULL,
          trade_date TEXT NOT NULL,
          quantity REAL NOT NULL,
          price REAL NOT NULL,
          stt REAL DEFAULT 0.0,
          charges REAL DEFAULT 0.0,
          order_id TEXT,
          trade_id TEXT,
          notes TEXT
        );

        CREATE TABLE credit_cards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER DEFAULT 1,
          card_name TEXT NOT NULL,
          bank TEXT NOT NULL,
          last_4 TEXT,
          total_limit REAL NOT NULL,
          available_limit REAL DEFAULT NULL,
          current_balance REAL DEFAULT 0.0,
          due_date INTEGER DEFAULT 1,
          notes TEXT,
          linked_merchant_key TEXT,
          updated_at TEXT
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

        CREATE TABLE subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER DEFAULT 1,
          name TEXT NOT NULL,
          cost REAL NOT NULL,
          currency TEXT DEFAULT 'INR',
          billing_cycle TEXT DEFAULT 'Monthly',
          next_billing_date TEXT NOT NULL,
          category TEXT DEFAULT 'Entertainment',
          auto_debit INTEGER DEFAULT 1,
          annual_change_percent REAL DEFAULT 0.0,
          price_since TEXT,
          linked_merchant_key TEXT
        );

        CREATE TABLE goals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER DEFAULT 1,
          title TEXT NOT NULL,
          target_amount REAL NOT NULL,
          current_amount REAL DEFAULT 0.0,
          target_date TEXT NOT NULL,
          category TEXT DEFAULT 'General',
          notes TEXT
        );

        CREATE TABLE custom_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER DEFAULT 1,
          title TEXT NOT NULL,
          event_date TEXT NOT NULL,
          event_type TEXT DEFAULT 'Financial',
          notes TEXT,
          reminder_days_before INTEGER DEFAULT 3
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

      // Set v1.0.7 version metadata (versionCode 13)
      setDatabaseVersion(v107Db, 13, '1.0.7');

      // Insert an unlinked mutual fund purchase and its stamp duty entry
      v107Db.run(
        "INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, kind, amount, units, nav) VALUES (1, '12345/0', 'INF209K01165', 'Parag Parikh Flexi Cap Fund', '2026-08-01', 'Purchase', 'PURCHASE', 5000, 72.15, 69.30)",
      );
      v107Db.run(
        "INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, kind, amount, units, nav) VALUES (1, '12345/0', 'INF209K01165', 'Parag Parikh Flexi Cap Fund', '2026-08-01', 'Stamp Duty', 'STAMP_DUTY_TAX', 0.25, 0, 0)",
      );

      // Verify parent_txn_id does NOT exist yet in folio_transactions
      const colsBefore = v107Db.all('PRAGMA table_info(folio_transactions)').map((r) => r.name);
      assert.ok(!colsBefore.includes('parent_txn_id'));
      assert.ok(!colsBefore.includes('stamp_duty'));

      // Run initDb to execute sequential migrations (13 -> 14)
      initDb(v107Db, true);

      // Verify version was upgraded to 14 (v1.0.8)
      const verAfter = getDatabaseVersion(v107Db);
      assert.equal(verAfter.versionCode, 14);
      assert.equal(verAfter.versionName, '1.0.8');

      // Verify new tables created
      const hasMandates = Boolean(v107Db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sip_mandates'"));
      const hasExecutions = Boolean(v107Db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sip_executions'"));
      assert.ok(hasMandates);
      assert.ok(hasExecutions);

      // Verify columns and indexes added
      const colsAfter = v107Db.all('PRAGMA table_info(folio_transactions)').map((r) => r.name);
      assert.ok(colsAfter.includes('parent_txn_id'));
      assert.ok(colsAfter.includes('stamp_duty'));
      assert.ok(colsAfter.includes('stt'));
      assert.ok(colsAfter.includes('charges'));

      const hasParentIdx = Boolean(v107Db.get("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_folio_txn_parent'"));
      assert.ok(hasParentIdx);

      // Verify statutory cost linking executed during migration
      const parentRow = v107Db.get("SELECT * FROM folio_transactions WHERE kind = 'PURCHASE'");
      const dutyRow = v107Db.get("SELECT * FROM folio_transactions WHERE kind = 'STAMP_DUTY_TAX'");
      assert.equal(dutyRow.parent_txn_id, parentRow.id);
      assert.equal(parentRow.stamp_duty, 0.25);
    });
  });
});
