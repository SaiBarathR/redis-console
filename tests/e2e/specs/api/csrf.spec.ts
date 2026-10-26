/** CSRF defenses: X-CSRF-Token (per session) + Origin == publicUrl on every non-GET. */
import { test, expect } from '@playwright/test';
import { API, Api, dbPath, utf8 } from '../../lib/api.ts';
import { DB, BASE_URL } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';

const key = `${K.scratchPrefix}csrf-target`;
const setBody = (v: string) => ({ op: 'string.set', key: utf8(key), value: utf8(v) });

test.describe('CSRF', () => {
  let op: Api;
  let viewer: Api;
  test.beforeAll(async () => {
    op = await Api.fromStorage('operator');
    viewer = await Api.fromStorage('viewer');
    await redisExec(['SET', key, 'original']);
  });
  test.afterAll(async () => { await op.dispose(); await viewer.dispose(); });

  const cases: { name: string; opts: Parameters<Api['post']>[2] }[] = [
    { name: 'missing X-CSRF-Token', opts: { csrf: null } },
    { name: 'wrong X-CSRF-Token', opts: { csrf: 'A'.repeat(43) } },
    { name: 'empty X-CSRF-Token', opts: { csrf: '' , headers: { 'X-CSRF-Token': '' } } },
    { name: 'foreign Origin', opts: { origin: 'http://evil.example' } },
    { name: 'Origin with different port', opts: { origin: 'http://localhost:4401' } },
    { name: 'Origin "null"', opts: { origin: 'null' } },
    { name: 'publicUrl as prefix of a foreign origin', opts: { origin: 'http://localhost:4400.evil.example' } },
    { name: 'missing Origin', opts: { origin: null } },
  ];
  for (const c of cases) {
    test(`write rejected: ${c.name}`, async () => {
      const r = await op.post(dbPath(DB.e2e, 'ops'), setBody(`csrf-${c.name}`), c.opts);
      expect(r.status, r.text).toBe(403);
      expect(r.json?.error?.code).toBe('csrf');
      expect(String(await redisExec(['GET', key]))).toBe('original');
    });
  }

  test("another user's CSRF token is rejected", async () => {
    const r = await op.post(dbPath(DB.e2e, 'ops'), setBody('cross-session'), { csrf: viewer.csrf });
    expect(r.status).toBe(403);
    expect(r.json?.error?.code).toBe('csrf');
    expect(String(await redisExec(['GET', key]))).toBe('original');
  });

  test('CSRF applies to CLI, workbench, bulk delete, publish, logout and admin routes', async () => {
    const admin = await Api.fromStorage('admin');
    try {
      const targets: [Api, string, unknown][] = [
        [op, dbPath(DB.e2e, 'cli'), { line: `SET ${key} pwned` }],
        [op, dbPath(DB.e2e, 'workbench'), { script: `SET ${key} pwned` }],
        [op, dbPath(DB.e2e, 'bulk-delete'), { match: `${key}*` }],
        [op, dbPath(DB.e2e, 'pubsub/publish'), { channel: 'x', message: utf8('y') }],
        [admin, `${API}/admin/users`, { username: 'csrf-victim', displayName: 'x', role: 'admin', initialPassword: 'xxxxxxxxxxxxxxxx' }],
        [admin, dbPath(DB.e2e, 'slowlog/reset'), {}],
        [op, `${API}/auth/logout`, {}],
      ];
      for (const [api, url, body] of targets) {
        const r1 = await api.post(url, body, { csrf: null });
        expect(r1.status, `${url} without token`).toBe(403);
        const r2 = await api.post(url, body, { origin: 'http://evil.example' });
        expect(r2.status, `${url} with foreign origin`).toBe(403);
      }
      const pu = await admin.patch(`${API}/admin/users/does-not-matter`, { disabled: true }, { csrf: null });
      expect(pu.status).toBe(403);
      expect(String(await redisExec(['GET', key]))).toBe('original');
      // Session still alive (logout was refused).
      expect((await op.get(`${API}/auth/me`)).status).toBe(200);
    } finally {
      await admin.dispose();
    }
  });

  test('login is protected against cross-site login (foreign Origin)', async () => {
    const anon = await Api.anonymous();
    const r = await anon.post(`${API}/auth/login`, { username: 'admin', password: 'irrelevant-password' }, { csrf: null, origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    await anon.dispose();
  });

  test('text/plain (CORS "simple request") bodies are rejected', async () => {
    const r = await op.post(dbPath(DB.e2e, 'ops'), JSON.stringify(setBody('simple-request')), { headers: { 'Content-Type': 'text/plain' } });
    expect([400, 403, 415]).toContain(r.status);
    expect(String(await redisExec(['GET', key]))).toBe('original');
  });

  test('form-encoded bodies are rejected', async () => {
    const r = await op.post(dbPath(DB.e2e, 'cli'), 'line=SET+x+y', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect([400, 403, 415]).toContain(r.status);
  });

  test('no permissive CORS: cross-origin preflight gets no Access-Control-Allow-Origin', async () => {
    const r = await op.req('OPTIONS', dbPath(DB.e2e, 'ops'), undefined, {
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-csrf-token' },
    });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
    const g = await op.get(`${API}/auth/me`, { headers: { Origin: 'http://evil.example' } });
    expect(g.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('GET requests have no side effects (state-changing routes are not reachable via GET)', async () => {
    for (const p of [`${API}/auth/logout`, dbPath(DB.e2e, 'ops'), dbPath(DB.e2e, 'cli'), dbPath(DB.e2e, 'bulk-delete'), dbPath(DB.e2e, 'slowlog/reset')]) {
      const r = await op.get(p);
      expect([404, 405], `GET ${p} -> ${r.status}`).toContain(r.status);
    }
    expect((await op.get(`${API}/auth/me`)).status).toBe(200);
    expect(BASE_URL).toBe('http://localhost:4400');
  });
});
