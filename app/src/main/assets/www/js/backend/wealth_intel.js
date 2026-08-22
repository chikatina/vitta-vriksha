/*
 * Wealth Intelligence, Tax-Harvesting, Asset Rebalancing, Yield & Compounding Tools.
 */

import {
  isoDate, memberClause, number, parseISO, today,
} from './periods.js';
import {
  processFifoCapitalGains, calculateExactTaxHarvesting, TAX_DISCLAIMER_TEXT, TAX_DISCLAIMER_SHORT,
} from './tax_engine.js';
import { navSearch } from '../../vendor/casparser/isin.js';

const LTCG_ANNUAL_EXEMPTION = 125000; // ₹1.25 Lakh tax-free equity LTCG (Budget 2024)
const LTCG_TAX_RATE = 0.125; // 12.5% LTCG tax
const STCG_TAX_RATE = 0.20; // 20.0% STCG tax

/**
 * Calculates ₹1.25 Lakh Tax-Free LTCG Harvesting opportunities from mutual fund folios & demat holdings.
 */
export function calculateTaxHarvesting(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');

  const folioTxns = db.all(
    `SELECT id, member_id, folio_number, isin, scheme_name AS name, date, kind, amount, units, nav AS price, 'equity' AS asset_class FROM folio_transactions${clause}`,
    params,
  );
  const stockTxns = db.all(
    `SELECT id, member_id, isin, symbol, symbol AS name, trade_date AS date, trade_type AS kind, (quantity * price) AS amount, quantity AS units, price, stt, charges, 'equity' AS asset_class FROM stock_transactions${clause}`,
    params,
  );

  const combinedTxns = [...folioTxns, ...stockTxns];

  // If detailed transactions exist, use exact lot-level engine
  if (combinedTxns.length > 0) {
    const processed = processFifoCapitalGains(combinedTxns, {
      asOfDate: today(),
      fmvLookup: (code) => {
        try {
          const val = navSearch(code);
          return val ? Number(val.toString()) : 0;
        } catch {
          return 0;
        }
      },
    });

    const prices = {};
    const folios = db.all(`SELECT isin, scheme_name, nav, current_value, units FROM mf_folios${clause}`, params);
    for (const f of folios) {
      const p = number(f.nav) || (number(f.units) > 0 ? number(f.current_value) / number(f.units) : 0);
      if (f.isin) prices[f.isin] = p;
      if (f.scheme_name) prices[f.scheme_name] = p;
    }
    const demat = db.all(`SELECT isin, symbol, price, current_value, quantity FROM demat_holdings${clause}`, params);
    for (const d of demat) {
      const p = number(d.price) || (number(d.quantity) > 0 ? number(d.current_value) / number(d.quantity) : 0);
      if (d.isin) prices[d.isin] = p;
      if (d.symbol) prices[d.symbol] = p;
    }

    const exact = calculateExactTaxHarvesting(processed.activeLots, prices, {
      exemptionLimit: LTCG_ANNUAL_EXEMPTION,
    });

    const harvestableFolios = exact.harvestableHoldings.map((h) => ({
      folio_id: h.securityKey,
      scheme: h.name || h.symbol || h.isin,
      folio_number: h.securityKey,
      current_value: h.currentValue,
      cost_basis: h.costBasis,
      unrealized_gain: h.unrealizedLtcg,
      estimated_ltcg: h.unrealizedLtcg,
      return_pct: h.costBasis > 0 ? Math.round(((h.currentValue - h.costBasis) / h.costBasis) * 1000) / 10 : 0,
    }));

    return {
      status: 'success',
      disclaimer: TAX_DISCLAIMER_TEXT,
      disclaimer_short: TAX_DISCLAIMER_SHORT,
      exemption_limit: LTCG_ANNUAL_EXEMPTION,
      ltcg_tax_rate_percent: 12.5,
      stcg_tax_rate_percent: 20.0,
      total_portfolio_value: Math.round(harvestableFolios.reduce((s, f) => s + f.current_value, 0)),
      total_unrealized_gain: Math.round(exact.totalUnrealizedLtcg + exact.totalUnrealizedStcg),
      estimated_ltcg: exact.totalUnrealizedLtcg,
      estimated_stcg: exact.totalUnrealizedStcg,
      harvestable_ltcg: exact.harvestableLtcg,
      tax_saved_by_harvesting: exact.taxSavedByHarvesting,
      remaining_tax_free_limit: exact.remainingLimit,
      harvestable_folios: harvestableFolios,
      recommendation: exact.harvestableLtcg > 0
        ? `You can harvest up to ₹${exact.harvestableLtcg.toLocaleString('en-IN')} in long-term gains with ₹0 tax before March 31, saving ₹${exact.taxSavedByHarvesting.toLocaleString('en-IN')} in tax.`
        : 'No unrealized long-term capital gains available to harvest currently.',
    };
  }

  // Fallback for snapshot-only folios without transaction lines
  const folios = db.all(
    `SELECT id, scheme_name, folio_number, COALESCE(invested_value, 0) AS purchase_cost, current_value, last_updated FROM mf_folios${clause}`,
    params,
  );

  let totalCurrentValue = 0;
  let totalCost = 0;
  let totalUnrealizedGain = 0;
  let estimatedLTCG = 0;
  let estimatedSTCG = 0;

  const harvestableFolios = [];

  for (const f of folios) {
    const cost = number(f.purchase_cost);
    const value = number(f.current_value);
    const gain = value - cost;

    totalCurrentValue += value;
    totalCost += cost;

    if (gain > 0) {
      totalUnrealizedGain += gain;
      const ltcgShare = gain * 0.8;
      const stcgShare = gain * 0.2;
      estimatedLTCG += ltcgShare;
      estimatedSTCG += stcgShare;

      harvestableFolios.push({
        folio_id: f.id,
        scheme: f.scheme_name,
        folio_number: f.folio_number,
        current_value: Math.round(value),
        cost_basis: Math.round(cost),
        unrealized_gain: Math.round(gain),
        estimated_ltcg: Math.round(ltcgShare),
        return_pct: cost > 0 ? Math.round((gain / cost) * 1000) / 10 : 0,
      });
    }
  }

  harvestableFolios.sort((a, b) => b.estimated_ltcg - a.estimated_ltcg);

  const harvestableLtcg = Math.min(LTCG_ANNUAL_EXEMPTION, Math.round(estimatedLTCG));
  const taxSaved = Math.round(harvestableLtcg * LTCG_TAX_RATE);
  const remainingExemption = Math.max(0, LTCG_ANNUAL_EXEMPTION - harvestableLtcg);

  return {
    status: 'success',
    disclaimer: TAX_DISCLAIMER_TEXT,
    disclaimer_short: TAX_DISCLAIMER_SHORT,
    exemption_limit: LTCG_ANNUAL_EXEMPTION,
    ltcg_tax_rate_percent: 12.5,
    stcg_tax_rate_percent: 20.0,
    total_portfolio_value: Math.round(totalCurrentValue),
    total_unrealized_gain: Math.round(totalUnrealizedGain),
    estimated_ltcg: Math.round(estimatedLTCG),
    estimated_stcg: Math.round(estimatedSTCG),
    harvestable_ltcg: harvestableLtcg,
    tax_saved_by_harvesting: taxSaved,
    remaining_tax_free_limit: remainingExemption,
    harvestable_folios: harvestableFolios,
    recommendation: harvestableLtcg > 0
      ? `You can harvest up to ₹${harvestableLtcg.toLocaleString('en-IN')} in long-term gains with ₹0 tax before March 31, saving ₹${taxSaved.toLocaleString('en-IN')} in tax.`
      : 'No unrealized long-term capital gains available to harvest currently.',
  };
}

