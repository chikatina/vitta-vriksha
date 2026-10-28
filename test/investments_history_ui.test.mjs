/*
 * Automated Test Suite for Expandable Fund History & Invested vs Current Value Chart
 * Verifies that:
 * 1. Transaction history rows render as expandable details.history-item with full statutory breakdown (Stamp duty, STT, charges).
 * 2. holdingHistoryChart renders clear X and Y axes, horizontal dashed gridlines, and both Invested and Current Value paths.
 * 3. Period breakdown ('Every line') in openFolioPeriodSheet uses expandable history items.
 * 4. CSS contains multi-line clamp for .holding-name and accordion styles for .history-item and .tax-lot-item.
 * 5. SIP tracker renders structured cost breakdown badges.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, before } from 'node:test';
import { freshBackend, call } from './_harness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const WWW_DIR = path.join(ROOT, 'app', 'src', 'main', 'assets', 'www');

describe('Investments & Fund History Expandable UI and Chart Suite', () => {
  let cssContent;
  let investmentsJsContent;
  let sipsJsContent;

  before(async () => {
    cssContent = fs.readFileSync(path.join(WWW_DIR, 'css', 'style.css'), 'utf8');
    investmentsJsContent = fs.readFileSync(path.join(WWW_DIR, 'js', 'views', 'investments.js'), 'utf8');
    sipsJsContent = fs.readFileSync(path.join(WWW_DIR, 'js', 'views', 'sips.js'), 'utf8');
  });

  it('verifies stylesheet contains 2-line clamp for holding names and history accordion styles', () => {
    // 1. Check holding name 2-line clamp
    assert.ok(cssContent.includes('.holding-name'), 'style.css must have .holding-name');
    assert.ok(cssContent.includes('-webkit-line-clamp: 2'), 'holding-name must have -webkit-line-clamp: 2');
    assert.ok(cssContent.includes('-webkit-box-orient: vertical'), 'holding-name must have -webkit-box-orient: vertical');

    // 2. Check history-item accordion styles
    assert.ok(cssContent.includes('.history-item'), 'style.css must have .history-item');
    assert.ok(cssContent.includes('.history-item summary'), 'style.css must have .history-item summary');
    assert.ok(cssContent.includes('.history-item summary::-webkit-details-marker'), 'must hide default marker');
    assert.ok(cssContent.includes('.history-item[open] .history-expand-icon'), 'must rotate expand icon on open');
    assert.ok(cssContent.includes('.history-item-details'), 'must have .history-item-details container');

    // 3. Check tax-lot-item accordion styles
    assert.ok(cssContent.includes('.tax-lot-item'), 'style.css must have .tax-lot-item');
    assert.ok(cssContent.includes('.tax-lot-details'), 'style.css must have .tax-lot-details');
  });

  it('verifies investments.js defines renderHistoryTransactionItem with full statutory details', () => {
    assert.ok(investmentsJsContent.includes('function renderHistoryTransactionItem'), 'must declare renderHistoryTransactionItem');
    assert.ok(investmentsJsContent.includes('<details class="history-item">'), 'must render details.history-item');
    assert.ok(investmentsJsContent.includes('Stamp Duty'), 'must display Stamp Duty in expanded details');
    assert.ok(investmentsJsContent.includes('STT'), 'must display STT in expanded details');
    assert.ok(investmentsJsContent.includes('Exchange / Charges'), 'must display Charges in expanded details');
    assert.ok(investmentsJsContent.includes('Total Statutory Costs'), 'must calculate and show total statutory costs');
    assert.ok(investmentsJsContent.includes('data-toggle-expand-all'), 'must have Expand all toggle button');
  });

  it('verifies investments.js holdingHistoryChart renders X and Y axes and Invested vs Current Value', () => {
    assert.ok(investmentsJsContent.includes('function holdingHistoryChart'), 'must declare holdingHistoryChart');
    // Check parameters accept holding
    assert.ok(investmentsJsContent.includes('holdingHistoryChart(lines, money, holding)'), 'signature must accept holding');

    // Check dual lines: Invested (dashed blue) and Value (solid with gradient)
    assert.ok(investmentsJsContent.includes('investedPoints'), 'must calculate investedPoints');
    assert.ok(investmentsJsContent.includes('valuePoints'), 'must calculate valuePoints');
    assert.ok(investmentsJsContent.includes('stroke="#3B82F6"'), 'must stroke invested line with blue');
    assert.ok(investmentsJsContent.includes('stroke-dasharray="4 3"'), 'invested line must be dashed');
    assert.ok(investmentsJsContent.includes('linearGradient id="valueGrad"'), 'must render gradient fill under value curve');

    // Check axes and ticks
    assert.ok(investmentsJsContent.includes('yTicks'), 'must render Y-axis ticks');
    assert.ok(investmentsJsContent.includes('axisLine'), 'must render X-axis baseline');
    assert.ok(investmentsJsContent.includes('xLabels'), 'must render X-axis date labels');
    assert.ok(investmentsJsContent.includes('stroke-dasharray="3 3"'), 'must have dashed horizontal gridlines');

    // Check legend header
    assert.ok(investmentsJsContent.includes('Value:'), 'legend must show Value');
    assert.ok(investmentsJsContent.includes('Invested:'), 'legend must show Invested');
  });

  it('verifies formatChartDateWithYear formats date with year and avoids duplicate labels', async () => {
    const { formatChartDateWithYear } = await import('../app/src/main/assets/www/js/views/investments.js');
    assert.equal(formatChartDateWithYear('2024-08-15'), "Aug '24");
    assert.equal(formatChartDateWithYear('2021-03-01'), "Mar '21");
    assert.equal(formatChartDateWithYear('2026-11-20', true), "20 Nov '26");
    assert.equal(formatChartDateWithYear('Today'), 'Today');
  });

  it('verifies holdingHistoryChart mobile unslop: touch scrubber present and desktop hover removed', async () => {
    const { holdingHistoryChart } = await import('../app/src/main/assets/www/js/views/investments.js');
    const dummyMoney = (v) => `₹${Math.round(v)}`;
    const txLines = [
      { date: '2023-01-10', amount: 10000, units: 100, nav: 100, stamp_duty: 0.5, charges: 0 },
      { date: '2024-06-15', amount: 10000, units: 50, nav: 200, stamp_duty: 0.5, charges: 0 },
    ];
    const holding = {
      nav: 220,
      units: 150,
      value: 33000,
      invested: 20001,
      has_cost: true,
      last_updated: '2024-08-20',
    };

    const html = holdingHistoryChart(txLines, dummyMoney, holding);
    assert.ok(!html.includes('Hover points for date & valuation'), 'desktop hover text must be removed');
    assert.ok(html.includes('Tap timeline to inspect milestone'), 'must include mobile tap instruction');
    assert.ok(html.includes('data-chart-scrubber'), 'must include vertical scrubber line');
    assert.ok(html.includes('data-chart-scrubber-val'), 'must include scrubber value circle');
    assert.ok(html.includes('data-chart-scrubber-inv'), 'must include scrubber invested circle');
    assert.ok(html.includes('data-point-idx="0"'), 'must include tap hit targets');
    assert.ok(html.includes('Jan &#39;23') || html.includes("Jan '23"), 'X-axis must display start year');
    assert.ok(html.includes('Aug &#39;24') || html.includes("Aug '24"), 'X-axis must display end year');
  });

  it('verifies spiky chart fix: valuation does not plunge to 0 on zero-NAV tx or unpriced holding', async () => {
    const { holdingHistoryChart } = await import('../app/src/main/assets/www/js/views/investments.js');
    const dummyMoney = (v) => `₹${Math.round(v)}`;

    // Scenario: Purchase followed by zero-NAV transactions (stamp duty, dividend, AMC charge)
    // and same-date transactions
    const txLines = [
      { date: '2024-01-10', amount: 10000, units: 100, nav: 100, kind: 'PURCHASE' },
      { date: '2024-01-10', amount: 0.5, units: 0, nav: 0, kind: 'STAMP_DUTY_TAX' },
      { date: '2024-02-15', amount: 150, units: 0, nav: 0, kind: 'DIVIDEND_PAYOUT' },
      { date: '2024-03-20', amount: 5000, units: 40, nav: 125, kind: 'PURCHASE' },
    ];

    // Holding today is unpriced (value is 0 or null in DB)
    const unpricedHolding = {
      nav: 130,
      units: 140,
      value: 0, // Unpriced!
      invested: 15000.5,
      has_cost: true,
      last_updated: '2024-04-01',
    };

    const html = holdingHistoryChart(txLines, dummyMoney, unpricedHolding);

    // Extract all data-val attributes from hit targets
    const valMatches = [...html.matchAll(/data-val="([^"]+)"/g)].map((m) => Number(m[1]));
    assert.ok(valMatches.length >= 3, 'must generate milestones');
    for (const val of valMatches) {
      assert.ok(val > 0, `milestone valuation should never plunge to 0 while holding units, got ${val}`);
    }

    // Check same-date consolidation: 2024-01-10 should only appear once as a hit target
    const dates = [...html.matchAll(/data-date="([^"]+)"/g)].map((m) => m[1]);
    const jan10Count = dates.filter((d) => d === '2024-01-10').length;
    assert.equal(jan10Count, 1, 'same-date transactions must be consolidated into 1 milestone');

    // Final point must have non-zero value computed from units * nav
    const lastVal = valMatches[valMatches.length - 1];
    assert.equal(lastVal, 140 * 130, 'unpriced holding must fallback to units * nav');
  });

  it('verifies openFolioPeriodSheet uses renderHistoryTransactionItem', () => {
    assert.ok(
      investmentsJsContent.includes('lines.transactions.map((line) => renderHistoryTransactionItem(line, money, { showScheme: true }))'),
      'openFolioPeriodSheet must use renderHistoryTransactionItem for Every line',
    );
  });

  it('verifies sips.js renders structured cost breakdown badges', () => {
    assert.ok(sipsJsContent.includes('function formatCostBreakdownBadges'), 'sips.js must declare formatCostBreakdownBadges');
    assert.ok(sipsJsContent.includes('formatCostBreakdownBadges(ex.cas_transaction, money)'), 'SIP timeline must use formatCostBreakdownBadges');
    assert.ok(sipsJsContent.includes('formatCostBreakdownBadges(tx, money)'), 'Link transactions modal must use formatCostBreakdownBadges');
  });

  it('exercises holding detail backend retrieval with real transactions including stamp duty', async () => {
    await freshBackend();

    // 1. Create a folio transaction with stamp duty
    const pDate = '2024-05-10';
    await call('add_family_member', { name: 'Sagar Chikati', relationship: 'Self' });
    const { getDatabase } = await import('../app/src/main/assets/www/js/backend/database.js');
    const rawDb = await getDatabase();

    rawDb.run(
      'INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, description, kind, amount, units, nav, stamp_duty, stt, charges)'
      + ' VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['998877/11', 'INF209K01165', 'Parag Parikh Flexi Cap Fund Direct Growth', pDate, 'SIP Purchase', 'PURCHASE', 5000, 75.50, 66.225, 0.25, 0.00, 1.20],
    );

    // 2. Fetch holding detail
    const detail = await call('get_holding_detail', { isin: 'INF209K01165', folio_number: '998877/11' });
    assert.equal(detail.status, 'success');
    assert.equal(detail.transactions.length, 1);
    assert.equal(detail.transactions[0].stamp_duty, 0.25);
    assert.equal(detail.transactions[0].charges, 1.20);
    assert.ok(detail.invested_from_history > 5000, 'invested amount should include statutory additions');
  });
});
