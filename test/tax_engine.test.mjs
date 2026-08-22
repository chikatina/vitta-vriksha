import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ADVANCE_TAX_QUARTER_LABELS,
  DEBT_SEC50AA_CUTOFF,
  GRANDFATHER_CUTOFF,
  GRANDFATHER_SELL_CUTOFF,
  LTCG_REGIME_CUTOFF,
  TAX_DISCLAIMER_SHORT,
  TAX_DISCLAIMER_TEXT,
  calculateExactTaxHarvesting,
  calculateGrandfatheredCost,
  daysBetween,
  generateSchedule112aCsv,
  getAdvanceTaxQuarter,
  getFinancialYear,
  isLongTermAsset,
  processFifoCapitalGains,
  transferFlag,
} from '../app/src/main/assets/www/js/backend/tax_engine.js';

describe('tax_engine.js: Date arithmetic & helpers', () => {
  it('calculates daysBetween accurately including leap years and boundary dates', () => {
    assert.equal(daysBetween('', '2024-05-10'), 0);
    assert.equal(daysBetween('2024-05-10', ''), 0);
    assert.equal(daysBetween('2024-01-01', '2024-01-01'), 0);
    assert.equal(daysBetween('2024-01-01', '2024-01-10'), 9);
    // 2024 is a leap year (Feb has 29 days)
    assert.equal(daysBetween('2024-02-01', '2024-03-01'), 29);
    // Negative order clamped to 0
    assert.equal(daysBetween('2024-05-10', '2024-05-01'), 0);
  });

  it('determines Indian Financial Year correctly across calendar months', () => {
    assert.equal(getFinancialYear(''), 'Unknown');
    assert.equal(getFinancialYear('invalid-date'), 'Unknown');
    assert.equal(getFinancialYear('2024-04-01'), 'FY2024-25');
    assert.equal(getFinancialYear('2024-07-23'), 'FY2024-25');
    assert.equal(getFinancialYear('2024-12-31'), 'FY2024-25');
    assert.equal(getFinancialYear('2025-01-15'), 'FY2024-25');
    assert.equal(getFinancialYear('2025-03-31'), 'FY2024-25');
    assert.equal(getFinancialYear('2023-03-15'), 'FY2022-23');
  });

  it('flags transferFlag as BE (Before) or AE (After) July 23, 2024 Budget cutoff', () => {
    assert.equal(transferFlag('2024-07-22'), 'BE');
    assert.equal(transferFlag('2024-01-15'), 'BE');
    assert.equal(transferFlag('2024-07-23'), 'AE');
    assert.equal(transferFlag('2024-08-01'), 'AE');
    assert.equal(transferFlag('2025-02-10'), 'AE');
    assert.equal(transferFlag(''), 'BE');
  });

  it('maps sale date to 5 Advance Tax quarterly windows correctly', () => {
    assert.equal(getAdvanceTaxQuarter(''), 0);
    assert.equal(getAdvanceTaxQuarter('2024-04-10'), 0); // Q1: Upto 15 Jun
    assert.equal(getAdvanceTaxQuarter('2024-06-15'), 0); // Q1: Upto 15 Jun
    assert.equal(getAdvanceTaxQuarter('2024-06-16'), 1); // Q2: 16 Jun to 15 Sep
    assert.equal(getAdvanceTaxQuarter('2024-09-15'), 1); // Q2: 16 Jun to 15 Sep
    assert.equal(getAdvanceTaxQuarter('2024-09-16'), 2); // Q3: 16 Sep to 15 Dec
    assert.equal(getAdvanceTaxQuarter('2024-12-15'), 2); // Q3: 16 Sep to 15 Dec
    assert.equal(getAdvanceTaxQuarter('2024-12-16'), 3); // Q4: 16 Dec to 15 Mar
    assert.equal(getAdvanceTaxQuarter('2025-03-15'), 3); // Q4: 16 Dec to 15 Mar
    assert.equal(getAdvanceTaxQuarter('2025-03-16'), 4); // Q5: 16 Mar to 31 Mar
    assert.equal(getAdvanceTaxQuarter('2025-03-31'), 4); // Q5: 16 Mar to 31 Mar
  });

  it('classifies asset holding period rules for Equity, Debt and Unlisted', () => {
    // Equity: 365 days threshold
    assert.equal(isLongTermAsset('equity', '2023-01-01', '2023-12-31'), false); // 364 days
    assert.equal(isLongTermAsset('equity', '2023-01-01', '2024-01-02'), true); // 366 days
    assert.equal(isLongTermAsset('Equity MF', '2023-01-01', '2024-01-02'), true);

    // Debt post-01-Apr-2023 (Section 50AA): Always Short-Term
    assert.equal(isLongTermAsset('debt', '2023-04-01', '2027-04-01'), false);
    assert.equal(isLongTermAsset('debt', '2023-05-10', '2025-05-10'), false);

    // Debt pre-01-Apr-2023: 3 years (1095 days)
    assert.equal(isLongTermAsset('debt', '2020-01-01', '2022-01-01'), false); // 2 years
    assert.equal(isLongTermAsset('debt', '2020-01-01', '2023-01-03'), true); // > 3 years

    // Unlisted: 24 months (730 days)
    assert.equal(isLongTermAsset('unlisted', '2022-01-01', '2023-06-01'), false);
    assert.equal(isLongTermAsset('unlisted', '2022-01-01', '2024-01-05'), true);
  });

  it('calculates Section 112A Grandfathered Cost accurately', () => {
    // Zero/negative FMV -> returns actual cost
    assert.equal(calculateGrandfatheredCost(100, 0, 200), 100);
    assert.equal(calculateGrandfatheredCost(100, null, 200), 100);

    // Case 1: Bought @ 100, FMV on 31-Jan-2018 @ 150, Sold @ 200
    // min(FMV 150, Sale 200) = 150 -> max(Cost 100, 150) = 150 (Gain = 50)
    assert.equal(calculateGrandfatheredCost(100, 150, 200), 150);

    // Case 2: Bought @ 100, FMV @ 150, Sold @ 130
    // min(FMV 150, Sale 130) = 130 -> max(Cost 100, 130) = 130 (Gain = 0)
    assert.equal(calculateGrandfatheredCost(100, 150, 130), 130);

    // Case 3: Bought @ 100, FMV @ 80, Sold @ 150
    // min(FMV 80, Sale 150) = 80 -> max(Cost 100, 80) = 100 (Gain = 50)
    assert.equal(calculateGrandfatheredCost(100, 80, 150), 100);

    // Case 4: Bought @ 100, FMV @ 150, Sold @ 80
    // min(FMV 150, Sale 80) = 80 -> max(Cost 100, 80) = 100 (Loss = 20)
    assert.equal(calculateGrandfatheredCost(100, 150, 80), 100);
  });
});

