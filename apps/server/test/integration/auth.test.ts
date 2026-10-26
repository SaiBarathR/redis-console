import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../../src/security/totp.ts';
import { anonymous, clientFor, startApp, testConfig, userSession, type TestApp } from '../helpers.ts';
import { createUser, login, PASSWORD, setCookies } from './auth-helpers.ts';

const BIG_LIMITS = { loginLimits: { perIpPerSecond: 1000, perIpBurst: 1000 } };
const GENERIC = 'Invalid username or password, or the account is temporarily locked.';

describe('auth: providers, me, local login', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(testConfig({ local: { lockout: { maxAttempts: 3, windowMinutes: 1 } } }), BIG_LIMITS);
  });
  afterAll(async () => t?.close());

  it('lists providers without a session', async () => {
    const r = await anonymous(t).req('GET', '/api/v1/auth/providers');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ oidc: { enabled: false, displayName: '' }, local: { enabled: true } });
  });

  it('me is 401 when anonymous', async () => {
    const r = await anonymous(t).req('GET', '/api/v1/auth/me');
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('unauthenticated');
  });

  it('logs in and sets a HttpOnly SameSite=Strict session cookie', async () => {
    await createUser(t, 'alice', 'operator');
    const { c, r } = await login(t, 'alice');
    expect(r.status).toBe(200);
    expect(r.json.me).toMatchObject({ username: 'alice', role: 'operator', source: 'local', totpEnabled: false, mustChangePassword: false, mustEnrollTotp: false });
    expect(r.json.me.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const cookie = setCookies(r.headers).find((s) => s.startsWith('rc_session='))!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
    const me = await c.req('GET', '/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.json.username).toBe('alice');
    expect(new Date(me.json.sessionExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('wrong password and unknown user give the same generic 401', async () => {
    await createUser(t, 'bob', 'viewer');
    const a = await login(t, 'bob', 'wrong password!!');
    const b = await login(t, 'nobody-here', 'wrong password!!');
    expect(a.r.status).toBe(401);
    expect(b.r.status).toBe(401);
    expect(a.r.json.error.message).toBe(GENERIC);
    expect(b.r.json.error.message).toBe(GENERIC);
    expect(setCookies(a.r.headers)).toHaveLength(0);
  });

  it('locks the account after maxAttempts failures, even for the right password', async () => {
    const u = await createUser(t, 'carol', 'viewer');
    for (let i = 0; i < 3; i++) expect((await login(t, 'carol', 'nope nope nope')).r.status).toBe(401);
    const locked = await login(t, 'carol');
    expect(locked.r.status).toBe(401);
    expect(locked.r.json.error.message).toBe(GENERIC);
    t.ctx.users.resetFailures(u.id);
    expect((await login(t, 'carol')).r.status).toBe(200);
  });

  it('rejects login without an allowed Origin (CSRF)', async () => {
    await createUser(t, 'dave', 'viewer');
    const c = anonymous(t);
    const r1 = await c.req('POST', '/api/v1/auth/login', { username: 'dave', password: PASSWORD }, { origin: 'https://evil.example' });
    expect(r1.status).toBe(403);
    expect(r1.json.error.code).toBe('csrf');
    const r2 = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'dave', password: PASSWORD } });
    expect(r2.statusCode).toBe(403);
  });

  it('rejects unknown body fields', async () => {
    const r = await anonymous(t).req('POST', '/api/v1/auth/login', { username: 'dave', password: PASSWORD, admin: true });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('validation');
  });

  it('replaces an existing session on login (no fixation)', async () => {
    await createUser(t, 'erin', 'viewer');
    const first = await login(t, 'erin');
    const oldCookie = first.c.cookie;
    const second = await login(t, 'erin', PASSWORD, first.c);
    expect(second.r.status).toBe(200);
    expect(second.c.cookie).not.toBe(oldCookie);
    const stale = clientFor(t.app, 'rc_session', oldCookie.split('=')[1]!, '');
    expect((await stale.req('GET', '/api/v1/auth/me')).status).toBe(401);
    expect((await second.c.req('GET', '/api/v1/auth/me')).status).toBe(200);
  });

  it('logout destroys the session and clears the cookie', async () => {
    await createUser(t, 'frank', 'viewer');
    const { c } = await login(t, 'frank');
    const oldCookie = c.cookie;
    const noCsrf = await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: c.cookie, origin: 'http://localhost:4100' } });
    expect(noCsrf.statusCode).toBe(403);
    const r = await c.req('POST', '/api/v1/auth/logout');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(setCookies(r.headers).some((s) => s.startsWith('rc_session=;') && s.includes('Max-Age=0'))).toBe(true);
    const stale = clientFor(t.app, 'rc_session', oldCookie.split('=')[1]!, '');
    expect((await stale.req('GET', '/api/v1/auth/me')).status).toBe(401);
  });

  it('expires idle and absolute sessions', async () => {
    const idle = await userSession(t, 'viewer');
    const abs = await userSession(t, 'viewer');
    const now = Date.now();
    t.ctx.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE user_id = ?').run(now - 31 * 60_000, idle.userId);
    t.ctx.db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(now - 1, abs.userId);
    expect((await idle.req('GET', '/api/v1/auth/me')).status).toBe(401);
    expect((await abs.req('GET', '/api/v1/auth/me')).status).toBe(401);
    // Expired rows are removed on access.
    const n = t.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id IN (?, ?)').get(idle.userId, abs.userId) as { n: number };
    expect(n.n).toBe(0);
  });

  it('stores only a hash of the session id', async () => {
    const c = await userSession(t, 'viewer');
    const raw = c.cookie.split('=')[1]!;
    const rows = t.ctx.db.prepare('SELECT id_hash FROM sessions').all() as { id_hash: string }[];
    expect(rows.some((r) => r.id_hash === raw)).toBe(false);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.id_hash))).toBe(true);
  });

  it('kicks out disabled users on the next request', async () => {
    const c = await userSession(t, 'operator');
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(200);
    t.ctx.users.update(c.userId, { disabled: true });
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(401);
    t.ctx.users.update(c.userId, { disabled: false });
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(401); // session is gone
  });

  it('disabled users cannot log in', async () => {
    const u = await createUser(t, 'gina', 'viewer');
    t.ctx.users.update(u.id, { disabled: true });
    const r = await login(t, 'gina');
    expect(r.r.status).toBe(401);
    expect(r.r.json.error.message).toBe(GENERIC);
  });
});

