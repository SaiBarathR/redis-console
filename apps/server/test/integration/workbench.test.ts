import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupPrefix, keyPrefix, ORIGIN, sandboxAdmin, sandboxUp, startApp, testConfig, userSession, type Client, type TestApp } from '../helpers.ts';
import { listen } from './auth-helpers.ts';
import { WORKBENCH_OUTPUT_FACTOR } from '../../src/routes/cli.ts';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;
const WB = '/api/v1/databases/e2e/workbench';

describe.skipIf(!sandboxUp)('POST /workbench', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('wb');

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('runs lines sequentially, skipping comments and blanks', async () => {
    const c = await userSession(t, 'operator');
    const script = [`# set things`, `SET ${P}a 1`, '', `// increment`, `INCR ${P}a`, `GET ${P}a`].join('\n');
    const res = await c.req('POST', WB, { script });
    expect(res.status).toBe(200);
    expect(res.json.results).toHaveLength(3);
    expect(res.json.results[1].reply).toEqual({ t: 'int', v: '2' });
    expect(res.json.results[2].reply.v.data).toBe('2');
    expect(res.json.results[0].commandClass).toBe('write');
  });

  it('stopOnError true stops at a blocked line; false continues', async () => {
    const c = await userSession(t, 'operator');
    const script = [`SET ${P}b 1`, 'KEYS *', `SET ${P}c 1`].join('\n');
    let res = await c.req('POST', WB, { script });
    expect(res.json.results).toHaveLength(2);
    expect(res.json.results[1]).toMatchObject({ line: 'KEYS *', error: { code: 'command_blocked' } });
    expect(await r.exists(`${P}c`)).toBe(0);
    res = await c.req('POST', WB, { script, stopOnError: false });
    expect(res.json.results).toHaveLength(3);
    expect(await r.exists(`${P}c`)).toBe(1);

    // Redis error replies also stop when stopOnError
    res = await c.req('POST', WB, { script: [`LPUSH ${P}b x`, `SET ${P}d 1`].join('\n') });
    expect(res.json.results).toHaveLength(1);
    expect(res.json.results[0].reply.t).toBe('err');
    // tokenizer errors are per line
    res = await c.req('POST', WB, { script: 'GET "open', stopOnError: false });
    expect(res.json.results[0].error.code).toBe('validation');
  });

  it('role checks apply per line', async () => {
    const v = await userSession(t, 'viewer');
    const res = await v.req('POST', WB, { script: [`GET ${P}a`, `SET ${P}a 9`].join('\n'), stopOnError: false });
    expect(res.json.results[0].reply).toBeDefined();
    expect(res.json.results[1].error.code).toBe('forbidden');
  });

  it('rejects scripts with more than 100 commands', async () => {
    const c = await userSession(t, 'operator');
    const res = await c.req('POST', WB, { script: Array.from({ length: 101 }, () => 'PING').join('\n') });
    expect(res.status).toBe(400);
    expect((await c.req('POST', WB, { script: '' })).json).toEqual({ results: [] });
    expect((await c.req('POST', WB, { script: 'PING', extra: true })).status).toBe(400);
  });

  it('one confirmation for the whole script when any line is destructive', async () => {
    await r.set(`${P}x`, '1');
    const c = await userSession(t, 'operator');
    const body = { script: [`SET ${P}y 2`, `DEL ${P}x`, `UNLINK ${P}y`].join('\n') };
    const first = await c.req('POST', WB, body);
    expect(first.status).toBe(428);
    expect(first.json.error.confirmation.level).toBe('confirm');
    expect(first.json.error.confirmation.summary).toMatch(/2 commands that need confirmation/);
    expect(await r.exists(`${P}y`)).toBe(0); // nothing ran
    const second = await c.req('POST', WB, { ...body, confirmation: { token: first.json.error.confirmation.token } });
    expect(second.status).toBe(200);
    expect(second.json.results.map((x: any) => x.reply)).toEqual([
      { t: 'str', v: { enc: 'utf8', data: 'OK' } },
      { t: 'int', v: '1' },
      { t: 'int', v: '1' },
    ]);
    // prod: typed + reason
    const p = await c.req('POST', '/api/v1/databases/e2e-prod/workbench', { script: `SET ${P}z 1` });
    expect(p.json.error.confirmation).toMatchObject({ level: 'typed', expectedText: 'E2E prod', reasonRequired: true });
  });
});

