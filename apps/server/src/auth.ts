import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const SESSION_DAYS = 30;

/** scrypt with a random 16-byte salt, stored as "scrypt$<salt-hex>$<hash-hex>". */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export interface SessionUser {
  id: string;
  name: string;
  householdId: string;
  mustChangePassword: boolean;
}

export async function createSession(db: Db, userId: string): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [id, userId]);
  return id;
}

export async function userForSession(db: Db, sessionId: string | undefined): Promise<SessionUser | null> {
  if (!sessionId) return null;
  const rows = await db.query<{ id: string; name: string; household_id: string; must_change_password: boolean }>(
    'SELECT u.id, u.name, u.household_id, u.must_change_password FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now()',
    [sessionId],
  );
  const r = rows[0];
  return r ? { id: r.id, name: r.name, householdId: r.household_id, mustChangePassword: r.must_change_password } : null;
}

export const newId = () => randomUUID();
