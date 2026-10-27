/**
 * v0.4 arrays: reads, searches, aggregates and typed writes for the Redis 8.8+ native array type (`TYPE` = `array`).
 *
 * Every read here is a fixed, server-built command with the `read` class, sent on the measured transport as the
 * caller's tier with the actor check (like `detailRead`), inside the request's cumulative reply budget, with
 * `policy.commandTimeoutMs`. Bounds:
 * - pages and searches return at most ARRAY_PAGE_MAX elements (`LIMIT`), each value previewed to
 *   KEY_ELEMENT_PREVIEW_BYTES within the page budget (`maxReplyBytes`), with a reference for the full bytes;
 * - a search visits at most ARRAY_SCAN_MAX_ELEMENTS existing elements per request (the range is cut at that count,
 *   found with `AROP … USED`, which Redis answers from per-slice counters), and never runs `RE` predicates;
 * - an aggregate over a range holding more than ARRAY_SCAN_MAX_ELEMENTS elements is refused;
 * - a full element read (ARGET) is bounded on the wire by `maxValueBytes`.
 * Indices are decimal strings end to end (they go up to 2^64 - 2, beyond JavaScript's safe integers).
 */
import { createHash } from 'node:crypto';
import { RESP_TYPES } from 'redis';
import {
  ARRAY_MAX_INDEX,
  ARRAY_PAGE_MAX,
  ARRAY_PREDICATE_MAX_BYTES,
  ARRAY_SCAN_MAX_ELEMENTS,
  ARRAY_SEARCH_MAX_BYTES,
  binFromBytes,
  bytesFromBin,
  type ArrayAggregateResult,
  type ArrayElement,
  type ArrayPage,
  type ArraySearchResult,
  type ArraySummary,
  type Bin,
  type ConfirmLevel,
  type ElementRef,
  type KeyElementResponse,
  type KeyOp,
  zArrayAggregate,
  zArraySearch,
} from '@rconsole/shared';
import type { z } from 'zod';
import type { DbScope } from '../context.ts';
import { HttpError } from '../http/errors.ts';
import { authorize, checkGlob, fixedCommand } from '../policy/policy.ts';
import type { Probe } from './checked.ts';
import { run } from './exec.ts';
import { TM_BIN, type Arg, type Conn, type SendOpts } from './manager.ts';
import { asStr, kv } from './reply.ts';
import { globMatch, lower, OutOfSteps, type Steps } from './glob.ts';

/** Values as Buffers, integers as exact decimal text. */
export const TM_ARRAY = { ...TM_BIN, [RESP_TYPES.NUMBER]: String } as const;
const LAST = BigInt(ARRAY_MAX_INDEX);

/** Display preview of one element (the key browser's page budget); `cut` when only a prefix is returned. */
export type Preview = (value: Buffer) => { v: Bin; cut: boolean };

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const bytes = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.from(asStr(v)));
const intText = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('latin1') : String(v));

/** A fixed read on the caller's tier: policy class `read`, measured transport, actor-checked (not marked readonly). */
async function arrayRead<T = unknown>(scope: DbScope, conn: Conn, args: Arg[], o: SendOpts): Promise<T> {
  authorize(fixedCommand(String(args[0]), 'read'), scope);
  return run<T>(conn, args, { typeMapping: TM_ARRAY, ...o });
}

/**
 * The key must be an array: TYPE first, so a missing key is 404 and another type a clear 400 rather than WRONGTYPE
 * (as for vector sets; review v0.4 r1 L3).
 */
export async function requireArray(scope: DbScope, conn: Conn, key: Buffer, timeout: number): Promise<void> {
  const type = asStr(await arrayRead(scope, conn, ['TYPE', key], { key, timeout, maxBytes: 4096 }));
  if (type === 'none') throw new HttpError('not_found', 'Key does not exist.');
  if (type !== 'array') throw new HttpError('validation', 'This key is not an array.');
}

