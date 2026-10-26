import { describe, expect, it } from 'vitest';
import { simulatePayoff, payoffOrder, type Loan } from '../src/loans';
import { addMonths, monthLabel } from '../src/dates';
import { toCents } from '../src/money';

// Jason's student loans as of Oct 2026. Payment month 1 = Nov 2026.
const LOANS: Loan[] = [
  { id: 'mohela', name: 'Mohela', balance: toCents(5855.45), apr: 0.04125, minPayment: toCents(189.45) },
  { id: 'nelnet', name: 'NelNet', balance: toCents(16240.27), apr: 0.068, minPayment: toCents(277.88) },
  { id: 'firstmark', name: 'FirstMark', balance: toCents(33801.83), apr: 0.0825, minPayment: toCents(391.26) },
];
const when = (m: number) => monthLabel(addMonths('2026-10', m));
const dollars = (c: number) => Math.round(c / 100);

describe('payoffOrder', () => {
  it('snowball is smallest balance first', () => {
    expect(payoffOrder(LOANS, 'snowball')).toEqual(['mohela', 'nelnet', 'firstmark']);
  });
  it('avalanche is highest rate first', () => {
    expect(payoffOrder(LOANS, 'avalanche')).toEqual(['firstmark', 'nelnet', 'mohela']);
  });
});

describe('simulatePayoff with $500 extra', () => {
  it('snowball clears Mohela Jul 2027 and everything Nov 2030', () => {
    const r = simulatePayoff({ loans: LOANS, extraMonthly: toCents(500), strategy: 'snowball' });
    expect(when(r.paidOffMonth.mohela!)).toBe('Jul 2027');
    expect(when(r.paidOffMonth.nelnet!)).toBe('Nov 2028');
    expect(when(r.months)).toBe('Nov 2030');
    expect(dollars(r.totalInterest)).toBeGreaterThan(9480);
    expect(dollars(r.totalInterest)).toBeLessThan(9500);
  });

  it('avalanche finishes Oct 2030 with about $690 less interest', () => {
    const snow = simulatePayoff({ loans: LOANS, extraMonthly: toCents(500), strategy: 'snowball' });
    const aval = simulatePayoff({ loans: LOANS, extraMonthly: toCents(500), strategy: 'avalanche' });
    expect(when(aval.paidOffMonth.firstmark!)).toBe('May 2030');
    expect(when(aval.months)).toBe('Oct 2030');
    expect(dollars(snow.totalInterest - aval.totalInterest)).toBeGreaterThan(670);
    expect(dollars(snow.totalInterest - aval.totalInterest)).toBeLessThan(710);
  });

  it('February windfall ($5,000) and $100 raise pull payoff to Mar 2030 (snowball)', () => {
    const r = simulatePayoff({
      loans: LOANS,
      extraMonthly: toCents(500),
      strategy: 'snowball',
      lumps: [{ month: 4, amount: toCents(5000) }],
      raises: [{ fromMonth: 4, amount: toCents(100) }],
    });
    expect(when(r.paidOffMonth.mohela!)).toBe('Feb 2027');
    expect(when(r.months)).toBe('Mar 2030');
  });
});

describe('minimums only', () => {
  it('without rollover the last loan runs to Oct 2037 with about $21,550 interest', () => {
    const r = simulatePayoff({ loans: LOANS, extraMonthly: 0, strategy: 'snowball', rollover: false });
    expect(when(r.months)).toBe('Oct 2037');
    // Interest is rounded to the cent each month (as lenders do), so it lands within ~$30 of an unrounded estimate.
    expect(Math.abs(dollars(r.totalInterest) - 21553)).toBeLessThan(30);
  });

  it('flags plans whose payments never cover interest', () => {
    const r = simulatePayoff({
      loans: [{ id: 'x', name: 'X', balance: toCents(10000), apr: 0.24, minPayment: toCents(100) }],
      extraMonthly: 0,
      strategy: 'snowball',
      maxMonths: 120,
    });
    expect(r.incomplete).toBe(true);
  });
});
