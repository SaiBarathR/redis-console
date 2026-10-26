/**
 * Review v0.2 round 4 (server, Claude reviewer): limits around the measured transport, through the HTTP API.
 * Writes only to the disposable 6411 sandbox (per-run prefix); slow cases use an in-process fake Redis.
 * Each test failed on `release/v0.2` @ 93a5720.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig, type AppConfig } from '../../src/config.ts';
import { cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, testConfigRaw, userSession, type Client } from '../helpers.ts';
import { listen, openPubSub, openSse, sleep, type SseConn } from './auth-helpers.ts';
import { startFakeRedis, type FakeRedis } from './fake-redis.ts';

const P = keyPrefix('r4');
const CLI = '/api/v1/databases/e2e/cli';

function config(policy: Partial<AppConfig['policy']> = {}, extra: Record<string, unknown>[] = []): AppConfig {
  const raw = testConfigRaw();
  (raw.databases as Record<string, unknown>[]).push(...extra);
  (raw.server as Record<string, unknown>).dataDir = mkdtempSync(path.join(tmpdir(), 'rconsole-test-'));
  const cfg = resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } });
  Object.assign(cfg.policy, policy);
  return cfg;
}
const fakeDb = (id: string, f: FakeRedis) => ({ id, name: id, environment: 'test', url: `redis://127.0.0.1:${f.port}`, credentials: { default: { username: 'default' } } });

describe.skipIf(!sandboxUp)('review v0.2 round 4', () => {
  let r: Awaited<ReturnType<typeof sandboxAdmin>>;
  beforeAll(async () => {
    r = await sandboxAdmin();
  });
  afterAll(async () => {
    await r?.close();
    await cleanupPrefix(P);
  });

  it('H1: idle pub/sub streams never block console commands; streams have their own server-wide limit', async () => {
    const t = await startApp(config({ maxInflightCommands: 2, maxStreams: 3 }));
    const base = await listen(t.app);
    const open: SseConn[] = [];
    try {
      const viewers = [await userSession(t, 'viewer'), await userSession(t, 'viewer')];
      for (let i = 0; i < 3; i++) {
        const s = await openPubSub(base, viewers[i % 2]!, 'e2e', [`${P}idle${i}`]);
        open.push(s);
        expect(s.status).toBe(200);
        await s.waitFor((e) => e.event === 'ready');
      }
      const fourth = await openPubSub(base, await userSession(t, 'viewer'), 'e2e', [`${P}idle4`]);
      open.push(fourth);
      expect(fourth.status).toBe(429);
      expect(fourth.json.error.message).toMatch(/live streams are open on this server \(limit 3\)/);
      // More open streams than command slots, yet everyone else's work runs, on every database.
      const admin = await userSession(t, 'admin');
      expect((await admin.req('POST', CLI, { argv: ['GET', `${P}k`] })).status).toBe(200);
      expect((await admin.req('POST', '/api/v1/databases/e2e/keys/scan', { cursor: '0', match: `${P}*`, count: 10 })).status).toBe(200);
      expect((await admin.req('GET', '/api/v1/databases/e2e/overview')).status).toBe(200);
      expect((await admin.req('POST', '/api/v1/databases/main/cli', { argv: ['DBSIZE'] })).status).toBe(200);
      const list = await admin.req('GET', '/api/v1/databases');
      expect(list.json.databases.find((d: { id: string }) => d.id === 'e2e').status).toBe('connected');
    } finally {
      for (const s of open) s.close();
      await t.close();
    }
  });

  it('M1: concurrent commands within per-user limits wait for a pool socket instead of getting 429', async () => {
    const t = await startApp(config());
    try {
      // Six operators, one 300 ms blocking command each (their per-user limit), on the 4-socket operator pool.
      const operators = await Promise.all(Array.from({ length: 6 }, () => userSession(t, 'operator')));
      const blocking = await Promise.all(operators.map((c) => c.req('POST', CLI, { argv: ['BLPOP', `${P}none`, '0.3'] })));
      expect(blocking.map((x) => x.status)).toEqual(Array(6).fill(200));
      // The reviewer's case: two viewers, four concurrent GETs each (the per-user CLI limit).
      const [a, b] = [await userSession(t, 'viewer'), await userSession(t, 'viewer')];
      for (let round = 0; round < 3; round++) {
        const res = await Promise.all([a, b].flatMap((v) => Array.from({ length: 4 }, () => v.req('POST', CLI, { argv: ['GET', `${P}x`] }))));
        expect(res.map((x) => x.status)).toEqual(Array(8).fill(200));
      }
    } finally {
      await t.close();
    }
  });

  it('M2: bulk delete preview, bulk delete and analysis go past one read budget of SCAN replies', async () => {
    const t = await startApp(config({ maxReadReplyBytes: 64 * 1024 }));
    const N = 4000;
    try {
      // 4,000 keys with ~60-byte names: about 270 KB of SCAN replies, four times the 64 KiB cap.
      for (let i = 0; i < N; i += 1000) {
        const pairs: string[] = [];
        for (let j = i; j < i + 1000; j++) pairs.push(`${P}bulk:${String(j).padStart(32, '0')}`, '1');
        await r.sendCommand(['MSET', ...pairs]);
      }
      const op = await userSession(t, 'operator');
      const url = '/api/v1/databases/e2e/bulk-delete';
      const pre = await op.req('POST', url, { match: `${P}bulk:*` });
      expect(pre.status, JSON.stringify(pre.json)).toBe(428);
      expect(pre.json.error.confirmation.impact.keys).toBe(N);
      const analysis = await op.req('POST', '/api/v1/databases/e2e/analysis', { sampleSize: N, match: `${P}bulk:*` });
      expect(analysis.status, JSON.stringify(analysis.json)).toBe(200);
      expect(analysis.json.sampled).toBe(N);
      const done = await op.req('POST', url, { match: `${P}bulk:*`, confirmation: { token: pre.json.error.confirmation.token, typed: 'E2E' } });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      expect(done.json.deleted).toBe(N);
    } finally {
      await t.close();
    }
  });

  it('M3: a stream whose client leaves during the Redis handshake keeps no slot, socket or audit start', async () => {
    const fake = await startFakeRedis({ cappedHelloDelayMs: 600 });
    const t = await startApp(config({}, [fakeDb('slow', fake)]));
    const base = await listen(t.app);
    try {
      const v = await userSession(t, 'viewer');
      const admin = await userSession(t, 'admin');
      const abandon = async (c: Client, streamPath: string) => {
        const stop = new AbortController();
        setTimeout(() => stop.abort(), 150);
        await fetch(base + streamPath, { headers: { cookie: c.cookie, accept: 'text/event-stream' }, signal: stop.signal }).catch(() => undefined);
      };
      for (let i = 0; i < 3; i++) {
        const sub = await v.req('POST', '/api/v1/databases/slow/pubsub/subscriptions', { channels: [`${P}leak`] });
        await abandon(v, `/api/v1/databases/slow/pubsub/stream?sub=${sub.json.id}`);
      }
      await abandon(admin, '/api/v1/databases/slow/profiler/stream?seconds=30');
      await sleep(900);
      expect(t.ctx.slots.count(`sse:live:${v.userId}`)).toBe(0);
      expect(t.ctx.slots.count(`sse:live:${admin.userId}`)).toBe(0);
      expect(fake.capped.size).toBe(0);
      expect(fake.commands).not.toContain('SUBSCRIBE');
      expect(fake.commands).not.toContain('MONITOR');
      const started = t.ctx.audit.query({ limit: 50 }).events.filter((e) => e.action === 'pubsub.start' || (e.action === 'profiler.start' && e.outcome === 'allowed'));
      expect(started).toEqual([]);
      // The user still has every stream slot.
      const fresh: SseConn[] = [];
      for (let i = 0; i < 3; i++) {
        const s = await openPubSub(base, v, 'e2e', [`${P}fresh${i}`]);
        fresh.push(s);
        expect(s.status).toBe(200);
      }
      for (const s of fresh) s.close();
    } finally {
      await t.close();
      await fake.close();
    }
  });

  it('M4: a large monitored command or published message arrives cut; the stream continues', async () => {
    const t = await startApp(config({ maxReadReplyBytes: 256 * 1024 }));
    const base = await listen(t.app);
    const open: SseConn[] = [];
    try {
      const admin = await userSession(t, 'admin');
      const prof = await openSse(base, '/api/v1/databases/e2e/profiler/stream?seconds=10', admin.cookie);
      open.push(prof);
      await prof.waitFor((e) => e.event === 'ready');
      await r.set(`${P}mon-big`, 'y'.repeat(70 * 1024));
      await r.set(`${P}mon-after`, 'v');
      const big = await prof.waitFor((e) => e.event === 'message' && e.data.argv?.[1] === `${P}mon-big`);
      expect(big.data.argv[2]).toBe(`${'y'.repeat(64)}…`);
      await prof.waitFor((e) => e.event === 'message' && e.data.argv?.[1] === `${P}mon-after`);
      expect(prof.events.filter((e) => e.event === 'error' || e.event === 'end')).toEqual([]);

      const viewer = await userSession(t, 'viewer');
      const ch = `${P}chan`;
      const sub = await openPubSub(base, viewer, 'e2e', [ch]);
      open.push(sub);
      await sub.waitFor((e) => e.event === 'ready');
      // Larger than the configured 256 KiB data cap: shown cut with its size, not a closed stream.
      await r.publish(ch, 'z'.repeat(300 * 1024));
      await r.publish(ch, 'after');
      const cut = await sub.waitFor((e) => e.event === 'message' && e.data.truncated === true);
      expect(cut.data.totalBytes).toBe(300 * 1024);
      expect(Buffer.from(cut.data.message.data, cut.data.message.enc === 'base64' ? 'base64' : 'utf8').length).toBe(64 * 1024);
      const after = await sub.waitFor((e) => e.event === 'message' && e.data.message?.data === 'after');
      expect(after.data.truncated).toBeUndefined();
      expect(sub.events.filter((e) => e.event === 'error' || e.event === 'end')).toEqual([]);
    } finally {
      for (const s of open) s.close();
      await t.close();
    }
  });

  it('L2: server metadata reads (INFO, COMMAND DOCS) keep working with the smallest data cap', async () => {
    const t = await startApp(config({ maxReadReplyBytes: 1024 }));
    try {
      const v = await userSession(t, 'viewer');
      const docs = await v.req('GET', '/api/v1/databases/e2e/commands');
      expect(docs.status, JSON.stringify(docs.json).slice(0, 300)).toBe(200);
      expect(docs.json.commands.length).toBeGreaterThan(100);
      expect((await v.req('GET', '/api/v1/databases/e2e/overview')).status).toBe(200);
      const list = await v.req('GET', '/api/v1/databases');
      expect(list.json.databases.find((d: { id: string }) => d.id === 'e2e').status).toBe('connected');
    } finally {
      await t.close();
    }
  });

  it('L2: one user cannot hold every server-wide request slot', async () => {
    const fake = await startFakeRedis({
      reply: (args, socket) => {
        if (args[0] === 'ECHO' && args[1] === 'slow') {
          setTimeout(() => socket.writable && socket.write('$4\r\nslow\r\n'), 800);
          return true;
        }
      },
    });
    const t = await startApp(config({ maxInflightCommands: 2 }, [fakeDb('slow', fake)]));
    try {
      const v = await userSession(t, 'viewer');
      // Two slow requests of one user; the second waits for the user's share instead of taking the last slot.
      const slow = [v.req('POST', '/api/v1/databases/slow/cli', { argv: ['ECHO', 'slow'] }), v.req('POST', '/api/v1/databases/slow/cli', { argv: ['ECHO', 'slow'] })];
      await sleep(150);
      const other = await userSession(t, 'viewer');
      const start = Date.now();
      const ping = await other.req('POST', CLI, { argv: ['PING'] });
      expect(ping.status, JSON.stringify(ping.json)).toBe(200);
      expect(Date.now() - start).toBeLessThan(500);
      expect((await Promise.all(slow)).map((x) => x.status)).toEqual([200, 200]);
    } finally {
      await t.close();
      await fake.close();
    }
  });
});
