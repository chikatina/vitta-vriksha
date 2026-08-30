/*
 * Zero-network local demonstration & test data seeder.
 * Used for automated E2E testing, screenshots, and showroom walkthroughs.
 */

import { Bridge } from './bridge.js';

export async function seedDemoData(app) {
  // 1. Bank & Savings Accounts
  await Bridge.db('save_record', {
    record_type: 'account',
    record: {
      name: 'HDFC Salary A/c',
      category: 'Bank',
      institution: 'HDFC Bank',
      account_number: '•••• 4821',
      balance: 385000,
      currency: 'INR',
    },
  });

  await Bridge.db('save_record', {
    record_type: 'account',
    record: {
      name: 'ICICI Emergency Reserve FD',
      category: 'Deposit',
      institution: 'ICICI Bank',
      account_number: '•••• 9104',
      balance: 500000,
      interest_rate: 7.2,
      currency: 'INR',
    },
  });

  // 2. Direct Demat Equity Holdings (Stocks)
  await Bridge.db('save_record', {
    record_type: 'demat_holding',
    record: {
      account_type: 'Equity',
      broker: 'Zerodha',
      symbol: 'RELIANCE',
      isin: 'INE002A01018',
      name: 'Reliance Industries Ltd',
      kind: 'EQUITY',
      exchange: 'NSE',
      quantity: 100,
      price: 2950,
      current_value: 295000,
      invested_value: 245000,
    },
  });

  await Bridge.db('save_record', {
    record_type: 'demat_holding',
    record: {
      account_type: 'Equity',
      broker: 'Zerodha',
      symbol: 'TCS',
      isin: 'INE467B01029',
      name: 'Tata Consultancy Services',
      kind: 'EQUITY',
      exchange: 'NSE',
      quantity: 50,
      price: 4120,
      current_value: 206000,
      invested_value: 175000,
    },
  });

  await Bridge.db('save_record', {
    record_type: 'demat_holding',
    record: {
      account_type: 'Equity',
      broker: 'Zerodha',
      symbol: 'HDFCBANK',
      isin: 'INE040A01034',
      name: 'HDFC Bank Ltd',
      kind: 'EQUITY',
      exchange: 'NSE',
      quantity: 200,
      price: 1680,
      current_value: 336000,
      invested_value: 290000,
    },
  });

  // 3. Mutual Fund Folios
  await Bridge.db('save_record', {
    record_type: 'mf_folio',
    record: {
      folio_number: '12098453/91',
      amc: 'PPFAS Mutual Fund',
      scheme_name: 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth',
      isin: 'INF879O01019',
      units: 842.15,
      nav: 78.45,
      invested_value: 500000,
      current_value: 660666,
      source: 'manual',
      scope: 'mutual_fund',
    },
  });

  await Bridge.db('save_record', {
    record_type: 'mf_folio',
    record: {
      folio_number: '99843210/12',
      amc: 'UTI Mutual Fund',
      scheme_name: 'UTI Nifty 50 Index Fund - Direct Plan - Growth',
      isin: 'INF789F01058',
      units: 1520.40,
      nav: 185.30,
      invested_value: 220000,
      current_value: 281730,
      source: 'manual',
      scope: 'mutual_fund',
    },
  });

  // 4. Liabilities: Loans & Credit Cards
  await Bridge.db('save_record', {
    record_type: 'loan',
    record: {
      name: 'Car Loan',
      direction: 'borrowed',
      loan_type: 'Vehicle',
      principal_amount: 900000,
      interest_rate: 8.75,
      tenure_months: 60,
      monthly_emi: 18600,
      current_outstanding: 650000,
      start_date: '2024-01-10',
    },
  });

  await Bridge.db('save_record', {
    record_type: 'card',
    record: {
      bank: 'HDFC Bank',
      card_name: 'Regalia Gold',
      total_limit: 500000,
      current_balance: 42500,
      last_4: '8821',
      due_date: '5',
    },
  });

  // 5. Active SIP Mandates
  await Bridge.db('save_record', {
    record_type: 'sip',
    record: {
      scheme_name: 'Parag Parikh Flexi Cap Fund',
      monthly_amount: 25000,
      debit_day: 5,
      is_active: 1,
      start_date: '2023-01-05',
    },
  });

  await Bridge.db('save_record', {
    record_type: 'sip',
    record: {
      scheme_name: 'UTI Nifty 50 Index Fund',
      monthly_amount: 15000,
      debit_day: 10,
      is_active: 1,
      start_date: '2023-03-10',
    },
  });

  // 6. Financial Goals
  await Bridge.db('save_record', {
    record_type: 'goal',
    record: {
      title: 'Emergency Buffer (6 Mo)',
      target_amount: 600000,
      current_amount: 500000,
      target_date: '2026-12-31',
      category: 'Emergency',
    },
  });

  await Bridge.db('save_record', {
    record_type: 'goal',
    record: {
      title: 'Family Vacation Japan',
      target_amount: 400000,
      current_amount: 280000,
      target_date: '2027-04-15',
      category: 'Travel',
    },
  });

  // 7. Category Budgets
  const categories = [
    { name: 'Groceries', limit: 20000 },
    { name: 'Dining', limit: 10000 },
    { name: 'Utilities', limit: 8000 },
    { name: 'Transport', limit: 6000 },
    { name: 'Fuel', limit: 5000 },
    { name: 'Shopping', limit: 12000 },
    { name: 'Entertainment', limit: 5000 },
    { name: 'Health', limit: 5000 },
    { name: 'Rent & Housing', limit: 40000 },
  ];
  const existingCatsRes = await Bridge.db('get_categories');
  const existingCats = existingCatsRes?.categories || [];

  for (const cat of categories) {
    const existing = existingCats.find((c) => c.name === cat.name);
    await Bridge.db('save_category', {
      category: {
        id: existing?.id,
        name: cat.name,
        monthly_budget: cat.limit,
      },
    });
  }

  // 8. Monthly Transactions
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = (day) => `${y}-${m}-${String(day).padStart(2, '0')}`;

  const txs = [
    {
      date: d(1),
      amount: 165000,
      type: 'Income',
      category: 'Salary',
      merchant: 'Tech Corp India',
      description: 'Monthly Salary Credit',
    },
    {
      date: d(2),
      amount: 35000,
      type: 'Expense',
      category: 'Rent & Housing',
      merchant: 'Apartment Rent',
      description: 'Monthly Flat Rent',
    },
    {
      date: d(3),
      amount: 25000,
      type: 'Investment',
      category: 'Investment Outflow',
      merchant: 'Parag Parikh Flexi Cap SIP',
      description: 'Monthly Mutual Fund SIP',
      is_investment_outflow: 1,
    },
    {
      date: d(4),
      amount: 15000,
      type: 'Investment',
      category: 'Investment Outflow',
      merchant: 'UTI Nifty 50 Index Fund',
      description: 'Index Fund SIP',
      is_investment_outflow: 1,
    },
    {
      date: d(5),
      amount: 18600,
      type: 'Expense',
      category: 'Loans & EMI',
      merchant: 'Car Loan EMI Auto-Debit',
      description: 'Monthly Car Loan EMI',
    },
    {
      date: d(6),
      amount: 4250,
      type: 'Expense',
      category: 'Groceries',
      merchant: 'Nature Basket',
      description: 'Weekly Organic Groceries',
    },
    {
      date: d(7),
      amount: 2150,
      type: 'Expense',
      category: 'Dining',
      merchant: 'The Bombay Canteen',
      description: 'Dinner with family',
    },
    {
      date: d(8),
      amount: 3500,
      type: 'Expense',
      category: 'Dining',
      merchant: 'Toit Brewpub',
      description: 'Weekend Social Outing',
    },
    {
      date: d(9),
      amount: 4060,
      type: 'Expense',
      category: 'Groceries',
      merchant: 'Blinkit Delivery',
      description: 'Monthly Pantry Refill',
    },
    {
      date: d(10),
      amount: 2800,
      type: 'Expense',
      category: 'Fuel',
      merchant: 'Shell Petrol Pump',
      description: 'Vehicle Full Tank Fuel',
    },
    {
      date: d(11),
      amount: 5499,
      type: 'Expense',
      category: 'Shopping',
      merchant: 'Amazon India',
      description: 'Home essentials & books',
    },
    {
      date: d(12),
      amount: 999,
      type: 'Expense',
      category: 'Entertainment',
      merchant: 'Netflix & Spotify',
      description: 'Monthly streaming subscriptions',
    },
    {
      date: d(13),
      amount: 2200,
      type: 'Expense',
      category: 'Health',
      merchant: 'Apollo Pharmacy',
      description: 'Annual health supplements',
    },
    {
      date: d(14),
      amount: 1450,
      type: 'Expense',
      category: 'Utilities',
      merchant: 'Bescom Electricity',
      description: 'Monthly power utility bill',
    },
  ];

  for (const t of txs) {
    await Bridge.db('save_transaction', { transaction: t });
  }

  // Set overall monthly budget & dismiss onboarding checklist for clean screenshots
  await Bridge.db('update_setting', { key: 'monthly_budget', value: '75000' });
  await Bridge.db('update_setting', { key: 'onboarding_dismissed', value: '1' });
  if (app?.settings) {
    app.settings.monthly_budget = '75000';
    app.settings.onboarding_dismissed = '1';
  }

  if (app?.render) {
    await app.render();
  }
}
