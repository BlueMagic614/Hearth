import { describe, expect, it } from 'vitest';
import { eventsForMonth, projectBalance, type Schedule } from '../src/schedule';
import { adjustForWeekend } from '../src/dates';
import { toCents } from '../src/money';

const pay: Schedule[] = [
  { id: 'j', name: 'Payday — Jason', kind: 'pay', amount: toCents(2198), cadence: 'semimonthly', days: [15, 30], weekendRule: 'before' },
  { id: 'r', name: 'Payday — Renee', kind: 'pay', amount: toCents(2660), cadence: 'semimonthly', days: [10, 25], weekendRule: 'before' },
];

describe('schedules', () => {
  it('moves a Sunday payday to the Friday before', () => {
    expect(adjustForWeekend('2026-10-25', 'before')).toBe('2026-10-23');
    expect(adjustForWeekend('2026-10-25', 'after')).toBe('2026-10-26');
  });

  it('expands four paydays in October 2026, $9,716 total', () => {
    const ev = eventsForMonth(pay, '2026-10');
    expect(ev.map((e) => e.date)).toEqual(['2026-10-09', '2026-10-15', '2026-10-23', '2026-10-30']);
    expect(ev.reduce((s, e) => s + e.amount, 0)).toBe(toCents(9716));
  });

  it('clamps the 30th to the last day of February', () => {
    const ev = eventsForMonth([pay[0]!], '2027-02');
    expect(ev.map((e) => e.date)).toEqual(['2027-02-15', '2027-02-26']); // Feb 28 2027 is a Sunday → Friday the 26th
  });

  it('projects balances with events and a daily allowance', () => {
    const ev = eventsForMonth(pay, '2026-10');
    const pts = projectBalance(toCents(1000), '2026-10-21', 3, ev, toCents(90));
    expect(pts.map((p) => p.balance)).toEqual([toCents(910), toCents(3480), toCents(3390)]);
  });
});
