/*
 * Debt Avalanche vs Snowball Payoff Roadmap, Part-Payment Planner, Grace Period & DTI Analyzer.
 */

import { memberClause, number } from './periods.js';

/**
 * Calculates Debt Avalanche (highest interest first) vs Snowball (smallest balance first) payoff schedules.
 */
export function calculateDebtPayoffRoadmap(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');

  const extraMonthly = number(args.extra_monthly, 5000);

  // Fetch all debts: loans (borrowed) and credit cards with non-zero balances
  const loans = db.all(
    `SELECT id, name, current_outstanding AS balance, interest_rate, monthly_emi AS min_payment FROM loans${clause}`
    + `${clause ? ' AND' : ' WHERE'} COALESCE(direction, 'borrowed') != 'lent' AND current_outstanding > 0`,
    params,
  );

  const cards = db.all(
    `SELECT id, card_name AS name, current_balance AS balance, COALESCE(total_limit, 0) AS credit_limit FROM credit_cards${clause}`
    + `${clause ? ' AND' : ' WHERE'} current_balance > 0`,
    params,
  ).map((c) => ({
    id: `card-${c.id}`,
    name: c.name,
    balance: number(c.balance),
    interest_rate: 42.0, // Typical CC APR (3.5% / month = 42% / yr)
    min_payment: Math.max(500, Math.round(number(c.balance) * 0.05)), // 5% min due
  }));

  const allDebts = [...loans.map((l) => ({
    id: `loan-${l.id}`,
    name: l.name,
    balance: number(l.balance),
    interest_rate: number(l.interest_rate, 9.5),
    min_payment: number(l.min_payment, Math.round(number(l.balance) * 0.02)),
  })), ...cards];

  if (!allDebts.length) {
    return {
      status: 'success',
      debt_count: 0,
      total_debt: 0,
      message: 'No active debt records.',
    };
  }

  const totalDebt = allDebts.reduce((s, d) => s + d.balance, 0);
  const totalBaseMin = allDebts.reduce((s, d) => s + d.min_payment, 0);

  // Simulate Avalanche (sort by interest_rate desc)
  const avalancheDebts = allDebts.map((d) => ({ ...d })).sort((a, b) => b.interest_rate - a.interest_rate);
  const avalancheRes = simulatePayoff(avalancheDebts, extraMonthly);

  // Simulate Snowball (sort by balance asc)
  const snowballDebts = allDebts.map((d) => ({ ...d })).sort((a, b) => a.balance - b.balance);
  const snowballRes = simulatePayoff(snowballDebts, extraMonthly);

  const interestDiff = snowballRes.total_interest - avalancheRes.total_interest;
  const monthsDiff = snowballRes.total_months - avalancheRes.total_months;

  return {
    status: 'success',
    total_debt: Math.round(totalDebt),
    debt_count: allDebts.length,
    monthly_base_payment: Math.round(totalBaseMin),
    extra_monthly_budget: extraMonthly,
    avalanche: avalancheRes,
    snowball: snowballRes,
    interest_saved_with_avalanche: Math.max(0, Math.round(interestDiff)),
    months_saved_with_avalanche: Math.max(0, monthsDiff),
    verdict: interestDiff > 500
      ? `Debt Avalanche saves ₹${Math.round(interestDiff).toLocaleString('en-IN')} more in interest compared to Snowball.`
      : 'Both Avalanche and Snowball achieve debt freedom in comparable timeframes.',
  };
}

