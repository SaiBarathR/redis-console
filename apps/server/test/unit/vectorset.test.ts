/** Vector-set argv builders, reply parsers, op plans and compare-and-set probes (v0.4, F23). No Redis needed. */
import { describe, expect, it } from 'vitest';
import {
  KEY_ELEMENT_PREVIEW_BYTES,
  VSET_FILTER_EF_MAX,
  VSET_LINKS_PER_LAYER_MAX,
  VSET_LINK_LAYERS_MAX,
  VSET_MEMBER_MAX_BYTES,
  zKeyOp,
  zVsetSearchRequest,
} from '@rconsole/shared';
import { conflictOf, validateExpect, type CheckedPlan } from '../../src/redis/checked.ts';
import { HttpError } from '../../src/http/errors.ts';
import { infoOf, isTrue, linksOf, memberBytes, pageOf, planVsetOp, prefixEnd, similarOf, vrangeArgs, vsetProbe, vsetRequestError, vsimArgs } from '../../src/redis/vectorset.ts';

const B = (s: string | number[]) => (typeof s === 'string' ? Buffer.from(s) : Buffer.from(s));
const text = (argv: (string | Buffer)[]) => argv.map((a) => (Buffer.isBuffer(a) ? a.toString('latin1') : a));
const utf8 = (data: string) => ({ enc: 'utf8' as const, data });

describe('VRANGE paging and prefix bounds', () => {
  it('prefixEnd increments the last byte, dropping trailing 0xff; none for empty or all-0xff prefixes', () => {
    expect(prefixEnd(B('m29'))).toEqual(B('m2:'));
    expect(prefixEnd(B([0x61, 0xff, 0xff]))).toEqual(B([0x62]));
    expect(prefixEnd(B([0xff]))).toBeUndefined();
    expect(prefixEnd(B(''))).toBeUndefined();
  });

  it('builds - + for the first page, (after for later pages, [prefix (end for a prefix', () => {
    expect(text(vrangeArgs(B('k'), { count: 100 })!)).toEqual(['VRANGE', 'k', '-', '+', '101']);
    expect(text(vrangeArgs(B('k'), { after: B('m009'), count: 5 })!)).toEqual(['VRANGE', 'k', '(m009', '+', '6']);
    expect(text(vrangeArgs(B('k'), { prefix: B('m29'), count: 5 })!)).toEqual(['VRANGE', 'k', '[m29', '(m2:', '6']);
    // An `after` before the prefix starts at the prefix; inside it, after it.
    expect(text(vrangeArgs(B('k'), { prefix: B('m29'), after: B('a'), count: 5 })!)).toEqual(['VRANGE', 'k', '[m29', '(m2:', '6']);
    expect(text(vrangeArgs(B('k'), { prefix: B('m29'), after: B('m295'), count: 5 })!)).toEqual(['VRANGE', 'k', '(m295', '(m2:', '6']);
    // At or past the prefix's end there is nothing to read.
    expect(vrangeArgs(B('k'), { prefix: B('m29'), after: B('m2:'), count: 5 })).toBeNull();
    // A 0xff prefix runs to +.
    expect(text(vrangeArgs(B('k'), { prefix: B([0xff]), count: 5 })!)).toEqual(['VRANGE', 'k', '[\xff', '+', '6']);
    // After the empty member (a legal name): the smallest name after it, since "(" alone is not a range (review v0.4 r1 L3).
    expect(text(vrangeArgs(B('k'), { after: B(''), count: 5 })!)).toEqual(['VRANGE', 'k', '[\x00', '+', '6']);
  });

  it('pageOf names the next start only when VRANGE returned more than a page, in full bytes, and cuts long names', () => {
    expect(pageOf([B('a'), B('b')], 3, 1e6)).toEqual({ members: [{ member: utf8('a') }, { member: utf8('b') }] });
    // Exactly full: the last page (review v0.4 r1 L1); one more member: cut to the page and continue after its last.
    expect(pageOf([B('a'), B('b')], 2, 1e6).next).toBeUndefined();
    expect(pageOf([B('a'), B('b'), B('c')], 2, 1e6)).toEqual({ members: [{ member: utf8('a') }, { member: utf8('b') }], next: utf8('b') });
    const long = Buffer.alloc(KEY_ELEMENT_PREVIEW_BYTES + 1, 0x61);
    const page = pageOf([long, B('z')], 1, 1e9);
    expect(page.members[0]!.truncated).toBe(true);
    expect(page.next).toBeUndefined();
    expect(page.nextUnavailable).toBe(true);
    // Past the display budget, names are cut to 64 bytes but `next` stays exact.
    const names = [Buffer.alloc(100, 0x62), Buffer.alloc(100, 0x63), B('d')];
    const cut = pageOf(names, 2, 100);
    expect(cut.members[1]).toMatchObject({ truncated: true });
    expect(Buffer.from(cut.next!.data).length).toBe(100);
    expect(pageOf([], 5, 100, B('p')).prefix).toEqual(utf8('p'));
  });
});

