import { describe, expect, it } from 'vitest';
import { ErrorReply } from 'redis';
import { RespPush, RespReader } from '../../src/redis/resp.ts';
import { TM_REPLY } from '../../src/redis/reply.ts';
import { hashSlot, redirect, CommandBudget } from '../../src/redis/capped.ts';
const parse = (s: string | Buffer, chunk = 1) => {
  const r = new RespReader(1 << 20, TM_REPLY);
  const b = Buffer.from(s);
  for (let i = 0; i < b.length; i += chunk) r.feed(b.subarray(i, i + chunk));
  r.end(); return r.value;
};
describe('measured RESP2/3 reader', () => {
  it.each([
    ['+OK\r\n', Buffer.from('OK')], ['$3\r\na\x00b\r\n', Buffer.from('a\x00b')],
    ['$-1\r\n', null], ['*-1\r\n', null], ['_\r\n', null], ['#t\r\n', true], ['#f\r\n', false],
    [':9223372036854775807\r\n', '9223372036854775807'], ['(-3492890328409238509324850943850943825024385\r\n', -3492890328409238509324850943850943825024385n],
    [',1.25e2\r\n', 125], [',inf\r\n', Infinity], [',-inf\r\n', -Infinity], [',nan\r\n', NaN],
    ['=9\r\ntxt:hello\r\n', Buffer.from('hello')], ['*0\r\n', []], ['%0\r\n', new Map()], ['~0\r\n', new Set()],
    ['*?\r\n:1\r\n:2\r\n.\r\n', ['1','2']],
    ['%?\r\n$1\r\nx\r\n:1\r\n.\r\n',new Map([[Buffer.from('x'),'1']])],
    ['|1\r\n+meta\r\n:1\r\n:2\r\n','2'],
  ])('decodes %j at every chunk split', (wire, value) => {
    for (let n = 1; n <= Buffer.byteLength(wire as string); n++) expect(parse(wire as string, n)).toEqual(value);
  });
  it('keeps nested aggregates, binary map keys, sets and nested errors', () => {
    const v = parse(Buffer.from('*3\r\n%1\r\n$1\r\n\xff\r\n~2\r\n:1\r\n:2\r\n-ERR nested\r\n!8\r\nERR blob\r\n', 'latin1'));
    expect(v).toEqual([new Map([[Buffer.from([255]),new Set(['1','2'])]]),new ErrorReply('ERR nested'),new ErrorReply('ERR blob')]);
  });
  it('decodes push frames and attributes without consuming the next reply', () => {
    expect(parse('>2\r\n+message\r\n+x\r\n')).toBeInstanceOf(RespPush);
    const r=new RespReader(100);expect(r.feed(Buffer.from('+one\r\n+two\r\n'),true)).toBe(6);expect(r.value).toBe('one');
  });
  it('trips on the byte after the cap in the middle of a bulk payload, never allocating the announced oversize', () => {
    const r=new RespReader(32);r.feed(Buffer.from('$29\r\n'));r.feed(Buffer.alloc(20,120));
    expect(()=>r.feed(Buffer.alloc(9,120))).toThrow(expect.objectContaining({code:'too_large'}));
    expect(()=>new RespReader(1024).feed(Buffer.from('$999999999\r\n'))).toThrow(expect.objectContaining({code:'too_large'}));
  });
  it('accepts an exactly capped reply and enforces aggregate elements and depth before allocation', () => {
    const wire=Buffer.from('$3\r\nabc\r\n');const r=new RespReader(wire.length);r.feed(wire);expect(r.done).toBe(true);
    expect(()=>new RespReader(100,{},3).feed(Buffer.from('*1000000000\r\n'))).toThrow(expect.objectContaining({code:'too_large'}));
    expect(()=>new RespReader(100,{},100,2).feed(Buffer.from('*1\r\n*1\r\n*1\r\n'))).toThrow(expect.objectContaining({code:'too_large'}));
  });
  it.each(['?x\r\n', ':wat\r\n', ':9223372036854775808\r\n', '#yes\r\n', '_x\r\n', '$-2\r\n', '$x\r\n', '*-2\r\n', ',wat\r\n', '=3\r\nabc\r\n', '$1\r\naXX', '+a\n', '.\r\n', '%?\r\n:1\r\n.\r\n', '+a\r\n+b\r\n'])('rejects malformed %j', wire => {
    expect(()=>parse(wire)).toThrow(expect.objectContaining({code:'redis_error'}));
  });
  it('rejects incomplete replies at EOF and overlong numeric headers in linear work', () => {
    expect(()=>parse('$20\r\nabc')).toThrow();
    expect(()=>parse(':'+ '9'.repeat(513))).toThrow(expect.objectContaining({code:'too_large'}));
  });
});
describe('routing and admission', () => {
  it('matches Redis CRC16 hash tags',()=>{expect(hashSlot('123456789')).toBe(12739);expect(hashSlot('a{tag}b')).toBe(hashSlot('tag'));expect(hashSlot(Buffer.from('a{tag}b'))).toBe(hashSlot('tag'));});
  it('only accepts explicit MOVED/ASK errors including IPv6',()=>{expect(redirect(new ErrorReply('ASK 1 [::1]:6420'))).toEqual({kind:'ASK',slot:1,endpoint:{host:'::1',port:6420}});expect(redirect(new Error('MOVED 1 host:6420'))).toBeUndefined();expect(redirect(new ErrorReply('MOVED 1 host:99999'))).toBeUndefined();});
  it('refuses excess commands after a bounded wait and restores capacity',async()=>{const b=new CommandBudget(1);const release=b.take();expect(()=>b.take()).toThrow(expect.objectContaining({code:'rate_limited'}));await expect(b.acquire(Date.now()+20)).rejects.toMatchObject({code:'rate_limited'});release();expect(()=>b.take()).not.toThrow();});
});
