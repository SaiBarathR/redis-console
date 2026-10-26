/**
 * M2: Redis key names, glob patterns, channel names and queries never travel in URLs (reverse proxies and
 * load balancers log URLs). Every route that needs them takes a POST body; SSE takes a subscription id.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES } from '@rconsole/shared';
import { SENSITIVE_QUERY_PARAMS, sensitiveQueryParams } from '../../src/app.ts';
import { StreamTickets, MAX_TICKETS_PER_SESSION } from '../../src/security/streamTickets.ts';
import { ORIGIN, startApp, testConfig, userSession, type Client, type TestApp } from '../helpers.ts';

const path = (spec: string) => spec.split(' ')[1]!.replace(':db', 'e2e').replace(':id', 'x');
const method = (spec: string) => spec.split(' ')[0] as 'GET' | 'POST' | 'PATCH';

describe('no route accepts key, match or channel query parameters', () => {
  let t: TestApp;
  let admin: Client;
  beforeAll(async () => {
    t = await startApp(testConfig());
    admin = await userSession(t, 'admin');
  });
  afterAll(() => t.close());

  it('the old GET variants are gone', () => {
    for (const url of [
      '/api/v1/databases/:db/keys',
      '/api/v1/databases/:db/key',
      '/api/v1/databases/:db/streams/groups',
      '/api/v1/databases/:db/streams/pending',
      '/api/v1/databases/:db/timeseries/range',
      '/api/v1/databases/:db/pubsub/channels',
    ]) {
      expect(t.app.hasRoute({ method: 'GET', url }), url).toBe(false);
    }
  });

  it('no ROUTES entry documents a sensitive query parameter', () => {
    for (const spec of Object.values(ROUTES)) expect(sensitiveQueryParams(spec.split(' ')[1]!), spec).toEqual([]);
  });

  for (const [name, spec] of Object.entries(ROUTES)) {
    it(`${name}: ${spec} refuses ?k= / ?match= / ?channel= (and friends) with 400`, async () => {
      for (const p of ['k', 'match', 'channel']) {
        const r = await admin.req(method(spec), `${path(spec)}?${encodeURIComponent(p)}=secret-key-name`, method(spec) === 'GET' ? undefined : {});
        expect(r.status, `${spec} ?${p}=`).toBe(400);
        expect(r.json.error.code).toBe('validation');
        expect(r.body).not.toContain('secret-key-name');
      }
    });
  }

  it('every sensitive name (any case, [] suffix, percent-encoded) is refused', async () => {
    for (const p of [...SENSITIVE_QUERY_PARAMS, 'K', 'channel[]', 'Match', '%6B']) {
      const r = await admin.req('GET', `/api/v1/databases/e2e/overview?${p}=x`);
      expect(r.status, p).toBe(400);
    }
    // Health checks and SPA deep links too.
    expect((await admin.req('GET', '/databases/e2e/keys?match=user:*')).status).toBe(400);
    expect((await admin.req('GET', '/login?error=oidc_failed')).status).not.toBe(400);
  });

  it('applies before authentication too (an anonymous probe learns nothing else)', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/databases/e2e/metrics/stream?channel=x' });
    expect(r.statusCode).toBe(400);
  });

  it('parses names case-insensitively, percent-decoded, with [] suffixes', () => {
    expect(sensitiveQueryParams('/x?K=1')).toEqual(['k']);
    expect(sensitiveQueryParams('/x?%6B=1&a=2')).toEqual(['k']);
    expect(sensitiveQueryParams('/x?channel[]=a&channel[]=b&pattern=p')).toEqual(['channel', 'pattern']);
    expect(sensitiveQueryParams('/x?sub=abc&count=5&seconds=3')).toEqual([]);
    expect(sensitiveQueryParams('/x?%E0%A4%A=1')).toEqual([]);
    expect(sensitiveQueryParams('/x')).toEqual([]);
  });

  it('body-based reads still need Origin and the CSRF token (they are POSTs)', async () => {
    const reads = [ROUTES.scan, ROUTES.key, ROUTES.streamGroups, ROUTES.streamPending, ROUTES.tsRange, ROUTES.pubsubChannels, ROUTES.pubsubSubscribe];
    for (const spec of reads) {
      expect(method(spec)).toBe('POST');
      const noCsrf = await t.app.inject({ method: 'POST', url: path(spec), headers: { origin: ORIGIN, cookie: admin.cookie, 'content-type': 'application/json' }, payload: '{}' });
      expect(noCsrf.statusCode, spec).toBe(403);
      expect(noCsrf.json().error.code).toBe('csrf');
      const noOrigin = await t.app.inject({ method: 'POST', url: path(spec), headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }, payload: '{}' });
      expect(noOrigin.statusCode, spec).toBe(403);
      const evil = await t.app.inject({ method: 'POST', url: path(spec), headers: { origin: 'https://evil.example', cookie: admin.cookie, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' }, payload: '{}' });
      expect(evil.statusCode, spec).toBe(403);
    }
  });

  it('read bodies reject unknown fields (no k/match smuggling via other names) and the old base64url form', async () => {
    expect((await admin.req('POST', path(ROUTES.key), { k: 'a2V5' })).status).toBe(400);
    expect((await admin.req('POST', path(ROUTES.scan), { match: '*', extra: 1 })).status).toBe(400);
    expect((await admin.req('POST', path(ROUTES.pubsubSubscribe), { channel: 'x' })).status).toBe(400);
  });
});

describe('pub/sub subscription tickets', () => {
  let now = 1_000_000;
  const tickets = new StreamTickets<{ channels: string[] }>(60_000, () => now);

  it('are single-use and bound to the session and database', () => {
    const a = tickets.issue('sessA', 'db1', { channels: ['c'] });
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tickets.take(a.id, 'sessB', 'db1')).toBeNull(); // another session: refused (and consumed)
    expect(tickets.take(a.id, 'sessA', 'db1')).toBeNull();
    const b = tickets.issue('sessA', 'db1', { channels: ['c'] });
    expect(tickets.take(b.id, 'sessA', 'db2')).toBeNull();
    const c = tickets.issue('sessA', 'db1', { channels: ['c'] });
    expect(tickets.take(c.id, 'sessA', 'db1')).toEqual({ channels: ['c'] });
    expect(tickets.take(c.id, 'sessA', 'db1')).toBeNull();
    expect(tickets.take('not-a-ticket', 'sessA', 'db1')).toBeNull();
  });

  it('expire after 60 s', () => {
    const a = tickets.issue('sessA', 'db1', { channels: ['c'] });
    expect(a.expiresAt).toBe(now + 60_000);
    now += 60_000;
    expect(tickets.take(a.id, 'sessA', 'db1')).toBeNull();
  });

  it('are capped per session without evicting other sessions', () => {
    const other = tickets.issue('sessOther', 'db1', { channels: ['o'] });
    const ids = Array.from({ length: MAX_TICKETS_PER_SESSION + 5 }, () => tickets.issue('sessFlood', 'db1', { channels: ['f'] }).id);
    expect(ids.filter((id) => tickets.take(id, 'sessFlood', 'db1')).length).toBe(MAX_TICKETS_PER_SESSION);
    expect(tickets.take(other.id, 'sessOther', 'db1')).toEqual({ channels: ['o'] });
  });
});
