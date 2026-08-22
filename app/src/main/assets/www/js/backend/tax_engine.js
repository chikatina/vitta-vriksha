/*
 * Unified FIFO Capital Gains, Holding Period & Tax Filing Engine.
 *
 * Implements statutory Indian Income Tax provisions:
 * - Section 111A (Short-Term Capital Gains on listed equity / equity MFs)
 * - Section 112A (Long-Term Capital Gains & Jan 31, 2018 Grandfathering)
 * - Section 50AA (Debt Mutual Funds bought on/after April 1, 2023)
 * - Finance (No. 2) Act 2024 regime split (July 23, 2024 cutoff, 15%->20% STCG, 10%->12.5% LTCG, Rs 1.25L exemption)
 * - Advance Tax 5 quarterly windows (Schedule CG Section F)
 * - Lot-level open holding maturity & tax-free LTCG harvesting
 */

import { nameForIsin } from './isin.js';
import { today } from './periods.js';

export const TAX_DISCLAIMER_TEXT =
  'IMPORTANT NOTICE: Vitta Vriksha is an offline personal productivity enablement tool and is NOT a financial institution, SEBI-registered investment advisor, or Chartered Accountant. All capital gains, holding periods, grandfathering values, and tax calculations are estimates generated strictly for personal tracking based on user-provided data and standard statutory formulas. Tax rules are complex, subject to regulatory changes, and vary based on your individual tax regime, deductions, and slab. Users must independently verify all calculations and consult a certified Chartered Accountant (CA) or check against official broker capital gains statements before filing Income Tax Returns.';

export const TAX_DISCLAIMER_SHORT =
  'Productivity Estimator Tool Only — No Financial or Tax Advice. Verify independently with a Chartered Accountant before filing.';

export const LTCG_REGIME_CUTOFF = '2024-07-23';
export const GRANDFATHER_CUTOFF = '2018-01-31';
export const GRANDFATHER_SELL_CUTOFF = '2018-04-01';
export const DEBT_SEC50AA_CUTOFF = '2023-04-01';

export const ADVANCE_TAX_QUARTER_LABELS = [
  'Upto 15/6 (Q1)',
  '16/6 to 15/9 (Q2)',
  '16/9 to 15/12 (Q3)',
  '16/12 to 15/3 (Q4)',
  '16/3 to 31/3 (Q5)',
];

/**
 * Difference in calendar days between two YYYY-MM-DD date strings.
 */
export function daysBetween(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const diffMs = end.getTime() - start.getTime();
  return Math.max(0, Math.round(diffMs / (1000 * 60 * 60 * 24)));
}

/**
 * Converts a YYYY-MM-DD date string to its Indian Financial Year (e.g., '2024-05-10' -> 'FY2024-25').
 */
export function getFinancialYear(dateStr) {
  if (!dateStr) return 'Unknown';
  const str = String(dateStr).trim();
  const year = parseInt(str.slice(0, 4), 10);
  const month = parseInt(str.slice(5, 7), 10);
  if (Number.isNaN(year) || Number.isNaN(month)) return 'Unknown';
  if (month >= 4) {
    return `FY${year}-${String(year + 1).slice(-2)}`;
  }
  return `FY${year - 1}-${String(year).slice(-2)}`;
}

/**
 * Determines whether a sale occurred Before (BE) or on/After (AE) the July 23, 2024 Budget cutoff.
 */
export function transferFlag(saleDate) {
  return String(saleDate || '') < LTCG_REGIME_CUTOFF ? 'BE' : 'AE';
}

/**
 * Maps a sale date to one of the 5 Advance Tax quarterly windows (indices 0 to 4).
 */
export function getAdvanceTaxQuarter(saleDate) {
  if (!saleDate) return 0;
  const str = String(saleDate).slice(5, 10); // MM-DD
  if (str <= '06-15' && str >= '04-01') return 0; // 01-Apr to 15-Jun
  if (str <= '09-15' && str >= '06-16') return 1; // 16-Jun to 15-Sep
  if (str <= '12-15' && str >= '09-16') return 2; // 16-Sep to 15-Dec
  if (str <= '03-15' || str >= '12-16') return 3; // 16-Dec to 15-Mar
  return 4; // 16-Mar to 31-Mar
}

