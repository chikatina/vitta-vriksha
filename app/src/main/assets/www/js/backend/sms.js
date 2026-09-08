/*
 * Turning a bank alert into a transaction.
 *
 * The rules are rows in the database rather than code, so a bank that words its messages
 * differently is a row the user adds rather than a release. A rule matches on a phrase in
 * the body and names the pattern that finds the amount; everything else falls through to
 * a general classifier that at least gets the amount and the direction right.
 *
 * The message itself is only ever read here. Nothing about it leaves the device, and the
 * app has no network permission to send it anywhere even if it wanted to.
 */

import {
  autoUpdateAccountFromSms, autoUpdateCreditCardFromSms, currentCurrency, getDatabase, initDb, learnMerchant,
  parseAccountDetailsFromText, resolveAccountAndCardFromSms, resolveMemberId,
} from './database.js';
import { memberClause } from './periods.js';
import { readSmsInbox, takePendingAlerts } from './native.js';
import {
  categoryForMerchant, extractMerchant, merchantKey, notATransaction,
} from './merchants.js';
import { fail } from './errors.js';

const DEFAULT_AMOUNT_RE = /(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]+)?)/i;
const FALLBACK_AMOUNT_RE = /(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]+)?)/i;
const ACCOUNT_RE = /(?:card|a\/c|acct|account|wallet|vpa)\s*(?:no\.?|ending(?:\s*(?:in|with))?|number)?\s*[*Xx#\s]*([0-9]{4})\b/i;

export function extractTransactionAmount(text) {
  const t = String(text || '');

  // 1. Verb-anchored amount patterns (highest precision)
  const verbPatterns = [
    /(?:spent|debited|paid|withdrawn|charged|sent|used|deducted|transfer(?:red)?)\s*(?:of|for|with|by)?\s*[:\s-]*\s*(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]+)?)/i,
    /(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]+)?)\s*(?:has\s+been|was)?\s*(?:spent|debited|paid|withdrawn|charged|deducted|used)/i,
    /(?:credited|deposited|received|refunded)\s*(?:with|of|for|by)?\s*[:\s-]*\s*(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]+)?)/i,
    /(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]+)?)\s*(?:has\s+been|was)?\s*(?:credited|deposited|received|refunded)/i,
    /(?:txn|tx)\s*(?:of)?\s*[:\s-]*\s*(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]+)?)/i,
    // Currency-omitted alerts where amount follows preposition: e.g. "debited by 440.00", "credited by 500.00"
    /(?:spent|debited|paid|withdrawn|charged|sent|used|deducted|transfer(?:red)?)\s+(?:of|for|with|by)\s+[:\s-]*([0-9,]+(?:\.[0-9]+)?)/i,
    /(?:credited|deposited|received|refunded)\s+(?:with|of|for|by)\s+[:\s-]*([0-9,]+(?:\.[0-9]+)?)/i,
  ];

  for (const pat of verbPatterns) {
    const m = pat.exec(t);
    if (m && m[1]) {
      const amt = toAmount(m[1]);
      if (amt > 0) return amt;
    }
  }

  // 2. Fallback: match any currency symbol followed by amount, but skip if preceded by "bal", "balance", "limit", "due", "avl"
  const allMatches = [...t.matchAll(/(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]+)?)/gi)];
  for (const m of allMatches) {
    const index = m.index;
    const prefix = t.slice(Math.max(0, index - 25), index).toLowerCase();
    if (/avl\s*bal|available\s*bal|clear\s*bal|total\s*bal|wallet\s*bal|bal\b|balance\b|limit\b|lmt\b|due\b|min\s*due|total\s*due/.test(prefix)) {
      continue;
    }
    const amt = toAmount(m[1]);
    if (amt > 0) return amt;
  }

  // 3. Ultimate fallback
  const first = DEFAULT_AMOUNT_RE.exec(t);
  return first ? toAmount(first[1]) : 0;
}

const DATE_PATTERNS = [
  /\b(?:on\s+date|on|dt\.?|dated)\s+(\d{1,2})[-/]?([A-Za-z]{3}|\d{1,2})[-/]?(\d{2,4})\b/i,
  /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/,
];

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function extractDate(text) {
  const pad = (v) => String(v).padStart(2, '0');
  for (const pattern of DATE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (match.length === 4 && match[1].length === 4) {
      const y = match[1];
      const m = pad(match[2]);
      const d = pad(match[3]);
      return `${y}-${m}-${d}`;
    }
    const d = pad(match[1]);
    const mRaw = match[2].toLowerCase();
    const mNum = MONTHS[mRaw] || Number(mRaw);
    if (!mNum || mNum < 1 || mNum > 12) continue;
    const m = pad(mNum);
    let y = match[3];
    if (y.length === 2) y = `20${y}`;
    return `${y}-${m}-${d}`;
  }
  return null;
}

const UTR_PATTERNS = [
  /\bupi(?:\/|\s*(?:ref|txn|reference)?\s*(?:no\.?|id|num)?[:\s\/-]+)([A-Za-z0-9]{6,24})\b/i,
  /\b(?:ref(?:\s*no\.?|\s*id|\s*num)?|rrn|utr(?:\s*no\.?)?|txn\s*id|transaction\s*id|reference\s*no\.?)[:\s\/-]+([A-Za-z0-9]{6,24})\b/i,
  /\b(?:info|via)[:\s]+[A-Za-z0-9\s-]*\/\s*([0-9]{6,24})\b/i,
  /\bupi\/\s*([0-9]{6,24})\b/i,
];

export function extractUtr(text) {
  if (!text || typeof text !== 'string') return '';
  for (const pattern of UTR_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match[1]) {
      const val = match[1].trim();
      if (val.length >= 6 && /\d/.test(val) && !/^(success|pending|completed|declined|reversed)$/i.test(val)) {
        return val;
      }
    }
  }
  return '';
}

