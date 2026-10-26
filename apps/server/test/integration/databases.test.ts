import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.ts';
import { mainUp, oidcSession, remoteUp, sandboxUp, startApp, testConfigRaw, userSession, type TestApp } from '../helpers.ts';

function configWithUnreachable() {
  const raw = testConfigRaw();
  (raw.databases as Record<string, unknown>[]).push({
    id: 'down', name: 'Unreachable', environment: 'dev', url: 'redis://127.0.0.1:1',
    credentials: { viewer: { username: 'rc-viewer', password: { env: 'SANDBOX_REDIS_VIEWER_PASSWORD' } } },
  });
  return resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } });
}

describe.skipIf(!sandboxUp)('databases', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(configWithUnreachable());
  });
  afterAll(async () => t?.close());

  it('requires a session', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/databases' })).statusCode).toBe(401);
  });

  it('lists every database with per-database effective roles and no connection details', async () => {
    const admin = await userSession(t, 'admin');
    const start = Date.now();
    const r = await admin.req('GET', '/api/v1/databases');
    expect(Date.now() - start).toBeLessThan(6000);
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.json.databases.map((d: any) => [d.id, d]));
    expect(Object.keys(byId)).toEqual(expect.arrayContaining(['e2e', 'e2e-ro', 'e2e-prod', 'e2e-maxop', 'e2e-default', 'e2e-viewer-only', 'down']));
    expect(byId.e2e).toMatchObject({ name: 'E2E', environment: 'test', readOnly: false, effectiveRole: 'admin', status: 'connected' });
    expect(byId.e2e.server.version).toMatch(/^\d+\.\d+/);
    expect(byId.e2e.server.mode).toBe('standalone');
    expect(Array.isArray(byId.e2e.server.modules)).toBe(true);
    expect(byId['e2e-ro'].readOnly).toBe(true);
    expect(byId['e2e-prod'].environment).toBe('prod');
    expect(byId['e2e-maxop'].effectiveRole).toBe('operator');
    if (mainUp) expect(byId.main.status).toBe('connected');
    if (remoteUp) expect(byId.remote).toMatchObject({ effectiveRole: 'viewer', readOnly: true, environment: 'prod' });
    // F-07: profiler availability mirrors the server gate (admin + policy.profilerAllowedEnvironments).
    expect(byId.e2e.features).toEqual({ profiler: true });
    expect(byId['e2e-prod'].features).toEqual({ profiler: false });
    expect(byId['e2e-maxop'].features).toEqual({ profiler: false });
    if (remoteUp) expect(byId.remote.features).toEqual({ profiler: false });

    // `down` only has viewer credentials: admins get a definitive error.
    expect(byId.down.status).toBe('error');

    // admin has no credentials on e2e-viewer-only: no silent fallback to the viewer tier.
    expect(byId['e2e-viewer-only'].status).toBe('error');
    expect(byId['e2e-viewer-only'].statusMessage).toMatch(/no Redis credentials/);

    const text = JSON.stringify(r.json);
    for (const leak of [':6411', ':6410', ':6390', ':1"', '127.0.0.1', 'redis://', 'rc-viewer', 'rc-operator', 'rc-admin', 'username', 'password']) {
      expect(text).not.toContain(leak);
    }
    for (const v of ['SANDBOX_REDIS_VIEWER_PASSWORD', 'SANDBOX_REDIS_OPERATOR_PASSWORD', 'SANDBOX_REDIS_ADMIN_PASSWORD', 'RC_TEST_REMOTE_PASSWORD']) {
      const secret = process.env[v];
      if (secret) expect(text).not.toContain(secret);
    }
  });

  it('caps the effective role by the user role', async () => {
    const viewer = oidcSession(t, 'viewer');
    const start = Date.now();
    const r = await viewer.req('GET', '/api/v1/databases');
    expect(Date.now() - start).toBeLessThan(6000);
    expect(r.json.databases.every((d: any) => d.effectiveRole === 'viewer')).toBe(true);
    // Unreachable database: reported (not fatal), sanitized message, other databases unaffected.
    const down = r.json.databases.find((d: any) => d.id === 'down');
    expect(['error', 'connecting']).toContain(down.status);
    expect(down.statusMessage).toBeTruthy();
    expect(down.statusMessage).not.toMatch(/redis:\/\/|127\.0\.0\.1/);
    expect(r.json.databases.find((d: any) => d.id === 'e2e').status).toBe('connected');
    const op = await userSession(t, 'operator');
    const r2 = await op.req('GET', '/api/v1/databases');
    const byId = Object.fromEntries(r2.json.databases.map((d: any) => [d.id, d]));
    expect(byId.e2e.effectiveRole).toBe('operator');
    expect(byId['e2e-maxop'].effectiveRole).toBe('operator');
    expect(r2.json.databases.every((d: any) => d.features.profiler === false)).toBe(true);
  });

  it('returns an overview with sanitized INFO', async () => {
    const viewer = await userSession(t, 'viewer');
    const r = await viewer.req('GET', '/api/v1/databases/e2e/overview');
    expect(r.status).toBe(200);
    const o = r.json;
    expect(o.id).toBe('e2e');
    expect(o.info.server.redis_version).toBeTruthy();
    for (const hidden of ['executable', 'config_file', 'tcp_port', 'run_id']) expect(o.info.server).not.toHaveProperty(hidden);
    expect(o.memory.used).toBeGreaterThan(0);
    expect(typeof o.memory.policy).toBe('string');
    expect(o.clients.connected).toBeGreaterThan(0);
    expect(typeof o.stats.opsPerSec).toBe('number');
    expect(o.uptimeSeconds).toBeGreaterThan(0);
    expect(Array.isArray(o.keyspace)).toBe(true);
    expect(JSON.stringify(o)).not.toContain('/usr/local');
  });

  it('unknown database is 404; unreachable database is 503', async () => {
    const viewer = await userSession(t, 'viewer');
    const r = await viewer.req('GET', '/api/v1/databases/nope/overview');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('not_found');
    const d = await viewer.req('GET', '/api/v1/databases/down/overview');
    expect(d.status).toBe(503);
    expect(d.json.error.code).toBe('unavailable');
    expect(d.json.error.message).not.toContain('redis://');
  });

  it('a tier without credentials is unavailable, never a lower tier', async () => {
    const admin = await userSession(t, 'admin');
    const r = await admin.req('POST', '/api/v1/databases/e2e-viewer-only/cli', { line: 'PING' });
    expect(r.status).toBe(503);
    expect(r.json.error.message).toMatch(/admin tier/);
    const viewer = await userSession(t, 'viewer');
    expect((await viewer.req('POST', '/api/v1/databases/e2e-viewer-only/cli', { line: 'PING' })).status).toBe(200);
  });

  it('every command runs as the ACL user of the caller tier', async () => {
    for (const role of ['viewer', 'operator', 'admin'] as const) {
      const c = await userSession(t, role);
      const r = await c.req('POST', '/api/v1/databases/e2e/cli', { line: 'CLIENT INFO' });
      expect(r.status).toBe(200);
      expect(r.json.reply.v.data).toContain(`user=rc-${role}`);
    }
    // maxRole=operator caps admins to the operator ACL user.
    const admin = await userSession(t, 'admin');
    const capped = await admin.req('POST', '/api/v1/databases/e2e-maxop/cli', { line: 'CLIENT INFO' });
    expect(capped.json.reply.v.data).toContain('user=rc-operator');
    // `default` credentials apply to every tier.
    const viewer = await userSession(t, 'viewer');
    const def = await viewer.req('POST', '/api/v1/databases/e2e-default/cli', { line: 'CLIENT INFO' });
    expect(def.json.reply.v.data).toContain('user=rc-operator');
  });
});
