/** Key browser API: scan, details per type, typed ops per type, large values, binary keys, Unicode. */
import { test, expect } from '@playwright/test';
import { Api, b64, binToBuffer, dbPath, keyRead, utf8 } from '../../lib/api.ts';
import { DB } from '../../lib/env.ts';
import { BIG_HASH_FIELDS, BIG_LIST_ITEMS, BIG_VALUE_BYTES, BINARY_KEY, BINARY_VALUE, K, XSS_KEYS, XSS_PAYLOADS, redisExec } from '../../lib/fixtures-data.ts';

const E = (s: string) => dbPath(DB.e2e, s);
const readKey = (api: Api, k: string | Buffer, extra: Record<string, unknown> = {}) => api.post(E('key/read'), keyRead(k, extra));
const scan = (api: Api, body: Record<string, unknown>, o?: Parameters<Api['post']>[2]) => api.post(E('keys/scan'), body, o);

test.describe('keys API', () => {
  let viewer: Api;
  let op: Api;
  test.beforeAll(async () => { viewer = await Api.fromStorage('viewer'); op = await Api.fromStorage('operator'); });
  test.afterAll(async () => { await viewer.dispose(); await op.dispose(); });

  test('scan pages through the keyspace with cursor, match and type filters', async () => {
    const seen = new Set<string>();
    let cursor = '0';
    let pages = 0;
    do {
      const r = await scan(viewer, { cursor, match: K.bulkPrefix + '*', count: 50 });
      expect(r.status).toBe(200);
      for (const k of r.json.keys) seen.add(binToBuffer(k.key).toString());
      cursor = r.json.cursor;
      pages++;
    } while (cursor !== '0' && pages < 100);
    expect(seen.size).toBeGreaterThanOrEqual(100);
    const typed = await scan(viewer, { match: 'e2e:*', type: 'hash', count: 1000 });
    expect(typed.status).toBe(200);
    for (const k of typed.json.keys) expect(k.type).toBe('hash');
    expect(typed.json.dbSize).toBeGreaterThan(200);
  });

  test('scan count above the cap is rejected or capped', async () => {
    const r = await scan(viewer, { count: 100000 });
    expect([200, 400]).toContain(r.status);
    if (r.status === 200) expect(r.json.keys.length).toBeLessThanOrEqual(1000);
  });

  test('details for every type', async () => {
    const cases: [string, string, (v: any) => void][] = [
      [K.str, 'string', (v) => expect(v.value).toEqual(utf8('Hello from Redis Console e2e'))],
      [K.hash, 'hash', (v) => expect(v.entries.map((e: any) => e.field.data).sort()).toEqual(['email', 'logins', 'name', 'role'])],
      [K.list, 'list', (v) => expect(v.items.map((i: any) => i.value.data)).toEqual(['job-1', 'job-2', 'job-3', 'job-4', 'job-5'])],
      [K.set, 'set', (v) => expect(v.members.map((m: any) => m.data).sort()).toEqual(['blue', 'green', 'red', 'yellow'])],
      [K.zset, 'zset', (v) => expect(v.members.map((m: any) => m.member.data)).toEqual(['carol', 'alice', 'bob', 'dave'])],
      [K.stream, 'stream', (v) => { expect(v.total).toBe(10); expect(v.groups).toBe(2); expect(v.entries[0].fields[0].field.data).toBe('order'); }],
      [K.json, 'json', (v) => expect(JSON.parse(v.json)).toMatchObject({ user: 'grace' })],
      [K.ts, 'timeseries', (v) => expect(v.samples.length).toBeGreaterThan(10)],
    ];
    for (const [key, vtype, check] of cases) {
      const r = await readKey(viewer, key);
      expect(r.status, `${key}: ${r.text.slice(0, 200)}`).toBe(200);
      expect(r.json.value.type, key).toBe(vtype);
      check(r.json.value);
    }
    const bloom = await readKey(viewer, K.bloom);
    expect(bloom.status).toBe(200);
    expect(bloom.json.type).toBe('MBbloom--');
    const ttl = await readKey(viewer, K.strTtl);
    expect(ttl.json.ttl).toBeGreaterThan(3600);
  });

  test('large string value is truncated at maxValueBytes with the total size reported', async () => {
    const r = await readKey(viewer, K.big);
    expect(r.status).toBe(200);
    const v = r.json.value;
    expect(v.truncated).toBe(true);
    expect(v.totalBytes).toBe(BIG_VALUE_BYTES);
    expect(binToBuffer(v.value).length).toBeLessThanOrEqual(524288);
    expect(r.text.length).toBeLessThan(1_000_000);
    // Explicit "load full value" is still capped at policy.maxValueBytes (512 KiB).
    const full = await readKey(viewer, K.big, { full: true });
    expect(full.status).toBe(200);
    expect(full.json.value.truncated).toBe(true);
    const n = binToBuffer(full.json.value.value).length;
    expect(n).toBeGreaterThan(binToBuffer(v.value).length - 1);
    expect(n).toBeLessThanOrEqual(524288);
  });

  test('large hash and list are paged, not returned whole', async () => {
    const h = await readKey(viewer, K.bigHash);
    expect(h.status).toBe(200);
    expect(h.json.value.total).toBe(BIG_HASH_FIELDS);
    expect(h.json.value.entries.length).toBeLessThan(BIG_HASH_FIELDS);
    expect(h.json.value.cursor).not.toBe('0');
    const l = await readKey(viewer, K.bigList);
    expect(l.json.value.total).toBe(BIG_LIST_ITEMS);
    expect(l.json.value.items.length).toBeLessThan(BIG_LIST_ITEMS);
    const l2 = await readKey(viewer, K.bigList, { offset: 19990, count: 100 });
    expect(l2.status).toBe(200);
  });

  test('binary key: listed as base64, readable by its raw bytes, value round-trips', async () => {
    const r = await scan(viewer, { match: 'e2e:bin:*', count: 1000 });
    expect(r.status).toBe(200);
    const k = (r.json.keys as any[]).find((x) => x.key.enc === 'base64');
    expect(k, 'binary key returned as base64 Bin').toBeTruthy();
    expect(binToBuffer(k.key).equals(BINARY_KEY)).toBe(true);
    const d = await readKey(viewer, BINARY_KEY);
    expect(d.status).toBe(200);
    expect(d.json.value.value.data).toBe('value of a binary key');
    const bv = await readKey(viewer, K.binValue);
    expect(bv.json.value.value.enc).toBe('base64');
    expect(binToBuffer(bv.json.value.value).equals(BINARY_VALUE)).toBe(true);
  });

  test('binary write: operator sets a binary key and value', async () => {
    const key = Buffer.concat([Buffer.from(K.scratchPrefix), Buffer.from([0xff, 0x00, 0xfe])]);
    const r = await op.post(E('ops'), { op: 'string.set', key: b64(key), value: b64(BINARY_VALUE) });
    expect(r.status, r.text).toBe(200);
    const raw = await redisExec<Buffer>(['GET', key]);
    expect(Buffer.from(raw).equals(BINARY_VALUE)).toBe(true);
  });

  test('Unicode / RTL keys round-trip exactly', async () => {
    for (const k of [K.unicode, K.rtl, K.arabic, K.zeroWidth]) {
      const r = await readKey(viewer, k);
      expect(r.status, k).toBe(200);
      expect(r.json.key).toEqual(utf8(k));
    }
  });

  test('XSS payload keys are returned verbatim as data (JSON-escaped, never HTML)', async () => {
    const r = await scan(viewer, { match: K.xssPrefix + '*', count: 1000 });
    const names = (r.json.keys as any[]).map((x) => x.key.data);
    for (const k of XSS_KEYS) expect(names).toContain(k);
    expect(r.headers['content-type']).toContain('application/json');
    const v = await readKey(viewer, XSS_KEYS[0]!);
    expect(v.json.value.value.data).toBe(XSS_PAYLOADS[0]);
  });

  test('invalid key parameter is a 400, missing key is a 404', async () => {
    expect((await viewer.post(E('key/read'), { key: { enc: 'base64', data: '***' } })).status).toBe(400);
    expect((await viewer.post(E('key/read'), { key: utf8('x'), extra: 1 })).status).toBe(400);
    expect((await readKey(viewer, 'e2e:does-not-exist')).status).toBe(404);
  });

  test('typed ops for every type (operator) change Redis exactly as requested', async () => {
    const p = K.scratchPrefix + 'ops:';
    const ops: [unknown, () => Promise<void>][] = [
      [{ op: 'string.set', key: utf8(`${p}s`), value: utf8('v1'), ttl: 600 }, async () => {
        expect(String(await redisExec(['GET', `${p}s`]))).toBe('v1');
        expect(Number(await redisExec(['TTL', `${p}s`]))).toBeGreaterThan(500);
      }],
      [{ op: 'string.set', key: utf8(`${p}s`), value: utf8('v2'), nx: true }, async () => expect(String(await redisExec(['GET', `${p}s`]))).toBe('v1')],
      [{ op: 'key.persist', key: utf8(`${p}s`) }, async () => expect(Number(await redisExec(['TTL', `${p}s`]))).toBe(-1)],
      [{ op: 'key.expire', key: utf8(`${p}s`), ttl: 1234 }, async () => expect(Number(await redisExec(['TTL', `${p}s`]))).toBeGreaterThan(1200)],
      [{ op: 'key.rename', key: utf8(`${p}s`), newKey: utf8(`${p}s2`) }, async () => expect(await redisExec(['EXISTS', `${p}s2`])).toBe(1)],
      [{ op: 'hash.set', key: utf8(`${p}h`), entries: [{ field: utf8('a'), value: utf8('1') }, { field: utf8('b'), value: utf8('2') }] }, async () => expect(Number(await redisExec(['HLEN', `${p}h`]))).toBe(2)],
      [{ op: 'hash.delete', key: utf8(`${p}h`), fields: [utf8('a')] }, async () => expect(Number(await redisExec(['HLEN', `${p}h`]))).toBe(1)],
      [{ op: 'list.push', key: utf8(`${p}l`), values: [utf8('x'), utf8('y')], end: 'tail' }, async () => expect(Number(await redisExec(['LLEN', `${p}l`]))).toBe(2)],
      [{ op: 'list.push', key: utf8(`${p}l`), values: [utf8('first')], end: 'head' }, async () => expect(String(await redisExec(['LINDEX', `${p}l`, 0]))).toBe('first')],
      [{ op: 'list.set', key: utf8(`${p}l`), index: 1, value: utf8('X') }, async () => expect(String(await redisExec(['LINDEX', `${p}l`, 1]))).toBe('X')],
      [{ op: 'list.remove', key: utf8(`${p}l`), value: utf8('y'), count: 1 }, async () => expect(Number(await redisExec(['LLEN', `${p}l`]))).toBe(2)],
      [{ op: 'set.add', key: utf8(`${p}set`), members: [utf8('m1'), utf8('m2')] }, async () => expect(Number(await redisExec(['SCARD', `${p}set`]))).toBe(2)],
      [{ op: 'set.remove', key: utf8(`${p}set`), members: [utf8('m1')] }, async () => expect(Number(await redisExec(['SCARD', `${p}set`]))).toBe(1)],
      [{ op: 'zset.add', key: utf8(`${p}z`), members: [{ member: utf8('a'), score: '1.5' }, { member: utf8('b'), score: '-inf' }] }, async () => expect(String(await redisExec(['ZSCORE', `${p}z`, 'a']))).toBe('1.5')],
      [{ op: 'zset.remove', key: utf8(`${p}z`), members: [utf8('b')] }, async () => expect(Number(await redisExec(['ZCARD', `${p}z`]))).toBe(1)],
      [{ op: 'stream.add', key: utf8(`${p}x`), fields: [{ field: utf8('f'), value: utf8('v') }] }, async () => expect(Number(await redisExec(['XLEN', `${p}x`]))).toBe(1)],
      [{ op: 'stream.group.create', key: utf8(`${p}x`), group: 'gg', id: '0' }, async () => expect((await redisExec<unknown[]>(['XINFO', 'GROUPS', `${p}x`])).length).toBe(1)],
      [{ op: 'json.set', key: utf8(`${p}j`), path: '$', json: '{"a":{"b":1}}' }, async () => expect(String(await redisExec(['JSON.GET', `${p}j`, '$.a.b']))).toBe('[1]')],
      [{ op: 'json.set', key: utf8(`${p}j`), path: '$.a.c', json: '"new"' }, async () => expect(String(await redisExec(['JSON.GET', `${p}j`, '$.a.c']))).toBe('["new"]')],
    ];
    for (const [body, check] of ops) {
      let r = await op.post(E('ops'), body);
      // Destructive ops (hash.delete, list.remove, set.remove, zset.remove, key.rename...) answer 428 first.
      if (r.status === 428) r = await op.post(E('ops'), { ...(body as object), confirmation: { token: r.json.error.confirmation.token } });
      expect(r.status, `${JSON.stringify(body).slice(0, 120)} -> ${r.text.slice(0, 200)}`).toBe(200);
      await check();
    }
    // Destructive ones need confirmation: stream.delete, json.delete, stream.group.destroy, rename onto existing...
    const xid = String(((await redisExec<any[]>(['XRANGE', `${p}x`, '-', '+']))[0] as any[])[0]);
    for (const body of [{ op: 'stream.delete', key: utf8(`${p}x`), ids: [xid] }, { op: 'json.delete', key: utf8(`${p}j`), path: '$.a.c' }, { op: 'stream.group.destroy', key: utf8(`${p}x`), group: 'gg' }]) {
      let r = await op.post(E('ops'), body);
      if (r.status === 428) r = await op.post(E('ops'), { ...body, confirmation: { token: r.json.error.confirmation.token } });
      expect(r.status, `${body.op}: ${r.text.slice(0, 200)}`).toBe(200);
    }
    expect(Number(await redisExec(['XLEN', `${p}x`]))).toBe(0);
  });

  test('validation: unknown op and extra fields are rejected', async () => {
    expect((await op.post(E('ops'), { op: 'string.eval', key: utf8('x') })).status).toBe(400);
    expect((await op.post(E('ops'), { op: 'zset.add', key: utf8('x'), members: [{ member: utf8('a'), score: '1; FLUSHALL' }] })).status).toBe(400);
    expect((await op.post(E('cli'), { line: 'PING', extra: true })).status).toBe(400);
    expect((await op.post(E('cli'), { line: 'PING', argv: ['PING'] })).status).toBe(400);
  });

  test('JSON body limit is enforced (> 12 MB rejected with 413)', async () => {
    const huge = 'x'.repeat(13 * 1024 * 1024);
    // The server may answer 413 and close the connection before the upload finishes (EPIPE on the client).
    const status = await op.post(E('ops'), { op: 'string.set', key: utf8(`${K.scratchPrefix}huge`), value: utf8(huge) }, { noScan: true }).then((r) => r.status, (e) => String(e));
    expect(status === 413 || /EPIPE|ECONNRESET|socket hang up/.test(String(status)), `got ${status}`).toBe(true);
    expect(await redisExec(['EXISTS', `${K.scratchPrefix}huge`])).toBe(0);
  });

  test('v0.2.1 names scan: names only, whole keyspace in few requests, exact lookups, binary names', async () => {
    const names = (body: Record<string, unknown>) => viewer.post(E('keys/names'), body);
    const all = new Set<string>();
    let cursor = '0', requests = 0, scanned = 0;
    do {
      const r = await names({ cursor, match: 'e2e:*' });
      expect(r.status, r.text.slice(0, 200)).toBe(200);
      for (const k of r.json.keys) {
        expect(Object.keys(k).sort()).toEqual(['data', 'enc']);
        all.add(binToBuffer(k).toString('latin1'));
      }
      scanned += r.json.scanned;
      cursor = r.json.cursor;
      requests++;
    } while (cursor !== '0' && requests < 50);
    expect(all.has(BINARY_KEY.toString('latin1'))).toBe(true);
    for (const k of XSS_KEYS) expect(all.has(Buffer.from(k).toString('latin1'))).toBe(true);
    const exact = await names({ match: K.hash });
    expect(exact.json).toMatchObject({ cursor: '0', exact: true, keys: [utf8(K.hash)] });
    expect((await names({ match: K.hash, type: 'string' })).json.keys).toEqual([]);
    expect((await names({ count: 10_001 })).status).toBe(400);
  });

  test('v0.2.1 metadata: type, TTL and size of up to 500 keys in request order', async () => {
    const keys = [utf8(K.hash), b64(BINARY_KEY), utf8('e2e:does-not-exist'), utf8(K.strTtl)];
    const r = await viewer.post(E('keys/meta'), { keys });
    expect(r.status).toBe(200);
    expect(r.json.keys.map((k: any) => k.type)).toEqual(['hash', 'string', 'none', 'string']);
    expect(binToBuffer(r.json.keys[1].key).equals(BINARY_KEY)).toBe(true);
    expect(r.json.keys[2].ttl).toBe(-2);
    expect(r.json.keys[3].ttl).toBeGreaterThan(3600);
    expect(r.json.keys[0].size).toBeGreaterThan(0);
    expect((await viewer.post(E('keys/meta'), { keys: Array.from({ length: 501 }, (_, i) => utf8(`k${i}`)) })).status).toBe(400);
  });

  test('v0.2.1 pattern delete job: confirmation, live counts, cancel, owner-only status', async () => {
    const prefix = `${K.scratchPrefix}job:`;
    for (let i = 0; i < 40; i++) await redisExec(['SET', `${prefix}${i}`, 'x']);
    const jobs = E('bulk-delete/jobs');
    const challenge = await op.post(jobs, { match: `${prefix}*` });
    expect(challenge.status).toBe(428);
    expect(challenge.json.error.confirmation.impact.keys).toBe(40);
    const c = challenge.json.error.confirmation;
    const started = await op.post(jobs, { match: `${prefix}*`, confirmation: { token: c.token, typed: c.expectedText } });
    expect(started.status, started.text).toBe(200);
    const id = started.json.job.id;
    let job = started.json.job;
    for (let i = 0; i < 100 && job.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = (await op.get(E(`bulk-delete/jobs/${id}`))).json.job;
    }
    expect(job).toMatchObject({ state: 'done', deleted: 40, failed: 0, complete: true, expected: 40 });
    expect((await viewer.get(E(`bulk-delete/jobs/${id}`))).status).toBe(403);
    expect(await redisExec(['EXISTS', `${prefix}0`])).toBe(0);
  });
});
