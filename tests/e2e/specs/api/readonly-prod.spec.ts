/**
 * remote-6390 is readOnly + prod + maxRole viewer. Every write path must be rejected by the
 * server for every role (including admin). The server reaches the selected upstream only through
 * the e2e read-only proxy, which additionally refuses (and records) any non-read command, so these
 * tests can never modify an external dataset; specs/final asserts the proxy saw no violation.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { API, Api, dbPath, utf8 } from '../../lib/api.ts';
import { DB } from '../../lib/env.ts';
import { PROXY_VIOLATIONS_FILE } from '../../lib/readonly-proxy.ts';

const R = (s: string) => dbPath(DB.remote, s);
const PROBE_KEY = 'rconsole-e2e:must-never-exist';

test.describe('readOnly / prod database (remote-6390)', () => {
  let apis: { viewer: Api; operator: Api; admin: Api };
  let sampleKey: { enc: 'utf8' | 'base64'; data: string } | undefined;
  test.beforeAll(async () => {
    apis = { viewer: await Api.fromStorage('viewer'), operator: await Api.fromStorage('operator'), admin: await Api.fromStorage('admin') };
  });
  test.afterAll(async () => { for (const a of Object.values(apis)) await a.dispose(); });

  test('reads work: database summary, overview, scan, key, CLI read', async () => {
    const dbs = await apis.admin.get(`${API}/databases`);
    const remote = (dbs.json.databases as any[]).find((d) => d.id === DB.remote);
    expect(remote.status, remote.statusMessage).toBe('connected');
    expect((await apis.viewer.get(R('overview'))).status).toBe(200);
    const scan = await apis.admin.post(R('keys/scan'), { count: 50 });
    expect(scan.status).toBe(200);
    expect(scan.json.dbSize).toBeGreaterThan(0);
    sampleKey = scan.json.keys[0]?.key;
    if (sampleKey) {
      const k = await apis.admin.post(R('key/read'), { key: sampleKey });
      expect(k.status).toBe(200);
    }
    // v0.2.1 key browser reads: names only, then metadata of a few keys (TYPE, PTTL, MEMORY USAGE through the proxy).
    const names = await apis.viewer.post(R('keys/names'), { count: 100, scanThreshold: 1000 });
    expect(names.status, names.text.slice(0, 200)).toBe(200);
    expect(names.json.dbSize).toBeGreaterThan(0);
    if (names.json.keys.length) {
      const meta = await apis.viewer.post(R('keys/meta'), { keys: names.json.keys.slice(0, 5) });
      expect(meta.status).toBe(200);
      expect(meta.json.keys).toHaveLength(Math.min(5, names.json.keys.length));
    }
    const c = await apis.admin.post(R('cli'), { line: 'DBSIZE' });
    expect(c.status).toBe(200);
    expect(c.json.commandClass).toBe('read');
  });

  const writeAttempts: [string, string, unknown][] = [
    ['ops string.set', 'ops', { op: 'string.set', key: utf8(PROBE_KEY), value: utf8('x') }],
    ['ops key.delete', 'ops', { op: 'key.delete', keys: [utf8(PROBE_KEY)] }],
    ['ops key.expire', 'ops', { op: 'key.expire', key: utf8(PROBE_KEY), ttl: 10 }],
    ['ops hash.set', 'ops', { op: 'hash.set', key: utf8(PROBE_KEY), entries: [{ field: utf8('f'), value: utf8('v') }] }],
    ['ops json.set', 'ops', { op: 'json.set', key: utf8(PROBE_KEY), path: '$', json: '{}' }],
    ['ops stream.add', 'ops', { op: 'stream.add', key: utf8(PROBE_KEY), fields: [{ field: utf8('f'), value: utf8('v') }] }],
    ['cli SET', 'cli', { line: `SET ${PROBE_KEY} x` }],
    ['cli set (lowercase)', 'cli', { line: `set ${PROBE_KEY} x` }],
    ['cli DEL', 'cli', { line: `DEL ${PROBE_KEY}` }],
    ['cli EXPIRE', 'cli', { line: `EXPIRE ${PROBE_KEY} 1` }],
    ['cli FLUSHDB', 'cli', { line: 'FLUSHDB' }],
    ['cli PUBLISH', 'cli', { line: 'PUBLISH rconsole-e2e hi' }],
    ['cli argv SET', 'cli', { argv: ['SET', PROBE_KEY, 'x'] }],
    ['workbench SET', 'workbench', { script: `SET ${PROBE_KEY} x` }],
    ['bulk delete', 'bulk-delete', { match: `${PROBE_KEY}*` }],
    ['bulk delete job', 'bulk-delete/jobs', { match: `${PROBE_KEY}*` }],
    ['publish', 'pubsub/publish', { channel: 'rconsole-e2e', message: utf8('x') }],
    ['slowlog reset', 'slowlog/reset', {}],
    ['client kill', 'clients/kill', { id: '1' }],
  ];

  for (const role of ['admin', 'operator', 'viewer'] as const) {
    test(`all writes rejected for ${role}`, async () => {
      for (const [name, sub, body] of writeAttempts) {
        const r = await apis[role].post(R(sub), body);
        if (sub === 'workbench' && r.status === 200) {
          expect(['read_only', 'forbidden'], `${role} ${name}`).toContain(r.json.results[0].error?.code);
          continue;
        }
        expect(r.status, `${role} ${name}: ${r.text.slice(0, 200)}`).toBe(403);
        expect(['read_only', 'forbidden', 'command_blocked'], `${role} ${name}`).toContain(r.json.error.code);
        // A confirmation challenge must never be offered for a read-only database.
        expect(r.json.error.confirmation).toBeUndefined();
      }
    });
  }

  test('a confirmation token cannot unlock a write on a read-only database', async () => {
    // Obtain a genuine token on sandbox-e2e, then try to replay it on remote-6390.
    const ch = await apis.admin.post(dbPath(DB.e2e, 'cli'), { line: 'DEL e2e:scratch:nonexistent' });
    expect(ch.status).toBe(428);
    const token = ch.json.error.confirmation.token;
    const r = await apis.admin.post(R('cli'), { line: 'DEL e2e:scratch:nonexistent', confirmation: { token, typed: 'Remote 6390 (read-only)', reason: 'trying to bypass read-only' } });
    expect(r.status).toBe(403);
  });

  test('profiler is refused on prod for admin', async () => {
    const r = await apis.admin.sse(R('profiler/stream?seconds=1'), { maxEvents: 1, timeoutMs: 3000 });
    expect(r.status).toBe(403);
  });

  test('admin-class reads are refused too (effective role is viewer)', async () => {
    for (const line of ['CONFIG GET *', 'CLIENT LIST', 'MEMORY MALLOC-STATS']) {
      const r = await apis.admin.post(R('cli'), { line });
      expect(r.status, line).toBe(403);
    }
  });

  test('the read-only proxy has not seen any non-read command so far', () => {
    const v = readFileSync(PROXY_VIOLATIONS_FILE, 'utf8').trim();
    expect(v, 'non-read commands that reached the read-only proxy').toBe('');
  });
});
