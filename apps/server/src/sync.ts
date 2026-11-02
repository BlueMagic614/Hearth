import type { BankAccount, BankProvider, BankTxn } from './bank';
import { decrypt } from './crypto';
import type { Db } from './db';
import { newId } from './auth';
import { householdToday } from './time';
import { flowOf, runAgent, type AgentResult, type PayeeClassifier } from './agent';

/** Letters only, for comparing payee names: "KROGER #123" and "Kroger 456" → "kroger". */
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

const accountType = (a: BankAccount) =>
  a.type === 'depository' ? (a.subtype === 'savings' || a.subtype === 'money market' ? 'savings' : 'checking') : a.type === 'credit' ? 'credit' : a.type;

export interface SyncResult { added: number; modified: number; removed: number; categorized: number; review: number; learnedDates: number; agent?: AgentResult }

/**
 * Pulls accounts and every page of new transactions for one connection, applies them, sorts what it can, and
 * learns due dates. Safe to run repeatedly: Plaid's cursor makes each run pick up only what changed.
 */
export async function syncConnection(db: Db, bank: BankProvider, connectionId: string, opts: { classifier?: PayeeClassifier | null; today?: string } = {}): Promise<SyncResult> {
  const conn = (await db.query<{ id: string; household_id: string; access_token_enc: string; cursor: string | null }>(
    'SELECT id, household_id, access_token_enc, cursor FROM bank_connections WHERE id = $1', [connectionId]))[0];
  if (!conn) throw new Error('Connection not found');
  const hid = conn.household_id;
  const token = decrypt(conn.access_token_enc);
  const result: SyncResult = { added: 0, modified: 0, removed: 0, categorized: 0, review: 0, learnedDates: 0 };

  try {
    // 1. Accounts and balances
    const accounts = await bank.getAccounts(token);
    for (const a of accounts) {
      const t = accountType(a);
      // Credit cards and loans are money owed, so store their balance as negative.
      const bal = a.current === null ? 0 : t === 'credit' || t === 'loan' ? -a.current : a.current;
      await db.query(
        `INSERT INTO accounts (id, household_id, connection_id, external_id, name, type, subtype, institution, mask, balance_cents, available_cents, limit_cents, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'Kemba',$8,$9,$10,$11, now())
         ON CONFLICT (external_id) DO UPDATE SET name = EXCLUDED.name, balance_cents = EXCLUDED.balance_cents, available_cents = EXCLUDED.available_cents,
           limit_cents = EXCLUDED.limit_cents, mask = EXCLUDED.mask, updated_at = now()`,
        [newId(), hid, conn.id, a.externalId, a.name, t, a.subtype, a.mask, bal, a.available, a.limit],
      );
    }
    if (accounts.some((a) => accountType(a) === 'checking')) {
      // A real Kemba checking balance replaces the one typed in by hand.
      await db.query("DELETE FROM accounts WHERE household_id = $1 AND connection_id IS NULL AND type = 'checking'", [hid]);
    }
    const acctIds = new Map((await db.query<{ id: string; external_id: string }>('SELECT id, external_id FROM accounts WHERE connection_id = $1', [conn.id])).map((r) => [r.external_id, r.id]));

    // 2. Transactions, page by page
    let cursor = conn.cursor;
    const added: BankTxn[] = [];
    const modified: BankTxn[] = [];
    const removed: string[] = [];
    for (let guard = 0; guard < 100; guard++) {
      const page = await bank.syncTransactions(token, cursor);
      added.push(...page.added);
      modified.push(...page.modified);
      removed.push(...page.removed);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }

    for (const t of [...added, ...modified]) {
      // When a pending charge posts, keep the category the household (or the agent) already gave it.
      let carried: { category_id: string | null; source: string } | undefined;
      if (t.pendingExternalId) {
        carried = (await db.query<{ category_id: string | null; source: string }>('SELECT category_id, source FROM transactions WHERE external_id = $1', [t.pendingExternalId]))[0];
      }
      const id = newId();
      const rows = await db.query<{ id: string; inserted: boolean }>(
        `INSERT INTO transactions (id, household_id, account_id, external_id, pending_external_id, date, authorized_date, amount_cents, merchant, raw_name, bank_category, pending, category_id, source, flow)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (external_id) DO UPDATE SET date = EXCLUDED.date, authorized_date = EXCLUDED.authorized_date, amount_cents = EXCLUDED.amount_cents,
           merchant = EXCLUDED.merchant, raw_name = EXCLUDED.raw_name, bank_category = EXCLUDED.bank_category, pending = EXCLUDED.pending
         RETURNING id, (xmax = 0) AS inserted`,
        [id, hid, acctIds.get(t.accountExternalId) ?? null, t.externalId, t.pendingExternalId, t.date, t.authorizedDate, t.amount,
          t.merchantName || t.name, t.name, t.category, t.pending, carried?.category_id ?? null, carried?.category_id ? carried.source : 'bank', flowOf(t.category, t.amount)],
      );
      if (rows[0]?.inserted) result.added++; else result.modified++;
    }
    if (removed.length) {
      const r = await db.query('DELETE FROM transactions WHERE external_id = ANY($1) RETURNING id', [removed]);
      result.removed = r.length;
    }

    const agent = await runAgent(db, hid, { classifier: opts.classifier, today: opts.today ?? householdToday() });
    result.agent = agent;
    result.categorized = agent.remembered + agent.model + agent.bank + agent.claude;
    result.review = agent.review;
    await assignBudgetMonths(db, hid);
    result.learnedDates = await learnDueDates(db, hid);

    await db.query("UPDATE bank_connections SET cursor = $1, last_synced_at = now(), status = 'ok', last_error = NULL WHERE id = $2", [cursor, conn.id]);
    return result;
  } catch (e) {
    const err = e as { response?: { data?: { error_code?: string; error_message?: string } }; message?: string };
    const code = err.response?.data?.error_code;
    const status = code === 'ITEM_LOGIN_REQUIRED' ? 'login_required' : 'error';
    await db.query('UPDATE bank_connections SET status = $1, last_error = $2 WHERE id = $3', [status, err.response?.data?.error_message ?? err.message ?? 'Sync failed', conn.id]);
    throw e;
  }
}

