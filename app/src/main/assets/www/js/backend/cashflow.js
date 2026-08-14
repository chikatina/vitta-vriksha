/*
 * Cashflow, Safe-to-Spend, Runway Forecaster, Salary Checklist & Weekend Spend Intelligence.
 */

import { memberClause, monthBounds, number, today } from './periods.js';
import { flowClause, isExcludingInvestments } from './analytics.js';

const LIQUID_CATEGORIES = new Set(['bank', 'cash', 'wallet', 'savings', 'checking', 'liquid']);

/**
 * Calculates how much cash is genuinely "safe to spend" today after reserving funds
 * for upcoming EMIs, SIPs, credit card bills, and fixed recurring bills.
 */
export function calculateSafeToSpend(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');

  // 1. Total Liquid Balance across bank accounts & wallets
  let liquidBalance = 0;
  const accounts = db.all(`SELECT id, name, category, balance FROM asset_accounts${clause}`, params);
  for (const acc of accounts) {
    const cat = String(acc.category || '').toLowerCase();
    if (LIQUID_CATEGORIES.has(cat) || !cat) {
      liquidBalance += number(acc.balance);
    }
  }

  // 2. Upcoming Monthly Loan EMIs (borrowed)
  let loanEmis = 0;
  const loans = db.all(
    `SELECT name, monthly_emi, current_outstanding FROM loans${clause}`
    + `${clause ? ' AND' : ' WHERE'} COALESCE(direction, 'borrowed') != 'lent' AND current_outstanding > 0`,
    params,
  );
  for (const l of loans) {
    loanEmis += number(l.monthly_emi);
  }

  // 3. Active Monthly SIP commitments
  let sipTotal = 0;
  const sips = db.all(
    `SELECT COALESCE(scheme_name, '') AS fund_name, monthly_amount, debit_day FROM sips${clause}`
    + `${clause ? ' AND' : ' WHERE'} is_active = 1`,
    params,
  );
  for (const s of sips) {
    sipTotal += number(s.monthly_amount);
  }

  // 4. Credit Card Outstanding Dues
  let cardDues = 0;
  const cards = db.all(`SELECT card_name, current_balance, due_date AS due_day FROM credit_cards${clause}`, params);
  for (const c of cards) {
    cardDues += Math.max(0, number(c.current_balance));
  }

  // 5. Fixed recurring expenses / bills
  let recurringBills = 0;
  const recurring = db.all(
    `SELECT name, cost AS amount FROM subscriptions${clause}`
    + `${clause ? ' AND' : ' WHERE'} auto_debit = 1`,
    params,
  );
  for (const r of recurring) {
    recurringBills += number(r.amount);
  }

  const lockedCommitments = loanEmis + sipTotal + cardDues + recurringBills;
  const safeTotal = Math.max(0, liquidBalance - lockedCommitments);

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const currentDay = now.getDate();
  const daysRemaining = Math.max(1, daysInMonth - currentDay + 1);

  const safeDaily = Math.round(safeTotal / daysRemaining);
  const safeWeekly = Math.round(safeDaily * 7);

  let status = 'healthy';
  if (liquidBalance < lockedCommitments) {
    status = 'deficit';
  } else if (safeTotal < (liquidBalance * 0.15)) {
    status = 'tight';
  }

  return {
    status: 'success',
    liquid_balance: Math.round(liquidBalance),
    locked_commitments: Math.round(lockedCommitments),
    safe_to_spend_total: Math.round(safeTotal),
    safe_to_spend_daily: safeDaily,
    safe_to_spend_weekly: safeWeekly,
    days_remaining: daysRemaining,
    health_status: status,
    breakdown: {
      loan_emis: Math.round(loanEmis),
      sips: Math.round(sipTotal),
      credit_cards: Math.round(cardDues),
      recurring_bills: Math.round(recurringBills),
    },
    counts: {
      loans: loans.length,
      sips: sips.length,
      cards: cards.length,
      recurring: recurring.length,
    },
  };
}

/**
 * Projects day-by-day cashflow trajectory for the next 30 days.
 */
