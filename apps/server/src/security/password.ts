/** argon2id password hashing via node:crypto (Node >= 24.7). PHC string format. */
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

// OWASP 2024 baseline for argon2id: m=19 MiB, t=2, p=1.
export const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

export function argon2id(message: string, nonce: Buffer, p: typeof PARAMS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', { message, nonce, memory: p.memory, passes: p.passes, parallelism: p.parallelism, tagLength: p.tagLength }, (err, key) => {
      if (err) reject(err);
      else resolve(Buffer.from(key));
    });
  });
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const tag = await argon2id(password, salt, PARAMS);
  return `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$${b64(salt)}$${b64(tag)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const m = PHC.exec(phc);
  if (!m) return false;
  const [, mem, t, p, saltB64, tagB64] = m;
  const expected = Buffer.from(tagB64!, 'base64');
  const params = { memory: Number(mem), passes: Number(t), parallelism: Number(p), tagLength: expected.length };
  if (params.memory > 1 << 21 || params.passes > 20 || params.parallelism > 16 || expected.length < 16) return false;
  const actual = await argon2id(password, Buffer.from(saltB64!, 'base64'), params);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;
/** Burn the same CPU as a real verification so unknown usernames are not distinguishable by timing. */
export async function verifyDummy(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummy);
  return false;
}

export function needsRehash(phc: string): boolean {
  const m = PHC.exec(phc);
  return !m || Number(m[1]) < PARAMS.memory || Number(m[2]) < PARAMS.passes;
}
