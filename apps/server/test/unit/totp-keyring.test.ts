/**
 * TOTP seed key ring: config validation, v1 -> v2 migration, rotation (add, make primary, restart, remove), refusal
 * to start when a seed's key is unknown or was removed, and the user id as AAD.
 */
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/store/db.ts';
import { TotpKeyError, UserStore } from '../../src/store/users.ts';
import { TotpKeyring } from '../../src/security/totpCipher.ts';
import { generateTotpSecret } from '../../src/security/totp.ts';
import { resolveConfig } from '../../src/config.ts';
import { buildApp } from '../../src/app.ts';
import { testConfig } from '../helpers.ts';

const K_OLD = 'o'.repeat(40);
const K_NEW = 'n'.repeat(40);
const K_OTHER = 'x'.repeat(40);

/** A v1 value exactly as the previous version wrote it (single key, no key id). */
function v1Encrypt(secret: string, plain: string, userId: string): string {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret), 'rconsole/totp-seed', 'rconsole totp-seed aes-256-gcm v1', 32));
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(userId));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64url')}:${ct.toString('base64url')}:${c.getAuthTag().toString('base64url')}`;
}

const ring = (keys: Record<string, string>, primary: string) => new TotpKeyring(Object.entries(keys).map(([id, secret]) => ({ id, secret })), primary);
const newUser = (users: UserStore, username: string) => users.create({ username, displayName: username, role: 'admin', passwordHash: 'x', mustChangePassword: false });
const rawSeed = (db: Db, id: string) => (db.prepare('SELECT totp_secret AS s, totp_pending_secret AS p FROM users WHERE id = ?').get(id) as { s: string | null; p: string | null });
const kidOf = (v: string | null) => v?.split(':').slice(0, 2).join(':');

describe('TotpKeyring', () => {
  it('encrypts under the primary key with its id in the value, and decrypts under any key of the ring', () => {
    const r1 = ring({ old: K_OLD }, 'old');
    const v = r1.encrypt('JBSWY3DPEHPK3PXP', 'local:1');
    expect(v.startsWith('v2:old:')).toBe(true);
    const r2 = ring({ old: K_OLD, new: K_NEW }, 'new');
    expect(r2.decrypt(v, 'local:1')).toBe('JBSWY3DPEHPK3PXP');
    expect(r2.needsRewrap(v)).toBe(true);
    const w = r2.encrypt('JBSWY3DPEHPK3PXP', 'local:1');
    expect(w.startsWith('v2:new:')).toBe(true);
    expect(r2.needsRewrap(w)).toBe(false);
    expect(() => r1.decrypt(w, 'local:1')).toThrow(/key "new", which is not in the key ring/);
  });

  it('binds the value to the user id (AAD) for v1 and v2', () => {
    const r = ring({ old: K_OLD, new: K_NEW }, 'new');
    expect(() => r.decrypt(r.encrypt('JBSWY3DPEHPK3PXP', 'local:1'), 'local:2')).toThrow();
    const v1 = v1Encrypt(K_OLD, 'JBSWY3DPEHPK3PXP', 'local:1');
    expect(r.decrypt(v1, 'local:1')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => r.decrypt(v1, 'local:2')).toThrow(/no key of the TOTP key ring/);
  });

  it('cannot be relabelled: a value moved to another key id does not decrypt', () => {
    const r = ring({ a: K_OLD, b: K_NEW }, 'a');
    const v = r.encrypt('JBSWY3DPEHPK3PXP', 'local:1');
    expect(() => r.decrypt(v.replace('v2:a:', 'v2:b:'), 'local:1')).toThrow();
  });

  it('validates the ring', () => {
    expect(() => ring({ a: K_OLD }, 'b')).toThrow(/primary TOTP key "b" is not in the key ring/);
    expect(() => new TotpKeyring([{ id: 'a', secret: K_OLD }, { id: 'a', secret: K_NEW }], 'a')).toThrow(/duplicate/);
    expect(() => ring({ a: 'short' }, 'a')).toThrow(/at least 32 characters/);
    expect(() => ring({ 'a:b': K_OLD }, 'a:b')).toThrow(/invalid TOTP key id/);
    expect(() => new TotpKeyring([], 'a')).toThrow(/at least one key/);
  });
});

