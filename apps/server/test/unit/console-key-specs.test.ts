import { describe, expect, it } from 'vitest';
import { parseKeySpecs } from '../../src/policy/commandTable.ts';
const spec = (flags: string[] = ['RO'], extra: unknown = 1) => ['flags', flags, 'begin_search', ['type', 'index', 'spec', ['index', 1]], 'find_keys', ['type', 'range', 'spec', ['lastkey', -1, 'keystep', extra, 'limit', 2]]];
describe('command documentation key extraction metadata', () => {
  it('exposes supported finite key specifications', () => {
    expect(parseKeySpecs([spec()])).toEqual([{ begin: { type: 'index', index: 1 }, find: { type: 'range', lastkey: -1, keystep: 1, limit: 2 } }]);
  });
  it('omits incomplete, malformed and non-key specifications', () => {
    expect(parseKeySpecs([spec(['incomplete'])])).toBeUndefined();
    expect(parseKeySpecs([spec(['not_key'])])).toEqual([]);
    expect(parseKeySpecs([spec(['RO'], 0)])).toBeUndefined();
    expect(parseKeySpecs([spec(['RO'], Number.POSITIVE_INFINITY)])).toBeUndefined();
    expect(parseKeySpecs([['begin_search', ['type', 'unknown']]])).toBeUndefined();
  });
});
