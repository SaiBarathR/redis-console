import { describe, expect, it } from 'vitest';
import { parseJson, stringifyJson } from './json.ts';
describe('lossless JSON', () => {
  it.each(['9007199254740993', '123456789012345678901234567890', '1.0', '1.5e3', '-0', '1e+999', '0.000000000000000000001'])('preserves %s', text => {
    expect(stringifyJson(parseJson(text))).toBe(text);
  });
  it.each(['', '01', '-01', '+1', '1.', '.1', '1e', 'NaN', 'undefined', '[1,]', '{"a":1,}', '"\n"', '"\\q"', 'true false', '{a:1}', '['])('rejects invalid JSON %j', text => {
    expect(() => parseJson(text)).toThrow();
  });
  it('handles escaped names and strings as inert data', () => {
    const text = '{"__proto__":{"constructor":1},"a\\\"b":"\\uFEFF\\r\\n\\t\\b\\f\\\\\\/","duplicate":1,"duplicate":2}';
    expect(JSON.parse(stringifyJson(parseJson(text)))).toEqual(JSON.parse(text));
    expect(Object.getPrototypeOf(parseJson(text))).toBeNull();
  });
  it('caps recursion', () => { expect(() => parseJson('['.repeat(130) + '0' + ']'.repeat(130))).toThrow(/nesting/); });
});
