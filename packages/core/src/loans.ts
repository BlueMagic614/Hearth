import type { Cents } from './money';

/**
 * Month-by-month student loan payoff simulation.
 *
 * Each month: interest accrues on every open loan (balance × APR / 12, rounded to the cent),
 * every open loan gets its minimum, then whatever is left of the monthly budget goes to loans
 * in priority order. When a loan is paid off, its minimum stays in the budget and rolls into
 * the next loan ("snowball" effect) unless `rollover` is false.
 */
export interface Loan {
  id: string;
  name: string;
  balance: Cents;
  /** Annual rate as a decimal, e.g. 0.0825 for 8.25%. */
  apr: number;
  minPayment: Cents;
}

export type Strategy = 'snowball' | 'avalanche';

export interface Lump {
  /** 1 = first payment month. */
  month: number;
  amount: Cents;
}

export interface Raise {
  /** First payment month the extra amount applies to. */
  fromMonth: number;
  amount: Cents;
}

export interface PayoffInput {
  loans: Loan[];
  extraMonthly: Cents;
  strategy: Strategy;
  lumps?: Lump[];
  raises?: Raise[];
  /** Keep paid-off minimums in the budget. Defaults to true. */
  rollover?: boolean;
  maxMonths?: number;
}

export interface PayoffResult {
  /** Number of payment months until every loan is paid off. */
  months: number;
  totalInterest: Cents;
  /** Payment month in which each loan reached zero. */
  paidOffMonth: Record<string, number>;
  order: string[];
  /** True when the plan could not finish within maxMonths (payments do not cover interest). */
  incomplete: boolean;
}

/** Snowball: smallest balance first. Avalanche: highest rate first (ties broken by smaller balance). */
export function payoffOrder(loans: Loan[], strategy: Strategy): string[] {
  const sorted = [...loans].sort((a, b) =>
    strategy === 'snowball' ? a.balance - b.balance || b.apr - a.apr : b.apr - a.apr || a.balance - b.balance,
  );
  return sorted.map((l) => l.id);
}

export function simulatePayoff(input: PayoffInput): PayoffResult {
  const { loans, extraMonthly, strategy, lumps = [], raises = [], rollover = true, maxMonths = 600 } = input;
  const order = payoffOrder(loans, strategy);
  const byId = new Map(loans.map((l) => [l.id, l]));
  const bal = new Map(loans.map((l) => [l.id, l.balance]));
  const minTotal = loans.reduce((s, l) => s + l.minPayment, 0);
  const paidOffMonth: Record<string, number> = {};
  let totalInterest = 0;
  let m = 0;

  const open = () => [...bal.values()].some((b) => b > 0);

  while (open() && m < maxMonths) {
    m++;
    // 1. Interest
    for (const [id, b] of bal) {
      if (b <= 0) continue;
      const interest = Math.round((b * byId.get(id)!.apr) / 12);
      bal.set(id, b + interest);
      totalInterest += interest;
    }
    // 2. Budget for this month
    const activeMins = loans.filter((l) => (bal.get(l.id) ?? 0) > 0).reduce((s, l) => s + l.minPayment, 0);
    const base = rollover ? minTotal + extraMonthly : activeMins + extraMonthly;
    const raise = raises.filter((r) => m >= r.fromMonth).reduce((s, r) => s + r.amount, 0);
    const lump = lumps.filter((x) => x.month === m).reduce((s, x) => s + x.amount, 0);
    let budget = base + raise + lump;
    // 3. Minimums
    for (const l of loans) {
      const b = bal.get(l.id) ?? 0;
      if (b <= 0) continue;
      const p = Math.min(l.minPayment, b, budget);
      bal.set(l.id, b - p);
      budget -= p;
    }
    // 4. Extra in priority order
    for (const id of order) {
      if (budget <= 0) break;
      const b = bal.get(id) ?? 0;
      if (b <= 0) continue;
      const p = Math.min(budget, b);
      bal.set(id, b - p);
      budget -= p;
    }
    for (const [id, b] of bal) if (b <= 0 && paidOffMonth[id] === undefined) paidOffMonth[id] = m;
  }

  return { months: m, totalInterest, paidOffMonth, order, incomplete: open() };
}
