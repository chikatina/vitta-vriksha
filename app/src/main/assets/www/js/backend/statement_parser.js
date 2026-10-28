/*
 * Statement and transaction import engine.
 *
 * Parses on-device UPI statements (PhonePe, Google Pay, Paytm) from PDF exports
 * and CSV statement exports (including Cashew and generic bank exports).
 *
 * Runs completely locally on-device. No network access or third-party cloud.
 */

import { fail } from './errors.js';
import {
  currentCurrency, getDatabase, initDb, resolveMemberId,
} from './database.js';
import { categoryForMerchant, extractMerchant, merchantKey } from './merchants.js';
import { decodeBase64 } from './native.js';

const PDFJS_URL = new URL('../../vendor/pdfjs/pdf.mjs', import.meta.url);
const PDFJS_WORKER_URL = new URL('../../vendor/pdfjs/pdf.worker.mjs', import.meta.url);

let pdfjs = null;

async function getPdfjs() {
  if (pdfjs) return pdfjs;
  const lib = await import(PDFJS_URL.href);
  lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL.href;
  pdfjs = lib;
  return pdfjs;
}

const MONTH_MAP = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  january: '01', february: '02', march: '03', april: '04', may_: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

/** Normalizes diverse human dates to YYYY-MM-DD */
export function normalizeDate(str) {
  if (!str) return '';
  const s = String(str).trim();

  // YYYY-MM-DD
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  }

  // DD-MM-YYYY or DD/MM/YYYY
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(s);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }

  // DD MMM YYYY or MMM DD, YYYY (e.g. 15 Oct 2026, Oct 15, 2026)
  const m1 = /^(\d{1,2})\s+([A-Za-z]{3,9})[,.]?\s+(\d{4})/.exec(s);
  if (m1) {
    const mon = MONTH_MAP[m1[2].toLowerCase().slice(0, 3)];
    if (mon) return `${m1[3]}-${mon}-${m1[1].padStart(2, '0')}`;
  }

  const m2 = /^([A-Za-z]{3,9})\s+(\d{1,2})[,.]?\s+(\d{4})/.exec(s);
  if (m2) {
    const mon = MONTH_MAP[m2[1].toLowerCase().slice(0, 3)];
    if (mon) return `${m2[3]}-${mon}-${m2[2].padStart(2, '0')}`;
  }

  return '';
}

/** Parses amount string into a positive float */
export function cleanAmount(str) {
  if (!str) return 0;
  const noCurrency = String(str).replace(/(?:rs\.?|inr|₹)/gi, '').replace(/,/g, '').trim();
  const match = /([0-9]+(?:\.[0-9]+)?)/.exec(noCurrency);
  if (!match) return 0;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

/**
 * Extracts line-grouped text strings from PDF bytes.
 */
export async function extractPdfLines(bytes, password = '') {
  const lib = await getPdfjs();
  let doc;
  try {
    const loadingTask = lib.getDocument({ data: bytes, password });
    doc = await loadingTask.promise;
  } catch (err) {
    if (err && (err.name === 'PasswordException' || String(err.message).includes('password'))) {
      throw fail('CAS_WRONG_PASSWORD', 'This PDF is password protected. Please enter the password.');
    }
    throw fail('CAS_FILE_UNREADABLE', 'Could not open PDF file.');
  }

  const allLines = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const items = (content.items || []).filter((it) => it && it.str && it.str.trim());

    // Sort top-to-bottom (y desc), then left-to-right (x asc)
    items.sort((a, b) => {
      const yA = a.transform ? a.transform[5] : 0;
      const yB = b.transform ? b.transform[5] : 0;
      const dy = yB - yA;
      if (Math.abs(dy) > 3.5) return dy;
      const xA = a.transform ? a.transform[4] : 0;
      const xB = b.transform ? b.transform[4] : 0;
      return xA - xB;
    });

    let currentLine = [];
    let currentY = null;
    for (const item of items) {
      const y = item.transform ? item.transform[5] : 0;
      if (currentY === null || Math.abs(currentY - y) > 3.5) {
        if (currentLine.length > 0) {
          allLines.push(currentLine.map((it) => it.str.trim()).join(' '));
        }
        currentLine = [item];
        currentY = y;
      } else {
        currentLine.push(item);
      }
    }
    if (currentLine.length > 0) {
      allLines.push(currentLine.map((it) => it.str.trim()).join(' '));
    }
  }

  return allLines;
}

/**
 * Detects statement provider from extracted lines.
 */
