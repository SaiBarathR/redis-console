import { ErrorReply } from 'redis';
import type { Arg, SendOpts } from '../../src/redis/manager.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { binFromBytes, bytesFromBin, sha256Hex } from '@rconsole/shared';
import { bk, cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, testConfig, userSession, utf8, type TestApp } from '../helpers.ts';
import { confirmed } from './data-helpers.ts';

describe.skipIf(!sandboxUp)('DETAIL parity reads and operations', () => {
  let t: TestApp, r: Awaited<ReturnType<typeof sandboxAdmin>>;
  const P = keyPrefix('detail');
  const key = (name: string) => utf8(P + name);
  const path = (s: string, db = 'e2e') => `/api/v1/databases/${db}/${s}`;
  beforeAll(async () => {
    t = await startApp(); r = await sandboxAdmin();
    const entries = Object.fromEntries(Array.from({ length: 1200 }, (_, i) => [`f:${i}`, `v:${i}`]));
    await r.hSet(P + 'h', entries);
    await r.sAdd(P + 's', Object.keys(entries));
    await r.zAdd(P + 'z', Object.keys(entries).map((value, score) => ({ value, score })));
    await r.rPush(P + 'l', Object.keys(entries));
    await r.hSet(P + 'big', 'large', Buffer.concat([Buffer.from([0xff, 0, 13]), Buffer.alloc(80000, 65)]));
    for (let i = 1; i <= 4; i++) await r.xAdd(P + 'x', `${i}-0`, { f: `v${i}` });
    await r.xGroupCreate(P + 'x', 'g', '0');
    await r.sendCommand(['XREADGROUP', 'GROUP', 'g', 'c', 'COUNT', '4', 'STREAMS', P + 'x', '>']);
  });
  afterAll(async () => { await t?.close(); await r?.close(); await cleanupPrefix(P); });
  for (const [type, name, command] of [['hash', 'h', 'HSCAN'], ['set', 's', 'SSCAN'], ['zset', 'z', 'ZSCAN']] as const) {
    it(`F1 ${command} MATCH finds an unloaded identity and reports page matches separately`, async () => {
      const c = await userSession(t, 'viewer'); let cursor = '0'; const seen: string[] = [];
      do {
        const res = await c.req('POST', path('key/read'), { key: key(name), count: 100, cursor, match: 'f:119?' });
        expect(res.status, res.body).toBe(200); const v = res.json.value;
        expect(v.total).toBe(1200); expect(res.json.filter.totalMatches).toBeUndefined();
        const items = type === 'hash' ? v.entries.map((x: any) => x.field) : type === 'set' ? v.members : v.members.map((x: any) => x.member);
        expect(res.json.filter.matches).toBe(items.length); seen.push(...items.map((b: any) => b.data)); cursor = v.cursor;
      } while (cursor !== '0');
      expect(new Set(seen)).toEqual(new Set(Array.from({ length: 10 }, (_, i) => `f:119${i}`)));
    });
    it(`F1 exact ${type} lookup is independent of the loaded scan page`, async () => {
      const c = await userSession(t, 'viewer');
      const found = await c.req('POST', path('key/read'), { key: key(name), exact: utf8('f:1199'), count: 1 });
      expect(found.status, found.body).toBe(200); expect(found.json.filter).toEqual({ matches: 1, totalMatches: 1 });
      const missing = await c.req('POST', path('key/read'), { key: key(name), exact: utf8('absent') });
      expect(missing.json.filter.totalMatches).toBe(0);
      if (type === 'hash') expect(missing.json.hashFieldExpiry.supported).toBe(true);
    });
  }
  it('F1 list jump, reverse zset and score ranges page in the selected order', async () => {
    const c = await userSession(t, 'viewer');
    const l = await c.req('POST', path('key/read'), { key: key('l'), offset: 1100, count: 2 });
    expect(l.json.value.items[0]).toMatchObject({ index: 1100, value: utf8('f:1100') });
    const z = await c.req('POST', path('key/read'), { key: key('z'), reverse: true, count: 2 });
    expect(z.json.value.members.map((x: any) => x.score)).toEqual(['1199', '1198']);
    const range = await c.req('POST', path('key/read'), { key: key('z'), reverse: true, scoreMin: '100', scoreMax: '105', offset: 2, count: 2 });
    expect(range.status, range.body).toBe(200); expect(range.json.filter).toEqual({ matches: 2, totalMatches: 6 });
    expect(range.json.value.members.map((x: any) => x.score)).toEqual(['103', '102']);
  });
  it('F1 validates glob, cursor, mixed criteria and score bounds', async () => {
    const c = await userSession(t, 'viewer');
    for (const options of [{ match: '*'.repeat(9) }, { cursor: '1-0' }, { exact: utf8('f'), match: '*' }, { scoreMin: 'NaN' }])
      expect((await c.req('POST', path('key/read'), { key: key('h'), ...options })).status).toBe(400);
  });
  it('F6 batches TTLs on the displayed fields, edits and removes expiry', async () => {
    const c = await userSession(t, 'operator');
    let res = await c.req('POST', path('ops'), { op: 'hash.expire', key: key('h'), fields: [utf8('f:1199')], ttl: 600 });
    expect(res.status, res.body).toBe(200);
    res = await c.req('POST', path('key/read'), { key: key('h'), exact: utf8('f:1199') });
    expect(res.json.hashFieldExpiry.supported).toBe(true); expect(res.json.value.entries[0].ttl).toBeGreaterThan(590);
    expect((await c.req('POST', path('ops'), { op: 'hash.persist', key: key('h'), fields: [utf8('f:1199')] })).status).toBe(200);
    res = await c.req('POST', path('key/read'), { key: key('h'), exact: utf8('f:1199') });
    expect(res.json.value.entries[0].ttl).toBe(-1);
  });
  it.each([
    ['ERR unknown command HTTL', 'Redis 7.4'],
    ['NOPERM this user has no permissions to run HTTL', 'ACL'],
  ])('F6 unsupported expiry is explicit: %s', async (message, reason) => {
    const c = await userSession(t, 'viewer');
    const conn = await t.ctx.redis.conn('e2e', 'viewer'), original = conn.send;
    const spy = vi.spyOn(conn, 'send').mockImplementation(async <T>(args: Arg[], opts?: SendOpts): Promise<T> => {
      if (args[0] === 'HTTL') throw new ErrorReply(message);
      return original.call(conn, args, opts) as Promise<T>;
    });
    try {
      const res = await c.req('POST', path('key/read'), { key: key('h'), exact: utf8('f:1') });
      expect(res.status, res.body).toBe(200);
      expect(res.json.hashFieldExpiry.supported).toBe(false);
      expect(res.json.hashFieldExpiry.reason).toContain(reason);
      expect(res.json.value.entries[0].ttl).toBeUndefined();
    } finally { spy.mockRestore(); }
  });
  it('F9 full hash bytes survive binary preview and cap exactly', async () => {
    const c = await userSession(t, 'viewer');
    const page = await c.req('POST', path('key/read'), { key: key('big') });
    expect(page.json.value.entries[0].truncated).toBe(true);
    const res = await c.req('POST', path('key/element'), { key: key('big'), ref: page.json.value.entries[0].ref });
    expect(res.status, res.body).toBe(200);
    const event = t.auditLines.map(line => JSON.parse(line)).findLast(event => event.action === 'key.element');
    expect(event.command).toBe('HGET'); expect(event.argvRedacted.join(' ')).not.toContain('large');
    expect(Buffer.from(bytesFromBin(res.json.value))).toEqual(Buffer.concat([Buffer.from([0xff, 0, 13]), Buffer.alloc(80000, 65)]));
  });
  it('F9 an exact lookup of a long field addresses it inline, not through a page it never read', async () => {
    const field = 'L'.repeat(100), bytes = Buffer.alloc(80000, 66);
    await r.hSet(P + 'h', field, bytes);
    try {
      const c = await userSession(t, 'viewer');
      const page = await c.req('POST', path('key/read'), { key: key('h'), exact: utf8(field) });
      expect(page.status, page.body).toBe(200);
      const entry = page.json.value.entries[0];
      expect(entry.truncated).toBe(true); expect(entry.ref).toEqual({ kind: 'hash', field: utf8(field) });
      const res = await c.req('POST', path('key/element'), { key: key('h'), ref: entry.ref });
      expect(res.status, res.body).toBe(200); expect(Buffer.from(bytesFromBin(res.json.value))).toEqual(bytes);
    } finally { await r.hDel(P + 'h', field); }
  });
  it.each(['list', 'set', 'zset'] as const)('F9 retrieves a full %s element and refuses missing elements', async type => {
    const c = await userSession(t, 'viewer'); const name = { list: 'l', set: 's', zset: 'z' }[type];
    const identity = sha256Hex(Buffer.from('f:1199'));
    const ref = type === 'list' ? { kind: type, index: 1199, identity } : { kind: type, member: utf8('f:1199') };
    const res = await c.req('POST', path('key/element'), { key: key(name), ref });
    expect(res.status, res.body).toBe(200); expect(res.json.value).toEqual(utf8('f:1199'));
    const absent = await c.req('POST', path('key/element'), { key: key(name), ref: type === 'list' ? { kind: type, index: 9999, identity } : { kind: type, member: utf8('absent') } });
    expect(absent.status).toBe(404);
  });
  it('F9 oversized identities use revalidated page references; changed pages cannot retarget', async () => {
    const member = Buffer.alloc(70000, 90);
    await r.sAdd(P + 'longset', member);
    const c = await userSession(t, 'viewer');
    const page = await c.req('POST', path('key/read'), { key: key('longset') });
    const ref = page.json.value.memberRefs[0]; expect(ref.kind).toBe('scan');
    const full = await c.req('POST', path('key/element'), { key: key('longset'), ref });
    expect(full.status, full.body).toBe(200); expect(bytesFromBin(full.json.value).length).toBe(70000);
    await r.del(P + 'longset'); await r.sAdd(P + 'longset', 'other');
    expect((await c.req('POST', path('key/element'), { key: key('longset'), ref })).status).toBe(409);
  });
  it('F9 refuses over-cap values while the measured socket stops reading', async () => {
    await r.hSet(P + 'cap', 'f', Buffer.alloc(600000, 1));
    const c = await userSession(t, 'viewer');
    const res = await c.req('POST', path('key/element'), { key: key('cap'), ref: { kind: 'hash', field: utf8('f') } });
    expect(res.status, res.body).toBe(413);
    expect((await c.req('POST', path('key/read'), { key: key('h'), exact: utf8('f:1') })).status).toBe(200);
  });
  it('F9 a lower configured wire cap cannot be bypassed by the full-value cap', async () => {
    const cfg = testConfig(); cfg.policy.maxReadReplyBytes = 1024;
    const small = await startApp(cfg);
    try {
      const c = await userSession(small, 'viewer');
      const res = await c.req('POST', path('key/element'), { key: key('big'), ref: { kind: 'hash', field: utf8('large') } });
      expect(res.status, res.body).toBe(413);
    } finally { await small.close(); }
  });
  it('F18 checked hash and score additions refuse replacing unseen elements and stale expectations', async () => {
    const c = await userSession(t, 'operator');
    const op = { op: 'hash.set', key: key('h'), entries: [{ field: utf8('f:1199'), value: utf8('replacement') }], expect: { type: 'hash', sha256: null } };
    const res = await c.req('POST', path('ops'), op);
    expect(res.status, res.body).toBe(409); expect(await r.hGet(P + 'h', 'f:1199')).toBe('v:1199');
    const accepted = await c.req('POST', path('ops'), { ...op, expect: res.json.error.conflict.current.expect });
    expect(accepted.status, accepted.body).toBe(200);
    const z = await c.req('POST', path('ops'), { op: 'zset.add', key: key('z'), members: [{ member: utf8('f:1199'), score: '1' }], expect: { type: 'zset', sha256: sha256Hex(Buffer.from('wrong')) } });
    expect(z.status).toBe(409); expect(await r.zScore(P + 'z', 'f:1199')).toBe(1199);
  });
  it('F15 range/consumer pending lookup, payload retrieval, confirmed claim and ack', async () => {
    const c = await userSession(t, 'operator');
    const groups = await c.req('POST', path('streams/groups'), { key: key('x') });
    expect(groups.json.groups[0].nameBin).toEqual(utf8('g')); expect(groups.json.groups[0].consumers[0].nameBin).toEqual(utf8('c'));
    const range = await c.req('POST', path('streams/pending'), { key: key('x'), group: utf8('g'), consumer: utf8('c'), start: '2-0', end: '3-0' });
    expect(range.status, range.body).toBe(200); expect(range.json.pending.map((p: any) => p.id)).toEqual(['2-0', '3-0']); expect(range.json.total).toBe(4);
    const element = await c.req('POST', path('key/element'), { key: key('x'), ref: { kind: 'stream', id: '2-0', position: 0 } });
    expect(element.json.value).toEqual(utf8('v2'));
    const claim = await confirmed(c, path('ops'), { op: 'stream.claim', key: key('x'), group: utf8('g'), consumer: utf8('new'), minIdleMs: 0, ids: ['2-0'] });
    expect(claim.first.status).toBe(428); expect(claim.second.status, claim.second.body).toBe(200);
    const changed = await c.req('POST', path('streams/pending'), { key: key('x'), group: 'g', consumer: 'new' });
    expect(changed.json.pending[0].consumer).toBe('new');
    const ack = await confirmed(c, path('ops'), { op: 'stream.ack', confirmAck: true, key: key('x'), group: utf8('g'), ids: ['2-0'] });
    expect(ack.first.status).toBe(428); expect(ack.second.status).toBe(200);
  });
  it('F15 binary group and consumer names retain their exact bytes', async () => {
    const g = Buffer.from([0xff, 65]), consumer = Buffer.from([0xfe, 66]);
    await r.sendCommand(['XGROUP', 'CREATE', P + 'x', g, '0']);
    await r.sendCommand(['XREADGROUP', 'GROUP', g, consumer, 'COUNT', '1', 'STREAMS', P + 'x', '>']);
    const c = await userSession(t, 'viewer'); const res = await c.req('POST', path('streams/groups'), { key: key('x') });
    const group = res.json.groups.find((x: any) => x.nameBin.enc === 'base64');
    expect(group.nameBin).toEqual(binFromBytes(g)); expect(group.consumers[0].nameBin).toEqual(binFromBytes(consumer));
    const pending = await c.req('POST', path('streams/pending'), { key: key('x'), group: bk(g), consumer: bk(consumer) });
    expect(pending.status, pending.body).toBe(200); expect(pending.json.pending).toHaveLength(1);
  });
  // Review v0.2.1 web L2: inspector-bound consumer delete and group lifecycle, by exact bytes.
  it('L2 consumer delete is confirmed, operator-only, binary-exact and reports the dropped pending count', async () => {
    const g = Buffer.from([0xff, 0x67]), consumer = Buffer.from([0xfe, 0x63]);
    for (let i = 1; i <= 3; i++) await r.xAdd(P + 'xd', `${i}-0`, { f: `v${i}` });
    await r.sendCommand(['XGROUP', 'CREATE', P + 'xd', g, '0']);
    await r.sendCommand(['XREADGROUP', 'GROUP', g, consumer, 'COUNT', '2', 'STREAMS', P + 'xd', '>']);
    await r.sendCommand(['XGROUP', 'CREATECONSUMER', P + 'xd', g, 'idle']);
    const del = { op: 'stream.consumer.delete', key: key('xd'), group: bk(g), consumer: bk(consumer) };
    const viewer = await userSession(t, 'viewer');
    expect((await viewer.req('POST', path('ops'), del)).status).toBe(403);
    const operator = await userSession(t, 'operator');
    const res = await confirmed(operator, path('ops'), del);
    expect(res.first.status).toBe(428);
    expect(res.first.json.error.confirmation.summary).toMatch(/Delete consumer/);
    expect(res.first.json.error.confirmation.preview.commands[0].argv.map((a: any) => a.v.data)).toContain('DELCONSUMER');
    expect(res.second.status, res.second.body).toBe(200);
    expect(res.second.json.result).toEqual({ t: 'int', v: '2' });
    const left = (await r.sendCommand(['XINFO', 'CONSUMERS', P + 'xd', g])) as unknown[];
    expect(left).toHaveLength(1);
    expect(String((await r.sendCommand(['XPENDING', P + 'xd', g]) as unknown[])[0])).toBe('0');
    // Lifecycle from the inspector: create at an explicit ID (not confirmed), destroy (confirmed), both by bytes.
    const g2 = Buffer.from([0xfd, 0x32]);
    expect((await operator.req('POST', path('ops'), { op: 'stream.group.create', key: key('xd'), group: bk(g2), id: '1-0' })).status).toBe(200);
    expect((await operator.req('POST', path('ops'), { op: 'stream.group.create', key: key('xd-new'), group: 'g', id: '$', mkstream: true })).status).toBe(200);
    expect(await r.exists(P + 'xd-new')).toBe(1);
    const destroy = await confirmed(operator, path('ops'), { op: 'stream.group.destroy', key: key('xd'), group: bk(g2) });
    expect(destroy.first.status).toBe(428); expect(destroy.second.json.result).toEqual({ t: 'int', v: '1' });
    expect(((await r.sendCommand(['XINFO', 'GROUPS', P + 'xd'])) as unknown[]).length).toBe(1);
  });
  it('new reads carry the actor check; revocation during connection wait prevents dispatch', async () => {
    const c = await userSession(t, 'viewer'); const original = t.ctx.redis.conn.bind(t.ctx.redis);
    const spy = vi.spyOn(t.ctx.redis, 'conn').mockImplementation(async (...args) => {
      const conn = await original(...args); t.ctx.users.update(c.userId, { disabled: true }); return conn;
    });
    const res = await c.req('POST', path('key/element'), { key: key('h'), ref: { kind: 'hash', field: utf8('f:1') } });
    spy.mockRestore(); expect(res.status, res.body).toBe(401);
  });
  it('viewer and read-only databases refuse every new write; new reads stay available', async () => {
    for (const [role, db] of [['viewer', 'e2e'], ['admin', 'e2e-ro']] as const) {
      const c = await userSession(t, role);
      for (const operation of [ { op: 'hash.expire', key: key('h'), fields: [utf8('f:1')], ttl: 10 }, { op: 'hash.persist', key: key('h'), fields: [utf8('f:1')] }, { op: 'stream.claim', key: key('x'), group: 'g', consumer: 'c', minIdleMs: 0, ids: ['1-0'] }, { op: 'stream.ack', confirmAck: true, key: key('x'), group: 'g', ids: ['1-0'] } ]) expect((await c.req('POST', path('ops', db), operation)).status).toBe(403);
      expect((await c.req('POST', path('key/element', db), { key: key('h'), ref: { kind: 'hash', field: utf8('f:1') } })).status).toBe(200);
    }
    expect(t.auditLines.join('\n')).not.toContain('replacement');
  });
});
