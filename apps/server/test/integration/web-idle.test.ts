import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, userSession, type TestApp } from '../helpers.ts';
describe('web R2 M4: background requests and idle timeout', () => {
  let t: TestApp;
  beforeAll(async () => { t = await startApp(); });
  afterAll(async () => { await t.close(); });
  it('polls do not slide idle expiry; user requests do, and expired polls return 401', async () => {
    const c = await userSession(t, 'viewer');
    const lastSeen = Date.now() - 30_000;
    t.ctx.db.prepare('UPDATE sessions SET last_seen_at = ?').run(lastSeen);
    for (let i = 0; i < 3; i++) {
      expect((await c.req('GET', '/api/v1/auth/me', undefined, { 'x-rc-background': '1' })).status).toBe(200);
      expect((t.ctx.db.prepare('SELECT last_seen_at FROM sessions').get() as {last_seen_at: number}).last_seen_at).toBe(lastSeen);
    }
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(200);
    expect((t.ctx.db.prepare('SELECT last_seen_at FROM sessions').get() as {last_seen_at: number}).last_seen_at).toBeGreaterThan(lastSeen);
    t.ctx.db.prepare('UPDATE sessions SET last_seen_at = ?').run(Date.now() - t.ctx.sessions.idleMs - 1);
    expect((await c.req('GET', '/api/v1/auth/me', undefined, { 'x-rc-background': '1' })).status).toBe(401);
  });
});
