/**
 * v0.4 arrays: the array inspector's reads, typed writes and console policy, against Redis 8 arrays on the 6411
 * sandbox (keys under this file's own prefix, deleted afterwards). Bisection of the search window and the aggregate
 * bound are covered with a fake connection in unit/array.test.ts (they need more than a million elements here).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARGREP_HINT, ARRAY_MAX_INDEX, ARRAY_SEARCH_MAX_BYTES } from '@rconsole/shared';
import { checkedWrite, type CheckedPlan } from '../../src/redis/checked.ts';
import { searchMatcher } from '../../src/redis/array.ts';
import { zArraySearch } from '@rconsole/shared';
import type { Conn } from '../../src/redis/manager.ts';
import { HttpError } from '../../src/http/errors.ts';
import { b64, cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, userSession, utf8, type Client, type TestApp } from '../helpers.ts';
import { confirmed } from './data-helpers.ts';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const DB = '/api/v1/databases/e2e';
type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;

describe.skipIf(!sandboxUp)('v0.4 arrays', () => {
  let t: TestApp;
  let r: Admin;
  let viewer: Client, operator: Client, admin: Client;
  const P = keyPrefix('array');
  const k = (s: string) => `${P}${s}`;
  const ar = (...args: (string | Buffer)[]) => r.sendCommand(args);
  const BIN = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x41]);

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    [viewer, operator, admin] = await Promise.all([userSession(t, 'viewer'), userSession(t, 'operator'), userSession(t, 'admin')]);
    // Sparse: 0..2, 1000, a binary value at 5000, an index above 2^53 and the last index Redis accepts.
    await ar('ARSET', k('sparse'), '0', 'zero', 'one', 'two');
    await ar('ARSET', k('sparse'), '1000', 'thousand');
    await ar('ARSET', k('sparse'), '5000', BIN);
    await ar('ARSET', k('sparse'), '9007199254740993', 'beyond-2^53');
    await ar('ARSET', k('sparse'), ARRAY_MAX_INDEX, 'last');
    // Dense, numeric and textual values for search and aggregates.
    await ar('ARSET', k('dense'), '0', ...Array.from({ length: 250 }, (_, i) => String(i)));
    await ar('ARSET', k('words'), '0', 'apple', 'banana', 'Apple pie', 'cherry', 'pineapple', '42');
    // One element larger than a preview (64 KiB) and one larger than maxValueBytes (512 KiB).
    await ar('ARSET', k('big'), '0', 'x'.repeat(100_000), 'y'.repeat(600_000));
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  describe('search matches as ARGREP does (review v0.4 r2 H2: the search runs on the server)', () => {
    it('EXACT, MATCH and GLOB, with and without NOCASE, agree with ARGREP on Redis for edge-case values and patterns', async () => {
      const values: Buffer[] = [
        '', 'a', 'A', 'abc', 'ABC', 'aBc', 'a*c', 'a?c', 'a[b]c', 'a\\c', 'x-y', ']', '^', '[', '\\', '-', 'é', 'É', 'hello world',
        'Hello World', 'aaaaaaaaab', 'aaaaaaaaaa', 'Zebra', '0123', 'a-c', 'b', 'ab', 'abcabc',
      ].map((v) => Buffer.from(v));
      // Binary and single Latin-1 bytes (É 0xc9, é 0xe9): NOCASE must fold ASCII letters only.
      values.push(Buffer.from([0xff, 0x00, 0x80]), Buffer.from([0x00]), Buffer.from('a\r\nb'), Buffer.from([0xc9]), Buffer.from([0xe9]), Buffer.from([0x41, 0xc9, 0x62]));
      await ar('ARSET', k('fidelity'), '0', ...values);
      const globs = ['*', 'a*', '*c', 'a?c', '?', '??', '???', '[a-c]bc', '[c-a]bc', '[^a]bc', '[!a]bc', 'a\\*c', 'a[*]c', '[\\]]', '[]]', '[', 'a[', '[abc', '\\', '*\\', 'a*b*c',
        '[A-Z]*', 'h*o w*', 'H*O W*', 'É', 'é', '[^x]', 'a*a*a*a*b', '\\a\\b\\c', '*-*', '[a-]', '[-a]', '[a\\-c]', 'a\\', '**', '*a*', '[\\x00-\\x7f]', 'z*', 'Z*', '[0-9]*'];
      const substrings = ['a', 'A', 'b', 'é', 'É', 'wor', 'O W', 'aaaab', '\\', '[', 'c'];
      const exacts = ['abc', 'ABC', 'é', 'É', 'a', 'hello world'];
      const bin = (...b: number[]) => Buffer.from(b).toString('latin1');
      const latin1 = [bin(0xc9), bin(0xe9), bin(0xc0, 0x2d, 0xde), bin(0x5b, 0xc0, 0x2d, 0xde, 0x5d), bin(0x2a, 0xc9, 0x2a), bin(0x41, 0xe9, 0x42)];
      const cases: [string, string][] = [
        ...globs.map((g) => ['glob', g] as [string, string]),
        ...substrings.map((m) => ['match', m] as [string, string]),
        ...exacts.map((e) => ['exact', e] as [string, string]),
        ...latin1.flatMap((b) => [['glob', b], ['match', b], ['exact', b]] as [string, string][]),
      ];
      let compared = 0;
      for (const [kind, pattern] of cases) {
        for (const nocase of [false, true]) {
          let redis: string[];
          try {
            const reply = (await ar('ARGREP', k('fidelity'), '0', String(values.length - 1), kind.toUpperCase(), Buffer.from(pattern, latin1.includes(pattern) ? 'latin1' : 'utf8'), ...(nocase ? ['NOCASE'] : []), 'LIMIT', '1000')) as unknown as unknown[];
            redis = reply.map(String);
          } catch {
            continue; // Redis refuses the pattern; the search refuses or matches nothing, never more.
          }
          const value = latin1.includes(pattern) ? b64(Buffer.from(pattern, 'latin1')) : utf8(pattern);
          const m = searchMatcher(zArraySearch.parse({ key: utf8('k'), predicates: [{ kind, value }], nocase }));
          const ours = values.flatMap((v, i) => (m(v) ? [String(i)] : []));
          expect(ours, `${kind} ${JSON.stringify(pattern)}${nocase ? ' NOCASE' : ''}`).toEqual(redis);
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(100);
      // AND/OR over several predicates.
      for (const combine of ['and', 'or'] as const) {
        const reply = (await ar('ARGREP', k('fidelity'), '0', String(values.length - 1), 'MATCH', 'a', 'GLOB', '*c', combine.toUpperCase(), 'LIMIT', '1000')) as unknown as unknown[];
        const m = searchMatcher(zArraySearch.parse({ key: utf8('k'), predicates: [{ kind: 'match', value: utf8('a') }, { kind: 'glob', value: utf8('*c') }], combine }));
        expect(values.flatMap((v, i) => (m(v) ? [String(i)] : [])), combine).toEqual(reply.map(String));
      }
    });
  });

  describe('search work is bounded by the bytes it reads (review v0.4 r2 H2)', () => {
    it('clustered large values with many small ones elsewhere: one request reads at most ARRAY_SEARCH_MAX_BYTES of the range', async () => {
      // The reproduction: 5,000 values of 4 KiB at 0–4999 (20 MiB), then 50,000 one-byte values after them.
      const big = 'a'.repeat(4096);
      for (let i = 0; i < 5000; i += 500) await ar('ARSET', k('clustered'), String(i), ...Array<string>(500).fill(big));
      for (let i = 5000; i < 55_000; i += 5000) await ar('ARSET', k('clustered'), String(i), ...Array<string>(5000).fill('x'));
      const pattern = utf8('a'.repeat(63) + 'b');
      for (const [start, end] of [['0', '4999'], ['4999', '0']]) {
        const t0 = Date.now();
        const res = await viewer.req('POST', `${DB}/array/search`, { key: utf8(k('clustered')), start, end, predicates: Array.from({ length: 8 }, () => ({ kind: 'match', value: pattern })), nocase: true, values: false, limit: 1 });
        expect(res.status, res.body.slice(0, 200)).toBe(200);
        expect(res.json.items).toEqual([]);
        expect(res.json.elements * 4096).toBeLessThanOrEqual(ARRAY_SEARCH_MAX_BYTES);
        expect(res.json.elements).toBeGreaterThan(3000);
        expect(res.json.next).toBeDefined();
        expect(Date.now() - t0).toBeLessThan(5000);
      }
    });

    it('an element over half the budget is skipped by index; the search continues after it', async () => {
      await ar('ARSET', k('huge'), '0', 'small-a');
      await ar('ARSET', k('huge'), '5', Buffer.alloc(ARRAY_SEARCH_MAX_BYTES / 2 + 1024, 0x61));
      await ar('ARSET', k('huge'), '9', 'small-b');
      const find = (start: string) => viewer.req('POST', `${DB}/array/search`, { key: utf8(k('huge')), start, predicates: [{ kind: 'match', value: utf8('small') }], values: false });
      let res = await find('0');
      const seen: string[] = res.json.items.map((i: { index: string }) => i.index);
      const skipped: string[] = [...(res.json.skipped ?? [])];
      for (let n = 0; res.json.next && n < 5; n++) {
        res = await find(res.json.next);
        expect(res.status).toBe(200);
        seen.push(...res.json.items.map((i: { index: string }) => i.index));
        skipped.push(...(res.json.skipped ?? []));
      }
      expect(seen).toEqual(['0', '9']);
      expect(skipped).toEqual(['5']);
    });
  });

  describe('reads', () => {
    it('key/read: ARINFO summary and the first page, indices as exact decimal text, binary values as base64', async () => {
      const res = await viewer.req('POST', `${DB}/key/read`, { key: utf8(k('sparse')), count: 10 });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.type).toBe('array');
      expect(res.json.encoding).toBe('sliced-array');
      expect(res.json.length).toBe(7);
      const v = res.json.value;
      expect(v.info).toMatchObject({ count: '7', length: '18446744073709551615', nextInsertIndex: '0' });
      expect(v.items.map((i: any) => i.index)).toEqual(['0', '1', '2', '1000', '5000', '9007199254740993', ARRAY_MAX_INDEX]);
      expect(v.items[4].value).toEqual(b64(BIN));
      expect(v.items[0].ref).toEqual({ kind: 'array', index: '0', identity: sha('zero') });
      expect(v.next).toBeUndefined();
      expect(v).toMatchObject({ start: '0', end: ARRAY_MAX_INDEX, reverse: false });
    });

    it('key/read pages from `cursor` (start index) and from the end with `reverse`', async () => {
      const from = await viewer.req('POST', `${DB}/key/read`, { key: utf8(k('sparse')), cursor: '3', count: 2 });
      expect(from.json.value.items.map((i: any) => i.index)).toEqual(['1000', '5000']);
      expect(from.json.value.next).toBe('5001');
      const last = await viewer.req('POST', `${DB}/key/read`, { key: utf8(k('sparse')), reverse: true, count: 2 });
      expect(last.json.value.items.map((i: any) => i.index)).toEqual([ARRAY_MAX_INDEX, '9007199254740993']);
      expect(last.json.value.next).toBe('9007199254740992');
      const bad = await viewer.req('POST', `${DB}/key/read`, { key: utf8(k('sparse')), cursor: '18446744073709551615' });
      expect(bad.status).toBe(400);
    });

    it('array/range: next starts after the last index returned, jumps to any index, and stops at `end`', async () => {
      const page = (body: Record<string, unknown>) => viewer.req('POST', `${DB}/array/range`, { key: utf8(k('dense')), ...body });
      let res = await page({ count: 100 });
      expect(res.status).toBe(200);
      expect(res.json.items).toHaveLength(100);
      expect(res.json.next).toBe('100');
      res = await page({ start: res.json.next, count: 100 });
      expect(res.json.items[0].index).toBe('100');
      res = await page({ start: '200', count: 100 });
      expect(res.json.items).toHaveLength(50);
      expect(res.json.next).toBeUndefined();
      // A last page that is exactly full has no next page either, in both directions (review v0.4 r1 L1).
      res = await page({ start: '150', count: 100 });
      expect(res.json.items).toHaveLength(100);
      expect(res.json.next).toBeUndefined();
      res = await page({ start: '99', reverse: true, count: 100 });
      expect(res.json.items).toHaveLength(100);
      expect(res.json.next).toBeUndefined();
      expect((await viewer.req('POST', `${DB}/key/read`, { key: utf8(k('dense')), count: 250 })).json.value.next).toBeUndefined();
      res = await page({ start: '10', end: '14', count: 5 });
      expect(res.json.items.map((i: any) => i.index)).toEqual(['10', '11', '12', '13', '14']);
      expect(res.json.next).toBeUndefined();
      res = await page({ start: '20', reverse: true, count: 3 });
      expect(res.json.items.map((i: any) => i.index)).toEqual(['20', '19', '18']);
      expect(res.json.next).toBe('17');
      // Bounds and direction are validated before Redis is asked.
      for (const body of [{ count: 1001 }, { count: 0 }, { start: '-1' }, { start: '01' }, { start: '5', end: '1' }, { start: '1', end: '5', reverse: true }, { start: '18446744073709551615' }])
        expect((await page(body)).status, JSON.stringify(body)).toBe(400);
      // Like the vector-set routes: a missing key is 404 and another type a clear 400, not WRONGTYPE (review v0.4 r1 L3).
      await r.set(k('text'), 'not an array');
      const routes: [string, Record<string, unknown>][] = [
        ['array/range', { count: 5 }],
        ['array/search', { predicates: [{ kind: 'exact', value: utf8('x') }] }],
        ['array/aggregate', { start: '0', end: '9', op: 'sum' }],
      ];
      for (const [route, body] of routes) {
        const missing = await viewer.req('POST', `${DB}/${route}`, { key: utf8(k('missing')), ...body });
        expect(missing.status, route).toBe(404);
        const other = await viewer.req('POST', `${DB}/${route}`, { key: utf8(k('text')), ...body });
        expect(other.status, route).toBe(400);
        expect(other.json.error.message).toBe('This key is not an array.');
      }
    });

    it('previews long values and reads the full element by reference, bounded by maxValueBytes', async () => {
      const res = await viewer.req('POST', `${DB}/array/range`, { key: utf8(k('big')), count: 2 });
      const [a, b] = res.json.items;
      expect(a.truncated).toBe(true);
      expect(a.value.data).toHaveLength(65_536);
      expect(a.ref).toEqual({ kind: 'array', index: '0', identity: sha('x'.repeat(100_000)) });
      const full = await viewer.req('POST', `${DB}/key/element`, { key: utf8(k('big')), ref: a.ref });
      expect(full.status, JSON.stringify(full.json)).toBe(200);
      expect(full.json.value.data).toHaveLength(100_000);
      const tooBig = await viewer.req('POST', `${DB}/key/element`, { key: utf8(k('big')), ref: b.ref });
      expect(tooBig.status).toBe(413);
      // The page read element 0; another value there now is a conflict, an empty index a 404.
      await ar('ARSET', k('big'), '0', 'changed');
      expect((await viewer.req('POST', `${DB}/key/element`, { key: utf8(k('big')), ref: a.ref })).status).toBe(409);
      await ar('ARDEL', k('big'), '0');
      expect((await viewer.req('POST', `${DB}/key/element`, { key: utf8(k('big')), ref: a.ref })).status).toBe(404);
    });

    it('array/search: EXACT, MATCH, GLOB, AND/OR, NOCASE, values, LIMIT with continuation', async () => {
      // Searches are rate limited per user (5/s, burst 10): a fresh session per test.
      const v = await userSession(t, 'viewer');
      const search = (body: Record<string, unknown>) => v.req('POST', `${DB}/array/search`, { key: utf8(k('words')), ...body });
      const indices = (res: Awaited<ReturnType<typeof search>>) => res.json.items.map((i: any) => i.index);
      let res = await search({ predicates: [{ kind: 'exact', value: utf8('apple') }] });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(indices(res)).toEqual(['0']);
      expect(res.json.items[0].value).toEqual(utf8('apple'));
      expect(res.json).toMatchObject({ start: '0', searchedTo: ARRAY_MAX_INDEX, elements: 6 });
      expect(res.json.next).toBeUndefined();
      res = await search({ predicates: [{ kind: 'exact', value: utf8('apple') }], nocase: true });
      expect(indices(res)).toEqual(['0']);
      res = await search({ predicates: [{ kind: 'match', value: utf8('apple') }], nocase: true });
      expect(indices(res)).toEqual(['0', '2', '4']);
      res = await search({ predicates: [{ kind: 'match', value: utf8('pple') }, { kind: 'match', value: utf8('pie') }], combine: 'and' });
      expect(indices(res)).toEqual(['2']);
      res = await search({ predicates: [{ kind: 'exact', value: utf8('banana') }, { kind: 'exact', value: utf8('cherry') }], combine: 'or', values: false });
      expect(res.json.items).toEqual([{ index: '1' }, { index: '3' }]);
      res = await search({ predicates: [{ kind: 'glob', value: utf8('*a*') }], limit: 2 });
      expect(indices(res)).toEqual(['0', '1']);
      expect(res.json.next).toBe('2');
      res = await search({ start: res.json.next, predicates: [{ kind: 'glob', value: utf8('*a*') }], limit: 2 });
      expect(indices(res)).toEqual(['4']);
      expect(res.json.next).toBeUndefined();
      res = await search({ start: '5', end: '0', predicates: [{ kind: 'glob', value: utf8('*') }], limit: 2 });
      expect(indices(res)).toEqual(['5', '4']);
      expect(res.json.next).toBe('3');
    });

    it('array/search refuses RE, oversized and malformed predicates before Redis is asked', async () => {
      const v = await userSession(t, 'viewer');
      const search = (predicates: unknown[]) => v.req('POST', `${DB}/array/search`, { key: utf8(k('words')), predicates });
      for (const predicates of [
        [{ kind: 're', value: utf8('^(a+)+$') }],
        [{ kind: 'RE', value: utf8('x') }],
        [{ kind: 'glob', value: utf8('*a*b*c*d*e*f*g*h*i') }],
        [{ kind: 'exact', value: utf8('x'.repeat(16 * 1024 + 1)) }],
        [{ kind: 'exact', value: { enc: 'base64', data: '!!not base64' } }],
        Array.from({ length: 9 }, () => ({ kind: 'exact', value: utf8('x') })),
      ]) {
        const res = await search(predicates);
        expect(res.status, JSON.stringify(predicates).slice(0, 80)).toBe(400);
        expect(res.json.error.code).toBe('validation');
      }
    });

    it('array/aggregate: SUM, MIN, MAX, bitwise, USED and MATCH over a range; empty ranges are null', async () => {
      const v = await userSession(t, 'viewer');
      const agg = (body: Record<string, unknown>) => v.req('POST', `${DB}/array/aggregate`, { key: utf8(k('dense')), start: '0', end: '9', ...body });
      expect((await agg({ op: 'sum' })).json).toEqual({ op: 'sum', result: '45', elements: 10 });
      expect((await agg({ op: 'min' })).json.result).toBe('0');
      expect((await agg({ op: 'max' })).json.result).toBe('9');
      expect((await agg({ op: 'or' })).json.result).toBe('15');
      expect((await agg({ op: 'used', start: '0', end: ARRAY_MAX_INDEX })).json).toEqual({ op: 'used', result: '250', elements: 250 });
      expect((await agg({ op: 'match', value: utf8('7') })).json.result).toBe('1');
      // Aggregates are rate limited per user (5/s, burst 10).
      const v2 = await userSession(t, 'viewer');
      const agg2 = (body: Record<string, unknown>) => v2.req('POST', `${DB}/array/aggregate`, { key: utf8(k('dense')), start: '0', end: '9', ...body });
      expect((await agg2({ op: 'sum', start: '9000', end: '9100' })).json).toEqual({ op: 'sum', result: null, elements: 0 });
      // Reversed ranges are the same range.
      expect((await agg2({ op: 'sum', start: '9', end: '0' })).json.result).toBe('45');
      expect((await agg2({ op: 'match' })).status).toBe(400);
      expect((await agg2({ op: 'sum', value: utf8('x') })).status).toBe(400);
      expect((await agg2({ op: 'avg' })).status).toBe(400);
    });

    it('reads are audited per request with counts only (no values, keys as tags)', async () => {
      const before = t.auditLines.length;
      const v = await userSession(t, 'viewer');
      await v.req('POST', `${DB}/array/range`, { key: utf8(k('words')), count: 3 });
      await v.req('POST', `${DB}/array/search`, { key: utf8(k('words')), predicates: [{ kind: 'exact', value: utf8('cherry') }] });
      await v.req('POST', `${DB}/array/aggregate`, { key: utf8(k('dense')), start: '0', end: '3', op: 'sum' });
      const lines = t.auditLines.slice(before).map((l) => JSON.parse(l));
      expect(lines.map((l) => [l.action, l.command, l.outcome])).toEqual([
        ['array.range', 'ARSCAN', 'allowed'],
        ['array.search', 'ARSCAN', 'allowed'],
        ['array.aggregate', 'AROP', 'allowed'],
      ]);
      expect(lines[1].argvRedacted).toEqual(['ARSCAN', expect.stringMatching(/^key#[0-9a-f]{12}$/), 'EXACT', '<6 bytes>', 'OR']);
      expect(lines[1].detail).toBe('returned=1 elements=6');
      const text = t.auditLines.slice(before).join('\n');
      for (const secret of ['cherry', 'banana', P]) expect(text).not.toContain(secret);
    });
  });

  describe('writes (typed ops)', () => {
    const OPS = `${DB}/ops`;

    it('viewers cannot write; read-only databases refuse every array write, for admins too', async () => {
      await ar('ARSET', k('roles'), '0', 'a');
      const bodies = [
        { op: 'array.set', key: utf8(k('roles')), index: '0', value: utf8('b'), expect: { type: 'array', sha256: sha('a') } },
        { op: 'array.insert', key: utf8(k('roles')), values: [utf8('c')], expect: { type: 'array' } },
        { op: 'array.delete', key: utf8(k('roles')), indexes: ['0'] },
        { op: 'array.delete-range', key: utf8(k('roles')), start: '0', end: '10' },
      ];
      for (const body of bodies) {
        const v = await viewer.req('POST', OPS, body);
        expect(v.status, body.op).toBe(403);
        expect(v.json.error.code).toBe('forbidden');
        for (const c of [operator, admin]) {
          const ro = await c.req('POST', '/api/v1/databases/e2e-ro/ops', body);
          expect(ro.status, body.op).toBe(403);
          expect(ro.json.error.code).toBe('read_only');
        }
      }
      expect(await ar('ARSCAN', k('roles'), '0', '10')).toEqual([[0, 'a']]);
    });

    it('array.set is compare-and-set: element bytes, or null for an empty index; 409 shows what is there', async () => {
      await ar('ARSET', k('cas'), '0', 'opened');
      let res = await operator.req('POST', OPS, { op: 'array.set', key: utf8(k('cas')), index: '0', value: utf8('mine'), expect: { type: 'array', sha256: sha('opened') } });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(await ar('ARGET', k('cas'), '0')).toBe('mine');
      // Someone else's value since: 409 with the current value and an expectation for "Overwrite anyway".
      res = await operator.req('POST', OPS, { op: 'array.set', key: utf8(k('cas')), index: '0', value: utf8('again'), expect: { type: 'array', sha256: sha('opened') } });
      expect(res.status).toBe(409);
      expect(res.json.error.conflict).toEqual({ reason: 'value', expected: { type: 'array', sha256: sha('opened') }, current: { type: 'array', value: utf8('mine'), expect: { type: 'array', sha256: sha('mine') } } });
      expect(await ar('ARGET', k('cas'), '0')).toBe('mine');
      res = await operator.req('POST', OPS, { op: 'array.set', key: utf8(k('cas')), index: '0', value: utf8('again'), expect: res.json.error.conflict.current.expect });
      expect(res.status).toBe(200);
      // An empty index is expected as null; a value that appeared meanwhile is a conflict.
      res = await operator.req('POST', OPS, { op: 'array.set', key: utf8(k('cas')), index: '9007199254740993', value: b64(BIN), expect: { type: 'array', sha256: null } });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(Buffer.from(await r.sendCommand(['ARGET', k('cas'), '9007199254740993'], { typeMapping: { [36]: Buffer } } as never) as Buffer)).toEqual(BIN);
      res = await operator.req('POST', OPS, { op: 'array.set', key: utf8(k('cas')), index: '9007199254740993', value: utf8('x'), expect: { type: 'array', sha256: null } });
      expect(res.status).toBe(409);
      expect(res.json.error.conflict.current.value).toEqual(b64(BIN));
      // Deleted meanwhile: 409 without a value; a removed key is never recreated by an element edit.
      await ar('ARDEL', k('cas'), '0');
      res = await operator.req('POST', OPS, { op: 'array.set', key: utf8(k('cas')), index: '0', value: utf8('x'), expect: { type: 'array', sha256: sha('again') } });
      expect(res.status).toBe(409);
      expect(res.json.error.conflict.current).toEqual({ type: 'array', expect: { type: 'array', sha256: null } });
      await r.unlink(k('cas'));
      res = await operator.req('POST', OPS, { op: 'array.set', key: utf8(k('cas')), index: '0', value: utf8('x'), expect: { type: 'array', sha256: null } });
      expect(res.status).toBe(409);
      expect(res.json.error.conflict.reason).toBe('type');
      expect(await r.exists(k('cas'))).toBe(0);
    });

    it('array.set validation: the expectation must name an array element', async () => {
      for (const expect_ of [undefined, { type: 'none' }, { type: 'array' }, { type: 'list', sha256: null }]) {
        const res = await operator.req('POST', OPS, { op: 'array.set', key: utf8(k('val')), index: '0', value: utf8('x'), ...(expect_ ? { expect: expect_ } : {}) });
        expect(res.status, JSON.stringify(expect_)).toBe(400);
      }
      expect(await r.exists(k('val'))).toBe(0);
    });

    it('a write between the read and EXEC aborts array.set; it is retried while the bytes still match', async () => {
      await ar('ARSET', k('race'), '0', 'opened');
      const conn = await t.ctx.redis.conn('e2e', 'operator');
      const racing = (write: () => Promise<unknown>): Conn => ({
        exclusive: ((key, fn, o) => conn.exclusive(key, (send) => fn(async (args, so) => {
          if (String(args[0]) === 'MULTI') await write();
          return send(args, so);
        }), o)) as Conn['exclusive'],
      }) as Conn;
      const plan: CheckedPlan = { key: Buffer.from(k('race')), probe: { kind: 'array', index: '0' }, expect: { type: 'array', sha256: sha('opened') }, command: ['ARSET', Buffer.from(k('race')), '0', 'mine'] };
      let writes = 0;
      const err = await checkedWrite(racing(async () => { writes++; await ar('ARSET', k('race'), '0', `theirs-${writes}`); }), plan, { timeout: 5000, maxValueBytes: 524_288 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe('conflict');
      expect(await ar('ARGET', k('race'), '0')).toBe('theirs-1');
      await ar('ARSET', k('race'), '0', 'opened');
      writes = 0;
      await checkedWrite(racing(async () => { if (writes++ === 0) await ar('ARSET', k('race'), '0', 'opened'); }), plan, { timeout: 5000, maxValueBytes: 524_288 });
      expect(writes).toBe(2);
      expect(await ar('ARGET', k('race'), '0')).toBe('mine');
    });

    it('array.insert appends at the insert cursor only when every position it writes is empty', async () => {
      // An array built with ARSET keeps its cursor at 0: ARINSERT would overwrite elements 0 and 1.
      await ar('ARSET', k('ins'), '0', 'a', 'b', 'c');
      let res = await operator.req('POST', OPS, { op: 'array.insert', key: utf8(k('ins')), values: [utf8('n1'), utf8('n2')], expect: { type: 'array' } });
      expect(res.status).toBe(409);
      expect(res.json.error.message).toMatch(/insert cursor is at index 0 and ARINSERT would overwrite 2 existing elements/);
      expect(res.json.error.conflict.current.expect).toBeUndefined();
      expect(await ar('ARSCAN', k('ins'), '0', '10')).toEqual([[0, 'a'], [1, 'b'], [2, 'c']]);
      // Past the end (ARSEEK in the console), the append writes there.
      await ar('ARSEEK', k('ins'), '3');
      res = await operator.req('POST', OPS, { op: 'array.insert', key: utf8(k('ins')), values: [utf8('d'), b64(BIN)], expect: { type: 'array' } });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(await ar('ARCOUNT', k('ins'))).toBe(5);
      expect(await ar('ARNEXT', k('ins'))).toBe(5);
      // A partly occupied target is refused too.
      await ar('ARSET', k('ins'), '6', 'later');
      res = await operator.req('POST', OPS, { op: 'array.insert', key: utf8(k('ins')), values: [utf8('e'), utf8('f')], expect: { type: 'array' } });
      expect(res.status).toBe(409);
      expect(res.json.error.message).toMatch(/at index 5 and ARINSERT would overwrite 1 existing element there/);
    });

    it('array.insert past the last index is a 400 before anything is written (review v0.4 r2 L2)', async () => {
      await ar('ARSET', k('edge'), '0', 'keep');
      await ar('ARSEEK', k('edge'), ARRAY_MAX_INDEX);
      const res = await operator.req('POST', OPS, { op: 'array.insert', key: utf8(k('edge')), values: [utf8('x'), utf8('y')], expect: { type: 'array' } });
      expect(res.status, res.body).toBe(400);
      expect(res.json.error.message).toMatch(/would pass the last index 18446744073709551614/);
      expect(await ar('ARCOUNT', k('edge'))).toBe(1);
      // One value still fits at the last index.
      expect((await operator.req('POST', OPS, { op: 'array.insert', key: utf8(k('edge')), values: [utf8('z')], expect: { type: 'array' } })).status).toBe(200);
      expect(String(await ar('ARGET', k('edge'), ARRAY_MAX_INDEX))).toBe('z');
    });

    it('array.insert with expect none creates the key and never overwrites an existing one', async () => {
      let res = await operator.req('POST', OPS, { op: 'array.insert', key: utf8(k('new')), values: [utf8('first'), utf8('second')], expect: { type: 'none' } });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(await ar('ARSCAN', k('new'), '0', '10')).toEqual([[0, 'first'], [1, 'second']]);
      res = await operator.req('POST', OPS, { op: 'array.insert', key: utf8(k('new')), values: [utf8('third')], expect: { type: 'none' } });
      expect(res.status).toBe(409);
      expect(res.json.error.message).toBe('This key already exists; nothing was written.');
      await r.set(k('str'), 'v');
      res = await operator.req('POST', OPS, { op: 'array.insert', key: utf8(k('str')), values: [utf8('x')], expect: { type: 'none' } });
      expect(res.status).toBe(409);
      expect(await r.get(k('str'))).toBe('v');
      for (const expect_ of [{ type: 'array', sha256: null }, { type: 'list' }]) {
        res = await operator.req('POST', OPS, { op: 'array.insert', key: utf8(k('new2')), values: [utf8('x')], expect: expect_ });
        expect(res.status, JSON.stringify(expect_)).toBe(400);
      }
    });

    it('array.delete and array.delete-range need the server confirmation, previewed from the exact argv', async () => {
      await ar('ARSET', k('del'), '0', ...Array.from({ length: 20 }, (_, i) => `v${i}`));
      const del = { op: 'array.delete', key: utf8(k('del')), indexes: ['3', '5'] };
      const first = await operator.req('POST', OPS, del);
      expect(first.status).toBe(428);
      const ch = first.json.error.confirmation;
      expect(ch).toMatchObject({ level: 'confirm', reasonRequired: false, summary: 'Delete 2 array element(s) on E2E' });
      expect(ch.preview).toEqual({ total: 1, commands: [{ argv: [{ kind: 'command', v: utf8('ARDEL') }, { kind: 'key', v: utf8(k('del')) }, { kind: 'arg', v: utf8('3') }, { kind: 'arg', v: utf8('5') }] }] });
      expect(await ar('ARCOUNT', k('del'))).toBe(20);
      const { second } = await confirmed(operator, OPS, del);
      expect(second.status, JSON.stringify(second.json)).toBe(200);
      expect(second.json.result).toEqual({ t: 'int', v: '2' });
      const range = { op: 'array.delete-range', key: utf8(k('del')), start: '15', end: '10' };
      const r1 = await operator.req('POST', OPS, range);
      expect(r1.status).toBe(428);
      expect(r1.json.error.confirmation.summary).toBe('Delete every array element from index 10 to 15 on E2E');
      expect(r1.json.error.confirmation.preview.commands[0].argv.map((a: any) => a.v.data)).toEqual(['ARDELRANGE', k('del'), '15', '10']);
      const { second: r2 } = await confirmed(operator, OPS, range);
      expect(r2.status).toBe(200);
      expect(r2.json.result).toEqual({ t: 'int', v: '6' });
      expect(await ar('ARCOUNT', k('del'))).toBe(12);
      // A token confirms only the request it was issued for.
      const other = await operator.req('POST', OPS, { ...range, start: '0', confirmation: { token: r1.json.error.confirmation.token } });
      expect(other.status).toBe(428);
    });

    it('prod databases ask for the typed name and a reason for every array write, which the audit keeps', async () => {
      await ar('ARSET', k('prod'), '0', 'p');
      const before = t.auditLines.length;
      const body = { op: 'array.set', key: utf8(k('prod')), index: '1', value: utf8('q'), expect: { type: 'array', sha256: null } };
      const { first, second } = await confirmed(operator, '/api/v1/databases/e2e-prod/ops', body, { reason: 'array QA reason' });
      expect(first.json.error.confirmation).toMatchObject({ level: 'typed', expectedText: 'E2E prod', reasonRequired: true });
      expect(second.status, JSON.stringify(second.json)).toBe(200);
      const lines = t.auditLines.slice(before).map((l) => JSON.parse(l));
      expect(lines.at(-1)).toMatchObject({ action: 'array.set', outcome: 'allowed', reason: 'array QA reason', detail: 'checked', command: 'ARSET' });
      expect(lines.at(-1).argvRedacted).toEqual(['ARSET', expect.stringMatching(/^key#/), '<1 bytes>', '<1 bytes>']);
    });
  });

  describe('console policy (v0.4 arrays block)', () => {
    const cli = (c: Client, line: string) => c.req('POST', `${DB}/cli`, { line });

    it('reads run for viewers; writes need operator; ARDEL, ARDELRANGE and ARRING confirm', async () => {
      await ar('ARSET', k('cli'), '0', 'a', 'b', 'c');
      expect((await cli(viewer, `ARSCAN ${k('cli')} 0 10 LIMIT 5`)).status).toBe(200);
      expect((await cli(viewer, `ARINFO ${k('cli')}`)).json.commandClass).toBe('read');
      expect((await cli(viewer, `ARSET ${k('cli')} 0 x`)).status).toBe(403);
      expect((await cli(operator, `ARSET ${k('cli')} 0 x`)).status).toBe(200);
      for (const line of [`ARDEL ${k('cli')} 1`, `ARDELRANGE ${k('cli')} 0 1`, `ARRING ${k('cli')} 2 z`]) {
        const res = await cli(operator, line);
        expect(res.status, line).toBe(428);
      }
      expect(await ar('ARCOUNT', k('cli'))).toBe(3);
    });

    it('ARGREP is blocked in the console and the Workbench for every role and audited as denied (review v0.4 r2 H1)', async () => {
      const before = t.auditLines.length;
      const lines = [`ARGREP ${k('cli')} 0 10 RE "(a+)+$"`, `argrep ${k('cli')} 0 10 MATCH aab NOCASE LIMIT 1`, `ARGREP ${k('cli')} 0 10 EXACT RE`, `ARGREP ${k('cli')} 0 10 GLOB *`];
      for (const c of [viewer, operator, admin]) {
        for (const line of lines) {
          const res = await cli(c, line);
          expect(res.status, line).toBe(403);
          expect(res.json.error).toMatchObject({ code: 'command_blocked', hint: ARGREP_HINT });
        }
      }
      const wb = await admin.req('POST', `${DB}/workbench`, { script: `ARGREP ${k('cli')} 0 10 GLOB *` });
      expect(JSON.stringify(wb.json)).toContain('command_blocked');
      const audit = t.auditLines.slice(before).map((l) => JSON.parse(l));
      expect(audit.filter((l) => l.outcome === 'denied' && l.command === 'ARGREP').length).toBeGreaterThanOrEqual(12);
    });
  });

  it('cleanup leaves nothing under this prefix', async () => {
    await cleanupPrefix(P);
    const left: string[] = [];
    for await (const keys of r.scanIterator({ MATCH: `${P}*`, COUNT: 1000 })) left.push(...keys);
    expect(left).toEqual([]);
  });
});