describe.skipIf(!sandboxUp)('GET /commands', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  it('returns docs annotated with policy for the caller', async () => {
    const v = await userSession(t, 'viewer');
    const a = await userSession(t, 'admin');
    const vr = await v.req('GET', '/api/v1/databases/e2e/commands');
    expect(vr.status).toBe(200);
    const byName = (list: any[]) => Object.fromEntries(list.map((d) => [d.name, d]));
    const vd = byName(vr.json.commands);
    expect(vr.json.commands.length).toBeGreaterThan(200);
    expect(vd.GET).toMatchObject({ class: 'read', allowed: true, group: 'string' });
    expect(vd.GET.arguments[0]).toMatchObject({ name: 'key', type: 'key' });
    expect(typeof vd.GET.summary).toBe('string');
    expect(vd.SET).toMatchObject({ class: 'write', allowed: false });
    expect(vd['CLIENT KILL']).toMatchObject({ class: 'admin', allowed: false });
    expect(vd.EVAL).toMatchObject({ class: 'blocked', allowed: false });
    expect(vd.EVAL.hint).toMatch(/Lua/);
    expect(vd['CONFIG SET'].class).toBe('blocked');

    const ad = byName((await a.req('GET', '/api/v1/databases/e2e/commands')).json.commands);
    expect(ad.SET.allowed).toBe(true);
    expect(ad['CLIENT KILL'].allowed).toBe(true);
    expect(ad.FLUSHDB.allowed).toBe(true);
    expect(ad.EVAL.allowed).toBe(false);

    const prod = byName((await a.req('GET', '/api/v1/databases/e2e-prod/commands')).json.commands);
    expect(prod.FLUSHDB.allowed).toBe(false);
    const ro = byName((await a.req('GET', '/api/v1/databases/e2e-ro/commands')).json.commands);
    expect(ro.SET.allowed).toBe(false);
    expect(ro.GET.allowed).toBe(true);
  });
});

describe.skipIf(!sandboxUp)('workbench vs. account changes (review M1)', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('wbrevoke');
  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('stops issuing commands once its user is disabled mid-script (review M1)', async () => {
    const admin = await userSession(t, 'admin');
    const op = await userSession(t, 'operator');
    const uid = t.ctx.users.byUsername(op.username)!.id;
    const running = op.req('POST', WB, { script: `BLPOP ${P}absent 1\nSET ${P}after-disable x\nGET ${P}after-disable`, stopOnError: false });
    await new Promise((res) => setTimeout(res, 300)); // BLPOP is blocking on Redis now
    expect((await admin.req('PATCH', `/api/v1/admin/users/${uid}`, { disabled: true })).status).toBe(200);
    const r2 = await running;
    expect(r2.status).toBe(200);
    expect(r2.json.results).toHaveLength(3);
    expect(r2.json.results[1].error.code).toBe('unauthenticated');
    expect(r2.json.results[2].error.code).toBe('unauthenticated');
    expect(await r.exists(`${P}after-disable`)).toBe(0);
  });

  it('stops when the user is demoted mid-script', async () => {
    const admin = await userSession(t, 'admin');
    const op = await userSession(t, 'operator');
    const uid = t.ctx.users.byUsername(op.username)!.id;
    const running = op.req('POST', WB, { script: `BLPOP ${P}absent2 1\nSET ${P}after-demote x` });
    await new Promise((res) => setTimeout(res, 300));
    expect((await admin.req('PATCH', `/api/v1/admin/users/${uid}`, { role: 'viewer' })).status).toBe(200);
    const r2 = await running;
    expect(r2.json.results[1].error.code).toBe('unauthenticated');
    expect(await r.exists(`${P}after-demote`)).toBe(0);
  });

  it('a bulk delete stops between batches when the session is no longer valid', async () => {
    const op = await userSession(t, 'operator');
    const multi = r.multi();
    for (let i = 0; i < 12_000; i++) multi.set(`${P}bulk:${i}`, '1');
    await multi.exec();
    const body = { match: `${P}bulk:*` };
    const first = await op.req('POST', '/api/v1/databases/e2e/bulk-delete', body);
    expect(first.status).toBe(428);
    const ch = first.json.error.confirmation;
    // Valid for the request gate's checks after the body and after the slot wait (review r6 H2) and the first
    // between-batch check, then the session is gone (as if revoked by an admin mid-run): the batch's first Redis
    // command is refused right before it is sent (review v0.2 N1), and the delete stops.
    const alive = t.ctx.sessions.alive.bind(t.ctx.sessions);
    let calls = 0;
    t.ctx.sessions.alive = (h: string) => (++calls <= 3 ? alive(h) : false);
    try {
      const res = await op.req('POST', '/api/v1/databases/e2e/bulk-delete', { ...body, confirmation: { token: ch.token, typed: ch.expectedText } });
      expect(res.status).toBe(401);
    } finally {
      t.ctx.sessions.alive = alive;
    }
    let left = 0;
    for await (const keys of r.scanIterator({ MATCH: `${P}bulk:*`, COUNT: 1000 })) left += keys.length;
    expect(left).toBeGreaterThan(0);
    const ev = t.ctx.audit.query({ user: op.username, action: 'key.bulk-delete', outcome: 'allowed', limit: 1 }).events[0]!;
    expect(ev.detail).toContain('stopped');
  });
});

