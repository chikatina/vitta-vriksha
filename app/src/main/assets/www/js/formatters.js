/* Number, money and date formatting. Indian conventions by default. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/*
 * Hiding the figures.
 *
 * For handing the phone to somebody, sitting on a train, or taking a screenshot to send to
 * a developer. Every amount in the app is rendered through the two functions below, which
 * is the only reason this can be one flag rather than a change to fifty screens: see the
 * note in CLAUDE.md about never formatting money by hand.
 *
 * The mask is a fixed width and says nothing about the number behind it. A mask that kept
 * the digit count would tell you whether a balance was four figures or seven, which is
 * most of what anybody glancing over a shoulder wanted to know.
 */
const MASK = '•••••';
let masked = false;

/** Turns masking on or off. Called when settings load and when the toggle moves. */
export function setAmountsMasked(on) {
  masked = Boolean(on);
}

export function amountsAreMasked() {
  return masked;
}

function maskFor(currency) {
  return currency === 'INR' ? `₹${MASK}` : `${MASK}`;
}

/**
 * Money for display. Indian amounts collapse to lakh and crore past a threshold, which
 * is how people actually read them, and stay exact below it.
 */
export function formatCurrency(amount, currency = 'INR', locale = 'en-IN') {
  if (masked) return maskFor(currency);
  const value = Number.isFinite(Number(amount)) ? Number(amount) : 0;

  if (currency === 'INR') {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    if (abs >= 1e7) return `${sign}₹${trimZeros(abs / 1e7)} Cr`;
    if (abs >= 1e5) return `${sign}₹${trimZeros(abs / 1e5)} L`;
  }

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: Math.abs(value) < 100 && value % 1 !== 0 ? 2 : 0,
  }).format(value);
}

/**
 * Always the full figure, for totals that must reconcile.
 *
 * Masked as well, and for a better reason than consistency: this is the one that prints
 * every digit, so leaving it out would mean the screens showing exact figures were the
 * screens the mask did not cover.
 */
export function formatExact(amount, currency = 'INR', locale = 'en-IN') {
  if (masked) return maskFor(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Number(amount) || 0);
}

function trimZeros(n) {
  return n.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

export function formatNumber(value, locale = 'en-IN') {
  return new Intl.NumberFormat(locale).format(Number(value) || 0);
}

export function formatPercent(value, digits = 0) {
  return `${(Number(value) || 0).toFixed(digits)}%`;
}

/** "12 Aug 2026" */
export function formatDate(value) {
  const date = toDate(value);
  if (!date) return '';
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** "12 Aug" for rows where the year is obvious from context. */
export function formatDayMonth(value) {
  const date = toDate(value);
  if (!date) return '';
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** "August 2026" from a YYYY-MM key. */
export function formatMonthKey(key) {
  const [year, month] = String(key).split('-');
  const index = Number(month) - 1;
  if (Number.isNaN(index) || !MONTHS[index]) return key;
  return `${MONTHS[index]} ${year}`;
}

/**
 * A bucket key as a chart axis label.
 *
 * Short, because an axis has the width of a phone divided by however many buckets there
 * are. A month is three letters, a week is the day it starts on, and a day is the number
 * with the month only on the first of it, so a run of thirty days does not repeat "Aug"
 * thirty times.
 */
export function formatBucketLabel(key, granularity, index = 0) {
  if (granularity === 'month') return formatMonthKey(key).slice(0, 3);

  const date = toDate(key);
  if (!date) return String(key);
  if (granularity === 'week') return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getDate() === 1 || index === 0
    ? `${date.getDate()} ${MONTHS[date.getMonth()]}`
    : String(date.getDate());
}

/** The same bucket, written out, for a heading that has room for it. */
export function formatBucketTitle(key, granularity) {
  if (granularity === 'month') return formatMonthKey(key);

  const date = toDate(key);
  if (!date) return String(key);
  if (granularity === 'day') return formatDate(date);

  // A week is a range, and stating both ends is the only way to say which week it was.
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 6);
  const sameMonth = end.getMonth() === date.getMonth();
  return `${date.getDate()}${sameMonth ? '' : ` ${MONTHS[date.getMonth()]}`} to ${end.getDate()} ${MONTHS[end.getMonth()]}`;
}

/** "Aug 2026", "week of 12 Aug", "12 Aug 2026". For a sentence about a period. */
export function describePeriod(key, granularity) {
  if (granularity === 'week') return `the week of ${formatDayMonth(key)}`;
  if (granularity === 'day') return formatDate(key);
  return formatMonthKey(key);
}

/** A signed percentage for a comparison, or an empty string when there is nothing to compare. */
export function formatDelta(percent, digits = 0) {
  if (percent === null || percent === undefined || !Number.isFinite(Number(percent))) return '';
  const value = Number(percent);
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

/** Today and Yesterday get names; everything else gets a date. */
export function formatRelativeDate(value) {
  const date = toDate(value);
  if (!date) return '';

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days === -1) return 'Tomorrow';
  if (days > 1 && days < 7) return `${days} days ago`;
  if (days < -1 && days > -7) return `In ${Math.abs(days)} days`;
  return formatDate(date);
}

export function daysUntil(value) {
  const date = toDate(value);
  if (!date) return null;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((startOfDay(date) - startOfDay(new Date())) / 86400000);
}

export function todayISO() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  // Plain YYYY-MM-DD is parsed as UTC by Date, which shifts the day in negative
  // offsets. Build it as a local date instead.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