/** One step from `index` in a direction, or undefined past either end of the index space. */
export function stepIndex(index: string, reverse: boolean): string | undefined {
  const n = BigInt(index);
  if (reverse) return n === 0n ? undefined : String(n - 1n);
  return n >= LAST ? undefined : String(n + 1n);
}

/** ARINFO -> summary. */
export async function readArraySummary(scope: DbScope, conn: Conn, key: Buffer, timeout: number): Promise<ArraySummary> {
  const info = kv(await arrayRead(scope, conn, ['ARINFO', key], { key, timeout, maxBytes: 64 * 1024 }));
  const out: ArraySummary = { count: intText(info.count ?? '0'), length: intText(info.len ?? '0'), nextInsertIndex: intText(info['next-insert-index'] ?? '0') };
  if (info.slices != null) out.slices = Number(intText(info.slices));
  if (info['slice-size'] != null) out.sliceSize = Number(intText(info['slice-size']));
  return out;
}

/** [index, value] pairs from ARSCAN / ARGREP WITHVALUES (RESP3 nested pairs, or a flat RESP2-style list). */
function pairs(raw: unknown): [string, Buffer][] {
  if (!Array.isArray(raw)) return [];
  if (raw.length && Array.isArray(raw[0])) return (raw as unknown[][]).map((p) => [intText(p[0]), bytes(p[1])]);
  const out: [string, Buffer][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([intText(raw[i]), bytes(raw[i + 1])]);
  return out;
}

function element(index: string, value: Buffer, preview: Preview): ArrayElement {
  const p = preview(value);
  const ref: ElementRef = { kind: 'array', index, identity: sha(value) };
  return p.cut ? { index, value: p.v, truncated: true, ref } : { index, value: p.v, ref };
}

/** One page of existing elements (ARSCAN start end LIMIT count). */
export async function readArrayPage(
  scope: DbScope,
  conn: Conn,
  key: Buffer,
  q: { start?: string | undefined; end?: string | undefined; count: number; reverse: boolean },
  preview: Preview,
  timeout: number,
): Promise<ArrayPage> {
  const start = q.start ?? (q.reverse ? ARRAY_MAX_INDEX : '0');
  const end = q.end ?? (q.reverse ? '0' : ARRAY_MAX_INDEX);
  if (q.reverse ? BigInt(start) < BigInt(end) : BigInt(start) > BigInt(end)) throw new HttpError('validation', q.reverse ? 'With reverse, start must be at or above end.' : 'start must be at or below end (use reverse to read downwards).');
  const raw = await arrayRead(scope, conn, ['ARSCAN', key, start, end, 'LIMIT', String(q.count)], { key, timeout });
  const items = pairs(raw).map(([index, value]) => element(index, value, preview));
  const page: ArrayPage = { items, start, end, reverse: q.reverse };
  const last = items.at(-1)?.index;
  if (items.length === q.count && last !== undefined && last !== end) {
    const next = stepIndex(last, q.reverse);
    // A full page can be the last one: name `next` only when an element remains (AROP USED from the per-slice
    // counters, not another value read; review v0.4 r1 L1).
    if (next !== undefined && (await used(scope, conn, key, next, end, timeout)) > 0) page.next = next;
  }
  return page;
}

/** `key/read` for an array: ARINFO and the first page (`cursor` = start index). */
export async function readArrayValue(
  scope: DbScope,
  conn: Conn,
  key: Buffer,
  q: { cursor?: string | undefined; count: number; reverse: boolean },
  preview: Preview,
  timeout: number,
): Promise<{ value: { type: 'array'; info: ArraySummary } & ArrayPage; length: number | undefined }> {
  if (q.cursor !== undefined && !/^(?:0|[1-9]\d{0,19})$/.test(q.cursor)) throw new HttpError('validation', 'An array cursor is the start index.');
  if (q.cursor !== undefined && BigInt(q.cursor) > LAST) throw new HttpError('validation', `An array index is at most ${ARRAY_MAX_INDEX}.`);
  const info = await readArraySummary(scope, conn, key, timeout);
  const page = await readArrayPage(scope, conn, key, { start: q.cursor, count: q.count, reverse: q.reverse }, preview, timeout);
  const count = Number(info.count);
  return { value: { type: 'array', info, ...page }, length: Number.isSafeInteger(count) ? count : undefined };
}

/** Existing elements between two indices, either order (AROP … USED; answered from slice counters). */
async function used(scope: DbScope, conn: Conn, key: Buffer, a: string, b: string, timeout: number): Promise<number> {
  return Number(intText(await arrayRead(scope, conn, ['AROP', key, a, b, 'USED'], { key, timeout, maxBytes: 1024 })));
}

/**
 * The part of [start, end] (either direction) that holds at most `max` existing elements, found by bisecting on
 * `AROP … USED` (at most 65 small reads). Returns the far index reached and the elements up to it.
 */
export async function windowEnd(scope: DbScope, conn: Conn, key: Buffer, start: string, end: string, max: number, timeout: number): Promise<{ to: string; elements: number }> {
  const total = await used(scope, conn, key, start, end, timeout);
  if (total <= max) return { to: end, elements: total };
  const s = BigInt(start), e = BigInt(end), down = s > e;
  const at = (d: bigint) => String(down ? s - d : s + d);
  // Invariant: USED(start, at(lo)) <= max < USED(start, at(hi)).
  let lo = 0n, hi = down ? s - e : e - s, loCount = await used(scope, conn, key, start, start, timeout);
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const n = await used(scope, conn, key, start, at(mid), timeout);
    if (n <= max) { lo = mid; loCount = n; } else hi = mid;
  }
  return { to: at(lo), elements: loCount };
}