export function getCashflowRunway(db, args = {}) {
  const safe = calculateSafeToSpend(db, args);
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');

  // Estimate average daily discretionary burn from past 30 days
  const [currentFrom, currentTo] = monthBounds(0);
  const totalRecentSpend = number(db.value(
    `SELECT SUM(amount) FROM transactions WHERE date >= ? AND date < ? AND ${flowClause(db, 'spend')}`,
    [currentFrom, currentTo],
  ));
  const daysElapsed = Math.max(1, new Date().getDate());
  const dailyBurn = Math.max(100, Math.round(totalRecentSpend / daysElapsed));

  // Collect scheduled debits with their calendar days
  const sips = db.all(`SELECT COALESCE(scheme_name, '') AS fund_name, monthly_amount, debit_day FROM sips${clause}${clause ? ' AND' : ' WHERE'} is_active = 1`, params);
  const cards = db.all(`SELECT card_name, current_balance, due_date AS due_day FROM credit_cards${clause}`, params);

  // Salary expectation day: default to 1st of next month or learned from history
  const salaryRow = db.get(
    "SELECT strftime('%d', date) AS day, amount FROM transactions WHERE type = 'Income' ORDER BY date DESC LIMIT 1",
  );
  const expectedSalaryDay = salaryRow ? Number(salaryRow.day) : 1;
  const expectedSalaryAmount = salaryRow ? number(salaryRow.amount) : 0;

  const now = new Date();
  let balance = safe.liquid_balance;
  const timeline = [];
  let minBalance = balance;

  for (let i = 0; i < 30; i += 1) {
    const dateObj = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const day = dateObj.getDate();
    const iso = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const dayDebits = [];
    const dayCredits = [];

    // Check SIPs
    for (const s of sips) {
      if (Number(s.debit_day) === day) {
        dayDebits.push({ title: `SIP: ${s.fund_name}`, amount: number(s.monthly_amount) });
      }
    }
    // Check Cards
    for (const c of cards) {
      if (Number(c.due_day) === day && number(c.current_balance) > 0) {
        dayDebits.push({ title: `CC Bill: ${c.card_name}`, amount: number(c.current_balance) });
      }
    }
    // Check Salary Credit
    if (day === expectedSalaryDay && i > 0 && expectedSalaryAmount > 0) {
      dayCredits.push({ title: 'Expected Salary', amount: expectedSalaryAmount });
    }

    const totalDebits = dayDebits.reduce((s, d) => s + d.amount, 0) + dailyBurn;
    const totalCredits = dayCredits.reduce((s, c) => s + c.amount, 0);

    balance = balance - totalDebits + totalCredits;
    if (balance < minBalance) minBalance = balance;

    timeline.push({
      date: iso,
      day_of_month: day,
      projected_balance: Math.round(balance),
      debits: dayDebits,
      credits: dayCredits,
      discretionary_burn: dailyBurn,
      is_low: balance < 5000,
    });
  }

  return {
    status: 'success',
    starting_balance: safe.liquid_balance,
    min_projected_balance: Math.round(minBalance),
    is_runway_safe: minBalance >= 5000,
    estimated_daily_burn: dailyBurn,
    timeline,
  };
}

/**
 * Interactive salary day automation checklist.
 */
export function getSalaryChecklist(db, args = {}) {
  const safe = calculateSafeToSpend(db, args);
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'AND');

  const latestSalary = db.get(
    `SELECT date, amount, description FROM transactions WHERE type = 'Income' AND category = 'Salary'${clause} ORDER BY date DESC LIMIT 1`,
    params,
  );

  const steps = [
    {
      id: 'invest',
      title: 'Fund SIPs & Investments',
      desc: `Allocate ₹${safe.breakdown.sips.toLocaleString('en-IN')} towards active SIPs.`,
      amount: safe.breakdown.sips,
      completed: false,
      icon: 'trending_up',
    },
    {
      id: 'cards',
      title: 'Clear Credit Card Dues',
      desc: `Pay off statement balances (₹${safe.breakdown.credit_cards.toLocaleString('en-IN')}) in full.`,
      amount: safe.breakdown.credit_cards,
      completed: false,
      icon: 'credit_card',
    },
    {
      id: 'bills',
      title: 'Reserve Fixed Bills & Rent',
      desc: `Keep ₹${safe.breakdown.recurring_bills.toLocaleString('en-IN')} for utilities, subscriptions & rent.`,
      amount: safe.breakdown.recurring_bills,
      completed: false,
      icon: 'receipt',
    },
    {
      id: 'buffer',
      title: 'Emergency Fund Top-up',
      desc: 'Ensure 3–6 months of essential living expenses are saved.',
      amount: 0,
      completed: safe.liquid_balance >= (safe.locked_commitments * 2),
      icon: 'shield',
    },
    {
      id: 'safe_spend',
      title: 'Enjoy Safe-to-Spend Pool',
      desc: `You have ₹${safe.safe_to_spend_daily.toLocaleString('en-IN')}/day in guilt-free spending.`,
      amount: safe.safe_to_spend_total,
      completed: safe.safe_to_spend_total > 0,
      icon: 'savings',
    },
  ];

  return {
    status: 'success',
    latest_salary: latestSalary || null,
    steps,
    safe_to_spend: safe.safe_to_spend_total,
    safe_daily: safe.safe_to_spend_daily,
  };
}