/**
 * Classifies asset holding period rules:
 * - Equity / Equity MF: > 365 days = Long Term
 * - Debt MF post-01-Apr-2023: Short Term regardless of duration (Sec 50AA)
 * - Debt MF pre-01-Apr-2023: > 1095 days (36 months) = Long Term
 * - Other / Unlisted: > 730 days (24 months) = Long Term
 */
export function isLongTermAsset(assetClass, buyDate, sellDate) {
  const days = daysBetween(buyDate, sellDate);
  const cls = String(assetClass || 'equity').toLowerCase();

  if (cls === 'debt') {
    if (String(buyDate) >= DEBT_SEC50AA_CUTOFF) {
      return false; // Section 50AA applies: deemed short term
    }
    return days > 1095; // 3 years for older debt funds
  }
  if (cls === 'unlisted') {
    return days > 730;
  }
  // Equity shares, equity-oriented mutual funds, ETFs
  return days > 365;
}

/**
 * Calculates Section 112A Grandfathered Cost of Acquisition for equity assets bought before 31-Jan-2018.
 */
export function calculateGrandfatheredCost(actualCostPerUnit, fmv2018PerUnit, salePricePerUnit) {
  const actual = Number(actualCostPerUnit) || 0;
  const fmv = Number(fmv2018PerUnit) || 0;
  const sale = Number(salePricePerUnit) || 0;

  if (fmv <= 0) return actual;
  // Cost = Higher of (Actual Cost, Lower of (FMV as of 31-Jan-2018, Sale Price))
  const fmvOrSale = Math.min(fmv, sale);
  return Math.max(actual, fmvOrSale);
}

/**
 * Core FIFO Lot Matching Engine.
 *
 * Takes buy transactions, sell transactions, and current market prices/NAVs.
 * Returns:
 * 1. Realized Gains lots (matched buy lots with holding periods, STCG/LTCG, Section 112A FMV, and regime flags)
 * 2. Active Open Lots (unrealized units with days held, LTCG status, and countdown days to LTCG maturity)
 * 3. Schedule CG, Schedule 112A CSV data, and 5-Quarter Advance Tax breakdown.
 */
