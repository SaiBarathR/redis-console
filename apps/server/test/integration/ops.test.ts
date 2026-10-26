import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, userSession, utf8, type TestApp } from '../helpers.ts';
import { confirmed } from './data-helpers.ts';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;
const OPS = '/api/v1/databases/e2e/ops';

describe.skipIf(!sandboxUp)('POST /ops (typed operations)', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('ops');
  const k = (s: string) => utf8(`${P}${s}`);
  const op = async (body: Record<string, unknown>, db = 'e2e', role: 'operator' | 'admin' = 'operator') => {
    const c = await userSession(t, role);
    return c.req('POST', `/api/v1/databases/${db}/ops`, body);
  };

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('string.set with ttl and nx', async () => {
    let res = await op({ op: 'string.set', key: k('s1'), value: utf8('v1'), ttl: 100 });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(await r.get(`${P}s1`)).toBe('v1');
    expect(await r.ttl(`${P}s1`)).toBeGreaterThan(90);
    res = await op({ op: 'string.set', key: k('s1'), value: utf8('v2'), nx: true });
    expect(res.status).toBe(200);
    expect(res.json.result).toEqual({ t: 'nil' });
    expect(await r.get(`${P}s1`)).toBe('v1');
  });

  it('key.expire / key.persist', async () => {
    await r.set(`${P}e`, 'x');
    expect((await op({ op: 'key.expire', key: k('e'), ttl: 500 })).status).toBe(200);
    expect(await r.ttl(`${P}e`)).toBeGreaterThan(400);
    expect((await op({ op: 'key.persist', key: k('e') })).status).toBe(200);
    expect(await r.ttl(`${P}e`)).toBe(-1);
  });

  it('key.delete needs confirmation, then deletes', async () => {
    await r.set(`${P}d1`, '1');
    await r.set(`${P}d2`, '2');
    const c = await userSession(t, 'operator');
    const { first, second } = await confirmed(c, OPS, { op: 'key.delete', keys: [k('d1'), k('d2')] });
    expect(first.json.error.confirmation.level).toBe('confirm');
    expect(first.json.error.confirmation.reasonRequired).toBe(false);
    expect(second.status).toBe(200);
    expect(second.json.result).toEqual({ t: 'int', v: '2' });
    expect(await r.exists([`${P}d1`, `${P}d2`])).toBe(0);
  });

  it('key.rename: nx without confirmation, overwrite with confirmation', async () => {
    await r.set(`${P}r1`, 'a');
    await r.set(`${P}r2`, 'b');
    let res = await op({ op: 'key.rename', key: k('r1'), newKey: k('r2') });
    expect(res.status).toBe(200);
    expect(res.json.result).toEqual({ t: 'int', v: '0' });
    const c = await userSession(t, 'operator');
    const { second } = await confirmed(c, OPS, { op: 'key.rename', key: k('r1'), newKey: k('r2'), nx: false });
    expect(second.status).toBe(200);
    expect(await r.get(`${P}r2`)).toBe('a');
    expect(await r.exists(`${P}r1`)).toBe(0);
  });

  it('hash.set / hash.delete', async () => {
    expect((await op({ op: 'hash.set', key: k('h'), entries: [{ field: utf8('a'), value: utf8('1') }, { field: utf8('b'), value: utf8('2') }] })).status).toBe(200);
    expect(await r.hGetAll(`${P}h`)).toEqual({ a: '1', b: '2' });
    const c = await userSession(t, 'operator');
    const { second } = await confirmed(c, OPS, { op: 'hash.delete', key: k('h'), fields: [utf8('a')] });
    expect(second.status).toBe(200);
    expect(await r.hGetAll(`${P}h`)).toEqual({ b: '2' });
  });

  it('list.push / list.set / list.remove', async () => {
    expect((await op({ op: 'list.push', key: k('l'), values: [utf8('a'), utf8('b')], end: 'tail' })).status).toBe(200);
    expect((await op({ op: 'list.push', key: k('l'), values: [utf8('z')], end: 'head' })).status).toBe(200);
    expect(await r.lRange(`${P}l`, 0, -1)).toEqual(['z', 'a', 'b']);
    expect((await op({ op: 'list.set', key: k('l'), index: 1, value: utf8('A') })).status).toBe(200);
    expect(await r.lRange(`${P}l`, 0, -1)).toEqual(['z', 'A', 'b']);
    const c = await userSession(t, 'operator');
    const { second } = await confirmed(c, OPS, { op: 'list.remove', key: k('l'), value: utf8('z'), count: 1 });
    expect(second.status).toBe(200);
    expect(await r.lRange(`${P}l`, 0, -1)).toEqual(['A', 'b']);
    // Redis errors surface as redis_error
    const bad = await op({ op: 'list.set', key: k('l'), index: 99, value: utf8('x') });
    expect(bad.status).toBe(502);
    expect(bad.json.error.code).toBe('redis_error');
  });

  it('set.add / set.remove', async () => {
    expect((await op({ op: 'set.add', key: k('set'), members: [utf8('a'), utf8('b')] })).status).toBe(200);
    const c = await userSession(t, 'operator');
    const { second } = await confirmed(c, OPS, { op: 'set.remove', key: k('set'), members: [utf8('a')] });
    expect(second.status).toBe(200);
    expect(await r.sMembers(`${P}set`)).toEqual(['b']);
  });

  it('zset.add / zset.remove (score validation)', async () => {
    expect((await op({ op: 'zset.add', key: k('z'), members: [{ member: utf8('a'), score: '1.5' }, { member: utf8('b'), score: '-inf' }] })).status).toBe(200);
    expect(await r.zScore(`${P}z`, 'a')).toBe(1.5);
    expect((await op({ op: 'zset.add', key: k('z'), members: [{ member: utf8('c'), score: 'NaN' }] })).status).toBe(400);
    const c = await userSession(t, 'operator');
    const { second } = await confirmed(c, OPS, { op: 'zset.remove', key: k('z'), members: [utf8('b')] });
    expect(second.status).toBe(200);
    expect(await r.zCard(`${P}z`)).toBe(1);
  });

  it('stream.add / delete / group create / ack / destroy', async () => {
    let res = await op({ op: 'stream.add', key: k('x'), id: '1-1', fields: [{ field: utf8('f'), value: utf8('v') }] });
    expect(res.status).toBe(200);
    res = await op({ op: 'stream.add', key: k('x'), fields: [{ field: utf8('f'), value: utf8('w') }] });
    expect(res.status).toBe(200);
    expect(res.json.result.t).toBe('str');
    expect(await r.xLen(`${P}x`)).toBe(2);
    expect((await op({ op: 'stream.group.create', key: k('x'), group: 'g', id: '0' })).status).toBe(200);
    await r.sendCommand(['XREADGROUP', 'GROUP', 'g', 'c1', 'COUNT', '1', 'STREAMS', `${P}x`, '>']);
    res = await op({ op: 'stream.ack', key: k('x'), group: 'g', ids: ['1-1'] });
    expect(res.json.result).toEqual({ t: 'int', v: '1' });
    const c = await userSession(t, 'operator');
    expect((await confirmed(c, OPS, { op: 'stream.delete', key: k('x'), ids: ['1-1'] })).second.status).toBe(200);
    expect(await r.xLen(`${P}x`)).toBe(1);
    expect((await confirmed(c, OPS, { op: 'stream.group.destroy', key: k('x'), group: 'g' })).second.status).toBe(200);
    expect(((await r.sendCommand(['XINFO', 'GROUPS', `${P}x`])) as unknown[]).length).toBe(0);
    expect((await op({ op: 'stream.group.create', key: k('newstream'), group: 'g', mkstream: true })).status).toBe(200);
    expect(await r.exists(`${P}newstream`)).toBe(1);
  });

  it('json.set / json.delete', async () => {
    expect((await op({ op: 'json.set', key: k('j'), json: '{"a":1,"b":2}' })).status).toBe(200);
    const c = await userSession(t, 'operator');
    expect((await confirmed(c, OPS, { op: 'json.delete', key: k('j'), path: '$.a' })).second.status).toBe(200);
    expect(JSON.parse(String(await r.sendCommand(['JSON.GET', `${P}j`])))).toEqual({ b: 2 });
    expect((await op({ op: 'json.set', key: k('j2'), json: '{not json' })).json.error.code).toBe('redis_error');
  });

  it('validation: unknown op and malformed body -> 400', async () => {
    expect((await op({ op: 'nope', key: k('a') })).status).toBe(400);
    expect((await op({ op: 'string.set', key: k('a') })).status).toBe(400);
    expect((await op({ op: 'key.delete', keys: [] })).status).toBe(400);
  });

  it('role and database gates: viewer 403, read-only 403, maxRole, viewer-only creds 503', async () => {
    const body = { op: 'string.set', key: k('gate'), value: utf8('x') };
    const v = await userSession(t, 'viewer');
    let res = await v.req('POST', OPS, body);
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('forbidden');
    res = await op(body, 'e2e-ro', 'admin');
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('read_only');
    expect((await op(body, 'e2e-maxop', 'admin')).status).toBe(200);
    res = await op(body, 'e2e-viewer-only', 'operator');
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe('unavailable');
    expect(await r.exists(`${P}gate`)).toBe(1);
  });

  it('prod: typed database name + reason, single-use tokens bound to body and session', async () => {
    const url = '/api/v1/databases/e2e-prod/ops';
    const body = { op: 'string.set', key: k('prod'), value: utf8('prodvalue') };
    const c = await userSession(t, 'operator');
    let res = await c.req('POST', url, body);
    expect(res.status).toBe(428);
    const ch = res.json.error.confirmation;
    expect(ch).toMatchObject({ level: 'typed', expectedText: 'E2E prod', reasonRequired: true });
    expect(ch.token.length).toBeGreaterThanOrEqual(16);

    // wrong typed text -> new challenge, token consumed
    res = await c.req('POST', url, { ...body, confirmation: { token: ch.token, typed: 'E2E', reason: 'because' } });
    expect(res.status).toBe(428);
    expect(res.json.error.message).toMatch(/typed/i);
    res = await c.req('POST', url, { ...body, confirmation: { token: ch.token, typed: 'E2E prod', reason: 'because' } });
    expect(res.status).toBe(428); // single use

    // missing reason
    let tok = res.json.error.confirmation.token;
    res = await c.req('POST', url, { ...body, confirmation: { token: tok, typed: 'E2E prod' } });
    expect(res.status).toBe(428);
    expect(res.json.error.message).toMatch(/reason/i);

    // token bound to the exact body
    tok = res.json.error.confirmation.token;
    res = await c.req('POST', url, { ...body, value: utf8('other'), confirmation: { token: tok, typed: 'E2E prod', reason: 'because' } });
    expect(res.status).toBe(428);
    expect(res.json.error.message).toMatch(/does not match/);

    // token bound to the session
    tok = (await c.req('POST', url, body)).json.error.confirmation.token;
    const other = await userSession(t, 'operator');
    res = await other.req('POST', url, { ...body, confirmation: { token: tok, typed: 'E2E prod', reason: 'because' } });
    expect(res.status).toBe(428);
    expect(await r.exists(`${P}prod`)).toBe(0);

    // correct
    tok = (await c.req('POST', url, body)).json.error.confirmation.token;
    res = await c.req('POST', url, { ...body, confirmation: { token: tok, typed: 'E2E prod', reason: 'ticket OPS-1234' } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await r.get(`${P}prod`)).toBe('prodvalue');

    const ev = t.ctx.audit.query({ limit: 50, action: 'string.set', database: 'e2e-prod' }).events;
    expect(ev.find((e) => e.outcome === 'allowed')?.reason).toBe('ticket OPS-1234');
    expect(ev.some((e) => e.outcome === 'confirmation_required')).toBe(true);
    // audit never contains the value
    expect(t.auditLines.join('\n')).not.toContain('prodvalue');
    expect(JSON.stringify(ev)).not.toContain(`${P}prod`);
  });
});