describe('auth: login rate limit', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(testConfig(), { loginLimits: { perIpPerSecond: 0.001, perIpBurst: 3 } });
  });
  afterAll(async () => t?.close());

  it('returns 429 after the per-IP burst', async () => {
    await createUser(t, 'henry', 'viewer');
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await login(t, 'henry', 'bad password here')).r.status);
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    expect((await login(t, 'henry')).r.json.error.code).toBe('rate_limited');
  });
});

describe('auth: TOTP', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(testConfig(), BIG_LIMITS);
  });
  afterAll(async () => t?.close());

  async function enroll(username: string) {
    await createUser(t, username, 'operator');
    const { c } = await login(t, username);
    const e = await c.req('POST', '/api/v1/auth/totp/enroll', {});
    expect(e.status).toBe(200);
    expect(e.json.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Redis%20Console%3A/);
    const secret: string = e.json.secretBase32;
    const bad = await c.req('POST', '/api/v1/auth/totp/confirm', { code: totpCode(secret, Date.now() - 3600_000) });
    expect(bad.status).toBe(400);
    const cookieBefore = c.cookie;
    const ok = await c.req('POST', '/api/v1/auth/totp/confirm', { code: totpCode(secret) });
    expect(ok.status).toBe(200);
    expect(ok.json.me.totpEnabled).toBe(true);
    expect(c.cookie).not.toBe(cookieBefore); // rotated
    // Already enabled: re-enrollment refused.
    expect((await c.req('POST', '/api/v1/auth/totp/enroll', {})).status).toBe(403);
    return { c, secret };
  }

  it('requires a second factor after enrollment, with a pending session that cannot use the API', async () => {
    const { secret } = await enroll('ivy');
    const { c, r } = await login(t, 'ivy');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ totpRequired: true });
    expect(c.cookie).toMatch(/^rc_session=/);
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(401);
    expect((await c.req('GET', '/api/v1/databases')).status).toBe(401);
    const wrong = await c.req('POST', '/api/v1/auth/totp/verify', { code: totpCode(secret, Date.now() - 3600_000) });
    expect(wrong.status).toBe(401);
    const pendingCookie = c.cookie;
    // The enrollment consumed the current step; the next step is inside the ±1 window.
    const code = totpCode(secret, Date.now() + 30_000);
    const ok = await c.req('POST', '/api/v1/auth/totp/verify', { code });
    expect(ok.status).toBe(200);
    expect(ok.json.me.username).toBe('ivy');
    expect(c.cookie).not.toBe(pendingCookie);
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(200);

    // Replay of the same code on a fresh login is refused.
    const again = await login(t, 'ivy');
    expect(again.r.json).toEqual({ totpRequired: true });
    const replay = await again.c.req('POST', '/api/v1/auth/totp/verify', { code });
    expect(replay.status).toBe(401);
  });

  it('verify without a pending session is 401', async () => {
    const r = await anonymous(t).req('POST', '/api/v1/auth/totp/verify', { code: '123456' });
    expect(r.status).toBe(401);
  });

  it('OIDC sessions cannot manage local TOTP/password', async () => {
    const { oidcSession } = await import('../helpers.ts');
    const c = oidcSession(t, 'admin');
    expect((await c.req('POST', '/api/v1/auth/totp/enroll', {})).status).toBe(403);
    expect((await c.req('POST', '/api/v1/auth/password', { currentPassword: 'x', newPassword: 'y'.repeat(16) })).status).toBe(403);
  });
});

