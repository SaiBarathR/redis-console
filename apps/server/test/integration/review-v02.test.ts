/**
 * Regression tests for the v0.2 server review, round 1 (docs/REVIEW-LOG.md), against the disposable sandbox (6411).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyTag } from '../../src/audit.ts';
import { bk, cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, testConfig, userSession, type Client, type TestApp } from '../helpers.ts';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;
const CLI = '/api/v1/databases/e2e/cli';
const str = (res: { json: any }) => Buffer.from(res.json.reply.v.data, res.json.reply.v.enc === 'base64' ? 'base64' : 'utf8').toString();

describe.skipIf(!sandboxUp)('review v0.2 H1 / L1: RedisJSON reads are sized by what they return', () => {
  let t: TestApp;
  let small: TestApp;
  let r: Admin;
  let v: Client;
  const P = keyPrefix('rv2json');
  beforeAll(async () => {
    t = await startApp();
    const cfg = testConfig();
    cfg.policy.maxReplyBytes = 4096;
    cfg.policy.maxReadReplyBytes = 64 * 1024; // preflight budget 64 KiB
    small = await startApp(cfg);
    r = await sandboxAdmin();
    v = await userSession(t, 'viewer');
    await r.sendCommand(['JSON.SET', `${P}ones`, '$', JSON.stringify(Array(128).fill(1))]);
    await r.sendCommand(['JSON.SET', `${P}many`, '$', JSON.stringify(Array(100_001).fill(1))]);
    await r.sendCommand(['JSON.SET', `${P}doc`, '$', JSON.stringify({ id: 1, name: 'x', items: [{ name: 'a' }, { name: 'b' }] })]);
    await r.sendCommand(['JSON.SET', `${P}big`, '$', JSON.stringify({ id: 1, payload: 'p'.repeat(100_000) })]);
  }, 60_000);
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await small?.close();
    await cleanupPrefix(P);
  });

  it('JSON.GET with a huge INDENT is refused before Redis builds the reply; short formatting still works', async () => {
    const res = await v.req('POST', CLI, { argv: ['JSON.GET', `${P}ones`, 'INDENT', ' '.repeat(140_000), '$'] });
    expect(res.status).toBe(413);
    expect(res.json.error.code).toBe('too_large');
    const argv = ['JSON.GET', `${P}doc`, 'INDENT', '  ', 'NEWLINE', '\n', 'SPACE', ' ', '$'];
    const ok = await v.req('POST', CLI, { argv });
    expect(ok.status).toBe(200);
    expect(str(ok)).toBe(String(await r.sendCommand(argv)));
  });

  it('per-match JSON reads with a fan-out larger than 100k elements are refused; definite paths are not', async () => {
    const res = await v.req('POST', CLI, { argv: ['JSON.TYPE', `${P}many`, '$[*]'] });
    expect(res.status).toBe(413);
    expect((await v.req('POST', CLI, { argv: ['JSON.TYPE', `${P}many`, '$[0]'] })).status).toBe(200);
    expect((await v.req('POST', CLI, { argv: ['JSON.ARRLEN', `${P}many`] })).status).toBe(200);
    // Everyday reads: whole document, a slice, recursive descent and several paths on a small document.
    for (const argv of [['JSON.GET', `${P}doc`], ['JSON.GET', `${P}many`, '$[0:5]'], ['JSON.GET', `${P}doc`, '$..name'], ['JSON.GET', `${P}doc`, '$.id', '$.items[*].name'], ['JSON.TYPE', `${P}doc`, '$.items[*]'], ['JSON.OBJKEYS', `${P}doc`]]) {
      const ok = await v.req('POST', CLI, { argv });
      expect(ok.status, argv.join(' ')).toBe(200);
      expect(ok.json.reply.t, argv.join(' ')).not.toBe('err');
    }
  });

  it('L1: a definite path into a document larger than the budget is sized by the selected value', async () => {
    const sv = await userSession(small, 'viewer');
    const id = await sv.req('POST', CLI, { argv: ['JSON.GET', `${P}big`, '$.id'] });
    expect(id.status).toBe(200);
    expect(str(id)).toBe('[1]');
    expect((await sv.req('POST', CLI, { argv: ['JSON.GET', `${P}big`, '.id'] })).status).toBe(200);
    expect((await sv.req('POST', CLI, { argv: ['JSON.GET', `${P}big`] })).status).toBe(413);
    expect((await sv.req('POST', CLI, { argv: ['JSON.GET', `${P}big`, '$.payload'] })).status).toBe(413);
  });

  it('L1: SUNIONCARD (a scalar cardinality read) runs', async () => {
    await r.sAdd(`${P}sa`, ['x', 'y']);
    await r.sAdd(`${P}sb`, ['y', 'z']);
    const res = await v.req('POST', CLI, { argv: ['SUNIONCARD', '2', `${P}sa`, `${P}sb`] });
    expect(res.status).toBe(200);
    expect(res.json.reply).toEqual({ t: 'int', v: '3' });
  });
});

describe.skipIf(!sandboxUp)('review v0.2 M1: search options are parsed with the grammar', () => {
  let t: TestApp;
  let r: Admin;
  let v: Client;
  const P = keyPrefix('rv2ft');
  const idx = `${P}idx`;
  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    v = await userSession(t, 'viewer');
    await r.sendCommand(['FT.CREATE', idx, 'ON', 'HASH', 'PREFIX', '1', `${P}doc:`, 'SCHEMA', 'text', 'TEXT']);
    await r.hSet(`${P}doc:1`, { text: 'LIMIT ordinary' });
    await r.hSet(`${P}doc:2`, { text: 'NOCONTENT words' });
  }, 60_000);
  afterAll(async () => {
    await r?.sendCommand(['FT.DROPINDEX', idx]).catch(() => {});
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });
  const cli = (...argv: string[]) => v.req('POST', CLI, { argv });

  it('query text or a PARAMS value "NOCONTENT" does not affect measured reply limits', async () => {
    expect((await cli('FT.SEARCH', idx, 'NOCONTENT', 'LIMIT', '0', '1001')).status).toBe(200);
    expect((await cli('FT.SEARCH', idx, '*', 'PARAMS', '2', 'unused', 'NOCONTENT', 'LIMIT', '0', '1001', 'DIALECT', '2')).status).toBe(200);
    expect((await cli('FT.SEARCH', idx, '*', 'NOCONTENT', 'LIMIT', '0', '1001')).status).toBe(200);
  });

  it('valid searches for the word LIMIT (query or parameter) run', async () => {
    const q = await cli('FT.SEARCH', idx, 'LIMIT');
    expect(q.status).toBe(200);
    expect(JSON.stringify(q.json.reply)).toContain('ordinary');
    expect((await cli('FT.SEARCH', idx, '*', 'PARAMS', '2', 'q', 'LIMIT', 'DIALECT', '2')).status).toBe(200);
    expect((await cli('FT.AGGREGATE', idx, 'LIMIT', 'LIMIT', '0', '10')).status).toBe(200);
  });
});

describe.skipIf(!sandboxUp)('review v0.2 M2: the search endpoint keeps the reply budgets', () => {
  let t: TestApp;
  let tight: TestApp;
  let r: Admin;
  const P = keyPrefix('rv2srch');
  const idx = `${P}idx`;
  const MAX = 1_048_576;
  beforeAll(async () => {
    t = await startApp();
    const cfg = testConfig();
    cfg.policy.maxReplyBytes = 16_384; // read budget 256 KiB: about three of the 82 KB documents below
    tight = await startApp(cfg);
    r = await sandboxAdmin();
    await r.sendCommand(['FT.CREATE', idx, 'ON', 'HASH', 'PREFIX', '1', `${P}doc:`, 'SCHEMA', 'text', 'TEXT']);
    for (let i = 0; i < 20; i++) {
      await r.hSet(`${P}doc:${String(i).padStart(2, '0')}`, { text: `doc ${i}`, ...Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`payload${j}`, String(j % 10).repeat(4096)])) });
    }
  }, 60_000);
  afterAll(async () => {
    await r?.sendCommand(['FT.DROPINDEX', idx]).catch(() => {});
    await r?.close();
    await t?.close();
    await tight?.close();
    await cleanupPrefix(P);
  });

  it('a page of wide documents stays within maxReplyBytes, listing every document and flagging what was cut', async () => {
    const v = await userSession(t, 'viewer');
    const res = await v.req('POST', '/api/v1/databases/e2e/search/query', { index: idx, query: '*', limit: 20 });
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(20);
    expect(res.json.docs).toHaveLength(20);
    expect(Buffer.byteLength(res.body)).toBeLessThan(MAX + 64 * 1024);
    expect(res.json.docs.some((d: { truncated?: boolean }) => d.truncated)).toBe(true);
    expect(res.json.docs[0].fields.text).toMatch(/^doc \d+$/);
  });

  it('the display budget lists ids and flags fields withheld after a measured read', async () => {
    const v = await userSession(tight, 'viewer');
    const res = await v.req('POST', '/api/v1/databases/e2e/search/query', { index: idx, query: '*', limit: 20 });
    expect(res.status).toBe(200);
    expect(res.json.docs).toHaveLength(20);
    expect(Buffer.byteLength(res.body)).toBeLessThan(16_384 + 8 * 1024);
    type Doc = { id: string; fields: Record<string, string>; truncated?: boolean };
    const docs = res.json.docs as Doc[];
    expect(new Set(docs.map((d) => d.id)).size).toBe(20);
    const unread = docs.filter((d) => !Object.keys(d.fields).length);
    expect(unread.length).toBeGreaterThanOrEqual(15); // ~82 KB each, 256 KiB read budget
    for (const d of unread) expect(d.truncated).toBe(true);
    expect(Object.keys(docs[0]!.fields).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!sandboxUp)('review v0.2 M3: a stuck command replaces only its own socket (real Redis)', () => {
  const P = keyPrefix('rv2stuck');
  it('commands in flight on other pooled sockets finish, and the replacement signs in as the same ACL user', async () => {
    const { RedisManager } = await import('../../src/redis/manager.ts');
    const { TimeoutError } = await import('redis');
    const logs: string[] = [];
    const mgr = new RedisManager(testConfig().databases, (m) => logs.push(m));
    try {
      const conn = await mgr.conn('e2e', 'viewer');
      // XREAD BLOCK 0 never answers (sent directly, without the console's block cap).
      const stuck = expect(conn.send(['XREAD', 'BLOCK', '0', 'STREAMS', `${P}never`, '$'], { timeout: 200 })).rejects.toBeInstanceOf(TimeoutError);
      await new Promise((r) => setTimeout(r, 30));
      const other = conn.send(['XREAD', 'BLOCK', '1000', 'STREAMS', `${P}other`, '$'], { timeout: 3000 });
      await stuck;
      await expect(other).resolves.toBeNull();
      expect(logs).toEqual([]); // capped transport destroys only its exclusive socket
      expect(await mgr.conn('e2e', 'viewer')).toBe(conn);
      const infos = await Promise.all(Array.from({ length: 4 }, () => conn.send(['CLIENT', 'INFO'], { timeout: 2000 })));
      for (const i of infos) expect(String(i)).toMatch(/ name=rconsole-viewer-capped .* user=rc-viewer /);
    } finally {
      await mgr.closeAll();
    }
  });
});

describe.skipIf(!sandboxUp)('review v0.2 M6: key-browser and feature reads are audited (one event per request, no data)', () => {
  let t: TestApp;
  let r: Admin;
  let v: Client;
  const P = keyPrefix('rv2audit');
  const CANARY = 'rv2-audit-canary-value';
  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    v = await userSession(t, 'viewer');
    await r.set(`${P}str`, CANARY);
    await r.hSet(`${P}hash`, { f: CANARY });
    await r.xAdd(`${P}stream`, '*', { f: CANARY });
    await r.sendCommand(['XGROUP', 'CREATE', `${P}stream`, 'grp', '0']);
    await r.sendCommand(['TS.ADD', `${P}ts`, '1000', '1.5']);
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });
  const events = () => t.ctx.audit.query({ limit: 1000 }).events;
  async function oneEvent(path: string, body: unknown) {
    const before = events().length;
    const res = await v.req('POST', `/api/v1/databases/e2e/${path}`, body);
    const added = events().slice(0, events().length - before);
    expect(added, path).toHaveLength(1);
    const text = JSON.stringify(added) + t.auditLines.join('');
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(P);
    return { res, ev: added[0]! };
  }

  it('reads of every type, scans and stream/time-series reads record who read which key (hashed)', async () => {
    const cases: [string, unknown, string, string][] = [
      ['key/read', { key: bk(`${P}str`) }, 'key.read', `${P}str`],
      ['key/read', { key: bk(`${P}hash`) }, 'key.read', `${P}hash`],
      ['streams/groups', { key: bk(`${P}stream`) }, 'stream.groups', `${P}stream`],
      ['streams/pending', { key: bk(`${P}stream`), group: 'grp' }, 'stream.pending', `${P}stream`],
      ['timeseries/range', { key: bk(`${P}ts`) }, 'timeseries.range', `${P}ts`],
    ];
    for (const [path, body, action, key] of cases) {
      const { res, ev } = await oneEvent(path, body);
      expect(res.status, path).toBe(200);
      expect(ev).toMatchObject({ action, outcome: 'allowed', databaseId: 'e2e', username: v.username, keyCount: 1 });
      expect(ev.argvRedacted).toContain(keyTag(key));
    }
    const scan = await oneEvent('keys/scan', { match: `${P}*`, count: 100 });
    expect(scan.res.status).toBe(200);
    expect(scan.ev).toMatchObject({ action: 'key.scan', outcome: 'allowed', command: 'SCAN' });
    expect(scan.ev.detail).toMatch(/^keys=\d+ scanned=\d+$/);
  });

  it('failed reads are recorded too (missing key, wrong type, unknown index)', async () => {
    const missing = await oneEvent('key/read', { key: bk(`${P}missing`) });
    expect(missing.res.status).toBe(404);
    expect(missing.ev).toMatchObject({ action: 'key.read', outcome: 'denied' });
    const wrong = await oneEvent('streams/pending', { key: bk(`${P}str`), group: 'grp' });
    expect(wrong.res.status).toBe(502);
    expect(wrong.ev).toMatchObject({ action: 'stream.pending', outcome: 'error', detail: 'redis_error: WRONGTYPE' });
    const search = await oneEvent('search/query', { index: `${P}no-such-index`, query: '*' });
    expect(search.res.status).toBe(502);
    expect(search.ev).toMatchObject({ action: 'search.query', outcome: 'error' });
  });
});