describe.skipIf(!sandboxUp)('workbench total output budget (review M2)', () => {
  let t: TestApp;
  const MAX = 1024;
  beforeAll(async () => {
    const cfg = testConfig();
    cfg.policy.maxReplyBytes = MAX;
    t = await startApp(cfg);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('stops running lines once the accumulated output of the script exceeds its budget', async () => {
    const v = await userSession(t, 'viewer');
    const script = Array.from({ length: 100 }, () => `ECHO ${'q'.repeat(900)}`).join('\n');
    const res = await v.req('POST', WB, { script, stopOnError: false });
    expect(res.status).toBe(200);
    expect(res.json.results).toHaveLength(100);
    const ran = res.json.results.filter((x: any) => x.reply).length;
    expect(ran).toBeGreaterThan(0);
    expect(ran).toBeLessThanOrEqual(WORKBENCH_OUTPUT_FACTOR + 2);
    expect(res.json.results.at(-1).error.code).toBe('too_large');
    expect(Buffer.byteLength(res.body)).toBeLessThan(40 * MAX); // was 121 KB
  });

  it('one script at a time per user', async () => {
    const v = await userSession(t, 'viewer');
    const slow = v.req('POST', WB, { script: 'XREAD BLOCK 1000 STREAMS rcsrv:wb-none $' });
    await new Promise((r) => setTimeout(r, 200));
    const second = await v.req('POST', WB, { script: 'PING' });
    expect(second.status).toBe(429);
    expect((await slow).status).toBe(200);
  });
});


describe.skipIf(!sandboxUp)('workbench cancellation (console review round 1, H1)', () => {
  let t: TestApp;
  let r: Admin;
  let base: string;
  const P = keyPrefix('wbcancel');
  const CANCEL = '/api/v1/databases/e2e/workbench/cancel';
  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    base = await listen(t.app);
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  /** A real HTTP request (not inject), so the client can go away mid-request as a browser does. */
  const post = (c: Client, path: string, body: unknown, signal?: AbortSignal) =>
    fetch(base + path, {
      method: 'POST',
      headers: { cookie: c.cookie, origin: ORIGIN, 'x-csrf-token': c.csrf, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });

  it('a client that aborts the request stops the script before its next line', async () => {
    const op = await userSession(t, 'operator');
    const ac = new AbortController();
    const running = post(op, WB, { script: `BLPOP ${P}empty 1\nSET ${P}after-abort x\nSET ${P}after-abort-2 y`, stopOnError: false }, ac.signal).catch((e: Error) => e);
    await sleep(300); // BLPOP is blocking on Redis now
    ac.abort();
    expect(await running).toBeInstanceOf(Error);
    await sleep(1200); // BLPOP times out; the old loop then sent both SETs
    expect(await r.exists([`${P}after-abort`, `${P}after-abort-2`])).toBe(0);
    const events = t.ctx.audit.query({ user: op.username, action: 'workbench.exec', limit: 10 }).events;
    expect(events.map((e) => e.command)).toEqual(['BLPOP']); // the line in flight is audited; nothing after it ran
    expect((await op.req('POST', WB, { script: 'PING' })).status).toBe(200); // the script's slot was released
  });

  it('cancel answers at once with the finished lines and the line in flight; later lines are not sent', async () => {
    const op = await userSession(t, 'operator');
    const started = Date.now();
    const running = op.req('POST', WB, { script: `SET ${P}first 1\nBLPOP ${P}empty2 2\nSET ${P}after-cancel x\nGET ${P}first`, stopOnError: false });
    await sleep(300);
    const cancel = await op.req('POST', CANCEL, {});
    expect(cancel.status).toBe(200);
    expect(cancel.json).toEqual({ cancelled: true });
    const res = await running;
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1500); // did not wait for the 2 s BLPOP
    expect(res.json.results).toHaveLength(1);
    expect(res.json.results[0].reply).toEqual({ t: 'str', v: { enc: 'utf8', data: 'OK' } });
    expect(res.json.cancelled).toEqual({ inFlight: true });
    // Transport cancellation destroys the exclusive socket and releases the slot immediately.
    expect((await op.req('POST', WB, { script: 'PING' })).status).toBe(200);
    await sleep(2200);
    expect(await r.exists(`${P}after-cancel`)).toBe(0);
    expect(await r.get(`${P}first`)).toBe('1');
    const events = t.ctx.audit.query({ user: op.username, action: 'workbench.exec', limit: 10 }).events;
    expect(events.map((e) => e.command).sort()).toEqual(['BLPOP', 'PING', 'SET']);
    expect((await op.req('POST', WB, { script: 'PING' })).status).toBe(200);
  });

  it('a cancel between lines reports no line in flight', async () => {
    const op = await userSession(t, 'operator');
    // Cancel arrives while line 1 runs; line 1 answers first only if Redis is faster than the cancel. Either
    // way nothing after the reported lines ran.
    const running = op.req('POST', WB, { script: `BLPOP ${P}empty3 1\nSET ${P}after-cancel-3 x` });
    await sleep(200);
    expect((await op.req('POST', CANCEL, {})).json).toEqual({ cancelled: true });
    const res = await running;
    expect(res.json.cancelled).toBeDefined();
    expect(res.json.results.length + (res.json.cancelled.inFlight ? 1 : 0)).toBeLessThanOrEqual(1);
    await sleep(1200);
    expect(await r.exists(`${P}after-cancel-3`)).toBe(0);
  });

  it("cancel only reaches the caller's own running script on that database", async () => {
    const op = await userSession(t, 'operator');
    const other = await userSession(t, 'operator');
    expect((await op.req('POST', CANCEL, {})).json).toEqual({ cancelled: false }); // nothing running
    const running = op.req('POST', WB, { script: `BLPOP ${P}empty4 1\nSET ${P}not-cancelled x` });
    await sleep(200);
    expect((await other.req('POST', CANCEL, {})).json).toEqual({ cancelled: false });
    expect((await op.req('POST', '/api/v1/databases/main/workbench/cancel', {})).json).toEqual({ cancelled: false });
    expect((await op.req('POST', CANCEL, { extra: 1 })).status).toBe(400);
    const res = await running;
    expect(res.json.cancelled).toBeUndefined();
    expect(res.json.results).toHaveLength(2);
    expect(await r.get(`${P}not-cancelled`)).toBe('x');
    // A viewer may cancel its own (read-only) scripts.
    const viewer = await userSession(t, 'viewer');
    expect((await viewer.req('POST', CANCEL, {})).json).toEqual({ cancelled: false });
  });

  it('a bulk delete stops between batches when its client goes away', async () => {
    const op = await userSession(t, 'operator');
    const multi = r.multi();
    for (let i = 0; i < 12_000; i++) multi.set(`${P}bulk:${i}`, '1');
    await multi.exec();
    const body = { match: `${P}bulk:*` };
    const first = await op.req('POST', '/api/v1/databases/e2e/bulk-delete', body);
    expect(first.status).toBe(428);
    const ch = first.json.error.confirmation;
    // The client goes away as the first batch starts (the first between-batch check).
    const ac = new AbortController();
    const alive = t.ctx.sessions.alive.bind(t.ctx.sessions);
    t.ctx.sessions.alive = (h: string) => {
      ac.abort();
      return alive(h);
    };
    try {
      const res = await post(op, '/api/v1/databases/e2e/bulk-delete', { ...body, confirmation: { token: ch.token, typed: ch.expectedText } }, ac.signal).catch((e: Error) => e);
      expect(res).toBeInstanceOf(Error);
      let ev: { detail?: string | null } | undefined;
      for (let i = 0; i < 50 && !ev; i++) {
        await sleep(100);
        ev = t.ctx.audit.query({ user: op.username, action: 'key.bulk-delete', limit: 1 }).events[0];
      }
      expect(ev?.detail).toMatch(/stopped: client disconnected|unavailable: Redis command cancelled/);
    } finally {
      t.ctx.sessions.alive = alive;
    }
    let left = 0;
    for await (const keys of r.scanIterator({ MATCH: `${P}bulk:*`, COUNT: 1000 })) left += keys.length;
    expect(left).toBeGreaterThan(0);
  });
});