export function isoFromMillis(millis) {
  if (!millis) return null;
  if (typeof millis === 'string' && /^\d{4}-\d{2}-\d{2}/.test(millis)) {
    return millis.slice(0, 10);
  }
  const date = new Date(Number(millis));
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function toAmount(text) {
  const clean = String(text || '').replace(/,/g, '').replace(/\/[- ]*$/, '').trim();
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A rule's own pattern is user-supplied, so it is compiled defensively: an invalid one
 * falls back to the default rather than taking the whole classifier down with it.
 */
function compile(pattern) {
  if (!pattern) return DEFAULT_AMOUNT_RE;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return DEFAULT_AMOUNT_RE;
  }
}

/*
 * Does this trigger appear in the body as a word.
 *
 * Plain substring matching is what "emi" does to "reminder": one three letter trigger
 * matched eight hundred messages, nearly all of them reminders, and every one would have
 * been filed as a loan payment. A trigger has to sit on word boundaries. The edges are
 * only anchored where the trigger itself starts or ends alphanumeric, so a wording like
 * "ach d-" still matches.
 */
const triggerCache = new Map();

function triggerMatches(trigger, text) {
  let pattern = triggerCache.get(trigger);
  if (!pattern) {
    const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = /^[a-z0-9]/i.test(trigger) ? '\\b' : '';
    const right = /[a-z0-9]$/i.test(trigger) ? '\\b' : '';
    pattern = new RegExp(left + escaped + right, 'i');
    triggerCache.set(trigger, pattern);
  }
  return pattern.test(text);
}

/**
 * What is known about a counterparty, cheapest source first.
 *
 * Tier one is what this household already taught the app: one seek on the primary key of
 * merchant_rules, which is where nearly every message lands, because spending repeats.
 * Tier two is the dictionary that ships in merchants.js, one pass over the text however
 * many vendors it holds. Neither tier walks a list of rules per message.
 */
const INCOME_CATEGORIES = new Set(['Salary', 'Freelance', 'Interest & Dividends', 'Refunds & Cashback']);
const INVESTMENT_CATEGORIES = new Set([
  'Investment Outflow', 'Investment', 'Investments', 'Emergency Fund',
  'Mutual Funds', 'Stocks & Equity', 'Fixed Deposit & RD', 'Gold & Metals',
  'Retirement & NPS', 'Real Estate', 'Crypto & Digital Assets',
]);
const TRANSFER_CATEGORIES = new Set(['Transfer', 'Credit Card', 'Investment Outflow']);

/*
 * Does this category belong on a row of this kind.
 *
 * The dictionary reads a vendor, not a direction, so it happily answers "Dining" for a
 * meal card. That is right for a lunch and absurd for the employer's credit that paid for
 * it, which would arrive as income filed under an expense category. A category the user
 * taught is exempt: they said what they meant.
 */
function categoryFits(category, type) {
  if (!category) return false;
  if (type === 'Income') return INCOME_CATEGORIES.has(category);
  if (type === 'Investment') return INVESTMENT_CATEGORIES.has(category);
  if (type === 'Transfer') return TRANSFER_CATEGORIES.has(category);
  if (type === 'Ignore') return category === 'Ignore';
  return !INCOME_CATEGORIES.has(category) && !INVESTMENT_CATEGORIES.has(category) && !TRANSFER_CATEGORIES.has(category);
}

/** Whether what is known about the vendor may stand as this row's category. */
function usable(known, type) {
  if (!known.category) return false;
  return known.source === 'learned' || categoryFits(known.category, type);
}

function knownCategory(db, key, merchant, text, merchantMap = null) {
  if (key) {
    if (merchantMap) {
      const learned = merchantMap.get(key);
      if (learned) return learned;
    } else {
      const learned = db.get(
        'SELECT category_name, transaction_type FROM merchant_rules WHERE merchant_key = ?', [key],
      );
      if (learned) {
        return { category: learned.category_name, type: learned.transaction_type || '', source: 'learned' };
      }
    }
  }
  const found = categoryForMerchant(merchant, text);
  let type = '';
  if (found === 'Investment Outflow') type = 'Investment';
  else if (found === 'Loans & EMI') type = 'Expense';
  else if (found === 'Credit Card' || found === 'Transfer') type = 'Transfer';
  else if (INCOME_CATEGORIES.has(found)) type = 'Income';
  return { category: found, type, source: found ? 'dictionary' : '' };
}

/** Pre-loads rules, merchant dictionaries, accounts, and cards in-memory for instant batch SMS classification. */
export function buildClassificationContext(db, memberId = null) {
  initDb(db);
  const rules = db.all("SELECT * FROM sms_rules WHERE is_active = 1 ORDER BY CASE WHEN transaction_type = 'Ignore' THEN 0 ELSE 1 END, id ASC");
  const merchantRows = db.all('SELECT merchant_key, category_name, transaction_type FROM merchant_rules');
  const merchantMap = new Map();
  for (const m of merchantRows) {
    if (m.merchant_key) {
      merchantMap.set(m.merchant_key, { category: m.category_name, type: m.transaction_type || '', source: 'learned' });
    }
  }
  const [clause, params] = memberClause(memberId, 'WHERE');
  const cachedAccounts = db.all(`SELECT id, name, category, institution, account_number, debit_card_last_4 FROM asset_accounts${clause}`, params);
  const cachedCards = db.all(`SELECT id, card_name, bank, last_4, total_limit, available_limit, current_balance FROM credit_cards${clause}`, params);

  return {
    db,
    memberId,
    rules,
    merchantMap,
    cachedAccounts,
    cachedCards,
  };
}

/** Extracts note or remark or reference info from SMS text. */
export function extractDescription(text) {
  if (!text) return '';
  const match = /(?:info[:\s-]+|towards\s+|note[:\s-]+|remarks?[:\s-]+|ref(?:\s+no\.?)?[:\s-]+)([A-Za-z0-9\s/._-]+)/i.exec(text);
  if (match) {
    const cleaned = match[1].replace(/\b(?:on|dt|avl|bal|a\/c|xx\d+|\d{2}[-/]\d{2}[-/]\d{2,4})\b.*/i, '').trim();
    if (cleaned.length > 2 && cleaned.length < 80) return cleaned;
  }
  return '';
}

/** Classifies one message against the stored rules and everything known about the vendor. */
export async function parseSmsText(text, sender = '', receivedAt = null, context = null) {
  const db = context?.db || (await getDatabase());
  if (!context) initDb(db);

  const rules = context?.rules || db.all("SELECT * FROM sms_rules WHERE is_active = 1 ORDER BY CASE WHEN transaction_type = 'Ignore' THEN 0 ELSE 1 END, id ASC");
  const lower = String(text).toLowerCase();
  const merchant = extractMerchant(text);
  const key = merchantKey(merchant);
  const known = knownCategory(db, key, merchant, text, context?.merchantMap);
  const accountInfo = parseAccountDetailsFromText(text, sender);
  const resolvedAccount = resolveAccountAndCardFromSms(db, text, sender, {
    memberId: context?.memberId,
    cachedAccounts: context?.cachedAccounts,
    cachedCards: context?.cachedCards,
  });
  const accountMatch = ACCOUNT_RE.exec(text);
  const accountLast4 = accountInfo.last4 || (accountMatch ? accountMatch[1] : '');
  const senderText = String(sender).toLowerCase();
  const dateFromSms = extractDate(text) || (receivedAt ? isoFromMillis(receivedAt) : null) || today();
  const descriptionFromSms = extractDescription(text);

  // Check learned merchant ignore rules first
  if (known.type === 'Ignore' || known.category === 'Ignore') {
    return {
      status: 'classified',
      matched_rule: 'Ignored Merchant Rule',
      not_a_transaction: 'ignored-rule',
      amount: 0,
      type: 'Ignore',
      category: 'Ignore',
      category_source: 'rule',
      merchant: merchant || '',
      merchant_key: key,
      account_last4: accountLast4,
      account_issuer: accountInfo.issuer,
      is_food_card: accountInfo.isFoodCard,
      is_credit_card: accountInfo.isCreditCard,
      card_variant: accountInfo.cardVariant,
      available_limit: accountInfo.available_limit,
      total_limit: accountInfo.total_limit,
      current_outstanding: accountInfo.current_outstanding,
      min_due: accountInfo.min_due,
      account_balance: accountInfo.account_balance,
      account_id: resolvedAccount.account_id,
      card_id: resolvedAccount.card_id,
      sender,
      description: descriptionFromSms,
      raw_sms: text,
      date: dateFromSms,
    };
  }

  // User-defined Ignore rules take top priority over built-in classifier
  for (const rule of rules) {
    if (rule.transaction_type !== 'Ignore') continue;
    const trigger = String(rule.body_trigger || '').toLowerCase();
    if (!trigger || !triggerMatches(trigger, lower)) continue;
    const wants = String(rule.sender_keyword || '').toLowerCase();
    if (wants && senderText && !senderText.includes(wants)) continue;

    return {
      status: 'classified',
      matched_rule: rule.rule_name,
      not_a_transaction: 'ignored-rule',
      amount: 0,
      type: 'Ignore',
      category: 'Ignore',
      category_source: 'rule',
      merchant: merchant || '',
      merchant_key: key,
      account_last4: accountLast4,
      account_issuer: accountInfo.issuer,
      is_food_card: accountInfo.isFoodCard,
      is_credit_card: accountInfo.isCreditCard,
      card_variant: accountInfo.cardVariant,
      available_limit: accountInfo.available_limit,
      total_limit: accountInfo.total_limit,
      current_outstanding: accountInfo.current_outstanding,
      min_due: accountInfo.min_due,
      account_balance: accountInfo.account_balance,
      account_id: resolvedAccount.account_id,
      card_id: resolvedAccount.card_id,
      sender,
      description: descriptionFromSms,
      raw_sms: text,
      date: dateFromSms,
    };
  }

  const notMoney = notATransaction(text);

  /*
   * Money between the household's own pockets.
   *
   * Paying a credit card bill and topping up a wallet were thrown away, because filing
   * either as income would have booked every rupee already spent as earnings. Thrown away
   * is not right either: the money did move, and a ledger that never shows the card bill
   * cannot explain where the bank balance went. It is a transfer, which every total that
   * adds up income or expenditure leaves out.
   */
  if (notMoney === 'card-payment' || notMoney === 'self-transfer') {
    const moved = extractTransactionAmount(text) || (FALLBACK_AMOUNT_RE.exec(text) ? toAmount(FALLBACK_AMOUNT_RE.exec(text)[1]) : 0);
    return {
      status: 'classified',
      matched_rule: notMoney === 'card-payment' ? 'Credit card payment' : 'Own transfer',
      amount: moved,
      type: 'Transfer',
      category: notMoney === 'card-payment' ? 'Credit Card' : 'Transfer',
      category_source: 'rule',
      merchant: merchant || (notMoney === 'card-payment' ? 'Credit Card Payment' : ''),
      merchant_key: key || (notMoney === 'card-payment' ? 'credit card payment' : ''),
      account_last4: accountLast4,
      account_issuer: accountInfo.issuer,
      is_food_card: accountInfo.isFoodCard,
      is_credit_card: accountInfo.isCreditCard,
      card_variant: accountInfo.cardVariant,
      available_limit: accountInfo.available_limit,
      total_limit: accountInfo.total_limit,
      current_outstanding: accountInfo.current_outstanding,
      min_due: accountInfo.min_due,
      account_balance: accountInfo.account_balance,
      account_id: resolvedAccount.account_id,
      card_id: resolvedAccount.card_id,
      sender,
      description: descriptionFromSms,
      raw_sms: text,
      date: dateFromSms,
    };
  }

  if (notMoney) {
    return {
      status: 'classified',
      matched_rule: 'Not a transaction',
      not_a_transaction: notMoney,
      amount: 0,
      type: '',
      category: '',
      category_source: '',
      merchant: merchant || '',
      merchant_key: key,
      account_last4: accountLast4,
      account_issuer: accountInfo.issuer,
      is_food_card: accountInfo.isFoodCard,
      is_credit_card: accountInfo.isCreditCard,
      card_variant: accountInfo.cardVariant,
      available_limit: accountInfo.available_limit,
      total_limit: accountInfo.total_limit,
      current_outstanding: accountInfo.current_outstanding,
      min_due: accountInfo.min_due,
      account_balance: accountInfo.account_balance,
      account_id: resolvedAccount.account_id,
      card_id: resolvedAccount.card_id,
      sender,
      description: descriptionFromSms,
      raw_sms: text,
      date: dateFromSms,
    };
  }

  for (const rule of rules) {
    if (rule.transaction_type === 'Ignore') continue;
    const trigger = String(rule.body_trigger || '').toLowerCase();
    if (!trigger || !triggerMatches(trigger, lower)) continue;
    // A rule that names a bank belongs to that bank. An empty keyword means the wording
    // is common enough that whoever sent it does not matter.
    const wants = String(rule.sender_keyword || '').toLowerCase();
    if (wants && senderText && !senderText.includes(wants)) continue;

    const match = compile(rule.regex_pattern).exec(text);
    const parsedAmount = match ? toAmount(match[1]) : extractTransactionAmount(text);

    // A rule names the bank's wording. What was actually bought is the vendor's business,
    // so anything known about the vendor outranks the rule's standing guess.
    const isTransferRule = rule.transaction_type === 'Transfer';
    const resolvedType = (known.source === 'learned' && known.type)
      ? known.type
      : (isTransferRule ? 'Transfer' : (known.type || (known.category === 'Investment Outflow' ? 'Investment' : rule.transaction_type)));
    const resolvedCategory = (known.source === 'learned' && categoryFits(known.category, resolvedType))
      ? known.category
      : (isTransferRule ? rule.category_name : (usable(known, resolvedType) ? known.category : rule.category_name));
    return {
      status: 'classified',
      matched_rule: rule.rule_name,
      amount: parsedAmount,
      type: resolvedType,
      category: resolvedCategory,
      category_source: (known.source === 'learned' || (!isTransferRule && usable(known, resolvedType))) ? known.source : 'rule',
      merchant,
      merchant_key: key,
      account_last4: accountLast4,
      account_issuer: accountInfo.issuer,
      is_food_card: accountInfo.isFoodCard,
      is_credit_card: accountInfo.isCreditCard,
      card_variant: accountInfo.cardVariant,
      available_limit: accountInfo.available_limit,
      total_limit: accountInfo.total_limit,
      current_outstanding: accountInfo.current_outstanding,
      min_due: accountInfo.min_due,
      account_balance: accountInfo.account_balance,
      account_id: resolvedAccount.account_id,
      card_id: resolvedAccount.card_id,
      sender,
      description: descriptionFromSms,
      raw_sms: text,
      date: dateFromSms,
    };
  }

  const fallbackAmount = extractTransactionAmount(text);
  const isCredit = lower.includes('credited') || lower.includes('received') || lower.includes('deposited');
  const guess = isCredit ? 'Salary' : 'Shopping';
  const defaultType = known.type || (known.category === 'Investment Outflow' ? 'Investment' : (isCredit ? 'Income' : 'Expense'));

  return {
    status: 'classified',
    matched_rule: 'Default Classifier',
    amount: fallbackAmount,
    type: defaultType,
    category: usable(known, defaultType) ? known.category : guess,
    category_source: known.source || 'guess',
    merchant,
    merchant_key: key,
    account_last4: accountLast4,
    account_issuer: accountInfo.issuer,
    is_food_card: accountInfo.isFoodCard,
    is_credit_card: accountInfo.isCreditCard,
    card_variant: accountInfo.cardVariant,
    available_limit: accountInfo.available_limit,
    total_limit: accountInfo.total_limit,
    current_outstanding: accountInfo.current_outstanding,
    min_due: accountInfo.min_due,
    account_balance: accountInfo.account_balance,
    account_id: resolvedAccount.account_id,
    card_id: resolvedAccount.card_id,
    sender,
    description: descriptionFromSms,
    raw_sms: text,
    date: dateFromSms,
  };
}

async function importInbox(db, { days = 0, memberId = 1 } = {}) {
  const currency = currentCurrency(db);
  const messages = readSmsInbox(days);

  const seen = new Set(
    db.all("SELECT raw_sms FROM transactions WHERE raw_sms IS NOT NULL AND raw_sms != ''")
      .map((row) => row.raw_sms),
  );

  const ctx = buildClassificationContext(db, memberId);
  const txByDateAmount = new Map();
  for (const row of db.all('SELECT id, date, amount, raw_sms FROM transactions WHERE amount > 0')) {
    const key = `${row.date}:${row.amount}`;
    if (!txByDateAmount.has(key)) txByDateAmount.set(key, []);
    txByDateAmount.get(key).push(row);
  }

  let imported = 0;
  let skipped = 0;
  let unmatched = 0;
  let duplicates = 0;

  // Classify first, write after. Reading a rule for every message inside a write
  // transaction would hold it open for the length of the whole inbox.
  const rows = [];
  const staged = new Set();

  for (const message of messages) {
    const body = message.body ?? '';
    if (seen.has(body)) {
      skipped += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const classified = await parseSmsText(body, message.sender ?? '', message.received_at ?? null, ctx);
    if (classified.matched_rule === 'Default Classifier' || !(classified.amount > 0)) {
      unmatched += 1;
      continue;
    }

    // Two messages for one payment must not become two transactions. This is left for
    // review rather than dropped, because a genuine second purchase of the same amount on
    // the same day looks identical from here and only the user can tell them apart.
    const date = isoFromMillis(message.received_at) || classified.date;
    const stageKey = `${date}:${classified.amount}`;

    if (duplicateOfFast(txByDateAmount, { date, amount: classified.amount, body }) || staged.has(stageKey)) {
      duplicates += 1;
      continue;
    }

    rows.push({ body, classified, receivedAt: message.received_at, sender: message.sender ?? '' });
    seen.add(body);
    staged.add(stageKey);
  }

  db.transaction(() => {
    for (const { body, classified, receivedAt, sender } of rows) {
      const isInvest = classified.type === 'Investment' || classified.category === 'Investment Outflow' ? 1 : 0;
      let accountId = classified.account_id ?? null;
      let cardId = classified.card_id ?? null;
      if (!accountId && !cardId) {
        const resolved = resolveAccountAndCardFromSms(db, body, sender, {
          memberId,
          cachedAccounts: ctx.cachedAccounts,
          cachedCards: ctx.cachedCards,
        });
        accountId = resolved.account_id;
        cardId = resolved.card_id;
      }
      if (accountId) {
        autoUpdateAccountFromSms(db, body, sender, accountId);
      }
      if (cardId) {
        autoUpdateCreditCardFromSms(db, body, sender, cardId);
      }
      db.run(
        'INSERT INTO transactions (member_id, account_id, card_id, date, amount, currency, type, category,'
        + ' merchant, merchant_key, description, is_investment_outflow, raw_sms, created_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          memberId,
          accountId,
          cardId,
          isoFromMillis(receivedAt) || classified.date,
          classified.amount,
          currency,
          classified.type,
          classified.category,
          classified.merchant,
          classified.merchant_key ?? '',
          classified.description || '',
          isInvest,
          body,
          new Date().toISOString(),
        ],
      );
      imported += 1;
    }
  });

  markSynced(db);
  await db.schedulePersist();
  return {
    status: 'success', read: messages.length, imported, skipped, unmatched, duplicates, days,
  };
}

/**
 * Turns one categorisation into a standing rule, and applies it to what is already filed.
 *
 * This is the whole learning loop. Correcting a transaction is not an edit to that row,
 * it is a statement about a vendor, so it is stored against the vendor and every other
 * transaction with the same key is brought into line. The backfill is an indexed update,
 * so it costs the same whether the history holds fifty rows or fifty thousand.
 */
async function learnCategory(db, args) {
  let merchant = String(args.merchant ?? '').trim();
  if (!merchant && args.transaction_id) {
    const row = db.get('SELECT merchant FROM transactions WHERE id = ?', [args.transaction_id]);
    merchant = row ? String(row.merchant ?? '').trim() : '';
  }

  const key = merchantKey(merchant);
  const category = String(args.category ?? '').trim();
  if (!key) {
    return fail('MERCHANT_UNKNOWN', 'This message names no counterparty.',
      'Set the category on the transaction itself; there is nothing to learn from.');
  }
  if (!category) {
    return fail('MERCHANT_CATEGORY_REQUIRED', 'No category was given.', 'Pick a category first.');
  }

  let learned = { merchant_key: key, applied: 0 };
  db.transaction(() => {
    learned = learnMerchant(db, merchant, category, String(args.transaction_type ?? '').trim());
  });

  await db.schedulePersist();
  return {
    status: 'success', merchant_key: learned.merchant_key, category, applied: learned.applied,
  };
}

/**
 * Reads the messages already on the phone and files the ones a rule recognises.
 *
 * Only a message a rule actually matched is filed. The general classifier is good enough
 * to show somebody what a message means, but not good enough to write a transaction
 * nobody asked for, so anything it had to guess at is reported and left alone.
 *
 * A message that has already been filed is skipped, so running this twice does not
 * produce two of everything.
 */
/*
 * How far back a sync has to look.
 *
 * A receiver catches what arrives while the app is closed, so most of the time there is
 * nothing to find. It does not catch everything: the queue holds two hundred, a force
 * stopped app is sent no broadcasts at all until somebody opens it again, and nothing
 * before the permission was granted was ever seen. So a sync covers the stretch since the
 * last one, with a day of overlap because a message that arrived while the last sync was
 * running would otherwise fall between them.
 */
function daysSinceLastSync(db) {
  const row = db.get("SELECT value FROM app_settings WHERE key = 'last_sms_sync'");
  if (!row || !row.value) return 90;
  const then = new Date(row.value);
  if (Number.isNaN(then.getTime())) return 90;
  // At least one whole day, always plus one of overlap. Syncing twice in a minute would
  // otherwise round the elapsed time to nothing and skip the overlap the gap needs.
  const elapsed = Math.max(1, Math.ceil((Date.now() - then.getTime()) / 86400000));
  return Math.min(730, elapsed + 1);
}

/** Where the next sync starts from. */
function markSynced(db) {
  db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('last_sms_sync', ?)",
    [new Date().toISOString()]);
}

