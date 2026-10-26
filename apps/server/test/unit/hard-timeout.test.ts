/**
 * Self-review finding 1: node-redis (5.12) clears a command's timeout once the command is written, so a command
 * that Redis never answers pinned a pooled connection (and the caller's console slots) forever. A fake RESP server
 * that never answers `HANG` proves that the timeout now holds after the write and that the tier recovers.
 */
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClientClosedError, DisconnectsClientError, TimeoutError } from 'redis';
import { resolveConfig, type DatabaseConfig } from '../../src/config.ts';
import { RedisManager } from '../../src/redis/manager.ts';
import { startApp, testConfigRaw, userSession } from '../helpers.ts';
import { listen, openSse, type SseConn } from '../integration/auth-helpers.ts';

/**
 * Minimal RESP server: answers HELLO with a map, PING with PONG (`PING hang` never, `PING later` after 150 ms),
 * INFO with a few fields, `DELAY ms` with OK after ms, everything else with OK, and never answers HANG.
 */
function fakeRedis(): Promise<{ port: number; seen: string[]; connections: () => number; close: () => Promise<void> }> {
  const seen: string[] = [];
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const server = net.createServer((sock) => {
    connections++;
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const cmd = parseCommand(buf);
        if (!cmd) break;
        buf = buf.subarray(cmd.used);
        const name = cmd.argv[0]!.toUpperCase();
        seen.push(name);
        const arg = cmd.argv[1]?.toLowerCase();
        if (name === 'HANG' || (name === 'PING' && arg === 'hang')) continue;
        const later = (ms: number, reply: string) => setTimeout(() => !sock.destroyed && sock.write(reply), ms).unref();
        if (name === 'HELLO') sock.write('%1\r\n+server\r\n+redis\r\n');
        else if (name === 'PING' && arg === 'later') later(150, '+later\r\n');
        else if (name === 'PING') sock.write('+PONG\r\n');
        else if (name === 'DELAY') later(Number(cmd.argv[1]), '+OK\r\n');
        else if (name === 'INFO') {
          const text = '# Server\r\nredis_version:8.0.0\r\n# Stats\r\ninstantaneous_ops_per_sec:1\r\n';
          sock.write(`$${Buffer.byteLength(text)}\r\n${text}\r\n`);
        } else if (name === 'COMMAND') sock.write('*0\r\n');
        else sock.write('+OK\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        seen,
        connections: () => connections,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

function parseCommand(b: Buffer): { argv: string[]; used: number } | null {
  if (b[0] !== 0x2a) return null; // '*'
  let pos = 0;
  const line = (): string | null => {
    const end = b.indexOf('\r\n', pos);
    if (end < 0) return null;
    const s = b.subarray(pos, end).toString();
    pos = end + 2;
    return s;
  };
  const head = line();
  if (head === null) return null;
  const n = Number(head.slice(1));
  const argv: string[] = [];
  for (let i = 0; i < n; i++) {
    const len = line();
    if (len === null) return null;
    const l = Number(len.slice(1));
    if (b.length < pos + l + 2) return null;
    argv.push(b.subarray(pos, pos + l).toString());
    pos += l + 2;
  }
  return { argv, used: pos };
}

describe('hard command timeout (self-review finding 1)', () => {
  let srv: Awaited<ReturnType<typeof fakeRedis>>;
  let mgr: RedisManager;
  const logs: string[] = [];
  beforeAll(async () => {
    srv = await fakeRedis();
    const db: DatabaseConfig = {
      id: 'fake', name: 'Fake', environment: 'test', mode: 'standalone', url: `redis://127.0.0.1:${srv.port}`,
      db: 0, readOnly: false, maxRole: 'admin', credentials: { default: { username: 'default' } }, poolSize: 1,
    };
    mgr = new RedisManager([db], (m) => logs.push(m));
  });
  afterAll(async () => {
    await mgr.closeAll();
    await srv.close();
  });

  it('a command that is never answered times out after it was written, and the tier recovers', async () => {
    const conn = await mgr.conn('fake', 'viewer');
    expect(await conn.send(['PING'])).toBeTruthy();
    const before = srv.connections();
    const t0 = Date.now();
    await expect(conn.send(['HANG'], { timeout: 200 })).rejects.toBeInstanceOf(TimeoutError);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(srv.seen).toContain('HANG'); // it really was written (node-redis's own timeout no longer applies)
    expect(logs).toEqual([]); // exclusive capped socket is discarded without resetting the tier
    // With poolSize 1 the stuck client used to make every later command wait for a client and fail. Its socket is
    // replaced (a new connection), the tier's Conn stays (review v0.2 M3).
    const again = await mgr.conn('fake', 'viewer');
    expect(again).toBe(conn);
    expect(String(await again.send(['PING'], { timeout: 1000 }))).toBe('PONG');
    expect(srv.connections()).toBeGreaterThan(before);
  });

  it('hardTimeout resets once on expiry and never for a timely reply', async () => {
    const { hardTimeout } = await import('../../src/redis/manager.ts');
    let stuck = 0;
    const never = new Promise<never>(() => {});
    await expect(hardTimeout(never, 10, () => stuck++)).rejects.toBeInstanceOf(TimeoutError);
    expect(stuck).toBe(1);
    // A reply that arrives in time never resets the connection.
    await expect(hardTimeout(Promise.resolve('ok'), 10, () => stuck++)).resolves.toBe('ok');
    await new Promise((r) => setTimeout(r, 600));
    expect(stuck).toBe(1);
  });
});

describe('a hard timeout replaces only the stuck connection (review v0.2 M3)', () => {
  let srv: Awaited<ReturnType<typeof fakeRedis>>;
  beforeAll(async () => {
    srv = await fakeRedis();
  });
  afterAll(async () => {
    await srv.close();
  });

  it('other commands in flight on the same tier finish; the tier keeps its connection', async () => {
    const db: DatabaseConfig = {
      id: 'fake', name: 'Fake', environment: 'test', mode: 'standalone', url: `redis://127.0.0.1:${srv.port}`,
      db: 0, readOnly: false, maxRole: 'admin', credentials: { default: { username: 'default' } }, poolSize: 2,
    };
    const mgr = new RedisManager([db], () => {});
    try {
      const conn = await mgr.conn('fake', 'viewer');
      const stuck = expect(conn.send(['HANG'], { timeout: 200 })).rejects.toBeInstanceOf(TimeoutError); // hard timeout after 200 ms
      await new Promise((r) => setTimeout(r, 30));
      const other = conn.send(['DELAY', '700'], { timeout: 3000 }); // still in flight when HANG times out
      await stuck;
      await expect(other).resolves.toBeTruthy();
      expect(await mgr.conn('fake', 'viewer')).toBe(conn);
      // The stuck connection was replaced: both pooled connections answer again.
      expect(String(await Promise.all([conn.send(['PING'], { timeout: 1000 }), conn.send(['PING'], { timeout: 1000 })]))).toBe('PONG,PONG');
    } finally {
      await mgr.closeAll();
    }
  });

  it('connection failures caused by a reset are 503 unavailable, not 500', async () => {
    const { toHttpError } = await import('../../src/redis/exec.ts');
    expect(toHttpError(new DisconnectsClientError())).toMatchObject({ code: 'unavailable', status: 503 });
    expect(toHttpError(new ClientClosedError())).toMatchObject({ code: 'unavailable', status: 503 });
  });

  it("another user's timeout neither fails their console command nor stalls their metrics stream", async () => {
    const raw = testConfigRaw() as { policy: { commandTimeoutMs: number }; databases: Record<string, unknown>[] };
    raw.policy.commandTimeoutMs = 200; // hard timeout after 200 ms
    raw.databases = [{ ...raw.databases[0], url: `redis://127.0.0.1:${srv.port}` }];
    const cfg = resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } });
    const t = await startApp(cfg);
    let metrics: SseConn | undefined;
    try {
      const base = await listen(t.app);
      const a = await userSession(t, 'viewer', 'slow-a');
      const b = await userSession(t, 'viewer', 'other-b');
      metrics = await openSse(base, '/api/v1/databases/e2e/metrics/stream', b.cookie);
      await metrics.waitFor((e) => e.event === 'message');
      const ra = a.req('POST', '/api/v1/databases/e2e/cli', { argv: ['PING', 'hang'] });
      await new Promise((r) => setTimeout(r, 100));
      const rb = b.req('POST', '/api/v1/databases/e2e/cli', { argv: ['PING', 'later'] }); // answered at ~250 ms, after the other socket times out
      expect((await ra).status).toBe(504);
      const okB = await rb;
      expect(okB.status, JSON.stringify(okB.json)).toBe(200);
      // The stream keeps sampling: two more samples after the timeout and no errors.
      const seen = metrics.events.length;
      await metrics.waitFor((e) => e.event === 'message' && metrics!.events.indexOf(e) > seen, 5000);
      expect(metrics.events.filter((e) => e.event === 'error')).toEqual([]);
      // Whatever replaces the tier's connections (cluster/sentinel resets, a fallback reset), the stream follows.
      await t.ctx.redis.closeAll();
      const after = metrics.events.length;
      await metrics.waitFor((e) => e.event === 'message' && metrics!.events.indexOf(e) >= after, 5000);
    } finally {
      metrics?.close();
      await t.close();
    }
  }, 20_000);
});
