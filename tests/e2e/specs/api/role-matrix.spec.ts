/**
 * Role matrix: every route in ROUTES x {anonymous, viewer, operator, admin}
 * against the expected HTTP status (database-scoped routes on sandbox-e2e, env=test).
 */
import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { ROUTES } from '@rconsole/shared';
import { API, dbPath, utf8, type Api } from '../../lib/api.ts';
import { roleApis, disposeAll, ROLE_KEYS, type RoleKey } from '../../lib/roles.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';
import { uniqueName, newPassword } from '../../lib/accounts.ts';
import { registerExtraSecret } from '../../lib/leak.ts';
import { knownBug } from '../../lib/findings.ts';

type Expect = number | number[] | null; // null = not checked here (covered by a dedicated spec)
interface Row {
  route: keyof typeof ROUTES;
  label?: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: string | (() => string);
  body?: unknown | (() => unknown);
  sse?: boolean;
  /** For pub/sub SSE: create a single-use subscription first and stream `?sub=<id>`. */
  subscribe?: { channels?: string[]; patterns?: string[] };
  expect: Record<RoleKey, Expect>;
}

const e2e = (s: string) => dbPath(DB.e2e, s);
const ANON_WRITE = [401, 403]; // unauthenticated non-GET: 401 (or 403 if CSRF is checked first)
const all = (anon: Expect, viewer: Expect, operator: Expect, admin: Expect) => ({ anon, viewer, operator, admin });
const readRoute = all(401, 200, 200, 200);
let throwawayUserId = '';
/** v0.4: a small vector set for the vector-set routes, created in beforeAll and deleted in afterAll. */
const VSET = `${K.scratchPrefix}matrix:vset`;

