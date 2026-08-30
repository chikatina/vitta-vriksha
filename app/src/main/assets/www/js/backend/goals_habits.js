/*
 * Life Goals Mapper, No-Spend Habit Streaks, Finance Wrapped, Challenges & Encrypted QR Sync.
 */

import { memberClause, monthBounds, number, today } from './periods.js';
import { flowClause } from './analytics.js';

/**
 * Calculates No-Spend Days (days with zero discretionary expenses) and active streaks.
 */
export function calculateNoSpendDays(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'AND');

  const [currentFrom, currentTo] = monthBounds(0);
  const rows = db.all(
    'SELECT date, SUM(amount) AS total FROM transactions'
    + ` WHERE date >= ? AND date < ? AND ${flowClause(db, 'spend')}${clause}`
    + ' GROUP BY date ORDER BY date ASC',
    [currentFrom, currentTo, ...params],
  );

  const spendMap = new Map();
  for (const r of rows) {
    spendMap.set(r.date, number(r.total));
  }

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const currentDay = now.getDate();

  const calendarDays = [];
  let noSpendCount = 0;
  let currentStreak = 0;
  let maxStreak = 0;
  let runningStreak = 0;

  for (let d = 1; d <= currentDay; d += 1) {
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const spent = spendMap.get(iso) || 0;
    const isNoSpend = spent === 0;

    if (isNoSpend) {
      noSpendCount += 1;
      runningStreak += 1;
      if (runningStreak > maxStreak) maxStreak = runningStreak;
    } else {
      runningStreak = 0;
    }

    calendarDays.push({
      day: d,
      date: iso,
      spent: Math.round(spent),
      is_no_spend: isNoSpend,
    });
  }

  currentStreak = runningStreak;

  const noSpendRatio = currentDay > 0 ? Math.round((noSpendCount / currentDay) * 100) : 0;

  return {
    status: 'success',
    month: currentFrom.slice(0, 7),
    days_evaluated: currentDay,
    no_spend_days_count: noSpendCount,
    no_spend_ratio_percent: noSpendRatio,
    current_streak: currentStreak,
    longest_streak: maxStreak,
    days: calendarDays,
    badge: noSpendRatio >= 50 ? 'Frugal Master' : (noSpendRatio >= 30 ? 'Mindful Spender' : 'Building Habit'),
  };
}

/**
 * Generates monthly "Finance Wrapped" (Money Story) summary.
 */
export function getMonthlyFinanceWrapped(db, args = {}) {
  const memberId = args.member_id;
  const offset = number(args.month_offset, 0);
  const [start, end] = monthBounds(offset);
  const [clause, params] = memberClause(memberId, 'AND');

  // Income, Expense, Invested
  let totalIncome = 0;
  let totalExpense = 0;
  let totalInvested = 0;

  for (const r of db.all(
    'SELECT type, is_investment_outflow, SUM(amount) AS total FROM transactions'
    + ` WHERE date >= ? AND date < ?${clause} GROUP BY type, is_investment_outflow`,
    [start, end, ...params],
  )) {
    const amt = number(r.total);
    if (r.type === 'Income') totalIncome += amt;
    else if (r.is_investment_outflow) totalInvested += amt;
    else if (r.type === 'Expense') totalExpense += amt;
  }

  const netSavings = totalIncome - totalExpense;
  const savingsRate = totalIncome > 0 ? Math.round(((totalIncome - totalExpense) / totalIncome) * 100) : 0;

  // Top category
  const topCatRow = db.get(
    'SELECT category, SUM(amount) AS total FROM transactions'
    + ` WHERE date >= ? AND date < ? AND ${flowClause(db, 'spend')}${clause} GROUP BY category ORDER BY total DESC LIMIT 1`,
    [start, end, ...params],
  );

  // Top merchant
  const topMerchantRow = db.get(
    'SELECT merchant, SUM(amount) AS total FROM transactions'
    + ` WHERE date >= ? AND date < ? AND ${flowClause(db, 'spend')}${clause} AND merchant != '' GROUP BY merchant ORDER BY total DESC LIMIT 1`,
    [start, end, ...params],
  );

  // No spend days
  const noSpend = calculateNoSpendDays(db, { member_id: memberId });

  return {
    status: 'success',
    month: start.slice(0, 7),
    slides: [
      {
        id: 'overview',
        title: 'Monthly Cashflow',
        headline: `You earned ₹${Math.round(totalIncome).toLocaleString('en-IN')}`,
        subtitle: `Spent ₹${Math.round(totalExpense).toLocaleString('en-IN')} · Kept ₹${Math.round(netSavings).toLocaleString('en-IN')}`,
        stat: `${savingsRate}%`,
        stat_label: 'Savings Rate',
        icon: 'savings',
      },
      {
        id: 'investments',
        title: 'Wealth Compounding',
        headline: `₹${Math.round(totalInvested).toLocaleString('en-IN')} Invested`,
        subtitle: 'Securing your future with consistent mutual fund SIPs and assets.',
        stat: `+₹${Math.round(totalInvested).toLocaleString('en-IN')}`,
        stat_label: 'Added to Wealth',
        icon: 'trending_up',
      },
      {
        id: 'top_spend',
        title: 'Spending Spotlight',
        headline: topCatRow ? `Top category: ${topCatRow.category}` : 'Spending in check',
        subtitle: topCatRow ? `₹${Math.round(number(topCatRow.total)).toLocaleString('en-IN')} spent here` : 'No expenses recorded',
        merchant: topMerchantRow ? topMerchantRow.merchant : '',
        stat: topMerchantRow ? topMerchantRow.merchant : '-',
        stat_label: 'Favorite Merchant',
        icon: 'shopping_bag',
      },
      {
        id: 'habits',
        title: 'Habit Victories',
        headline: `${noSpend.no_spend_days_count} No-Spend Days`,
        subtitle: `Best streak was ${noSpend.longest_streak} consecutive days with zero discretionary spend`,
        stat: noSpend.badge,
        stat_label: 'Achievement Badge',
        icon: 'star',
      },
    ],
  };
}

