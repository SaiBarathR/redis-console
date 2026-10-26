import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.ts';
import { sandboxUp, startApp, testConfigRaw, userSession, type TestApp } from '../helpers.ts';

const env = { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' };

function withShellExtras() {
  const raw = testConfigRaw();
  const dbs = raw.databases as Record<string, unknown>[];
  dbs.find((d) => d.id === 'e2e')!.tags = ['checkout', 'team/payments', 'checkout'];
  dbs.push({
    id: 'e2e-db3', name: 'E2E logical 3', environment: 'test', db: 3, url: 'redis://127.0.0.1:6411',
    credentials: dbs.find((d) => d.id === 'e2e')!.credentials,
  });
  return resolveConfig(raw, { env });
}

describe('config: display-only tags (F21)', () => {
  it('accepts short labels and rejects markup-like or long ones', () => {
    const ok = testConfigRaw();
    (ok.databases as Record<string, unknown>[])[0]!.tags = ['payments', 'Team Ä/1'];
    expect(() => resolveConfig(ok, { env })).not.toThrow();
    for (const bad of [['<b>x</b>'], ['x'.repeat(33)], ['javascript:alert(1)'], Array.from({ length: 9 }, (_, i) => `t${i}`), ['']]) {
      const raw = testConfigRaw();
      (raw.databases as Record<string, unknown>[])[0]!.tags = bad;
      expect(() => resolveConfig(raw, { env }), JSON.stringify(bad)).toThrow();
    }
  });
});

describe.skipIf(!sandboxUp)('shell parity routes (F13, F19, F21)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(withShellExtras());
  });
  afterAll(async () => t?.close());

  it('database summaries carry the configured logical db index and display tags (F13, F21)', async () => {
    const v = await userSession(t, 'viewer');
    const r = await v.req('GET', '/api/v1/databases');
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.json.databases.map((d: { id: string }) => [d.id, d]));
    expect(byId.e2e.db).toBe(0);
    expect(byId.e2e.tags).toEqual(['checkout', 'team/payments']);
    expect(byId['e2e-db3'].db).toBe(3);
    expect(byId['e2e-db3'].tags).toBeUndefined();
    // Still no connection details.
    expect(JSON.stringify(r.json)).not.toMatch(/6411|redis:\/\/|127\.0\.0\.1/);
  });

  it('the overview keyspace lets the browser pick the configured logical db', async () => {
    const v = await userSession(t, 'viewer');
    const r = await v.req('GET', '/api/v1/databases/e2e-db3/overview');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.keyspace)).toBe(true);
    for (const k of r.json.keyspace) expect(typeof k.db).toBe('number');
  });

  it('slowlog config: real values for admins, an explanation for other roles (F19)', async () => {
    const adm = await userSession(t, 'admin');
    const a = await adm.req('GET', '/api/v1/databases/e2e/slowlog/config');
    expect(a.status).toBe(200);
    expect(a.json.available).toBe(true);
    expect(Number.isInteger(a.json.slowerThanMicros)).toBe(true);
    expect(a.json.maxLen).toBeGreaterThan(0);
    expect(Object.keys(a.json).sort()).toEqual(['available', 'maxLen', 'slowerThanMicros']);
    // Read-only databases still allow admin-class reads for admins.
    const ro = await adm.req('GET', '/api/v1/databases/e2e-ro/slowlog/config');
    expect(ro.json.available).toBe(true);
    for (const role of ['viewer', 'operator'] as const) {
      const c = await userSession(t, role);
      const r = await c.req('GET', '/api/v1/databases/e2e/slowlog/config');
      expect(r.status).toBe(200);
      expect(r.json.available).toBe(false);
      expect(r.json.reason).toMatch(/admin role/);
      expect(r.json.slowerThanMicros).toBeUndefined();
    }
    // maxRole=operator caps admins too.
    const capped = await adm.req('GET', '/api/v1/databases/e2e-maxop/slowlog/config');
    expect(capped.json.available).toBe(false);
    // Only GET, no parameters accepted from the caller.
    expect((await adm.req('POST', '/api/v1/databases/e2e/slowlog/config', {})).status).toBe(404);
  });

  it('slowlog config reads are audited without values', async () => {
    const adm = await userSession(t, 'admin');
    await adm.req('GET', '/api/v1/databases/e2e/slowlog/config');
    const line = t.auditLines.map((l) => JSON.parse(l) as { action?: string; argvRedacted?: string[]; outcome?: string }).findLast((l) => l.action === 'slowlog.config');
    expect(line?.outcome).toBe('allowed');
    expect(line?.argvRedacted).toEqual(['CONFIG', 'GET', 'slowlog-log-slower-than', 'slowlog-max-len']);
  });

  it('the slow log honours a caller-chosen count within the cap (F19)', async () => {
    const v = await userSession(t, 'viewer');
    const r = await v.req('GET', '/api/v1/databases/e2e/slowlog?count=1000');
    expect(r.status).toBe(200);
    expect(r.json.entries.length).toBeLessThanOrEqual(1000);
  });
});