export function processFifoCapitalGains(transactions = [], options = {}) {
  const asOfDate = options.asOfDate || today();
  const fmvLookup = options.fmvLookup || (() => null);

  // Group transactions by distinct security (ISIN, or symbol/folio fallback)
  const securityMap = new Map();

  for (const txn of transactions) {
    const key = String(txn.isin || txn.symbol || txn.folio_number || 'UNKNOWN').trim().toUpperCase();
    if (!securityMap.has(key)) {
      securityMap.set(key, {
        key,
        isin: txn.isin || '',
        symbol: txn.symbol || '',
        name: txn.name || txn.scheme_name || nameForIsin(txn.isin) || txn.symbol || key,
        assetClass: txn.asset_class || 'equity',
        buys: [],
        sells: [],
      });
    }

    const sec = securityMap.get(key);
    const date = String(txn.date || txn.trade_date || '').slice(0, 10);
    const units = Math.abs(Number(txn.units ?? txn.quantity ?? 0));
    const price = Number(txn.price ?? txn.nav ?? 0);
    const amount = Number(txn.amount ?? (units * price) ?? 0);
    const kind = String(txn.kind || txn.trade_type || txn.type || '').toUpperCase();

    const isSell = kind.includes('SELL') || kind.includes('REDEMPTION') || kind.includes('SWITCH_OUT') || (amount < 0 && units < 0);

    if (units <= 0 && amount <= 0) continue;

    const normalizedTxn = {
      id: txn.id,
      date,
      units: units || (price > 0 ? Math.abs(amount) / price : 0),
      price: price || (units > 0 ? Math.abs(amount) / units : 0),
      amount: Math.abs(amount) || (units * price),
      stt: Number(txn.stt || 0),
      charges: Number(txn.charges || 0),
      description: txn.description || '',
    };

    if (isSell) {
      sec.sells.push(normalizedTxn);
    } else {
      sec.buys.push(normalizedTxn);
    }
  }

  const realizedLots = [];
  const activeLots = [];

  for (const sec of securityMap.values()) {
    // Sort chronologically
    sec.buys.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));
    sec.sells.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0)));

    const fmv2018 = Number(fmvLookup(sec.isin)) || 0;

    // Build open buy lots queue
    const buyQueue = sec.buys.map((b) => ({
      buyId: b.id,
      buyDate: b.date,
      initialUnits: b.units,
      remainingUnits: b.units,
      buyPrice: b.price,
      actualCostPerUnit: b.price,
      fmv2018PerUnit: fmv2018,
      sttPerUnit: b.units > 0 ? b.stt / b.units : 0,
      chargesPerUnit: b.units > 0 ? b.charges / b.units : 0,
    }));

    // Match sells against buy queue FIFO
    for (const sell of sec.sells) {
      let unitsNeeded = sell.units;
      const sellPrice = sell.price;
      const sellDate = sell.date;

      for (const buyLot of buyQueue) {
        if (unitsNeeded <= 0.00001) break;
        if (buyLot.remainingUnits <= 0.00001) continue;

        const matchedUnits = Math.min(unitsNeeded, buyLot.remainingUnits);
        const daysHeld = daysBetween(buyLot.buyDate, sellDate);
        const isLtcg = isLongTermAsset(sec.assetClass, buyLot.buyDate, sellDate);
        const isGrandfathered = isLtcg
          && String(sec.assetClass).toLowerCase() === 'equity'
          && buyLot.buyDate <= GRANDFATHER_CUTOFF
          && sellDate >= GRANDFATHER_SELL_CUTOFF
          && buyLot.fmv2018PerUnit > 0;

        const effectiveCostPerUnit = isGrandfathered
          ? calculateGrandfatheredCost(buyLot.actualCostPerUnit, buyLot.fmv2018PerUnit, sellPrice)
          : buyLot.actualCostPerUnit;

        const saleConsideration = matchedUnits * sellPrice;
        const actualCost = matchedUnits * buyLot.actualCostPerUnit;
        const taxCost = matchedUnits * effectiveCostPerUnit;
        const gain = saleConsideration - taxCost;
        const flag = transferFlag(sellDate);
        const quarter = getAdvanceTaxQuarter(sellDate);
        const fy = getFinancialYear(sellDate);

        realizedLots.push({
          securityKey: sec.key,
          isin: sec.isin,
          symbol: sec.symbol,
          name: sec.name,
          assetClass: sec.assetClass,
          financialYear: fy,
          buyDate: buyLot.buyDate,
          sellDate,
          units: matchedUnits,
          buyPrice: buyLot.actualCostPerUnit,
          sellPrice,
          saleConsideration,
          actualCost,
          taxCost,
          fmv2018PerUnit: buyLot.fmv2018PerUnit,
          isGrandfathered,
          gain,
          daysHeld,
          gainType: isLtcg ? 'LTCG' : 'STCG',
          transferFlag: flag,
          advanceTaxQuarter: quarter,
        });

        buyLot.remainingUnits -= matchedUnits;
        unitsNeeded -= matchedUnits;
      }
    }

    // Retain remaining units as active open lots
    for (const buyLot of buyQueue) {
      if (buyLot.remainingUnits > 0.00001) {
        const daysHeld = daysBetween(buyLot.buyDate, asOfDate);
        const isLtcg = isLongTermAsset(sec.assetClass, buyLot.buyDate, asOfDate);
        const daysToLtcg = isLtcg ? 0 : Math.max(0, 366 - daysHeld);

        activeLots.push({
          securityKey: sec.key,
          isin: sec.isin,
          symbol: sec.symbol,
          name: sec.name,
          assetClass: sec.assetClass,
          buyDate: buyLot.buyDate,
          remainingUnits: buyLot.remainingUnits,
          buyPrice: buyLot.actualCostPerUnit,
          investedCost: buyLot.remainingUnits * buyLot.actualCostPerUnit,
          daysHeld,
          gainType: isLtcg ? 'LTCG' : 'STCG',
          daysToLtcg,
          isLtcg,
        });
      }
    }
  }

  // Aggregate by Financial Year
  const fyMap = new Map();

  for (const lot of realizedLots) {
    const fy = lot.financialYear;
    if (!fyMap.has(fy)) {
      fyMap.set(fy, {
        financialYear: fy,
        disclaimer: TAX_DISCLAIMER_TEXT,
        disclaimerShort: TAX_DISCLAIMER_SHORT,
        stcgEquityBe: 0, // 15%
        stcgEquityAe: 0, // 20%
        ltcgEquityBe: 0, // 10%
        ltcgEquityAe: 0, // 12.5%
        debtGains: 0, // slab rate
        totalRealizedGain: 0,
        totalRealizedLoss: 0,
        netGain: 0,
        ltcgExemption: fy >= 'FY2024-25' ? 125000 : 100000,
        quarterlyGains: [0, 0, 0, 0, 0],
        lots: [],
      });
    }

    const fyData = fyMap.get(fy);
    fyData.lots.push(lot);

    const gain = lot.gain;
    if (gain >= 0) {
      fyData.totalRealizedGain += gain;
    } else {
      fyData.totalRealizedLoss += Math.abs(gain);
    }
    fyData.netGain += gain;

    // Distribute to advance tax quarter
    if (lot.advanceTaxQuarter >= 0 && lot.advanceTaxQuarter < 5) {
      fyData.quarterlyGains[lot.advanceTaxQuarter] += gain;
    }

    // Classify gain buckets
    const isEquity = String(lot.assetClass).toLowerCase() === 'equity';
    if (isEquity) {
      if (lot.gainType === 'STCG') {
        if (lot.transferFlag === 'BE') fyData.stcgEquityBe += gain;
        else fyData.stcgEquityAe += gain;
      } else {
        if (lot.transferFlag === 'BE') fyData.ltcgEquityBe += gain;
        else fyData.ltcgEquityAe += gain;
      }
    } else {
      fyData.debtGains += gain;
    }
  }

  // Compute final taxable figures per FY
  const financialYears = [...fyMap.keys()].sort().reverse();
  const fyReports = {};

  for (const fy of financialYears) {
    const report = fyMap.get(fy);
    const totalLtcg = Math.max(0, report.ltcgEquityBe + report.ltcgEquityAe);
    const taxableLtcg = Math.max(0, totalLtcg - report.ltcgExemption);

    // Tax rate projections
    const stcgTax = (Math.max(0, report.stcgEquityBe) * 0.15) + (Math.max(0, report.stcgEquityAe) * 0.20);
    let ltcgTax = 0;
    if (totalLtcg > 0 && taxableLtcg > 0) {
      const beShare = report.ltcgEquityBe > 0 ? (report.ltcgEquityBe / totalLtcg) * taxableLtcg : 0;
      const aeShare = report.ltcgEquityAe > 0 ? (report.ltcgEquityAe / totalLtcg) * taxableLtcg : 0;
      ltcgTax = (beShare * 0.10) + (aeShare * 0.125);
    }

    report.taxableLtcg = Math.round(taxableLtcg);
    report.estimatedTax = Math.round(stcgTax + ltcgTax);
    report.schedule112aCsv = generateSchedule112aCsv(report.lots.filter((l) => l.gainType === 'LTCG'));
    fyReports[fy] = report;
  }

  return {
    status: 'success',
    disclaimer: TAX_DISCLAIMER_TEXT,
    disclaimerShort: TAX_DISCLAIMER_SHORT,
    financialYears,
    financialYearReports: fyReports,
    realizedLots,
    activeLots,
    activeSummary: summarizeActiveLots(activeLots),
  };
}

