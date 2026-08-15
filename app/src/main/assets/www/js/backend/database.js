/*
 * The schema, the migrations, and every action the UI can reach.
 *
 * One action surface, one shape of reply: `{status: "success", ...}` or an error built by
 * `fail`, whose code is stable across any rewording of the message. The SQL is the same
 * SQL the Python layer ran, against the same file, because the file format never changed:
 * an install from before this rewrite opens exactly as it is.
 */

import { fail } from './errors.js';
import { BackupDecryptError, decryptData, encryptData, hashPin, pinMatches } from './crypto.js';
import { Database } from './sqlite.js';
import { deleteDatabase, deleteVaultKey, writeAttempts } from './native.js';
import { merchantKey } from './merchants.js';
import { classifyAsset } from './asset-class.js';
import {
  changeVaultPin, createVault, failedAttempts, isUnlocked, lockVault, mirrorConfig,
  restoreMirroredConfig, unlockVault, vaultExists,
} from './vault.js';
/*
 * The date and bucket arithmetic, and the aggregates built on it.
 *
 * Split out rather than grown here: what a week is, and where a month starts, has to be
 * the same answer for a chart, a drilldown and a recurring-payment scan, and three copies
 * of that arithmetic is three chances for them to disagree. This file stays the schema, the
 * CRUD and the front door.
 */
import {
  memberClause, monthBounds, monthKeys, number, pad, today,
} from './periods.js';
import {
  breakdownDimensions, getBreakdown, getPeriodSummary, getSeries, getSpendingAnomalies, seriesMetrics,
} from './analytics.js';
import {
  applyPriceChange, dismissRecurring, findRecurring, getPriceHistory, projectCommitments,
  steppedAmount, trackRecurring,
} from './recurring.js';
import {
  calculateSafeToSpend, getCashflowRunway, getSalaryChecklist, getWeekendVsWeekdayAnalysis,
} from './cashflow.js';
import {
  calculateDirectVsRegularDrag, calculateFdLadder, calculatePortfolioRebalance,
  calculatePassiveYield, calculateRealReturn, calculateSgbSchedule, calculateTaxHarvesting,
} from './wealth_intel.js';
import {
  calculateDebtPayoffRoadmap, calculateDtiRatio, calculateHomeLoanPartPayment, getCreditCardOptimizer,
} from './debt_planner.js';
import {
  calculateLifeGoals, calculateNoSpendDays, evaluateChallenge, generateLocalSyncPayload,
  getMonthlyFinanceWrapped,
} from './goals_habits.js';

/** Settings that must never be handed to the UI. */
const PRIVATE_SETTINGS = new Set(['pin_hash', 'pin_code']);

/**
 * Icons are Material Symbols names. Anything added here has to exist in the subsetted
 * font as well, see tools/subset-material-symbols.py.
 */
const DEFAULT_CATEGORIES = [
  ['Groceries', 'Expense', '#10B981', 'shopping_cart'],
  ['Dining', 'Expense', '#F59E0B', 'restaurant'],
  ['Utilities', 'Expense', '#3B82F6', 'bolt'],
  ['Rent & Housing', 'Expense', '#EC4899', 'home'],
  ['Transport & Fuel', 'Expense', '#8B5CF6', 'directions_car'],
  ['Health', 'Expense', '#EF4444', 'medical_services'],
  ['Shopping', 'Expense', '#6366F1', 'shopping_bag'],
  ['Entertainment', 'Expense', '#14B8A6', 'movie'],
  ['Education', 'Expense', '#F97316', 'school'],
  ['Personal Care', 'Expense', '#D946EF', 'spa'],
  ['Travel', 'Expense', '#06B6D4', 'flight'],
  ['Gifts & Donations', 'Expense', '#FB7185', 'redeem'],
  ['Insurance & Tax', 'Expense', '#64748B', 'shield'],
  ['Loans & EMI', 'Expense', '#A16207', 'account_balance'],
  ['Investment Outflow', 'Investment', '#059669', 'trending_up'],
  ['Salary', 'Income', '#10B981', 'work'],
  ['Freelance', 'Income', '#3B82F6', 'computer'],
  ['Interest & Dividends', 'Income', '#F59E0B', 'savings'],
  ['Refunds & Cashback', 'Income', '#8B5CF6', 'receipt_long'],
  /* Money moving between the household's own pockets: a credit card bill paid from a
     bank account, a transfer between two accounts. It is neither earned nor spent, and
     every total that adds up income or expenditure leaves it out. */
  ['Transfer', 'Transfer', '#78909C', 'arrow_forward'],
];

/*
 * The amount in a bank alert.
 *
 * "Rs" alone missed every issuer that writes INR, which is most of them once a card is
 * involved: an AU Bank or DCB alert states INR and the old pattern read zero from it.
 */
const AMOUNT_PATTERN = '(?:Rs|INR|₹)\\.?\\s*([\\d,]+(?:\\.\\d{1,2})?)';
const LEGACY_AMOUNT_PATTERN = 'Rs\\.?\\s*([\\d,]+\\.?\\d*)';

// Bumped when DEFAULT_SMS_RULES gains entries an existing install should also get.
const SMS_RULES_SEED_VERSION = '3';

/*
 * The wordings a bank uses, most specific first, because the first rule whose trigger
 * appears in the body wins.
 *
 * A rule is only about the shape of the sentence: what was bought is the vendor's
 * business and is decided by merchants.js, so the category here is the fallback for when
 * nothing is known about the counterparty. A sender keyword narrows a rule to one bank;
 * an empty one means the wording is common enough not to care.
 *
 * Nothing here needs to recognise a reminder or a one time password. Those never reach
 * the rules: sms.js rejects them first, which is what stops "will be debited" from being
 * filed as money that has already gone.
 */
