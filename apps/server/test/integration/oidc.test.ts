/**
 * OIDC against the sandbox Keycloak. The app must listen on localhost:4100 (the registered
 * redirect URI). Keycloak has brute-force protection: never submit a wrong password.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keycloakUp, portOpen, startApp, testConfig, type TestApp } from '../helpers.ts';

const APP = 'http://localhost:4100';

class Jar {
  readonly #c = new Map<string, string>();
  store(r: Response) {
    for (const sc of r.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const i = kv!.indexOf('=');
      const name = kv!.slice(0, i).trim();
      const value = kv!.slice(i + 1).trim();
      if (!value || /max-age=0/i.test(sc)) this.#c.delete(name);
      else this.#c.set(name, value);
    }
  }
  header(): string {
    return [...this.#c].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get(name: string) {
    return this.#c.get(name);
  }
  delete(name: string) {
    this.#c.delete(name);
  }
}

const unescapeHtml = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function get(url: string, jar: Jar) {
  const r = await fetch(url, { redirect: 'manual', headers: { cookie: jar.header() } });
  jar.store(r);
  return r;
}

/** Start a flow and authenticate at Keycloak. Returns the callback URL (not yet visited) and the app jar. */
async function idpLogin(username: string): Promise<{ callback: string; app: Jar }> {
  const app = new Jar();
  const kc = new Jar();
  const start = await get(`${APP}/api/v1/auth/oidc/start`, app);
  expect(start.status).toBe(302);
  expect(app.get('rc_oidc')).toBeTruthy();
  const authUrl = start.headers.get('location')!;
  expect(authUrl).toMatch(/^http:\/\/localhost:8089\/realms\/rconsole\/protocol\/openid-connect\/auth\?/);
  const q = new URL(authUrl).searchParams;
  expect(q.get('code_challenge_method')).toBe('S256');
  expect(q.get('code_challenge')).toBeTruthy();
  expect(q.get('state')).toBeTruthy();
  expect(q.get('nonce')).toBeTruthy();
  expect(q.get('redirect_uri')).toBe(`${APP}/api/v1/auth/oidc/callback`);
  expect(q.get('scope')).toContain('openid');

  const page = await get(authUrl, kc);
  expect(page.status).toBe(200);
  const html = await page.text();
  const m = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html) ?? /<form[^>]*action="([^"]+)"[^>]*id="kc-form-login"/.exec(html);
  if (!m) throw new Error('Keycloak login form not found');
  const action = unescapeHtml(m[1]!);
  const post = await fetch(action, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: kc.header(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password: process.env.KC_USER_PASSWORD!, credentialId: '' }).toString(),
  });
  kc.store(post);
  expect(post.status).toBe(302);
  const callback = post.headers.get('location')!;
  expect(callback.startsWith(`${APP}/api/v1/auth/oidc/callback?`)).toBe(true);
  return { callback, app };
}

async function me(app: Jar) {
  const r = await fetch(`${APP}/api/v1/auth/me`, { headers: { cookie: app.header() } });
  return { status: r.status, json: (await r.json()) as any };
}

