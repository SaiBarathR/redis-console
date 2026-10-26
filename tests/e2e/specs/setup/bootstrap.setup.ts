/**
 * Setup project: bootstraps the local admin (forced password change + TOTP enrollment,
 * asserted along the way) and provisions one account per role. Saves cookies to
 * .state/storage-<key>.json and credentials to .state/accounts.json (gitignored).
 */
import { test, expect } from '@playwright/test';
import { API, Api, saveAccount, type Account } from '../../lib/api.ts';
import { createUser, newPassword } from '../../lib/accounts.ts';
import { envVar } from '../../lib/env.ts';
import { freshTotp, totpAt, counterNow } from '../../lib/totp.ts';
import { registerExtraSecret } from '../../lib/leak.ts';

test.describe.configure({ mode: 'serial' });

test('bootstrap admin: forced password change, then forced TOTP enrollment, then full access', async () => {
  const acc: Account = { username: 'admin', password: envVar('BOOTSTRAP_ADMIN_PASSWORD'), role: 'admin' };
  const api = await Api.anonymous();

  expect((await api.get(`${API}/auth/me`)).status).toBe(401);
  expect((await api.get(`${API}/databases`)).status).toBe(401);

  const login = await api.post(`${API}/auth/login`, { username: acc.username, password: acc.password }, { csrf: null });
  expect(login.status, login.text).toBe(200);
  expect(login.json.me, 'bootstrap admin login returns me (no TOTP enrolled yet)').toBeTruthy();
  expect(login.json.me.mustChangePassword).toBe(true);
  await api.refreshMe();
  const csrf1 = api.csrf;
  expect(csrf1.length).toBeGreaterThanOrEqual(16);

  // Everything except the auth endpoints is refused until onboarding is finished.
  expect((await api.get(`${API}/databases`)).status).toBe(403);
  // Validation: too short.
  expect((await api.post(`${API}/auth/password`, { currentPassword: acc.password, newPassword: 'short' })).status).toBe(400);
  // Wrong current password.
  const wrong = await api.post(`${API}/auth/password`, { currentPassword: 'definitely-wrong-password', newPassword: 'Another-long-password-1!' });
  expect(wrong.status).toBeGreaterThanOrEqual(400);
  expect(wrong.status).toBeLessThan(500);

  // Change password.
  const np = newPassword();
  registerExtraSecret('password:admin', np);
  const ch = await api.post(`${API}/auth/password`, { currentPassword: acc.password, newPassword: np });
  expect(ch.status, ch.text).toBe(200);
  acc.password = np;
  expect(ch.json.me.mustChangePassword).toBe(false);
  expect(ch.json.me.mustEnrollTotp, 'admin role requires TOTP').toBe(true);
  expect(ch.json.me.csrfToken, 'session (and CSRF token) rotated on password change').not.toBe(csrf1);
  await api.refreshMe();
  expect((await api.get(`${API}/databases`)).status).toBe(403);

  // Enroll TOTP.
  const en = await api.post(`${API}/auth/totp/enroll`, {});
  expect(en.status, en.text).toBe(200);
  expect(en.json.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
  expect(en.json.secretBase32).toMatch(/^[A-Z2-7]+=*$/);
  acc.totpSecret = en.json.secretBase32;
  registerExtraSecret('totp:admin', acc.totpSecret!);
  // A wrong code is refused (use a code from an hour ago).
  const bad = await api.post(`${API}/auth/totp/confirm`, { code: totpAt(acc.totpSecret!, counterNow() - 120) });
  expect(bad.status).toBeGreaterThanOrEqual(400);
  const ok = await api.post(`${API}/auth/totp/confirm`, { code: await freshTotp(acc.totpSecret!) });
  expect(ok.status, ok.text).toBe(200);
  expect(ok.json.me.mustEnrollTotp).toBe(false);
  expect(ok.json.me.totpEnabled).toBe(true);
  await api.refreshMe();
  expect((await api.get(`${API}/databases`)).status).toBe(200);
  saveAccount('admin', acc);

  // Logging in again now requires a TOTP code.
  const api2 = await Api.anonymous();
  const l2 = await api2.post(`${API}/auth/login`, { username: acc.username, password: acc.password }, { csrf: null });
  expect(l2.status).toBe(200);
  expect(l2.json).toEqual({ totpRequired: true });
  expect((await api2.get(`${API}/databases`)).status).toBe(401);
  const v = await api2.post(`${API}/auth/totp/verify`, { code: await freshTotp(acc.totpSecret!) }, { csrf: null });
  expect(v.status, v.text).toBe(200);
  await api2.refreshMe();
  expect(api2.me.role).toBe('admin');
  await api2.saveStorage('admin');
  await api.dispose();
  await api2.dispose();
});

test('provision one local account per role', async () => {
  const admin = await Api.fromStorage('admin');
  const { api: viewer } = await createUser(admin, 'e2e-viewer', 'viewer', { save: 'viewer' });
  const { api: operator } = await createUser(admin, 'e2e-operator', 'operator', { save: 'operator' });
  const { api: admin2 } = await createUser(admin, 'e2e-admin2', 'admin', { save: 'admin2' });
  expect(viewer!.me.role).toBe('viewer');
  expect(operator!.me.role).toBe('operator');
  expect(admin2!.me.role).toBe('admin');
  expect(admin2!.me.totpEnabled).toBe(true);
  for (const a of [admin, viewer!, operator!, admin2!]) await a.dispose();
});