const DEFAULT_SMS_RULES = [
  // Wordings that say outright what kind of spending they are.
  // The credit has to come before the spend wordings: both mention a meal wallet, and an
  // employer topping the card up is money arriving, not another lunch.
  ['Meal voucher credit', '', 'towards meal wallet', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Meal wallet spend', '', 'spent from pluxee meal wallet', 'Expense', 'Dining', AMOUNT_PATTERN],
  ['Meal card spend', '', 'meal wallet', 'Expense', 'Dining', AMOUNT_PATTERN],
  ['Toll paid', '', 'toll paid', 'Expense', 'Transport & Fuel', AMOUNT_PATTERN],
  ['Bill paid', '', 'bill paid', 'Expense', 'Utilities', AMOUNT_PATTERN],
  ['SmartPay bill', '', 'via smartpay', 'Expense', 'Utilities', AMOUNT_PATTERN],
  ['Tax challan', '', 'challan', 'Expense', 'Insurance & Tax', AMOUNT_PATTERN],
  ['Fund purchase', '', 'in scheme', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['Fund purchase folio', '', 'in folio', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['Mandate debit', '', 'ach d-', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['EMI debit', '', 'emi', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],

  // Card spends. The wording is "Spent Rs.220 On HDFC Bank Card", with the amount sitting
  // between the verb and the preposition, so a trigger of "spent on" is a phrase that
  // never actually occurs. The verb on its own is the trigger, and word boundaries are
  // what make that safe.
  ['POS purchase', '', 'pos transaction', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Card spend', '', 'spent', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Card transaction', '', 'transaction of', 'Expense', 'Shopping', AMOUNT_PATTERN],

  // Money leaving an account.
  ['UPI sent', '', 'sent rs', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['UPI sent INR', '', 'sent inr', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Account debit', '', 'debited from', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Account debit to', '', 'debited', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Payment deducted', '', 'deducted from', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Cash withdrawal', '', 'withdrawn', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Transfer out', '', 'transferred to', 'Expense', 'Shopping', AMOUNT_PATTERN],

  // Money arriving. A card bill paid off and a wallet topped up also read as a credit,
  // and both are rejected before this point, so nothing here double counts them.
  ['Salary deposit', '', 'deposited in', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Account credit', '', 'credited to', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Account credit with', '', 'credited with', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Account credit by', '', 'credited by', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Credit alert', '', 'credit alert', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Money received', '', 'received rs', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Refund', '', 'refunded', 'Income', 'Refunds & Cashback', AMOUNT_PATTERN],
  ['Interest paid', '', 'interest credited', 'Income', 'Interest & Dividends', AMOUNT_PATTERN],

  /*
   * The bare verbs, last.
   *
   * A rule earlier in this list wins, so these only see a wording none of the shapes above
   * recognised. They exist because a bank does not always follow its verb with the word
   * the specific rules key on: "INR 1,96,563.00 deposited in HDFC Bank" matches "deposited
   * in", and the same bank's "INR 12,000 deposited" matches nothing at all and a salary
   * goes unrecorded. Word boundaries are what make a bare verb safe as a trigger.
   */
  ['Deposit', '', 'deposited', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Credit', '', 'credited', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Debit', '', 'debited', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Deduction', '', 'deducted', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Payment', '', 'paid', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Withdrawal', '', 'withdrawn', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Purchase', '', 'purchased', 'Expense', 'Shopping', AMOUNT_PATTERN],
];

const DEFAULT_SETTINGS = {
  locale: 'en-IN',
  currency: 'INR',
  theme: 'system',
  exclude_investments_from_expenses: '1',
  last_cas_upload_date: '',
  family_features_enabled: '0',
  setup_complete: '0',
  monthly_budget: '0',
  appearance: 'system',
  accent: 'jade',
  // Off by default. Somebody who wants the figures hidden knows it; somebody who opened a
  // finance app to see figures should see them.
  mask_amounts: '0',
  // Which dashboard panels Home shows, in order. Empty means the built-in default.
  home_widgets: '',
};

/**
 * The tables the backup writer and reader may touch. Anything outside this list coming
 * from a backup file is ignored, so a crafted file cannot name arbitrary tables.
 *
 * The order is topological: a table only references tables above it. Insert in this order
 * and delete in reverse, and the foreign keys hold at every statement.
 */
const BACKUP_TABLES = [
  'family_members', 'asset_accounts', 'transactions', 'transaction_splits',
  'transaction_cashbacks', 'mf_folios', 'folio_transactions', 'demat_holdings',
  'nps_holdings', 'loans',
  'credit_cards', 'subscriptions', 'sips', 'goals', 'custom_events', 'custom_categories',
  // What the household taught the app about who it pays, and which alerts it decided to
  // ignore. Both are things the user built up rather than anything derived, so they
  // belong in an export, and a reset that left them behind would not be a reset.
  'sms_rules', 'merchant_rules', 'ignored_alerts', 'imported_statements',
  // What a plan has cost over the years, and the suggestions the user turned down. Both
  // describe records above them, and both are things only this household knows.
  'price_changes', 'recurring_dismissed', 'app_settings',
];

/**
 * The uniform record surface: what the UI asks for, which table it lives in, which
 * columns may be written, and the default order.
 */
const RECORD_TYPES = {
  account: ['asset_accounts',
    ['member_id', 'name', 'category', 'institution', 'account_number', 'balance',
      'currency', 'interest_rate', 'maturity_date', 'notes'],
    'category, name'],
  loan: ['loans',
    ['member_id', 'name', 'direction', 'loan_type', 'principal_amount',
      'current_outstanding', 'interest_rate', 'tenure_months', 'start_date',
      'monthly_emi', 'notes'],
    'name'],
  card: ['credit_cards',
    ['member_id', 'card_name', 'bank', 'last_4', 'total_limit', 'current_balance',
      'due_date', 'notes'],
    'card_name'],
  subscription: ['subscriptions',
    ['member_id', 'name', 'cost', 'currency', 'billing_cycle', 'next_billing_date',
      'category', 'auto_debit', 'annual_change_percent', 'price_since',
      'linked_merchant_key'],
    'next_billing_date'],
  sip: ['sips',
    ['member_id', 'scheme_name', 'monthly_amount', 'debit_day', 'step_up_percent',
      'is_active', 'start_date', 'step_up_month', 'linked_merchant_key'],
    'debit_day'],
  goal: ['goals',
    ['member_id', 'title', 'target_amount', 'current_amount', 'target_date',
      'category', 'notes'],
    'target_date'],
  event: ['custom_events',
    ['member_id', 'title', 'event_date', 'event_type', 'notes', 'reminder_days_before'],
    'event_date'],
  mf_folio: ['mf_folios',
    ['member_id', 'folio_number', 'amc', 'scheme_name', 'isin', 'units', 'nav',
      'current_value', 'invested_value', 'last_updated', 'source', 'scope'],
    'scheme_name'],
  demat_holding: ['demat_holdings',
    ['member_id', 'account_type', 'broker', 'dp_id', 'client_id', 'kind', 'isin',
      'name', 'symbol', 'exchange', 'quantity', 'price', 'current_value',
      'invested_value', 'last_updated'],
    'symbol'],
};

const RECORD_TYPE_ALIASES = {
  asset_accounts: 'account',
  accounts: 'account',
  account: 'account',
  loans: 'loan',
  loan: 'loan',
  credit_cards: 'card',
  cards: 'card',
  card: 'card',
  subscriptions: 'subscription',
  recurring_items: 'subscription',
  subscription: 'subscription',
  sips: 'sip',
  sip: 'sip',
  goals: 'goal',
  goal: 'goal',
  custom_events: 'event',
  events: 'event',
  event: 'event',
  mf_folios: 'mf_folio',
  folios: 'mf_folio',
  mf_folio: 'mf_folio',
  demat_holdings: 'demat_holding',
  demat_holding: 'demat_holding',
  demat: 'demat_holding',
  holding: 'demat_holding',
  holdings: 'demat_holding',
};

let database = null;
let schemaReady = false;

/** The open database, opening it on first use. */
export async function getDatabase() {
  if (!database) database = await Database.openStored();
  return database;
}

/** Points the backend at a database of your own. Used by the tests. */
export function useDatabase(instance) {
  database = instance;
  schemaReady = false;
}

export function currentDatabase() {
  return database;
}

/* ------------------------------------------------------------------- schema */

/** Whether a table has been created yet. */
function tableExists(db, name) {
  return Boolean(db.get(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", [name],
  ));
}

export function initDb(db, force = false) {
  if (schemaReady && !force) return;

  /*
   * Whether this database has ever been used, asked before anything is created.
   *
   * It is the one moment the question can be answered: a line further down and the schema
   * exists, the defaults are seeded, and a database that has just been made is
   * indistinguishable from one that has been in use for a year. The answer decides whether
   * the mirrored rules go back in, which is what a reset after a forgotten PIN comes back
   * with.
   */
  const wasEmpty = !tableExists(db, 'app_settings');

  db.exec(`
    CREATE TABLE IF NOT EXISTS family_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        relationship TEXT NOT NULL,
        avatar_color TEXT DEFAULT '#10B981',
        is_primary INTEGER DEFAULT 0,
        notes TEXT,
        created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS asset_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        institution TEXT,
        account_number TEXT,
        balance REAL DEFAULT 0.0,
        currency TEXT DEFAULT 'INR',
        interest_rate REAL DEFAULT 0.0,
        maturity_date TEXT,
        notes TEXT,
        updated_at TEXT,
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        account_id INTEGER,
        date TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'INR',
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        merchant TEXT,
        description TEXT,
        is_investment_outflow INTEGER DEFAULT 0,
        raw_sms TEXT,
        created_at TEXT,
        FOREIGN KEY (member_id) REFERENCES family_members(id),
        FOREIGN KEY (account_id) REFERENCES asset_accounts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_member ON transactions(member_id);

    CREATE TABLE IF NOT EXISTS transaction_splits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER NOT NULL,
        person_name TEXT NOT NULL,
        share_amount REAL NOT NULL,
        is_paid INTEGER DEFAULT 0,
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transaction_cashbacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER NOT NULL,
        source_name TEXT NOT NULL,
        cashback_amount REAL NOT NULL,
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mf_folios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        folio_number TEXT,
        amc TEXT,
        scheme_name TEXT NOT NULL,
        isin TEXT,
        units REAL DEFAULT 0.0,
        nav REAL DEFAULT 0.0,
        current_value REAL DEFAULT 0.0,
        invested_value REAL DEFAULT 0.0,
        last_updated TEXT,
        /* Where the units sit: 'registrar' for a folio serviced by CAMS or KFintech,
           'amc-folio' for the same kind of holding as a depository reports it, and
           'depository' for units held in demat. The three are not interchangeable: the
           first two describe the same money and the third is separate. */
        source TEXT DEFAULT '',
        /* The place a statement is a snapshot of: one bucket for everything held with an
           AMC however it was reported, and one per demat account. An import replaces the
           scopes it covered, which is how a fund that was sold stops being listed. */
        scope TEXT DEFAULT '',
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );
    /* Keyed on the ISIN as well as the folio and the name, because neither of the other
       two identifies a holding on their own. A depository masks the folio and prints the
       fund house where a registrar prints the scheme, so every scheme a household holds
       with one AMC arrives as the same folio and the same name. Keyed on those two alone,
       each one overwrote the last and a real statement lost five holdings out of
       eighteen. The ISIN is the only thing on the line that is actually the scheme. */
    CREATE UNIQUE INDEX IF NOT EXISTS idx_folio_scheme_isin
        ON mf_folios(folio_number, scheme_name, isin);

    /* Every purchase, redemption and dividend a detailed registrar statement carries.
       A summary statement has none of this: it says what is held today and nothing about
       how it got there. The detailed one is what makes a real cost, a holding period and
       a history possible, which is why the guide explains how to ask for it. */
    CREATE TABLE IF NOT EXISTS folio_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        folio_number TEXT,
        isin TEXT,
        scheme_name TEXT,
        date TEXT NOT NULL,
        description TEXT,
        kind TEXT,
        amount REAL DEFAULT 0.0,
        units REAL DEFAULT 0.0,
        nav REAL DEFAULT 0.0,
        balance REAL DEFAULT 0.0,
        last_updated TEXT,
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );
    /* One line of a statement is one row however many times the file is read. The date,
       the amount and the units together are what make a line distinct: a folio can carry
       two instalments of the same size in one month, on different days. */
    CREATE UNIQUE INDEX IF NOT EXISTS idx_folio_txn
        ON folio_transactions(folio_number, isin, date, amount, units);
    CREATE INDEX IF NOT EXISTS idx_folio_txn_isin ON folio_transactions(isin, date DESC);

    CREATE TABLE IF NOT EXISTS loans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        name TEXT NOT NULL,
        loan_type TEXT NOT NULL,
        principal_amount REAL NOT NULL,
        current_outstanding REAL NOT NULL,
        interest_rate REAL NOT NULL,
        tenure_months INTEGER NOT NULL,
        start_date TEXT NOT NULL,
        monthly_emi REAL NOT NULL,
        notes TEXT,
        /* Money borrowed is a liability; money lent is an asset that happens to be
           repaid the same way. Both are the same arithmetic, so both live here rather
           than in a second table that would duplicate every field. */
        direction TEXT DEFAULT 'borrowed',
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );

    CREATE TABLE IF NOT EXISTS credit_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        card_name TEXT NOT NULL,
        bank TEXT NOT NULL,
        last_4 TEXT,
        total_limit REAL NOT NULL,
        current_balance REAL DEFAULT 0.0,
        due_date INTEGER DEFAULT 1,
        notes TEXT,
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        name TEXT NOT NULL,
        cost REAL NOT NULL,
        currency TEXT DEFAULT 'INR',
        billing_cycle TEXT DEFAULT 'Monthly',
        next_billing_date TEXT NOT NULL,
        category TEXT DEFAULT 'Entertainment',
        auto_debit INTEGER DEFAULT 1,
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );

    CREATE TABLE IF NOT EXISTS sips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        scheme_name TEXT NOT NULL,
        monthly_amount REAL NOT NULL,
        debit_day INTEGER NOT NULL,
        step_up_percent REAL DEFAULT 0.0,
        is_active INTEGER DEFAULT 1,
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );

    CREATE TABLE IF NOT EXISTS goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        title TEXT NOT NULL,
        target_amount REAL NOT NULL,
        current_amount REAL DEFAULT 0.0,
        target_date TEXT NOT NULL,
        category TEXT DEFAULT 'General',
        notes TEXT,
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );

    CREATE TABLE IF NOT EXISTS custom_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        title TEXT NOT NULL,
        event_date TEXT NOT NULL,
        event_type TEXT DEFAULT 'Financial',
        notes TEXT,
        reminder_days_before INTEGER DEFAULT 3,
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );

    /* What a commitment has cost, and when that changed.
       A price is overwritten on the record so every screen shows what is being debited
       now, and appended here so nothing is lost by that. Two rows on one plan are what
       let the app say a streaming subscription has risen twice in eighteen months, and
       what an inflation projection is fitted to. The kind is 'sip' or 'subscription'. */
    CREATE TABLE IF NOT EXISTS price_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        record_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        from_amount REAL DEFAULT 0.0,
        to_amount REAL DEFAULT 0.0,
        source TEXT DEFAULT 'user',
        note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_price_changes ON price_changes(kind, record_id, date);

    /* Vendors the user has been offered as a recurring payment and does not want tracked.
       The scan runs over the whole history every time it is opened, so without this it
       would offer the same rejected suggestion for as long as the transactions exist. */
    CREATE TABLE IF NOT EXISTS recurring_dismissed (
        merchant_key TEXT PRIMARY KEY,
        kind TEXT,
        dismissed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS custom_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        color TEXT DEFAULT '#10B981',
        icon TEXT DEFAULT 'sell',
        monthly_budget REAL DEFAULT 0.0
    );

    CREATE TABLE IF NOT EXISTS sms_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_name TEXT NOT NULL,
        sender_keyword TEXT,
        body_trigger TEXT NOT NULL,
        transaction_type TEXT NOT NULL,
        category_name TEXT DEFAULT 'Groceries',
        regex_pattern TEXT,
        is_active INTEGER DEFAULT 1
    );

    /* What this household has taught the app about who it pays.
       The shipped dictionary in merchants.js knows the chains everybody uses. This knows
       that the mandate printed as INDIAN CLEARING CORP LTD is a monthly SIP, which is
       true here and nowhere else, which is exactly why it is a row and not code. The key
       is the primary key, so recognising a repeat is an index seek. */
    CREATE TABLE IF NOT EXISTS merchant_rules (
        merchant_key TEXT PRIMARY KEY,
        category_name TEXT NOT NULL,
        transaction_type TEXT DEFAULT 'Expense',
        display_name TEXT,
        source TEXT DEFAULT 'user',
        hits INTEGER DEFAULT 0,
        updated_at TEXT
    );

    /* Alerts the user looked at and decided were not worth filing. Without this the
       review list hands back the same message every time it is opened, and dismissing
       something has no meaning. */
    /* Statements already read, by a hash of the file. Re-importing one is harmless now
       that a statement replaces the places it covers, but somebody who uploads the same
       file twice deserves to be told rather than left guessing. */
    CREATE TABLE IF NOT EXISTS imported_statements (
        digest TEXT PRIMARY KEY,
        issuer TEXT,
        period_to TEXT,
        imported_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ignored_alerts (
        body TEXT PRIMARY KEY,
        ignored_at TEXT
    );

    CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    /* Demat holdings, from a depository statement: shares, exchange-traded funds and
       bonds, which a registrar statement cannot see at all. */
    CREATE TABLE IF NOT EXISTS demat_holdings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        account_type TEXT,
        broker TEXT,
        dp_id TEXT,
        client_id TEXT,
        kind TEXT NOT NULL,
        isin TEXT NOT NULL,
        name TEXT,
        symbol TEXT,
        exchange TEXT,
        quantity REAL DEFAULT 0.0,
        price REAL DEFAULT 0.0,
        current_value REAL DEFAULT 0.0,
        last_updated TEXT,
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_demat_holding
        ON demat_holdings(dp_id, client_id, isin, kind);

    /* National Pension System holdings, which the same statement carries. */
    CREATE TABLE IF NOT EXISTS nps_holdings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        pran TEXT,
        scheme TEXT NOT NULL,
        fund_manager TEXT,
        tier TEXT,
        asset_class TEXT,
        units REAL DEFAULT 0.0,
        nav REAL DEFAULT 0.0,
        current_value REAL DEFAULT 0.0,
        last_updated TEXT,
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nps_scheme ON nps_holdings(pran, scheme);
  `);

  if (Number(db.value('SELECT COUNT(*) FROM family_members')) === 0) {
    db.run(
      "INSERT INTO family_members (name, relationship, avatar_color, is_primary, created_at)"
      + " VALUES ('You', 'Self', '#0E6B5A', 1, ?)",
      [today()],
    );
  }

  migrate(db);

  if (Number(db.value('SELECT COUNT(*) FROM custom_categories')) === 0) {
    for (const row of DEFAULT_CATEGORIES) {
      db.run(
        'INSERT OR IGNORE INTO custom_categories (name, type, color, icon) VALUES (?, ?, ?, ?)',
        row,
      );
    }
  }

  /*
   * The rules coming back after a reset.
   *
   * Done before the seeding below, so a rule the user wrote or renamed wins and the seeder
   * only fills what is genuinely missing. Only on a database that has never been used:
   * anywhere else this would quietly reinstate rules somebody deliberately deleted.
   */
  if (wasEmpty) restoreMirroredConfig(db);

  /*
   * Seeding the wordings, on a new install and on an upgrade alike.
   *
   * A fresh database has none of them and gets all of them. An install from an earlier
   * build already has its six, and only gains the ones it is missing by name. The version
   * stamp means that happens once: delete a rule you do not want and it stays deleted.
   */
  const seeded = db.get("SELECT value FROM app_settings WHERE key = 'sms_rules_seed'");
  if (!seeded || seeded.value !== SMS_RULES_SEED_VERSION) {
    const known = new Set(db.all('SELECT rule_name FROM sms_rules').map((row) => row.rule_name));
    for (const row of DEFAULT_SMS_RULES) {
      if (known.has(row[0])) continue;
      db.run(
        'INSERT INTO sms_rules (rule_name, sender_keyword, body_trigger, transaction_type,'
        + ' category_name, regex_pattern) VALUES (?, ?, ?, ?, ?, ?)',
        row,
      );
    }
    // The rules an earlier build wrote read Rs and nothing else, so every alert that
    // states INR gave them an amount of zero. Only a pattern still untouched by the user
    // is replaced.
    db.run('UPDATE sms_rules SET regex_pattern = ? WHERE regex_pattern = ?',
      [AMOUNT_PATTERN, LEGACY_AMOUNT_PATTERN]);
    db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('sms_rules_seed', ?)",
      [SMS_RULES_SEED_VERSION]);
  }

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', [key, value]);
  }

  schemaReady = true;
}

/** Additive migrations, so an install from an older build keeps its data. */
function migrate(db) {
  const memberTables = ['asset_accounts', 'transactions', 'mf_folios', 'loans', 'credit_cards',
    'subscriptions', 'sips', 'goals', 'custom_events'];
  for (const table of memberTables) {
    addColumnIfMissing(db, table, 'member_id', 'INTEGER DEFAULT 1');
  }
  addColumnIfMissing(db, 'custom_categories', 'monthly_budget', 'REAL DEFAULT 0.0');
  // Loans used to be borrowing only. Everything already recorded is money owed.
  addColumnIfMissing(db, 'loans', 'direction', "TEXT DEFAULT 'borrowed'");
  db.run("UPDATE loans SET direction = 'borrowed' WHERE direction IS NULL OR direction = ''");

  // Earlier builds kept the unlock PIN in plain text. There is no way to rehash it here
  // without the PIN, and hashing is asynchronous, so the readable copy is removed and the
  // lock falls back to "no PIN set" rather than leaving it lying about.
  const legacy = db.get("SELECT value FROM app_settings WHERE key = 'pin_code'");
  if (legacy) {
    db.run("DELETE FROM app_settings WHERE key = 'pin_code'");
  }

  /*
   * The old fund key, which could not tell two schemes apart.
   *
   * Dropped rather than left alongside the wider one: it is a unique index, so leaving it
   * would keep rejecting exactly the holdings the wider key exists to admit. Nothing is
   * lost by dropping it, and anything unique under the old pair is still unique under the
   * new triple. An empty ISIN rather than a null one, because SQLite counts two nulls as
   * different and a null would quietly stop the index doing its job.
   */
  db.run("UPDATE mf_folios SET isin = '' WHERE isin IS NULL");
  db.run('DROP INDEX IF EXISTS idx_folio_scheme');
  addColumnIfMissing(db, 'mf_folios', 'source', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'mf_folios', 'scope', "TEXT DEFAULT ''");
  /*
   * After the column and not with the table.
   *
   * The schema block runs before the migrations, so an index declared beside CREATE TABLE
   * is created against a database that has not gained the column yet, and an install from
   * an earlier build fails to open at all. An index on a column added by migration
   * belongs with the migration.
   */
  db.run('CREATE INDEX IF NOT EXISTS idx_folio_scope ON mf_folios(scope)');

  /*
   * Clean up duplicate folio transactions from overlapping imports.
   *
   * An import of an overlapping statement period could insert duplicate transaction lines
   * when folio formatting or ISIN fields differed slightly between statements. This deduplicates
   * them, keeping the richer row, so 'Net into funds' and investment metrics reflect true totals.
   */
  db.run("UPDATE folio_transactions SET isin = '' WHERE isin IS NULL");
  db.run("UPDATE folio_transactions SET folio_number = '' WHERE folio_number IS NULL");
  const dupRows = db.all(`
    SELECT t1.id AS del_id, t2.id AS keep_id, t1.isin AS isin1, t2.isin AS isin2
    FROM folio_transactions t1
    JOIN folio_transactions t2 ON t1.id > t2.id
      AND t1.member_id = t2.member_id
      AND t1.date = t2.date
      AND ABS(t1.amount - t2.amount) < 0.01
      AND ABS(t1.units - t2.units) < 0.0001
      AND (
        (t1.isin != '' AND t2.isin != '' AND t1.isin = t2.isin)
        OR (t1.isin = '' OR t2.isin = '')
      )
      AND (
        t1.scheme_name = t2.scheme_name
        OR t1.folio_number = t2.folio_number
        OR (t1.isin != '' AND t2.isin != '' AND t1.isin = t2.isin)
      )
  `);
  if (dupRows.length) {
    const deleted = new Set();
    db.transaction(() => {
      for (const d of dupRows) {
        if (deleted.has(d.del_id)) continue;
        if (!d.isin2 && d.isin1) {
          db.run('UPDATE folio_transactions SET isin = ? WHERE id = ?', [d.isin1, d.keep_id]);
        }
        db.run('DELETE FROM folio_transactions WHERE id = ?', [d.del_id]);
        deleted.add(d.del_id);
      }
    });
  }

  // What a holding cost. A registrar statement prints it for a fund, so mf_folios has
  // carried it from the start, but a depository summary prints only today's value and a
  // pension statement prints neither. Without somewhere to put the cost there is no
  // profit or loss to show for a share or for NPS, so both get a column they can be
  // given by an import that knows it or by hand.
  addColumnIfMissing(db, 'demat_holdings', 'invested_value', 'REAL DEFAULT 0.0');
  addColumnIfMissing(db, 'nps_holdings', 'invested_value', 'REAL DEFAULT 0.0');

  // The normalised vendor name a learned rule is keyed by. Kept on the row and indexed,
  // so teaching the app a category is one indexed update rather than a walk over every
  // transaction ever recorded. Rows written before this column existed get their key
  // computed once, here.
  addColumnIfMissing(db, 'transactions', 'merchant_key', 'TEXT');
  db.run('CREATE INDEX IF NOT EXISTS idx_tx_merchant_key ON transactions(merchant_key)');
  const unkeyed = db.all(
    "SELECT id, merchant FROM transactions WHERE merchant_key IS NULL AND merchant IS NOT NULL AND merchant != ''",
  );
  if (unkeyed.length) {
    db.transaction(() => {
      for (const row of unkeyed) {
        db.run('UPDATE transactions SET merchant_key = ? WHERE id = ?', [merchantKey(row.merchant), row.id]);
      }
    });
  }

  /*
   * What a commitment does over time, rather than only what it costs today.
   *
   * A SIP has carried a step-up percentage from the start but nothing to apply it from: a
   * rate with no anniversary is a rate that cannot be worked out, so the projections
   * silently treated every mandate as flat. `start_date` is that anniversary and
   * `step_up_month` pins it to a calendar month instead, which is how a mandate written to
   * rise every April behaves. A subscription gets the same pair under the names that suit
   * it: a rate, and the date the current price took effect.
   *
   * `linked_merchant_key` is what ties a record back to the debits that pay it, so the
   * scan can tell a plan it already knows about from one it is discovering.
   */
  addColumnIfMissing(db, 'sips', 'start_date', 'TEXT');
  addColumnIfMissing(db, 'sips', 'step_up_month', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'sips', 'linked_merchant_key', 'TEXT');
  addColumnIfMissing(db, 'subscriptions', 'annual_change_percent', 'REAL DEFAULT 0.0');
  addColumnIfMissing(db, 'subscriptions', 'price_since', 'TEXT');
  addColumnIfMissing(db, 'subscriptions', 'linked_merchant_key', 'TEXT');

  // A step-up with nothing to count from does nothing at all, so an existing mandate is
  // dated from the first debit that looks like it, and from today if there is none.
  db.run(
    "UPDATE sips SET start_date = COALESCE((SELECT MIN(date) FROM transactions"
    + ' WHERE transactions.merchant_key = sips.linked_merchant_key), ?)'
    + " WHERE start_date IS NULL OR start_date = ''",
    [today()],
  );
  db.run(
    "UPDATE subscriptions SET price_since = COALESCE(NULLIF(next_billing_date, ''), ?)"
    + " WHERE price_since IS NULL OR price_since = ''",
    [today()],
  );

  // Category icons used to be emoji. Anything that is not a Material Symbols name is
  // reset to a neutral icon, so the UI never asks the font for a glyph it does not have.
  for (const category of db.all('SELECT id, icon FROM custom_categories')) {
    const icon = category.icon || '';
    if (!/^[a-z0-9_]+$/.test(icon)) {
      db.run("UPDATE custom_categories SET icon = 'sell' WHERE id = ?", [category.id]);
    }
  }
}

function addColumnIfMissing(db, table, column, declaration) {
  const columns = db.all(`PRAGMA table_info(${table})`).map((row) => row.name);
  if (columns.includes(column)) return;
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
  } catch {
    // A column another build added under a different declaration is not worth failing on.
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * The currency a write is denominated in.
 *
 * Read from the setting rather than written in as a literal. The rows carry it so a
 * historic entry keeps the currency it was made in even if the setting changes later,
 * which is the whole reason the column exists; writing a constant into it would have
 * thrown that away and made the column a lie.
 */
export function currentCurrency(db) {
  const row = db.get("SELECT value FROM app_settings WHERE key = 'currency'");
  return (row && row.value) || DEFAULT_SETTINGS.currency;
}

/**
 * Which household member a write belongs to.
 *
 * Never assume the first one is numbered one. `family_members` is `AUTOINCREMENT`, which
 * promises never to reuse an id: delete the seeded member, as a factory reset does, and
 * the one that replaces it is numbered two. Everything that hardcoded a one then failed
 * the foreign key, which surfaced as a bare constraint error with nothing to explain it.
 *
 * So the requested id is used only if it exists, and otherwise the primary member, who is
 * the answer the caller meant. If somehow there is nobody at all, one is created, because
 * the schema promises a household of at least one and a write should not fail over it.
 */
export function resolveMemberId(db, requested) {
  const wanted = Number.parseInt(requested, 10);
  if (Number.isFinite(wanted)) {
    const match = db.get('SELECT id FROM family_members WHERE id = ?', [wanted]);
    if (match) return match.id;
  }

  const primary = db.get(
    'SELECT id FROM family_members ORDER BY is_primary DESC, id ASC LIMIT 1',
  );
  if (primary) return primary.id;

  return db.run(
    "INSERT INTO family_members (name, relationship, avatar_color, is_primary, created_at)"
    + " VALUES ('You', 'Self', '#0E6B5A', 1, ?)",
    [today()],
  ).lastInsertRowid;
}

export function isExcludingInvestments(db) {
  const row = db.get("SELECT value FROM app_settings WHERE key = 'exclude_investments_from_expenses'");
  return row ? row.value !== '0' : true;
}

function getSettings(db) {
  const settings = {};
  for (const row of db.all('SELECT key, value FROM app_settings')) {
    if (!PRIVATE_SETTINGS.has(row.key)) settings[row.key] = row.value;
  }
  settings.pin_is_set = db.get("SELECT 1 FROM app_settings WHERE key = 'pin_hash'") ? '1' : '0';
  return { settings };
}

function updateSetting(db, args) {
  const key = args.key;
  if (PRIVATE_SETTINGS.has(key)) {
    return fail('SETTING_PRIVATE', 'That setting cannot be written directly.');
  }
  db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)',
    [key, String(args.value ?? '')]);
  return {};
}

async function setPin(db, args) {
  const newPin = String(args.new_pin ?? '');
  if (newPin.length < 4 || !/^\d+$/.test(newPin)) {
    return fail('PIN_TOO_SHORT', 'Choose a PIN of at least 4 digits.',
      'Digits only, and at least four of them.');
  }

  const row = db.get("SELECT value FROM app_settings WHERE key = 'pin_hash'");
  const currentPin = String(args.current_pin ?? '');
  if (row && !(await pinMatches(currentPin, row.value))) {
    return fail('PIN_WRONG', 'That is not your current PIN.');
  }

  /*
   * The wrapping moves before the hash does.
   *
   * These are two records of the same PIN and they have to agree. The hash is what this
   * screen checks against; the wrapping is what actually opens the records. If only the
   * hash changed, the app would accept the new PIN at the lock screen and then fail to
   * decrypt anything with it, which is the worst of both: it looks unlocked and reads as
   * corrupt.
   *
   * So the wrapping is rewrapped first, and the hash is only written once that succeeded.
   * A failure here leaves both describing the old PIN, which still works.
   *
   * Only when there was a PIN to change from. During setup there is no hash yet and the
   * vault was made moments ago with this very PIN, so there is nothing to rewrap.
   */
  if (row && vaultExists()) {
    try {
      await changeVaultPin(currentPin, newPin);
    } catch {
      return fail('PIN_WRONG', 'That is not your current PIN.',
        'It has to match the PIN your records are encrypted with.');
    }
  }

  db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('pin_hash', ?)",
    [await hashPin(newPin)]);
  return {};
}

/*
 * The lock, from the UI's side.
 *
 * These are the only actions that work before the app is unlocked, because everything
 * else needs a database that cannot be read yet.
 */
async function vaultStatus() {
  return { exists: vaultExists(), unlocked: isUnlocked() };
}

/**
 * Makes the vault. The PIN chosen during setup is the one thing that can do this.
 *
 * Records the PIN in both places it has to be recorded: the wrapping that opens the key,
 * and the hash the app checks against when it wants the PIN confirmed without unlocking
 * anything. Doing both here is what keeps them from ever disagreeing. Setup used to make
 * the vault and then set the PIN as two calls, which read fine and had a trap in it: an
 * install that already had a hash, from a build before any of this existed, had the second
 * call try to change a PIN it had just established and refuse.
 *
 * Opening the database is safe by this point and not before it, because the line above put
 * the key in memory. The save is done here rather than left to the dispatcher, which does
 * not save on behalf of the actions that work the lock.
 */
async function createVaultAction(unused, args) {
  const pin = String(args.new_pin ?? '');
  if (pin.length < 4) return fail('PIN_TOO_SHORT', 'Use at least four digits.');
  if (!/^\d+$/.test(pin)) return fail('PIN_NOT_NUMERIC', 'Digits only.');
  if (vaultExists()) return fail('BAD_REQUEST', 'This device already has a vault.');

  await createVault(pin);

  const db = await getDatabase();
  initDb(db);
  db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('pin_hash', ?)",
    [await hashPin(pin)]);
  mirrorConfig(db);
  await db.flush();

  return { created: true };
}

/**
 * Opens the vault.
 *
 * A wrong PIN is a wrong PIN and nothing more: the wrapping's own tag rejects it, so
 * there is no hash to compare and nothing that could leak which digit was wrong.
 */
async function unlockVaultAction(db, args) {
  try {
    await unlockVault(String(args.pin ?? ''));
    return { unlocked: true };
  } catch (error) {
    const waiting = error.lockedFor || 0;
    return fail('PIN_WRONG', waiting ? 'Too many wrong tries.' : 'That is not your PIN.',
      waiting ? `Try again in ${describeWait(waiting)}.` : null,
      { failed_attempts: error.failed || failedAttempts(), locked_for_ms: waiting });
  }
}

/**
 * Shuts the vault: saves what is pending, then forgets the key and the open database.
 *
 * Dropping the database matters as much as dropping the key. The open handle holds the
 * decrypted records in memory, and leaving it there would mean a locked app still had
 * everything sitting in the heap for anything that could reach it. Locking is meant to
 * leave nothing but ciphertext behind, so the handle is closed and the next unlock reads
 * the file again from the start.
 *
 * The save happens first and is allowed to fail. A device that cannot write at this moment
 * should still end up locked; the alternative is refusing to lock, which is worse.
 */
async function lockVaultAction() {
  const db = currentDatabase();
  if (db) {
    try {
      await db.flush();
    } catch {
      // Nothing useful to do here. Locking anyway is the safer of the two failures.
    }
    try {
      db.close();
    } catch {
      // Already closed, or closing twice. Either way the handle is going away.
    }
  }
  useDatabase(null);
  lockVault();
  return { locked: true };
}

/** A wait, in the words somebody would use for it. */
function describeWait(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 36) return `${hours} hours`;
  return `${Math.ceil(hours / 24)} days`;
}

