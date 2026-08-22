/*
 * Broker Tradebook & Transaction CSV Parsers.
 *
 * Supports:
 * - Zerodha Tradebook / Tax P&L CSV
 * - Groww Trade Report / Order History CSV
 * - Generic / Standard Tradebook CSV
 */

import { nameForIsin } from './isin.js';

/**
 * Normalizes varied date formats (DD/MM/YYYY, DD-MM-YYYY, DD-MMM-YYYY, YYYY-MM-DD) into YYYY-MM-DD.
 */
export function normalizeDate(str) {
  if (!str) return '';
  const text = String(str).trim();

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  // DD/MM/YYYY or DD-MM-YYYY
  const ddmmyyyy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (ddmmyyyy) {
    const day = ddmmyyyy[1].padStart(2, '0');
    const month = ddmmyyyy[2].padStart(2, '0');
    const year = ddmmyyyy[3];
    return `${year}-${month}-${day}`;
  }

  // DD-MMM-YYYY (e.g. 15-Jan-2024 or 15-JAN-2024)
  const months = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const ddmmmyyyy = /^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{4})$/.exec(text);
  if (ddmmmyyyy) {
    const day = ddmmmyyyy[1].padStart(2, '0');
    const mon = months[ddmmmyyyy[2].toLowerCase()] || '01';
    const year = ddmmmyyyy[3];
    return `${year}-${mon}-${day}`;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    const pad = (v) => String(v).padStart(2, '0');
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
  }

  return text;
}

/**
 * Robust RFC 4180 CSV line parser supporting quoted strings and commas.
 */
export function parseCsvLines(csvText) {
  if (!csvText) return [];
  const lines = [];
  let currentRow = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i += 1) {
    const char = csvText[i];
    const next = csvText[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        currentCell += '"';
        i += 1; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      currentRow.push(currentCell.trim());
      if (currentRow.some((cell) => cell.length > 0)) {
        lines.push(currentRow);
      }
      currentRow = [];
      currentCell = '';
    } else {
      currentCell += char;
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((cell) => cell.length > 0)) {
      lines.push(currentRow);
    }
  }

  return lines;
}

function cleanNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  const cleaned = String(val).replace(/[^0-9.-]/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function cleanHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Parses broker tradebook CSV text.
 */
export function parseBrokerCsv(csvText, defaultBroker = 'Broker') {
  const rows = parseCsvLines(csvText);
  if (!rows || rows.length < 2) {
    return { status: 'error', code: 'CSV_EMPTY', message: 'The CSV file contains no transaction rows.' };
  }

  // Detect header index
  let headerIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
    const headers = rows[i].map(cleanHeader);
    if (headers.includes('symbol') || headers.includes('isin') || (headers.includes('date') && headers.includes('quantity')) || headers.includes('tradedate')) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    return { status: 'error', code: 'CSV_UNKNOWN_HEADER', message: 'Could not identify tradebook headers in the CSV file.' };
  }

  const rawHeaders = rows[headerIndex];
  const headers = rawHeaders.map(cleanHeader);

  // Identify column indices
  const findCol = (...names) => {
    for (const n of names) {
      const idx = headers.indexOf(cleanHeader(n));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const dateCol = findCol('tradedate', 'date', 'transactiondate', 'executiondate', 'orderdate', 'timestamp');
  const symbolCol = findCol('symbol', 'scrip', 'scripname', 'stock', 'stockname', 'security', 'instrument', 'scheme');
  const isinCol = findCol('isin', 'isincode');
  const typeCol = findCol('tradetype', 'type', 'buysell', 'action', 'transactiontype', 'side');
  const qtyCol = findCol('quantity', 'qty', 'shares', 'units', 'volume', 'tradedqty');
  const priceCol = findCol('price', 'rate', 'tradeprice', 'executionprice', 'avgprice', 'nav', 'averageprice');
  const exchangeCol = findCol('exchange', 'segment');
  const orderIdCol = findCol('orderid', 'orderno');
  const tradeIdCol = findCol('tradeid', 'tradeno');
  const sttCol = findCol('stt', 'seccheck', 'securitytransactiontax');
  const chargesCol = findCol('charges', 'brokerage', 'taxes', 'totalcharges');

  if (dateCol === -1 || (symbolCol === -1 && isinCol === -1) || qtyCol === -1 || priceCol === -1) {
    return {
      status: 'error',
      code: 'CSV_MISSING_COLUMNS',
      message: 'CSV is missing essential trade columns (Date, Symbol/ISIN, Quantity, Price).',
    };
  }

  const transactions = [];
  let skipped = 0;

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const rawDate = row[dateCol];
    const date = normalizeDate(rawDate);
    const symbol = symbolCol !== -1 ? String(row[symbolCol] || '').trim().toUpperCase() : '';
    const isin = isinCol !== -1 ? String(row[isinCol] || '').trim().toUpperCase() : '';
    const rawType = typeCol !== -1 ? String(row[typeCol] || '').trim().toUpperCase() : 'BUY';
    const quantity = Math.abs(cleanNumber(row[qtyCol]));
    const price = Math.abs(cleanNumber(row[priceCol]));

    if (!date || (!symbol && !isin) || quantity <= 0 || price <= 0) {
      skipped += 1;
      continue;
    }

    const tradeType = (rawType.startsWith('S') || rawType === 'REDEMPTION') ? 'SELL' : 'BUY';
    const exchange = exchangeCol !== -1 ? String(row[exchangeCol] || '').trim().toUpperCase() : 'NSE';
    const orderId = orderIdCol !== -1 ? String(row[orderIdCol] || '').trim() : '';
    const tradeId = tradeIdCol !== -1 ? String(row[tradeIdCol] || '').trim() : '';
    const stt = sttCol !== -1 ? cleanNumber(row[sttCol]) : 0;
    const charges = chargesCol !== -1 ? cleanNumber(row[chargesCol]) : 0;

    const name = nameForIsin(isin) || symbol || isin;

    transactions.push({
      trade_date: date,
      isin,
      symbol,
      name,
      trade_type: tradeType,
      quantity,
      price,
      exchange,
      broker: defaultBroker,
      stt,
      charges,
      order_id: orderId,
      trade_id: tradeId,
    });
  }

  return {
    status: 'success',
    broker: defaultBroker,
    imported_count: transactions.length,
    skipped_count: skipped,
    transactions,
  };
}
