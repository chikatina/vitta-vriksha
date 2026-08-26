/*
 * One page implementation for every simple record list: accounts, SIPs, loans, cards,
 * subscriptions and goals.
 *
 * Each type declares its fields and how a row reads. The list, the empty state, the
 * add and edit sheet, validation and deletion are shared. Adding a new kind of record
 * means adding a config entry, not another screen.
 */

import { Bridge } from '../bridge.js';
import {
  icon, h, sheet, toast, confirmDialog, emptyState, errorBlock, selectField, bindSelectFields, showProgressModal,
} from '../ui.js';
import {
  formatCurrency, formatDate, formatDelta, formatMonthKey, formatRelativeDate, todayISO,
} from '../formatters.js';
import { barSeriesChart } from '../charts.js';
import { openCommitmentMenu } from './recurring.js';
import { openDiscoveredAccountSheet } from './rules.js';

const ACCOUNT_CATEGORIES = ['Bank', 'Meal Card', 'Wallet', 'Prepaid Card', 'Cash', 'FD', 'RD', 'Stock', 'MF', 'NPS', 'EPF', 'PPF', 'Gold', 'Property', 'Other'];
const LOAN_TYPES = ['Home', 'Car', 'Personal', 'Education', 'Gold', 'Business', 'Other'];
const BILLING_CYCLES = ['Monthly', 'Quarterly', 'Half-yearly', 'Annual'];

/**
 * When a yearly step-up lands.
 *
 * The anniversary of the start is the default because that is what a mandate set up through
 * a fund house does. A calendar month is offered because an increase timed to a pay rise is
 * the other common arrangement, and April is when most of them happen here.
 */
const STEP_UP_MONTHS = [
  { value: '0', label: 'On the anniversary' },
  { value: '1', label: 'Every January' },
  { value: '4', label: 'Every April' },
  { value: '7', label: 'Every July' },
  { value: '10', label: 'Every October' },
];

/** The record types that cost money on a schedule, and so can be stepped up. */
const COMMITMENT_KINDS = { sip: 'sip', subscription: 'subscription' };

/**
 * A loan is the same arithmetic whichever way the money went. What changes is which side
 * of the balance it lands on, and whether the instalment is one you pay or one you are
 * paid.
 */
const LOAN_DIRECTIONS = [
  { value: 'borrowed', label: 'I borrowed', sub: 'Money you owe' },
  { value: 'lent', label: 'I lent', sub: 'Money owed to you' },
];

const isLent = (loan) => loan.direction === 'lent';

const DAY_OPTIONS = Array.from({ length: 28 }, (_, i) => String(i + 1));

export const GOAL_PRESETS = [
  { icon: 'shield', title: 'Emergency Fund', target: 300000, months: 12, category: 'Safety' },
  { icon: 'directions_car', title: 'New Car / EV', target: 250000, months: 18, category: 'Vehicle' },
  { icon: 'home', title: 'House Downpayment', target: 1500000, months: 36, category: 'Property' },
  { icon: 'flight', title: 'Vacation Trip', target: 120000, months: 6, category: 'Travel' },
  { icon: 'volunteer_activism', title: 'Wedding & Family', target: 500000, months: 24, category: 'Family' },
  { icon: 'school', title: 'Higher Education', target: 1000000, months: 48, category: 'Education' },
  { icon: 'devices', title: 'Gadget Upgrade', target: 80000, months: 4, category: 'Electronics' },
  { icon: 'savings', title: '₹1 Crore Corpus', target: 10000000, months: 120, category: 'Wealth' },
];

export function getGoalGlyph(goal) {
  const text = `${goal?.title || ''} ${goal?.category || ''}`.toLowerCase();
  if (text.includes('emerg') || text.includes('safe') || text.includes('rainy')) return 'shield';
  if (text.includes('car') || text.includes('bike') || text.includes('vehicle') || text.includes('ev')) return 'directions_car';
  if (text.includes('house') || text.includes('home') || text.includes('flat') || text.includes('prop')) return 'home';
  if (text.includes('travel') || text.includes('trip') || text.includes('vacat') || text.includes('tour') || text.includes('flight')) return 'flight';
  if (text.includes('wed') || text.includes('marri') || text.includes('fam') || text.includes('ring')) return 'volunteer_activism';
  if (text.includes('edu') || text.includes('colleg') || text.includes('school') || text.includes('degree')) return 'school';
  if (text.includes('tech') || text.includes('phone') || text.includes('laptop') || text.includes('gadg') || text.includes('mac')) return 'devices';
  if (text.includes('crore') || text.includes('retire') || text.includes('corpus') || text.includes('wealth')) return 'savings';
  return 'flag';
}

export function getMonthsRemaining(targetDateStr) {
  if (!targetDateStr) return 1;
  const now = new Date();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(targetDateStr));
  if (!match) return 1;
  const target = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const diffMonths = (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
  return Math.max(1, diffMonths);
}

