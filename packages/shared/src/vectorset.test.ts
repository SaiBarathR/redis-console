import { describe, expect, it } from 'vitest';
import { ROUTES, VSET_NUMBER, zKeyOp, zVsetAttributesRequest, zVsetMembersRequest } from './api.ts';
import { lookupRule } from './commands.ts';

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
  });

  it('vset ops parse as typed ops; remove takes one member', () => {
    expect(zKeyOp.safeParse({ op: 'vset.remove', key: utf8('k'), member: utf8('m') }).success).toBe(true);
    expect(zKeyOp.safeParse({ op: 'vset.remove', key: utf8('k'), members: [utf8('m')] }).success).toBe(false);
    expect(zKeyOp.safeParse({ op: 'vset.add', key: utf8('k'), member: utf8('m'), values: ['1'], quantization: 'Q4', expect: { type: 'none' } }).success).toBe(false);
  });
});
