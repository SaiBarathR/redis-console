import { describe, expect, it } from 'vitest';
import { binFromBytes, binFromString, binEquals, bytesFromBin, keyToParam, keyFromParam } from './bin.ts';

describe('BOM bytes (web R2 H3)', () => {
  it.each(['\ufeffkey', '\ufeff\ufeffvalue', 'plain', '\ufeff', '\u0000\ufeff'])('round trips %j', text => {
    const bytes = new TextEncoder().encode(text);
    const bin = binFromBytes(bytes);
    expect(bin).toEqual(binFromString(text));
    expect(bytesFromBin(bin)).toEqual(bytes);
    expect(keyFromParam(keyToParam(bin))).toEqual(bytes);
  });
  it('keeps BOM and plain names distinct', () => {
    expect(binEquals(binFromBytes(new TextEncoder().encode('\ufeffkey')), binFromString('key'))).toBe(false);
  });
});
