/*
 * How much is enough, and when.
 *
 * The target is a multiple of what a year costs, at the price it will be by then rather
 * than today's. The growth is projected in real terms, so the number that comes out is in
 * today's money and can be compared with today's expenses without any further arithmetic.
 */

/**
 * @param {object} input
 * @param {number} input.current_age
 * @param {number} input.target_retirement_age
 * @param {number} input.current_net_worth
 * @param {number} input.monthly_expenses
 * @param {number} input.monthly_savings
 * @param {number} input.expected_cagr annual portfolio return, per cent
 * @param {number} input.inflation_rate annual inflation, per cent
 * @param {number} input.fire_multiplier how many years of spending the target holds
 */
export function calculateFireProjections({
  current_age: currentAge = 30,
  target_retirement_age: retirementAge = 50,
  current_net_worth: currentNetWorth = 1000000,
  monthly_expenses: monthlyExpenses = 50000,
  monthly_savings: monthlySavings = 30000,
  expected_cagr: expectedCagr = 12,
  inflation_rate: inflationRate = 6,
  fire_multiplier: fireMultiplier = 25,
} = {}) {
  const realReturn = ((1 + expectedCagr / 100) / (1 + inflationRate / 100)) - 1;
  const yearsToRetire = Math.max(1, retirementAge - currentAge);

  const futureAnnualExpenses = (monthlyExpenses * 12)
    * (1 + inflationRate / 100) ** yearsToRetire;

  const fireNumber = futureAnnualExpenses * fireMultiplier;
  const leanFire = fireNumber * 0.75;
  const fatFire = fireNumber * 1.5;

  // What the target is worth today: the sum that, left alone, grows into it by then.
  const coastFire = fireNumber / (1 + realReturn) ** yearsToRetire;

  const monthlyRealReturn = (1 + realReturn) ** (1 / 12) - 1;
  let corpus = currentNetWorth;
  const curve = [];

  for (let age = currentAge; age <= retirementAge; age += 1) {
    curve.push({
      age,
      projected_net_worth: round2(corpus),
      fire_target: round2(fireNumber),
    });
    for (let month = 0; month < 12; month += 1) {
      corpus = (corpus + monthlySavings) * (1 + monthlyRealReturn);
    }
  }

  return {
    status: 'success',
    current_age: currentAge,
    retirement_age: retirementAge,
    years_to_retire: yearsToRetire,
    fire_number: round2(fireNumber),
    lean_fire: round2(leanFire),
    fat_fire: round2(fatFire),
    coast_fire: round2(coastFire),
    projected_corpus_at_retirement: round2(corpus),
    is_fire_achievable: corpus >= fireNumber,
    projection_curve: curve,
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

export async function handleFireAction(args = {}) {
  try {
    return calculateFireProjections({
      current_age: Number.parseInt(args.current_age ?? 30, 10),
      target_retirement_age: Number.parseInt(args.target_retirement_age ?? 50, 10),
      current_net_worth: Number(args.current_net_worth ?? 1000000),
      monthly_expenses: Number(args.monthly_expenses ?? 50000),
      monthly_savings: Number(args.monthly_savings ?? 30000),
      expected_cagr: Number(args.expected_cagr ?? 12),
      inflation_rate: Number(args.inflation_rate ?? 6),
      fire_multiplier: Number(args.fire_multiplier ?? 25),
    });
  } catch (error) {
    return { status: 'error', message: error.message };
  }
}
