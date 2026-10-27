import { describe, expect, it } from 'vitest';
import { conflictOf, type CheckedPlan } from '../../src/redis/checked.ts';

const plan = (type: string): CheckedPlan => ({ key: Buffer.from('k'), probe: { kind: 'key' }, expect: { type }, command: ['DEL', 'k'] });

describe('conflict message', () => {
  it('names a well-formed opened type', () => {
    expect(conflictOf(plan('hash'), { type: 'string' }).message).toContain('(you opened a hash)');
  });
  it('reads naturally for a key created meanwhile and for types starting with a vowel (review v0.4 r1 L5)', () => {
    expect(conflictOf(plan('none'), { type: 'vectorset' }).message).toBe('This key was created since you opened it (it is now a vectorset); nothing was written.');
    expect(conflictOf(plan('array'), { type: 'string' }).message).toContain('(you opened an array)');
    expect(conflictOf(plan('string'), { type: 'array' }).message).toContain('it is now an array (you opened a string)');
  });
  it('never copies arbitrary client text into the message (it reaches the audit log)', () => {
    const e = conflictOf(plan('x\n{"forged":"audit line"} <script>'), { type: 'string' });
    expect(e.message).toContain('(you opened a different type)');
    expect(e.message).not.toContain('forged');
  });
});
