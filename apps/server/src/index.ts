import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app';
import { migrate, openDb } from './db';
import { seedHousehold } from './seed';

const port = Number(process.env.PORT ?? 8787);
const db = await openDb();
const applied = await migrate(db);
if (applied.length) console.log('Applied migrations:', applied.join(', '));
await seedHousehold(db, { devPassword: process.env.HEARTH_DEV_PASSWORD ?? (process.env.NODE_ENV === 'production' ? undefined : 'hearth-dev-password') });

const app = await buildApp(db, { webOrigin: process.env.WEB_ORIGIN, secureCookies: process.env.NODE_ENV === 'production' });

// In production the server also serves the built web app.
const webDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.status(404).send({ error: 'Not found' }) : reply.sendFile('index.html')));
}

await app.listen({ port, host: '0.0.0.0' });
console.log(`Hearth server on http://localhost:${port}`);
