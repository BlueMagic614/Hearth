import { randomUUID } from 'node:crypto';
import { toCents } from '@hearth/core';
import type { Db } from './db';
import { hashPassword, verifyPassword } from './auth';

/**
 * Seeds the Green household from what Jason has provided: paychecks, the 21 fixed bills from his
 * spreadsheet, the everyday categories chosen in the setup interview (starter amounts until Kemba
 * history replaces them), student loans with rates, goals and one-time income.
 * No transactions or balances are invented; those come from manual entry or Kemba.
 */
type Leaf = [name: string, planned: number, kind: string, bill?: { day: number; variable?: boolean }];
type Group = { name: string; kind: string; items: (Leaf | Group)[] };

const BUDGET: Group[] = [
  { name: 'Giving', kind: 'giving', items: [['Rocky City (tithe)', 1400, 'giving']] },
  {
    name: 'Housing & utilities', kind: 'bill', items: [
      ['Rent', 1690, 'bill', { day: 1 }],
      ['AEP', 350, 'bill', { day: 22, variable: true }],
      ['Columbia Gas', 100, 'bill', { day: 23, variable: true }],
      ['Spectrum Internet & TV', 171, 'bill', { day: 5 }],
      ['Spectrum Mobile', 103, 'bill', { day: 14 }],
    ],
  },
  {
    name: 'Student loans', kind: 'debt', items: [
      ['FirstMark', 391.26, 'debt', { day: 12 }],
      ['NelNet', 277.88, 'debt', { day: 18 }],
      ['Mohela', 189.45, 'debt', { day: 8 }],
      ['Extra on student loans', 500, 'debt'],
    ],
  },
  { name: 'Food', kind: 'everyday', items: [['Groceries', 1100, 'everyday']] },
  { name: 'Transportation', kind: 'everyday', items: [['Fuel', 250, 'everyday'], ['Car maintenance', 75, 'everyday'], ['Car registration (yearly)', 15, 'everyday']] },
  {
    name: 'Kids', kind: 'bill', items: [
      ['WYB Soccer', 207, 'bill', { day: 20 }],
      ['Student lunch accounts', 150, 'bill', { day: 2 }],
      ["Boy's music lessons", 79, 'bill', { day: 26 }],
      ["Kids' school & activity extras", 100, 'everyday'],
    ],
  },
  {
    name: 'Insurance', kind: 'bill', items: [
      ['Granger Insurance', 112, 'bill', { day: 21 }],
      ['Banner Insurance', 52, 'bill', { day: 27 }],
      ['Pet insurance', 43, 'bill', { day: 28 }],
      ['Zander Insurance', 22, 'bill', { day: 27 }],
    ],
  },
  {
    name: 'Subscriptions', kind: 'bill', items: [
      ['Splice', 33, 'bill', { day: 24 }], ['Xbox', 25, 'bill', { day: 28 }], ['Disney+', 22, 'bill', { day: 16 }], ['Crunchyroll', 11, 'bill', { day: 16 }],
    ],
  },
  { name: 'Health', kind: 'bill', items: [['Modern Therapy', 60, 'bill', { day: 29 }]] },
  { name: 'Home', kind: 'everyday', items: [['Household supplies', 200, 'everyday']] },
  { name: 'Savings', kind: 'savings', items: [['Emergency fund', 500, 'savings'], ['Vacation', 250, 'savings'], ['Christmas & holidays', 150, 'savings']] },
  {
    name: 'Other', kind: 'everyday', items: [
      ['Restaurants & takeout', 300, 'everyday'], ['Family outings', 150, 'everyday'], ['Clothing & shoes', 150, 'everyday'], ['Date nights', 100, 'everyday'],
      { name: 'Hobbies', kind: 'everyday', items: [['Music gear', 50, 'everyday'], ['Games', 25, 'everyday']] },
      ['Gifts & birthdays', 100, 'everyday'], ['Pet food & vet', 80, 'everyday'], ['Haircuts', 60, 'everyday'], ['Coffee & snacks', 60, 'everyday'],
    ],
  },
];

export const SEED_MONTH = '2026-10';

/**
 * Keeps the starter password in step with configuration for accounts that have never set
 * their own password. Accounts that already chose a password are never touched.
 */
export async function syncStarterPassword(db: Db, password: string | undefined): Promise<number> {
  if (!password) return 0;
  const rows = await db.query<{ id: string; password_hash: string | null }>('SELECT id, password_hash FROM users WHERE must_change_password = TRUE');
  let changed = 0;
  for (const r of rows) {
    if (await verifyPassword(password, r.password_hash)) continue;
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2 AND must_change_password = TRUE', [await hashPassword(password), r.id]);
    changed++;
  }
  return changed;
}

