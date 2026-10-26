import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../../src/security/totp.ts';
import { oidcSession, startApp, testConfig, userSession, type TestApp } from '../helpers.ts';
import { createUser, login } from './auth-helpers.ts';

const LIMITS = { loginLimits: { perIpPerSecond: 1000, perIpBurst: 1000 } };

describe('admin: audit log', () => {
  let t: TestApp;
  const SECRET_PW = 'Very-Secret-Password-Do-Not-Log-77';
  beforeAll(async () => {
    t = await startApp(testConfig(), LIMITS);
  });
  afterAll(async () => t?.close());

  it('is admin only', async () => {
    for (const role of ['viewer', 'operator'] as const) {
      const c = await userSession(t, role);
      const r = await c.req('GET', '/api/v1/admin/audit');
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe('forbidden');
    }
  });

  it('records auth events without secrets, with filters and pagination', async () => {
    await createUser(t, 'auditee', 'viewer', { password: SECRET_PW });
    const ok = await login(t, 'auditee', SECRET_PW);
    expect(ok.r.status).toBe(200);
    for (let i = 0; i < 3; i++) await login(t, 'auditee', `${SECRET_PW}-wrong`);
    const sessionId = ok.c.cookie.split('=')[1]!;
    const csrf = ok.c.csrf;

    const admin = await userSession(t, 'admin');
    const all = await admin.req('GET', '/api/v1/admin/audit?limit=500');
    expect(all.status).toBe(200);
    const text = JSON.stringify(all.json) + t.auditLines.join('');
    for (const secret of [SECRET_PW, sessionId, csrf]) expect(text).not.toContain(secret);

    const mine = await admin.req('GET', '/api/v1/admin/audit?user=auditee&action=auth.login');
    expect(mine.json.events.length).toBe(4);
    expect(mine.json.events.every((e: any) => e.username === 'auditee' && e.action === 'auth.login')).toBe(true);
    const denied = await admin.req('GET', '/api/v1/admin/audit?user=auditee&outcome=denied');
    expect(denied.json.events).toHaveLength(3);
    expect(denied.json.events[0]).toMatchObject({ outcome: 'denied', ip: '127.0.0.1' });
    expect(typeof denied.json.events[0].at).toBe('string');

    // Pagination: newest first, nextBefore cursor.
    const p1 = await admin.req('GET', '/api/v1/admin/audit?user=auditee&limit=2');
    expect(p1.json.events).toHaveLength(2);
    expect(p1.json.nextBefore).toBe(p1.json.events[1].id);
    const p2 = await admin.req('GET', `/api/v1/admin/audit?user=auditee&limit=2&before=${p1.json.nextBefore}`);
    expect(p2.json.events).toHaveLength(2);
    expect(Number(p2.json.events[0].id)).toBeLessThan(Number(p1.json.events[1].id));
    expect(p2.json.nextBefore).toBeUndefined();

    // Stdout JSON lines carry `audit: true`.
    const line = JSON.parse(t.auditLines.find((l) => l.includes('"auditee"'))!);
    expect(line.audit).toBe(true);
  });

  it('filters by database and records command audits with redacted argv', async () => {
    const op = await userSession(t, 'operator');
    const r = await op.req('POST', '/api/v1/databases/e2e/cli', { line: 'ECHO "a value that must never be logged"' });
    expect(r.status).toBe(200);
    const admin = await userSession(t, 'admin');
    const a = await admin.req('GET', `/api/v1/admin/audit?database=e2e&user=${op.username}`);
    expect(a.json.events[0]).toMatchObject({ action: 'cli.exec', databaseId: 'e2e', command: 'ECHO', outcome: 'allowed' });
    expect(a.json.events[0].argvRedacted).toEqual(['ECHO', '<33 bytes>']);
    expect(JSON.stringify(a.json) + t.auditLines.join('')).not.toContain('must never be logged');
  });

  it('validates the query', async () => {
    const admin = await userSession(t, 'admin');
    expect((await admin.req('GET', '/api/v1/admin/audit?limit=5000')).status).toBe(400);
    expect((await admin.req('GET', '/api/v1/admin/audit?outcome=maybe')).status).toBe(400);
  });

  it('the audit table is append-only', () => {
    expect(() => t.ctx.db.prepare('DELETE FROM audit').run()).toThrow(/append-only/);
    expect(() => t.ctx.db.prepare("UPDATE audit SET outcome = 'allowed'").run()).toThrow(/append-only/);
  });
});

