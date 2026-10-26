/**
 * TOTP recovery codes: single-use codes that stand in for an authenticator code at sign-in (as with Google,
 * Microsoft and GitHub).
 *
 * - 10 codes per set, shown once (at TOTP enrollment, or when the user regenerates the set).
 * - Each code is 12 characters of Crockford base32 (60 random bits), shown as `xxxx-xxxx-xxxx`. Input is
 *   case-insensitive, ignores spaces and hyphens, and reads o as 0 and i/l as 1.
 * - Stored only as argon2id hashes. All codes of one set share a random salt, so checking an entered code costs one
 *   argon2id computation (the same work as a password check), whose result the store compares in constant time with
 *   the user's unused hashes (UserStore.consumeRecoveryCode); a copy of the database
 *   still needs an argon2id computation per guess per user.
 */
import { randomBytes } from 'node:crypto';
import { RECOVERY_CODE_COUNT } from '@rconsole/shared';
import { argon2id, PARAMS } from './password.ts';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const CODE_CHARS = 12;
const PARAMS_TAG = `a2id:m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}`;

export function generateRecoveryCode(): string {
  const bytes = randomBytes(CODE_CHARS);
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** The canonical form of an entered code, or null when it cannot be a recovery code. */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toLowerCase().replace(/[\s-]+/g, '').replace(/o/g, '0').replace(/[il]/g, '1');
  if (s.length !== CODE_CHARS) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

export interface RecoveryCodeSet {
  /** Shown to the user once. */
  codes: string[];
  salt: string;
  hashes: string[];
}

export async function hashRecoveryCode(normalized: string, salt: string): Promise<string> {
  return `${PARAMS_TAG}$${(await argon2id(normalized, Buffer.from(salt, 'base64'), PARAMS)).toString('base64')}`;
}

/** A fresh set of codes and their hashes. Hashes are computed one after the other (bounded memory). */
export async function newRecoveryCodeSet(count = RECOVERY_CODE_COUNT): Promise<RecoveryCodeSet> {
  const salt = randomBytes(16).toString('base64');
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateRecoveryCode());
  const hashes: string[] = [];
  for (const c of codes) hashes.push(await hashRecoveryCode(normalizeRecoveryCode(c)!, salt));
  return { codes: [...codes], salt, hashes };
}
