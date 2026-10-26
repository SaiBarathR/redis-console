/**
 * v0.3 follow-up 1: `server.trustProxy` behind real HTTP reverse proxies.
 *
 * Fastify 5.12.7 turns a numeric `trustProxy` into "trust nothing", so with `trustProxy: 1` every client appeared as
 * the proxy (audit log, per-address limits). The server now gives Fastify a trust function with Express/proxy-addr
 * semantics: a hop count N trusts the N nearest hops, so the client address is the Nth X-Forwarded-For entry from the
 * right. The proxies below are real HTTP reverse proxies that append the peer they saw to X-Forwarded-For, like
 * nginx's `$proxy_add_x_forwarded_for`. The edge proxy reports a fixed documentation address for the client
 * (203.0.113.7), because a test host has only two loopback addresses (127.0.0.1 and ::1) to tell hops apart.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { PUBLIC_URL, testConfig } from '../helpers.ts';

const CLIENT = '203.0.113.7';
const FORGED = '198.51.100.66';

interface Hop { url: { host: string; port: number }; close(): Promise<void> }

const closeServer = (s: http.Server) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); });

/** A reverse proxy listening on `listen`, forwarding to `upstream`, appending the peer (or `clientAs`) to X-Forwarded-For. */
async function proxy(listen: string, upstream: { host: string; port: number }, clientAs?: string): Promise<Hop> {
  const server = http.createServer((req, res) => {
    const peer = clientAs ?? req.socket.remoteAddress ?? '';
    const prior = req.headers['x-forwarded-for'];
    const headers = { ...req.headers, 'x-forwarded-for': prior ? `${Array.isArray(prior) ? prior.join(', ') : prior}, ${peer}` : peer };
    const up = http.request({ host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, listen, resolve); });
  return { url: { host: listen, port: (server.address() as AddressInfo).port }, close: () => closeServer(server) };
}

/** POST a failed sign-in to `to` and return the client address the audit log recorded for it. */
async function auditedIp(t: Started, to: { host: string; port: number }, forged?: string): Promise<string> {
  const before = t.auditLines.length;
  const body = JSON.stringify({ username: `nobody-${Math.random().toString(36).slice(2, 8)}`, password: 'not the password at all' });
  const status = await new Promise<number>((resolve, reject) => {
    const r = http.request({
      host: to.host, port: to.port, method: 'POST', path: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), origin: PUBLIC_URL, ...(forged ? { 'x-forwarded-for': forged } : {}) },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    r.on('error', reject);
    r.end(body);
  });
  expect(status).toBe(401);
  const line = t.auditLines.slice(before).map((l) => JSON.parse(l) as { action: string; ip: string }).find((e) => e.action === 'auth.login');
  expect(line, 'the failed sign-in is audited').toBeDefined();
  return line!.ip;
}

interface Started { auditLines: string[]; url: { host: string; port: number }; close(): Promise<void> }

/** The real server on a dual-stack socket: proxies reach it over ::1, direct clients over 127.0.0.1. */
async function startServer(trustProxy: boolean | number | string): Promise<Started> {
  const auditLines: string[] = [];
  const { app } = await buildApp(testConfig({ server: { trustProxy } }), { logger: false, dbPath: ':memory:', auditWrite: (l) => auditLines.push(l) });
  await app.listen({ host: '::', port: 0 });
  return { auditLines, url: { host: '127.0.0.1', port: (app.server.address() as AddressInfo).port }, close: () => app.close() };
}

let dualStack = true;
beforeAll(async () => {
  // Some CI sandboxes have no IPv6 loopback; the topology then cannot be built.
  const s = http.createServer();
  try {
    await new Promise<void>((resolve, reject) => { s.once('error', reject); s.listen(0, '::1', resolve); });
  } catch {
    dualStack = false;
  } finally {
    s.close();
  }
});

/**
 * One proxy: client → edge (127.0.0.1) → app, which sees the edge as ::1.
 * Two proxies: client → edge (127.0.0.1) → inner (::1, sees the edge as ::1) → app, which sees the inner proxy as
 * ::ffff:127.0.0.1. Returns the address the client talks to.
 */
async function chain(t: Started, proxies: 1 | 2): Promise<{ entry: Hop['url']; close(): Promise<void> }> {
  if (proxies === 1) {
    const edge = await proxy('127.0.0.1', { host: '::1', port: t.url.port }, CLIENT);
    return { entry: edge.url, close: () => edge.close() };
  }
  const inner = await proxy('::1', { host: '127.0.0.1', port: t.url.port });
  const edge = await proxy('127.0.0.1', inner.url, CLIENT);
  return { entry: edge.url, close: async () => { await edge.close(); await inner.close(); } };
}

describe('trustProxy behind real reverse proxies (v0.3 follow-up 1)', () => {
  const started: Started[] = [];
  const start = async (tp: boolean | number | string) => { const s = await startServer(tp); started.push(s); return s; };
  afterAll(async () => { for (const s of started) await s.close(); });

  it('hop count 1, one proxy: the client is the address the proxy appended; a forged X-Forwarded-For is ignored', async (c) => {
    if (!dualStack) return c.skip();
    const t = await start(1);
    const hops = await chain(t, 1);
    try {
      expect(await auditedIp(t, hops.entry)).toBe(CLIENT);
      expect(await auditedIp(t, hops.entry, FORGED)).toBe(CLIENT);
    } finally { await hops.close(); }
  });

  it('hop count 2, two proxies: the client is the address the edge proxy appended; a forged entry is ignored', async (c) => {
    if (!dualStack) return c.skip();
    const t = await start(2);
    const hops = await chain(t, 2);
    try {
      expect(await auditedIp(t, hops.entry)).toBe(CLIENT);
      expect(await auditedIp(t, hops.entry, FORGED)).toBe(CLIENT);
      expect(await auditedIp(t, hops.entry, `${FORGED}, 192.0.2.1`)).toBe(CLIENT);
    } finally { await hops.close(); }
  });

  it('the count must match the chain: too small names a proxy, too large lets the client choose', async (c) => {
    if (!dualStack) return c.skip();
    const short = await start(1);
    const long = await start(3);
    const a = await chain(short, 2);
    const b = await chain(long, 2);
    try {
      expect(await auditedIp(short, a.entry, FORGED)).toBe('::1'); // the edge proxy, as the inner proxy saw it
      expect(await auditedIp(long, b.entry, FORGED)).toBe(FORGED);
    } finally { await a.close(); await b.close(); }
  });

  it('a forged X-Forwarded-For sent directly: ignored with the proxy address form, believed with a hop count', async (c) => {
    if (!dualStack) return c.skip();
    // The address form names the proxy (it reaches the app over ::1); a direct client (127.0.0.1) is not trusted.
    const byAddress = await start('::1');
    const viaProxy = await chain(byAddress, 1);
    try {
      expect(await auditedIp(byAddress, viaProxy.entry, FORGED)).toBe(CLIENT);
      expect(await auditedIp(byAddress, byAddress.url, FORGED)).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
    } finally { await viaProxy.close(); }
    // A hop count trusts whatever connects: this is why the app port must be reachable only through the proxy
    // (docs/INSTALL.md "Setting trustProxy"; the shipped examples publish 127.0.0.1 only or use a NetworkPolicy).
    const byCount = await start(1);
    expect(await auditedIp(byCount, byCount.url, FORGED)).toBe(FORGED);
    expect(await auditedIp(byCount, byCount.url)).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });

  it('false trusts no proxy: every client appears as the proxy', async (c) => {
    if (!dualStack) return c.skip();
    const t = await start(false);
    const hops = await chain(t, 1);
    try {
      expect(await auditedIp(t, hops.entry, FORGED)).toBe('::1');
    } finally { await hops.close(); }
  });
});
