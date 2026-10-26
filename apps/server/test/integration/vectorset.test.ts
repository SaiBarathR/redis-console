/**
 * Vector-set inspector (v0.4, F23) against the 6411 sandbox: `key/read` summary and first page, member paging and
 * prefix filter, lazy attributes, element detail (attributes, embedding, neighbours), similarity search, the
 * `vset.*` typed ops (compare-and-set, confirmation, roles, read-only and prod rules) and their audit events.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VSET_ATTR_PREVIEW_BYTES, VSET_EMBED_PREVIEW_VALUES, VSET_PAGE_MAX } from '@rconsole/shared';
import { resolveConfig } from '../../src/config.ts';
import { anonymous, b64, bk, portOpen, startApp, testConfigRaw, userSession, utf8, type Client, type TestApp } from '../helpers.ts';
import { cli, confirmed } from './data-helpers.ts';

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');

/**
 * The sandbox-e2e Redis by default. RC_TEST_VSET_PORT points the suite at another Redis built from the same
 * `infra/redis/users.acl.template` (a sandbox generated before the v0.4 V* grants refuses them for rc-viewer and
 * rc-operator: vector-set commands have no ACL category, so `+@read`/`+@write` do not include them).
 */
const PORT = Number(process.env.RC_TEST_VSET_PORT ?? 6411);
const redisAs = async (user: 'rc-admin' | 'rc-viewer') => {
  const c = createClient({ url: `redis://127.0.0.1:${PORT}`, username: user, password: process.env[user === 'rc-admin' ? 'SANDBOX_REDIS_ADMIN_PASSWORD' : 'SANDBOX_REDIS_VIEWER_PASSWORD']!, RESP: 3 });
  c.on('error', () => {});
  await c.connect();
  return c;
};
type Admin = Awaited<ReturnType<typeof redisAs>>;
const up = await portOpen(PORT);
/** Whether this Redis grants the vector-set reads to the viewer tier (the v0.4 ACL template). */
const aclReady = up && (await (async () => {
  const c = await redisAs('rc-viewer').catch(() => undefined);
  if (!c) return false;
  try { await c.sendCommand(['VCARD', 'vset:20261026:acl-probe']); return true; } catch { return false; } finally { await c.close(); }
})());
if (up && !aclReady) console.warn(`vectorset.test.ts: skipped; Redis on ${PORT} predates the v0.4 V* ACL grants (regenerate its users.acl from infra/redis/users.acl.template, or set RC_TEST_VSET_PORT)`);

function vsetConfig() {
  const raw = testConfigRaw() as { databases: { url: string }[]; server: Record<string, unknown> };
  for (const d of raw.databases) d.url = d.url.replace('127.0.0.1:6411', `127.0.0.1:${PORT}`);
  raw.server.dataDir = mkdtempSync(path.join(tmpdir(), 'rconsole-test-'));
  return resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } });
}
const db = (id: string, route: string) => `/api/v1/databases/${id}/${route}`;
const decode = (b: { enc: string; data: string }) => (b.enc === 'utf8' ? Buffer.from(b.data) : Buffer.from(b.data, 'base64'));