type SearchRequest = z.infer<typeof zArraySearch>;

/** The bytes of a search value (400 for malformed base64, a value over ARRAY_PREDICATE_MAX_BYTES or a GLOB with too many `*`). */
export function predicateBytes(v: Bin, kind: string): Buffer {
  if (v.enc === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(v.data)) throw new HttpError('validation', 'A search value is not valid base64.');
  const b = Buffer.from(bytesFromBin(v));
  if (b.length > ARRAY_PREDICATE_MAX_BYTES) throw new HttpError('validation', `A search value is at most ${ARRAY_PREDICATE_MAX_BYTES} bytes.`);
  if (kind === 'glob') checkGlob(b, 'GLOB pattern');
  return b;
}

/** ASCII lower-casing of a whole value (Redis's `tolower` in the C locale; other bytes are kept). */
function folded(b: Buffer): Buffer {
  const out = Buffer.allocUnsafe(b.length);
  for (let i = 0; i < b.length; i++) out[i] = lower(b[i]!);
  return out;
}

/**
 * The matching work one search request may do (review v0.4 r3 H1), in steps: a step of the glob matcher, or 8 bytes of a
 * native scan (EXACT, MATCH, the NOCASE fold). About 40 ms of CPU; the reviewer's costly glob (a 1,024-byte `*a…ab`
 * against 1 MB) needs about 10^9 steps. Matching runs on the server's event loop, so this bounds how long one request
 * can hold it, together with yielding between elements (searchArray).
 */
export const ARRAY_SEARCH_MATCH_STEPS = 16_000_000;

/** Spend `n` steps of the allowance before the work they pay for. */
function charge(steps: Steps, n: number): void {
  steps.left -= n;
  if (steps.left < 0) throw new OutOfSteps();
}
const scanSteps = (bytes: number) => Math.ceil(bytes / 8) + 1;

/**
 * A search's predicates as one test of an element's bytes, with ARGREP's meanings: EXACT equal bytes, MATCH a
 * substring, GLOB Redis's glob (`glob.ts`), NOCASE folding ASCII letters, `or` any and `and` all of them. The work is
 * paid from `steps` (unbounded when omitted); an exhausted allowance throws OutOfSteps.
 */