function simulatePayoff(debts, extraMonthly) {
  let active = debts.map((d) => ({ ...d, current_balance: d.balance }));
  let totalInterest = 0;
  let months = 0;
  const milestones = [];
  const MAX_MONTHS = 360;

  while (active.some((d) => d.current_balance > 0) && months < MAX_MONTHS) {
    months += 1;
    let freedSnowballCash = extraMonthly;

    // Apply interest and pay minimums
    for (const d of active) {
      if (d.current_balance <= 0) continue;
      const monthlyRate = (d.interest_rate / 100) / 12;
      const interest = d.current_balance * monthlyRate;
      totalInterest += interest;
      d.current_balance += interest;

      const payment = Math.min(d.current_balance, d.min_payment);
      d.current_balance -= payment;
    }

    // Direct surplus and freed payments to the first active target debt
    for (const d of active) {
      if (d.current_balance > 0) {
        const extraPay = Math.min(d.current_balance, freedSnowballCash);
        d.current_balance -= extraPay;
        freedSnowballCash -= extraPay;

        if (d.current_balance <= 0.01) {
          d.current_balance = 0;
          milestones.push({
            debt_name: d.name,
            cleared_in_month: months,
          });
        }
        if (freedSnowballCash <= 0) break;
      }
    }
  }

  const now = new Date();
  const debtFreeDate = new Date(now.getFullYear(), now.getMonth() + months, 1);
  const dateStr = debtFreeDate.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });

  return {
    total_months: months,
    years: Math.floor(months / 12),
    remaining_months: months % 12,
    total_interest: Math.round(totalInterest),
    debt_free_date: dateStr,
    milestones,
  };
}

/**
 * Calculates Home Loan 1 Extra EMI / Year or Annual Step-up Prepayment savings.
 */
export function calculateHomeLoanPartPayment(principal, annualRate, tenureYears, extraEmisPerYear = 1, annualStepUpPct = 5) {
  const p = number(principal, 5000000);
  const r = number(annualRate, 8.5) / 100 / 12;
  const totalMonths = Math.max(1, number(tenureYears, 20) * 12);

  // Base EMI formula: E = P * r * (1+r)^n / ((1+r)^n - 1)
  const baseEmi = r > 0
    ? Math.round((p * r * Math.pow(1 + r, totalMonths)) / (Math.pow(1 + r, totalMonths) - 1))
    : Math.round(p / totalMonths);
  const baseTotalInterest = Math.max(0, (baseEmi * totalMonths) - p);

  // Scenario 1: 1 Extra EMI paid every 12th month
  let balExtra = p;
  let monthsExtra = 0;
  let interestExtra = 0;
  while (balExtra > 0 && monthsExtra < totalMonths) {
    monthsExtra += 1;
    const interest = balExtra * r;
    interestExtra += interest;
    balExtra += interest;

    let pay = baseEmi;
    if (monthsExtra % 12 === 0) pay += (baseEmi * extraEmisPerYear);
    balExtra -= Math.min(balExtra, pay);
  }

  // Scenario 2: 5% or 10% Annual Step-up in EMI
  let balStep = p;
  let monthsStep = 0;
  let interestStep = 0;
  let currentStepEmi = baseEmi;
  const stepRatio = 1 + (annualStepUpPct / 100);

  while (balStep > 0 && monthsStep < totalMonths) {
    monthsStep += 1;
    if (monthsStep > 1 && monthsStep % 12 === 1) {
      currentStepEmi = Math.round(currentStepEmi * stepRatio);
    }
    const interest = balStep * r;
    interestStep += interest;
    balStep += interest;
    balStep -= Math.min(balStep, currentStepEmi);
  }

  return {
    status: 'success',
    principal: p,
    annual_rate: annualRate,
    original_tenure_years: tenureYears,
    base_emi: baseEmi,
    base_total_interest: Math.round(baseTotalInterest),
    extra_emi_scenario: {
      extra_emis_per_year: extraEmisPerYear,
      new_tenure_months: monthsExtra,
      new_tenure_years: Math.round((monthsExtra / 12) * 10) / 10,
      years_saved: Math.round(((totalMonths - monthsExtra) / 12) * 10) / 10,
      interest_saved: Math.round(baseTotalInterest - interestExtra),
    },
    step_up_scenario: {
      annual_step_up_percent: annualStepUpPct,
      new_tenure_months: monthsStep,
      new_tenure_years: Math.round((monthsStep / 12) * 10) / 10,
      years_saved: Math.round(((totalMonths - monthsStep) / 12) * 10) / 10,
      interest_saved: Math.round(baseTotalInterest - interestStep),
    },
  };
}

/**
 * Calculates comprehensive Debt & Credit Card Summary across loans and credit cards.
 */
