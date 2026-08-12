/*
 * Dates, buckets and the two SQL fragments every aggregate needs.
 *
 * Everything that reads history has to agree on what "this week" means and where a month
 * starts, so the arithmetic lives here rather than three times over. A bucket is named by
 * a key that sorts as text: `YYYY-MM` for a month, and the ISO date of the first day for a
 * week or a day. That way a bucket key is also a date range, and the two are never out of
 * step with each other.
 *
 * Weeks start on Monday, which is the convention a salary month and a bank statement both
 * follow here.
 */

export const GRANULARITIES = ['day', 'week', 'month'];

export function pad(value) {
  return String(value).padStart(2, '0');
}

export function isoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function today() {
  return isoDate(new Date());
}

/**
 * A local date from a stored one.
 *
 * Plain `new Date('2026-08-12')` is parsed as UTC, which lands on the day before in a
 * negative offset and on the same day everywhere else. That is the sort of bug that only
 * appears on somebody else's phone, so the parts are read out and built locally.
 */
export function parseISO(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The filter for one household member, or nothing at all for everybody. */
export function memberClause(memberId, prefix = 'WHERE') {
  if (memberId === null || memberId === undefined || String(memberId).toLowerCase() === 'all') {
    return ['', []];
  }
  return [` ${prefix} member_id = ?`, [Number.parseInt(memberId, 10)]];
}

/** The first day of a month and of the one after it, `offset` months back. */
export function monthBounds(offset = 0) {
  const now = new Date();
  let month = now.getMonth() + 1 - offset;
  let year = now.getFullYear();
  while (month < 1) {
    month += 12;
    year -= 1;
  }
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return [`${year}-${pad(month)}-01`, `${nextYear}-${pad(nextMonth)}-01`];
}

/** The last `count` month keys, oldest first. */
export function monthKeys(count) {
  return bucketKeys('month', count);
}

/** Months added to a date, clamping the day so 31 January plus a month is 28 February. */
export function addMonths(date, months) {
  const year = date.getFullYear();
  const month = date.getMonth() + months;
  const target = new Date(year, month, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), lastDay));
  return target;
}

/** The Monday of the week a date falls in. */
export function weekStart(value) {
  const date = parseISO(value);
  if (!date) return '';
  const shift = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - shift);
  return isoDate(date);
}

/** 'day', 'week' or 'month' from whatever the UI sent, or null if it was none of them. */
export function normaliseGranularity(value, fallback = 'month') {
  const wanted = String(value ?? fallback).toLowerCase();
  if (GRANULARITIES.includes(wanted)) return wanted;
  // The plural and the adjective are both natural things for a caller to send.
  const aliases = {
    daily: 'day', weekly: 'week', monthly: 'month', days: 'day', weeks: 'week', months: 'month',
  };
  return aliases[wanted] || null;
}

/** Which bucket a date belongs to, at the given granularity. */
export function bucketFor(date, granularity) {
  const text = String(date ?? '');
  if (granularity === 'month') return text.slice(0, 7);
  if (granularity === 'day') return text.slice(0, 10);
  return weekStart(text);
}

/**
 * The last `count` buckets, oldest first, ending `offset` buckets before the current one.
 *
 * The offset is what makes a drilldown possible: the same call with an offset of one is
 * last month, or last week, without the caller having to do calendar arithmetic to say so.
 */
export function bucketKeys(granularity, count, offset = 0) {
  const total = Math.max(1, Math.floor(count));
  const back = Math.max(0, Math.floor(offset));
  const keys = [];

  if (granularity === 'month') {
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth() + 1 - back;
    while (month < 1) {
      month += 12;
      year -= 1;
    }
    for (let i = 0; i < total; i += 1) {
      keys.push(`${year}-${pad(month)}`);
      month -= 1;
      if (month === 0) {
        month = 12;
        year -= 1;
      }
    }
  } else {
    const step = granularity === 'week' ? 7 : 1;
    const cursor = granularity === 'week' ? parseISO(weekStart(today())) : new Date();
    cursor.setDate(cursor.getDate() - back * step);
    for (let i = 0; i < total; i += 1) {
      keys.push(isoDate(cursor));
      cursor.setDate(cursor.getDate() - step);
    }
  }

  return keys.reverse();
}

/** The half-open range one bucket covers: start inclusive, end exclusive. */
export function bucketRange(granularity, key) {
  if (granularity === 'month') {
    const [year, month] = String(key).split('-').map(Number);
    if (!year || !month) return ['', ''];
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    return [`${year}-${pad(month)}-01`, `${nextYear}-${pad(nextMonth)}-01`];
  }

  const start = parseISO(key);
  if (!start) return ['', ''];
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + (granularity === 'week' ? 7 : 1));
  return [isoDate(start), isoDate(end)];
}

/** The range a whole run of buckets covers. */
export function windowRange(granularity, keys) {
  if (!keys.length) return ['', ''];
  const [from] = bucketRange(granularity, keys[0]);
  const [, to] = bucketRange(granularity, keys[keys.length - 1]);
  return [from, to];
}

/** Whole days between two stored dates, or null if either is unreadable. */
export function daysBetween(from, to) {
  const a = parseISO(from);
  const b = parseISO(to);
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * The window of the same length immediately before this one, for a comparison.
 *
 * Measured in days rather than in calendar steps, so a month against the month before it
 * compares 31 days with 31 days. February against January is the price of that, and it is
 * a smaller lie than comparing a part-month with a whole one.
 */
export function previousWindow(from, to) {
  const span = daysBetween(from, to);
  if (span === null || span <= 0) return ['', ''];
  const start = parseISO(from);
  const earlier = new Date(start.getTime());
  earlier.setDate(earlier.getDate() - span);
  return [isoDate(earlier), from];
}

/** Days in the range, at least one, for a per-day average. */
export function spanDays(from, to) {
  const span = daysBetween(from, to);
  return span && span > 0 ? span : 1;
}