/**
 * Smart Portfolio Rebalancer (Target vs Actual Allocation with SIP routing).
 */
export function calculatePortfolioRebalance(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');

  // Fetch all asset accounts and investment values
  const accounts = db.all(`SELECT category, linked_holding_type, balance FROM asset_accounts${clause}`, params);
  const mfTotal = number(db.value(`SELECT SUM(current_value) FROM mf_folios${clause}`, params));
  const dematTotal = number(db.value(`SELECT SUM(current_value) FROM demat_holdings${clause}`, params));
  const npsTotal = number(db.value(`SELECT SUM(current_value) FROM nps_holdings${clause}`, params));

  let equity = mfTotal + dematTotal;
  let debt = 0;
  let gold = 0;
  let alternative = 0;

  for (const acc of accounts) {
    if (acc.linked_holding_type === 'nps' || (String(acc.category || '').toUpperCase() === 'NPS' && npsTotal > 0)) {
      continue;
    }
    const cat = String(acc.category || '').toLowerCase();
    const bal = number(acc.balance);
    if (cat.includes('gold') || cat.includes('sgb')) gold += bal;
    else if (cat.includes('crypto') || cat.includes('art') || cat.includes('land')) alternative += bal;
    else if (cat.includes('equity') || cat.includes('stock')) equity += bal;
    else debt += bal; // Bank, FD, Savings, Debt
  }
  debt += npsTotal;

  const totalAssets = equity + debt + gold + alternative;

  // Target allocation (defaults: 70% Equity, 20% Debt, 10% Gold, 0% Alt, or custom)
  const targetEquity = number(args.target_equity, 70);
  const targetDebt = number(args.target_debt, 20);
  const targetGold = number(args.target_gold, 10);
  const targetAlt = number(args.target_alt, 0);

  const currentEquityPct = totalAssets > 0 ? (equity / totalAssets) * 100 : 0;
  const currentDebtPct = totalAssets > 0 ? (debt / totalAssets) * 100 : 0;
  const currentGoldPct = totalAssets > 0 ? (gold / totalAssets) * 100 : 0;
  const currentAltPct = totalAssets > 0 ? (alternative / totalAssets) * 100 : 0;

  const monthlySipBudget = number(args.monthly_sip_budget, 25000);

  // Calculate gaps in Rupees
  const targetEquityVal = (totalAssets * targetEquity) / 100;
  const targetDebtVal = (totalAssets * targetDebt) / 100;
  const targetGoldVal = (totalAssets * targetGold) / 100;

  const equityGap = targetEquityVal - equity;
  const debtGap = targetDebtVal - debt;
  const goldGap = targetGoldVal - gold;

  // SIP Rebalance Distribution: route monthly SIP to underweight assets
  const deficits = [
    { name: 'Equity', gap: equityGap, current: equity, currentPct: currentEquityPct, targetPct: targetEquity },
    { name: 'Debt & FD', gap: debtGap, current: debt, currentPct: currentDebtPct, targetPct: targetDebt },
    { name: 'Gold & SGB', gap: goldGap, current: gold, currentPct: currentGoldPct, targetPct: targetGold },
  ].filter((d) => d.gap > 0);

  const totalDeficit = deficits.reduce((sum, d) => sum + d.gap, 0);
  const sipRouting = deficits.map((d) => ({
    asset_class: d.name,
    recommended_monthly_sip: totalDeficit > 0 ? Math.round((d.gap / totalDeficit) * monthlySipBudget) : 0,
    shortfall: Math.round(d.gap),
  }));

  return {
    status: 'success',
    total_portfolio_value: Math.round(totalAssets),
    current_allocation: {
      equity: { value: Math.round(equity), percent: Math.round(currentEquityPct * 10) / 10 },
      debt: { value: Math.round(debt), percent: Math.round(currentDebtPct * 10) / 10 },
      gold: { value: Math.round(gold), percent: Math.round(currentGoldPct * 10) / 10 },
      alternative: { value: Math.round(alternative), percent: Math.round(currentAltPct * 10) / 10 },
    },
    target_allocation: {
      equity: targetEquity,
      debt: targetDebt,
      gold: targetGold,
      alternative: targetAlt,
    },
    is_balanced: Math.abs(currentEquityPct - targetEquity) < 3 && Math.abs(currentDebtPct - targetDebt) < 3,
    monthly_sip_budget: monthlySipBudget,
    sip_rebalancing_plan: sipRouting,
  };
}

