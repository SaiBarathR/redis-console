/**
 * v0.4 arrays: the per-request bounds of searches and aggregates need far more data than a test should write to Redis,
 * so they are tested here against an in-memory array that answers the commands the server sends (AROP … USED, ARSCAN,
 * AROP SUM) and enforces the measured transport's per-read cap and shared request budget the way it does.
 */
import { describe, expect, it } from 'vitest';
import { ARRAY_MAX_INDEX, binFromString, zArrayAggregate, zArraySearch } from '@rconsole/shared';
import type { DbScope } from '../../src/context.ts';
import { HttpError } from '../../src/http/errors.ts';
import type { Conn, SendOpts } from '../../src/redis/manager.ts';
import { aggregateArray, planArrayOp, searchArray, searchMatcher, stepIndex, windowEnd } from '../../src/redis/array.ts';

/** A sparse in-memory array (index -> value, or indices holding `v<index>`) and the commands the server sends. */
function fakeArray(content: bigint[] | Map<bigint, Buffer>) {
  const values = content instanceof Map ? content : new Map(content.map((i) => [i, Buffer.from(`v${i}`)]));
  const sorted = [...values.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sent: string[][] = [];
  const between = (a: string, b: string) => {
    const [lo, hi] = BigInt(a) <= BigInt(b) ? [BigInt(a), BigInt(b)] : [BigInt(b), BigInt(a)];
    return sorted.filter((i) => i >= lo && i <= hi);
  };
  /** The measured transport: a reply over min(cap, budget) fails; a per-read overflow keeps the budget it charged. */
  const measured = <T>(size: number, o: SendOpts, reply: T): T => {
    const b = o.replyBudget;
    const cap = o.maxBytes ?? Infinity;
    const limit = Math.min(cap, b?.remaining ?? Infinity);
    if (size > limit) {
      if (b) b.remaining = limit === cap && b.remaining > cap ? b.remaining - limit : 0;
      throw new HttpError('too_large', 'Redis reply exceeded the read limit.');
    }
    if (b) b.remaining -= size;
    return reply;
  };
  const conn = {
    send: async (args: unknown[], o: SendOpts = {}) => {
      const argv = args.map((a) => (Buffer.isBuffer(a) ? a.toString() : String(a)));
      sent.push(argv);
      const [cmd, , a, b] = argv as [string, string, string, string];
      if (cmd === 'AROP' && argv[4] === 'USED') return String(between(a, b).length);
      if (cmd === 'AROP' && argv[4] === 'SUM') return Buffer.from(String(between(a, b).length));
      if (cmd === 'ARSCAN') {
        let hits = between(a, b);
        if (BigInt(a) > BigInt(b)) hits = hits.reverse();
        hits = hits.slice(0, Number(argv[argv.indexOf('LIMIT') + 1]));
        const size = hits.reduce((n, i) => n + String(i).length + values.get(i)!.length + 12, 4);
        return measured(size, o, hits.map((i) => [String(i), values.get(i)!]));
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

  it('a search over the element bound stops after it and continues where it stopped, with ARSCAN, never ARGREP', async () => {
    const { conn, scope, sent } = fakeArray(huge);
    let r = await searchArray(scope, conn, key, search({ limit: 100 }), preview, 1000, { maxElements: 4 });
    expect(r.items.map((i) => i.index)).toEqual(['0', '1', '2', '3']);
    expect(r).toMatchObject({ start: '0', searchedTo: '3', elements: 4, next: '4' });
    expect(sent.some((c) => c[0] === 'ARGREP')).toBe(false);
    expect(sent.find((c) => c[0] === 'ARSCAN')).toEqual(['ARSCAN', 'arr', '0', ARRAY_MAX_INDEX, 'LIMIT', '4']);
    r = await searchArray(scope, conn, key, search({ start: r.next, limit: 100 }), preview, 1000, { maxElements: 4 });
    expect(r.items.map((i) => i.index)).toEqual(['10', '1000', String(2n ** 53n + 1n), String(2n ** 63n)]);
    // LIMIT reached: continue after the last match.
    r = await searchArray(scope, conn, key, search({ limit: 2 }), preview, 1000, { maxElements: 4 });
    expect(r).toMatchObject({ searchedTo: '1', next: '2' });
    // Downwards, the next start is below the last match.
    r = await searchArray(scope, conn, key, search({ start: ARRAY_MAX_INDEX, end: '0', limit: 1 }), preview, 1000);
    expect(r.items.map((i) => i.index)).toEqual([ARRAY_MAX_INDEX]);
    expect(r.next).toBe(String(BigInt(ARRAY_MAX_INDEX) - 1n));
    // The whole range searched: no continuation.
    r = await searchArray(scope, conn, key, search({ limit: 100 }), preview, 1000);
    expect(r).toMatchObject({ searchedTo: ARRAY_MAX_INDEX, elements: 10 });
    expect(r.next).toBeUndefined();
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

describe('array search byte bound (review v0.4 r2 H2)', () => {
  const MiB = 1024 * 1024;
  const fill = (n: number, from: number, size: number, byte = 0x61) => Array.from({ length: n }, (_, i) => [BigInt(from + i), Buffer.alloc(size, byte)] as const);

  it('reads at most the byte budget of the selected range, however small the elements elsewhere are, in both directions', async () => {
    // The reproduction: 5,000 values of 4 KiB at 0–4999, then 50,000 one-byte values after them.
    const values = new Map<bigint, Buffer>([...fill(5000, 0, 4096), ...fill(50_000, 5000, 1, 0x78)]);
    const { conn, scope } = fakeArray(values);
    const q = (start: string, end: string) => search({ start, end, predicates: Array.from({ length: 8 }, () => ({ kind: 'match', value: binFromString('a'.repeat(63) + 'b') })), nocase: true, limit: 1 });
    for (const [start, end] of [['0', '4999'], ['4999', '0']] as const) {
      const r = await searchArray(scope, conn, key, q(start, end), preview, 1000, { maxBytes: MiB });
      expect(r.items).toEqual([]);
      expect(r.elements * 4096).toBeLessThanOrEqual(MiB);
      expect(r.elements).toBeGreaterThan(200);
      expect(r.next).toBe(stepIndex(r.searchedTo, start === '4999'));
    }
  });

  it('an element larger than one read is skipped by index and the search goes on after it on the next request', async () => {
    const values = new Map<bigint, Buffer>([...fill(3, 0, 10), [7n, Buffer.alloc(2 * MiB, 0x62)], ...fill(3, 20, 10)]);
    const { conn, scope, sent } = fakeArray(values);
    const find = (start = '0') => searchArray(scope, conn, key, search({ start, predicates: [{ kind: 'match', value: binFromString('a') }] }), preview, 1000, { maxBytes: MiB });
    // The first batch overflowed on it and the small elements before it used part of the rest, so this request cannot
    // tell "larger than a read" from "larger than what is left": it stops before it.
    let r = await find();
    expect(r).toMatchObject({ elements: 3, searchedTo: '2', next: '3' });
    expect(r.items.map((i) => i.index)).toEqual(['0', '1', '2']);
    expect(r.skipped).toBeUndefined();
    // The next request reaches it with a whole read cap: skipped by index (AROP USED bisection, no value read).
    r = await find(r.next);
    expect(r).toMatchObject({ elements: 0, searchedTo: '7', next: '8', skipped: ['7'] });
    expect(sent.some((c) => c[0] === 'AROP' && c[4] === 'USED')).toBe(true);
    r = await find(r.next);
    expect(r.items.map((i) => i.index)).toEqual(['20', '21', '22']);
    expect(r.skipped).toBeUndefined();
    expect(r.next).toBeUndefined();
    // Starting on it: skipped at once.
    r = await searchArray(scope, conn, key, search({ start: '7', end: '7' }), preview, 1000, { maxBytes: MiB });
    expect(r).toMatchObject({ elements: 0, searchedTo: '7', skipped: ['7'] });
    expect(r.next).toBeUndefined();
  });

  it('when the budget runs out, an element that fits a whole budget is read by the next request, not skipped', async () => {
    const values = new Map<bigint, Buffer>(fill(10, 0, 200 * 1024));
    const { conn, scope } = fakeArray(values);
    let start = '0';
    let seen = 0;
    for (let i = 0; i < 10 && start; i++) {
      const r = await searchArray(scope, conn, key, search({ start, end: '9' }), preview, 1000, { maxBytes: MiB });
      expect(r.skipped).toBeUndefined();
      seen += r.elements;
      start = r.next!;
    }
    expect(seen).toBe(10);
  });

  it('a value over 1 KiB or malformed base64 is refused before anything is read', async () => {
    const { conn, scope, sent } = fakeArray([0n]);
    const long = await searchArray(scope, conn, key, search({ predicates: [{ kind: 'exact', value: binFromString('a'.repeat(1025)) }] }), preview, 1000).catch((e: unknown) => e);
    expect(long).toBeInstanceOf(HttpError);
    const bad = await searchArray(scope, conn, key, search({ predicates: [{ kind: 'exact', value: { enc: 'base64', data: '!!' } }] }), preview, 1000).catch((e: unknown) => e);
    expect((bad as HttpError).message).toMatch(/base64/);
    expect(sent).toEqual([]);
  });
});

describe('search predicates (ARGREP meanings, matched on the server)', () => {
  const m = (predicates: [string, string][], o: { nocase?: boolean; combine?: string } = {}) =>
    searchMatcher(zArraySearch.parse({ key: binFromString('k'), predicates: predicates.map(([kind, data]) => ({ kind, value: binFromString(data) })), ...o }));
  const B = (s: string) => Buffer.from(s);
  it('EXACT, MATCH and GLOB, with NOCASE folding ASCII letters only', () => {
    expect(m([['exact', 'Apple']])(B('Apple'))).toBe(true);
    expect(m([['exact', 'Apple']])(B('apple'))).toBe(false);
    expect(m([['exact', 'Apple']], { nocase: true })(B('aPPLE'))).toBe(true);
    expect(m([['match', 'pie']])(B('Apple pie'))).toBe(true);
    expect(m([['match', 'PIE']], { nocase: true })(B('Apple pie'))).toBe(true);
    expect(m([['glob', 'a*e']], { nocase: true })(B('APPLE'))).toBe(true);
    expect(m([['glob', 'a*e']])(B('APPLE'))).toBe(false);
    // Bytes above 0x7f are not folded: É (c3 89) and é (c3 a9).
    expect(m([['exact', 'é']], { nocase: true })(B('É'))).toBe(false);
  });
  it('combines with any (or) and all (and)', () => {
    const p: [string, string][] = [['match', 'a'], ['match', 'z']];
    expect(m(p)(B('abc'))).toBe(true);
    expect(m(p, { combine: 'and' })(B('abc'))).toBe(false);
    expect(m(p, { combine: 'and' })(B('az'))).toBe(true);
  });
});