/*
 * Removing the PIN, which is no longer a thing that can be done.
 *
 * A PIN that only hid the screen was fair to remove. A PIN that the records are encrypted
 * with is not: taking it away would either strand the data behind a key nobody holds, or
 * quietly rewrite it in the clear, and the second is worse because the app would still be
 * describing itself as private. Changing the PIN is the supported move, and it keeps the
 * key so nothing has to be rewritten.
 */
async function clearPin(db, args) {
  const row = db.get("SELECT value FROM app_settings WHERE key = 'pin_hash'");
  if (!row) return {};
  if (!(await pinMatches(String(args.current_pin ?? ''), row.value))) {
    return fail('PIN_WRONG', 'That is not your current PIN.');
  }
  return fail('PIN_REQUIRED', 'The PIN cannot be removed.',
    'It is what your records are locked with. You can change it instead.');
}

async function verifyPin(db, args) {
  const row = db.get("SELECT value FROM app_settings WHERE key = 'pin_hash'");
  if (!row) return { valid: false, reason: 'no_pin_set' };
  return { valid: await pinMatches(String(args.pin ?? ''), row.value) };
}

function getSummary(db, args) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId);

  const totals = {};
  for (const row of db.all(
    `SELECT category, SUM(balance) AS total FROM asset_accounts${clause} GROUP BY category`,
    params,
  )) {
    totals[row.category] = number(row.total);
  }

  const folioTotal = number(db.value(
    `SELECT SUM(current_value) AS total FROM mf_folios${clause}`, params,
  ));
  if (folioTotal) totals.MF = number(totals.MF) + folioTotal;

  const dematTotal = number(db.value(
    `SELECT SUM(current_value) AS total FROM demat_holdings${clause}`, params,
  ));
  if (dematTotal) totals.Demat = number(totals.Demat) + dematTotal;

  const npsTotal = number(db.value(
    `SELECT SUM(current_value) AS total FROM nps_holdings${clause}`, params,
  ));
  if (npsTotal) totals.NPS = number(totals.NPS) + npsTotal;

  // Money lent out is still owed to somebody, but by them rather than by you, so it
  // belongs on the other side of the balance.
  const lent = number(db.value(
    `SELECT SUM(current_outstanding) AS total FROM loans${clause}`
    + `${clause ? ' AND' : ' WHERE'} direction = 'lent'`, params,
  ));
  if (lent) totals.Lent = number(totals.Lent) + lent;

  const assets = Object.values(totals).reduce((sum, value) => sum + value, 0);

  let liabilities = number(db.value(
    `SELECT SUM(current_outstanding) AS total FROM loans${clause}`
    + `${clause ? ' AND' : ' WHERE'} COALESCE(direction, 'borrowed') != 'lent'`, params,
  ));
  liabilities += number(db.value(
    `SELECT SUM(current_balance) AS total FROM credit_cards${clause}`, params,
  ));

  const excludeInvestments = isExcludingInvestments(db);
  const months = [];
  for (let offset = 0; offset < 6; offset += 1) {
    const [start, end] = monthBounds(offset);
    const [txClause, txParams] = memberClause(memberId, 'AND');
    let income = 0;
    let expense = 0;
    let invested = 0;
    for (const row of db.all(
      'SELECT type, is_investment_outflow, SUM(amount) AS total FROM transactions'
      + ` WHERE date >= ? AND date < ?${txClause} GROUP BY type, is_investment_outflow`,
      [start, end, ...txParams],
    )) {
      const total = number(row.total);
      // A transfer is the same money in a different pocket. Counting it as spending is
      // what made paying a credit card bill look like a second month of shopping.
      if (row.type === 'Transfer') continue;
      if (row.type === 'Income') income += total;
      else if (row.is_investment_outflow && excludeInvestments) invested += total;
      else expense += total;
    }
    months.push({ month: start.slice(0, 7), income, expense, invested });
  }

  const recent = db.all(
    `SELECT * FROM transactions${clause} ORDER BY date DESC, id DESC LIMIT 8`, params,
  );
  const members = db.all('SELECT * FROM family_members ORDER BY is_primary DESC, id ASC');
  const budget = db.get("SELECT value FROM app_settings WHERE key = 'monthly_budget'");

  return {
    net_worth: assets - liabilities,
    total_assets: assets,
    total_liabilities: liabilities,
    asset_totals: totals,
    months,
    this_month: months[0],
    recent_transactions: recent,
    family_members: members,
    monthly_budget: budget && budget.value ? number(budget.value) : 0,
  };
}