describe('config: auth.local.totpEncryptionKeys + totpPrimaryKeyId', () => {
  const env = { NODE_ENV: 'test', OLD: K_OLD, NEW: K_NEW, SHORT: 'too-short', SAME: K_OLD };
  const cfg = (local: Record<string, unknown>) =>
    resolveConfig({ server: { publicUrl: 'http://localhost:4100', secureCookies: false }, auth: { local: { enabled: true, ...local } }, databases: [] }, { env });
  const keys = (...ks: [string, string][]) => ks.map(([id, e]) => ({ id, secret: { env: e } }));

  it('resolves a ring; the secrets never appear in the serialized config', () => {
    const c = cfg({ totpEncryptionKeys: keys(['2025-01', 'OLD'], ['2026-10', 'NEW']), totpPrimaryKeyId: '2026-10' });
    expect(c.local?.totpKeyring?.primaryId).toBe('2026-10');
    expect(c.local?.totpKeyring?.keys.map((k) => k.id)).toEqual(['2025-01', '2026-10']);
    const json = JSON.stringify(c);
    expect(json).not.toContain(K_OLD);
    expect(json).not.toContain(K_NEW);
  });

  it('the single key is a one-key ring with the id "default"', () => {
    const c = cfg({ totpEncryptionKey: { env: 'OLD' } });
    expect(c.local?.totpKeyring).toMatchObject({ primaryId: 'default', keys: [{ id: 'default' }] });
  });

  it('refuses duplicate ids, a missing or unknown primary, both forms, short or shared secrets, bad ids', () => {
    expect(() => cfg({ totpEncryptionKeys: keys(['a', 'OLD'], ['a', 'NEW']), totpPrimaryKeyId: 'a' })).toThrow(/duplicate key id "a"/);
    expect(() => cfg({ totpEncryptionKeys: keys(['a', 'OLD']) })).toThrow(/totpPrimaryKeyId is required/);
    expect(() => cfg({ totpEncryptionKeys: keys(['a', 'OLD']), totpPrimaryKeyId: 'b' })).toThrow(/totpPrimaryKeyId "b" is not one of the totpEncryptionKeys ids \(a\)/);
    expect(() => cfg({ totpEncryptionKey: { env: 'OLD' }, totpEncryptionKeys: keys(['a', 'NEW']), totpPrimaryKeyId: 'a' })).toThrow(/either totpEncryptionKey .* or totpEncryptionKeys/);
    expect(() => cfg({ totpEncryptionKey: { env: 'OLD' }, totpPrimaryKeyId: 'default' })).toThrow(/totpPrimaryKeyId needs totpEncryptionKeys/);
    expect(() => cfg({ totpEncryptionKeys: keys(['a', 'OLD'], ['b', 'SHORT']), totpPrimaryKeyId: 'a' })).toThrow(/totpEncryptionKeys\[1\] \(id "b"\) must be at least 32 characters/);
    expect(() => cfg({ totpEncryptionKeys: keys(['a', 'OLD'], ['b', 'SAME']), totpPrimaryKeyId: 'b' })).toThrow(/same secret as key "a"/);
    expect(() => cfg({ totpEncryptionKeys: [{ id: 'a b', secret: { env: 'OLD' } }], totpPrimaryKeyId: 'a b' })).toThrow(/key ids are 1-64/);
    expect(() => cfg({ totpEncryptionKeys: [{ id: 'a', secret: 'inline-inline-inline-inline-inline-inline' }], totpPrimaryKeyId: 'a' })).toThrow(/inline secret/);
    expect(() => cfg({})).toThrow(/totpEncryptionKey \(or the key ring auth.local.totpEncryptionKeys \+ totpPrimaryKeyId\) is required/);
  });
});

