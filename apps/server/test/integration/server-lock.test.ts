/**
 * Review v0.3 TOTP M1: a failed duplicate start replaced the live server's `server.lock`, so `admin rotate-totp-key`
 * believed no server was running, re-wrapped the seeds to a key the running server did not have, and its sign-ins
 * answered 500. Real processes: server A runs `src/main.ts`; a duplicate B with the same config and data directory
 * must refuse to start without touching A's lock; rotation must stay refused while A runs; A keeps authenticating.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT, runAdmin } from '../../src/cli/admin.ts';
import { TotpKeyring } from '../../src/security/totpCipher.ts';
import { generateTotpSecret } from '../../src/security/totp.ts';
import { hashPassword } from '../../src/security/password.ts';
import { openDb } from '../../src/store/db.ts';
import { LOCK_FILE } from '../../src/store/lock.ts';
import { UserStore } from '../../src/store/users.ts';

const SERVER_DIR = path.resolve(import.meta.dirname, '../..');
const K_OLD = 'old-key-'.repeat(5);
const K_NEW = 'new-key-'.repeat(5);
const PASSWORD = 'correct horse battery staple';

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

interface Proc { child: ChildProcess; stderr: () => string; exited: Promise<number | null> }

function startServer(configFile: string): Proc {
  let err = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/main.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'warn', RCONSOLE_CONFIG: configFile, RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '', K_OLD },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, stderr: () => err, exited };
}

async function waitHealthy(port: number, proc: Proc): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.child.exitCode !== null) throw new Error(`server exited early: ${proc.stderr()}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy: ${proc.stderr()}`);
}

const login = (port: number) => fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: `http://localhost:${port}` },
  body: JSON.stringify({ username: 'alice', password: PASSWORD }),
});

describe('server.lock is owned exclusively (review v0.3 TOTP M1)', () => {
  const running: Proc[] = [];
  afterAll(async () => {
    for (const p of running) if (p.child.exitCode === null) { p.child.kill('SIGTERM'); await p.exited; }
  });

  it('a duplicate start refuses and leaves the lock intact; rotation stays refused; the first server keeps authenticating', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rconsole-lock-'));
    const db = openDb(dir);
    const users = new UserStore(db, { totpKeyring: new TotpKeyring([{ id: 'old', secret: K_OLD }], 'old') });
    const alice = users.create({ username: 'alice', displayName: 'alice', role: 'admin', passwordHash: await hashPassword(PASSWORD), mustChangePassword: false });
    users.update(alice.id, { totpSecret: generateTotpSecret() });
    const stored = () => (db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(alice.id) as { totp_secret: string }).totp_secret;
    expect(stored().startsWith('v2:old:')).toBe(true);

    const port = await freePort();
    const config = (keys: string[], primary: string) => ({
      server: { host: '127.0.0.1', port, publicUrl: `http://localhost:${port}`, secureCookies: false, dataDir: dir },
      auth: { local: { enabled: true, requireTotpForRoles: [], totpEncryptionKeys: keys.map((id) => ({ id, secret: { env: id === 'old' ? 'K_OLD' : 'K_NEW' } })), totpPrimaryKeyId: primary } },
      databases: [],
    });
    const serverCfg = path.join(dir, 'server.json');
    const rotateCfg = path.join(dir, 'rotate.json');
    writeFileSync(serverCfg, JSON.stringify(config(['old'], 'old')));
    writeFileSync(rotateCfg, JSON.stringify(config(['old', 'new'], 'new')));
    const lockFile = path.join(dir, LOCK_FILE);
    const rotate = () => runAdmin(['rotate-totp-key', '--config', rotateCfg], { env: { K_OLD, K_NEW }, cwd: dir, out: () => {}, err: () => {} });

    const a = startServer(serverCfg);
    running.push(a);
    await waitHealthy(port, a);
    const owner = readFileSync(lockFile, 'utf8');
    expect(JSON.parse(owner)).toMatchObject({ pid: a.child.pid });
    expect((await login(port)).status).toBe(200);

    // Rotation is refused while A runs.
    expect(rotate()).toBe(EXIT.running);

    // B: the same command, config, data directory and port. It refuses before it opens the database or binds.
    const b = startServer(serverCfg);
    running.push(b);
    expect(await b.exited).toBe(75);
    expect(b.stderr()).toContain('refusing to start');
    expect(b.stderr()).toContain(`pid ${a.child.pid}`);
    expect(readFileSync(lockFile, 'utf8')).toBe(owner);

    // Still refused, nothing re-wrapped, and A still authenticates (it would answer 500 under an unknown primary key).
    expect(rotate()).toBe(EXIT.running);
    expect(stored().startsWith('v2:old:')).toBe(true);
    expect(readFileSync(lockFile, 'utf8')).toBe(owner);
    const r = await login(port);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ totpRequired: true });

    // A stops: only the owner removes its lock; then rotation runs (and holds and releases the lock itself).
    a.child.kill('SIGTERM');
    expect(await a.exited).toBe(0);
    expect(existsSync(lockFile)).toBe(false);
    expect(rotate()).toBe(EXIT.ok);
    expect(stored().startsWith('v2:new:')).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
    db.close();
  });
});