/** Dated outflows in the next window, merged from instalments, subscriptions and loans. */
function getUpcoming(db, args) {
  const days = Number.parseInt(args.days ?? 30, 10);
  const now = new Date();
  const horizon = new Date(now.getTime() + days * 86400000);
  const [clause, params] = memberClause(args.member_id);
  const items = [];

  const nextOnDay = (day) => {
    const target = Math.max(1, Math.min(28, Number.parseInt(day || 1, 10)));
    let candidate = new Date(now.getFullYear(), now.getMonth(), target);
    if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
      candidate = new Date(now.getFullYear(), now.getMonth() + 1, target);
    }
    return `${candidate.getFullYear()}-${pad(candidate.getMonth() + 1)}-${pad(candidate.getDate())}`;
  };

  for (const row of db.all(
    `SELECT * FROM sips${clause}${clause ? ' AND' : ' WHERE'} is_active = 1`, params,
  )) {
    const date = nextOnDay(row.debit_day);
    // What will actually be debited, which for a stepped-up mandate is not what the
    // record says the instalment was when it was set up.
    const amount = steppedAmount('sip', row, date);
    items.push({
      kind: 'sip',
      title: row.scheme_name,
      amount,
      date,
      note: number(row.step_up_percent) && amount !== number(row.monthly_amount)
        ? `Monthly SIP · stepped up from ${Math.round(number(row.monthly_amount))}`
        : 'Monthly SIP',
    });
  }
  for (const row of db.all(`SELECT * FROM subscriptions${clause}`, params)) {
    items.push({
      kind: 'subscription',
      title: row.name,
      amount: steppedAmount('subscription', row, row.next_billing_date),
      date: row.next_billing_date,
      note: row.billing_cycle,
    });
  }
  for (const row of db.all(`SELECT * FROM loans${clause}`, params)) {
    items.push({
      kind: 'loan', title: row.name, amount: row.monthly_emi, date: nextOnDay(1), note: 'EMI',
    });
  }
  for (const row of db.all(`SELECT * FROM credit_cards${clause}`, params)) {
    if (!row.current_balance) continue;
    items.push({
      kind: 'card',
      title: row.card_name,
      amount: row.current_balance,
      date: nextOnDay(row.due_date),
      note: 'Statement due',
    });
  }

  const from = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const to = `${horizon.getFullYear()}-${pad(horizon.getMonth() + 1)}-${pad(horizon.getDate())}`;
  const upcoming = items
    .filter((item) => item.date && item.date >= from && item.date <= to)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return { upcoming, total: upcoming.reduce((sum, item) => sum + number(item.amount), 0) };
}

