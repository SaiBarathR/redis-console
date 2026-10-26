/**
 * Key browser v0.2.1: names-only scans (`keys/names`) and lazy metadata for the rows on screen (`keys/meta`).
 * Runs against the disposable 6411 sandbox under a unique prefix.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyTag } from '../../src/audit.ts';
import { resolveConfig } from '../../src/config.ts';
import { b64, bk, cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, testConfigRaw, userSession, utf8, type TestApp } from '../helpers.ts';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;
const fromBin = (b: { enc: string; data: string }) => (b.enc === 'utf8' ? Buffer.from(b.data, 'utf8') : Buffer.from(b.data, 'base64'));
const NAMES = '/api/v1/databases/e2e/keys/names';
const META = '/api/v1/databases/e2e/keys/meta';

describe.skipIf(!sandboxUp)('key browser v0.2.1: names and metadata', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('kb');
  const many = Array.from({ length: 2600 }, (_, i) => `${P}many:${i}`);
  const binKey = Buffer.concat([Buffer.from(`${P}bin:`), Buffer.from([0xff, 0x00, 0xfe, 0x0a])]);

  beforeAll(async () => {
    const raw = testConfigRaw();
    (raw.policy as Record<string, unknown>).keyScanThresholdMax = 20_000;
    t = await startApp(resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } }));
    r = await sandboxAdmin();
    for (let i = 0; i < many.length; i += 500) {
      const m = r.multi();
      for (const k of many.slice(i, i + 500)) m.set(k, 'v');
      await m.exec();
    }
    await r.hSet(`${P}hash`, { a: '1', b: '2' });
    await r.rPush(`${P}list`, ['x', 'y']);
    await r.zAdd(`${P}zset`, [{ score: 1, value: 'm' }]);
    await r.set(`${P}ttl`, 'v', { EX: 1000 });
    await r.set(`${P}star*name`, 'literal star');
    await r.set(binKey as never, 'binary');
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  /** Every page of a names scan until the cursor returns to 0. */
  async function drain(c: Awaited<ReturnType<typeof userSession>>, body: Record<string, unknown>) {
    const keys: Buffer[] = [];
    let cursor = '0', pages = 0, scanned = 0;
    do {
      const res = await c.req('POST', NAMES, { ...body, cursor });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      keys.push(...res.json.keys.map(fromBin));
      scanned += res.json.scanned;
      cursor = res.json.cursor;
      pages++;
    } while (cursor !== '0' && pages < 200);
    return { keys, pages, scanned };
  }

  it('returns names only (no metadata), with the cursor, the slots scanned and DBSIZE', async () => {
    const c = await userSession(t, 'viewer');
    const res = await c.req('POST', NAMES, { match: `${P}*` });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ threshold: 10_000 });
    expect(typeof res.json.dbSize).toBe('number');
    expect(res.json.dbSize).toBeGreaterThanOrEqual(many.length);
    expect(res.json.scanned).toBeGreaterThan(0);
    expect(res.json.cursor).toMatch(/^\d+$/);
    for (const k of res.json.keys) expect(Object.keys(k).sort()).toEqual(['data', 'enc']);
  });

  it('a full drain returns every matching key exactly once, binary names byte-exact', async () => {
    const c = await userSession(t, 'viewer');
    const { keys } = await drain(c, { match: `${P}*`, count: 10_000, scanThreshold: 20_000 });
    const names = keys.map((k) => k.toString('latin1'));
    expect(new Set(names).size).toBe(names.length);
    expect(keys.length).toBe(many.length + 6);
    expect(keys.some((k) => k.equals(binKey))).toBe(true);
    const listed = await drain(c, { match: `${P}many:*`, count: 1000, scanThreshold: 1000 });
    expect(new Set(listed.keys.map(String))).toEqual(new Set(many));
  });

  it('stops at scanThreshold (clamped to policy.keyScanThresholdMax) and at count', async () => {
    const c = await userSession(t, 'viewer');
    const small = await c.req('POST', NAMES, { match: '*', scanThreshold: 500 });
    expect(small.status).toBe(200);
    expect(small.json.threshold).toBe(500);
    expect(small.json.scanned).toBeLessThanOrEqual(500);
    if (small.json.dbSize > 600) expect(small.json.cursor).not.toBe('0');
    const clamped = await c.req('POST', NAMES, { match: `${P}many:*`, scanThreshold: 5_000_000 });
    expect(clamped.json.threshold).toBe(20_000);
    const few = await c.req('POST', NAMES, { match: `${P}many:*`, count: 25, scanThreshold: 20_000 });
    expect(few.json.keys.length).toBeGreaterThan(0);
    expect(few.json.keys.length).toBeLessThanOrEqual(25 + 20);
  });

  it('honours the TYPE filter', async () => {
    const c = await userSession(t, 'viewer');
    const { keys } = await drain(c, { match: `${P}*`, type: 'hash', scanThreshold: 20_000 });
    expect(keys.map(String)).toEqual([`${P}hash`]);
  });

  it('a pattern without glob characters is one direct lookup (escapes resolved, type filter applied)', async () => {
    const c = await userSession(t, 'viewer');
    const hit = await c.req('POST', NAMES, { match: `${P}hash` });
    expect(hit.json).toMatchObject({ cursor: '0', exact: true, keys: [utf8(`${P}hash`)] });
    expect(hit.json.scanned).toBe(hit.json.dbSize);
    const star = await c.req('POST', NAMES, { match: `${P}star\\*name` });
    expect(star.json).toMatchObject({ exact: true, keys: [utf8(`${P}star*name`)] });
    expect((await c.req('POST', NAMES, { match: `${P}missing` })).json).toMatchObject({ cursor: '0', exact: true, keys: [] });
    expect((await c.req('POST', NAMES, { match: `${P}hash`, type: 'string' })).json.keys).toEqual([]);
  });

  it('validates the request', async () => {
    const c = await userSession(t, 'viewer');
    for (const body of [{ count: 0 }, { count: 10_001 }, { scanThreshold: 99 }, { scanThreshold: 10_000_001 }, { cursor: 'abc' }, { cursor: '-1' }, { extra: 1 }, { match: 'x'.repeat(513) }]) {
      expect((await c.req('POST', NAMES, body)).status, JSON.stringify(body)).toBe(400);
    }
    for (const body of [{ keys: [] }, { keys: Array.from({ length: 501 }, (_, i) => utf8(`k${i}`)) }, { keys: [{ enc: 'base64', data: '!!' }] }, { keys: [utf8('k')], type: 'hash' }, { keys: [utf8('k')], size: 'no' }]) {
      expect((await c.req('POST', META, body)).status).toBe(400);
    }
  });

  it('metadata: type, TTL and size per key in request order; missing keys are none/-2; binary keys work', async () => {
    const c = await userSession(t, 'viewer');
    const keys = [utf8(`${P}hash`), utf8(`${P}missing`), utf8(`${P}ttl`), b64(binKey), utf8(`${P}list`), utf8(`${P}zset`), utf8(`${P}many:1`)];
    const res = await c.req('POST', META, { keys });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const out = res.json.keys;
    expect(out.map((k: { key: { enc: string; data: string } }) => fromBin(k.key).toString('latin1'))).toEqual(keys.map((k) => fromBin(k).toString('latin1')));
    expect(out.map((k: { type: string }) => k.type)).toEqual(['hash', 'none', 'string', 'string', 'list', 'zset', 'string']);
    expect(out[0]).toMatchObject({ ttl: -1 });
    expect(out[0].size).toBeGreaterThan(0);
    expect(out[1]).toEqual({ key: utf8(`${P}missing`), type: 'none', ttl: -2 });
    expect(out[2].ttl).toBeGreaterThan(990);
    expect(out[2].ttl).toBeLessThanOrEqual(1000);
    expect(out[3].key.enc).toBe('base64');
    // A key repeated in one request is read once and reported at every position.
    const twice = await c.req('POST', META, { keys: [utf8(`${P}hash`), utf8(`${P}hash`)] });
    expect(twice.json.keys[1]).toEqual(twice.json.keys[0]);
    // Hidden columns: no PTTL / MEMORY USAGE is sent, and the audit lists only TYPE.
    const typeOnly = await c.req('POST', META, { keys: [utf8(`${P}hash`), utf8(`${P}ttl`)], ttl: false, size: false });
    expect(typeOnly.json.keys).toEqual([{ key: utf8(`${P}hash`), type: 'hash' }, { key: utf8(`${P}ttl`), type: 'string' }]);
    const ttlOnly = await c.req('POST', META, { keys: [utf8(`${P}ttl`)], size: false });
    expect(Object.keys(ttlOnly.json.keys[0]).sort()).toEqual(['key', 'ttl', 'type']);
  });

  it('records one audit event per request: counts and key hashes, never names', async () => {
    const v = await userSession(t, 'viewer');
    const events = () => t.auditLines.map((l) => JSON.parse(l)).filter((e) => e.username === v.username);
    let before = events().length;
    await v.req('POST', NAMES, { match: `${P}many:*`, count: 100 });
    let added = events().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ action: 'key.names', outcome: 'allowed', command: 'SCAN', databaseId: 'e2e' });
    expect(added[0].detail).toMatch(/^keys=\d+ scanned=\d+ threshold=10000$/);
    before = events().length;
    await v.req('POST', NAMES, { match: `${P}hash` });
    added = events().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ action: 'key.names', command: 'TYPE', keyCount: 1, argvRedacted: ['TYPE', keyTag(`${P}hash`)] });
    expect(added[0].detail).toMatch(/ exact$/);
    before = events().length;
    const keys = Array.from({ length: 60 }, (_, i) => utf8(`${P}many:${i}`));
    await v.req('POST', META, { keys });
    added = events().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ action: 'key.meta', outcome: 'allowed', keyCount: 60, detail: 'keys=60 missing=0' });
    expect(added[0].argvRedacted.slice(0, 4)).toEqual(['TYPE', 'PTTL', 'MEMORY', keyTag(`${P}many:0`)]);
    expect(added[0].argvRedacted.at(-1)).toBe('<+10 keys>');
    const text = t.auditLines.join('');
    expect(text).not.toContain(`${P}many`);
    expect(text).not.toContain(`${P}hash`);
  });

  it('a normal open never hits a limit: one names scan, then metadata batches while scrolling', async () => {
    const c = await userSession(t, 'viewer');
    const statuses: number[] = [];
    statuses.push((await c.req('POST', NAMES, { match: '*' })).status);
    // Scrolling quickly through the list: a debounced batch of visible rows about every 120 ms, one at a time.
    for (let i = 0; i < 25; i++) {
      statuses.push((await c.req('POST', META, { keys: many.slice(i * 40, i * 40 + 40).map(utf8) })).status);
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('bounds abuse: bursts of metadata or names requests get 429', async () => {
    const c = await userSession(t, 'viewer');
    const meta = await Promise.all(Array.from({ length: 60 }, () => c.req('POST', META, { keys: [utf8(`${P}hash`)] }).then((x) => x.status)));
    expect(meta).toContain(429);
    expect(meta).toContain(200);
    const names = await Promise.all(Array.from({ length: 40 }, () => c.req('POST', NAMES, { match: `${P}nothing*`, scanThreshold: 100 }).then((x) => x.status)));
    expect(names).toContain(429);
  });

  it('read-only databases and every role can list names and metadata; anonymous cannot', async () => {
    for (const role of ['viewer', 'operator', 'admin'] as const) {
      const c = await userSession(t, role);
      expect((await c.req('POST', '/api/v1/databases/e2e-ro/keys/names', { match: `${P}hash` })).json.keys).toHaveLength(1);
      expect((await c.req('POST', '/api/v1/databases/e2e-ro/keys/meta', { keys: [bk(`${P}hash`)] })).json.keys[0].type).toBe('hash');
    }
    const anon = await t.app.inject({ method: 'POST', url: NAMES, headers: { origin: 'http://localhost:4100', 'content-type': 'application/json' }, payload: '{}' });
    expect(anon.statusCode).toBe(401);
  });
});

describe.skipIf(!sandboxUp)('pattern delete as a job (F20)', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('kbjob');
  const JOBS = '/api/v1/databases/e2e/bulk-delete/jobs';
  const fill = async (prefix: string, n: number) => {
    for (let i = 0; i < n; i += 1000) {
      const m = r.multi();
      for (let j = i; j < Math.min(n, i + 1000); j++) m.set(`${prefix}${j}`, 'v');
      await m.exec();
    }
  };
  const count = async (prefix: string) => {
    let n = 0;
    for await (const keys of r.scanIterator({ MATCH: `${prefix}*`, COUNT: 1000 })) n += keys.length;
    return n;
  };
  type C = Awaited<ReturnType<typeof userSession>>;
  const start = async (c: C, body: Record<string, unknown>) => {
    const challenge = await c.req('POST', JOBS, body);
    expect(challenge.status, JSON.stringify(challenge.json)).toBe(428);
    const conf = challenge.json.error.confirmation;
    return { conf, res: await c.req('POST', JOBS, { ...body, confirmation: { token: conf.token, typed: conf.expectedText } }) };
  };
  const settle = async (c: C, id: string) => {
    for (let i = 0; i < 200; i++) {
      const s = await c.req('GET', `${JOBS}/${id}`);
      expect(s.status).toBe(200);
      if (s.json.job.state !== 'running') return s.json.job;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('job did not finish');
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

  it('keeps the impact preview and typed confirmation, then reports counts until done', async () => {
    await fill(`${P}a:`, 2500);
    const op = await userSession(t, 'operator');
    const { conf, res } = await start(op, { match: `${P}a:*` });
    expect(conf.impact.keys).toBe(2500);
    expect(conf.level).toBe('typed');
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.job).toMatchObject({ state: 'running', expected: 2500 });
    const job = await settle(op, res.json.job.id);
    expect(job).toMatchObject({ state: 'done', deleted: 2500, failed: 0, complete: true, errors: [], expected: 2500 });
    expect(job.scanned).toBeGreaterThanOrEqual(2500);
    expect(job.finishedAt).toBeTruthy();
    expect(await count(`${P}a:`)).toBe(0);
    const events = t.auditLines.map((l) => JSON.parse(l)).filter((e) => e.username === op.username && e.action.startsWith('key.bulk-delete'));
    expect(events.map((e) => [e.action, e.outcome])).toEqual([
      ['key.bulk-delete', 'confirmation_required'], ['key.bulk-delete.start', 'allowed'], ['key.bulk-delete', 'allowed'],
    ]);
    expect(events[2]).toMatchObject({ keyCount: 2500 });
    expect(events[2].detail).toMatch(/scanned \d+; deleted 2500; failed 0; done$/);
    expect(t.auditLines.join('')).not.toContain(`${P}a:`);
  });

  it('stops between batches when cancelled and reports the partial outcome', async () => {
    await fill(`${P}b:`, 30_000);
    const op = await userSession(t, 'operator');
    const { res } = await start(op, { match: `${P}b:*` });
    const id = res.json.job.id;
    const cancel = await op.req('POST', `${JOBS}/${id}/cancel`, {});
    expect(cancel.status).toBe(200);
    const job = await settle(op, id);
    expect(job).toMatchObject({ state: 'cancelled', stopReason: 'cancelled', complete: false });
    expect(job.deleted).toBeLessThan(30_000);
    expect(await count(`${P}b:`)).toBe(30_000 - job.deleted);
    // One job per user at a time; a finished one does not count.
    expect((await op.req('GET', `${JOBS}/${id}`)).json.job.state).toBe('cancelled');
  });

  it('only the session that started a job sees or cancels it; viewers cannot start one', async () => {
    await fill(`${P}c:`, 10);
    const op = await userSession(t, 'operator');
    const { res } = await start(op, { match: `${P}c:*` });
    const other = await userSession(t, 'operator');
    expect((await other.req('GET', `${JOBS}/${res.json.job.id}`)).status).toBe(404);
    expect((await other.req('POST', `${JOBS}/${res.json.job.id}/cancel`, {})).status).toBe(404);
    expect((await op.req('GET', `/api/v1/databases/e2e-ro/bulk-delete/jobs/${res.json.job.id}`)).status).toBe(404);
    await settle(op, res.json.job.id);
    const viewer = await userSession(t, 'viewer');
    expect((await viewer.req('POST', JOBS, { match: `${P}c:*` })).status).toBe(403);
    expect((await op.req('POST', '/api/v1/databases/e2e-ro/bulk-delete/jobs', { match: `${P}c:*` })).status).toBe(403);
    expect((await other.req('POST', JOBS, { match: '*' })).status).toBe(403);
  });

  it('closing the server stops a running job between batches and still audits its outcome', async () => {
    await fill(`${P}e:`, 30_000);
    const own = await startApp();
    try {
      const op = await userSession(own, 'operator');
      const { res } = await start(op, { match: `${P}e:*` });
      expect(res.status).toBe(200);
    } finally {
      await own.close();
    }
    const end = own.auditLines.map((l) => JSON.parse(l)).find((e) => e.action === 'key.bulk-delete' && String(e.detail).startsWith('job '));
    expect(end?.detail).toMatch(/; (stopped \(shutdown\)|done)$/);
    expect(end.detail).not.toMatch(/failed [1-9]/);
    expect(await count(`${P}e:`)).toBe(30_000 - end.keyCount);
  });

  it('a session that ends stops its job (audited with the partial counts)', async () => {
    await fill(`${P}d:`, 30_000);
    const op = await userSession(t, 'operator');
    const { res } = await start(op, { match: `${P}d:*` });
    expect(res.status).toBe(200);
    await op.req('POST', '/api/v1/auth/logout', {});
    await expect.poll(() => t.auditLines.some((l) => l.includes(`job ${res.json.job.id}; scanned`)), { timeout: 10_000 }).toBe(true);
    const end = t.auditLines.map((l) => JSON.parse(l)).find((e) => e.action === 'key.bulk-delete' && String(e.detail).startsWith(`job ${res.json.job.id};`));
    expect(end.detail).toMatch(/stopped \(session\)$/);
    expect(await count(`${P}d:`)).toBe(30_000 - end.keyCount);
  });
});
