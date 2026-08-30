/*
 * What is about to need attention.
 *
 * Four sources: a statement that has gone stale, an instalment about to be debited,
 * a dated event the user asked to be reminded about, and a daily evening review check-in
 * to review daily expenses (especially when SMS tracking is not active). Deciding which
 * ones are due is arithmetic on dates and belongs here; raising a notification at the
 * right moment needs an alarm that outlives the app, so that part is handed to the shell.
 */

import { getDatabase, initDb } from './database.js';
import {
  cancelReminder, checkPermission, isSmsTrackingEnabled, scheduleReminder,
} from './native.js';
import { isUnlocked, vaultExists } from './vault.js';

/** How old a statement gets before it is worth re-importing. */
const CAS_STALE_DAYS = 30;

/** How close an instalment has to be before it is worth mentioning. */
const SIP_NOTICE_DAYS = 3;

/** The default hour of the day a morning scheduled notification fires. */
const NOTIFY_HOUR = 9;

function todayParts() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function toDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(text || ''));
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function startOfToday() {
  const { year, month, day } = todayParts();
  return new Date(year, month - 1, day);
}

function daysBetween(from, to) {
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function isoToday() {
  const { year, month, day } = todayParts();
  const pad = (value) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

function isoDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Everything currently due, newest concern first. */
export async function checkReminders() {
  if (vaultExists() && !isUnlocked()) {
    return { status: 'success', total_reminders: 0, reminders: [] };
  }

  const db = await getDatabase();
  initDb(db);

  const reminders = [];
  const today = startOfToday();

  // A statement that has gone stale. Values drift with the market, and an unimported
  // statement is the one thing that makes every other number on the dashboard wrong.
  const lastUpload = db.get("SELECT value FROM app_settings WHERE key = 'last_cas_upload_date'");
  const lastDate = lastUpload && lastUpload.value ? toDate(lastUpload.value) : null;
  const daysSince = lastDate ? daysBetween(lastDate, today) : 0;

  if (!lastDate || daysSince >= CAS_STALE_DAYS) {
    reminders.push({
      id: 'cas-refresh',
      type: 'CAS_REFRESH',
      title: 'Time to refresh your statement',
      message: lastDate
        ? `Your last statement is ${daysSince} days old. Import a fresh one to bring the `
          + 'fund values and unit balances up to date.'
        : 'No statement has been imported yet. Importing one fills in your fund holdings.',
      urgent: true,
      due: isoToday(),
    });
  }

  // An instalment about to be debited.
  for (const sip of db.all('SELECT * FROM sips WHERE is_active = 1')) {
    const day = Number(sip.debit_day);
    if (!day) continue;

    let daysAway = day - today.getDate();
    if (daysAway <= 0) {
      const daysInThisMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
      daysAway = (daysInThisMonth - today.getDate()) + day;
    }
    if (daysAway <= 0 || daysAway > SIP_NOTICE_DAYS) continue;

    const due = new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysAway);
    reminders.push({
      id: `sip-${sip.id}`,
      type: 'SIP_DUE',
      title: `Instalment due in ${daysAway} day${daysAway === 1 ? '' : 's'}`,
      message: `${sip.scheme_name} is scheduled for day ${day} of the month.`,
      amount: sip.monthly_amount,
      urgent: false,
      due: isoDate(due),
    });
  }

  // A dated event, within the notice the user asked for.
  for (const event of db.all('SELECT * FROM custom_events WHERE event_date >= ?', [isoToday()])) {
    const date = toDate(event.event_date);
    if (!date) continue;
    const daysLeft = daysBetween(today, date);
    const notice = Number(event.reminder_days_before ?? 3);
    if (daysLeft < 0 || daysLeft > notice) continue;

    reminders.push({
      id: `event-${event.id}`,
      type: 'CUSTOM_EVENT',
      title: event.title,
      message: `${event.title} is due on ${event.event_date}, ${daysLeft} day`
        + `${daysLeft === 1 ? '' : 's'} from now.`,
      urgent: daysLeft <= 1,
      due: event.event_date,
    });
  }

  // Daily spend review reminder:
  // When SMS tracking is not active (or explicitly enabled in settings), schedule an evening
  // check-in reminder to help users review and record daily expenses.
  const reviewEnabled = db.get("SELECT value FROM app_settings WHERE key = 'daily_review_reminder_enabled'");
  const isReviewOn = reviewEnabled ? reviewEnabled.value === '1' : true;
  const smsActive = checkPermission('SMS') && isSmsTrackingEnabled();

  if (isReviewOn && (!smsActive || reviewEnabled?.value === '1')) {
    const reviewTime = db.get("SELECT value FROM app_settings WHERE key = 'daily_review_reminder_time'");
    const timeStr = (reviewTime && reviewTime.value) || '21:00';
    const [hourStr, minStr] = timeStr.split(':');
    const hour = Number.parseInt(hourStr || '21', 10);
    const minute = Number.parseInt(minStr || '0', 10);

    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    reminders.push({
      id: 'daily-spend-review',
      type: 'DAILY_REVIEW',
      title: 'Evening spend review',
      message: "Take a moment to review or record today's expenses.",
      urgent: false,
      due: isoDate(target),
      targetEpochMs: target.getTime(),
    });
  }

  return { status: 'success', total_reminders: reminders.length, reminders };
}

/**
 * Hands the due reminders to the platform's alarm clock.
 *
 * Every alarm is replaced rather than added to, so running this twice in a day does not
 * produce two notifications. An alarm whose moment has already passed is skipped: a
 * notification about something that happened yesterday is noise.
 */
export async function syncReminders() {
  const { reminders } = await checkReminders();
  const now = Date.now();
  let scheduled = 0;

  for (const reminder of reminders) {
    cancelReminder(reminder.id);
    let triggerTime = reminder.targetEpochMs;
    if (!triggerTime) {
      const due = toDate(reminder.due);
      if (!due) continue;
      due.setHours(NOTIFY_HOUR, 0, 0, 0);
      triggerTime = due.getTime();
    }
    if (triggerTime <= now) continue;
    if (scheduleReminder(reminder.id, triggerTime, reminder.title, reminder.message)) {
      scheduled += 1;
    }
  }
  return { status: 'success', scheduled, total_reminders: reminders.length, reminders };
}

export async function handleReminderAction(args = {}) {
  try {
    if (args.action === 'sync') return await syncReminders();
    return await checkReminders();
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

