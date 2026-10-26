import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, userSession, type Client, type TestApp } from '../helpers.ts';
import { listen, openPubSub, openSse, sleep, type SseConn } from './auth-helpers.ts';

describe.skipIf(!sandboxUp)('SSE streams', () => {
  let t: TestApp;
  let base: string;
  const P = keyPrefix('sse');
  const open: SseConn[] = [];
  const sse = async (path: string, c: Client) => {
    const s = await openSse(base, path, c.cookie);
    open.push(s);
    return s;
  };
  const pubsub = async (c: Client, channels: string[], patterns: string[] = [], db = 'e2e') => {
    const s = await openPubSub(base, c, db, channels, patterns);
    open.push(s);
    return s;
  };

  beforeAll(async () => {
    t = await startApp();
    base = await listen(t.app);
  });
  afterAll(async () => {
    for (const s of open) s.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('metrics stream emits samples with security headers', async () => {
    const v = await userSession(t, 'viewer');
    const s = await sse('/api/v1/databases/e2e/metrics/stream', v);
    expect(s.status).toBe(200);
    expect(s.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(s.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(s.headers.get('x-content-type-options')).toBe('nosniff');
    expect(s.headers.get('cache-control')).toBe('no-store');
    const first = await s.waitFor((e) => e.event === 'message');
    expect(first.data).toMatchObject({ opsPerSec: expect.any(Number), usedMemory: expect.any(Number), connectedClients: expect.any(Number) });
    expect(first.data.t).toBeGreaterThan(Date.now() - 10_000);
    const second = await s.waitFor((e) => e.event === 'message' && e.data !== first.data, 5000);
    expect(second.data.cpuUser).toBeGreaterThanOrEqual(0);
    s.close();
  });

  it('requires a session', async () => {
    const r = await fetch(`${base}/api/v1/databases/e2e/metrics/stream`);
    expect(r.status).toBe(401);
  });

  it('pub/sub: subscribe, publish (operator) and receive binary-safe messages', async () => {
    const viewer = await userSession(t, 'viewer');
    const op = await userSession(t, 'operator');
    const ch = `${P}chan`;
    const s = await pubsub(viewer, [ch], [`${P}pat:*`]);
    expect(s.status).toBe(200);
    await s.waitFor((e) => e.event === 'ready');

    const chans = await viewer.req('POST', '/api/v1/databases/e2e/pubsub/channels', { pattern: `${P}*` });
    expect(chans.status).toBe(200);
    expect(chans.json.channels).toContainEqual({ name: ch, subscribers: 1 });
    expect(chans.json.patterns).toBeGreaterThanOrEqual(1);

    // Viewers cannot publish.
    expect((await viewer.req('POST', '/api/v1/databases/e2e/pubsub/publish', { channel: ch, message: { enc: 'utf8', data: 'x' } })).status).toBe(403);

    const pub = await op.req('POST', '/api/v1/databases/e2e/pubsub/publish', { channel: ch, message: { enc: 'utf8', data: 'hello ✓' } });
    expect(pub.status).toBe(200);
    expect(pub.json).toEqual({ receivers: 1 });
    const m1 = await s.waitFor((e) => e.event === 'message' && e.data.channel === ch);
    expect(m1.data.message).toEqual({ enc: 'utf8', data: 'hello ✓' });
    expect(m1.data.pattern).toBeUndefined();

    const bin = Buffer.from([0xff, 0x00, 0x80, 0x41]);
    await op.req('POST', '/api/v1/databases/e2e/pubsub/publish', { channel: `${P}pat:x`, message: { enc: 'base64', data: bin.toString('base64') } });
    const m2 = await s.waitFor((e) => e.event === 'message' && e.data.channel === `${P}pat:x`);
    expect(m2.data.pattern).toBe(`${P}pat:*`);
    expect(m2.data.message).toEqual({ enc: 'base64', data: bin.toString('base64') });

    s.close();
    await sleep(300);
    const audit = t.ctx.audit.query({ user: viewer.username, limit: 50 }).events.map((e) => e.action);
    expect(audit).toContain('pubsub.start');
    expect(audit).toContain('pubsub.stop');
    const pubAudit = t.ctx.audit.query({ user: op.username, action: 'pubsub.publish', limit: 10 }).events;
    expect(pubAudit[0]!.argvRedacted).toEqual(['PUBLISH', `<${Buffer.byteLength(`${P}pat:x`)} bytes>`, '<message>']);
  });

  it('publish: readOnly -> 403, prod -> 428 typed + reason', async () => {
    const op = await userSession(t, 'operator');
    const ro = await op.req('POST', '/api/v1/databases/e2e-ro/pubsub/publish', { channel: `${P}c`, message: { enc: 'utf8', data: 'x' } });
    expect(ro.status).toBe(403);
    expect(ro.json.error.code).toBe('read_only');
    const body = { channel: `${P}c`, message: { enc: 'utf8', data: 'x' } };
    const first = await op.req('POST', '/api/v1/databases/e2e-prod/pubsub/publish', body);
    expect(first.status).toBe(428);
    const ch = first.json.error.confirmation;
    expect(ch).toMatchObject({ level: 'typed', expectedText: 'E2E prod', reasonRequired: true });
    const noReason = await op.req('POST', '/api/v1/databases/e2e-prod/pubsub/publish', { ...body, confirmation: { token: ch.token, typed: 'E2E prod' } });
    expect(noReason.status).toBe(428);
    const ch2 = noReason.json.error.confirmation;
    const ok = await op.req('POST', '/api/v1/databases/e2e-prod/pubsub/publish', { ...body, confirmation: { token: ch2.token, typed: 'E2E prod', reason: 'integration test' } });
    expect(ok.status).toBe(200);
    // Single use.
    expect((await op.req('POST', '/api/v1/databases/e2e-prod/pubsub/publish', { ...body, confirmation: { token: ch2.token, typed: 'E2E prod', reason: 'again' } })).status).toBe(428);
    const ev = t.ctx.audit.query({ user: op.username, action: 'pubsub.publish', outcome: 'allowed', limit: 5 }).events[0]!;
    expect(ev.reason).toBe('integration test');
  });

  it('pub/sub subscription ids: single-use, session- and database-bound, channel names never in the URL', async () => {
    const v = await userSession(t, 'viewer');
    const other = await userSession(t, 'viewer');
    const mk = async (c: Client, db = 'e2e') => {
      const r = await c.req('POST', `/api/v1/databases/${db}/pubsub/subscriptions`, { channels: [`${P}secret:chan`] });
      expect(r.status).toBe(200);
      expect(r.json.id).not.toContain('secret');
      expect(Date.parse(r.json.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
      return r.json.id as string;
    };
    // Another user's session cannot use it.
    const stolen = await sse(`/api/v1/databases/e2e/pubsub/stream?sub=${await mk(v)}`, other);
    expect(stolen.status).toBe(404);
    // Another database cannot use it.
    expect((await sse(`/api/v1/databases/main/pubsub/stream?sub=${await mk(v)}`, v)).status).toBe(404);
    // Single use.
    const id = await mk(v);
    const s = await sse(`/api/v1/databases/e2e/pubsub/stream?sub=${id}`, v);
    expect(s.status).toBe(200);
    const ready = await s.waitFor((e) => e.event === 'ready');
    expect(ready.data).toEqual({ subscribed: { channels: [`${P}secret:chan`], patterns: [] } });
    s.close();
    expect((await sse(`/api/v1/databases/e2e/pubsub/stream?sub=${id}`, v)).status).toBe(404);
    // The legacy query form is refused outright.
    expect((await sse(`/api/v1/databases/e2e/pubsub/stream?channel=${P}x`, v)).status).toBe(400);
  });

  it('pub/sub validation and the per-user live stream limit', async () => {
    const v = await userSession(t, 'viewer');
    const tooMany = await pubsub(v, Array.from({ length: 6 }, (_, i) => `${P}c${i}`), Array.from({ length: 5 }, (_, i) => `${P}p${i}*`));
    expect(tooMany.status).toBe(400);
    expect((await pubsub(v, [])).status).toBe(400);
    // The stream itself only takes a subscription id.
    expect((await sse('/api/v1/databases/e2e/pubsub/stream', v)).status).toBe(400);

    const streams: SseConn[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await pubsub(v, [`${P}lim${i}`]);
      expect(s.status).toBe(200);
      streams.push(s);
    }
    const fourth = await pubsub(v, [`${P}lim4`]);
    expect(fourth.status).toBe(429);
    expect(fourth.json.error.code).toBe('rate_limited');
    // Another user is unaffected.
    const other = await userSession(t, 'viewer');
    const s5 = await pubsub(other, [`${P}lim5`]);
    expect(s5.status).toBe(200);
    s5.close();
    // Closing one frees a slot.
    streams[0]!.close();
    await sleep(300);
    const again = await pubsub(v, [`${P}lim6`]);
    expect(again.status).toBe(200);
    for (const s of [...streams, again]) s.close();
    await sleep(200);
  });

  it('profiler: admin only, non-prod only, bounded duration, truncated args', async () => {
    const admin = await userSession(t, 'admin');
    for (const role of ['viewer', 'operator'] as const) {
      const c = await userSession(t, role);
      const r = await sse('/api/v1/databases/e2e/profiler/stream?seconds=2', c);
      expect(r.status).toBe(403);
    }
    expect((await sse('/api/v1/databases/e2e-prod/profiler/stream?seconds=2', admin)).status).toBe(403);
    expect((await sse('/api/v1/databases/e2e/profiler/stream?seconds=61', admin)).status).toBe(400);
    // maxRole=operator caps the admin below the profiler requirement.
    expect((await sse('/api/v1/databases/e2e-maxop/profiler/stream?seconds=2', admin)).status).toBe(403);

    const s = await sse('/api/v1/databases/e2e/profiler/stream?seconds=2', admin);
    expect(s.status).toBe(200);
    await s.waitFor((e) => e.event === 'ready');
    const long = 'x'.repeat(100);
    const direct = await sandboxAdmin();
    try {
      await direct.sendCommand(['ECHO', `${P}${long}`]);
    } finally {
      await direct.close();
    }
    const ev = await s.waitFor((e) => e.event === 'message' && e.data.argv?.[0]?.toUpperCase() === 'ECHO' && String(e.data.argv[1]).startsWith(P));
    expect(ev.data.argv[1].length).toBe(65); // 64 chars + ellipsis
    expect(ev.data.argv[1].endsWith('…')).toBe(true);
    expect(typeof ev.data.client).toBe('string');
    expect(typeof ev.data.db).toBe('number');
    expect(ev.data.t).toBeGreaterThan(Date.now() - 60_000);
    // Ends by itself after `seconds`.
    const end = await s.waitFor((e) => e.event === 'end', 6000);
    expect(end.data.reason).toBe('time limit reached');
    await s.ended;
    await sleep(200);
    const actions = t.ctx.audit.query({ user: admin.username, limit: 50 }).events.map((e) => `${e.action}:${e.outcome}`);
    expect(actions).toContain('profiler.start:allowed');
    expect(actions).toContain('profiler.stop:allowed');
    expect(actions).toContain('profiler.start:denied');
  });

  it('logout closes open streams', async () => {
    const v = await userSession(t, 'viewer');
    const s = await sse('/api/v1/databases/e2e/metrics/stream', v);
    expect(s.status).toBe(200);
    await s.waitFor((e) => e.event === 'message');
    expect((await v.req('POST', '/api/v1/auth/logout')).status).toBe(200);
    const end = await s.waitFor((e) => e.event === 'end', 7000);
    expect(end.data.reason).toBe('session ended');
    await s.ended;
    expect(s.isEnded()).toBe(true);
  });
});