export function calculateDebtSummary(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');

  const loans = db.all(
    `SELECT id, name, loan_type, principal_amount, current_outstanding, interest_rate, monthly_emi, direction FROM loans${clause}`
    + `${clause ? ' AND' : ' WHERE'} COALESCE(direction, 'borrowed') != 'lent'`,
    params,
  );

  const cards = db.all(
    `SELECT id, card_name, bank, last_4, COALESCE(total_limit, 0) AS total_limit, available_limit, COALESCE(current_balance, 0) AS current_balance, COALESCE(due_date, 15) AS due_date, updated_at FROM credit_cards${clause}`,
    params,
  );

  let totalLoanOutstanding = 0;
  let totalLoanEmi = 0;
  const loanList = loans.map((l) => {
    const outstanding = number(l.current_outstanding);
    const emi = number(l.monthly_emi);
    totalLoanOutstanding += outstanding;
    totalLoanEmi += emi;
    return {
      id: l.id,
      name: l.name,
      loan_type: l.loan_type,
      principal_amount: number(l.principal_amount),
      current_outstanding: outstanding,
      interest_rate: number(l.interest_rate),
      monthly_emi: emi,
    };
  });

  let totalCreditLimit = 0;
  let totalCardBalance = 0;
  let totalAvailableLimit = 0;
  let totalCardMinDue = 0;

  const cardList = cards.map((c) => {
    const limit = number(c.total_limit);
    const balance = number(c.current_balance);
    const avail = c.available_limit !== null && c.available_limit !== undefined
      ? number(c.available_limit)
      : Math.max(0, limit - balance);
    const utilization = limit > 0 ? Math.round((balance / limit) * 100) : 0;
    const minDue = Math.max(0, Math.round(balance * 0.05));

    totalCreditLimit += limit;
    totalCardBalance += balance;
    totalAvailableLimit += avail;
    totalCardMinDue += minDue;

    return {
      id: c.id,
      card_name: c.card_name,
      bank: c.bank,
      last_4: c.last_4 || '',
      total_limit: limit,
      available_limit: avail,
      current_balance: balance,
      utilization_percent: utilization,
      due_date: c.due_date,
      min_due: minDue,
      updated_at: c.updated_at || '',
    };
  });

  const totalDebt = totalLoanOutstanding + totalCardBalance;
  const monthlyDebtObligations = totalLoanEmi + totalCardMinDue;
  const overallUtilization = totalCreditLimit > 0 ? Math.round((totalCardBalance / totalCreditLimit) * 100) : 0;

  // DTI calculation
  const [andClause, andParams] = memberClause(memberId, 'AND');
  const salary = db.get(
    `SELECT amount FROM transactions WHERE type = 'Income'${andClause} ORDER BY date DESC LIMIT 1`,
    andParams,
  );
  const monthlyIncome = salary ? number(salary.amount) : 50000;
  const dti = monthlyIncome > 0 ? Math.round((monthlyDebtObligations / monthlyIncome) * 1000) / 10 : 0;

  let dtiRating = 'Healthy';
  let dtiColor = 'var(--income)';
  if (dti > 45) {
    dtiRating = 'High Risk';
    dtiColor = 'var(--expense)';
  } else if (dti > 30) {
    dtiRating = 'Moderate';
    dtiColor = 'var(--warning, #F59E0B)';
  }

  return {
    status: 'success',
    total_debt: Math.round(totalDebt),
    total_loan_outstanding: Math.round(totalLoanOutstanding),
    loan_balance: Math.round(totalLoanOutstanding),
    total_loan_emi: Math.round(totalLoanEmi),
    loan_monthly_emis: Math.round(totalLoanEmi),
    total_credit_limit: Math.round(totalCreditLimit),
    total_available_limit: Math.round(totalAvailableLimit),
    available_credit_limit: Math.round(totalAvailableLimit),
    total_card_balance: Math.round(totalCardBalance),
    credit_card_balance: Math.round(totalCardBalance),
    card_min_dues: Math.round(totalCardMinDue),
    credit_utilization_percent: overallUtilization,
    overall_utilization_pct: overallUtilization,
    monthly_debt_obligations: Math.round(monthlyDebtObligations),
    dti_percent: dti,
    dti_rating: dtiRating,
    dti_color: dtiColor,
    monthly_net_income: Math.round(monthlyIncome),
    active_loans_count: loans.filter((l) => l.current_outstanding > 0).length,
    active_cards_count: cards.length,
    loans: loanList,
    cards: cardList,
  };
}

/**
 * Recommends the optimal Credit Card to swipe today for maximum interest-free grace period.
 */
