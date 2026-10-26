import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { cleanupPrefix, keyPrefix, bk, sandboxAdmin, sandboxUp, startApp, userSession, type TestApp } from '../helpers.ts';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;

describe.skipIf(!sandboxUp)('search, streams and timeseries routes', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('mod');
  const idx = `rcsrv-idx-${randomBytes(3).toString('hex')}`;

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    await r.sendCommand(['FT.CREATE', idx, 'ON', 'HASH', 'PREFIX', '1', `${P}doc:`, 'SCHEMA', 'title', 'TEXT', 'n', 'NUMERIC']);
    for (let i = 0; i < 5; i++) await r.hSet(`${P}doc:${i}`, { title: `hello world ${i}`, n: String(i) });
    for (let i = 0; i < 50; i++) {
      const info = (await r.sendCommand(['FT.INFO', idx])) as unknown;
      if (JSON.stringify(info, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)).includes('"num_docs",5') || i > 40) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    for (let i = 1; i <= 3; i++) await r.sendCommand(['XADD', `${P}stream`, `${i}-0`, 'f', String(i)]);
    await r.sendCommand(['XGROUP', 'CREATE', `${P}stream`, 'grp', '0']);
    await r.sendCommand(['XREADGROUP', 'GROUP', 'grp', 'consumer-a', 'COUNT', '2', 'STREAMS', `${P}stream`, '>']);
    for (const [ts, v] of [[1000, 1], [2000, 2], [3000, 3], [4000, 4]]) await r.sendCommand(['TS.ADD', `${P}ts`, String(ts), String(v)]);
  });
  afterAll(async () => {
    await r?.sendCommand(['FT.DROPINDEX', idx]).catch(() => {});
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('GET /search/indexes lists the index with fields and prefixes', async () => {
    // The sandbox ACL grants +ft._list +ft.info to rc-viewer and rc-operator (infra/redis/users.acl.template).
    for (const role of ['viewer', 'operator', 'admin'] as const) {
      const s = await userSession(t, role);
      const r2 = await s.req('GET', '/api/v1/databases/e2e/search/indexes');
      expect(r2.status, `${role}: ${JSON.stringify(r2.json)}`).toBe(200);
      expect(r2.json.indexes.some((i: any) => i.name === idx)).toBe(true);
    }
    const v = await userSession(t, 'viewer');
    const res = await v.req('GET', '/api/v1/databases/e2e/search/indexes');
    const mine = res.json.indexes.find((i: any) => i.name === idx);
    expect(mine).toBeDefined();
    expect(mine.prefixes).toEqual([`${P}doc:`]);
    expect(mine.fields).toEqual(expect.arrayContaining([{ name: 'title', type: 'TEXT' }, { name: 'n', type: 'NUMERIC' }]));
    expect(mine.numDocs).toBe(5);
  });

  it('POST /search/query returns docs and totals, with paging and validation', async () => {
    const v = await userSession(t, 'viewer');
    let res = await v.req('POST', '/api/v1/databases/e2e/search/query', { index: idx, query: 'hello', limit: 2 });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.total).toBe(5);
    expect(res.json.docs).toHaveLength(2);
    expect(res.json.docs[0].id.startsWith(`${P}doc:`)).toBe(true);
    expect(res.json.docs[0].fields.title).toMatch(/^hello world/);
    res = await v.req('POST', '/api/v1/databases/e2e/search/query', { index: idx, query: '@n:[3 4]' });
    expect(res.json.total).toBe(2);
    expect((await v.req('POST', '/api/v1/databases/e2e/search/query', { index: idx, query: 'x', limit: 101 })).status).toBe(400);
    expect((await v.req('POST', '/api/v1/databases/e2e/search/query', { query: 'x' })).status).toBe(400);
    res = await v.req('POST', '/api/v1/databases/e2e/search/query', { index: `${idx}-missing`, query: '*' });
    expect(res.status).toBe(502);
    expect(res.json.error.code).toBe('redis_error');
  });

  it('POST /streams/groups and /streams/pending', async () => {
    const v = await userSession(t, 'viewer');
    let res = await v.req('POST', '/api/v1/databases/e2e/streams/groups', { key: bk(`${P}stream`) });
    expect(res.status).toBe(200);
    expect(res.json.groups).toHaveLength(1);
    expect(res.json.groups[0]).toMatchObject({ name: 'grp', pending: 2, lastDeliveredId: '2-0', entriesRead: 2, lag: 1 });
    expect(res.json.groups[0].consumers[0]).toMatchObject({ name: 'consumer-a', pending: 2, idleMs: expect.any(Number) });

    res = await v.req('POST', '/api/v1/databases/e2e/streams/pending', { key: bk(`${P}stream`), group: 'grp' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ total: 2, minId: '1-0', maxId: '2-0' });
    expect(res.json.pending.map((p: any) => [p.id, p.consumer, p.deliveries])).toEqual([
      ['1-0', 'consumer-a', 1],
      ['2-0', 'consumer-a', 1],
    ]);
    expect((await v.req('POST', '/api/v1/databases/e2e/streams/pending', { key: bk(`${P}stream`) })).status).toBe(400);
    expect((await v.req('POST', '/api/v1/databases/e2e/streams/pending', { key: bk(`${P}stream`), group: 'nope' })).status).toBe(502);
    expect((await v.req('POST', '/api/v1/databases/e2e/streams/groups', { key: bk(`${P}missing`) })).status).toBe(502);
  });

  it('POST /timeseries/range with and without aggregation', async () => {
    const v = await userSession(t, 'viewer');
    const TS = '/api/v1/databases/e2e/timeseries/range';
    const key = bk(`${P}ts`);
    let res = await v.req('POST', TS, { key });
    expect(res.status).toBe(200);
    expect(res.json.samples).toEqual([
      [1000, '1'],
      [2000, '2'],
      [3000, '3'],
      [4000, '4'],
    ]);
    expect(res.json.key).toEqual({ enc: 'utf8', data: `${P}ts` });
    res = await v.req('POST', TS, { key, from: 2000, to: 3000 });
    expect(res.json.samples.map((s: any) => s[0])).toEqual([2000, 3000]);
    res = await v.req('POST', TS, { key, bucketMs: 2000, agg: 'sum' });
    expect(res.json.aggregation).toBe('sum/2000ms');
    expect(res.json.samples).toEqual([
      [0, '1'],
      [2000, '5'],
      [4000, '4'],
    ]);
    expect((await v.req('POST', TS, { key, bucketMs: 2000 })).status).toBe(400);
    expect((await v.req('POST', TS, { key, agg: 'avg' })).status).toBe(400);
    expect((await v.req('POST', TS, { key, agg: 'bogus', bucketMs: 10 })).status).toBe(400);
  });
});
