/**
 * Encryption at rest for TOTP seeds (finding F-05), with a key ring for rotation.
 *
 * AES-256-GCM. Each key of the ring derives its AES key by HKDF-SHA256 from its server secret. Every record gets a
 * fresh random 96-bit IV, and the owning user id is bound in as additional authenticated data, so a ciphertext
 * copied onto another user's row fails to decrypt.
 *
 * Stored formats:
 * - `v2:<key id>:<iv>:<ciphertext>:<tag>` (base64url parts): written by this version, always under the primary key.
 * - `v1:<iv>:<ciphertext>:<tag>`: written by earlier versions under the single `auth.local.totpEncryptionKey`. Read by
 *   trying every key of the ring (the GCM tag tells which one is right) and re-wrapped to v2 at startup.
 * - a base32 seed (what `generateTotpSecret()` has always produced): clear text from before F-05, encrypted at
 *   startup.
 * - anything else is malformed (corrupted or crafted): it is never taken for a seed, and startup refuses.
 *
 * The ring is modelled on Tink keysets and the ASP.NET Data Protection key ring: several keys may decrypt, one (the
 * primary) encrypts. Rotation: add a key, make it primary, restart (startup re-wraps every seed to the primary),
 * then remove the old key.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const V1 = 'v1:';
const V2 = 'v2:';
const HKDF_SALT = 'rconsole/totp-seed';
// Unchanged from v1: a key's AES key depends on its secret only, so a v1 record decrypts under the same secret.
const HKDF_INFO = 'rconsole totp-seed aes-256-gcm v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Key ids appear in stored values and in logs: short, no separators. */
export const KEY_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Id of the one-key ring built from the legacy single `auth.local.totpEncryptionKey`. */
export const IMPLICIT_KEY_ID = 'default';
export const MIN_SECRET_LENGTH = 32;

export interface RingKey {
  id: string;
  secret: string;
}

/** What a stored value is, read without any key. */
export type StoredSeedFormat = { format: 'plain' } | { format: 'v1' } | { format: 'v2'; keyId: string } | { format: 'malformed' };

/** A clear-text seed as versions before F-05 stored it: RFC 4648 base32, upper case (20 random bytes = 32 characters). */
const LEGACY_PLAIN_RE = /^[A-Z2-7]{16,128}=*$/;
/** One encrypted part (IV, ciphertext, tag): strict base64url, so lenient decoding never skips characters. */
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const encryptedParts = (parts: string[]) => parts.every((p) => B64URL_RE.test(p));

/**
 * Classifies a stored value without any key. Strict: a value that is not exactly v1, v2 (with a valid key id) or a
 * base32 clear-text seed is `malformed`, so a corrupted or crafted value is never taken for a seed and encrypted.
 */
export function storedSeedFormat(stored: string): StoredSeedFormat {
  if (stored.startsWith(V2)) {
    const parts = stored.slice(V2.length).split(':');
    return parts.length === 4 && KEY_ID_RE.test(parts[0]!) && encryptedParts(parts.slice(1)) ? { format: 'v2', keyId: parts[0]! } : { format: 'malformed' };
  }
  if (stored.startsWith(V1)) {
    const parts = stored.slice(V1.length).split(':');
    return parts.length === 3 && encryptedParts(parts) ? { format: 'v1' } : { format: 'malformed' };
  }
  return LEGACY_PLAIN_RE.test(stored) ? { format: 'plain' } : { format: 'malformed' };
}

function split(parts: string[]): [Buffer, Buffer, Buffer] {
  const [iv, ct, tag] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('malformed encrypted TOTP seed');
  return [iv, ct, tag];
}

function open(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, userId: string): string {
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  d.setAAD(Buffer.from(userId, 'utf8'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export class TotpKeyring {
  readonly #keys: Map<string, Buffer>;
  readonly primaryId: string;

  constructor(keys: readonly RingKey[], primaryId: string) {
    if (!keys.length) throw new Error('the TOTP key ring needs at least one key');
    const m = new Map<string, Buffer>();
    for (const k of keys) {
      if (!KEY_ID_RE.test(k.id)) throw new Error(`invalid TOTP key id "${k.id}" (1-64 of A-Z a-z 0-9 . _ -)`);
      if (m.has(k.id)) throw new Error(`duplicate TOTP key id "${k.id}"`);
      if (k.secret.length < MIN_SECRET_LENGTH) throw new Error(`TOTP key "${k.id}": the secret must be at least ${MIN_SECRET_LENGTH} characters`);
      m.set(k.id, Buffer.from(hkdfSync('sha256', Buffer.from(k.secret, 'utf8'), HKDF_SALT, HKDF_INFO, 32)));
    }
    if (!m.has(primaryId)) throw new Error(`the primary TOTP key "${primaryId}" is not in the key ring`);
    this.#keys = m;
    this.primaryId = primaryId;
  }

  /** The one-key ring of the legacy single-key configuration. */
  static single(secret: string): TotpKeyring {
    return new TotpKeyring([{ id: IMPLICIT_KEY_ID, secret }], IMPLICIT_KEY_ID);
  }

  /** True when the stored value is in an encrypted format (as opposed to a legacy clear-text seed). */
  static isEncrypted(stored: string): boolean {
    return stored.startsWith(V1) || stored.startsWith(V2);
  }

  get keyIds(): string[] {
    return [...this.#keys.keys()];
  }

  /** Encrypt under the primary key (format v2). */
  encrypt(plain: string, userId: string): string {
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv('aes-256-gcm', this.#keys.get(this.primaryId)!, iv, { authTagLength: TAG_BYTES });
    c.setAAD(Buffer.from(userId, 'utf8'));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `${V2}${this.primaryId}:${iv.toString('base64url')}:${ct.toString('base64url')}:${c.getAuthTag().toString('base64url')}`;
  }

  /**
   * Decrypt a v1 or v2 value. Throws when it was tampered with, belongs to another user, names a key that is not in
   * the ring, or no key of the ring opens it.
   */
  decrypt(stored: string, userId: string): string {
    const f = storedSeedFormat(stored);
    if (f.format === 'v2') {
      const key = this.#keys.get(f.keyId);
      if (!key) throw new Error(`TOTP seed is encrypted with key "${f.keyId}", which is not in the key ring`);
      return open(key, ...split(stored.slice(V2.length).split(':').slice(1)), userId);
    }
    if (f.format === 'v1') {
      const parts = split(stored.slice(V1.length).split(':'));
      for (const key of this.#keys.values()) {
        try {
          return open(key, ...parts, userId);
        } catch {
          /* try the next key */
        }
      }
      throw new Error('no key of the TOTP key ring decrypts this v1 seed');
    }
    if (f.format === 'malformed') throw new Error('malformed encrypted TOTP seed');
    throw new Error('TOTP seed is not in the encrypted format');
  }

  /** Whether a stored value must be rewritten to be v2 under the primary key. */
  needsRewrap(stored: string): boolean {
    const f = storedSeedFormat(stored);
    return !(f.format === 'v2' && f.keyId === this.primaryId);
  }
}

/** The ring of a resolved config (`AppConfig.local.totpKeyring`), or undefined without one. */
export function keyringFromConfig(r: { keys: { id: string; secret: { reveal(): string } }[]; primaryId: string } | undefined): TotpKeyring | undefined {
  return r ? new TotpKeyring(r.keys.map((k) => ({ id: k.id, secret: k.secret.reveal() })), r.primaryId) : undefined;
}
