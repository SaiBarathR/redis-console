/**
 * Break-glass admin CLI (src/cli/admin.ts): reset one user / all users (seed, pending seed and recovery codes
 * cleared, auth generation bumped, sessions revoked, audited), rotate the key (re-wrap, counts), status (no secrets),
 * and the server lock.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { EXIT, runAdmin } from '../../src/cli/admin.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { UserStore } from '../../src/store/users.ts';
import { SessionStore } from '../../src/store/sessions.ts';
import { TotpKeyring } from '../../src/security/totpCipher.ts';
import { generateTotpSecret } from '../../src/security/totp.ts';
import { newRecoveryCodeSet } from '../../src/security/recoveryCodes.ts';
import { LOCK_FILE } from '../../src/store/lock.ts';

const K1 = 'one-'.repeat(10);
const K2 = 'two-'.repeat(10);
const SERVER_DIR = path.resolve(import.meta.dirname, '../..');

function run(args: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runAdmin(args, { env: { ...env }, cwd: '/', out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join(''), err: err.join('') };
}

interface Fixture {
  dir: string;
  db: Db;
  users: UserStore;
  sessions: SessionStore;
  seeds: Map<string, string>;
  codes: Map<string, string[]>;
  configFile: (keys: [string, string][], primary: string) => string;
}

async function fixture(): Promise<Fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), 'rconsole-cli-'));
  const db = openDb(dir);
  const users = new UserStore(db, { totpKeyring: new TotpKeyring([{ id: 'k1', secret: K1 }], 'k1') });
  const sessions = new SessionStore(db, { ttlMs: 3600_000, idleMs: 3600_000 });
  const seeds = new Map<string, string>();
  const codes = new Map<string, string[]>();
  for (const name of ['alice', 'bob', 'carol']) {
    const u = users.create({ username: name, displayName: name, role: 'admin', passwordHash: 'x', mustChangePassword: false });
    if (name !== 'carol') {
      const seed = generateTotpSecret();
      users.update(u.id, { totpSecret: seed });
      seeds.set(name, seed);
      const set = await newRecoveryCodeSet(4);
      users.replaceRecoveryCodes(u.id, set);
      codes.set(name, set.codes);
    } else {
      users.update(u.id, { totpPendingSecret: generateTotpSecret() });
    }
    const v = users.byId(u.id)!;
    sessions.create({ userId: v.id, username: name, displayName: name, source: 'local', role: 'admin', state: 'active', ip: '127.0.0.1', authGen: v.authGen });
  }
  const configFile = (keys: [string, string][], primary: string) => {
    const f = path.join(dir, 'config.json');
    writeFileSync(f, JSON.stringify({
      server: { publicUrl: 'http://localhost:4600', secureCookies: false, dataDir: dir },
      auth: { local: { enabled: true, totpEncryptionKeys: keys.map(([id, env]) => ({ id, secret: { env } })), totpPrimaryKeyId: primary } },
      databases: [],
    }));
    return f;
  };
  return { dir, db, users, sessions, seeds, codes, configFile };
}

const row = (db: Db, name: string) =>
  db.prepare('SELECT id, totp_secret, totp_pending_secret, auth_gen FROM users WHERE username = ?').get(name) as { id: string; totp_secret: string | null; totp_pending_secret: string | null; auth_gen: number };
const sessionCount = (db: Db, id: string) => (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(id) as { n: number }).n;
const codeCount = (db: Db, id: string) => (db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?').get(id) as { n: number }).n;
const auditRows = (db: Db, action: string) => db.prepare('SELECT * FROM audit WHERE action = ? ORDER BY id').all(action) as Record<string, unknown>[];

describe('admin CLI', () => {
  it('reset-totp --user clears seed, pending seed and recovery codes, bumps the generation, revokes sessions, audits', async () => {
    const f = await fixture();
    const before = row(f.db, 'alice');
    const r = run(['reset-totp', '--user', 'ALICE', '--data-dir', f.dir]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('Reset TOTP for 1 user(s): alice. 1 session(s) revoked.');
    const after = row(f.db, 'alice');
    expect(after).toMatchObject({ totp_secret: null, totp_pending_secret: null, auth_gen: before.auth_gen + 1 });
    expect(sessionCount(f.db, after.id)).toBe(0);
    expect(codeCount(f.db, after.id)).toBe(0);
    // Others untouched.
    expect(row(f.db, 'bob').totp_secret).not.toBeNull();
    expect(sessionCount(f.db, row(f.db, 'bob').id)).toBe(1);
    const ev = auditRows(f.db, 'admin.cli.reset-totp');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ user_id: 'cli', outcome: 'allowed' });
    expect(String(ev[0]!.username)).toMatch(/^cli:/);
    expect(ev[0]!.detail).toBe('user=alice; seed, pending enrollment and recovery codes cleared; sessions revoked');
    // The audit JSON line goes to stderr, never a secret.
    expect(r.err).toContain('"action":"admin.cli.reset-totp"');
    expect(r.out + r.err).not.toContain(f.seeds.get('alice')!);
  });

  it('reset-totp works without any key (keys lost) and refuses unknown users', async () => {
    const f = await fixture();
    expect(run(['reset-totp', '--user', 'nobody', '--data-dir', f.dir])).toMatchObject({ code: EXIT.failed, err: expect.stringContaining('no local user named "nobody"') });
    expect(run(['reset-totp', '--user', 'bob', '--data-dir', f.dir]).code).toBe(EXIT.ok);
  });

  it('reset-totp --all needs --yes, then resets every local user with TOTP state', async () => {
    const f = await fixture();
    const dry = run(['reset-totp', '--all', '--data-dir', f.dir]);
    expect(dry.code).toBe(EXIT.usage);
    expect(dry.out).toContain('for 3 local user(s)');
    expect(dry.out).toContain('Run again with --yes');
    expect(row(f.db, 'alice').totp_secret).not.toBeNull();
    const r = run(['reset-totp', '--all', '--yes', '--data-dir', f.dir]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('Reset TOTP for 3 user(s): alice, bob, carol. 3 session(s) revoked.');
    for (const n of ['alice', 'bob', 'carol']) {
      const x = row(f.db, n);
      expect(x).toMatchObject({ totp_secret: null, totp_pending_secret: null });
      expect(sessionCount(f.db, x.id)).toBe(0);
      expect(codeCount(f.db, x.id)).toBe(0);
    }
    expect(auditRows(f.db, 'admin.cli.reset-totp').map((e) => e.detail)).toEqual([
      'user=alice (--all); seed, pending enrollment and recovery codes cleared; sessions revoked',
      'user=bob (--all); seed, pending enrollment and recovery codes cleared; sessions revoked',
      'user=carol (--all); seed, pending enrollment and recovery codes cleared; sessions revoked',
    ]);
  });

  it('rotate-totp-key re-wraps every seed to the primary and reports counts; nobody is signed out', async () => {
    const f = await fixture();
    const env = { K1, K2 };
    const gens = ['alice', 'bob', 'carol'].map((n) => row(f.db, n).auth_gen);
    const r = run(['rotate-totp-key', '--config', f.configFile([['k1', 'K1'], ['k2', 'K2']], 'k2')], env);
    expect(r.err).not.toMatch(/refus/);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('Primary key: k2. Re-wrapped 3 seed(s), encrypted 0 legacy clear-text seed(s); every stored seed of 3 user(s) is now under "k2".');
    for (const n of ['alice', 'bob']) expect(row(f.db, n).totp_secret!.startsWith('v2:k2:')).toBe(true);
    expect(row(f.db, 'carol').totp_pending_secret!.startsWith('v2:k2:')).toBe(true);
    expect(['alice', 'bob', 'carol'].map((n) => row(f.db, n).auth_gen)).toEqual(gens);
    const now = new UserStore(f.db, { totpKeyring: new TotpKeyring([{ id: 'k2', secret: K2 }], 'k2') });
    expect(now.byUsername('alice')!.totpSecret).toBe(f.seeds.get('alice'));
    expect(auditRows(f.db, 'admin.cli.rotate-totp-key')[0]).toMatchObject({ outcome: 'allowed', detail: 'encrypted=0 rewrapped=3 users=3 primary=k2' });
    expect(r.out + r.err).not.toContain(K2);
    // Idempotent.
    expect(run(['rotate-totp-key', '--config', f.configFile([['k2', 'K2']], 'k2')], env).out).toContain('Re-wrapped 0 seed(s)');
  });

  it('rotate-totp-key with a key missing from the ring fails, names the count and the commands, changes nothing', async () => {
    const f = await fixture();
    const before = row(f.db, 'alice').totp_secret;
    const r = run(['rotate-totp-key', '--config', f.configFile([['k2', 'K2']], 'k2')], { K2 });
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toContain('3 local user(s) have a stored TOTP seed that no key of the TOTP key ring can decrypt (their seeds name key id(s) that are not in the ring: k1)');
    expect(r.err).toContain('admin reset-totp --user <name>');
    expect(row(f.db, 'alice').totp_secret).toBe(before);
    expect(auditRows(f.db, 'admin.cli.rotate-totp-key')[0]).toMatchObject({ outcome: 'error' });
  });

  it('rotate-totp-key needs a config and refuses while a server holds the data directory', async () => {
    const f = await fixture();
    expect(run(['rotate-totp-key', '--data-dir', f.dir]).code).toBe(EXIT.usage);
    const cfg = f.configFile([['k1', 'K1'], ['k2', 'K2']], 'k2');
    // A live process on this host (not this one: a lock naming the process that takes it is a restarted
    // container's leftover) holds the lock.
    const server = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    onTestFinished(() => { server.kill(); });
    writeFileSync(path.join(f.dir, LOCK_FILE), JSON.stringify({ pid: server.pid, host: hostname(), startedAt: new Date().toISOString() }));
    const r = run(['rotate-totp-key', '--config', cfg], { K1, K2 });
    expect(r.code).toBe(EXIT.running);
    expect(r.err).toContain(`a server is running on it (pid ${server.pid}`);
    expect(run(['rotate-totp-key', '--config', cfg, '--force'], { K1, K2 }).code).toBe(EXIT.running);
    expect(row(f.db, 'alice').totp_secret!.startsWith('v2:k1:')).toBe(true);
    // reset-totp and status are safe next to a running server (WAL, short transactions) and say so.
    const reset = run(['reset-totp', '--user', 'alice', '--data-dir', f.dir]);
    expect(reset.code).toBe(EXIT.ok);
    expect(reset.err).toContain('That is safe');
    // A lock from another host cannot be checked: refused unless --force.
    writeFileSync(path.join(f.dir, LOCK_FILE), JSON.stringify({ pid: 1, host: 'elsewhere.example', startedAt: new Date().toISOString() }));
    expect(run(['rotate-totp-key', '--config', cfg], { K1, K2 }).code).toBe(EXIT.running);
    expect(run(['rotate-totp-key', '--config', cfg, '--force'], { K1, K2 }).code).toBe(EXIT.ok);
    // A stale lock (process gone) is ignored.
    writeFileSync(path.join(f.dir, LOCK_FILE), JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname(), startedAt: new Date().toISOString() }));
    expect(run(['rotate-totp-key', '--config', cfg], { K1, K2 }).code).toBe(EXIT.ok);
  });

  it('status shows key ids in use with counts, users with TOTP and recovery codes left, never secrets', async () => {
    const f = await fixture();
    const alice = f.users.byUsername('alice')!;
    f.users.consumeRecoveryCode(alice.id, (f.db.prepare('SELECT code_hash FROM recovery_codes WHERE user_id = ? LIMIT 1').get(alice.id) as { code_hash: string }).code_hash);
    const r = run(['status', '--config', f.configFile([['k2', 'K2']], 'k2')], { K2 });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('TOTP key ring (config): k2; primary: k2');
    expect(r.out).toMatch(/v2:k1\s+3\s+NOT IN THE KEY RING/);
    expect(r.out).toContain('Local users: 3; with TOTP: 2');
    expect(r.out).toMatch(/alice\s+v2:k1\s+-\s+3 \(1 used\)/);
    expect(r.out).toMatch(/carol\s+-\s+v2:k1\s+-/);
    expect(r.out).toContain('Key id(s) in use but not in the ring: k1');
    const json = JSON.parse(run(['status', '--json', '--data-dir', f.dir]).out);
    expect(json).toMatchObject({ keyRing: null, storedSeedsByKey: { 'v2:k1': 3 }, usersWithTotp: 2, localUsers: 3 });
    expect(json.users.find((u: { username: string }) => u.username === 'bob')).toEqual({ username: 'bob', totp: 'v2:k1', pending: null, recoveryCodesRemaining: 4, recoveryCodesUsed: 0 });
    const all = r.out + r.err + JSON.stringify(json);
    for (const s of [K1, K2, ...f.seeds.values(), ...[...f.codes.values()].flat()]) expect(all).not.toContain(s);
    const hashes = f.db.prepare('SELECT code_hash FROM recovery_codes').all() as { code_hash: string }[];
    for (const h of hashes) expect(all).not.toContain(h.code_hash.split('$')[1]);
  });

  it('usage errors and a data directory without a database', async () => {
    expect(run([]).code).toBe(EXIT.usage);
    expect(run(['--help']).code).toBe(EXIT.ok);
    expect(run(['frobnicate', '--data-dir', '/tmp']).code).toBe(EXIT.usage);
    expect(run(['status']).err).toContain('no data directory');
    const empty = mkdtempSync(path.join(tmpdir(), 'rconsole-cli-empty-'));
    expect(run(['status', '--data-dir', empty])).toMatchObject({ code: EXIT.failed, err: expect.stringContaining('rconsole.sqlite not found') });
    expect(run(['reset-totp', '--data-dir', empty, '--user', 'a', '--all'])).toMatchObject({ code: EXIT.failed });
  });

  it('relative --data-dir and --config are taken from where the command was typed (INIT_CWD under pnpm)', async () => {
    const f = await fixture();
    const parent = path.dirname(f.dir);
    const rel = path.basename(f.dir);
    const pnpmEnv = { INIT_CWD: parent, npm_lifecycle_event: 'admin', npm_package_name: '@rconsole/server' };
    expect(run(['status', '--data-dir', rel], pnpmEnv).out).toContain(`Data directory: ${f.dir} `);
    const cfg = path.basename(f.configFile([['k1', 'K1']], 'k1'));
    expect(run(['status', '--config', path.join(rel, cfg)], { ...pnpmEnv, K1 }).out).toContain('TOTP key ring (config): k1; primary: k1');
  });

  it('a stale INIT_CWD (not the admin package script) does not redirect a relative --data-dir to another installation', async () => {
    const f = await fixture(); // "another installation"
    const parent = path.dirname(f.dir);
    const rel = path.basename(f.dir);
    // `node apps/server/src/cli/admin.ts` from a shell that inherited INIT_CWD from some other pnpm script: the
    // relative path is taken from the working directory ("/" in these tests), where there is no such database.
    const stale: Record<string, string>[] = [{ INIT_CWD: parent }, { INIT_CWD: parent, npm_lifecycle_event: 'dev', npm_package_name: '@rconsole/server' }];
    for (const env of stale) {
      const r = run(['reset-totp', '--all', '--yes', '--data-dir', rel], env);
      expect(r.code).toBe(EXIT.failed);
      expect(r.err).toContain(`no Redis Console database in ${path.resolve('/', rel)}`);
    }
    expect(row(f.db, 'alice').totp_secret).not.toBeNull();
    // Every command names the directory it changed.
    const ok = run(['reset-totp', '--user', 'alice', '--data-dir', f.dir]);
    expect(ok.out).toContain(`Data directory: ${f.dir}\n`);
  });

  it('status flags a corrupted (malformed) stored value without printing it', async () => {
    const f = await fixture();
    const junk = 'attacker-chosen seed';
    f.db.prepare('UPDATE users SET totp_secret = ? WHERE username = ?').run(junk, 'bob');
    const r = run(['status', '--data-dir', f.dir]);
    expect(r.out).toMatch(/malformed\s+1\s+NOT A SEED \(corrupted\): the server refuses to start; reset these users/);
    expect(r.out).not.toContain(junk);
  });

  it('runs as the package script (pnpm --filter @rconsole/server admin …)', async () => {
    const f = await fixture();
    const r = spawnSync('pnpm', ['--silent', '--dir', SERVER_DIR, 'admin', 'status', '--data-dir', f.dir], { encoding: 'utf8', env: { ...process.env, RCONSOLE_CONFIG: '' } });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Local users: 3; with TOTP: 2');
  });
});
