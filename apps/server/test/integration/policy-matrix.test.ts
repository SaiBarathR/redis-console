import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@rconsole/shared';
import { cleanupPrefix, keyPrefix, oidcSession, sandboxUp, startApp, userSession, type TestApp } from '../helpers.ts';
import { cli } from './data-helpers.ts';

/**
 * Role x command-class x database matrix through POST /cli. Each row: database, command,
 * expected status per role (viewer, operator, admin) and expected error code when denied.
 */
describe.skipIf(!sandboxUp)('policy matrix (CLI)', () => {
  let t: TestApp;
  const P = keyPrefix('matrix');

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t?.close();
    await cleanupPrefix(P);
  });

  type Row = { db: string; line: string; expect: [number, number, number]; code?: string };
  const rows: Row[] = [
    // read: everyone
    { db: 'e2e', line: `GET ${'{P}'}a`, expect: [200, 200, 200] },
    { db: 'e2e', line: 'DBSIZE', expect: [200, 200, 200] },
    // write: operator+
    { db: 'e2e', line: `SET ${'{P}'}a 1`, expect: [403, 200, 200] },
    { db: 'e2e', line: `HSET ${'{P}'}h f v`, expect: [403, 200, 200] },
    { db: 'e2e', line: 'PUBLISH chan msg', expect: [403, 200, 200] },
    // admin class: admin only
    { db: 'e2e', line: 'CONFIG GET maxmemory', expect: [403, 403, 200] },
    { db: 'e2e', line: 'CLIENT LIST', expect: [403, 403, 200] },
    // blocked for everyone
    { db: 'e2e', line: 'KEYS *', expect: [403, 403, 403], code: 'command_blocked' },
    { db: 'e2e', line: 'CONFIG SET maxmemory 0', expect: [403, 403, 403], code: 'command_blocked' },
    // read-only database: reads ok, writes read_only even for admin, admin reads ok
    { db: 'e2e-ro', line: `GET ${'{P}'}a`, expect: [200, 200, 200] },
    { db: 'e2e-ro', line: `SET ${'{P}'}a 1`, expect: [403, 403, 403] },
    { db: 'e2e-ro', line: 'CONFIG GET maxmemory', expect: [403, 403, 200] },
    // maxRole=operator caps admins
    { db: 'e2e-maxop', line: `SET ${'{P}'}b 1`, expect: [403, 200, 200] },
    { db: 'e2e-maxop', line: 'CONFIG GET maxmemory', expect: [403, 403, 403] },
    // viewer-only credentials: higher tiers never fall back to the viewer connection
    { db: 'e2e-viewer-only', line: 'PING', expect: [200, 503, 503] },
  ];

  const roles: Role[] = ['viewer', 'operator', 'admin'];
  for (const row of rows) {
    it(`${row.db}: ${row.line.replace('{P}', '')} -> ${row.expect.join('/')}`, async () => {
      for (let i = 0; i < 3; i++) {
        const c = await userSession(t, roles[i]!);
        const res = await cli(c, row.db, row.line.replaceAll('{P}', P));
        expect(res.status, `${roles[i]}: ${JSON.stringify(res.json)}`).toBe(row.expect[i]);
        if (row.code && res.status === 403) expect(res.json.error.code).toBe(row.code);
        if (row.db === 'e2e-ro' && row.line.startsWith('SET')) expect(res.json.error.code).toBe(roles[i] === 'viewer' ? 'forbidden' : 'read_only');
      }
    });
  }

  it('the Redis connection always uses the caller tier ACL user', async () => {
    const who = async (role: Role, db: string) => {
      const c = await userSession(t, role);
      const res = await cli(c, db, 'CLIENT INFO');
      expect(res.status).toBe(200);
      return /user=(\S+)/.exec(res.json.reply.v.data)![1];
    };
    expect(await who('viewer', 'e2e')).toBe('rc-viewer');
    expect(await who('operator', 'e2e')).toBe('rc-operator');
    expect(await who('admin', 'e2e')).toBe('rc-admin');
    expect(await who('admin', 'e2e-maxop')).toBe('rc-operator');
    // only `default` credentials (= rc-operator): every tier uses it; app policy still applies
    for (const role of ['viewer', 'operator', 'admin'] as const) expect(await who(role, 'e2e-default')).toBe('rc-operator');
    const v = await userSession(t, 'viewer');
    expect((await cli(v, 'e2e-default', `SET ${P}x 1`)).status).toBe(403);
    // admin policy allows CONFIG GET but the shared operator ACL user refuses it (second line of defence)
    const a = await userSession(t, 'admin');
    const res = await cli(a, 'e2e-default', 'CONFIG GET maxmemory');
    expect(res.status).toBe(200);
    expect(res.json.reply.t).toBe('err');
    expect(res.json.reply.v).toMatch(/NOPERM/);
  });

  it('OIDC sessions follow the same matrix', async () => {
    const v = oidcSession(t, 'viewer');
    expect((await cli(v, 'e2e', `SET ${P}o 1`)).status).toBe(403);
    const o = oidcSession(t, 'operator');
    expect((await cli(o, 'e2e', `SET ${P}o 1`)).status).toBe(200);
  });

  it('effective roles are reported per database', async () => {
    const a = await userSession(t, 'admin');
    const res = await a.req('GET', '/api/v1/databases');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.json.databases.map((d: any) => [d.id, d]));
    expect(byId.e2e.effectiveRole).toBe('admin');
    expect(byId['e2e-maxop'].effectiveRole).toBe('operator');
    expect(byId['e2e-ro'].readOnly).toBe(true);
    expect(JSON.stringify(res.json)).not.toMatch(/redis:\/\/|6411|rc-admin|password/i);
  });
});