/** Where the money actually went, ranked. */
function getTopMerchants(db, args) {
  const months = Math.max(1, Math.min(24, Number.parseInt(args.months ?? 3, 10) || 0));
  const since = `${monthKeys(months)[0]}-01`;
  const [clause, params] = memberClause(args.member_id, 'AND');

  const merchants = db.all(
    'SELECT merchant, SUM(amount) AS total, COUNT(*) AS times FROM transactions'
    + " WHERE date >= ? AND type != 'Income' AND is_investment_outflow = 0"
    + ` AND merchant IS NOT NULL AND merchant != ''${clause}`
    + ' GROUP BY lower(merchant) ORDER BY total DESC LIMIT ?',
    [since, ...params, Number.parseInt(args.limit ?? 6, 10)],
  );
  return { merchants, months };
}

function resolveRecordType(args) {
  const typeOrTable = args.record_type || args.type || args.table;
  const canonical = RECORD_TYPE_ALIASES[typeOrTable] || typeOrTable;
  return canonical ? RECORD_TYPES[canonical] : null;
}

function listRecords(db, args) {
  const spec = resolveRecordType(args);
  if (!spec) return fail('RECORD_TYPE_UNKNOWN', 'That kind of record does not exist.');
  const [table, , order] = spec;
  const [clause, params] = memberClause(args.member_id);
  return { records: db.all(`SELECT * FROM ${table}${clause} ORDER BY ${order}`, params) };
}

function saveRecord(db, args) {
  const spec = resolveRecordType(args);
  if (!spec) return fail('RECORD_TYPE_UNKNOWN', 'That kind of record does not exist.');
  const [table, columns] = spec;
  const record = { ...(args.record || {}) };

  // Field aliases for compatibility
  if (record.principal !== undefined && record.principal_amount === undefined) {
    record.principal_amount = record.principal;
  }
  if (record.credit_limit !== undefined && record.total_limit === undefined) {
    record.total_limit = record.credit_limit;
  }
  if (record.due_day !== undefined && record.due_date === undefined) {
    record.due_date = record.due_day;
  }
  if (record.fund_name !== undefined && record.scheme_name === undefined) {
    record.scheme_name = record.fund_name;
  }
  if (record.purchase_cost !== undefined && record.invested_value === undefined) {
    record.invested_value = record.purchase_cost;
  }
  if (record.cost_value !== undefined && record.invested_value === undefined) {
    record.invested_value = record.cost_value;
  }
  if (record.amount !== undefined && record.cost === undefined && table === 'subscriptions') {
    record.cost = record.amount;
  }
  if (record.amount !== undefined && record.monthly_amount === undefined && table === 'sips') {
    record.monthly_amount = record.amount;
  }
  if (table === 'loans') {
    if (record.principal_amount === undefined) {
      record.principal_amount = record.principal ?? record.current_outstanding ?? 0;
    }
    if (record.current_outstanding === undefined) {
      record.current_outstanding = record.principal_amount ?? 0;
    }
    if (record.interest_rate === undefined) {
      record.interest_rate = 0;
    }
    if (record.monthly_emi === undefined) {
      record.monthly_emi = 0;
    }
    if (!record.loan_type) {
      record.loan_type = 'Personal';
    }
    if (!record.start_date) {
      record.start_date = today();
    }
    if (!record.tenure_months) {
      record.tenure_months = 12;
    }
  }
  if (table === 'credit_cards' && !record.bank) {
    record.bank = record.card_name || 'Bank';
  }
  if (table === 'subscriptions' && !record.next_billing_date) {
    record.next_billing_date = today();
  }

  const fields = columns.filter((column) => column in record);
  if (!fields.length) return fail('RECORD_EMPTY', 'Nothing in that record could be saved.');
  const values = fields.map((column) => record[column]);

  let recordId = record.id;
  if (!recordId && columns.includes('member_id') && !fields.includes('member_id')) {
    // The column defaults to one, which is only right until a member has been recreated.
    fields.push('member_id');
    values.push(resolveMemberId(db, null));
  } else if (fields.includes('member_id')) {
    values[fields.indexOf('member_id')] = resolveMemberId(db, record.member_id);
  }

  // Same for the currency: the record carries the one in force when it was written.
  if (!recordId && columns.includes('currency') && !fields.includes('currency')) {
    fields.push('currency');
    values.push(currentCurrency(db));
  }

  if (recordId) {
    const assignments = fields.map((column) => `${column} = ?`).join(', ');
    db.run(`UPDATE ${table} SET ${assignments} WHERE id = ?`, [...values, recordId]);
  } else {
    const placeholders = fields.map(() => '?').join(', ');
    const result = db.run(
      `INSERT INTO ${table} (${fields.join(', ')}) VALUES (${placeholders})`, values,
    );
    recordId = result.lastInsertRowid;
  }

  if (table === 'asset_accounts') {
    db.run('UPDATE asset_accounts SET updated_at = ? WHERE id = ?', [today(), recordId]);
  }
  return { record_id: recordId };
}

function deleteRecord(db, args) {
  const spec = resolveRecordType(args);
  if (!spec) return fail('RECORD_TYPE_UNKNOWN', 'That kind of record does not exist.');
  db.run(`DELETE FROM ${spec[0]} WHERE id = ?`, [args.record_id]);

  // The price history describes a plan. With the plan gone it describes nothing, and the
  // ids are AUTOINCREMENT so nothing will ever adopt it either.
  const canonicalType = RECORD_TYPE_ALIASES[args.record_type || args.table] || args.record_type;
  if (canonicalType === 'sip' || canonicalType === 'subscription') {
    db.run('DELETE FROM price_changes WHERE kind = ? AND record_id = ?',
      [canonicalType, args.record_id]);
  }
  return {};
}

/** Fund holdings, whether typed in or imported from a statement. */
function listFolios(db, args) {
  const [clause, params] = memberClause(args.member_id);
  const folios = db.all(`SELECT * FROM mf_folios${clause} ORDER BY current_value DESC`, params);
  return {
    folios,
    total_value: folios.reduce((sum, folio) => sum + number(folio.current_value), 0),
    total_invested: folios.reduce((sum, folio) => sum + number(folio.invested_value), 0),
  };
}

/** Shares, exchange-traded funds and bonds held in a demat account. */
function listDematHoldings(db, args) {
  const [clause, params] = memberClause(args.member_id);
  const holdings = db.all(
    `SELECT * FROM demat_holdings${clause} ORDER BY current_value DESC`, params,
  );
  const byKind = {};
  for (const holding of holdings) {
    byKind[holding.kind] = (byKind[holding.kind] || 0) + number(holding.current_value);
  }
  return {
    holdings,
    totals_by_kind: byKind,
    total_value: holdings.reduce((sum, row) => sum + number(row.current_value), 0),
  };
}

/** Pension holdings, from the same statement. */
function listNpsHoldings(db, args) {
  const [clause, params] = memberClause(args.member_id);
  const holdings = db.all(
    `SELECT * FROM nps_holdings${clause} ORDER BY current_value DESC`, params,
  );
  return {
    holdings,
    total_value: holdings.reduce((sum, row) => sum + number(row.current_value), 0),
  };
}

/**
 * Every holding, from all three tables, in one shape.
 *
 * The three of them describe the same idea in different words: a folio has units and a
 * NAV, a demat line has a quantity and a price, a pension scheme has units and a NAV
 * again. A screen that wants to sort the lot by profit should not have to know that, so
 * the translation happens once, here.
 *
 * Cost is the awkward part. A registrar prints it, a depository summary does not, so a
 * row whose cost is unknown reports `has_cost: false` rather than a profit of minus
 * everything. Totals only add up the rows that know.
 */
