/*
 * Retirement and Financial Independence, Retire Early (FIRE) Engine.
 *
 * Uses actual ledger data (assets, liabilities, historical spending, active SIPs, asset
 * allocation returns, and debt payoff timelines) to calculate personalized FIRE targets,
 * milestones (Lean, Regular, Fat, Coast, Barista), longevity simulation, and actionable gap analysis.
 */

import { memberClause, monthBounds, number } from './periods.js';
import { getDatabase, INVESTMENT_CATEGORIES } from './database.js';

const ESSENTIAL_CATEGORIES = new Set([
  'Groceries',
  'Utilities',
  'Rent & Housing',
  'Health',
  'Medical',
  'Insurance & Tax',
  'School',
  'Education',
  'Kids & Baby',
  'Maintenance & Repairs',
  'Loans & EMI',
  'Fuel',
  'Transport',
]);

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Extracts live financial profile from the database for retirement planning.
 */
export function getFireProfile(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');
  const [andClause, andParams] = memberClause(memberId, 'AND');

  // 1. Assets & Liabilities
  const accounts = db.all(`SELECT category, linked_holding_type, balance FROM asset_accounts${clause}`, params);
  const npsTotal = number(db.value(`SELECT SUM(current_value) FROM nps_holdings${clause}`, params));
  const folioTotal = number(db.value(`SELECT SUM(current_value) FROM mf_folios${clause}`, params));
  const dematTotal = number(db.value(`SELECT SUM(current_value) FROM demat_holdings${clause}`, params));

  let equityAssets = folioTotal + dematTotal;
  let debtAssets = npsTotal;
  let goldAssets = 0;
  let cashAssets = 0;
  let otherAssets = 0;

  for (const acc of accounts) {
    if (acc.linked_holding_type === 'nps' || (String(acc.category || '').toUpperCase() === 'NPS' && npsTotal > 0)) {
      continue;
    }
    const cat = String(acc.category || '').toLowerCase();
    const bal = number(acc.balance);
    if (cat.includes('gold') || cat.includes('sgb')) {
      goldAssets += bal;
    } else if (cat.includes('equity') || cat.includes('stock') || cat.includes('demat') || cat.includes('mf')) {
      equityAssets += bal;
    } else if (cat.includes('cash')) {
      cashAssets += bal;
    } else if (cat.includes('bank') || cat.includes('fd') || cat.includes('rd') || cat.includes('deposit') || cat.includes('debt') || cat.includes('savings')) {
      debtAssets += bal;
    } else {
      otherAssets += bal;
    }
  }

  const lent = number(db.value(
    `SELECT SUM(current_outstanding) FROM loans${clause}${clause ? ' AND' : ' WHERE'} direction = 'lent'`,
    params,
  ));
  if (lent) debtAssets += lent;

  let liabilities = number(db.value(
    `SELECT SUM(current_outstanding) FROM loans${clause}${clause ? ' AND' : ' WHERE'} COALESCE(direction, 'borrowed') != 'lent'`,
    params,
  ));
  liabilities += number(db.value(`SELECT SUM(current_balance) FROM credit_cards${clause}`, params));

  const totalAssets = equityAssets + debtAssets + goldAssets + cashAssets + otherAssets;
  const netWorth = totalAssets - liabilities;

  // 2. Asset Allocation & Weighted Expected Portfolio CAGR
  const totalInvestable = equityAssets + debtAssets + goldAssets + cashAssets;
  let weightedCagr = 12;
  if (totalInvestable > 0) {
    const eqWeight = equityAssets / totalInvestable;
    const debtWeight = debtAssets / totalInvestable;
    const goldWeight = goldAssets / totalInvestable;
    const cashWeight = cashAssets / totalInvestable;
    const cagr = (eqWeight * 12) + (debtWeight * 7) + (goldWeight * 8) + (cashWeight * 4);
    weightedCagr = Math.round(cagr * 10) / 10;
  }

  // 3. Historical Monthly Expenses & Income (past 6 completed months + current)
  const [earliestStart] = monthBounds(6);
  const [, currentEnd] = monthBounds(0);

  let totalExpenses = 0;
  let totalEssential = 0;
  let totalDiscretionary = 0;
  let totalIncome = 0;
  let totalInvested = 0;

  const txRows = db.all(
    'SELECT date, type, category, is_investment_outflow, amount FROM transactions'
    + ` WHERE date >= ? AND date < ?${andClause}`,
    [earliestStart, currentEnd, ...andParams],
  );

  const monthsSeen = new Set();
  for (const row of txRows) {
    if (row.type === 'Transfer' || row.category === 'Transfer' || row.category === 'Credit Card') continue;
    const monthKey = String(row.date).slice(0, 7);
    monthsSeen.add(monthKey);
    const amt = number(row.amount);

    if (row.type === 'Income') {
      totalIncome += amt;
    } else if (row.type === 'Investment' || row.is_investment_outflow || row.category === 'Investment Outflow' || INVESTMENT_CATEGORIES?.has(row.category)) {
      totalInvested += amt;
    } else if (row.type === 'Expense') {
      totalExpenses += amt;
      if (ESSENTIAL_CATEGORIES.has(row.category)) {
        totalEssential += amt;
      } else {
        totalDiscretionary += amt;
      }
    }
  }

  const monthsCount = Math.max(1, monthsSeen.size);
  const avgMonthlyExpenses = Math.round(totalExpenses / monthsCount);
  const avgEssentialExpenses = Math.round(totalEssential / monthsCount);
  const avgDiscretionaryExpenses = Math.round(totalDiscretionary / monthsCount);
  const avgMonthlyIncome = Math.round(totalIncome / monthsCount);
  const avgMonthlyInvested = Math.round(totalInvested / monthsCount);

  // 4. Committed Active SIPs
  const activeSipsSum = number(db.value(
    `SELECT SUM(monthly_amount) FROM sips${clause}${clause ? ' AND' : ' WHERE'} is_active = 1`,
    params,
  ));

  // Monthly savings run-rate
  const calculatedSavings = Math.max(0, avgMonthlyIncome - avgMonthlyExpenses);
  const monthlySavingsRunRate = Math.max(calculatedSavings, activeSipsSum + avgMonthlyInvested, activeSipsSum);

  // 5. Active Loans & EMIs
  const loans = db.all(
    `SELECT name, current_outstanding, monthly_emi, tenure_months FROM loans${clause}${clause ? ' AND' : ' WHERE'} COALESCE(direction, 'borrowed') != 'lent' AND is_active = 1`,
    params,
  );
  let totalLoanEmi = 0;
  let maxLoanMonthsRemaining = 0;
  for (const loan of loans) {
    totalLoanEmi += number(loan.monthly_emi);
    maxLoanMonthsRemaining = Math.max(maxLoanMonthsRemaining, number(loan.tenure_months, 0));
  }

  // 6. Settings & Preferences
  const settingsRows = db.all("SELECT key, value FROM app_settings WHERE key LIKE 'fire_%'");
  const settings = {};
  for (const s of settingsRows) {
    settings[s.key] = s.value;
  }

  const familyMembers = db.all('SELECT * FROM family_members ORDER BY is_primary DESC, id ASC');

  return {
    status: 'success',
    net_worth: netWorth,
    total_assets: totalAssets,
    total_liabilities: liabilities,
    asset_breakdown: {
      equity: equityAssets,
      debt: debtAssets,
      gold: goldAssets,
      cash: cashAssets,
      other: otherAssets,
    },
    weighted_cagr: weightedCagr,
    monthly_expenses: avgMonthlyExpenses > 0 ? avgMonthlyExpenses : 50000,
    essential_expenses: avgEssentialExpenses > 0 ? avgEssentialExpenses : Math.round((avgMonthlyExpenses || 50000) * 0.75),
    discretionary_expenses: avgDiscretionaryExpenses > 0 ? avgDiscretionaryExpenses : Math.round((avgMonthlyExpenses || 50000) * 0.25),
    monthly_income: avgMonthlyIncome,
    monthly_savings: monthlySavingsRunRate > 0 ? monthlySavingsRunRate : 30000,
    active_sips_total: activeSipsSum,
    active_loan_emi: totalLoanEmi,
    loan_months_remaining: maxLoanMonthsRemaining,
    saved_settings: settings,
    family_members: familyMembers,
    months_analyzed: monthsCount,
    has_real_data: txRows.length > 0 || totalAssets > 0 || activeSipsSum > 0,
  };
}