/**
 * Generates official Schedule 112A CSV format for ITR upload.
 */
export function generateSchedule112aCsv(ltcgLots = []) {
  const headers = [
    'ISIN',
    'Name of Share/Unit',
    'No of Shares/Units',
    'Sale Price Per Share/Unit',
    'Total Sale Consideration',
    'Cost of Acquisition',
    'Fair Market Value as on 31 Jan 2018',
    'Total Fair Market Value',
    'Grandfathered Cost of Acquisition',
    'Deductions (STT/Exp)',
    'Total Capital Gain',
    'Transfer Flag (BE/AE)',
  ];

  const rows = ltcgLots.map((l) => [
    `"${l.isin || 'INNOTREQUIRD'}"`,
    `"${(l.name || 'CONSOLIDATED').replace(/"/g, '""')}"`,
    Number(l.units).toFixed(3),
    Number(l.sellPrice).toFixed(2),
    Math.round(l.saleConsideration),
    Math.round(l.actualCost),
    Number(l.fmv2018PerUnit || 0).toFixed(2),
    Math.round(l.units * (l.fmv2018PerUnit || 0)),
    Math.round(l.taxCost),
    0,
    Math.round(l.gain),
    l.transferFlag,
  ]);

  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
}

/**
 * Summarizes active holding lots into holding status and tax-harvesting metrics.
 */
