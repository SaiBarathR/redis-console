/**
 * TOTP recovery codes in the browser: shown once at enrollment (copy, local download), sign-in with a recovery code
 * instead of the authenticator (single use), the remaining count in Account, and regeneration (old set revoked).
 */
import { readFileSync } from 'node:fs';
import { test, expect } from '../../lib/test.ts';
import { API, Api } from '../../lib/api.ts';
import { createUser, newPassword, uniqueName } from '../../lib/accounts.ts';
import { registerExtraSecret } from '../../lib/leak.ts';
import { freshTotp } from '../../lib/totp.ts';
import { expectShell, uiLogin } from '../../lib/ui.ts';
import { loginThrottle } from '../../lib/throttle.ts';
import type { Page } from '@playwright/test';

const CODE_RE = /^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/;

async function shownCodes(page: Page): Promise<string[]> {
  const panel = page.getByTestId('recovery-codes');
  await expect(panel).toBeVisible();
  const codes = (await panel.getByRole('listitem').allTextContents()).map((s) => s.trim());
  expect(codes).toHaveLength(10);
  for (const c of codes) expect(c).toMatch(CODE_RE);
  return codes;
}

async function passwordStep(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(password);
  await loginThrottle();
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('totp-code')).toBeVisible();
}

async function recoveryStep(page: Page, code: string) {
  await page.getByTestId('recovery-toggle').click();
  await page.getByTestId('recovery-code').fill(code);
  await loginThrottle();
  await page.getByTestId('totp-submit').click();
}

