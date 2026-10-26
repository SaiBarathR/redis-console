/**
 * Regression tests for the v0.2 server review, round 2 (docs/REVIEW-LOG.md), against the disposable sandbox (6411).
 * Budgets: maxReplyBytes 1 MiB -> 16 MiB read budget by default; `tight` apps use 16 KiB -> 256 KiB.
 */
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loggerOptions } from '../../src/app.ts';
import { cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, testConfig, userSession, type Client, type TestApp } from '../helpers.ts';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;
const CLI = '/api/v1/databases/e2e/cli';
const SEARCH = '/api/v1/databases/e2e/search/query';
const TIGHT = 16_384; // maxReplyBytes of the tight apps: read budget 256 KiB
const str = (res: { json: any }) => Buffer.from(res.json.reply.v.data, res.json.reply.v.enc === 'base64' ? 'base64' : 'utf8').toString();
const ctl = (n: number) => '\u0001'.repeat(n);

async function tightApp(): Promise<TestApp> {
  const cfg = testConfig();
  cfg.policy.maxReplyBytes = TIGHT;
  cfg.policy.maxReadReplyBytes = 16 * TIGHT;
  return startApp(cfg);
}

describe.skipIf(!sandboxUp)('review v0.2 R2-H1: JSON text is sized with its escaping', () => {
  let t: TestApp;
  let tight: TestApp;
  let r: Admin;
  let v: Client;
  let tv: Client;
  const P = keyPrefix('r2json');
  beforeAll(async () => {
    t = await startApp();
    tight = await tightApp();
    r = await sandboxAdmin();
    v = await userSession(t, 'viewer');
    tv = await userSession(tight, 'viewer');
    // The reviewer's document: 3 MiB of control characters, about 3 MiB in memory, 18 MiB as JSON text.
    await r.sendCommand(['JSON.SET', `${P}ctl`, '$', JSON.stringify({ id: 1, data: ctl(3 * 1024 * 1024) })]);
    // Object names are stored once but serialized at every occurrence, escaped.
    await r.sendCommand(['JSON.SET', `${P}names`, '$', JSON.stringify(Array.from({ length: 60 }, () => ({ [ctl(1024)]: 1 })))]);
    await r.sendCommand(['JSON.SET', `${P}m1`, '$', JSON.stringify({ data: ctl(30_000) })]);
    await r.sendCommand(['JSON.SET', `${P}m2`, '$', JSON.stringify({ data: ctl(30_000) })]);
    await r.sendCommand(['JSON.SET', `${P}small`, '$', JSON.stringify({ id: 7, note: `tab\there ${ctl(16)}`, items: [{ name: 'a' }, { name: 'b' }] })]);
  }, 60_000);
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await tight?.close();
    await cleanupPrefix(P);
  });

  it('JSON.GET of a document whose JSON text exceeds the read budget is refused before it is read', async () => {
    const res = await v.req('POST', CLI, { argv: ['JSON.GET', `${P}ctl`] });
    expect(res.status).toBe(413);
    expect(res.json.error.code).toBe('too_large');
    expect((await v.req('POST', CLI, { argv: ['JSON.GET', `${P}ctl`, '$.data'] })).status).toBe(413);
    // A small projection of the same document still works.
    const id = await v.req('POST', CLI, { argv: ['JSON.GET', `${P}ctl`, '$.id'] });
    expect(id.status).toBe(200);
    expect(str(id)).toBe('[1]');
  });

  it('the key browser does not read a document whose JSON text exceeds the read budget ("load full value")', async () => {
    const res = await v.req('POST', '/api/v1/databases/e2e/key/read', { key: { enc: 'utf8', data: `${P}ctl` }, full: true });
    expect(res.status).toBe(413);
    expect(res.json.error.code).toBe('too_large');
    const small = await v.req('POST', '/api/v1/databases/e2e/key/read', { key: { enc: 'utf8', data: `${P}small` }, full: true });
    expect(small.json.value.json).toBe(String(await r.sendCommand(['JSON.GET', `${P}small`])));
  });

  it('escaped object names and JSON.MGET are sized as JSON text too', async () => {
    expect((await tv.req('POST', CLI, { argv: ['JSON.GET', `${P}names`] })).status).toBe(413);
    expect((await tv.req('POST', CLI, { argv: ['JSON.MGET', `${P}m1`, `${P}m2`, '$'] })).status).toBe(413);
    expect((await tv.req('POST', CLI, { argv: ['JSON.MGET', `${P}small`, `${P}m1`, '$.id'] })).status).toBe(200);
  });

  it('everyday JSON reads (with escapes) still return the exact document', async () => {
    for (const argv of [['JSON.GET', `${P}small`], ['JSON.GET', `${P}small`, '$'], ['JSON.GET', `${P}small`, '$..name'], ['JSON.GET', `${P}small`, 'INDENT', '  ', 'NEWLINE', '\n', '$']]) {
      const res = await v.req('POST', CLI, { argv });
      expect(res.status, argv.join(' ')).toBe(200);
      expect(str(res), argv.join(' ')).toBe(String(await r.sendCommand(argv)));
    }
  });
});

