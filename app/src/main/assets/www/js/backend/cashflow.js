/*
 * Cashflow, Safe-to-Spend, Runway Forecaster, Salary Checklist & Weekend Spend Intelligence.
 */

import { memberClause, monthBounds, number, today } from './periods.js';
import { flowClause, isExcludingInvestments } from './analytics.js';

const LIQUID_CATEGORIES = new Set(['bank', 'cash', 'wallet', 'savings', 'checking', 'liquid']);

export function isLiquidCategory(category) {
  const cat = String(category || '').toLowerCase();
  if (!cat) return true;
  if (cat.includes('fd') || cat.includes('rd') || cat.includes('deposit') || cat.includes('fixed')
    || cat.includes('demat') || cat.includes('stock') || cat.includes('equity') || cat.includes('share')
    || cat.includes('mf') || cat.includes('mutual') || cat.includes('gold') || cat.includes('sgb') || cat.includes('silver')
    || cat.includes('nps') || cat.includes('pf') || cat.includes('ppf') || cat.includes('epf') || cat.includes('pension')) {
    return false;
  }
  return LIQUID_CATEGORIES.has(cat) || cat.includes('bank') || cat.includes('cash') || cat.includes('wallet')
    || cat.includes('saving') || cat.includes('checking') || cat.includes('liquid') || cat.includes('salary')
    || cat.includes('current') || cat.includes('meal') || cat.includes('prepaid');
}

/**
 * Calculates how much cash is genuinely "safe to spend" today after reserving funds
 * for upcoming EMIs, SIPs, credit card bills, and fixed recurring bills.
 */
