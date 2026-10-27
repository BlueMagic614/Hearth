import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app';
import { migrate, openDb } from './db';
import { seedHousehold, syncStarterPassword } from './seed';
import { bankFromEnv } from './bank';
import { syncConnection } from './sync';
import { classifierFromEnv, runAgent } from './agent';
import { householdToday } from './time';

const port = Number(process.env.PORT ?? 8787);
const db = await openDb();
const applied = await migrate(db).catch((e: { code?: string; message?: string }) => {
  if (e.code === '28P01') {
    console.error('Database rejected the username/password in DATABASE_URL. Re-link DATABASE_URL to the database (Render: Blueprint → Manual sync) instead of editing it by hand.');
  } else if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
    console.error('Could not reach the database at DATABASE_URL. Check that the database is running and the URL is the internal one.');
  }
  throw e;
});
if (applied.length) console.log('Applied migrations:', applied.join(', '));
const isProd = process.env.NODE_ENV === 'production';
const starterPassword = process.env.HEARTH_INITIAL_PASSWORD ?? process.env.HEARTH_DEV_PASSWORD ?? (isProd ? undefined : 'hearth-dev-password');
if (isProd && !starterPassword) console.warn('No HEARTH_INITIAL_PASSWORD set: seeded users will not be able to sign in.');
await seedHousehold(db, { devPassword: starterPassword });
const synced = await syncStarterPassword(db, starterPassword);
if (synced) console.log(`Starter password updated for ${synced} account(s) that haven't chosen their own yet.`);

const bank = bankFromEnv();
console.log(bank ? `Bank sync: Plaid ${bank.environment}` : 'Bank sync: off (no Plaid keys)');
const classifier = classifierFromEnv();
console.log(classifier ? 'Categorization agent: learned model + Claude for new payees' : 'Categorization agent: learned model (no ANTHROPIC_API_KEY, new payees go to review)');
const app = await buildApp(db, { webOrigin: process.env.WEB_ORIGIN, secureCookies: process.env.NODE_ENV === 'production', bank, classifier });

// In production the server also serves the built web app.
const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  // wildcard: files are looked up per request, so a fresh build is served without a restart.
  await app.register(fastifyStatic, { root: webDist, wildcard: true });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') || req.url.startsWith('/assets/') ? reply.status(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
  );
}

await app.listen({ port, host: '0.0.0.0' });
console.log(`Hearth server on http://localhost:${port}`);

// Plaid's webhook is the main signal; this catch-up sync covers any webhook that never arrived.
if (bank) {
  const catchUp = async () => {
    const conns = await db.query<{ id: string }>("SELECT id FROM bank_connections WHERE status <> 'login_required' AND (last_synced_at IS NULL OR last_synced_at < now() - interval '5 hours')");
    for (const c of conns) await syncConnection(db, bank, c.id, { classifier }).catch((e) => console.error('Catch-up sync failed:', (e as Error).message));
  };
  setInterval(() => void catchUp(), 60 * 60 * 1000).unref();
  setTimeout(() => void catchUp(), 30_000).unref();
}

// Sort existing history once at startup (also picks up anything new the agent can now handle).
setTimeout(async () => {
  for (const h of await db.query<{ id: string }>('SELECT id FROM households')) {
    const r = await runAgent(db, h.id, { classifier, today: householdToday() }).catch((e) => ({ error: (e as Error).message }));
    console.log('Agent run at startup:', JSON.stringify(r));
  }
}, 5_000).unref();

// Close the database cleanly so the local (PGlite) data files are always flushed.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
