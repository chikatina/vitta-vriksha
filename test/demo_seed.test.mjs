import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './_harness.mjs';
import { useDatabase, invoke } from '../app/src/main/assets/www/js/backend/index.js';
import { seedDemoData } from '../app/src/main/assets/www/js/demo-seed.js';

test('seedDemoData inserts assets, debts, transactions, and investments', async () => {
  const db = freshDatabase();
  useDatabase(db);
  await seedDemoData({});
  const summary = await invoke('db', { action: 'get_summary' });
  console.log('SUMMARY RESULT:', summary);
  const investments = await invoke('db', { action: 'list_investments' });
  console.log('INVESTMENTS RESULT:', investments);

  assert.ok(summary.total_assets > 0, `Assets should be > 0, got ${summary.total_assets}`);
  assert.ok(summary.total_liabilities > 0, `Liabilities should be > 0, got ${summary.total_liabilities}`);
  assert.ok(summary.net_worth > 0, `Net worth should be > 0, got ${summary.net_worth}`);
});