async function reimportInbox(db, args) {
  const isAll = args.days === 'all' || args.days === 0 || args.days === '0';
  const days = isAll ? 0 : Number.parseInt(args.days ?? daysSinceLastSync(db), 10);
  const memberId = resolveMemberId(db, args.member_id);
  const currency = currentCurrency(db);
  const messages = readSmsInbox(days);

  if (!messages.length) {
    // Finding nothing still covers the window. Leaving the mark where it was would make
    // every later sync start from the same stale point and grow without end.
    markSynced(db);
    await db.schedulePersist();
    return {
      status: 'success', read: 0, imported: 0, skipped: 0, unmatched: 0, duplicates: 0,
      days,
    };
  }

  const seen = new Set(
    db.all("SELECT raw_sms FROM transactions WHERE raw_sms IS NOT NULL AND raw_sms != ''")
      .map((row) => row.raw_sms),
  );

  const ctx = buildClassificationContext(db, memberId);
  const txByDateAmount = new Map();
  for (const row of db.all('SELECT id, date, amount, raw_sms FROM transactions WHERE amount > 0')) {
    const key = `${row.date}:${row.amount}`;
    if (!txByDateAmount.has(key)) txByDateAmount.set(key, []);
    txByDateAmount.get(key).push(row);
  }

  let imported = 0;
  let skipped = 0;
  let unmatched = 0;
  let duplicates = 0;

  // Classify first, write after. Reading a rule for every message inside a write
  // transaction would hold it open for the length of the whole inbox.
  const rows = [];
  const staged = new Set();

  for (const message of messages) {
    const body = message.body ?? '';
    if (seen.has(body)) {
      skipped += 1;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const classified = await parseSmsText(body, message.sender ?? '', message.received_at ?? null, ctx);
    if (classified.matched_rule === 'Default Classifier' || !(classified.amount > 0)) {
      unmatched += 1;
      continue;
    }

    // Two messages for one payment must not become two transactions. This is left for
    // review rather than dropped, because a genuine second purchase of the same amount on
    // the same day looks identical from here and only the user can tell them apart.
    const date = isoFromMillis(message.received_at) || classified.date;
    const stageKey = `${date}:${classified.amount}`;

    if (duplicateOfFast(txByDateAmount, { date, amount: classified.amount, body }) || staged.has(stageKey)) {
      duplicates += 1;
      continue;
    }

    rows.push({ body, classified, receivedAt: message.received_at, sender: message.sender ?? '' });
    seen.add(body);
    staged.add(stageKey);
  }

  db.transaction(() => {
    for (const { body, classified, receivedAt, sender } of rows) {
      const isInvest = classified.type === 'Investment' || classified.category === 'Investment Outflow' ? 1 : 0;
      let accountId = classified.account_id ?? null;
      let cardId = classified.card_id ?? null;
      if (!accountId && !cardId) {
        const resolved = resolveAccountAndCardFromSms(db, body, sender, {
          memberId,
          cachedAccounts: ctx.cachedAccounts,
          cachedCards: ctx.cachedCards,
        });
        accountId = resolved.account_id;
        cardId = resolved.card_id;
      }
      if (accountId) {
        autoUpdateAccountFromSms(db, body, sender, accountId);
      }
      if (cardId) {
        autoUpdateCreditCardFromSms(db, body, sender, cardId);
      }
      db.run(
        'INSERT INTO transactions (member_id, account_id, card_id, date, amount, currency, type, category,'
        + ' merchant, merchant_key, description, is_investment_outflow, raw_sms, created_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          memberId,
          accountId,
          cardId,
          isoFromMillis(receivedAt) || classified.date,
          classified.amount,
          currency,
          classified.type,
          classified.category,
          classified.merchant,
          classified.merchant_key ?? '',
          classified.description || '',
          isInvest,
          body,
          new Date().toISOString(),
        ],
      );
      imported += 1;
    }
  });

  // Only after the messages are safely filed. A sync that failed halfway must be able to
  // cover the same stretch again rather than skip it.
  markSynced(db);
  await db.schedulePersist();
  return {
    status: 'success', read: messages.length, imported, skipped, unmatched, duplicates, days,
  };
}