describe('admin: local users', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(testConfig(), LIMITS);
  });
  afterAll(async () => t?.close());

  it('non-admins get 403', async () => {
    const c = await userSession(t, 'operator');
    expect((await c.req('GET', '/api/v1/admin/users')).status).toBe(403);
    expect((await c.req('POST', '/api/v1/admin/users', { username: 'x-user', displayName: 'X', role: 'viewer', initialPassword: 'a'.repeat(20) })).status).toBe(403);
  });

  it('creates, lists and validates users', async () => {
    const admin = await userSession(t, 'admin');
    const body = { username: 'new.user', displayName: 'New User', role: 'operator', initialPassword: 'An-initial-password-1' };
    const r = await admin.req('POST', '/api/v1/admin/users', body);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ username: 'new.user', role: 'operator', disabled: false, totpEnabled: false });
    expect(r.json).not.toHaveProperty('passwordHash');
    expect(t.ctx.users.byUsername('new.user')!.mustChangePassword).toBe(true);
    expect((await admin.req('POST', '/api/v1/admin/users', body)).status).toBe(400); // duplicate
    expect((await admin.req('POST', '/api/v1/admin/users', { ...body, username: 'other.user', initialPassword: 'short' })).status).toBe(400);
    expect((await admin.req('POST', '/api/v1/admin/users', { ...body, username: 'other.user', isAdmin: true })).status).toBe(400);
    expect((await admin.req('POST', '/api/v1/admin/users', { ...body, username: 'bad user!' })).status).toBe(400);
    const list = await admin.req('GET', '/api/v1/admin/users');
    expect(list.status).toBe(200);
    expect(list.json.users.map((u: any) => u.username)).toContain('new.user');
    expect(JSON.stringify(list.json)).not.toMatch(/argon2|password/i);

    // The created user must change the initial password.
    const { c, r: lr } = await login(t, 'new.user', 'An-initial-password-1');
    expect(lr.json.me.mustChangePassword).toBe(true);
    expect((await c.req('GET', '/api/v1/databases')).status).toBe(403);
  });

  it('role change and disable revoke the target user sessions', async () => {
    const admin = await userSession(t, 'admin');
    const target = await userSession(t, 'operator');
    const target2 = await userSession(t, 'viewer');
    const r = await admin.req('PATCH', `/api/v1/admin/users/${target.userId}`, { role: 'viewer' });
    expect(r.status).toBe(200);
    expect(r.json.role).toBe('viewer');
    expect((await target.req('GET', '/api/v1/auth/me')).status).toBe(401);
    const d = await admin.req('PATCH', `/api/v1/admin/users/${target2.userId}`, { disabled: true });
    expect(d.json.disabled).toBe(true);
    expect((await target2.req('GET', '/api/v1/auth/me')).status).toBe(401);
    // Display name changes do not revoke.
    const target3 = await userSession(t, 'viewer');
    expect((await admin.req('PATCH', `/api/v1/admin/users/${target3.userId}`, { displayName: 'Renamed' })).json.displayName).toBe('Renamed');
    expect((await target3.req('GET', '/api/v1/auth/me')).status).toBe(200);
  });

  it('resetTotp and newPassword', async () => {
    const admin = await userSession(t, 'admin');
    await createUser(t, 'totp.user', 'operator');
    const { c } = await login(t, 'totp.user');
    const e = await c.req('POST', '/api/v1/auth/totp/enroll', {});
    await c.req('POST', '/api/v1/auth/totp/confirm', { code: totpCode(e.json.secretBase32) });
    const u = t.ctx.users.byUsername('totp.user')!;
    expect(u.totpSecret).toBeTruthy();
    const r = await admin.req('PATCH', `/api/v1/admin/users/${u.id}`, { resetTotp: true });
    expect(r.json.totpEnabled).toBe(false);
    expect((await c.req('GET', '/api/v1/auth/me')).status).toBe(401);
    expect((await admin.req('PATCH', `/api/v1/admin/users/${u.id}`, { newPassword: 'short' })).status).toBe(400);
    expect((await admin.req('PATCH', `/api/v1/admin/users/${u.id}`, { newPassword: 'Reset-by-admin-password-9' })).status).toBe(200);
    const lr = await login(t, 'totp.user', 'Reset-by-admin-password-9');
    expect(lr.r.json.me.mustChangePassword).toBe(true);
    expect((await admin.req('PATCH', '/api/v1/admin/users/local:nope', { displayName: 'x' })).status).toBe(404);
    expect((await admin.req('PATCH', `/api/v1/admin/users/${u.id}`, { role: 'root' })).status).toBe(400);
  });

  it('admins cannot change their own role or disable themselves', async () => {
    const admin = await userSession(t, 'admin');
    expect((await admin.req('PATCH', `/api/v1/admin/users/${admin.userId}`, { role: 'viewer' })).status).toBe(403);
    expect((await admin.req('PATCH', `/api/v1/admin/users/${admin.userId}`, { disabled: true })).status).toBe(403);
    expect((await admin.req('PATCH', `/api/v1/admin/users/${admin.userId}`, { displayName: 'Me' })).status).toBe(200);
  });

  it('requires the CSRF token on PATCH', async () => {
    const admin = await userSession(t, 'admin');
    const target = await userSession(t, 'viewer');
    const r = await t.app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${target.userId}`, headers: { cookie: admin.cookie, origin: 'http://localhost:4100', 'x-csrf-token': 'nope' }, payload: { disabled: true } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('csrf');
    const r3 = await t.app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${target.userId}`, headers: { cookie: admin.cookie, origin: 'https://evil.example', 'x-csrf-token': admin.csrf }, payload: { disabled: true } });
    expect(r3.statusCode).toBe(403);
    const r2 = await t.app.inject({ method: 'PATCH', url: `/api/v1/admin/users/${target.userId}`, headers: { cookie: admin.cookie, origin: 'http://localhost:4100' }, payload: { disabled: true } });
    expect(r2.statusCode).toBe(403);
    expect(t.ctx.users.byId(target.userId)!.disabled).toBe(false);
  });
});

describe('admin: last local admin', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(testConfig(), LIMITS);
  });
  afterAll(async () => t?.close());

  it('cannot demote or disable the last enabled local admin', async () => {
    const only = await createUser(t, 'sole.admin', 'admin');
    const sso = oidcSession(t, 'admin');
    const r = await sso.req('PATCH', `/api/v1/admin/users/${only.id}`, { role: 'operator' });
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/last enabled local admin/);
    expect((await sso.req('PATCH', `/api/v1/admin/users/${only.id}`, { disabled: true })).status).toBe(403);
    await createUser(t, 'second.admin', 'admin');
    expect((await sso.req('PATCH', `/api/v1/admin/users/${only.id}`, { role: 'operator' })).status).toBe(200);
  });
});