test.describe('recovery codes (UI)', () => {
  // Many paced sign-in requests (the server allows 10 per minute per IP).
  test.describe.configure({ timeout: 300_000 });
  let admin: Api;
  const seen: string[] = [];
  test.beforeAll(async () => { admin = await Api.fromStorage('admin'); });
  test.afterAll(async () => {
    await admin.dispose();
    // From here on, any response or the server log (final/summary) containing one of them is a leak.
    seen.forEach((c, i) => registerExtraSecret(`recovery-code:${i}`, c));
  });

  test('enrollment shows codes once with copy and download; a code signs in once; regenerate revokes the old set', async ({ page, context }) => {
    const { acc } = await createUser(admin, uniqueName('uirc'), 'admin', { onboard: false });
    // The server's Permissions-Policy denies clipboard-read, so record what the page writes instead.
    await page.addInitScript(() => {
      const w = window as unknown as { __copied: string[] };
      w.__copied = [];
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (t: string) => { w.__copied.push(t); return write(t); };
    });
    await context.grantPermissions(['clipboard-write']);
    await uiLogin(page, acc);
    // Forced password change, then forced enrollment.
    const np = newPassword();
    registerExtraSecret(`password:${acc.username}`, np);
    await page.getByTestId('current-password').fill(acc.password);
    await page.getByTestId('new-password').fill(np);
    await loginThrottle();
    await page.getByTestId('password-change-submit').click();
    acc.password = np;
    const enrollResp = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/totp/enroll') && r.status() === 200);
    await page.getByTestId('totp-enroll').click();
    const { secretBase32 } = await (await enrollResp).json();
    acc.totpSecret = secretBase32;
    registerExtraSecret(`totp:${acc.username}`, secretBase32);
    await page.getByTestId('totp-enroll-code').fill(await freshTotp(secretBase32));
    await loginThrottle();
    await page.getByTestId('totp-enroll-confirm').click();

    const codes = await shownCodes(page);
    seen.push(...codes);
    // The forced page stays until the codes are saved.
    await expect(page.getByTestId('database-switcher')).toHaveCount(0);

    // Copy: the clipboard gets all codes, one per line.
    await page.getByTestId('recovery-codes').getByRole('button', { name: 'Copy codes' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([codes.join('\n')]);
    await expect(page.getByTestId('recovery-codes').getByRole('button', { name: 'Copy codes' })).toHaveText(/Copied/);

    // Download: a local Blob, no request to the server.
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    const download = page.waitForEvent('download');
    await page.getByTestId('recovery-download').click();
    const d = await download;
    expect(d.suggestedFilename()).toBe('redis-console-recovery-codes.txt');
    expect(d.url()).toMatch(/^blob:/);
    const text = readFileSync((await d.path())!, 'utf8');
    for (const c of codes) expect(text).toContain(c);
    expect(requests.filter((u) => !u.startsWith('blob:'))).toEqual([]);

    await page.getByTestId('recovery-saved').click();
    await expectShell(page);

    // Sign out, sign in with a recovery code instead of the authenticator.
    await page.getByTestId('logout').click();
    await passwordStep(page, acc.username, acc.password);
    await recoveryStep(page, codes[0]!.toUpperCase());
    await expectShell(page);
    await page.goto('/account');
    await expect(page.getByTestId('recovery-remaining')).toHaveText('9 of 10 left');

    // The same code does not work twice.
    await page.getByTestId('logout').click();
    await passwordStep(page, acc.username, acc.password);
    await recoveryStep(page, codes[0]!);
    await expect(page.getByRole('alert')).toContainText('Invalid code');
    await page.getByTestId('recovery-code').fill(codes[1]!);
    await loginThrottle();
    await page.getByTestId('totp-submit').click();
    await expectShell(page);

    // Regenerate from Account (re-authenticates with the password).
    await page.goto('/account');
    await expect(page.getByTestId('recovery-remaining')).toHaveText('8 of 10 left');
    await page.getByTestId('recovery-password').fill(acc.password);
    await loginThrottle();
    await page.getByTestId('recovery-regenerate').click();
    const fresh = await shownCodes(page);
    seen.push(...fresh);
    expect(fresh.some((c) => codes.includes(c))).toBe(false);
    await page.getByTestId('recovery-saved').click();
    await expect(page.getByTestId('recovery-remaining')).toHaveText('10 of 10 left');
    await expect(page.getByTestId('recovery-low')).toHaveCount(0);

    // An unused code of the old set no longer works; a new one does.
    await page.getByTestId('logout').click();
    await passwordStep(page, acc.username, acc.password);
    await recoveryStep(page, codes[2]!);
    await expect(page.getByRole('alert')).toContainText('Invalid code');
    await page.getByTestId('recovery-code').fill(fresh[0]!);
    await loginThrottle();
    await page.getByTestId('totp-submit').click();
    await expectShell(page);

    // Audited without the codes.
    const audit = await admin.get(`${API}/admin/audit?action=auth.recovery&user=${encodeURIComponent(acc.username)}`);
    expect(audit.status).toBe(200);
    const events = audit.json.events as { outcome: string; detail?: string }[];
    expect(events.filter((e) => e.outcome === 'allowed')).toHaveLength(3);
    expect(events.filter((e) => e.outcome === 'denied')).toHaveLength(2);
    for (const c of [...codes, ...fresh]) expect(audit.text).not.toContain(c);
  });

  test('a low count is shown as a warning in Account', async ({ page }) => {
    const { acc, api } = await createUser(admin, uniqueName('uirclow'), 'admin');
    // Use seven codes through the API (each a full sign-in with password + recovery code).
    const regen = await api!.post(`${API}/auth/recovery-codes`, { currentPassword: acc.password });
    expect(regen.status).toBe(200);
    const codes = regen.json.recoveryCodes as string[];
    seen.push(...codes);
    for (const c of codes.slice(0, 7)) {
      const x = await Api.anonymous();
      const r = await x.post(`${API}/auth/login`, { username: acc.username, password: acc.password, recoveryCode: c }, { csrf: null });
      expect(r.status).toBe(200);
      await x.dispose();
    }
    await api!.dispose();
    await passwordStep(page, acc.username, acc.password);
    await recoveryStep(page, codes[7]!);
    await expectShell(page);
    await page.goto('/account');
    await expect(page.getByTestId('recovery-remaining')).toHaveText('2 of 10 left');
    await expect(page.getByTestId('recovery-low')).toContainText('Only 2 recovery codes left');
  });
});
