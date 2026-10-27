import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { migrate, openDb, type Db } from '../src/db';
import { seedHousehold } from '../src/seed';

let db: Db;
let app: FastifyInstance;
let cookie = '';
const M = '2026-10';

type Node = { id: string; name: string; children: Node[]; totalPlanned: number; totalSpent: number; planned: number };
const find = (nodes: Node[], name: string): Node | undefined => {
  for (const n of nodes) {
    if (n.name === name) return n;
    const f = find(n.children, name);
    if (f) return f;
  }
  return undefined;
};
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as object, headers: { cookie } });
  return { status: res.statusCode, body: res.json() };
};
const budget = async () => (await api('GET', `/api/budget?month=${M}`)).body as { income: number; plannedTotal: number; leftToAssign: number; tree: Node[] };

beforeAll(async () => {
  db = await openDb({ memory: true });
  await migrate(db);
  await seedHousehold(db, { devPassword: 'test-password-123' });
  app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'jason@hearth.local', password: 'test-password-123' } });
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
});
afterAll(async () => { await app.close(); await db.close(); });

describe('auth', () => {
  it('rejects requests without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/budget' });
    expect(res.statusCode).toBe(401);
  });
  it('rejects a wrong password', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'jason@hearth.local', password: 'nope' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('starter password sync', () => {
  it('updates a never-used account to the configured starter password, but not one that chose its own', async () => {
    const { syncStarterPassword } = await import('../src/seed');
    await db.query("UPDATE users SET must_change_password = FALSE WHERE email = 'jason@hearth.local'");
    expect(await syncStarterPassword(db, 'brand-new-starter-1')).toBe(1); // only Renee
    const renee = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'renee@hearth.local', password: 'brand-new-starter-1' } });
    expect(renee.statusCode).toBe(200);
    const jason = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'jason@hearth.local', password: 'brand-new-starter-1' } });
    expect(jason.statusCode).toBe(401);
    expect(await syncStarterPassword(db, 'brand-new-starter-1')).toBe(0); // already in step
  });
});

describe('seeded budget', () => {
  it('matches Jason\'s numbers: $9,716 income, $5,488.59 in bills, $12.41 left to assign', async () => {
    const b = await budget();
    expect(b.income).toBe(971600);
    expect(b.leftToAssign).toBe(1241);
    const bills = ['Rocky City (tithe)', 'Rent', 'AEP', 'Columbia Gas', 'Spectrum Internet & TV', 'Spectrum Mobile', 'FirstMark', 'NelNet', 'Mohela', 'WYB Soccer',
      'Student lunch accounts', "Boy's music lessons", 'Granger Insurance', 'Banner Insurance', 'Pet insurance', 'Zander Insurance', 'Modern Therapy', 'Splice', 'Xbox', 'Disney+', 'Crunchyroll'];
    expect(bills.reduce((s, n) => s + find(b.tree, n)!.planned, 0)).toBe(548859);
  });
  it('carries the plan forward into later months', async () => {
    const nov = (await api('GET', '/api/budget?month=2026-11')).body;
    expect(nov.leftToAssign).toBe(1241);
  });
});

describe('editing categories', () => {
  it('adds and deletes a category, updating left to assign, and can restore it', async () => {
    const other = find((await budget()).tree, 'Other')!;
    const add = await api('POST', '/api/categories', { name: 'Car wash', parentId: other.id, planned: 20, month: M });
    expect(add.status).toBe(200);
    expect((await budget()).leftToAssign).toBe(1241 - 2000);
    const del = await api('DELETE', `/api/categories/${add.body.id}`);
    expect((await budget()).leftToAssign).toBe(1241);
    await api('POST', '/api/categories/restore', { ids: del.body.archived });
    expect(find((await budget()).tree, 'Car wash')).toBeDefined();
    await api('DELETE', `/api/categories/${add.body.id}`);
  });

  it('splits a category into subcategories without losing its money', async () => {
    const rest = find((await budget()).tree, 'Restaurants & takeout')!;
    await api('POST', `/api/categories/${rest.id}/split`, { month: M });
    await api('POST', '/api/categories', { name: 'Takeout', parentId: rest.id, planned: 0, month: M });
    const after = find((await budget()).tree, 'Restaurants & takeout')!;
    expect(after.children.map((c) => c.name).sort()).toEqual(['General', 'Takeout']);
    expect(after.totalPlanned).toBe(30000);
    expect((await budget()).leftToAssign).toBe(1241);
  });

  it('groups categories under a new parent by name', async () => {
    const t = (await budget()).tree;
    const ids = ['Haircuts', 'Date nights'].map((n) => find(t, n)!.id);
    const r = await api('POST', '/api/categories/group', { ids, newParentName: 'Fun stuff', month: M });
    const parent = find((await budget()).tree, 'Fun stuff')!;
    expect(parent.id).toBe(r.body.parentId);
    expect(parent.children.map((c) => c.name).sort()).toEqual(['Date nights', 'Haircuts']);
    expect(parent.totalPlanned).toBe(16000);
  });

  it('ungroups a parent and keeps its categories', async () => {
    const parent = find((await budget()).tree, 'Fun stuff')!;
    await api('DELETE', `/api/categories/${parent.id}?mode=ungroup`);
    const t = (await budget()).tree;
    expect(find(t, 'Fun stuff')).toBeUndefined();
    expect(t.map((n) => n.name)).toContain('Haircuts');
    expect((await budget()).leftToAssign).toBe(1241);
  });

  it('refuses to put a category inside itself', async () => {
    const t = (await budget()).tree;
    const other = find(t, 'Other')!;
    const gear = find(t, 'Music gear')!;
    const r = await api('PATCH', `/api/categories/${other.id}`, { parentId: gear.id, month: M });
    expect(r.status).toBe(400);
  });
});

describe('transactions', () => {
  it('records spending against a category', async () => {
    const groc = find((await budget()).tree, 'Groceries')!;
    await api('POST', '/api/transactions', { date: '2026-10-20', amount: '86.43', merchant: 'Kroger', categoryId: groc.id });
    expect(find((await budget()).tree, 'Groceries')!.totalSpent).toBe(8643);
    const list = (await api('GET', `/api/transactions?month=${M}`)).body;
    expect(list[0].merchant).toBe('Kroger');
  });
});

describe('plan', () => {
  it('compares strategies with interest and applies February income', async () => {
    const p = (await api('GET', '/api/plan')).body;
    expect(p.withoutIncome.doneLabel).toBe('Nov 2030');
    // $5,000 (bonus low end + stock sale) every February from 2027, plus a $100/mo raise from Feb 2027.
    expect(p.current.doneLabel).toBe('Jul 2029');
    expect(p.avalanche.totalInterest).toBeLessThan(p.snowball.totalInterest);
    expect(p.minimumsOnly.doneLabel).toBe('Oct 2037');
  });
  it('switches strategy', async () => {
    const p = (await api('PUT', '/api/plan', { strategy: 'avalanche' })).body;
    expect(p.strategy).toBe('avalanche');
    expect(p.current.order[0]).toBe('FirstMark');
  });
});