/**
 * Aggregates dividend and interest inflows across accounts and folios to calculate passive yield run-rate.
 */
export function calculatePassiveYield(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'AND');

  // Past 12 months
  const now = new Date();
  const past12ISO = `${now.getFullYear() - 1}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const rows = db.all(
    'SELECT date, amount, description, merchant, category FROM transactions'
    + ` WHERE date >= ? AND type = 'Income' AND (category IN ('Dividend', 'Interest', 'Yield', 'Cashback', 'Interest & Dividends') OR description LIKE '%dividend%' OR description LIKE '%interest%')${clause}`,
    [past12ISO, ...params],
  );

  let totalPassive12m = 0;
  const monthlyTotals = new Map();

  for (const r of rows) {
    const amt = number(r.amount);
    totalPassive12m += amt;
    const monthKey = String(r.date).slice(0, 7);
    monthlyTotals.set(monthKey, (monthlyTotals.get(monthKey) || 0) + amt);
  }

  const monthlyRunRate = Math.round(totalPassive12m / 12);

  // Total Portfolio for yield % calculation
  const totalAssets = number(db.value('SELECT SUM(balance) FROM asset_accounts'))
    + number(db.value('SELECT SUM(current_value) FROM mf_folios'))
    + number(db.value('SELECT SUM(current_value) FROM demat_holdings'));

  const portfolioYieldPct = totalAssets > 0 ? Math.round(((totalPassive12m / totalAssets) * 100) * 100) / 100 : 0;

  return {
    status: 'success',
    total_passive_12m: Math.round(totalPassive12m),
    monthly_run_rate: monthlyRunRate,
    portfolio_yield_percent: portfolioYieldPct,
    total_investment_assets: Math.round(totalAssets),
    transaction_count: rows.length,
    recent_payouts: rows.slice(0, 8),
  };
}

/**
 * Calculates Direct vs Regular Mutual Fund compounding expense drag.
 */
export function calculateDirectVsRegularDrag(monthlySip = 10000, lumpsum = 100000, expectedCagr = 12, years = 20) {
  const pSip = number(monthlySip, 10000);
  const pLump = number(lumpsum, 0);
  const rGross = number(expectedCagr, 12) / 100;
  const tYears = number(years, 20);

  // Direct fund (0.5% TER) -> Net CAGR = rGross - 0.005
  // Regular fund (1.5% TER) -> Net CAGR = rGross - 0.015 (1.0% distributor commission lost)
  const rDirect = (rGross - 0.005) / 12;
  const rRegular = (rGross - 0.015) / 12;
  const totalMonths = tYears * 12;

  let directWealth = pLump * Math.pow(1 + (rGross - 0.005), tYears);
  let regularWealth = pLump * Math.pow(1 + (rGross - 0.015), tYears);

  for (let m = 1; m <= totalMonths; m += 1) {
    directWealth += pSip * Math.pow(1 + rDirect, totalMonths - m + 1);
    regularWealth += pSip * Math.pow(1 + rRegular, totalMonths - m + 1);
  }

  const commissionLost = directWealth - regularWealth;
  const lostPercent = directWealth > 0 ? Math.round((commissionLost / directWealth) * 1000) / 10 : 0;

  return {
    status: 'success',
    tenure_years: tYears,
    monthly_sip: pSip,
    direct_final_wealth: Math.round(directWealth),
    regular_final_wealth: Math.round(regularWealth),
    commission_lost_to_distributor: Math.round(commissionLost),
    wealth_lost_percent: lostPercent,
    verdict: `By choosing Direct plans over Regular plans, you save ₹${Math.round(commissionLost).toLocaleString('en-IN')} (+${lostPercent}%) over ${tYears} years.`,
  };
}

/**
 * Fixed Deposit (FD) Laddering and Maturity Schedule.
 */
export function calculateFdLadder(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');

  const fds = db.all(
    `SELECT id, name, category, balance FROM asset_accounts${clause}`,
    params,
  ).filter((a) => {
    const cat = String(a.category || '').toLowerCase();
    return cat.includes('fd') || cat.includes('deposit') || cat.includes('fixed');
  });

  const totalFdValue = fds.reduce((sum, f) => sum + number(f.balance), 0);

  return {
    status: 'success',
    total_fd_value: Math.round(totalFdValue),
    deposit_count: fds.length,
    deposits: fds.map((f) => ({
      id: f.id,
      name: f.name,
      amount: number(f.balance),
    })),
  };
}

/**
 * Sovereign Gold Bond (SGB) Interest & Maturity Schedule.
 */
export function calculateSgbSchedule(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');

  const sgbs = db.all(
    `SELECT id, name, category, balance FROM asset_accounts${clause}`,
    params,
  ).filter((a) => {
    const cat = String(a.category || '').toLowerCase();
    const name = String(a.name || '').toLowerCase();
    return cat.includes('sgb') || name.includes('sgb') || name.includes('sovereign gold');
  });

  const totalSgbValue = sgbs.reduce((sum, s) => sum + number(s.balance), 0);
  const annualInterest = totalSgbValue * 0.025; // 2.5% semi-annual coupon

  return {
    status: 'success',
    total_sgb_value: Math.round(totalSgbValue),
    annual_interest_payout: Math.round(annualInterest),
    semi_annual_payout: Math.round(annualInterest / 2),
    tranches: sgbs.map((s) => ({
      id: s.id,
      name: s.name,
      amount: number(s.balance),
      annual_coupon: Math.round(number(s.balance) * 0.025),
    })),
  };
}

/**
 * Calculates Inflation-Adjusted Real XIRR / Returns.
 */
export function calculateRealReturn(nominalReturnPct = 14, inflationPct = 5.5) {
  const rNominal = number(nominalReturnPct, 14) / 100;
  const rInflation = number(inflationPct, 5.5) / 100;

  // Fisher equation: 1 + real = (1 + nominal) / (1 + inflation)
  const denom = 1 + rInflation;
  const realReturn = denom !== 0 ? ((1 + rNominal) / denom) - 1 : rNominal;
  const realReturnPct = Math.round(realReturn * 1000) / 10;

  return {
    status: 'success',
    nominal_return_percent: number(nominalReturnPct, 14),
    inflation_rate_percent: number(inflationPct, 5.5),
    real_return_percent: realReturnPct,
    purchasing_power_growth: realReturnPct > 0 ? 'expanding' : 'eroding',
    verdict: realReturnPct > 0
      ? `Your wealth grows by ${realReturnPct}% per year in real purchasing power after defeating ${inflationPct}% inflation.`
      : `At ${nominalReturnPct}% returns, inflation (${inflationPct}%) is eroding your real purchasing power.`,
  };
}

/**
 * Calculates Net Worth Milestones from ₹1 Lakh to ₹10 Crore with progress and distance.
 */
export function getNetWorthMilestones(currentNetWorth = 0) {
  const nw = Math.max(0, number(currentNetWorth, 0));
  const MILESTONES = [
    { target: 100000, label: '₹1L', name: '1 Lakh' },
    { target: 500000, label: '₹5L', name: '5 Lakhs' },
    { target: 1000000, label: '₹10L', name: '10 Lakhs' },
    { target: 2500000, label: '₹25L', name: '25 Lakhs' },
    { target: 5000000, label: '₹50L', name: '50 Lakhs' },
    { target: 10000000, label: '₹1 Cr', name: '1 Crore' },
    { target: 25000000, label: '₹2.5 Cr', name: '2.5 Crores' },
    { target: 50000000, label: '₹5 Cr', name: '5 Crores' },
    { target: 100000000, label: '₹10 Cr', name: '10 Crores' },
  ];

  let nextMilestone = null;
  const milestones = MILESTONES.map((m) => {
    const achieved = nw >= m.target;
    const isNext = !achieved && (!nextMilestone);
    if (isNext) nextMilestone = m;
    const pct = Math.min(100, Math.round((nw / m.target) * 100));
    return {
      ...m,
      achieved,
      isNext,
      pct,
    };
  });

  return {
    status: 'success',
    current_net_worth: nw,
    milestones,
    next_milestone: nextMilestone || MILESTONES[MILESTONES.length - 1],
    progress_to_next: nextMilestone ? Math.min(100, Math.round((nw / nextMilestone.target) * 100)) : 100,
    distance_to_next: nextMilestone ? Math.max(0, nextMilestone.target - nw) : 0,
  };
}

/**
 * Calculates Fixed / Recurring Deposit maturity date, days remaining, interest accrued, and payout.
 */
export function calculateFdMaturity(principal = 100000, annualRate = 7.25, tenureMonths = 12, startDate = null) {
  const p = number(principal, 100000);
  const r = number(annualRate, 7.25) / 100;
  const tMonths = Math.max(1, number(tenureMonths, 12));
  const tYears = tMonths / 12;

  // Indian quarterly compounding standard for bank FDs (n=4)
  const maturityValue = p * Math.pow(1 + (r / 4), 4 * tYears);
  const totalInterest = maturityValue - p;

  const start = startDate ? (parseISO(startDate) || new Date()) : new Date();
  const maturityDate = new Date(start.getFullYear(), start.getMonth() + tMonths, start.getDate());

  const todayDate = new Date();
  const diffTime = maturityDate.getTime() - todayDate.getTime();
  const daysLeft = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));

  return {
    status: 'success',
    principal: Math.round(p),
    annual_rate: number(annualRate, 7.25),
    tenure_months: tMonths,
    maturity_value: Math.round(maturityValue),
    total_interest: Math.round(totalInterest),
    maturity_date: isoDate(maturityDate),
    days_left: daysLeft,
    is_matured: daysLeft === 0,
  };
}