export function detectProvider(lines) {
  const headerText = lines.slice(0, 30).join(' ').toLowerCase();
  if (headerText.includes('phonepe')) return 'phonepe';
  if (headerText.includes('google pay') || headerText.includes('gpay')) return 'gpay';
  if (headerText.includes('paytm')) return 'paytm';
  if (headerText.includes('cashew')) return 'cashew';
  return 'generic';
}

/**
 * Parses PhonePe PDF Statement lines into structured transactions.
 */
export function parsePhonePeStatement(lines) {
  const transactions = [];

  // Patterns for PhonePe statements:
  // e.g.: "Oct 12, 2026 Paid to Starbucks DEBIT ₹ 250.00"
  // e.g.: "Oct 12, 2026 14:22:10" followed by "Paid to Starbucks" ... "DEBIT ₹250.00"
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Look for date at the start
    const dateMatch = /^([A-Za-z]{3}\s+\d{1,2},\s+\d{4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{4}|\d{2}[-/]\d{2}[-/]\d{4})/.exec(line);
    if (!dateMatch) continue;

    const date = normalizeDate(dateMatch[1]);
    if (!date) continue;

    // Check next 1-3 lines or rest of current line for details
    const textChunk = [line, lines[i + 1] || '', lines[i + 2] || ''].join(' ');

    const isDebit = /\b(DEBIT|DR|Paid to|Transfer to)\b/i.test(textChunk);
    const isCredit = /\b(CREDIT|CR|Received from|Refund from|Cashback from)\b/i.test(textChunk);
    const type = isCredit && !isDebit ? 'Income' : 'Expense';

    // Amount extraction
    const amtMatch = /(?:₹|rs\.?|inr)?\s*([0-9,]+\.[0-9]{2})\b/i.exec(textChunk);
    if (!amtMatch) continue;
    const amount = cleanAmount(amtMatch[1]);
    if (!(amount > 0)) continue;

    // Merchant / description
    let rawDesc = '';
    const descMatch = /(?:Paid to|Received from|Transfer to|Refund from)\s+([^₹\n\r]+?)(?=(?:\s+(?:DEBIT|CREDIT)|₹|\s+UTR|\s+Txn))/i.exec(textChunk);
    if (descMatch) {
      rawDesc = descMatch[1].trim();
    } else {
      rawDesc = line.replace(dateMatch[0], '').replace(amtMatch[0], '').replace(/\b(DEBIT|CREDIT)\b/gi, '').trim();
    }

    const merchant = extractMerchant(rawDesc) || rawDesc || (type === 'Income' ? 'Payment Received' : 'UPI Payment');
    const category = categoryForMerchant(merchant) || (type === 'Income' ? 'Income' : 'Other');

    // Reference ID / UTR
    const utrMatch = /(?:UTR|Txn ID|Ref(?:erence)?(?:\s*No)?)\s*[:\s-]*([A-Za-z0-9]+)/i.exec(textChunk);
    const refId = utrMatch ? utrMatch[1] : '';

    transactions.push({
      date,
      amount,
      type,
      category,
      merchant,
      description: rawDesc ? `UPI: ${rawDesc}` : 'PhonePe Statement Transaction',
      ref_id: refId,
      source: 'PhonePe',
    });
  }

  return transactions;
}

/**
 * Parses Google Pay PDF Statement lines into structured transactions.
 */
export function parseGPayStatement(lines) {
  const transactions = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // e.g. "12 Oct 2026, 02:30 PM" or "Oct 12, 2026"
    const dateMatch = /^(\d{1,2}\s+[A-Za-z]{3}\s+\d{4}|[A-Za-z]{3}\s+\d{1,2},\s+\d{4})/.exec(line);
    if (!dateMatch) continue;

    const date = normalizeDate(dateMatch[1]);
    if (!date) continue;

    const textChunk = [line, lines[i + 1] || '', lines[i + 2] || ''].join(' ');

    const amtMatch = /(?:₹|rs\.?|inr)?\s*([0-9,]+\.[0-9]{2})\b/i.exec(textChunk);
    if (!amtMatch) continue;
    const amount = cleanAmount(amtMatch[1]);
    if (!(amount > 0)) continue;

    const isCredit = /\b(Received|Refund|Cashback|credited)\b/i.test(textChunk);
    const type = isCredit ? 'Income' : 'Expense';

    let rawDesc = '';
    const descMatch = /(?:Paid to|Payment to|Received from|To)\s+([^₹\n\r]+?)(?=(?:\s+Completed|₹|\s+Google Pay Txn|\s+Txn))/i.exec(textChunk);
    if (descMatch) {
      rawDesc = descMatch[1].trim();
    } else {
      rawDesc = line.replace(dateMatch[0], '').replace(amtMatch[0], '').trim();
    }

    const merchant = extractMerchant(rawDesc) || rawDesc || (type === 'Income' ? 'Payment Received' : 'UPI Payment');
    const category = categoryForMerchant(merchant) || (type === 'Income' ? 'Income' : 'Other');

    const txnMatch = /(?:Google Pay Transaction ID|Txn ID|Ref)\s*[:\s-]*([A-Za-z0-9_-]+)/i.exec(textChunk);
    const refId = txnMatch ? txnMatch[1] : '';

    transactions.push({
      date,
      amount,
      type,
      category,
      merchant,
      description: rawDesc ? `GPay: ${rawDesc}` : 'Google Pay Statement Transaction',
      ref_id: refId,
      source: 'Google Pay',
    });
  }

  return transactions;
}

