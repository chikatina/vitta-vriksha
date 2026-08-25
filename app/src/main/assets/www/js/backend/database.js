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
import { deleteDatabase, deleteVaultKey, takePendingAlerts, writeAttempts } from './native.js';
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
  calculateDebtPayoffRoadmap, calculateDebtSummary, calculateDtiRatio, calculateHomeLoanPartPayment, getCreditCardOptimizer,
} from './debt_planner.js';
import {
  calculateLifeGoals, calculateNoSpendDays, evaluateChallenge, generateLocalSyncPayload,
  getMonthlyFinanceWrapped,
} from './goals_habits.js';
import {
  processFifoCapitalGains, calculateExactTaxHarvesting, TAX_DISCLAIMER_TEXT, TAX_DISCLAIMER_SHORT,
} from './tax_engine.js';
import { parseBrokerCsv } from './broker_parser.js';
import { getFireProfile, saveFireSettings } from './fire.js';
import { navSearch } from '../../vendor/casparser/isin.js';

/** Settings that must never be handed to the UI. */
const PRIVATE_SETTINGS = new Set(['pin_hash', 'pin_code']);

/**
 * Icons are Material Symbols names. Anything added here has to exist in the subsetted
 * font as well, see tools/subset-material-symbols.py.
 */
const DEFAULT_CATEGORIES = [
  ['Groceries', 'Expense', '#10B981', 'shopping_cart'],
  ['Dining', 'Expense', '#F59E0B', 'restaurant'],
  ['Shopping', 'Expense', '#6366F1', 'shopping_bag'],
  ['Transport', 'Expense', '#8B5CF6', 'directions_car'],
  ['Fuel', 'Expense', '#F59E0B', 'local_gas_station'],
  ['Medical', 'Expense', '#EF4444', 'local_hospital'],
  ['Health', 'Expense', '#EF4444', 'medical_services'],
  ['School', 'Expense', '#F97316', 'school'],
  ['Education', 'Expense', '#F97316', 'menu_book'],
  ['Kids & Baby', 'Expense', '#EC4899', 'child_care'],
  ['Pets', 'Expense', '#10B981', 'pets'],
  ['Fitness', 'Expense', '#06B6D4', 'fitness_center'],
  ['Entertainment', 'Expense', '#14B8A6', 'movie'],
  ['Subscriptions', 'Expense', '#8B5CF6', 'subscriptions'],
  ['Utilities', 'Expense', '#3B82F6', 'bolt'],
  ['Rent & Housing', 'Expense', '#EC4899', 'home'],
  ['Maintenance & Repairs', 'Expense', '#64748B', 'build'],
  ['Personal Care', 'Expense', '#D946EF', 'spa'],
  ['Travel', 'Expense', '#06B6D4', 'flight'],
  ['Gifts & Donations', 'Expense', '#FB7185', 'redeem'],
  ['Insurance & Tax', 'Expense', '#64748B', 'shield'],
  ['Loans & EMI', 'Expense', '#A16207', 'account_balance'],
  ['Investment Outflow', 'Investment', '#059669', 'trending_up'],
  ['Salary', 'Income', '#10B981', 'work'],
  ['Freelance', 'Income', '#3B82F6', 'computer'],
  ['Business Income', 'Income', '#3B82F6', 'storefront'],
  ['Rental Income', 'Income', '#10B981', 'real_estate_agent'],
  ['Interest & Dividends', 'Income', '#F59E0B', 'savings'],
  ['Refunds & Cashback', 'Income', '#8B5CF6', 'receipt_long'],
  ['Gifts Received', 'Income', '#EC4899', 'redeem'],
  ['Other Income', 'Income', '#06B6D4', 'savings'],
  /* Money moving between the household's own pockets: a credit card bill paid from a
     bank account, a transfer between two accounts. It is neither earned nor spent, and
     every total that adds up income or expenditure leaves it out. */
  ['Transfer', 'Transfer', '#78909C', 'arrow_forward'],
  ['Credit Card', 'Transfer', '#F59E0B', 'credit_card'],
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
const SMS_RULES_SEED_VERSION = '7';

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
  ['Toll paid', '', 'toll paid', 'Expense', 'Transport', AMOUNT_PATTERN],
  ['FASTag Recharge', '', 'fastag recharge', 'Expense', 'Transport', AMOUNT_PATTERN],
  ['FASTag Toll', '', 'fastag toll', 'Expense', 'Transport', AMOUNT_PATTERN],
  ['FASTag Debit', '', 'fastag', 'Expense', 'Transport', AMOUNT_PATTERN],
  ['Bill paid', '', 'bill paid', 'Expense', 'Utilities', AMOUNT_PATTERN],
  ['SmartPay bill', '', 'via smartpay', 'Expense', 'Utilities', AMOUNT_PATTERN],
  ['Electricity Bill', '', 'electricity bill', 'Expense', 'Utilities', AMOUNT_PATTERN],
  ['Water Bill', '', 'water bill', 'Expense', 'Utilities', AMOUNT_PATTERN],
  ['Gas Bill', '', 'gas bill', 'Expense', 'Utilities', AMOUNT_PATTERN],
  ['Broadband Bill', '', 'broadband bill', 'Expense', 'Utilities', AMOUNT_PATTERN],
  ['Mobile Recharge', '', 'mobile recharge', 'Expense', 'Utilities', AMOUNT_PATTERN],
  ['DTH Recharge', '', 'dth recharge', 'Expense', 'Utilities', AMOUNT_PATTERN],
  ['UPI AutoPay Bill', '', 'upi autopay', 'Expense', 'Utilities', AMOUNT_PATTERN],
  ['Insurance Premium', '', 'insurance premium', 'Expense', 'Insurance & Tax', AMOUNT_PATTERN],
  ['LIC Premium', '', 'towards lic', 'Expense', 'Insurance & Tax', AMOUNT_PATTERN],
  ['Health Insurance', '', 'health insurance', 'Expense', 'Insurance & Tax', AMOUNT_PATTERN],
  ['Term Insurance', '', 'term insurance', 'Expense', 'Insurance & Tax', AMOUNT_PATTERN],
  ['Tax challan', '', 'challan', 'Expense', 'Insurance & Tax', AMOUNT_PATTERN],
  ['Advance Tax', '', 'advance tax', 'Expense', 'Insurance & Tax', AMOUNT_PATTERN],
  ['Property Tax', '', 'property tax', 'Expense', 'Insurance & Tax', AMOUNT_PATTERN],

  // Investments & Wealth
  ['SIP Debit', '', 'towards sip', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['SIP Installment', '', 'sip installment', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['SIP Instalment', '', 'sip instalment', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['Mutual Fund Purchase', '', 'mutual fund', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['Fund purchase', '', 'in scheme', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['Fund purchase folio', '', 'in folio', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['PPF Deposit', '', 'ppf', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['FD Created', '', 'fd created', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['RD Installment', '', 'rd installment', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['RD Instalment', '', 'rd instalment', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['Zerodha Demat', '', 'towards zerodha', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['Groww Investment', '', 'towards groww', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['Upstox Investment', '', 'towards upstox', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],
  ['AngelOne Investment', '', 'towards angelone', 'Investment', 'Investment Outflow', AMOUNT_PATTERN],

  // Loans, Mandates & EMIs
  ['ECS Debit', '', 'towards ecs', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['ECS Mandate Debit', '', 'ecs debit', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['ECS Mandate', '', 'ecs mandate', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['NACH Mandate', '', 'nach mandate', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['ACH Mandate', '', 'ach mandate', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['NACH Debit', '', 'nach debit', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['ACH Debit', '', 'ach debit', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['Mandate debit', '', 'ach d-', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['Housing Loan EMI', '', 'housing loan', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['Home Loan EMI', '', 'home loan', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['Car Loan EMI', '', 'car loan', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['Auto Loan EMI', '', 'auto loan', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['Personal Loan EMI', '', 'personal loan', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['Gold Loan EMI', '', 'gold loan', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['Education Loan EMI', '', 'education loan', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['Bajaj Finserv EMI', '', 'towards bajaj', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['Tata Capital EMI', '', 'towards tata capital', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['HDB Financial EMI', '', 'towards hdb', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['Muthoot EMI', '', 'towards muthoot', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['DMI Finance EMI', '', 'towards dmi', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['Standing Instruction Debit', '', 'standing instruction', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['EMI debit', '', 'emi', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],

  // Credit Card Bill Payments & Transfers (Money Moved between accounts/cards)
  ['AutoPay CC Bill', '', 'autopay towards credit card', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['Credit Card Bill Payment', '', 'credit card payment', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['Credit Card Bill', '', 'credit card bill', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['Card Bill Payment', '', 'card bill', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['CC Bill Payment', '', 'cc bill', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['CC Payment', '', 'cc payment', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['Payment Towards Credit Card', '', 'towards credit card', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['Payment Towards Card', '', 'towards your credit card', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['Payment For Card', '', 'payment towards card', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['BBPS CC Payment', '', 'bbps cc payment', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['CRED CC Payment', '', 'cred', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['Cheq CC Payment', '', 'cheq', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['SBI Card Payment', '', 'sbi card', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['Card Payment Credited', '', 'credited to your card', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['Card Payment Received', '', 'payment received towards', 'Transfer', 'Credit Card', AMOUNT_PATTERN],
  ['Transfer to Demat', '', 'demat', 'Transfer', 'Transfer', AMOUNT_PATTERN],
  ['Transfer to NPS', '', 'nps', 'Transfer', 'Transfer', AMOUNT_PATTERN],

  // Card spends. The wording is "Spent Rs.220 On HDFC Bank Card", with the amount sitting
  // between the verb and the preposition, so a trigger of "spent on" is a phrase that
  // never actually occurs. The verb on its own is the trigger, and word boundaries are
  // what make that safe.
  ['POS purchase', '', 'pos transaction', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Card spend', '', 'spent', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Card transaction', '', 'transaction of', 'Expense', 'Shopping', AMOUNT_PATTERN],

  // Money leaving an account.
  ['ATM Withdrawal Cash', '', 'atm cash', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['ATM Withdrawal Wdl', '', 'atm wdl', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['UPI sent', '', 'sent rs', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['UPI sent INR', '', 'sent inr', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Account debit', '', 'debited from', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Account debit to', '', 'debited', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Payment deducted', '', 'deducted from', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Cash withdrawal', '', 'withdrawn', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Transfer out', '', 'transferred to', 'Expense', 'Shopping', AMOUNT_PATTERN],

  // Money arriving. A card bill paid off and a wallet topped up also read as a credit,
  // and both are rejected before this point, so nothing here double counts them.
  ['Salary credit', '', 'salary', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Payroll credit', '', 'payroll', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Reimbursement', '', 'reimbursement', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Stipend credit', '', 'stipend', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Bonus credit', '', 'bonus credited', 'Income', 'Bonus & Grants', AMOUNT_PATTERN],
  ['Rental income', '', 'rent credited', 'Income', 'Rental Income', AMOUNT_PATTERN],
  ['Salary deposit', '', 'deposited in', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Account credit', '', 'credited to', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Account credit with', '', 'credited with', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Account credit by', '', 'credited by', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Credit alert', '', 'credit alert', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Money received', '', 'received rs', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Refund', '', 'refunded', 'Income', 'Refunds & Cashback', AMOUNT_PATTERN],
  ['Cashback credit', '', 'cashback', 'Income', 'Refunds & Cashback', AMOUNT_PATTERN],
  ['Reversal credit', '', 'reversal', 'Income', 'Refunds & Cashback', AMOUNT_PATTERN],
  ['Chargeback credit', '', 'chargeback', 'Income', 'Refunds & Cashback', AMOUNT_PATTERN],
  ['FD interest', '', 'fd interest', 'Income', 'Interest & Dividends', AMOUNT_PATTERN],
  ['Savings interest', '', 'savings interest', 'Income', 'Interest & Dividends', AMOUNT_PATTERN],
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
  ['Dividend Credit', '', 'dividend', 'Income', 'Interest & Dividends', AMOUNT_PATTERN],
  ['Interest Credit', '', 'interest credited', 'Income', 'Interest & Dividends', AMOUNT_PATTERN],
  ['Deposit', '', 'deposited', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Credit', '', 'credited', 'Income', 'Salary', AMOUNT_PATTERN],
  ['Debit', '', 'debited', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Deduction', '', 'deducted', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Payment', '', 'paid', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Withdrawal', '', 'withdrawn', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['Purchase', '', 'purchased', 'Expense', 'Shopping', AMOUNT_PATTERN],
  ['EMI & Installment', '', 'installment', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['EMI & Instalment', '', 'instalment', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['Loan EMI Debit', '', 'loan emi', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
  ['NACH Mandate Debit', '', 'nach debit', 'Expense', 'Loans & EMI', AMOUNT_PATTERN],
];

// Application and Database Schema Version tracking
export const APP_VERSION_NAME = '1.0.5';
export const APP_VERSION_CODE = 9;

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
  app_version: APP_VERSION_NAME,
  app_version_code: String(APP_VERSION_CODE),
  schema_version: String(APP_VERSION_CODE),
  // Off by default. Somebody who wants the figures hidden knows it; somebody who opened a
  // finance app to see figures should see them.
  mask_amounts: '0',
  // Which dashboard panels Home shows, in order. Empty means the built-in default.
  home_widgets: '',
  daily_review_reminder_enabled: '1',
  daily_review_reminder_time: '21:00',
};

/**
 * The tables the backup writer and reader may touch. Anything outside this list coming
 * from a backup file is ignored, so a crafted file cannot name arbitrary tables.
 *
 * The order is topological: a table only references tables above it. Insert in this order
 * and delete in reverse, and the foreign keys hold at every statement.
 */
const BACKUP_TABLES = [
  'family_members', 'asset_accounts', 'credit_cards', 'transactions', 'transaction_splits',
  'transaction_cashbacks', 'mf_folios', 'folio_transactions', 'demat_holdings',
  'nps_holdings', 'loans',
  'subscriptions', 'sips', 'goals', 'custom_events', 'custom_categories',
  // What the household taught the app about who it pays, and which alerts it decided to
  // ignore. Both are things the user built up rather than anything derived, so they
  // belong in an export, and a reset that left them behind would not be a reset.
  'sms_rules', 'merchant_rules', 'ignored_alerts', 'ignored_discovered_accounts', 'imported_statements',
  // What a plan has cost over the years, and the suggestions the user turned down. Both
  // describe records above them, and both are things only this household knows.
  'price_changes', 'recurring_dismissed', 'app_settings', 'stock_transactions',
];

/**
 * The uniform record surface: what the UI asks for, which table it lives in, which
 * columns may be written, and the default order.
 */
const RECORD_TYPES = {
  account: ['asset_accounts',
    ['member_id', 'name', 'category', 'institution', 'account_number', 'debit_card_last_4', 'account_type', 'balance',
      'currency', 'interest_rate', 'maturity_date', 'notes', 'linked_holding_type', 'linked_pran'],
    'category, name'],
  loan: ['loans',
    ['member_id', 'name', 'direction', 'loan_type', 'principal_amount',
      'current_outstanding', 'interest_rate', 'tenure_months', 'start_date',
      'monthly_emi', 'notes', 'lender', 'debit_day', 'is_active', 'linked_merchant_key'],
    'name'],
  card: ['credit_cards',
    ['member_id', 'card_name', 'bank', 'last_4', 'total_limit', 'available_limit', 'current_balance',
      'due_date', 'notes', 'linked_merchant_key', 'updated_at'],
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
  stock_transaction: ['stock_transactions',
    ['member_id', 'broker', 'dp_id', 'client_id', 'isin', 'symbol', 'exchange',
      'trade_type', 'trade_date', 'quantity', 'price', 'stt', 'charges', 'order_id',
      'trade_id', 'notes'],
    'trade_date DESC, id DESC'],
};

const RECORD_TYPE_ALIASES = {
  stock_transactions: 'stock_transaction',
  stock_transaction: 'stock_transaction',
  trades: 'stock_transaction',
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
        debit_card_last_4 TEXT DEFAULT '',
        account_type TEXT DEFAULT '',
        balance REAL DEFAULT 0.0,
        currency TEXT DEFAULT 'INR',
        interest_rate REAL DEFAULT 0.0,
        maturity_date TEXT,
        notes TEXT,
        linked_holding_type TEXT DEFAULT '',
        linked_pran TEXT DEFAULT '',
        updated_at TEXT,
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );

    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        account_id INTEGER,
        card_id INTEGER,
        date TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'INR',
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        merchant TEXT,
        merchant_key TEXT,
        description TEXT,
        is_investment_outflow INTEGER DEFAULT 0,
        raw_sms TEXT,
        is_ignored INTEGER DEFAULT 0,
        is_duplicate INTEGER DEFAULT 0,
        created_at TEXT,
        FOREIGN KEY (member_id) REFERENCES family_members(id),
        FOREIGN KEY (account_id) REFERENCES asset_accounts(id),
        FOREIGN KEY (card_id) REFERENCES credit_cards(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_member ON transactions(member_id);
    CREATE INDEX IF NOT EXISTS idx_tx_member_date ON transactions(member_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category);
    CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(type);
    CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_tx_card ON transactions(card_id);
    CREATE INDEX IF NOT EXISTS idx_tx_merchant_key ON transactions(merchant_key);
    CREATE INDEX IF NOT EXISTS idx_tx_date_amount ON transactions(date, amount);

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
        source TEXT DEFAULT '',
        scope TEXT DEFAULT '',
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_folio_scheme_isin
        ON mf_folios(folio_number, scheme_name, isin);

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
        direction TEXT DEFAULT 'borrowed',
        lender TEXT DEFAULT '',
        debit_day INTEGER DEFAULT 5,
        is_active INTEGER DEFAULT 1,
        linked_merchant_key TEXT,
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );

    CREATE TABLE IF NOT EXISTS credit_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        card_name TEXT NOT NULL,
        bank TEXT NOT NULL,
        last_4 TEXT,
        total_limit REAL NOT NULL,
        available_limit REAL DEFAULT NULL,
        current_balance REAL DEFAULT 0.0,
        due_date INTEGER DEFAULT 1,
        notes TEXT,
        linked_merchant_key TEXT,
        updated_at TEXT,
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
        annual_change_percent REAL DEFAULT 0.0,
        price_since TEXT,
        linked_merchant_key TEXT,
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
        start_date TEXT,
        step_up_month INTEGER DEFAULT 0,
        linked_merchant_key TEXT,
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

    CREATE TABLE IF NOT EXISTS ignored_discovered_accounts (
        identifier TEXT PRIMARY KEY,
        issuer TEXT,
        last_4 TEXT,
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

    /* Stock and Demat trade transactions (Buy/Sell, STT, Execution Date) */
    CREATE TABLE IF NOT EXISTS stock_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER DEFAULT 1,
        broker TEXT DEFAULT '',
        dp_id TEXT,
        client_id TEXT,
        isin TEXT NOT NULL,
        symbol TEXT NOT NULL,
        exchange TEXT DEFAULT 'NSE',
        trade_type TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        stt REAL DEFAULT 0.0,
        charges REAL DEFAULT 0.0,
        order_id TEXT,
        trade_id TEXT,
        notes TEXT,
        FOREIGN KEY (member_id) REFERENCES family_members(id)
    );
    CREATE INDEX IF NOT EXISTS idx_stock_txn_isin_date ON stock_transactions(isin, trade_date ASC);
    CREATE INDEX IF NOT EXISTS idx_stock_txn_symbol_date ON stock_transactions(symbol, trade_date ASC);

    CREATE INDEX IF NOT EXISTS idx_accounts_member ON asset_accounts(member_id);
    CREATE INDEX IF NOT EXISTS idx_cards_member ON credit_cards(member_id);
    CREATE INDEX IF NOT EXISTS idx_loans_member ON loans(member_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_member ON subscriptions(member_id);
    CREATE INDEX IF NOT EXISTS idx_sips_member ON sips(member_id);
    CREATE INDEX IF NOT EXISTS idx_goals_member ON goals(member_id);
    CREATE INDEX IF NOT EXISTS idx_custom_events_member ON custom_events(member_id);
    CREATE INDEX IF NOT EXISTS idx_mf_member_isin ON mf_folios(member_id, isin);
    CREATE INDEX IF NOT EXISTS idx_demat_member_isin ON demat_holdings(member_id, isin);
    CREATE INDEX IF NOT EXISTS idx_nps_member ON nps_holdings(member_id);
  `);

  if (Number(db.value('SELECT COUNT(*) FROM family_members')) === 0) {
    db.run(
      "INSERT INTO family_members (name, relationship, avatar_color, is_primary, created_at)"
      + " VALUES ('You', 'Self', '#88A838', 1, ?)",
      [today()],
    );
  }

  if (wasEmpty) {
    // Fresh install: schema is directly at the latest structure. Stamp version metadata.
    runAdditiveMigrations(db);
    setDatabaseVersion(db, APP_VERSION_CODE, APP_VERSION_NAME);
  } else {
    // Existing install: check stored version and run pending migrations sequentially.
    const current = getDatabaseVersion(db);
    if (current.versionCode < APP_VERSION_CODE) {
      runMigrations(db, current.versionCode, APP_VERSION_CODE);
    }
    // Fallback additive safety check to guarantee backward compatibility
    runAdditiveMigrations(db);
    setDatabaseVersion(db, APP_VERSION_CODE, APP_VERSION_NAME);
  }

  for (const row of DEFAULT_CATEGORIES) {
    db.run(
      'INSERT OR IGNORE INTO custom_categories (name, type, color, icon) VALUES (?, ?, ?, ?)',
      row,
    );
  }

  /*
   * The rules coming back after a reset.
   *
   * Done before the seeding below, so a rule the user wrote or renamed wins and the seeder
   * only fills what is genuinely missing. Only on a database that has never been used:
   * anywhere else this would quietly reinstate rules somebody deliberately deleted.
   */
  if (wasEmpty) restoreMirroredConfig(db);

  seedDefaultRules(db);

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', [key, value]);
  }

  schemaReady = true;
}

/**
 * Seeds or updates default SMS rules when SMS_RULES_SEED_VERSION increases.
 */
export function seedDefaultRules(db) {
  const hasRulesTable = Boolean(db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sms_rules'"));
  if (!hasRulesTable) return;

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
}

/**
 * Sequential Schema Migrations registry.
 *
 * Each entry is tagged with its target versionCode and versionName.
 * When upgrading from an older build, migrations are run sequentially in ascending order
 * of versionCode.
 */
export const MIGRATIONS = [
  {
    versionCode: 1,
    versionName: '1.0.0',
    description: 'Initial schema baseline',
    up(db) {
      // Baseline tables created in db.exec()
    },
  },
  {
    versionCode: 2,
    versionName: '1.0.1',
    description: 'Add loan direction, demat & nps invested_value, debit card metadata',
    up(db) {
      addColumnIfMissing(db, 'loans', 'direction', "TEXT DEFAULT 'borrowed'");
      db.run("UPDATE loans SET direction = 'borrowed' WHERE direction IS NULL OR direction = ''");
      addColumnIfMissing(db, 'demat_holdings', 'invested_value', 'REAL DEFAULT 0.0');
      addColumnIfMissing(db, 'nps_holdings', 'invested_value', 'REAL DEFAULT 0.0');
      addColumnIfMissing(db, 'asset_accounts', 'debit_card_last_4', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'asset_accounts', 'account_type', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'custom_categories', 'monthly_budget', 'REAL DEFAULT 0.0');
    },
  },
  {
    versionCode: 3,
    versionName: '1.0.2',
    description: 'Add merchant_key index, SIP start date & step-up, subscription pricing',
    up(db) {
      addColumnIfMissing(db, 'transactions', 'merchant_key', 'TEXT');
      db.run('CREATE INDEX IF NOT EXISTS idx_tx_merchant_key ON transactions(merchant_key)');
      const unkeyed = db.all(
        "SELECT id, merchant FROM transactions WHERE merchant_key IS NULL AND merchant IS NOT NULL AND merchant != ''",
      );
      if (unkeyed.length) {
        for (const row of unkeyed) {
          db.run('UPDATE transactions SET merchant_key = ? WHERE id = ?', [merchantKey(row.merchant), row.id]);
        }
      }
      addColumnIfMissing(db, 'sips', 'start_date', 'TEXT');
      addColumnIfMissing(db, 'sips', 'step_up_month', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'sips', 'linked_merchant_key', 'TEXT');
      addColumnIfMissing(db, 'subscriptions', 'annual_change_percent', 'REAL DEFAULT 0.0');
      addColumnIfMissing(db, 'subscriptions', 'price_since', 'TEXT');
      addColumnIfMissing(db, 'subscriptions', 'linked_merchant_key', 'TEXT');
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
    },
  },
  {
    versionCode: 4,
    versionName: '1.0.3',
    description: 'Add stock transactions, loan lender & active flags, NPS/account linking, statement hashes',
    up(db) {
      addColumnIfMissing(db, 'loans', 'linked_merchant_key', 'TEXT');
      addColumnIfMissing(db, 'loans', 'debit_day', 'INTEGER DEFAULT 5');
      addColumnIfMissing(db, 'loans', 'lender', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'loans', 'is_active', 'INTEGER DEFAULT 1');
      addColumnIfMissing(db, 'asset_accounts', 'linked_holding_type', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'asset_accounts', 'linked_pran', "TEXT DEFAULT ''");

      db.exec(`
        CREATE TABLE IF NOT EXISTS stock_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          member_id INTEGER DEFAULT 1,
          broker TEXT,
          dp_id TEXT,
          client_id TEXT,
          isin TEXT,
          symbol TEXT NOT NULL,
          exchange TEXT DEFAULT 'NSE',
          trade_type TEXT NOT NULL,
          trade_date TEXT NOT NULL,
          quantity REAL NOT NULL,
          price REAL NOT NULL,
          stt REAL DEFAULT 0.0,
          charges REAL DEFAULT 0.0,
          order_id TEXT,
          trade_id TEXT,
          notes TEXT,
          FOREIGN KEY (member_id) REFERENCES family_members(id)
        );
        CREATE INDEX IF NOT EXISTS idx_stock_txn_date ON stock_transactions(trade_date DESC);
        CREATE INDEX IF NOT EXISTS idx_stock_txn_symbol_date ON stock_transactions(symbol, trade_date ASC);
        CREATE TABLE IF NOT EXISTS imported_statements (
          digest TEXT PRIMARY KEY,
          issuer TEXT,
          period_to TEXT,
          imported_at TEXT
        );
        CREATE TABLE IF NOT EXISTS ignored_discovered_accounts (
          identifier TEXT PRIMARY KEY,
          issuer TEXT,
          last_4 TEXT,
          ignored_at TEXT
        );
        CREATE TABLE IF NOT EXISTS ignored_alerts (
          body TEXT PRIMARY KEY,
          ignored_at TEXT
        );
      `);
    },
  },
  {
    versionCode: 5,
    versionName: '1.0.4',
    description: 'Add credit cards available limit & updated_at, transaction card linking & ignore flags',
    up(db) {
      addColumnIfMissing(db, 'credit_cards', 'linked_merchant_key', 'TEXT');
      addColumnIfMissing(db, 'credit_cards', 'available_limit', 'REAL DEFAULT NULL');
      addColumnIfMissing(db, 'credit_cards', 'updated_at', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'transactions', 'card_id', 'INTEGER');
      addColumnIfMissing(db, 'transactions', 'is_ignored', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'transactions', 'is_duplicate', 'INTEGER DEFAULT 0');
      db.run('CREATE INDEX IF NOT EXISTS idx_tx_card ON transactions(card_id);');

      // Category icons cleanup
      for (const category of db.all('SELECT id, icon FROM custom_categories')) {
        const icon = category.icon || '';
        if (!/^[a-z0-9_]+$/.test(icon)) {
          db.run("UPDATE custom_categories SET icon = 'sell' WHERE id = ?", [category.id]);
        }
      }
    },
  },
  {
    versionCode: 6,
    versionName: '1.0.4',
    description: 'Seed robust Indian banking, ECS/mandates, SIP and utility rules',
    up(db) {
      seedDefaultRules(db);
    },
  },
  {
    versionCode: 7,
    versionName: '1.0.4',
    description: 'Enforce backup version limits, restore foreign key safety, and verify biometrics on enablement',
    up(db) {
      seedDefaultRules(db);
    },
  },
  {
    versionCode: 8,
    versionName: '1.0.4',
    description: 'Production hardening: composite indexes, streaming ledger, timezone safety, and architectural documentation',
    up(db) {
      seedDefaultRules(db);
    },
  },
  {
    versionCode: 9,
    versionName: '1.0.5',
    description: 'Discovered accounts weighted scoring, non-destructive debit card linking, and configurable merge balances',
    up(db) {
      seedDefaultRules(db);
    },
  },
];

export function getDatabaseVersion(db) {
  let userVersion = 0;
  try {
    const uvRow = db.get('PRAGMA user_version');
    if (uvRow && Number.isFinite(Number(uvRow.user_version))) {
      userVersion = Number(uvRow.user_version);
    }
  } catch {
    userVersion = 0;
  }

  let appVersionCode = 0;
  let appVersionName = '';
  try {
    const codeRow = db.get("SELECT value FROM app_settings WHERE key = 'app_version_code'");
    if (codeRow && codeRow.value) {
      appVersionCode = Number.parseInt(codeRow.value, 10) || 0;
    }
    const nameRow = db.get("SELECT value FROM app_settings WHERE key = 'app_version'");
    if (nameRow && nameRow.value) {
      appVersionName = nameRow.value;
    }
  } catch {
    // Settings table might not exist yet
  }

  const effectiveCode = appVersionCode || userVersion || 0;
  return {
    versionCode: effectiveCode,
    versionName: appVersionName || (effectiveCode > 0 ? (MIGRATIONS.find((m) => m.versionCode === effectiveCode)?.versionName || `1.0.${Math.max(0, effectiveCode - 1)}`) : ''),
    userVersion,
  };
}

export function setDatabaseVersion(db, versionCode, versionName = '') {
  const code = Number.parseInt(versionCode, 10) || 0;
  const name = versionName || (MIGRATIONS.find((m) => m.versionCode === code)?.versionName) || `1.0.${Math.max(0, code - 1)}`;

  db.run(`PRAGMA user_version = ${code}`);
  db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('app_version_code', ?)", [String(code)]);
  db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('app_version', ?)", [name]);
  db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', ?)", [String(code)]);
  db.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('last_migration_at', ?)", [new Date().toISOString()]);
}

export function runMigrations(db, fromCode, toCode) {
  const pending = MIGRATIONS
    .filter((m) => m.versionCode > fromCode && m.versionCode <= toCode)
    .sort((a, b) => a.versionCode - b.versionCode);

  const applied = [];
  for (const mig of pending) {
    db.transaction(() => {
      mig.up(db);
      setDatabaseVersion(db, mig.versionCode, mig.versionName);
    });
    applied.push({
      versionCode: mig.versionCode,
      versionName: mig.versionName,
      description: mig.description,
    });
  }
  return applied;
}

export function getVersionInfo(db) {
  const dbVer = getDatabaseVersion(db);
  return {
    status: 'success',
    app_version: APP_VERSION_NAME,
    app_version_code: APP_VERSION_CODE,
    db_version: dbVer.versionName || APP_VERSION_NAME,
    db_version_code: dbVer.versionCode,
    user_version: dbVer.userVersion,
    schema_version: dbVer.versionCode,
    is_latest: dbVer.versionCode >= APP_VERSION_CODE,
  };
}

/** Additive migrations safety net, so an install from any older build keeps its data. */
function runAdditiveMigrations(db) {
  const memberTables = ['asset_accounts', 'transactions', 'mf_folios', 'folio_transactions', 'stock_transactions', 'loans', 'credit_cards',
    'subscriptions', 'sips', 'goals', 'custom_events'];
  for (const table of memberTables) {
    addColumnIfMissing(db, table, 'member_id', 'INTEGER DEFAULT 1');
  }
  addColumnIfMissing(db, 'custom_categories', 'monthly_budget', 'REAL DEFAULT 0.0');
  // Rename legacy "Transport & Fuel" category to "Transport"
  db.run("UPDATE custom_categories SET name = 'Transport' WHERE name = 'Transport & Fuel'");
  db.run("UPDATE sms_rules SET category_name = 'Transport' WHERE category_name = 'Transport & Fuel'");
  db.run("UPDATE merchant_rules SET category_name = 'Transport' WHERE category_name = 'Transport & Fuel'");
  db.run("UPDATE transactions SET category = 'Transport' WHERE category = 'Transport & Fuel'");
  // Loans used to be borrowing only. Everything already recorded is money owed.
  addColumnIfMissing(db, 'loans', 'direction', "TEXT DEFAULT 'borrowed'");
  db.run("UPDATE loans SET direction = 'borrowed' WHERE direction IS NULL OR direction = ''");

  // Earlier builds kept the unlock PIN in plain text.
  const legacy = db.get("SELECT value FROM app_settings WHERE key = 'pin_code'");
  if (legacy) {
    db.run("DELETE FROM app_settings WHERE key = 'pin_code'");
  }

  db.run("UPDATE mf_folios SET isin = '' WHERE isin IS NULL");
  db.run('DROP INDEX IF EXISTS idx_folio_scheme');
  addColumnIfMissing(db, 'mf_folios', 'source', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'mf_folios', 'scope', "TEXT DEFAULT ''");
  db.run('CREATE INDEX IF NOT EXISTS idx_folio_scope ON mf_folios(scope)');

  // Clean up duplicate folio transactions
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

  addColumnIfMissing(db, 'demat_holdings', 'invested_value', 'REAL DEFAULT 0.0');
  addColumnIfMissing(db, 'nps_holdings', 'invested_value', 'REAL DEFAULT 0.0');
  addColumnIfMissing(db, 'asset_accounts', 'debit_card_last_4', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'asset_accounts', 'account_type', "TEXT DEFAULT ''");

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

  addColumnIfMissing(db, 'sips', 'start_date', 'TEXT');
  addColumnIfMissing(db, 'sips', 'step_up_month', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'sips', 'linked_merchant_key', 'TEXT');
  addColumnIfMissing(db, 'subscriptions', 'annual_change_percent', 'REAL DEFAULT 0.0');
  addColumnIfMissing(db, 'subscriptions', 'price_since', 'TEXT');
  addColumnIfMissing(db, 'subscriptions', 'linked_merchant_key', 'TEXT');
  addColumnIfMissing(db, 'loans', 'linked_merchant_key', 'TEXT');
  addColumnIfMissing(db, 'loans', 'debit_day', 'INTEGER DEFAULT 5');
  addColumnIfMissing(db, 'loans', 'lender', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'loans', 'is_active', 'INTEGER DEFAULT 1');
  addColumnIfMissing(db, 'credit_cards', 'linked_merchant_key', 'TEXT');
  addColumnIfMissing(db, 'credit_cards', 'available_limit', 'REAL DEFAULT NULL');
  addColumnIfMissing(db, 'credit_cards', 'updated_at', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'asset_accounts', 'linked_holding_type', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'asset_accounts', 'linked_pran', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'transactions', 'card_id', 'INTEGER');
  addColumnIfMissing(db, 'transactions', 'is_ignored', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'transactions', 'is_duplicate', 'INTEGER DEFAULT 0');
  db.run('CREATE INDEX IF NOT EXISTS idx_tx_card ON transactions(card_id);');

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
    + " VALUES ('You', 'Self', '#88A838', 1, ?)",
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

  const prevDb = currentDatabase();
  if (prevDb) {
    try {
      prevDb.close();
    } catch {
      // Nothing to close
    }
  }
  useDatabase(null);
  await deleteDatabase();

  await createVault(pin);

  const db = await Database.open(null);
  useDatabase(db);
  initDb(db, true);
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

  const npsTotal = number(db.value(
    `SELECT SUM(current_value) AS total FROM nps_holdings${clause}`, params,
  ));

  const totals = {};
  for (const row of db.all(
    `SELECT category, linked_holding_type, SUM(balance) AS total FROM asset_accounts${clause} GROUP BY category, linked_holding_type`,
    params,
  )) {
    // Avoid double counting: if linked to NPS, or if category is NPS and NPS holdings exist,
    // npsTotal below will supply the exact market value from holdings.
    if (row.linked_holding_type === 'nps' || (row.category === 'NPS' && npsTotal > 0)) {
      continue;
    }
    totals[row.category] = number(totals[row.category]) + number(row.total);
  }

  const folioTotal = number(db.value(
    `SELECT SUM(current_value) AS total FROM mf_folios${clause}`, params,
  ));
  if (folioTotal) totals.MF = number(totals.MF) + folioTotal;

  const dematTotal = number(db.value(
    `SELECT SUM(current_value) AS total FROM demat_holdings${clause}`, params,
  ));
  if (dematTotal) totals.Demat = number(totals.Demat) + dematTotal;

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
  const [earliestStart] = monthBounds(5);
  const [, currentEnd] = monthBounds(0);
  const [txClause, txParams] = memberClause(memberId, 'AND');

  const monthTotals = new Map();
  for (const row of db.all(
    'SELECT SUBSTR(date, 1, 7) AS month_key, type, category, is_investment_outflow, SUM(amount) AS total FROM transactions'
    + ` WHERE date >= ? AND date < ?${txClause} GROUP BY SUBSTR(date, 1, 7), type, category, is_investment_outflow`,
    [earliestStart, currentEnd, ...txParams],
  )) {
    if (row.type === 'Transfer' || row.category === 'Transfer' || row.category === 'Credit Card') continue;
    const key = row.month_key;
    if (!monthTotals.has(key)) {
      monthTotals.set(key, { income: 0, expense: 0, invested: 0 });
    }
    const bucket = monthTotals.get(key);
    const total = number(row.total);
    if (row.type === 'Income') {
      bucket.income += total;
    } else if ((row.type === 'Investment' || row.is_investment_outflow || row.category === 'Investment Outflow') && excludeInvestments) {
      bucket.invested += total;
    } else {
      bucket.expense += total;
    }
  }

  const months = [];
  for (let offset = 0; offset < 6; offset += 1) {
    const [start] = monthBounds(offset);
    const monthKey = start.slice(0, 7);
    const bucket = monthTotals.get(monthKey) || { income: 0, expense: 0, invested: 0 };
    months.push({ month: monthKey, ...bucket });
  }

  const recent = db.all(
    `SELECT * FROM transactions${clause} ORDER BY date DESC, id DESC LIMIT 8`, params,
  );
  const members = db.all('SELECT * FROM family_members ORDER BY is_primary DESC, id ASC');
  const budget = db.get("SELECT value FROM app_settings WHERE key = 'monthly_budget'");

  const debtSummary = calculateDebtSummary(db, { member_id: args.member_id });

  return {
    net_worth: assets - liabilities,
    total_assets: assets,
    total_liabilities: liabilities,
    asset_totals: totals,
    debt_summary: debtSummary,
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
    + " WHERE date >= ? AND type != 'Income' AND type != 'Transfer' AND type != 'Investment' AND category != 'Transfer' AND category != 'Credit Card' AND category != 'Investment Outflow' AND COALESCE(is_investment_outflow, 0) = 0"
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
    const inst = String(record.institution || '').trim();
    const accNum = record.account_number ? String(record.account_number).trim() : '';
    const dcLast4 = record.debit_card_last_4 ? String(record.debit_card_last_4).trim() : '';

    if (accNum) {
      const last4 = accNum.slice(-4);
      db.run(
        "UPDATE transactions SET account_id = ? WHERE (account_id IS NULL OR account_id = 0) AND raw_sms LIKE '%' || ? || '%'",
        [recordId, accNum],
      );
      if (last4 && last4.length >= 4) {
        db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
          [`account:${inst}:${last4}`.toLowerCase(), inst, last4, new Date().toISOString()]);
        db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
          [`bank_account:${inst}:${last4}`.toLowerCase(), inst, last4, new Date().toISOString()]);
        db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
          [`${inst}:${last4}`.toLowerCase(), inst, last4, new Date().toISOString()]);
        db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
          [last4.toLowerCase(), inst, last4, new Date().toISOString()]);
      }
    }
    if (dcLast4) {
      const dcDigits = dcLast4.slice(-4);
      db.run(
        "UPDATE transactions SET account_id = ? WHERE (account_id IS NULL OR account_id = 0) AND raw_sms LIKE '%' || ? || '%'",
        [recordId, dcDigits],
      );
      if (dcDigits && dcDigits.length >= 4) {
        db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
          [`debit_card:${inst}:${dcDigits}`.toLowerCase(), inst, dcDigits, new Date().toISOString()]);
        db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
          [`${inst}:${dcDigits}`.toLowerCase(), inst, dcDigits, new Date().toISOString()]);
        db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
          [dcDigits.toLowerCase(), inst, dcDigits, new Date().toISOString()]);
      }
    }

    // Auto-detect balance from transactions if not explicitly set / is 0
    const currentAcc = db.get('SELECT balance FROM asset_accounts WHERE id = ?', [recordId]);
    if (!currentAcc?.balance || Number(currentAcc.balance) === 0) {
      const matchPats = [accNum ? accNum.slice(-4) : '', dcLast4 ? dcLast4.slice(-4) : ''].filter((p) => p && p.length >= 4);
      for (const pat of matchPats) {
        const matchingTxns = db.all(
          "SELECT raw_sms FROM transactions WHERE raw_sms IS NOT NULL AND raw_sms != '' AND raw_sms LIKE '%' || ? || '%' ORDER BY date DESC, id DESC LIMIT 50",
          [pat],
        );
        for (const m of matchingTxns) {
          const detectedBal = extractAccountBalanceFromText(m.raw_sms);
          if (detectedBal !== null && detectedBal !== undefined && detectedBal > 0) {
            db.run('UPDATE asset_accounts SET balance = ? WHERE id = ?', [detectedBal, recordId]);
            break;
          }
        }
      }
    }
  } else if (table === 'credit_cards') {
    db.run('UPDATE credit_cards SET updated_at = ? WHERE id = ?', [new Date().toISOString(), recordId]);
    const bank = String(record.bank || '').trim();
    if (record.last_4) {
      const last4 = String(record.last_4).trim().slice(-4);
      if (last4 && last4.length >= 4) {
        db.run(
          "UPDATE transactions SET card_id = ? WHERE (card_id IS NULL OR card_id = 0) AND raw_sms LIKE '%' || ? || '%'",
          [recordId, last4],
        );
        db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
          [`credit_card:${bank}:${last4}`.toLowerCase(), bank, last4, new Date().toISOString()]);
        db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
          [`card:${bank}:${last4}`.toLowerCase(), bank, last4, new Date().toISOString()]);
        db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
          [`${bank}:${last4}`.toLowerCase(), bank, last4, new Date().toISOString()]);
        db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
          [last4.toLowerCase(), bank, last4, new Date().toISOString()]);
      }
    }
  }
  return { record_id: recordId };
}

function deleteRecord(db, args) {
  const spec = resolveRecordType(args);
  if (!spec) return fail('RECORD_TYPE_UNKNOWN', 'That kind of record does not exist.');

  if (spec[0] === 'asset_accounts') {
    db.run('UPDATE transactions SET account_id = NULL WHERE account_id = ?', [args.record_id]);
  } else if (spec[0] === 'credit_cards') {
    db.run('UPDATE transactions SET card_id = NULL WHERE card_id = ?', [args.record_id]);
  }
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

/** Links or unlinks an NPS asset account to imported NPS pension holdings. */
function linkNpsAccount(db, args = {}) {
  const memberId = resolveMemberId(db, args.member_id);
  const pran = String(args.pran || '').trim();
  const accountId = args.account_id;
  const unlink = Boolean(args.unlink);

  const [clause, params] = memberClause(memberId);
  const npsHoldings = db.all(
    `SELECT * FROM nps_holdings${clause}${pran ? `${clause ? ' AND' : ' WHERE'} pran = ?` : ''}`,
    pran ? [...params, pran] : params,
  );
  const totalNpsVal = npsHoldings.reduce((sum, h) => sum + number(h.current_value), 0);

  if (unlink && accountId) {
    db.run("UPDATE asset_accounts SET linked_holding_type = '', linked_pran = '' WHERE id = ?", [Number(accountId)]);
    return { status: 'success', unlinked: true, account_id: Number(accountId) };
  }

  let targetAccountId = Number(accountId);
  if (targetAccountId > 0) {
    db.run(
      "UPDATE asset_accounts SET linked_holding_type = 'nps', linked_pran = ?, category = 'NPS', balance = ?, updated_at = ? WHERE id = ?",
      [pran, totalNpsVal, today(), targetAccountId],
    );
  } else {
    // Create new linked NPS account
    const name = String(args.name || (pran ? `NPS (${pran})` : 'NPS Portfolio')).trim();
    const inst = String(args.institution || 'CRA-NSDL / PFRDA').trim();
    targetAccountId = db.run(
      "INSERT INTO asset_accounts (member_id, name, category, institution, account_number, balance, linked_holding_type, linked_pran, notes, updated_at)"
      + " VALUES (?, ?, 'NPS', ?, ?, ?, 'nps', ?, 'Linked to CAS NPS Holdings', ?)",
      [memberId, name, inst, pran, totalNpsVal, pran, today()],
    ).lastInsertRowid;
  }

  return {
    status: 'success',
    account_id: targetAccountId,
    pran,
    balance: totalNpsVal,
    schemes_count: npsHoldings.length,
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
    let inv = number(holding.invested_value);
    if (inv <= 0) {
      const stockCost = db.value(
        `SELECT SUM(quantity * price) FROM stock_transactions WHERE (isin = ? OR symbol = ?) AND trade_type = 'BUY'${clause}`,
        [holding.isin, holding.symbol || holding.isin, ...params],
      );
      if (stockCost && number(stockCost) > 0) {
        inv = number(stockCost);
      }
    }

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
      invested: inv,
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
  const symbol = String(args.symbol || '').trim();
  if (!isin && !folio && !symbol) return fail('BAD_REQUEST', 'Which holding was not given.');

  const [clause, params] = memberClause(args.member_id, 'AND');
  const folioLines = db.all(
    `SELECT * FROM folio_transactions WHERE (isin = ? OR folio_number = ?)${clause}`
    + ' ORDER BY date DESC, id DESC',
    [isin, folio, ...params],
  );

  const stockLines = db.all(
    `SELECT id, member_id, isin, symbol, trade_date AS date, trade_type AS kind, quantity AS units, price, (quantity * price) AS amount, stt, charges, notes AS description, 'equity' AS asset_class FROM stock_transactions WHERE (isin = ? OR symbol = ?)${clause} ORDER BY trade_date DESC, id DESC`,
    [isin, symbol || folio || isin, ...params],
  );

  const lines = folioLines.length ? folioLines : stockLines;

  let invested = 0;
  let redeemed = 0;
  let unitsBought = 0;
  for (const line of lines) {
    const amount = number(line.amount);
    const kind = String(line.kind || '').toUpperCase();
    const isSell = kind.includes('SELL') || kind.includes('REDEMPTION') || amount < 0;
    // A registrar writes a purchase positive and a redemption negative, and a dividend
    // payout carries money without units. Only what bought units counts as invested.
    if (!isSell && number(line.units) > 0 && amount > 0) {
      invested += amount;
      unitsBought += number(line.units);
    } else if (isSell) {
      redeemed += Math.abs(amount);
    }
  }

  // Calculate lot-level holding periods and LTCG maturity
  const allTxns = [...folioLines, ...stockLines];
  const processed = processFifoCapitalGains(allTxns, {
    asOfDate: today(),
    fmvLookup: (code) => {
      try {
        const val = navSearch(code);
        return val ? Number(val.toString()) : 0;
      } catch {
        return 0;
      }
    },
  });

  return {
    transactions: lines,
    counted: lines.length,
    invested_from_history: invested,
    redeemed_from_history: redeemed,
    average_cost: unitsBought > 0 ? invested / unitsBought : 0,
    first_seen: lines.length ? lines[lines.length - 1].date : '',
    last_seen: lines.length ? lines[0].date : '',
    active_tax_lots: processed.activeLots,
    tax_lots_summary: processed.activeSummary,
    disclaimer: TAX_DISCLAIMER_TEXT,
    disclaimer_short: TAX_DISCLAIMER_SHORT,
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

function addStockTransaction(db, args) {
  const memberId = resolveMemberId(db, args.member_id);
  const isin = String(args.isin || '').trim().toUpperCase();
  const symbol = String(args.symbol || '').trim().toUpperCase();
  const tradeType = String(args.trade_type || 'BUY').trim().toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const tradeDate = String(args.trade_date || today()).slice(0, 10);
  const quantity = Math.abs(number(args.quantity));
  const price = Math.abs(number(args.price));
  const broker = String(args.broker || '');
  const exchange = String(args.exchange || 'NSE').trim().toUpperCase();
  const stt = Math.abs(number(args.stt || 0));
  const charges = Math.abs(number(args.charges || 0));
  const orderId = String(args.order_id || '');
  const tradeId = String(args.trade_id || '');
  const notes = String(args.notes || '');

  if (!symbol && !isin) return fail('BAD_REQUEST', 'Symbol or ISIN is required for a stock transaction.');
  if (quantity <= 0) return fail('AMOUNT_INVALID', 'Quantity must be greater than zero.');
  if (price <= 0) return fail('AMOUNT_INVALID', 'Price must be greater than zero.');

  const res = db.run(
    'INSERT INTO stock_transactions (member_id, broker, dp_id, client_id, isin, symbol, exchange, trade_type, trade_date, quantity, price, stt, charges, order_id, trade_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [memberId, broker, args.dp_id || '', args.client_id || '', isin, symbol, exchange, tradeType, tradeDate, quantity, price, stt, charges, orderId, tradeId, notes],
  );
  return { id: res.lastInsertRowid };
}

function updateStockTransaction(db, args) {
  const id = Number(args.id);
  if (!id) return fail('BAD_REQUEST', 'Transaction id is required.');
  const existing = db.get('SELECT id FROM stock_transactions WHERE id = ?', [id]);
  if (!existing) return fail('RECORD_NOT_FOUND', 'Stock transaction not found.');

  const updates = [];
  const params = [];
  if (args.trade_type !== undefined) {
    updates.push('trade_type = ?');
    params.push(String(args.trade_type).toUpperCase() === 'SELL' ? 'SELL' : 'BUY');
  }
  if (args.trade_date !== undefined) {
    updates.push('trade_date = ?');
    params.push(String(args.trade_date).slice(0, 10));
  }
  if (args.quantity !== undefined) {
    updates.push('quantity = ?');
    params.push(Math.abs(number(args.quantity)));
  }
  if (args.price !== undefined) {
    updates.push('price = ?');
    params.push(Math.abs(number(args.price)));
  }
  if (args.isin !== undefined) {
    updates.push('isin = ?');
    params.push(String(args.isin).trim().toUpperCase());
  }
  if (args.symbol !== undefined) {
    updates.push('symbol = ?');
    params.push(String(args.symbol).trim().toUpperCase());
  }
  if (args.exchange !== undefined) {
    updates.push('exchange = ?');
    params.push(String(args.exchange).trim().toUpperCase());
  }
  if (args.broker !== undefined) {
    updates.push('broker = ?');
    params.push(String(args.broker));
  }
  if (args.stt !== undefined) {
    updates.push('stt = ?');
    params.push(Math.abs(number(args.stt)));
  }
  if (args.charges !== undefined) {
    updates.push('charges = ?');
    params.push(Math.abs(number(args.charges)));
  }
  if (args.notes !== undefined) {
    updates.push('notes = ?');
    params.push(String(args.notes));
  }

  if (updates.length > 0) {
    db.run(`UPDATE stock_transactions SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);
  }
  return { id };
}

function deleteStockTransaction(db, args) {
  const id = Number(args.id);
  if (!id) return fail('BAD_REQUEST', 'Transaction id is required.');
  db.run('DELETE FROM stock_transactions WHERE id = ?', [id]);
  return { id };
}

function listStockTransactions(db, args = {}) {
  const [clause, params] = memberClause(args.member_id);
  const filters = [];
  const sqlParams = [...params];

  if (args.isin) {
    filters.push('isin = ?');
    sqlParams.push(String(args.isin).trim().toUpperCase());
  }
  if (args.symbol) {
    filters.push('symbol = ?');
    sqlParams.push(String(args.symbol).trim().toUpperCase());
  }
  if (args.trade_type) {
    filters.push('trade_type = ?');
    sqlParams.push(String(args.trade_type).trim().toUpperCase());
  }
  if (args.from) {
    filters.push('trade_date >= ?');
    sqlParams.push(String(args.from).slice(0, 10));
  }
  if (args.to) {
    filters.push('trade_date <= ?');
    sqlParams.push(String(args.to).slice(0, 10));
  }

  const where = [clause.replace(/^\s*WHERE\s*/i, ''), ...filters].filter(Boolean);
  const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const rows = db.all(`SELECT * FROM stock_transactions${whereClause} ORDER BY trade_date DESC, id DESC`, sqlParams);
  return { transactions: rows, count: rows.length };
}

function importStockTransactions(db, args = {}) {
  let list = [];
  const memberId = resolveMemberId(db, args.member_id);
  const broker = args.broker || 'Broker';

  if (args.csv_text) {
    const parsed = parseBrokerCsv(args.csv_text, broker);
    if (parsed.status === 'error') return parsed;
    list = parsed.transactions;
  } else if (Array.isArray(args.transactions)) {
    list = args.transactions;
  } else {
    return fail('BAD_REQUEST', 'No CSV text or transaction list provided.');
  }

  let imported = 0;
  let skipped = 0;

  db.transaction(() => {
    for (const item of list) {
      const isin = String(item.isin || '').trim().toUpperCase();
      const symbol = String(item.symbol || '').trim().toUpperCase();
      const date = String(item.trade_date || item.date || '').slice(0, 10);
      const qty = Math.abs(number(item.quantity ?? item.units));
      const price = Math.abs(number(item.price));
      const type = String(item.trade_type || item.type || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

      if (!date || (!isin && !symbol) || qty <= 0 || price <= 0) {
        skipped += 1;
        continue;
      }

      // Check for duplicate
      const existing = db.get(
        'SELECT id FROM stock_transactions WHERE member_id = ? AND trade_date = ? AND trade_type = ? AND ABS(quantity - ?) < 0.001 AND ABS(price - ?) < 0.01 AND (isin = ? OR symbol = ?)',
        [memberId, date, type, qty, price, isin, symbol],
      );
      if (existing) {
        skipped += 1;
        continue;
      }

      db.run(
        'INSERT INTO stock_transactions (member_id, broker, dp_id, client_id, isin, symbol, exchange, trade_type, trade_date, quantity, price, stt, charges, order_id, trade_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [memberId, item.broker || broker, item.dp_id || '', item.client_id || '', isin, symbol, item.exchange || 'NSE', type, date, qty, price, item.stt || 0, item.charges || 0, item.order_id || '', item.trade_id || '', item.notes || ''],
      );
      imported += 1;
    }
  });

  return {
    status: 'success',
    imported_count: imported,
    skipped_count: skipped,
  };
}

function getCapitalGainsReport(db, args = {}) {
  const [clause, params] = memberClause(args.member_id);
  const folioTxns = db.all(
    `SELECT id, member_id, folio_number, isin, scheme_name AS name, date, kind, amount, units, nav AS price, 'equity' AS asset_class FROM folio_transactions${clause}`,
    params,
  );
  const stockTxns = db.all(
    `SELECT id, member_id, isin, symbol, symbol AS name, trade_date AS date, trade_type AS kind, (quantity * price) AS amount, quantity AS units, price, stt, charges, 'equity' AS asset_class FROM stock_transactions${clause}`,
    params,
  );

  const combined = [...folioTxns, ...stockTxns];
  const report = processFifoCapitalGains(combined, {
    asOfDate: args.as_of_date || today(),
    fmvLookup: (isin) => {
      try {
        const val = navSearch(isin);
        return val ? Number(val.toString()) : 0;
      } catch {
        return 0;
      }
    },
  });

  return report;
}

function getHoldingTaxLots(db, args = {}) {
  const isin = String(args.isin || '').trim();
  const symbol = String(args.symbol || '').trim();
  const folio = String(args.folio_number || '').trim();
  if (!isin && !symbol && !folio) return fail('BAD_REQUEST', 'Which holding was not given.');

  const [clause, params] = memberClause(args.member_id, 'AND');
  const folioTxns = db.all(
    `SELECT id, member_id, folio_number, isin, scheme_name AS name, date, kind, amount, units, nav AS price, 'equity' AS asset_class FROM folio_transactions WHERE (isin = ? OR folio_number = ?)${clause}`,
    [isin, folio, ...params],
  );
  const stockTxns = db.all(
    `SELECT id, member_id, isin, symbol, symbol AS name, trade_date AS date, trade_type AS kind, (quantity * price) AS amount, quantity AS units, price, stt, charges, 'equity' AS asset_class FROM stock_transactions WHERE (isin = ? OR symbol = ?)${clause}`,
    [isin, symbol || isin, ...params],
  );

  const combined = [...folioTxns, ...stockTxns];
  const processed = processFifoCapitalGains(combined, {
    asOfDate: args.as_of_date || today(),
    fmvLookup: (code) => {
      try {
        const val = navSearch(code);
        return val ? Number(val.toString()) : 0;
      } catch {
        return 0;
      }
    },
  });

  return {
    status: 'success',
    disclaimer: TAX_DISCLAIMER_TEXT,
    disclaimerShort: TAX_DISCLAIMER_SHORT,
    holding: { isin, symbol, folio },
    active_lots: processed.activeLots,
    summary: processed.activeSummary,
  };
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
      [member.name.trim(), member.relationship ?? 'Self', member.avatar_color ?? '#88A838',
        member.notes ?? '', today()],
    );
    return { member_id: created.lastInsertRowid };
  }
  const result = db.run(
    'INSERT INTO family_members (name, relationship, avatar_color, is_primary, notes, created_at)'
    + ' VALUES (?, ?, ?, 0, ?, ?)',
    [member.name.trim(), member.relationship ?? 'Other', member.avatar_color ?? '#88A838',
      member.notes ?? '', today()],
  );
  return { member_id: result.lastInsertRowid };
}

function deleteFamilyMember(db, args) {
  const primaryId = Number(db.value('SELECT id FROM family_members WHERE is_primary = 1 ORDER BY id LIMIT 1') || 1);
  const memberId = Number(args.member_id);
  if (memberId === primaryId) {
    return fail('MEMBER_PRIMARY', 'The primary profile cannot be removed.');
  }

  const tablesWithMember = [
    'asset_accounts', 'transactions', 'mf_folios', 'folio_transactions', 'loans',
    'credit_cards', 'subscriptions', 'sips', 'goals', 'custom_events',
    'demat_holdings', 'nps_holdings', 'stock_transactions',
  ];
  db.transaction(() => {
    for (const table of tablesWithMember) {
      db.run(`UPDATE ${table} SET member_id = ? WHERE member_id = ?`, [primaryId, memberId]);
    }
    const result = db.run('DELETE FROM family_members WHERE id = ? AND is_primary = 0', [memberId]);
    if (result.changes === 0) {
      throw new Error('MEMBER_DELETE_FAILED');
    }
  });
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
      [name, category.type ?? 'Expense', category.color ?? '#88A838',
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
    [name, category.type ?? 'Expense', category.color ?? '#88A838',
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
    filters.push('t.member_id = ?');
    params.push(...memberParams);
  }
  if (args.from) {
    filters.push('t.date >= ?');
    params.push(String(args.from).slice(0, 10));
  }
  if (args.to) {
    // Exclusive, so a bucket range from the analytics side can be passed straight through.
    filters.push('t.date < ?');
    params.push(String(args.to).slice(0, 10));
  }
  if (args.category) {
    filters.push('t.category = ?');
    params.push(String(args.category));
  }
  if (args.merchant) {
    filters.push("lower(COALESCE(t.merchant, '')) = ?");
    params.push(String(args.merchant).toLowerCase());
  }
  if (args.merchant_key) {
    filters.push('t.merchant_key = ?');
    params.push(String(args.merchant_key));
  }
  if (args.account_id) {
    filters.push('t.account_id = ?');
    params.push(Number(args.account_id));
  }
  if (args.card_id) {
    filters.push('t.card_id = ?');
    params.push(Number(args.card_id));
  }
  if (args.weekday !== undefined && args.weekday !== null && args.weekday !== '') {
    // SQLite counts weekdays from Sunday, the same way JavaScript does.
    filters.push("CAST(strftime('%w', t.date) AS INTEGER) = ?");
    params.push(Number.parseInt(args.weekday, 10));
  }
  const excludeInvestments = isExcludingInvestments(db);
  if (args.flow === 'spend') {
    filters.push(excludeInvestments
      ? "t.type != 'Income' AND t.type != 'Transfer' AND t.type != 'Investment' AND t.category != 'Transfer' AND t.category != 'Credit Card' AND t.category != 'Investment Outflow' AND COALESCE(t.is_investment_outflow, 0) = 0"
      : "t.type != 'Income' AND t.type != 'Transfer' AND t.category != 'Transfer' AND t.category != 'Credit Card'");
  } else if (args.flow === 'income') {
    filters.push("t.type = 'Income' AND t.category != 'Transfer' AND t.category != 'Credit Card'");
  } else if (args.flow === 'invest') {
    filters.push("t.type != 'Transfer' AND t.category != 'Transfer' AND t.category != 'Credit Card' AND (COALESCE(t.is_investment_outflow, 0) = 1 OR t.type = 'Investment' OR t.category = 'Investment Outflow')");
  } else if (args.flow === 'transfer') {
    filters.push("(t.type = 'Transfer' OR t.category = 'Transfer' OR t.category = 'Credit Card')");
  } else if (args.type) {
    filters.push('t.type = ?');
    params.push(String(args.type));
  }
  if (args.search) {
    filters.push("(lower(COALESCE(t.merchant, '')) LIKE ? OR lower(COALESCE(t.description, '')) LIKE ?"
      + " OR lower(t.category) LIKE ? OR lower(COALESCE(a.name, '')) LIKE ? OR lower(COALESCE(c.card_name, '')) LIKE ?"
      + " OR COALESCE(c.last_4, '') LIKE ? OR COALESCE(a.account_number, '') LIKE ?)");
    const needle = `%${String(args.search).toLowerCase()}%`;
    params.push(needle, needle, needle, needle, needle, needle, needle);
  }
  if (args.show_ignored || args.filter === 'ignored') {
    filters.push('(COALESCE(t.is_ignored, 0) = 1 OR COALESCE(t.is_duplicate, 0) = 1)');
  } else if (!args.include_ignored) {
    filters.push('COALESCE(t.is_ignored, 0) = 0 AND COALESCE(t.is_duplicate, 0) = 0');
  }

  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(2000, Number.parseInt(args.limit ?? 250, 10) || 250));
  const transactions = db.all(
    `SELECT t.*,
      a.name AS account_name,
      a.account_number AS account_number,
      a.category AS account_category,
      a.institution AS account_institution,
      c.card_name AS card_name,
      c.bank AS card_bank,
      c.last_4 AS card_last_4
    FROM transactions t
    LEFT JOIN asset_accounts a ON t.account_id = a.id
    LEFT JOIN credit_cards c ON t.card_id = c.id
    ${where} ORDER BY t.date DESC, t.id DESC LIMIT ?`,
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
    if (transaction.type === 'Transfer' || transaction.category === 'Transfer' || transaction.category === 'Credit Card') continue;
    if (transaction.type === 'Income') totals.income += value;
    else if ((transaction.type === 'Investment' || transaction.is_investment_outflow || transaction.category === 'Investment Outflow') && excludeInvestments) totals.invested += value;
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

  let txType = transactionType;
  if (!txType && (category === 'Credit Card' || category === 'Transfer')) {
    txType = 'Transfer';
  }

  db.run(
    'INSERT INTO merchant_rules (merchant_key, category_name, transaction_type, display_name,'
    + ' source, hits, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)'
    + ' ON CONFLICT(merchant_key) DO UPDATE SET category_name = excluded.category_name,'
    + ' transaction_type = excluded.transaction_type, display_name = excluded.display_name,'
    + ' source = excluded.source, updated_at = excluded.updated_at',
    [key, category, txType, String(merchant).trim(), 'user', new Date().toISOString()],
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
  if (txType) {
    const isInvest = isInvestOutflow || txType === 'Investment' || category === 'Investment Outflow' ? 1 : 0;
    const isIgnored = txType === 'Ignore' || category === 'Ignore' ? 1 : 0;
    db.run('UPDATE transactions SET type = ?, is_investment_outflow = ?, is_ignored = ? WHERE merchant_key = ?', [txType, isInvest, isIgnored, key]);
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
  const isIgnored = transaction.is_ignored || transaction.type === 'Ignore' || transaction.category === 'Ignore' ? 1 : 0;
  const isDuplicate = transaction.is_duplicate ? 1 : 0;
  const rawSms = String(transaction.raw_sms ?? '');

  let txType = transaction.type;
  if (!txType) {
    if (transaction.category === 'Credit Card' || transaction.category === 'Transfer') {
      txType = 'Transfer';
    } else if (isInvest) {
      txType = 'Investment';
    } else {
      txType = 'Expense';
    }
  } else if (transaction.category === 'Credit Card' && txType === 'Expense') {
    txType = 'Transfer';
  }

  let accountId = transaction.account_id !== undefined && transaction.account_id !== null ? Number(transaction.account_id) : null;
  let cardId = transaction.card_id !== undefined && transaction.card_id !== null ? Number(transaction.card_id) : null;

  if (!accountId && !cardId && rawSms) {
    const resolved = resolveAccountAndCardFromSms(db, rawSms, transaction.sender || '', { memberId: transaction.member_id });
    accountId = resolved.account_id;
    cardId = resolved.card_id;
  }
  if (cardId && rawSms) {
    autoUpdateCreditCardFromSms(db, rawSms, transaction.sender || '', cardId);
  }

  const values = [
    resolveMemberId(db, transaction.member_id),
    accountId,
    cardId,
    transaction.date || today(),
    amount,
    transaction.currency || currentCurrency(db),
    txType,
    transaction.category ?? 'Groceries',
    merchant,
    transaction.description ?? '',
    isInvest,
    rawSms,
    isIgnored,
    isDuplicate,
  ];

  let oldTx = null;
  let transactionId = transaction.id;
  if (transactionId) {
    oldTx = db.get('SELECT id, account_id, card_id, amount, type FROM transactions WHERE id = ?', [transactionId]);
    db.run(
      'UPDATE transactions SET member_id = ?, account_id = ?, card_id = ?, date = ?, amount = ?,'
      + ' currency = ?, type = ?, category = ?, merchant = ?,'
      + ' description = ?, is_investment_outflow = ?, raw_sms = ?,'
      + ' is_ignored = ?, is_duplicate = ? WHERE id = ?',
      [...values, transactionId],
    );
    db.run('DELETE FROM transaction_splits WHERE transaction_id = ?', [transactionId]);
    db.run('DELETE FROM transaction_cashbacks WHERE transaction_id = ?', [transactionId]);
  } else {
    const result = db.run(
      'INSERT INTO transactions (member_id, account_id, card_id, date, amount, currency, type,'
      + ' category, merchant, description, is_investment_outflow, raw_sms,'
      + ' is_ignored, is_duplicate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [...values, new Date().toISOString()],
    );
    transactionId = result.lastInsertRowid;
  }

  // Update account / card balances
  let handledBySms = false;
  if (accountId && rawSms) {
    const updated = autoUpdateAccountFromSms(db, rawSms, transaction.sender || '', accountId);
    if (updated) handledBySms = true;
  }
  if (cardId && rawSms) {
    const updated = autoUpdateCreditCardFromSms(db, rawSms, transaction.sender || '', cardId);
    if (updated) handledBySms = true;
  }

  if (!handledBySms) {
    if (accountId) {
      const acc = db.get('SELECT id, balance FROM asset_accounts WHERE id = ?', [accountId]);
      if (acc) {
        let currentBal = Number(acc.balance) || 0;
        if (oldTx) {
          const oldAmt = Number(oldTx.amount) || 0;
          if (oldTx.type === 'Income' || oldTx.type === 'credit') currentBal -= oldAmt;
          else currentBal += oldAmt;
        }
        if (amount > 0) {
          if (txType === 'Income' || txType === 'credit') currentBal += amount;
          else currentBal -= amount;
        }
        db.run('UPDATE asset_accounts SET balance = ?, updated_at = ? WHERE id = ?', [currentBal, new Date().toISOString(), accountId]);
      }
    }
    if (cardId) {
      const card = db.get('SELECT id, current_balance, total_limit, available_limit FROM credit_cards WHERE id = ?', [cardId]);
      if (card) {
        let curBal = Number(card.current_balance) || 0;
        if (oldTx) {
          const oldAmt = Number(oldTx.amount) || 0;
          if (oldTx.type === 'Transfer' || oldTx.type === 'credit') curBal += oldAmt;
          else curBal = Math.max(0, curBal - oldAmt);
        }
        if (amount > 0) {
          if (txType === 'Transfer' || txType === 'credit') curBal = Math.max(0, curBal - amount);
          else curBal += amount;
        }
        let newAvail = card.available_limit;
        if (card.total_limit > 0) {
          newAvail = Math.max(0, card.total_limit - curBal);
        }
        db.run('UPDATE credit_cards SET current_balance = ?, available_limit = ?, updated_at = ? WHERE id = ?', [curBal, newAvail, new Date().toISOString(), cardId]);
      }
    }
  }

  // Naming a category for a named vendor is the teaching moment. It is only taken when
  // the caller actually wanted to update the rule for all transactions from this merchant.
  let learned = { merchant_key: merchantKey(merchant), applied: 0 };
  const shouldApplyToAll = transaction.apply_to_all === true
    || (transaction.apply_to_all !== false && !transaction.override_single && !transaction.id);
  if (merchant && transaction.category && shouldApplyToAll) {
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
  const tx = db.get('SELECT id, account_id, card_id, amount, type FROM transactions WHERE id = ?', [args.transaction_id]);
  if (tx) {
    if (tx.account_id) {
      const acc = db.get('SELECT balance FROM asset_accounts WHERE id = ?', [tx.account_id]);
      if (acc) {
        let bal = Number(acc.balance) || 0;
        const amt = Number(tx.amount) || 0;
        if (tx.type === 'Income' || tx.type === 'credit') bal -= amt;
        else bal += amt;
        db.run('UPDATE asset_accounts SET balance = ?, updated_at = ? WHERE id = ?', [bal, new Date().toISOString(), tx.account_id]);
      }
    }
    if (tx.card_id) {
      const card = db.get('SELECT current_balance, total_limit, available_limit FROM credit_cards WHERE id = ?', [tx.card_id]);
      if (card) {
        let curBal = Number(card.current_balance) || 0;
        const amt = Number(tx.amount) || 0;
        if (tx.type === 'Transfer' || tx.type === 'credit') curBal += amt;
        else curBal = Math.max(0, curBal - amt);
        let newAvail = card.available_limit;
        if (card.total_limit > 0) {
          newAvail = Math.max(0, card.total_limit - curBal);
        }
        db.run('UPDATE credit_cards SET current_balance = ?, available_limit = ?, updated_at = ? WHERE id = ?', [curBal, newAvail, new Date().toISOString(), tx.card_id]);
      }
    }
    db.run('DELETE FROM transactions WHERE id = ?', [args.transaction_id]);
  }
  return {};
}

function splitTransaction(db, args) {
  const originalId = args.transaction_id;
  const splits = args.splits || [];
  if (!originalId || !splits.length) return fail('INVALID_REQUEST', 'Missing transaction or splits.');

  const parent = db.get('SELECT * FROM transactions WHERE id = ?', [originalId]);
  if (!parent) return fail('NOT_FOUND', 'Original transaction not found.');

  const insertedIds = [];
  db.transaction(() => {
    db.run('DELETE FROM transactions WHERE id = ?', [originalId]);
    for (const split of splits) {
      const amt = Number(split.amount) || 0;
      if (amt <= 0) continue;
      const cat = split.category || parent.category;
      const desc = split.description !== undefined ? split.description : parent.description;
      const res = db.run(
        `INSERT INTO transactions (
          type, amount, category, merchant, date, member_id, description,
          currency, raw_sms, is_investment_outflow, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          parent.type,
          amt,
          cat,
          parent.merchant,
          parent.date,
          split.member_id || parent.member_id,
          desc,
          parent.currency,
          parent.raw_sms,
          parent.is_investment_outflow,
          parent.created_at || new Date().toISOString(),
        ],
      );
      insertedIds.push(res.lastInsertRowid);
    }
  });

  return { status: 'success', inserted_count: insertedIds.length, ids: insertedIds };
}

function ignoreTransaction(db, args = {}) {
  const txId = Number(args.transaction_id || args.id);
  if (!txId) return fail('BAD_REQUEST', 'Transaction ID is required.');
  const tx = db.get('SELECT * FROM transactions WHERE id = ?', [txId]);
  if (!tx) return fail('NOT_FOUND', 'Transaction not found.');

  db.transaction(() => {
    db.run('UPDATE transactions SET is_ignored = 1 WHERE id = ?', [txId]);

    // Learn ignore rule if requested
    if (args.create_rule && tx.merchant) {
      learnMerchant(db, tx.merchant, 'Ignore', 'Ignore');
    }
    if (args.create_sms_rule && (args.body_trigger || tx.merchant)) {
      const trigger = String(args.body_trigger || tx.merchant).trim();
      db.run(
        "INSERT INTO sms_rules (rule_name, sender_keyword, body_trigger, transaction_type, category_name, is_active)"
        + " VALUES (?, ?, ?, 'Ignore', 'Ignore', 1)",
        [`Ignore: ${trigger}`, String(args.sender_keyword || '').trim(), trigger],
      );
    }
  });

  return { status: 'success', transaction_id: txId, is_ignored: 1 };
}

function markTransactionDuplicate(db, args = {}) {
  const txId = Number(args.transaction_id || args.id);
  if (!txId) return fail('BAD_REQUEST', 'Transaction ID is required.');
  const tx = db.get('SELECT * FROM transactions WHERE id = ?', [txId]);
  if (!tx) return fail('NOT_FOUND', 'Transaction not found.');

  db.transaction(() => {
    db.run('UPDATE transactions SET is_duplicate = 1 WHERE id = ?', [txId]);
    if (tx.raw_sms) {
      db.run('INSERT OR REPLACE INTO ignored_alerts (body, ignored_at) VALUES (?, ?)',
        [tx.raw_sms, new Date().toISOString()]);
    }
    if (args.create_rule && tx.merchant) {
      learnMerchant(db, tx.merchant, 'Ignore', 'Ignore');
    }
  });

  return { status: 'success', transaction_id: txId, is_duplicate: 1 };
}

function restoreTransaction(db, args = {}) {
  const txId = Number(args.transaction_id || args.id);
  if (!txId) return fail('BAD_REQUEST', 'Transaction ID is required.');
  db.run('UPDATE transactions SET is_ignored = 0, is_duplicate = 0 WHERE id = ?', [txId]);
  return { status: 'success', transaction_id: txId, is_ignored: 0, is_duplicate: 0 };
}

function scanLedgerDuplicates(db, args = {}) {
  const memberId = args.member_id && args.member_id !== 'all' ? Number(args.member_id) : null;
  const rows = db.all(`
    SELECT t.id, t.date, t.amount, t.type, t.category, t.merchant, t.description,
           t.account_id, t.card_id, t.member_id, t.raw_sms, t.created_at,
           COALESCE(a.name, c.card_name) AS instrument_name,
           m.name AS member_name
    FROM transactions t
    LEFT JOIN asset_accounts a ON t.account_id = a.id
    LEFT JOIN credit_cards c ON t.card_id = c.id
    LEFT JOIN family_members m ON t.member_id = m.id
    WHERE t.amount > 0 AND COALESCE(t.is_ignored, 0) = 0 AND COALESCE(t.is_duplicate, 0) = 0
      ${memberId ? 'AND t.member_id = ?' : ''}
    ORDER BY t.date DESC, t.amount DESC, t.id DESC
  `, memberId ? [memberId] : []);

  const utrPattern = /\b(?:upi(?:\/|\s*(?:ref|txn|reference)?\s*(?:no\.?|id|num)?[:\s\/-]+)|ref(?:\s*no\.?|\s*id|\s*num)?[:\s\/-]+|rrn[:\s\/-]+|utr(?:\s*no\.?)?[:\s\/-]+|txn\s*id[:\s\/-]+|upi\/)([A-Za-z0-9]{6,24})\b/i;
  const getUtr = (txt) => {
    if (!txt) return '';
    const m = utrPattern.exec(txt);
    return (m && m[1] && /\d/.test(m[1])) ? m[1].trim() : '';
  };

  const groupsMap = new Map();
  for (const row of rows) {
    const key = `${row.date}:${row.amount}`;
    if (!groupsMap.has(key)) groupsMap.set(key, []);
    groupsMap.get(key).push({ ...row, utr: getUtr(row.raw_sms) });
  }

  const duplicateGroups = [];
  for (const [key, list] of groupsMap.entries()) {
    if (list.length >= 2) {
      const first = list[0];
      const second = list[1];
      const isExactUtr = Boolean(first.utr && second.utr && first.utr === second.utr);
      const sameMerchant = Boolean(first.merchant && second.merchant && first.merchant.toLowerCase() === second.merchant.toLowerCase());
      const sameInstrument = Boolean((first.account_id && first.account_id === second.account_id) || (first.card_id && first.card_id === second.card_id));

      duplicateGroups.push({
        key,
        date: first.date,
        amount: first.amount,
        match_type: isExactUtr ? 'exact-utr' : (sameMerchant || sameInstrument ? 'high-confidence' : 'date-amount'),
        match_score: isExactUtr ? 100 : (sameMerchant && sameInstrument ? 90 : (sameMerchant ? 80 : 65)),
        transactions: list,
      });
    }
  }

  return {
    status: 'success',
    count: duplicateGroups.length,
    total_duplicate_txns: duplicateGroups.reduce((acc, g) => acc + g.transactions.length, 0),
    groups: duplicateGroups,
  };
}

function mergeLedgerTransactions(db, args = {}) {
  const primaryId = Number(args.primary_id || args.target_id);
  const secondaryId = Number(args.secondary_id || args.source_id);
  if (!primaryId || !secondaryId || primaryId === secondaryId) {
    return fail('BAD_REQUEST', 'Two distinct transaction IDs required to merge.');
  }

  const primary = db.get('SELECT * FROM transactions WHERE id = ?', [primaryId]);
  const secondary = db.get('SELECT * FROM transactions WHERE id = ?', [secondaryId]);
  if (!primary || !secondary) {
    return fail('BAD_REQUEST', 'One or both transactions no longer exist.');
  }

  const mergedMerchant = String(args.merchant !== undefined ? args.merchant : (primary.merchant || secondary.merchant || '')).trim();
  const mergedCategory = String(args.category !== undefined ? args.category : (primary.category || secondary.category || 'Shopping')).trim();
  const mergedType = String(args.type || primary.type || secondary.type || 'Expense');
  const mergedDesc = String(args.description !== undefined ? args.description : (primary.description || secondary.description || '')).trim();
  const mergedAccountId = args.account_id !== undefined ? (args.account_id ? Number(args.account_id) : null) : (primary.account_id || secondary.account_id);
  const mergedCardId = args.card_id !== undefined ? (args.card_id ? Number(args.card_id) : null) : (primary.card_id || secondary.card_id);
  const isInvest = mergedType === 'Investment' || mergedCategory === 'Investment Outflow' ? 1 : 0;

  db.transaction(() => {
    db.run(
      'UPDATE transactions SET merchant = ?, merchant_key = ?, category = ?, type = ?,'
      + ' description = ?, account_id = ?, card_id = ?, is_investment_outflow = ? WHERE id = ?',
      [mergedMerchant, merchantKey(mergedMerchant), mergedCategory, mergedType, mergedDesc, mergedAccountId, mergedCardId, isInvest, primaryId],
    );
    // Mark secondary transaction as duplicate
    db.run('UPDATE transactions SET is_duplicate = 1 WHERE id = ?', [secondaryId]);
    if (secondary.raw_sms) {
      db.run('INSERT OR REPLACE INTO ignored_alerts (body, ignored_at) VALUES (?, ?)',
        [secondary.raw_sms, new Date().toISOString()]);
    }
  });

  return { status: 'success', primary_id: primaryId, secondary_id: secondaryId, is_merged: true };
}

function batchUpdateTransactions(db, args) {
  const ids = args.ids || [];
  if (!ids.length) return { status: 'success', updated_count: 0 };
  const placeholders = ids.map(() => '?').join(', ');
  let updated = 0;

  db.transaction(() => {
    if (args.category) {
      db.run(`UPDATE transactions SET category = ? WHERE id IN (${placeholders})`, [args.category, ...ids]);
      updated = ids.length;
    }
    if (args.member_id) {
      db.run(`UPDATE transactions SET member_id = ? WHERE id IN (${placeholders})`, [args.member_id, ...ids]);
      updated = ids.length;
    }
    if (args.is_ignored !== undefined) {
      db.run(`UPDATE transactions SET is_ignored = ? WHERE id IN (${placeholders})`, [args.is_ignored ? 1 : 0, ...ids]);
      updated = ids.length;
    }
    if (args.is_duplicate !== undefined) {
      db.run(`UPDATE transactions SET is_duplicate = ? WHERE id IN (${placeholders})`, [args.is_duplicate ? 1 : 0, ...ids]);
      updated = ids.length;
    }
  });

  return { status: 'success', updated_count: updated };
}

function batchDeleteTransactions(db, args) {
  const ids = args.ids || [];
  if (!ids.length) return { status: 'success', deleted_count: 0 };
  const placeholders = ids.map(() => '?').join(', ');
  db.run(`DELETE FROM transactions WHERE id IN (${placeholders})`, ids);
  return { status: 'success', deleted_count: ids.length };
}

function extractCreditLimits(text) {
  const t = String(text || '');
  let availableLimit = null;
  let totalLimit = null;
  let currentOutstanding = null;
  let minDue = null;

  // 1. Available Limit
  const avlPatterns = [
    /(?:avl|avail|available)\s*(?:credit\s*)?(?:lmt|limit|bal|balance)?\s*(?:is)?\s*[:\s-]*\s*(?:rs\.?|inr|₹)?\s*([0-9,]+(?:\.[0-9]+)?)/i,
    /(?:credit\s*)?(?:lmt|limit|bal|balance)\s*(?:avl|avail|available)\s*(?:is)?\s*[:\s-]*\s*(?:rs\.?|inr|₹)?\s*([0-9,]+(?:\.[0-9]+)?)/i,
    /\bavl\s*limit\s*[:\s-]*\s*(?:rs\.?|inr|₹)?\s*([0-9,]+(?:\.[0-9]+)?)/i,
    /\bavail\s*limit\s*[:\s-]*\s*(?:rs\.?|inr|₹)?\s*([0-9,]+(?:\.[0-9]+)?)/i,
  ];
  for (const pat of avlPatterns) {
    const m = pat.exec(t);
    if (m && m[1]) {
      const val = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(val) && val >= 0) {
        availableLimit = val;
        break;
      }
    }
  }

  // 2. Total Credit Limit
  const totPatterns = [
    /(?:total|tot)\s*(?:credit\s*)?(?:lmt|limit)\s*(?:is)?\s*[:\s-]*\s*(?:rs\.?|inr|₹)?\s*([0-9,]+(?:\.[0-9]+)?)/i,
    /(?:total|tot)\s*lmt\s*[:\s-]*\s*(?:rs\.?|inr|₹)?\s*([0-9,]+(?:\.[0-9]+)?)/i,
    /credit\s*limit\s*(?:is)?\s*[:\s-]*\s*(?:rs\.?|inr|₹)?\s*([0-9,]+(?:\.[0-9]+)?)/i,
  ];
  for (const pat of totPatterns) {
    const m = pat.exec(t);
    if (m && m[1]) {
      const val = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(val) && val > 0) {
        totalLimit = val;
        break;
      }
    }
  }

  // 3. Current Outstanding / Total Due
  const duePatterns = [
    /(?:current\s*outstanding|total\s*outstanding|tot\s*outstanding|total\s*amount\s*due|total\s*amt\s*due|total\s*due|tot\s*due|outstanding\s*amount)\s*(?:is)?\s*[:\s-]*\s*(?:rs\.?|inr|₹)?\s*([0-9,]+(?:\.[0-9]+)?)/i,
  ];
  for (const pat of duePatterns) {
    const m = pat.exec(t);
    if (m && m[1]) {
      const val = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(val) && val >= 0) {
        currentOutstanding = val;
        break;
      }
    }
  }

  // 4. Min Due
  const minPatterns = [
    /min(?:imum)?\s*(?:amount\s*due|amt\s*due|due)\s*(?:is)?\s*[:\s-]*\s*(?:rs\.?|inr|₹)?\s*([0-9,]+(?:\.[0-9]+)?)/i,
  ];
  for (const pat of minPatterns) {
    const m = pat.exec(t);
    if (m && m[1]) {
      const val = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(val) && val >= 0) {
        minDue = val;
        break;
      }
    }
  }

  return {
    available_limit: availableLimit,
    total_limit: totalLimit,
    current_outstanding: currentOutstanding,
    min_due: minDue,
  };
}

/**
 * Extracts bank account, wallet, or food card available/clear balance from SMS alert text.
 */
export function extractAccountBalanceFromText(text) {
  const t = String(text || '');
  const balPatterns = [
    // 1. Explicit Avl / Available / Clear / Total / Updated / Effective / Net / Wallet / A/c Balance
    /(?:avl\.?|avail(?:able)?|clear|total|updated|effective|net|wallet|acct?|a\/c)?\s*bal(?:ance)?(?:\s*in\s*(?:your\s*)?(?:a\/c|account|wallet|card|bank))?\s*(?:is)?\s*[:\s-]*\s*(?:rs\.?|inr|₹|inr\.)?\s*[:\s-]*\s*([0-9,]+(?:\.[0-9]+)?)\s*(?:cr\.?|dr\.?)?/i,
    // 2. Bal: Rs. 1234 or Bal: 1234 or Bal Rs 1234 or Bal INR 1234
    /\bbal(?:ance)?\s*[:\s-]+\s*(?:rs\.?|inr|₹)?\s*[:\s-]*\s*([0-9,]+(?:\.[0-9]+)?)\s*(?:cr\.?|dr\.?)?/i,
    // 3. Currency followed by is Avl Bal
    /(?:rs\.?|inr|₹)\s*[:\s-]*\s*([0-9,]+(?:\.[0-9]+)?)\s*(?:is\s*)?(?:avl\.?|available|clear|total|updated|current)?\s*bal(?:ance)?/i,
    // 4. Standalone Balance is / Balance:
    /\bbalance\s*(?:is)?\s*[:\s-]+\s*(?:rs\.?|inr|₹)?\s*([0-9,]+(?:\.[0-9]+)?)/i,
    // 5. Account Balance Rs 1234
    /(?:account|a\/c)\s+bal(?:ance)?\s*[:\s-]*\s*(?:rs\.?|inr|₹)?\s*([0-9,]+(?:\.[0-9]+)?)/i,
  ];

  for (const pat of balPatterns) {
    const m = pat.exec(t);
    if (m && m[1]) {
      const clean = m[1].replace(/,/g, '').replace(/\/[- ]*$/, '').trim();
      const val = Number(clean);
      if (Number.isFinite(val) && val >= 0) {
        return val;
      }
    }
  }
  return null;
}

function isValid4Digits(d, text) {
  if (!d || d.length !== 4 || !/^\d{4}$/.test(d)) return false;
  const num = Number(d);
  // Exclude calendar years (2020-2035) when found in date context
  if (num >= 2020 && num <= 2035) {
    if (new RegExp(`(?:[-/]|\\b(?:on|dt|dated|in|year)\\s+)${d}\\b`, 'i').test(text)) {
      return false;
    }
  }
  // Exclude numbers directly preceded by currency indicators (amounts like Rs 1200, INR 5000, Rs. 2500)
  if (new RegExp(`(?:rs\\.?|inr|₹)\\s*[:\\s-]*${d}(?:\\b|\\.)`, 'i').test(text)) {
    return false;
  }
  // Exclude reference / OTP / UTR / Auth numbers
  if (new RegExp(`\\b(?:otp|ref|utr|rrn|txn|id|code|pin|vpa)\\b[^.]*?${d}\\b`, 'i').test(text)) {
    return false;
  }
  return true;
}

const KNOWN_INSTITUTIONS = [
  { issuer: 'HDFC Bank', code: 'HDFC', aliases: [/\bhdfc bank\b/i, /\bhdfc\b/i], senderRe: /hdfc/i },
  { issuer: 'ICICI Bank', code: 'ICICI', aliases: [/\bicici bank\b/i, /\bicici\b/i], senderRe: /icici/i },
  { issuer: 'State Bank of India', code: 'SBI', aliases: [/\bstate bank\b/i, /\bsbi card\b/i, /\bsbi\b/i], senderRe: /sbi/i },
  { issuer: 'Axis Bank', code: 'AXIS', aliases: [/\baxis bank\b/i, /\baxis\b/i], senderRe: /axis/i },
  { issuer: 'Kotak Mahindra Bank', code: 'KOTAK', aliases: [/\bkotak mahindra\b/i, /\bkotak bank\b/i, /\bkotak\b/i], senderRe: /kotak/i },
  { issuer: 'IndusInd Bank', code: 'INDUSIND', aliases: [/\bindusind bank\b/i, /\bindusind\b/i], senderRe: /indus/i },
  { issuer: 'IDFC FIRST Bank', code: 'IDFC', aliases: [/\bidfc first\b/i, /\bidfc bank\b/i, /\bidfc\b/i], senderRe: /idfc/i },
  { issuer: 'RBL Bank', code: 'RBL', aliases: [/\brbl bank\b/i, /\brbl\b/i, /\bratnakar\b/i], senderRe: /rbl/i },
  { issuer: 'DCB Bank', code: 'DCB', aliases: [/\bdcb bank\b/i, /\bdcb\b/i], senderRe: /dcb/i },
  { issuer: 'American Express', code: 'AMEX', aliases: [/\bamerican express\b/i, /\bamex\b/i], senderRe: /amex/i },
  { issuer: 'Standard Chartered Bank', code: 'SCB', aliases: [/\bstandard chartered\b/i, /\bstanchart\b/i, /\bscb\b/i], senderRe: /scb|stanchar/i },
  { issuer: 'Citibank', code: 'CITI', aliases: [/\bcitibank\b/i, /\bciti\b/i], senderRe: /citi/i },
  { issuer: 'HSBC Bank', code: 'HSBC', aliases: [/\bhsbc bank\b/i, /\bhsbc\b/i], senderRe: /hsbc/i },
  { issuer: 'Federal Bank', code: 'FED', aliases: [/\bfederal bank\b/i, /\bfederal\b/i], senderRe: /fed/i },
  { issuer: 'Bank of Baroda', code: 'BOB', aliases: [/\bbank of baroda\b/i, /\bbaroda bank\b/i, /\bbob\b/i], senderRe: /bob/i },
  { issuer: 'Punjab National Bank', code: 'PNB', aliases: [/\bpunjab national\b/i, /\bpnb\b/i], senderRe: /pnb/i },
  { issuer: 'Canara Bank', code: 'CANARA', aliases: [/\bcanara bank\b/i, /\bcanara\b/i], senderRe: /canara|canbnk/i },
  { issuer: 'Union Bank of India', code: 'UBI', aliases: [/\bunion bank\b/i, /\bubi\b/i], senderRe: /unionb|ubi/i },
  { issuer: 'Central Bank of India', code: 'CBI', aliases: [/\bcentral bank\b/i, /\bcbi\b/i], senderRe: /cbi/i },
  { issuer: 'Bank of India', code: 'BOI', aliases: [/\bbank of india\b/i, /\bboi\b/i], senderRe: /boi/i },
  { issuer: 'Indian Bank', code: 'INDIAN', aliases: [/\bindian bank\b/i], senderRe: /indianb/i },
  { issuer: 'Indian Overseas Bank', code: 'IOB', aliases: [/\bindian overseas bank\b/i, /\biob\b/i], senderRe: /iob/i },
  { issuer: 'UCO Bank', code: 'UCO', aliases: [/\buco bank\b/i, /\buco\b/i], senderRe: /uco/i },
  { issuer: 'Bank of Maharashtra', code: 'BOM', aliases: [/\bbank of maharashtra\b/i, /\bbom\b/i], senderRe: /bom/i },
  { issuer: 'Punjab & Sind Bank', code: 'PSB', aliases: [/\bpunjab & sind\b/i, /\bpunjab and sind\b/i, /\bpsb\b/i], senderRe: /psb/i },
  { issuer: 'Karur Vysya Bank', code: 'KVB', aliases: [/\bkarur vysya\b/i, /\bkvb\b/i], senderRe: /kvb/i },
  { issuer: 'Karnataka Bank', code: 'KTK', aliases: [/\bkarnataka bank\b/i, /\bktk\b/i], senderRe: /ktk/i },
  { issuer: 'J&K Bank', code: 'JKB', aliases: [/\bjammu & kashmir\b/i, /\bj&k bank\b/i, /\bjk bank\b/i], senderRe: /jkb/i },
  { issuer: 'Yes Bank', code: 'YES', aliases: [/\byes bank\b/i, /\byes\b/i], senderRe: /yes/i },
  { issuer: 'South Indian Bank', code: 'SIB', aliases: [/\bsouth indian bank\b/i, /\bsib\b/i], senderRe: /sib/i },
  { issuer: 'Bandhan Bank', code: 'BANDHAN', aliases: [/\bbandhan bank\b/i, /\bbandhan\b/i], senderRe: /bandhan/i },
  { issuer: 'City Union Bank', code: 'CUB', aliases: [/\bcity union bank\b/i, /\bcub\b/i], senderRe: /cub/i },
  { issuer: 'AU Small Finance Bank', code: 'AU', aliases: [/\bau small finance\b/i, /\bau bank\b/i, /\bau sfb\b/i], senderRe: /aubank|au/i },
  { issuer: 'Equitas Small Finance Bank', code: 'EQUITAS', aliases: [/\bequitas\b/i], senderRe: /equitas/i },
  { issuer: 'Ujjivan Small Finance Bank', code: 'UJJIVAN', aliases: [/\bujjivan\b/i], senderRe: /ujjivan/i },
  { issuer: 'Jana Small Finance Bank', code: 'JANA', aliases: [/\bjana sfb\b/i, /\bjana\b/i], senderRe: /jana/i },
  { issuer: 'Deutsche Bank', code: 'DB', aliases: [/\bdeutsche bank\b/i, /\bdeutsche\b/i], senderRe: /deutsche/i },
  { issuer: 'DBS Bank', code: 'DBS', aliases: [/\bdbs bank\b/i, /\bdbs\b/i], senderRe: /dbs/i },
  { issuer: 'Barclays', code: 'BARCLAYS', aliases: [/\bbarclays\b/i], senderRe: /barclays/i },
  { issuer: 'OneCard', code: 'ONECARD', aliases: [/\bonecard\b/i], senderRe: /onecard|onecrd/i },
  { issuer: 'Scapia', code: 'SCAPIA', aliases: [/\bscapia\b/i], senderRe: /scapia/i },
  { issuer: 'Slice', code: 'SLICE', aliases: [/\bslice\b/i], senderRe: /slice/i },
  { issuer: 'Airtel Payments Bank', code: 'AIRTEL', aliases: [/\bairtel payments\b/i, /\bairtel bank\b/i], senderRe: /airtel/i },
  { issuer: 'India Post Payments Bank', code: 'IPPB', aliases: [/\bindia post\b/i, /\bippb\b/i], senderRe: /ippb/i },
  { issuer: 'Fino Payments Bank', code: 'FINO', aliases: [/\bfino\b/i], senderRe: /fino/i },
  { issuer: 'Jio Payments Bank', code: 'JIO', aliases: [/\bjio payments\b/i], senderRe: /jio/i },
  { issuer: 'Pluxee', code: 'PLUXEE', aliases: [/\bpluxee\b/i], senderRe: /pluxee/i },
  { issuer: 'Sodexo', code: 'SODEXO', aliases: [/\bsodexo\b/i], senderRe: /sodexo/i },
  { issuer: 'Zeta', code: 'ZETA', aliases: [/\bzeta\b/i], senderRe: /zeta/i },
  { issuer: 'SmartQ', code: 'SMARTQ', aliases: [/\bsmartq\b/i], senderRe: /smartq/i },
  { issuer: 'HungerBox', code: 'HUNGERBOX', aliases: [/\bhungerbox\b/i], senderRe: /hungerbox/i },
  { issuer: 'Amazon Pay', code: 'AMAZON', aliases: [/\bamazon pay\b/i, /\bamazon\b/i], senderRe: /amazon/i, isWalletOnly: true },
  { issuer: 'Paytm', code: 'PAYTM', aliases: [/\bpaytm\b/i], senderRe: /paytm/i, isWalletOnly: true },
  { issuer: 'PhonePe', code: 'PHONEPE', aliases: [/\bphonepe\b/i], senderRe: /phonepe/i, isWalletOnly: true },
  { issuer: 'MobiKwik', code: 'MOBIKWIK', aliases: [/\bmobikwik\b/i], senderRe: /mobikwik/i, isWalletOnly: true },
  { issuer: 'Freecharge', code: 'FREECHARGE', aliases: [/\bfreecharge\b/i], senderRe: /freecharge/i, isWalletOnly: true },
];

/**
 * Weighted scoring engine to determine the true account-holding bank / issuer.
 * Accounts for counterparty VPAs/handles (penalized as external parties) and direct account anchors (highly weighted).
 */
export function detectAccountIssuerWeighted(text = '', sender = '') {
  const t = String(text || '');
  const s = String(sender || '');
  const scores = new Map();

  const addScore = (inst, points) => {
    const existing = scores.get(inst.issuer) || { score: 0, code: inst.code, issuer: inst.issuer };
    existing.score += points;
    scores.set(inst.issuer, existing);
  };

  const isIntermediaryContext = /it refund|income tax refund|tax refund|refund for ay|pan\s+[a-z0-9]+\s*,\s*an?\s*it\s*refund|refund banker|cpc refund|pf claim|epfo|pfms|dbt\b/i.test(t);

  // 1. Direct Account / Card Anchor (+120 points)
  // E.g. "Your DCB A/c no XX1977", "HDFC Bank A/C *1234", "ICICI Bank Credit Card ending 9012"
  let directAnchorInst = null;
  const anchorRegex = /(?:in|from|to|on|your|dear)?\s*\b([A-Za-z0-9\s&]+?)\s*(?:Bank)?\s*(?:A\/c|Account|Acct|Card|Debit\s*Card|Credit\s*Card|Meal\s*Card|Meal\s*Wallet|Wallet)\s*(?:no\.?|ending(?:\s*(?:in|with))?|number)?\s*[*Xx#\s.]*([0-9]{4})\b/gi;
  let m;
  while ((m = anchorRegex.exec(t)) !== null) {
    const anchoredText = m[1].toLowerCase();
    for (const inst of KNOWN_INSTITUTIONS) {
      if (inst.aliases.some((al) => al.test(anchoredText))) {
        directAnchorInst = inst;
        addScore(inst, 120);
      }
    }
  }

  // 2. Sender Header Match (+100 points)
  if (s) {
    const isIntermediarySender = isIntermediaryContext || /itdept|cpc|epfo|pfms|dbt/i.test(s);
    for (const inst of KNOWN_INSTITUTIONS) {
      if (inst.senderRe && inst.senderRe.test(s)) {
        if (!isIntermediarySender || directAnchorInst === inst) {
          addScore(inst, 100);
        }
      }
    }
  }

  // 3. Salutation / Bank Alert Header (+70 points)
  // E.g. "Dear HDFC Bank Customer", "ICICI Bank Alert:", "Thank you for banking with State Bank of India"
  if (!isIntermediaryContext) {
    const salutationRegex = /(?:dear|thank you for banking with|welcome to|alert:?)\s+([A-Za-z0-9\s&]+?)\s*(?:customer|user|bank|alert)?\b/gi;
    while ((m = salutationRegex.exec(t)) !== null) {
      const salText = m[1].toLowerCase();
      for (const inst of KNOWN_INSTITUTIONS) {
        if (inst.aliases.some((al) => al.test(salText))) {
          addScore(inst, 70);
        }
      }
    }
  }

  // 3b. Trailing Sender / Gateway Signature (e.g. " - SBI", " - HDFC Bank", " - Google Pay")
  // Trailing suffixes identify the sending gateway/channel (+40 points), subordinate to direct account anchors (+120 points).
  // In intermediary contexts (IT Refunds, PF Claims, Government DBT), the signatory bank (e.g. SBI as Refund Banker)
  // is merely the disbursing agent, NOT the user's account-holding bank.
  const sigMatch = /[-–—~]\s*([A-Za-z0-9\s&]+)$/.exec(t);
  let sigText = '';
  if (sigMatch && sigMatch[1] && (!isIntermediaryContext || directAnchorInst)) {
    sigText = sigMatch[1].trim().toLowerCase();
    for (const inst of KNOWN_INSTITUTIONS) {
      if (inst.aliases.some((al) => al.test(sigText))) {
        addScore(inst, 40);
      }
    }
  }

  // 4. Standalone mentions in body (excluding trailing signature) (+30 points for banks, +10 for wallets)
  const bodyWithoutSig = sigMatch ? t.slice(0, sigMatch.index) : t;
  if (!isIntermediaryContext || directAnchorInst) {
    for (const inst of KNOWN_INSTITUTIONS) {
      for (const al of inst.aliases) {
        if (al.test(bodyWithoutSig)) {
          addScore(inst, inst.isWalletOnly ? 10 : 30);
          break;
        }
      }
    }
  }

  // 5. PENALTIES:
  // Penalty A: Counterparty VPA / UPI handle (-150 points)
  // VPA handles indicate the EXTERNAL party (e.g. 'from UPI ID aaaaa@okaxis', 'to user@okhdfcbank', 'xyz@ybl')
  const vpaMatches = t.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+/g) || [];
  for (const vpa of vpaMatches) {
    const vpaLower = vpa.toLowerCase();
    for (const inst of KNOWN_INSTITUTIONS) {
      if (vpaLower.includes(inst.code.toLowerCase())
        || (inst.code === 'AXIS' && vpaLower.includes('axis'))
        || (inst.code === 'HDFC' && vpaLower.includes('hdfc'))
        || (inst.code === 'ICICI' && vpaLower.includes('icici'))
        || (inst.code === 'SBI' && vpaLower.includes('sbi'))
        || (inst.code === 'YES' && vpaLower.includes('ybl'))
        || (inst.code === 'PAYTM' && vpaLower.includes('paytm'))) {
        addScore(inst, -150);
      }
    }
  }

  // Penalty B: External Payee / Merchant context (-80 points)
  // E.g. "to Amazon Pay", "to Swiggy", "towards Amazon Pay", "paid to Ramesh on Google Pay"
  const payeeRegex = /(?:to|towards|at|for|paid to|sent to|transferred to)\s+([A-Za-z0-9\s&@._-]+?)(?:\s+(?:on|via|using|ref|bal|from|dated)|$|\.)/gi;
  while ((m = payeeRegex.exec(t)) !== null) {
    const payeeText = m[1].toLowerCase();
    for (const inst of KNOWN_INSTITUTIONS) {
      if (inst.aliases.some((al) => al.test(payeeText))) {
        addScore(inst, -80);
      }
    }
  }

  // Determine the highest scoring institution
  let best = null;
  for (const entry of scores.values()) {
    if (entry.score > 0 && (!best || entry.score > best.score)) {
      best = entry;
    }
  }

  return best ? { issuer: best.issuer, bankCode: best.code, score: best.score } : { issuer: 'Bank', bankCode: 'BANK', score: 0 };
}

/**
 * Extracts bank account, debit card, credit card, meal card (Pluxee/Sodexo), wallet, and prepaid card details from SMS alert text.
 */
export function parseAccountDetailsFromText(text = '', sender = '') {
  const t = String(text || '');
  const s = String(sender || '');
  const combined = `${s} ${t}`;

  // 1. Detect Institution / Issuer using Weighted Scoring Engine
  const detected = detectAccountIssuerWeighted(t, s);
  const issuer = detected.issuer;
  const bankCode = detected.bankCode;

  // 2. Specific Instrument Detection
  const isFoodCard = /pluxee|sodexo|zeta|smartq|hungerbox|meal card|food card|meal wallet|food wallet/i.test(combined);
  const isWallet = !isFoodCard && (
    /paytm wallet|amazon pay (?:wallet|balance)|mobikwik (?:wallet|zip)|phonepe wallet|freecharge (?:wallet|balance)|ola money|wallet ending|debited from (?:your )?wallet|credited to (?:your )?wallet|wallet balance/i.test(combined)
    || (issuer === 'Amazon Pay' && /balance|wallet/i.test(combined))
    || (issuer === 'Paytm' && /wallet/i.test(combined))
  );
  const isPrepaidCard = !isFoodCard && !isWallet && /prepaid card|prepaid wallet|ncmc card|travel card|forex card|gift card|prepaid card ending/i.test(combined);

  // Debit card check: explicit debit card mentions MUST NOT become credit cards
  const isDebitCard = !isFoodCard && !isWallet && !isPrepaidCard && (
    /debit\s*card|debitcard|dc ending|\bdc\b|atm card|spent via debit card|using debit card|by debit card|debit card \*\*|debit card no|on your debit card/i.test(combined)
  );

  // Credit card check: explicit credit card or known premium/retail credit card brands
  const isCreditCard = !isFoodCard && !isWallet && !isPrepaidCard && !isDebitCard && (
    /credit\s*card|creditcard|cc ending|\bcc\b|cardholder|limit avl|total due|min due|statement generated/i.test(combined)
    || /infinia|regalia|millennia|coral|rubyx|sapphiro|simplyclick|simplysave|magnus|atlas|onecard|scapia|slice/i.test(combined)
    || (/spent on .*card|card ending|card \*\*/i.test(combined) && !/debit|a\/c|account/i.test(combined))
    || (/amazon pay|flipkart axis|tata neu|swiggy hdfc/i.test(combined) && /card/i.test(combined))
  );

  // 3. Extract 4-digit numbers: Account Number, Debit Card, Credit Card, etc.
  let accountLast4 = '';
  let debitCardLast4 = '';
  let creditCardLast4 = '';
  let generalLast4 = '';

  const acctMatch = /(?:a\/c|acct|account)\s*(?:no\.?|ending(?:\s*(?:in|with))?|number)?\s*[*Xx#\s.]*([0-9]{4})\b/i.exec(t);
  if (acctMatch && acctMatch[1] && isValid4Digits(acctMatch[1], t)) accountLast4 = acctMatch[1];

  const dcMatch = /(?:debit\s*card|dc)\s*(?:no\.?|ending(?:\s*(?:in|with))?|number)?\s*[*Xx#\s.]*([0-9]{4})\b/i.exec(t);
  if (dcMatch && dcMatch[1] && isValid4Digits(dcMatch[1], t)) debitCardLast4 = dcMatch[1];

  const ccMatch = /(?:credit\s*card|cc)\s*(?:no\.?|ending(?:\s*(?:in|with))?|number)?\s*[*Xx#\s.]*([0-9]{4})\b/i.exec(t);
  if (ccMatch && ccMatch[1] && isValid4Digits(ccMatch[1], t)) creditCardLast4 = ccMatch[1];

  const generalPatterns = [
    /(?:card|wallet)\s*(?:no\.?|ending(?:\s*(?:in|with))?|number)?\s*[*Xx#\s.]*([0-9]{4})\b/i,
    /\bending(?:\s*(?:in|with))?\s*[*Xx#\s.]*([0-9]{4})\b/i,
    /(?:xx|[*#]{2,}|\.{2,})\s*([0-9]{4})\b/i,
    /(?:card|a\/c)\s+([0-9]{4})\b/i,
  ];
  for (const pat of generalPatterns) {
    const m = pat.exec(t);
    if (m && m[1] && isValid4Digits(m[1], t)) {
      generalLast4 = m[1];
      break;
    }
  }

  const primaryLast4 = (isDebitCard && debitCardLast4)
    || (isCreditCard && creditCardLast4)
    || accountLast4
    || debitCardLast4
    || creditCardLast4
    || generalLast4;

  // 4. Detect Variant / Sub-name
  let cardVariant = '';
  if (isFoodCard) {
    cardVariant = /wallet/i.test(combined) ? 'Meal Wallet' : 'Meal Card';
  } else if (isWallet) {
    cardVariant = 'Wallet';
  } else if (isPrepaidCard) {
    cardVariant = 'Prepaid Card';
  } else if (isDebitCard) {
    cardVariant = 'Debit Card';
  } else if (/infinia/i.test(combined)) cardVariant = 'Infinia';
  else if (/regalia/i.test(combined)) cardVariant = 'Regalia';
  else if (/millennia/i.test(combined)) cardVariant = 'Millennia';
  else if (/amazon pay/i.test(combined)) cardVariant = 'Amazon Pay Card';
  else if (/flipkart axis|flipkart/i.test(combined)) cardVariant = 'Flipkart Card';
  else if (/tata neu/i.test(combined)) cardVariant = 'Tata Neu Card';
  else if (/swiggy/i.test(combined) && /card/i.test(combined)) cardVariant = 'Swiggy Card';
  else if (/coral/i.test(combined)) cardVariant = 'Coral';
  else if (/rubyx/i.test(combined)) cardVariant = 'Rubyx';
  else if (/sapphiro/i.test(combined)) cardVariant = 'Sapphiro';
  else if (/simplyclick/i.test(combined)) cardVariant = 'SimplyCLICK';
  else if (/simplysave/i.test(combined)) cardVariant = 'SimplySAVE';
  else if (/magnus/i.test(combined)) cardVariant = 'Magnus';
  else if (/atlas/i.test(combined)) cardVariant = 'Atlas';
  else if (/onecard/i.test(combined)) cardVariant = 'OneCard';
  else if (/scapia/i.test(combined)) cardVariant = 'Scapia';
  else if (/slice/i.test(combined)) cardVariant = 'Slice';

  let instrumentType = 'bank_account';
  if (isFoodCard) instrumentType = 'meal_card';
  else if (isWallet) instrumentType = 'wallet';
  else if (isPrepaidCard) instrumentType = 'prepaid_card';
  else if (isDebitCard) instrumentType = 'debit_card';
  else if (isCreditCard) instrumentType = 'credit_card';

  const limits = extractCreditLimits(t);
  const accountBalance = extractAccountBalanceFromText(t);

  return {
    last4: primaryLast4,
    account_number: accountLast4,
    debit_card_last_4: debitCardLast4 || (isDebitCard ? primaryLast4 : ''),
    issuer,
    bankCode,
    instrument_type: instrumentType,
    isFoodCard,
    isWallet,
    isPrepaidCard,
    isDebitCard,
    isCreditCard,
    isBankAccount: instrumentType === 'bank_account',
    cardVariant,
    available_limit: limits.available_limit,
    total_limit: limits.total_limit,
    current_outstanding: limits.current_outstanding,
    min_due: limits.min_due,
    account_balance: accountBalance,
  };
}

/**
 * Resolves matched asset_account (bank/wallet/meal card) or credit_card for an SMS message.
 */
export function resolveAccountAndCardFromSms(db, text = '', sender = '', { memberId = null, cachedAccounts = null, cachedCards = null } = {}) {
  const info = parseAccountDetailsFromText(text, sender);
  const last4 = info.last4 || '';
  const dcLast4 = info.debit_card_last_4 || '';
  const acctLast4 = info.account_number || '';
  const issuer = info.issuer || '';
  const [clause, params] = memberClause(memberId, 'WHERE');

  const existingAccounts = cachedAccounts || db.all(`SELECT id, name, category, institution, account_number, debit_card_last_4 FROM asset_accounts${clause}`, params);
  const existingCards = cachedCards || db.all(`SELECT id, card_name, bank, last_4, total_limit, available_limit, current_balance FROM credit_cards${clause}`, params);

  let matchedAccountId = null;
  let matchedCardId = null;
  let matchedAccount = null;
  let matchedCard = null;

  if (info.isCreditCard) {
    if (last4) {
      matchedCard = existingCards.find((c) => c.last_4 && c.last_4.endsWith(last4))
        || existingCards.find((c) => c.card_name && c.card_name.includes(last4));
    }
    if (!matchedCard && issuer && issuer !== 'Bank') {
      const issuerLower = issuer.toLowerCase();
      matchedCard = existingCards.find((c) => (c.bank && c.bank.toLowerCase().includes(issuerLower))
        || (c.card_name && c.card_name.toLowerCase().includes(issuerLower)));
    }
    if (matchedCard) {
      matchedCardId = matchedCard.id;
    }
  } else {
    // Bank account or Debit card or Wallet/Meal Card
    if (dcLast4) {
      matchedAccount = existingAccounts.find((a) => a.debit_card_last_4 && a.debit_card_last_4.endsWith(dcLast4));
    }
    if (!matchedAccount && acctLast4) {
      matchedAccount = existingAccounts.find((a) => a.account_number && a.account_number.endsWith(acctLast4));
    }
    if (!matchedAccount && last4) {
      matchedAccount = existingAccounts.find((a) =>
        (a.debit_card_last_4 && a.debit_card_last_4.endsWith(last4))
        || (a.account_number && a.account_number.endsWith(last4))
        || (a.name && a.name.includes(last4)));
    }
    if (!matchedAccount && issuer && issuer !== 'Bank') {
      const issuerLower = issuer.toLowerCase();
      const matchingInst = existingAccounts.filter((a) => (a.institution && a.institution.toLowerCase().includes(issuerLower))
        || (a.name && a.name.toLowerCase().includes(issuerLower)));
      if (matchingInst.length === 1) {
        matchedAccount = matchingInst[0];
      }
    }
    if (matchedAccount) {
      matchedAccountId = matchedAccount.id;
    } else if (last4 && !info.isDebitCard && !info.isBankAccount) {
      // Fallback: check if last4 matches a credit card
      matchedCard = existingCards.find((c) => c.last_4 && c.last_4.endsWith(last4));
      if (matchedCard) matchedCardId = matchedCard.id;
    }
  }

  return {
    account_id: matchedAccountId,
    card_id: matchedCardId,
    account: matchedAccount,
    card: matchedCard,
    info,
  };
}

/**
 * Automatically updates bank account or wallet balances from SMS text.
 */
export function autoUpdateAccountFromSms(db, text = '', sender = '', matchedAccountId = null) {
  const info = parseAccountDetailsFromText(text, sender);
  let accountId = matchedAccountId;
  if (!accountId) {
    const res = resolveAccountAndCardFromSms(db, text, sender);
    accountId = res.account_id;
  }
  if (!accountId) return null;

  const account = db.get('SELECT id, balance FROM asset_accounts WHERE id = ?', [accountId]);
  if (!account) return null;

  if (info.account_balance !== null && info.account_balance !== undefined && info.account_balance >= 0) {
    db.run(
      'UPDATE asset_accounts SET balance = ?, updated_at = ? WHERE id = ?',
      [info.account_balance, new Date().toISOString(), accountId],
    );
    return {
      account_id: accountId,
      balance: info.account_balance,
    };
  }
  return null;
}

/**
 * Automatically updates credit card limits and balances from SMS text.
 */
export function autoUpdateCreditCardFromSms(db, text = '', sender = '', matchedCardId = null) {
  const info = parseAccountDetailsFromText(text, sender);
  let cardId = matchedCardId;
  if (!cardId) {
    const res = resolveAccountAndCardFromSms(db, text, sender);
    cardId = res.card_id;
  }
  if (!cardId) return null;

  const card = db.get('SELECT id, total_limit, available_limit, current_balance FROM credit_cards WHERE id = ?', [cardId]);
  if (!card) return null;

  let newAvail = info.available_limit !== null && info.available_limit !== undefined ? info.available_limit : card.available_limit;
  let newTotal = info.total_limit && info.total_limit > 0 ? info.total_limit : card.total_limit;
  let newBal = card.current_balance;

  if (info.current_outstanding !== null && info.current_outstanding !== undefined && info.current_outstanding >= 0) {
    newBal = info.current_outstanding;
  } else if (newTotal > 0 && newAvail !== null && newAvail !== undefined) {
    newBal = Math.max(0, newTotal - newAvail);
  }

  if (newAvail !== null && newAvail !== undefined && newTotal > 0 && newAvail > newTotal) {
    newTotal = newAvail;
  }

  db.run(
    'UPDATE credit_cards SET total_limit = ?, available_limit = ?, current_balance = ?, updated_at = ? WHERE id = ?',
    [newTotal, newAvail, newBal, new Date().toISOString(), cardId],
  );

  return {
    card_id: cardId,
    total_limit: newTotal,
    available_limit: newAvail,
    current_balance: newBal,
  };
}

export function discoverAccountsFromSms(db) {
  const transactions = db.all("SELECT raw_sms, type, amount, date, id FROM transactions WHERE raw_sms IS NOT NULL AND raw_sms != '' ORDER BY date DESC, id DESC");
  const existingAccounts = db.all('SELECT id, name, category, institution, account_number, debit_card_last_4 FROM asset_accounts');
  const existingCards = db.all('SELECT id, card_name, bank, last_4 FROM credit_cards');

  const ignoredRows = db.all('SELECT identifier, issuer, last_4 FROM ignored_discovered_accounts');
  const ignoredSet = new Set();
  for (const r of ignoredRows) {
    if (r.identifier) ignoredSet.add(String(r.identifier).trim().toLowerCase());
    if (r.issuer && r.last_4) ignoredSet.add(`${String(r.issuer).trim()}:${String(r.last_4).trim()}`.toLowerCase());
    if (r.last_4) ignoredSet.add(String(r.last_4).trim().toLowerCase());
  }

  // Pre-collect existing last_4 digits across both cards and accounts
  const extractDigits4 = (str) => {
    if (!str) return '';
    const digits = String(str).replace(/\D/g, '');
    return digits.length >= 4 ? digits.slice(-4).toLowerCase() : '';
  };

  const existingCardLast4Set = new Set();
  const existingAccountLast4Set = new Set();
  const existingDebitCardLast4Set = new Set();
  const existingAllLast4Set = new Set();

  for (const c of existingCards) {
    const d = extractDigits4(c.last_4) || extractDigits4(c.card_name);
    if (d) {
      existingCardLast4Set.add(d);
      existingAllLast4Set.add(d);
    }
  }
  for (const a of existingAccounts) {
    const acctD = extractDigits4(a.account_number) || extractDigits4(a.name);
    if (acctD) {
      existingAccountLast4Set.add(acctD);
      existingAllLast4Set.add(acctD);
    }
    const dcD = extractDigits4(a.debit_card_last_4);
    if (dcD) {
      existingDebitCardLast4Set.add(dcD);
      existingAllLast4Set.add(dcD);
    }
  }

  const discovered = [];
  const map = new Map();

  for (const m of transactions) {
    const text = m.raw_sms || '';
    const info = parseAccountDetailsFromText(text);
    if (!info.last4 && !info.isFoodCard && !info.isWallet) continue;

    // Filter out invalid/generic issuers or payees
    if (info.issuer === 'Bank' && !info.last4) continue;
    if ((info.issuer === 'Amazon Pay' || info.issuer === 'PhonePe' || info.issuer === 'Google Pay' || info.issuer === 'Paytm') && info.instrument_type === 'bank_account') {
      continue;
    }

    const last4 = info.last4 || (info.isFoodCard ? 'Meal Card' : 'Wallet');
    const key = `${info.instrument_type}:${info.issuer}:${last4}`.toLowerCase();

    if (ignoredSet.has(key)
      || ignoredSet.has(`${info.issuer}:${last4}`.toLowerCase())
      || (last4.length === 4 && (ignoredSet.has(last4.toLowerCase()) || existingAllLast4Set.has(last4.toLowerCase())))) {
      continue;
    }

    let entry = map.get(key);
    if (!entry) {
      entry = {
        info,
        last4,
        instrument_type: info.instrument_type,
        txn_count: 0,
        total_spent: 0,
        total_received: 0,
        total_limit: info.total_limit || 0,
        available_limit: info.available_limit,
        current_balance: info.current_outstanding || 0,
        balance: info.account_balance || 0,
        last_balance_date: (info.account_balance !== null && info.account_balance !== undefined) ? (m.date || '') : '',
        last_seen: m.date || '',
        sample_sms: text.trim(),
      };
      map.set(key, entry);
    }

    if (info.account_balance !== null && info.account_balance !== undefined && info.account_balance >= 0) {
      if (!entry.balance || !entry.last_balance_date || (m.date && m.date >= entry.last_balance_date)) {
        entry.balance = info.account_balance;
        entry.last_balance_date = m.date || '';
      }
    }
    if (info.available_limit !== null && info.available_limit !== undefined) {
      entry.available_limit = info.available_limit;
    }
    if (info.total_limit && info.total_limit > 0) {
      entry.total_limit = info.total_limit;
    }
    if (info.current_outstanding !== null && info.current_outstanding !== undefined) {
      entry.current_balance = info.current_outstanding;
    }

    entry.txn_count += 1;
    const amt = Math.abs(Number(m.amount) || 0);
    if (m.type === 'expense' || m.type === 'debit') {
      entry.total_spent += amt;
    } else if (m.type === 'income' || m.type === 'credit') {
      entry.total_received += amt;
    }
    if (m.date && (!entry.last_seen || m.date > entry.last_seen)) {
      entry.last_seen = m.date;
      entry.sample_sms = text.trim();
    }
  }

  for (const entry of map.values()) {
    const { info, last4, instrument_type } = entry;

    if (ignoredSet.has(`${instrument_type}:${info.issuer}:${last4}`.toLowerCase())
      || ignoredSet.has(`${info.issuer}:${last4}`.toLowerCase())
      || (last4.length === 4 && (ignoredSet.has(last4.toLowerCase()) || existingAllLast4Set.has(last4.toLowerCase())))) {
      continue;
    }

    if (instrument_type === 'debit_card') {
      const alreadyHas = existingDebitCardLast4Set.has(last4)
        || existingCardLast4Set.has(last4)
        || existingAccounts.some((a) =>
          (a.debit_card_last_4 && a.debit_card_last_4.endsWith(last4))
          || (a.account_number && a.account_number.endsWith(last4))
          || (a.name && a.name.includes(last4)));
      if (!alreadyHas) {
        discovered.push({
          kind: 'account',
          bank: info.issuer,
          category: 'Bank',
          account_type: 'Debit Card',
          instrument_type: 'debit_card',
          is_debit_card: true,
          institution: info.issuer,
          name: `${info.issuer} Debit Card (${last4})`,
          account_number: info.account_number || '',
          debit_card_last_4: last4,
          last_4: last4,
          suggested_name: `${info.issuer} Debit Card (${last4})`,
          balance: entry.balance || 0,
          txn_count: entry.txn_count,
          total_spent: Math.round(entry.total_spent * 100) / 100,
          total_received: Math.round(entry.total_received * 100) / 100,
          last_seen: entry.last_seen,
          sample_sms: entry.sample_sms,
        });
      }
    } else if (instrument_type === 'meal_card') {
      const alreadyHas = existingAccounts.some((a) =>
        (a.category === 'Meal Card' || (a.institution && a.institution.toLowerCase().includes(info.issuer.toLowerCase())))
        && (a.account_number === last4 || (a.name && a.name.includes(last4))));
      if (!alreadyHas) {
        discovered.push({
          kind: 'account',
          bank: info.issuer,
          category: 'Meal Card',
          account_type: 'Meal Card',
          instrument_type: 'meal_card',
          institution: info.issuer,
          name: `${info.issuer} ${info.cardVariant || 'Meal Card'}${last4 !== 'Card' && last4 !== 'Meal Card' ? ` (${last4})` : ''}`,
          account_number: last4 !== 'Card' && last4 !== 'Meal Card' ? last4 : '',
          last_4: last4,
          suggested_name: `${info.issuer} ${info.cardVariant || 'Meal Card'}${last4 !== 'Card' && last4 !== 'Meal Card' ? ` (${last4})` : ''}`,
          balance: entry.balance || 0,
          txn_count: entry.txn_count,
          total_spent: Math.round(entry.total_spent * 100) / 100,
          total_received: Math.round(entry.total_received * 100) / 100,
          last_seen: entry.last_seen,
          sample_sms: entry.sample_sms,
        });
      }
    } else if (instrument_type === 'wallet') {
      const alreadyHas = existingAccounts.some((a) =>
        a.category === 'Wallet' && (a.name.toLowerCase().includes(info.issuer.toLowerCase()) || (a.account_number && a.account_number === last4)));
      if (!alreadyHas) {
        discovered.push({
          kind: 'account',
          bank: info.issuer,
          category: 'Wallet',
          account_type: 'Wallet',
          instrument_type: 'wallet',
          institution: info.issuer,
          name: `${info.issuer} Wallet${last4 !== 'Card' && last4 !== 'Wallet' ? ` (${last4})` : ''}`,
          account_number: last4 !== 'Card' && last4 !== 'Wallet' ? last4 : '',
          last_4: last4,
          suggested_name: `${info.issuer} Wallet${last4 !== 'Card' && last4 !== 'Wallet' ? ` (${last4})` : ''}`,
          balance: entry.balance || 0,
          txn_count: entry.txn_count,
          total_spent: Math.round(entry.total_spent * 100) / 100,
          total_received: Math.round(entry.total_received * 100) / 100,
          last_seen: entry.last_seen,
          sample_sms: entry.sample_sms,
        });
      }
    } else if (instrument_type === 'prepaid_card') {
      const alreadyHas = existingAccounts.some((a) =>
        a.category === 'Prepaid Card' && (a.account_number === last4 || (a.name && a.name.includes(last4))));
      if (!alreadyHas) {
        discovered.push({
          kind: 'account',
          bank: info.issuer,
          category: 'Prepaid Card',
          account_type: 'Prepaid Card',
          instrument_type: 'prepaid_card',
          institution: info.issuer,
          name: `${info.issuer} Prepaid Card (${last4})`,
          account_number: last4 !== 'Card' ? last4 : '',
          last_4: last4,
          suggested_name: `${info.issuer} Prepaid Card (${last4})`,
          balance: entry.balance || 0,
          txn_count: entry.txn_count,
          total_spent: Math.round(entry.total_spent * 100) / 100,
          total_received: Math.round(entry.total_received * 100) / 100,
          last_seen: entry.last_seen,
          sample_sms: entry.sample_sms,
        });
      }
    } else if (instrument_type === 'credit_card') {
      const alreadyHas = existingCardLast4Set.has(last4)
        || existingDebitCardLast4Set.has(last4)
        || existingCards.some((c) =>
          (c.last_4 && c.last_4.endsWith(last4))
          || (c.card_name && c.card_name.includes(last4)));
      if (!alreadyHas) {
        const displayName = info.cardVariant ? `${info.issuer} ${info.cardVariant}` : `${info.issuer} Credit Card`;
        const discoveredTotalLimit = entry.total_limit || info.total_limit || 0;
        const discoveredAvailLimit = entry.available_limit !== null && entry.available_limit !== undefined ? entry.available_limit : info.available_limit;
        let discoveredBalance = entry.current_balance || info.current_outstanding || 0;
        if (!discoveredBalance && discoveredTotalLimit > 0 && discoveredAvailLimit !== null && discoveredAvailLimit !== undefined) {
          discoveredBalance = Math.max(0, discoveredTotalLimit - discoveredAvailLimit);
        }
        discovered.push({
          kind: 'card',
          bank: info.issuer,
          card_name: displayName,
          account_type: 'Credit Card',
          instrument_type: 'credit_card',
          last_4: last4,
          suggested_name: `${displayName}${last4 !== 'Card' ? ` (${last4})` : ''}`,
          total_limit: discoveredTotalLimit,
          available_limit: discoveredAvailLimit,
          current_balance: discoveredBalance,
          txn_count: entry.txn_count,
          total_spent: Math.round(entry.total_spent * 100) / 100,
          total_received: Math.round(entry.total_received * 100) / 100,
          last_seen: entry.last_seen,
          sample_sms: entry.sample_sms,
        });
      }
    } else {
      const alreadyHas = existingAccountLast4Set.has(last4)
        || existingDebitCardLast4Set.has(last4)
        || existingCardLast4Set.has(last4)
        || existingAccounts.some((a) =>
          (a.account_number && a.account_number.endsWith(last4))
          || (a.name && a.name.includes(last4)));
      if (!alreadyHas) {
        discovered.push({
          kind: 'account',
          bank: info.issuer,
          category: 'Bank',
          account_type: 'Savings',
          instrument_type: 'bank_account',
          institution: info.issuer,
          name: `${info.issuer} Savings${last4 !== 'Card' ? ` (${last4})` : ''}`,
          account_number: last4 !== 'Card' ? last4 : '',
          last_4: last4,
          suggested_name: `${info.issuer} A/c${last4 !== 'Card' ? ` (${last4})` : ''}`,
          balance: entry.balance || 0,
          txn_count: entry.txn_count,
          total_spent: Math.round(entry.total_spent * 100) / 100,
          total_received: Math.round(entry.total_received * 100) / 100,
          last_seen: entry.last_seen,
          sample_sms: entry.sample_sms,
        });
      }
    }
  }

  return {
    status: 'success',
    discovered,
    existing_accounts: existingAccounts,
    existing_cards: existingCards,
  };
}

export function addDiscoveredAccounts(db, args = {}) {
  const items = Array.isArray(args.accounts) ? args.accounts : [];
  if (!items.length) return { status: 'success', added: 0 };

  const memberId = resolveMemberId(db, args.member_id);
  let added = 0;

  db.transaction(() => {
    for (const item of items) {
      const isCard = item.kind === 'card' || item.instrument_type === 'credit_card';
      const isDebit = Boolean(item.is_debit_card || item.instrument_type === 'debit_card');
      const bank = String(item.bank || item.institution || 'Bank').trim();
      const last4 = String(item.last_4 || '').trim();

      if (isCard) {
        const cardName = String(item.suggested_name || item.card_name || item.name || `${bank} Credit Card`).trim();
        const limit = Math.abs(Number(item.total_limit) || 0);
        const avail = item.available_limit !== null && item.available_limit !== undefined ? Math.abs(Number(item.available_limit) || 0) : null;
        let bal = Math.abs(Number(item.current_balance) || 0);
        if (!bal && limit > 0 && avail !== null) {
          bal = Math.max(0, limit - avail);
        }
        const cardRes = db.run(
          'INSERT INTO credit_cards (member_id, card_name, bank, last_4, total_limit, available_limit, current_balance, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [memberId, cardName, bank, last4, limit, avail, bal, new Date().toISOString()],
        );
        const newCardId = cardRes.lastInsertRowid;
        if (last4 && last4.length >= 4) {
          db.run(
            "UPDATE transactions SET card_id = ? WHERE (card_id IS NULL OR card_id = 0) AND raw_sms LIKE '%' || ? || '%'",
            [newCardId, last4],
          );
        }
        added += 1;
      } else {
        const name = String(item.suggested_name || item.name || `${bank} Account`).trim();
        const category = String(item.category || (isDebit ? 'Bank' : (item.instrument_type === 'meal_card' ? 'Meal Card' : (item.instrument_type === 'wallet' ? 'Wallet' : (item.instrument_type === 'prepaid_card' ? 'Prepaid Card' : 'Bank'))))).trim();
        const institution = bank;
        const accountNum = String(item.account_number || (isDebit ? '' : last4) || '').trim();
        const debitCardLast4 = String(item.debit_card_last_4 || (isDebit ? last4 : '') || '').trim();
        let bal = Math.abs(Number(item.balance) || 0);

        if (!bal) {
          const matchPats = [accountNum ? accountNum.slice(-4) : '', debitCardLast4 ? debitCardLast4.slice(-4) : '', last4 ? last4.slice(-4) : ''].filter((p) => p && p.length >= 4);
          for (const pat of matchPats) {
            const matchingTxns = db.all(
              "SELECT raw_sms FROM transactions WHERE raw_sms IS NOT NULL AND raw_sms != '' AND raw_sms LIKE '%' || ? || '%' ORDER BY date DESC, id DESC LIMIT 50",
              [pat],
            );
            for (const m of matchingTxns) {
              const detected = extractAccountBalanceFromText(m.raw_sms);
              if (detected !== null && detected !== undefined && detected > 0) {
                bal = detected;
                break;
              }
            }
            if (bal > 0) break;
          }
        }

        const result = db.run(
          'INSERT INTO asset_accounts (member_id, name, category, institution, account_number, debit_card_last_4, balance) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [memberId, name, category, institution, accountNum, debitCardLast4, bal],
        );
        const newAccId = result.lastInsertRowid;
        if (accountNum) {
          db.run(
            "UPDATE transactions SET account_id = ? WHERE (account_id IS NULL OR account_id = 0) AND raw_sms LIKE '%' || ? || '%'",
            [newAccId, accountNum],
          );
        }
        if (debitCardLast4) {
          db.run(
            "UPDATE transactions SET account_id = ? WHERE (account_id IS NULL OR account_id = 0) AND raw_sms LIKE '%' || ? || '%'",
            [newAccId, debitCardLast4],
          );
        }
        added += 1;
      }

      // Register all keys into ignored_discovered_accounts
      const instType = item.instrument_type || (isCard ? 'credit_card' : (isDebit ? 'debit_card' : 'bank_account'));
      const keys = [
        `${instType}:${bank}:${last4}`.toLowerCase(),
        `${bank}:${last4}`.toLowerCase(),
        last4 ? last4.toLowerCase() : null,
      ].filter(Boolean);

      for (const k of keys) {
        db.run(
          'INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
          [k, bank, last4, new Date().toISOString()],
        );
      }
    }
  });

  return { status: 'success', added };
}

export function combineDiscoveredAccount(db, args = {}) {
  const targetId = Number(args.target_id);
  const targetType = args.target_type; // 'account' or 'card'
  const last4 = String(args.last_4 || '').trim();
  const bank = String(args.bank || args.institution || '').trim();
  const isDebitCard = Boolean(args.is_debit_card || args.link_as === 'debit_card' || args.instrument_type === 'debit_card');
  const updateLast4 = Boolean(args.update_last_4);

  if (!targetId || !targetType) {
    return fail('BAD_REQUEST', 'Target account is required.');
  }

  db.transaction(() => {
    if (targetType === 'card') {
      const card = db.get('SELECT id, last_4, bank, total_limit, available_limit, current_balance FROM credit_cards WHERE id = ?', [targetId]);
      if (card) {
        const updateLast4Val = (updateLast4 && last4) || !card.last_4 ? last4 : card.last_4;
        const updateBank = card.bank ? card.bank : bank;
        const updateLimit = args.total_limit !== undefined ? Number(args.total_limit) : card.total_limit;
        const updateAvail = args.available_limit !== undefined ? Number(args.available_limit) : card.available_limit;
        const updateBal = args.current_balance !== undefined ? Number(args.current_balance) : card.current_balance;
        db.run('UPDATE credit_cards SET last_4 = ?, bank = ?, total_limit = ?, available_limit = ?, current_balance = ?, updated_at = ? WHERE id = ?',
          [updateLast4Val, updateBank, updateLimit, updateAvail, updateBal, new Date().toISOString(), targetId]);
        if (last4) {
          db.run(
            "UPDATE transactions SET card_id = ? WHERE (card_id IS NULL OR card_id = 0) AND raw_sms LIKE '%' || ? || '%'",
            [targetId, last4],
          );
        }
      }
    } else {
      const acc = db.get('SELECT id, account_number, debit_card_last_4, institution, balance FROM asset_accounts WHERE id = ?', [targetId]);
      if (acc) {
        if (isDebitCard) {
          const updateDebitCard = last4 || acc.debit_card_last_4;
          const updateInst = acc.institution ? acc.institution : bank;
          db.run('UPDATE asset_accounts SET debit_card_last_4 = ?, institution = ? WHERE id = ?', [updateDebitCard, updateInst, targetId]);
          if (last4) {
            db.run(
              "UPDATE transactions SET account_id = ? WHERE (account_id IS NULL OR account_id = 0) AND raw_sms LIKE '%' || ? || '%'",
              [targetId, last4],
            );
          }
        } else {
          const updateAccNum = (!acc.account_number || updateLast4) && last4 ? last4 : acc.account_number;
          const updateInst = acc.institution ? acc.institution : bank;
          db.run('UPDATE asset_accounts SET account_number = ?, institution = ? WHERE id = ?', [updateAccNum, updateInst, targetId]);
          if (last4) {
            db.run(
              "UPDATE transactions SET account_id = ? WHERE (account_id IS NULL OR account_id = 0) AND raw_sms LIKE '%' || ? || '%'",
              [targetId, last4],
            );
          }
        }
        if (args.balance && (!acc.balance || acc.balance === 0)) {
          db.run('UPDATE asset_accounts SET balance = ? WHERE id = ?', [Number(args.balance), targetId]);
        }
      }
    }

    // Register into ignored_discovered_accounts with all key variants
    const instType = args.instrument_type || (isDebitCard ? 'debit_card' : (targetType === 'card' ? 'credit_card' : 'bank_account'));
    const keys = [
      `${instType}:${bank}:${last4}`.toLowerCase(),
      `${bank}:${last4}`.toLowerCase(),
      last4 ? last4.toLowerCase() : null,
    ].filter(Boolean);

    for (const k of keys) {
      db.run(
        'INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
        [k, bank, last4, new Date().toISOString()],
      );
    }
  });

  return { status: 'success', combined: true };
}

export function mergeCards(db, args = {}) {
  const sourceCardId = Number(args.source_card_id);
  const targetCardId = Number(args.target_card_id);
  const updateLast4 = Boolean(args.update_last_4);
  const balanceAction = args.balance_action
    || (args.overwrite_balance ? 'use_source' : (args.add_balance === false ? 'keep_target' : 'add'));

  if (!sourceCardId || !targetCardId || sourceCardId === targetCardId) {
    return fail('BAD_REQUEST', 'Please choose two different cards to merge.');
  }

  const sourceCard = db.get('SELECT * FROM credit_cards WHERE id = ?', [sourceCardId]);
  const targetCard = db.get('SELECT * FROM credit_cards WHERE id = ?', [targetCardId]);

  if (!sourceCard) return fail('CARD_NOT_FOUND', 'Source card could not be found.');
  if (!targetCard) return fail('CARD_NOT_FOUND', 'Target card could not be found.');

  let movedTxns = 0;
  let movedStatements = 0;

  db.transaction(() => {
    // 1. Move all transactions from source card to target card
    const txnRes = db.run('UPDATE transactions SET card_id = ? WHERE card_id = ?', [targetCardId, sourceCardId]);
    movedTxns = txnRes.changes || 0;

    // 2. Move any imported statements
    try {
      const stmtRes = db.run('UPDATE imported_statements SET card_id = ? WHERE card_id = ?', [targetCardId, sourceCardId]);
      movedStatements = stmtRes.changes || 0;
    } catch {}

    // 3. Move any transactions that might have matched source card's last 4 digits
    if (sourceCard.last_4) {
      const sLast4 = String(sourceCard.last_4).trim().slice(-4);
      if (sLast4.length >= 4) {
        db.run(
          "UPDATE transactions SET card_id = ? WHERE (card_id IS NULL OR card_id = 0) AND raw_sms LIKE '%' || ? || '%'",
          [targetCardId, sLast4],
        );
      }
    }

    // 4. Update target card's last_4 if requested (e.g. source card had the new replacement card number)
    const newLast4 = (updateLast4 && sourceCard.last_4) ? sourceCard.last_4 : targetCard.last_4;
    const newTotalLimit = Math.max(Number(targetCard.total_limit) || 0, Number(sourceCard.total_limit) || 0);
    const newAvailLimit = sourceCard.available_limit !== null && sourceCard.available_limit !== undefined
      ? Number(sourceCard.available_limit)
      : targetCard.available_limit;

    let newBal;
    if (balanceAction === 'use_source') {
      newBal = Number(sourceCard.current_balance) || 0;
    } else if (balanceAction === 'keep_target') {
      newBal = Number(targetCard.current_balance) || 0;
    } else {
      newBal = (Number(targetCard.current_balance) || 0) + (Number(sourceCard.current_balance) || 0);
    }

    db.run(
      'UPDATE credit_cards SET last_4 = ?, total_limit = ?, available_limit = ?, current_balance = ?, updated_at = ? WHERE id = ?',
      [newLast4, newTotalLimit, newAvailLimit, newBal, new Date().toISOString(), targetCardId],
    );

    // 5. Register ignore rules for the source card so discovery won't recreate it
    const bank = sourceCard.bank || targetCard.bank || 'Bank';
    const last4 = sourceCard.last_4 || '';
    const keys = [
      `credit_card:${bank}:${last4}`.toLowerCase(),
      `card:${bank}:${last4}`.toLowerCase(),
      `${bank}:${last4}`.toLowerCase(),
      last4 ? last4.toLowerCase() : null,
    ].filter(Boolean);

    for (const k of keys) {
      db.run(
        'INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
        [k, bank, last4, new Date().toISOString()],
      );
    }

    // 6. Delete the source card
    db.run('DELETE FROM credit_cards WHERE id = ?', [sourceCardId]);
  });

  return {
    status: 'success',
    merged: true,
    moved_transactions: movedTxns,
    moved_statements: movedStatements,
    target_card_id: targetCardId,
  };
}

export function mergeAccounts(db, args = {}) {
  const sourceAccountId = Number(args.source_account_id);
  const targetAccountId = Number(args.target_account_id);
  const updateAccountNumber = Boolean(args.update_account_number);
  const updateDebitCard = Boolean(args.update_debit_card);
  const linkAsDebitCard = Boolean(args.link_as_debit_card);
  const balanceAction = args.balance_action
    || (args.overwrite_balance ? 'use_source' : (args.add_balance === false ? 'keep_target' : 'add'));

  if (!sourceAccountId || !targetAccountId || sourceAccountId === targetAccountId) {
    return fail('BAD_REQUEST', 'Please choose two different accounts to merge.');
  }

  const sourceAccount = db.get('SELECT * FROM asset_accounts WHERE id = ?', [sourceAccountId]);
  const targetAccount = db.get('SELECT * FROM asset_accounts WHERE id = ?', [targetAccountId]);

  if (!sourceAccount) return fail('ACCOUNT_NOT_FOUND', 'Source account could not be found.');
  if (!targetAccount) return fail('ACCOUNT_NOT_FOUND', 'Target account could not be found.');

  let movedTxns = 0;

  db.transaction(() => {
    // 1. Move all transactions from source account to target account
    const txnRes = db.run('UPDATE transactions SET account_id = ? WHERE account_id = ?', [targetAccountId, sourceAccountId]);
    movedTxns = txnRes.changes || 0;

    // 2. Link raw SMS from source account identifiers
    if (sourceAccount.account_number) {
      const sAcc = String(sourceAccount.account_number).trim().slice(-4);
      if (sAcc.length >= 4) {
        db.run(
          "UPDATE transactions SET account_id = ? WHERE (account_id IS NULL OR account_id = 0) AND raw_sms LIKE '%' || ? || '%'",
          [targetAccountId, sAcc],
        );
      }
    }
    if (sourceAccount.debit_card_last_4) {
      const sDc = String(sourceAccount.debit_card_last_4).trim().slice(-4);
      if (sDc.length >= 4) {
        db.run(
          "UPDATE transactions SET account_id = ? WHERE (account_id IS NULL OR account_id = 0) AND raw_sms LIKE '%' || ? || '%'",
          [targetAccountId, sDc],
        );
      }
    }

    // 3. Update target account properties
    const sourceAccNum = sourceAccount.account_number ? String(sourceAccount.account_number).trim() : '';
    const sourceDc = sourceAccount.debit_card_last_4 ? String(sourceAccount.debit_card_last_4).trim() : '';
    const targetAccNum = targetAccount.account_number ? String(targetAccount.account_number).trim() : '';
    const targetDc = targetAccount.debit_card_last_4 ? String(targetAccount.debit_card_last_4).trim() : '';

    let newAccNum = targetAccNum;
    let newDc = targetDc;

    if (linkAsDebitCard) {
      newDc = sourceDc || sourceAccNum || targetDc;
    } else {
      if (updateAccountNumber && sourceAccNum) {
        newAccNum = sourceAccNum;
      } else if (!targetAccNum && sourceAccNum) {
        newAccNum = sourceAccNum;
      }

      if (updateDebitCard && sourceDc) {
        newDc = sourceDc;
      } else if (!targetDc) {
        newDc = sourceDc || (sourceAccount.name?.toLowerCase().includes('debit') ? sourceAccNum : '');
      }
    }

    let newBal;
    if (balanceAction === 'use_source') {
      newBal = Number(sourceAccount.balance) || 0;
    } else if (balanceAction === 'keep_target') {
      newBal = Number(targetAccount.balance) || 0;
    } else {
      newBal = (Number(targetAccount.balance) || 0) + (Number(sourceAccount.balance) || 0);
    }

    db.run(
      'UPDATE asset_accounts SET account_number = ?, debit_card_last_4 = ?, balance = ?, updated_at = ? WHERE id = ?',
      [newAccNum, newDc, newBal, today(), targetAccountId],
    );

    // 4. Register ignore rules for source account
    const inst = sourceAccount.institution || targetAccount.institution || 'Bank';
    const accNum = sourceAccount.account_number ? sourceAccount.account_number.slice(-4) : '';
    const dcLast4 = sourceAccount.debit_card_last_4 ? sourceAccount.debit_card_last_4.slice(-4) : '';

    if (accNum && accNum.length >= 4) {
      db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
        [`bank_account:${inst}:${accNum}`.toLowerCase(), inst, accNum, new Date().toISOString()]);
      db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
        [`${inst}:${accNum}`.toLowerCase(), inst, accNum, new Date().toISOString()]);
    }
    if (dcLast4 && dcLast4.length >= 4) {
      db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
        [`debit_card:${inst}:${dcLast4}`.toLowerCase(), inst, dcLast4, new Date().toISOString()]);
      db.run('INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
        [`${inst}:${dcLast4}`.toLowerCase(), inst, dcLast4, new Date().toISOString()]);
    }

    // 5. Delete the source account
    db.run('DELETE FROM asset_accounts WHERE id = ?', [sourceAccountId]);
  });

  return {
    status: 'success',
    merged: true,
    moved_transactions: movedTxns,
    target_account_id: targetAccountId,
  };
}

export function ignoreDiscoveredAccount(db, args = {}) {
  const last4 = String(args.last_4 || '').trim();
  const issuer = String(args.issuer || args.bank || args.institution || '').trim();
  const instrumentType = String(args.instrument_type || (args.is_debit_card ? 'debit_card' : (args.kind === 'card' ? 'credit_card' : 'account'))).trim();

  if (!last4 && !issuer && !args.identifier) {
    return fail('BAD_REQUEST', 'Identifier or last 4 digits required.');
  }

  const keys = [
    args.identifier ? String(args.identifier).trim().toLowerCase() : null,
    `${instrumentType}:${issuer}:${last4}`.toLowerCase(),
    `${issuer}:${last4}`.toLowerCase(),
    last4 ? last4.toLowerCase() : null,
  ].filter(Boolean);

  for (const k of keys) {
    db.run(
      'INSERT OR REPLACE INTO ignored_discovered_accounts (identifier, issuer, last_4, ignored_at) VALUES (?, ?, ?, ?)',
      [k, issuer, last4, new Date().toISOString()],
    );
  }

  return { status: 'success', keys };
}

export function restoreDiscoveredAccount(db, args = {}) {
  const last4 = String(args.last_4 || '').trim();
  const issuer = String(args.issuer || args.bank || '').trim();
  const identifier = String(args.identifier || '').trim().toLowerCase();

  if (identifier) {
    db.run('DELETE FROM ignored_discovered_accounts WHERE identifier = ?', [identifier]);
  }
  if (issuer && last4) {
    db.run('DELETE FROM ignored_discovered_accounts WHERE issuer = ? AND last_4 = ?', [issuer, last4]);
  } else if (last4) {
    db.run('DELETE FROM ignored_discovered_accounts WHERE last_4 = ?', [last4]);
  }

  return { status: 'success' };
}

export function getIgnoredDiscoveredAccounts(db) {
  const ignored = db.all('SELECT * FROM ignored_discovered_accounts ORDER BY ignored_at DESC');
  return { status: 'success', ignored };
}

function getSalaryInvestmentTrend(db, args) {
  const [clause, params] = memberClause(args.member_id);
  const now = new Date();
  const months = [];

  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const monthKey = `${y}-${m}`;

    const nextD = new Date(y, d.getMonth() + 1, 1);
    const nextY = nextD.getFullYear();
    const nextM = String(nextD.getMonth() + 1).padStart(2, '0');
    const nextKey = `${nextY}-${nextM}`;

    const from = `${monthKey}-01`;
    const to = `${nextKey}-01`;

    const rows = db.all(
      `SELECT type, amount, is_investment_outflow FROM transactions
       ${clause ? `${clause} AND` : 'WHERE'} date >= ? AND date < ?`,
      [...params, from, to],
    );

    let income = 0;
    let expense = 0;
    let invested = 0;

    for (const r of rows) {
      const amt = Number(r.amount) || 0;
      if (r.type === 'Income') {
        income += amt;
      } else if (r.type === 'Transfer') {
        // transfers ignored
      } else if (r.is_investment_outflow || r.type === 'Investment') {
        invested += amt;
      } else {
        expense += amt;
      }
    }

    const netKept = income - expense - invested;
    const investRate = income > 0 ? Math.round((invested / income) * 100) : 0;
    const savingsRate = income > 0 ? Math.round(((income - expense) / income) * 100) : 0;

    months.push({
      month_key: monthKey,
      income: Math.round(income),
      expense: Math.round(expense),
      invested: Math.round(invested),
      net_kept: Math.round(netKept),
      investment_rate: investRate,
      savings_rate: savingsRate,
    });
  }

  return { status: 'success', months };
}

async function exportBackup(db, args) {
  const password = args.password;
  if (!password || String(password).length < 8) {
    return fail('BACKUP_PASSWORD_WEAK', 'Use a password of at least 8 characters.',
      'This password is the only thing protecting the export.');
  }

  const payload = {
    _meta: {
      app_version: APP_VERSION_NAME,
      app_version_code: APP_VERSION_CODE,
      schema_version: APP_VERSION_CODE,
      exported_at: new Date().toISOString(),
    },
  };
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

  // Extract version information from the backup.
  // Checks top-level _meta first, falls back to app_settings rows, defaults to 1 for early legacy exports.
  let backupVersionCode = 1;
  let backupVersionName = '';

  if (data._meta && typeof data._meta === 'object') {
    if (data._meta.app_version_code) {
      backupVersionCode = Number.parseInt(data._meta.app_version_code, 10) || 1;
    } else if (data._meta.schema_version) {
      backupVersionCode = Number.parseInt(data._meta.schema_version, 10) || 1;
    }
    if (data._meta.app_version) {
      backupVersionName = String(data._meta.app_version);
    }
  } else if (Array.isArray(data.app_settings)) {
    const codeRow = data.app_settings.find((row) => row.key === 'app_version_code' || row.key === 'schema_version');
    if (codeRow && codeRow.value) {
      backupVersionCode = Number.parseInt(codeRow.value, 10) || 1;
    }
    const nameRow = data.app_settings.find((row) => row.key === 'app_version');
    if (nameRow && nameRow.value) {
      backupVersionName = String(nameRow.value);
    }
  }

  // Enforce that the backup version is less than or equal to current app version.
  // Backups created with newer app releases cannot be safely restored on older builds.
  if (backupVersionCode > APP_VERSION_CODE) {
    const vStr = backupVersionName ? `v${backupVersionName}` : `build ${backupVersionCode}`;
    return fail(
      'BACKUP_VERSION_NEWER',
      `This backup was created with a newer version of Vitta Vriksha (${vStr}).`,
      `Please update the app to ${vStr} or newer to restore this backup.`,
    );
  }

  let restored = 0;
  db.exec('PRAGMA foreign_keys = OFF');
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

    // If restoring from an older version, sequentially apply schema migrations and update version metadata
    const current = getDatabaseVersion(db);
    if (current.versionCode < APP_VERSION_CODE) {
      runMigrations(db, current.versionCode, APP_VERSION_CODE);
    }
    runAdditiveMigrations(db);
    setDatabaseVersion(db, APP_VERSION_CODE, APP_VERSION_NAME);
  } catch (error) {
    if (error instanceof EmptyBackup) {
      return fail('BACKUP_EMPTY', 'That backup held no records.', 'Nothing was changed.');
    }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  return { restored, backup_version_code: backupVersionCode, backup_version_name: backupVersionName };
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
  transactions: [
    'transaction_splits',
    'transaction_cashbacks',
    'transactions',
    'ignored_alerts',
    'imported_statements',
  ],
  // A transaction can name the account it came out of, so those references have to be
  // released before the accounts go. Deleting straight out fails the foreign key.
  accounts: [
    'ignored_discovered_accounts',
    'asset_accounts',
  ],
  goals: ['goals'],
  loans: ['loans'],
  cards: [
    'imported_statements',
    'credit_cards',
  ],
  // The price history goes with the plan it describes: rows left behind would point at a
  // record that no longer exists and turn up in the next projection.
  subscriptions: ['subscriptions'],
  sips: ['sips'],
  recurring: ['recurring_dismissed'],
  events: ['custom_events'],
  holdings: [
    'folio_transactions',
    'mf_folios',
    'stock_transactions',
    'demat_holdings',
    'nps_holdings',
  ],
  rules: ['sms_rules', 'merchant_rules'],
  categories: ['custom_categories'],
  alerts: ['ignored_alerts', 'ignored_discovered_accounts'],
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
      if (kind === 'cards') {
        db.run('UPDATE transactions SET card_id = NULL WHERE card_id IS NOT NULL');
      }
      if (kind === 'sips' || kind === 'subscriptions') {
        // The price history describes records that are about to go. Left behind, it would
        // point at nothing and still turn up in the next projection.
        cleared += db.run('DELETE FROM price_changes WHERE kind = ?',
          [kind === 'sips' ? 'sip' : 'subscription']).changes;
      }
      if (kind === 'transactions' || kind === 'alerts') {
        db.run("DELETE FROM app_settings WHERE key IN ('last_sms_sync', 'pending_alerts_count')");
        try {
          takePendingAlerts();
        } catch {
          // Non-Android or test environment
        }
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

  try {
    takePendingAlerts();
  } catch {
    // Non-Android or test environment
  }

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
  get_debt_summary: calculateDebtSummary,
  get_home_loan_part_payment: (db, args) => calculateHomeLoanPartPayment(args.principal, args.annual_rate, args.tenure_years, args.extra_emis_per_year, args.annual_step_up_pct),
  get_credit_card_optimizer: getCreditCardOptimizer,
  get_dti_ratio: calculateDtiRatio,
  get_no_spend_days: calculateNoSpendDays,
  get_monthly_wrapped: getMonthlyFinanceWrapped,
  get_life_goals: (db, args) => calculateLifeGoals(args.goals, args.expected_cagr),
  evaluate_challenge: (db, args) => evaluateChallenge(db, args.challenge),
  get_local_sync_payload: generateLocalSyncPayload,
  get_fire_profile: getFireProfile,
  save_fire_settings: saveFireSettings,
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
  link_nps_account: linkNpsAccount,
  list_investments: listInvestments,
  get_holding_detail: getHoldingDetail,
  get_folio_transactions: getFolioTransactions,
  save_holding_cost: saveHoldingCost,
  add_stock_transaction: addStockTransaction,
  update_stock_transaction: updateStockTransaction,
  delete_stock_transaction: deleteStockTransaction,
  list_stock_transactions: listStockTransactions,
  import_stock_transactions: importStockTransactions,
  get_capital_gains_report: getCapitalGainsReport,
  get_holding_tax_lots: getHoldingTaxLots,
  get_family_members: getFamilyMembers,
  add_family_member: addFamilyMember,
  delete_family_member: deleteFamilyMember,
  get_categories: getCategories,
  save_category: saveCategory,
  delete_category: deleteCategory,
  get_transactions: getTransactions,
  save_transaction: saveTransaction,
  delete_transaction: deleteTransaction,
  ignore_transaction: ignoreTransaction,
  mark_transaction_duplicate: markTransactionDuplicate,
  restore_transaction: restoreTransaction,
  scan_ledger_duplicates: scanLedgerDuplicates,
  merge_ledger_transactions: mergeLedgerTransactions,
  split_transaction: splitTransaction,
  batch_update_transactions: batchUpdateTransactions,
  batch_delete_transactions: batchDeleteTransactions,
  discover_accounts_from_sms: discoverAccountsFromSms,
  add_discovered_accounts: addDiscoveredAccounts,
  combine_discovered_account: combineDiscoveredAccount,
  merge_cards: mergeCards,
  merge_accounts: mergeAccounts,
  ignore_discovered_account: ignoreDiscoveredAccount,
  restore_discovered_account: restoreDiscoveredAccount,
  get_ignored_discovered_accounts: getIgnoredDiscoveredAccounts,
  get_salary_investment_trend: getSalaryInvestmentTrend,
  export_backup: exportBackup,
  import_backup: importBackup,
  get_version_info: getVersionInfo,
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
