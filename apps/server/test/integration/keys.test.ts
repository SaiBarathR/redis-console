import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, cleanupPrefix, keyPrefix, sandboxAdmin, testConfig, utf8, sandboxUp, startApp, userSession, type TestApp } from '../helpers.ts';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;
const binText = (b: { enc: string; data: string }) => (b.enc === 'utf8' ? b.data : Buffer.from(b.data, 'base64').toString('latin1'));

describe.skipIf(!sandboxUp)('POST /keys/scan', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('scan');
  const strings = Array.from({ length: 25 }, (_, i) => `${P}s:${i}`);

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    for (const k of strings) await r.set(k, 'v');
    await r.hSet(`${P}h`, 'f', 'v');
    await r.set(`${P}ttl`, 'v', { EX: 1000 });
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('continues the cursor until 0 and returns every matching key exactly once', async () => {
    const c = await userSession(t, 'viewer');
    const seen: string[] = [];
    let cursor = '0';
    let pages = 0;
    do {
      const res = await c.req('POST', '/api/v1/databases/e2e/keys/scan', { match: `${P}s:*`, count: 10, cursor });
      expect(res.status).toBe(200);
      for (const k of res.json.keys) seen.push(binText(k.key));
      expect(typeof res.json.dbSize).toBe('number');
      expect(typeof res.json.scanned).toBe('number');
      cursor = res.json.cursor;
      pages++;
    } while (cursor !== '0' && pages < 500);
    expect(cursor).toBe('0');
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(strings));
  });

  it('never drops keys when a page overshoots its size (cursor already past them)', async () => {
    const Q = `${P}many:`;
    const many = Array.from({ length: 2600 }, (_, i) => `${Q}${i}`);
    for (let i = 0; i < many.length; i += 500) {
      const m = r.multi();
      for (const k of many.slice(i, i + 500)) m.set(k, 'v');
      await m.exec();
    }
    const c = await userSession(t, 'viewer');
    const seen: string[] = [];
    let cursor = '0';
    let pages = 0;
    do {
      const res = await c.req('POST', '/api/v1/databases/e2e/keys/scan', { match: `${Q}*`, count: 1000, cursor });
      expect(res.status).toBe(200);
      for (const k of res.json.keys) seen.push(binText(k.key));
      cursor = res.json.cursor;
      pages++;
    } while (cursor !== '0' && pages < 500);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(many.length);
  });

  it('returns type, ttl and size metadata and honours the TYPE filter', async () => {
    const c = await userSession(t, 'viewer');
    const all: any[] = [];
    let cursor = '0';
    do {
      const res = await c.req('POST', '/api/v1/databases/e2e/keys/scan', { match: `${P}*`, count: 1000, cursor });
      expect(res.status).toBe(200);
      all.push(...res.json.keys);
      cursor = res.json.cursor;
    } while (cursor !== '0');
    const h = all.find((k) => binText(k.key) === `${P}h`);
    expect(h.type).toBe('hash');
    expect(h.ttl).toBe(-1);
    expect(h.size).toBeGreaterThan(0);
    const ttl = all.find((k) => binText(k.key) === `${P}ttl`);
    expect(ttl.ttl).toBeGreaterThan(900);

    const hashes: any[] = [];
    cursor = '0';
    do {
      const res = await c.req('POST', '/api/v1/databases/e2e/keys/scan', { match: `${P}*`, type: 'hash', count: 1000, cursor });
      hashes.push(...res.json.keys);
      cursor = res.json.cursor;
    } while (cursor !== '0');
    expect(hashes.map((k) => binText(k.key))).toEqual([`${P}h`]);
    expect(hashes[0].type).toBe('hash');
  });

  it('validates count bounds and cursor format', async () => {
    const c = await userSession(t, 'viewer');
    expect((await c.req('POST', '/api/v1/databases/e2e/keys/scan', { count: 9 })).status).toBe(400);
    expect((await c.req('POST', '/api/v1/databases/e2e/keys/scan', { count: 1001 })).status).toBe(400);
    expect((await c.req('POST', '/api/v1/databases/e2e/keys/scan', { cursor: 'abc' })).status).toBe(400);
    const ok = await c.req('POST', '/api/v1/databases/e2e/keys/scan', { count: 10 });
    expect(ok.status).toBe(200);
    expect(ok.json.cursor).toMatch(/^\d+$/);
  });

  it('unknown database -> 404, anonymous -> 401', async () => {
    const c = await userSession(t, 'viewer');
    expect((await c.req('POST', '/api/v1/databases/nope/keys/scan', {})).status).toBe(404);
    const anon = await t.app.inject({ method: 'POST', url: '/api/v1/databases/e2e/keys/scan', headers: { origin: ORIGIN, 'content-type': 'application/json' }, payload: '{}' });
    expect(anon.statusCode).toBe(401);
  });

  it('rate limits scanning per user (429)', async () => {
    const c = await userSession(t, 'viewer');
    const body = { match: `${P}nothing*`, count: 10 };
    const statuses = await Promise.all(Array.from({ length: 40 }, () => c.req('POST', '/api/v1/databases/e2e/keys/scan', body).then((x) => x.status)));
    expect(statuses).toContain(429);
    expect(statuses).toContain(200);
  });
});