/**
 * Parses generic bank / Paytm / universal PDF statement lines.
 */
export function parseGenericStatement(lines) {
  const transactions = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Look for date at the start of a line
    const dateMatch = /^(\d{1,2}[-/]\d{1,2}[-/]\d{4}|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/.exec(line);
    if (!dateMatch) continue;

    const date = normalizeDate(dateMatch[1]);
    if (!date) continue;

    const amtMatch = /(?:₹|rs\.?|inr)?\s*([0-9,]+\.[0-9]{2})\b/i.exec(line);
    if (!amtMatch) continue;
    const amount = cleanAmount(amtMatch[1]);
    if (!(amount > 0)) continue;

    const isCredit = /\b(CR|Credit|Deposit|Received)\b/i.test(line);
    const type = isCredit ? 'Income' : 'Expense';

    const remainder = line.replace(dateMatch[0], '').replace(amtMatch[0], '').trim();
    const merchant = extractMerchant(remainder) || remainder.slice(0, 30).trim() || 'Bank Transaction';
    const category = categoryForMerchant(merchant) || (type === 'Income' ? 'Income' : 'Other');

    transactions.push({
      date,
      amount,
      type,
      category,
      merchant,
      description: remainder,
      ref_id: '',
      source: 'Bank Statement',
    });
  }

  return transactions;
}

/**
 * Parses RFC 4180 CSV text (e.g. Cashew, Walnut, or generic bank export).
 */
