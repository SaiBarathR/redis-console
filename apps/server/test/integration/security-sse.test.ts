/** Regression tests for SSE findings (sandbox 6411). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyPrefix, sandboxUp, startApp, userSession, type TestApp } from '../helpers.ts';
import { listen, openPubSub, type SseConn } from './auth-helpers.ts';

describe.skipIf(!sandboxUp)('security: live streams', () => {
  let t: TestApp;
  let base: string;
  const P = keyPrefix('secsse');
  const open: SseConn[] = [];
  beforeAll(async () => {
    t = await startApp();
    base = await listen(t.app);
  });
  afterAll(async () => {
    for (const s of open) s.close();
    await t?.close();
  });

  it('requests over the per-user stream limit never open a Redis connection', async () => {
    const v = await userSession(t, 'viewer');
    const conn = await t.ctx.redis.conn('e2e', 'viewer');
    let dedicated = 0;
    const orig = conn.dedicated.bind(conn);
    conn.dedicated = () => {
      dedicated++;
      return orig();
    };
    try {
      for (let i = 0; i < 3; i++) {
        const s = await openPubSub(base, v, 'e2e', [`${P}c${i}`]);
        open.push(s);
        await s.waitFor((e) => e.event === 'ready');
      }
      expect(dedicated).toBe(3);
      const burst = await Promise.all(Array.from({ length: 10 }, () => openPubSub(base, v, 'e2e', [`${P}x`])));
      expect(burst.every((s) => s.status === 429)).toBe(true);
      expect(dedicated).toBe(3);
    } finally {
      conn.dedicated = orig;
      for (const s of open.splice(0)) s.close();
    }
  });

  it('large pub/sub messages are cut and flagged instead of streamed whole', async () => {
    const v = await userSession(t, 'viewer');
    const op = await userSession(t, 'operator');
    const ch = `${P}big`;
    const s = await openPubSub(base, v, 'e2e', [ch]);
    open.push(s);
    await s.waitFor((e) => e.event === 'ready');
    const msg = 'm'.repeat(200_000);
    expect((await op.req('POST', '/api/v1/databases/e2e/pubsub/publish', { channel: ch, message: { enc: 'utf8', data: msg } })).status).toBe(200);
    const ev = await s.waitFor((e) => e.event === 'message');
    expect(ev.data.truncated).toBe(true);
    expect(ev.data.totalBytes).toBe(200_000);
    expect(ev.data.message.data.length).toBe(65_536);
    s.close();
  });
});
