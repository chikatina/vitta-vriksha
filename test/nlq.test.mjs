import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTemporalWindow } from '../app/src/main/assets/www/js/backend/nlq.js';

test('NLQ: parseTemporalWindow expressions', () => {
  const todayWindow = parseTemporalWindow('how much did I spend today?');
  assert.equal(todayWindow.label, 'today');
  assert.ok(todayWindow.from && todayWindow.to);

  const monthWindow = parseTemporalWindow('groceries this month');
  assert.equal(monthWindow.label, 'this month');

  const lastMonthWindow = parseTemporalWindow('swiggy last month');
  assert.equal(lastMonthWindow.label, 'last month');

  const augWindow = parseTemporalWindow('spent in August 2026');
  assert.ok(augWindow.label.includes('August 2026'));
  assert.equal(augWindow.from, '2026-08-01');
  assert.equal(augWindow.to, '2026-09-01');
});
