/** Provisioning helpers for local test accounts. */
import { randomBytes } from 'node:crypto';
import { expect } from '@playwright/test';
import { API, Api, loadAccounts, saveAccount, type Account } from './api.ts';
import { registerExtraSecret } from './leak.ts';
import { freshTotp } from './totp.ts';

export const newPassword = () => `E2e-${randomBytes(12).toString('base64url')}!`;

/** Handles forced password change and forced TOTP enrollment after a login. Mutates `acc`. */
export async function completeOnboarding(api: Api, acc: Account): Promise<void> {
  if (api.me?.mustChangePassword) {
    const np = newPassword();
    registerExtraSecret(`password:${acc.username}`, np);
    const r = await api.post(`${API}/auth/password`, { currentPassword: acc.password, newPassword: np });
    expect(r.status, `password change for ${acc.username}: ${r.text.slice(0, 200)}`).toBe(200);
    acc.password = np;
    await api.refreshMe();
  }
  if (api.me?.mustEnrollTotp) {
    const e = await api.post(`${API}/auth/totp/enroll`, {});
    expect(e.status, `totp enroll for ${acc.username}: ${e.text.slice(0, 200)}`).toBe(200);
    acc.totpSecret = e.json.secretBase32 as string;
    registerExtraSecret(`totp:${acc.username}`, acc.totpSecret);
    const code = await freshTotp(acc.totpSecret);
    const c = await api.post(`${API}/auth/totp/confirm`, { code });
    expect(c.status, `totp confirm for ${acc.username}: ${c.text.slice(0, 200)}`).toBe(200);
    await api.refreshMe();
  }
}

/** Creates a local user through the admin API and returns a fully onboarded logged-in session. */
export async function createUser(admin: Api, username: string, role: Account['role'], opts: { onboard?: boolean; save?: string } = {}): Promise<{ acc: Account; api?: Api; id: string }> {
  const initialPassword = newPassword();
  registerExtraSecret(`password:${username}:initial`, initialPassword);
  const r = await admin.post(`${API}/admin/users`, { username, displayName: `E2E ${username}`, role, initialPassword });
  expect(r.status, `create user ${username}: ${r.text.slice(0, 300)}`).toBeLessThan(300);
  const id = (r.json.user?.id ?? r.json.id) as string;
  const acc: Account = { username, password: initialPassword, role };
  if (opts.onboard === false) {
    if (opts.save) saveAccount(opts.save, acc);
    return { acc, id };
  }
  const api = await Api.login(acc);
  await completeOnboarding(api, acc);
  if (opts.save) {
    saveAccount(opts.save, acc);
    await api.saveStorage(opts.save);
  }
  return { acc, api, id };
}

let counter = 0;
export const uniqueName = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function adminApi(): Promise<Api> {
  return Api.fromStorage('admin');
}
export { loadAccounts };