function listInvestments(db, args) {
  const [clause, params] = memberClause(args.member_id);
  const rows = [];

  for (const folio of db.all(`SELECT * FROM mf_folios${clause}`, params)) {
    rows.push(shapeHolding({
      source: 'folio',
      id: folio.id,
      name: folio.scheme_name,
      isin: folio.isin,
      /*
       * A portfolio is where a holding is kept, not who runs it. For units in demat that
       * is the broker, which is what the amc column happens to hold for those rows. For a
       * folio there is no broker, so it is one bucket: listing every fund house separately
       * turns the filter into a list of the schemes it is supposed to be filtering.
       */
      portfolio: folio.source === 'depository'
        ? (folio.amc || 'Demat')
        : 'Mutual fund folios',
      amc: folio.amc || '',
      account: folio.folio_number || '',
      units: folio.units,
      nav: folio.nav,
      value: folio.current_value,
      invested: folio.invested_value,
      member_id: folio.member_id,
      updated: folio.last_updated,
    }));
  }

  for (const holding of db.all(`SELECT * FROM demat_holdings${clause}`, params)) {
    rows.push(shapeHolding({
      source: 'demat',
      id: holding.id,
      name: holding.name || holding.symbol || holding.isin,
      isin: holding.isin,
      kind: holding.kind,
      // A depository account is the portfolio: somebody with two brokers wants the two
      // kept apart, and the client id is what keeps them apart.
      portfolio: holding.broker || holding.account_type || 'Demat',
      account: holding.client_id ? `${holding.dp_id || ''}${holding.client_id}` : '',
      symbol: holding.symbol || '',
      exchange: holding.exchange || '',
      units: holding.quantity,
      nav: holding.price,
      value: holding.current_value,
      invested: holding.invested_value,
      member_id: holding.member_id,
      updated: holding.last_updated,
    }));
  }

  for (const scheme of db.all(`SELECT * FROM nps_holdings${clause}`, params)) {
    rows.push(shapeHolding({
      source: 'nps',
      id: scheme.id,
      name: scheme.scheme,
      portfolio: scheme.fund_manager || 'NPS',
      account: [scheme.pran, scheme.tier].filter(Boolean).join(' '),
      units: scheme.units,
      nav: scheme.nav,
      value: scheme.current_value,
      invested: scheme.invested_value,
      member_id: scheme.member_id,
      updated: scheme.last_updated,
    }));
  }

  const totals = { value: 0, invested: 0, pnl: 0, priced_value: 0 };
  const byClass = {};
  const portfolios = new Set();

  for (const row of rows) {
    totals.value += row.value;
    portfolios.add(row.portfolio);
    if (row.has_cost) {
      totals.invested += row.invested;
      totals.pnl += row.pnl;
      // Only value backed by a known cost can be compared with that cost, so the return
      // percentage is worked out against this rather than against everything.
      totals.priced_value += row.value;
    }
    const bucket = byClass[row.asset_class] || (byClass[row.asset_class] = {
      value: 0, invested: 0, pnl: 0, count: 0,
    });
    bucket.value += row.value;
    bucket.count += 1;
    if (row.has_cost) {
      bucket.invested += row.invested;
      bucket.pnl += row.pnl;
    }
  }

  totals.pnl_percent = totals.invested > 0 ? (totals.pnl / totals.invested) * 100 : 0;
  totals.unpriced = rows.filter((row) => !row.has_cost).length;

  return {
    holdings: rows,
    totals,
    by_class: byClass,
    portfolios: [...portfolios].sort(),
  };
}

/** One holding in the shape every screen reads. */
function shapeHolding(raw) {
  const units = number(raw.units);
  const nav = number(raw.nav);
  const invested = number(raw.invested);
  // A statement that prints a value is believed. One that does not still has units and a
  // price, and their product is the value.
  const value = number(raw.value) || units * nav;
  const hasCost = invested > 0;

  return {
    source: raw.source,
    id: raw.id,
    name: raw.name || '',
    isin: raw.isin || '',
    symbol: raw.symbol || '',
    exchange: raw.exchange || '',
    portfolio: raw.portfolio || '',
    // Who runs the scheme, kept beside the portfolio rather than instead of it.
    amc: raw.amc || '',
    account: raw.account || '',
    asset_class: classifyAsset({
      isin: raw.isin, name: raw.name, kind: raw.kind, source: raw.source,
    }),
    units,
    nav,
    invested,
    value,
    has_cost: hasCost,
    pnl: hasCost ? value - invested : 0,
    pnl_percent: hasCost ? ((value - invested) / invested) * 100 : 0,
    member_id: raw.member_id,
    last_updated: raw.updated || '',
  };
}

/**
 * Everything recorded about one holding, including how it got there.
 *
 * The history only exists where a detailed registrar statement was read, so an empty list
 * means nobody has uploaded one rather than that nothing ever happened. What the lines
 * add up to is reported separately from what the holding is worth, because the two come
 * from different statements and either can be missing.
 */
function getHoldingDetail(db, args) {
  const isin = String(args.isin || '').trim();
  const folio = String(args.folio_number || '').trim();
  if (!isin && !folio) return fail('BAD_REQUEST', 'Which holding was not given.');

  const [clause, params] = memberClause(args.member_id, 'AND');
  const lines = db.all(
    `SELECT * FROM folio_transactions WHERE (isin = ? OR folio_number = ?)${clause}`
    + ' ORDER BY date DESC, id DESC',
    [isin, folio, ...params],
  );

  let invested = 0;
  let redeemed = 0;
  let unitsBought = 0;
  for (const line of lines) {
    const amount = number(line.amount);
    // A registrar writes a purchase positive and a redemption negative, and a dividend
    // payout carries money without units. Only what bought units counts as invested.
    if (number(line.units) > 0 && amount > 0) {
      invested += amount;
      unitsBought += number(line.units);
    } else if (amount < 0) {
      redeemed += Math.abs(amount);
    }
  }

  return {
    transactions: lines,
    counted: lines.length,
    invested_from_history: invested,
    redeemed_from_history: redeemed,
    average_cost: unitsBought > 0 ? invested / unitsBought : 0,
    first_seen: lines.length ? lines[lines.length - 1].date : '',
    last_seen: lines.length ? lines[0].date : '',
  };
}

/**
 * Statement lines in a window, whichever holding they belong to.
 *
 * The counterpart of `get_transactions` for the investment side: a chart of what was bought
 * in a month is worth nothing if tapping the bar cannot say which schemes it was. Only
 * exists where a detailed registrar statement was read, so an empty reply means nobody has
 * uploaded one rather than that nothing was bought.
 */
function getFolioTransactions(db, args) {
  const filters = [];
  const params = [];

  const [clause, memberParams] = memberClause(args.member_id, 'AND');
  if (clause) {
    filters.push('member_id = ?');
    params.push(...memberParams);
  }
  if (args.from) {
    filters.push('date >= ?');
    params.push(String(args.from).slice(0, 10));
  }
  if (args.to) {
    filters.push('date < ?');
    params.push(String(args.to).slice(0, 10));
  }
  if (args.isin) {
    filters.push('isin = ?');
    params.push(String(args.isin));
  }
  if (args.scheme_name) {
    filters.push('scheme_name = ?');
    params.push(String(args.scheme_name));
  }
  if (args.direction === 'bought') filters.push('amount > 0');
  if (args.direction === 'sold') filters.push('amount < 0');

  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(1000, Number.parseInt(args.limit ?? 250, 10) || 250));
  const lines = db.all(
    `SELECT * FROM folio_transactions${where} ORDER BY date DESC, id DESC LIMIT ?`,
    [...params, limit],
  );

  let bought = 0;
  let sold = 0;
  const schemes = new Map();
  for (const line of lines) {
    const amount = number(line.amount);
    if (amount >= 0) bought += amount;
    else sold += Math.abs(amount);
    const name = line.scheme_name || line.isin || 'Unnamed scheme';
    schemes.set(name, (schemes.get(name) || 0) + amount);
  }

  return {
    transactions: lines,
    count: lines.length,
    bought,
    sold,
    net: bought - sold,
    schemes: [...schemes.entries()]
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
    capped: lines.length >= limit,
  };
}

/** Records what a holding cost, which is the one thing no depository statement says. */
function saveHoldingCost(db, args) {
  const tables = { folio: 'mf_folios', demat: 'demat_holdings', nps: 'nps_holdings' };
  const table = tables[args.source];
  const id = Number(args.holding_id);
  const invested = number(args.invested_value);

  if (!table) return fail('RECORD_TYPE_UNKNOWN', 'No such kind of holding.');
  if (!id) return fail('BAD_REQUEST', 'Which holding was not given.');
  if (invested < 0) return fail('AMOUNT_INVALID', 'A cost cannot be negative.');

  db.run(`UPDATE ${table} SET invested_value = ? WHERE id = ?`, [invested, id]);
  return { holding_id: id };
}

function getFamilyMembers(db) {
  return { members: db.all('SELECT * FROM family_members ORDER BY is_primary DESC, id ASC') };
}

function addFamilyMember(db, args) {
  const member = args.member || (args.name ? args : {});
  if (!String(member.name ?? '').trim()) {
    return fail('NAME_REQUIRED', 'Give the member a name.');
  }
  // A household with nobody in it should not be possible, but if the seeded member was
  // removed some other way, the first one added becomes the primary rather than leaving
  // every write with nothing to point at.
  const isFirst = Number(db.value('SELECT COUNT(*) FROM family_members')) === 0;
  if (isFirst) {
    const created = db.run(
      'INSERT INTO family_members (name, relationship, avatar_color, is_primary, notes,'
      + ' created_at) VALUES (?, ?, ?, 1, ?, ?)',
      [member.name.trim(), member.relationship ?? 'Self', member.avatar_color ?? '#0E6B5A',
        member.notes ?? '', today()],
    );
    return { member_id: created.lastInsertRowid };
  }
  const result = db.run(
    'INSERT INTO family_members (name, relationship, avatar_color, is_primary, notes, created_at)'
    + ' VALUES (?, ?, ?, 0, ?, ?)',
    [member.name.trim(), member.relationship ?? 'Other', member.avatar_color ?? '#0E6B5A',
      member.notes ?? '', today()],
  );
  return { member_id: result.lastInsertRowid };
}

function deleteFamilyMember(db, args) {
  const result = db.run(
    'DELETE FROM family_members WHERE id = ? AND is_primary = 0', [args.member_id],
  );
  if (result.changes === 0) {
    return fail('MEMBER_PRIMARY', 'The primary profile cannot be removed.');
  }
  return {};
}

function getCategories(db) {
  const categories = db.all('SELECT * FROM custom_categories ORDER BY type, name');
  const [start, end] = monthBounds();
  const spent = new Map(db.all(
    'SELECT category, SUM(amount) AS spent FROM transactions'
    + ' WHERE date >= ? AND date < ? GROUP BY category',
    [start, end],
  ).map((row) => [row.category, number(row.spent)]));

  for (const category of categories) {
    category.spent_this_month = spent.get(category.name) || 0;
  }
  return { categories };
}

