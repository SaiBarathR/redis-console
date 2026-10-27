/**
 * v0.4 arrays (F24): the array routes and typed ops against the real server, per role and per database kind:
 * sandbox (test), the prod simulation (typed name + reason) and the read-only remote (every write refused for every
 * role; reads pass the read-only proxy, which specs/final checks recorded no write).
 */
import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { ARGREP_HINT } from '@rconsole/shared';
import { Api, dbPath, utf8 } from '../../lib/api.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';

const E = (s: string) => dbPath(DB.e2e, s);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const key = `${K.scratchPrefix}api-array`;
const text = (v: unknown) => (Buffer.isBuffer(v) ? v.toString() : v == null ? null : String(v));

test.describe('arrays (v0.4)', () => {
  let viewer: Api, operator: Api, admin: Api;
  test.beforeAll(async () => {
    [viewer, operator, admin] = await Promise.all([Api.fromStorage('viewer'), Api.fromStorage('operator'), Api.fromStorage('admin')]);
    await redisExec(['UNLINK', key]);
    await redisExec(['ARSET', key, 0, 'a', 'b', 'c']);
  });
  test.afterAll(async () => {
    await redisExec(['UNLINK', key]);
    for (const a of [viewer, operator, admin]) await a.dispose();
  });

  test('key/read and array/range return exact indices beyond 2^53, with element references', async () => {
    const read = await viewer.post(E('key/read'), { key: utf8(K.array), count: 10 });
    expect(read.status, read.text).toBe(200);
    expect(read.json.type).toBe('array');
    expect(read.json.value.info).toMatchObject({ count: '5', length: '9007199254740994' });
    expect(read.json.value.items.map((i: { index: string }) => i.index)).toEqual(['0', '1', '2', '1000', '9007199254740993']);
    const page = await viewer.post(E('array/range'), { key: utf8(K.array), start: '3', count: 1 });
    expect(page.json.items[0]).toEqual({ index: '1000', value: utf8('thousand'), ref: { kind: 'array', index: '1000', identity: sha('thousand') } });
    expect(page.json.next).toBe('1001');
    const full = await viewer.post(E('key/element'), { key: utf8(K.array), ref: page.json.items[0].ref });
    expect(full.json.value).toEqual(utf8('thousand'));
  });

  test('compare-and-set edits: a stale expectation is a 409 and writes nothing', async () => {
    const ok = await operator.post(E('ops'), { op: 'array.set', key: utf8(key), index: '1', value: utf8('B'), expect: { type: 'array', sha256: sha('b') } });
    expect(ok.status, ok.text).toBe(200);
    const stale = await operator.post(E('ops'), { op: 'array.set', key: utf8(key), index: '1', value: utf8('X'), expect: { type: 'array', sha256: sha('b') } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.conflict.current.value).toEqual(utf8('B'));
    expect(text(await redisExec(['ARGET', key, 1]))).toBe('B');
    expect((await viewer.post(E('ops'), { op: 'array.set', key: utf8(key), index: '1', value: utf8('X'), expect: { type: 'array', sha256: sha('B') } })).status).toBe(403);
  });

  test('ARGREP is refused: RE is not a predicate of the search route, and the console blocks ARGREP for everyone', async () => {
    const route = await admin.post(E('array/search'), { key: utf8(key), predicates: [{ kind: 're', value: utf8('(a+)+$') }] });
    expect(route.status).toBe(400);
    const cli = await admin.post(E('cli'), { line: `ARGREP ${key} 0 10 RE "(a+)+$"` });
    expect(cli.status).toBe(403);
    expect(cli.json.error).toMatchObject({ code: 'command_blocked', hint: ARGREP_HINT });
    expect((await viewer.post(E('cli'), { line: `ARGREP ${key} 0 10 GLOB *` })).status).toBe(403);
  });

  test('prod: every array write needs the typed database name and a reason', async () => {
    const body = { op: 'array.set', key: utf8(key), index: '9', value: utf8('p'), expect: { type: 'array', sha256: null } };
    const first = await operator.post(dbPath(DB.prodSim, 'ops'), body);
    expect(first.status).toBe(428);
    expect(first.json.error.confirmation).toMatchObject({ level: 'typed', reasonRequired: true });
  });

  test('read-only remote: array reads pass the read-only proxy; every array write is refused for every role', async () => {
    const R = (s: string) => dbPath(DB.remote, s);
    const probe = utf8('rconsole-e2e:array-probe-never-created');
    // A missing key: TYPE (a read) passes the proxy and every array read answers 404 (review v0.4 r1 L3).
    expect((await viewer.post(R('array/range'), { key: probe, count: 5 })).status).toBe(404);
    expect((await viewer.post(R('array/search'), { key: probe, predicates: [{ kind: 'exact', value: utf8('x') }] })).status).toBe(404);
    expect((await viewer.post(R('array/aggregate'), { key: probe, start: '0', end: '10', op: 'sum' })).status).toBe(404);
    // The disposable fixture holds an array (an external upstream may not): ARSCAN, ARGREP with its MEMORY USAGE and
    // ARCOUNT sizing, and AROP pass the read-only proxy, which the final spec checks recorded no other command.
    const arr = utf8('example:remote:array');
    const range = await viewer.post(R('array/range'), { key: arr, count: 5 });
    if (range.status !== 404) {
      expect(range.json.items.map((i: { index: string }) => i.index)).toEqual(['0', '1', '2']);
      const found = await viewer.post(R('array/search'), { key: arr, predicates: [{ kind: 'match', value: utf8('ET') }], nocase: true });
      expect(found.json).toMatchObject({ items: [{ index: '1' }], elements: 3 });
      expect((await viewer.post(R('array/aggregate'), { key: arr, start: '0', end: '10', op: 'used' })).json).toMatchObject({ op: 'used', elements: 3 });
    }
    for (const api of [viewer, operator, admin]) {
      for (const body of [
        { op: 'array.insert', key: probe, values: [utf8('x')], expect: { type: 'none' } },
        { op: 'array.delete-range', key: probe, start: '0', end: '10' },
      ]) {
        const r = await api.post(R('ops'), body);
        expect(r.status, `${body.op}: ${r.text}`).toBe(403);
      }
    }
  });
});
