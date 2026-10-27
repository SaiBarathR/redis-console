import { describe, expect, it } from 'vitest';
import { applyCaps, authorize, classify, isMutating } from '../../src/policy/policy.ts';
import { testConfig } from '../helpers.ts';

describe('graph command execution bounds and roles', () => {
  it('always appends a timeout, caps zero/large values and refuses ambiguous options', () => {
    for (const cmd of ['GRAPH.QUERY', 'GRAPH.RO_QUERY', 'GRAPH.EXPLAIN', 'GRAPH.PROFILE']) {
      expect(applyCaps([cmd, 'g', 'RETURN 1'])).toEqual([cmd, 'g', 'RETURN 1', 'TIMEOUT', '1000']);
      for (const n of ['0', '999999']) expect(applyCaps([cmd, 'g', 'RETURN 1', 'TIMEOUT', n]).at(-1)).toBe('1000');
      expect(applyCaps([cmd, 'g', 'RETURN 1', '--compact', 'timeout', '12'])).toEqual([cmd, 'g', 'RETURN 1', '--compact', 'TIMEOUT', '12']);
      for (const opts of [['TIMEOUT'], ['TIMEOUT', '-1'], ['TIMEOUT', '1.5'], ['TIMEOUT', '1', 'TIMEOUT', '0'], ['--timeout', '0'], ['garbage']]) expect(() => applyCaps([cmd, 'g', 'RETURN 1', ...opts])).toThrow();
    }
  });
  it('caps graph memory sampling, including zero/all and the default', () => {
    for (const n of ['0', '99999']) expect(applyCaps(['GRAPH.MEMORY', 'USAGE', 'g', 'SAMPLES', n])).toEqual(['GRAPH.MEMORY', 'USAGE', 'g', 'SAMPLES', '100']);
    expect(applyCaps(['GRAPH.MEMORY', 'USAGE', 'g'])).toEqual(['GRAPH.MEMORY', 'USAGE', 'g', 'SAMPLES', '100']);
    expect(() => applyCaps(['GRAPH.MEMORY', 'USAGE', 'g', 'SAMPLES', '-1'])).toThrow();
  });
  it('enforces roles/readOnly even without COMMAND metadata, and treats admin introspection as reads', () => {
    const db = testConfig().databases[0]!;
    for (const role of ['viewer', 'operator', 'admin'] as const) {
      for (const argv of [['GRAPH.RO_QUERY', 'g', 'RETURN 1'], ['GRAPH.EXPLAIN', 'g', 'RETURN 1'], ['GRAPH.INFO', 'ObjectPool']]) expect(() => authorize(classify(argv, undefined), { role, db: { ...db, readOnly: true } })).not.toThrow();
      const c = classify(['GRAPH.QUERY', 'g', 'RETURN 1'], undefined);
      if (role === 'viewer') expect(() => authorize(c, { role, db })).toThrow(/operator/);
      else expect(() => authorize(c, { role, db })).not.toThrow();
      expect(() => authorize(c, { role, db: { ...db, readOnly: true } })).toThrow();
      const del = classify(['GRAPH.DELETE', 'g'], undefined);
      if (role !== 'admin') expect(() => authorize(del, { role, db })).toThrow(/admin/);
    }
    for (const argv of [['GRAPH.CONFIG', 'GET', '*'], ['GRAPH.SLOWLOG', 'g']]) {
      const c = classify(argv, undefined);
      expect(isMutating(c)).toBe(false);
      expect(() => authorize(c, { role: 'admin', db: { ...db, readOnly: true } })).not.toThrow();
    }
    const binary = ['GRAPH.RO_QUERY', 'g', 'LOAD/*x*/CSV FROM "file://x" AS r RETURN r'].map((s) => Buffer.from(s));
    expect(classify(binary, undefined).class).toBe('blocked');
  });
});
