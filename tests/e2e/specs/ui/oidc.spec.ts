/** OIDC login through the sandbox Keycloak (realm rconsole): group -> role mapping, no-group refusal. */
import { test, expect } from '../../lib/test.ts';
import { envVar, KEYCLOAK_URL } from '../../lib/env.ts';
import { expectShell } from '../../lib/ui.ts';
import { registerExtraSecret } from '../../lib/leak.ts';

async function keycloakLogin(page: import('@playwright/test').Page, username: string) {
  await page.goto('/login');
  await page.getByTestId('login-sso').click();
  await page.waitForURL(new RegExp(`^${KEYCLOAK_URL}/realms/rconsole/`));
  // The authorization request must use PKCE (S256), state and nonce.
  const authUrl = new URL(page.url());
  if (authUrl.pathname.endsWith('/auth')) {
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('state')).toBeTruthy();
    expect(authUrl.searchParams.get('nonce')).toBeTruthy();
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:4400/api/v1/auth/oidc/callback');
  }
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(envVar('KC_USER_PASSWORD'));
  await page.locator('#kc-login').click();
}

test.describe('OIDC (Keycloak)', () => {
  test.beforeAll(() => { registerExtraSecret('KC_USER_PASSWORD', envVar('KC_USER_PASSWORD')); });

  for (const [user, role] of [['viewer1', 'viewer'], ['operator1', 'operator'], ['admin1', 'admin']] as const) {
    test(`${user} signs in via SSO and gets role ${role}`, async ({ page, guards }) => {
      guards.allowConsole(/Failed to load resource/); // Keycloak page assets / favicon
      await keycloakLogin(page, user);
      await expectShell(page);
      expect(new URL(page.url()).origin).toBe('http://localhost:4400');
      const me = await (await page.request.get('/api/v1/auth/me')).json();
      expect(me).toMatchObject({ username: user, source: 'oidc', role });
      // No tokens are exposed to the browser.
      const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
      expect(storage).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); // JWTs
      expect(storage).not.toContain('rc_session'); // HttpOnly
      // Admin-only navigation follows the role.
      await expect(page.getByTestId('nav-audit')).toHaveCount(role === 'admin' ? 1 : 0);
      // Logout ends the app session.
      await page.getByTestId('logout').click();
      await expect(page.getByTestId('login-username').or(page.getByTestId('login-sso')).first()).toBeVisible();
      expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
    });
  }

  test('nogroup1 (no mapped group) is refused', async ({ page, guards }) => {
    guards.allowConsole(/Failed to load resource/);
    await keycloakLogin(page, 'nogroup1');
    await page.waitForURL(/\/login\?error=oidc_no_role/);
    await expect(page.getByRole('alert')).toContainText(/no Redis Console role/i);
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
    expect((await page.request.get('/api/v1/databases')).status()).toBe(401);
  });

  test('callback with a forged state is rejected', async ({ page }) => {
    await page.goto('/api/v1/auth/oidc/callback?code=forged&state=forged');
    await page.waitForURL(/\/login\?error=oidc_(state|failed)/);
    expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
  });
});
