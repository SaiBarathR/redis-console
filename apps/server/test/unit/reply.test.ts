import { describe, expect, it } from 'vitest';
import { asNum, asStr, formatDouble, kv, parseInfo, toReply } from '../../src/redis/reply.ts';

const L = { maxBytes: 1024 * 1024, maxElements: 10_000 };

describe('toReply', () => {
  it('encodes buffers as utf8 Bin when valid, base64 otherwise', () => {
    expect(toReply(Buffer.from('héllo'), L)).toEqual({ t: 'str', v: { enc: 'utf8', data: 'héllo' } });
    expect(toReply(Buffer.from([0xff, 0x00, 0x41]), L)).toEqual({ t: 'str', v: { enc: 'base64', data: Buffer.from([0xff, 0x00, 0x41]).toString('base64') } });
    expect(toReply(Buffer.alloc(0), L)).toEqual({ t: 'str', v: { enc: 'utf8', data: '' } });
  });

  it('integers stay exact (decimal strings and bigints)', () => {
    expect(toReply('9223372036854775807', L)).toEqual({ t: 'int', v: '9223372036854775807' });
    expect(toReply(-5n, L)).toEqual({ t: 'int', v: '-5' });
    expect(toReply(123456789012345678901234567890n, L)).toEqual({ t: 'int', v: '123456789012345678901234567890' });
  });

  it('doubles incl. inf/-inf/nan', () => {
    expect(toReply(1.5, L)).toEqual({ t: 'dbl', v: '1.5' });
    expect(toReply(Infinity, L)).toEqual({ t: 'dbl', v: 'inf' });
    expect(toReply(-Infinity, L)).toEqual({ t: 'dbl', v: '-inf' });
    expect(toReply(NaN, L)).toEqual({ t: 'dbl', v: 'nan' });
    expect(formatDouble(0.1 + 0.2)).toBe('0.30000000000000004');
  });

  it('bool and nil', () => {
    expect(toReply(true, L)).toEqual({ t: 'bool', v: true });
    expect(toReply(false, L)).toEqual({ t: 'bool', v: false });
    expect(toReply(null, L)).toEqual({ t: 'nil' });
    expect(toReply(undefined, L)).toEqual({ t: 'nil' });
  });

  it('errors (top-level and nested)', () => {
    expect(toReply(new Error('ERR wrong type'), L)).toEqual({ t: 'err', v: 'ERR wrong type' });
    expect(toReply([Buffer.from('a'), new Error('ERR x')], L)).toEqual({ t: 'arr', v: [{ t: 'str', v: { enc: 'utf8', data: 'a' } }, { t: 'err', v: 'ERR x' }] });
  });

  it('arrays, sets and maps', () => {
    expect(toReply([Buffer.from('a'), '1', [null]], L)).toEqual({
      t: 'arr',
      v: [{ t: 'str', v: { enc: 'utf8', data: 'a' } }, { t: 'int', v: '1' }, { t: 'arr', v: [{ t: 'nil' }] }],
    });
    expect(toReply(new Set([Buffer.from('x')]), L)).toEqual({ t: 'set', v: [{ t: 'str', v: { enc: 'utf8', data: 'x' } }] });
    const m = new Map<unknown, unknown>([['field', Buffer.from('v')], ['n', '2']]);
    expect(toReply(m, L)).toEqual({
      t: 'map',
      v: [
        [{ t: 'str', v: { enc: 'utf8', data: 'field' } }, { t: 'str', v: { enc: 'utf8', data: 'v' } }],
        [{ t: 'str', v: { enc: 'utf8', data: 'n' } }, { t: 'int', v: '2' }],
      ],
    });
  });

  it('pairs mode re-pairs flat maps and keeps binary keys', () => {
    const k = Buffer.from([0xff, 0xfe, 0x00]);
    const r = toReply([k, Buffer.from('v1'), Buffer.from('f2'), [Buffer.from('nested')]], L, { pairs: true });
    expect(r).toEqual({
      t: 'map',
      v: [
        [{ t: 'str', v: { enc: 'base64', data: k.toString('base64') } }, { t: 'str', v: { enc: 'utf8', data: 'v1' } }],
        [{ t: 'str', v: { enc: 'utf8', data: 'f2' } }, { t: 'arr', v: [{ t: 'str', v: { enc: 'utf8', data: 'nested' } }] }],
      ],
    });
    // Nested arrays inside a pairs map are NOT re-paired.
    const nested = toReply([Buffer.from('s'), [Buffer.from('a'), Buffer.from('b')]], L, { pairs: true });
    expect(nested.t === 'map' && nested.v[0]![1].t).toBe('arr');
  });

  it('truncates oversized strings', () => {
    const r = toReply(Buffer.alloc(2000, 0x61), { maxBytes: 1000, maxElements: 10 });
    expect(r).toEqual({ t: 'truncated', bytes: 2000 });
  });

  it('stops arrays once the byte budget is used up', () => {
    const items = Array.from({ length: 10 }, () => Buffer.alloc(300, 0x61));
    const r = toReply(items, { maxBytes: 1000, maxElements: 100 });
    expect(r.t).toBe('arr');
    if (r.t !== 'arr') return;
    expect(r.v.slice(0, 3).every((x) => x.t === 'str')).toBe(true);
    expect(r.v[3]).toEqual({ t: 'truncated', bytes: 300 });
    expect(r.v.length + (r.more ?? 0)).toBe(10);
    expect(r.more).toBeGreaterThan(0);
  });

  it('caps element counts with `more`', () => {
    const items = Array.from({ length: 50 }, (_, i) => String(i));
    const r = toReply(items, { maxBytes: 1e6, maxElements: 20 });
    expect(r).toMatchObject({ t: 'arr', more: 30 });
    if (r.t === 'arr') expect(r.v).toHaveLength(20);
    const s = toReply(new Set(items), { maxBytes: 1e6, maxElements: 5 });
    expect(s).toMatchObject({ t: 'set', more: 45 });
    const m = toReply(new Map(items.map((x) => [x, x])), { maxBytes: 1e6, maxElements: 5 });
    expect(m).toMatchObject({ t: 'map', more: 45 });
    const p = toReply(items, { maxBytes: 1e6, maxElements: 5 }, { pairs: true });
    expect(p).toMatchObject({ t: 'map', more: 20 });
  });

  it('element budget is shared across nesting levels', () => {
    const nested = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => '1'));
    const r = toReply(nested, { maxBytes: 1e6, maxElements: 25 });
    const count = (x: any): number => (x.t === 'arr' ? x.v.length + x.v.reduce((a: number, y: any) => a + count(y), 0) : 0);
    expect(count(r)).toBeLessThanOrEqual(25);
  });

  it('caps nesting depth', () => {
    let deep: unknown = Buffer.from('x');
    for (let i = 0; i < 50; i++) deep = [deep];
    const json = JSON.stringify(toReply(deep, L));
    expect(json).toContain('"truncated"');
    expect(json).not.toContain('"x"');
  });

  it('never passes through arbitrary objects', () => {
    expect(toReply({ password: 'x' }, L)).toEqual({ t: 'status', v: '<unsupported reply type object>' });
  });
});

