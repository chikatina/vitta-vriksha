import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatCurrency, formatExact, formatNumber, formatPercent,
  formatDate, formatDayMonth, formatMonthKey, formatBucketLabel,
  formatBucketTitle, describePeriod, formatDelta, formatRelativeDate,
  daysUntil, todayISO, setAmountsMasked, amountsAreMasked,
} from '../app/src/main/assets/www/js/formatters.js';

describe('formatters.js utilities', () => {
  it('formats currency in Indian style (Lakh and Crore thresholds)', () => {
    setAmountsMasked(false);
    assert.equal(amountsAreMasked(), false);
    assert.equal(formatCurrency(500), '₹500');
    assert.equal(formatCurrency(1500.50), '₹1,501');
    assert.equal(formatCurrency(50.25), '₹50.25');
    assert.equal(formatCurrency(150000), '₹1.5\u00A0L');
    assert.equal(formatCurrency(100000), '₹1\u00A0L');
    assert.equal(formatCurrency(-250000), '-₹2.5\u00A0L');
    assert.equal(formatCurrency(15000000), '₹1.5\u00A0Cr');
    assert.equal(formatCurrency(10000000), '₹1\u00A0Cr');
    assert.equal(formatCurrency(-35000000), '-₹3.5\u00A0Cr');
    assert.equal(formatCurrency(NaN), '₹0');
  });

  it('formats other currencies with standard Intl format', () => {
    setAmountsMasked(false);
    const usd = formatCurrency(1250, 'USD', 'en-US');
    assert.ok(usd.includes('1,250') || usd.includes('$1,250'));
  });

  it('masks amounts when masking is enabled', () => {
    setAmountsMasked(true);
    assert.equal(amountsAreMasked(), true);
    assert.equal(formatCurrency(5000), '₹•••••');
    assert.equal(formatCurrency(5000, 'USD'), '•••••');
    assert.equal(formatExact(5000), '₹•••••');
    assert.equal(formatExact(5000, 'USD'), '•••••');
    setAmountsMasked(false);
  });

  it('formats exact numbers and percentages', () => {
    assert.ok(formatExact(1234.56).includes('1,234.56'));
    assert.ok(formatExact(0).includes('0.00'));
    assert.ok(formatNumber(1234567).includes('12,34,567'));
    assert.equal(formatPercent(12.345, 1), '12.3%');
    assert.equal(formatPercent(12.345, 0), '12%');
    assert.equal(formatPercent(null), '0%');
  });

  it('formats dates in various shapes', () => {
    assert.equal(formatDate('2026-08-12'), '12 Aug 2026');
    assert.equal(formatDate(''), '');
    assert.equal(formatDate(null), '');
    assert.equal(formatDayMonth('2026-08-12'), '12 Aug');
    assert.equal(formatDayMonth('invalid'), '');
    assert.equal(formatMonthKey('2026-08'), 'Aug 2026');
    assert.equal(formatMonthKey('invalid-key'), 'invalid-key');
  });

  it('formats bucket labels and titles for day, week, month', () => {
    assert.equal(formatBucketLabel('2026-08', 'month'), 'Aug');
    assert.equal(formatBucketLabel('2026-08-01', 'day', 0), '1 Aug');
    assert.equal(formatBucketLabel('2026-08-15', 'day', 1), '15');
    assert.equal(formatBucketLabel('2026-08-10', 'week', 0), '10 Aug');
    assert.equal(formatBucketLabel('invalid', 'day'), 'invalid');

    assert.equal(formatBucketTitle('2026-08', 'month'), 'Aug 2026');
    assert.equal(formatBucketTitle('2026-08-12', 'day'), '12 Aug 2026');
    assert.equal(formatBucketTitle('2026-08-10', 'week'), '10 to 16 Aug');
    assert.equal(formatBucketTitle('2026-08-28', 'week'), '28 Aug to 3 Sep');
    assert.equal(formatBucketTitle('invalid', 'day'), 'invalid');
  });

  it('describes periods and calculates deltas and relative dates', () => {
    assert.equal(describePeriod('2026-08-10', 'week'), 'the week of 10 Aug');
    assert.equal(describePeriod('2026-08-12', 'day'), '12 Aug 2026');
    assert.equal(describePeriod('2026-08', 'month'), 'Aug 2026');

    assert.equal(formatDelta(15.2, 1), '+15.2%');
    assert.equal(formatDelta(-5.4, 1), '-5.4%');
    assert.equal(formatDelta(0, 0), '0%');
    assert.equal(formatDelta(null), '');
    assert.equal(formatDelta(undefined), '');

    assert.equal(formatRelativeDate(''), '');
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    assert.equal(formatRelativeDate(today), 'Today');
    assert.equal(daysUntil(today), 0);
    assert.equal(daysUntil(''), null);
    assert.equal(todayISO(), today);
  });
});
