import { migrate, openDb } from './db';
import { seedHousehold } from './seed';

const db = await openDb();
await migrate(db);
const id = await seedHousehold(db, { devPassword: process.env.HEARTH_DEV_PASSWORD ?? 'hearth-dev-password' });
console.log('Household ready:', id);
await db.close();
