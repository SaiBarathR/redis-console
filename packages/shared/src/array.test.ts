/** v0.4 arrays: the shared contract (index schema, request schemas, typed ops, command rules). */
import { describe, expect, it } from 'vitest';
import {
  ARRAY_MAX_INDEX,
  ARRAY_PREDICATE_MAX_BYTES,
  isArrayIndex,
  zArrayAggregate,
  zArrayIndex,
  zArrayRange,
  zArraySearch,
  zElementRef,
  zKeyOp,
} from './api.ts';
import { ARGREP_NOCASE_MATCH_MAX_BYTES, ARGREP_RE_HINT, ARGREP_VALUE_MAX_BYTES, argrepPredicates, argumentRule, lookupRule } from './commands.ts';

const key = { enc: 'utf8' as const, data: 'arr' };
const sha = 'a'.repeat(64);

describe('array index', () => {
  it('accepts canonical decimal indices from 0 to 2^64 - 2', () => {
    for (const s of ['0', '1', '42', '9007199254740993', ARRAY_MAX_INDEX]) expect(isArrayIndex(s), s).toBe(true);
  });
  it('refuses 2^64 - 1 and above, signs, leading zeros, fractions and empty text', () => {
    for (const s of ['18446744073709551615', '99999999999999999999', '-1', '+1', '01', '007', '1.5', '1e3', '', ' 1', '0x10', '١'])
      expect(isArrayIndex(s), s).toBe(false);
    expect(zArrayIndex.safeParse('18446744073709551615').success).toBe(false);
    expect(zArrayIndex.safeParse('1'.repeat(21)).success).toBe(false);
  });
});

describe('array request schemas', () => {
  it('range: defaults, bounds and strictness', () => {
    expect(zArrayRange.parse({ key })).toEqual({ key, count: 100, reverse: false });
    expect(zArrayRange.safeParse({ key, count: 1001 }).success).toBe(false);
    expect(zArrayRange.safeParse({ key, count: 0 }).success).toBe(false);
    expect(zArrayRange.safeParse({ key, start: '-1' }).success).toBe(false);
    expect(zArrayRange.safeParse({ key, extra: 1 }).success).toBe(false);
  });
  it('search: EXACT, MATCH and GLOB only; RE is not a predicate kind', () => {
    const ok = zArraySearch.parse({ key, predicates: [{ kind: 'glob', value: { enc: 'utf8', data: 'a*' } }] });
    expect(ok).toMatchObject({ start: '0', end: ARRAY_MAX_INDEX, combine: 'or', nocase: false, limit: 100, values: true });
    expect(zArraySearch.safeParse({ key, predicates: [{ kind: 're', value: { enc: 'utf8', data: '.*' } }] }).success).toBe(false);
    expect(zArraySearch.safeParse({ key, predicates: [] }).success).toBe(false);
    expect(zArraySearch.safeParse({ key, predicates: Array.from({ length: 9 }, () => ({ kind: 'exact', value: key })) }).success).toBe(false);
    expect(zArraySearch.safeParse({ key, predicates: [{ kind: 'exact', value: key }], limit: 1001 }).success).toBe(false);
  });
  it('aggregate: a known operation over an explicit range', () => {
    expect(zArrayAggregate.safeParse({ key, start: '0', end: '9', op: 'sum' }).success).toBe(true);
    expect(zArrayAggregate.safeParse({ key, start: '0', end: '9', op: 'avg' }).success).toBe(false);
    expect(zArrayAggregate.safeParse({ key, op: 'sum' }).success).toBe(false);
  });
});

describe('array element references and typed ops', () => {
  it('element reference carries an index and the digest of the element it names', () => {
    expect(zElementRef.safeParse({ kind: 'array', index: '5', identity: sha }).success).toBe(true);
    expect(zElementRef.safeParse({ kind: 'array', index: '5' }).success).toBe(false);
    expect(zElementRef.safeParse({ kind: 'array', index: '-5', identity: sha }).success).toBe(false);
  });
  it('array.set and array.insert require an expectation (compare-and-set, creates never overwrite)', () => {
    expect(zKeyOp.safeParse({ op: 'array.set', key, index: '3', value: key }).success).toBe(false);
    expect(zKeyOp.safeParse({ op: 'array.set', key, index: '3', value: key, expect: { type: 'array', sha256: null } }).success).toBe(true);
    expect(zKeyOp.safeParse({ op: 'array.insert', key, values: [key] }).success).toBe(false);
    expect(zKeyOp.safeParse({ op: 'array.insert', key, values: [key], expect: { type: 'none' } }).success).toBe(true);
    expect(zKeyOp.safeParse({ op: 'array.insert', key, values: [], expect: { type: 'array' } }).success).toBe(false);
  });
  it('deletes take indices or one inclusive range', () => {
    expect(zKeyOp.safeParse({ op: 'array.delete', key, indexes: ['0', ARRAY_MAX_INDEX] }).success).toBe(true);
    expect(zKeyOp.safeParse({ op: 'array.delete', key, indexes: [] }).success).toBe(false);
    expect(zKeyOp.safeParse({ op: 'array.delete-range', key, start: '10', end: '0' }).success).toBe(true);
    expect(zKeyOp.safeParse({ op: 'array.delete-range', key, start: '10' }).success).toBe(false);
  });
});