describe('auth: requireTotpForRoles', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(testConfig({ local: { requireTotpForRoles: ['admin'] } }), BIG_LIMITS);
  });
  afterAll(async () => t?.close());

  it('admin without TOTP must enroll before anything else', async () => {
    await createUser(t, 'jack', 'admin');
    const { c, r } = await login(t, 'jack');
    expect(r.status).toBe(200);
    expect(r.json.me.mustEnrollTotp).toBe(true);
    for (const [m, u] of [['GET', '/api/v1/databases'], ['GET', '/api/v1/admin/users'], ['GET', '/api/v1/databases/e2e/overview']] as const) {
      const x = await c.req(m, u);
      expect(x.status).toBe(403);
      expect(x.json.error.hint).toBe('totp_enrollment_required');
    }
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(200);
    const e = await c.req('POST', '/api/v1/auth/totp/enroll', {});
    const ok = await c.req('POST', '/api/v1/auth/totp/confirm', { code: totpCode(e.json.secretBase32) });
    expect(ok.json.me.mustEnrollTotp).toBe(false);
    expect((await c.req('GET', '/api/v1/admin/users')).status).toBe(200);
  });

  it('roles not in the list are not forced', async () => {
    await createUser(t, 'kate', 'operator');
    const { c, r } = await login(t, 'kate');
    expect(r.json.me.mustEnrollTotp).toBe(false);
    expect((await c.req('GET', '/api/v1/admin/audit')).status).toBe(403); // role gate, not TOTP
  });
});

