/** Review L1: RP-initiated logout must not hand the ID token to the browser. */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.ts';
import { clientFor, startApp, testConfigRaw, type TestApp } from '../helpers.ts';

describe('RP-initiated logout (L1)', () => {
  let issuer: Server;
  let t: TestApp;
  beforeAll(async () => {
    issuer = createServer((req, res) => {
      const base = `http://127.0.0.1:${(issuer.address() as { port: number }).port}`;
      if (req.url === '/.well-known/openid-configuration') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/auth`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks`, end_session_endpoint: `${base}/logout`, response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => issuer.listen(0, '127.0.0.1', r));
    const port = (issuer.address() as { port: number }).port;
    const raw = testConfigRaw({ oidc: true });
    const o = (raw.auth as { oidc: Record<string, unknown> }).oidc;
    o.issuer = `http://127.0.0.1:${port}`;
    o.rpInitiatedLogout = true;
    process.env.OIDC_CLIENT_SECRET ??= 'test-secret';
    const cfg = resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } });
    t = await startApp(cfg);
  });
  afterAll(async () => {
    await t?.close();
    await new Promise((r) => issuer.close(r));
  });

  it('the logout redirect carries client_id and the post-logout URI, never id_token_hint or the token', async () => {
    const marker = 'eyJSYNTHETIC.ID-TOKEN-MARKER.sig';
    const { id, session } = t.ctx.sessions.create({ userId: 'oidc:x', username: 'x', displayName: 'x', source: 'oidc', role: 'viewer', state: 'active', ip: '127.0.0.1', idToken: marker });
    const c = clientFor(t.app, t.ctx.sessionCookie, id, session.csrfToken);
    const r = await c.req('POST', '/api/v1/auth/logout', {});
    expect(r.status).toBe(200);
    const url = new URL(r.json.redirectUrl);
    expect(url.pathname).toBe('/logout');
    expect(url.searchParams.get('client_id')).toBe('rconsole');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:4100/');
    expect(url.searchParams.has('id_token_hint')).toBe(false);
    expect(r.body).not.toContain('SYNTHETIC');
  });
});
