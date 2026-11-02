import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { newId } from '../src/auth';
import { migrate, openDb, type Db } from '../src/db';
import { seedHousehold } from '../src/seed';

let db: Db;
let app: FastifyInstance;
let hid = '';
let cookie = '';
type Node = { name: string; children: Node[]; totalSpent: number; billPaid?: boolean };
const find = (ns: Node[], name: string): Node | undefined => { for (const n of ns) { if (n.name === name) return n; const f = find(n.children, name); if (f) return f; } return undefined; };
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};
const budget = async (m: string) => (await api('GET', `/api/budget?month=${m}`)).body.tree as Node[];
const bankTxn = async (merchant: string, dollars: number, bankCategory: string | null, date: string) => {
  const id = newId();
  await db.query(`INSERT INTO transactions (id, household_id, external_id, date, amount_cents, merchant, raw_name, bank_category, source)
    VALUES ($1,$2,$3,$4,$5,$6,$6,$7,'bank')`, [id, hid, `ext-${id}`, date, Math.round(dollars * 100), merchant, bankCategory]);
  return id;
};

beforeAll(async () => {
  db = await openDb({ memory: true });
  await migrate(db);
  await seedHousehold(db, { devPassword: 'test-password-123' });
  hid = (await db.query<{ id: string }>('SELECT id FROM households'))[0]!.id;
  app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'jason@hearth.local', password: 'test-password-123' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterAll(async () => { await app.close(); await db.close(); });

describe('rent paid early', () => {
  let oct31 = '';
  it("counts a payment on the 31st toward next month's rent", async () => {
    await bankTxn('Carlton Equities', -1683.36, 'RENT_AND_UTILITIES_RENT', '2026-09-01');
    await bankTxn('Carlton Equities', -1683.36, 'RENT_AND_UTILITIES_RENT', '2026-10-01');
    oct31 = await bankTxn('Carlton Equities', -1703.31, 'RENT_AND_UTILITIES_RENT', '2026-10-31');
    await api('POST', '/api/agent/run');
    expect(find(await budget('2026-10'), 'Rent')!.totalSpent).toBe(168336);
    expect(find(await budget('2026-11'), 'Rent')!.totalSpent).toBe(170331);
    const nov = (await api('GET', '/api/transactions?month=2026-11')).body as { merchant: string; budget_month: string }[];
    expect(nov.find((t) => t.merchant === 'Carlton Equities')?.budget_month).toBe('2026-11');
  });

  it('learns the 1st as the due day, counting the early payment as day 0', async () => {
    const { learnDueDates } = await import('../src/sync');
    await learnDueDates(db, hid);
    const s = (await db.query<{ days: number[]; window_days: number }>("SELECT days, window_days FROM schedules WHERE name = 'Rent'"))[0]!;
    expect(s.days).toEqual([1]);
    expect(s.window_days).toBeLessThanOrEqual(1);
  });

  it('lets you put a payment back in the month it cleared, and keeps it there', async () => {
    await api('PATCH', `/api/transactions/${oct31}`, { budgetMonth: '2026-10' });
    await api('POST', '/api/agent/run');
    expect(find(await budget('2026-10'), 'Rent')!.totalSpent).toBe(168336 + 170331);
  });
});

describe('fluctuating bills', () => {
  it('marks a variable bill paid once its payment goes out, even under the estimate', async () => {
    expect(find(await budget('2026-10'), 'AEP')!.billPaid).toBe(false);
    await bankTxn('American Electric Power', -345.76, 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY', '2026-10-19');
    await api('POST', '/api/agent/run');
    const aep = find(await budget('2026-10'), 'AEP')!;
    expect(aep.totalSpent).toBe(34576);
    expect(aep.billPaid).toBe(true);
    // Fixed bills still need the full amount.
    expect(find(await budget('2026-10'), 'Rent')!.billPaid).toBe(false);
  });
});

describe('two bills from one payee', () => {
  const cat = async (name: string) => (await db.query<{ id: string }>('SELECT id FROM categories WHERE name = $1', [name]))[0]!.id;
  const catOf = async (id: string) => (await db.query<{ name: string }>('SELECT c.name FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.id = $1', [id]))[0]?.name;

  it('tells Spectrum internet from Spectrum Mobile by amount, even after memory points one way', async () => {
    const mobile = await bankTxn('Spectrum', -102.76, 'RENT_AND_UTILITIES_TELEPHONE', '2026-09-14');
    const internet = await bankTxn('Spectrum', -170.44, 'RENT_AND_UTILITIES_TELEPHONE', '2026-09-05');
    await api('POST', '/api/agent/run');
    expect(await catOf(mobile)).toBe('Spectrum Mobile');
    expect(await catOf(internet)).toBe('Spectrum Internet & TV');
  });

  it('fixing one misfiled payment fixes its auto-sorted look-alikes, not the other bill', async () => {
    // Simulate the old behaviour: everything from Spectrum filed under Mobile.
    const a = await bankTxn('Spectrum', -170.44, null, '2026-10-05');
    const b = await bankTxn('Spectrum', -171.02, null, '2026-08-05');
    const m = await bankTxn('Spectrum', -102.76, null, '2026-10-14');
    await db.query("UPDATE transactions SET category_id = $1, source = 'rule' WHERE id = ANY($2)", [await cat('Spectrum Mobile'), [a, b, m]]);
    const r = await api('PATCH', `/api/transactions/${a}`, { categoryId: await cat('Spectrum Internet & TV') });
    expect(r.body.alsoSorted).toBeGreaterThanOrEqual(1);
    expect(await catOf(b)).toBe('Spectrum Internet & TV');
    expect(await catOf(m)).toBe('Spectrum Mobile');
    const link = await db.query<{ name: string }>('SELECT s.name FROM transactions t JOIN schedules s ON s.id = t.schedule_id WHERE t.id = $1', [b]);
    expect(link[0]?.name).toBe('Spectrum Internet & TV');
  });
});

describe('end-of-month bill paid late', () => {
  it('counts Columbia Gas paid on Nov 2 toward October, and expects November at the end of the month', async () => {
    const bills = await db.query<{ id: string; category_id: string }>("SELECT id, category_id FROM schedules WHERE name = 'Columbia Gas'");
    const sep = await bankTxn('Columbia Gas of Ohio', -88.1, null, '2026-09-30');
    const nov2 = await bankTxn('Columbia Gas of Ohio', -96.4, null, '2026-11-02');
    await db.query('UPDATE transactions SET category_id = $1 WHERE id = ANY($2)', [bills[0]!.category_id, [sep, nov2]]);
    await api('POST', '/api/agent/run');
    const months = await db.query<{ id: string; m: string }>("SELECT id, COALESCE(budget_month, to_char(date, 'YYYY-MM')) AS m FROM transactions WHERE id = ANY($1)", [[sep, nov2]]);
    expect(months.find((x) => x.id === nov2)!.m).toBe('2026-10');
    expect(months.find((x) => x.id === sep)!.m).toBe('2026-09');
    expect(find(await budget('2026-10'), 'Columbia Gas')!.billPaid).toBe(true);
    expect(find(await budget('2026-11'), 'Columbia Gas')!.billPaid).toBe(false);

    const { learnDueDates } = await import('../src/sync');
    await learnDueDates(db, hid);
    const s = (await db.query<{ days: number[]; weekend_rule: string }>("SELECT days, weekend_rule FROM schedules WHERE name = 'Columbia Gas'"))[0]!;
    expect(s.days[0]).toBeGreaterThanOrEqual(30);
    expect(s.weekend_rule).toBe('after');
    const nov = (await api('GET', '/api/calendar?month=2026-11')).body.events as { name: string; date: string }[];
    // October's bill (due Sat Oct 31) lands Monday Nov 2; November's is due Nov 30.
    expect(nov.filter((e) => e.name === 'Columbia Gas').map((e) => e.date)).toEqual(['2026-11-02', '2026-11-30']);
  });
});

describe('yearly categories', () => {
  it('hides car registration except in May, with no monthly amount, and puts it on the calendar for May 29', async () => {
    const id = (await db.query<{ id: string }>("SELECT id FROM categories WHERE name LIKE 'Car registration%'"))[0]!.id;
    const before = (await api('GET', '/api/budget?month=2026-11')).body;
    await api('PATCH', `/api/categories/${id}`, { months: [5], dueDay: 29 });

    const nov = (await api('GET', '/api/budget?month=2026-11')).body;
    expect(find(nov.tree, 'Car registration (yearly)')).toBeUndefined();
    expect(nov.plannedTotal).toBe(before.plannedTotal - 1500);
    expect(nov.hidden).toEqual([expect.objectContaining({ name: 'Car registration (yearly)', months: [5], dueDay: 29 })]);
    // Still reachable when asked for everything (for editing).
    expect(find((await api('GET', '/api/budget?month=2026-11&all=1')).body.tree, 'Car registration (yearly)')).toBeTruthy();

    const may = (await api('GET', '/api/budget?month=2027-05')).body;
    const reg = find(may.tree, 'Car registration (yearly)') as Node & { planned: number };
    expect(reg.planned).toBe(0);
    await api('PATCH', `/api/categories/${id}`, { planned: 118.5, month: '2027-05' });
    expect((find((await api('GET', '/api/budget?month=2027-05')).body.tree, 'Car registration (yearly)') as Node & { planned: number }).planned).toBe(11850);
    const cal = (await api('GET', '/api/calendar?month=2027-05')).body.events as { name: string; date: string; amount: number }[];
    expect(cal.filter((e) => e.name.startsWith('Car registration'))).toEqual([expect.objectContaining({ date: '2027-05-29', amount: -11850 })]);
    // June: hidden again, nothing carried forward.
    expect(find((await api('GET', '/api/budget?month=2027-06')).body.tree, 'Car registration (yearly)')).toBeUndefined();
    expect(((await api('GET', '/api/calendar?month=2027-06')).body.events as { name: string }[]).some((e) => e.name.startsWith('Car registration'))).toBe(false);
  });
});