/**
 * Links payments to the bill whose category they were sorted into (e.g. a landlord payment sorted to Rent),
 * so the bill's real due day can be learned. Only money going out, and never one already linked.
 */
export async function linkBills(db: Db, ids: string[]) {
  if (!ids.length) return;
  await db.query(
    `UPDATE transactions t SET schedule_id = s.id
     FROM (SELECT DISTINCT ON (category_id) id, category_id FROM schedules WHERE category_id IS NOT NULL ORDER BY category_id, id) s
     WHERE t.id = ANY($1) AND t.schedule_id IS NULL AND t.amount_cents < 0 AND s.category_id = t.category_id`, [ids]);
}

/** Words too common to identify a bill's payee ("Pet insurance" must not catch PetSmart). */
const GENERIC = new Set(['the', 'my', 'pet', 'car', 'home', 'auto', 'life', 'student', 'boy', 'boys', 'kids', 'music', 'lessons', 'insurance', 'internet', 'mobile', 'extra', 'lunch', 'accounts', 'modern', 'rent']);

/**
 * First-pass sorting until the Phase 3 agent arrives:
 *  1. a payee the household has categorized before goes to the same category;
 *  2. a payment that matches a scheduled bill (name and amount) goes to that bill's category and is linked to it.
 */
export async function categorize(db: Db, hid: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const txns = await db.query<{ id: string; merchant: string; amount_cents: number; date: string }>(
    "SELECT id, merchant, amount_cents, to_char(date, 'YYYY-MM-DD') AS date FROM transactions WHERE id = ANY($1)", [ids]);
  const bills = await db.query<{ id: string; name: string; amount_cents: number; variable: boolean; category_id: string | null }>(
    'SELECT id, name, amount_cents, variable, category_id FROM schedules WHERE household_id = $1', [hid]);
  const billCats = new Set(bills.map((b) => b.category_id).filter(Boolean));
  const diff = (a: number, b: number) => Math.abs(Math.abs(a) - Math.abs(b));
  let n = 0;
  for (const t of txns) {
    const key = norm(t.merchant);
    if (!key) continue;

    // Bills this payment could be: brand in the payee name and an amount close to the bill. Closest amount wins,
    // which tells apart two bills from one payee (Spectrum internet $171 vs Spectrum Mobile $103).
    let bill: (typeof bills)[number] | undefined;
    if (t.amount_cents < 0) {
      const initials = t.merchant.toLowerCase().split(/[^a-z]+/).filter(Boolean).map((w) => w[0]).join('');
      const fits = bills.filter((b) => {
        // Match on the brand word ("Columbia" in "Columbia Gas"), never generic words like "gas" that a gas station shares.
        // Short names may be initials: "AEP" matches "American Electric Power".
        const brand = b.name.toLowerCase().replace(/\(.*?\)/g, '').split(/[^a-z0-9]+/).find((w) => w.length >= 3 && !GENERIC.has(w));
        const nameHit = !!brand && (key.includes(brand) || (brand.length <= 4 && initials.includes(brand)));
        return nameHit && diff(t.amount_cents, b.amount_cents) <= Math.abs(b.amount_cents) * (b.variable ? 0.6 : 0.25);
      });
      bill = fits.sort((a, b) => diff(t.amount_cents, a.amount_cents) - diff(t.amount_cents, b.amount_cents))[0];
    }

    // What the household did with this payee before. If it went to more than one category, the past payment
    // closest in amount decides.
    const priors = await db.query<{ category_id: string; schedule_id: string | null; amount_cents: number }>(
      `SELECT category_id, schedule_id, amount_cents FROM transactions WHERE household_id = $1 AND id <> $2 AND category_id IS NOT NULL AND source IN ('you','rule','manual')
         AND regexp_replace(lower(merchant), '[^a-z]', '', 'g') = $3 ORDER BY (source = 'you') DESC, date DESC LIMIT 30`, [hid, t.id, key]);
    const prior = new Set(priors.map((p) => p.category_id)).size > 1
      ? [...priors].sort((a, b) => diff(t.amount_cents, a.amount_cents) - diff(t.amount_cents, b.amount_cents))[0]
      : priors[0];

    // A matching bill beats memory that points at a different bill (memory can't see amounts); memory wins otherwise.
    const useBill = bill?.category_id && (!prior || prior.category_id === bill.category_id || billCats.has(prior.category_id));
    const choice = useBill ? { category_id: bill!.category_id!, schedule_id: bill!.id } : prior;
    if (!choice) continue;
    await db.query("UPDATE transactions SET category_id = $1, schedule_id = $2, source = 'rule', needs_review = FALSE, suggested_category_id = NULL WHERE id = $3",
      [choice.category_id, choice.schedule_id, t.id]);
    n++;
  }
  return n;
}

