import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { migrate, openDb, type Db } from '../src/db';
import { seedHousehold } from '../src/seed';
import { currentMonth } from '../src/time';

let db: Db;
let app: FastifyInstance;
let cookie = '';
const M = currentMonth();
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};
const cat = async (name: string) => (await db.query<{ id: string }>('SELECT id FROM categories WHERE name = $1', [name]))[0]!.id;
type Plan = { extraCents: number; goals: { name: string; monthly_cents: number; saved_cents: number }[] };

beforeAll(async () => {
  db = await openDb({ memory: true });
  await migrate(db);
  await seedHousehold(db, { devPassword: 'test-password-123' });
  app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'jason@hearth.local', password: 'test-password-123' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterAll(async () => { await app.close(); await db.close(); });

describe('one change, every screen', () => {
  it("a budget change moves the bill on the calendar, the forecast and the paycheck plan", async () => {
    await api('PATCH', `/api/categories/${await cat('AEP')}`, { planned: 412, month: M });
    const cal = (await api('GET', `/api/calendar?month=${M}`)).body.events as { name: string; amount: number }[];
    expect(cal.find((e) => e.name === 'AEP')?.amount).toBe(-41200);
    const plan = (await api('GET', `/api/paychecks?month=${M}`)).body as { halves: { step1: { items: { name: string; amount: number }[] }; step2: { items: { name: string; amount: number }[] } | null }[] };
    const aep = plan.halves.flatMap((h) => [...h.step1.items, ...(h.step2?.items ?? [])]).filter((i) => i.name === 'AEP');
    expect(aep.every((i) => i.amount === 41200)).toBe(true);
  });

  it('splits a bill paid on several paydays (tithe) evenly', async () => {
    await api('PATCH', `/api/categories/${await cat('Rocky City (tithe)')}`, { planned: 1600, month: M });
    const cal = (await api('GET', `/api/calendar?month=${M}`)).body.events as { name: string; amount: number }[];
    expect(cal.filter((e) => e.name === 'Rocky City (tithe)').every((e) => e.amount === -40000)).toBe(true);
  });

  it('renaming a category renames its bill everywhere', async () => {
    await api('PATCH', `/api/categories/${await cat('Splice')}`, { name: 'Splice Sounds' });
    const cal = (await api('GET', `/api/calendar?month=${M}`)).body.events as { name: string }[];
    expect(cal.some((e) => e.name === 'Splice Sounds') && !cal.some((e) => e.name === 'Splice')).toBe(true);
  });

  it('savings goals follow the budget, and money put into the category counts as saved', async () => {
    await api('PATCH', `/api/categories/${await cat('Emergency fund')}`, { planned: 650, month: M });
    await api('POST', '/api/transactions', { date: `${M}-05`, merchant: 'Transfer to savings', amount: 200, categoryId: await cat('Emergency fund') });
    const plan = (await api('GET', '/api/plan')).body as Plan;
    expect(plan.goals.find((g) => g.name === 'Emergency fund')).toMatchObject({ monthly_cents: 65000, saved_cents: 20000 });
    expect(plan.goals.find((g) => g.name === 'Family vacation')?.monthly_cents).toBe(25000);
  });

  it('the payoff plan and the budget share one extra payment, whichever side changes it', async () => {
    await api('PATCH', `/api/categories/${await cat('Extra on student loans')}`, { planned: 700, month: M });
    expect(((await api('GET', '/api/plan')).body as Plan).extraCents).toBe(70000);
    await api('PUT', '/api/plan', { extra: 550 });
    const budget = (await api('GET', `/api/budget?month=${M}`)).body;
    const find = (ns: { name: string; planned: number; children: unknown[] }[]): number | undefined => {
      for (const n of ns) { if (n.name === 'Extra on student loans') return n.planned; const f = find(n.children as never); if (f !== undefined) return f; }
      return undefined;
    };
    expect(find(budget.tree)).toBe(55000);
  });

  it('moving a bill on the calendar moves it in the paycheck plan', async () => {
    const id = (await db.query<{ id: string }>("SELECT id FROM schedules WHERE name = 'Granger Insurance'"))[0]!.id;
    const ev = ((await api('GET', `/api/calendar?month=${M}`)).body.events as { scheduleId: string; originalDate: string }[]).find((e) => e.scheduleId === id)!;
    await api('POST', '/api/calendar/move', { scheduleId: id, originalDate: ev.originalDate, toDate: `${M}-12`, scope: 'ongoing' });
    const plan = (await api('GET', `/api/paychecks?month=${M}`)).body as { halves: { step1: { items: { name: string; date: string }[] }; step2: { items: { name: string; date: string }[] } | null }[] };
    const dates = plan.halves.flatMap((h) => [...h.step1.items, ...(h.step2?.items ?? [])]).filter((i) => i.name === 'Granger Insurance' && i.date.startsWith(M)).map((i) => i.date);
    expect(dates).toEqual([`${M}-12`]);
  });
});