export const RECORD_CONFIG = {
  account: {
    heading: 'Accounts',
    addLabel: 'Add account',
    empty: ['account_balance', 'No accounts yet',
      'Add bank balances, deposits and manual holdings.'],
    totalLabel: 'Total value',
    total: (rows) => rows.reduce((s, r) => s + Number(r.balance || 0), 0),
    /*
     * What is asked for depends on the kind.
     *
     * A fixed deposit has a rate and a maturity date; a cash box has neither, and being
     * asked for them suggests the app has not understood what it is being told about.
     * A field with no `showFor` is asked of everything.
     */
    fields: [
      { key: 'category', label: 'Kind', type: 'select', options: ACCOUNT_CATEGORIES, half: true },
      { key: 'name', label: 'Name', type: 'text', required: true, half: true, placeholder: 'HDFC savings' },
      { key: 'balance', label: 'Balance', type: 'number', required: true },
      {
        key: 'institution',
        label: 'Institution',
        type: 'text',
        placeholder: 'HDFC Bank',
        showFor: ['Bank', 'Meal Card', 'Wallet', 'Prepaid Card', 'FD', 'RD', 'Stock', 'MF', 'NPS', 'EPF', 'PPF', 'Other'],
      },
      {
        key: 'account_number',
        label: 'Account / Card Number (Last 4)',
        type: 'text',
        placeholder: 'Optional',
        showFor: ['Bank', 'Meal Card', 'Wallet', 'Prepaid Card', 'FD', 'RD', 'Stock', 'MF', 'NPS', 'EPF', 'PPF'],
      },
      {
        key: 'debit_card_last_4',
        label: 'Linked Debit Card (Last 4)',
        type: 'text',
        placeholder: 'e.g. 5678',
        maxlength: 4,
        showFor: ['Bank'],
      },
      {
        key: 'interest_rate',
        label: 'Interest rate %',
        type: 'number',
        half: true,
        showFor: ['FD', 'RD', 'PPF', 'EPF', 'NPS', 'Bank'],
      },
      {
        key: 'maturity_date',
        label: 'Matures on',
        type: 'date',
        half: true,
        showFor: ['FD', 'RD', 'PPF'],
      },
      { key: 'notes', label: 'Note', type: 'textarea' },
    ],
    row: (r) => {
      let glyph = 'account_balance';
      let avatarClass = 'avatar-bank';
      if (r.category === 'Meal Card') { glyph = 'restaurant'; avatarClass = 'avatar-meal'; }
      else if (r.category === 'Wallet') { glyph = 'account_balance_wallet'; avatarClass = 'avatar-wallet'; }
      else if (r.category === 'Prepaid Card') { glyph = 'credit_card'; avatarClass = 'avatar-debit'; }
      else if (r.debit_card_last_4 && (!r.account_number || r.name?.toLowerCase().includes('debit'))) { glyph = 'payments'; avatarClass = 'avatar-debit'; }
      else if (r.category === 'Cash') { glyph = 'payments'; avatarClass = 'avatar-bank'; }
      else if (r.category === 'Gold') { glyph = 'savings'; avatarClass = 'avatar-bank'; }
      else if (r.category === 'Property') { glyph = 'home'; avatarClass = 'avatar-bank'; }
      else if (r.category === 'Stock' || r.category === 'MF' || r.category === 'NPS') { glyph = 'trending_up'; avatarClass = 'avatar-bank'; }

      const isNpsLinked = r.linked_holding_type === 'nps';
      const details = [
        r.institution,
        r.account_number ? (r.category === 'NPS' ? `PRAN: ${r.account_number}` : `ending ${r.account_number}`) : '',
        r.debit_card_last_4 ? `Debit Card ···· ${r.debit_card_last_4}` : '',
        isNpsLinked ? 'Linked to CAS' : '',
      ].filter(Boolean).join(' · ');

      return {
        glyph,
        avatarClass,
        title: r.name,
        sub: details || r.category,
        amount: r.balance,
      };
    },
  },

  sip: {
    heading: 'SIPs',
    addLabel: 'Add SIP',
    empty: ['trending_up', 'No SIPs tracked',
      'Add recurring investments to track monthly outflows.'],
    totalLabel: 'Every month',
    total: (rows) => rows.filter((r) => r.is_active !== 0)
      .reduce((s, r) => s + Number(r.monthly_amount || 0), 0),
    fields: [
      { key: 'scheme_name', label: 'Scheme', type: 'text', required: true, placeholder: 'Nifty 50 Index Fund' },
      { key: 'monthly_amount', label: 'Amount', type: 'number', required: true, half: true },
      { key: 'debit_day', label: 'Debits on', type: 'select', options: DAY_OPTIONS, half: true, default: '5' },
      {
        key: 'step_up_percent',
        label: 'Yearly step-up %',
        type: 'number',
        half: true,
        hint: 'A negative figure steps the instalment down instead.',
      },
      { key: 'step_up_month', label: 'Step-up applies', type: 'select', options: STEP_UP_MONTHS, half: true, default: '0' },
      { key: 'start_date', label: 'Started', type: 'date', half: true, default: todayISO },
      { key: 'is_active', label: 'Active', type: 'switch', half: true, default: 1 },
    ],
    row: (r) => ({
      glyph: 'trending_up',
      title: r.scheme_name,
      sub: [
        `Day ${r.debit_day} of each month`,
        Number(r.step_up_percent) ? `${Number(r.step_up_percent) > 0 ? 'step-up' : 'step-down'} ${Math.abs(Number(r.step_up_percent))}%` : '',
        r.is_active === 0 ? 'paused' : '',
      ].filter(Boolean).join(' · '),
      amount: r.monthly_amount,
      dim: r.is_active === 0,
    }),
    afterList: (host, app, records) => renderCommitmentOutlook(host, app, records, 'sip'),
  },

  loan: {
    heading: 'Loans',
    addLabel: 'Add loan',
    empty: ['account_balance', 'No loans tracked',
      'Add borrowed or lent amounts to track liabilities.'],
    // Two totals, because one net figure would hide the thing worth knowing: whether
    // what you owe and what you are owed are the same size or nothing like it.
    totals: (rows) => [
      {
        label: 'You owe',
        value: rows.filter((r) => !isLent(r))
          .reduce((sum, r) => sum + Number(r.current_outstanding || 0), 0),
        negative: true,
      },
      {
        label: 'Owed to you',
        value: rows.filter(isLent)
          .reduce((sum, r) => sum + Number(r.current_outstanding || 0), 0),
      },
    ].filter((total) => total.value > 0),
    negative: true,
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Home loan' },
      { key: 'direction', label: 'Direction', type: 'select', options: LOAN_DIRECTIONS, half: true, default: 'borrowed' },
      { key: 'loan_type', label: 'Kind', type: 'select', options: LOAN_TYPES, half: true },
      { key: 'principal_amount', label: 'Principal', type: 'number', required: true, half: true },
      { key: 'current_outstanding', label: 'Outstanding', type: 'number', required: true, half: true },
      { key: 'interest_rate', label: 'Rate %', type: 'number', required: true, half: true, default: 8.5 },
      { key: 'monthly_emi', label: 'Instalment', type: 'number', required: true, half: true },
      { key: 'tenure_months', label: 'Tenure in months', type: 'number', required: true, half: true, default: 240 },
      { key: 'start_date', label: 'Started', type: 'date', default: todayISO },
      { key: 'notes', label: 'Note', type: 'textarea' },
    ],
    row: (r) => {
      const bal = Number(r.current_outstanding) || 0;
      const emi = Number(r.monthly_emi) || 0;
      const rate = Number(r.interest_rate) || 0;
      let emiLeftStr = '';
      if (bal > 0 && emi > 0) {
        let emisLeft = 0;
        if (rate <= 0) {
          emisLeft = Math.ceil(bal / emi);
        } else {
          const monthlyRate = rate / 12 / 100;
          const monthlyInt = bal * monthlyRate;
          if (emi > monthlyInt) {
            const n = -Math.log(1 - (monthlyInt / emi)) / Math.log(1 + monthlyRate);
            emisLeft = Math.max(1, Math.ceil(n));
          } else {
            emisLeft = Number(r.tenure_months) || 0;
          }
        }
        if (emisLeft > 0) {
          const yrs = Math.floor(emisLeft / 12);
          const mos = emisLeft % 12;
          const timeStr = yrs > 0 ? (mos > 0 ? `${yrs}y ${mos}m` : `${yrs} yrs`) : `${mos} mos`;
          emiLeftStr = `${emisLeft} EMIs left (${timeStr})`;
        }
      }

      return {
        glyph: isLent(r) ? 'volunteer_activism' : 'account_balance',
        title: r.name,
        sub: [
          isLent(r) ? 'Lent' : 'Borrowed',
          r.loan_type,
          `${r.interest_rate}%`,
          `${Math.round(r.monthly_emi)}/mo`,
          emiLeftStr,
        ].filter(Boolean).join(' · '),
        amount: r.current_outstanding,
        positive: isLent(r),
      };
    },
    afterList: renderPrepaymentCalculator,
  },

  card: {
    heading: 'Credit cards',
    addLabel: 'Add card',
    empty: ['credit_card', 'No cards tracked',
      'Add credit cards to track limits and utilisation.'],
    totalLabel: 'Total owed',
    total: (rows) => rows.reduce((s, r) => s + Number(r.current_balance || 0), 0),
    negative: true,
    fields: [
      { key: 'card_name', label: 'Card', type: 'text', required: true, placeholder: 'Regalia Gold' },
      { key: 'bank', label: 'Bank', type: 'text', required: true, half: true, placeholder: 'HDFC' },
      { key: 'last_4', label: 'Last 4 digits', type: 'text', half: true, maxlength: 4 },
      { key: 'total_limit', label: 'Total Limit', type: 'number', required: true, half: true },
      { key: 'available_limit', label: 'Available Limit', type: 'number', half: true },
      { key: 'current_balance', label: 'Current balance', type: 'number', half: true },
      { key: 'due_date', label: 'Statement due on', type: 'select', options: DAY_OPTIONS, default: '15' },
    ],
    row: (r) => {
      const limit = Number(r.total_limit) || 0;
      const bal = Number(r.current_balance) || 0;
      const avail = r.available_limit !== null && r.available_limit !== undefined ? Number(r.available_limit) : (limit > 0 ? Math.max(0, limit - bal) : 0);
      const used = limit > 0 ? (bal / limit) * 100 : 0;
      const availSub = limit > 0 ? ` · Avl: ${money(avail)}` : '';
      return {
        glyph: 'credit_card',
        avatarClass: 'avatar-credit',
        title: r.card_name,
        sub: `${r.bank}${r.last_4 ? ` ···· ${r.last_4}` : ''} · Credit Card · ${used.toFixed(0)}% used${availSub}`,
        amount: r.current_balance,
        progress: { value: used, warn: used > 30 },
      };
    },
  },

  subscription: {
    heading: 'Subscriptions',
    addLabel: 'Add subscription',
    empty: ['subscriptions', 'No subscriptions tracked',
      'Add repeating subscriptions and bills.'],
    totalLabel: 'Per month',
    total: (rows) => rows.reduce((s, r) => s + monthlyEquivalent(r), 0),
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true, placeholder: 'Streaming plan' },
      { key: 'cost', label: 'Cost', type: 'number', required: true, half: true },
      { key: 'billing_cycle', label: 'Billed', type: 'select', options: BILLING_CYCLES, half: true },
      { key: 'next_billing_date', label: 'Next bill', type: 'date', required: true, default: todayISO },
      { key: 'category', label: 'Category', type: 'text', half: true, placeholder: 'Entertainment' },
      { key: 'auto_debit', label: 'Auto debit', type: 'switch', half: true, default: 1 },
      {
        key: 'annual_change_percent',
        label: 'Yearly price change %',
        type: 'number',
        half: true,
        hint: 'What this plan does every year. Used by the projections.',
      },
      { key: 'price_since', label: 'Price since', type: 'date', half: true, default: todayISO },
    ],
    row: (r) => ({
      glyph: 'subscriptions',
      title: r.name,
      sub: [
        r.billing_cycle,
        `next ${formatRelativeDate(r.next_billing_date)}`,
        Number(r.annual_change_percent) ? `${formatDelta(r.annual_change_percent, 1)} a year` : '',
      ].filter(Boolean).join(' · '),
      amount: r.cost,
    }),
    afterList: (host, app, records) => renderCommitmentOutlook(host, app, records, 'subscription'),
  },

  goal: {
    heading: 'Goals',
    addLabel: 'Add goal',
    empty: ['flag', 'No goals yet', 'Set financial targets and track your savings pace.'],
    totalLabel: 'Saved towards goals',
    total: (rows) => rows.reduce((s, r) => s + Number(r.current_amount || 0), 0),
    fields: [
      { key: 'title', label: 'Goal title', type: 'text', required: true, placeholder: 'Emergency Fund / New Car / House' },
      { key: 'target_amount', label: 'Target amount', type: 'number', required: true, half: true },
      { key: 'current_amount', label: 'Saved so far', type: 'number', half: true },
      { key: 'target_date', label: 'Target date', type: 'date', required: true, default: todayISO },
      { key: 'category', label: 'Category', type: 'text', half: true, placeholder: 'Safety / Property' },
      { key: 'notes', label: 'Note / Strategy', type: 'textarea' },
    ],
    row: (r) => {
      const target = Number(r.target_amount || 0);
      const current = Number(r.current_amount || 0);
      const progress = target > 0 ? Math.min(100, (current / target) * 100) : 0;
      const monthsLeft = getMonthsRemaining(r.target_date);
      const remaining = Math.max(0, target - current);
      const monthlyNeeded = Math.round(remaining / monthsLeft);

      return {
        glyph: getGoalGlyph(r),
        title: r.title,
        sub: progress >= 100
          ? 'Completed'
          : `${progress.toFixed(0)}% · ${formatCurrency(monthlyNeeded)}/mo · ${monthsLeft}m left`,
        amount: target,
        progress: { value: progress, positive: progress >= 100 },
      };
    },
    afterList: renderGoalPlannerSection,
  },
};

function monthlyEquivalent(subscription) {
  const cost = Number(subscription.cost || 0);
  switch (subscription.billing_cycle) {
    case 'Annual': return cost / 12;
    case 'Half-yearly': return cost / 6;
    case 'Quarterly': return cost / 3;
    default: return cost;
  }
}

/* ------------------------------------------------------------------- page */