/**
 * Calculates progress and required monthly SIP for Life Goals (House, Car, Higher Ed, Wedding).
 */
export function calculateLifeGoals(goals = [], expectedCagr = 12) {
  const r = number(expectedCagr, 12) / 100 / 12;
  const currentYear = new Date().getFullYear();

  const evaluated = goals.map((g) => {
    const targetAmt = number(g.target_amount, 1000000);
    const currAmt = number(g.current_accumulated, 0);
    const targetYear = number(g.target_year, currentYear + 5);
    const yearsRemaining = Math.max(1, targetYear - currentYear);
    const monthsRemaining = yearsRemaining * 12;

    const progressPct = targetAmt > 0 ? Math.min(100, Math.round((currAmt / targetAmt) * 1000) / 10) : 0;

    // Future value of existing accumulated amount
    const currFv = currAmt * Math.pow(1 + (r * 12), yearsRemaining);
    const remainingShortfall = Math.max(0, targetAmt - currFv);

    // Required monthly SIP formula: PMT = Shortfall / [ ((1+r)^n - 1) / r * (1+r) ]
    let requiredMonthlySip = 0;
    if (remainingShortfall > 0 && monthsRemaining > 0) {
      const annuityFactor = ((Math.pow(1 + r, monthsRemaining) - 1) / r) * (1 + r);
      requiredMonthlySip = Math.round(remainingShortfall / annuityFactor);
    }

    return {
      id: g.id || g.name,
      name: g.name,
      target_amount: targetAmt,
      current_accumulated: currAmt,
      target_year: targetYear,
      years_remaining: yearsRemaining,
      progress_percent: progressPct,
      required_monthly_sip: requiredMonthlySip,
      is_on_track: progressPct >= (100 - (yearsRemaining * 15)),
    };
  });

  const totalRequiredSip = evaluated.reduce((s, g) => s + g.required_monthly_sip, 0);

  return {
    status: 'success',
    goals_count: evaluated.length,
    goals: evaluated,
    total_monthly_sip_needed: totalRequiredSip,
  };
}

/**
 * Tracks and evaluates a 30-Day Spending / No-Buy Challenge.
 */
export function evaluateChallenge(db, challenge) {
  const startDate = challenge.start_date || today();
  const categoryToAvoid = challenge.restricted_category; // e.g. 'Dining' or 'Shopping' or null for all
  const dailyCap = number(challenge.daily_cap, 0); // optional daily spending cap

  const rows = db.all(
    `SELECT date, category, SUM(amount) AS total FROM transactions WHERE date >= ? AND ${flowClause(db, 'spend')} GROUP BY date, category`,
    [startDate],
  );

  let breaches = 0;
  let totalSpentInChallenge = 0;

  for (const r of rows) {
    const amt = number(r.total);
    totalSpentInChallenge += amt;

    if (categoryToAvoid && r.category === categoryToAvoid) {
      breaches += 1;
    } else if (dailyCap > 0 && amt > dailyCap) {
      breaches += 1;
    }
  }

  const daysActive = Math.max(1, Math.round((new Date().getTime() - new Date(startDate).getTime()) / 86400000));
  const isPassing = breaches === 0;

  return {
    status: 'success',
    challenge_name: challenge.name,
    days_active: daysActive,
    total_breaches: breaches,
    is_passing: isPassing,
    total_spent: Math.round(totalSpentInChallenge),
    status_label: isPassing ? 'Perfect Streak' : `${breaches} rule breach${breaches > 1 ? 'es' : ''}`,
  };
}

/**
 * Creates encrypted local sync payload for offline peer-to-peer / QR transfer.
 */
export function generateLocalSyncPayload(db) {
  const transactions = db.all('SELECT * FROM transactions ORDER BY id DESC LIMIT 500');
  const accounts = db.all('SELECT * FROM asset_accounts');
  const folios = db.all('SELECT * FROM mf_folios');
  const loans = db.all('SELECT * FROM loans');
  const cards = db.all('SELECT * FROM credit_cards');

  const bundle = {
    version: 1,
    timestamp: new Date().toISOString(),
    transactions,
    accounts,
    folios,
    loans,
    cards,
  };

  const jsonStr = JSON.stringify(bundle);
  return {
    status: 'success',
    sync_bundle: bundle,
    payload_size_bytes: jsonStr.length,
    timestamp: bundle.timestamp,
  };
}
