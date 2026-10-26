/**
 * Compare-and-set edits (web review v0.2 r3): ops that replace existing data carry `expect`, and the server writes
 * only when Redis still holds what the client last read (WATCH + read + MULTI/EXEC on its own socket). Real Redis
 * on the 6411 sandbox; the race between the read and EXEC is injected by writing from a second connection when
 * the server sends MULTI.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient, RESP_TYPES } from 'redis';
import { resolveConfig } from '../../src/config.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkedWrite, type CheckedPlan } from '../../src/redis/checked.ts';
import type { Conn } from '../../src/redis/manager.ts';
import { HttpError } from '../../src/http/errors.ts';
import { b64, cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, testConfigRaw, userSession, utf8, type Client, type TestApp } from '../helpers.ts';
import { confirmed } from './data-helpers.ts';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const OPS = '/api/v1/databases/e2e/ops';
type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;

describe.skipIf(!sandboxUp)('compare-and-set edits (web review v0.2 r3)', () => {
  let t: TestApp;
  let r: Admin;
  let op: Client;
  const P = keyPrefix('cas');
  const k = (s: string) => `${P}${s}`;
  const post = (body: Record<string, unknown>) => op.req('POST', OPS, body);

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    op = await userSession(t, 'operator');
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('same value: every checked op writes when Redis holds what the client read', async () => {
    await r.set(k('s'), 'before', { EX: 3600 });
    let res = await post({ op: 'string.set', key: utf8(k('s')), value: utf8('after'), keepTtl: true, expect: { type: 'string', sha256: sha('before') } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await r.get(k('s'))).toBe('after');
    expect(await r.ttl(k('s'))).toBeGreaterThan(3500);

    await r.hSet(k('h'), { f: 'v1', other: 'keep' });
    res = await post({ op: 'hash.set', key: utf8(k('h')), entries: [{ field: utf8('f'), value: utf8('v2') }], expect: { type: 'hash', sha256: sha('v1') } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    // A field that did not exist: sha256 null.
    res = await post({ op: 'hash.set', key: utf8(k('h')), entries: [{ field: utf8('new'), value: utf8('n') }], expect: { type: 'hash', sha256: null } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await r.hGetAll(k('h'))).toEqual({ f: 'v2', other: 'keep', new: 'n' });

    await r.rPush(k('l'), ['A', 'B', 'C']);
    res = await post({ op: 'list.set', key: utf8(k('l')), index: 1, value: utf8('B2'), expect: { type: 'list', sha256: sha('B') } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await r.lRange(k('l'), 0, -1)).toEqual(['A', 'B2', 'C']);

    await r.zAdd(k('z'), [{ score: 1.5, value: 'm' }]);
    res = await post({ op: 'zset.add', key: utf8(k('z')), members: [{ member: utf8('m'), score: '7' }], expect: { type: 'zset', sha256: sha('1.5') } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await r.zScore(k('z'), 'm')).toBe(7);

    await r.sendCommand(['JSON.SET', k('j'), '$', '{"items":[{"id":"A"},{"id":"B"}]}']);
    const doc = String(await r.sendCommand(['JSON.GET', k('j')]));
    res = await post({ op: 'json.set', key: utf8(k('j')), path: '$["items"][1]', json: '{"id":"B","v":99}', expect: { type: 'ReJSON-RL', sha256: sha(doc) } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(String(await r.sendCommand(['JSON.GET', k('j')]))).toBe('{"items":[{"id":"A"},{"id":"B","v":99}]}');

    // Binary bytes compare exactly.
    const bin = Buffer.from([0xff, 0x00, 0x0d, 0x0a]);
    await r.set(k('bin'), bin);
    res = await post({ op: 'string.set', key: utf8(k('bin')), value: b64(Buffer.from([1, 2])), expect: { type: 'string', sha256: sha(bin) } });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
  });

  it('concurrent change: 409 with the current value, nothing written; the returned expectation overwrites', async () => {
    await r.hSet(k('hc'), { f: 'REVG-opened' });
    await r.hSet(k('hc'), { f: Buffer.from([0xff, 0x00, 0x0d]) });
    const body = { op: 'hash.set', key: utf8(k('hc')), entries: [{ field: utf8('f'), value: utf8('mine') }], expect: { type: 'hash', sha256: sha('REVG-opened') } };
    const res = await post(body);
    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(res.json.error.code).toBe('conflict');
    const c = res.json.error.conflict;
    expect(c.reason).toBe('value');
    expect(c.expected).toEqual(body.expect);
    expect(c.current.type).toBe('hash');
    expect(c.current.value).toEqual(b64(Buffer.from([0xff, 0x00, 0x0d])));
    expect(c.current.expect).toEqual({ type: 'hash', sha256: sha(Buffer.from([0xff, 0x00, 0x0d])) });
    expect(await r.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer }).hGet(k('hc'), 'f')).toEqual(Buffer.from([0xff, 0x00, 0x0d]));
    // "Overwrite anyway": a new expectation, checked again.
    const again = await post({ ...body, expect: c.current.expect });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(await r.hGet(k('hc'), 'f')).toBe('mine');

    // A field that appeared since the client read the page (sha256 null) is not overwritten blindly.
    await r.hSet(k('hc'), { late: 'someone else' });
    const late = await post({ op: 'hash.set', key: utf8(k('hc')), entries: [{ field: utf8('late'), value: utf8('x') }], expect: { type: 'hash', sha256: null } });
    expect(late.status).toBe(409);
    expect(late.json.error.conflict.current.value).toEqual(utf8('someone else'));
    expect(await r.hGet(k('hc'), 'late')).toBe('someone else');

    // JSON array retargeting (review H2 B): the draft for B is refused after an insert moved A under its index.
    await r.sendCommand(['JSON.SET', k('arr'), '$', '{"items":[{"id":"A","v":1},{"id":"B","v":2}]}']);
    const opened = String(await r.sendCommand(['JSON.GET', k('arr')]));
    await r.sendCommand(['JSON.ARRINSERT', k('arr'), '$.items', '0', '{"id":"X","v":0}']);
    const retarget = await post({ op: 'json.set', key: utf8(k('arr')), path: '$["items"][1]', json: '{"id":"B","v":99}', expect: { type: 'ReJSON-RL', sha256: sha(opened) } });
    expect(retarget.status).toBe(409);
    expect(retarget.json.error.conflict.current.value).toEqual(utf8('{"items":[{"id":"X","v":0},{"id":"A","v":1},{"id":"B","v":2}]}'));
    expect(String(await r.sendCommand(['JSON.GET', k('arr')]))).toBe('{"items":[{"id":"X","v":0},{"id":"A","v":1},{"id":"B","v":2}]}');

    // A list element displaced by LPUSH.
    await r.rPush(k('lc'), ['A0', 'A1', 'A2']);
    await r.lPush(k('lc'), 'X');
    const list = await post({ op: 'list.set', key: utf8(k('lc')), index: 2, value: utf8('EDITED'), expect: { type: 'list', sha256: sha('A2') } });
    expect(list.status).toBe(409);
    expect(await r.lRange(k('lc'), 0, -1)).toEqual(['X', 'A0', 'A1', 'A2']);
  });

  it('type change: 409, the other type survives, and overwrite across types is never offered (review H2 A)', async () => {
    await r.del(k('t'));
    await r.hSet(k('t'), { sensitive: 'KEEP-ME' });
    const res = await post({ op: 'string.set', key: utf8(k('t')), value: utf8('EDITED'), keepTtl: true, expect: { type: 'string', sha256: sha('ORIGINAL') } });
    expect(res.status, JSON.stringify(res.json)).toBe(409);
    const c = res.json.error.conflict;
    expect(c.reason).toBe('type');
    expect(c.current.type).toBe('hash');
    expect(c.current.expect).toBeUndefined();
    expect(await r.type(k('t'))).toBe('hash');
    expect(await r.hGet(k('t'), 'sensitive')).toBe('KEEP-ME');
    // A deleted key: the expectation offered is "absent" (the op would create it), never a silent write.
    await r.del(k('t'));
    const gone = await post({ op: 'string.set', key: utf8(k('t')), value: utf8('EDITED'), expect: { type: 'string', sha256: sha('ORIGINAL') } });
    expect(gone.status).toBe(409);
    expect(gone.json.error.conflict.current).toEqual({ type: 'none', expect: { type: 'none' } });
    expect(await r.exists(k('t'))).toBe(0);
    // Key-level ops: delete and rename check the type (and a string's bytes).
    await r.set(k('del'), 'v1');
    const del = await op.req('POST', OPS, { op: 'key.delete', keys: [utf8(k('del'))], expect: { type: 'string', sha256: sha('v0') } });
    expect(del.status, JSON.stringify(del.json)).toBe(428);
    const { second } = await confirmed(op, OPS, { op: 'key.delete', keys: [utf8(k('del'))], expect: { type: 'string', sha256: sha('v0') } });
    expect(second.status).toBe(409);
    expect(await r.get(k('del'))).toBe('v1');
    const ok = await confirmed(op, OPS, { op: 'key.delete', keys: [utf8(k('del'))], expect: second.json.error.conflict.current.expect });
    expect(ok.second.status, JSON.stringify(ok.second.json)).toBe(200);
    expect(await r.exists(k('del'))).toBe(0);
    await r.rPush(k('ren'), 'x');
    const ren = await post({ op: 'key.rename', key: utf8(k('ren')), newKey: utf8(k('ren2')), expect: { type: 'hash' } });
    expect(ren.status).toBe(409);
    expect(ren.json.error.conflict.current).toEqual({ type: 'list', expect: { type: 'list' } });
    const ren2 = await post({ op: 'key.rename', key: utf8(k('ren')), newKey: utf8(k('ren2')), expect: { type: 'list' } });
    expect(ren2.status).toBe(200);
    expect(await r.lRange(k('ren2'), 0, -1)).toEqual(['x']);
  });

  it('a write between the read and EXEC aborts the transaction: retried when the bytes still match, 409 otherwise', async () => {
    const conn = await t.ctx.redis.conn('e2e', 'operator');
    const racing = (write: () => Promise<unknown>): Conn => {
      const exclusive: Conn['exclusive'] = (key, fn, o) => conn.exclusive(key, (send) => fn(async (args, so) => {
        if (String(args[0]) === 'MULTI') await write();
        return send(args, so);
      }), o);
      return { exclusive } as unknown as Conn;
    };
    const plan = (key: string, value: string, opened: string): CheckedPlan => ({ key: Buffer.from(key), probe: { kind: 'string' }, expect: { type: 'string', sha256: sha(opened) }, command: ['SET', Buffer.from(key), value] });
    await r.set(k('race'), 'opened');
    // Someone writes different bytes right before MULTI: EXEC aborts, the second read sees the change -> 409.
    let writes = 0;
    await expect(checkedWrite(racing(async () => { writes++; await r.set(k('race'), `theirs-${writes}`); }), plan(k('race'), 'mine', 'opened'), { timeout: 5000, maxValueBytes: 524_288 }))
      .rejects.toMatchObject({ code: 'conflict', status: 409 });
    expect(writes).toBe(1);
    expect(await r.get(k('race'))).toBe('theirs-1');
    // Someone rewrites the same bytes: WATCH aborts EXEC, the retry finds what the client read and writes.
    await r.set(k('race'), 'opened');
    writes = 0;
    const out = await checkedWrite(racing(async () => { if (writes++ === 0) await r.set(k('race'), 'opened'); }), plan(k('race'), 'mine', 'opened'), { timeout: 5000, maxValueBytes: 524_288 });
    expect(Buffer.from(out as Buffer).toString()).toBe('OK');
    expect(writes).toBe(2);
    expect(await r.get(k('race'))).toBe('mine');
    // A key that never stops changing: at most ATTEMPTS transactions, then 409 (nothing written).
    await r.set(k('race'), 'opened');
    writes = 0;
    const err = await checkedWrite(racing(async () => { writes++; await r.set(k('race'), 'opened'); }), plan(k('race'), 'mine', 'opened'), { timeout: 5000, maxValueBytes: 524_288 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe('conflict');
    expect(writes).toBe(3);
    expect(await r.get(k('race'))).toBe('opened');
  });

  it('values larger than an editor can hold are reported cut and cannot be overwritten without a reload', async () => {
    const big = 'x'.repeat(600_000);
    await r.set(k('big'), big);
    const res = await post({ op: 'string.set', key: utf8(k('big')), value: utf8('small'), expect: { type: 'string', sha256: sha('x') } });
    expect(res.status).toBe(409);
    const c = res.json.error.conflict.current;
    expect(c.truncated).toBe(true);
    expect(c.totalBytes).toBe(600_000);
    expect(c.value.data).toHaveLength(65_536);
    expect(c.expect).toBeUndefined();
    expect(await r.strLen(k('big'))).toBe(600_000);
  });

  it('validation: expectations must describe what the op replaces', async () => {
    const bad = async (body: Record<string, unknown>) => {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json.error.code).toBe('validation');
    };
    await bad({ op: 'hash.set', key: utf8(k('v')), entries: [{ field: utf8('a'), value: utf8('1') }, { field: utf8('b'), value: utf8('2') }], expect: { type: 'hash', sha256: null } });
    await bad({ op: 'string.set', key: utf8(k('v')), value: utf8('x'), nx: true, expect: { type: 'none' } });
    await bad({ op: 'string.set', key: utf8(k('v')), value: utf8('x'), keepTtl: true, ttl: 5 });
    await bad({ op: 'string.set', key: utf8(k('v')), value: utf8('x'), expect: { type: 'hash', sha256: null } });
    await bad({ op: 'string.set', key: utf8(k('v')), value: utf8('x'), expect: { type: 'string' } });
    await bad({ op: 'key.rename', key: utf8(k('v')), newKey: utf8(k('w')), expect: { type: 'hash', sha256: sha('x') } });
    await bad({ op: 'key.delete', keys: [utf8(k('v')), utf8(k('w'))], expect: { type: 'string' } });
    await bad({ op: 'list.set', key: utf8(k('v')), index: 0, value: utf8('x'), expect: { type: 'none' } });
    await bad({ op: 'string.set', key: utf8(k('v')), value: utf8('x'), expect: { type: 'string', sha256: 'ABC' } });
    expect(await r.exists(k('v'))).toBe(0);
  });

  it('audit: checked writes and conflicts are recorded without values', async () => {
    const canary = `CAS-CANARY-${randomBytes(4).toString('hex')}`;
    await r.set(k('audit'), canary);
    const before = t.auditLines.length;
    expect((await post({ op: 'string.set', key: utf8(k('audit')), value: utf8(`${canary}-2`), expect: { type: 'string', sha256: sha(canary) } })).status).toBe(200);
    expect((await post({ op: 'string.set', key: utf8(k('audit')), value: utf8(`${canary}-3`), expect: { type: 'string', sha256: sha(canary) } })).status).toBe(409);
    const lines = t.auditLines.slice(before).map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.action, l.outcome, l.detail])).toEqual([
      ['string.set', 'allowed', 'checked'],
      ['string.set', 'denied', 'conflict: This value changed since you opened it; nothing was written.'],
    ]);
    expect(t.auditLines.slice(before).join('\n')).not.toContain(canary);
  });

  it('a tier whose ACL user lacks +@transaction fails closed with a hint, writing nothing', async () => {
    const name = `rc-cas-notx-${randomBytes(3).toString('hex')}`;
    const password = randomBytes(16).toString('hex');
    const root = createClient({ url: 'redis://127.0.0.1:6411', username: 'default', password: process.env.SANDBOX_REDIS_DEFAULT_PASSWORD!, RESP: 3 });
    root.on('error', () => {});
    await root.connect();
    // The round-2 operator rules without +@transaction, limited to this run's keys.
    await root.sendCommand(['ACL', 'SETUSER', name, 'on', `>${password}`, 'resetkeys', `~${P}*`, '-@all', '+@read', '+@write', '+@connection', '-@dangerous']);
    process.env.RC_CAS_NOTX_PASSWORD = password;
    const raw = testConfigRaw();
    const db = (raw.databases as Record<string, any>[]).find((d) => d.id === 'e2e')!;
    db.credentials = { ...db.credentials, operator: { username: name, password: { env: 'RC_CAS_NOTX_PASSWORD' } } };
    (raw.server as Record<string, unknown>).dataDir = mkdtempSync(path.join(tmpdir(), 'rconsole-test-'));
    const t2 = await startApp(resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } }));
    try {
      await r.set(k('notx'), 'opened');
      const o2 = await userSession(t2, 'operator');
      const res = await o2.req('POST', OPS, { op: 'string.set', key: utf8(k('notx')), value: utf8('mine'), expect: { type: 'string', sha256: sha('opened') } });
      expect(res.status, JSON.stringify(res.json)).toBe(403);
      expect(res.json.error.hint).toMatch(/\+@transaction/);
      expect(await r.get(k('notx'))).toBe('opened');
      // Unchecked ops keep working on such a tier.
      expect((await o2.req('POST', OPS, { op: 'string.set', key: utf8(k('notx2')), value: utf8('v') })).status).toBe(200);
    } finally {
      await t2.close();
      await root.sendCommand(['ACL', 'DELUSER', name]);
      await root.close();
    }
  });
});