/**
 * Saves user retirement planning preferences to persistent app settings.
 */
export function saveFireSettings(db, args = {}) {
  const allowed = [
    'fire_current_age',
    'fire_target_age',
    'fire_expected_cagr',
    'fire_inflation_rate',
    'fire_multiplier',
    'fire_step_up_percent',
    'fire_life_expectancy',
  ];
  for (const key of allowed) {
    if (args[key] !== undefined && args[key] !== null) {
      db.run(
        'INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
        [key, String(args[key])],
      );
    }
  }
  return { status: 'success' };
}

/**
 * Core mathematical engine for FIRE projections and longevity analysis.
 */
export function calculateFireProjections({
  current_age: currentAge = 30,
  target_retirement_age: retirementAge = 50,
  life_expectancy_age: lifeExpectancyAge = 85,
  current_net_worth: currentNetWorth = 1000000,
  monthly_expenses: monthlyExpenses = 50000,
  essential_expenses: essentialExpenses = null,
  discretionary_expenses: discretionaryExpenses = null,
  monthly_savings: monthlySavings = 30000,
  annual_step_up_percent: stepUpPercent = 0,
  expected_cagr: expectedCagr = 12,
  inflation_rate: inflationRate = 6,
  fire_multiplier: fireMultiplier = 25,
  monthly_emi: monthlyEmi = 0,
  loan_months_remaining: loanMonthsRemaining = 0,
} = {}) {
  currentAge = Number.parseInt(currentAge, 10) || 30;
  retirementAge = Number.parseInt(retirementAge, 10) || 50;
  lifeExpectancyAge = Number.parseInt(lifeExpectancyAge, 10) || 85;
  currentNetWorth = number(currentNetWorth, 0);
  monthlyExpenses = Math.max(1, number(monthlyExpenses, 50000));
  monthlySavings = Math.max(0, number(monthlySavings, 30000));
  stepUpPercent = number(stepUpPercent, 0);
  expectedCagr = number(expectedCagr, 12);
  inflationRate = number(inflationRate, 6);
  fireMultiplier = Math.max(10, number(fireMultiplier, 25));
  monthlyEmi = Math.max(0, number(monthlyEmi, 0));
  loanMonthsRemaining = Math.max(0, number(loanMonthsRemaining, 0));

  const essentialExp = essentialExpenses !== null && essentialExpenses !== undefined
    ? number(essentialExpenses, monthlyExpenses * 0.75)
    : monthlyExpenses * 0.75;
  const discretionaryExp = discretionaryExpenses !== null && discretionaryExpenses !== undefined
    ? number(discretionaryExpenses, monthlyExpenses * 0.25)
    : monthlyExpenses * 0.25;

  const yearsToRetire = Math.max(1, retirementAge - currentAge);
  const realReturn = ((1 + expectedCagr / 100) / (1 + inflationRate / 100)) - 1;
  const monthlyRealReturn = (1 + realReturn) ** (1 / 12) - 1;

  // Post-retirement expense reduction if active loans end before retirement
  const loanTenureYears = loanMonthsRemaining / 12;
  let postRetireMonthlyBase = monthlyExpenses;
  if (monthlyEmi > 0 && loanTenureYears <= yearsToRetire) {
    postRetireMonthlyBase = Math.max(1000, monthlyExpenses - monthlyEmi);
  }

  const futureAnnualExpenses = (postRetireMonthlyBase * 12)
    * (1 + inflationRate / 100) ** yearsToRetire;

  const fireNumber = futureAnnualExpenses * fireMultiplier;
  const leanAnnual = (essentialExp * 12) * (1 + inflationRate / 100) ** yearsToRetire;
  const leanFire = leanAnnual * fireMultiplier;
  const fatAnnual = ((monthlyExpenses + discretionaryExp * 0.5) * 12) * (1 + inflationRate / 100) ** yearsToRetire;
  const fatFire = Math.max(fireNumber * 1.35, fatAnnual * fireMultiplier);

  // Coast FIRE: Lump sum needed today to grow into target by retirement age without adding any further savings
  const coastFire = fireNumber / (1 + realReturn) ** yearsToRetire;
  const isCoastFireAchieved = currentNetWorth >= coastFire;

  // Barista FIRE: Target corpus if semi-retired / part-time work covers 40% of living expenses
  const baristaFire = fireNumber * 0.6;

  // Progress towards FIRE target
  const progressPercent = fireNumber > 0
    ? Math.min(100, Math.round((currentNetWorth / fireNumber) * 1000) / 10)
    : 0;

  // Accumulation Phase Simulation
  let corpus = currentNetWorth;
  const curve = [];
  let fireAgeReached = null;
  let leanFireAgeReached = null;

  for (let age = currentAge; age <= retirementAge; age += 1) {
    curve.push({
      age,
      projected_net_worth: round2(corpus),
      fire_target: round2(fireNumber),
      phase: 'accumulation',
    });

    if (corpus >= fireNumber && fireAgeReached === null) {
      fireAgeReached = age;
    }
    if (corpus >= leanFire && leanFireAgeReached === null) {
      leanFireAgeReached = age;
    }

    const yearIdx = age - currentAge;
    const currentYearMonthlySavings = monthlySavings * ((1 + stepUpPercent / 100) ** yearIdx);

    for (let month = 0; month < 12; month += 1) {
      corpus = (corpus + currentYearMonthlySavings) * (1 + monthlyRealReturn);
    }
  }

  const projectedCorpusAtRetirement = corpus;
  const isFireAchievable = projectedCorpusAtRetirement >= fireNumber;
  const shortfall = Math.max(0, fireNumber - projectedCorpusAtRetirement);
  const surplus = Math.max(0, projectedCorpusAtRetirement - fireNumber);

  // Additional monthly savings needed if shortfall
  let additionalMonthlySavingsNeeded = 0;
  if (shortfall > 0 && yearsToRetire > 0) {
    const totalMonths = yearsToRetire * 12;
    if (monthlyRealReturn > 0) {
      const annuityFactor = (((1 + monthlyRealReturn) ** totalMonths - 1) / monthlyRealReturn) * (1 + monthlyRealReturn);
      additionalMonthlySavingsNeeded = Math.round(shortfall / annuityFactor);
    } else {
      additionalMonthlySavingsNeeded = Math.round(shortfall / totalMonths);
    }
  }

  // Safe monthly withdrawal in retirement
  const safeMonthlyWithdrawal = round2(projectedCorpusAtRetirement / (fireMultiplier * 12));

  // Post-Retirement Drawdown Phase Simulation
  let drawdownCorpus = projectedCorpusAtRetirement;
  const annualWithdrawal = fireNumber / fireMultiplier;
  const monthlyWithdrawal = annualWithdrawal / 12;
  let exhaustionAge = null;

  const maxSimAge = Math.max(retirementAge + 1, Math.min(100, lifeExpectancyAge));
  for (let age = retirementAge + 1; age <= maxSimAge; age += 1) {
    for (let month = 0; month < 12; month += 1) {
      drawdownCorpus = (drawdownCorpus * (1 + monthlyRealReturn)) - monthlyWithdrawal;
      if (drawdownCorpus <= 0) {
        drawdownCorpus = 0;
        if (exhaustionAge === null) exhaustionAge = age;
      }
    }
    curve.push({
      age,
      projected_net_worth: round2(drawdownCorpus),
      fire_target: round2(fireNumber),
      phase: 'drawdown',
    });
  }

  return {
    status: 'success',
    current_age: currentAge,
    retirement_age: retirementAge,
    life_expectancy_age: lifeExpectancyAge,
    years_to_retire: yearsToRetire,
    fire_number: round2(fireNumber),
    lean_fire: round2(leanFire),
    fat_fire: round2(fatFire),
    coast_fire: round2(coastFire),
    barista_fire: round2(baristaFire),
    is_coast_fire_achieved: isCoastFireAchieved,
    progress_percent: progressPercent,
    projected_corpus_at_retirement: round2(projectedCorpusAtRetirement),
    is_fire_achievable: isFireAchievable,
    fire_age_reached: fireAgeReached,
    lean_fire_age_reached: leanFireAgeReached,
    shortfall_at_retirement: round2(shortfall),
    surplus_at_retirement: round2(surplus),
    additional_monthly_savings_needed: additionalMonthlySavingsNeeded,
    safe_monthly_withdrawal_at_retirement: safeMonthlyWithdrawal,
    corpus_exhaustion_age: exhaustionAge,
    projection_curve: curve,
    real_return_rate_percent: Math.round(realReturn * 1000) / 10,
    future_monthly_expenses: round2(futureAnnualExpenses / 12),
  };
}