export async function renderRecordPage(container, app, type) {
  const config = RECORD_CONFIG[type];
  const money = (v) => formatCurrency(v, app.currency, app.locale);

  // When viewing accounts or cards, provide dedicated segmented tabs
  const isAccountOrCard = type === 'account' || type === 'card';

  if (app.recordsContext !== type) {
    app.recordsContext = type;
    app.accountsTab = type === 'card' ? 'cards' : 'bank';
  }
  let currentTab = app.accountsTab || (type === 'card' ? 'cards' : 'bank');

  let accountsList = [];
  let cardsList = [];
  let discovered = [];
  let existingAccounts = [];
  let existingCards = [];
  let records = [];

  if (isAccountOrCard) {
    const [accRes, cardRes, discRes] = await Promise.all([
      Bridge.db('list_records', { record_type: 'account', member_id: app.memberFilter }),
      Bridge.db('list_records', { record_type: 'card', member_id: app.memberFilter }),
      Bridge.db('discover_accounts_from_sms'),
    ]);
    accountsList = accRes?.records || [];
    cardsList = cardRes?.records || [];
    discovered = discRes?.discovered || [];
    existingAccounts = discRes?.existing_accounts || accountsList;
    existingCards = discRes?.existing_cards || cardsList;
  } else {
    const res = await Bridge.db('list_records', { record_type: type, member_id: app.memberFilter });
    records = res.records || [];
  }

  const bankRecords = accountsList.filter((a) => !a.category || a.category === 'Bank' || a.category === 'Savings' || a.category === 'Current' || a.category === 'Cash');
  const cardRecords = cardsList;
  const walletRecords = accountsList.filter((a) => a.category === 'Meal Card' || a.category === 'Wallet' || a.category === 'Prepaid Card');
  const depositRecords = accountsList.filter((a) => a.category === 'FD' || a.category === 'RD' || a.category === 'PPF' || a.category === 'EPF' || a.category === 'NPS' || a.category === 'Stock' || a.category === 'MF' || a.category === 'Gold' || a.category === 'Property' || a.category === 'Other');

  let activeRecords = [];
  let activeConfig = config;
  let activeRecordType = type;

  if (isAccountOrCard) {
    if (currentTab === 'bank') {
      activeRecords = bankRecords;
      activeConfig = RECORD_CONFIG.account;
      activeRecordType = 'account';
    } else if (currentTab === 'cards') {
      activeRecords = cardRecords;
      activeConfig = RECORD_CONFIG.card;
      activeRecordType = 'card';
    } else if (currentTab === 'wallets') {
      activeRecords = walletRecords;
      activeConfig = RECORD_CONFIG.account;
      activeRecordType = 'account';
    } else if (currentTab === 'deposits') {
      activeRecords = depositRecords;
      activeConfig = RECORD_CONFIG.account;
      activeRecordType = 'account';
    } else if (currentTab === 'discovered') {
      activeRecords = discovered;
    } else if (currentTab === 'all') {
      activeRecords = [...accountsList, ...cardsList];
      activeConfig = RECORD_CONFIG.account;
    }
  } else {
    activeRecords = records;
  }

  // Segmented Tabs Header for Accounts & Credit Cards screen
  let tabsHeaderHtml = '';
  if (isAccountOrCard) {
    const tabs = [
      { id: 'bank', label: 'Bank Accounts', icon: 'account_balance', count: bankRecords.length },
      { id: 'cards', label: 'Credit Cards', icon: 'credit_card', count: cardRecords.length },
      { id: 'wallets', label: 'Wallets & Meal', icon: 'account_balance_wallet', count: walletRecords.length },
      { id: 'deposits', label: 'Deposits & Other', icon: 'savings', count: depositRecords.length },
      { id: 'discovered', label: 'Discovered', icon: 'star', count: discovered.length, badge: discovered.length > 0 },
      { id: 'all', label: 'All', icon: 'receipt_long', count: bankRecords.length + cardRecords.length + walletRecords.length + depositRecords.length },
    ];

    tabsHeaderHtml = `
      <div class="chip-scroller" style="margin-bottom:var(--gap-3);padding-bottom:4px">
        ${tabs.map((t) => {
          const isSelected = currentTab === t.id;
          return `
            <button type="button" class="chip" data-account-tab="${t.id}" aria-selected="${isSelected}">
              ${icon(t.icon, 'icon-sm')}
              <span>${t.label}</span>
              ${t.count ? `<span class="badge" style="font-size:11px;padding:0 7px;height:20px;border-radius:var(--radius-full);background:${isSelected ? 'var(--accent)' : (t.badge ? 'var(--accent-container)' : 'var(--surface-container-highest)')};color:${isSelected ? 'var(--on-accent)' : (t.badge ? 'var(--on-accent-container)' : 'var(--on-surface-variant)')}">${t.count}</span>` : ''}
            </button>`;
        }).join('')}
      </div>`;
  }

  // Discovered quick discovery banner if user is on another tab
  let discoveryBannerHtml = '';
  if (isAccountOrCard && currentTab !== 'discovered' && discovered.length > 0) {
    discoveryBannerHtml = `
      <div class="card-flat" style="background:var(--accent-container);color:var(--on-accent-container);padding:10px 14px;border-radius:var(--radius-md);margin-bottom:var(--gap-3);display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div class="row" style="gap:8px;align-items:center">
          ${icon('star', 'icon-sm')}
          <span style="font-size:12.5px;font-weight:600">${discovered.length} new ${discovered.length === 1 ? 'account/card' : 'accounts/cards'} found from SMS</span>
        </div>
        <button class="btn btn-filled btn-xs" data-switch-to-discovered style="background:var(--accent);color:var(--on-accent);padding:4px 10px">
          Review (${discovered.length})
        </button>
      </div>`;
  }

  // Loan Header
  let loanHeaderHtml = '';
  if (type === 'loan' && records.length) {
    const borrowed = records.filter((r) => !isLent(r));
    const totalEmi = borrowed.reduce((sum, r) => sum + Number(r.monthly_emi || 0), 0);
    const totalOwed = borrowed.reduce((sum, r) => sum + Number(r.current_outstanding || 0), 0);
    const totalLent = records.filter(isLent).reduce((sum, r) => sum + Number(r.current_outstanding || 0), 0);

    loanHeaderHtml = `
      <div class="card" style="background:linear-gradient(180deg, var(--surface-container-low), var(--surface-container));border:1px solid var(--outline-variant);margin-bottom:var(--gap-3)">
        <div class="row-between" style="margin-bottom:8px;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="overline" style="margin-bottom:0;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Combined Monthly EMI</span>
          <span class="badge badge-expense" style="flex-shrink:0">${borrowed.length} Active ${borrowed.length === 1 ? 'Loan' : 'Loans'}</span>
        </div>
        <div class="display expense" style="font-size:28px;margin-bottom:8px">
          ${h(money(totalEmi))}<span style="font-size:13px;font-weight:400;color:var(--on-surface-variant)"> / month</span>
        </div>
        <div class="grid-2" style="gap:8px;margin-top:var(--gap-2)">
          <div class="card-flat" style="padding:10px;background:var(--surface-container-high);border-radius:var(--radius-sm)">
            <span class="caption" style="font-size:11px">Total Outstanding Principal</span>
            <div style="font-weight:700;font-size:15px;margin-top:2px" class="expense">${h(money(totalOwed))}</div>
          </div>
          <div class="card-flat" style="padding:10px;background:var(--surface-container-high);border-radius:var(--radius-sm)">
            <span class="caption" style="font-size:11px">Lent / Owed to You</span>
            <div style="font-weight:700;font-size:15px;margin-top:2px" class="income">${h(money(totalLent))}</div>
          </div>
        </div>
      </div>`;
  }

  // Summary Stat cards for active tab
  let statCardsHtml = '';
  if (isAccountOrCard) {
    if (currentTab === 'bank' && bankRecords.length) {
      const totalBank = bankRecords.reduce((s, r) => s + Number(r.balance || 0), 0);
      statCardsHtml = `
        <div class="card-accent" style="margin-bottom:var(--gap-3)">
          <span class="overline" style="color:inherit;opacity:0.7">Total Bank & Cash Balance</span>
          <div class="balance-amount" style="font-size:30px">${h(money(totalBank))}</div>
        </div>`;
    } else if (currentTab === 'cards' && cardRecords.length) {
      const totalOwed = cardRecords.reduce((s, r) => s + Number(r.current_balance || 0), 0);
      const totalLimit = cardRecords.reduce((s, r) => s + Number(r.total_limit || 0), 0);
      const totalAvail = cardRecords.reduce((s, r) => {
        if (r.available_limit !== null && r.available_limit !== undefined) return s + Number(r.available_limit);
        const l = Number(r.total_limit || 0);
        const b = Number(r.current_balance || 0);
        return s + Math.max(0, l - b);
      }, 0);
      const usedPct = totalLimit > 0 ? (totalOwed / totalLimit) * 100 : 0;
      statCardsHtml = `
        <div class="card" style="background:linear-gradient(180deg, var(--surface-container-low), var(--surface-container));border:1px solid var(--outline-variant);margin-bottom:var(--gap-3)">
          <div class="row-between" style="margin-bottom:8px;gap:8px;align-items:center;flex-wrap:wrap">
            <span class="overline" style="margin-bottom:0;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Total Credit Card Owed</span>
            <span class="badge ${usedPct > 30 ? 'badge-expense' : 'badge-income'}" style="flex-shrink:0">${usedPct.toFixed(0)}% Utilized</span>
          </div>
          <div class="display expense" style="font-size:28px;margin-bottom:8px">
            ${h(money(totalOwed))}
          </div>
          <div class="row-between" style="font-size:12.5px;color:var(--on-surface-variant)">
            <span>Total Limit: <strong>${h(money(totalLimit))}</strong></span>
            <span>Available: <strong>${h(money(totalAvail))}</strong></span>
          </div>
          <div class="progress" style="margin-top:10px">
            <div class="progress-bar ${usedPct > 50 ? 'over' : ''}" style="width:${Math.min(100, Math.max(0, usedPct))}%"></div>
          </div>
        </div>`;
    } else if (currentTab === 'wallets' && walletRecords.length) {
      const totalWallets = walletRecords.reduce((s, r) => s + Number(r.balance || 0), 0);
      statCardsHtml = `
        <div class="card-accent" style="margin-bottom:var(--gap-3)">
          <span class="overline" style="color:inherit;opacity:0.7">Total Wallets & Meal Cards</span>
          <div class="balance-amount" style="font-size:30px">${h(money(totalWallets))}</div>
        </div>`;
    } else if (currentTab === 'deposits' && depositRecords.length) {
      const totalDeposits = depositRecords.reduce((s, r) => s + Number(r.balance || 0), 0);
      statCardsHtml = `
        <div class="card-accent" style="margin-bottom:var(--gap-3)">
          <span class="overline" style="color:inherit;opacity:0.7">Total Deposits & Other Holdings</span>
          <div class="balance-amount" style="font-size:30px">${h(money(totalDeposits))}</div>
        </div>`;
    } else if (currentTab === 'all' && activeRecords.length) {
      const totalAll = accountsList.reduce((s, r) => s + Number(r.balance || 0), 0);
      const totalOwed = cardsList.reduce((s, r) => s + Number(r.current_balance || 0), 0);
      statCardsHtml = `
        <div class="grid-2" style="margin-bottom:var(--gap-3)">
          <div class="stat">
            <span class="caption">Total Assets & Balances</span>
            <span class="stat-value income">${h(money(totalAll))}</span>
          </div>
          <div class="stat">
            <span class="caption">Total Credit Owed</span>
            <span class="stat-value expense">${h(money(totalOwed))}</span>
          </div>
        </div>`;
    }
  } else if (type !== 'loan' && activeRecords.length) {
    const totals = config.totals
      ? config.totals(activeRecords)
      : (config.total ? [{ label: config.totalLabel, value: config.total(activeRecords) }] : []);

    if (totals.length === 1) {
      statCardsHtml = `
        <div class="card-accent" style="margin-bottom:var(--gap-3)">
          <span class="overline" style="color:inherit;opacity:0.7">${h(totals[0].label)}</span>
          <div class="balance-amount" style="font-size:30px">${h(money(totals[0].value))}</div>
        </div>`;
    } else if (totals.length > 1) {
      statCardsHtml = `
        <div class="grid-2" style="margin-bottom:var(--gap-3)">
          ${totals.map((entry) => `
            <div class="stat">
              <span class="caption">${h(entry.label)}</span>
              <span class="stat-value ${entry.negative ? 'expense' : 'income'}">${h(money(entry.value))}</span>
            </div>`).join('')}
        </div>`;
    }
  }

  // Main List Content
  let listContentHtml = '';
  let addButtonLabel = activeConfig.addLabel;
  if (isAccountOrCard) {
    if (currentTab === 'bank') addButtonLabel = 'Add Bank Account';
    else if (currentTab === 'cards') addButtonLabel = 'Add Credit Card';
    else if (currentTab === 'wallets') addButtonLabel = 'Add Wallet / Meal Card';
    else if (currentTab === 'deposits') addButtonLabel = 'Add Deposit / Holding';
    else if (currentTab === 'all') addButtonLabel = 'Add Account or Card';
  }

  if (isAccountOrCard && currentTab === 'discovered') {
    if (discovered.length) {
      listContentHtml = `
        <div class="card" style="margin-bottom:var(--gap-3);border:1px solid var(--outline-variant)">
          <div class="row-between" style="align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
            <div class="row" style="gap:6px;align-items:center;min-width:0">
              <span style="color:var(--accent);display:flex;flex-shrink:0">${icon('star', 'icon-sm')}</span>
              <span style="font-weight:700;font-size:13.5px;white-space:nowrap">Discovered from SMS Alerts</span>
              <span class="badge badge-income" style="font-size:11px;padding:2px 8px">${discovered.length}</span>
            </div>
            <button class="btn btn-filled btn-xs" data-add-all-discovered style="flex-shrink:0">
              ${icon('check_circle', 'icon-sm')}Add All
            </button>
          </div>
          <p class="caption" style="margin-bottom:12px">
            Tap <strong>Link / Details</strong> to link a debit card to your bank account or combine with an existing card. Tap <strong>Ignore</strong> to remove alerts.
          </p>
          <div class="list" style="background:transparent;box-shadow:none;display:flex;flex-direction:column;gap:10px">
            ${discovered.map((d, i) => {
              const isCredit = d.instrument_type === 'credit_card';
              const isDebit = d.instrument_type === 'debit_card';
              const isMeal = d.instrument_type === 'meal_card' || d.category === 'Meal Card';
              const isWallet = d.instrument_type === 'wallet' || d.category === 'Wallet';
              const isPrepaid = d.instrument_type === 'prepaid_card' || d.category === 'Prepaid Card';

              let glyph = 'account_balance';
              let avatarClass = 'avatar-bank';
              let badgeClass = 'badge-income';
              let label = 'Bank A/c';

              if (isCredit) {
                glyph = 'credit_card';
                avatarClass = 'avatar-credit';
                badgeClass = 'badge-gold';
                label = 'Credit Card';
              } else if (isDebit) {
                glyph = 'payments';
                avatarClass = 'avatar-debit';
                badgeClass = 'badge-income';
                label = 'Debit Card';
              } else if (isMeal) {
                glyph = 'restaurant';
                avatarClass = 'avatar-meal';
                badgeClass = 'badge-warning';
                label = 'Meal Card';
              } else if (isWallet) {
                glyph = 'account_balance_wallet';
                avatarClass = 'avatar-wallet';
                badgeClass = 'badge-info';
                label = 'Wallet';
              } else if (isPrepaid) {
                glyph = 'credit_card';
                avatarClass = 'avatar-debit';
                badgeClass = 'badge-income';
                label = 'Prepaid';
              }

              return `
              <div class="card-flat" style="background:var(--surface-container-high);padding:14px;border-radius:var(--radius-md);border:1px solid var(--outline-variant);display:flex;flex-direction:column;gap:10px;width:100%;box-sizing:border-box">
                <div style="display:flex;align-items:flex-start;gap:12px;cursor:pointer" data-inspect-discovered="${i}">
                  <span class="avatar avatar-sm ${avatarClass}" style="flex-shrink:0;margin-top:2px">
                    ${icon(glyph, 'icon-sm')}
                  </span>
                  <div style="flex:1;min-width:0">
                    <div class="row-between" style="align-items:center;gap:6px">
                      <div style="font-weight:700;font-size:13.5px;color:var(--on-surface);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                        ${h(d.suggested_name || d.name || d.card_name)}
                      </div>
                      <span class="badge ${badgeClass}" style="font-size:10px;padding:1px 6px;text-transform:uppercase;letter-spacing:0.3px;flex-shrink:0">
                        ${h(label)}
                      </span>
                    </div>
                    <div class="caption" style="font-size:11.5px;margin-top:2px;color:var(--on-surface-variant)">
                      ${h(d.bank || d.institution || 'Bank')} · ending ${h(d.last_4)}
                    </div>
                    ${d.balance ? `
                      <div class="caption" style="color:var(--income);font-size:11px;font-weight:600;margin-top:3px">
                        Latest Balance: ${h(formatCurrency(d.balance, app.currency, app.locale))}
                      </div>` : ''}
                    ${isCredit && (d.total_limit || d.current_balance) ? `
                      <div class="caption" style="color:var(--expense);font-size:11px;font-weight:600;margin-top:3px">
                        ${d.current_balance ? `Outstanding: ${h(formatCurrency(d.current_balance, app.currency, app.locale))}` : ''}${d.total_limit ? ` · Limit: ${h(formatCurrency(d.total_limit, app.currency, app.locale))}` : ''}
                      </div>` : ''}
                    ${d.txn_count ? `
                      <div class="caption" style="color:var(--accent);font-size:11px;font-weight:600;margin-top:3px">
                        ${d.txn_count} alert${d.txn_count === 1 ? '' : 's'}${d.total_spent ? ` · ${h(formatCurrency(d.total_spent, app.currency, app.locale))}` : ''}${d.last_seen ? ` · Last active ${h(formatDate(d.last_seen))}` : ''}
                      </div>` : ''}
                  </div>
                </div>

                <div class="discovered-card-actions">
                  <button class="btn btn-tonal btn-xs" data-inspect-discovered="${i}">
                    ${icon('open_in_new', 'icon-sm')}Link / Details
                  </button>
                  <div class="discovered-btn-group">
                    <button class="btn btn-filled btn-xs" data-add-discovered="${i}">
                      ${icon('add', 'icon-sm')}Add
                    </button>
                    <button class="btn btn-outlined btn-xs" data-ignore-discovered="${i}" style="color:var(--on-surface-variant);border-color:var(--outline-variant)">
                      ${icon('visibility_off', 'icon-sm')}Ignore
                    </button>
                  </div>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>`;
    } else {
      listContentHtml = `<div class="card">${emptyState('star', 'No discovered accounts', 'Accounts and cards detected from your bank SMS alerts will appear here.')}</div>`;
    }
  } else if (activeRecords.length) {
    listContentHtml = `
      <div class="list">
        ${activeRecords.map((record) => {
          const rowRenderer = (record.card_name || record.total_limit !== undefined)
            ? RECORD_CONFIG.card.row
            : (activeConfig?.row || RECORD_CONFIG[type]?.row || RECORD_CONFIG.account.row);
          const row = rowRenderer(record);
          const isCardRecord = Boolean(record.card_name || record.total_limit !== undefined);
          return `
            <button class="list-row" data-record="${record.id}" data-is-card="${isCardRecord ? '1' : '0'}" ${row.dim ? 'style="opacity:0.55"' : ''}>
              <span class="avatar avatar-sm ${row.avatarClass || ''}">
                ${icon(row.glyph)}
              </span>
              <span class="list-row-main">
                <span class="list-row-title">${h(row.title)}</span>
                <span class="list-row-sub">${h(row.sub)}</span>
                ${row.progress ? `
                  <span class="bar-track" style="margin-top:6px">
                    <span class="bar-fill" style="display:block;width:${Math.min(100, row.progress.value)}%;
                      background:${row.progress.warn ? 'var(--expense)' : 'var(--accent)'}"></span>
                  </span>` : ''}
              </span>
              <span class="list-row-amount ${row.positive ? 'income' : (isCardRecord ? 'expense' : '')}">${h(money(row.amount))}</span>
            </button>`;
        }).join('')}
      </div>`;
  } else {
    listContentHtml = `<div class="card">${emptyState(...activeConfig.empty)}</div>`;
  }

  container.innerHTML = `
    ${tabsHeaderHtml}
    ${discoveryBannerHtml}
    ${loanHeaderHtml}
    ${statCardsHtml}
    ${config.note && activeRecords.length ? `
      <div class="banner">${icon('info')}<span class="banner-main"><span class="banner-body">${h(config.note)}</span></span></div>` : ''}
    ${listContentHtml}
    ${(currentTab !== 'discovered') ? `
      <button class="btn btn-tonal btn-block" data-add style="margin-top:var(--gap-3)">
        ${icon('add')}${h(addButtonLabel)}
      </button>` : ''}
    <div data-after></div>`;

  // Tab switching click handlers
  container.querySelectorAll('[data-account-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      app.accountsTab = btn.dataset.accountTab;
      renderRecordPage(container, app, type);
    });
  });

  const bannerSwitchBtn = container.querySelector('[data-switch-to-discovered]');
  if (bannerSwitchBtn) {
    bannerSwitchBtn.addEventListener('click', () => {
      app.accountsTab = 'discovered';
      renderRecordPage(container, app, type);
    });
  }

  // Discovered inspection & actions
  if (discovered.length) {
    container.querySelectorAll('[data-inspect-discovered]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = discovered[Number(btn.dataset.inspectDiscovered)];
        if (item) openDiscoveredAccountSheet(app, item, existingAccounts, existingCards);
      });
    });

    container.querySelectorAll('[data-add-discovered]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = discovered[Number(btn.dataset.addDiscovered)];
        if (!item) return;
        btn.disabled = true;
        btn.textContent = '...';

        const isCard = item.kind === 'card' || item.instrument_type === 'credit_card';
        const isDebit = item.is_debit_card || item.instrument_type === 'debit_card';
        const bank = item.bank || item.institution || 'Bank';
        const last4 = item.last_4 || '';

        const recordPayload = isCard ? {
          card_name: item.suggested_name || item.name || `${bank} Credit Card`,
          bank,
          last_4: last4,
          total_limit: item.total_limit || 0,
          available_limit: item.available_limit !== null && item.available_limit !== undefined ? item.available_limit : 0,
          current_balance: item.current_balance || 0,
        } : {
          name: item.suggested_name || item.name || `${bank} Account`,
          category: item.category || (isDebit ? 'Bank' : (item.instrument_type === 'meal_card' ? 'Meal Card' : (item.instrument_type === 'wallet' ? 'Wallet' : 'Bank'))),
          institution: bank,
          account_number: isDebit ? (item.account_number || '') : (last4 || item.account_number || ''),
          debit_card_last_4: isDebit ? (last4 || '') : (item.debit_card_last_4 || ''),
          balance: item.balance || 0,
        };

        const res = await Bridge.db('save_record', {
          record_type: isCard ? 'card' : 'account',
          record: recordPayload,
        });

        if (res && res.status === 'success') {
          await Bridge.db('ignore_discovered_account', {
            issuer: bank,
            last_4: last4,
            instrument_type: item.instrument_type,
          });
          toast(`Added ${recordPayload.name || recordPayload.card_name}!`, 'success');
          app.refresh();
        } else {
          toast(res?.message || 'Could not add account.', 'error');
        }
      });
    });

    container.querySelectorAll('[data-ignore-discovered]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = discovered[Number(btn.dataset.ignoreDiscovered)];
        if (!item) return;

        const confirmed = await confirmDialog(
          'Ignore & Discard Identifier?',
          `Future alerts for "${h(item.bank || item.institution || '')} ending ${h(item.last_4 || '')}" will not be suggested as a new discovered account.`,
          { confirmLabel: 'Discard', danger: true },
        );
        if (!confirmed) return;

        const res = await Bridge.db('ignore_discovered_account', {
          issuer: item.bank || item.institution,
          last_4: item.last_4,
          instrument_type: item.instrument_type,
        });

        if (res && res.status === 'success') {
          toast('Discovered identifier discarded.', 'success');
          app.refresh();
        } else {
          toast(res?.message || 'Could not discard identifier.', 'error');
        }
      });
    });

    const addAllBtn = container.querySelector('[data-add-all-discovered]');
    if (addAllBtn) {
      addAllBtn.addEventListener('click', async () => {
        addAllBtn.disabled = true;
        addAllBtn.textContent = 'Adding...';

        const progress = showProgressModal('Adding Discovered Accounts', {
          message: `Saving ${discovered.length} accounts & cards to vault...`,
          initialPercent: 40,
          detail: 'Writing records into encrypted SQLite database',
        });

        try {
          const res = await Bridge.db('add_discovered_accounts', {
            accounts: discovered,
            member_id: app.memberFilter === 'all' ? 1 : Number(app.memberFilter || 1),
          });
          if (res && res.status === 'success') {
            progress.complete(`Added ${res.added || discovered.length} accounts!`, 350);
            toast(`Added ${res.added || discovered.length} accounts!`, 'success');
            app.refresh();
          } else {
            progress.fail('Failed to add accounts.');
            toast(res?.message || 'Failed to add accounts.', 'error');
            addAllBtn.disabled = false;
            addAllBtn.textContent = 'Add All';
          }
        } catch (err) {
          progress.fail('Failed to add accounts.');
          toast('Failed to add accounts.', 'error');
          addAllBtn.disabled = false;
          addAllBtn.textContent = 'Add All';
        }
      });
    }
  }

  const addBtn = container.querySelector('[data-add]');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      let addType = activeRecordType;
      let preset = null;
      if (isAccountOrCard) {
        if (currentTab === 'cards') {
          addType = 'card';
        } else {
          addType = 'account';
          if (currentTab === 'wallets') preset = { category: 'Meal Card' };
          else if (currentTab === 'deposits') preset = { category: 'FD' };
          else preset = { category: 'Bank' };
        }
      }
      openRecordSheet(app, addType, null, preset);
    });
  }

  container.querySelectorAll('[data-record]').forEach((row) => {
    row.addEventListener('click', async () => {
      const isCardRecord = row.dataset.isCard === '1';
      const clickedType = isAccountOrCard ? (isCardRecord ? 'card' : 'account') : type;
      const targetList = isCardRecord ? cardsList : (isAccountOrCard ? accountsList : records);
      const record = targetList.find((r) => String(r.id) === row.dataset.record);
      if (!record) return;

      if (COMMITMENT_KINDS[clickedType]) {
        const outcome = await openCommitmentMenu(app, clickedType, record);
        if (outcome === 'saved') {
          app.refresh();
          return;
        }
        if (outcome !== 'edit') return;
      }

      openRecordSheet(app, clickedType, record);
    });
  });

  if (config.afterList) {
    await config.afterList(container.querySelector('[data-after]'), app, records);
  }
}

/* ------------------------------------------------------------------ sheet */

function fieldHtml(field, value) {
  const id = `field_${field.key}`;
  const common = `id="${id}" data-field="${field.key}"`;

  let control;
  if (field.type === 'select') {
    return selectField({
      key: field.key, label: field.label, value, options: field.options, half: field.half, id,
    });
  }
  if (field.type === 'textarea') {
    control = `<textarea class="textarea" ${common} rows="2" placeholder="${h(field.placeholder || '')}">${h(value ?? '')}</textarea>`;
  } else if (field.type === 'switch') {
    return `
      <label class="switch-row" style="${field.half ? 'flex:1;' : ''}">
        <span class="list-row-main"><span class="list-row-title">${h(field.label)}</span></span>
        <input type="checkbox" class="switch" ${common} ${Number(value) ? 'checked' : ''}>
      </label>`;
  } else {
    const numeric = field.type === 'number';
    control = `<input class="input ${numeric ? 'numeric' : ''}" type="${field.type}" ${common}
      value="${h(value ?? '')}" placeholder="${h(field.placeholder || '')}"
      ${numeric ? 'inputmode="decimal" step="any"' : ''}
      ${field.maxlength ? `maxlength="${field.maxlength}"` : ''}>`;
  }

  return `
    <div class="field" style="${field.half ? 'flex:1;min-width:0;' : ''}"
         ${field.showFor ? `data-show-for="${h(field.showFor.join(','))}"` : ''}>
      <label class="field-label" for="${id}">${h(field.label)}</label>
      ${control}
      ${field.hint ? `<span class="caption">${h(field.hint)}</span>` : ''}
    </div>`;
}

async function openRecordSheet(app, type, existing, preset = null) {
  const config = RECORD_CONFIG[type];

  const initial = (field) => {
    if (existing) return existing[field.key];
    if (preset) {
      if (field.key === 'title') return preset.title;
      if (field.key === 'target_amount') return preset.target;
      if (field.key === 'category') return preset.category;
      if (field.key === 'target_date') {
        const now = new Date();
        now.setMonth(now.getMonth() + (preset.months || 12));
        const pad = (v) => String(v).padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      }
    }
    return typeof field.default === 'function' ? field.default() : field.default ?? '';
  };

  let npsRes = null;
  let discoveredRes = null;
  if (type === 'account') {
    [npsRes, discoveredRes] = await Promise.all([
      Bridge.db('list_nps_holdings', { member_id: app.memberFilter }),
      Bridge.db('discover_accounts_from_sms'),
    ]);
  }

  // Discovered Debit Card suggestions for Bank accounts
  const discoveredDebitCards = (discoveredRes?.discovered || []).filter((d) => d.instrument_type === 'debit_card' || d.is_debit_card);

  // Preset ideas banner for new goals
  const presetBannerHtml = (type === 'goal' && !existing) ? `
    <div style="margin-bottom:var(--gap-3)">
      <div class="field-label" style="margin-bottom:6px">Quick Goal Ideas</div>
      <div class="chip-scroller" style="gap:6px;padding-bottom:2px">
        ${GOAL_PRESETS.map((p, idx) => `
          <button type="button" class="chip" data-preset-idx="${idx}" style="font-size:12px;padding:4px 10px">
            ${icon(p.icon, 'icon-sm')}${h(p.title)}
          </button>`).join('')}
      </div>
    </div>` : '';

  // NPS Linking widget for Account sheets
  const npsHoldingCount = npsRes?.holdings?.length || 0;
  const npsHoldingsTotal = npsRes?.total_value || 0;
  const npsLinkBannerHtml = (type === 'account' && npsHoldingCount > 0) ? `
    <div data-nps-linking-box style="margin-bottom:var(--gap-3);background:var(--surface-container-high);padding:10px 12px;border-radius:var(--radius-sm);border:1px solid var(--outline-variant)" hidden>
      <div class="row-between" style="align-items:center">
        <span style="font-weight:600;font-size:12px">CAS NPS Holdings Detected</span>
        <span class="badge badge-income">${npsHoldingCount} schemes</span>
      </div>
      <p class="caption" style="margin:4px 0 8px 0">
        Holding value: <strong>${formatCurrency(npsHoldingsTotal, app.currency, app.locale)}</strong>. Linking auto-syncs this balance and prevents double counting in Net Worth.
      </p>
      <label class="row" style="gap:8px;align-items:center;cursor:pointer">
        <input type="checkbox" id="chkLinkNps" ${existing?.linked_holding_type === 'nps' ? 'checked' : (existing ? '' : 'checked')}>
        <span style="font-size:12px;font-weight:500">Link balance to CAS NPS Holdings</span>
      </label>
    </div>` : '';

  // Discovered Debit Card quick-link chips for Bank accounts
  const dcSuggestionsHtml = (type === 'account' && discoveredDebitCards.length > 0) ? `
    <div data-dc-suggestions style="margin-top:-6px;margin-bottom:var(--gap-3)" data-show-for="Bank">
      <span class="caption" style="font-size:11.5px;font-weight:600;display:block;margin-bottom:4px">Discovered Debit Cards (Tap to Link):</span>
      <div class="chip-scroller" style="gap:6px">
        ${discoveredDebitCards.map((dc) => `
          <button type="button" class="chip" data-fill-dc="${h(dc.last_4)}" data-fill-bank="${h(dc.bank || dc.institution || '')}" style="font-size:11.5px;padding:3px 8px">
            ${icon('payments', 'icon-sm')}${h(dc.bank || 'Bank')} ending ${h(dc.last_4)}
          </button>`).join('')}
      </div>
    </div>` : '';

  // Consecutive half-width fields share a row.
  const rows = [];
  config.fields.forEach((field) => {
    const last = rows[rows.length - 1];
    if (field.half && last && last.half && last.fields.length < 2) last.fields.push(field);
    else rows.push({ half: field.half, fields: [field] });
  });

  const conversionBtnHtml = existing ? (
    type === 'account'
      ? `<button type="button" class="btn btn-outlined btn-block" data-convert-to-card style="margin-top:12px">
          ${icon('credit_card')}Convert to Credit Card
        </button>`
      : (type === 'card'
        ? `<button type="button" class="btn btn-outlined btn-block" data-convert-to-account style="margin-top:12px">
            ${icon('account_balance')}Convert to Bank Account / Debit Card
          </button>`
        : '')
  ) : '';

  const mergeBtnHtml = existing ? (
    type === 'card'
      ? `<button type="button" class="btn btn-tonal btn-block" data-merge-card style="margin-top:8px">
          ${icon('account_tree')}Merge into Another Card (Replacement Card)
        </button>`
      : (type === 'account'
        ? `<button type="button" class="btn btn-tonal btn-block" data-merge-account style="margin-top:8px">
            ${icon('account_tree')}Merge into Another Account
          </button>`
        : '')
  ) : '';

  const resyncBtnHtml = existing && (type === 'card' || type === 'account')
    ? `<button type="button" class="btn btn-outlined btn-block" data-resync-sms style="margin-top:8px">
        ${icon('refresh')}Resync Balance & Transactions from SMS
      </button>`
    : '';

  const body = presetBannerHtml + npsLinkBannerHtml + rows.map((row) => (row.fields.length > 1 || row.half
    ? `<div class="row" style="gap:12px;align-items:flex-end">${row.fields.map((f) => fieldHtml(f, initial(f))).join('')}</div>`
    : fieldHtml(row.fields[0], initial(row.fields[0])))).join('')
    + dcSuggestionsHtml
    + resyncBtnHtml
    + conversionBtnHtml
    + mergeBtnHtml
    + (existing ? `<button class="btn btn-danger-text btn-block" data-delete style="margin-top:8px">${icon('delete')}Delete</button>` : '');

  const saved = await sheet(existing ? `Edit ${config.heading.toLowerCase().replace(/s$/, '')}` : config.addLabel, body, {
    actions: `
      <button class="btn btn-outlined" data-cancel>Cancel</button>
      <button class="btn btn-filled" data-save>Save</button>`,
    onMount(node, close) {
      bindSelectFields(node);
      node.querySelector('[data-cancel]').addEventListener('click', () => close(null));

      if (type === 'goal' && !existing) {
        node.querySelectorAll('[data-preset-idx]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const idx = Number(btn.dataset.presetIdx);
            const p = GOAL_PRESETS[idx];
            if (!p) return;
            node.querySelectorAll('[data-preset-idx]').forEach((b) => b.removeAttribute('aria-selected'));
            btn.setAttribute('aria-selected', 'true');

            const titleInput = node.querySelector('[data-field="title"]');
            const targetInput = node.querySelector('[data-field="target_amount"]');
            const categoryInput = node.querySelector('[data-field="category"]');
            const dateInput = node.querySelector('[data-field="target_date"]');

            if (titleInput) titleInput.value = p.title;
            if (targetInput) targetInput.value = p.target;
            if (categoryInput) categoryInput.value = p.category;
            if (dateInput) {
              const now = new Date();
              now.setMonth(now.getMonth() + p.months);
              const pad = (v) => String(v).padStart(2, '0');
              dateInput.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
            }
          });
        });
      }

      // Fill debit card last 4 from chip suggestion
      node.querySelectorAll('[data-fill-dc]').forEach((chip) => {
        chip.addEventListener('click', () => {
          const dcLast4 = chip.dataset.fillDc;
          const bankName = chip.dataset.fillBank;
          const dcInput = node.querySelector('[data-field="debit_card_last_4"]');
          const instInput = node.querySelector('[data-field="institution"]');
          if (dcInput) dcInput.value = dcLast4;
          if (instInput && !instInput.value && bankName) instInput.value = bankName;
          toast(`Linked Debit Card ending ${dcLast4}`, 'success');
        });
      });

      /*
       * Shows only the fields the chosen kind actually has. A hidden field is left out of
       * the save entirely rather than written as a blank, so switching a deposit to a cash
       * account does not leave a stale maturity date behind it.
       */
      const kindField = node.querySelector('[data-field="category"]');
      const npsBox = node.querySelector('[data-nps-linking-box]');
      const balanceInput = node.querySelector('[data-field="balance"]');
      const chkLinkNps = node.querySelector('#chkLinkNps');

      const applyKind = () => {
        const kind = kindField ? kindField.value : '';
        node.querySelectorAll('[data-show-for]').forEach((field) => {
          const shown = field.dataset.showFor.split(',').includes(kind);
          field.hidden = !shown;
        });

        if (npsBox) {
          npsBox.hidden = kind !== 'NPS';
          if (kind === 'NPS' && chkLinkNps?.checked && npsHoldingsTotal > 0 && !existing) {
            if (balanceInput) balanceInput.value = npsHoldingsTotal;
          }
        }
      };

      if (chkLinkNps && balanceInput) {
        chkLinkNps.addEventListener('change', () => {
          if (chkLinkNps.checked && npsHoldingsTotal > 0) {
            balanceInput.value = npsHoldingsTotal;
          }
        });
      }

      if (kindField) {
        kindField.addEventListener('change', applyKind);
        applyKind();
      }

      // Resync Account/Card from SMS handler
      const resyncBtn = node.querySelector('[data-resync-sms]');
      if (resyncBtn && existing) {
        resyncBtn.addEventListener('click', async () => {
          resyncBtn.disabled = true;
          toast('Resyncing from SMS...', 'info');
          const res = await Bridge.db('resync_account_from_sms', type === 'card' ? { card_id: existing.id } : { account_id: existing.id });
          resyncBtn.disabled = false;
          if (res && res.status === 'success' && res.results?.length) {
            const item = res.results[0];
            if (type === 'account') {
              const balInput = node.querySelector('[data-field="balance"]');
              if (balInput && item.balance !== undefined) balInput.value = item.balance;
              toast(`Resynced! Balance updated to ${formatCurrency(item.balance, app.currency, app.locale)} (${item.remapped_transactions} txns linked).`, 'success');
            } else {
              const curBalInput = node.querySelector('[data-field="current_balance"]');
              const availInput = node.querySelector('[data-field="available_limit"]');
              const totInput = node.querySelector('[data-field="total_limit"]');
              if (curBalInput && item.current_balance !== undefined) curBalInput.value = item.current_balance;
              if (availInput && item.available_limit !== null && item.available_limit !== undefined) availInput.value = item.available_limit;
              if (totInput && item.total_limit) totInput.value = item.total_limit;
              toast(`Resynced! Card updated (${item.remapped_transactions} txns linked).`, 'success');
            }
          } else {
            toast(res?.message || 'Could not resync from SMS.', 'error');
          }
        });
      }

      // 2-Way Conversion handlers
      const convertToCardBtn = node.querySelector('[data-convert-to-card]');
      if (convertToCardBtn && existing) {
        convertToCardBtn.addEventListener('click', async () => {
          const confirmed = await confirmDialog(
            'Convert to Credit Card?',
            `Move "${h(existing.name)}" to Credit Cards so you can track credit limit, billing due dates, and utilisation.`,
            { confirmLabel: 'Convert to Card' },
          );
          if (!confirmed) return;

          await Bridge.db('save_record', {
            record_type: 'card',
            record: {
              card_name: existing.name,
              bank: existing.institution || 'Bank',
              last_4: existing.account_number || existing.debit_card_last_4 || '',
              total_limit: 0,
              current_balance: Math.abs(Number(existing.balance) || 0),
            },
          });

          await Bridge.db('delete_record', { record_type: 'account', record_id: existing.id });
          toast('Converted to Credit Card!', 'success');
          close(true);
        });
      }

      const convertToAccBtn = node.querySelector('[data-convert-to-account]');
      if (convertToAccBtn && existing) {
        convertToAccBtn.addEventListener('click', async () => {
          const confirmed = await confirmDialog(
            'Convert to Bank Account?',
            `Move "${h(existing.card_name)}" to Bank Accounts as a savings/current account with linked Debit Card.`,
            { confirmLabel: 'Convert to Account' },
          );
          if (!confirmed) return;

          await Bridge.db('save_record', {
            record_type: 'account',
            record: {
              name: existing.card_name,
              category: 'Bank',
              institution: existing.bank || 'Bank',
              debit_card_last_4: existing.last_4 || '',
              balance: Math.abs(Number(existing.current_balance) || 0),
            },
          });

          await Bridge.db('delete_record', { record_type: 'card', record_id: existing.id });
          toast('Converted to Bank Account with Debit Card!', 'success');
          close(true);
        });
      }

      // Merge Duplicate Card handler (New card number issue)
      const mergeCardBtn = node.querySelector('[data-merge-card]');
      if (mergeCardBtn && existing) {
        mergeCardBtn.addEventListener('click', async () => {
          const cardListRes = await Bridge.db('list_records', { record_type: 'card' });
          const otherCards = (cardListRes?.records || []).filter((c) => c.id !== existing.id);
          if (!otherCards.length) {
            toast('No other cards found to merge with.', 'info');
            return;
          }

          const targetCardResult = await sheet('Merge Duplicate Card', `
            <div style="display:flex;flex-direction:column;gap:var(--gap-3)">
              <div class="card-flat" style="background:var(--surface-container-high);padding:12px 14px;border-radius:var(--radius-md);border:1px solid var(--outline-variant)">
                <div style="font-weight:600;font-size:13px;color:var(--on-surface-variant)">Source Card (will be merged & removed):</div>
                <div style="font-weight:700;font-size:14px;margin-top:4px;color:var(--on-surface)">
                  ${h(existing.card_name)} · ${h(existing.bank || 'Bank')} ${existing.last_4 ? `(ending ${h(existing.last_4)})` : ''}
                </div>
              </div>

              <p class="caption" style="font-size:12px;line-height:1.45">
                All past transactions, statements, and SMS history from this card will be moved to the target card.
              </p>

              <div class="field">
                ${selectField({
                  key: 'target_card',
                  id: 'selectMergeTargetCard',
                  label: 'Select Target Card to Merge Into',
                  value: String(otherCards[0].id),
                  options: otherCards.map((c) => ({
                    value: String(c.id),
                    label: `${c.card_name} (${c.bank || 'Bank'}${c.last_4 ? ` · ${c.last_4}` : ''})`,
                  })),
                })}
              </div>

              ${existing.last_4 ? `
                <label class="card-flat" style="display:flex;align-items:flex-start;gap:10px;padding:12px;background:var(--surface-container-high);border-radius:var(--radius-sm);cursor:pointer">
                  <input type="checkbox" id="chkUpdateTargetLast4" checked style="margin-top:2px;width:18px;height:18px;accent-color:var(--accent)">
                  <div style="font-size:12px;line-height:1.35">
                    <strong>Update target card digits to ${h(existing.last_4)}</strong>
                    <div class="caption">Check this if "${h(existing.card_name)}" is a replacement/reissued card with a new card number.</div>
                  </div>
                </label>` : ''}

              <div class="card-flat" style="padding:12px;background:var(--surface-container-high);border-radius:var(--radius-sm);display:flex;flex-direction:column;gap:8px">
                <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
                  <input type="checkbox" id="chkAddCardBalance" style="margin-top:2px;width:18px;height:18px;accent-color:var(--accent)">
                  <div style="font-size:12px;line-height:1.35">
                    <strong>Add balance (${formatCurrency(existing.current_balance || 0, app.currency, app.locale)}) to target card</strong>
                    <div class="caption">Check to sum outstanding balances. Leave unchecked to keep target card's current balance.</div>
                  </div>
                </label>

                <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;border-top:1px solid var(--outline-variant);padding-top:8px">
                  <input type="checkbox" id="chkOverwriteCardBalance" style="margin-top:2px;width:18px;height:18px;accent-color:var(--accent)">
                  <div style="font-size:12px;line-height:1.35">
                    <strong>Overwrite target card balance with this card's balance</strong>
                    <div class="caption">Replace target card balance with ${formatCurrency(existing.current_balance || 0, app.currency, app.locale)}.</div>
                  </div>
                </label>
              </div>
            </div>`, {
              actions: `
                <button class="btn btn-outlined" data-cancel>Cancel</button>
                <button class="btn btn-filled" data-confirm-merge>${icon('account_tree')}Merge Cards</button>`,
              onMount(sheetNode, sheetClose) {
                bindSelectFields(sheetNode);
                const chkAdd = sheetNode.querySelector('#chkAddCardBalance');
                const chkOvr = sheetNode.querySelector('#chkOverwriteCardBalance');
                if (chkAdd && chkOvr) {
                  chkAdd.addEventListener('change', () => { if (chkAdd.checked) chkOvr.checked = false; });
                  chkOvr.addEventListener('change', () => { if (chkOvr.checked) chkAdd.checked = false; });
                }

                sheetNode.querySelector('[data-cancel]').addEventListener('click', () => sheetClose(null));
                sheetNode.querySelector('[data-confirm-merge]').addEventListener('click', () => {
                  const sel = sheetNode.querySelector('.select-button[data-field="target_card"]');
                  const targetId = sel ? Number(sel.dataset.value) : 0;
                  const updateLast4 = Boolean(sheetNode.querySelector('#chkUpdateTargetLast4')?.checked);
                  const isAdd = Boolean(chkAdd?.checked);
                  const isOvr = Boolean(chkOvr?.checked);
                  const balanceAction = isOvr ? 'use_source' : (isAdd ? 'add' : 'keep_target');
                  sheetClose({ targetId, updateLast4, balanceAction });
                });
              },
            });

          if (targetCardResult?.targetId) {
            const mergeRes = await Bridge.db('merge_cards', {
              source_card_id: existing.id,
              target_card_id: targetCardResult.targetId,
              update_last_4: targetCardResult.updateLast4,
              balance_action: targetCardResult.balanceAction,
            });
            if (mergeRes.status === 'success') {
              toast(`Merged card! (${mergeRes.moved_transactions || 0} transactions updated)`, 'success');
              close(true);
              app.refresh();
            } else {
              toast(mergeRes.message || 'Could not merge cards.', 'error');
            }
          }
        });
      }

      // Merge Duplicate Account handler
      const mergeAccBtn = node.querySelector('[data-merge-account]');
      if (mergeAccBtn && existing) {
        mergeAccBtn.addEventListener('click', async () => {
          const accListRes = await Bridge.db('list_records', { record_type: 'account' });
          const otherAccounts = (accListRes?.records || []).filter((a) => a.id !== existing.id);
          if (!otherAccounts.length) {
            toast('No other accounts found to merge with.', 'info');
            return;
          }

          const targetAccResult = await sheet('Merge Duplicate Account', `
            <div style="display:flex;flex-direction:column;gap:var(--gap-3)">
              <div class="card-flat" style="background:var(--surface-container-high);padding:12px 14px;border-radius:var(--radius-md);border:1px solid var(--outline-variant)">
                <div style="font-weight:600;font-size:13px;color:var(--on-surface-variant)">Source Account (will be merged & removed):</div>
                <div style="font-weight:700;font-size:14px;margin-top:4px;color:var(--on-surface)">
                  ${h(existing.name)} · ${h(existing.institution || 'Bank')} ${existing.account_number ? `(ending ${h(existing.account_number)})` : ''} · ${formatCurrency(existing.balance || 0, app.currency, app.locale)}
                </div>
              </div>

              <p class="caption" style="font-size:12px;line-height:1.45">
                All past transactions and SMS history from this account will be moved to the target account.
              </p>

              <div class="field">
                ${selectField({
                  key: 'target_account',
                  id: 'selectMergeTargetAccount',
                  label: 'Select Target Account to Merge Into',
                  value: String(otherAccounts[0].id),
                  options: otherAccounts.map((a) => ({
                    value: String(a.id),
                    label: `${a.name} (${a.institution || 'Bank'}${a.account_number ? ` · ${a.account_number}` : ''}${a.debit_card_last_4 ? ` · DC: ${a.debit_card_last_4}` : ''}) · ${formatCurrency(a.balance || 0, app.currency, app.locale)}`,
                  })),
                })}
              </div>

              ${existing.account_number || existing.debit_card_last_4 ? `
                <div class="card-flat" style="padding:12px;background:var(--surface-container-high);border-radius:var(--radius-sm);display:flex;flex-direction:column;gap:8px">
                  <div style="font-weight:600;font-size:12px;color:var(--on-surface-variant)">Account & Card Numbers:</div>
                  
                  <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
                    <input type="checkbox" id="chkLinkAsDebitCard" checked style="margin-top:2px;width:18px;height:18px;accent-color:var(--accent)">
                    <div style="font-size:12px;line-height:1.35">
                      <strong>Link digits (${h(existing.debit_card_last_4 || existing.account_number)}) as Target's Debit Card</strong>
                      <div class="caption">Merges debit card tracking into target account without overwriting target account number.</div>
                    </div>
                  </label>

                  <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;border-top:1px solid var(--outline-variant);padding-top:8px">
                    <input type="checkbox" id="chkOverwriteAccNumber" style="margin-top:2px;width:18px;height:18px;accent-color:var(--accent)">
                    <div style="font-size:12px;line-height:1.35">
                      <strong>Overwrite target account number with ${h(existing.account_number || existing.debit_card_last_4)}</strong>
                      <div class="caption">Replaces target account number. Leave unchecked to keep target account number intact.</div>
                    </div>
                  </label>
                </div>` : ''}

              <div class="card-flat" style="padding:12px;background:var(--surface-container-high);border-radius:var(--radius-sm);display:flex;flex-direction:column;gap:8px">
                <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
                  <input type="checkbox" id="chkAddAccBalance" style="margin-top:2px;width:18px;height:18px;accent-color:var(--accent)">
                  <div style="font-size:12px;line-height:1.35">
                    <strong>Add balance (${formatCurrency(existing.balance || 0, app.currency, app.locale)}) to target balance</strong>
                    <div class="caption">Check to sum both account balances. Leave unchecked to keep the target account's balance (avoids doubling balance on duplicate accounts).</div>
                  </div>
                </label>

                <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;border-top:1px solid var(--outline-variant);padding-top:8px">
                  <input type="checkbox" id="chkOverwriteAccBalance" style="margin-top:2px;width:18px;height:18px;accent-color:var(--accent)">
                  <div style="font-size:12px;line-height:1.35">
                    <strong>Overwrite target balance with this account's balance</strong>
                    <div class="caption">Replace target account balance with ${formatCurrency(existing.balance || 0, app.currency, app.locale)}.</div>
                  </div>
                </label>
              </div>
            </div>`, {
              actions: `
                <button class="btn btn-outlined" data-cancel>Cancel</button>
                <button class="btn btn-filled" data-confirm-merge>${icon('account_tree')}Merge Accounts</button>`,
              onMount(sheetNode, sheetClose) {
                bindSelectFields(sheetNode);
                const chkAdd = sheetNode.querySelector('#chkAddAccBalance');
                const chkOvr = sheetNode.querySelector('#chkOverwriteAccBalance');
                if (chkAdd && chkOvr) {
                  chkAdd.addEventListener('change', () => { if (chkAdd.checked) chkOvr.checked = false; });
                  chkOvr.addEventListener('change', () => { if (chkOvr.checked) chkAdd.checked = false; });
                }

                sheetNode.querySelector('[data-cancel]').addEventListener('click', () => sheetClose(null));
                sheetNode.querySelector('[data-confirm-merge]').addEventListener('click', () => {
                  const sel = sheetNode.querySelector('.select-button[data-field="target_account"]');
                  const targetId = sel ? Number(sel.dataset.value) : 0;
                  const linkAsDebitCard = Boolean(sheetNode.querySelector('#chkLinkAsDebitCard')?.checked);
                  const updateAcc = Boolean(sheetNode.querySelector('#chkOverwriteAccNumber')?.checked);
                  const isAdd = Boolean(chkAdd?.checked);
                  const isOvr = Boolean(chkOvr?.checked);
                  const balanceAction = isOvr ? 'use_source' : (isAdd ? 'add' : 'keep_target');
                  sheetClose({
                    targetId, linkAsDebitCard, updateAcc, balanceAction,
                  });
                });
              },
            });

          if (targetAccResult?.targetId) {
            const mergeRes = await Bridge.db('merge_accounts', {
              source_account_id: existing.id,
              target_account_id: targetAccResult.targetId,
              link_as_debit_card: targetAccResult.linkAsDebitCard,
              update_account_number: targetAccResult.updateAcc,
              update_debit_card: targetAccResult.linkAsDebitCard,
              balance_action: targetAccResult.balanceAction,
            });
            if (mergeRes.status === 'success') {
              toast(`Merged account! (${mergeRes.moved_transactions || 0} transactions updated)`, 'success');
              close(true);
              app.refresh();
            } else {
              toast(mergeRes.message || 'Could not merge accounts.', 'error');
            }
          }
        });
      }

      node.querySelector('[data-save]').addEventListener('click', async () => {
        const record = existing ? { id: existing.id } : {};

        for (const field of config.fields) {
          const input = node.querySelector(`[data-field="${field.key}"]`);
          // A field this kind does not have is not written, so a rate typed against a
          // deposit does not survive being changed to a savings account.
          const wrapper = input && input.closest('[data-show-for]');
          if (wrapper && wrapper.hidden) {
            record[field.key] = field.type === 'number' ? 0 : '';
            continue;
          }
          let value;

          if (field.type === 'switch') value = input.checked ? 1 : 0;
          else if (field.type === 'number') value = input.value === '' ? 0 : Number(input.value);
          else value = input.value.trim();

          if (field.required && (value === '' || value === null
            || (field.type === 'number' && !Number.isFinite(value)))) {
            toast(`${field.label} is required.`, 'error');
            input.focus();
            return;
          }
          record[field.key] = value;
        }

        if (type === 'account') {
          const isNps = record.category === 'NPS';
          const isLinked = isNps && (chkLinkNps?.checked || (!chkLinkNps && existing?.linked_holding_type === 'nps'));
          record.linked_holding_type = isLinked ? 'nps' : '';
          record.linked_pran = isLinked ? (existing?.linked_pran || npsRes?.holdings?.[0]?.pran || record.account_number || '') : '';
        }

        if (app.memberFilter !== 'all') record.member_id = Number(app.memberFilter);

        const res = await app.db('save_record', { record_type: type, record });
        if (res) {
          toast('Saved.', 'success');
          close(true);
        }
      });

      const deleteButton = node.querySelector('[data-delete]');
      if (deleteButton) {
        deleteButton.addEventListener('click', async () => {
          const confirmed = await confirmDialog('Delete this record?',
            'This cannot be undone.', { confirmLabel: 'Delete', danger: true });
          if (!confirmed) return;
          const res = await app.db('delete_record', { record_type: type, record_id: existing.id });
          if (res) {
            toast('Deleted.', 'success');
            close(true);
          }
        });
      }
    },
  });

  if (saved) app.refresh();
}

/* ------------------------------------------------ what a commitment becomes */

/**
 * The next twelve months of one kind of commitment, with every step-up applied.
 *
 * A page that lists five SIPs and totals this month's instalments understates what has
 * actually been agreed to: three of them rise ten percent a year, and in five years that is
 * a different household budget. The projection is worked out in the backend, where the
 * anniversary arithmetic lives, so this only draws it.
 */
async function renderCommitmentOutlook(host, app, records, kind) {
  const money = (value) => formatCurrency(value, app.currency, app.locale);
  const seriesKey = kind === 'sip' ? 'sips' : 'subscriptions';

  const finder = `
    <button class="btn btn-text btn-block" data-find>
      ${icon('autorenew')}Find these in my transactions
    </button>`;

  if (!records.length) {
    host.innerHTML = finder;
    bindFinder(host, app);
    return;
  }

  const projection = await Bridge.db('project_commitments', {
    months: 12, member_id: app.memberFilter,
  });

  if (projection.status !== 'success') {
    host.innerHTML = `${errorBlock(projection, { compact: true })}${finder}`;
    bindFinder(host, app);
    return;
  }

  const series = projection.series.filter((entry) => entry.key === seriesKey);
  const items = projection.items.filter((entry) => entry.kind === kind);
  const rising = items.filter((entry) => entry.last_amount > entry.first_amount + 0.5);
  const values = series.length ? series[0].values : [];
  const first = values.length ? values[0] : 0;
  const last = values.length ? values[values.length - 1] : 0;
  const yearTotal = values.reduce((sum, value) => sum + value, 0);

  host.innerHTML = `
    <div class="card">
      <div class="card-title">
        <span>The next twelve months</span>
        <span class="caption">${h(money(yearTotal))}</span>
      </div>

      ${series.length ? barSeriesChart(
    projection.buckets.map((key) => formatMonthKey(key).slice(0, 3)),
    series,
    { format: money, height: 140 },
  ) : ''}

      <div class="grid-2" style="margin-top:14px">
        <div class="stat">
          <span class="caption">This month</span>
          <span class="stat-value">${h(money(first))}</span>
        </div>
        <div class="stat">
          <span class="caption">In a year</span>
          <span class="stat-value ${last > first ? 'expense' : ''}">${h(money(last))}</span>
        </div>
      </div>

      ${rising.length ? `
        <div class="section-header" style="margin-top:16px">
          <span class="title">What is rising</span>
        </div>
        <div class="list">
          ${rising.map((entry) => `
            <div class="list-row">
              <span class="list-row-main">
                <span class="list-row-title">${h(entry.name)}</span>
                <span class="list-row-sub">
                  ${h(money(entry.first_amount))} now, ${h(money(entry.last_amount))} in a year
                  ${entry.change_percent ? ` · ${h(formatDelta(entry.change_percent, 1))} a year` : ''}
                </span>
              </span>
              ${icon('trending_up', 'icon-sm')}
            </div>`).join('')}
        </div>`
    : `<p class="caption" style="margin-top:12px">
         Nothing here is set to change. Add a yearly step-up to a ${kind === 'sip' ? 'SIP' : 'plan'}
         and the projection follows it.
       </p>`}
    </div>

    ${finder}`;

  bindFinder(host, app);
}

function bindFinder(host, app) {
  const button = host.querySelector('[data-find]');
  if (button) button.addEventListener('click', () => app.open('recurring'));
}

/* --------------------------------------------------- loan prepayment extra */

async function renderPrepaymentCalculator(container, app, loans = []) {
  const first = loans[0];
  const money = (v) => formatCurrency(v, app.currency, app.locale);

  const loanOptions = loans.map((l, i) => ({
    value: String(i),
    label: `${l.name} (${money(l.current_outstanding)})`,
  }));

  container.innerHTML = `
    <div class="card">
      <div class="card-title">Prepay Loan vs Stay Invested</div>
      <p class="caption" style="margin-bottom:14px">
        Should you aggressively prepay your loan or invest the surplus money? Compare interest saved against compounding market wealth.
      </p>

      ${loans.length > 1 ? `
        <div style="margin-bottom:14px">
          ${selectField({
    id: 'preLoanSelect',
    name: 'selected_loan_index',
    label: 'Select loan to evaluate',
    value: '0',
    options: loanOptions.map((opt) => ({ value: String(opt.value), label: opt.label })),
  })}
        </div>` : ''}

      <div class="row" style="gap:12px;align-items:flex-end">
        <div class="field" style="flex:1">
          <label class="field-label" for="prePrincipal">Outstanding</label>
          <input class="input numeric" id="prePrincipal" type="number" inputmode="decimal"
                 value="${first?.current_outstanding || 5000000}">
        </div>
        <div class="field" style="flex:1">
          <label class="field-label" for="preRate">Loan Rate %</label>
          <input class="input numeric" id="preRate" type="number" step="0.1" value="${first?.interest_rate || 8.5}">
        </div>
      </div>

      <div class="row" style="gap:12px;align-items:flex-end;margin-top:12px">
        <div class="field" style="flex:1">
          <label class="field-label" for="preTenure">Months left</label>
          <input class="input numeric" id="preTenure" type="number" value="${first?.tenure_months || 240}">
        </div>
        <div class="field" style="flex:1">
          <label class="field-label" for="preExtra">Extra cash / mo</label>
          <input class="input numeric" id="preExtra" type="number" inputmode="decimal" value="10000">
        </div>
      </div>

      <div class="field" style="margin-top:12px">
        <div class="row-between" style="margin-bottom:4px">
          <label class="field-label" for="preInvestReturn" style="padding-left:0">Expected investment return %</label>
          <span class="caption" id="investPresetLabel">12% Balanced MF</span>
        </div>
        <div class="row" style="gap:8px;align-items:center">
          <input class="input numeric" id="preInvestReturn" type="number" step="0.5" value="12" style="max-width:110px">
          <div class="row" style="gap:6px;flex-wrap:wrap">
            <button type="button" class="chip btn-sm" data-rate="7.5">7.5% FD/Debt</button>
            <button type="button" class="chip btn-sm" data-rate="12" aria-selected="true">12% MF/Index</button>
            <button type="button" class="chip btn-sm" data-rate="15">15% Equity</button>
          </div>
        </div>
      </div>

      <button class="btn btn-filled btn-block" data-calc style="margin-top:16px">${icon('balance')}Run comparison</button>
      <div data-result style="margin-top:16px"></div>
    </div>`;

  bindSelectFields(container, (field, value) => {
    if (field.dataset.name === 'selected_loan_index') {
      const selected = loans[Number(value)];
      if (selected) {
        container.querySelector('#prePrincipal').value = selected.current_outstanding || 0;
        container.querySelector('#preRate').value = selected.interest_rate || 8.5;
        container.querySelector('#preTenure').value = selected.tenure_months || 240;
      }
    }
  });

  container.querySelectorAll('[data-rate]').forEach((btn) => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('[data-rate]').forEach((b) => b.removeAttribute('aria-selected'));
      btn.setAttribute('aria-selected', 'true');
      container.querySelector('#preInvestReturn').value = btn.dataset.rate;
      const label = btn.dataset.rate === '7.5' ? '7.5% FD/Debt' : (btn.dataset.rate === '12' ? '12% MF/Index' : '15% Equity');
      const labelNode = container.querySelector('#investPresetLabel');
      if (labelNode) labelNode.textContent = label;
    });
  });

  const runCalculation = async () => {
    const read = (id) => Number(container.querySelector(`#${id}`)?.value) || 0;

    const res = await Bridge.call('loan', {
      action: 'compare',
      principal: read('prePrincipal'),
      rate: read('preRate'),
      tenure_months: read('preTenure'),
      extra_monthly: read('preExtra'),
      invest_return: read('preInvestReturn'),
    });

    const output = container.querySelector('[data-result]');
    if (!output) return;
    if (res.status !== 'success') {
      output.innerHTML = errorBlock(res, { compact: true });
      return;
    }

    const isInvestWinner = res.winner === 'invest';
    const isPrepayWinner = res.winner === 'prepay';

    output.innerHTML = `
      <div class="card-flat" style="border-left:4px solid ${isInvestWinner ? 'var(--income)' : (isPrepayWinner ? 'var(--accent)' : 'var(--outline)')};padding:14px;background:var(--surface-container-high);border-radius:var(--radius);margin-bottom:16px">
        <div class="row" style="gap:10px;align-items:flex-start">
          <span style="color:${isInvestWinner ? 'var(--income)' : (isPrepayWinner ? 'var(--accent)' : 'var(--on-surface)')};flex-shrink:0;margin-top:2px">
            ${icon(isInvestWinner ? 'trending_up' : (isPrepayWinner ? 'verified' : 'balance'), 'icon-md')}
          </span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:15px;color:var(--on-surface);margin-bottom:4px;word-break:break-word">
              ${isInvestWinner
    ? `Staying Invested wins by ${h(money(res.wealth_difference))}`
    : (isPrepayWinner
      ? `Prepaying Loan wins by ${h(money(res.wealth_difference))}`
      : 'Both strategies break even')}
            </div>
            <div class="caption" style="line-height:1.45;word-break:break-word">
              ${isInvestWinner
    ? `Your expected investment return (${res.invest_return_rate}%) beats the loan interest (${read('preRate')}%). Investing ${h(money(read('preExtra')))}/mo builds a <strong>${h(money(res.invest_final_wealth))}</strong> corpus vs ${h(money(res.prepay_final_wealth))} from prepayment.`
    : (isPrepayWinner
      ? `Guaranteed interest savings of ${h(money(res.interest_saved))} at ${read('preRate')}% beat the ${res.invest_return_rate}% market return, clearing debt ${res.years_saved} years early.`
      : `The ${res.invest_return_rate}% return matches your borrowing cost.`)}
            </div>
          </div>
        </div>
      </div>

      <div class="row" style="gap:10px;margin-bottom:14px;flex-direction:column">
        <div class="card" style="padding:14px;background:${isInvestWinner ? 'var(--surface-container-highest)' : 'var(--surface-container)'};border:${isInvestWinner ? '1.5px solid var(--income)' : '1px solid var(--outline)'}">
          <div class="row-between" style="align-items:center">
            <span class="row" style="gap:6px;align-items:center;font-weight:700">
              ${icon('trending_up', 'icon-sm')}Stay Invested
            </span>
            ${isInvestWinner ? `<span class="badge" style="background:var(--income-container);color:var(--income)">Recommended</span>` : ''}
          </div>
          <div class="display" style="font-size:22px;margin-top:6px;color:var(--income)">${h(money(res.invest_final_wealth))}</div>
          <div class="caption" style="margin-top:2px">Final wealth after full term</div>
          <div class="caption" style="margin-top:6px;font-size:11.5px;color:var(--on-surface-variant);line-height:1.4">
            Pay regular EMI · Invest ${h(money(read('preExtra')))}/mo at ${res.invest_return_rate}%
          </div>
        </div>

        <div class="card" style="padding:14px;background:${isPrepayWinner ? 'var(--surface-container-highest)' : 'var(--surface-container)'};border:${isPrepayWinner ? '1.5px solid var(--accent)' : '1px solid var(--outline)'}">
          <div class="row-between" style="align-items:center">
            <span class="row" style="gap:6px;align-items:center;font-weight:700">
              ${icon('shield', 'icon-sm')}Prepay Loan
            </span>
            ${isPrepayWinner ? `<span class="badge" style="background:var(--accent-container);color:var(--on-accent-container)">Recommended</span>` : ''}
          </div>
          <div class="display" style="font-size:22px;margin-top:6px;color:var(--on-surface)">${h(money(res.prepay_final_wealth))}</div>
          <div class="caption" style="margin-top:2px">Final wealth after full term</div>
          <div class="caption" style="margin-top:6px;font-size:11.5px;color:var(--on-surface-variant);line-height:1.4">
            Debt-free ${res.years_saved} yrs early · Saves ${h(money(res.interest_saved))} interest
          </div>
        </div>
      </div>

      <div class="grid-2">
        <div class="stat">
          <span class="caption">Current Base EMI</span>
          <span class="stat-value">${h(money(res.base_emi))}</span>
        </div>
        <div class="stat">
          <span class="caption">Interest as-is</span>
          <span class="stat-value expense">${h(money(res.total_base_interest))}</span>
        </div>
        <div class="stat">
          <span class="caption">Interest saved</span>
          <span class="stat-value income">${h(money(res.interest_saved))}</span>
        </div>
        <div class="stat">
          <span class="caption">Tenure reduced by</span>
          <span class="stat-value income">${res.months_saved} mos (${res.years_saved} yrs)</span>
        </div>
      </div>`;
  };

  container.querySelector('[data-calc]').addEventListener('click', runCalculation);
}

function renderGoalPlannerSection(host, app, records) {
  const container = document.createElement('div');
  container.className = 'goal-planner-section';
  container.style.marginTop = 'var(--gap-3)';

  const money = (v) => formatCurrency(v, app.currency, app.locale);
  const totalTarget = records.reduce((sum, r) => sum + Number(r.target_amount || 0), 0);
  const totalSaved = records.reduce((sum, r) => sum + Number(r.current_amount || 0), 0);
  const totalRemaining = Math.max(0, totalTarget - totalSaved);
  const fundedPct = totalTarget > 0 ? Math.min(100, Math.round((totalSaved / totalTarget) * 100)) : 0;

  const totalMonthlyNeeded = records.reduce((sum, r) => {
    const target = Number(r.target_amount || 0);
    const current = Number(r.current_amount || 0);
    if (current >= target) return sum;
    const months = getMonthsRemaining(r.target_date);
    return sum + Math.round((target - current) / months);
  }, 0);

  const avgMonths = records.length
    ? Math.round(records.reduce((s, r) => s + getMonthsRemaining(r.target_date), 0) / records.length)
    : 12;
  const rMonth = 0.12 / 12;
  const factor = Math.pow(1 + rMonth, avgMonths) - 1;
  const equitySipNeeded = (totalRemaining > 0 && factor > 0)
    ? Math.round((totalRemaining * rMonth) / factor)
    : totalMonthlyNeeded;
  const savingsAdvantage = Math.max(0, totalMonthlyNeeded - equitySipNeeded);

  container.innerHTML = `
    <div class="card" style="border:1px solid var(--outline-variant);background:var(--surface-container-low)">
      <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
        <span class="row" style="gap:6px;align-items:center">
          ${icon('query_stats', 'icon-sm')}Goal Roadmap & Pacing
        </span>
        <span class="badge ${fundedPct >= 100 ? 'badge-income' : 'badge-tonal'}" style="flex-shrink:0">${fundedPct}% Funded</span>
      </div>

      <div class="progress" style="height:8px;margin:var(--gap-2) 0">
        <div class="progress-bar" style="width:${fundedPct}%;background:${fundedPct >= 100 ? 'var(--income)' : 'var(--accent)'}"></div>
      </div>

      <div class="grid-2" style="gap:8px;margin-top:var(--gap-2)">
        <div class="card-flat" style="padding:10px;background:var(--surface-container-high);border-radius:var(--radius-sm)">
          <span class="caption" style="font-size:11px">Monthly Savings Pace</span>
          <div style="font-weight:700;font-size:15px;margin-top:2px" class="income">
            ${h(money(totalMonthlyNeeded))}<span style="font-size:11px;font-weight:400;color:var(--on-surface-variant)"> / mo</span>
          </div>
        </div>
        <div class="card-flat" style="padding:10px;background:var(--surface-container-high);border-radius:var(--radius-sm)">
          <span class="caption" style="font-size:11px">Remaining to Target</span>
          <div style="font-weight:700;font-size:15px;margin-top:2px" class="expense">
            ${h(money(totalRemaining))}
          </div>
        </div>
      </div>

      ${savingsAdvantage > 500 ? `
        <div class="row" style="gap:8px;align-items:center;background:var(--accent-container);color:var(--on-accent-container);padding:8px 10px;border-radius:var(--radius-sm);margin-top:var(--gap-2);font-size:12px">
          ${icon('bolt', 'icon-sm')}
          <span>With <strong>12% Equity SIP</strong>, you only need <strong>${h(money(equitySipNeeded))}/mo</strong> (saves ${h(money(savingsAdvantage))}/mo vs cash).</span>
        </div>` : ''}

      <div style="margin-top:var(--gap-3)">
        <span class="overline" style="margin-bottom:6px">Quick Goal Ideas</span>
        <div class="chip-scroller" style="gap:6px;padding-bottom:2px">
          ${GOAL_PRESETS.slice(0, 5).map((p, idx) => `
            <button type="button" class="chip" data-quick-add-goal="${idx}" style="font-size:11.5px;padding:3px 8px">
              ${icon(p.icon, 'icon-sm')}+ ${h(p.title)}
            </button>`).join('')}
        </div>
      </div>
    </div>`;

  container.querySelectorAll('[data-quick-add-goal]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.quickAddGoal);
      const p = GOAL_PRESETS[idx];
      if (!p) return;
      await openRecordSheet(app, 'goal', null, p);
      app.render();
    });
  });

  host.appendChild(container);
}
