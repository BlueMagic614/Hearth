import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app';
import { migrate, openDb } from './db';
import { seedHousehold, syncStarterPassword } from './seed';

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

const app = await buildApp(db, { webOrigin: process.env.WEB_ORIGIN, secureCookies: process.env.NODE_ENV === 'production' });

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

// Close the database cleanly so the local (PGlite) data files are always flushed.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    await app.close();
    await db.close();
    process.exit(0);
  });
}