describe('tax_engine.js: FIFO Matching, Capital Gains & Regime Split', () => {
  it('handles empty and zero-quantity transaction lists gracefully', () => {
    const res = processFifoCapitalGains([]);
    assert.equal(res.status, 'success');
    assert.equal(res.financialYears.length, 0);
    assert.equal(res.realizedLots.length, 0);
    assert.equal(res.activeLots.length, 0);
    assert.ok(res.disclaimer.includes('IMPORTANT NOTICE'));
    assert.ok(res.disclaimerShort.includes('No Financial or Tax Advice'));

    const res2 = processFifoCapitalGains([
      { units: 0, amount: 0, date: '2024-01-01', kind: 'PURCHASE' },
    ]);
    assert.equal(res2.activeLots.length, 0);
  });

  it('performs FIFO matching across multiple buy lots and partial sells', () => {
    const txns = [
      { isin: 'INF123456789', name: 'Nifty 50 Index Fund', date: '2023-01-10', units: 100, price: 50, kind: 'PURCHASE' },
      { isin: 'INF123456789', name: 'Nifty 50 Index Fund', date: '2023-06-15', units: 50, price: 60, kind: 'PURCHASE' },
      // Sell 120 units on 2024-05-20 (Consumes 100 from Lot 1 and 20 from Lot 2)
      { isin: 'INF123456789', name: 'Nifty 50 Index Fund', date: '2024-05-20', units: 120, price: 80, kind: 'REDEMPTION' },
    ];

    const result = processFifoCapitalGains(txns, { asOfDate: '2024-06-01' });
    assert.equal(result.realizedLots.length, 2);

    // Lot 1: 100 units bought 2023-01-10 @ 50, sold 2024-05-20 @ 80 (Held 496 days -> LTCG)
    const lot1 = result.realizedLots[0];
    assert.equal(lot1.units, 100);
    assert.equal(lot1.buyPrice, 50);
    assert.equal(lot1.sellPrice, 80);
    assert.equal(lot1.gain, 3000);
    assert.equal(lot1.gainType, 'LTCG');
    assert.equal(lot1.transferFlag, 'BE'); // Before 23-Jul-2024

    // Lot 2: 20 units bought 2023-06-15 @ 60, sold 2024-05-20 @ 80 (Held 340 days -> STCG)
    const lot2 = result.realizedLots[1];
    assert.equal(lot2.units, 20);
    assert.equal(lot2.buyPrice, 60);
    assert.equal(lot2.sellPrice, 80);
    assert.equal(lot2.gain, 400);
    assert.equal(lot2.gainType, 'STCG');
    assert.equal(lot2.transferFlag, 'BE');

    // Remaining Active Lot: 30 units from Lot 2 (bought 2023-06-15 @ 60)
    assert.equal(result.activeLots.length, 1);
    const active = result.activeLots[0];
    assert.equal(active.remainingUnits, 30);
    assert.equal(active.buyPrice, 60);
    assert.equal(active.investedCost, 1800);
    assert.equal(active.daysHeld, 352); // As of 2024-06-01
    assert.equal(active.isLtcg, false);
    assert.equal(active.daysToLtcg, 14); // 366 - 352
  });

  it('applies Grandfathering under Section 112A for pre-2018 purchases', () => {
    const txns = [
      { isin: 'INF999000111', name: 'Bluechip Equity Fund', date: '2016-05-10', units: 100, price: 100, kind: 'PURCHASE' },
      { isin: 'INF999000111', name: 'Bluechip Equity Fund', date: '2024-06-10', units: 100, price: 300, kind: 'REDEMPTION' },
    ];

    const result = processFifoCapitalGains(txns, {
      asOfDate: '2024-07-01',
      fmvLookup: (isin) => (isin === 'INF999000111' ? 220 : 0),
    });

    assert.equal(result.realizedLots.length, 1);
    const lot = result.realizedLots[0];
    assert.equal(lot.isGrandfathered, true);
    assert.equal(lot.fmv2018PerUnit, 220);
    assert.equal(lot.actualCost, 10000); // 100 * 100
    assert.equal(lot.taxCost, 22000); // 100 * 220 (Grandfathered cost)
    assert.equal(lot.gain, 8000); // 30,000 sale - 22,000 cost = 8,000 gain
  });

  it('computes Budget 2024 regime split (15%/20% STCG, 10%/12.5% LTCG, 1.25L exemption)', () => {
    const txns = [
      // STCG pre-23-Jul: 100 units bought 2024-01-01 @ 100, sold 2024-05-10 @ 150 (Gain = 5000 @ 15%)
      { isin: 'INE001', symbol: 'TCS', date: '2024-01-01', units: 100, price: 100, kind: 'BUY' },
      { isin: 'INE001', symbol: 'TCS', date: '2024-05-10', units: 100, price: 150, kind: 'SELL' },

      // STCG post-23-Jul: 100 units bought 2024-02-01 @ 100, sold 2024-08-20 @ 160 (Gain = 6000 @ 20%)
      { isin: 'INE002', symbol: 'INFY', date: '2024-02-01', units: 100, price: 100, kind: 'BUY' },
      { isin: 'INE002', symbol: 'INFY', date: '2024-08-20', units: 100, price: 160, kind: 'SELL' },

      // LTCG post-23-Jul: 1000 units bought 2022-01-01 @ 100, sold 2024-09-01 @ 300 (Gain = 200,000 @ 12.5%)
      { isin: 'INE003', symbol: 'RELIANCE', date: '2022-01-01', units: 1000, price: 100, kind: 'BUY' },
      { isin: 'INE003', symbol: 'RELIANCE', date: '2024-09-01', units: 1000, price: 300, kind: 'SELL' },
    ];

    const result = processFifoCapitalGains(txns);
    const fyReport = result.financialYearReports['FY2024-25'];
    assert.ok(fyReport);
    assert.equal(fyReport.stcgEquityBe, 5000); // 15%
    assert.equal(fyReport.stcgEquityAe, 6000); // 20%
    assert.equal(fyReport.ltcgEquityAe, 200000); // 12.5%
    assert.equal(fyReport.ltcgExemption, 125000);
    assert.equal(fyReport.taxableLtcg, 75000); // 200,000 - 125,000

    // Tax calculation: (5000 * 0.15) + (6000 * 0.20) + (75000 * 0.125) = 750 + 1200 + 9375 = 11325
    assert.equal(fyReport.estimatedTax, 11325);
    assert.ok(fyReport.schedule112aCsv.includes('RELIANCE'));
    assert.ok(fyReport.schedule112aCsv.includes('AE'));
  });

  it('generates Schedule 112A CSV format correctly', () => {
    const ltcgLots = [
      {
        isin: 'INE009A01021',
        name: 'INFOSYS LTD',
        units: 50,
        sellPrice: 1600,
        saleConsideration: 80000,
        actualCost: 60000,
        fmv2018PerUnit: 0,
        taxCost: 60000,
        gain: 20000,
        transferFlag: 'AE',
      },
    ];

    const csv = generateSchedule112aCsv(ltcgLots);
    assert.ok(csv.startsWith('ISIN,Name of Share/Unit,No of Shares/Units'));
    assert.ok(csv.includes('"INE009A01021","INFOSYS LTD",50.000,1600.00,80000,60000,0.00,0,60000,0,20000,AE'));
  });

  it('calculates exact tax-free LTCG harvesting with exemption limit and tax savings', () => {
    const activeLots = [
      { securityKey: 'INFY', name: 'Infosys', isin: 'INE009A01021', symbol: 'INFY', assetClass: 'equity', remainingUnits: 100, investedCost: 120000, isLtcg: true },
      { securityKey: 'TCS', name: 'TCS', isin: 'INE467B01029', symbol: 'TCS', assetClass: 'equity', remainingUnits: 50, investedCost: 150000, isLtcg: true },
      { securityKey: 'HDFC', name: 'HDFC Bank', isin: 'INE040A01034', symbol: 'HDFCBANK', assetClass: 'equity', remainingUnits: 80, investedCost: 100000, isLtcg: false },
    ];

    const currentPrices = {
      INE009A01021: 1800, // INFY: 100 * 1800 = 180,000 (LTCG gain = 60,000)
      INE467B01029: 3800, // TCS: 50 * 3800 = 190,000 (LTCG gain = 40,000)
      INE040A01034: 1600, // HDFC: 80 * 1600 = 128,000 (STCG gain = 28,000)
    };

    const harvest = calculateExactTaxHarvesting(activeLots, currentPrices, { exemptionLimit: 125000 });
    assert.equal(harvest.status, 'success');
    assert.equal(harvest.totalUnrealizedLtcg, 100000); // 60k + 40k
    assert.equal(harvest.totalUnrealizedStcg, 28000);
    assert.equal(harvest.harvestableLtcg, 100000);
    assert.equal(harvest.taxSavedByHarvesting, 12500); // 100,000 * 12.5%
    assert.equal(harvest.remainingLimit, 25000); // 125,000 - 100,000
    assert.ok(harvest.disclaimer.includes('IMPORTANT NOTICE'));
    assert.ok(harvest.disclaimerShort.includes('No Financial or Tax Advice'));
  });
});