const ROWS: Row[] = [
  { route: 'health', method: 'GET', path: '/healthz', expect: all(200, 200, 200, 200) },
  { route: 'ready', method: 'GET', path: '/readyz', expect: all([200, 503], [200, 503], [200, 503], [200, 503]) },
  { route: 'providers', method: 'GET', path: `${API}/auth/providers`, expect: all(200, 200, 200, 200) },
  { route: 'me', method: 'GET', path: `${API}/auth/me`, expect: readRoute },
  { route: 'login', label: 'login with bad credentials', method: 'POST', path: `${API}/auth/login`, body: { username: 'no-such-user', password: 'nope-nope-nope' }, expect: all(401, null, null, null) },
  { route: 'totpVerify', label: 'totp verify without pending login', method: 'POST', path: `${API}/auth/totp/verify`, body: { code: '000000' }, expect: all(ANON_WRITE, null, null, null) },
  { route: 'logout', method: 'POST', path: `${API}/auth/logout`, expect: all([200, 401, 403], null, null, null) },
  { route: 'oidcStart', method: 'GET', path: `${API}/auth/oidc/start`, expect: all([302, 303], null, null, null) },
  { route: 'oidcCallback', label: 'oidc callback without state', method: 'GET', path: `${API}/auth/oidc/callback?code=x&state=y`, expect: all([302, 303, 400], null, null, null) },
  { route: 'passwordChange', method: 'POST', path: `${API}/auth/password`, body: { currentPassword: 'x', newPassword: 'yyyyyyyyyyyyyy' }, expect: all(ANON_WRITE, null, null, null) },
  { route: 'totpEnroll', method: 'POST', path: `${API}/auth/totp/enroll`, expect: all(ANON_WRITE, null, null, null) },
  { route: 'totpConfirm', method: 'POST', path: `${API}/auth/totp/confirm`, body: { code: '000000' }, expect: all(ANON_WRITE, null, null, null) },
  // Signed-in behaviour (password re-auth, TOTP required, lockout) is in ui/recovery-codes.spec.ts and the server tests.
  { route: 'recoveryCodesRegenerate', method: 'POST', path: `${API}/auth/recovery-codes`, body: { currentPassword: 'x' }, expect: all(ANON_WRITE, null, null, null) },
  { route: 'databases', method: 'GET', path: `${API}/databases`, expect: readRoute },
  { route: 'overview', method: 'GET', path: e2e('overview'), expect: readRoute },
  { route: 'metricsStream', method: 'GET', path: e2e('metrics/stream'), sse: true, expect: readRoute },
  { route: 'scan', method: 'POST', path: e2e('keys/scan'), body: { match: 'e2e:string:*' }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'key', method: 'POST', path: e2e('key/read'), body: { key: utf8(K.str) }, expect: all(ANON_WRITE, 200, 200, 200) },
  // A list row reference carries the SHA-256 of the element it names (the fixture list starts with job-1).
  { route: 'keyElement', method: 'POST', path: e2e('key/element'), body: { key: utf8(K.list), ref: { kind: 'list', index: 0, identity: createHash('sha256').update('job-1').digest('hex') } }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'ops', label: 'ops string.set', method: 'POST', path: e2e('ops'), body: () => ({ op: 'string.set', key: utf8(`${K.scratchPrefix}matrix`), value: utf8('v') }), expect: all(ANON_WRITE, 403, 200, 200) },
  { route: 'bulkDelete', method: 'POST', path: e2e('bulk-delete'), body: { match: 'e2e:nothing-matches-this:*' }, expect: all(ANON_WRITE, 403, 428, 428) },
  { route: 'keyNames', method: 'POST', path: e2e('keys/names'), body: { match: 'e2e:string:*' }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'keyMeta', method: 'POST', path: e2e('keys/meta'), body: { keys: [utf8(K.str)] }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'bulkDeleteJobs', method: 'POST', path: e2e('bulk-delete/jobs'), body: { match: 'e2e:nothing-matches-this:*' }, expect: all(ANON_WRITE, 403, 428, 428) },
  { route: 'bulkDeleteJob', label: 'bulk delete job status (unknown job)', method: 'GET', path: e2e('bulk-delete/jobs/no-such-job'), expect: all(401, 403, 404, 404) },
  { route: 'bulkDeleteJobCancel', label: 'bulk delete job cancel (unknown job)', method: 'POST', path: e2e('bulk-delete/jobs/no-such-job/cancel'), body: {}, expect: all(ANON_WRITE, 403, 404, 404) },
  { route: 'cli', label: 'cli read (PING)', method: 'POST', path: e2e('cli'), body: { line: 'PING' }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'cli', label: 'cli write (SET)', method: 'POST', path: e2e('cli'), body: { line: `SET ${K.scratchPrefix}matrix-cli v` }, expect: all(ANON_WRITE, 403, 200, 200) },
  { route: 'cli', label: 'cli admin (CONFIG GET)', method: 'POST', path: e2e('cli'), body: { line: 'CONFIG GET maxmemory' }, expect: all(ANON_WRITE, 403, 403, 200) },
  { route: 'cli', label: 'cli blocked (EVAL)', method: 'POST', path: e2e('cli'), body: { line: 'EVAL "return 1" 0' }, expect: all(ANON_WRITE, 403, 403, 403) },
  { route: 'workbench', method: 'POST', path: e2e('workbench'), body: { script: 'PING\nDBSIZE' }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'commands', method: 'GET', path: e2e('commands'), expect: readRoute },
  { route: 'slowlog', method: 'GET', path: e2e('slowlog'), expect: readRoute },
  { route: 'slowlogReset', method: 'POST', path: e2e('slowlog/reset'), expect: all(ANON_WRITE, 403, 403, 428) },
  // Admin-class CONFIG GET of two fixed parameters; other roles get 200 with `available: false` (F19).
  { route: 'slowlogConfig', method: 'GET', path: e2e('slowlog/config'), expect: readRoute },
  { route: 'clients', method: 'GET', path: e2e('clients'), expect: all(401, 403, 403, 200) },
  { route: 'clientKill', method: 'POST', path: e2e('clients/kill'), body: { id: '987654321' }, expect: all(ANON_WRITE, 403, 403, [428, 404]) },
  { route: 'analysis', method: 'POST', path: e2e('analysis'), body: { sampleSize: 100 }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'pubsubChannels', method: 'POST', path: e2e('pubsub/channels'), body: {}, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'pubsubSubscribe', method: 'POST', path: e2e('pubsub/subscriptions'), body: { channels: ['e2e-matrix'] }, expect: all(ANON_WRITE, [200, 201], [200, 201], [200, 201]) },
  { route: 'pubsubStream', label: 'pubsub stream (subscribe, then stream)', method: 'GET', path: e2e('pubsub/stream'), sse: true, subscribe: { channels: ['e2e-matrix'] }, expect: readRoute },
  { route: 'publish', method: 'POST', path: e2e('pubsub/publish'), body: { channel: 'e2e-matrix', message: utf8('hi') }, expect: all(ANON_WRITE, 403, 200, 200) },
  { route: 'profilerStream', method: 'GET', path: e2e('profiler/stream?seconds=1'), sse: true, expect: all(401, 403, 403, 200) },
  { route: 'searchIndexes', method: 'GET', path: e2e('search/indexes'), expect: readRoute },
  { route: 'searchQuery', method: 'POST', path: e2e('search/query'), body: { index: K.searchIndex, query: '*' }, expect: all(ANON_WRITE, 200, 200, 200) },
  // v0.2.1 insight routes. Nothing is created or dropped here: write routes stop at their confirmation (428), and
  // job routes use an id the caller does not own (404, indistinguishable from a missing job).
  { route: 'searchIndexInfo', method: 'POST', path: e2e('search/index/info'), body: { index: K.searchIndex }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'searchSample', method: 'POST', path: e2e('search/sample'), body: { on: 'HASH', prefix: K.docPrefix, keys: 5 }, expect: all(ANON_WRITE, 200, 200, 200) },
  {
    route: 'searchIndexCreate', method: 'POST', path: e2e('search/index/create'),
    body: { index: 'idx:e2e:matrix-never-created', on: 'HASH', prefixes: ['e2e:matrix-none:'], schema: [{ name: 'title', type: 'TEXT' }] },
    expect: all(ANON_WRITE, 403, 428, 428),
  },
  { route: 'searchIndexDrop', method: 'POST', path: e2e('search/index/drop'), body: { index: 'idx:e2e:matrix-no-such-index' }, expect: all(ANON_WRITE, 403, 403, 428) },
  { route: 'analysisJobStart', method: 'POST', path: e2e('analysis/jobs'), body: { sampleSize: 100, match: 'e2e:string:*' }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'analysisJob', method: 'GET', path: e2e('analysis/jobs/0123456789abcdef01234567'), expect: all(401, 404, 404, 404) },
  { route: 'analysisJobCancel', method: 'POST', path: e2e('analysis/jobs/0123456789abcdef01234567/cancel'), expect: all(ANON_WRITE, 404, 404, 404) },
  // Imports are operator and above (review v0.2.1 F1).
  { route: 'importPlan', method: 'POST', path: e2e('import'), body: { script: 'PING' }, expect: all(ANON_WRITE, 403, 200, 200) },
  { route: 'importStart', method: 'POST', path: e2e('import/0123456789abcdef01234567/start'), expect: all(ANON_WRITE, 403, 404, 404) },
  { route: 'importStatus', method: 'GET', path: e2e('import/0123456789abcdef01234567'), expect: all(401, 403, 404, 404) },
  { route: 'importCancel', method: 'POST', path: e2e('import/0123456789abcdef01234567/cancel'), expect: all(ANON_WRITE, 403, 404, 404) },
  { route: 'streamGroups', method: 'POST', path: e2e('streams/groups'), body: { key: utf8(K.stream) }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'streamPending', method: 'POST', path: e2e('streams/pending'), body: { key: utf8(K.stream), group: K.streamGroup }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'tsRange', method: 'POST', path: e2e('timeseries/range'), body: { key: utf8(K.ts) }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'vsetMembers', method: 'POST', path: e2e('vectorset/members'), body: { key: utf8(VSET), count: 10 }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'vsetAttributes', method: 'POST', path: e2e('vectorset/attributes'), body: { key: utf8(VSET), members: [utf8('m1')] }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'vsetElement', method: 'POST', path: e2e('vectorset/element'), body: { key: utf8(VSET), member: utf8('m1') }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'vsetSearch', method: 'POST', path: e2e('vectorset/search'), body: { key: utf8(VSET), query: { element: utf8('m1') }, count: 2 }, expect: all(ANON_WRITE, 200, 200, 200) },
  // v0.4 arrays: reads for every role; writes are typed ops (operator and up), deletes stop at their confirmation.
  { route: 'arrayRange', method: 'POST', path: e2e('array/range'), body: { key: utf8(K.array), count: 10 }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'arraySearch', method: 'POST', path: e2e('array/search'), body: { key: utf8(K.array), predicates: [{ kind: 'match', value: utf8('a') }] }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'arraySearch', label: 'array search with RE (refused)', method: 'POST', path: e2e('array/search'), body: { key: utf8(K.array), predicates: [{ kind: 're', value: utf8('(a+)+$') }] }, expect: all(ANON_WRITE, 400, 400, 400) },
  { route: 'arrayAggregate', method: 'POST', path: e2e('array/aggregate'), body: { key: utf8(K.array), start: '0', end: '2000', op: 'used' }, expect: all(ANON_WRITE, 200, 200, 200) },
  { route: 'ops', label: 'ops array.insert (create)', method: 'POST', path: e2e('ops'), body: () => ({ op: 'array.insert', key: utf8(`${K.scratchPrefix}matrix-array:${Math.random().toString(36).slice(2)}`), values: [utf8('v')], expect: { type: 'none' } }), expect: all(ANON_WRITE, 403, 200, 200) },
  { route: 'ops', label: 'ops array.delete-range (confirmation)', method: 'POST', path: e2e('ops'), body: { op: 'array.delete-range', key: utf8(K.array), start: '0', end: '2' }, expect: all(ANON_WRITE, 403, 428, 428) },
  { route: 'audit', method: 'GET', path: `${API}/admin/audit`, expect: all(401, 403, 403, 200) },
  { route: 'users', method: 'GET', path: `${API}/admin/users`, expect: all(401, 403, 403, 200) },
  {
    route: 'userCreate', method: 'POST', path: `${API}/admin/users`,
    body: () => { const pw = newPassword(); registerExtraSecret(`pw:${pw.slice(0, 8)}`, pw); return { username: uniqueName('mx'), displayName: 'Matrix user', role: 'viewer', initialPassword: pw }; },
    expect: all(ANON_WRITE, 403, 403, [200, 201]),
  },
  { route: 'userUpdate', method: 'PATCH', path: () => `${API}/admin/users/${throwawayUserId}`, body: { displayName: 'Renamed by matrix' }, expect: all(ANON_WRITE, 403, 403, 200) },
];