/**
 * The alerts an import read but could not file, so somebody can decide what they were.
 *
 * A message ends up here for one of three reasons: no rule recognised the wording, a rule
 * did but found no amount, or a guard read it as a reminder or an advertisement. All
 * three are shown with the reason, because "no rule matched" and "I think this was a
 * reminder" call for different answers from the user, and the second one might be wrong.
 */
/*
 * Is this alert describing money that is already recorded.
 *
 * A bank often says the same thing twice in different words. One payment arrives as
 * "Bill Paid: ... Rs.316.00 paid on 04-Aug" and again as "ALERT:Rs.316.00 spent via ...
 * Debit Card xx3120", and the two share no text at all, so matching on the message body
 * cannot see it. What they share is the money and the day.
 *
 * This deliberately does not decide anything on its own. Two coffees on one afternoon are
 * the same amount on the same day and are both real, so a match is reported and left for
 * somebody to look at rather than dropped.
 */
export function duplicateOf(db, { date, amount, body }) {
  if (!date || !(amount > 0)) return null;
  const incomingUtr = extractUtr(body);
  const rows = db.all(
    `SELECT t.id, t.date, t.amount, t.merchant, t.category, t.type, t.description,
            t.account_id, t.card_id, t.raw_sms,
            COALESCE(a.name, c.card_name) AS instrument_name
     FROM transactions t
     LEFT JOIN asset_accounts a ON t.account_id = a.id
     LEFT JOIN credit_cards c ON t.card_id = c.id
     WHERE t.date = ? AND t.amount = ?
       AND (t.raw_sms IS NULL OR t.raw_sms != ?)
       AND COALESCE(t.is_ignored, 0) = 0 AND COALESCE(t.is_duplicate, 0) = 0`,
    [date, amount, body ?? ''],
  );
  if (!rows.length) return null;

  let match = rows[0];
  let isExactUtr = false;
  if (incomingUtr) {
    const utrMatch = rows.find((r) => {
      const u = extractUtr(r.raw_sms);
      return u && u === incomingUtr;
    });
    if (utrMatch) {
      match = utrMatch;
      isExactUtr = true;
    }
  }

  const matchUtr = extractUtr(match.raw_sms);
  return {
    ...match,
    utr: matchUtr,
    match_reason: isExactUtr ? 'exact-utr' : 'date-amount',
    match_score: isExactUtr ? 100 : (match.merchant ? 85 : 70),
  };
}

