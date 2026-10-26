/**
 * Review v0.2 r6 (final server review), against the 6411 sandbox over real HTTP sockets:
 * - H1: concurrent near-limit uploads to a process with a 256 MiB heap are refused before they are buffered.
 * - H2: a checked edit whose account is disabled or demoted before its body completes, or while it reads, is refused.
 * - M1: a type change between TYPE and the element read is a 409 conflict, not a 502.
 * - L1: `expect` on an op that cannot carry one is a 400, not silently ignored.
 */
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { checkedWrite, type CheckedPlan, type Probe } from '../../src/redis/checked.ts';
import type { Arg, Conn } from '../../src/redis/manager.ts';
import { ORIGIN, cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, testConfig, userSession, utf8, type Client, type TestApp } from '../helpers.ts';

const MiB = 1024 * 1024;
const OPS = '/api/v1/databases/e2e/ops';
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;

describe.skipIf(!sandboxUp)('review v0.2 r6', () => {
  let t: TestApp;
  let r: Admin;
  let port: number;
  let headersSeen = 0;
  const P = keyPrefix('r6');
  const k = (s: string) => `${P}${s}`;

  beforeAll(async () => {
    const auditLines: string[] = [];
    const built = await buildApp(testConfig(), { logger: false, dbPath: ':memory:', auditWrite: (l) => auditLines.push(l) });
    // Observation only: registered after the app's hooks, so it runs once a request passed authentication.
    built.app.addHook('onRequest', async (req) => { if (req.headers['x-r6-probe']) headersSeen++; });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    port = (built.app.server.address() as AddressInfo).port;
    t = { ...built, auditLines, close: () => built.app.close() };
    r = await sandboxAdmin();
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });
  const audits = () => t.auditLines.map((l) => JSON.parse(l) as Record<string, unknown>);

  /** A real HTTP request whose body is sent except for its last byte, once its headers passed authentication. */
  async function paused(c: Client, method: string, url: string, body: unknown) {
    const data = JSON.stringify(body);
    const before = headersSeen;
    let req!: http.ClientRequest;
    const result = new Promise<{ status: number; json: any }>((resolve, reject) => {
      req = http.request({ host: '127.0.0.1', port, path: url, method, headers: {
        origin: ORIGIN, cookie: c.cookie, 'x-csrf-token': c.csrf, 'x-r6-probe': '1', 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
      } }, (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => resolve({ status: res.statusCode!, json: JSON.parse(text) }));
      });
      req.on('error', reject);
    });
    req.write(data.slice(0, -1));
    const end = Date.now() + 4000;
    while (headersSeen === before) {
      if (Date.now() > end) throw new Error('request not admitted');
      await new Promise((res) => setTimeout(res, 5));
    }
    return { finish: () => { req.end(data.slice(-1)); return result; } };
  }

  /** Run `before(argv)` ahead of every command of the server's exclusive (checked-edit) sockets. */
  function intercept(before: (argv: Arg[]) => Promise<void> | void): () => void {
    const original = t.ctx.redis.conn.bind(t.ctx.redis);
    t.ctx.redis.conn = async (...args: Parameters<typeof original>) => {
      const c = await original(...args);
      return new Proxy(c, { get(target, p) {
        if (p === 'exclusive') {
          const exclusive: Conn['exclusive'] = (key, fn, o) => target.exclusive(key, (send) => fn(async (argv, so) => { await before(argv); return send(argv, so); }), o);
          return exclusive;
        }
        const v = Reflect.get(target, p);
        return typeof v === 'function' ? v.bind(target) : v;
      } });
    };
    return () => { t.ctx.redis.conn = original; };
  }

  it('H1: concurrent 11 MiB uploads from one and from three operators are refused before buffering; a 256 MiB heap survives', async () => {
    const child = fork(path.join(import.meta.dirname, 'upload-memory-worker.ts'), [], {
      execArgv: ['--max-old-space-size=256', '--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr!.on('data', (d) => { stderr += d; });
    const exited = once(child, 'exit');
    const key = k('memory');
    try {
      const ready = await new Promise<{ port: number; sessions: { cookie: string; csrf: string }[] }>((resolve, reject) => {
        child.once('message', (m) => resolve(m as never));
        child.once('exit', (code, signal) => reject(new Error(`worker exited (${code ?? signal}): ${stderr}`)));
      });
      // Valid checked string.set bodies just under the 12 MiB limit, all on one key (bounded Redis data).
      const body = JSON.stringify({ op: 'string.set', key: utf8(key), value: utf8('m'.repeat(11 * MiB)), expect: { type: 'none' } });
      const send = (s: { cookie: string; csrf: string }, method = 'POST', url = '/api/v1/databases/e2e/ops', payload: string | undefined = body) => new Promise<number | string>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: ready.port, path: url, method, headers: {
          origin: ORIGIN, cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        } }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode!)); });
        req.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
        req.end(payload);
      });
      const one = await Promise.all(Array.from({ length: 24 }, () => send(ready.sessions[0]!)));
      const three = await Promise.all(ready.sessions.flatMap((s) => Array.from({ length: 8 }, () => send(s))));
      expect(child.exitCode, stderr).toBeNull();
      for (const statuses of [one, three]) {
        expect(statuses.every((s) => s === 200 || s === 409 || s === 429), JSON.stringify(statuses)).toBe(true);
        expect(statuses.filter((s) => s === 429).length, JSON.stringify(statuses)).toBeGreaterThan(0);
        expect(statuses.filter((s) => s !== 429).length, JSON.stringify(statuses)).toBeGreaterThan(0);
      }
      expect(one.filter((s) => s === 200)).toHaveLength(1);
      expect(three.filter((s) => s === 200)).toHaveLength(0);
      expect(await r.strLen(key)).toBe(11 * MiB);
      // Still serving afterwards.
      expect(await send(ready.sessions[0]!, 'GET', '/api/v1/auth/me', undefined)).toBe(200);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.send('stop');
      await exited;
      await r.del(key);
    }
    expect(child.exitCode, stderr).toBe(0);
    expect(stderr).not.toMatch(/heap out of memory/i);
  }, 120_000);

  it.each([[{ disabled: true }], [{ role: 'viewer' }]])('H2: a checked edit whose body completes after %j gets 401 and writes nothing', async (change) => {
    const [actor, admin] = [await userSession(t, 'operator'), await userSession(t, 'admin')];
    const key = k(`revoked-${Object.keys(change)[0]}`);
    await r.set(key, 'opened');
    const pending = await paused(actor, 'POST', OPS, { op: 'string.set', key: utf8(key), value: utf8('written-after-revocation'), expect: { type: 'string', sha256: sha('opened') } });
    expect((await admin.req('PATCH', `/api/v1/admin/users/${actor.userId}`, change)).status).toBe(200);
    expect((await actor.req('GET', '/api/v1/auth/me')).status).toBe(401);
    const late = await pending.finish();
    expect(late.status, JSON.stringify(late.json)).toBe(401);
    expect(await r.get(key)).toBe('opened');
    expect(audits().filter((e) => e.action === 'auth.revoked' && e.userId === actor.userId)).toEqual([
      expect.objectContaining({ outcome: 'denied', databaseId: 'e2e', detail: expect.stringContaining('POST /api/v1/databases/:db/ops refused after its body was received') }),
    ]);
  });

  it('H2: a disabled admin cannot finish a paused PATCH that promotes another account (no password change)', async () => {
    const [actor, other, target] = [await userSession(t, 'admin'), await userSession(t, 'admin'), await userSession(t, 'viewer')];
    const pending = await paused(actor, 'PATCH', `/api/v1/admin/users/${target.userId}`, { role: 'admin' });
    expect((await other.req('PATCH', `/api/v1/admin/users/${actor.userId}`, { disabled: true })).status).toBe(200);
    expect((await actor.req('GET', '/api/v1/admin/users')).status).toBe(401);
    expect((await pending.finish()).status).toBe(401);
    expect(t.ctx.users.byId(target.userId)!.role).toBe('viewer');
  });

  it('H2: an account disabled while its checked edit reads is refused before MULTI; nothing is written', async () => {
    const [actor, admin] = [await userSession(t, 'operator'), await userSession(t, 'admin')];
    const key = k('revoked-reading');
    await r.set(key, 'opened');
    const sent: string[] = [];
    const restore = intercept(async (argv) => {
      sent.push(String(argv[0]));
      if (String(argv[0]) === 'TYPE') expect((await admin.req('PATCH', `/api/v1/admin/users/${actor.userId}`, { disabled: true })).status).toBe(200);
    });
    try {
      const res = await actor.req('POST', OPS, { op: 'string.set', key: utf8(key), value: utf8('mine'), expect: { type: 'string', sha256: sha('opened') } });
      expect(res.status, JSON.stringify(res.json)).toBe(401);
    } finally { restore(); }
    expect(sent).not.toContain('MULTI');
    expect(await r.get(key)).toBe('opened');
    expect(audits().find((e) => e.action === 'string.set' && e.userId === actor.userId)).toMatchObject({ outcome: 'denied', detail: expect.stringContaining('unauthenticated') });
  });

  it('M1: a type change between TYPE and the element read is a 409 type conflict over HTTP, audited as denied', async () => {
    const op = await userSession(t, 'operator');
    const key = k('type-read-race');
    await r.set(key, 'opened');
    let injected = false;
    const restore = intercept(async (argv) => {
      if (!injected && String(argv[0]) === 'STRLEN') { injected = true; await r.del(key); await r.hSet(key, 'f', 'theirs'); }
    });
    try {
      const res = await op.req('POST', OPS, { op: 'string.set', key: utf8(key), value: utf8('mine'), expect: { type: 'string', sha256: sha('opened') } });
      expect(res.status, JSON.stringify(res.json)).toBe(409);
      expect(res.json.error.conflict).toMatchObject({ reason: 'type', current: { type: 'hash' } });
      expect(res.json.error.conflict.current.expect).toBeUndefined();
    } finally { restore(); }
    expect(await r.hGetAll(key)).toEqual({ f: 'theirs' });
    expect(audits().find((e) => e.action === 'string.set' && e.userId === op.userId)).toMatchObject({ outcome: 'denied', detail: expect.stringContaining('conflict') });
  });

  describe('M1: every element read of a checked edit', () => {
    let conn: Conn;
    beforeAll(async () => { conn = await t.ctx.redis.conn('e2e', 'operator'); });
    /** `conn` with `before(argv)` run ahead of each command of its exclusive exchange. */
    const racing = (before: (argv: Arg[]) => Promise<void>): Conn => ({
      exclusive: ((key, fn, o) => conn.exclusive(key, (send) => fn(async (argv, so) => { await before(argv); return send(argv, so); }), o)) as Conn['exclusive'],
    }) as Conn;
    const run = (c: Conn, plan: CheckedPlan) => checkedWrite(c, plan, { timeout: 5000, maxValueBytes: 524_288 }).then(
      (v) => ({ ok: Buffer.from(v as Buffer).toString() }),
      (e: { code: string; status: number; message: string; extra?: { conflict?: unknown } }) => ({ code: e.code, status: e.status, message: e.message, conflict: e.extra?.conflict }),
    );

    const cases: { name: string; probe: Probe; type: string; opened: string; setup: (key: string) => Promise<unknown>; at: string; command: (key: string) => Arg[]; sha?: boolean }[] = [
      { name: 'string STRLEN', probe: { kind: 'string' }, type: 'string', opened: 'opened', setup: (x) => r.set(x, 'opened'), at: 'STRLEN', command: (x) => ['SET', x, 'mine'] },
      { name: 'string GET', probe: { kind: 'string' }, type: 'string', opened: 'opened', setup: (x) => r.set(x, 'opened'), at: 'GET', command: (x) => ['SET', x, 'mine'] },
      { name: 'hash HGET', probe: { kind: 'hash', field: Buffer.from('f') }, type: 'hash', opened: 'v', setup: (x) => r.hSet(x, 'f', 'v'), at: 'HGET', command: (x) => ['HSET', x, 'f', 'mine'] },
      { name: 'list LINDEX', probe: { kind: 'list', index: 0 }, type: 'list', opened: 'a', setup: (x) => r.rPush(x, 'a'), at: 'LINDEX', command: (x) => ['LSET', x, '0', 'mine'] },
      { name: 'zset ZSCORE', probe: { kind: 'zset', member: Buffer.from('m') }, type: 'zset', opened: '1', setup: (x) => r.zAdd(x, { score: 1, value: 'm' }), at: 'ZSCORE', command: (x) => ['ZADD', x, '2', 'm'] },
      { name: 'JSON JSON.GET', probe: { kind: 'json' }, type: 'ReJSON-RL', opened: '{"a":1}', setup: (x) => r.sendCommand(['JSON.SET', x, '$', '{"a":1}']), at: 'JSON.GET', command: (x) => ['JSON.SET', x, '$.a', '2'] },
      { name: 'key rename GET', probe: { kind: 'key' }, type: 'string', opened: 'opened', setup: (x) => r.set(x, 'opened'), at: 'GET', command: (x) => ['RENAME', x, `${x}:to`] },
    ];
    it.each(cases)('$name: the replaced key is a 409 type conflict, and the other writer keeps it', async (c) => {
      const key = k(`m1-${c.at}-${c.probe.kind}`);
      await r.del(key);
      await c.setup(key);
      // Another client replaces the key with another type right before the element read.
      const now = c.type === 'hash' ? 'string' : 'hash';
      let injected = false;
      const out = await run(racing(async (argv) => {
        if (injected || String(argv[0]) !== c.at) return;
        injected = true;
        await r.del(key);
        await (now === 'hash' ? r.hSet(key, 'theirs', 'x') : r.set(key, 'theirs'));
      }), { key: Buffer.from(key), probe: c.probe, expect: { type: c.type, sha256: sha(c.opened) }, command: c.command(key) });
      expect(injected).toBe(true);
      expect(out).toMatchObject({ code: 'conflict', status: 409, conflict: { reason: 'type', current: { type: now } } });
      expect(await r.type(key)).toBe(now);
    });

    it('a key whose type keeps changing gets 409 after the bounded attempts; nothing is written', async () => {
      const key = k('m1-flapping');
      await r.set(key, 'opened');
      const sent: string[] = [];
      const out = await run(racing(async (argv) => {
        const cmd = String(argv[0]);
        sent.push(cmd);
        if (cmd === 'TYPE') { await r.del(key); await r.set(key, 'opened'); }
        if (cmd === 'STRLEN') { await r.del(key); await r.hSet(key, 'f', 'theirs'); }
      }), { key: Buffer.from(key), probe: { kind: 'string' }, expect: { type: 'string', sha256: sha('opened') }, command: ['SET', key, 'mine'] });
      expect(out).toMatchObject({ code: 'conflict', status: 409 });
      expect((out as { conflict: { current: { expect?: unknown } } }).conflict.current.expect).toBeUndefined();
      expect(sent.filter((x) => x === 'TYPE')).toHaveLength(4);
      expect(sent).not.toContain('MULTI');
      expect(await r.get(key)).toBe('opened');
    });

    it('after a change and a change back, the next attempt writes with one EXEC (UNWATCH cleared the touched flag)', async () => {
      const key = k('m1-aba');
      await r.set(key, 'opened');
      const sent: string[] = [];
      let watches = 0;
      const out = await run(racing(async (argv) => {
        const cmd = String(argv[0]);
        sent.push(cmd);
        if (cmd === 'STRLEN' && sent.filter((x) => x === 'STRLEN').length === 1) { await r.del(key); await r.hSet(key, 'f', 'theirs'); }
        if (cmd === 'WATCH' && watches++ === 1) { await r.del(key); await r.set(key, 'opened'); }
      }), { key: Buffer.from(key), probe: { kind: 'string' }, expect: { type: 'string', sha256: sha('opened') }, command: ['SET', key, 'mine'] });
      expect(out).toEqual({ ok: 'OK' });
      expect(sent.filter((x) => x === 'EXEC')).toHaveLength(1);
      expect(await r.get(key)).toBe('mine');
    });

    it('other Redis errors in the read phase stay errors, not conflicts', async () => {
      const key = k('m1-error');
      await r.set(key, 'opened');
      // A real error reply from Redis for the element read (an unknown command in place of STRLEN).
      const broken: Conn = {
        exclusive: ((x, fn, o) => conn.exclusive(x, (send) => fn((argv, so) => send(String(argv[0]) === 'STRLEN' ? ['RC-R6-NOT-A-COMMAND', ...argv.slice(1)] : argv, so)), o)) as Conn['exclusive'],
      } as Conn;
      const out = await run(broken, { key: Buffer.from(key), probe: { kind: 'string' }, expect: { type: 'string', sha256: sha('opened') }, command: ['SET', key, 'mine'] });
      expect(out).toMatchObject({ code: 'redis_error', status: 502 });
      expect(await r.get(key)).toBe('opened');
    });
  });

  it('L1: expect on an op that cannot carry one is a 400 and nothing runs; the same op without it works', async () => {
    const op = await userSession(t, 'operator');
    const key = k('l1');
    await r.del(key);
    await r.hSet(key, { f: 'v', g: 'w' });
    const stale = { type: 'hash', sha256: sha('stale') };
    const bodies: Record<string, unknown>[] = [
      { op: 'key.expire', key: utf8(key), ttl: 120 },
      { op: 'key.persist', key: utf8(key) },
      { op: 'hash.delete', key: utf8(key), fields: [utf8('f')] },
      { op: 'set.add', key: utf8(k('l1-set')), members: [utf8('m')] },
      { op: 'list.push', key: utf8(k('l1-list')), values: [utf8('v')], end: 'tail' },
    ];
    for (const body of bodies) {
      for (const expectation of [stale, null]) {
        const res = await op.req('POST', OPS, { ...body, expect: expectation });
        expect(res.status, `${body.op}: ${JSON.stringify(res.json)}`).toBe(400);
        expect(res.json.error.message).toContain(`expect: not supported for ${body.op}`);
      }
    }
    expect(await r.ttl(key)).toBe(-1);
    expect(await r.hGetAll(key)).toEqual({ f: 'v', g: 'w' });
    expect(await r.exists([k('l1-set'), k('l1-list')])).toBe(0);
    const ok = await op.req('POST', OPS, bodies[0]);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(await r.ttl(key)).toBeGreaterThan(100);
  });
});
