/** Review v0.2 r5: real HTTP sockets, body/response backpressure and routed slot admission. */
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, BODY_LIMIT } from '../../src/app.ts';
import { testConfig, oidcSession, type TestApp, type Client } from '../helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const path = '/api/v1/databases/e2e/r5';
async function fixture(server: Record<string, unknown> = {}) {
  const config = testConfig();
  Object.assign(config.server, server);
  config.policy.maxInflightCommands = 4;
  const built = await buildApp(config, { logger: false, dbPath: ':memory:', auditWrite: () => {} });
  let held = 0, sent = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => { release = r; });
  built.app.route({ method: ['GET', 'POST'], url: path, handler: async (req) => {
    const body = req.body as { hold?: boolean; big?: boolean } | undefined;
    if (body?.hold) { held++; await barrier; }
    return { value: body?.big ? 'x'.repeat(16 * 1024 * 1024) : 'ok' };
  } });
  built.app.addHook('onSend', async (_req, _reply, payload) => { sent++; return payload; });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const t: TestApp = { ...built, auditLines: [], close: () => built.app.close() };
  cleanups.push(async () => { release(); await t.close(); });
  const port = (t.app.server.address() as net.AddressInfo).port;
  const clients = [oidcSession(t, 'viewer'), oidcSession(t, 'operator'), oidcSession(t, 'admin')];
  const socket = async (head: string) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('error', () => {});
    cleanups.push(() => { s.destroy(); });
    await once(s, 'connect');
    s.write(head);
    return s;
  };
  const headers = (c: Client, length: number) => `POST ${path} HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost:4100\r\nCookie: ${c.cookie}\r\nX-CSRF-Token: ${c.csrf}\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`;
  const until = async (condition: () => boolean) => {
    const end = Date.now() + 4000;
    while (!condition()) { if (Date.now() > end) throw new Error('condition not reached'); await sleep(10); }
  };
  return { t, port, clients, socket, headers, until, release, held: () => held, sent: () => sent };
}

describe('review r5 H1: request slots cover server work, not client IO', () => {
  it('more than a per-user share of stalled bodies cannot occupy user or global slots', async () => {
    const f = await fixture();
    for (const c of f.clients.slice(0, 2)) for (let i = 0; i < 3; i++) await f.socket(f.headers(c!, 20));
    await sleep(100);
    for (const c of f.clients) expect((await c!.req('POST', path, {})).status).toBe(200);
  });

  it('releases serialized payloads while slow readers still have pending writes', async () => {
    const f = await fixture();
    const held: net.Socket[] = [];
    for (const c of f.clients.slice(0, 2)) for (let i = 0; i < 2; i++) {
      const s = await f.socket(f.headers(c!, 12) + '{"big":true}');
      s.pause(); held.push(s);
    }
    await f.until(() => f.sent() >= 4);
    // The payload exceeds the OS send buffers, so close/finish cannot have released these slots.
    expect(held.every((s) => !s.destroyed)).toBe(true);
    for (const c of f.clients) expect((await c!.req('POST', path, {})).status).toBe(200);
  });

  it('allows a paced JSON upload up to the unchanged body limit', async () => {
    const f = await fixture({ requestTimeoutMs: 5000, headersTimeoutMs: 1000, connectionTimeoutMs: 1000 });
    const body = Buffer.from(JSON.stringify({ data: 'x'.repeat(BODY_LIMIT - 11) }));
    expect(body.length).toBe(BODY_LIMIT);
    const c = f.clients[0]!;
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: f.port, path, method: 'POST', headers: {
        origin: 'http://localhost:4100', cookie: c.cookie, 'x-csrf-token': c.csrf,
        'content-type': 'application/json', 'content-length': body.length,
      } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      void (async () => {
        for (let i = 0; i < body.length; i += 512 * 1024) {
          if (!req.write(body.subarray(i, i + 512 * 1024))) await once(req, 'drain');
          await sleep(10);
        }
        req.end();
      })().catch(reject);
    });
    expect(status).toBe(200);
  });
});

describe('review r5 M1: query values never exempt a routed request', () => {
  it.each(['?x=/stream', '?/workbench/cancel', '?x=%2Fstream', ''])('enforces the global gate with %s', async (query) => {
    const f = await fixture();
    const holding = f.clients.slice(0, 2).flatMap((c) => Array.from({ length: 2 }, () => c!.req('POST', path, { hold: true })));
    await f.until(() => f.held() === 4);
    try {
      expect((await f.clients[2]!.req('GET', path + query)).status).toBe(429);
    } finally { f.release(); await Promise.all(holding); }
    expect((await f.clients[2]!.req('GET', path)).status).toBe(200);
  });
});

describe('review r5 L2: finite connection and parser deadlines', () => {
  it('closes bare and stalled anonymous sockets, partial headers and keep-alive connections', async () => {
    const f = await fixture({ requestTimeoutMs: 700, headersTimeoutMs: 200, connectionTimeoutMs: 250, keepAliveTimeoutMs: 100 });
    const bare = await f.socket(''); bare.resume();
    const partial = await f.socket('GET / HTTP/1.1\r\nHost: localhost\r\n'); partial.resume();
    const body = await f.socket('POST /api/v1/auth/login HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost:4100\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n'); body.resume();
    const keep = await f.socket('GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n'); keep.resume();
    // Progress defeats the idle timer but must not defeat the absolute header/body deadlines.
    const drip = setInterval(() => { if (!partial.destroyed) partial.write('x'); if (!body.destroyed) body.write(' '); }, 50);
    try {
      await sleep(1800);
      expect([bare, partial, body, keep].map((s) => s.destroyed)).toEqual([true, true, true, true]);
    } finally { clearInterval(drip); }
  });

  it('closes a client that leaves a response larger than the send buffers unread', async () => {
    const f = await fixture({ connectionTimeoutMs: 200 });
    const s = await f.socket(f.headers(f.clients[0]!, 12) + '{"big":true}'); s.pause();
    await f.until(() => f.sent() === 1);
    await sleep(900);
    const sockets = await new Promise<number>((resolve, reject) => f.t.app.server.getConnections((err, n) => err ? reject(err) : resolve(n)));
    expect(sockets).toBe(0);
  });
});
