/** Local auth in the browser: login, forced password change, TOTP enrollment + login, lockout, logout, session expiry. */
import { test, expect } from '../../lib/test.ts';
import { Api, loadAccounts } from '../../lib/api.ts';
import { createUser, newPassword, uniqueName } from '../../lib/accounts.ts';
import { registerExtraSecret } from '../../lib/leak.ts';
import { freshTotp } from '../../lib/totp.ts';
import { ageSession } from '../../lib/sessions-db.ts';
import { expectShell, uiLogin } from '../../lib/ui.ts';
import { loginThrottle } from '../../lib/throttle.ts';
import { knownBug } from '../../lib/findings.ts';

test.describe('local auth (UI)', () => {
  let admin: Api;
  test.beforeAll(async () => { admin = await Api.fromStorage('admin'); });
  test.afterAll(async () => { await admin.dispose(); });

  test('unauthenticated visit redirects to the login page', async ({ page }) => {
    await page.goto('/db/sandbox-e2e/keys');
    await expect(page.getByTestId('login-username')).toBeVisible();
    await expect(page.getByTestId('login-sso')).toBeVisible();
  });

  test('local login with the viewer account', async ({ page }) => {
    const { acc } = await createUser(admin, uniqueName('uiv'), 'viewer');
    await uiLogin(page, acc);
    await expectShell(page);
    await expect(page.getByTestId('nav-audit')).toHaveCount(0);
  });

  test('wrong password shows a generic error', async ({ page }) => {
    await page.goto('/login');
    await page.getByTestId('login-username').fill('e2e-viewer');
    await page.getByTestId('login-password').fill('not-the-password');
    await loginThrottle();
    await page.getByTestId('login-submit').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).not.toContainText(/not found|unknown user|no such/i);
  });

  test('forced password change, then TOTP enrollment, then TOTP login (admin role)', async ({ page }) => {
    const { acc } = await createUser(admin, uniqueName('uiadm'), 'admin', { onboard: false });
    await uiLogin(page, acc);
    // Forced password change.
    await expect(page.getByTestId('current-password')).toBeVisible();
    await expect(page.getByTestId('nav-keys')).toHaveCount(0);
    const np = newPassword();
    registerExtraSecret(`password:${acc.username}`, np);
    await page.getByTestId('current-password').fill(acc.password);
    await page.getByTestId('new-password').fill(np);
    await loginThrottle();
    await page.getByTestId('password-change-submit').click();
    acc.password = np;
    // Forced TOTP enrollment. The secret is read from the enrollment response, the code computed here.
    const enrollResp = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/totp/enroll') && r.status() === 200);
    await page.getByTestId('totp-enroll').click();
    const { secretBase32 } = await (await enrollResp).json();
    acc.totpSecret = secretBase32;
    registerExtraSecret(`totp:${acc.username}`, secretBase32);
    await expect(page.getByTestId('totp-qr')).toBeVisible();
    await page.getByTestId('totp-enroll-code').fill(await freshTotp(secretBase32));
    await loginThrottle();
    await page.getByTestId('totp-enroll-confirm').click();
    // Recovery codes are shown once; the forced page stays until the user says they are saved.
    await expect(page.getByTestId('recovery-codes')).toBeVisible();
    await page.getByTestId('recovery-saved').click();
    await expectShell(page);
    await expect(page.getByTestId('nav-audit')).toBeVisible();
    // Log out and back in: TOTP is now required.
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-username')).toBeVisible();
    await page.getByTestId('login-username').fill(acc.username);
    await page.getByTestId('login-password').fill(acc.password);
    await loginThrottle();
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('totp-code')).toBeVisible();
    await page.getByTestId('totp-code').fill('000000');
    await loginThrottle();
    await page.getByTestId('totp-submit').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByTestId('totp-code').fill(await freshTotp(secretBase32));
    await loginThrottle();
    await page.getByTestId('totp-submit').click();
    await expectShell(page);
  });

  test('lockout after repeated failures is shown and blocks the correct password', async ({ page }) => {
    const { acc } = await createUser(admin, uniqueName('uilock'), 'viewer');
    await page.goto('/login');
    for (let i = 0; i < 6; i++) {
      await page.getByTestId('login-username').fill(acc.username);
      await page.getByTestId('login-password').fill(`wrong-password-${i}`);
      await loginThrottle();
    await page.getByTestId('login-submit').click();
      await expect(page.getByRole('alert')).toBeVisible();
    }
    await page.getByTestId('login-username').fill(acc.username);
    await page.getByTestId('login-password').fill(acc.password);
    await loginThrottle();
    await page.getByTestId('login-submit').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('database-switcher')).toHaveCount(0);
  });

  test('logout returns to login; back button does not restore the session', async ({ page }) => {
    const { acc } = await createUser(admin, uniqueName('uiout'), 'operator');
    await uiLogin(page, acc);
    await expectShell(page);
    await page.goto('/db/sandbox-e2e/keys');
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-username')).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId('login-username')).toBeVisible();
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
  });

  test('session expiry sends the user back to login', async ({ page, context }) => {
    const { acc } = await createUser(admin, uniqueName('uiexp'), 'viewer');
    await uiLogin(page, acc);
    await expectShell(page);
    const cookie = (await context.cookies()).find((c) => /rc_session/.test(c.name))!;
    expect(ageSession(cookie.value, { idleMs: 61 * 60_000 })).toBe(1);
    await page.goto('/db/sandbox-e2e/keys');
    await expect(page.getByTestId('login-username')).toBeVisible();
    // Any API 401 on an open page explains why the user is back at sign-in.
    const { acc: acc2 } = await createUser(admin, uniqueName('uiexp2'), 'viewer');
    await uiLogin(page, acc2);
    await expectShell(page);
    await page.goto('/db/sandbox-e2e/keys');
    // goto waits for the document, not the SPA's authenticated/lazy-loaded view.
    // Age an open session only after the shell exists, then require the in-app click.
    await expect(page.getByTestId('key-pattern')).toBeVisible();
    const c2 = (await context.cookies()).find((c) => /rc_session/.test(c.name))!;
    expect(ageSession(c2.value, { expire: true })).toBe(1);
    // The next in-app API call (a click or a background refresh) gets 401 and the SPA explains why. On a slow
    // runner the background refresh can win and replace the shell before the click lands, so click only while
    // the notice is not shown yet.
    const ended = page.getByTestId('session-ended');
    await expect(async () => {
      if (!(await ended.isVisible())) await page.getByTestId('nav-overview').click({ timeout: 2_000 });
      await expect(ended).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByTestId('login-username')).toBeVisible();
  });

  test('stored role sessions render the shell (smoke)', async ({ browser }) => {
    for (const role of ['viewer', 'operator', 'admin'] as const) {
      const ctx = await browser.newContext({ storageState: (await import('../../lib/api.ts')).storageFile(role) });
      const p = await ctx.newPage();
      await p.goto('/');
      await expectShell(p);
      await ctx.close();
    }
    expect(Object.keys(loadAccounts()).length).toBeGreaterThanOrEqual(3);
  });
});