const ymOf = (d: string) => d.slice(0, 7);
const nextYM = (ym: string) => { const [y, m] = ym.split('-').map(Number) as [number, number]; return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };
const dim = (ym: string) => { const [y, m] = ym.split('-').map(Number) as [number, number]; return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

/**
 * A monthly bill paid in the last week of a month for the next one (rent paid on the 31st, due the 1st) counts
 * toward the next month. That's when the bill is due early in the month, or when this month already has its payment.
 * Only payments nobody has placed by hand are moved.
 */
export async function assignBudgetMonths(db: Db, hid: string): Promise<number> {
  const rows = await db.query<{ id: string; date: string; schedule_id: string; days: number[]; budget_month: string | null }>(
    `SELECT t.id, to_char(t.date, 'YYYY-MM-DD') AS date, t.schedule_id, s.days, t.budget_month FROM transactions t JOIN schedules s ON s.id = t.schedule_id
     WHERE t.household_id = $1 AND s.cadence = 'monthly' AND t.amount_cents < 0 ORDER BY t.date, t.id`, [hid]);
  const count = new Map<string, number>();
  const bump = (k: string) => count.set(k, (count.get(k) ?? 0) + 1);
  // Payments already placed (by hand or earlier runs) count first.
  for (const r of rows) if (r.budget_month) bump(`${r.schedule_id}|${r.budget_month}`);
  let moved = 0;
  for (const r of rows) {
    if (r.budget_month) continue;
    const ym = ymOf(r.date);
    const day = Number(r.date.slice(8, 10));
    const due = r.days[0] ?? 1;
    const lateInMonth = day >= dim(ym) - 6;
    const next = nextYM(ym);
    if (lateInMonth && (due <= 7 || (count.get(`${r.schedule_id}|${ym}`) ?? 0) > 0) && !(count.get(`${r.schedule_id}|${next}`) ?? 0)) {
      await db.query('UPDATE transactions SET budget_month = $1 WHERE id = $2', [next, r.id]);
      bump(`${r.schedule_id}|${next}`);
      moved++;
    } else bump(`${r.schedule_id}|${ym}`);
  }
  return moved;
}

/**
 * Learns the usual day for bills whose date is an estimate (or was learned before), from at least two posted
 * payments. A payment counted toward the next month reads as an early day (Oct 31 for November = day 0).
 * Uses the median and records how far payments wander. Dates a person set are never changed here.
 */
export async function learnDueDates(db: Db, hid: string): Promise<number> {
  const rows = await db.query<{ schedule_id: string; date: string; budget_month: string | null }>(
    `SELECT t.schedule_id, to_char(t.date, 'YYYY-MM-DD') AS date, t.budget_month FROM transactions t JOIN schedules s ON s.id = t.schedule_id
     WHERE t.household_id = $1 AND NOT t.pending AND s.date_source IN ('placeholder', 'learned') AND s.cadence = 'monthly' AND t.amount_cents < 0`, [hid]);
  const by = new Map<string, number[]>();
  for (const r of rows) {
    const ym = ymOf(r.date);
    let day = Number(r.date.slice(8, 10));
    if (r.budget_month && r.budget_month === nextYM(ym)) day -= dim(ym);
    by.set(r.schedule_id, [...(by.get(r.schedule_id) ?? []), day]);
  }
  let n = 0;
  for (const [sid, days] of by) {
    if (days.length < 2) continue;
    const sorted = [...days].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const due = Math.min(31, Math.max(1, median));
    const window = Math.min(5, Math.max(...sorted.map((d) => Math.abs(d - due))));
    const r = await db.query("UPDATE schedules SET days = $1, window_days = $2, date_source = 'learned' WHERE id = $3 AND date_source IN ('placeholder', 'learned') AND (days <> $1 OR window_days <> $2 OR date_source <> 'learned') RETURNING id", [[due], window, sid]);
    n += r.length;
  }
  return n;
}

/** Runs a sync for every connection in a household, collecting errors instead of stopping at the first. */
export async function syncHousehold(db: Db, bank: BankProvider, hid: string, opts: { classifier?: PayeeClassifier | null } = {}) {
  const conns = await db.query<{ id: string }>('SELECT id FROM bank_connections WHERE household_id = $1', [hid]);
  const out: { id: string; ok: boolean; result?: SyncResult; error?: string }[] = [];
  for (const c of conns) {
    try { out.push({ id: c.id, ok: true, result: await syncConnection(db, bank, c.id, opts) }); }
    catch (e) { out.push({ id: c.id, ok: false, error: (e as Error).message }); }
  }
  return out;
}