function saveCategory(db, args) {
  const category = args.category || {};
  const name = String(category.name ?? '').trim();
  if (!name) return fail('NAME_REQUIRED', 'Give the category a name.');

  if (category.id) {
    db.run(
      'UPDATE custom_categories SET name = ?, type = ?, color = ?, icon = ?,'
      + ' monthly_budget = ? WHERE id = ?',
      [name, category.type ?? 'Expense', category.color ?? '#0E6B5A',
        category.icon ?? 'sell', number(category.monthly_budget), category.id],
    );
    return { category_id: category.id };
  }

  if (db.get('SELECT id FROM custom_categories WHERE name = ?', [name])) {
    return fail('CATEGORY_DUPLICATE', 'A category with that name already exists.');
  }

  const result = db.run(
    'INSERT INTO custom_categories (name, type, color, icon, monthly_budget)'
    + ' VALUES (?, ?, ?, ?, ?)',
    [name, category.type ?? 'Expense', category.color ?? '#0E6B5A',
      category.icon ?? 'sell', number(category.monthly_budget)],
  );
  return { category_id: result.lastInsertRowid };
}

function deleteCategory(db, args) {
  db.run('DELETE FROM custom_categories WHERE id = ?', [args.category_id]);
  return {};
}

/**
 * Transactions, newest first, narrowed by whatever the caller asked for.
 *
 * The filters exist so a drilldown can ask for exactly the rows behind a bar rather than
 * fetching the last two hundred and fifty and sieving them in the view. A screen that
 * showed only what it had fetched was the reason tapping a month showed nothing: the month
 * was real, the rows were simply not in the page's copy of the ledger.
 */
function getTransactions(db, args) {
  const filters = [];
  const params = [];

  const [memberFilter, memberParams] = memberClause(args.member_id, 'AND');
  if (memberFilter) {
    filters.push('member_id = ?');
    params.push(...memberParams);
  }
  if (args.from) {
    filters.push('date >= ?');
    params.push(String(args.from).slice(0, 10));
  }
  if (args.to) {
    // Exclusive, so a bucket range from the analytics side can be passed straight through.
    filters.push('date < ?');
    params.push(String(args.to).slice(0, 10));
  }
  if (args.category) {
    filters.push('category = ?');
    params.push(String(args.category));
  }
  if (args.merchant) {
    filters.push("lower(COALESCE(merchant, '')) = ?");
    params.push(String(args.merchant).toLowerCase());
  }
  if (args.merchant_key) {
    filters.push('merchant_key = ?');
    params.push(String(args.merchant_key));
  }
  if (args.weekday !== undefined && args.weekday !== null && args.weekday !== '') {
    // SQLite counts weekdays from Sunday, the same way JavaScript does.
    filters.push("CAST(strftime('%w', date) AS INTEGER) = ?");
    params.push(Number.parseInt(args.weekday, 10));
  }
  const excludeInvestments = isExcludingInvestments(db);
  if (args.flow === 'spend') {
    filters.push(excludeInvestments
      ? "type != 'Income' AND type != 'Transfer' AND COALESCE(is_investment_outflow, 0) = 0"
      : "type != 'Income' AND type != 'Transfer'");
  } else if (args.flow === 'income') {
    filters.push("type = 'Income'");
  } else if (args.flow === 'invest') {
    filters.push('COALESCE(is_investment_outflow, 0) = 1');
  } else if (args.type) {
    filters.push('type = ?');
    params.push(String(args.type));
  }
  if (args.search) {
    filters.push("(lower(COALESCE(merchant, '')) LIKE ? OR lower(COALESCE(description, '')) LIKE ?"
      + ' OR lower(category) LIKE ?)');
    const needle = `%${String(args.search).toLowerCase()}%`;
    params.push(needle, needle, needle);
  }

  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(2000, Number.parseInt(args.limit ?? 250, 10) || 250));
  const transactions = db.all(
    `SELECT * FROM transactions${where} ORDER BY date DESC, id DESC LIMIT ?`,
    [...params, limit],
  );

  for (const transaction of transactions) {
    transaction.splits = db.all(
      'SELECT * FROM transaction_splits WHERE transaction_id = ?', [transaction.id],
    );
    transaction.cashbacks = db.all(
      'SELECT * FROM transaction_cashbacks WHERE transaction_id = ?', [transaction.id],
    );
    const cashback = transaction.cashbacks
      .reduce((sum, row) => sum + number(row.cashback_amount), 0);
    const recovered = transaction.splits
      .filter((row) => row.is_paid)
      .reduce((sum, row) => sum + number(row.share_amount), 0);
    transaction.net_personal_amount = Math.max(
      0, number(transaction.amount) - cashback - recovered,
    );
  }

  // The totals are of what came back, so a list that was capped says so rather than
  // letting the view add up a page and present it as the whole window.
  const totals = { income: 0, expense: 0, invested: 0 };
  for (const transaction of transactions) {
    const value = number(transaction.amount);
    if (transaction.type === 'Transfer') continue;
    if (transaction.type === 'Income') totals.income += value;
    else if (transaction.is_investment_outflow && excludeInvestments) totals.invested += value;
    else totals.expense += value;
  }

  return {
    transactions,
    totals,
    count: transactions.length,
    capped: transactions.length >= limit,
  };
}

/**
 * Records what a vendor means, and brings the history into line with it.
 *
 * Categorising something is a statement about the vendor, not about the one row that
 * prompted it, so it is stored against the vendor and every transaction sharing the key
 * follows. The backfill is an indexed update, so its cost does not grow with the history.
 *
 * Returns how many rows moved, which is the only interesting thing to tell the user.
 */
export function learnMerchant(db, merchant, category, transactionType = '', isInvestOutflow = false) {
  const key = merchantKey(merchant);
  if (!key || !category) return { merchant_key: '', applied: 0 };

  db.run(
    'INSERT INTO merchant_rules (merchant_key, category_name, transaction_type, display_name,'
    + ' source, hits, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
    + ' ON CONFLICT(merchant_key) DO UPDATE SET category_name = excluded.category_name,'
    + ' transaction_type = excluded.transaction_type, display_name = excluded.display_name,'
    + ' source = excluded.source, updated_at = excluded.updated_at',
    [key, category, transactionType, String(merchant).trim(), 'user', new Date().toISOString()],
  );

  // Anything still unkeyed gets a key first. Matching on the raw name instead would reach
  // "CITYFLO" and miss "CAS*CITYFLO", which is the whole reason the key exists. The set
  // empties out, so later corrections do not pay for this again.
  const unkeyed = db.all(
    "SELECT id, merchant FROM transactions WHERE (merchant_key IS NULL OR merchant_key = '')"
    + " AND merchant IS NOT NULL AND merchant != ''",
  );
  for (const row of unkeyed) {
    db.run('UPDATE transactions SET merchant_key = ? WHERE id = ?', [merchantKey(row.merchant), row.id]);
  }

  const applied = db.all('SELECT id FROM transactions WHERE merchant_key = ?', [key]).length;
  db.run('UPDATE transactions SET category = ? WHERE merchant_key = ?', [category, key]);
  if (transactionType) {
    const isInvest = isInvestOutflow || transactionType === 'Investment' || category === 'Investment Outflow' ? 1 : 0;
    db.run('UPDATE transactions SET type = ?, is_investment_outflow = ? WHERE merchant_key = ?', [transactionType, isInvest, key]);
  }
  db.run('UPDATE merchant_rules SET hits = ? WHERE merchant_key = ?', [applied, key]);
  return { merchant_key: key, applied };
}

function saveTransaction(db, args) {
  const transaction = args.transaction || {};
  const amount = number(transaction.amount);
  if (!(amount > 0)) return fail('AMOUNT_INVALID', 'Enter an amount greater than zero.');

  const merchant = String(transaction.merchant ?? '').trim();
  const isInvest = transaction.is_investment_outflow || transaction.type === 'Investment' || transaction.category === 'Investment Outflow' ? 1 : 0;
  const values = [
    resolveMemberId(db, transaction.member_id),
    transaction.account_id ?? null,
    transaction.date || today(),
    amount,
    transaction.currency || currentCurrency(db),
    transaction.type ?? 'Expense',
    transaction.category ?? 'Groceries',
    merchant,
    transaction.description ?? '',
    isInvest,
    transaction.raw_sms ?? '',
  ];

  let transactionId = transaction.id;
  if (transactionId) {
    db.run(
      'UPDATE transactions SET member_id = ?, account_id = ?, date = ?, amount = ?,'
      + ' currency = ?, type = ?, category = ?, merchant = ?,'
      + ' description = ?, is_investment_outflow = ?, raw_sms = ? WHERE id = ?',
      [...values, transactionId],
    );
    db.run('DELETE FROM transaction_splits WHERE transaction_id = ?', [transactionId]);
    db.run('DELETE FROM transaction_cashbacks WHERE transaction_id = ?', [transactionId]);
  } else {
    const result = db.run(
      'INSERT INTO transactions (member_id, account_id, date, amount, currency, type,'
      + ' category, merchant, description, is_investment_outflow, raw_sms,'
      + ' created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [...values, new Date().toISOString()],
    );
    transactionId = result.lastInsertRowid;
  }

  // Naming a category for a named vendor is the teaching moment. It is only taken when
  // the caller actually said one, so the 'Groceries' default above never becomes a rule.
  let learned = { merchant_key: merchantKey(merchant), applied: 0 };
  if (merchant && transaction.category) {
    learned = learnMerchant(db, merchant, transaction.category, transaction.type ?? '', isInvest);
  }

  for (const split of transaction.splits || []) {
    db.run(
      'INSERT INTO transaction_splits (transaction_id, person_name, share_amount, is_paid)'
      + ' VALUES (?, ?, ?, ?)',
      [transactionId, split.person_name, number(split.share_amount), split.is_paid ? 1 : 0],
    );
  }
  for (const cashback of transaction.cashbacks || []) {
    db.run(
      'INSERT INTO transaction_cashbacks (transaction_id, source_name, cashback_amount)'
      + ' VALUES (?, ?, ?)',
      [transactionId, cashback.source_name, number(cashback.cashback_amount)],
    );
  }
  // `also_categorised` counts the other rows this save brought into line, so a screen can
  // say what it did rather than silently rewriting the user's history.
  return {
    transaction_id: transactionId,
    merchant_key: learned.merchant_key,
    also_categorised: Math.max(0, learned.applied - 1),
  };
}

function deleteTransaction(db, args) {
  db.run('DELETE FROM transactions WHERE id = ?', [args.transaction_id]);
  return {};
}

async function exportBackup(db, args) {
  const password = args.password;
  if (!password || String(password).length < 8) {
    return fail('BACKUP_PASSWORD_WEAK', 'Use a password of at least 8 characters.',
      'This password is the only thing protecting the export.');
  }

  const payload = {};
  let count = 0;
  for (const table of BACKUP_TABLES) {
    payload[table] = db.all(`SELECT * FROM ${table}`);
    count += payload[table].length;
  }

  return {
    backup_payload: await encryptData(JSON.stringify(payload), String(password)),
    record_count: count,
  };
}

