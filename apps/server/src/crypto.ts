import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for secrets at rest (bank access tokens). The key comes from HEARTH_ENCRYPTION_KEY, which lives
 * only in the host's environment, never in the database or the repo. Output: "v1:<iv>:<tag>:<ciphertext>" (base64).
 */
function key(secret = process.env.HEARTH_ENCRYPTION_KEY): Buffer {
  if (!secret) {
    if (process.env.NODE_ENV === 'production') throw new Error('HEARTH_ENCRYPTION_KEY is not set');
    return createHash('sha256').update('hearth-development-only-key').digest();
  }
  return createHash('sha256').update(secret).digest();
}

export function encrypt(plain: string, secret?: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secret), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

export function decrypt(stored: string, secret?: string): string {
  const [v, iv, tag, body] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !body) throw new Error('Unrecognized encrypted value');
  const d = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
}