describe.skipIf(!sandboxUp)('POST /bulk-delete', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('bulk');

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    for (let i = 0; i < 30; i++) await r.set(`${P}del:${i}`, 'x');
    await r.set(`${P}keep:1`, 'x');
    await r.hSet(`${P}del:hash`, 'f', 'v');
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('428 with impact, typed name required, deletes exactly the matching keys', async () => {
    const c = await userSession(t, 'operator');
    const url = '/api/v1/databases/e2e/bulk-delete';
    const body = { match: `${P}del:*`, type: 'string' };
    const res = await c.req('POST', url, body);
    expect(res.status).toBe(428);
    const ch = res.json.error.confirmation;
    expect(ch.level).toBe('typed');
    expect(ch.expectedText).toBe('E2E');
    expect(ch.impact.keys).toBe(30);
    expect(ch.impact.sample.length).toBe(20);
    expect(ch.impact.sample[0].data.startsWith(`${P}del:`)).toBe(true);

    const wrong = await c.req('POST', url, { ...body, confirmation: { token: ch.token, typed: 'nope' } });
    expect(wrong.status).toBe(428);
    expect(await r.exists(`${P}del:0`)).toBe(1);

    const ok = await c.req('POST', url, { ...body, confirmation: { token: wrong.json.error.confirmation.token, typed: 'E2E' } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.deleted).toBe(30);
    expect(await r.exists(`${P}keep:1`)).toBe(1);
    expect(await r.exists(`${P}del:hash`)).toBe(1); // type filter respected
    expect(await r.exists(`${P}del:5`)).toBe(0);
    const ev = t.ctx.audit.query({ limit: 10, action: 'key.bulk-delete', outcome: 'allowed' }).events;
    expect(ev[0]?.keyCount).toBe(30);
  });

  it('pure wildcard by operator, viewer and read-only database are refused', async () => {
    const op = await userSession(t, 'operator');
    let res = await op.req('POST', '/api/v1/databases/e2e/bulk-delete', { match: '*' });
    expect(res.status).toBe(403);
    res = await op.req('POST', '/api/v1/databases/e2e/bulk-delete', { match: '**?' });
    expect(res.status).toBe(403);
    // Self-review finding 3: bracket classes match any name too ([^] is "any one character" in Redis).
    // (one request: bulk delete allows a burst of 3; the other shapes are unit-tested in misc.test.ts)
    res = await op.req('POST', '/api/v1/databases/e2e/bulk-delete', { match: '[^]*' });
    expect(res.status).toBe(403);
    const adm = await userSession(t, 'admin');
    res = await adm.req('POST', '/api/v1/databases/e2e-prod/bulk-delete', { match: '*' });
    expect(res.status).toBe(403);
    const v = await userSession(t, 'viewer');
    res = await v.req('POST', '/api/v1/databases/e2e/bulk-delete', { match: `${P}*` });
    expect(res.status).toBe(403);
    res = await adm.req('POST', '/api/v1/databases/e2e-ro/bulk-delete', { match: `${P}*` });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('read_only');
    expect((await adm.req('POST', '/api/v1/databases/e2e/bulk-delete', { match: `${P}*`, extra: 1 })).status).toBe(400);
  });
});
