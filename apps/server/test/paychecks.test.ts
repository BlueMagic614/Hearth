import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { migrate, openDb, type Db } from '../src/db';
import { seedHousehold } from '../src/seed';

let db: Db;
let app: FastifyInstance;
let cookie = '';
type Item = { name: string; date: string; amount: number; kind: string; categoryId: string | null };
type Step = { from: string; to: string; items: Item[]; outflow: number; leaves: number; pool?: number };
type Half = { from: string; to: string; first: { person: string; payDate: string; amount: number }; second: { person: string; payDate: string; amount: number } | null; step1: Step; step2: Step | null; carryIn: number; end: number };
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};
const plan = async (m = '2026-11') => (await api('GET', `/api/paychecks?month=${m}`)).body as { halves: Half[]; unscheduled: { categoryId: string; name: string }[]; payers: Record<string, string> };

beforeAll(async () => {
  db = await openDb({ memory: true });
  await migrate(db);
  await seedHousehold(db, { devPassword: 'test-password-123' });
  app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'jason@hearth.local', password: 'test-password-123' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterAll(async () => { await app.close(); await db.close(); });

describe('paycheck plan in halves', () => {
  it('pairs Renee\'s check with Jason\'s: 10th + 15th until the 25th, 25th + 30th until the 10th', async () => {
    const p = await plan();
    // Oct 25 and Nov 15 fall on Sundays, so those checks come the Friday before.
    expect(p.halves.map((h) => [h.first.person, h.first.payDate, h.second?.person, h.second?.payDate, h.to])).toEqual([
      ['Renee', '2026-10-23', 'Jason', '2026-10-30', '2026-11-10'],
      ['Renee', '2026-11-10', 'Jason', '2026-11-13', '2026-11-25'],
      ['Renee', '2026-11-25', 'Jason', '2026-11-30', '2026-12-10'],
    ]);
    const late = p.halves[0]!;
    expect([late.step1.to, late.step2!.from]).toEqual(['2026-10-30', '2026-10-31']);
    expect(late.step2!.items.find((i) => i.name === 'Rent')).toMatchObject({ date: '2026-11-01', amount: 169000 });
  });

  it("Renee's check alone pays through Jason's payday; tithe comes out of the check landing that day", async () => {
    await db.query("UPDATE schedules SET days = '{13}', date_source = 'manual' WHERE name = 'Spectrum Mobile'");
    const h = (await plan()).halves[1]!;
    expect(h.step1.items.some((i) => i.name === 'Spectrum Mobile' && i.date === '2026-11-13')).toBe(true);
    expect(h.step1.items.filter((i) => i.name.includes('tithe')).map((i) => i.date)).toEqual(['2026-11-10']);
    expect(h.step2!.items.filter((i) => i.name.includes('tithe')).map((i) => i.date)).toEqual(['2026-11-13']);
    // The next half's tithe (Nov 25) isn't in this one.
    expect([...h.step1.items, ...h.step2!.items].some((i) => i.date === '2026-11-25' && i.name.includes('tithe'))).toBe(false);
  });

  it('pools what is left of the first check with the second, and carries leftovers forward', async () => {
    await db.query("UPDATE categories SET cash = TRUE WHERE name IN ('Groceries', 'Fuel')");
    const p = await plan();
    for (const h of p.halves) {
      expect(h.step1.leaves).toBe(h.first.amount - h.step1.outflow);
      expect(h.step2!.pool).toBe(h.step1.leaves + h.carryIn + h.second!.amount);
      expect(h.end).toBe(h.step2!.pool! - h.step2!.outflow);
      expect(h.step1.items.some((i) => i.kind === 'cash') && h.step2!.items.some((i) => i.kind === 'cash')).toBe(true);
    }
    for (let i = 1; i < p.halves.length; i++) expect(p.halves[i]!.carryIn).toBe(Math.max(0, p.halves[i - 1]!.end));
  });

  it('lists monthly items without a date, and pays one from a chosen check', async () => {
    const p = await plan();
    const ef = p.unscheduled.find((u) => u.name === 'Emergency fund')!;
    expect(ef).toBeTruthy();
    await api('POST', '/api/paychecks/assign', { categoryId: ef.categoryId, payDay: 15 });
    const after = await plan();
    expect(after.unscheduled.some((u) => u.name === 'Emergency fund')).toBe(false);
    const h = after.halves[1]!;
    expect(h.step2!.items.find((i) => i.name === 'Emergency fund')).toMatchObject({ date: '2026-11-13', amount: 50000, kind: 'save' });
    expect(after.payers[ef.categoryId]).toBe("Renee's and Jason's pooled checks (Nov 10 + 13)");
  });
});

describe('letting Hearth decide', () => {
  it('previews placements for savings and extra debt, balanced across halves, from the second check of a half', async () => {
    // Undo the earlier manual assignment so everything is up for grabs.
    const r = (await api('POST', '/api/paychecks/auto', { month: '2026-11' })).body as { placements: { name: string; payDay: number; person: string; reason: string }[]; after: { half: string; leftAtEnd: number; firstCheckAlone: number }[]; applied: boolean };
    expect(r.applied).toBe(false);
    expect(r.placements.map((p) => p.name).sort()).toEqual(['Christmas & holidays', 'Emergency fund', 'Extra on student loans', 'Vacation']);
    // Same half either way, so the later payday wins: Renee's check stays free for bills until Jason is paid.
    expect(r.placements.every((p) => p.payDay === 15 || p.payDay === 30)).toBe(true);
    expect(r.placements.every((p) => p.reason.length > 20)).toBe(true);
    // The budget gives every dollar a job, so halves land near zero; none should be meaningfully short.
    const nets = r.after.map((a) => a.leftAtEnd);
    expect(Math.min(...nets)).toBeGreaterThan(-10000);
    expect(new Set(r.placements.map((p) => p.payDay)).size).toBe(2);
  });

  it('applies the placements when asked', async () => {
    await api('POST', '/api/paychecks/auto', { month: '2026-11', apply: true });
    const after = await plan();
    expect(after.unscheduled).toEqual([]);
    expect(Object.keys(after.payers).length).toBeGreaterThan(0);
  });
});