export function searchMatcher(q: SearchRequest): (value: Buffer, steps?: Steps) => boolean {
  const tests = q.predicates.map((p) => {
    const raw = predicateBytes(p.value, p.kind);
    const needle = q.nocase && p.kind !== 'glob' ? folded(raw) : raw;
    if (p.kind === 'glob') return (v: Buffer, _f: () => Buffer, steps: Steps) => globMatch(raw, v, q.nocase, steps);
    if (p.kind === 'exact') return (v: Buffer, f: () => Buffer, steps: Steps) => { charge(steps, scanSteps(v.length)); return (q.nocase ? f() : v).equals(needle); };
    return (v: Buffer, f: () => Buffer, steps: Steps) => { charge(steps, scanSteps(v.length)); return (q.nocase ? f() : v).indexOf(needle) !== -1; };
  });
  return (value, steps = { left: Infinity }) => {
    let fold: Buffer | undefined;
    const f = () => {
      if (!fold) { charge(steps, scanSteps(value.length)); fold = folded(value); }
      return fold;
    };
    return q.combine === 'and' ? tests.every((t) => t(value, f, steps)) : tests.some((t) => t(value, f, steps));
  };
}

/** The index of the first existing element from `from` towards `end` (there is one): AROP USED bisection, no value read. */
async function firstElement(scope: DbScope, conn: Conn, key: Buffer, from: string, end: string, timeout: number): Promise<string> {
  if ((await used(scope, conn, key, from, from, timeout)) > 0) return from;
  const before = await windowEnd(scope, conn, key, from, end, 0, timeout);
  return stepIndex(before.to, BigInt(from) > BigInt(end)) ?? before.to;
}

const tooLarge = (e: unknown) => e instanceof HttpError && e.code === 'too_large';

/**
 * Search values over [start, end] in either direction (review v0.4 r2 H1/H2). The elements are read with ARSCAN in
 * batches through the measured transport, all from one cumulative budget of `maxBytes` (ARRAY_SEARCH_MAX_BYTES, or the
 * request read budget when smaller), and matched here (searchMatcher). A request therefore makes Redis copy at most
 * that many bytes and visit at most `maxElements` elements, whatever the predicates, the element sizes or how they are
 * spread; ARGREP is not used, since nothing bounds its work in Redis.
 *
 * Each read is capped at `readCap` (at most half the budget). Every request reads its first element alone, with a
 * whole read cap and a fresh budget, so it always tests or skips at least one element: a value whose reply is larger
 * than `readCap` (the value and a few bytes of framing) is located by AROP USED bisection (no value read) and reported
 * in `skipped` (review v0.4 r3 M1). Then batches follow the sizes seen; after one overflows, the elements it held are
 * read one at a time, and when what is left of the budget no longer holds a whole read cap, the request stops and the
 * next one continues there.
 */
