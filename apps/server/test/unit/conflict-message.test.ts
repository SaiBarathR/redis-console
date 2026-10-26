import { describe, expect, it } from 'vitest';
import { conflictOf, type CheckedPlan } from '../../src/redis/checked.ts';

const plan = (type: string): CheckedPlan => ({ key: Buffer.from('k'), probe: { kind: 'key' }, expect: { type }, command: ['DEL', 'k'] });

describe('conflict message', () => {
  it('names a well-formed opened type', () => {
    expect(conflictOf(plan('hash'), { type: 'string' }).message).toContain('(you opened a hash)');
  });
  it('never copies arbitrary client text into the message (it reaches the audit log)', () => {
    const e = conflictOf(plan('x\n{"forged":"audit line"} <script>'), { type: 'string' });
    expect(e.message).toContain('(you opened a different type)');
    expect(e.message).not.toContain('forged');
  });
});
