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

describe('the half we are in uses the real balance', () => {
  it('starts from Kemba checking, subtracts what is still due, and carries the real result forward', async () => {
    const { paycheckPlan } = await import('../src/paychecks');
    const hid = (await db.query<{ id: string }>('SELECT id FROM households'))[0]!.id;
    await api('PUT', '/api/accounts/checking', { balance: 612 });
    // Rent went out on Oct 31; music lessons (due Oct 26) hasn't hit the bank yet.
    const rent = (await db.query<{ id: string }>("SELECT id FROM categories WHERE name = 'Rent'"))[0]!.id;
    await db.query("INSERT INTO transactions (id, household_id, external_id, date, amount_cents, merchant, category_id, source) VALUES ('rent1', $1, 'rent1', '2026-10-31', -169000, 'Carlton Equities', $2, 'you')", [hid, rent]);
    const p = await paycheckPlan(db, hid, '2026-11', { today: '2026-11-02' });
    const h = p.halves[0]!;
    expect(h.actual).toBeTruthy();
    expect(h.actual!.items.find((i) => i.name === "Boy's music lessons")).toMatchObject({ date: '2026-10-26', late: true });
    const a = h.actual!;
    expect(a.balance).toBe(61200);
    expect(a.checksToCome).toBe(0); // Jason's Oct 30 check is already in
    // Rent is paid; the lunch accounts (Nov 2), Spectrum Internet (Nov 5) and Mohela (Nov 8) are still due.
    expect(a.items.some((i) => i.name === 'Rent')).toBe(false);
    expect(a.items.filter((i) => i.kind === 'bill').map((i) => i.name)).toEqual(expect.arrayContaining(['Student lunch accounts', 'Spectrum Internet & TV', 'Mohela']));
    expect(a.end).toBe(a.balance - a.stillDue);
    expect(h.end).toBe(a.end);
    expect(p.halves[1]!.carryIn).toBe(Math.max(0, a.end));
  });
});

describe('adjusting the plan to real life', () => {
  const live = async () => {
    const { paycheckPlan } = await import('../src/paychecks');
    const hid = (await db.query<{ id: string }>('SELECT id FROM households'))[0]!.id;
    return { hid, p: await paycheckPlan(db, hid, '2026-11', { today: '2026-11-02' }) };
  };

  it("drops a deleted category's bill from every plan", async () => {
    const xbox = (await db.query<{ id: string }>("SELECT id FROM categories WHERE name = 'Xbox'"))[0]!.id;
    await api('DELETE', `/api/categories/${xbox}`);
    const { p } = await live();
    expect(p.halves.flatMap((h) => [...h.step1.items, ...(h.step2?.items ?? [])]).some((i) => i.name === 'Xbox')).toBe(false);
    const cal = (await api('GET', '/api/calendar?month=2026-11')).body.events as { name: string }[];
    expect(cal.some((e) => e.name === 'Xbox')).toBe(false);
  });

  it('places a flexible bill on the payday with the most room, and says so', async () => {
    const lunch = (await db.query<{ id: string }>("SELECT id FROM categories WHERE name = 'Student lunch accounts'"))[0]!.id;
    await api('PATCH', `/api/categories/${lunch}`, { flexible: true });
    const { p } = await live();
    const placed = p.halves.flatMap((h) => [...h.step1.items, ...(h.step2?.items ?? [])].filter((i) => i.name === 'Student lunch accounts' && i.date.startsWith('2026-11')).map((i) => ({ h, i })));
    expect(placed).toHaveLength(1);
    expect(placed[0]!.i.suggested).toBe(true);
    // The tight half we're in (about $600 in checking) isn't the one chosen.
    expect(placed[0]!.h.first.payDate >= '2026-11-10').toBe(true);
    expect(placed[0]!.i.date).toBe(placed[0]!.h.second!.payDate);
    expect((await api('GET', '/api/paychecks?month=2026-11')).body.payers[lunch]).toMatch(/^Hearth suggests funding it on Nov/);
  });

  it('counts cash pulled since the half began, and lets a line be marked as already paid', async () => {
    const { hid, p } = await live();
    const before = p.halves[0]!.actual!;
    const cashBefore = before.items.find((i) => i.kind === 'cash')?.amount ?? 0;
    await db.query(`INSERT INTO transactions (id, household_id, external_id, date, amount_cents, merchant, source, flow) VALUES ('atm1', $1, 'atm1', '2026-10-31', -500000, 'ATM WITHDRAWAL', 'bank', 'cash')`, [hid]);
    const afterCash = (await live()).p.halves[0]!.actual!;
    expect(afterCash.items.find((i) => i.kind === 'cash')?.amount ?? 0).toBeLessThan(Math.max(1, cashBefore));

    const spectrum = afterCash.items.find((i) => i.name === 'Spectrum Internet & TV')!;
    await api('POST', '/api/paychecks/covered', { halfId: (await live()).p.halves[0]!.id, key: spectrum.key, covered: true });
    const marked = (await live()).p.halves[0]!.actual!;
    expect(marked.items.some((i) => i.name === 'Spectrum Internet & TV')).toBe(false);
    expect(marked.stillDue).toBe(afterCash.stillDue - spectrum.amount);
  });
});
