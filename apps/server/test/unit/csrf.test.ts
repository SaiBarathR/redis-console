import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.ts';
import { ORIGIN, anonymous, startApp, testConfigRaw, userSession, type TestApp } from '../helpers.ts';

const env = { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' };

describe('CSRF protection', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(resolveConfig(testConfigRaw({ server: { extraAllowedOrigins: ['http://localhost:5173'] } }), { env }));
  });
  afterAll(() => t.close());

  it('rejects state-changing requests without an Origin header', async () => {
    const c = await userSession(t, 'viewer');
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('csrf');
  });

  it('rejects a foreign Origin, even with a valid token', async () => {
    const c = await userSession(t, 'viewer');
    for (const origin of ['https://evil.example', 'http://localhost:4101', 'null', 'http://localhost:4100.evil.example']) {
      const r = await c.req('POST', '/api/v1/auth/logout', {}, { origin });
      expect(r.status, origin).toBe(403);
      expect(r.json.error.code).toBe('csrf');
    }
  });

  it('accepts configured extra origins', async () => {
    const c = await userSession(t, 'viewer');
    const r = await c.req('POST', '/api/v1/auth/logout', {}, { origin: 'http://localhost:5173' });
    expect(r.status).toBe(200);
  });

  it('rejects authenticated POSTs with a missing or wrong X-CSRF-Token', async () => {
    const c = await userSession(t, 'viewer');
    const good = c.csrf;
    c.csrf = '';
    let r = await c.req('POST', '/api/v1/auth/logout', {});
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('csrf');
    c.csrf = `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`;
    r = await c.req('POST', '/api/v1/auth/logout', {});
    expect(r.status).toBe(403);
    c.csrf = 'short';
    r = await c.req('POST', '/api/v1/auth/logout', {});
    expect(r.status).toBe(403);
    // Another session's token does not work either.
    const other = await userSession(t, 'viewer');
    c.csrf = other.csrf;
    r = await c.req('POST', '/api/v1/auth/logout', {});
    expect(r.status).toBe(403);
    c.csrf = good;
    r = await c.req('POST', '/api/v1/auth/logout', {});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
  });

  it('GET requests need neither the token nor an Origin', async () => {
    const c = await userSession(t, 'viewer');
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: c.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json().csrfToken).toBe(c.csrf);
  });

  it('login is public: needs Origin but no CSRF token', async () => {
    const a = anonymous(t);
    let r = await a.req('POST', '/api/v1/auth/login', { username: 'nobody', password: 'wrong-password' });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('unauthenticated');
    r = await a.req('POST', '/api/v1/auth/login', { username: 'nobody', password: 'x' }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('csrf');
  });

  it('rejects non-JSON bodies on API routes', async () => {
    const c = await userSession(t, 'viewer');
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'a=1' });
    expect(r.statusCode).toBe(415);
  });
});

describe('security headers', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(() => t.close());

  const nonceOf = (csp: string) => /'nonce-([^']+)'/.exec(csp)?.[1];

  it('API responses carry the full header set and no-store', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
    expect(r.statusCode).toBe(200);
    const h = r.headers;
    const csp = String(h['content-security-policy']);
    for (const d of ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "connect-src 'self'", "require-trusted-types-for 'script'", "img-src 'self' data:"]) {
      expect(csp).toContain(d);
    }
    expect(csp).toMatch(/style-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['cross-origin-resource-policy']).toBe('same-origin');
    expect(h['x-frame-options']).toBe('DENY');
    expect(String(h['permissions-policy'])).toContain('camera=()');
    expect(h['cache-control']).toBe('no-store');
    expect(h['strict-transport-security']).toBeUndefined();
    expect(h['x-powered-by']).toBeUndefined();
  });

  it('uses a fresh nonce per request', async () => {
    const a = await t.app.inject({ method: 'GET', url: '/healthz' });
    const b = await t.app.inject({ method: 'GET', url: '/healthz' });
    const na = nonceOf(String(a.headers['content-security-policy']));
    const nb = nonceOf(String(b.headers['content-security-policy']));
    expect(na).toBeTruthy();
    expect(na).not.toBe(nb);
  });

  it('errors and 404s carry the headers too', async () => {
    for (const url of ['/api/v1/nope', '/api/v1/databases']) {
      const r = await t.app.inject({ method: 'GET', url });
      expect([401, 404]).toContain(r.statusCode);
      expect(r.headers['content-security-policy']).toBeTruthy();
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['cache-control']).toBe('no-store');
    }
    const r = await t.app.inject({ method: 'GET', url: '/some/page' });
    expect(r.headers['content-security-policy']).toBeTruthy();
  });

  it('sends HSTS only with secure cookies or an https public URL', async () => {
    const s = await startApp(resolveConfig(testConfigRaw({ server: { secureCookies: true } }), { env }));
    try {
      const r = await s.app.inject({ method: 'GET', url: '/healthz' });
      expect(String(r.headers['strict-transport-security'])).toMatch(/max-age=\d+/);
    } finally {
      await s.close();
    }
  });

  it('uses the __Host- session cookie name with secure cookies', async () => {
    const s = await startApp(resolveConfig(testConfigRaw({ server: { secureCookies: true } }), { env }));
    try {
      expect(s.ctx.sessionCookie).toBe('__Host-rc_session');
    } finally {
      await s.close();
    }
    expect(t.ctx.sessionCookie).toBe('rc_session');
  });
});
