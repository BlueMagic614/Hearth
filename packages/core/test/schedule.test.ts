import { describe, expect, it } from 'vitest';
import { eventsForMonth, lowBalance, projectBalance, type Schedule } from '../src/schedule';
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

  it('moves one occurrence with an override, even into the next month', () => {
    const aep: Schedule = { id: 'aep', name: 'AEP', kind: 'bill', amount: -toCents(350), cadence: 'monthly', days: [30] };
    const ov = [{ scheduleId: 'aep', originalDate: '2026-10-30', newDate: '2026-11-02' }];
    expect(eventsForMonth([aep], '2026-10', ov)).toEqual([]);
    const nov = eventsForMonth([aep], '2026-11', ov);
    expect(nov.map((e) => [e.date, e.source])).toEqual([['2026-11-02', 'moved'], ['2026-11-30', 'placeholder']]);
  });

  it('cautious projection takes bills at the earliest day of their window', () => {
    const bill: Schedule = { id: 'b', name: 'Gas', kind: 'bill', amount: -toCents(100), cadence: 'monthly', days: [24], windowDays: 2 };
    const ev = eventsForMonth([bill], '2026-10');
    const normal = projectBalance(toCents(500), '2026-10-21', 4, ev, 0);
    const cautious = projectBalance(toCents(500), '2026-10-21', 4, ev, 0, { cautious: true });
    expect(normal.find((p) => p.date === '2026-10-22')!.balance).toBe(toCents(500));
    expect(cautious.find((p) => p.date === '2026-10-22')!.balance).toBe(toCents(400));
    expect(lowBalance(cautious, toCents(450)).firstBelow!.date).toBe('2026-10-22');
  });

  it('projects balances with events and a daily allowance', () => {
    const ev = eventsForMonth(pay, '2026-10');
    const pts = projectBalance(toCents(1000), '2026-10-21', 3, ev, toCents(90));
    expect(pts.map((p) => p.balance)).toEqual([toCents(910), toCents(3480), toCents(3390)]);
  });
});