describe.skipIf(!aclReady)('vector-set inspector (v0.4 F23)', () => {
  let t: TestApp;
  let r: Admin;
  let viewer: Client, operator: Client, admin: Client;
  // The stream's own sandbox prefix (docs/V0.4-PLAN.md), plus a run id so parallel runs never collide.
  const P = `vset:20261026:it:${randomBytes(3).toString('hex')}:`;
  const k = (s: string) => `${P}${s}`;
  const vadd = (key: string, values: number[], member: string | Buffer, ...extra: string[]) =>
    r.sendCommand(['VADD', key, 'VALUES', String(values.length), ...values.map(String), member as string, ...extra]);
  const read = (c: Client, key: string, extra: Record<string, unknown> = {}) => c.req('POST', db('e2e', 'key/read'), { key: utf8(key), ...extra });
  const post = (c: Client, route: string, body: Record<string, unknown>, id = 'e2e') => c.req('POST', db(id, route), body);

  beforeAll(async () => {
    t = await startApp(vsetConfig());
    r = await redisAs('rc-admin');
    [viewer, operator, admin] = await Promise.all([userSession(t, 'viewer'), userSession(t, 'operator'), userSession(t, 'admin')]);
    // 3 dimensions, 300 members m000..m299 with attributes on every third, plus a few with other prefixes.
    for (let i = 0; i < 300; i++) {
      const a = Math.cos(i), b = Math.sin(i);
      await vadd(k('v3'), [a, b, i / 300], `m${String(i).padStart(3, '0')}`, ...(i % 3 === 0 ? ['SETATTR', JSON.stringify({ i, even: i % 2 === 0 })] : []));
    }
    await vadd(k('v3'), [1, 0, 0], 'other:a');
    await vadd(k('v3'), [0, 1, 0], Buffer.from([0xff, 0x00, 0x41]));
    // 8 dimensions, NOQUANT, a long attribute and a huge one.
    await vadd(k('v8'), [1, 2, 3, 4, 5, 6, 7, 8], 'long', 'NOQUANT', 'SETATTR', JSON.stringify({ text: 'x'.repeat(5000) }));
    await vadd(k('v8'), [8, 7, 6, 5, 4, 3, 2, 1], 'huge', 'NOQUANT', 'SETATTR', JSON.stringify({ text: 'y'.repeat(100_000) }));
    await vadd(k('v8'), [1, 1, 1, 1, 1, 1, 1, 1], 'plain', 'NOQUANT');
    await r.set(k('str'), 'not a vector set');
  });
  afterAll(async () => {
    try {
      for await (const keys of r.scanIterator({ MATCH: `${P}*`, COUNT: 1000 })) if (keys.length) await r.unlink(keys);
    } finally {
      await r?.close();
      await t?.close();
    }
  });

  it('key/read: summary from VCARD, VDIM and VINFO and the first VRANGE page, bounded by VSET_PAGE_MAX', async () => {
    const res = await read(viewer, k('v3'), { count: 1000 });
    expect(res.status, res.body).toBe(200);
    const d = res.json;
    expect(d.type).toBe('vectorset');
    expect(d.length).toBe(302);
    expect(d.value.info).toMatchObject({ size: 302, dim: 3, quantization: 'int8', hnswM: 16, attributesCount: 100 });
    // count 1000 is clamped to VSET_PAGE_MAX; the page is in byte order and full, so it names the next start.
    expect(d.value.page.members.length).toBe(Math.min(302, VSET_PAGE_MAX));
    expect(d.value.page.members[0].member).toEqual(utf8('m000'));
    const small = (await read(viewer, k('v3'), { count: 10 })).json;
    expect(small.value.page.members.map((m: { member: { data: string } }) => m.member.data)).toEqual(Array.from({ length: 10 }, (_, i) => `m00${i}`));
    expect(small.value.page.next).toEqual(utf8('m009'));
    const ev = t.ctx.audit.query({ limit: 5, action: 'key.read' }).events[0]!;
    expect(ev.command).toBe('VRANGE');
    expect(ev.detail).toContain('type=vectorset returned=10 length=302');
  });

  it('members: exclusive paging after a member, a byte prefix (also 0xff), the last page and the type check', async () => {
    let res = await post(viewer, 'vectorset/members', { key: utf8(k('v3')), after: utf8('m009'), count: 5 });
    expect(res.status, res.body).toBe(200);
    expect(res.json.total).toBe(302);
    expect(res.json.page.members.map((m: { member: { data: string } }) => m.member.data)).toEqual(['m010', 'm011', 'm012', 'm013', 'm014']);
    expect(res.json.page.next).toEqual(utf8('m014'));
    // Prefix: only members starting with "m29"; the page is not full, so there is no next page.
    res = await post(viewer, 'vectorset/members', { key: utf8(k('v3')), prefix: utf8('m29'), count: 50 });
    expect(res.json.page.members.map((m: { member: { data: string } }) => m.member.data)).toEqual(Array.from({ length: 10 }, (_, i) => `m29${i}`));
    expect(res.json.page.next).toBeUndefined();
    expect(res.json.page.prefix).toEqual(utf8('m29'));
    // Prefix and paging together: start after m295 inside the prefix.
    res = await post(viewer, 'vectorset/members', { key: utf8(k('v3')), prefix: utf8('m29'), after: utf8('m295'), count: 50 });
    expect(res.json.page.members.map((m: { member: { data: string } }) => m.member.data)).toEqual(['m296', 'm297', 'm298', 'm299']);
    // A start past the prefix's range sends nothing and returns an empty page.
    res = await post(viewer, 'vectorset/members', { key: utf8(k('v3')), prefix: utf8('m29'), after: utf8('n'), count: 50 });
    expect(res.json.page.members).toEqual([]);
    // Binary: the 0xff prefix runs to the end of the range.
    res = await post(viewer, 'vectorset/members', { key: utf8(k('v3')), prefix: b64(Buffer.from([0xff])), count: 50 });
    expect(res.json.page.members.map((m: { member: { enc: string; data: string } }) => decode(m.member))).toEqual([Buffer.from([0xff, 0x00, 0x41])]);
    res = await post(viewer, 'vectorset/members', { key: utf8(k('v3')), prefix: utf8('other:'), count: 50 });
    expect(res.json.page.members).toEqual([{ member: utf8('other:a') }]);
    // Bounds and types.
    expect((await post(viewer, 'vectorset/members', { key: utf8(k('v3')), count: VSET_PAGE_MAX + 1 })).status).toBe(400);
    expect((await post(viewer, 'vectorset/members', { key: utf8(k('str')) })).json.error.code).toBe('validation');
    expect((await post(viewer, 'vectorset/members', { key: utf8(k('missing')) })).status).toBe(404);
    expect((await post(anonymous(t), 'vectorset/members', { key: utf8(k('v3')) })).status).toBe(401);
  });

  it('attributes: VGETATTR of the rows on screen, in order, with previews and a too-large fallback per row', async () => {
    let res = await post(viewer, 'vectorset/attributes', { key: utf8(k('v3')), members: [utf8('m000'), utf8('m001'), utf8('nope'), utf8('m003')] });
    expect(res.status, res.body).toBe(200);
    expect(res.json.attributes).toEqual([{ value: utf8('{"i":0,"even":true}') }, null, null, { value: utf8('{"i":3,"even":false}') }]);
    // A long attribute is cut to the row preview; one over the per-row read cap is reported, the others still read.
    res = await post(viewer, 'vectorset/attributes', { key: utf8(k('v8')), members: [utf8('long'), utf8('huge'), utf8('plain')] });
    expect(res.status, res.body).toBe(200);
    const [long, huge, plain] = res.json.attributes;
    expect(long.truncated).toBe(true);
    expect(decode(long.value).length).toBe(VSET_ATTR_PREVIEW_BYTES);
    expect(long.totalBytes).toBe(JSON.stringify({ text: 'x'.repeat(5000) }).length);
    expect(huge).toEqual({ tooLarge: true });
    expect(plain).toBeNull();
    expect((await post(viewer, 'vectorset/attributes', { key: utf8(k('v3')), members: Array.from({ length: 101 }, () => utf8('m000')) })).status).toBe(400);
    const ev = t.ctx.audit.query({ limit: 5, action: 'vset.attributes' }).events[0]!;
    expect(ev.detail).toBe('rows=3 present=2 tooLarge=1');
    expect(JSON.stringify(ev)).not.toContain('long');
  });

  it('element: attributes, the embedding, neighbours per layer; 404 for a missing member', async () => {
    let res = await post(viewer, 'vectorset/element', { key: utf8(k('v8')), member: utf8('long') });
    expect(res.status, res.body).toBe(200);
    expect(decode(res.json.attributes).toString()).toBe(JSON.stringify({ text: 'x'.repeat(5000) }));
    expect(res.json.quantization).toBe('f32');
    expect(res.json.embedding).toEqual({ values: ['1', '2', '3', '4', '5', '6', '7', '8'].map((v) => expect.stringMatching(new RegExp(`^${v}(\\.0+)?$`))), dim: 8, truncated: false });
    expect(res.json.links[0].layer).toBe(0);
    expect(res.json.links[0].neighbours.map((n: { member: { data: string } }) => n.member.data).sort()).toEqual(['huge', 'plain']);
    // An attribute larger than maxValueBytes (512 KiB in tests) is not read whole: here 100 KB is read.
    res = await post(viewer, 'vectorset/element', { key: utf8(k('v8')), member: utf8('huge'), links: false });
    expect(decode(res.json.attributes).length).toBeGreaterThan(100_000);
    expect(res.json.links).toBeUndefined();
    res = await post(viewer, 'vectorset/element', { key: utf8(k('v8')), member: utf8('plain') });
    expect(res.json.attributes).toBeNull();
    expect((await post(viewer, 'vectorset/element', { key: utf8(k('v8')), member: utf8('nope') })).status).toBe(404);
    expect((await post(viewer, 'vectorset/element', { key: utf8(k('str')), member: utf8('x') })).status).toBe(400);
  });

  it('element: embeddings above VSET_EMBED_PREVIEW_VALUES are cut and flagged', async () => {
    const dim = VSET_EMBED_PREVIEW_VALUES + 4;
    await vadd(k('wide'), Array.from({ length: dim }, (_, i) => (i % 7) / 7), 'w', 'NOQUANT');
    const res = await post(viewer, 'vectorset/element', { key: utf8(k('wide')), member: utf8('w') });
    expect(res.status, res.body).toBe(200);
    expect(res.json.embedding.dim).toBe(dim);
    expect(res.json.embedding.values.length).toBe(VSET_EMBED_PREVIEW_VALUES);
    expect(res.json.embedding.truncated).toBe(true);
  });

  it('search: VSIM by member and by vector, with scores, attributes, EF and a bounded filter', async () => {
    let res = await post(viewer, 'vectorset/search', { key: utf8(k('v3')), query: { element: utf8('m150') }, count: 5 });
    expect(res.status, res.body).toBe(200);
    expect(res.json.results.length).toBe(5);
    expect(res.json.results[0].member).toEqual(utf8('m150'));
    expect(Number(res.json.results[0].score)).toBeGreaterThan(0.99);
    res = await post(viewer, 'vectorset/search', { key: utf8(k('v8')), query: { values: ['8', '7', '6', '5', '4', '3', '2', '1'] }, count: 2, ef: 50, withAttributes: true });
    expect(res.status, res.body).toBe(200);
    expect(res.json.results[0].member).toEqual(utf8('huge'));
    expect(res.json.results[0].attributes).toMatchObject({ truncated: true });
    // A filter keeps only matching members; FILTER-EF is always sent by the server.
    res = await post(viewer, 'vectorset/search', { key: utf8(k('v3')), query: { element: utf8('m000') }, count: 10, filter: '.i > 100', withAttributes: true });
    expect(res.status, res.body).toBe(200);
    expect(res.json.results.length).toBeGreaterThan(0);
    for (const x of res.json.results) expect(JSON.parse(decode(x.attributes.value).toString()).i).toBeGreaterThan(100);
    // Request errors are 4xx, not 502.
    expect((await post(viewer, 'vectorset/search', { key: utf8(k('v3')), query: { element: utf8('nope') } })).status).toBe(404);
    expect((await post(viewer, 'vectorset/search', { key: utf8(k('v3')), query: { values: ['1', '2'] } })).json.error.code).toBe('validation');
    expect((await post(viewer, 'vectorset/search', { key: utf8(k('v3')), query: { element: utf8('m000') }, filter: '.even ==' })).json.error.code).toBe('validation');
    // Bounds (as another user: the search rate limit is 5/s with a burst of 10 per user).
    for (const bad of [{ count: 101 }, { ef: 1001 }, { filter: 'x'.repeat(1025) }, { filterEf: 100_001 }, { query: { values: ['inf', '1', '2'] } }, { query: { values: ['0x10', '1', '2'] } }])
      expect((await post(admin, 'vectorset/search', { key: utf8(k('v3')), query: { element: utf8('m000') }, ...bad })).status, JSON.stringify(bad)).toBe(400);
    const ev = t.ctx.audit.query({ limit: 20, action: 'vset.search', outcome: 'allowed' }).events.find((e) => e.argvRedacted?.includes('FILTER'))!;
    expect(ev.argvRedacted).toEqual(['VSIM', expect.stringMatching(/^key#/), 'ELE', '<4 bytes>', 'COUNT', '10', 'FILTER', '<8 bytes>']);
  });

  it('vset.add: operator and up; the member must be absent (409, nothing written); creates a key from type none', async () => {
    const add = (c: Client, member: string, expect: Record<string, unknown>, key = k('v3'), values = ['0.1', '0.2', '0.3']) =>
      post(c, 'ops', { op: 'vset.add', key: utf8(key), member: utf8(member), values, expect });
    expect((await add(viewer, 'new1', { type: 'vectorset', sha256: null })).status).toBe(403);
    let res = await add(operator, 'new1', { type: 'vectorset', sha256: null });
    expect(res.status, res.body).toBe(200);
    expect(await r.sendCommand(['VISMEMBER', k('v3'), 'new1'])).toBe(true);
    // Adding an existing member would replace its vector: refused, with no overwrite offered.
    const before = await r.sendCommand(['VEMB', k('v3'), 'm001']);
    res = await add(admin, 'm001', { type: 'vectorset', sha256: null }, k('v3'), ['9', '9', '9']);
    expect(res.status, res.body).toBe(409);
    expect(res.json.error.message).toMatch(/already exists/);
    expect(res.json.error.conflict.current.expect).toBeUndefined();
    expect(await r.sendCommand(['VEMB', k('v3'), 'm001'])).toEqual(before);
    // The expectation is mandatory and can only say "absent".
    expect((await post(operator, 'ops', { op: 'vset.add', key: utf8(k('v3')), member: utf8('x'), values: ['1', '2', '3'] })).status).toBe(400);
    expect((await add(operator, 'x', { type: 'vectorset', sha256: sha('') })).status).toBe(400);
    // Create: type none, quantisation and attributes.
    res = await post(operator, 'ops', { op: 'vset.add', key: utf8(k('created')), member: utf8('first'), values: ['1', '0'], quantization: 'BIN', attributes: utf8('{"a":1}'), expect: { type: 'none' } });
    expect(res.status, res.body).toBe(200);
    expect(String(await r.sendCommand(['VGETATTR', k('created'), 'first']))).toBe('{"a":1}');
    // ... but never on top of an existing key.
    res = await post(operator, 'ops', { op: 'vset.add', key: utf8(k('created')), member: utf8('second'), values: ['1', '0'], expect: { type: 'none' } });
    expect(res.status).toBe(409);
    // The audit records the shape of the vector, not one entry per coordinate, and no member or attribute bytes.
    const ev = t.ctx.audit.query({ limit: 10, action: 'vset.add', outcome: 'allowed' }).events[0]!;
    expect(ev.argvRedacted).toEqual(['VADD', expect.stringMatching(/^key#/), 'VALUES', '<2 values>', '<5 bytes>', 'BIN', 'SETATTR', '<7 bytes>']);
  });

  it('vset.setattr: compare-and-set on the attribute bytes; a concurrent change is a 409 with the current value', async () => {
    const set = (c: Client, member: string, attributes: string, expect: Record<string, unknown>) =>
      post(c, 'ops', { op: 'vset.setattr', key: utf8(k('v3')), member: utf8(member), attributes: utf8(attributes), expect });
    const current = '{"i":6,"even":true}';
    let res = await set(operator, 'm006', '{"i":6,"edited":1}', { type: 'vectorset', sha256: sha(current) });
    expect(res.status, res.body).toBe(200);
    expect(String(await r.sendCommand(['VGETATTR', k('v3'), 'm006']))).toBe('{"i":6,"edited":1}');
    // No attributes compare as no bytes.
    res = await set(operator, 'm001', '{"added":true}', { type: 'vectorset', sha256: sha('') });
    expect(res.status, res.body).toBe(200);
    // Someone else changes the attribute after the editor read it.
    await r.sendCommand(['VSETATTR', k('v3'), 'm009', '{"by":"someone else"}']);
    res = await set(operator, 'm009', '{"mine":1}', { type: 'vectorset', sha256: sha('{"i":9,"even":false}') });
    expect(res.status).toBe(409);
    expect(res.json.error.conflict.reason).toBe('value');
    expect(decode(res.json.error.conflict.current.value).toString()).toBe('{"by":"someone else"}');
    expect(String(await r.sendCommand(['VGETATTR', k('v3'), 'm009']))).toBe('{"by":"someone else"}');
    // "Overwrite anyway" with the expectation the conflict offered.
    res = await set(operator, 'm009', '{"mine":1}', res.json.error.conflict.current.expect);
    expect(res.status, res.body).toBe(200);
    // Empty attributes remove them.
    res = await set(operator, 'm009', '', { type: 'vectorset', sha256: sha('{"mine":1}') });
    expect(res.status, res.body).toBe(200);
    expect(await r.sendCommand(['VGETATTR', k('v3'), 'm009'])).toBeNull();
    // A member that is gone: 409, never an overwrite.
    res = await set(operator, 'gone', '{}', { type: 'vectorset', sha256: sha('') });
    expect(res.status).toBe(409);
    expect(res.json.error.message).toMatch(/no longer exists/);
    expect(res.json.error.conflict.current.expect).toBeUndefined();
    // Viewer refused; expectation required; another type is a type conflict.
    expect((await set(viewer, 'm006', '{}', { type: 'vectorset', sha256: sha('') })).status).toBe(403);
    expect((await post(operator, 'ops', { op: 'vset.setattr', key: utf8(k('v3')), member: utf8('m006'), attributes: utf8('{}') })).status).toBe(400);
    expect((await set(operator, 'm006', '{}', { type: 'vectorset', sha256: null })).status).toBe(400);
    res = await post(operator, 'ops', { op: 'vset.setattr', key: utf8(k('str')), member: utf8('m'), attributes: utf8('{}'), expect: { type: 'vectorset', sha256: sha('') } });
    expect(res.status).toBe(409);
    expect(res.json.error.conflict.reason).toBe('type');
  });

  it('vset.remove: confirmation like removing hash fields; the preview names the command', async () => {
    const body = { op: 'vset.remove', key: utf8(k('v3')), member: utf8('m100') };
    expect((await post(viewer, 'ops', body)).status).toBe(403);
    const { first, second } = await confirmed(operator, db('e2e', 'ops'), body);
    expect(first.json.error.confirmation.summary).toContain('Remove 1 vector set member');
    expect((await post(operator, 'ops', { op: 'vset.remove', key: body.key, members: [utf8('m100')] })).status).toBe(400);
    expect(first.json.error.confirmation.preview.commands[0].argv[0].v).toEqual(utf8('VREM'));
    expect(second.status, second.body).toBe(200);
    expect(await r.sendCommand(['VISMEMBER', k('v3'), 'm100'])).toBe(false);
    expect(await r.sendCommand(['VISMEMBER', k('v3'), 'm101'])).toBe(true);
  });

  it('read-only databases refuse every vset op for every role, with no confirmation offered; reads still work', async () => {
    const ops = [
      { op: 'vset.add', key: utf8(k('v3')), member: utf8('ro'), values: ['1', '2', '3'], expect: { type: 'vectorset', sha256: null } },
      { op: 'vset.setattr', key: utf8(k('v3')), member: utf8('m003'), attributes: utf8('{}'), expect: { type: 'vectorset', sha256: sha('{"i":3,"even":false}') } },
      { op: 'vset.remove', key: utf8(k('v3')), member: utf8('m003') },
    ];
    for (const c of [operator, admin]) for (const o of ops) {
      const res = await post(c, 'ops', o, 'e2e-ro');
      expect(res.status, `${o.op} ${res.body}`).toBe(403);
      expect(res.json.error.code).toBe('read_only');
    }
    expect(await r.sendCommand(['VISMEMBER', k('v3'), 'ro'])).toBe(false);
    expect((await post(viewer, 'vectorset/members', { key: utf8(k('v3')), count: 2 }, 'e2e-ro')).status).toBe(200);
  });

  it('prod databases ask for the typed name and a reason before an attribute edit', async () => {
    const body = { op: 'vset.setattr', key: utf8(k('v3')), member: utf8('m012'), attributes: utf8('{"prod":1}'), expect: { type: 'vectorset', sha256: sha('{"i":12,"even":true}') } };
    const { first, second } = await confirmed(operator, db('e2e-prod', 'ops'), body);
    expect(first.json.error.confirmation.level).toBe('typed');
    expect(first.json.error.confirmation.reasonRequired).toBe(true);
    expect(second.status, second.body).toBe(200);
  });

  it('console: V* writes need operator; VREM runs without confirmation like HDEL', async () => {
    expect((await cli(viewer, 'e2e', `VREM ${k('v3')} m200`)).status).toBe(403);
    expect((await cli(viewer, 'e2e', `VSETATTR ${k('v3')} m200 {}`)).status).toBe(403);
    expect((await cli(viewer, 'e2e', `VCARD ${k('v3')}`)).status).toBe(200);
    const res = await cli(operator, 'e2e', `VREM ${k('v3')} m200`);
    expect(res.status, res.body).toBe(200);
    expect(res.json.reply).toEqual({ t: 'bool', v: true });
  });

  it('a binary member round-trips through element, setattr and remove', async () => {
    const m = Buffer.from([0xff, 0x00, 0x41]);
    let res = await post(viewer, 'vectorset/element', { key: utf8(k('v3')), member: bk(m) });
    expect(res.status, res.body).toBe(200);
    expect(decode(res.json.member)).toEqual(m);
    res = await post(operator, 'ops', { op: 'vset.setattr', key: utf8(k('v3')), member: bk(m), attributes: utf8('{"bin":1}'), expect: { type: 'vectorset', sha256: sha('') } });
    expect(res.status, res.body).toBe(200);
    const { second } = await confirmed(operator, db('e2e', 'ops'), { op: 'vset.remove', key: utf8(k('v3')), member: bk(m) });
    expect(second.status).toBe(200);
    expect(await r.sendCommand(['VISMEMBER', k('v3'), m])).toBe(false);
    // Nothing of the member or its attributes reaches the audit stream.
    expect(t.auditLines.join('\n')).not.toContain('"bin":1');
  });
});