export async function searchArray(
  scope: DbScope,
  conn: Conn,
  key: Buffer,
  q: SearchRequest,
  preview: Preview,
  timeout: number,
  o: { maxElements?: number; maxBytes?: number; readCap?: number; matchSteps?: number } = {},
): Promise<ArraySearchResult> {
  const maxElements = o.maxElements ?? ARRAY_SCAN_MAX_ELEMENTS;
  const steps: Steps = { left: o.matchSteps ?? ARRAY_SEARCH_MATCH_STEPS };
  const maxBytes = o.maxBytes ?? ARRAY_SEARCH_MAX_BYTES;
  const readCap = Math.max(1, Math.min(o.readCap ?? maxBytes, Math.floor(maxBytes / 2)));
  const matches = searchMatcher(q);
  const down = BigInt(q.start) > BigInt(q.end);
  const budget = { remaining: maxBytes };
  const items: ArraySearchResult['items'] = [];
  const out = (searchedTo: string, elements: number, next?: string, skipped?: string): ArraySearchResult => ({
    items,
    start: q.start,
    searchedTo,
    elements,
    ...(next !== undefined ? { next } : {}),
    ...(skipped !== undefined ? { skipped: [skipped] } : {}),
  });
  let cursor = q.start;
  let examined = 0;
  let lastTested = q.start;
  let yielded = performance.now();
  let wire = 0;
  // The first element alone (see above); later batches follow the sizes seen.
  let batch = 1;
  // After a batch overflowed, the next elements it held are read one at a time, so the large one is reached alone.
  let careful = 0;
  for (;;) {
    const n = Math.min(careful > 0 ? 1 : batch, ARRAY_PAGE_MAX, maxElements - examined);
    // The element bound: stop before the next element, which the next request reads.
    if (n <= 0) return out(stepIndex(cursor, !down) ?? cursor, examined, cursor);
    // The budget is spent: the next request continues here.
    if (budget.remaining <= 0) return out(stepIndex(cursor, !down) ?? cursor, examined, cursor);
    const cap = Math.min(readCap, budget.remaining);
    let raw: unknown;
    const before = budget.remaining;
    try {
      raw = await arrayRead(scope, conn, ['ARSCAN', key, cursor, q.end, 'LIMIT', String(n)], { key, timeout, maxBytes: cap, replyBudget: budget });
    } catch (e) {
      if (!tooLarge(e)) throw e;
      if (n > 1) { careful = n; continue; }
      // One element did not fit in what is left of the budget: the next request reads it first, with a whole budget.
      // (Only after other elements: the first read of a request has a whole read cap.)
      if (cap < readCap && examined > 0) return out(stepIndex(cursor, !down) ?? cursor, examined, cursor);
      // It is larger than one read may be: skip it.
      const at = await firstElement(scope, conn, key, cursor, q.end, timeout);
      const next = at === q.end ? undefined : stepIndex(at, down);
      return out(at, examined, next, at);
    }
    wire += before - budget.remaining;
    const got = pairs(raw);
    if (careful > 0) careful -= got.length;
    for (const [index, value] of got) {
      let hit: boolean;
      try {
        hit = matches(value, steps);
      } catch (e) {
        if (!(e instanceof OutOfSteps)) throw e;
        // The matching allowance is spent (review v0.4 r3 H1). On the request's first element, that value alone costs
        // more than a request may spend: skip it. Otherwise the next request starts at it with a whole allowance.
        if (examined === 0) return out(index, 0, index === q.end ? undefined : stepIndex(index, down), index);
        return out(lastTested, examined, index);
      }
      examined++;
      lastTested = index;
      if (hit) {
        items.push(q.values ? element(index, value, preview) : { index });
        if (items.length === q.limit) {
          const next = index === q.end ? undefined : stepIndex(index, down);
          return out(index, examined, next);
        }
      }
      // Matching is synchronous: let other requests run every few milliseconds.
      if (performance.now() - yielded > 10) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        yielded = performance.now();
      }
    }
    const last = got.at(-1)?.[0];
    // Fewer than asked: nothing is left in the range.
    if (got.length < n || last === undefined || last === q.end) return out(q.end, examined);
    const next = stepIndex(last, down);
    if (next === undefined) return out(q.end, examined);
    cursor = next;
    // The next batch: as many elements as one read (or the rest of the budget) holds at the wire size seen so far.
    batch = Math.max(1, Math.min(ARRAY_PAGE_MAX, Math.floor(Math.min(readCap, budget.remaining) / Math.max(16, wire / examined))));
  }
}

type AggregateRequest = z.infer<typeof zArrayAggregate>;