export function duplicateOfFast(txByDateAmount, { date, amount, body }) {
  if (!date || !(amount > 0) || !txByDateAmount) return null;
  const list = txByDateAmount.get(`${date}:${amount}`);
  if (!list || !list.length) return null;
  const incomingUtr = extractUtr(body);

  let found = null;
  let isExactUtr = false;

  if (incomingUtr) {
    found = list.find((row) => {
      if (row.raw_sms && row.raw_sms === (body || '')) return false;
      return row.utr && row.utr === incomingUtr;
    });
    if (found) isExactUtr = true;
  }

  if (!found) {
    found = list.find((row) => !row.raw_sms || row.raw_sms !== (body || ''));
  }

  if (!found) return null;

  return {
    ...found,
    match_reason: isExactUtr ? 'exact-utr' : 'date-amount',
    match_score: isExactUtr ? 100 : (found.merchant ? 85 : 70),
  };
}

async function reviewAlerts(db, args) {
  const isAll = args.days === 'all' || args.days === 0 || args.days === '0';
  const days = isAll ? 0 : Number.parseInt(args.days ?? 0, 10);
  const want = String(args.filter ?? 'pending');
  const messages = readSmsInbox(days);
  if (!messages.length) return { status: 'success', items: [], read: 0, counts: {} };

  const ctx = buildClassificationContext(db, args.member_id);

  // One pass over what is already recorded, keyed by the message it came from, so
  // deciding the state of a few hundred alerts does not mean a query each.
  const filed = new Map();
  for (const row of db.all(
    'SELECT id, raw_sms, amount, type, category, merchant, description FROM transactions'
    + " WHERE raw_sms IS NOT NULL AND raw_sms != ''",
  )) {
    if (row.raw_sms) {
      filed.set(row.raw_sms, row);
      filed.set(row.raw_sms.trim(), row);
    }
  }
  const ignoredRows = db.all('SELECT body FROM ignored_alerts');
  const ignored = new Set(ignoredRows.flatMap((row) => (row.body ? [row.body, row.body.trim()] : [])));

  const txByDateAmount = new Map();
  for (const row of db.all(`
    SELECT t.id, t.date, t.amount, t.merchant, t.category, t.type, t.description,
           t.account_id, t.card_id, t.raw_sms,
           COALESCE(a.name, c.card_name) AS instrument_name
    FROM transactions t
    LEFT JOIN asset_accounts a ON t.account_id = a.id
    LEFT JOIN credit_cards c ON t.card_id = c.id
    WHERE t.amount > 0 AND COALESCE(t.is_ignored, 0) = 0 AND COALESCE(t.is_duplicate, 0) = 0
  `)) {
    const key = `${row.date}:${row.amount}`;
    if (!txByDateAmount.has(key)) txByDateAmount.set(key, []);
    txByDateAmount.get(key).push({
      ...row,
      utr: extractUtr(row.raw_sms),
    });
  }

  const items = [];
  const counts = { filed: 0, pending: 0, ignored: 0 };
  const seen = new Set();

  for (const message of messages) {
    const body = message.body ?? '';
    const trimmedBody = body.trim();
    if (!body || seen.has(body) || (trimmedBody && seen.has(trimmedBody))) continue;
    seen.add(body);
    if (trimmedBody) seen.add(trimmedBody);

    const already = filed.get(body) || (trimmedBody ? filed.get(trimmedBody) : null);
    const date = isoFromMillis(message.received_at);

    if (already) {
      counts.filed += 1;
      if (want === 'filed' || want === 'all') {
        items.push({
          state: 'filed',
          transaction_id: already.id,
          body,
          sender: message.sender ?? '',
          date,
          amount: already.amount,
          type: already.type,
          category: already.category,
          merchant: already.merchant || '',
          description: already.description || '',
          reason: '',
        });
      }
      continue;
    }

    if (ignored.has(body) || (trimmedBody && ignored.has(trimmedBody))) {
      counts.ignored += 1;
      if (want === 'all' || want === 'ignored') {
        items.push({
          state: 'ignored', body, sender: message.sender ?? '', date, amount: 0, reason: 'ignored',
        });
      }
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const classified = await parseSmsText(body, message.sender ?? '', message.received_at ?? null, ctx);
    
    // Check if message is ignored by a rule or identified as non-transaction (OTP, promo, reminder, mandate, etc.)
    // or has no financial amount (amount missing/unclear/zero)
    const isIgnored = classified.type === 'Ignore'
      || classified.category === 'Ignore'
      || classified.matched_rule === 'Ignored Merchant Rule'
      || (classified.not_a_transaction && classified.not_a_transaction !== 'card-payment' && classified.not_a_transaction !== 'self-transfer')
      || (!classified.amount || classified.amount <= 0);

    if (isIgnored) {
      counts.ignored += 1;
      if (want === 'ignored' || want === 'all') {
        items.push({
          state: 'ignored',
          body,
          sender: message.sender ?? '',
          date: date || classified.date,
          amount: classified.amount || 0,
          reason: classified.not_a_transaction || (!classified.amount ? 'amount-missing' : 'ignored'),
        });
      }
      continue;
    }

    const wouldFile = !classified.not_a_transaction
      && classified.matched_rule !== 'Default Classifier'
      && classified.amount > 0;

    // Only genuine actionable transaction messages with valid positive amounts land in the pending waiting list
    counts.pending += 1;
    if (want === 'pending' || want === 'all') {
      const fallback = FALLBACK_AMOUNT_RE.exec(body);
      const twin = wouldFile
        ? duplicateOfFast(txByDateAmount, { date: date || classified.date, amount: classified.amount, body })
        : null;
      items.push({
        state: 'pending',
        body,
        sender: message.sender ?? '',
        date: date || classified.date,
        duplicate_of: twin ? twin.id : 0,
        duplicate_twin: twin || null,
        reason: twin ? 'possible-duplicate'
          : (wouldFile ? 'ready'
            : 'no-rule'),
        // What the app would guess if forced, so the common case is one tap not a form.
        amount: classified.amount || (fallback ? toAmount(fallback[1]) : 0),
        merchant: classified.merchant || '',
        merchant_key: classified.merchant_key || '',
        description: classified.description || '',
        suggested_type: classified.type || 'Expense',
        suggested_category: classified.category || '',
        account_id: classified.account_id ?? null,
        card_id: classified.card_id ?? null,
      });
    }
  }

  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    status: 'success', items, read: messages.length, counts,
  };
}

