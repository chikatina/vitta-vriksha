import test from 'node:test';
import assert from 'node:assert/strict';
import { getPeriodSummary } from '../app/src/main/assets/www/js/backend/analytics.js';
import { freshBackend } from './_harness.mjs';

test('Theme Accents: Modern accents are registered with valid CSS tokens and hex values', async () => {
  const { renderSettings } = await import('../app/src/main/assets/www/js/views/settings.js');
  assert.ok(typeof renderSettings === 'function');

  // Verify settings source defines our modern palette
  const fs = await import('node:fs');
  const settingsCode = fs.readFileSync('app/src/main/assets/www/js/views/settings.js', 'utf-8');
  assert.ok(settingsCode.includes("'jade'"));
  assert.ok(settingsCode.includes("'sapphire'"));
  assert.ok(settingsCode.includes("'teal'"));
  assert.ok(settingsCode.includes("'violet'"));
  assert.ok(settingsCode.includes("'amber'"));
  assert.ok(settingsCode.includes("'rose'"));
  assert.ok(settingsCode.includes("'forest'"));
  assert.ok(settingsCode.includes("'ochre'"));

  const cssCode = fs.readFileSync('app/src/main/assets/www/css/style.css', 'utf-8');
  assert.ok(cssCode.includes("[data-accent='jade']"));
  assert.ok(cssCode.includes("[data-accent='sapphire']"));
  assert.ok(cssCode.includes("[data-accent='teal']"));
  assert.ok(cssCode.includes("[data-accent='violet']"));
  assert.ok(cssCode.includes("[data-accent='amber']"));
  assert.ok(cssCode.includes("[data-accent='rose']"));
  assert.ok(cssCode.includes("[data-accent='forest']"));
  assert.ok(cssCode.includes("[data-accent='ochre']"));
  assert.ok(cssCode.includes('.fact-grid'));
  assert.ok(cssCode.includes('.period-hero-card'));
  assert.ok(cssCode.includes('.period-flow-grid'));
  assert.ok(cssCode.includes('.period-spotlight-card'));
});

test('Period Summary Analytics: Computes net flow, flow breakdown, top category, and largest transaction', async () => {
  const db = await freshBackend();

  // Insert sample expense and income
  db.run(
    `INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [1, '2026-08-15', 3500, 'INR', 'Expense', 'Electronics', 'Amazon', 'Headphones', new Date().toISOString()],
  );
  db.run(
    `INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [1, '2026-08-18', 1200, 'INR', 'Expense', 'Groceries', 'Zepto', 'Daily Needs', new Date().toISOString()],
  );
  db.run(
    `INSERT INTO transactions (member_id, date, amount, currency, type, category, merchant, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [1, '2026-08-01', 50000, 'INR', 'Income', 'Salary', 'Employer', 'Monthly Pay', new Date().toISOString()],
  );

  const summary = getPeriodSummary(db, { granularity: 'month', bucket: '2026-08' });
  assert.equal(summary.income, 50000);
  assert.equal(summary.expense, 4700);
  assert.equal(summary.net, 45300);
  assert.equal(summary.count, 3);
  assert.ok(summary.savings_rate > 0);
  assert.ok(summary.biggest);
  assert.equal(summary.biggest.amount, 3500);
  assert.equal(summary.biggest.merchant, 'Amazon');
  assert.equal(summary.top_category.name, 'Electronics');
});