describe.skipIf(!sandboxUp)('review v0.2 R2-M1 / R2-L1: console searches are sized in bytes before they run', () => {
  let tight: TestApp;
  let r: Admin;
  let v: Client;
  const P = keyPrefix('r2ft');
  const idx = `${P}idx`;
  const jidx = `${P}jidx`;
  beforeAll(async () => {
    tight = await tightApp();
    r = await sandboxAdmin();
    v = await userSession(tight, 'viewer');
    await r.sendCommand(['FT.CREATE', idx, 'ON', 'HASH', 'PREFIX', '1', `${P}doc:`, 'SCHEMA', 'text', 'TEXT', 'cat', 'TAG', 'n', 'NUMERIC', 'SORTABLE']);
    await r.sendCommand(['FT.CREATE', jidx, 'ON', 'JSON', 'PREFIX', '1', `${P}json:`, 'SCHEMA', '$.text', 'AS', 'text', 'TEXT']);
    // One wide document (300 KB, over the 256 KiB read budget) among ordinary ones.
    await r.hSet(`${P}doc:wide`, { text: 'oversize', cat: 'big', n: '1', payload: 'p'.repeat(300_000) });
    for (let i = 0; i < 5; i++) await r.hSet(`${P}doc:${i}`, { text: `hello world ${i}`, cat: i % 2 ? 'odd' : 'even', n: String(i) });
    // A JSON document that is small in memory (60 KB) and large as JSON text (360 KB).
    await r.sendCommand(['JSON.SET', `${P}json:ctl`, '$', JSON.stringify({ text: 'escaped', data: ctl(60_000) })]);
    await r.sendCommand(['JSON.SET', `${P}json:ok`, '$', JSON.stringify({ text: 'fine', data: 'plain' })]);
    await new Promise((res) => setTimeout(res, 300));
  }, 60_000);
  afterAll(async () => {
    for (const i of [idx, jidx]) await r?.sendCommand(['FT.DROPINDEX', i]).catch(() => {});
    await r?.close();
    await tight?.close();
    await cleanupPrefix(P);
  });
  let calls = 0;
  // A fresh session every 15 commands: the console allows 20 commands per second per user.
  const cli = async (...argv: string[]) => {
    if (++calls % 15 === 0) v = await userSession(tight, 'viewer');
    return v.req('POST', CLI, { argv });
  };

  it('one matching wide document no longer passes on its row count (FT.SEARCH, FT.PROFILE, FT.AGGREGATE)', async () => {
    for (const argv of [
      ['FT.SEARCH', idx, 'oversize', 'LIMIT', '0', '1'],
      ['FT.SEARCH', jidx, 'escaped'],
      ['FT.PROFILE', idx, 'SEARCH', 'QUERY', 'oversize', 'LIMIT', '0', '1'],
      ['FT.AGGREGATE', idx, 'oversize', 'LOAD', '1', '@payload', 'LIMIT', '0', '1'],
      ['FT.AGGREGATE', idx, '*', 'LOAD', '1', '@payload', 'GROUPBY', '0', 'REDUCE', 'TOLIST', '1', '@payload', 'AS', 'all', 'LIMIT', '0', '1'],
    ]) {
      const res = await cli(...argv);
      expect(res.status, argv.join(' ')).toBe(413);
      expect(res.json.error.code).toBe('too_large');
    }
  });

  it('formerly unsized forms run when their actual reply fits; oversized projections fail', async () => {
    expect((await cli('FT.AGGREGATE', idx, 'hello', 'LOAD', '*', 'LIMIT', '0', '1')).status).toBe(200);
    expect((await cli('FT.AGGREGATE', idx, '*', 'LOAD', '1', '@text', 'APPLY', 'upper(@text)', 'AS', 'u', 'LIMIT', '0', '1')).status).toBe(200);
    expect((await cli('FT.AGGREGATE', idx, '*', 'WITHCURSOR', 'COUNT', '10')).status).toBe(200);
    expect((await cli('FT.SEARCH', idx, 'hello', 'EXPLAINSCORE', 'WITHSCORES')).status).toBe(200);
    expect((await cli('FT.SEARCH', idx, 'hello', 'HIGHLIGHT', 'TAGS', '<'.repeat(9), '>')).status).toBe(200);
    expect((await cli('FT.CURSOR', 'READ', idx, '1')).status).toBe(200);
    expect((await cli('FT.HYBRID', idx, 'SEARCH', '*')).status).toBe(200);
    const ids = await cli('FT.SEARCH', idx, 'oversize', 'NOCONTENT');
    expect(ids.status).toBe(200);
    expect(JSON.stringify(ids.json.reply)).toContain('doc:wide');
    // A small projection of the wide document is measured exactly, so it runs; the wide field itself does not.
    const ret = await cli('FT.SEARCH', idx, 'oversize', 'RETURN', '1', 'cat');
    expect(ret.status).toBe(200);
    expect(JSON.stringify(ret.json.reply)).toContain('big');
    expect((await cli('FT.SEARCH', idx, 'oversize', 'RETURN', '1', 'payload')).status).toBe(413);
  });

  it('everyday searches and aggregations return what Redis returns', async () => {
    const same = async (...argv: string[]) => {
      const res = await cli(...argv);
      expect(res.status, argv.join(' ')).toBe(200);
      expect(res.json.reply.t, argv.join(' ')).not.toBe('err');
      return res;
    };
    await same('FT.SEARCH', idx, 'hello');
    await same('FT.SEARCH', idx, 'hello', 'LIMIT', '0', '3', 'SORTBY', 'n', 'DESC', 'WITHSCORES');
    await same('FT.SEARCH', idx, 'hello', 'RETURN', '2', 'text', 'cat', 'HIGHLIGHT', 'SUMMARIZE');
    await same('FT.SEARCH', idx, '@cat:{odd}', 'DIALECT', '2');
    await same('FT.SEARCH', idx, '@text:$q', 'PARAMS', '2', 'q', 'hello', 'DIALECT', '2');
    await same('FT.SEARCH', jidx, 'fine');
    await same('FT.PROFILE', idx, 'SEARCH', 'QUERY', 'hello', 'LIMIT', '0', '20');
    const agg = await same('FT.AGGREGATE', idx, 'hello', 'GROUPBY', '1', '@cat', 'REDUCE', 'COUNT', '0', 'AS', 'count', 'SORTBY', '2', '@count', 'DESC', 'LIMIT', '0', '10');
    expect(JSON.stringify(agg.json.reply)).toContain('even');
    await same('FT.AGGREGATE', idx, 'hello', 'LOAD', '2', '@text', '@n', 'APPLY', '@n * 2', 'AS', 'twice', 'APPLY', 'format("%s!", @text)', 'AS', 'shout', 'SORTBY', '2', '@twice', 'DESC', 'LIMIT', '0', '5');
    await same('FT.AGGREGATE', idx, '*', 'GROUPBY', '1', '@cat', 'REDUCE', 'TOLIST', '1', '@text', 'AS', 'texts', 'REDUCE', 'FIRST_VALUE', '1', '@text', 'AS', 'first', 'LIMIT', '0', '10');
  });

  it('R2-L1: FORMAT STRING (the default) runs; FORMAT EXPAND uses the same measured cap', async () => {
    const res = await cli('FT.SEARCH', idx, 'hello', 'FORMAT', 'STRING');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json.reply)).toContain('hello world');
    expect((await cli('FT.SEARCH', jidx, 'fine', 'FORMAT', 'EXPAND')).status).toBe(200);
  });

  it('a Redis error from the size check is the reply (the command is not run), audited by code only', async () => {
    const res = await cli('FT.SEARCH', idx, '@text:(r2_syntax_canary');
    expect(res.status).toBe(200);
    expect(res.json.reply.t).toBe('err');
    expect(res.json.reply.v).toMatch(/syntax/i);
    expect(tight.ctx.audit.query({ action: 'cli.exec', limit: 1 }).events[0]!.detail).toMatch(/^redis_error: [A-Z_]+$/);
  });
});