describe('reply parsers', () => {
  it('infoOf reads the shown VINFO fields and ignores others and odd quantisation text', () => {
    const flat = ['quant-type', 'int8', 'hnsw-m', 16, 'vector-dim', 3, 'projection-input-dim', 0, 'size', 3, 'max-level', 2, 'attributes-count', 1, 'vset-uid', 9];
    expect(infoOf(3, 3, flat)).toEqual({ size: 3, dim: 3, quantization: 'int8', hnswM: 16, maxLevel: 2, attributesCount: 1, projectionInputDim: 0 });
    expect(infoOf(1, 2, ['quant-type', '<script>'])).toEqual({ size: 1, dim: 2 });
    expect(infoOf(1, 2, new Map([['__proto__', 'x']]))).toEqual({ size: 1, dim: 2 });
  });

  it('linksOf bounds layers and neighbours per layer and counts the rest', () => {
    const layer = (n: number) => Array.from({ length: n }, (_, i) => [B(`n${i}`), '0.5']).flat();
    const r = linksOf([layer(VSET_LINKS_PER_LAYER_MAX + 3), layer(2)]);
    expect(r.links[0]!.neighbours.length).toBe(VSET_LINKS_PER_LAYER_MAX);
    expect(r.links[0]!.more).toBe(3);
    expect(r.links[1]).toEqual({ layer: 1, neighbours: [{ member: utf8('n0'), score: '0.5' }, { member: utf8('n1'), score: '0.5' }] });
    const many = linksOf(Array.from({ length: VSET_LINK_LAYERS_MAX + 2 }, () => layer(1)));
    expect(many.links.length).toBe(VSET_LINK_LAYERS_MAX);
    expect(many.moreLayers).toBe(2);
    expect(linksOf(null)).toEqual({ links: [] });
    const big = linksOf([[Buffer.alloc(VSET_MEMBER_MAX_BYTES + 1), '1']]);
    expect(big.links[0]!.neighbours[0]!.truncated).toBe(true);
  });

  it('similarOf reads scores, and [score, attributes] pairs with WITHATTRIBS', () => {
    expect(similarOf([B('a'), '1', B('b'), '0.5'], false)).toEqual([{ member: B('a'), score: '1' }, { member: B('b'), score: '0.5' }]);
    expect(similarOf([B('a'), ['1', B('{"x":1}')], B('b'), ['0.5', null]], true)).toEqual([
      { member: B('a'), score: '1', attributes: B('{"x":1}') },
      { member: B('b'), score: '0.5', attributes: null },
    ]);
  });

  it('isTrue reads RESP3 booleans and RESP2 integers', () => {
    expect([true, false, 1, 0, '1', null].map(isTrue)).toEqual([true, false, true, false, true, false]);
  });

  it('maps request-shaped Redis errors to 404 and 400, and leaves the rest alone', () => {
    expect(vsetRequestError(new HttpError('redis_error', 'ERR element not found in set'))?.code).toBe('not_found');
    expect(vsetRequestError(new HttpError('redis_error', 'ERR Vector dimension mismatch - got 2 but set has 3'))?.code).toBe('validation');
    expect(vsetRequestError(new HttpError('redis_error', 'ERR syntax error in FILTER expression near: x'))?.message).toContain('syntax error in FILTER expression');
    expect(vsetRequestError(new HttpError('redis_error', 'ERR invalid vector specification'))?.code).toBe('validation');
    expect(vsetRequestError(new HttpError('redis_error', 'ERR something else'))).toBeUndefined();
    expect(vsetRequestError(new HttpError('timeout', 'element not found'))).toBeUndefined();
  });
});