async function importBackup(db, args) {
  const { backup_payload: payload, password } = args;
  if (!payload || !password) {
    return fail('BACKUP_PASSWORD_MISSING', 'Choose a backup file and enter its password.');
  }

  const data = JSON.parse(await decryptData(payload, String(password)));
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return fail('BACKUP_MALFORMED', 'That file is not a Vitta Vriksha backup.');
  }

  let restored = 0;
  try {
    db.transaction(() => {
      for (const table of [...BACKUP_TABLES].reverse()) {
        db.run(`DELETE FROM ${table}`);
      }
      for (const table of BACKUP_TABLES) {
        const rows = data[table];
        if (!rows || !rows.length) continue;
        const known = new Set(db.all(`PRAGMA table_info(${table})`).map((row) => row.name));
        for (const row of rows) {
          const columns = Object.keys(row).filter((column) => known.has(column));
          if (!columns.length) continue;
          const placeholders = columns.map(() => '?').join(', ');
          db.run(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
            columns.map((column) => row[column]),
          );
          restored += 1;
        }
      }
      if (!restored) throw new EmptyBackup();
    });
  } catch (error) {
    if (error instanceof EmptyBackup) {
      return fail('BACKUP_EMPTY', 'That backup held no records.', 'Nothing was changed.');
    }
    throw error;
  }
  return { restored };
}

/** Thrown to roll a restore back when nothing in the file was usable. */
class EmptyBackup extends Error {}

/**
 * What "delete my data" can mean, and which tables each answer touches.
 *
 * Deliberately explicit rather than a table name passed through from the UI: a screen
 * asking to erase something should never be able to name a table the backend did not
 * intend to expose.
 */
const CLEARABLE = {
  transactions: ['transactions'],
  // A transaction can name the account it came out of, so those references have to be
  // released before the accounts go. Deleting straight out fails the foreign key.
  accounts: ['asset_accounts'],
  goals: ['goals'],
  loans: ['loans'],
  cards: ['credit_cards'],
  // The price history goes with the plan it describes: rows left behind would point at a
  // record that no longer exists and turn up in the next projection.
  subscriptions: ['subscriptions'],
  sips: ['sips'],
  recurring: ['recurring_dismissed'],
  events: ['custom_events'],
  holdings: ['mf_folios', 'demat_holdings', 'nps_holdings'],
  rules: ['sms_rules'],
  categories: ['custom_categories'],
};

/**
 * Erases one or more kinds of record.
 *
 * Budgets are a special case: they are a column on the categories rather than rows of
 * their own, so clearing them resets the amounts and leaves the categories in place.
 * Anything that reseeds itself does so on the next call, the way a factory reset does.
 */
async function clearData(db, args) {
  const kinds = Array.isArray(args.kinds) ? args.kinds : [args.kind].filter(Boolean);
  if (!kinds.length) return fail('BAD_REQUEST', 'Nothing was named to delete.');

  let cleared = 0;
  const unknown = [];

  db.transaction(() => {
    for (const kind of kinds) {
      if (kind === 'budgets') {
        cleared += db.run('UPDATE custom_categories SET monthly_budget = 0').changes;
        db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('monthly_budget', '0')");
        continue;
      }
      const tables = CLEARABLE[kind];
      if (!tables) {
        unknown.push(kind);
        continue;
      }
      if (kind === 'accounts') {
        // Release the references first; the transactions themselves are somebody else's
        // answer to delete.
        db.run('UPDATE transactions SET account_id = NULL WHERE account_id IS NOT NULL');
      }
      if (kind === 'sips' || kind === 'subscriptions') {
        // The price history describes records that are about to go. Left behind, it would
        // point at nothing and still turn up in the next projection.
        cleared += db.run('DELETE FROM price_changes WHERE kind = ?',
          [kind === 'sips' ? 'sip' : 'subscription']).changes;
      }
      for (const table of tables) {
        cleared += db.run(`DELETE FROM ${table}`).changes;
      }
    }
  });

  if (unknown.length) {
    return fail('BAD_REQUEST', `Nothing here is called ${unknown.join(', ')}.`);
  }
  // Categories and rules seed themselves; clearing them means the defaults come back.
  if (kinds.includes('categories') || kinds.includes('rules')) schemaReady = false;
  return { cleared };
}

/*
 * Starting again, from either end.
 *
 * The same operation whether it is reached from Security by somebody who means it, or from
 * the lock screen by somebody who has forgotten their PIN. It has to be, because the two
 * have to leave the device in the same state: emptying the tables but keeping the vault
 * would leave a device whose PIN is the old one and whose ledger is gone, and setup would
 * then refuse to make the vault it is about to ask for a PIN for.
 *
 * So the file goes and the key goes with it. What is deliberately kept is the mirror of
 * the rules, which is copied out one last time on the way past if the database can still
 * be read, and picked up by the next `initDb`.
 */
async function factoryReset() {
  const db = currentDatabase();
  if (db) {
    // Only possible while unlocked. From the lock screen the mirror is already current,
    // because it is refreshed after every action that ever changed a rule.
    mirrorConfig(db);
    try {
      db.close();
    } catch {
      // Nothing to save. The file is about to be deleted either way.
    }
  }
  useDatabase(null);
  lockVault();

  await deleteDatabase();
  // Last, and in this order. A key deleted before the file it opens would leave a file
  // nothing can ever read, which is the same outcome but looks like a bug to whoever finds
  // it on the device.
  deleteVaultKey();
  writeAttempts({ failed: 0, until: 0, seen: Date.now() });
  return { reset: true };
}

const ACTIONS = {
  get_settings: getSettings,
  update_setting: updateSetting,
  set_pin: setPin,
  clear_pin: clearPin,
  vault_status: vaultStatus,
  create_vault: createVaultAction,
  unlock_vault: unlockVaultAction,
  lock_vault: lockVaultAction,
  verify_pin: verifyPin,
  get_summary: getSummary,
  get_upcoming: getUpcoming,
  get_series: getSeries,
  get_breakdown: getBreakdown,
  get_period_summary: getPeriodSummary,
  get_spending_anomalies: getSpendingAnomalies,
  get_safe_to_spend: calculateSafeToSpend,
  get_cashflow_runway: getCashflowRunway,
  get_salary_checklist: getSalaryChecklist,
  get_weekend_spend_analysis: getWeekendVsWeekdayAnalysis,
  get_tax_harvesting: calculateTaxHarvesting,
  get_portfolio_rebalance: calculatePortfolioRebalance,
  get_passive_yield: calculatePassiveYield,
  get_direct_vs_regular_drag: (db, args) => calculateDirectVsRegularDrag(args.monthly_sip, args.lumpsum, args.expected_cagr, args.years),
  get_fd_ladder: calculateFdLadder,
  get_sgb_schedule: calculateSgbSchedule,
  get_real_return: (db, args) => calculateRealReturn(args.nominal_return, args.inflation_rate),
  get_debt_roadmap: calculateDebtPayoffRoadmap,
  get_home_loan_part_payment: (db, args) => calculateHomeLoanPartPayment(args.principal, args.annual_rate, args.tenure_years, args.extra_emis_per_year, args.annual_step_up_pct),
  get_credit_card_optimizer: getCreditCardOptimizer,
  get_dti_ratio: calculateDtiRatio,
  get_no_spend_days: calculateNoSpendDays,
  get_monthly_wrapped: getMonthlyFinanceWrapped,
  get_life_goals: (db, args) => calculateLifeGoals(args.goals, args.expected_cagr),
  evaluate_challenge: (db, args) => evaluateChallenge(db, args.challenge),
  get_local_sync_payload: generateLocalSyncPayload,
  // The two catalogues, so a screen that offers the user a choice of chart offers exactly
  // the charts the backend can draw rather than a list somebody has to keep in step.
  get_chart_catalogue: () => ({
    metrics: seriesMetrics(), dimensions: breakdownDimensions(),
  }),
  get_top_merchants: getTopMerchants,
  find_recurring: findRecurring,
  track_recurring: trackRecurring,
  dismiss_recurring: dismissRecurring,
  apply_price_change: applyPriceChange,
  get_price_history: getPriceHistory,
  project_commitments: projectCommitments,
  list_records: listRecords,
  save_record: saveRecord,
  delete_record: deleteRecord,
  list_folios: listFolios,
  list_demat_holdings: listDematHoldings,
  list_nps_holdings: listNpsHoldings,
  list_investments: listInvestments,
  get_holding_detail: getHoldingDetail,
  get_folio_transactions: getFolioTransactions,
  save_holding_cost: saveHoldingCost,
  get_family_members: getFamilyMembers,
  add_family_member: addFamilyMember,
  delete_family_member: deleteFamilyMember,
  get_categories: getCategories,
  save_category: saveCategory,
  delete_category: deleteCategory,
  get_transactions: getTransactions,
  save_transaction: saveTransaction,
  delete_transaction: deleteTransaction,
  export_backup: exportBackup,
  import_backup: importBackup,
  clear_data: clearData,
  factory_reset: factoryReset,
};

/*
 * The actions that work the lock itself, and so run outside the usual cycle.
 *
 * Every other action is handed an open database and has its writes saved afterwards.
 * Opening the database means decrypting it, which cannot happen until the key is in
 * memory, and saving it means encrypting it, which cannot happen once the key has been
 * dropped. These four sit on the wrong side of that in one direction or the other, so
 * they are given no database and nothing is saved on their behalf.
 *
 * They are listed here rather than flagged on each handler so that everything reachable
 * while the app is locked is one line somebody auditing this can read.
 */
const LOCK_ACTIONS = new Set([
  'vault_status', 'create_vault', 'unlock_vault', 'lock_vault', 'factory_reset',
]);

/** Runs one action and returns its reply. Nothing here throws at the caller. */
export async function handleDbAction(args = {}) {
  try {
    const handler = ACTIONS[args.action];
    if (!handler) return fail('UNKNOWN_ACTION', `Unknown action: ${args.action}`);

    if (LOCK_ACTIONS.has(args.action)) {
      const result = await handler(null, args);
      if (result && result.status === 'error') return result;
      return { status: 'success', ...result };
    }

    /*
     * The one gate. Without it, a locked app answers the first action by trying to decrypt
     * the file with no key, and the caller gets INTERNAL from somewhere deep in the crypto
     * rather than a plain statement that it is locked.
     */
    if (vaultExists() && !isUnlocked()) {
      return fail('LOCKED', 'The app is locked.', 'Enter your PIN to continue.');
    }

    const db = await getDatabase();
    initDb(db);

    const result = await handler(db, args);
    if (result && result.status === 'error') return result;

    // Keeps the readable copy of the rules level with the encrypted one. Cheap, and does
    // nothing at all unless a rule actually moved.
    mirrorConfig(db);
    await db.schedulePersist();
    return { status: 'success', ...result };
  } catch (error) {
    if (error instanceof BackupDecryptError) {
      return fail('BACKUP_DECRYPT_FAILED', error.message,
        'The password must match the one used for the export.');
    }
    if (error instanceof SyntaxError || error instanceof RangeError) {
      return fail('BAD_REQUEST', error.message);
    }

    /*
     * The app was locked while this was still running.
     *
     * Reachable because locking happens on its own schedule: the user puts the phone down
     * mid-import and the database is closed underneath an action that was waiting on a PDF.
     * Whatever the handle threw on the way out is true but useless, and the honest answer
     * is the same one a locked app gives to anything else.
     */
    if (vaultExists() && !isUnlocked()) {
      return fail('LOCKED', 'The app was locked before that finished.',
        'Enter your PIN and try again.');
    }
    return fail('INTERNAL', `${error.name}: ${error.message}`);
  }
}

export { BACKUP_TABLES, DEFAULT_CATEGORIES, DEFAULT_SETTINGS, RECORD_TYPES, deleteDatabase };