export async function seedHousehold(db: Db, opts: { jasonEmail?: string; reneeEmail?: string; devPassword?: string } = {}): Promise<string> {
  const existing = await db.query<{ id: string }>('SELECT id FROM households LIMIT 1');
  if (existing[0]) return existing[0].id;

  const hid = randomUUID();
  await db.tx(async (t) => {
    await t.query('INSERT INTO households (id, name) VALUES ($1, $2)', [hid, 'Green household']);

    const pw = opts.devPassword ? await hashPassword(opts.devPassword) : null;
    await t.query('INSERT INTO users (id, household_id, name, email, password_hash) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), hid, 'Jason', opts.jasonEmail ?? 'jason@hearth.local', pw]);
    await t.query('INSERT INTO users (id, household_id, name, email, password_hash) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), hid, 'Renee', opts.reneeEmail ?? 'renee@hearth.local', pw]);

    await t.query("INSERT INTO income_sources (id, household_id, person, amount_cents, cadence, days, weekend_rule) VALUES ($1,$2,'Jason',$3,'semimonthly',$4,'before')", [randomUUID(), hid, toCents(2198), [15, 30]]);
    await t.query("INSERT INTO income_sources (id, household_id, person, amount_cents, cadence, days, weekend_rule) VALUES ($1,$2,'Renee',$3,'semimonthly',$4,'before')", [randomUUID(), hid, toCents(2660), [10, 25]]);

    const insert = async (item: Leaf | Group, parentId: string | null, order: number) => {
      const id = randomUUID();
      if (Array.isArray(item)) {
        const [name, planned, kind, bill] = item;
        await t.query('INSERT INTO categories (id, household_id, parent_id, name, kind, sort_order) VALUES ($1,$2,$3,$4,$5,$6)', [id, hid, parentId, name, kind, order]);
        await t.query('INSERT INTO budgets (category_id, month, planned_cents) VALUES ($1,$2,$3)', [id, SEED_MONTH, toCents(planned)]);
        if (bill) {
          await t.query(
            "INSERT INTO schedules (id, household_id, name, kind, amount_cents, cadence, days, variable, category_id) VALUES ($1,$2,$3,'bill',$4,'monthly',$5,$6,$7)",
            [randomUUID(), hid, name, -toCents(planned), [bill.day], !!bill.variable, id],
          );
        }
      } else {
        await t.query('INSERT INTO categories (id, household_id, parent_id, name, kind, sort_order) VALUES ($1,$2,$3,$4,$5,$6)', [id, hid, parentId, item.name, item.kind, order]);
        for (const [i, child] of item.items.entries()) await insert(child, id, i);
      }
    };
    for (const [i, g] of BUDGET.entries()) await insert(g, null, i);

    // Tithe follows each paycheck ($350 × 4).
    const tithe = await t.query<{ id: string }>("SELECT id FROM categories WHERE household_id=$1 AND name='Rocky City (tithe)'", [hid]);
    await t.query(
      "INSERT INTO schedules (id, household_id, name, kind, amount_cents, cadence, days, weekend_rule, category_id, due_day_confirmed) VALUES ($1,$2,'Rocky City (tithe)','bill',$3,'semimonthly',$4,'before',$5,true)",
      [randomUUID(), hid, -toCents(350), [10, 15, 25, 30], tithe[0]!.id],
    );

    const loans: [string, number, number, number][] = [
      ['Mohela', 5855.45, 0.04125, 189.45],
      ['NelNet', 16240.27, 0.068, 277.88],
      ['FirstMark', 33801.83, 0.0825, 391.26],
    ];
    for (const [name, bal, apr, min] of loans) {
      await t.query("INSERT INTO loans (id, household_id, name, balance_cents, apr, min_payment_cents, as_of) VALUES ($1,$2,$3,$4,$5,$6,'2026-10-21')", [randomUUID(), hid, name, toCents(bal), apr, toCents(min)]);
    }
    await t.query("INSERT INTO loan_plans (household_id, strategy, extra_cents, start_month) VALUES ($1,'snowball',$2,'2026-11')", [hid, toCents(500)]);

    const goals: [string, string, number, number, number, string | null, string][] = [
      ['Emergency fund', 'save', 20550, 0, 500, null, 'Next few years'],
      ['Family vacation', 'save', 3000, 0, 250, '2027-06', 'This year'],
      ['Christmas & holidays', 'save', 1800, 0, 150, '2027-12', 'This year'],
      ['All student loans paid off', 'debt', 0, 0, 0, null, 'Long-term'],
    ];
    for (const [i, [name, kind, target, saved, monthly, tm, horizon]] of goals.entries()) {
      await t.query('INSERT INTO goals (id, household_id, name, kind, target_cents, saved_cents, monthly_cents, target_month, horizon, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [randomUUID(), hid, name, kind, toCents(target), toCents(saved), toCents(monthly), tm, horizon, i]);
    }

    const events: [string, string, string, number, string, boolean, string][] = [
      ['Annual bonus', 'one_time', '2027-02', 3000, 'loans', true, 'Usually $3,000–$7,000; planned at the low end.'],
      ['Vested stock sale', 'one_time', '2027-02', 2000, 'loans', true, 'Enter the amount after taxes.'],
      ['Raise', 'raise', '2027-02', 100, 'loans', false, 'Extra take-home per month, planned low; update when known.'],
    ];
    for (const [name, kind, month, amt, dest, repeats, note] of events) {
      await t.query('INSERT INTO income_events (id, household_id, name, kind, month, amount_cents, destination, repeats_yearly, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), hid, name, kind, month, toCents(amt), dest, repeats, note]);
    }

    await t.query("INSERT INTO settings (household_id, key, value) VALUES ($1, 'variable_bill_leftover', '\"emergency\"')", [hid]);
  });
  return hid;
}
