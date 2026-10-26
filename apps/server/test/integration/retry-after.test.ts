/**
 * v0.3 follow-up 6: every 429 carries `Retry-After` (seconds), so clients can back off instead of failing: the
 * per-user typed-read slots (the stream inspector's refresh after an acknowledge hit them), the per-address limit, and
 * the sign-in budget (which refills slowly, so it asks for longer).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bk, sandboxAdmin, startApp, testConfig, userSession, type TestApp } from '../helpers.ts';
import { createUser, login } from './auth-helpers.ts';

describe('Retry-After on 429 (v0.3 follow-up 6)', () => {
  let t: TestApp;
  let redisUp = true;
  beforeAll(async () => {
    t = await startApp(testConfig(), { loginLimits: { perIpPerSecond: 1 / 60, perIpBurst: 1 } });
    try {
      const c = await sandboxAdmin();
      await c.close();
    } catch {
      redisUp = false;
    }
  });
  afterAll(async () => t?.close());

  it('a typed read refused by the four-reads-per-user limit says when to retry', async (c) => {
    if (!redisUp) return c.skip();
    const op = await userSession(t, 'operator');
    const held = [1, 2, 3, 4].map(() => t.ctx.slots.acquire(`data-read:${op.userId}`, 4));
    try {
      const r = await op.req('POST', '/api/v1/databases/e2e/streams/groups', { key: bk('rcsrv:retry-after:none') });
      expect(r.status).toBe(429);
      expect(r.json.error.code).toBe('rate_limited');
      expect(r.headers['retry-after']).toBe('1');
    } finally {
      for (const release of held) release?.();
    }
    const ok = await op.req('POST', '/api/v1/databases/e2e/streams/groups', { key: bk('rcsrv:retry-after:none') });
    expect(ok.status).not.toBe(429);
    expect(ok.headers['retry-after']).toBeUndefined();
  });

  it('the sign-in budget asks for the time one more attempt takes to refill', async () => {
    await createUser(t, 'retry-after-user', 'viewer');
    expect((await login(t, 'retry-after-user', 'wrong password!')).r.status).toBe(401);
    const { r } = await login(t, 'retry-after-user', 'wrong password!');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('60');
  });

  it('the per-address request limit says when to retry', async () => {
    const anon = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(anon.headers['retry-after']).toBeUndefined();
    let last;
    for (let i = 0; i < 400; i++) {
      last = await t.app.inject({ method: 'GET', url: '/api/v1/auth/providers', remoteAddress: '198.51.100.9' });
      if (last.statusCode === 429) break;
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.headers['retry-after']).toBe('1');
  });
});