/**
 * Backend action dispatcher for FIRE module.
 */
export async function handleFireAction(args = {}) {
  try {
    const action = args.action || 'calculate';

    if (action === 'get_profile') {
      const db = await getDatabase();
      return getFireProfile(db, args);
    }
    if (action === 'save_settings') {
      const db = await getDatabase();
      return saveFireSettings(db, args);
    }

    return calculateFireProjections({
      current_age: Number.parseInt(args.current_age ?? 30, 10),
      target_retirement_age: Number.parseInt(args.target_retirement_age ?? 50, 10),
      life_expectancy_age: Number.parseInt(args.life_expectancy_age ?? 85, 10),
      current_net_worth: Number(args.current_net_worth ?? 1000000),
      monthly_expenses: Number(args.monthly_expenses ?? 50000),
      essential_expenses: args.essential_expenses !== undefined ? Number(args.essential_expenses) : undefined,
      discretionary_expenses: args.discretionary_expenses !== undefined ? Number(args.discretionary_expenses) : undefined,
      monthly_savings: Number(args.monthly_savings ?? 30000),
      annual_step_up_percent: Number(args.annual_step_up_percent ?? 0),
      expected_cagr: Number(args.expected_cagr ?? 12),
      inflation_rate: Number(args.inflation_rate ?? 6),
      fire_multiplier: Number(args.fire_multiplier ?? 25),
      monthly_emi: Number(args.monthly_emi ?? 0),
      loan_months_remaining: Number(args.loan_months_remaining ?? 0),
    });
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}