export function calculateSafeToSpend(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');

  // 1. Total Liquid Balance across bank accounts & wallets
  let liquidBalance = 0;
  const accounts = db.all(`SELECT id, name, category, linked_holding_type, balance FROM asset_accounts${clause}`, params);
  for (const acc of accounts) {
    if (acc.linked_holding_type === 'nps') continue;
    if (isLiquidCategory(acc.category)) {
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
    loanEmis += number(l.monthly_emi || 0);
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
  const deficitAmount = Math.max(0, lockedCommitments - liquidBalance);

  const todayStr = today();
  const [year, month, currentDay] = todayStr.split('-').map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysRemaining = Math.max(1, daysInMonth - currentDay + 1);

  // Compute daily living expense burn from historical transactions
  const burn90 = calculateDailyExpenseAverage(db, { days: 90, member_id: memberId });
  const burn30 = calculateDailyExpenseAverage(db, { days: 30, member_id: memberId });
  const dailyLivingBurn = burn90.daily_average || burn30.daily_average || 0;

  // Safe runway duration based on actual average spend burn rate
  let safeRunwayDays = 0;
  let safeDaily = 0;
  if (dailyLivingBurn > 0) {
    safeRunwayDays = Math.floor(safeTotal / dailyLivingBurn);
    safeDaily = dailyLivingBurn;
  } else {
    safeDaily = Math.round(safeTotal / daysRemaining);
    safeRunwayDays = daysRemaining;
  }

  const safeWeekly = Math.round(safeDaily * 7);
  const safeRunwayWeeks = Math.round((safeRunwayDays / 7) * 10) / 10;
  const safeRunwayMonths = Math.round((safeRunwayDays / 30.416) * 10) / 10;

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
    daily_living_burn: dailyLivingBurn,
    safe_runway_days: safeRunwayDays,
    safe_runway_weeks: safeRunwayWeeks,
    safe_runway_months: safeRunwayMonths,
    deficit_amount: Math.round(deficitAmount),
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
 * Calculates rolling average daily expense burn over a specified number of days (e.g., 30, 90, 180, 365).
 */
export function calculateDailyExpenseAverage(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'AND');
  const targetDays = Math.max(1, Number(args.days) || 90);

  const now = new Date();
  const pastDate = new Date(now.getTime() - (targetDays * 86400000));
  const pastISO = `${pastDate.getFullYear()}-${String(pastDate.getMonth() + 1).padStart(2, '0')}-${String(pastDate.getDate()).padStart(2, '0')}`;

  const row = db.get(
    `SELECT SUM(amount) AS total, COUNT(*) AS count, MIN(date) AS earliest, MAX(date) AS latest
     FROM transactions
     WHERE date >= ? AND ${flowClause(db, 'spend')}${clause}`,
    [pastISO, ...params],
  );

  const total = number(row?.total);
  const count = Number(row?.count || 0);

  let effectiveDays = targetDays;
  if (row?.earliest && count > 0) {
    const earliestDate = new Date(row.earliest);
    if (!Number.isNaN(earliestDate.getTime())) {
      const daysSinceEarliest = Math.max(1, Math.round((now - earliestDate) / 86400000) + 1);
      effectiveDays = Math.min(targetDays, daysSinceEarliest);
    }
  }

  const dailyAverage = effectiveDays > 0 ? Math.round(total / effectiveDays) : 0;
  const monthlyAverage = Math.round(dailyAverage * 30.416);
  const annualAverage = Math.round(dailyAverage * 365.25);

  return {
    status: 'success',
    days_requested: targetDays,
    effective_days: effectiveDays,
    total_spend: Math.round(total),
    transaction_count: count,
    daily_average: dailyAverage,
    monthly_average: monthlyAverage,
    annual_average: annualAverage,
  };
}

/**
 * Calculates customized financial runway based on average daily expenses across configurable asset tiers.
 */
export function getCustomRunway(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');

  // 1. Asset categories breakdown
  const accounts = db.all(`SELECT id, name, category, linked_holding_type, balance FROM asset_accounts${clause}`, params);
  const npsTotal = number(db.value(`SELECT SUM(current_value) FROM nps_holdings${clause}`, params));
  const folioTotal = number(db.value(`SELECT SUM(current_value) FROM mf_folios${clause}`, params));
  const dematTotal = number(db.value(`SELECT SUM(current_value) FROM demat_holdings${clause}`, params));

  let liquid = 0;
  let deposits = 0;
  let mutualFunds = folioTotal;
  let stocks = dematTotal;
  let gold = 0;
  let retirement = npsTotal;
  let other = 0;

  for (const acc of accounts) {
    if (acc.linked_holding_type === 'nps' || (String(acc.category || '').toUpperCase() === 'NPS' && npsTotal > 0)) {
      continue;
    }
    const cat = String(acc.category || '').toLowerCase();
    const bal = number(acc.balance);

    if (LIQUID_CATEGORIES.has(cat) || !cat) {
      liquid += bal;
    } else if (cat.includes('fd') || cat.includes('rd') || cat.includes('deposit') || cat.includes('debt') || cat.includes('fixed')) {
      deposits += bal;
    } else if (cat.includes('gold') || cat.includes('sgb') || cat.includes('silver')) {
      gold += bal;
    } else if (cat.includes('equity') || cat.includes('stock') || cat.includes('demat') || cat.includes('share')) {
      stocks += bal;
    } else if (cat.includes('mf') || cat.includes('mutual')) {
      mutualFunds += bal;
    } else if (cat.includes('nps') || cat.includes('pf') || cat.includes('epf') || cat.includes('ppf') || cat.includes('pension') || cat.includes('provident')) {
      retirement += bal;
    } else {
      other += bal;
    }
  }

  // Recoverable loans lent
  const lent = number(db.value(
    `SELECT SUM(current_outstanding) FROM loans${clause}${clause ? ' AND' : ' WHERE'} direction = 'lent'`,
    params,
  ));
  if (lent) deposits += lent;

  // 2. Liabilities & Debt commitments breakdown (EMI pattern)
  const loans = db.all(
    `SELECT name, monthly_emi, current_outstanding FROM loans${clause}`
    + `${clause ? ' AND' : ' WHERE'} COALESCE(direction, 'borrowed') != 'lent' AND current_outstanding > 0`,
    params,
  );
  let monthlyLoanEmis = 0;
  let totalLoanPrincipal = 0;
  for (const l of loans) {
    monthlyLoanEmis += number(l.monthly_emi);
    totalLoanPrincipal += number(l.current_outstanding);
  }
  const cardDues = number(db.value(`SELECT SUM(current_balance) FROM credit_cards${clause}`, params));
  const dailyLoanEmi = monthlyLoanEmis > 0 ? Math.round(monthlyLoanEmis / 30.416) : 0;

  // 3. Historical Daily Living Burn Benchmarks (30d, 90d, 180d, 365d)
  const burn30 = calculateDailyExpenseAverage(db, { days: 30, member_id: memberId });
  const burn90 = calculateDailyExpenseAverage(db, { days: 90, member_id: memberId });
  const burn180 = calculateDailyExpenseAverage(db, { days: 180, member_id: memberId });
  const burn365 = calculateDailyExpenseAverage(db, { days: 365, member_id: memberId });

  // Selected Daily Living Burn
  let dailyLivingBurn = 0;
  let burnPeriod = Number(args.burn_period_days) || 90;
  let burnBasis = '90-Day Average';

  if (args.custom_daily_burn !== undefined && args.custom_daily_burn !== null && number(args.custom_daily_burn) > 0) {
    dailyLivingBurn = Math.round(number(args.custom_daily_burn));
    burnBasis = 'Custom Input';
    burnPeriod = 0;
  } else if (burnPeriod === 30) {
    dailyLivingBurn = burn30.daily_average;
    burnBasis = '30-Day Average';
  } else if (burnPeriod === 180) {
    dailyLivingBurn = burn180.daily_average;
    burnBasis = '180-Day Average';
  } else if (burnPeriod === 365) {
    dailyLivingBurn = burn365.daily_average;
    burnBasis = '1-Year Average';
  } else {
    dailyLivingBurn = burn90.daily_average || burn30.daily_average || 1000;
    burnBasis = '90-Day Average (Smoothed)';
    burnPeriod = 90;
  }

  if (dailyLivingBurn <= 0) {
    dailyLivingBurn = Math.max(100, Math.round(number(args.custom_daily_burn) || 1000));
  }

  const monthlyLivingBurn = Math.round(dailyLivingBurn * 30.416);

  const incLiquid = args.include_liquid !== undefined ? Boolean(args.include_liquid) : true;
  const incDeposits = args.include_deposits !== undefined ? Boolean(args.include_deposits) : true;
  const incMutualFunds = args.include_mutual_funds !== undefined ? Boolean(args.include_mutual_funds) : true;
  const incStocks = args.include_stocks !== undefined ? Boolean(args.include_stocks) : true;
  const incGold = args.include_gold !== undefined ? Boolean(args.include_gold) : true;
  const incRetirement = args.include_retirement !== undefined ? Boolean(args.include_retirement) : false;
  const incOther = args.include_other !== undefined ? Boolean(args.include_other) : false;
  const subtractLiabilities = args.subtract_liabilities !== undefined ? Boolean(args.subtract_liabilities) : true;

  // Emergency Runway Burn via EMI pattern:
  // Immediate statement debts (Credit cards) are cleared from the asset pool.
  // Ongoing loan commitments are serviced as recurring Monthly EMIs added to the living burn rate.
  const totalDailyBurn = dailyLivingBurn + (subtractLiabilities ? dailyLoanEmi : 0);
  const totalMonthlyBurn = monthlyLivingBurn + (subtractLiabilities ? monthlyLoanEmis : 0);
  const annualBurn = totalMonthlyBurn * 12;

  let selectedAssetsTotal = 0;
  if (incLiquid) selectedAssetsTotal += liquid;
  if (incDeposits) selectedAssetsTotal += deposits;
  if (incMutualFunds) selectedAssetsTotal += mutualFunds;
  if (incStocks) selectedAssetsTotal += stocks;
  if (incGold) selectedAssetsTotal += gold;
  if (incRetirement) selectedAssetsTotal += retirement;
  if (incOther) selectedAssetsTotal += other;

  const immediateDebt = subtractLiabilities ? cardDues : 0;
  const netRunwayFunds = Math.max(0, selectedAssetsTotal - immediateDebt);

  const runwayDays = totalDailyBurn > 0 ? Math.floor(netRunwayFunds / totalDailyBurn) : 0;
  const runwayMonths = totalMonthlyBurn > 0 ? Math.round((netRunwayFunds / totalMonthlyBurn) * 10) / 10 : 0;
  const runwayYears = totalMonthlyBurn > 0 ? Math.round((netRunwayFunds / (totalMonthlyBurn * 12)) * 10) / 10 : 0;

  let depletionDate = null;
  if (runwayDays > 0 && runwayDays <= 36500) {
    const dep = new Date(Date.now() + (runwayDays * 86400000));
    depletionDate = `${dep.getFullYear()}-${String(dep.getMonth() + 1).padStart(2, '0')}-${String(dep.getDate()).padStart(2, '0')}`;
  }

  const calcTier = (poolAmount, id, label, iconName) => {
    const net = Math.max(0, poolAmount - immediateDebt);
    const d = totalDailyBurn > 0 ? Math.floor(net / totalDailyBurn) : 0;
    const m = totalMonthlyBurn > 0 ? Math.round((net / totalMonthlyBurn) * 10) / 10 : 0;
    const y = totalMonthlyBurn > 0 ? Math.round((net / (totalMonthlyBurn * 12)) * 10) / 10 : 0;
    return {
      id,
      label,
      icon: iconName,
      gross_amount: Math.round(poolAmount),
      net_amount: Math.round(net),
      runway_days: d,
      runway_months: m,
      runway_years: y,
    };
  };

  const totalAllAssets = liquid + deposits + mutualFunds + stocks + gold + retirement + other;

  const tiers = {
    liquid_only: calcTier(liquid, 'liquid_only', 'Liquid Cash Only', 'account_balance_wallet'),
    emergency_pool: calcTier(liquid + deposits, 'emergency_pool', 'Liquid + Deposits', 'shield'),
    investable: calcTier(liquid + deposits + mutualFunds + stocks + gold, 'investable', 'Investable Assets', 'trending_up'),
    net_worth: calcTier(totalAllAssets, 'net_worth', 'Total Net Worth', 'balance'),
  };

  return {
    status: 'success',
    daily_living_burn: dailyLivingBurn,
    monthly_living_burn: monthlyLivingBurn,
    monthly_loan_emis: Math.round(monthlyLoanEmis),
    daily_loan_emi: dailyLoanEmi,
    daily_burn: totalDailyBurn,
    monthly_burn: totalMonthlyBurn,
    annual_burn: annualBurn,
    burn_period_days: burnPeriod,
    burn_basis_label: burnBasis,
    historical_burn: {
      days_30: burn30,
      days_90: burn90,
      days_180: burn180,
      days_365: burn365,
    },
    asset_breakdown: {
      liquid: Math.round(liquid),
      deposits: Math.round(deposits),
      mutual_funds: Math.round(mutualFunds),
      stocks: Math.round(stocks),
      gold: Math.round(gold),
      retirement: Math.round(retirement),
      other: Math.round(other),
      total_assets: Math.round(totalAllAssets),
    },
    liabilities_breakdown: {
      credit_cards: Math.round(cardDues),
      monthly_loan_emis: Math.round(monthlyLoanEmis),
      total_loan_principal: Math.round(totalLoanPrincipal),
      total_liabilities: Math.round(totalLoanPrincipal + cardDues),
    },
    custom_configuration: {
      include_liquid: incLiquid,
      include_deposits: incDeposits,
      include_mutual_funds: incMutualFunds,
      include_stocks: incStocks,
      include_gold: incGold,
      include_retirement: incRetirement,
      include_other: incOther,
      subtract_liabilities: subtractLiabilities,
    },
    selected_assets_total: Math.round(selectedAssetsTotal),
    immediate_debt_dues: Math.round(immediateDebt),
    net_runway_funds: Math.round(netRunwayFunds),
    runway_days: runwayDays,
    runway_months: runwayMonths,
    runway_years: runwayYears,
    depletion_date: depletionDate,
    tiers,
  };
}

/**
 * Projects day-by-day cashflow trajectory for the next 30 days.
 */
export function getCashflowRunway(db, args = {}) {
  const safe = calculateSafeToSpend(db, args);
  const custom = getCustomRunway(db, args);
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');

  const dailyBurn = custom.daily_burn;

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
    runway_days: custom.runway_days,
    runway_months: custom.runway_months,
    runway_years: custom.runway_years,
    tiers: custom.tiers,
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
      icon: 'receipt_long',
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