test.describe('role matrix', () => {
  let apis: Record<RoleKey, Api>;
  test.beforeAll(async () => {
    await redisExec(['VADD', VSET, 'VALUES', '3', '0.1', '0.2', '0.3', 'm1', 'SETATTR', '{"n":1}']);
    await redisExec(['VADD', VSET, 'VALUES', '3', '0.3', '0.2', '0.1', 'm2']);
    apis = await roleApis();
    const pw = newPassword();
    registerExtraSecret('pw:matrix-throwaway', pw);
    const r = await apis.admin.post(`${API}/admin/users`, { username: uniqueName('mx-upd'), displayName: 'Matrix throwaway', role: 'viewer', initialPassword: pw });
    expect(r.status, r.text).toBeLessThan(300);
    throwawayUserId = r.json.user?.id ?? r.json.id;
  });
  test.afterAll(async () => {
    await disposeAll(apis);
    await redisExec(['DEL', VSET]).catch(() => undefined);
  });

  test('every route in the shared ROUTES table is covered', () => {
    const covered = new Set(ROWS.map((r) => r.route));
    const missing = Object.keys(ROUTES).filter((k) => !covered.has(k as keyof typeof ROUTES));
    expect(missing).toEqual([]);
    for (const r of ROWS) {
      const [m, p] = ROUTES[r.route].split(' ');
      expect(r.method, `${r.route} method`).toBe(m);
      const pathStr = typeof r.path === 'function' ? `${API}/admin/users/:id` : r.path;
      const pattern = new RegExp('^' + p!.replace(/:db/, '[^/]+').replace(/:id/, '[^/?]+') + '(\\?.*)?$');
      expect(pathStr, `${r.route} path`).toMatch(pattern);
    }
  });

  for (const row of ROWS) {
    for (const role of ROLE_KEYS) {
      const exp = row.expect[role];
      if (exp === null) continue;
      test(`${row.label ?? row.route} [${row.method}] as ${role} -> ${Array.isArray(exp) ? exp.join('|') : exp}`, async () => {
        const api = apis[role];
        const path = typeof row.path === 'function' ? row.path() : row.path;
        const body = typeof row.body === 'function' ? (row.body as () => unknown)() : row.body;
        let status: number;
        let text = '';
        if (row.sse) {
          let ssePath = path;
          if (row.subscribe) {
            // Anonymous callers cannot obtain a subscription id; use a made-up one.
            const sub = role === 'anon' ? { status: 401, json: { id: 'x'.repeat(32) } } : await api.post(e2e('pubsub/subscriptions'), row.subscribe);
            expect([200, 201, 401], `subscribe as ${role}`).toContain(sub.status);
            ssePath = `${path}?sub=${encodeURIComponent(sub.json.id)}`;
          }
          const r = await api.sse(ssePath, { maxEvents: 1, timeoutMs: 4000 });
          status = r.status;
          text = r.raw.slice(0, 300);
          if (status === 200) expect(r.contentType).toContain('text/event-stream');
        } else {
          const r = row.method === 'GET' ? await api.get(path) : await api.req(row.method, path, body ?? {});
          status = r.status;
          text = r.text.slice(0, 300);
          if (status >= 400 && status !== 404 && r.json) expect(r.json.error?.code, `ApiError shape: ${text}`).toBeTruthy();
        }
        const allowed = Array.isArray(exp) ? exp : [exp];
        expect(allowed, `${role} ${row.method} ${path} got ${status}: ${text}`).toContain(status);
      });
    }
  }
});

