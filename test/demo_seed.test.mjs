import test from 'node:test';
import assert from 'node:assert/strict';
import { freshBackend, call } from './_harness.mjs';
import { seedDemoData } from '../app/src/main/assets/www/js/demo-seed.js';
import { isDebug } from '../app/src/main/assets/www/js/backend/native.js';

test('seedDemoData inserts assets, debts, transactions, and investments', async () => {
  await freshBackend();
  await seedDemoData({});
  const summary = await call('get_summary');
  const investments = await call('list_investments');

  assert.ok(summary.total_assets > 0, `Assets should be > 0, got ${summary.total_assets}`);
  assert.ok(summary.total_liabilities > 0, `Liabilities should be > 0, got ${summary.total_liabilities}`);
  assert.ok(summary.net_worth > 0, `Net worth should be > 0, got ${summary.net_worth}`);
});

test('isDebug detects release vs debug Android builds', () => {
  // Test native bridge isDebug hook
  globalThis.AndroidBridge = {
    isDebug() { return false; },
  };
  assert.equal(isDebug(), false, 'Should return false when Android release build (BuildConfig.DEBUG == false)');

  globalThis.AndroidBridge = {
    isDebug() { return true; },
  };
  assert.equal(isDebug(), true, 'Should return true when Android debug build (BuildConfig.DEBUG == true)');

  delete globalThis.AndroidBridge;
});