describe('parseInfo', () => {
  it('parses sections and suffixes repeated keys', () => {
    const text = '# Server\r\nredis_version:8.10.2\r\nredis_mode:standalone\r\n\r\n# Modules\r\nmodule:name=search,ver=1\r\nmodule:name=ReJSON,ver=2\r\nmodule:name=bf,ver=3\r\n# Keyspace\r\ndb0:keys=3,expires=1,avg_ttl=0\r\n';
    const info = parseInfo(text);
    expect(info.server).toEqual({ redis_version: '8.10.2', redis_mode: 'standalone' });
    expect(info.modules).toEqual({ module: 'name=search,ver=1', 'module#2': 'name=ReJSON,ver=2', 'module#3': 'name=bf,ver=3' });
    expect(info.keyspace!.db0).toBe('keys=3,expires=1,avg_ttl=0');
  });
  it('values may contain colons', () => {
    expect(parseInfo('# X\nexecutable:/a:b\n').x!.executable).toBe('/a:b');
  });
});

describe('kv / asStr / asNum', () => {
  it('kv handles flat arrays, Maps and objects', () => {
    expect(kv([Buffer.from('a'), 1, 'b', Buffer.from('2')])).toEqual({ a: 1, b: Buffer.from('2') });
    expect(kv(new Map([['x', 1]]))).toEqual({ x: 1 });
    expect(kv({ y: 2 })).toEqual({ y: 2 });
    expect(kv(null)).toEqual({});
    expect(kv([Buffer.from('odd')])).toEqual({});
  });
  it('asStr / asNum', () => {
    expect(asStr(Buffer.from('é'))).toBe('é');
    expect(asStr(null)).toBe('');
    expect(asNum('12')).toBe(12);
    expect(asNum(Buffer.from('3.5'))).toBe(3.5);
    expect(asNum('nope')).toBe(0);
  });
});
