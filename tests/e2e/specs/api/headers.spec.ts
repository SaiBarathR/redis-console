/** Security headers per docs/ARCHITECTURE.md ("CSRF / browser hardening"). */
import { test, expect } from '@playwright/test';
import { API, Api, dbPath } from '../../lib/api.ts';
import { DB } from '../../lib/env.ts';
import { createUser, uniqueName } from '../../lib/accounts.ts';

function parseCsp(h: string | undefined): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const part of (h ?? '').split(';')) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) m.set(name.toLowerCase(), vals);
  }
  return m;
}

const EXPECTED_CSP: Record<string, (v: string[]) => boolean> = {
  'default-src': (v) => v.join(' ') === "'none'",
  'script-src': (v) => v.join(' ') === "'self'",
  'style-src': (v) => v[0] === "'self'" && v.length === 2 && /^'nonce-[A-Za-z0-9+/_=-]{16,}'$/.test(v[1]!),
  'img-src': (v) => v.sort().join(' ') === "'self' data:",
  'font-src': (v) => v.join(' ') === "'self'",
  'connect-src': (v) => v.join(' ') === "'self'",
  'frame-ancestors': (v) => v.join(' ') === "'none'",
  'base-uri': (v) => v.join(' ') === "'none'",
  'form-action': (v) => v.join(' ') === "'self'",
  'require-trusted-types-for': (v) => v.join(' ') === "'script'",
};

function expectHardening(h: Record<string, string>, where: string) {
  expect(h['x-content-type-options'], where).toBe('nosniff');
  expect(h['referrer-policy'], where).toBe('no-referrer');
  expect(h['cross-origin-opener-policy'], where).toBe('same-origin');
  expect(h['cross-origin-resource-policy'], where).toBe('same-origin');
  expect(h['permissions-policy'], where).toBeTruthy();
  expect(h['x-powered-by'], where).toBeUndefined();
  expect(h['server'] ?? '', where).not.toMatch(/\d/); // no version banner
  const csp = parseCsp(h['content-security-policy']);
  for (const [d, ok] of Object.entries(EXPECTED_CSP)) {
    expect(csp.has(d), `${where}: CSP has ${d}`).toBe(true);
    expect(ok([...(csp.get(d) ?? [])]), `${where}: CSP ${d} = ${csp.get(d)?.join(' ')}`).toBe(true);
  }
  for (const v of csp.values()) {
    expect(v.join(' '), `${where}: no unsafe CSP sources`).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:|wasm-unsafe/);
  }
}