describe.skipIf(!keycloakUp)('OIDC (Keycloak)', () => {
  let t: TestApp;
  beforeAll(async () => {
    if (await portOpen(4100)) throw new Error('Port 4100 is in use (dev server running?). Stop it: the OIDC test must listen on 4100, the redirect URI registered in Keycloak.');
    t = await startApp(testConfig({ oidc: true }));
    await t.app.listen({ host: '127.0.0.1', port: 4100 });
  });
  afterAll(async () => t?.close());

  it('advertises OIDC', async () => {
    const r = await fetch(`${APP}/api/v1/auth/providers`);
    expect(await r.json()).toEqual({ oidc: { enabled: true, displayName: 'Keycloak' }, local: { enabled: true } });
  });

  for (const [user, role] of [['viewer1', 'viewer'], ['operator1', 'operator'], ['admin1', 'admin']] as const) {
    it(`logs in ${user} with role ${role}`, async () => {
      const { callback, app } = await idpLogin(user);
      const cb = await get(callback, app);
      expect(cb.status).toBe(302);
      expect(cb.headers.get('location')).toBe('/');
      expect(app.get('rc_session')).toBeTruthy();
      expect(app.get('rc_oidc')).toBeUndefined(); // flow cookie cleared
      const sc = cb.headers.getSetCookie().find((s) => s.startsWith('rc_session='))!;
      expect(sc).toMatch(/HttpOnly/);
      expect(sc).toMatch(/SameSite=Strict/);
      // Tokens never reach the browser.
      expect(cb.headers.getSetCookie().join(';')).not.toMatch(/eyJ/);
      const m = await me(app);
      expect(m.status).toBe(200);
      expect(m.json).toMatchObject({ username: user, role, source: 'oidc', mustChangePassword: false, mustEnrollTotp: false });
      expect(m.json.id).toMatch(/^oidc:/);
      expect(JSON.stringify(m.json)).not.toMatch(/eyJ/);

      // Logout works for OIDC sessions.
      const lo = await fetch(`${APP}/api/v1/auth/logout`, { method: 'POST', headers: { cookie: app.header(), origin: APP, 'x-csrf-token': m.json.csrfToken } });
      expect(lo.status).toBe(200);
      app.store(lo);
      expect((await me(app)).status).toBe(401);
    });
  }

  it('refuses users without a mapped group', async () => {
    const { callback, app } = await idpLogin('nogroup1');
    const cb = await get(callback, app);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/login?error=oidc_no_role');
    expect(app.get('rc_session')).toBeUndefined();
    expect((await me(app)).status).toBe(401);
    const denied = t.ctx.audit.query({ action: 'auth.oidc', outcome: 'denied', limit: 10 }).events;
    expect(denied.some((e) => e.username === 'nogroup1' && e.detail === 'no mapped group')).toBe(true);
  });

  it('rejects a tampered state', async () => {
    const { callback, app } = await idpLogin('viewer1');
    const u = new URL(callback);
    u.searchParams.set('state', 'tampered-state-value');
    const cb = await get(u.href, app);
    expect(cb.headers.get('location')).toBe('/login?error=oidc_state');
    expect(app.get('rc_session')).toBeUndefined();
  });

  it('rejects a callback without the flow cookie (login CSRF)', async () => {
    const { callback, app } = await idpLogin('viewer1');
    app.delete('rc_oidc');
    const cb = await get(callback, app);
    expect(cb.headers.get('location')).toBe('/login?error=oidc_state');
    expect(app.get('rc_session')).toBeUndefined();
  });

  it('rejects a callback from another browser (flow cookie mismatch)', async () => {
    const victim = await idpLogin('viewer1');
    const attacker = await idpLogin('admin1');
    // The victim's browser receives the attacker's callback URL.
    const cb = await get(attacker.callback, victim.app);
    expect(cb.headers.get('location')).toBe('/login?error=oidc_state');
    expect(victim.app.get('rc_session')).toBeUndefined();
  });

  it('a callback URL cannot be replayed', async () => {
    const { callback, app } = await idpLogin('viewer1');
    const first = await get(callback, app);
    expect(first.headers.get('location')).toBe('/');
    const flow = new (class extends Jar {})();
    // Replay with a fresh flow cookie from a new start (state no longer exists).
    await get(`${APP}/api/v1/auth/oidc/start`, flow);
    const again = await get(callback, flow);
    expect(again.headers.get('location')).toBe('/login?error=oidc_state');
    expect(flow.get('rc_session')).toBeUndefined();
  });

  it('an IdP error response is reported as oidc_state/oidc_failed without a session', async () => {
    const app = new Jar();
    const start = await get(`${APP}/api/v1/auth/oidc/start`, app);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const cb = await get(`${APP}/api/v1/auth/oidc/callback?error=access_denied&state=${state}`, app);
    expect(cb.headers.get('location')).toBe('/login?error=oidc_failed');
    expect(app.get('rc_session')).toBeUndefined();
  });
});
