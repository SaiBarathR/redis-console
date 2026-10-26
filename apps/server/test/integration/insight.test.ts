/**
 * v0.2.1 insight routes (F4/F7/F8/F10): search index wizard and details, query options, admin drop, analysis jobs
 * with recommendations, and import jobs. All writes go to the 6411 sandbox under a per-run prefix.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ANALYSIS_RULES } from '@rconsole/shared';
import { bk, cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, testConfig, testConfigRaw, userSession, type Client, type TestApp } from '../helpers.ts';
import { confirmed, cli } from './data-helpers.ts';
import { resolveConfig } from '../../src/config.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;
const DB = '/api/v1/databases/e2e';

async function until<T>(fn: () => Promise<T>, done: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitIndexed(r: Admin, idx: string, docs: number) {
  for (let i = 0; i < 100; i++) {
    const info = JSON.stringify(await r.sendCommand(['FT.INFO', idx]), (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
    if (info.includes(`"num_docs",${docs}`) && info.includes('"indexing",0')) return;
    await new Promise((res) => setTimeout(res, 50));
  }
}

describe.skipIf(!sandboxUp)('insight: search index wizard, details, query options and drop', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('ins-search');
  const made: string[] = [];
  const idx = (s: string) => {
    const name = `rcsrv-ins-${s}-${randomBytes(3).toString('hex')}`;
    made.push(name);
    return name;
  };

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    for (let i = 0; i < 6; i++) await r.hSet(`${P}item:${i}`, { title: `Blue gadget ${i}`, price: String(10 + i), category: i % 2 ? 'tools' : 'toys', where: '13.4,52.5' });
    await r.hSet(`${P}item:bin`, { title: 'binary vector', emb: Buffer.from(new Float32Array([1, 2, 3, 4]).buffer) });
    // 2^53 + 1 is exact in RedisJSON (int64) but not in a JavaScript number.
    for (let i = 0; i < 3; i++) await r.sendCommand(['JSON.SET', `${P}doc:${i}`, '$', `{"name":"Doc ${i} name","n":900719925474099${3 + i},"tags":["a","b"],"nested":{"city":"Berlin"},"list":[{"x":1}]}`]);
    // A key whose id is not UTF-8, for "open any document" (RediSearch does not return ids holding a NUL byte).
    await r.hSet(Buffer.from([...Buffer.from(`${P}item:`), 0xff, 0xfe]), { title: 'Blue gadget binary id', price: '99', category: 'toys' });
  });
  afterAll(async () => {
    for (const name of made) await r?.sendCommand(['FT.DROPINDEX', name]).catch(() => {});
    // cleanupPrefix decodes names as UTF-8, so the binary key is removed by its exact bytes here.
    await r?.sendCommand(['UNLINK', Buffer.from([...Buffer.from(`${P}item:`), 0xff, 0xfe])]).catch(() => {});
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('samples hash fields (types, examples, binary FLOAT32 vectors) for any reader', async () => {
    const v = await userSession(t, 'viewer');
    const res = await v.req('POST', `${DB}/search/sample`, { on: 'HASH', prefix: `${P}item:`, keys: 20, key: bk(`${P}item:0`) });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.sampled).toBe(8);
    expect(res.json.complete).toBe(true);
    const by = Object.fromEntries(res.json.fields.map((f: any) => [f.name, f]));
    expect(by.title.suggested).toBe('TEXT');
    expect(by.price.suggested).toBe('NUMERIC');
    expect(by.category.suggested).toBe('TAG');
    expect(by.where.suggested).toBe('GEO');
    expect(by.emb).toMatchObject({ suggested: 'VECTOR', dim: 4 });
    expect(by.title.examples.length).toBeGreaterThan(0);
  });

  it('samples JSON paths with aliases, exact large numbers and ignored nested arrays', async () => {
    const v = await userSession(t, 'viewer');
    const res = await v.req('POST', `${DB}/search/sample`, { on: 'JSON', prefix: `${P}doc:` });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const by = Object.fromEntries(res.json.fields.map((f: any) => [f.name, f]));
    expect(by['$.name']).toMatchObject({ as: 'name', suggested: 'TEXT' });
    expect(by['$.n']).toMatchObject({ as: 'n', suggested: 'NUMERIC' });
    // The example is the stored number text, not a rounded double.
    for (const ex of by['$.n'].examples) expect(['9007199254740993', '9007199254740994', '9007199254740995']).toContain(ex);
    expect(by['$.tags[*]']).toMatchObject({ as: 'tags', suggested: 'TAG' });
    expect(by['$.nested.city']).toMatchObject({ as: 'city', suggested: 'TAG' });
    expect(res.json.ignored.map((i: any) => i.name)).toContain('$.list');
  });

  it('creates an index only with a role, a confirmation and a valid definition; FT.CREATE matches the definition', async () => {
    const name = idx('hash');
    const body = {
      index: name, on: 'HASH', prefixes: [`${P}item:`],
      schema: [{ name: 'title', type: 'TEXT' }, { name: 'price', type: 'NUMERIC', sortable: true }, { name: 'category', type: 'TAG' }],
    };
    const viewer = await userSession(t, 'viewer');
    const denied = await viewer.req('POST', `${DB}/search/index/create`, body);
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('forbidden');
    // Every-key prefix and invalid definitions are refused before anything else.
    const admin = await userSession(t, 'admin');
    expect((await admin.req('POST', `${DB}/search/index/create`, { ...body, prefixes: [''] })).status).toBe(400);
    expect((await admin.req('POST', `${DB}/search/index/create`, { ...body, schema: [{ name: 'x', type: 'VECTOR' }] })).status).toBe(400);
    // Read-only databases refuse it for every role.
    const ro = await admin.req('POST', '/api/v1/databases/e2e-ro/search/index/create', body);
    expect(ro.status).toBe(403);
    expect(ro.json.error.code).toBe('read_only');
    const { first, second } = await confirmed(admin, `${DB}/search/index/create`, body);
    expect(first.json.error.confirmation.level).toBe('confirm');
    const preview = first.json.error.confirmation.preview.commands[0].argv.map((a: any) => a.v.data);
    expect(preview).toEqual(['FT.CREATE', name, 'ON', 'HASH', 'PREFIX', '1', `${P}item:`, 'SCHEMA', 'title', 'TEXT', 'price', 'NUMERIC', 'SORTABLE', 'category', 'TAG']);
    expect(first.json.error.confirmation.preview.commands[0].moreArgs).toBeUndefined();
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(second.json.argv).toEqual(preview);
    await waitIndexed(r, name, 8);
    const audit = t.ctx.audit.query({ user: admin.username, action: 'search.index.create', limit: 5 }).events;
    expect(audit[0]).toMatchObject({ outcome: 'allowed', command: 'FT.CREATE' });
    expect(JSON.stringify(audit)).not.toContain(`${P}item:`);
  });

  it('operator creation follows the Redis ACL user of the role (FT.CREATE is @search, not @write, in the sandbox)', async () => {
    const op = await userSession(t, 'operator');
    const name = idx('op');
    const { second } = await confirmed(op, `${DB}/search/index/create`, { index: name, on: 'HASH', prefixes: [`${P}item:`], schema: [{ name: 'title', type: 'TEXT' }] });
    expect(second.status).toBe(403);
    expect(second.json.error.message).toMatch(/NOPERM/);
  });

  it('prod needs the typed database name and a reason', async () => {
    const admin = await userSession(t, 'admin');
    const name = idx('prod');
    const body = { index: name, on: 'HASH', prefixes: [`${P}none:`], schema: [{ name: 'title', type: 'TEXT' }] };
    const first = await admin.req('POST', '/api/v1/databases/e2e-prod/search/index/create', body);
    expect(first.status).toBe(428);
    expect(first.json.error.confirmation).toMatchObject({ level: 'typed', reasonRequired: true, expectedText: 'E2E prod' });
  });

  it('returns the full index detail', async () => {
    const name = made[0]!;
    const v = await userSession(t, 'viewer');
    const res = await v.req('POST', `${DB}/search/index/info`, { index: name });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ name, on: 'HASH', prefixes: [`${P}item:`], numDocs: 8, indexing: false, indexingFailures: 0 });
    expect(res.json.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ identifier: 'title', attribute: 'title', type: 'TEXT' }),
      expect.objectContaining({ identifier: 'price', type: 'NUMERIC', options: expect.arrayContaining(['SORTABLE']) }),
    ]));
    expect(res.json.memory.some((m: any) => m.name === 'inverted_sz_mb')).toBe(true);
    expect(res.json.stats.some((s: any) => s.name === 'num_terms')).toBe(true);
    expect((await v.req('POST', `${DB}/search/index/info`, { index: `${name}-missing` })).status).toBe(502);
  });

  it('query options: SORTBY, RETURN, DIALECT; document ids keep their exact bytes', async () => {
    const name = made[0]!;
    const v = await userSession(t, 'viewer');
    let res = await v.req('POST', `${DB}/search/query`, { index: name, query: '@category:{toys}', sortBy: 'price', sortOrder: 'DESC', returnFields: ['title', 'price'], dialect: 2, limit: 10 });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.total).toBe(4);
    expect(res.json.docs.map((d: any) => Number(d.fields.price))).toEqual([99, 14, 12, 10]);
    expect(Object.keys(res.json.docs[1].fields).sort()).toEqual(['price', 'title']);
    const bin = res.json.docs[0];
    expect(bin.key.enc).toBe('base64');
    expect(Buffer.from(bin.key.data, 'base64')).toEqual(Buffer.from([...Buffer.from(`${P}item:`), 0xff, 0xfe]));
    expect(res.json.docs[1].key).toEqual({ enc: 'utf8', data: res.json.docs[1].id });
    res = await v.req('POST', `${DB}/search/query`, { index: name, query: '*', returnFields: [] });
    expect(res.status).toBe(400);
  });

  it('console: FT.DROPINDEX is admin + typed; DD is refused everywhere outside the Search tool', async () => {
    const op = await userSession(t, 'operator');
    let res = await cli(op, 'e2e', `FT.DROPINDEX ${made[0]}`);
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('forbidden');
    const admin = await userSession(t, 'admin');
    res = await cli(admin, 'e2e', `FT.DROPINDEX ${made[0]} DD`);
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('command_blocked');
    res = await cli(admin, 'e2e', `FT.DROPINDEX ${made[0]}`);
    expect(res.status).toBe(428);
    expect(res.json.error.confirmation.level).toBe('typed');
    const wb = await admin.req('POST', `${DB}/workbench`, { script: `FT.DROPINDEX ${made[0]} DD`, stopOnError: true });
    expect(wb.json.results[0].error.code).toBe('command_blocked');
  });

  it('drop: admin only, typed index name, documents kept; DD needs server policy', async () => {
    const name = made[0]!;
    const op = await userSession(t, 'operator');
    expect((await op.req('POST', `${DB}/search/index/drop`, { index: name })).status).toBe(403);
    const admin = await userSession(t, 'admin');
    const dd = await admin.req('POST', `${DB}/search/index/drop`, { index: name, deleteDocuments: true });
    expect(dd.status).toBe(403);
    expect(dd.json.error.message).toMatch(/disabled by server policy/);
    const first = await admin.req('POST', `${DB}/search/index/drop`, { index: name });
    expect(first.status).toBe(428);
    expect(first.json.error.confirmation).toMatchObject({ level: 'typed', expectedText: name, reasonRequired: false });
    const wrong = await admin.req('POST', `${DB}/search/index/drop`, { index: name, confirmation: { token: first.json.error.confirmation.token, typed: 'E2E' } });
    expect(wrong.status).toBe(428);
    const { second } = await confirmed(admin, `${DB}/search/index/drop`, { index: name });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(second.json.documentsDeleted).toBe(false);
    expect(await r.exists(`${P}item:0`)).toBe(1);
    expect(((await r.sendCommand(['FT._LIST'])) as string[]).map(String)).not.toContain(name);
  });

  it('with searchDropDeletesDocuments the Search tool can drop with DD', async () => {
    const raw = testConfigRaw();
    (raw.policy as Record<string, unknown>).searchDropDeletesDocuments = true;
    (raw.server as Record<string, unknown>).dataDir = mkdtempSync(path.join(tmpdir(), 'rconsole-test-'));
    const t2 = await startApp(resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } }));
    try {
      await r.hSet(`${P}gone:1`, { title: 'to be deleted' });
      const name = idx('dd');
      await r.sendCommand(['FT.CREATE', name, 'ON', 'HASH', 'PREFIX', '1', `${P}gone:`, 'SCHEMA', 'title', 'TEXT']);
      await waitIndexed(r, name, 1);
      const admin = await userSession(t2, 'admin');
      const { first, second } = await confirmed(admin, `${DB}/search/index/drop`, { index: name, deleteDocuments: true });
      expect(first.json.error.confirmation.summary).toMatch(/DELETED/);
      expect(second.status).toBe(200);
      expect(second.json.documentsDeleted).toBe(true);
      expect(await until(() => r.exists(`${P}gone:1`), (n) => n === 0)).toBe(0);
    } finally {
      await t2.close();
    }
  });
});

describe.skipIf(!sandboxUp)('insight: analysis jobs and recommendations', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('ins-analysis');

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    await r.set(`${P}big`, 'x'.repeat(ANALYSIS_RULES.bigKeyBytes + 1024));
    const fields: Record<string, string> = {};
    for (let i = 0; i < ANALYSIS_RULES.hashManyFields; i++) fields[`f${i}`] = 'v';
    await r.hSet(`${P}wide`, fields);
    await r.sAdd(`${P}members`, Array.from({ length: ANALYSIS_RULES.largeCollection }, (_, i) => `m${i}`));
    await r.set(`${P}cache:json:1`, JSON.stringify({ id: 1, payload: 'y'.repeat(2048) }));
    for (let i = 0; i < 30; i++) await r.set(`${P}cache:item:${i}`, 'v');
    const at = Math.floor(Date.now() / 1000) + 3600;
    for (let i = 0; i < 60; i++) {
      await r.set(`${P}exp:${i}`, 'v');
      await r.expireAt(`${P}exp:${i}`, at);
    }
    for (let i = 0; i < 60; i++) await r.hSet(`${P}user:${i}`, { name: `u${i}` });
    for (let i = 0; i < 12; i++) await r.set(`${P}long:${'n'.repeat(220)}:${i}`, 'v');
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('a job reports progress, finishes with recommendations qualified by the sample, and is private to its session', async () => {
    const v = await userSession(t, 'viewer');
    const start = await v.req('POST', `${DB}/analysis/jobs`, { match: `${P}*`, sampleSize: 1000, delimiter: ':' });
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    expect(start.json).toMatchObject({ state: 'running', progress: { target: 1000 } });
    const id = start.json.id;
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    const other = await userSession(t, 'viewer');
    expect((await other.req('GET', `${DB}/analysis/jobs/${id}`)).status).toBe(404);
    const done = await until(() => v.req('GET', `${DB}/analysis/jobs/${id}`), (x) => x.json.state !== 'running');
    expect(done.json.state, JSON.stringify(done.json)).toBe('done');
    const report = done.json.report;
    expect(report.sampled).toBe(166);
    expect(report.coverage).toMatchObject({ complete: true, stoppedBy: 'complete', sampled: report.sampled });
    const rec = Object.fromEntries(report.recommendations.map((x: any) => [x.id, x]));
    expect(rec.bigKeys.keys.map((k: any) => k.key.data)).toContain(`${P}big`);
    expect(rec.bigKeys.basis).toBe(report.sampled);
    expect(rec.hashTooManyFields.keys[0]).toMatchObject({ key: { data: `${P}wide` }, length: ANALYSIS_RULES.hashManyFields });
    expect(rec.largeCollections.keys[0].key.data).toBe(`${P}members`);
    expect(rec.noTtlCacheKeys.affected).toBeGreaterThanOrEqual(31);
    expect(rec.noTtlCacheKeys.prefixes.map((p: any) => p.prefix)).toContain(`${P}cache:item:`);
    expect(rec.stringJsonCouldBeRedisJson.keys.map((k: any) => k.key.data)).toEqual([`${P}cache:json:1`]);
    expect(rec.keysExpiringEnMasse).toMatchObject({ affected: 60 });
    expect(rec.longKeyNames.affected).toBe(12);
    expect(rec.searchableNamespace.search).toEqual({ prefix: `${P}user:`, on: 'HASH' });
    for (const x of report.recommendations) expect(x.detail).toMatch(/sampled/);
  });

  it('cancel stops the job with a partial report; one job per user at a time', async () => {
    const v = await userSession(t, 'viewer');
    const start = await v.req('POST', `${DB}/analysis/jobs`, { match: `${P}*`, sampleSize: 100_000 });
    const busy = await v.req('POST', `${DB}/analysis/jobs`, { match: `${P}*` });
    expect(busy.status).toBe(429);
    const cancel = await v.req('POST', `${DB}/analysis/jobs/${start.json.id}/cancel`, {});
    expect(cancel.status).toBe(200);
    const end = await until(() => v.req('GET', `${DB}/analysis/jobs/${start.json.id}`), (x) => x.json.state !== 'running');
    expect(['cancelled', 'done']).toContain(end.json.state);
    if (end.json.state === 'cancelled') expect(end.json.report.coverage.stoppedBy).toBe('cancelled');
    expect((await v.req('GET', `${DB}/analysis/jobs/nope`)).status).toBe(404);
  });

  it('runs on a read-only database for a viewer', async () => {
    const v = await userSession(t, 'viewer');
    const start = await v.req('POST', '/api/v1/databases/e2e-ro/analysis/jobs', { match: `${P}cache:*`, sampleSize: 100 });
    expect(start.status).toBe(200);
    const done = await until(() => v.req('GET', `/api/v1/databases/e2e-ro/analysis/jobs/${start.json.id}`), (x) => x.json.state !== 'running');
    expect(done.json.state).toBe('done');
    expect(done.json.report.sampled).toBe(31);
  });
});

describe.skipIf(!sandboxUp)('insight: import jobs', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('ins-import');
  const IMP = `${DB}/import`;

  beforeAll(async () => {
    t = await startApp(testConfig());
    r = await sandboxAdmin();
  });
  afterAll(async () => {
    await r?.sendCommand(['UNLINK', Buffer.from([...Buffer.from(`${P}bin`), 0xff])]).catch(() => {});
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  const start = async (c: Client, id: string, body: Record<string, unknown> = {}, db = DB) => confirmed(c, `${db}/import/${id}/start`, body);
  const wait = (c: Client, id: string, db = DB) => until(() => c.req('GET', `${db}/import/${id}`), (x) => !['running', 'planned'].includes(x.json.state));

  it('plans with per-line policy, runs after one confirmation, and summarises failures per command', async () => {
    const op = await userSession(t, 'operator');
    const script = [
      '# seed file',
      `SET ${P}a 1`,
      '',
      `HSET ${P}h f "two words"`,
      `INCR ${P}a`,
      `LPUSH ${P}a x`,
      `LPUSH ${P}a y`,
      `GET ${P}a`,
      `"SET" "${P}bin\\xff" "\\x00\\x01"`,
      '// done',
    ].join('\r\n');
    const plan = await op.req('POST', IMP, { script, fileName: 'seed.redis' });
    expect(plan.status, JSON.stringify(plan.json)).toBe(200);
    expect(plan.json).toMatchObject({ total: 7, counts: { read: 1, write: 6, admin: 0, blocked: 0 }, destructive: 0, blocked: [], confirmation: 'confirm', fileName: 'seed.redis' });
    const other = await userSession(t, 'operator');
    expect((await other.req('GET', `${IMP}/${plan.json.id}`)).status).toBe(404);
    const { first, second } = await start(op, plan.json.id);
    expect(first.json.error.confirmation.summary).toMatch(/Import 7 commands/);
    expect(first.json.error.confirmation.preview.total).toBe(6);
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    const done = await wait(op, plan.json.id);
    expect(done.json).toMatchObject({ state: 'done', total: 7, processed: 7, succeeded: 5, failed: 2, skipped: 0 });
    expect(done.json.failures).toEqual([{ command: 'LPUSH', code: 'redis_error', message: expect.stringMatching(/^WRONGTYPE/), count: 2, lines: [6, 7] }]);
    expect(await r.get(`${P}a`)).toBe('2');
    expect(await r.hGet(`${P}h`, 'f')).toBe('two words');
    // \xHH escapes reach Redis as raw bytes (byte-exact key and value).
    const binKey = Buffer.from([...Buffer.from(`${P}bin`), 0xff]);
    expect(await r.exists(binKey)).toBe(1);
    expect(Buffer.from(String(await r.sendCommand(['STRLEN', binKey])))).toEqual(Buffer.from('2'));
    const events = t.ctx.audit.query({ user: op.username, action: 'import.exec', limit: 50 }).events;
    expect(events.filter((e) => e.outcome === 'allowed')).toHaveLength(5);
    expect(events.filter((e) => e.outcome === 'error')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('two words');
    expect(t.ctx.audit.query({ user: op.username, action: 'import.finish', limit: 1 }).events[0]).toMatchObject({ outcome: 'allowed' });
  });

  it('refused lines block the start unless skipped; a viewer cannot import (review v0.2.1 F1)', async () => {
    const v = await userSession(t, 'viewer');
    expect((await v.req('POST', IMP, { script: `GET ${P}a` })).status).toBe(403);
    const op = await userSession(t, 'operator');
    const plan = await op.req('POST', IMP, { script: `GET ${P}a\nKEYS *\nCONFIG SET maxmemory 1\nFLUSHALL\n"unbalanced` });
    expect(plan.status).toBe(200);
    expect(plan.json.counts).toEqual({ read: 1, write: 0, admin: 0, blocked: 4 });
    expect(plan.json.blocked.map((b: any) => b.line)).toEqual([2, 3, 4, 5]);
    expect(plan.json.blocked[1]).toMatchObject({ command: 'CONFIG SET', reason: expect.stringMatching(/blocked by policy/) });
    expect(plan.json.confirmation).toBe('none');
    const refused = await op.req('POST', `${IMP}/${plan.json.id}/start`, {});
    expect(refused.status).toBe(400);
    const ok = await op.req('POST', `${IMP}/${plan.json.id}/start`, { skipBlocked: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const done = await wait(op, plan.json.id);
    expect(done.json).toMatchObject({ state: 'done', succeeded: 1, skipped: 4, failed: 0 });
    // The unparseable line has no command to audit; the three refused commands are audited as denied.
    expect(t.ctx.audit.query({ user: op.username, action: 'import.exec', outcome: 'denied', limit: 10 }).events.length).toBe(3);
  });

  it('read-only databases refuse writes for every role; prod asks for the typed name and a reason', async () => {
    const admin = await userSession(t, 'admin');
    const ro = await admin.req('POST', '/api/v1/databases/e2e-ro/import', { script: `SET ${P}ro 1` });
    expect(ro.json.counts.blocked).toBe(1);
    expect(ro.json.blocked[0].reason).toMatch(/read-only/);
    const prod = await admin.req('POST', '/api/v1/databases/e2e-prod/import', { script: `SET ${P}prod 1\nDEL ${P}prod` });
    expect(prod.json).toMatchObject({ confirmation: 'typed', destructive: 1 });
    const first = await admin.req('POST', `/api/v1/databases/e2e-prod/import/${prod.json.id}/start`, {});
    expect(first.status).toBe(428);
    expect(first.json.error.confirmation).toMatchObject({ level: 'typed', reasonRequired: true, expectedText: 'E2E prod' });
    // The destructive command is listed first.
    expect(first.json.error.confirmation.preview.commands[0].argv[0].v.data).toBe('DEL');
    const { second } = await start(admin, prod.json.id, {}, '/api/v1/databases/e2e-prod');
    expect(second.status).toBe(200);
    expect((await wait(admin, prod.json.id, '/api/v1/databases/e2e-prod')).json).toMatchObject({ state: 'done', succeeded: 2 });
  });

  it('stop on error, cancel, limits and a token bound to the options', async () => {
    const op = await userSession(t, 'operator');
    let plan = await op.req('POST', IMP, { script: `SET ${P}s 1\nLPUSH ${P}s x\nSET ${P}after 1` });
    const { first, second } = await start(op, plan.json.id, { stopOnError: true });
    expect(first.status).toBe(428);
    expect(second.status).toBe(200);
    const stopped = await wait(op, plan.json.id);
    expect(stopped.json).toMatchObject({ state: 'stopped', succeeded: 1, failed: 1, skipped: 1 });
    expect(await r.exists(`${P}after`)).toBe(0);
    // A confirmation for one set of options does not start another.
    plan = await op.req('POST', IMP, { script: `SET ${P}t 1` });
    const ch = await op.req('POST', `${IMP}/${plan.json.id}/start`, { stopOnError: true });
    const swapped = await op.req('POST', `${IMP}/${plan.json.id}/start`, { stopOnError: false, confirmation: { token: ch.json.error.confirmation.token } });
    expect(swapped.status).toBe(428);
    // Cancel before it starts: nothing runs.
    const cancelled = await op.req('POST', `${IMP}/${plan.json.id}/cancel`, {});
    expect(cancelled.json.state).toBe('cancelled');
    expect((await op.req('POST', `${IMP}/${plan.json.id}/start`, {})).status).toBe(400);
    // Cancel while running: later commands are not sent.
    const many = Array.from({ length: 3000 }, (_, i) => `SET ${P}m:${i} ${i}`).join('\n');
    plan = await op.req('POST', IMP, { script: many });
    expect(plan.json.total, JSON.stringify(plan.json)).toBe(3000);
    await new Promise((res) => setTimeout(res, 1500)); // the start rate limit (2/s, burst 6) is for people
    expect((await start(op, plan.json.id)).second.status).toBe(200);
    await until(() => op.req('GET', `${IMP}/${plan.json.id}`), (x) => x.json.processed > 5);
    const c = await op.req('POST', `${IMP}/${plan.json.id}/cancel`, {});
    expect(c.status).toBe(200);
    const end = await wait(op, plan.json.id);
    expect(end.json.state).toBe('cancelled');
    expect(end.json.processed).toBeLessThan(3000);
    expect(end.json.processed + end.json.skipped + (end.json.inFlightLine ? 1 : 0)).toBe(3000);
    // Bounds.
    await new Promise((res) => setTimeout(res, 2500));
    expect((await op.req('POST', IMP, { script: '# nothing\n\n' })).status).toBe(400);
    expect((await op.req('POST', IMP, { script: Array.from({ length: 10_001 }, () => 'PING').join('\n') })).status).toBe(400);
  });

  it('at most four imports run at once on the server (each keeps one command in flight)', async () => {
    const users = await Promise.all([1, 2, 3, 4, 5].map(() => userSession(t, 'operator')));
    const plans = [];
    for (const [i, u] of users.entries()) plans.push(await u.req('POST', IMP, { script: Array.from({ length: 1500 }, (_, j) => `SET ${P}g${i}:${j} 1`).join('\n') }));
    const started = [];
    for (const [i, u] of users.slice(0, 4).entries()) started.push((await start(u, plans[i]!.json.id)).second.status);
    expect(started).toEqual([200, 200, 200, 200]);
    const fifth = await users[4]!.req('POST', `${IMP}/${plans[4]!.json.id}/start`, {});
    expect(fifth.status).toBe(429);
    expect(fifth.json.error.message).toMatch(/4 imports are running/);
    for (const [i, u] of users.slice(0, 4).entries()) await u.req('POST', `${IMP}/${plans[i]!.json.id}/cancel`, {});
    for (const [i, u] of users.slice(0, 4).entries()) await wait(u, plans[i]!.json.id);
    // A slot is free again, and the refused start did not spend a confirmation.
    expect((await start(users[4]!, plans[4]!.json.id)).second.status).toBe(200);
    await users[4]!.req('POST', `${IMP}/${plans[4]!.json.id}/cancel`, {});
    await wait(users[4]!, plans[4]!.json.id);
  });

  it('stops when the account is disabled while it runs', async () => {
    const op = await userSession(t, 'operator');
    const plan = await op.req('POST', IMP, { script: Array.from({ length: 2000 }, (_, i) => `SET ${P}rev:${i} ${i}`).join('\n') });
    await start(op, plan.json.id);
    await until(() => op.req('GET', `${IMP}/${plan.json.id}`), (x) => x.json.processed > 5);
    t.ctx.users.update(op.userId, { disabled: true });
    const end = await until(async () => t.ctx.audit.query({ user: op.username, action: 'import.finish', limit: 1 }).events[0], (e) => !!e);
    expect(end?.detail).toMatch(/^failed/);
    let sent = 0;
    for await (const keys of r.scanIterator({ MATCH: `${P}rev:*`, COUNT: 1000 })) sent += keys.length;
    expect(sent).toBeLessThan(2000);
  });
});
