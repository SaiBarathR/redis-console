/**
 * Regression tests for auth findings from the security review (no Redis needed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../../src/security/totp.ts';
import { startApp, testConfig, type TestApp } from '../helpers.ts';
import { createUser, login, PASSWORD } from './auth-helpers.ts';

const BIG_LIMITS = { loginLimits: { perIpPerSecond: 1000, perIpBurst: 1000 } };

describe('security: lockout and failed-login audit', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(testConfig({ local: { lockout: { maxAttempts: 3, windowMinutes: 5 } } }), BIG_LIMITS);
  });
  afterAll(async () => t?.close());

  it('concurrent wrong passwords cannot bypass the lockout (atomic failure counter)', async () => {
    const u = await createUser(t, 'race-user', 'viewer');
    // 15 guesses in parallel: before the fix every request read failed_count=0 and wrote 1.
    const rs = await Promise.all(Array.from({ length: 15 }, (_, i) => login(t, 'race-user', `wrong password ${i}`)));
    expect(rs.every((x) => x.r.status === 401)).toBe(true);
    const rec = t.ctx.users.byId(u.id)!;
    expect(rec.failedCount).toBeGreaterThanOrEqual(3);
    expect(t.ctx.users.isLocked(rec)).toBe(true);
    // The right password is refused while locked.
    expect((await login(t, 'race-user')).r.status).toBe(401);
  });

  it('the right password racing with a locking failure is refused', async () => {
    const u = await createUser(t, 'race-user2', 'viewer');
    for (let i = 0; i < 2; i++) await login(t, 'race-user2', 'nope nope nope');
    const [bad, good] = await Promise.all([login(t, 'race-user2', 'nope nope nope'), login(t, 'race-user2')]);
    expect(bad.r.status).toBe(401);
    // Either the good attempt finished before the lock (200) or it must be refused; the account ends locked.
    expect([200, 401]).toContain(good.r.status);
    expect(t.ctx.users.isLockedNow(u.id)).toBe(true);
    expect((await login(t, 'race-user2')).r.status).toBe(401);
  });

  it('lockout cannot be bypassed by changing the username case or padding', async () => {
    const u = await createUser(t, 'casey', 'viewer');
    await login(t, 'CASEY', 'nope nope nope');
    await login(t, 'Casey', 'nope nope nope');
    await login(t, '  casey  ', 'nope nope nope');
    expect(t.ctx.users.isLockedNow(u.id)).toBe(true);
    expect((await login(t, 'casey')).r.status).toBe(401);
    expect((await login(t, 'CASEY')).r.status).toBe(401);
  });

  it('unknown usernames (often a mistyped password) are not written to the audit log', async () => {
    const secret = 'My-Secret-Pa55word-typed-into-username';
    const r = await login(t, secret, 'whatever password');
    expect(r.r.status).toBe(401);
    const all = t.auditLines.join('\n') + JSON.stringify(t.ctx.audit.query({ limit: 500 }));
    expect(all).not.toContain(secret);
    expect(all.toLowerCase()).not.toContain(secret.toLowerCase());
    const ev = t.ctx.audit.query({ action: 'auth.login', outcome: 'denied', limit: 5 }).events[0]!;
    expect(ev.username).toBe('unknown');
    expect(ev.detail).toMatch(/^unknown user \(name#[0-9a-f]{12}\)$/);
  });

  it('known usernames are still audited by name', async () => {
    await createUser(t, 'dora', 'viewer');
    await login(t, 'DORA', 'nope nope nope');
    const ev = t.ctx.audit.query({ action: 'auth.login', outcome: 'denied', limit: 1 }).events[0]!;
    expect(ev.username).toBe('dora');
  });
});

describe('security: TOTP verification respects a lock set concurrently', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(testConfig({ local: { lockout: { maxAttempts: 3, windowMinutes: 5 } } }), BIG_LIMITS);
  });
  afterAll(async () => t?.close());

  it('a valid code is refused once the account is locked', async () => {
    const u = await createUser(t, 'totp-lock', 'viewer');
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    t.ctx.users.update(u.id, { totpSecret: secret });
    const { c, r } = await login(t, 'totp-lock', PASSWORD);
    expect(r.json).toEqual({ totpRequired: true });
    // Another request locks the account (e.g. parallel guesses) after this sign-in reached the TOTP step.
    for (let i = 0; i < 3; i++) t.ctx.users.recordFailure(u, 3, 5 * 60_000);
    const v = await c.req('POST', '/api/v1/auth/totp/verify', { code: totpCode(secret) });
    expect(v.status).toBe(401);
  });

  it('the same code used by two parallel sign-ins succeeds only once', async () => {
    const u = await createUser(t, 'totp-race', 'viewer');
    const secret = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';
    t.ctx.users.update(u.id, { totpSecret: secret });
    const a = await login(t, 'totp-race', PASSWORD);
    const b = await login(t, 'totp-race', PASSWORD);
    const code = totpCode(secret);
    const [x, y] = await Promise.all([a.c.req('POST', '/api/v1/auth/totp/verify', { code }), b.c.req('POST', '/api/v1/auth/totp/verify', { code })]);
    expect([x.status, y.status].sort()).toEqual([200, 401]);
  });
});