/**
 * Analyzes Weekend (Fri, Sat, Sun) vs Weekday (Mon–Thu) spending patterns over the last 90 days.
 */
export function getWeekendVsWeekdayAnalysis(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'AND');

  // Past 90 days
  const now = new Date();
  const past90 = new Date(now.getTime() - (90 * 86400000));
  const past90ISO = `${past90.getFullYear()}-${String(past90.getMonth() + 1).padStart(2, '0')}-${String(past90.getDate()).padStart(2, '0')}`;

  const rows = db.all(
    'SELECT strftime(\'%w\', date) AS weekday_num, category, SUM(amount) AS total, COUNT(*) AS count'
    + ` FROM transactions WHERE date >= ? AND ${flowClause(db, 'spend')}${clause}`
    + ' GROUP BY weekday_num, category',
    [past90ISO, ...params],
  );

  let weekendTotal = 0;
  let weekdayTotal = 0;
  let weekendDaysCount = 0;
  let weekdayDaysCount = 0;

  const weekendCatTotals = new Map();
  const weekdayCatTotals = new Map();

  for (const r of rows) {
    const dayNum = Number(r.weekday_num); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
    const isWeekend = (dayNum === 0 || dayNum === 5 || dayNum === 6); // Fri, Sat, Sun
    const amt = number(r.total);

    if (isWeekend) {
      weekendTotal += amt;
      weekendCatTotals.set(r.category, (weekendCatTotals.get(r.category) || 0) + amt);
    } else {
      weekdayTotal += amt;
      weekdayCatTotals.set(r.category, (weekdayCatTotals.get(r.category) || 0) + amt);
    }
  }

  // 90 days = ~38 weekend days (Fri, Sat, Sun) and ~52 weekdays (Mon-Thu)
  weekendDaysCount = 38;
  weekdayDaysCount = 52;

  const weekendDailyAvg = Math.round(weekendTotal / weekendDaysCount);
  const weekdayDailyAvg = Math.round(weekdayTotal / weekdayDaysCount);
  const total = weekendTotal + weekdayTotal;

  const weekendShare = total > 0 ? Math.round((weekendTotal / total) * 100) : 0;
  const intensityRatio = weekdayDailyAvg > 0 ? Math.round((weekendDailyAvg / weekdayDailyAvg) * 10) / 10 : 1;

  const topWeekendCategories = [...weekendCatTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([cat, val]) => ({
      category: cat,
      total: Math.round(val),
      share: weekendTotal > 0 ? Math.round((val / weekendTotal) * 100) : 0,
    }));

  return {
    status: 'success',
    period_days: 90,
    weekend: {
      total: Math.round(weekendTotal),
      daily_average: weekendDailyAvg,
      share_percent: weekendShare,
      days_count: weekendDaysCount,
      top_categories: topWeekendCategories,
    },
    weekday: {
      total: Math.round(weekdayTotal),
      daily_average: weekdayDailyAvg,
      share_percent: 100 - weekendShare,
      days_count: weekdayDaysCount,
    },
    intensity_ratio: intensityRatio,
    verdict: intensityRatio >= 1.5
      ? `Weekend spending is ${intensityRatio}× heavier per day than weekdays.`
      : 'Spending is evenly balanced between weekdays and weekends.',
  };
}
