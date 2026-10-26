/**
 * An explicitly configured remote holds a dataset. Read commands only, through the app's viewer path
 * (`remote` is prod + readOnly + maxRole viewer). Write refusal is asserted against the policy
 * functions directly so no write is ever sent, even by accident.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError } from '../../src/http/errors.ts';
import { authorize, classify } from '../../src/policy/policy.ts';
import { bk, remoteUp, startApp, userSession, type Client, type TestApp } from '../helpers.ts';

describe.skipIf(!remoteUp)('configured remote (read-only, viewer path)', () => {
  let t: TestApp;
  let admin: Client;
  let someKey: { key: { enc: string; data: string }; type: string } | undefined;

  beforeAll(async () => {
    t = await startApp();
    admin = await userSession(t, 'admin'); // capped to viewer by maxRole
  });
  afterAll(async () => t?.close());

  it('is listed as read-only with an effective role of viewer', async () => {
    const r = await admin.req('GET', '/api/v1/databases');
    const remote = r.json.databases.find((d: any) => d.id === 'remote');
    expect(remote).toMatchObject({ environment: 'prod', readOnly: true, effectiveRole: 'viewer', status: 'connected' });
  });

  it('uses the viewer tier connection', async () => {
    const db = t.ctx.redis.database('remote')!;
    expect(db.maxRole).toBe('viewer');
    expect(t.ctx.redis.status('remote', 'viewer').status).toBe('connected');
  });

  it('overview', async () => {
    const r = await admin.req('GET', '/api/v1/databases/remote/overview');
    expect(r.status).toBe(200);
    expect(r.json.info.server.redis_version).toBeTruthy();
    expect(r.json.info.server).not.toHaveProperty('executable');
  });

  it('scans one page of keys', async () => {
    const r = await admin.req('POST', '/api/v1/databases/remote/keys/scan', { count: 50 });
    expect(r.status).toBe(200);
    expect(typeof r.json.cursor).toBe('string');
    expect(r.json.dbSize).toBeGreaterThanOrEqual(0);
    for (const k of r.json.keys) {
      expect(['utf8', 'base64']).toContain(k.key.enc);
      expect(typeof k.type).toBe('string');
    }
    someKey = r.json.keys[0];
  });

  it('reads one key', async () => {
    if (!someKey) return;
    const raw = someKey.key.enc === 'utf8' ? Buffer.from(someKey.key.data, 'utf8') : Buffer.from(someKey.key.data, 'base64');
    const r = await admin.req('POST', '/api/v1/databases/remote/key/read', { key: bk(raw), count: 10 });
    expect([200, 404]).toContain(r.status); // 404 if it expired meanwhile
    if (r.status === 200) {
      expect(r.json.key).toEqual(someKey.key);
      expect(r.json.value.type).toBeTruthy();
    }
  });

  it('runs read-only CLI commands', async () => {
    for (const line of ['PING', 'DBSIZE', 'INFO server']) {
      const r = await admin.req('POST', '/api/v1/databases/remote/cli', { line });
      expect(r.status).toBe(200);
      expect(r.json.commandClass).toBe('read');
      expect(r.json.reply.t).not.toBe('err');
    }
    if (someKey) {
      const argvBin = [{ enc: 'utf8', data: 'TYPE' }, someKey.key];
      const r = await admin.req('POST', '/api/v1/databases/remote/cli', { argvBin });
      expect(r.status).toBe(200);
      const ttl = await admin.req('POST', '/api/v1/databases/remote/cli', { argvBin: [{ enc: 'utf8', data: 'TTL' }, someKey.key] });
      expect(ttl.json.reply.t).toBe('int');
    }
  });

  it('command docs mark writes as not allowed', async () => {
    const r = await admin.req('GET', '/api/v1/databases/remote/commands');
    expect(r.status).toBe(200);
    const byName = Object.fromEntries(r.json.commands.map((c: any) => [c.name, c]));
    expect(byName.GET).toMatchObject({ class: 'read', allowed: true });
    expect(byName.SET).toMatchObject({ class: 'write', allowed: false });
    expect(byName.FLUSHDB.allowed).toBe(false);
  });

  it('policy refuses writes before anything is sent (checked without HTTP)', async () => {
    const db = t.ctx.redis.database('remote')!;
    // COMMAND (read-only) via the viewer connection gives the real classification table.
    const table = await t.ctx.commandTables.get('remote', await t.ctx.redis.conn('remote', 'viewer'));
    expect(table?.get('set')).toBeTruthy();
    for (const [argv, code] of [
      [['SET', 'k', 'v'], 'forbidden'],
      [['DEL', 'k'], 'forbidden'],
      [['FLUSHDB'], 'forbidden'],
      [['FLUSHALL'], 'command_blocked'],
      [['CONFIG', 'SET', 'x', 'y'], 'command_blocked'],
    ] as const) {
      const c = classify([...argv], table);
      try {
        authorize(c, { role: 'viewer', db });
        throw new Error(`${argv[0]} was allowed`);
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError);
        expect((e as HttpError).code).toBe(code);
      }
    }
    // Even an admin-level role would hit readOnly on this database.
    const set = classify(['SET', 'k', 'v'], table);
    expect(classify(['SET', 'k', 'v'], undefined).class).toBe('blocked'); // no table: fail closed
    try {
      authorize({ ...set, class: 'write' }, { role: 'admin', db });
      throw new Error('allowed');
    } catch (e) {
      expect((e as HttpError).code).toBe('read_only');
    }
  });
});
