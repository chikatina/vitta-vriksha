import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { freshBackend } from './_harness.mjs';
import { normalizeDate, parseBrokerCsv, parseCsvLines } from '../app/src/main/assets/www/js/backend/broker_parser.js';
import * as database from '../app/src/main/assets/www/js/backend/database.js';

let db;

beforeEach(async () => {
  db = await freshBackend();
});

describe('broker_parser.js: CSV & Date Parsing', () => {
  it('normalizes various date formats into standard YYYY-MM-DD', () => {
    assert.equal(normalizeDate(''), '');
    assert.equal(normalizeDate('2024-05-15'), '2024-05-15');
    assert.equal(normalizeDate('15/05/2024'), '2024-05-15');
    assert.equal(normalizeDate('05-09-2024'), '2024-09-05');
    assert.equal(normalizeDate('15-Jan-2024'), '2024-01-15');
    assert.equal(normalizeDate('22-AUG-2024'), '2024-08-22');
    assert.equal(normalizeDate('invalid-date-string'), 'invalid-date-string');
  });

  it('parses RFC 4180 CSV lines with escaped quotes, commas and newlines', () => {
    assert.deepEqual(parseCsvLines(''), []);
    assert.deepEqual(parseCsvLines('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
    assert.deepEqual(parseCsvLines('a,"b, with comma",c\r\n1,"escaped ""quote""",3'), [
      ['a', 'b, with comma', 'c'],
      ['1', 'escaped "quote"', '3'],
    ]);
  });

  it('parses Zerodha tradebook CSV exports correctly', () => {
    const zerodhaCsv = `Symbol,ISIN,Trade Date,Exchange,Segment,Trade Type,Quantity,Price,Order ID,Trade ID
INFY,INE009A01021,2024-05-10,NSE,EQ,BUY,50,1450.50,123456,789012
INFY,INE009A01021,2024-08-20,NSE,EQ,SELL,20,1750.00,123457,789013
TCS,INE467B01029,2024-06-15,NSE,EQ,BUY,10,3800.00,123458,789014`;

    const res = parseBrokerCsv(zerodhaCsv, 'Zerodha');
    assert.equal(res.status, 'success');
    assert.equal(res.imported_count, 3);
    assert.equal(res.skipped_count, 0);

    const [t1, t2, t3] = res.transactions;
    assert.equal(t1.symbol, 'INFY');
    assert.equal(t1.isin, 'INE009A01021');
    assert.equal(t1.trade_type, 'BUY');
    assert.equal(t1.quantity, 50);
    assert.equal(t1.price, 1450.5);
    assert.equal(t1.trade_date, '2024-05-10');

    assert.equal(t2.symbol, 'INFY');
    assert.equal(t2.trade_type, 'SELL');
    assert.equal(t2.quantity, 20);
    assert.equal(t2.price, 1750);
  });

  it('parses Groww trade history CSV format correctly', () => {
    const growwCsv = `Date,Stock Name,ISIN,Type,Quantity,Price
15-Jan-2024,Reliance Industries,INE002A01018,BUY,15,2400.00
20-Aug-2024,Reliance Industries,INE002A01018,SELL,5,2950.00`;

    const res = parseBrokerCsv(growwCsv, 'Groww');
    assert.equal(res.status, 'success');
    assert.equal(res.imported_count, 2);
    assert.equal(res.transactions[0].trade_date, '2024-01-15');
    assert.equal(res.transactions[0].trade_type, 'BUY');
    assert.equal(res.transactions[0].quantity, 15);
    assert.equal(res.transactions[1].trade_date, '2024-08-20');
    assert.equal(res.transactions[1].trade_type, 'SELL');
  });

  it('handles invalid, empty, or missing CSV headers gracefully', () => {
    assert.equal(parseBrokerCsv('').status, 'error');
    assert.equal(parseBrokerCsv('colA,colB,colC\n1,2,3').code, 'CSV_UNKNOWN_HEADER');
    assert.equal(parseBrokerCsv('Symbol,Exchange\nINFY,NSE').code, 'CSV_MISSING_COLUMNS');
  });
});

describe('database.js: Stock Transactions CRUD & Actions', () => {
  it('adds, updates, lists and deletes stock transactions', async () => {
    // 1. Add Stock Transaction
    const addRes = await database.handleDbAction({
      action: 'add_stock_transaction',
      symbol: 'INFY',
      isin: 'INE009A01021',
      trade_type: 'BUY',
      trade_date: '2024-01-15',
      quantity: 50,
      price: 1500,
      broker: 'Zerodha',
      exchange: 'NSE',
      notes: 'Initial purchase',
    });

    assert.equal(addRes.status, 'success');
    const txnId = addRes.id;
    assert.ok(txnId > 0);

    // 2. Validation errors
    const invalidRes1 = await database.handleDbAction({
      action: 'add_stock_transaction',
      symbol: '',
      isin: '',
      quantity: 10,
      price: 100,
    });
    assert.equal(invalidRes1.code, 'BAD_REQUEST');

    const invalidRes2 = await database.handleDbAction({
      action: 'add_stock_transaction',
      symbol: 'TCS',
      quantity: 0,
      price: 100,
    });
    assert.equal(invalidRes2.code, 'AMOUNT_INVALID');

    // 3. List Stock Transactions
    const listRes = await database.handleDbAction({
      action: 'list_stock_transactions',
      symbol: 'INFY',
    });
    assert.equal(listRes.status, 'success');
    assert.equal(listRes.count, 1);
    assert.equal(listRes.transactions[0].quantity, 50);
    assert.equal(listRes.transactions[0].price, 1500);

    // 4. Update Stock Transaction
    const updateRes = await database.handleDbAction({
      action: 'update_stock_transaction',
      id: txnId,
      quantity: 60,
      price: 1480,
      notes: 'Corrected quantity',
    });
    assert.equal(updateRes.status, 'success');

    const listRes2 = await database.handleDbAction({ action: 'list_stock_transactions' });
    assert.equal(listRes2.transactions[0].quantity, 60);
    assert.equal(listRes2.transactions[0].price, 1480);
    assert.equal(listRes2.transactions[0].notes, 'Corrected quantity');

    // Update error handling
    const updateBadId = await database.handleDbAction({ action: 'update_stock_transaction', id: 99999 });
    assert.equal(updateBadId.code, 'RECORD_NOT_FOUND');

    const updateNoId = await database.handleDbAction({ action: 'update_stock_transaction' });
    assert.equal(updateNoId.code, 'BAD_REQUEST');

    // 5. Delete Stock Transaction
    const deleteRes = await database.handleDbAction({
      action: 'delete_stock_transaction',
      id: txnId,
    });
    assert.equal(deleteRes.status, 'success');

    const listRes3 = await database.handleDbAction({ action: 'list_stock_transactions' });
    assert.equal(listRes3.count, 0);

    const deleteNoId = await database.handleDbAction({ action: 'delete_stock_transaction' });
    assert.equal(deleteNoId.code, 'BAD_REQUEST');
  });

  it('imports stock transactions via CSV with deduplication', async () => {
    const csvContent = `Trade Date,Symbol,ISIN,Type,Quantity,Price
2024-02-10,RELIANCE,INE002A01018,BUY,20,2500.00
2024-06-15,RELIANCE,INE002A01018,SELL,10,2900.00`;

    const import1 = await database.handleDbAction({
      action: 'import_stock_transactions',
      csv_text: csvContent,
      broker: 'Zerodha',
    });

    assert.equal(import1.status, 'success');
    assert.equal(import1.imported_count, 2);
    assert.equal(import1.skipped_count, 0);

    // Re-importing same CSV deduplicates
    const import2 = await database.handleDbAction({
      action: 'import_stock_transactions',
      csv_text: csvContent,
      broker: 'Zerodha',
    });

    assert.equal(import2.status, 'success');
    assert.equal(import2.imported_count, 0);
    assert.equal(import2.skipped_count, 2);

    // Import with array
    const import3 = await database.handleDbAction({
      action: 'import_stock_transactions',
      transactions: [
        { trade_date: '2024-07-01', symbol: 'HDFCBANK', isin: 'INE040A01034', trade_type: 'BUY', quantity: 30, price: 1500 },
      ],
    });
    assert.equal(import3.imported_count, 1);

    // Bad arguments
    const importBad = await database.handleDbAction({ action: 'import_stock_transactions' });
    assert.equal(importBad.code, 'BAD_REQUEST');
  });

  it('generates unified capital gains report and active tax lots from DB rows', async () => {
    // Add MF buy & sell in folio_transactions
    db.run(
      `INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, kind, amount, units, nav)
       VALUES (1, 'FOLIO101', 'INF174K01LS2', 'Kotak Emerging Equity Fund', '2023-01-10', 'PURCHASE', 50000, 500, 100)`,
    );
    db.run(
      `INSERT INTO folio_transactions (member_id, folio_number, isin, scheme_name, date, kind, amount, units, nav)
       VALUES (1, 'FOLIO101', 'INF174K01LS2', 'Kotak Emerging Equity Fund', '2024-08-15', 'REDEMPTION', 45000, 300, 150)`,
    );

    // Add Stock buy & sell in stock_transactions
    await database.handleDbAction({
      action: 'add_stock_transaction',
      symbol: 'TCS',
      isin: 'INE467B01029',
      trade_type: 'BUY',
      trade_date: '2024-03-01',
      quantity: 20,
      price: 3600,
    });
    await database.handleDbAction({
      action: 'add_stock_transaction',
      symbol: 'TCS',
      isin: 'INE467B01029',
      trade_type: 'SELL',
      trade_date: '2024-09-01',
      quantity: 10,
      price: 4200,
    });

    // Run Capital Gains Report
    const reportRes = await database.handleDbAction({
      action: 'get_capital_gains_report',
      member_id: 1,
    });

    assert.equal(reportRes.status, 'success');
    assert.ok(reportRes.disclaimer.includes('IMPORTANT NOTICE'));
    assert.ok(reportRes.financialYears.includes('FY2024-25'));

    const fyData = reportRes.financialYearReports['FY2024-25'];
    assert.ok(fyData);
    // Kotak Fund: 300 units sold on 2024-08-15 (>1 yr -> LTCG post 23-Jul @ 12.5%, gain = 300 * (150-100) = 15000)
    assert.equal(fyData.ltcgEquityAe, 15000);
    // TCS: 10 units sold on 2024-09-01 (<=1 yr -> STCG post 23-Jul @ 20%, gain = 10 * (4200-3600) = 6000)
    assert.equal(fyData.stcgEquityAe, 6000);

    // Holding Tax Lots query
    const lotsRes = await database.handleDbAction({
      action: 'get_holding_tax_lots',
      isin: 'INF174K01LS2',
    });
    assert.equal(lotsRes.status, 'success');
    assert.equal(lotsRes.active_lots.length, 1);
    assert.equal(lotsRes.active_lots[0].remainingUnits, 200); // 500 - 300
    assert.equal(lotsRes.active_lots[0].isLtcg, true);

    const badLots = await database.handleDbAction({ action: 'get_holding_tax_lots' });
    assert.equal(badLots.code, 'BAD_REQUEST');
  });

  it('recovers cost basis in list_investments and returns tax lots in get_holding_detail', async () => {
    // Create demat holding with 0 cost
    db.run(
      `INSERT INTO demat_holdings (member_id, account_type, broker, dp_id, client_id, kind, isin, name, symbol, quantity, price, current_value, invested_value)
       VALUES (1, 'Demat', 'Zerodha', '12081600', '12345678', 'equity', 'INE009A01021', 'Infosys Limited', 'INFY', 50, 1600, 80000, 0)`,
    );

    // Record stock BUY trade
    await database.handleDbAction({
      action: 'add_stock_transaction',
      symbol: 'INFY',
      isin: 'INE009A01021',
      trade_type: 'BUY',
      trade_date: '2024-01-10',
      quantity: 50,
      price: 1400,
    });

    // list_investments should automatically recover cost basis from stock_transactions (50 * 1400 = 70000)
    const listRes = await database.handleDbAction({ action: 'list_investments' });
    const infy = listRes.holdings.find((h) => h.isin === 'INE009A01021');
    assert.ok(infy);
    assert.equal(infy.invested, 70000);
    assert.equal(infy.has_cost, true);
    assert.equal(infy.pnl, 10000); // 80000 - 70000

    // get_holding_detail should return stock history and active tax lots
    const detailRes = await database.handleDbAction({
      action: 'get_holding_detail',
      isin: 'INE009A01021',
    });
    assert.equal(detailRes.status, 'success');
    assert.equal(detailRes.counted, 1);
    assert.equal(detailRes.invested_from_history, 70000);
    assert.ok(detailRes.active_tax_lots.length > 0);
    assert.ok(detailRes.disclaimer.includes('IMPORTANT NOTICE'));
  });
});
