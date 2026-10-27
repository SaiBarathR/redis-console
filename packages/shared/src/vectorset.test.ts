import { describe, expect, it } from 'vitest';
import { ROUTES, VSET_FILTER_EF_MAX, VSET_FILTER_MAX_CHARS, VSET_NUMBER, VSET_SEARCH_EF_MAX, zKeyOp, zVsetAttributesRequest, zVsetMembersRequest, zVsetSearchRequest } from './api.ts';
import { argumentRule, lookupRule, VSIM_COUNT_MAX, VSIM_EF_MAX, VSIM_FILTER_EF_MAX, VSIM_FILTER_MAX_BYTES } from './commands.ts';

const utf8 = (data: string) => ({ enc: 'utf8' as const, data });

describe('v0.4 vector sets: policy and contract', () => {
  it('every V* command has an explicit rule: reads for viewers, writes for operators', () => {
    for (const c of ['VCARD', 'VDIM', 'VEMB', 'VGETATTR', 'VINFO', 'VISMEMBER', 'VLINKS', 'VRANDMEMBER', 'VRANGE', 'VSIM']) expect(lookupRule([c]), c).toEqual({ class: 'read' });
    for (const c of ['VADD', 'VREM', 'VSETATTR']) expect(lookupRule([c.toLowerCase()]), c).toEqual({ class: 'write' });
    // A V* command Redis adds later is not covered by a rule: the server classifies it from COMMAND INFO or blocks it.
    expect(lookupRule(['VFUTURE'])).toBeUndefined();
  });

  it('routes are POSTs under the database (data only in bodies)', () => {
    for (const r of [ROUTES.vsetMembers, ROUTES.vsetAttributes, ROUTES.vsetElement, ROUTES.vsetSearch]) expect(r).toMatch(/^POST \/api\/v1\/databases\/:db\/vectorset\/[a-z]+$/);
  });

  it('page and row bounds', () => {
    expect(zVsetMembersRequest.parse({ key: utf8('k') }).count).toBe(100);
    expect(zVsetMembersRequest.safeParse({ key: utf8('k'), count: 501 }).success).toBe(false);
    expect(zVsetMembersRequest.safeParse({ key: utf8('k'), cursor: '0' }).success).toBe(false);
    expect(zVsetAttributesRequest.safeParse({ key: utf8('k'), members: [] }).success).toBe(false);
  });

  it('coordinates are finite decimals', () => {
    for (const ok of ['1', '-0.5', '+.25', '3e-2', '1.']) expect(VSET_NUMBER.test(ok), ok).toBe(true);
    for (const bad of ['', 'inf', 'nan', '0x1', '1e', '1,5', ' 1']) expect(VSET_NUMBER.test(bad), bad).toBe(false);
    // Redis reads each coordinate as a double: beyond its range is refused here, not passed on (review v0.4 r1 L3).
    const search = (x: string) => zVsetSearchRequest.safeParse({ key: utf8('k'), query: { values: [x, '0'] } }).success;
    for (const ok of ['1e99', '-1e308', '1e-300']) expect(search(ok), ok).toBe(true);
    for (const bad of ['1e309', '-1e999', '1e999']) expect(search(bad), bad).toBe(false);
  });

  it('vset ops parse as typed ops; remove takes one member', () => {
    expect(zKeyOp.safeParse({ op: 'vset.remove', key: utf8('k'), member: utf8('m') }).success).toBe(true);
    expect(zKeyOp.safeParse({ op: 'vset.remove', key: utf8('k'), members: [utf8('m')] }).success).toBe(false);
    expect(zKeyOp.safeParse({ op: 'vset.add', key: utf8('k'), member: utf8('m'), values: ['1'], quantization: 'Q4', expect: { type: 'none' } }).success).toBe(false);
  });

  it('the console bounds VSIM as the inspector does: no TRUTH or NOTHREAD, bounded COUNT, EF and FILTER-EF (review v0.4 r1 M2)', () => {
    expect([VSIM_EF_MAX, VSIM_FILTER_EF_MAX, VSIM_FILTER_MAX_BYTES]).toEqual([VSET_SEARCH_EF_MAX, VSET_FILTER_EF_MAX, VSET_FILTER_MAX_CHARS]);
    const blocked = (argv: string[]) => argumentRule(argv)?.class;
    // Allowed: the shapes the inspector sends, and the defaults.
    expect(argumentRule(['VSIM', 'k', 'ELE', 'm', 'COUNT', '10', 'WITHSCORES'])).toBeUndefined();
    expect(argumentRule(['vsim', 'k', 'values', '3', '1', '0', '0', 'count', String(VSIM_COUNT_MAX), 'ef', String(VSIM_EF_MAX), 'withattribs'])).toBeUndefined();
    expect(argumentRule(['VSIM', 'k', 'ELE', 'm', 'FILTER', '.year > 2000', 'FILTER-EF', String(VSIM_FILTER_EF_MAX), 'EPSILON', '0.2'])).toBeUndefined();
    expect(argumentRule(['VSIM', 'k', 'ELE', 'm'])).toBeUndefined();
    // TRUTH is a brute-force scan of every vector and NOTHREAD runs it on the main thread: refused in any case.
    expect(blocked(['VSIM', 'k', 'ELE', 'm', 'COUNT', '2', 'TRUTH', 'NOTHREAD'])).toBe('blocked');
    expect(blocked(['VSIM', 'k', 'ELE', 'm', 'truth'])).toBe('blocked');
    expect(blocked(['VSIM', 'k', 'VALUES', '2', '1', '0', 'NoThread'])).toBe('blocked');
    // Bounds on the numbers; FILTER-EF 0 means "no limit" to Redis.
    expect(blocked(['VSIM', 'k', 'ELE', 'm', 'COUNT', String(VSIM_COUNT_MAX + 1)])).toBe('blocked');
    expect(blocked(['VSIM', 'k', 'ELE', 'm', 'EF', String(VSIM_EF_MAX + 1)])).toBe('blocked');
    expect(blocked(['VSIM', 'k', 'ELE', 'm', 'FILTER', '.a', 'FILTER-EF', '0'])).toBe('blocked');
    expect(blocked(['VSIM', 'k', 'ELE', 'm', 'FILTER', '.a', 'FILTER-EF', String(VSIM_FILTER_EF_MAX + 1)])).toBe('blocked');
    expect(blocked(['VSIM', 'k', 'ELE', 'm', 'FILTER', 'x'.repeat(VSIM_FILTER_MAX_BYTES + 1)])).toBe('blocked');
    expect(blocked(['VSIM', 'k', 'ELE', 'm', 'COUNT', '1e9'])).toBe('blocked');
    // Names and values are operands, not options: a member called TRUTH, a filter text "NOTHREAD".
    expect(argumentRule(['VSIM', 'TRUTH', 'ELE', 'NOTHREAD', 'FILTER', 'NOTHREAD'])).toBeUndefined();
    // Fewer arguments than VSIM's arity (4) never run, so they are left to Redis; the bare name is not blocked.
    expect(argumentRule(['VSIM'])).toBeUndefined();
    expect(argumentRule(['VSIM', 'k', 'ELE'])).toBeUndefined();
    // An argv Redis would not parse is refused rather than guessed at (an option could hide in it).
    expect(blocked(['VSIM', 'k', 'VALUES', 'x', 'NOTHREAD'])).toBe('blocked');
    expect(blocked(['VSIM', 'k', 'VALUES', '3', '1', '0'])).toBe('blocked');
    expect(blocked(['VSIM', 'k', 'ELE', 'm', 'BOGUS'])).toBe('blocked');
  });
});