describe.skipIf(!sandboxUp)('POST /key/read (details)', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('key');
  const READ = '/api/v1/databases/e2e/key/read';
  const body = (k: string, o: Record<string, unknown> = {}) => ({ key: utf8(k), ...o });

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    await r.set(`${P}small`, 'hello');
    await r.set(`${P}big`, 'a'.repeat(100_000));
    await r.set(`${P}huge`, 'b'.repeat(600_000));
    const fields: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) fields[`f${i}`] = `v${i}`;
    await r.hSet(`${P}hash`, fields);
    await r.hSet(`${P}bighash`, { big: 'x'.repeat(70_000), small: 'y' });
    await r.rPush(`${P}list`, Array.from({ length: 30 }, (_, i) => `item${i}`));
    await r.sAdd(`${P}set`, Array.from({ length: 200 }, (_, i) => `m${i}`));
    await r.sendCommand(['ZADD', `${P}zset`, '1.5', 'a', '-inf', 'b', '3', 'c']);
    for (let i = 1; i <= 5; i++) await r.sendCommand(['XADD', `${P}stream`, `${i}-1`, 'n', String(i)]);
    await r.sendCommand(['XGROUP', 'CREATE', `${P}stream`, 'g1', '0']);
    await r.sendCommand(['JSON.SET', `${P}json`, '$', '{"a":1,"b":[true,null]}']);
    await r.sendCommand(['TS.ADD', `${P}ts`, '1000', '1.5']);
    await r.sendCommand(['TS.ADD', `${P}ts`, '2000', '2.5']);
    await r.sendCommand(['BF.ADD', `${P}bloom`, 'x']);
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('string: preview, full=1 and maxValueBytes cap', async () => {
    const c = await userSession(t, 'viewer');
    let res = await c.req('POST', READ, body(`${P}small`));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ type: 'string', ttl: -1, length: 5, value: { type: 'string', value: { enc: 'utf8', data: 'hello' }, truncated: false, totalBytes: 5 } });
    expect(res.json.key).toEqual({ enc: 'utf8', data: `${P}small` });
    expect(typeof res.json.encoding).toBe('string');

    res = await c.req('POST', READ, body(`${P}big`));
    expect(res.json.value.truncated).toBe(true);
    expect(res.json.value.totalBytes).toBe(100_000);
    expect(res.json.value.value.data.length).toBe(65_536);

    res = await c.req('POST', READ, body(`${P}big`, { full: true }));
    expect(res.json.value.truncated).toBe(false);
    expect(res.json.value.value.data.length).toBe(100_000);

    res = await c.req('POST', READ, body(`${P}huge`, { full: true }));
    expect(res.json.value.truncated).toBe(true);
    expect(res.json.value.totalBytes).toBe(600_000);
    expect(res.json.value.value.data.length).toBe(524_288);
  });

  it('hash: HSCAN cursor paging collects every field; oversized values are flagged', async () => {
    const c = await userSession(t, 'viewer');
    const fields = new Set<string>();
    let cursor = '0';
    let pages = 0;
    do {
      const res = await c.req('POST', READ, body(`${P}hash`, { cursor, count: 50 }));
      expect(res.status).toBe(200);
      expect(res.json.value.total).toBe(1000);
      for (const e of res.json.value.entries) {
        fields.add(e.field.data);
        expect(e.value.data).toBe(`v${e.field.data.slice(1)}`);
      }
      if (pages === 0 && res.json.encoding === 'hashtable') expect(res.json.value.cursor).not.toBe('0');
      cursor = res.json.value.cursor;
      pages++;
    } while (cursor !== '0' && pages < 200);
    expect(fields.size).toBe(1000);

    const big = await c.req('POST', READ, body(`${P}bighash`));
    const e = big.json.value.entries.find((x: any) => x.field.data === 'big');
    expect(e.truncated).toBe(true);
    expect(e.value.data.length).toBe(65_536);
    expect(big.json.value.entries.find((x: any) => x.field.data === 'small').truncated).toBeUndefined();
  });

  it('list: offset/count paging', async () => {
    const c = await userSession(t, 'viewer');
    const res = await c.req('POST', READ, body(`${P}list`, { offset: 10, count: 5 }));
    expect(res.json.value).toMatchObject({ type: 'list', offset: 10, total: 30 });
    expect(res.json.value.items.map((i: any) => [i.index, i.value.data])).toEqual([10, 11, 12, 13, 14].map((i) => [i, `item${i}`]));
    expect(res.json.length).toBe(30);
  });

  it('set: SSCAN paging collects every member', async () => {
    const c = await userSession(t, 'viewer');
    const members = new Set<string>();
    let cursor = '0';
    do {
      const res = await c.req('POST', READ, body(`${P}set`, { cursor, count: 50 }));
      expect(res.json.value.total).toBe(200);
      for (const m of res.json.value.members) members.add(m.data);
      cursor = res.json.value.cursor;
    } while (cursor !== '0');
    expect(members.size).toBe(200);
  });

  it('zset: scores are exact strings', async () => {
    const c = await userSession(t, 'viewer');
    const res = await c.req('POST', READ, body(`${P}zset`));
    expect(res.json.value).toMatchObject({ type: 'zset', offset: 0, total: 3 });
    expect(res.json.value.members.map((m: any) => [m.member.data, m.score])).toEqual([
      ['b', '-inf'],
      ['a', '1.5'],
      ['c', '3'],
    ]);
  });

  it('stream: newest first, paging by entry id, lastId and groups', async () => {
    const c = await userSession(t, 'viewer');
    let res = await c.req('POST', READ, body(`${P}stream`, { count: 2 }));
    expect(res.json.value).toMatchObject({ type: 'stream', total: 5, lastId: '5-1', groups: 1 });
    expect(res.json.value.entries.map((e: any) => e.id)).toEqual(['5-1', '4-1']);
    expect(res.json.value.entries[0].fields).toMatchObject([{ field: { enc: 'utf8', data: 'n' }, value: { enc: 'utf8', data: '5' } }]);
    res = await c.req('POST', READ, body(`${P}stream`, { count: 2, cursor: '4-1' }));
    expect(res.json.value.entries.map((e: any) => e.id)).toEqual(['3-1', '2-1']);
  });

  it('JSON, TimeSeries and unsupported module types', async () => {
    const c = await userSession(t, 'viewer');
    const j = await c.req('POST', READ, body(`${P}json`));
    expect(j.json.type).toBe('ReJSON-RL');
    expect(j.json.value.type).toBe('json');
    expect(j.json.value.truncated).toBe(false);
    expect(JSON.parse(j.json.value.json)).toEqual({ a: 1, b: [true, null] });

    const ts = await c.req('POST', READ, body(`${P}ts`));
    expect(ts.json.type).toBe('TSDB-TYPE');
    expect(ts.json.value.type).toBe('timeseries');
    expect(ts.json.value.samples).toEqual([
      [1000, '1.5'],
      [2000, '2.5'],
    ]);
    expect(typeof ts.json.value.info).toBe('object');

    const bf = await c.req('POST', READ, body(`${P}bloom`));
    expect(bf.status).toBe(200);
    expect(bf.json.type).toMatch(/^MBbloom/);
    expect(bf.json.value.type).toBe('unsupported');
    expect(bf.json.value.message).toContain('BF.INFO');
  });

  it('vectorset -> unsupported (when the module is present)', async () => {
    const ok = await r.sendCommand(['VADD', `${P}vec`, 'VALUES', '2', '0.1', '0.2', 'el']).then(() => true, () => false);
    if (!ok) return;
    const c = await userSession(t, 'viewer');
    const res = await c.req('POST', READ, body(`${P}vec`));
    expect(res.json.type).toBe('vectorset');
    expect(res.json.value.type).toBe('unsupported');
  });

  it('reads are side-effect free POSTs: no confirmation on prod, one audit entry each (review v0.2 M6)', async () => {
    const c = await userSession(t, 'viewer');
    const before = t.ctx.audit.query({ user: c.username, limit: 50 }).events.length;
    const res = await c.req('POST', '/api/v1/databases/e2e-prod/key/read', body(`${P}small`));
    expect(res.status).toBe(200);
    expect(res.json.value.value.data).toBe('hello');
    const scan = await c.req('POST', '/api/v1/databases/e2e-prod/keys/scan', { match: `${P}*`, count: 10 });
    expect(scan.status).toBe(200);
    const ro = await c.req('POST', '/api/v1/databases/e2e-ro/key/read', body(`${P}small`));
    expect(ro.status).toBe(200);
    const events = t.ctx.audit.query({ user: c.username, limit: 50 }).events;
    expect(events.length).toBe(before + 3);
    expect(events.slice(0, 3).map((e) => [e.action, e.outcome])).toEqual([['key.read', 'allowed'], ['key.scan', 'allowed'], ['key.read', 'allowed']]);
  });

  it('missing key -> 404; bad k -> 400; count bounds', async () => {
    const c = await userSession(t, 'viewer');
    expect((await c.req('POST', READ, body(`${P}missing`))).status).toBe(404);
    expect((await c.req('POST', READ, { key: { enc: 'base64', data: 'not valid!' } })).status).toBe(400);
    expect((await c.req('POST', READ, {})).status).toBe(400);
    expect((await c.req('POST', READ, { ...body(`${P}small`), k: 'x' })).status).toBe(400);
    expect((await c.req('POST', READ, body(`${P}list`, { count: 1001 }))).status).toBe(400);
    expect((await c.req('POST', READ, body(`${P}list`, { count: 0 }))).status).toBe(400);
  });
});