test.describe('effective role per database', () => {
  test('remote-6390 (maxRole viewer, readOnly) caps every role at viewer', async () => {
    const apis = await roleApis();
    try {
      for (const role of ['viewer', 'operator', 'admin'] as const) {
        const r = await apis[role].get(`${API}/databases`);
        expect(r.status).toBe(200);
        const dbs = r.json.databases as { id: string; effectiveRole: string; readOnly: boolean; environment: string }[];
        const remote = dbs.find((d) => d.id === DB.remote)!;
        expect(remote, 'remote-6390 listed').toBeTruthy();
        expect(remote.effectiveRole).toBe('viewer');
        expect(remote.readOnly).toBe(true);
        expect(remote.environment).toBe('prod');
        const e2eDb = dbs.find((d) => d.id === DB.e2e)!;
        expect(e2eDb.effectiveRole).toBe(role);
      }
      // Admin-class command on remote is refused for admin (effective role viewer).
      const c = await apis.admin.post(dbPath(DB.remote, 'cli'), { line: 'CONFIG GET maxmemory' });
      expect(c.status).toBe(403);
      const cl = await apis.admin.get(dbPath(DB.remote, 'clients'));
      expect(cl.status).toBe(403);
    } finally {
      await disposeAll(apis);
    }
  });

  test('database list exposes no connection details', async () => {
    const apis = await roleApis();
    try {
      const r = await apis.admin.get(`${API}/databases`);
      expect(r.text).not.toMatch(/rediss?:\/\/|127\.0\.0\.1|:6411|:6431|:6430|:6390|password|credentials|"url"|"host"|"port"/i);
    } finally {
      await disposeAll(apis);
    }
  });

  test('unknown database id is 404 (not 500) for every role', async () => {
    const apis = await roleApis();
    try {
      for (const role of ['viewer', 'operator', 'admin'] as const) {
        const r = await apis[role].get(dbPath('no-such-db', 'overview'));
        expect(r.status).toBe(404);
      }
    } finally {
      await disposeAll(apis);
    }
  });
});
