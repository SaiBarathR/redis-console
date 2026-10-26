/**
 * Review v0.2 fix verification, N1 (`docs/research/18-v02-server-verify.md`), against the 6411 sandbox over
 * real HTTP and Redis sockets. A write that passed the HTTP gates but still waits for a Redis socket or connection is
 * refused once its account is revoked: 401 (CLI, publish) or an `unauthenticated` line (workbench), nothing sent.
 * Nothing in the server is mocked or instrumented: four real BLPOPs fill the operator tier's pool of four, and a TCP
 * relay in front of 6411 holds a connection's handshake.
 *
 * N1 follow-up (`docs/research/19-v02-n1-verify.md` §2): a fixed-size typed write was checked before node-redis
 * queued it, and node-redis writes on a later turn of the event loop. Those tests hold a real admin PATCH before its
 * handler and release it right after the command was handed to its connection; nothing Redis-side is held or delayed.
 */
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ErrorReply } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { resolveConfig } from '../../src/config.ts';
import { toHttpError } from '../../src/redis/exec.ts';
import { TM_BIN, TM_STR, fixedReply, type Arg, type Conn, type SendOpts, type Target } from '../../src/redis/manager.ts';
import { TM_REPLY, toReply } from '../../src/redis/reply.ts';
import { ORIGIN, cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, testConfigRaw, userSession, utf8, type Client, type TestApp } from '../helpers.ts';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A TCP relay to 6411. While held, it accepts connections but forwards no byte until it is released. */
async function relay() {
  let holding = false;
  const waiting: (() => void)[] = [];
  const sockets = new Set<net.Socket>();
  const state = { held: 0 };
  const server = net.createServer((client) => {
    const upstream = net.connect(6411, '127.0.0.1');
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('error', () => { client.destroy(); upstream.destroy(); });
      s.on('close', () => { sockets.delete(s); client.destroy(); upstream.destroy(); });
    }
    const pipe = () => { client.pipe(upstream); upstream.pipe(client); };
    if (!holding) return pipe();
    state.held++;
    waiting.push(pipe);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    state,
    hold: () => { holding = true; state.held = 0; },
    release: () => { holding = false; for (const pipe of waiting.splice(0)) pipe(); },
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

describe.skipIf(!sandboxUp)('review v0.2 N1: queued writes lose a revoked authority', () => {
  let t: TestApp;
  let r: Admin;
  let base: string;
  let proxy: Awaited<ReturnType<typeof relay>>;
  const P = keyPrefix('n1');
  const k = (s: string) => `${P}${s}`;
  /** An admin request sent with `x-n1-barrier` waits right before its handler until `release()`. */
  const barrier: { arrived?: () => void; release?: () => void } = {};

  beforeAll(async () => {
    proxy = await relay();
    const raw = testConfigRaw();
    const e2e = (raw.databases as Record<string, unknown>[]).find((d) => d.id === 'e2e')!;
    (raw.databases as Record<string, unknown>[]).push({ ...e2e, id: 'relay', name: 'E2E via relay', url: `redis://127.0.0.1:${proxy.port}` });
    (raw.server as Record<string, unknown>).dataDir = mkdtempSync(path.join(tmpdir(), 'rconsole-test-'));
    const config = resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } });
    expect(config.databases.find((d) => d.id === 'e2e')!.poolSize).toBe(4);
    const auditLines: string[] = [];
    const built = await buildApp(config, { logger: false, dbPath: ':memory:', auditWrite: (l) => auditLines.push(l) });
    // Test-only, after every server hook: the callback form runs the handler synchronously inside `release()`, and an
    // admin PATCH `{disabled: true}` has no await, so the account is disabled and its sessions revoked when it returns.
    built.app.addHook('preHandler', (req, _reply, done) => {
      if (!req.headers['x-n1-barrier']) { done(); return; }
      barrier.release = () => done();
      barrier.arrived?.();
    });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
    t = { ...built, auditLines, close: () => built.app.close() };
    r = await sandboxAdmin();
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await proxy?.close();
    await cleanupPrefix(P);
  });

  /** A real HTTP request (not inject), so the request runs through the server's actual sockets. */
  async function api(c: Client, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const res = await fetch(base + url, {
      method,
      headers: { origin: ORIGIN, cookie: c.cookie, 'x-csrf-token': c.csrf, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: await res.json() };
  }
  const audits = (username: string) => t.auditLines.map((l) => JSON.parse(l) as Record<string, any>).filter((e) => e.username === username);
  /** Disable through the public admin API; afterwards the actor's fresh requests get 401. */
  async function disable(admin: Client, actor: Client) {
    expect((await api(admin, 'PATCH', `/api/v1/admin/users/${actor.userId}`, { disabled: true })).status).toBe(200);
    expect((await api(actor, 'GET', '/api/v1/auth/me')).status).toBe(401);
  }
  /** Operator command sockets blocked in BLPOP right now (`flags` has `b`; an idle socket keeps its last `cmd`). */
  const blocked = async () => String(await r.sendCommand(['CLIENT', 'LIST'])).split('\n')
    .filter((l) => l.includes('name=rconsole-operator-capped') && l.includes('cmd=blpop') && /\bflags=\S*b/.test(l)).length;

  for (const route of ['cli', 'workbench'] as const) {
    it(`${route}: a write queued behind four BLPOPs in the full pool is refused when its account is disabled meanwhile`, async () => {
      const admin = await userSession(t, 'admin');
      const actors = await Promise.all(Array.from({ length: 4 }, () => userSession(t, 'operator')));
      const actor = actors[0]!;
      const key = k(`pool-${route}`), second = k(`pool-${route}-second`);
      await r.set(key, 'opened');
      // The command table and one pooled socket are ready, as in normal use.
      expect((await api(actor, 'POST', '/api/v1/databases/e2e/cli', { argv: ['PING'] })).status).toBe(200);
      expect(await blocked()).toBe(0);
      // One blocking command per user (the per-user limit): four operators park all four sockets of the pool.
      const holds = actors.map((_, i) => k(`hold-${route}-${i}`));
      const blpops = actors.map((a, i) => api(a, 'POST', '/api/v1/databases/e2e/cli', { argv: ['BLPOP', holds[i]!, '1.5'] }));
      for (let i = 0; i < 300 && (await blocked()) < 4; i++) await sleep(5);
      expect(await blocked()).toBe(4);

      const body = route === 'cli' ? { argv: ['SET', key, 'after-disabled'] } : { script: `SET ${key} after-disabled\nSET ${second} after-disabled` };
      let done = false;
      const pending = api(actor, 'POST', `/api/v1/databases/e2e/${route}`, body).then((v) => { done = true; return v; });
      await sleep(100);
      expect(done).toBe(false); // passed the HTTP gates, waiting for a Redis socket
      await disable(admin, actor);
      for (const hold of holds) await r.rPush(hold, 'release');
      const res = await pending;
      await Promise.all(blpops);

      if (route === 'cli') {
        expect(res.status).toBe(401);
        expect(res.json.error).toMatchObject({ code: 'unauthenticated', message: expect.stringMatching(/was not sent/) });
        expect(audits(actor.username).find((e) => e.action === 'cli.exec' && e.outcome === 'denied')?.detail).toMatch(/^unauthenticated/);
      } else {
        expect(res.status).toBe(200);
        const [first, rest] = res.json.results;
        expect(first.error).toMatchObject({ code: 'unauthenticated', message: expect.stringMatching(/was not sent/) });
        expect(rest.error).toMatchObject({ code: 'unauthenticated', message: expect.stringMatching(/rest of the script was not run/) });
        expect(audits(actor.username).find((e) => e.action === 'workbench.exec' && e.command === 'SET')).toMatchObject({ outcome: 'denied' });
      }
      expect(await r.get(key)).toBe('opened');
      expect(await r.exists(second)).toBe(0);
      expect(audits(actor.username).filter((e) => e.action === 'auth.revoked')).toEqual([
        expect.objectContaining({ outcome: 'denied', databaseId: 'e2e', detail: expect.stringMatching(/refused before a Redis command was sent/) }),
      ]);
      // The refused command released its pool socket and command slot: the pool serves the others normally.
      for (const a of actors.slice(1)) expect((await api(a, 'POST', '/api/v1/databases/e2e/cli', { argv: ['GET', key] })).json.reply).toEqual({ t: 'str', v: utf8('opened') });
    });
  }

  it('fixed-size typed writes are checked right before they are sent, too', async () => {
    const key = k('scalar');
    await r.set(key, 'opened');
    const conn = await t.ctx.redis.conn('e2e', 'operator');
    for (const argv of [['DEL', key], ['EXPIRE', key, '100'], ['HSET', k('scalar-hash'), 'f', 'v']]) {
      await expect(conn.send(argv, { key: argv[1], stillAllowed: () => false })).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
    }
    expect(await r.get(key)).toBe('opened');
    expect(await r.ttl(key)).toBe(-1);
    expect(await r.exists(k('scalar-hash'))).toBe(0);
    expect(await conn.send(['EXPIRE', key, '100'], { key, stillAllowed: () => true })).toBe(1);
  });

  // `first`: the request opens the operator tier's first connection. `socket`: the admin tier is connected, but its
  // command pool is empty, so the request opens a new command socket.
  for (const window of ['first', 'socket'] as const) {
    it(`publish: a message whose connection handshake is held is refused when its account is disabled meanwhile (${window} connection)`, async () => {
      const admin = await userSession(t, 'admin');
      const actor = await userSession(t, window === 'first' ? 'operator' : 'admin');
      const channel = k(`publish-${window}`);
      const sub = r.duplicate();
      sub.on('error', () => {});
      await sub.connect();
      const messages: string[] = [];
      await sub.subscribe(channel, (m) => messages.push(m));
      try {
        if (window === 'socket') {
          await t.ctx.redis.conn('relay', 'admin');
          expect(t.ctx.redis.status('relay', 'admin').status).toBe('connected');
        }
        proxy.hold();
        let done = false;
        const pending = api(actor, 'POST', '/api/v1/databases/relay/pubsub/publish', { channel, message: utf8('after-disabled') }).then((v) => { done = true; return v; });
        for (let i = 0; i < 400 && proxy.state.held === 0; i++) await sleep(5);
        expect(proxy.state.held).toBeGreaterThan(0); // the publish waits for its connection
        await sleep(50);
        expect(done).toBe(false);
        await disable(admin, actor);
        proxy.release();
        const res = await pending;
        expect(res.status).toBe(401);
        expect(res.json.error).toMatchObject({ code: 'unauthenticated', message: expect.stringMatching(/was not sent/) });
        await sleep(200);
        expect(messages).toEqual([]);
        expect(audits(actor.username).find((e) => e.action === 'pubsub.publish')).toMatchObject({ outcome: 'denied' });
        expect(audits(actor.username).filter((e) => e.action === 'auth.revoked')).toEqual([expect.objectContaining({ outcome: 'denied', databaseId: 'relay' })]);
        // Normal use is unaffected: another user's publish through the relay is delivered.
        const other = await userSession(t, window === 'first' ? 'operator' : 'admin');
        expect((await api(other, 'POST', '/api/v1/databases/relay/pubsub/publish', { channel, message: utf8('still-works') })).json).toEqual({ receivers: 1 });
        for (let i = 0; i < 100 && !messages.length; i++) await sleep(5);
        expect(messages).toEqual(['still-works']);
      } finally {
        proxy.release();
        await sub.close();
      }
    });
  }

  /**
   * Calls `fire` once, right after the request's first `cmd` was handed to its connection (`send` returned; the
   * command is not held). Wraps the operator tier's Conn and its primaries as the request's scope gets them.
   */
  function onHandoff(cmd: string, fire: () => void): () => void {
    const manager = t.ctx.redis;
    const original = manager.conn.bind(manager);
    let fired = false;
    const wrap = (target: Target): Target => ({
      label: target.label,
      send: <T,>(args: Arg[], o?: SendOpts) => {
        const sent = target.send<T>(args, o);
        if (!fired && String(args[0]).toUpperCase() === cmd) {
          fired = true;
          fire();
        }
        return sent;
      },
    });
    manager.conn = async (db, role) => {
      const c = await original(db, role);
      if (db !== 'e2e' || role !== 'operator') return c;
      return {
        ...wrap(c), mode: c.mode, primaries: async () => (await c.primaries()).map(wrap),
        dedicated: (signal, stillAllowed) => c.dedicated(signal, stillAllowed), exclusive: (key, fn, o) => c.exclusive(key, fn, o),
        pipeline: (commands, o) => c.pipeline(commands, o), close: () => c.close(), destroy: () => c.destroy(),
      } satisfies Conn;
    };
    return () => { Reflect.deleteProperty(manager, 'conn'); };
  }

  // Review v0.2 N1 follow-up. Before the fix the check ran when node-redis queued the command, and node-redis wrote
  // it on a later turn of the event loop: a revocation in between let it through (200, data changed). Now an actor-
  // checked command goes through the measured transport, which checks in the same synchronous step as the write.
  for (const timing of ['at once', 'in a microtask'] as const) {
    for (const op of ['key.expire', 'hash.set', 'bulk-delete'] as const) {
      it(`${op}: an account disabled right after the command was handed to its connection (${timing}) is refused; nothing changes`, async () => {
        const admin = await userSession(t, 'admin');
        const actor = await userSession(t, 'operator');
        const key = k(`handoff-${op}-${timing === 'at once' ? 'now' : 'micro'}`);
        const bulk = [1, 2, 3].map((i) => `${key}:${i}`);
        if (op === 'key.expire') await r.set(key, 'opened');
        if (op === 'hash.set') await r.hSet(key, 'f', 'opened');
        if (op === 'bulk-delete') for (const b of bulk) await r.set(b, 'opened');
        // Both of the tier's pools are connected and idle, as in normal use.
        expect((await api(actor, 'POST', '/api/v1/databases/e2e/cli', { argv: ['PING'] })).status).toBe(200);
        expect((await api(actor, 'POST', '/api/v1/databases/e2e/key/read', { key: utf8(op === 'bulk-delete' ? bulk[0]! : key) })).status).toBe(200);
        const url = `/api/v1/databases/e2e/${op === 'bulk-delete' ? 'bulk-delete' : 'ops'}`;
        let body: Record<string, unknown> = op === 'key.expire' ? { op, key: utf8(key), ttl: 100 }
          : op === 'hash.set' ? { op, key: utf8(key), entries: [{ field: utf8('f'), value: utf8('after-disabled') }] }
            : { match: `${key}:*` };
        if (op === 'bulk-delete') {
          const first = await api(actor, 'POST', url, body);
          expect(first.status, JSON.stringify(first.json)).toBe(428);
          const ch = first.json.error.confirmation;
          body = { ...body, confirmation: { token: ch.token, ...(ch.level === 'typed' ? { typed: ch.expectedText } : {}) } };
        }

        // The admin's PATCH {disabled: true} has passed every server check and waits right before its handler.
        const arrived = new Promise<void>((res) => { barrier.arrived = res; });
        const revoking = api(admin, 'PATCH', `/api/v1/admin/users/${actor.userId}`, { disabled: true }, { 'x-n1-barrier': '1' });
        await arrived;
        let released = false;
        let disabledAtRelease: boolean | undefined;
        const release = () => {
          if (released) return;
          released = true;
          barrier.release!();
          disabledAtRelease = t.ctx.users.byId(actor.userId)?.disabled;
        };
        const restore = onHandoff(op === 'key.expire' ? 'EXPIRE' : op === 'hash.set' ? 'HSET' : 'UNLINK', () => {
          if (timing === 'at once') release();
          else queueMicrotask(release);
        });
        let res: Awaited<ReturnType<typeof api>>;
        try {
          res = await api(actor, 'POST', url, body);
        } finally {
          restore();
          release();
        }
        expect((await revoking).status).toBe(200);
        expect(disabledAtRelease).toBe(true); // the revocation was complete when the barrier returned

        expect(res.status, JSON.stringify(res.json)).toBe(401);
        expect(res.json.error).toMatchObject({
          code: 'unauthenticated',
          message: op === 'bulk-delete' ? expect.stringMatching(/stopped after deleting 0 key/) : expect.stringMatching(/was not sent/),
        });
        if (op === 'key.expire') {
          expect(await r.ttl(key)).toBe(-1);
          expect(await r.get(key)).toBe('opened');
        }
        if (op === 'hash.set') expect(await r.hGetAll(key)).toEqual({ f: 'opened' });
        if (op === 'bulk-delete') expect(await r.exists(bulk)).toBe(3);
        expect((await api(actor, 'GET', '/api/v1/auth/me')).status).toBe(401);
        expect(audits(actor.username).filter((e) => e.action === 'auth.revoked')).toEqual([
          expect.objectContaining({ outcome: 'denied', databaseId: 'e2e', detail: expect.stringMatching(/refused before a Redis command was sent/) }),
        ]);
        expect(audits(actor.username).find((e) => e.action === (op === 'bulk-delete' ? 'key.bulk-delete' : op) && e.outcome === 'denied')).toBeDefined();
      });
    }
  }

  it('fixed-size replies decode the same on the measured transport as on node-redis: typed results and Reply trees are unchanged', async () => {
    const conn = await t.ctx.redis.conn('e2e', 'operator');
    // The fixed-size commands typed ops, key lists and bulk delete send. DBSIZE/LASTSAVE are left out: their values
    // depend on what other test files write to 6411 meanwhile.
    const script = (x: string): Arg[][] => [
      ['PING'],
      ['HSET', `${x}h`, 'a', '1', 'b', '2'], ['HSET', `${x}h`, 'a', '3'], ['HDEL', `${x}h`, 'a', 'zz'], ['HEXISTS', `${x}h`, 'b'], ['HLEN', `${x}h`],
      ['RPUSH', `${x}l`, 'a', 'b'], ['LPUSH', `${x}l`, 'z'], ['LSET', `${x}l`, '0', 'Z'], ['LSET', `${x}l`, '9', 'x'], ['LREM', `${x}l`, '1', 'a'], ['LLEN', `${x}l`],
      ['SADD', `${x}s`, 'a', 'b'], ['SREM', `${x}s`, 'a'], ['SISMEMBER', `${x}s`, 'b'], ['SCARD', `${x}s`],
      ['ZADD', `${x}z`, '1.5', 'a', '-inf', 'b'], ['ZREM', `${x}z`, 'b'], ['ZCARD', `${x}z`],
      ['XADD', `${x}x`, '1-1', 'f', 'v'], ['XADD', `${x}x`, '1-1', 'f', 'v'], ['XACK', `${x}x`, 'g', '1-1'], ['XDEL', `${x}x`, '1-1'], ['XLEN', `${x}x`],
      ['EXPIRE', `${x}h`, '100'], ['PEXPIRE', `${x}l`, '100000'], ['PERSIST', `${x}h`], ['TTL', `${x}h`], ['PTTL', `${x}missing`], ['TYPE', `${x}h`],
      ['EXISTS', `${x}h`, `${x}missing`], ['STRLEN', `${x}h`], ['MEMORY', 'USAGE', `${x}missing`],
      ['DEL', `${x}h`], ['UNLINK', `${x}l`, `${x}s`, `${x}z`, `${x}x`], ['EXISTS', `${x}h`],
    ];
    const shape = (v: unknown) => v instanceof Error
      ? { redisError: v instanceof ErrorReply, message: v.message, http: { ...toHttpError(v) } }
      : { value: v, reply: toReply(v, { maxBytes: 1 << 20, maxElements: 10_000 }) };
    let checks = 0;
    const allow = () => { checks++; return true; };
    for (const [name, typeMapping] of [['TM_REPLY', TM_REPLY], ['TM_BIN', TM_BIN], ['TM_STR', TM_STR]] as const) {
      const out: Record<'node' | 'measured', unknown[]> = { node: [], measured: [] };
      for (const path of ['node', 'measured'] as const) {
        for (const argv of script(k(`parity-${name}-${path}:`))) {
          expect(fixedReply(argv)).toBe(true);
          const o: SendOpts = { key: argv[1], typeMapping, ...(path === 'measured' ? { stillAllowed: allow } : {}) };
          out[path].push(shape(await conn.send(argv, o).catch((e: unknown) => e)));
        }
      }
      expect(out.measured, name).toEqual(out.node);
      expect(out.node.filter((x) => (x as { redisError?: boolean }).redisError).length, name).toBe(3); // LSET range, XADD id, STRLEN type
    }
    expect(checks).toBe(3 * script('').length); // each measured command was checked once: it went through the measured transport
  });
});
