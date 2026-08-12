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
  currentCurrency, getDatabase, initDb, learnMerchant, resolveMemberId,
} from './database.js';
import { readSmsInbox, takePendingAlerts } from './native.js';
import {
  categoryForMerchant, extractMerchant, merchantKey, notATransaction,
} from './merchants.js';
import { fail } from './errors.js';

const DEFAULT_AMOUNT_RE = /(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]+)?)/i;
const FALLBACK_AMOUNT_RE = /(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]+)?)/i;
const ACCOUNT_RE = /(?:a\/c|card|acct|\*+)\s*([0-9]{4})/i;

const DATE_PATTERNS = [
  /\bon\s+(\d{1,2})[-/]([A-Za-z]{3}|\d{1,2})[-/](\d{2,4})\b/i,
  /\b(?:dt\.?|dated)\s+(\d{1,2})[-/]([A-Za-z]{3}|\d{1,2})[-/](\d{2,4})\b/i,
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
  return type === 'Income' ? INCOME_CATEGORIES.has(category) : !INCOME_CATEGORIES.has(category);
}

/** Whether what is known about the vendor may stand as this row's category. */
function usable(known, type) {
  if (!known.category) return false;
  return known.source === 'learned' || categoryFits(known.category, type);
}

function knownCategory(db, key, merchant, text) {
  if (key) {
    const learned = db.get(
      'SELECT category_name, transaction_type FROM merchant_rules WHERE merchant_key = ?', [key],
    );
    if (learned) {
      return { category: learned.category_name, type: learned.transaction_type || '', source: 'learned' };
    }
  }
  const found = categoryForMerchant(merchant, text);
  return { category: found, type: '', source: found ? 'dictionary' : '' };
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
export async function parseSmsText(text, sender = '') {
  const db = await getDatabase();
  initDb(db);

  const rules = db.all("SELECT * FROM sms_rules WHERE is_active = 1 ORDER BY CASE WHEN transaction_type = 'Ignore' THEN 0 ELSE 1 END, id DESC");
  const lower = String(text).toLowerCase();
  const merchant = extractMerchant(text);
  const key = merchantKey(merchant);
  const known = knownCategory(db, key, merchant, text);
  const accountMatch = ACCOUNT_RE.exec(text);
  const senderText = String(sender).toLowerCase();
  const dateFromSms = extractDate(text) || today();
  const descriptionFromSms = extractDescription(text);

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
    const moved = FALLBACK_AMOUNT_RE.exec(text);
    return {
      status: 'classified',
      matched_rule: notMoney === 'card-payment' ? 'Credit card payment' : 'Own transfer',
      amount: moved ? toAmount(moved[1]) : 0,
      type: 'Transfer',
      category: 'Transfer',
      category_source: 'rule',
      merchant,
      merchant_key: key,
      account_last4: accountMatch ? accountMatch[1] : '',
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
      account_last4: accountMatch ? accountMatch[1] : '',
      sender,
      description: descriptionFromSms,
      raw_sms: text,
      date: dateFromSms,
    };
  }

  for (const rule of rules) {
    const trigger = String(rule.body_trigger || '').toLowerCase();
    if (!trigger || !triggerMatches(trigger, lower)) continue;
    // A rule that names a bank belongs to that bank. An empty keyword means the wording
    // is common enough that whoever sent it does not matter.
    const wants = String(rule.sender_keyword || '').toLowerCase();
    if (wants && senderText && !senderText.includes(wants)) continue;

    const match = compile(rule.regex_pattern).exec(text);

    if (rule.transaction_type === 'Ignore') {
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
        account_last4: accountMatch ? accountMatch[1] : '',
        sender,
        description: descriptionFromSms,
        raw_sms: text,
        date: dateFromSms,
      };
    }

    // A rule names the bank's wording. What was actually bought is the vendor's business,
    // so anything known about the vendor outranks the rule's standing guess.
    return {
      status: 'classified',
      matched_rule: rule.rule_name,
      amount: match ? toAmount(match[1]) : 0,
      type: known.type || rule.transaction_type,
      category: usable(known, known.type || rule.transaction_type) ? known.category : rule.category_name,
      category_source: usable(known, known.type || rule.transaction_type) ? known.source : 'rule',
      merchant,
      merchant_key: key,
      account_last4: accountMatch ? accountMatch[1] : '',
      sender,
      description: descriptionFromSms,
      raw_sms: text,
      date: dateFromSms,
    };
  }

  const fallback = FALLBACK_AMOUNT_RE.exec(text);
  const isCredit = lower.includes('credited') || lower.includes('received') || lower.includes('deposited');
  const guess = isCredit ? 'Salary' : 'Shopping';

  return {
    status: 'classified',
    matched_rule: 'Default Classifier',
    amount: fallback ? toAmount(fallback[1]) : 0,
    type: known.type || (isCredit ? 'Income' : 'Expense'),
    category: usable(known, known.type || (isCredit ? 'Income' : 'Expense')) ? known.category : guess,
    category_source: known.source || 'guess',
    merchant,
    merchant_key: key,
    account_last4: accountMatch ? accountMatch[1] : '',
    sender,
    description: descriptionFromSms,
    raw_sms: text,
    date: dateFromSms,
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
    const classified = await parseSmsText(body, message.sender ?? '');
    if (classified.matched_rule === 'Default Classifier' || !(classified.amount > 0)) {
      unmatched += 1;
      continue;
    }

    // Two messages for one payment must not become two transactions. This is left for
    // review rather than dropped, because a genuine second purchase of the same amount on
    // the same day looks identical from here and only the user can tell them apart.
    const date = isoFromMillis(message.received_at) || classified.date;
    const stageKey = `${date}:${classified.amount}`;

    if (duplicateOf(db, { date, amount: classified.amount, body }) || staged.has(stageKey)) {
      duplicates += 1;
      continue;
    }

    rows.push({ body, classified, receivedAt: message.received_at });
    seen.add(body);
    staged.add(stageKey);
  }

  db.transaction(() => {
    for (const { body, classified, receivedAt } of rows) {
      db.run(
        'INSERT INTO transactions (member_id, date, amount, currency, type, category,'
        + ' merchant, merchant_key, description, is_investment_outflow, raw_sms, created_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
        [
          memberId,
          isoFromMillis(receivedAt) || classified.date,
          classified.amount,
          currency,
          classified.type,
          classified.category,
          classified.merchant,
          classified.merchant_key ?? '',
          classified.description || '',
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

function isoFromMillis(millis) {
  if (!millis) return null;
  const date = new Date(Number(millis));
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
function duplicateOf(db, { date, amount, body }) {
  if (!date || !(amount > 0)) return null;
  const match = db.get(
    'SELECT id, merchant, category FROM transactions WHERE date = ? AND amount = ?'
    + ' AND (raw_sms IS NULL OR raw_sms != ?) LIMIT 1',
    [date, amount, body ?? ''],
  );
  return match || null;
}

async function reviewAlerts(db, args) {
  const isAll = args.days === 'all' || args.days === 0 || args.days === '0';
  const days = isAll ? 0 : Number.parseInt(args.days ?? 0, 10);
  const want = String(args.filter ?? 'pending');
  const messages = readSmsInbox(days);
  if (!messages.length) return { status: 'success', items: [], read: 0, counts: {} };

  // One pass over what is already recorded, keyed by the message it came from, so
  // deciding the state of a few hundred alerts does not mean a query each.
  const filed = new Map();
  for (const row of db.all(
    'SELECT id, raw_sms, amount, type, category, merchant, description FROM transactions'
    + " WHERE raw_sms IS NOT NULL AND raw_sms != ''",
  )) {
    if (!filed.has(row.raw_sms)) filed.set(row.raw_sms, row);
  }
  const ignored = new Set(db.all('SELECT body FROM ignored_alerts').map((row) => row.body));

  const items = [];
  const counts = { filed: 0, pending: 0, ignored: 0 };
  const seen = new Set();

  for (const message of messages) {
    const body = message.body ?? '';
    if (!body || seen.has(body)) continue;
    seen.add(body);

    const already = filed.get(body);
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

    if (ignored.has(body)) {
      counts.ignored += 1;
      if (want === 'all') {
        items.push({
          state: 'ignored', body, sender: message.sender ?? '', date, amount: 0, reason: 'ignored',
        });
      }
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const classified = await parseSmsText(body, message.sender ?? '');
    const wouldFile = !classified.not_a_transaction
      && classified.matched_rule !== 'Default Classifier'
      && classified.amount > 0;

    // Something a rule handles but that was never imported still counts as waiting:
    // the user has not run an import, or ran one before the rule existed.
    counts.pending += 1;
    if (want === 'pending' || want === 'all') {
      const fallback = FALLBACK_AMOUNT_RE.exec(body);
      const twin = wouldFile
        ? duplicateOf(db, { date: date || classified.date, amount: classified.amount, body })
        : null;
      items.push({
        state: 'pending',
        body,
        sender: message.sender ?? '',
        date: date || classified.date,
        duplicate_of: twin ? twin.id : 0,
        reason: twin ? 'possible-duplicate'
          : (wouldFile ? 'ready'
            : classified.not_a_transaction || (classified.amount > 0 ? 'no-rule' : 'no-amount')),
        // What the app would guess if forced, so the common case is one tap not a form.
        amount: classified.amount || (fallback ? toAmount(fallback[1]) : 0),
        merchant: classified.merchant || '',
        merchant_key: classified.merchant_key || '',
        description: classified.description || '',
        suggested_type: classified.type || 'Expense',
        suggested_category: classified.category || '',
      });
    }
  }

  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    status: 'success', items, read: messages.length, counts,
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

  db.transaction(() => {
    db.run(
      'UPDATE transactions SET type = ?, category = ?, merchant = ?, merchant_key = ?,'
      + ' description = ?, is_investment_outflow = ? WHERE id = ?',
      [type, category, merchant, merchantKey(merchant), description, type === 'Investment' ? 1 : 0, id],
    );
    if (merchant) learned = learnMerchant(db, merchant, category, type);
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

  db.transaction(() => {
    db.run(
      'INSERT INTO transactions (member_id, date, amount, currency, type, category,'
      + ' merchant, merchant_key, description, is_investment_outflow, raw_sms, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
      [memberId, args.date || today(), amount, currency, type, category, merchant,
        merchantKey(merchant), description, body, new Date().toISOString()],
    );
    if (merchant) learned = learnMerchant(db, merchant, category, type);
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

export async function handleSmsAction(args = {}) {
  try {
    const db = await getDatabase();
    initDb(db);

    if (args.action === 'parse_text') {
      return await parseSmsText(args.sms_text ?? '', args.sender ?? '');
    }

    if (args.action === 'pending_alerts') {
      // Everything the shell queued while the app was closed, classified now against the
      // rules as they stand rather than as they stood when the message arrived.
      const alerts = [];
      for (const alert of takePendingAlerts()) {
        // eslint-disable-next-line no-await-in-loop
        const classified = await parseSmsText(alert.body ?? '', alert.sender ?? '');
        if (classified.not_a_transaction) continue;
        alerts.push({ ...classified, source: alert.source, received_at: alert.received_at });
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

    if (args.action === 'reclassify_alert') {
      return await reclassifyAlert(db, args);
    }

    if (args.action === 'mark_duplicate') {
      return await markDuplicate(db, args);
    }

    if (args.action === 'ignore_alert') {
      db.run('INSERT OR REPLACE INTO ignored_alerts (body, ignored_at) VALUES (?, ?)',
        [String(args.body ?? ''), new Date().toISOString()]);
      await db.schedulePersist();
      return { status: 'success' };
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