/** AROP over a range of at most ARRAY_SCAN_MAX_ELEMENTS elements (larger ranges get 400 with their count). */
export async function aggregateArray(scope: DbScope, conn: Conn, key: Buffer, q: AggregateRequest, timeout: number, maxElements = ARRAY_SCAN_MAX_ELEMENTS): Promise<ArrayAggregateResult> {
  if ((q.op === 'match') !== (q.value !== undefined)) throw new HttpError('validation', q.op === 'match' ? 'MATCH needs a value.' : 'Only MATCH takes a value.');
  const elements = await used(scope, conn, key, q.start, q.end, timeout);
  if (q.op === 'used') return { op: q.op, result: String(elements), elements };
  if (elements > maxElements) {
    throw new HttpError('validation', `This range holds ${elements.toLocaleString('en-US')} elements; aggregates read at most ${maxElements.toLocaleString('en-US')} at a time. Narrow the range.`);
  }
  const argv: Arg[] = ['AROP', key, q.start, q.end, q.op.toUpperCase()];
  if (q.value) argv.push(predicateBytes(q.value, 'match'));
  const raw = await arrayRead(scope, conn, argv, { key, timeout, maxBytes: 64 * 1024 });
  return { op: q.op, result: raw == null ? null : intText(raw), elements };
}

/** POST /key/element for an array reference: ARGET bounded by `limit`; the element must still be the one the page read. */
export async function readArrayElement(scope: DbScope, key: Buffer, ref: Extract<ElementRef, { kind: 'array' }>, limit: number, timeout: number, wireCap: number): Promise<KeyElementResponse> {
  const conn = await scope.conn();
  const raw = await arrayRead(scope, conn, ['ARGET', key, ref.index], { key, timeout, replyBudget: { remaining: wireCap }, maxBytes: Math.min(wireCap, limit + 64) });
  if (raw == null) throw new HttpError('not_found', 'This array element no longer exists.');
  const value = bytes(raw);
  if (sha(value) !== ref.identity) throw new HttpError('conflict', 'This array element changed; refresh the page before loading it.');
  if (value.length > limit) throw new HttpError('too_large', `The full element exceeds the ${limit}-byte value cap.`);
  return { value: binFromBytes(value) };
}

// ---------------------------------------------------------------------------
// Typed writes (POST /ops): fixed commands, planned here and run by routes/keys.ts like every other op.

export type ArrayOp = Extract<KeyOp, { op: 'array.set' | 'array.insert' | 'array.delete' | 'array.delete-range' }>;

const k = (x: Bin) => Buffer.from(bytesFromBin(x));

export function planArrayOp(op: ArrayOp): { argv: Arg[]; confirm: ConfirmLevel; summary: string; keys: number[] } {
  switch (op.op) {
    case 'array.set':
      return { argv: ['ARSET', k(op.key), op.index, k(op.value)], confirm: 'none', summary: `Set array element ${op.index}`, keys: [1] };
    case 'array.insert':
      return { argv: ['ARINSERT', k(op.key), ...op.values.map(k)], confirm: 'none', summary: op.expect.type === 'none' ? 'Create array' : `Append ${op.values.length} array element(s) at the insert cursor`, keys: [1] };
    case 'array.delete':
      return { argv: ['ARDEL', k(op.key), ...op.indexes], confirm: 'confirm', summary: `Delete ${op.indexes.length} array element(s)`, keys: [1] };
    case 'array.delete-range': {
      const [a, b] = BigInt(op.start) <= BigInt(op.end) ? [op.start, op.end] : [op.end, op.start];
      return { argv: ['ARDELRANGE', k(op.key), op.start, op.end], confirm: 'confirm', summary: `Delete every array element from index ${a} to ${b}`, keys: [1] };
    }
  }
}

/** The compare-and-set probe of an array op that carries `expect` (array.set, array.insert). */
export function arrayProbe(op: ArrayOp): Probe | undefined {
  if (op.op === 'array.set') return { kind: 'array', index: op.index };
  if (op.op === 'array.insert') return { kind: 'arrayInsert', count: op.values.length };
  return undefined;
}