describe.skipIf(!sandboxUp)('key browser page budgets (review H4)', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('budget');
  const MAX = 1024;
  const READ = '/api/v1/databases/e2e/key/read';
  beforeAll(async () => {
    const cfg = testConfig();
    cfg.policy.maxReplyBytes = MAX;
    t = await startApp(cfg);
    r = await sandboxAdmin();
    await r.rPush(`${P}list`, Array.from({ length: 20 }, (_, i) => `${i}:`.padEnd(4096, 'v')));
    const h: Record<string, string> = {};
    for (let i = 0; i < 20; i++) h[`f${i}`] = 'w'.repeat(4096);
    await r.hSet(`${P}hash`, h);
    await r.sAdd(`${P}set`, Array.from({ length: 20 }, (_, i) => `${i}:`.padEnd(4096, 's')));
    await r.zAdd(`${P}zset`, Array.from({ length: 20 }, (_, i) => ({ score: i, value: `${i}:`.padEnd(4096, 'z') })));
    for (let i = 1; i <= 20; i++) await r.sendCommand(['XADD', `${P}stream`, `${i}-1`, 'f', 'x'.repeat(4096)]);
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('each page stays within a small multiple of maxReplyBytes, and paging still reaches every element', async () => {
    const c = await userSession(t, 'viewer');
    const page = async (key: string, o: Record<string, unknown>) => {
      const res = await c.req('POST', READ, { key: utf8(`${P}${key}`), count: 20, ...o });
      expect(res.status).toBe(200);
      expect(Buffer.byteLength(res.body), `${key} page bytes`).toBeLessThan(8 * MAX);
      return res.json.value;
    };
    // list / zset: offset paging
    for (const [key, field] of [['list', 'items'], ['zset', 'members']] as const) {
      let offset = 0;
      let n = 0;
      for (let i = 0; i < 100 && offset < 20; i++) {
        const v = await page(key, { offset });
        expect(v[field].length).toBeGreaterThan(0);
        n += v[field].length;
        offset += v[field].length;
      }
      expect(n, key).toBe(20);
    }
    // hash / set: cursor paging
    for (const [key, field] of [['hash', 'entries'], ['set', 'members']] as const) {
      let cursor = '0';
      let n = 0;
      let i = 0;
      do {
        const v = await page(key, { cursor });
        n += v[field].length;
        cursor = v.cursor;
      } while (cursor !== '0' && ++i < 100);
      expect(n, key).toBe(20);
    }
    // stream: id paging
    let cursor: string | undefined;
    let n = 0;
    for (let i = 0; i < 100 && n < 20; i++) {
      const v = await page('stream', cursor ? { cursor } : {});
      if (!v.entries.length) break;
      n += v.entries.length;
      cursor = v.entries.at(-1).id;
    }
    expect(n).toBe(20);
  });
});
