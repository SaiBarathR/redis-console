import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupPrefix, keyPrefix, mainUp, sandboxAdmin, sandboxUp, startApp, userSession, type TestApp } from '../helpers.ts';
import { confirmed } from './data-helpers.ts';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;

describe.skipIf(!sandboxUp)('diagnostics routes', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('diag');

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    for (let i = 0; i < 40; i++) await r.set(`${P}a:${i}`, 'x'.repeat(i * 10));
    await r.hSet(`${P}b:h`, { f1: 'v', f2: 'v' });
    await r.set(`${P}b:ttl`, 'v', { EX: 120 });
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('GET /slowlog with count bounds', async () => {
    const v = await userSession(t, 'viewer');
    const res = await v.req('GET', '/api/v1/databases/e2e/slowlog?count=10');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.entries)).toBe(true);
    expect(typeof res.json.len).toBe('number');
    for (const e of res.json.entries) {
      expect(typeof e.id).toBe('number');
      expect(Array.isArray(e.argv)).toBe(true);
      for (const a of e.argv) expect(a.length).toBeLessThanOrEqual(201);
    }
    expect((await v.req('GET', '/api/v1/databases/e2e/slowlog?count=0')).status).toBe(400);
    expect((await v.req('GET', '/api/v1/databases/e2e/slowlog?count=1001')).status).toBe(400);
  });

  it('GET /slowlog hides client addresses from non-admins (self-review finding 6)', async () => {
    // Make sure there is an entry (default threshold 10 ms): a synchronous DEL of a 300k-member set is slow.
    for (let i = 0; i < 6; i++) await r.sAdd(`${P}slow-set`, Array.from({ length: 50_000 }, (_, j) => `m${i * 50_000 + j}`));
    await r.del(`${P}slow-set`);
    const v = await userSession(t, 'viewer');
    const viewer = await v.req('GET', '/api/v1/databases/e2e/slowlog?count=50');
    expect(viewer.json.entries.length).toBeGreaterThan(0);
    for (const e of viewer.json.entries) if (e.client !== undefined) expect(e.client).toBe('<hidden>');
    const adm = await userSession(t, 'admin');
    const admin = await adm.req('GET', '/api/v1/databases/e2e/slowlog?count=50');
    expect(admin.json.entries.some((e: { client?: string }) => /:\d+$/.test(e.client ?? ''))).toBe(true);
    // The console reply is masked the same way.
    const cli = await v.req('POST', '/api/v1/databases/e2e/cli', { argv: ['SLOWLOG', 'GET', '50'] });
    expect(cli.status).toBe(200);
    expect(JSON.stringify(cli.json)).not.toMatch(/127\.0\.0\.1:\d+|172\.\d+\.\d+\.\d+:\d+/);
  });

  it('POST /slowlog/reset: admin only, confirmation, read-only refused', async () => {
    const op = await userSession(t, 'operator');
    expect((await op.req('POST', '/api/v1/databases/e2e/slowlog/reset', {})).status).toBe(403);
    const adm = await userSession(t, 'admin');
    const { second } = await confirmed(adm, '/api/v1/databases/e2e/slowlog/reset', {});
    expect(second.status).toBe(200);
    expect(second.json).toEqual({ ok: true });
    const ro = await adm.req('POST', '/api/v1/databases/e2e-ro/slowlog/reset', {});
    expect(ro.status).toBe(403);
    expect(ro.json.error.code).toBe('read_only');
    expect(t.ctx.audit.query({ limit: 5, action: 'slowlog.reset', outcome: 'allowed' }).events.length).toBe(1);
  });

  it('GET /clients: admin only', async () => {
    for (const role of ['viewer', 'operator'] as const) {
      const c = await userSession(t, role);
      expect((await c.req('GET', '/api/v1/databases/e2e/clients')).status).toBe(403);
    }
    const adm = await userSession(t, 'admin');
    const res = await adm.req('GET', '/api/v1/databases/e2e/clients');
    expect(res.status).toBe(200);
    expect(res.json.clients.length).toBeGreaterThan(0);
    const me = res.json.clients.find((c: any) => c.user === 'rc-admin');
    expect(me).toMatchObject({ id: expect.stringMatching(/^\d+$/), addr: expect.any(String), age: expect.any(Number), db: 0 });
  });

  it('POST /clients/kill: admin, confirmation, kills only the given client; unknown id -> 404', async () => {
    const victim = await sandboxAdmin();
    const id = String(await victim.sendCommand(['CLIENT', 'ID']));
    const op = await userSession(t, 'operator');
    expect((await op.req('POST', '/api/v1/databases/e2e/clients/kill', { id })).status).toBe(403);
    const adm = await userSession(t, 'admin');
    expect((await adm.req('POST', '/api/v1/databases/e2e/clients/kill', { id: 'abc' })).status).toBe(400);
    const { first, second } = await confirmed(adm, '/api/v1/databases/e2e/clients/kill', { id });
    expect(first.json.error.confirmation.level).toBe('confirm');
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    const clients = (await adm.req('GET', '/api/v1/databases/e2e/clients')).json.clients;
    expect(clients.find((c: any) => c.id === id)).toBeUndefined();
    await victim.destroy();
    const { second: missing } = await confirmed(adm, '/api/v1/databases/e2e/clients/kill', { id: '999999999' });
    expect(missing.status).toBe(404);
  });

  it('POST /analysis: viewer, bounded, report shape', async () => {
    const v = await userSession(t, 'viewer');
    const res = await v.req('POST', '/api/v1/databases/e2e/analysis', { match: `${P}*`, sampleSize: 100 });
    expect(res.status).toBe(200);
    const rep = res.json;
    expect(rep.sampled).toBe(42);
    expect(rep.totalSampledBytes).toBeGreaterThan(0);
    expect(rep.byType.find((x: any) => x.type === 'string').keys).toBe(41);
    expect(rep.byType.find((x: any) => x.type === 'hash').keys).toBe(1);
    expect(rep.topKeysBySize.length).toBeGreaterThan(0);
    expect(rep.topKeysBySize[0].bytes).toBeGreaterThanOrEqual(rep.topKeysBySize[rep.topKeysBySize.length - 1].bytes);
    expect(rep.topKeysByLength[0].length).toBe(390);
    expect(rep.prefixes.map((p: any) => p.prefix)).toContain('rcsrv:');
    expect(rep.ttl.noExpiry).toBe(41);
    expect(rep.ttl.lt1h).toBe(1);
    expect(typeof rep.durationMs).toBe('number');
    expect(typeof rep.dbSize).toBe('number');
    expect((await v.req('POST', '/api/v1/databases/e2e/analysis', { sampleSize: 50 })).status).toBe(400);
    expect((await v.req('POST', '/api/v1/databases/e2e/analysis', { sampleSize: 100_001 })).status).toBe(400);
    expect((await v.req('POST', '/api/v1/databases/e2e/analysis', { delimiter: '::::::' })).status).toBe(400);
  });

  it('one concurrent analysis per user (429)', async () => {
    const v = await userSession(t, 'viewer');
    const db = mainUp ? 'main' : 'e2e';
    const [a, b] = await Promise.all([
      v.req('POST', `/api/v1/databases/${db}/analysis`, { sampleSize: 2000 }),
      v.req('POST', `/api/v1/databases/${db}/analysis`, { sampleSize: 2000 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
  });
});
