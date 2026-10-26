import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A minimal database adapter. Production uses PostgreSQL through `pg` (DATABASE_URL).
 * Development and tests use PGlite, a real Postgres engine compiled to WebAssembly,
 * so the same SQL runs everywhere.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

export async function openDb(opts: { url?: string; dataDir?: string; memory?: boolean } = {}): Promise<Db> {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (url) {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: url });
    const make = (client: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Db => ({
      query: async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[],
      tx: async (fn) => fn(make(client)),
      close: async () => {},
    });
    return {
      query: async <T>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[],
      tx: async <T>(fn: (db: Db) => Promise<T>) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const out = await fn(make(c));
          await c.query('COMMIT');
          return out;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  let pglite: InstanceType<typeof PGlite>;
  if (opts.memory) pglite = new PGlite();
  else {
    const dir = opts.dataDir ?? process.env.HEARTH_DATA_DIR ?? join(here, '..', '.data', 'pglite');
    mkdirSync(dir, { recursive: true });
    pglite = new PGlite(dir);
  }
  const wrap = (q: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Db => ({
    query: async <T>(sql: string, params: unknown[] = []) => (await q.query(sql, params)).rows as T[],
    tx: async (fn) => fn(wrap(q)),
    close: async () => {},
  });
  return {
    query: async <T>(sql: string, params: unknown[] = []) => (await pglite.query(sql, params)).rows as T[],
    tx: <T>(fn: (db: Db) => Promise<T>) => pglite.transaction((t) => fn(wrap(t))) as Promise<T>,
    close: () => pglite.close(),
  };
}

/** Applies every migrations/*.sql file not yet recorded, in filename order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const dir = join(here, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    await db.tx(async (t) => {
      for (const stmt of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await t.query(stmt);
      await t.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}
