/*
 * Turns a raw SMS dump into a table of transactions.
 *
 * The input is what an inbox dumper writes: one "Row: N key=value, ..." record per
 * message, with the body last and free to contain newlines. Most of it is not financial
 * at all, and most of what is financial is a reminder or an advertisement rather than
 * something that moved money.
 *
 * This is a desk tool, not app code. It exists to show what a real inbox looks like so
 * the rules in the app can be written against it. Nothing here is imported by the app.
 *
 *   node scripts/clean-sms.mjs scripts/sms_backup.txt
 *
 * Writes sms_clean.csv (what moved money), sms_review.csv (had an amount, was not read
 * as a transaction) and prints a summary.
 *
 * Two rules keep somebody's inbox out of this file and out of the repository:
 *
 * 1. The category table below holds generic words and nationally known brands only. No
 *    place names, no neighbourhood merchants, no fund houses. A table tuned against one
 *    person's messages is a description of that person: where they shop tells you where
 *    they live. Anything specific belongs in merchant-categories.local.json, which is
 *    ignored by git.
 * 2. The output is redacted. Account tails, phone numbers, references, counterparty
 *    names and transfer narrations are masked on the way out, because the shape of a
 *    message is what you need to write a rule and the digits are not. Pass --keep-raw
 *    when you genuinely need the originals, and do not commit what comes out.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  categoryForMerchant, extractMerchant, merchantKey, notATransaction,
} from '../app/src/main/assets/www/js/backend/merchants.js';

/* ---------------------------------------------------------------- parsing */

/** Splits the dump into records. A body may span lines, so a record ends where the next begins. */
function parseDump(raw) {
  return raw
    .split(/(?=^Row: \d+ )/m)
    .filter((chunk) => chunk.startsWith('Row: '))
    .map((chunk) => {
      const bodyAt = chunk.indexOf(', body=');
      const head = bodyAt >= 0 ? chunk.slice(0, bodyAt) : chunk;
      const record = { body: (bodyAt >= 0 ? chunk.slice(bodyAt + 7) : '').trim() };
      head.replace(/^Row: \d+ /, '').split(', ').forEach((pair) => {
        const eq = pair.indexOf('=');
        if (eq > 0) record[pair.slice(0, eq)] = pair.slice(eq + 1);
      });
      return record;
    });
}

/** A sender id like VM-HDFCBK-S carries the issuer in the middle. */
function issuerOf(address = '') {
  const parts = String(address).toUpperCase().split('-');
  return parts.length >= 2 ? parts[1] : String(address).toUpperCase();
}