describe('VSIM argv', () => {
  const q = (o: Record<string, unknown>) => zVsetSearchRequest.parse({ key: utf8('k'), ...o });
  it('always sends COUNT and WITHSCORES, and FILTER-EF with every filter (never 0, never TRUTH or NOTHREAD)', () => {
    expect(text(vsimArgs(B('k'), q({ query: { element: utf8('m') } })))).toEqual(['VSIM', 'k', 'ELE', 'm', 'COUNT', '10', 'WITHSCORES']);
    expect(text(vsimArgs(B('k'), q({ query: { values: ['1', '-2.5', '3e2'] }, count: 3, ef: 40, withAttributes: true })))).toEqual(['VSIM', 'k', 'VALUES', '3', '1', '-2.5', '3e2', 'COUNT', '3', 'WITHSCORES', 'WITHATTRIBS', 'EF', '40']);
    expect(text(vsimArgs(B('k'), q({ query: { element: utf8('m') }, count: 7, filter: '.a > 1' })))).toEqual(['VSIM', 'k', 'ELE', 'm', 'COUNT', '7', 'WITHSCORES', 'FILTER', '.a > 1', 'FILTER-EF', '700']);
    expect(text(vsimArgs(B('k'), q({ query: { element: utf8('m') }, count: 100, filter: '.a', filterEf: VSET_FILTER_EF_MAX })))).toContain(String(VSET_FILTER_EF_MAX));
    const all = vsimArgs(B('k'), q({ query: { element: utf8('m') }, filter: '.a' })).map(String);
    expect(all).not.toContain('TRUTH');
    expect(all).not.toContain('NOTHREAD');
  });
  it('the schema refuses unbounded or non-numeric input', () => {
    for (const bad of [{ count: 0 }, { count: 101 }, { ef: 0 }, { ef: 1001 }, { filterEf: 0 }, { filter: '' }, { query: { values: [] } }, { query: { values: ['nan'] } }, { query: { values: ['1e9999'] } }, { query: { element: utf8('m'), values: ['1'] } }])
      expect(zVsetSearchRequest.safeParse({ key: utf8('k'), query: { element: utf8('m') }, ...bad }).success, JSON.stringify(bad)).toBe(false);
  });
});

