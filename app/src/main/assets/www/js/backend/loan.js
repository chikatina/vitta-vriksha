/*
 * What paying a little extra each month actually buys, and whether staying invested beats prepaying.
 *
 * Both schedules are run month by month rather than solved in closed form, because the
 * point of the answer is the comparison and a simulation cannot drift from the real
 * amortisation the way a formula rearranged for one variable can.
 */

/** The level instalment that clears a loan over its term. */
export function calculateEmi(principal, annualRate, tenureMonths) {
  if (annualRate <= 0 || tenureMonths <= 0) return principal / Math.max(1, tenureMonths);
  const rate = annualRate / 12 / 100;
  const growth = (1 + rate) ** tenureMonths;
  return (principal * rate * growth) / (growth - 1);
}

/**
 * Calculates remaining EMIs on a loan given current balance, rate and monthly EMI.
 */
export function calculateEmisLeft(outstanding, annualRate, monthlyEmi, originalTenure = 0) {
  const balance = Number(outstanding) || 0;
  const emi = Number(monthlyEmi) || 0;
  const rate = Number(annualRate) || 0;

  if (balance <= 0 || emi <= 0) return 0;
  if (rate <= 0) return Math.ceil(balance / emi);

  const monthlyRate = rate / 12 / 100;
  const monthlyInterest = balance * monthlyRate;

  if (emi <= monthlyInterest) return originalTenure || 999;

  const n = -Math.log(1 - (monthlyInterest / emi)) / Math.log(1 + monthlyRate);
  return Math.max(1, Math.ceil(n));
}

/**
 * @param {number} principal
 * @param {number} annualRate per cent a year
 * @param {number} tenureMonths
 * @param {number} extraMonthly paid on top of the instalment every month
 * @param {number} extraAnnual paid on top once a year
 */
export function optimizePrepayment(
  principal, annualRate, tenureMonths, extraMonthly = 0, extraAnnual = 0,
) {
  const p = Number(principal) || 0;
  const r = Number(annualRate) || 0;
  const t = Math.max(1, Number.parseInt(tenureMonths, 10) || 12);
  const em = Number(extraMonthly) || 0;
  const ea = Number(extraAnnual) || 0;

  const baseEmi = calculateEmi(p, r, t);
  const monthlyRate = r / 12 / 100;

  // The schedule as agreed.
  let balance = p;
  let baseInterest = 0;
  for (let month = 1; month <= t; month += 1) {
    const interest = balance * monthlyRate;
    baseInterest += interest;
    balance -= baseEmi - interest;
    if (balance <= 0) break;
  }

  // The schedule with the extra payments.
  let optimisedBalance = p;
  let optimisedInterest = 0;
  let monthsTaken = 0;

  while (optimisedBalance > 0 && monthsTaken < t) {
    monthsTaken += 1;
    const interest = optimisedBalance * monthlyRate;
    let payment = baseEmi + em;
    if (monthsTaken % 12 === 0 && ea > 0) payment += ea;

    optimisedInterest += interest;
    optimisedBalance -= payment - interest;
    if (optimisedBalance <= 0) break;
  }

  const interestSaved = Math.max(0, baseInterest - optimisedInterest);
  const monthsSaved = Math.max(0, t - monthsTaken);

  return {
    base_emi: round2(baseEmi),
    total_base_interest: round2(baseInterest),
    total_base_payment: round2(p + baseInterest),
    optimized_tenure_months: monthsTaken,
    optimized_total_interest: round2(optimisedInterest),
    interest_saved: round2(interestSaved),
    months_saved: monthsSaved,
    years_saved: Math.round((monthsSaved / 12) * 10) / 10,
  };
}

/**
 * Compares two financial strategies for surplus money:
 * 1. Prepay Loan: Pay extra towards loan, eliminate debt early, then invest the freed-up EMI.
 * 2. Stay Invested: Pay normal loan EMI and invest the surplus into an investment returning investReturnRate.
 *
 * @param {number} principal Loan current outstanding
 * @param {number} annualRate Loan interest rate %
 * @param {number} tenureMonths Remaining tenure in months
 * @param {number} extraMonthly Surplus monthly cash available
 * @param {number} extraAnnual Surplus annual cash available (bonus/lump sum)
 * @param {number} investReturnRate Expected annual return on investments % (e.g. 12%)
 */