export function getCreditCardOptimizer(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');

  const cards = db.all(`SELECT id, card_name, bank, last_4, COALESCE(total_limit, 0) AS credit_limit, available_limit, current_balance, COALESCE(due_date, 20) AS due_day, 1 AS billing_cycle_day FROM credit_cards${clause}`, params);

  const todayDate = new Date();
  const currentDay = todayDate.getDate();

  const evaluatedCards = cards.map((c) => {
    const cycleDay = number(c.billing_cycle_day, 1);
    const dueDay = number(c.due_day, 20);
    const limit = number(c.credit_limit, 100000);
    const balance = number(c.current_balance, 0);
    const avail = c.available_limit !== null && c.available_limit !== undefined
      ? number(c.available_limit)
      : Math.max(0, limit - balance);
    const utilization = limit > 0 ? Math.round((balance / limit) * 100) : 0;

    // Calculate days remaining in billing cycle + grace days until payment due
    let daysTillNextCycle = cycleDay - currentDay;
    if (daysTillNextCycle <= 0) daysTillNextCycle += 30;
    const graceDays = daysTillNextCycle + 20; // ~45-50 days max

    return {
      id: c.id,
      card_name: c.card_name,
      bank: c.bank,
      last_4: c.last_4,
      credit_limit: limit,
      available_limit: avail,
      current_balance: balance,
      utilization_percent: utilization,
      utilization_warning: utilization > 30,
      statement_day: cycleDay,
      due_day: dueDay,
      interest_free_days_if_used_today: graceDays,
    };
  });

  evaluatedCards.sort((a, b) => b.interest_free_days_if_used_today - a.interest_free_days_if_used_today);

  const bestCard = evaluatedCards[0] || null;

  return {
    status: 'success',
    best_card_to_use_today: bestCard,
    cards: evaluatedCards,
    high_utilization_count: evaluatedCards.filter((c) => c.utilization_warning).length,
  };
}

/**
 * Computes Debt-to-Income (DTI) Ratio and health diagnosis.
 */
export function calculateDtiRatio(db, args = {}) {
  const memberId = args.member_id;
  const [clause, params] = memberClause(memberId, 'WHERE');

  // Total monthly debt obligations
  const loans = db.all(
    `SELECT monthly_emi FROM loans${clause}${clause ? ' AND' : ' WHERE'} COALESCE(direction, 'borrowed') != 'lent'`,
    params,
  );
  const cards = db.all(`SELECT current_balance FROM credit_cards${clause}`, params);

  const loanEmis = loans.reduce((s, l) => s + number(l.monthly_emi), 0);
  const cardMinDues = cards.reduce((s, c) => s + Math.max(0, Math.round(number(c.current_balance) * 0.05)), 0);
  const totalDebtObligations = loanEmis + cardMinDues;

  // Monthly net income (from last salary transaction or average of last 3 months income)
  const [andClause, andParams] = memberClause(memberId, 'AND');
  const salary = db.get(
    `SELECT amount FROM transactions WHERE type = 'Income'${andClause} ORDER BY date DESC LIMIT 1`,
    andParams,
  );
  const monthlyIncome = salary ? number(salary.amount) : 50000;

  const dti = monthlyIncome > 0 ? Math.round((totalDebtObligations / monthlyIncome) * 1000) / 10 : 0;

  let riskCategory = 'Healthy';
  let badgeColor = 'var(--income)';
  let advice = 'Your debt obligations are well under control (<30% of income).';

  if (dti > 45) {
    riskCategory = 'High Risk';
    badgeColor = 'var(--expense)';
    advice = 'Debt obligations exceed 45% of your income. Prioritize debt payoff before taking on new commitments.';
  } else if (dti > 30) {
    riskCategory = 'Moderate';
    badgeColor = 'var(--warning, #F59E0B)';
    advice = 'Debt obligations are in the 30–45% range. Aim to bring DTI below 30% by prepaying high-interest debt.';
  }

  return {
    status: 'success',
    monthly_debt_obligations: Math.round(totalDebtObligations),
    monthly_net_income: Math.round(monthlyIncome),
    dti_percent: dti,
    risk_category: riskCategory,
    badge_color: badgeColor,
    advice,
  };
}
