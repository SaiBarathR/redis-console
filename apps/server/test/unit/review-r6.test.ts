/**
 * Review v0.2 r6 (final server review), on real HTTP sockets:
 * - H1: request bodies take a budget before any byte is read (counts per user and server-wide, bytes for large
 *   bodies, chunked bodies at the route limit), refused at once when full and released on every way out.
 * - H2: the session and account are checked again after the body was received and after a work-slot wait.
 */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import type { AppConfig } from '../../src/config.ts';
import { oidcSession, testConfig, userSession, type Client, type TestApp } from '../helpers.ts';

const MiB = 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const path = '/api/v1/databases/e2e/r6';
const tiny = '/api/v1/databases/e2e/r6-tiny';

interface Sent { socket: net.Socket; status: Promise<number | undefined>; text: () => string; write(data: string | Buffer): void }

async function fixture(o: { server?: Partial<AppConfig['server']>; policy?: Partial<AppConfig['policy']> } = {}) {
  const config = testConfig();
  Object.assign(config.server, o.server ?? {});
  Object.assign(config.policy, o.policy ?? {});
  const auditLines: string[] = [];
  const built = await buildApp(config, { logger: false, dbPath: ':memory:', auditWrite: (l) => auditLines.push(l) });
  let ran = 0, held = 0, headers = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => { release = r; });
  built.app.route({ method: ['GET', 'POST'], url: '/api/v1/databases/:db/r6', handler: async (req) => {
    ran++;
    if ((req.body as { hold?: boolean } | undefined)?.hold) { held++; await barrier; }
    return { ok: true };
  } });
  built.app.post('/api/v1/databases/:db/r6-tiny', { bodyLimit: 1024 }, async () => ({ ok: true }));
  // Registered after the app's hooks: when it runs, authentication and the body reservation are done.
  built.app.addHook('onRequest', async (req) => { if (req.headers['x-r6-probe']) headers++; });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const t: TestApp = { ...built, auditLines, close: () => built.app.close() };
  cleanups.push(async () => { release(); await t.close(); });
  const port = (t.app.server.address() as net.AddressInfo).port;

  /** Headers (Content-Length `length`, or chunked) and `first` body bytes; `status` is the response's, if any. */
  const send = async (c: Client, length: number | 'chunked', first: string | Buffer = '', o: { url?: string; method?: string } = {}): Promise<Sent> => {
    const s = net.connect(port, '127.0.0.1');
    s.on('error', () => {});
    cleanups.push(() => { s.destroy(); });
    let text = '';
    const status = new Promise<number | undefined>((resolve) => {
      s.on('data', (d) => { text += d.toString('latin1'); const m = /^HTTP\/1\.1 (\d{3})/.exec(text); if (m) resolve(Number(m[1])); });
      s.on('close', () => resolve(undefined));
    });
    await new Promise<void>((r) => s.once('connect', () => r()));
    const before = headers;
    s.write(`${o.method ?? 'POST'} ${o.url ?? path} HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost:4100\r\nCookie: ${c.cookie}\r\nX-CSRF-Token: ${c.csrf}\r\n`
      + `X-R6-Probe: 1\r\nContent-Type: application/json\r\n${length === 'chunked' ? 'Transfer-Encoding: chunked' : `Content-Length: ${length}`}\r\n\r\n`);
    if (first.length) s.write(first);
    // Wait until the server has run its onRequest hooks for it, or answered it.
    await Promise.race([until(() => headers > before), status]);
    return { socket: s, status, text: () => text, write: (d) => s.write(d) };
  };
  const until = async (condition: () => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!condition()) { if (Date.now() > end) throw new Error('condition not reached'); await sleep(5); }
  };
  /** The response status within `ms`, or undefined (still waiting for its body). */
  const answered = (x: Sent, ms = 1000) => Promise.race([x.status, sleep(ms).then(() => undefined)]);
  /** The whole error response of a request answered at once. */
  const refusal = async (x: Sent) => {
    const status = await answered(x);
    await until(() => /\r\n\r\n[\s\S]*\}$/.test(x.text()));
    return { status, text: x.text() };
  };
  return { t, port, send, until, answered, refusal, release, ran: () => ran, held: () => held, usage: (c?: Client) => t.ctx.ingress.usage(c?.userId) };
}

const json = (bytes: number) => Buffer.from(JSON.stringify({ pad: 'x'.repeat(bytes - 10) }));

