import type { ISODate, YearMonth } from '@hearth/core';

/** The household lives in Ohio; the server runs in UTC. All "today" logic uses Eastern time. */
export const HOUSEHOLD_TZ = process.env.HEARTH_TZ ?? 'America/New_York';
export function householdToday(now = new Date()): ISODate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: HOUSEHOLD_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function currentMonth(now = new Date()): YearMonth {
  return householdToday(now).slice(0, 7);
}