test.describe('security headers', () => {
  let anon: Api;
  let viewer: Api;
  test.beforeAll(async () => { anon = await Api.anonymous(); viewer = await Api.fromStorage('viewer'); });
  test.afterAll(async () => { await anon.dispose(); await viewer.dispose(); });

  test('SPA index: strict CSP with a per-request nonce matching <meta name="csp-nonce">', async () => {
    const r1 = await anon.get('/');
    const r2 = await anon.get('/');
    expect(r1.status).toBe(200);
    expect(r1.headers['content-type']).toContain('text/html');
    expectHardening(r1.headers, 'GET /');
    const n1 = parseCsp(r1.headers['content-security-policy']).get('style-src')![1]!.slice(7, -1);
    const n2 = parseCsp(r2.headers['content-security-policy']).get('style-src')![1]!.slice(7, -1);
    expect(n1).not.toBe(n2);
    expect(Buffer.from(n1, 'base64').length).toBeGreaterThanOrEqual(16);
    const meta = r1.text.match(/<meta\s+name="csp-nonce"\s+content="([^"]+)"/);
    expect(meta?.[1], 'nonce injected into index.html').toBe(n1);
    expect(r1.text).not.toContain('__CSP_NONCE__');
    // No inline scripts in the served index.html.
    const inlineScripts = [...r1.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\bsrc=/.test(m[1]!) && m[2]!.trim() !== '');
    expect(inlineScripts.length).toBe(0);
    expect(r1.headers['cache-control'] ?? '').toMatch(/no-store|no-cache/);
  });

  test('SPA deep links are served with the same headers (client-side routes)', async () => {
    const r = await anon.get('/login');
    expect(r.status).toBe(200);
    expectHardening(r.headers, 'GET /login');
  });

  test('API responses: hardening headers + Cache-Control: no-store + JSON content type', async () => {
    for (const [api, p] of [[anon, `${API}/auth/providers`], [anon, `${API}/auth/me`], [viewer, `${API}/databases`], [viewer, dbPath(DB.e2e, 'overview')], [viewer, `${API}/nope`]] as const) {
      const r = await api.get(p);
      expectHardening(r.headers, `GET ${p}`);
      expect(r.headers['cache-control'], `GET ${p}`).toContain('no-store');
      expect(r.headers['content-type'], `GET ${p}`).toContain('application/json');
    }
  });

  test('third-party notices: served as plain text with the hardening headers (v0.3 follow-up 2)', async () => {
    const r = await anon.get('/THIRD-PARTY-NOTICES.txt');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expectHardening(r.headers, 'GET /THIRD-PARTY-NOTICES.txt');
    expect(r.text).toMatch(/^THIRD-PARTY NOTICES\n/);
    for (const part of ['SIL OPEN FONT LICENSE Version 1.1', 'Atkinson Hyperlegible Mono', 'react 19', 'fastify 5', 'Permission is hereby granted']) expect(r.text).toContain(part);
  });

  test('unknown /api routes return JSON 404, not the SPA', async () => {
    const r = await viewer.get(`${API}/definitely-not-a-route`);
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toContain('application/json');
  });

  test('static assets: hardening headers, correct types, no source maps exposed', async () => {
    const idx = await anon.get('/');
    const assets = [...idx.text.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]!);
    expect(assets.length).toBeGreaterThan(0);
    for (const a of assets) {
      const r = await anon.get(a, { noScan: false });
      expect(r.status, a).toBe(200);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-type']).toMatch(a.endsWith('.js') ? /javascript/ : /text\/css/);
      if (a.endsWith('.js')) {
        expect(r.text, `${a} has no sourceMappingURL`).not.toMatch(/sourceMappingURL=/);
        const map = await anon.get(`${a}.map`);
        expect(map.status, `${a}.map is not published`).toBe(404);
      }
    }
  });

  test('no directory listing or dotfile exposure', async () => {
    for (const p of ['/assets/', '/.env', '/../.env', '/%2e%2e/.env', '/package.json', '/config/rconsole.e2e.json', '/.git/config']) {
      const r = await anon.get(p);
      // SPA fallback may answer 200 with index.html; it must never be the file itself.
      expect(r.text, p).not.toMatch(/SANDBOX_REDIS|"databases"|\[core\]|"dependencies"/);
    }
  });

  test('session cookie flags: HttpOnly, SameSite=Strict, Path=/', async () => {
    const admin = await Api.fromStorage('admin');
    const { acc } = await createUser(admin, uniqueName('cookie'), 'viewer', { onboard: false });
    await admin.dispose();
    const api = await Api.anonymous();
    const r = await api.post(`${API}/auth/login`, { username: acc.username, password: acc.password }, { csrf: null });
    expect(r.status).toBe(200);
    const raw = (await api.ctx.storageState()).cookies;
    const sess = raw.find((c) => /rc_session/.test(c.name));
    expect(sess, 'session cookie present').toBeTruthy();
    expect(sess!.httpOnly).toBe(true);
    expect(sess!.sameSite).toBe('Strict');
    expect(sess!.path).toBe('/');
    expect(sess!.value.length).toBeGreaterThanOrEqual(43); // 256-bit base64url
    expect(r.headers['set-cookie']).toMatch(/HttpOnly/i);
    expect(r.headers['set-cookie']).toMatch(/SameSite=Strict/i);
    await api.refreshMe();
    await api.post(`${API}/auth/logout`, {});
    await api.dispose();
  });

  test('frame-ancestors none blocks framing (checked in a real browser)', async ({ page }) => {
    await page.setContent('<iframe id="f" src="http://localhost:4400/"></iframe>');
    await page.waitForTimeout(1500);
    const frame = page.frames().find((f) => f.url().startsWith('http://localhost:4400'));
    const loaded = frame ? await frame.evaluate(() => document.body?.innerText.length ?? 0).catch(() => 0) : 0;
    expect(loaded).toBe(0);
  });
});