export function parseCsvStatements(csvText) {
  const text = String(csvText || '').trim();
  if (!text) return [];

  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  // Parse header
  const headerLine = lines[0];
  const headers = headerLine.split(',').map((h) => h.replace(/^["']|["']$/g, '').trim().toLowerCase());

  // Detect index of critical columns
  const dateIdx = headers.findIndex((h) => /date|txn_date|transaction_date/i.test(h));
  const amountIdx = headers.findIndex((h) => /amount|cost|value/i.test(h));
  const descIdx = headers.findIndex((h) => /title|desc|description|merchant|payee|narration/i.test(h));
  const catIdx = headers.findIndex((h) => /category|type/i.test(h));
  const typeIdx = headers.findIndex((h) => /transaction_type|type|flow|direction/i.test(h));

  if (dateIdx === -1 || amountIdx === -1) {
    return [];
  }

  const transactions = [];

  for (let i = 1; i < lines.length; i += 1) {
    // Regex for CSV split respecting quotes
    const row = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || lines[i].split(',');
    const cleanCells = row.map((c) => c.replace(/^["']|["']$/g, '').trim());

    const rawDate = cleanCells[dateIdx];
    const date = normalizeDate(rawDate);
    if (!date) continue;

    const amount = cleanAmount(cleanCells[amountIdx]);
    if (!(amount > 0)) continue;

    const rawDesc = descIdx !== -1 ? cleanCells[descIdx] : '';
    const rawCat = catIdx !== -1 ? cleanCells[catIdx] : '';
    const rawType = typeIdx !== -1 ? cleanCells[typeIdx].toLowerCase() : '';

    let type = 'Expense';
    if (/income|credit|deposit/i.test(rawType) || /income/i.test(rawCat)) {
      type = 'Income';
    } else if (/transfer/i.test(rawType) || /transfer/i.test(rawCat)) {
      type = 'Transfer';
    }

    const merchant = extractMerchant(rawDesc) || rawDesc || 'Imported Transaction';
    const category = rawCat || categoryForMerchant(merchant) || (type === 'Income' ? 'Income' : 'Other');

    transactions.push({
      date,
      amount,
      type,
      category,
      merchant,
      description: rawDesc,
      ref_id: '',
      source: 'CSV Import',
    });
  }

  return transactions;
}

/**
 * Checks extracted transactions against SQLite database to flag duplicates.
 */
export function flagDuplicates(db, transactions, memberId = 1) {
  const results = [];
  let duplicateCount = 0;

  for (const tx of transactions) {
    // Search existing transactions within +/- 1 day and matching amount
    const existing = db.get(
      'SELECT id, date, amount, merchant FROM transactions WHERE member_id = ? AND date BETWEEN date(?, "-1 day") AND date(?, "+1 day") AND ABS(amount - ?) < 0.01 LIMIT 1',
      [memberId, tx.date, tx.date, tx.amount],
    );

    const isDup = Boolean(existing);
    if (isDup) duplicateCount += 1;

    results.push({
      ...tx,
      is_duplicate: isDup ? 1 : 0,
      existing_id: existing ? existing.id : null,
    });
  }

  return { transactions: results, duplicateCount };
}

/**
 * Backend action to parse a statement (PDF or CSV) and return preview records.
 */
export async function parseStatementAction(args = {}) {
  const db = await getDatabase();
  initDb(db);

  const memberId = resolveMemberId(db, args.member_id);
  const fileBytes = args.file_bytes ? decodeBase64(args.file_bytes) : null;
  const csvText = args.csv_text || null;
  const password = args.password || '';

  let rawTransactions = [];
  let provider = 'generic';

  if (fileBytes) {
    const lines = await extractPdfLines(fileBytes, password);
    if (!lines.length) {
      return fail('CAS_NO_TEXT_LAYER', 'The statement has no readable text. Scans or images are not supported.');
    }
    provider = detectProvider(lines);
    if (provider === 'phonepe') {
      rawTransactions = parsePhonePeStatement(lines);
    } else if (provider === 'gpay') {
      rawTransactions = parseGPayStatement(lines);
    } else {
      rawTransactions = parseGenericStatement(lines);
    }
  } else if (csvText) {
    rawTransactions = parseCsvStatements(csvText);
    provider = 'csv';
  } else {
    return fail('BAD_REQUEST', 'Provide either file_bytes (PDF) or csv_text.');
  }

  if (!rawTransactions.length) {
    return fail('STATEMENT_PARSE_FAILED', 'Could not detect or extract transactions from this statement.');
  }

  const { transactions, duplicateCount } = flagDuplicates(db, rawTransactions, memberId);

  return {
    status: 'success',
    provider,
    total_count: transactions.length,
    duplicate_count: duplicateCount,
    new_count: transactions.length - duplicateCount,
    transactions,
  };
}

/**
 * Backend action to batch-import verified statement transactions into database.
 */
export async function importStatementTransactionsAction(args = {}) {
  const db = await getDatabase();
  initDb(db);

  const memberId = resolveMemberId(db, args.member_id);
  const transactions = args.transactions || [];
  const skipDuplicates = args.skip_duplicates !== false;
  const accountId = args.account_id ? Number(args.account_id) : null;
  const bucketId = args.bucket_id ? Number(args.bucket_id) : null;

  if (!transactions.length) {
    return fail('IMPORT_EMPTY', 'No transactions to import.');
  }

  let importedCount = 0;
  const now = new Date().toISOString();
  const currency = currentCurrency(db);

  db.transaction(() => {
    for (const tx of transactions) {
      if (skipDuplicates && tx.is_duplicate) {
        continue;
      }

      const amount = cleanAmount(tx.amount);
      if (!(amount > 0)) continue;

      const mKey = merchantKey(tx.merchant || '');
      db.run(
        'INSERT INTO transactions (member_id, account_id, card_id, date, amount, currency, type, category, merchant, merchant_key, description, is_investment_outflow, is_duplicate, created_at, bucket_id) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
        [
          memberId,
          accountId,
          tx.date,
          amount,
          currency,
          tx.type || 'Expense',
          tx.category || 'Other',
          tx.merchant || '',
          mKey,
          tx.description || '',
          tx.is_duplicate ? 1 : 0,
          now,
          bucketId,
        ],
      );

      // If linked to an account, adjust balance
      if (accountId) {
        const delta = tx.type === 'Income' ? amount : -amount;
        db.run('UPDATE asset_accounts SET balance = balance + ?, updated_at = ? WHERE id = ?', [delta, now, accountId]);
      }

      importedCount += 1;
    }
  });

  return {
    status: 'success',
    imported_count: importedCount,
  };
}