describe('UserStore: startup migration with a key ring', () => {
  it('re-wraps v1 values (written under the single key) to v2 under the primary, keeping the seeds and sessions', () => {
    const db = openDb(':memory:');
    const legacy = new UserStore(db);
    const u = newUser(legacy, 'alice');
    const seed = generateTotpSecret();
    const pending = generateTotpSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_pending_secret = ? WHERE id = ?').run(v1Encrypt(K_OLD, seed, u.id), v1Encrypt(K_OLD, pending, u.id), u.id);
    const gen = legacy.authGen(u.id);

    const users = new UserStore(db, { totpKeyring: TotpKeyring.single(K_OLD) });
    expect(users.byId(u.id)!.totpSecret).toBe(seed); // v1 stays readable
    expect(users.migrateTotpSeeds()).toEqual({ encrypted: 0, rewrapped: 2, users: 1 });
    expect(kidOf(rawSeed(db, u.id).s)).toBe('v2:default');
    expect(kidOf(rawSeed(db, u.id).p)).toBe('v2:default');
    expect(users.byId(u.id)).toMatchObject({ totpSecret: seed, totpPendingSecret: pending });
    expect(users.authGen(u.id)).toBe(gen);
    expect(users.migrateTotpSeeds()).toEqual({ encrypted: 0, rewrapped: 0, users: 1 });
  });

  it('rotation: add a key, make it primary, restart re-wraps, then the old key can be removed', () => {
    const db = openDb(':memory:');
    const before = new UserStore(db, { totpKeyring: ring({ old: K_OLD }, 'old') });
    const seeds = new Map<string, string>();
    for (const name of ['a1', 'a2', 'a3']) {
      const u = newUser(before, name);
      const seed = generateTotpSecret();
      before.update(u.id, { totpSecret: seed });
      seeds.set(u.id, seed);
    }
    // 1-2. add "new" and make it primary; 3. restart (migration).
    const during = new UserStore(db, { totpKeyring: ring({ old: K_OLD, new: K_NEW }, 'new') });
    expect(during.migrateTotpSeeds()).toEqual({ encrypted: 0, rewrapped: 3, users: 3 });
    for (const id of seeds.keys()) expect(kidOf(rawSeed(db, id).s)).toBe('v2:new');
    // 4. remove "old": the server starts and every seed still works.
    const after = new UserStore(db, { totpKeyring: ring({ new: K_NEW }, 'new') });
    expect(after.migrateTotpSeeds()).toEqual({ encrypted: 0, rewrapped: 0, users: 3 });
    for (const [id, seed] of seeds) expect(after.byId(id)!.totpSecret).toBe(seed);
  });

  it('removing a key that is still in use refuses to start, names how many users, and changes nothing', () => {
    const db = openDb(':memory:');
    const before = new UserStore(db, { totpKeyring: ring({ old: K_OLD }, 'old') });
    const a = newUser(before, 'alice');
    const b = newUser(before, 'bob');
    const c = newUser(before, 'carol');
    const seedA = generateTotpSecret();
    before.update(a.id, { totpSecret: seedA, totpPendingSecret: generateTotpSecret() });
    before.update(b.id, { totpSecret: generateTotpSecret() });
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(generateTotpSecret(), c.id); // legacy clear text
    const snapshot = [a, b, c].map((u) => rawSeed(db, u.id));

    const removed = new UserStore(db, { totpKeyring: ring({ new: K_NEW }, 'new') });
    let err: unknown;
    try {
      removed.migrateTotpSeeds();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TotpKeyError);
    const e = err as TotpKeyError;
    expect(e.affectedUsers).toBe(2);
    expect(e.missingKeyIds).toEqual(['old']);
    expect(e.message).toMatch(/^2 local user\(s\) have a stored TOTP seed that no key of the TOTP key ring can decrypt \(their seeds name key id\(s\) that are not in the ring: old\)/);
    expect(e.message).toContain('pnpm --filter @rconsole/server admin reset-totp --user <name>');
    expect(e.message).toContain('pnpm --filter @rconsole/server admin status');
    // The commands also work where there is no pnpm (the container image runs `node apps/server/src/main.ts`).
    expect(e.message).toContain('node apps/server/src/cli/admin.ts status');
    expect(e.message).toContain('node apps/server/src/cli/admin.ts reset-totp --user <name>');
    expect(e.message).toContain('reset-totp --all --yes');
    // Counts and key ids only: no user names, user ids, seeds or ciphertext.
    for (const s of ['alice', 'bob', 'carol', a.id, b.id, c.id, seedA, ...snapshot.flatMap((x) => [x.s, x.p]).filter((x): x is string => !!x)]) {
      expect(e.message).not.toContain(s);
    }
    // All or nothing: not even the clear-text row was encrypted.
    expect([a, b, c].map((u) => rawSeed(db, u.id))).toEqual(snapshot);

    // An unknown key (a different secret under the same id) is refused the same way.
    expect(() => new UserStore(db, { totpKeyring: ring({ old: K_OTHER }, 'old') }).migrateTotpSeeds()).toThrow(TotpKeyError);
  });

  it('a corrupted or crafted value is never taken for a clear-text seed: startup refuses and changes nothing', () => {
    const db = openDb(':memory:');
    const users = new UserStore(db, { totpKeyring: ring({ k: K_NEW }, 'k') });
    const a = newUser(users, 'alice');
    const valid = ring({ k: K_NEW }, 'k').encrypt('JBSWY3DPEHPK3PXP', a.id);
    const [, , iv, ct, tag] = valid.split(':');
    const crafted = [
      'V2:k:AAAA:BBBB:CCCC', // wrong case: before, any value without the exact v1:/v2: prefix was "clear text"
      'v3:k:AAAA:BBBB:CCCC',
      'v2',
      '',
      'attacker-chosen seed', // not base32
      'JBSWY3DP EHPK3PXP',
      'jbswy3dpehpk3pxp', // lower case: generateTotpSecret() never wrote that
      `v2:k:${iv}:${ct}:${tag}:extra`,
      `v2::${iv}:${ct}:${tag}`, // empty key id
      `v2:${'k'.repeat(65)}:${iv}:${ct}:${tag}`, // key id too long
      `v2:k/../x:${iv}:${ct}:${tag}`, // key id with a separator
      `v2:k:${iv}!:${ct}:${tag}`, // not base64url (Buffer.from would skip the "!")
      `v1:${iv}:${ct}`, // v1 with a missing part
    ];
    for (const value of crafted) {
      db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(value, a.id);
      let err: unknown;
      try {
        users.migrateTotpSeeds();
      } catch (e) {
        err = e;
      }
      expect(err, value).toBeInstanceOf(TotpKeyError);
      expect((err as TotpKeyError).affectedUsers).toBe(1);
      expect(rawSeed(db, a.id).s, value).toBe(value);
    }
    // A real legacy clear-text seed (upper-case base32) is still encrypted, and the strict v2 value still decrypts.
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run('JBSWY3DPEHPK3PXP', a.id);
    expect(users.migrateTotpSeeds()).toEqual({ encrypted: 1, rewrapped: 0, users: 1 });
    expect(users.byId(a.id)!.totpSecret).toBe('JBSWY3DPEHPK3PXP');
  });

  it('a seed copied onto another user row (wrong AAD) refuses to start, even under the primary key', () => {
    const db = openDb(':memory:');
    const users = new UserStore(db, { totpKeyring: ring({ k: K_NEW }, 'k') });
    const a = newUser(users, 'alice');
    const b = newUser(users, 'bob');
    users.update(a.id, { totpSecret: generateTotpSecret() });
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(rawSeed(db, a.id).s, b.id);
    expect(() => users.byId(b.id)).toThrow();
    expect(() => users.migrateTotpSeeds()).toThrow(/^1 local user\(s\) have a stored TOTP seed/);
  });
});