describe.skipIf(!sandboxUp)('review v0.2 R2-M2: the search page bounds document ids before reading them', () => {
  let tight: TestApp;
  let r: Admin;
  let v: Client;
  const P = keyPrefix('r2ids');
  const idx = `${P}idx`;
  beforeAll(async () => {
    tight = await tightApp();
    r = await sandboxAdmin();
    v = await userSession(tight, 'viewer');
    await r.sendCommand(['FT.CREATE', idx, 'ON', 'HASH', 'PREFIX', '1', `${P}d:`, 'SCHEMA', 'text', 'TEXT']);
    // Key names over the read budget (300 KB) and over the response budget only (20 KB).
    await r.hSet(`${P}d:huge:${'k'.repeat(300_000)}`, { text: 'single' });
    await r.hSet(`${P}d:long:${'k'.repeat(20_000)}`, { text: 'double' });
    await r.hSet(`${P}d:short`, { text: 'double' });
    await r.hSet(`${P}d:escaped`, { text: 'escaped', ...Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`f${i}`, ctl(4000)])) });
    await new Promise((res) => setTimeout(res, 300));
  }, 60_000);
  afterAll(async () => {
    await r?.sendCommand(['FT.DROPINDEX', idx]).catch(() => {});
    await r?.close();
    await tight?.close();
    await cleanupPrefix(P);
  });

  it('a page whose ids could exceed the read budget is refused before any id is read', async () => {
    const res = await v.req('POST', SEARCH, { index: idx, query: 'single', limit: 1 });
    expect(res.status).toBe(413);
    expect(res.json.error.code).toBe('too_large');
    expect(Buffer.byteLength(res.body)).toBeLessThan(4096);
  });

  it('ids count against the response budget: one that does not fit is withheld with its size, never cut', async () => {
    const res = await v.req('POST', SEARCH, { index: idx, query: 'double', limit: 10 });
    expect(res.status).toBe(200);
    expect(res.json.total).toBe(2);
    expect(Buffer.byteLength(res.body)).toBeLessThan(TIGHT + 1024);
    const ids = res.json.docs.map((d: { id: string }) => d.id);
    expect(ids).toContain(`${P}d:short`);
    const withheld = res.json.docs.find((d: { id: string }) => d.id === '');
    expect(withheld).toMatchObject({ id: '', idBytes: Buffer.byteLength(`${P}d:long:${'k'.repeat(20_000)}`), fields: {}, truncated: true });
  });

  it('the response budget is measured as JSON text (escaped control characters)', async () => {
    const res = await v.req('POST', SEARCH, { index: idx, query: 'escaped', limit: 10 });
    expect(res.status).toBe(200);
    expect(res.json.docs[0].truncated).toBe(true);
    expect(Buffer.byteLength(res.body)).toBeLessThan(TIGHT + 1024);
  });
});