function summarizeActiveLots(activeLots = []) {
  let totalInvested = 0;
  let ltcgCount = 0;
  let stcgCount = 0;
  let maturingSoonCount = 0; // maturing into LTCG within 30 days

  for (const lot of activeLots) {
    totalInvested += lot.investedCost;
    if (lot.isLtcg) {
      ltcgCount += 1;
    } else {
      stcgCount += 1;
      if (lot.daysToLtcg <= 30) {
        maturingSoonCount += 1;
      }
    }
  }

  return {
    totalActiveLots: activeLots.length,
    totalInvested: Math.round(totalInvested),
    ltcgLotsCount: ltcgCount,
    stcgLotsCount: stcgCount,
    maturingSoonCount,
  };
}

/**
 * Calculates exact Tax-Free LTCG Harvesting opportunities using active lots and current valuations.
 */
export function calculateExactTaxHarvesting(activeLots = [], currentPrices = {}, options = {}) {
  const ltcgExemptionLimit = options.exemptionLimit || 125000;
  const ltcgTaxRate = 0.125;

  let totalUnrealizedLtcg = 0;
  let totalUnrealizedStcg = 0;
  const harvestableHoldings = [];

  // Group active lots by security
  const bySec = new Map();
  for (const lot of activeLots) {
    if (!bySec.has(lot.securityKey)) {
      bySec.set(lot.securityKey, {
        securityKey: lot.securityKey,
        name: lot.name,
        isin: lot.isin,
        symbol: lot.symbol,
        assetClass: lot.assetClass,
        ltcgLots: [],
        stcgLots: [],
      });
    }
    const sec = bySec.get(lot.securityKey);
    if (lot.isLtcg) sec.ltcgLots.push(lot);
    else sec.stcgLots.push(lot);
  }

  for (const sec of bySec.values()) {
    const currentPrice = Number(currentPrices[sec.securityKey] || currentPrices[sec.isin] || currentPrices[sec.symbol]) || 0;
    if (currentPrice <= 0) continue;

    let secLtcgCost = 0;
    let secLtcgUnits = 0;
    for (const lot of sec.ltcgLots) {
      secLtcgUnits += lot.remainingUnits;
      secLtcgCost += lot.investedCost;
    }

    const secLtcgValue = secLtcgUnits * currentPrice;
    const secLtcgGain = secLtcgValue - secLtcgCost;

    if (secLtcgGain > 0) {
      totalUnrealizedLtcg += secLtcgGain;
      harvestableHoldings.push({
        securityKey: sec.securityKey,
        name: sec.name,
        isin: sec.isin,
        symbol: sec.symbol,
        units: secLtcgUnits,
        currentPrice,
        costBasis: Math.round(secLtcgCost),
        currentValue: Math.round(secLtcgValue),
        unrealizedLtcg: Math.round(secLtcgGain),
      });
    }

    for (const lot of sec.stcgLots) {
      const val = lot.remainingUnits * currentPrice;
      const gain = val - lot.investedCost;
      if (gain > 0) totalUnrealizedStcg += gain;
    }
  }

  harvestableHoldings.sort((a, b) => b.unrealizedLtcg - a.unrealizedLtcg);

  const harvestableAmount = Math.min(ltcgExemptionLimit, Math.round(totalUnrealizedLtcg));
  const taxSaved = Math.round(harvestableAmount * ltcgTaxRate);
  const remainingLimit = Math.max(0, ltcgExemptionLimit - harvestableAmount);

  return {
    status: 'success',
    disclaimer: TAX_DISCLAIMER_TEXT,
    disclaimerShort: TAX_DISCLAIMER_SHORT,
    exemptionLimit: ltcgExemptionLimit,
    totalUnrealizedLtcg: Math.round(totalUnrealizedLtcg),
    totalUnrealizedStcg: Math.round(totalUnrealizedStcg),
    harvestableLtcg: harvestableAmount,
    taxSavedByHarvesting: taxSaved,
    remainingLimit,
    harvestableHoldings,
  };
}