function isoDate(millis) {
  const date = new Date(Number(millis));
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* ------------------------------------------------------------- extraction */

const NUMBER = '([\\d,]+(?:\\.\\d{1,2})?)';
const MONEY = '(?:rs\\.?|inr|₹)\\s*\\.?\\s*';

const DEBIT_VERB = 'spent|debited|withdrawn|deducted|paid|purchased|sent|transferred';
const CREDIT_VERB = 'credited|received|deposited|refunded';

// The transaction amount, taken next to the verb so a closing balance is not mistaken
// for it. Order matters: a message usually states the amount before it states the balance.
const AMOUNT_PATTERNS = [
  { re: new RegExp(`${MONEY}${NUMBER}\\s+(?:has been\\s+|was\\s+|is\\s+)?(?:${DEBIT_VERB})`, 'i'), direction: 'debit' },
  { re: new RegExp(`(?:${DEBIT_VERB})\\s+(?:of\\s+|for\\s+|amount\\s+)?${MONEY}${NUMBER}`, 'i'), direction: 'debit' },
  { re: new RegExp(`${MONEY}${NUMBER}\\s+(?:has been\\s+|was\\s+|is\\s+)?(?:${CREDIT_VERB})`, 'i'), direction: 'credit' },
  { re: new RegExp(`(?:${CREDIT_VERB})\\s+(?:with\\s+|of\\s+|amount\\s+)?${MONEY}${NUMBER}`, 'i'), direction: 'credit' },
  // A fund house words a purchase as a request that was processed, with the amount in
  // the middle and the verb at the end, so neither of the shapes above reaches it.
  { re: new RegExp(`for\\s+${MONEY}${NUMBER}\\s+in\\s+(?:the\\s+)?scheme`, 'i'), direction: 'debit' },
];

const ACCOUNT_RE = /(?:a\/c|acct|account|card(?:\s+no)?\.?|tag)\s*(?:no\.?)?\s*[*x#]*\s*(\d{3,6})\b/i;
const REF_RE = /(?:ref(?:erence)?(?:\s+no)?\.?|upi|txn(?:\s+id)?|rrn)[:\s#-]*([A-Za-z0-9]{6,20})/i;

const CHANNELS = [
  [/\btoll\b|fastag|\btag\b/i, 'toll'],
  [/meal wallet|wallet/i, 'wallet'],
  [/\bupi\b|\bvpa\b/i, 'upi'],
  [/credit card|\bcard\b|\bpos\b/i, 'card'],
  [/\bimps\b|\bneft\b|\brtgs\b/i, 'transfer'],
  [/\batm\b/i, 'atm'],
];

/*
 * Whatever is specific to one inbox lives outside this file, in an object of
 * {"merchant substring": "Category"}. That is where "the mandate labelled INDIAN
 * CLEARING CORP LTD is my monthly SIP" belongs: true for one person, meaningless and
 * disclosing for everybody else.
 */
function loadLocalCategories(dir) {
  const file = path.join(dir, 'merchant-categories.local.json');
  if (!fs.existsSync(file)) return [];
  try {
    return Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))
      .map(([needle, category]) => [needle.toLowerCase(), category]);
  } catch (error) {
    console.warn(`ignoring ${file}: ${error.message}`);
    return [];
  }
}

/*
 * Local rules first, then the dictionary the app itself ships. Sharing that module is
 * the point: a vendor added for the app is a vendor this script recognises, and there is
 * only one table to keep honest.
 */
function categoryFor(merchant, body, local) {
  const lower = merchant.toLowerCase();
  for (const [needle, category] of local) if (lower.includes(needle)) return category;
  return categoryForMerchant(merchant, body);
}

function channelFor(body) {
  for (const [re, channel] of CHANNELS) if (re.test(body)) return channel;
  return 'other';
}

function toAmount(text) {
  const value = Number(String(text).replace(/,/g, ''));
  return Number.isFinite(value) ? value : 0;
}

/* ---------------------------------------------------------------- redaction */

// A counterparty with one of these in its name is a business. Anything else that reads
// as two or three plain words is somebody's name.
const CORPORATE = /\b(?:ltd|limited|pvt|private|llp|inc|corp\w*|co|company|services|solutions|technologies|tech|enterprises|traders|stores?|mall|bank|india|digital|media|systems|industries|foods?|retail|toll|plaza|metro|hospital|clinic)\b/i;

function looksLikePerson(name) {
  const words = name.trim().split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  if (CORPORATE.test(name)) return false;
  return words.every((word) => /^[A-Za-z]{2,}$/.test(word));
}

/*
 * Masks what identifies a person while leaving the shape of the message intact. You
 * write a rule against "Sent Rs.NNN From HDFC Bank A/C xXXXX To PERSON On DD/MM/YY",
 * and every digit that made that line yours is gone.
 */
function redact(text) {
  return String(text)
    // Transfer narrations name an employer or a counterparty bank branch, and they run
    // to the end of the field rather than to the end of the word.
    .replace(/\b(neft|imps|rtgs)(\s*(?:cr|dr)?[ -]+)[^,]*/gi, '$1$2REDACTED')
    // UPI handles and email addresses.
    .replace(/[\w.\-]{2,}@[a-z]{2,}\b/gi, 'handle@upi')
    // The tail of an account, card or tag, keeping the label that a rule matches on.
    // "SMS BLOCK CC 1929" and "card ending with 1929" carry it as surely as "A/C x1578".
    .replace(/\b(a\/c|acct|account|card(?:\s+no)?\.?|tag|cc|dc|p?block)(\s*(?:no[.:]?)?\s*[*x#]*\s*)\d{3,6}\b/gi, '$1$2XXXX')
    .replace(/\b(ending\s+(?:with\s+)?)\d{3,6}\b/gi, '$1XXXX')
    // A closing balance or a credit limit is the most revealing number in the message
    // and no rule is ever written against its value.
    .replace(/\b((?:avl|avbl|available|main|total)[\s.]*(?:bal(?:ance)?|lmt|limit)[:\s]*(?:rs\.?|inr|₹)?\s*)[\d,]+(?:\.\d+)?/gi, '$1XXXX')
    // A masked identifier the sender already partly starred, such as a tag 3XXX9900.
    .replace(/\b\d?[*xX#]{2,}\d{3,}\b/g, 'XXXX')
    // Vehicle registrations.
    .replace(/\b[A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{4}\b/g, 'XX00XX0000')
    // Phone numbers, references, mandate ids. An amount never has seven digits in a row
    // because it carries separators, so this does not touch the money.
    .replace(/\b[A-Z]{0,6}\d{7,}\b/g, 'REF')
    .replace(/\b\d{5}[A-Z0-9]{5,}\b/gi, 'REF');
}

/** A counterparty handle identifies somebody as surely as a name does. */
function looksLikeHandle(name) {
  return /@/.test(name) || /\d{5,}/.test(name);
}

/* --------------------------------------------------------- classification */

/** Reads one message. Returns a transaction, or a rejection with the reason. */
function classify(record, local) {
  const body = record.body || '';

  const notMoney = notATransaction(body);
  if (notMoney) return { ok: false, reason: notMoney };

  let amount = 0;
  let direction = '';
  for (const { re, direction: dir } of AMOUNT_PATTERNS) {
    const match = re.exec(body);
    if (match) {
      amount = toAmount(match[1]);
      direction = dir;
      break;
    }
  }
  if (!amount) return { ok: false, reason: /\d/.test(body) ? 'no-amount-near-verb' : 'no-amount' };

  const merchant = extractMerchant(body);
  const account = ACCOUNT_RE.exec(body);
  const ref = REF_RE.exec(body);

  // Paying a card bill, topping up a wallet or recharging a tag moves money between the
  // user's own pockets. Filing it as income would double-count every rupee already spent.
  const isSelfTransfer = direction === 'credit'
    && /credited to your card|card.*payment received|payment of .* was credited|wallet has been.*credited|successfully credited with|recharge successful|fastag/i.test(body);

  return {
    ok: true,
    date: isoDate(record.date),
    sender: record.address || '',
    issuer: issuerOf(record.address),
    direction,
    amount,
    account: account ? account[1] : '',
    merchant,
    // The same key the app stores, so a row here can be pasted straight into
    // merchant-categories.local.json or taught to the app as a rule.
    merchant_key: merchantKey(merchant),
    channel: channelFor(body),
    kind: isSelfTransfer ? 'transfer' : direction,
    category: isSelfTransfer ? 'Transfer' : categoryFor(merchant, body, local),
    ref: ref ? ref[1] : '',
    body,
  };
}

/**
 * Strips the identifying parts of a finished row. The category was already decided from
 * the real merchant, so masking a counterparty here costs nothing downstream.
 */
function deidentify(row) {
  const isPerson = looksLikePerson(row.merchant) || looksLikeHandle(row.merchant);
  const body = isPerson && row.merchant
    ? row.body.replace(new RegExp(row.merchant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'PERSON')
    : row.body;
  return {
    ...row,
    // A bank sends from a short code, a person sends from their number.
    sender: redact(row.sender),
    account: row.account ? 'XXXX' : '',
    ref: row.ref ? 'REF' : '',
    // The merchant column is a leak in its own right: a UPI handle is a phone number and
    // a counterparty name is a person. The category was already decided from the real
    // value, so nothing downstream depends on it surviving.
    merchant: isPerson ? 'PERSON' : redact(row.merchant),
    body: redact(body).replace(/\s+/g, ' '),
  };
}

/* ------------------------------------------------------------------ output */

function toCsv(rows, columns) {
  const cell = (value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(','), ...rows.map((row) => columns.map((c) => cell(row[c])).join(','))].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const keepRaw = args.includes('--keep-raw');
  const input = args.find((a) => !a.startsWith('--')) || path.join('scripts', 'sms_backup.txt');
  const outDir = path.dirname(input);
  const local = loadLocalCategories(outDir);
  const records = parseDump(fs.readFileSync(input, 'utf8'));

  // An inbox dump carries sent messages and drafts too, and the same alert can appear
  // twice when a backup is merged.
  const inbox = records.filter((r) => r.type === '1' && r.body);
  const seen = new Set();
  const unique = inbox.filter((r) => {
    const key = `${r.date}|${r.body}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const transactions = [];
  const review = [];
  const reasons = {};

  for (const record of unique) {
    const result = classify(record, local);
    if (result.ok) {
      transactions.push(keepRaw ? result : deidentify(result));
      continue;
    }
    reasons[result.reason] = (reasons[result.reason] || 0) + 1;
    if (/(?:rs\.?|inr|₹)\s*\.?\s*[\d,]+/i.test(record.body)) {
      const body = record.body.replace(/\s+/g, ' ');
      review.push({
        date: isoDate(record.date),
        sender: keepRaw ? (record.address || '') : redact(record.address || ''),
        reason: result.reason,
        body: keepRaw ? body : redact(body),
      });
    }
  }

  transactions.sort((a, b) => a.date.localeCompare(b.date));

  const txColumns = ['date', 'sender', 'issuer', 'direction', 'kind', 'amount', 'account',
    'merchant', 'merchant_key', 'channel', 'category', 'ref', 'body'];
  const cleanPath = path.join(outDir, 'sms_clean.csv');
  const reviewPath = path.join(outDir, 'sms_review.csv');
  fs.writeFileSync(cleanPath, toCsv(transactions, txColumns), 'utf8');
  fs.writeFileSync(reviewPath, toCsv(review, ['date', 'sender', 'reason', 'body']), 'utf8');

  const withCategory = transactions.filter((t) => t.category).length;
  const withMerchant = transactions.filter((t) => t.merchant).length;
  const masked = transactions.filter((t) => t.merchant === 'PERSON').length;
  const pct = (n, total) => `${((100 * n) / (total || 1)).toFixed(0)}%`;

  console.log(`read         ${records.length} records, ${unique.length} unique inbox messages`);
  console.log(`transactions ${transactions.length}`);
  console.log(`  merchant   ${withMerchant} (${pct(withMerchant, transactions.length)})`);
  console.log(`  category   ${withCategory} (${pct(withCategory, transactions.length)})`
    + `${local.length ? `, ${local.length} local rules applied` : ', no local rules'}`);
  console.log(`  debit ${transactions.filter((t) => t.kind === 'debit').length}`
    + `  credit ${transactions.filter((t) => t.kind === 'credit').length}`
    + `  transfer ${transactions.filter((t) => t.kind === 'transfer').length}`);
  console.log(`skipped      ${Object.entries(reasons).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(keepRaw
    ? 'output       RAW, identifying details intact. Do not commit or share.'
    : `output       redacted, ${masked} counterparties masked as PERSON`);
  console.log(`wrote        ${cleanPath}`);
  console.log(`             ${reviewPath} (${review.length} rows worth a look)`);
}

main();
