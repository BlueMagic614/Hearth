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