describe('array command rules (v0.4 arrays block)', () => {
  it('classifies every AR* command explicitly; destructive ones confirm', () => {
    for (const c of ['ARGET', 'ARMGET', 'ARGETRANGE', 'ARSCAN', 'ARGREP', 'AROP', 'ARLASTITEMS', 'ARNEXT', 'ARLEN', 'ARCOUNT', 'ARINFO'])
      expect(lookupRule([c]), c).toEqual({ class: 'read' });
    for (const c of ['ARSET', 'ARMSET', 'ARINSERT', 'ARSEEK']) expect(lookupRule([c]), c).toEqual({ class: 'write' });
    for (const c of ['ARDEL', 'ARDELRANGE', 'ARRING']) expect(lookupRule([c]), c).toEqual({ class: 'write', confirm: 'confirm' });
    expect(lookupRule(['ardelrange'])).toEqual({ class: 'write', confirm: 'confirm' });
  });
  it('blocks ARGREP with an RE predicate in any position and case, not a value that reads "RE"', () => {
    const blocked = { class: 'blocked', hint: ARGREP_RE_HINT };
    expect(argumentRule(['ARGREP', 'k', '0', '10', 'RE', '(a+)+$'])).toEqual(blocked);
    expect(argumentRule(['argrep', 'k', '0', '10', 'EXACT', 'x', 'OR', 're', 'y'])).toEqual(blocked);
    expect(argumentRule(['ARGREP', 'k', '0', '10', 'WITHVALUES', 'Re', 'y', 'LIMIT', '5'])).toEqual(blocked);
    // "RE" as the value of EXACT, or as LIMIT's argument, is not a predicate.
    expect(argumentRule(['ARGREP', 'k', '0', '10', 'EXACT', 'RE'])).toBeUndefined();
    expect(argumentRule(['ARGREP', 'k', '0', '10', 'GLOB', 'r*', 'LIMIT', '3', 'NOCASE'])).toBeUndefined();
    // The key, start and end are never predicates.
    expect(argumentRule(['ARGREP', 'RE', 'RE', 'RE', 'MATCH', 'x'])).toBeUndefined();
    expect(argrepPredicates(['ARGREP', 'k', '0', '10', 'EXACT', 'LIMIT', 'RE', 'x', 'MATCH', 'RE'])).toEqual(['EXACT', 'RE', 'MATCH']);
  });
  it('bounds ARGREP search values: at most 1 KiB, and a NOCASE MATCH at most 64 bytes (review v0.4 r1 H1)', () => {
    expect(ARRAY_PREDICATE_MAX_BYTES).toBe(ARGREP_VALUE_MAX_BYTES);
    const long = 'a'.repeat(1025);
    expect(argumentRule(['ARGREP', 'k', '0', '10', 'EXACT', long])?.class).toBe('blocked');
    expect(argumentRule(['ARGREP', 'k', '0', '10', 'MATCH', 'x', 'OR', 'GLOB', long])?.class).toBe('blocked');
    expect(argumentRule(['ARGREP', 'k', '0', '10', 'MATCH', 'a'.repeat(1024)])).toBeUndefined();
    // NOCASE makes MATCH cost the pattern length times a plain scan, wherever NOCASE is written.
    expect(argumentRule(['ARGREP', 'k', '0', '10', 'MATCH', 'a'.repeat(65), 'NOCASE'])?.class).toBe('blocked');
    expect(argumentRule(['argrep', 'k', '0', '10', 'nocase', 'match', 'a'.repeat(65)])?.class).toBe('blocked');
    expect(argumentRule(['ARGREP', 'k', '0', '10', 'MATCH', 'a'.repeat(64), 'NOCASE'])).toBeUndefined();
    expect(argumentRule(['ARGREP', 'k', '0', '10', 'EXACT', 'a'.repeat(65), 'NOCASE'])).toBeUndefined();
    // Multi-byte characters count as bytes.
    expect(argumentRule(['ARGREP', 'k', '0', '10', 'MATCH', 'é'.repeat(33), 'NOCASE'])?.class).toBe('blocked');
    // A value that reads "NOCASE" is not the option.
    expect(argumentRule(['ARGREP', 'k', '0', '10', 'MATCH', 'NOCASE', 'EXACT', 'a'.repeat(65)])).toBeUndefined();
  });
});