describe('auth: bootstrap admin and password change', () => {
  let t: TestApp;
  const BOOT = 'Bootstrap-Password-For-Tests-1';
  beforeAll(async () => {
    process.env.RC_TEST_BOOTSTRAP_PW = BOOT;
    t = await startApp(
      testConfig({ local: { requireTotpForRoles: ['admin'], bootstrapAdmin: { username: 'root', password: { env: 'RC_TEST_BOOTSTRAP_PW' } } } }),
      BIG_LIMITS,
    );
  });
  afterAll(async () => t?.close());

  it('creates the bootstrap admin with mustChangePassword and walks the forced flow', async () => {
    const u = t.ctx.users.byUsername('root')!;
    expect(u.role).toBe('admin');
    expect(u.mustChangePassword).toBe(true);
    expect(t.auditLines.some((l) => l.includes('admin.user.bootstrap'))).toBe(true);

    const { c, r } = await login(t, 'root', BOOT);
    expect(r.status).toBe(200);
    expect(r.json.me).toMatchObject({ mustChangePassword: true, mustEnrollTotp: true });
    const blocked = await c.req('GET', '/api/v1/databases');
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.hint).toBe('password_change_required');
    // TOTP enrollment comes after the password change.
    expect((await c.req('POST', '/api/v1/auth/totp/enroll', {})).json.error.hint).toBe('password_change_required');

    // A second session of the same user, to verify revocation.
    const other = (await login(t, 'root', BOOT)).c;
    expect((await other.req('GET', '/api/v1/auth/me')).status).toBe(200);

    expect((await c.req('POST', '/api/v1/auth/password', { currentPassword: 'not the password', newPassword: 'Another-long-password-1' })).status).toBe(403);
    expect((await c.req('POST', '/api/v1/auth/password', { currentPassword: BOOT, newPassword: 'short' })).status).toBe(400);
    expect((await c.req('POST', '/api/v1/auth/password', { currentPassword: BOOT, newPassword: BOOT })).status).toBe(400);
    expect((await c.req('POST', '/api/v1/auth/password', { currentPassword: BOOT, newPassword: 'my-root-password-123' })).status).toBe(400); // contains username

    const oldCookie = c.cookie, oldCsrf = c.csrf;
    const ok = await c.req('POST', '/api/v1/auth/password', { currentPassword: BOOT, newPassword: 'A-brand-new-passphrase-42' });
    expect(ok.status).toBe(200);
    expect(ok.json.me.mustChangePassword).toBe(false);
    expect(ok.json.me.mustEnrollTotp).toBe(true);
    expect(c.cookie).not.toBe(oldCookie);
    expect(c.csrf).not.toBe(oldCsrf);
    expect((await clientFor(t.app, 'rc_session', oldCookie.split('=')[1]!, oldCsrf).req('GET', '/api/v1/auth/me')).status).toBe(401);
    expect((await other.req('GET', '/api/v1/auth/me')).status).toBe(401);

    // Still restricted until TOTP enrollment.
    expect((await c.req('GET', '/api/v1/databases')).json.error.hint).toBe('totp_enrollment_required');
    const e = await c.req('POST', '/api/v1/auth/totp/enroll', {});
    expect((await c.req('POST', '/api/v1/auth/totp/confirm', { code: totpCode(e.json.secretBase32) })).status).toBe(200);
    expect((await c.req('GET', '/api/v1/databases')).status).toBe(200);

    // The old password no longer works; the new one does (TOTP now required).
    expect((await login(t, 'root', BOOT)).r.status).toBe(401);
    expect((await login(t, 'root', 'A-brand-new-passphrase-42')).r.json).toEqual({ totpRequired: true });
  });

  it('does not recreate the bootstrap admin when users exist', async () => {
    expect(t.ctx.users.list().filter((u) => u.username === 'root')).toHaveLength(1);
  });
});

describe('health', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });

  it('healthz and readyz', async () => {
    const h = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(h.statusCode).toBe(200);
    expect(h.json()).toEqual({ status: 'ok' });
    expect(h.headers['cache-control']).toBe('no-store');
    const r = await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ready', checks: { storage: 'ok', accepting: 'ok' } });
    t.ctx.state.shuttingDown = true;
    const r2 = await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(r2.statusCode).toBe(503);
    expect(r2.json().status).toBe('not_ready');
    await t.close();
  });
});
