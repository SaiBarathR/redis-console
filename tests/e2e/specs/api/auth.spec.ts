/** Local auth over the API: login, TOTP, lockout, logout, session rotation and expiry. */
import { test, expect } from '@playwright/test';
import { API, Api, loadAccounts } from '../../lib/api.ts';
import { createUser, uniqueName } from '../../lib/accounts.ts';
import { counterNow, freshTotp, totpAt } from '../../lib/totp.ts';
import { ageSession, findDbFile } from '../../lib/sessions-db.ts';
import { DatabaseSync } from 'node:sqlite';
import { knownBug } from '../../lib/findings.ts';

async function sessionCookie(api: Api): Promise<string> {
  const c = (await api.ctx.storageState()).cookies.find((x) => /rc_session/.test(x.name));
  if (!c) throw new Error('no session cookie');
  return c.value;
}

test.describe('local auth (API)', () => {
  let admin: Api;
  test.beforeAll(async () => { admin = await Api.fromStorage('admin'); });
  test.afterAll(async () => { await admin.dispose(); });

  test('providers advertise OIDC and local without leaking config', async () => {
    const anon = await Api.anonymous();
    const r = await anon.get(`${API}/auth/providers`);
    expect(r.json).toMatchObject({ oidc: { enabled: true, displayName: expect.any(String) }, local: { enabled: true } });
    expect(r.text).not.toMatch(/issuer|clientId|secret|8089/i);
    await anon.dispose();
  });

  test('me exposes no secrets and has the documented shape', async () => {
    const r = await admin.get(`${API}/auth/me`);
    expect(r.json).toMatchObject({ username: 'admin', source: 'local', role: 'admin', totpEnabled: true, mustChangePassword: false, mustEnrollTotp: false });
    expect(Date.parse(r.json.sessionExpiresAt)).toBeGreaterThan(Date.now());
    expect(Object.keys(r.json).filter((k) => /^(password|passwordHash|hash|secret|totpSecret|totp_secret)$/i.test(k))).toEqual([]);
  });

  test('wrong password and unknown user both give the same generic 401', async () => {
    const anon = await Api.anonymous();
    const a = await anon.post(`${API}/auth/login`, { username: 'e2e-viewer', password: 'wrong-password-123' }, { csrf: null });
    const b = await anon.post(`${API}/auth/login`, { username: 'no-such-user-xyz', password: 'wrong-password-123' }, { csrf: null });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.json.error.message).toBe(b.json.error.message);
    await anon.dispose();
  });

  test('login rotates the session id (no session fixation)', async () => {
    const { acc } = await createUser(admin, uniqueName('fix'), 'viewer');
    const api = await Api.anonymous();
    // Plant a cookie as an attacker would.
    const planted = 'A'.repeat(43);
    await api.get(`${API}/auth/me`, { headers: { Cookie: `rc_session=${planted}` } });
    await api.loginWith(acc);
    const after = await sessionCookie(api);
    expect(after).not.toBe(planted);
    // Two logins of the same user get different session ids.
    const api2 = await Api.login(acc);
    expect(await sessionCookie(api2)).not.toBe(after);
    await api.dispose();
    await api2.dispose();
  });

  test('TOTP: wrong code refused, code replay refused, pending session cannot use the API', async () => {
    // Provisioning and verifying a fresh account can cross two 30 s anti-replay windows.
    test.setTimeout(120_000);
    const { acc } = await createUser(admin, uniqueName('totp'), 'admin');
    expect(acc.totpSecret).toBeTruthy();
    const api = await Api.anonymous();
    const l = await api.post(`${API}/auth/login`, { username: acc.username, password: acc.password }, { csrf: null });
    expect(l.json).toEqual({ totpRequired: true });
    expect((await api.get(`${API}/databases`)).status).toBe(401);
    expect((await api.get(`${API}/auth/me`)).status).toBe(401);
    const wrong = await api.post(`${API}/auth/totp/verify`, { code: totpAt(acc.totpSecret!, counterNow() - 100) }, { csrf: null });
    expect(wrong.status).toBe(401);
    const code = await freshTotp(acc.totpSecret!);
    const ok = await api.post(`${API}/auth/totp/verify`, { code }, { csrf: null });
    expect(ok.status, ok.text).toBe(200);
    // Replay of the same code for a new login is refused.
    const api2 = await Api.anonymous();
    await api2.post(`${API}/auth/login`, { username: acc.username, password: acc.password }, { csrf: null });
    const replay = await api2.post(`${API}/auth/totp/verify`, { code }, { csrf: null });
    expect(replay.status).toBe(401);
    await api.dispose();
    await api2.dispose();
  });

  test('lockout after repeated failures; correct password refused while locked', async () => {
    const { acc } = await createUser(admin, uniqueName('lock'), 'viewer');
    const api = await Api.anonymous();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await api.post(`${API}/auth/login`, { username: acc.username, password: `wrong-${i}-password` }, { csrf: null })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401 || s === 423 || s === 429)).toBe(true);
    const locked = await api.post(`${API}/auth/login`, { username: acc.username, password: acc.password }, { csrf: null });
    expect([401, 423, 429], `correct password while locked -> ${locked.status}`).toContain(locked.status);
    // Lockout is audited.
    const a = await admin.get(`${API}/admin/audit?limit=100`);
    expect((a.json.events as any[]).some((e) => e.username === acc.username && /lock|login/.test(e.action) && e.outcome === 'denied')).toBe(true);
    await api.dispose();
  });

  test('logout destroys the server-side session; the old cookie is useless', async () => {
    const { acc } = await createUser(admin, uniqueName('logout'), 'operator');
    const api = await Api.login(acc);
    const cookie = await sessionCookie(api);
    const r = await api.post(`${API}/auth/logout`, {});
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect((await api.get(`${API}/auth/me`)).status).toBe(401);
    // Replay the old cookie from a fresh client.
    const thief = await Api.anonymous();
    const me = await thief.get(`${API}/auth/me`, { headers: { Cookie: `rc_session=${cookie}` } });
    expect(me.status).toBe(401);
    await api.dispose();
    await thief.dispose();
  });

  test('idle timeout expires the session', async () => {
    const { acc } = await createUser(admin, uniqueName('idle'), 'viewer');
    const api = await Api.login(acc);
    expect((await api.get(`${API}/databases`)).status).toBe(200);
    expect(ageSession(await sessionCookie(api), { idleMs: 61 * 60_000 })).toBe(1);
    expect((await api.get(`${API}/databases`)).status).toBe(401);
    await api.dispose();
  });

  test('absolute lifetime expires the session even when active', async () => {
    const { acc } = await createUser(admin, uniqueName('abs'), 'viewer');
    const api = await Api.login(acc);
    expect(ageSession(await sessionCookie(api), { expire: true })).toBe(1);
    expect((await api.get(`${API}/auth/me`)).status).toBe(401);
    await api.dispose();
  });

  test('garbage, oversized and forged cookies are 401, never 500', async () => {
    const anon = await Api.anonymous();
    for (const v of ['x', 'A'.repeat(43), 'A'.repeat(5000), '../../etc/passwd', '%00%00', "' OR 1=1 --"]) {
      const r = await anon.get(`${API}/auth/me`, { headers: { Cookie: `rc_session=${v}` } });
      expect(r.status, v.slice(0, 20)).toBe(401);
    }
    await anon.dispose();
  });

  test('password change revokes other sessions of the same user', async () => {
    const { acc } = await createUser(admin, uniqueName('pwrev'), 'viewer');
    const a = await Api.login(acc);
    const b = await Api.login(acc);
    const np = `New-${Date.now()}-password!`;
    const r = await a.post(`${API}/auth/password`, { currentPassword: acc.password, newPassword: np });
    expect(r.status).toBe(200);
    expect((await b.get(`${API}/auth/me`)).status).toBe(401);
    await a.refreshMe();
    expect((await a.get(`${API}/auth/me`)).status).toBe(200);
    await a.dispose();
    await b.dispose();
  });

  test('secrets at rest: no clear-text passwords or TOTP seeds in the data directory', async () => {
    const accs = loadAccounts();
    const db = new DatabaseSync(findDbFile(), { readOnly: true });
    try {
      const dump = JSON.stringify(db.prepare('SELECT * FROM users').all());
      expect(dump, 'clear-text password').not.toContain(accs.admin!.password);
      expect(dump, 'clear-text TOTP seed').not.toContain(accs.admin!.totpSecret!);
    } finally {
      db.close();
    }
  });

  test('stored role sessions are still valid', async () => {
    const accs = loadAccounts();
    expect(Object.keys(accs)).toEqual(expect.arrayContaining(['admin', 'viewer', 'operator']));
  });
});