describe('review r6 H1: request bodies are budgeted before they are read', () => {
  it("refuses a user's large bodies beyond their share at once, before reading them; others and small requests go on", async () => {
    const f = await fixture();
    const [a, b, c] = [oidcSession(f.t, 'operator'), oidcSession(f.t, 'operator'), oidcSession(f.t, 'admin')];
    const stalled = [await f.send(a, 11 * MiB, '{'), await f.send(a, 11 * MiB, '{')];
    const started = Date.now();
    const third = await f.refusal(await f.send(a, 11 * MiB));
    expect(third.status).toBe(429);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(third.text).toContain('request-body budget (24 MiB)');
    // Another user's upload still fits the server-wide budget; it is admitted and waits for its body.
    const other = await f.send(b, 11 * MiB, '{');
    expect(await f.answered(other, 200)).toBeUndefined();
    for (const x of stalled) expect(await f.answered(x, 10)).toBeUndefined();
    expect(f.usage(a)).toEqual({ bodies: 2, bytes: 22 * MiB });
    for (const x of [a, b, c]) expect((await x.req('POST', path, {})).status).toBe(200);
  });

  it('shares a server-wide byte budget; small bodies only take a count', async () => {
    const f = await fixture({ policy: { maxBodyBytesInFlight: 24 * MiB } });
    const [a, b, c] = [oidcSession(f.t, 'operator'), oidcSession(f.t, 'operator'), oidcSession(f.t, 'viewer')];
    await f.send(a, 11 * MiB, '{');
    await f.send(b, 11 * MiB, '{');
    const late = await f.refusal(await f.send(c, 11 * MiB));
    expect(late.status).toBe(429);
    expect(late.text).toContain("server's request-body budget (24 MiB)");
    const small = await f.send(c, 20, '{"pad":"xxxxxxxxxx"}');
    expect(await f.answered(small)).toBe(200);
    await f.until(() => f.usage().bodies === 2);
    expect(f.usage()).toEqual({ bodies: 2, bytes: 22 * MiB });
  });

  it('a chunked body reserves the route limit', async () => {
    const f = await fixture();
    const a = oidcSession(f.t, 'operator');
    await f.send(a, 'chunked', '1\r\n{\r\n');
    await f.send(a, 'chunked');
    const third = await f.send(a, 'chunked');
    expect(await f.answered(third)).toBe(429);
    expect(f.usage(a)).toEqual({ bodies: 2, bytes: 24 * MiB });
    // A small route's chunked body reserves that route's (small) limit and completes normally.
    const ok = await f.send(a, 'chunked', '2\r\n{}\r\n0\r\n\r\n', { url: tiny });
    expect(await f.answered(ok)).toBe(200);
  });

  it('limits how many bodies a user and the server receive at once', async () => {
    const f = await fixture({ policy: { maxBodiesInFlight: 16 } });
    const users = Array.from({ length: 9 }, () => oidcSession(f.t, 'viewer'));
    for (const u of users.slice(0, 8)) for (let i = 0; i < 2; i++) await f.send(u, 20, '{');
    const mine = await f.refusal(await f.send(users[0]!, 20));
    expect(mine.status).toBe(429);
    expect(mine.text).toContain('limit 2 request bodies');
    const server = await f.refusal(await f.send(users[8]!, 20));
    expect(server.status).toBe(429);
    expect(server.text).toContain('too many request bodies (limit 16)');
    // Requests without a body are not part of it.
    expect((await users[8]!.req('GET', path)).status).toBe(200);
  });

  it('releases the reservation on success, parse failure, receive timeout and disconnect; over-limit lengths get 413 at once', async () => {
    const f = await fixture({ server: { requestTimeoutMs: 800, headersTimeoutMs: 500 } });
    const a = oidcSession(f.t, 'operator');
    const body = json(200 * 1024);
    const ok = await f.send(a, body.length, body);
    expect(await f.answered(ok)).toBe(200);
    const bad = await f.send(a, body.length, Buffer.concat([body.subarray(0, -1), Buffer.from('!')]));
    expect(await f.answered(bad)).toBe(400);
    await f.until(() => f.usage(a).bodies === 0);
    const gone = await f.send(a, 11 * MiB, '{');
    expect(f.usage(a).bytes).toBe(11 * MiB);
    gone.socket.destroy();
    await f.until(() => f.usage(a).bodies === 0);
    const slow = await f.send(a, 11 * MiB, '{');
    expect(f.usage(a).bytes).toBe(11 * MiB);
    await f.until(() => f.usage(a).bodies === 0, 3000);
    await slow.status;
    const tooBig = await f.send(a, 2048, '', { url: tiny });
    expect(await f.answered(tooBig, 500)).toBe(413);
    expect(tooBig.text()).toMatch(/connection: close/i);
    expect(f.usage()).toEqual({ bodies: 0, bytes: 0 });
  });

  it('a parsed body waiting for a work slot keeps its reservation; stalled bodies still take no work slot', async () => {
    const f = await fixture({ policy: { maxInflightCommands: 2 } });
    const a = oidcSession(f.t, 'operator');
    const holding = a.req('POST', path, { hold: true });
    await f.until(() => f.held() === 1);
    // A whole 11 MiB body arrives and is parsed, then waits for the user's only slot.
    const body = json(11 * MiB);
    const waiting = await f.send(a, body.length, body);
    await sleep(300);
    expect(f.ran()).toBe(1);
    expect(f.usage(a)).toEqual({ bodies: 2, bytes: body.length });
    // A stalled upload of another user neither waits for nor takes a slot.
    const b = oidcSession(f.t, 'viewer');
    await f.send(b, 11 * MiB, '{');
    expect((await b.req('POST', path, {})).status).toBe(200);
    f.release();
    expect((await holding).status).toBe(200);
    expect(await f.answered(waiting, 2000)).toBe(200);
    await f.until(() => f.usage(a).bodies === 0);
  });
});

