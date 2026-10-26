/**
 * v0.4 arrays: the per-request element bound of searches and aggregates (ARRAY_SCAN_MAX_ELEMENTS) needs more than a
 * million elements on a real server, so it is tested here against an in-memory array that answers the commands the
 * server sends (AROP … USED, ARGREP, AROP SUM), with a small bound.
 */
import { describe, expect, it } from 'vitest';
import { ARRAY_MAX_INDEX, binFromString, zArrayAggregate, zArraySearch } from '@rconsole/shared';
import type { DbScope } from '../../src/context.ts';
import { HttpError } from '../../src/http/errors.ts';
import type { Conn } from '../../src/redis/manager.ts';
import { aggregateArray, planArrayOp, searchArgv, searchArray, stepIndex, windowEnd } from '../../src/redis/array.ts';

/** A sparse in-memory array and the commands the server sends, recorded. */
function fakeArray(indices: bigint[]) {
  const sorted = [...indices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sent: string[][] = [];
  const between = (a: string, b: string) => {
    const [lo, hi] = BigInt(a) <= BigInt(b) ? [BigInt(a), BigInt(b)] : [BigInt(b), BigInt(a)];
    return sorted.filter((i) => i >= lo && i <= hi);
  };
  const conn = {
    send: async (args: unknown[]) => {
      const argv = args.map((a) => (Buffer.isBuffer(a) ? a.toString() : String(a)));
      sent.push(argv);
      const [cmd, , a, b] = argv as [string, string, string, string];
      if (cmd === 'AROP' && argv[4] === 'USED') return String(between(a, b).length);
      if (cmd === 'AROP' && argv[4] === 'SUM') return Buffer.from(String(between(a, b).length));
      if (cmd === 'ARGREP') {
        const limit = Number(argv[argv.indexOf('LIMIT') + 1]);
        let hits = between(a, b);
        if (BigInt(a) > BigInt(b)) hits = hits.reverse();
        hits = hits.slice(0, limit);
        return argv.includes('WITHVALUES') ? hits.map((i) => [String(i), Buffer.from(`v${i}`)]) : hits.map(String);
      }
      throw new Error(`unexpected ${cmd}`);
    },
  } as unknown as Conn;
  const scope = { db: { id: 'db', environment: 'test', readOnly: false }, role: 'viewer' } as unknown as DbScope;
  return { conn, scope, sent };
}
const preview = (v: Buffer) => ({ v: binFromString(v.toString()), cut: false });
const key = Buffer.from('arr');
const search = (body: Record<string, unknown>) => zArraySearch.parse({ key: binFromString('arr'), predicates: [{ kind: 'glob', value: binFromString('*') }], ...body });

describe('array search window (ARRAY_SCAN_MAX_ELEMENTS)', () => {
  const huge = [0n, 1n, 2n, 3n, 10n, 1000n, 2n ** 53n + 1n, 2n ** 63n, BigInt(ARRAY_MAX_INDEX) - 1n, BigInt(ARRAY_MAX_INDEX)];

  it('a range within the bound is searched whole with one USED read', async () => {
    const { conn, scope, sent } = fakeArray(huge);
    expect(await windowEnd(scope, conn, key, '0', ARRAY_MAX_INDEX, 10, 1000)).toEqual({ to: ARRAY_MAX_INDEX, elements: 10 });
    expect(sent).toHaveLength(1);
  });

  it('bisects to the last index before the element over the bound, in both directions, across 2^64', async () => {
    const { conn, scope, sent } = fakeArray(huge);
    // Four elements allowed from 0: 0, 1, 2, 3 -> the window ends right before index 10.
    expect(await windowEnd(scope, conn, key, '0', ARRAY_MAX_INDEX, 4, 1000)).toEqual({ to: '9', elements: 4 });
    expect(sent.length).toBeLessThanOrEqual(67);
    // Seven allowed: up to 2^53 + 1, ending right before 2^63.
    expect(await windowEnd(scope, conn, key, '0', ARRAY_MAX_INDEX, 7, 1000)).toEqual({ to: String(2n ** 63n - 1n), elements: 7 });
    // Downwards from the last index: three allowed -> stops right above 2^53 + 1.
    expect(await windowEnd(scope, conn, key, ARRAY_MAX_INDEX, '0', 3, 1000)).toEqual({ to: String(2n ** 53n + 2n), elements: 3 });
  });

  it('a search that hits the bound reports what it covered and continues after it', async () => {
    const { conn, scope, sent } = fakeArray(huge);
    let r = await searchArray(scope, conn, key, search({ limit: 100 }), preview, 1000, 4);
    expect(r.items.map((i) => i.index)).toEqual(['0', '1', '2', '3']);
    expect(r).toMatchObject({ start: '0', searchedTo: '9', elements: 4, next: '10' });
    expect(sent.find((c) => c[0] === 'ARGREP')).toEqual(['ARGREP', 'arr', '0', '9', 'GLOB', '*', 'OR', 'LIMIT', '100', 'WITHVALUES']);
    r = await searchArray(scope, conn, key, search({ start: r.next, limit: 100 }), preview, 1000, 4);
    expect(r.items.map((i) => i.index)).toEqual(['10', '1000', String(2n ** 53n + 1n), String(2n ** 63n)]);
    // LIMIT reached inside the window: continue after the last match, not after the window.
    r = await searchArray(scope, conn, key, search({ limit: 2 }), preview, 1000, 4);
    expect(r).toMatchObject({ searchedTo: '9', next: '2' });
    // Downwards, the next start is below the last match.
    r = await searchArray(scope, conn, key, search({ start: ARRAY_MAX_INDEX, end: '0', limit: 1 }), preview, 1000, 4);
    expect(r.items.map((i) => i.index)).toEqual([ARRAY_MAX_INDEX]);
    expect(r.next).toBe(String(BigInt(ARRAY_MAX_INDEX) - 1n));
    // The whole range searched: no continuation.
    r = await searchArray(scope, conn, key, search({ limit: 100 }), preview, 1000, 100);
    expect(r.next).toBeUndefined();
    expect(r.searchedTo).toBe(ARRAY_MAX_INDEX);
  });

  it('aggregates refuse a range over the bound with its count, and never run AROP on it', async () => {
    const { conn, scope, sent } = fakeArray(huge);
    const agg = (op: string) => zArrayAggregate.parse({ key: binFromString('arr'), start: '0', end: ARRAY_MAX_INDEX, op });
    const err = await aggregateArray(scope, conn, key, agg('sum'), 1000, 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('validation');
    expect((err as HttpError).message).toMatch(/holds 10 elements; aggregates read at most 5/);
    expect(sent.some((c) => c[4] === 'SUM')).toBe(false);
    // USED is the count itself and has no bound; within the bound the operation runs.
    expect(await aggregateArray(scope, conn, key, agg('used'), 1000, 5)).toEqual({ op: 'used', result: '10', elements: 10 });
    expect(await aggregateArray(scope, conn, key, agg('sum'), 1000, 10)).toEqual({ op: 'sum', result: '10', elements: 10 });
  });
});

describe('array helpers', () => {
  it('steps indices as exact integers and stops at both ends', () => {
    expect(stepIndex('0', true)).toBeUndefined();
    expect(stepIndex(ARRAY_MAX_INDEX, false)).toBeUndefined();
    expect(stepIndex('9007199254740992', false)).toBe('9007199254740993');
    expect(stepIndex('18446744073709551614', true)).toBe('18446744073709551613');
  });

  it('builds ARGREP from the parsed request: predicates in order, combine, NOCASE, LIMIT, WITHVALUES', () => {
    const q = zArraySearch.parse({ key: binFromString('k'), start: '5', end: '1', predicates: [{ kind: 'exact', value: binFromString('a b') }, { kind: 'match', value: { enc: 'base64', data: '/wA=' } }], combine: 'and', nocase: true, limit: 7, values: false });
    expect(searchArgv(key, q, '2').map((a) => (Buffer.isBuffer(a) ? a.toString('base64') : a))).toEqual(['ARGREP', key.toString('base64'), '5', '2', 'EXACT', Buffer.from('a b').toString('base64'), 'MATCH', '/wA=', 'AND', 'NOCASE', 'LIMIT', '7']);
  });

  it('plans array ops as fixed commands with their confirmation level', () => {
    const k = binFromString('k');
    expect(planArrayOp({ op: 'array.set', key: k, index: '3', value: binFromString('v'), expect: { type: 'array', sha256: null } })).toMatchObject({ confirm: 'none', keys: [1] });
    expect(planArrayOp({ op: 'array.insert', key: k, values: [k, k], expect: { type: 'none' } }).summary).toBe('Create array');
    expect(planArrayOp({ op: 'array.delete', key: k, indexes: ['1', '2'] }).confirm).toBe('confirm');
    const range = planArrayOp({ op: 'array.delete-range', key: k, start: '9', end: '2' });
    expect(range.confirm).toBe('confirm');
    expect(range.argv.slice(2)).toEqual(['9', '2']);
    expect(range.summary).toBe('Delete every array element from index 2 to 9');
  });
});