describe('buildApp: rotation by restart, refusal to start', () => {
  const localWith = (local: Record<string, unknown>) => testConfig({ local: { totpEncryptionKey: undefined, ...local } });
  it('a restart with a new primary re-wraps every seed and audits the counts; removing a key in use refuses to start', async () => {
    process.env.RC_TEST_K_OLD = K_OLD;
    process.env.RC_TEST_K_NEW = K_NEW;
    const dir = mkdtempSync(path.join(tmpdir(), 'rconsole-ring-'));
    const k = (id: string, env: string) => ({ id, secret: { env } });
    const one = localWith({ totpEncryptionKeys: [k('old', 'RC_TEST_K_OLD')], totpPrimaryKeyId: 'old' });

    const first = await buildApp(one, { logger: false, dbPath: dir, auditWrite: () => {} });
    const u = first.ctx.users.create({ username: 'alice', displayName: 'alice', role: 'admin', passwordHash: 'x', mustChangePassword: false });
    const seed = generateTotpSecret();
    first.ctx.users.update(u.id, { totpSecret: seed });
    expect(JSON.parse(readFileSync(path.join(dir, 'server.lock'), 'utf8')).pid).toBe(process.pid);
    await first.app.close();

    const lines: string[] = [];
    const two = localWith({ totpEncryptionKeys: [k('old', 'RC_TEST_K_OLD'), k('new', 'RC_TEST_K_NEW')], totpPrimaryKeyId: 'new' });
    const second = await buildApp(two, { logger: false, dbPath: dir, auditWrite: (l) => lines.push(l) });
    expect(second.ctx.users.byId(u.id)!.totpSecret).toBe(seed);
    const ev = lines.map((l) => JSON.parse(l)).find((e) => e.action === 'system.totp.rewrap');
    expect(ev).toMatchObject({ outcome: 'allowed', detail: 'encrypted=0 rewrapped=1 primary=new' });
    expect(lines.join('\n')).not.toContain(seed);
    await second.app.close();

    // Now the old key is unused and can go.
    const three = localWith({ totpEncryptionKeys: [k('new', 'RC_TEST_K_NEW')], totpPrimaryKeyId: 'new' });
    const third = await buildApp(three, { logger: false, dbPath: dir, auditWrite: () => {} });
    expect(third.ctx.users.byId(u.id)!.totpSecret).toBe(seed);
    await third.app.close();

    // Going back to only the old key (the new one removed while in use) refuses to start.
    await expect(buildApp(one, { logger: false, dbPath: dir, auditWrite: () => {} })).rejects.toThrow(TotpKeyError);
  });
});