describe('vset ops', () => {
  const op = (o: Record<string, unknown>) => zKeyOp.parse({ key: utf8('k'), ...o }) as Parameters<typeof planVsetOp>[0];
  it('vset.add: one VADD, audited as its shape', () => {
    const plan = planVsetOp(op({ op: 'vset.add', member: utf8('m'), values: ['1', '2'], quantization: 'Q8', attributes: utf8('{"a":1}'), expect: { type: 'vectorset', sha256: null } }));
    expect(text(plan.argv)).toEqual(['VADD', 'k', 'VALUES', '2', '1', '2', 'm', 'Q8', 'SETATTR', '{"a":1}']);
    expect(plan.confirm).toBe('none');
    expect(plan.redacted).toEqual(['VADD', expect.stringMatching(/^key#[0-9a-f]{12}$/), 'VALUES', '<2 values>', '<1 bytes>', 'Q8', 'SETATTR', '<7 bytes>']);
    expect(vsetProbe(op({ op: 'vset.add', member: utf8('m'), values: ['1'], expect: { type: 'none' } }))).toEqual({ kind: 'vmember', member: B('m') });
  });
  it('vset.remove: one VREM of one member, with a confirmation', () => {
    const plan = planVsetOp(op({ op: 'vset.remove', member: utf8('m') }));
    expect(text(plan.argv)).toEqual(['VREM', 'k', 'm']);
    expect(plan.confirm).toBe('confirm');
    expect(vsetProbe(op({ op: 'vset.remove', member: utf8('m') }))).toBeUndefined();
  });
  it('vset.add and vset.setattr require an expectation', () => {
    expect(zKeyOp.safeParse({ op: 'vset.add', key: utf8('k'), member: utf8('m'), values: ['1'] }).success).toBe(false);
    expect(zKeyOp.safeParse({ op: 'vset.setattr', key: utf8('k'), member: utf8('m'), attributes: utf8('{}') }).success).toBe(false);
  });
  it('members longer than VSET_MEMBER_MAX_BYTES are refused', () => {
    expect(() => memberBytes({ enc: 'base64', data: Buffer.alloc(VSET_MEMBER_MAX_BYTES + 1).toString('base64') })).toThrow(/at most/);
    expect(() => memberBytes({ enc: 'base64', data: '!!' })).toThrow(/invalid base64/);
  });
});

describe('compare-and-set probes for vector sets', () => {
  const member = B('m');
  const bad = (f: () => void) => expect(f).toThrow(HttpError);
  it('an add may only expect the member absent; an attribute edit must name the bytes it read', () => {
    validateExpect({ kind: 'vmember', member }, { type: 'vectorset', sha256: null });
    validateExpect({ kind: 'vmember', member }, { type: 'none' });
    bad(() => validateExpect({ kind: 'vmember', member }, { type: 'vectorset' }));
    bad(() => validateExpect({ kind: 'vmember', member }, { type: 'vectorset', sha256: 'a'.repeat(64) }));
    bad(() => validateExpect({ kind: 'vmember', member }, { type: 'hash', sha256: null }));
    validateExpect({ kind: 'vattr', member }, { type: 'vectorset', sha256: 'a'.repeat(64) });
    bad(() => validateExpect({ kind: 'vattr', member }, { type: 'vectorset', sha256: null }));
    bad(() => validateExpect({ kind: 'vattr', member }, { type: 'vectorset' }));
    bad(() => validateExpect({ kind: 'vattr', member }, { type: 'none' }));
  });
  it('conflicts never offer to overwrite an existing member or to edit a member that is gone', () => {
    const plan = (kind: 'vmember' | 'vattr', sha256: string | null): CheckedPlan => ({ key: B('k'), probe: { kind, member }, expect: { type: 'vectorset', sha256 }, command: ['VADD'] });
    const exists = conflictOf(plan('vmember', null), { type: 'vectorset', sha: 'member-present' });
    expect(exists.message).toMatch(/already exists/);
    expect((exists.extra as { conflict: { current: { expect?: unknown } } }).conflict.current.expect).toBeUndefined();
    const gone = conflictOf(plan('vattr', 'a'.repeat(64)), { type: 'vectorset', sha: null });
    expect(gone.message).toMatch(/no longer exists/);
    expect((gone.extra as { conflict: { current: { expect?: unknown } } }).conflict.current.expect).toBeUndefined();
    const changed = conflictOf(plan('vattr', 'a'.repeat(64)), { type: 'vectorset', sha: 'b'.repeat(64), bytes: B('{"x":1}'), total: 7 });
    expect(changed.message).toMatch(/This value changed/);
    expect((changed.extra as { conflict: { current: { expect?: unknown } } }).conflict.current.expect).toEqual({ type: 'vectorset', sha256: 'b'.repeat(64) });
  });
});