describe.skipIf(!sandboxUp)('review v0.2 R2-M4: slow log and channel listings are audited (counts only)', () => {
  let t: TestApp;
  let r: Admin;
  let v: Client;
  const P = keyPrefix('r2slow');
  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    v = await userSession(t, 'viewer');
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('GET /slowlog records one slowlog.read event without the entries', async () => {
    const before = t.ctx.audit.query({ limit: 1000 }).events.length;
    const res = await v.req('GET', '/api/v1/databases/e2e/slowlog?count=5');
    expect(res.status).toBe(200);
    const added = t.ctx.audit.query({ limit: 1000 }).events.slice(0, t.ctx.audit.query({ limit: 1000 }).events.length - before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ action: 'slowlog.read', outcome: 'allowed', databaseId: 'e2e', command: 'SLOWLOG GET', username: v.username });
    expect(added[0]!.detail).toMatch(/^entries=\d+ len=\d+$/);
    // No argument of any slow log entry reaches the audit log.
    const text = JSON.stringify(added) + t.auditLines.join('');
    for (const e of res.json.entries) for (const a of e.argv as string[]) if (a.length > 3) expect(text).not.toContain(a);
  });

  it('POST /pubsub/channels records one pubsub.channels event with the pattern as a size only', async () => {
    const before = t.ctx.audit.query({ limit: 1000 }).events.length;
    const res = await v.req('POST', '/api/v1/databases/e2e/pubsub/channels', { pattern: `${P}secret-channel-*` });
    expect(res.status).toBe(200);
    const events = t.ctx.audit.query({ limit: 1000 }).events;
    const added = events.slice(0, events.length - before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ action: 'pubsub.channels', outcome: 'allowed', detail: 'channels=0' });
    expect(JSON.stringify(added) + t.auditLines.join('')).not.toContain('secret-channel');
  });
});