describe('review r6 H2: the actor is checked again after the body and after a slot wait', () => {
  it.each([[{ disabled: true }], [{ role: 'viewer' }]])('a body finished after %j of its account gets 401; the handler never runs', async (change) => {
    const f = await fixture();
    const [actor, admin] = [await userSession(f.t, 'operator'), await userSession(f.t, 'admin')];
    const body = '{"write":true}';
    const pending = await f.send(actor, body.length, body.slice(0, -1));
    expect((await admin.req('PATCH', `/api/v1/admin/users/${actor.userId}`, change)).status).toBe(200);
    pending.write(body.slice(-1));
    expect(await f.answered(pending)).toBe(401);
    expect(f.ran()).toBe(0);
    const denied = f.t.auditLines.map((l) => JSON.parse(l)).filter((e) => e.action === 'auth.revoked');
    expect(denied).toEqual([expect.objectContaining({ userId: actor.userId, outcome: 'denied', databaseId: 'e2e', detail: expect.stringContaining('POST /api/v1/databases/:db/r6 refused after its body was received') })]);
  });

  it('a body finished and abandoned at once after revocation never reaches the handler', async () => {
    const f = await fixture();
    const [actor, admin] = [await userSession(f.t, 'operator'), await userSession(f.t, 'admin')];
    const body = '{"write":true}';
    const pending = await f.send(actor, body.length, body.slice(0, -1));
    expect((await admin.req('PATCH', `/api/v1/admin/users/${actor.userId}`, { disabled: true })).status).toBe(200);
    pending.socket.end(body.slice(-1));
    await f.until(() => f.t.auditLines.some((l) => JSON.parse(l).action === 'auth.revoked'));
    await sleep(100);
    expect(f.ran()).toBe(0);
    expect(f.usage()).toEqual({ bodies: 0, bytes: 0 });
  });

  it('a disabled admin cannot finish a paused PATCH that promotes another account', async () => {
    const f = await fixture();
    const [actor, other, target] = [await userSession(f.t, 'admin'), await userSession(f.t, 'admin'), await userSession(f.t, 'viewer')];
    const body = '{"role":"admin"}';
    const pending = await f.send(actor, body.length, body.slice(0, -1), { method: 'PATCH', url: `/api/v1/admin/users/${target.userId}` });
    expect((await other.req('PATCH', `/api/v1/admin/users/${actor.userId}`, { disabled: true })).status).toBe(200);
    pending.write(body.slice(-1));
    expect(await f.answered(pending)).toBe(401);
    expect(f.t.ctx.users.byId(target.userId)!.role).toBe('viewer');
    expect(f.t.auditLines.some((l) => JSON.parse(l).action === 'auth.revoked')).toBe(true);
  });

  it('an account disabled while its request waits for a work slot gets 401 once the slot is free', async () => {
    const f = await fixture({ policy: { maxInflightCommands: 2 } });
    const [actor, admin] = [await userSession(f.t, 'operator'), await userSession(f.t, 'admin')];
    const holding = actor.req('POST', path, { hold: true });
    await f.until(() => f.held() === 1);
    const waiting = actor.req('POST', path, { write: true });
    await sleep(100);
    expect((await admin.req('PATCH', `/api/v1/admin/users/${actor.userId}`, { disabled: true })).status).toBe(200);
    f.release();
    expect((await holding).status).toBe(200);
    expect((await waiting).status).toBe(401);
    expect(f.ran()).toBe(1);
    expect(f.t.auditLines.map((l) => JSON.parse(l)).find((e) => e.action === 'auth.revoked')?.detail).toContain('after waiting for a database request slot');
  });
});
