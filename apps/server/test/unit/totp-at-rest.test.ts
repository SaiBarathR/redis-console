/** F-05: TOTP seeds are encrypted at rest (AES-256-GCM, HKDF-derived key, random IV, user id as AAD). */
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { UserStore } from '../../src/store/users.ts';
import { TotpKeyring } from '../../src/security/totpCipher.ts';
import { generateTotpSecret } from '../../src/security/totp.ts';
import { resolveConfig } from '../../src/config.ts';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

function store(key = KEY) {
  const db = openDb(':memory:');
  return { db, users: new UserStore(db, { totpKeyring: TotpKeyring.single(key) }) };
}
const newUser = (users: UserStore, username = 'alice') =>
  users.create({ username, displayName: username, role: 'admin', passwordHash: 'x', mustChangePassword: false });
const raw = (db: ReturnType<typeof openDb>, id: string) =>
  db.prepare('SELECT totp_secret, totp_pending_secret FROM users WHERE id = ?').get(id) as { totp_secret: string | null; totp_pending_secret: string | null };

describe('TotpKeyring (single key)', () => {
  const c = TotpKeyring.single(KEY);

  it('round-trips and uses a fresh IV per record', () => {
    const seed = generateTotpSecret();
    const a = c.encrypt(seed, 'local:1');
    const b = c.encrypt(seed, 'local:1');
    expect(a).not.toBe(b);
    expect(a).not.toContain(seed);
    expect(a.startsWith('v2:default:')).toBe(true);
    expect(c.decrypt(a, 'local:1')).toBe(seed);
    expect(c.decrypt(b, 'local:1')).toBe(seed);
  });

  it('binds the ciphertext to the user id (AAD)', () => {
    const e = c.encrypt('JBSWY3DPEHPK3PXP', 'local:1');
    expect(() => c.decrypt(e, 'local:2')).toThrow();
  });

  it('rejects tampering, another key and malformed values', () => {
    const e = c.encrypt('JBSWY3DPEHPK3PXP', 'local:1');
    const [v, kid, iv, ct, tag] = e.split(':') as [string, string, string, string, string];
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0]! ^= 1;
    expect(() => c.decrypt(`${v}:${kid}:${iv}:${flipped.toString('base64url')}:${tag}`, 'local:1')).toThrow();
    expect(() => TotpKeyring.single(OTHER_KEY).decrypt(e, 'local:1')).toThrow();
    expect(() => c.decrypt('JBSWY3DPEHPK3PXP', 'local:1')).toThrow();
    expect(() => c.decrypt('v1:abc', 'local:1')).toThrow();
  });

  it('refuses short keys', () => {
    expect(() => TotpKeyring.single('short')).toThrow(/32 characters/);
  });
});

describe('UserStore TOTP seeds at rest', () => {
  it('stores seeds encrypted and returns them decrypted', () => {
    const { db, users } = store();
    const u = newUser(users);
    const seed = generateTotpSecret();
    const pending = generateTotpSecret();
    users.update(u.id, { totpSecret: seed, totpPendingSecret: pending });
    const r = raw(db, u.id);
    expect(r.totp_secret).not.toContain(seed);
    expect(r.totp_pending_secret).not.toContain(pending);
    expect(TotpKeyring.isEncrypted(r.totp_secret!)).toBe(true);
    const got = users.byId(u.id)!;
    expect(got.totpSecret).toBe(seed);
    expect(got.totpPendingSecret).toBe(pending);
    users.update(u.id, { totpSecret: null, totpPendingSecret: null });
    expect(raw(db, u.id)).toEqual({ totp_secret: null, totp_pending_secret: null });
  });

  it('a seed copied onto another user row does not decrypt', () => {
    const { db, users } = store();
    const a = newUser(users, 'alice');
    const b = newUser(users, 'bob');
    users.update(a.id, { totpSecret: generateTotpSecret() });
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(raw(db, a.id).totp_secret, b.id);
    expect(() => users.byId(b.id)).toThrow();
    expect(() => users.migrateTotpSeeds()).toThrow(/1 local user\(s\) have a stored TOTP seed that no key/);
  });

  it('migrates legacy clear-text rows on startup, idempotently', () => {
    const db = openDb(':memory:');
    const legacy = new UserStore(db); // no cipher: as written by earlier versions
    const u = newUser(legacy);
    const seed = generateTotpSecret();
    const pending = generateTotpSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_pending_secret = ? WHERE id = ?').run(seed, pending, u.id);
    const genBefore = legacy.authGen(u.id);

    const users = new UserStore(db, { totpKeyring: TotpKeyring.single(KEY) });
    expect(() => users.byId(u.id)).toThrow(/clear-text/);
    expect(users.migrateTotpSeeds()).toEqual({ encrypted: 2, rewrapped: 0, users: 1 });
    const r = raw(db, u.id);
    expect(TotpKeyring.isEncrypted(r.totp_secret!)).toBe(true);
    expect(TotpKeyring.isEncrypted(r.totp_pending_secret!)).toBe(true);
    expect(users.byId(u.id)!.totpSecret).toBe(seed);
    expect(users.byId(u.id)!.totpPendingSecret).toBe(pending);
    // Migration does not log anyone out.
    expect(users.authGen(u.id)).toBe(genBefore);
    expect(users.migrateTotpSeeds()).toEqual({ encrypted: 0, rewrapped: 0, users: 1 });
    expect(raw(db, u.id)).toEqual(r);
  });

  it('refuses to start with a different key', () => {
    const { db, users } = store();
    users.update(newUser(users).id, { totpSecret: generateTotpSecret() });
    expect(() => new UserStore(db, { totpKeyring: TotpKeyring.single(OTHER_KEY) }).migrateTotpSeeds()).toThrow(/no key of the TOTP key ring can decrypt/);
  });

  it('cannot write a seed without a key', () => {
    const db = openDb(':memory:');
    const users = new UserStore(db);
    expect(() => users.update(newUser(users).id, { totpSecret: generateTotpSecret() })).toThrow(/totpEncryptionKey/);
  });
});

describe('config: auth.local.totpEncryptionKey', () => {
  const base = (local: Record<string, unknown>) => ({
    server: { publicUrl: 'http://localhost:4100', secureCookies: false },
    auth: { local: { enabled: true, ...local } },
    databases: [],
  });
  const env = { NODE_ENV: 'test', K: 'k'.repeat(64), SHORT: 'too-short' };

  it('is required when local accounts are enabled', () => {
    expect(() => resolveConfig(base({}), { env })).toThrow(/totpEncryptionKey \(or the key ring .*\) is required/);
  });
  it('must be a secret reference of at least 32 characters', () => {
    expect(() => resolveConfig(base({ totpEncryptionKey: 'inline-value-inline-value-inline-value' }), { env })).toThrow(/inline secret/);
    expect(() => resolveConfig(base({ totpEncryptionKey: { env: 'SHORT' } }), { env })).toThrow(/at least 32 characters/);
    const c = resolveConfig(base({ totpEncryptionKey: { env: 'K' } }), { env });
    expect(c.local?.totpKeyring?.primaryId).toBe('default');
    expect(c.local?.totpKeyring?.keys.map((k) => [k.id, k.secret.reveal()])).toEqual([['default', env.K]]);
    expect(JSON.stringify(c)).not.toContain(env.K);
  });
});