describe.skipIf(!sandboxUp)('review v0.2 R2-M5: server logs never carry Redis error text', () => {
  let t: TestApp;
  let r: Admin;
  const lines: string[] = [];
  const P = keyPrefix('r2log');
  const idx = `${P}idx`;
  const CANARY = 'private_review_r2_canary';
  beforeAll(async () => {
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    t = await startApp(testConfig(), { logger: { ...(loggerOptions('info') as object), stream } as never });
    r = await sandboxAdmin();
    await r.sendCommand(['FT.CREATE', idx, 'ON', 'HASH', 'PREFIX', '1', `${P}d:`, 'SCHEMA', 'text', 'TEXT', 'n', 'NUMERIC']);
  });
  afterAll(async () => {
    await r?.sendCommand(['FT.DROPINDEX', idx]).catch(() => {});
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('a search syntax error is logged by its error code; the user still gets the message', async () => {
    const v = await userSession(t, 'viewer');
    for (const query of [`@text:(${CANARY}`, `@n:[${CANARY} 5]`]) {
      const res = await v.req('POST', '/api/v1/databases/e2e/search/query', { index: idx, query });
      expect(res.status).toBe(502);
      expect(res.json.error.code).toBe('redis_error');
    }
    const logged = lines.join('');
    expect(logged).toContain('request failed');
    expect(logged).toMatch(/redis_error: [A-Z_]+/);
    expect(logged).not.toContain(CANARY);
    expect(t.auditLines.join('')).not.toContain(CANARY);
  });
});
