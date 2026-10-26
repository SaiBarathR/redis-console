import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, userSession, type TestApp } from '../helpers.ts';
import { cli, confirmed, str } from './data-helpers.ts';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;
const CLI = '/api/v1/databases/e2e/cli';

describe.skipIf(!sandboxUp)('POST /cli', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('cli');

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('accepts exactly one of line / argv / argvBin', async () => {
    const c = await userSession(t, 'viewer');
    expect((await c.req('POST', CLI, {})).status).toBe(400);
    expect((await c.req('POST', CLI, { line: 'PING', argv: ['PING'] })).status).toBe(400);
    expect((await c.req('POST', CLI, { line: 'PING', unknown: 1 })).status).toBe(400);
    expect((await c.req('POST', CLI, { line: '' })).status).toBe(400);
    expect((await c.req('POST', CLI, { line: 'GET "unterminated' })).status).toBe(400);
    let res = await c.req('POST', CLI, { argv: ['PING', 'hi'] });
    expect(res.status).toBe(200);
    expect(str(res.json.reply)).toBe('hi');
    res = await c.req('POST', CLI, { argvBin: [{ enc: 'utf8', data: 'ECHO' }, { enc: 'base64', data: Buffer.from('yo').toString('base64') }] });
    expect(str(res.json.reply)).toBe('yo');
    expect(res.json).toMatchObject({ argv: ['ECHO', 'yo'], commandClass: 'read' });
    expect(typeof res.json.durationMs).toBe('number');
  });

  it('returns typed reply trees', async () => {
    const c = await userSession(t, 'operator');
    let res = await cli(c, 'e2e', `SET ${P}s hello`);
    expect(res.json.reply).toEqual({ t: 'str', v: { enc: 'utf8', data: 'OK' } });
    expect(res.json.commandClass).toBe('write');
    res = await cli(c, 'e2e', `GET ${P}s`);
    expect(str(res.json.reply)).toBe('hello');
    res = await cli(c, 'e2e', `GET ${P}missing`);
    expect(res.json.reply).toEqual({ t: 'nil' });
    res = await cli(c, 'e2e', `INCRBY ${P}n 9007199254740993`);
    expect(res.json.reply).toEqual({ t: 'int', v: '9007199254740993' });
    await cli(c, 'e2e', `HSET ${P}h a 1 b 2`);
    res = await cli(c, 'e2e', `HGETALL ${P}h`);
    expect(res.json.reply.t).toBe('map');
    expect(res.json.reply.v.map(([k, v]: any) => [k.v.data, v.v.data]).sort()).toEqual([['a', '1'], ['b', '2']]);
    await cli(c, 'e2e', `SADD ${P}set x y`);
    res = await cli(c, 'e2e', `SMEMBERS ${P}set`);
    expect(res.json.reply.t).toBe('set');
    expect(res.json.reply.v.map((x: any) => x.v.data).sort()).toEqual(['x', 'y']);
    await cli(c, 'e2e', `ZADD ${P}z 1.5 m`);
    res = await cli(c, 'e2e', `ZSCORE ${P}z m`);
    expect(res.json.reply).toEqual({ t: 'dbl', v: '1.5' });
    res = await cli(c, 'e2e', `LPUSH ${P}s x`);
    expect(res.status).toBe(200);
    expect(res.json.reply.t).toBe('err');
    expect(res.json.reply.v).toMatch(/^WRONGTYPE/);
    res = await cli(c, 'e2e', `EXISTS ${P}s ${P}missing`);
    expect(res.json.reply).toEqual({ t: 'int', v: '1' });
    res = await cli(c, 'e2e', 'COMMAND INFO get');
    expect(res.json.reply.t).toBe('arr');
  });

  it('blocks dangerous and connection-state commands with a hint', async () => {
    const lines = [
      'EVAL "return 1" 0', 'EVALSHA abc 0', 'eVaL "return 1" 0', 'FCALL f 0', 'FUNCTION LOAD x', 'SCRIPT LOAD x', 'KEYS *',
      'CONFIG SET maxmemory 1', 'CONFIG REWRITE', 'FLUSHALL', 'MODULE LOAD /tmp/x.so', 'MULTI', 'EXEC', 'WATCH k', 'SELECT 1',
      'AUTH user pass', 'HELLO 3', 'DEBUG SLEEP 0', 'SHUTDOWN', 'REPLICAOF localhost 1', 'MIGRATE h 1 k 0 1', 'RESTORE k 0 x',
      'SAVE', 'BGSAVE', 'MONITOR', 'SUBSCRIBE ch', 'CLIENT SETNAME x', 'CLIENT NO-EVICT on', 'WAIT 1 0', 'FOOBAR', 'ACL SETUSER x',
      'CLIENT', 'SWAPDB 0 1', 'OBJECT HELP',
    ];
    for (let i = 0; i < lines.length; i++) {
      const c = await userSession(t, 'admin'); // fresh user each time: CLI is rate limited per user
      const res = await cli(c, 'e2e', lines[i]!);
      expect(res.status, `${lines[i]} -> ${JSON.stringify(res.json)}`).toBe(403);
      expect(res.json.error.code, lines[i]).toBe('command_blocked');
      expect(typeof (res.json.error.hint ?? res.json.error.message)).toBe('string');
    }
    const denied = t.ctx.audit.query({ limit: 500, action: 'cli.exec', outcome: 'denied' }).events;
    expect(denied.length).toBeGreaterThanOrEqual(lines.length);
    expect(denied.find((e) => e.command === 'EVAL')?.argvRedacted).toEqual(['EVAL', '<8 bytes>', '<1 bytes>']);
  });

  it('caps blocking timeouts: BLPOP 0 returns nil after ~5 s', async () => {
    const c = await userSession(t, 'operator');
    const start = Date.now();
    const res = await cli(c, 'e2e', `BLPOP ${P}emptylist 0`);
    const took = Date.now() - start;
    expect(res.status).toBe(200);
    expect(res.json.reply).toEqual({ t: 'nil' });
    expect(res.json.argv).toEqual(['BLPOP', `${P}emptylist`, '5']);
    expect(took).toBeGreaterThanOrEqual(4500);
    expect(took).toBeLessThan(9000);
  }, 20_000);

  it('caps XREAD BLOCK and SCAN COUNT', async () => {
    const c = await userSession(t, 'viewer');
    let res = await cli(c, 'e2e', `XREAD BLOCK 999999 STREAMS ${P}nostream $`);
    expect(res.json.argv).toEqual(['XREAD', 'BLOCK', '5000', 'STREAMS', `${P}nostream`, '$']);
    res = await cli(c, 'e2e', `SCAN 0 MATCH ${P}* COUNT 100000`);
    expect(res.status).toBe(200);
    expect(res.json.argv[5]).toBe('1000');
    expect((await cli(c, 'e2e', `BLPOP ${P}x 1`)).status).toBe(403); // write command for a viewer
    const op = await userSession(t, 'operator');
    res = await cli(op, 'e2e', `BLPOP ${P}x -1`);
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('validation');
  }, 20_000);

  it('DEL needs confirmation, then succeeds', async () => {
    await r.set(`${P}del`, 'x');
    const c = await userSession(t, 'operator');
    const { first, second } = await confirmed(c, CLI, { line: `DEL ${P}del` });
    expect(first.json.error.confirmation.summary).toContain('DEL');
    expect(second.status).toBe(200);
    expect(second.json.reply).toEqual({ t: 'int', v: '1' });
    expect(await r.exists(`${P}del`)).toBe(0);
  });

  it('truncates large replies (bytes and elements)', async () => {
    await r.set(`${P}big`, 'z'.repeat(2 * 1024 * 1024));
    const items = Array.from({ length: 12_000 }, (_, i) => `i${i}`);
    for (let i = 0; i < items.length; i += 1000) await r.rPush(`${P}biglist`, items.slice(i, i + 1000));
    const c = await userSession(t, 'viewer');
    let res = await cli(c, 'e2e', `GET ${P}big`);
    expect(res.json.reply).toEqual({ t: 'truncated', bytes: 2 * 1024 * 1024 });
    res = await cli(c, 'e2e', `LRANGE ${P}biglist 0 -1`);
    expect(res.json.reply.t).toBe('arr');
    expect(res.json.reply.v.length).toBe(10_000);
    expect(res.json.reply.more).toBe(2000);
  });

  it('FLUSHDB: typed confirmation on non-prod (never completed here); blocked on prod', async () => {
    const adm = await userSession(t, 'admin');
    let res = await cli(adm, 'e2e', 'FLUSHDB');
    expect(res.status).toBe(428);
    expect(res.json.error.confirmation).toMatchObject({ level: 'typed', expectedText: 'E2E', reasonRequired: false });
    // wrong typed text keeps it unconfirmed
    res = await adm.req('POST', CLI, { line: 'FLUSHDB', confirmation: { token: res.json.error.confirmation.token, typed: 'e2e' } });
    expect(res.status).toBe(428);
    res = await cli(adm, 'e2e-prod', 'FLUSHDB');
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('command_blocked');
    const op = await userSession(t, 'operator');
    res = await cli(op, 'e2e', 'FLUSHDB');
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('forbidden');
  });

  it('prod writes via CLI need typed name + reason; reads do not', async () => {
    const c = await userSession(t, 'operator');
    expect((await cli(c, 'e2e-prod', `GET ${P}x`)).status).toBe(200);
    const { first, second } = await confirmed(c, '/api/v1/databases/e2e-prod/cli', { line: `SET ${P}prodcli secretmarker123` }, { reason: 'deploy fix' });
    expect(first.json.error.confirmation).toMatchObject({ level: 'typed', expectedText: 'E2E prod', reasonRequired: true });
    expect(second.status).toBe(200);
    const ev = t.ctx.audit.query({ limit: 20, action: 'cli.exec', database: 'e2e-prod', outcome: 'allowed' }).events;
    expect(ev[0]).toMatchObject({ command: 'SET', reason: 'deploy fix', keyCount: 1 });
    expect(ev[0]!.argvRedacted![1]).toMatch(/^key#[0-9a-f]{12}$/);
    expect(ev[0]!.argvRedacted![2]).toBe('<15 bytes>');
    expect(t.auditLines.join('\n')).not.toContain('secretmarker123');
    expect(t.auditLines.join('\n')).not.toContain(`${P}prodcli`);
  });

  it('rate limits the CLI per user', async () => {
    const c = await userSession(t, 'viewer');
    const statuses = await Promise.all(Array.from({ length: 30 }, () => cli(c, 'e2e', 'PING').then((x) => x.status)));
    expect(statuses).toContain(429);
  });
});