/**
 * Merges an incoming alert into an existing recorded transaction.
 * Updates merchant/category/description/instrument if requested,
 * logs the incoming SMS in ignored_alerts so it is never reimported,
 * and optionally learns the merchant categorization rule.
 */
async function mergeAlert(db, args = {}) {
  let txId = Number(args.transaction_id);
  const body = String(args.body ?? args.raw_sms ?? '').trim();
  const rawBody = String(args.body ?? args.raw_sms ?? '');
  if (!body) return fail('BAD_REQUEST', 'No SMS message was given.');

  if (!txId) {
    const candidate = duplicateOf(db, {
      date: args.date,
      amount: Number(args.amount),
      body: rawBody,
    });
    if (candidate) txId = candidate.id;
  }
  if (!txId) return fail('BAD_REQUEST', 'Existing transaction ID is required.');

  const row = db.get('SELECT * FROM transactions WHERE id = ?', [txId]);
  if (!row) return fail('BAD_REQUEST', 'The target transaction no longer exists.');

  const type = String(args.type || row.type || 'Expense');
  const category = String(args.category || row.category || 'Shopping').trim();
  const merchant = String(args.merchant !== undefined ? args.merchant : (row.merchant || '')).trim();
  const description = String(args.description !== undefined ? args.description : (row.description || '')).trim();
  let accountId = args.account_id !== undefined ? (args.account_id ? Number(args.account_id) : null) : row.account_id;
  let cardId = args.card_id !== undefined ? (args.card_id ? Number(args.card_id) : null) : row.card_id;

  if (!accountId && !cardId && body) {
    const resolved = resolveAccountAndCardFromSms(db, body, args.sender ?? '', { memberId: row.member_id });
    if (resolved.account_id) accountId = resolved.account_id;
    if (resolved.card_id) cardId = resolved.card_id;
  }

  let learned = { merchant_key: '', applied: 0 };
  const isInvest = type === 'Investment' || category === 'Investment Outflow' ? 1 : 0;
  const shouldApplyToAll = args.apply_to_all === true;

  db.transaction(() => {
    db.run(
      'UPDATE transactions SET type = ?, category = ?, merchant = ?, merchant_key = ?,'
      + ' description = ?, account_id = ?, card_id = ?, is_investment_outflow = ?,'
      + ' raw_sms = COALESCE(NULLIF(raw_sms, \'\'), ?) WHERE id = ?',
      [type, category, merchant, merchantKey(merchant), description, accountId, cardId, isInvest, rawBody, txId],
    );
    // Ignore incoming SMS so it is never re-imported (store both raw and trimmed)
    db.run('INSERT OR REPLACE INTO ignored_alerts (body, ignored_at) VALUES (?, ?)',
      [rawBody, new Date().toISOString()]);
    if (body !== rawBody) {
      db.run('INSERT OR REPLACE INTO ignored_alerts (body, ignored_at) VALUES (?, ?)',
        [body, new Date().toISOString()]);
    }

    if (merchant && shouldApplyToAll) {
      learned = learnMerchant(db, merchant, category, type, isInvest === 1);
    }
  });

  await db.schedulePersist();
  return {
    status: 'success',
    transaction_id: txId,
    merchant_key: learned.merchant_key,
    also_categorised: Math.max(0, learned.applied - 1),
  };
}