export function compareInvestVsPrepay(
  principal, annualRate, tenureMonths, extraMonthly = 0, extraAnnual = 0, investReturnRate = 12,
) {
  const p = Number(principal) || 0;
  const r = Number(annualRate) || 0;
  const t = Math.max(1, Number.parseInt(tenureMonths, 10) || 12);
  const em = Number(extraMonthly) || 0;
  const ea = Number(extraAnnual) || 0;
  const invRate = Number(investReturnRate) || 0;

  const prepay = optimizePrepayment(p, r, t, em, ea);
  const invMonthlyRate = invRate / 12 / 100;
  const loanMonthlyRate = r / 12 / 100;

  // Month-by-month simulation for both strategies over full tenure t
  let prepayLoanBal = p;
  let prepayCorpus = 0;
  let investLoanBal = p;
  let investCorpus = 0;

  const yearlyData = [];
  const baseEmi = prepay.base_emi;

  for (let m = 1; m <= t; m += 1) {
    // Strategy 1: Prepay
    if (prepayLoanBal > 0) {
      const int = prepayLoanBal * loanMonthlyRate;
      let pay = baseEmi + em;
      if (m % 12 === 0 && ea > 0) pay += ea;
      prepayLoanBal -= (pay - int);
      if (prepayLoanBal < 0) {
        // Any remainder goes to corpus
        prepayCorpus += Math.abs(prepayLoanBal);
        prepayLoanBal = 0;
      }
    } else {
      // Loan is cleared early! Invest the freed up full monthly cashflow (baseEmi + extra)
      let surplus = baseEmi + em;
      if (m % 12 === 0 && ea > 0) surplus += ea;
      prepayCorpus = (prepayCorpus * (1 + invMonthlyRate)) + surplus;
    }

    // Strategy 2: Stay Invested
    if (investLoanBal > 0) {
      const int = investLoanBal * loanMonthlyRate;
      investLoanBal -= (baseEmi - int);
      if (investLoanBal < 0) investLoanBal = 0;
    }
    // Invest surplus every month
    let invPayment = em;
    if (m % 12 === 0 && ea > 0) invPayment += ea;
    investCorpus = (investCorpus * (1 + invMonthlyRate)) + invPayment;

    if (m % 12 === 0 || m === t) {
      const yr = Math.ceil(m / 12);
      yearlyData.push({
        year: yr,
        month: m,
        prepay_debt: round2(prepayLoanBal),
        prepay_corpus: round2(prepayCorpus),
        invest_debt: round2(investLoanBal),
        invest_corpus: round2(investCorpus),
        prepay_net_worth: round2(prepayCorpus - prepayLoanBal),
        invest_net_worth: round2(investCorpus - investLoanBal),
      });
    }
  }

  const prepayFinalWealth = round2(prepayCorpus);
  const investFinalWealth = round2(investCorpus);
  const diff = round2(Math.abs(investFinalWealth - prepayFinalWealth));

  let winner = 'tie';
  if (investFinalWealth > prepayFinalWealth + 100) winner = 'invest';
  else if (prepayFinalWealth > investFinalWealth + 100) winner = 'prepay';

  return {
    ...prepay,
    invest_return_rate: invRate,
    prepay_final_wealth: prepayFinalWealth,
    invest_final_wealth: investFinalWealth,
    wealth_difference: diff,
    winner,
    yearly_timeline: yearlyData,
    break_even_rate: r,
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

export async function handleLoanAction(args = {}) {
  try {
    const action = args.action || 'optimize';
    const principal = Number(args.principal ?? 0);
    const rate = Number(args.rate ?? 0);
    const tenureMonths = Number.parseInt(args.tenure_months ?? 12, 10);
    const extraMonthly = Number(args.extra_monthly ?? 0);
    const extraAnnual = Number(args.extra_annual ?? 0);
    const investReturn = Number(args.invest_return ?? 12);

    if (action === 'emis_left') {
      const emi = Number(args.monthly_emi ?? 0);
      return {
        status: 'success',
        emis_left: calculateEmisLeft(principal, rate, emi, tenureMonths),
      };
    }

    if (action === 'compare' || args.invest_return !== undefined) {
      return {
        status: 'success',
        ...compareInvestVsPrepay(principal, rate, tenureMonths, extraMonthly, extraAnnual, investReturn),
      };
    }

    return {
      status: 'success',
      ...optimizePrepayment(principal, rate, tenureMonths, extraMonthly, extraAnnual),
    };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}
