import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { migrate, openDb, type Db } from '../src/db';
import { seedHousehold } from '../src/seed';

let db: Db;
let app: FastifyInstance;
let cookie = '';
type Item = { name: string; date: string; amount: number; kind: string; categoryId: string | null };
type Period = { person: string; payDate: string; amount: number; from: string; to: string; items: Item[]; outflow: number; surplus: number; carryIn: number; short: number };
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};
const plan = async (m = '2026-11') => (await api('GET', `/api/paychecks?month=${m}`)).body as { periods: Period[]; unscheduled: { categoryId: string; name: string }[]; payers: Record<string, string> };

beforeAll(async () => {
  db = await openDb({ memory: true });
  await migrate(db);
  await seedHousehold(db, { devPassword: 'test-password-123' });
  app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'jason@hearth.local', password: 'test-password-123' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterAll(async () => { await app.close(); await db.close(); });

describe('paycheck plan', () => {
  it("shows November's checks, starting with Oct 30, which carries rent and everything to Nov 10", async () => {
    const p = await plan();
    // Nov 15 is a Sunday, so Jason is paid Friday the 13th.
    expect(p.periods.map((x) => [x.person, x.payDate])).toEqual([['Jason', '2026-10-30'], ['Renee', '2026-11-10'], ['Jason', '2026-11-13'], ['Renee', '2026-11-25']]);
    const oct30 = p.periods[0]!;
    expect([oct30.from, oct30.to]).toEqual(['2026-10-31', '2026-11-10']);
    expect(oct30.items.find((i) => i.name === 'Rent')).toMatchObject({ date: '2026-11-01', amount: 169000 });
  });

  it('puts a bill due on payday on the earlier check, but the tithe on that day\'s check', async () => {
    await db.query("UPDATE schedules SET days = '{10}', date_source = 'manual' WHERE name = 'Spectrum Mobile'");
    const p = await plan();
    const [oct30, nov10] = p.periods;
    expect(oct30!.items.some((i) => i.name === 'Spectrum Mobile' && i.date === '2026-11-10')).toBe(true);
    expect(nov10!.items.some((i) => i.name === 'Spectrum Mobile')).toBe(false);
    expect(oct30!.items.filter((i) => i.name.includes('tithe')).map((i) => i.date)).toEqual(['2026-10-30']);
    expect(nov10!.items.filter((i) => i.name.includes('tithe')).map((i) => i.date)).toEqual(['2026-11-10']);
  });

  it('spreads cash envelopes over the days each check covers, and carries surplus forward', async () => {
    await db.query("UPDATE categories SET cash = TRUE WHERE name IN ('Groceries', 'Fuel')");
    const p = await plan();
    const cash = p.periods.map((x) => x.items.find((i) => i.kind === 'cash')?.amount ?? 0);
    expect(cash.every((c) => c > 0)).toBe(true);
    for (let i = 1; i < p.periods.length; i++) {
      const prev = p.periods[i - 1]!;
      expect(p.periods[i]!.carryIn).toBe(Math.max(0, prev.carryIn + prev.surplus));
    }
    for (const x of p.periods) expect(x.short).toBe(Math.max(0, -(x.surplus + x.carryIn)));
  });

  it('lists monthly items without a date, and pays one from a chosen check', async () => {
    const p = await plan();
    const ef = p.unscheduled.find((u) => u.name === 'Emergency fund')!;
    expect(ef).toBeTruthy();
    await api('POST', '/api/paychecks/assign', { categoryId: ef.categoryId, payDay: 15 });
    const after = await plan();
    expect(after.unscheduled.some((u) => u.name === 'Emergency fund')).toBe(false);
    const nov13 = after.periods.find((x) => x.payDate === '2026-11-13')!;
    expect(nov13.items.find((i) => i.name === 'Emergency fund')).toMatchObject({ date: '2026-11-13', amount: 50000, kind: 'save' });
    expect(after.payers[ef.categoryId]).toBe("Jason's Nov 13 check");
  });
});