/**
 * Takes back a transaction that should never have been recorded.
 *
 * A bank often says the same thing twice, once as an alert and once as an update, and the
 * second one is not a second payment. Removing it also remembers the message, otherwise
 * the next import files it all over again.
 */
async function markDuplicate(db, args) {
  const body = String(args.body ?? '');
  if (!body) return fail('BAD_REQUEST', 'No message was given.');

  let removed = 0;
  db.transaction(() => {
    removed = db.all('SELECT id FROM transactions WHERE raw_sms = ?', [body]).length;
    db.run('DELETE FROM transactions WHERE raw_sms = ?', [body]);
    db.run('INSERT OR REPLACE INTO ignored_alerts (body, ignored_at) VALUES (?, ?)',
      [body, new Date().toISOString()]);
    if (args.create_rule && args.merchant) {
      learnMerchant(db, args.merchant, 'Ignore', 'Ignore');
    }
  });

  await db.schedulePersist();
  return { status: 'success', removed };
}

/** Changes what an already filed alert was taken to be, and learns from the correction. */
async function reclassifyAlert(db, args) {
  const id = Number(args.transaction_id);
  const category = String(args.category ?? '').trim();
  const row = id ? db.get('SELECT merchant, description FROM transactions WHERE id = ?', [id]) : null;

  if (!row) return fail('BAD_REQUEST', 'That transaction is no longer here.');
  if (!category) return fail('MERCHANT_CATEGORY_REQUIRED', 'Pick a category first.');

  const type = String(args.type ?? 'Expense');
  const merchant = String(args.merchant ?? row.merchant ?? '').trim();
  const description = args.description !== undefined ? String(args.description).trim() : (row.description || '');
  let learned = { merchant_key: '', applied: 0 };

  const shouldApplyToAll = args.apply_to_all === true;
  db.transaction(() => {
    db.run(
      'UPDATE transactions SET type = ?, category = ?, merchant = ?, merchant_key = ?,'
      + ' description = ?, is_investment_outflow = ? WHERE id = ?',
      [type, category, merchant, merchantKey(merchant), description, type === 'Investment' ? 1 : 0, id],
    );
    if (merchant && shouldApplyToAll) learned = learnMerchant(db, merchant, category, type);
  });

  await db.schedulePersist();
  return {
    status: 'success',
    merchant_key: learned.merchant_key,
    also_categorised: Math.max(0, learned.applied - 1),
  };
}

/**
 * Files one reviewed alert, and learns from it.
 *
 * The transaction is written whatever happens. The rule is only learned when the message
 * named a counterparty, because a rule keyed on nothing would match everything.
 */
async function classifyAlert(db, args) {
  const body = String(args.body ?? '');
  const amount = Number(args.amount);
  const category = String(args.category ?? '').trim();
  const description = String(args.description ?? '').trim();

  if (!body) return fail('BAD_REQUEST', 'No message was given.');
  if (!(amount > 0)) {
    return fail('AMOUNT_INVALID', 'Enter an amount greater than zero.',
      'The app could not read one from this message, so it needs typing in.');
  }
  if (!category) return fail('MERCHANT_CATEGORY_REQUIRED', 'Pick a category first.');

  const type = String(args.type ?? 'Expense');
  const merchant = String(args.merchant ?? '').trim();
  const memberId = resolveMemberId(db, args.member_id);
  const currency = currentCurrency(db);
  // Filing from the review screen is a deliberate act, so a twin is reported rather than
  // refused: only the user knows whether it is the bank repeating itself or a second
  // coffee.
  const twin = duplicateOf(db, { date: args.date || today(), amount, body });
  let learned = { merchant_key: '', applied: 0 };

  let accountId = args.account_id !== undefined && args.account_id !== null ? Number(args.account_id) : null;
  let cardId = args.card_id !== undefined && args.card_id !== null ? Number(args.card_id) : null;
  if (!accountId && !cardId && body) {
    const resolved = resolveAccountAndCardFromSms(db, body, args.sender ?? '', { memberId });
    accountId = resolved.account_id;
    cardId = resolved.card_id;
  }
  if (accountId && body) {
    autoUpdateAccountFromSms(db, body, args.sender ?? '', accountId);
  }
  if (cardId && body) {
    autoUpdateCreditCardFromSms(db, body, args.sender ?? '', cardId);
  }

  const isInvest = type === 'Investment' || category === 'Investment Outflow' ? 1 : 0;
  const shouldApplyToAll = args.apply_to_all !== false && !args.override_single;
  db.transaction(() => {
    db.run(
      'INSERT INTO transactions (member_id, account_id, card_id, date, amount, currency, type, category,'
      + ' merchant, merchant_key, description, is_investment_outflow, raw_sms, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [memberId, accountId, cardId, args.date || today(), amount, currency, type, category, merchant,
        merchantKey(merchant), description, isInvest, body, new Date().toISOString()],
    );
    if (merchant && shouldApplyToAll) learned = learnMerchant(db, merchant, category, type);
  });

  await db.schedulePersist();
  return {
    status: 'success',
    merchant_key: learned.merchant_key,
    duplicate_warning: Boolean(twin),
    // The row just written is part of the count, so what is interesting is the rest.
    also_categorised: Math.max(0, learned.applied - 1),
  };
}

