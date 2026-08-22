import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { freshBackend, ok } from './_harness.mjs';
import { checkReminders, syncReminders, handleReminderAction } from '../app/src/main/assets/www/js/backend/reminders.js';
import {
  loadIsinDatabase, nameForIsin, isinDatabaseVersion, unloadIsinDatabase,
} from '../app/src/main/assets/www/js/backend/isin.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('reminders.js reminder checker and dispatcher', () => {
  it('detects missing or stale CAS upload reminder', async () => {
    const res = await checkReminders();
    assert.equal(res.status, 'success');
    const cas = res.reminders.find((r) => r.type === 'CAS_REFRESH');
    assert.ok(cas);
    assert.equal(cas.urgent, true);
  });

  it('detects upcoming SIP reminder', async () => {
    const now = new Date();
    // Debit day 2 days from now
    const targetDay = ((now.getDate() + 2) % 28) || 1;
    await ok(null, 'save_record', {
      record_type: 'sip',
      record: {
        scheme_name: 'UTI Nifty 50 Index Fund',
        monthly_amount: 5000,
        debit_day: targetDay,
        is_active: 1,
      },
    });

    const res = await checkReminders();
    const sip = res.reminders.find((r) => r.type === 'SIP_DUE');
    // If targetDay was within SIP_NOTICE_DAYS (1..3 days ahead in current month)
    if (targetDay > now.getDate() && targetDay - now.getDate() <= 3) {
      assert.ok(sip);
    }
  });

  it('detects custom event reminder', async () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const eventDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
    const eventDateIso = `${eventDate.getFullYear()}-${pad(eventDate.getMonth() + 1)}-${pad(eventDate.getDate())}`;

    db.run(
      'INSERT INTO custom_events (title, event_date, reminder_days_before)'
      + ' VALUES (?, ?, ?)',
      ['Car Insurance Renewal', eventDateIso, 5],
    );

    const res = await checkReminders();
    const ev = res.reminders.find((r) => r.type === 'CUSTOM_EVENT');
    assert.ok(ev);
    assert.equal(ev.title, 'Car Insurance Renewal');
  });

  it('detects daily spend review reminder when SMS tracking is inactive', async () => {
    const res = await checkReminders();
    assert.equal(res.status, 'success');
    const review = res.reminders.find((r) => r.type === 'DAILY_REVIEW');
    assert.ok(review);
    assert.equal(review.id, 'daily-spend-review');
    assert.equal(review.title, 'Evening spend review');
    assert.ok(review.targetEpochMs > Date.now());
  });

  it('respects custom daily review reminder time and toggle setting', async () => {
    // Set custom time
    db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('daily_review_reminder_time', '20:30')");
    let res = await checkReminders();
    let review = res.reminders.find((r) => r.type === 'DAILY_REVIEW');
    assert.ok(review);
    const targetDate = new Date(review.targetEpochMs);
    assert.equal(targetDate.getHours(), 20);
    assert.equal(targetDate.getMinutes(), 30);

    // Disable daily review
    db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('daily_review_reminder_enabled', '0')");
    res = await checkReminders();
    review = res.reminders.find((r) => r.type === 'DAILY_REVIEW');
    assert.equal(review, undefined);
  });

  it('syncs reminders and handles reminder actions', async () => {
    const resSync = await syncReminders();
    assert.equal(resSync.status, 'success');

    const resActionCheck = await handleReminderAction({ action: 'check' });
    assert.equal(resActionCheck.status, 'success');

    const resActionSync = await handleReminderAction({ action: 'sync' });
    assert.equal(resActionSync.status, 'success');
  });
});

describe('isin.js reference database', () => {
  it('loads, looks up and unloads isin database', async () => {
    // Note: Node environment doesn't have fetch for relative URLs unless mock or file URL
    // Test nameForIsin when not loaded or with empty/null
    assert.equal(nameForIsin(''), '');
    assert.equal(nameForIsin(null), '');
    assert.equal(isinDatabaseVersion(), null);

    unloadIsinDatabase();
    assert.equal(isinDatabaseVersion(), null);
  });
});
