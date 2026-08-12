/*
 * What paying a little extra each month actually buys.
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
 * @param {number} principal
 * @param {number} annualRate per cent a year
 * @param {number} tenureMonths
 * @param {number} extraMonthly paid on top of the instalment every month
 * @param {number} extraAnnual paid on top once a year
 */
export function optimizePrepayment(
  principal, annualRate, tenureMonths, extraMonthly = 0, extraAnnual = 0,
) {
  const baseEmi = calculateEmi(principal, annualRate, tenureMonths);
  const monthlyRate = annualRate / 12 / 100;

  // The schedule as agreed.
  let balance = principal;
  let baseInterest = 0;
  for (let month = 1; month <= tenureMonths; month += 1) {
    const interest = balance * monthlyRate;
    baseInterest += interest;
    balance -= baseEmi - interest;
    if (balance <= 0) break;
  }

  // The schedule with the extra payments.
  let optimisedBalance = principal;
  let optimisedInterest = 0;
  let monthsTaken = 0;

  while (optimisedBalance > 0 && monthsTaken < tenureMonths) {
    monthsTaken += 1;
    const interest = optimisedBalance * monthlyRate;
    let payment = baseEmi + extraMonthly;
    if (monthsTaken % 12 === 0 && extraAnnual > 0) payment += extraAnnual;

    optimisedInterest += interest;
    optimisedBalance -= payment - interest;
    if (optimisedBalance <= 0) break;
  }

  const interestSaved = Math.max(0, baseInterest - optimisedInterest);
  const monthsSaved = Math.max(0, tenureMonths - monthsTaken);

  return {
    base_emi: round2(baseEmi),
    total_base_interest: round2(baseInterest),
    total_base_payment: round2(principal + baseInterest),
    optimized_tenure_months: monthsTaken,
    optimized_total_interest: round2(optimisedInterest),
    interest_saved: round2(interestSaved),
    months_saved: monthsSaved,
    years_saved: Math.round((monthsSaved / 12) * 10) / 10,
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

export async function handleLoanAction(args = {}) {
  try {
    return {
      status: 'success',
      ...optimizePrepayment(
        Number(args.principal ?? 0),
        Number(args.rate ?? 0),
        Number.parseInt(args.tenure_months ?? 12, 10),
        Number(args.extra_monthly ?? 0),
        Number(args.extra_annual ?? 0),
      ),
    };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}