/** Batch files multiple reviewed alerts in a single SQLite transaction. */
async function classifyBatch(db, args) {
  const items = Array.isArray(args.items) ? args.items : [];
  if (!items.length) return { status: 'success', filed: 0 };

  const memberId = resolveMemberId(db, args.member_id);
  const currency = currentCurrency(db);
  const ctx = buildClassificationContext(db, memberId);

  let filed = 0;
  db.transaction(() => {
    for (const item of items) {
      const body = String(item.body ?? '');
      const amount = Number(item.amount);
      const category = String(item.category || item.suggested_category || 'Shopping').trim();
      if (!body || !(amount > 0) || !category) continue;

      const type = String(item.type || item.suggested_type || 'Expense');
      const merchant = String(item.merchant ?? '').trim();
      const isInvest = type === 'Investment' || category === 'Investment Outflow' ? 1 : 0;
      let accountId = item.account_id !== undefined && item.account_id !== null ? Number(item.account_id) : null;
      let cardId = item.card_id !== undefined && item.card_id !== null ? Number(item.card_id) : null;

      if (!accountId && !cardId && body) {
        const resolved = resolveAccountAndCardFromSms(db, body, item.sender ?? '', {
          memberId,
          cachedAccounts: ctx.cachedAccounts,
          cachedCards: ctx.cachedCards,
        });
        accountId = resolved.account_id;
        cardId = resolved.card_id;
      }
      if (accountId && body) {
        autoUpdateAccountFromSms(db, body, item.sender ?? '', accountId);
      }
      if (cardId && body) {
        autoUpdateCreditCardFromSms(db, body, item.sender ?? '', cardId);
      }

      db.run(
        'INSERT INTO transactions (member_id, account_id, card_id, date, amount, currency, type, category,'
        + ' merchant, merchant_key, description, is_investment_outflow, raw_sms, created_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [memberId, accountId, cardId, item.date || today(), amount, currency, type, category, merchant,
          merchantKey(merchant), String(item.description || '').trim(), isInvest, body, new Date().toISOString()],
      );
      if (merchant && item.apply_to_all) {
        learnMerchant(db, merchant, category, type);
      }
      filed += 1;
    }
  });

  await db.schedulePersist();
  return { status: 'success', filed };
}

export async function handleSmsAction(args = {}) {
  try {
    const db = await getDatabase();
    initDb(db);

    if (args.action === 'parse_text') {
      return await parseSmsText(args.sms_text ?? '', args.sender ?? '', args.received_at ?? null);
    }

    if (args.action === 'pending_alerts') {
      // Everything the shell queued while the app was closed, classified now against the
      // rules as they stand rather than as they stood when the message arrived.
      const alerts = [];
      const ignoredRows = db.all('SELECT body FROM ignored_alerts');
      const ignoredSet = new Set(ignoredRows.flatMap((r) => (r.body ? [r.body, r.body.trim()] : [])));

      for (const alert of takePendingAlerts()) {
        const rawBody = alert.body ?? '';
        const trimmed = rawBody.trim();
        if (!rawBody || ignoredSet.has(rawBody) || (trimmed && ignoredSet.has(trimmed))) continue;
        // eslint-disable-next-line no-await-in-loop
        const classified = await parseSmsText(rawBody, alert.sender ?? '', alert.received_at ?? null);
        if (classified.not_a_transaction || !classified.amount || classified.amount <= 0) continue;
        const duplicate = duplicateOf(db, {
          date: classified.date,
          amount: classified.amount,
          body: rawBody,
        });
        alerts.push({
          ...classified,
          raw_sms: rawBody,
          body: rawBody,
          duplicate_of: duplicate ? duplicate.id : 0,
          duplicate_warning: Boolean(duplicate),
          duplicate_twin: duplicate || null,
          source: alert.source,
          received_at: alert.received_at,
        });
      }
      return { status: 'success', alerts };
    }

    if (args.action === 'reimport') {
      return await reimportInbox(db, args);
    }

    if (args.action === 'review' || args.action === 'unclassified') {
      return await reviewAlerts(db, args);
    }

    if (args.action === 'classify_alert') {
      return await classifyAlert(db, args);
    }

    if (args.action === 'classify_batch') {
      return await classifyBatch(db, args);
    }

    if (args.action === 'reclassify_alert') {
      return await reclassifyAlert(db, args);
    }

    if (args.action === 'mark_duplicate') {
      return await markDuplicate(db, args);
    }

    if (args.action === 'merge_alert') {
      return await mergeAlert(db, args);
    }

    if (args.action === 'ignore_alert') {
      db.transaction(() => {
        db.run('INSERT OR REPLACE INTO ignored_alerts (body, ignored_at) VALUES (?, ?)',
          [String(args.body ?? ''), new Date().toISOString()]);
        if (args.create_rule && args.merchant) {
          learnMerchant(db, args.merchant, 'Ignore', 'Ignore');
        }
        if (args.create_sms_rule && (args.body_trigger || args.merchant)) {
          const trigger = String(args.body_trigger || args.merchant).trim();
          db.run(
            "INSERT INTO sms_rules (rule_name, sender_keyword, body_trigger, transaction_type, category_name, is_active)"
            + " VALUES (?, ?, ?, 'Ignore', 'Ignore', 1)",
            [`Ignore: ${trigger}`, String(args.sender_keyword || '').trim(), trigger],
          );
        }
      });
      await db.schedulePersist();
      return { status: 'success' };
    }

    if (args.action === 'ignore_batch') {
      const bodies = Array.isArray(args.bodies) ? args.bodies : [];
      if (bodies.length) {
        db.transaction(() => {
          for (const body of bodies) {
            db.run('INSERT OR REPLACE INTO ignored_alerts (body, ignored_at) VALUES (?, ?)',
              [String(body), new Date().toISOString()]);
          }
        });
        await db.schedulePersist();
      }
      return { status: 'success', ignored: bodies.length };
    }

    if (args.action === 'learn_category') {
      return await learnCategory(db, args);
    }

    if (args.action === 'get_merchant_rules') {
      return {
        status: 'success',
        rules: db.all('SELECT * FROM merchant_rules ORDER BY hits DESC, merchant_key'),
      };
    }

    if (args.action === 'forget_merchant') {
      db.run('DELETE FROM merchant_rules WHERE merchant_key = ?', [args.merchant_key]);
      await db.schedulePersist();
      return { status: 'success' };
    }

    if (args.action === 'get_rules') {
      return { status: 'success', rules: db.all("SELECT * FROM sms_rules ORDER BY CASE WHEN transaction_type = 'Ignore' THEN 0 ELSE 1 END, id DESC") };
    }

    if (args.action === 'add_rule') {
      const rule = args.rule || {};
      db.run(
        'INSERT INTO sms_rules (rule_name, sender_keyword, body_trigger, transaction_type,'
        + ' category_name, regex_pattern) VALUES (?, ?, ?, ?, ?, ?)',
        [rule.rule_name, rule.sender_keyword ?? '', rule.body_trigger,
          rule.transaction_type ?? 'Expense', rule.category_name ?? 'Groceries',
          rule.regex_pattern || DEFAULT_AMOUNT_RE.source],
      );
      await db.schedulePersist();
      return { status: 'success' };
    }

    if (args.action === 'delete_rule') {
      db.run('DELETE FROM sms_rules WHERE id = ?', [args.rule_id]);
      await db.schedulePersist();
      return { status: 'success' };
    }

    return { status: 'error', message: `Unknown SMS action ${args.action}` };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}
