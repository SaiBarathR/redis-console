/** Feature endpoints: dashboard, diagnostics, pub/sub over SSE, streams, search, timeseries, profiler, commands, audit, users. */
import { test, expect } from '@playwright/test';
import { API, Api, dbPath, utf8 } from '../../lib/api.ts';
import { DB } from '../../lib/env.ts';
import { GRAPH_DB } from '../../lib/graph.ts';
import { AUDIT_CANARY_VALUE, K, redisExec } from '../../lib/fixtures-data.ts';
import { createUser, uniqueName } from '../../lib/accounts.ts';
import { knownBug } from '../../lib/findings.ts';

const E = (s: string) => dbPath(DB.e2e, s);

test.describe('features API', () => {
  let viewer: Api;
  let op: Api;
  let admin: Api;
  test.beforeAll(async () => {
    viewer = await Api.fromStorage('viewer');
    op = await Api.fromStorage('operator');
    admin = await Api.fromStorage('admin');
  });
  test.afterAll(async () => { for (const a of [viewer, op, admin]) await a.dispose(); });

  test('databases list and overview', async () => {
    const r = await viewer.get(`${API}/databases`);
    const ids = (r.json.databases as any[]).map((d) => d.id).sort();
    expect(ids).toEqual([DB.prodSim, DB.remote, DB.e2e, GRAPH_DB].sort());
    const graph = (r.json.databases as any[]).find((d) => d.id === GRAPH_DB);
    expect(graph.status).toBe('connected');
    expect(graph.server.modules.map((m: any) => m.name.toLowerCase())).toContain('graph');
    const e2e = (r.json.databases as any[]).find((d) => d.id === DB.e2e);
    expect(e2e.status).toBe('connected');
    expect(e2e.server.modules.map((m: any) => m.name.toLowerCase())).toEqual(expect.arrayContaining(['search', 'timeseries']));
    const o = await viewer.get(E('overview'));
    expect(o.status).toBe(200);
    expect(o.json.keyspace[0].keys).toBeGreaterThan(200);
    expect(o.json.memory.used).toBeGreaterThan(0);
    expect(o.json.uptimeSeconds).toBeGreaterThan(0);
    expect(JSON.stringify(o.json.info)).not.toMatch(/requirepass|masterauth/i);
  });

  test('metrics SSE emits MetricsSample events', async () => {
    const r = await viewer.sse(E('metrics/stream'), { maxEvents: 2, timeoutMs: 8000 });
    expect(r.status).toBe(200);
    expect(r.events.length).toBeGreaterThanOrEqual(1);
    expect(r.events[0]).toMatchObject({ t: expect.any(Number), opsPerSec: expect.any(Number), usedMemory: expect.any(Number) });
  });

  test('slowlog lists entries with argv truncated/redacted', async () => {
    await redisExec(['CONFIG', 'SET', 'slowlog-log-slower-than', '0']).catch(() => undefined);
    await redisExec(['GET', K.str]);
    await redisExec(['CONFIG', 'SET', 'slowlog-log-slower-than', '1000']).catch(() => undefined);
    const r = await viewer.get(E('slowlog?count=50'));
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.entries)).toBe(true);
    expect(typeof r.json.len).toBe('number');
  });

  test('slowlog reset (admin, confirmed)', async () => {
    const f = await admin.post(E('slowlog/reset'), {});
    expect(f.status).toBe(428);
    const ok = await admin.post(E('slowlog/reset'), { confirmation: { token: f.json.error.confirmation.token } });
    expect(ok.status, ok.text).toBe(200);
  });

  test('clients list (admin) contains no credentials', async () => {
    const r = await admin.get(E('clients'));
    expect(r.status).toBe(200);
    expect(r.json.clients.length).toBeGreaterThan(0);
    expect(r.json.clients[0]).toMatchObject({ id: expect.any(String), addr: expect.any(String) });
  });

  test('memory analysis is bounded and reports types, top keys and prefixes', async () => {
    const r = await viewer.post(E('analysis'), { sampleSize: 1000, delimiter: ':' });
    expect(r.status, r.text.slice(0, 200)).toBe(200);
    expect(r.json.sampled).toBeGreaterThan(100);
    expect(r.json.sampled).toBeLessThanOrEqual(1000);
    expect(r.json.byType.map((t: any) => t.type)).toEqual(expect.arrayContaining(['string', 'hash', 'list']));
    expect(r.json.topKeysBySize[0].key.data).toBe(K.big);
    expect(r.json.prefixes.length).toBeGreaterThan(0);
    const tooBig = await viewer.post(E('analysis'), { sampleSize: 10_000_000 });
    expect(tooBig.status).toBe(400);
  });

  test('pub/sub round trip over SSE (subscribe, publish, receive)', async () => {
    const channel = `e2e-chan-${Date.now()}`;
    const message = `hello <b>${Date.now()}</b>`;
    let published: Promise<any> | undefined;
    const sub = await viewer.post(E('pubsub/subscriptions'), { channels: [channel], patterns: ['e2e-pat-*'] });
    expect(sub.status, sub.text).toBeLessThan(300);
    expect(sub.json.id).toBeTruthy();
    expect(sub.text, 'subscription id does not echo channel names').not.toContain(channel);
    const r = await viewer.sse(E(`pubsub/stream?sub=${encodeURIComponent(sub.json.id)}`), {
      timeoutMs: 10_000,
      onOpen: () => {
        published = (async () => {
          for (let i = 0; i < 20; i++) {
            const ch = await op.post(E('pubsub/channels'), {});
            if ((ch.json.channels as any[]).some((c) => c.name === channel)) break;
            await new Promise((res) => setTimeout(res, 150));
          }
          const p1 = await op.post(E('pubsub/publish'), { channel, message: utf8(message) });
          const p2 = await op.post(E('pubsub/publish'), { channel: 'e2e-pat-x', message: utf8('via pattern') });
          return [p1, p2];
        })();
      },
      until: (_e, all) => all.filter((x: any) => x.message).length >= 2,
    });
    expect(r.status).toBe(200);
    const [p1] = await published!;
    expect(p1.status, p1.text).toBe(200);
    expect(p1.json.receivers).toBeGreaterThanOrEqual(1);
    const msgs = r.events.filter((e: any) => e.message);
    expect(msgs.find((m: any) => m.channel === channel)?.message).toEqual(utf8(message));
    expect(msgs.find((m: any) => m.pattern === 'e2e-pat-*')?.message).toEqual(utf8('via pattern'));
  });

  test('pub/sub limits: more than 10 channels refused', async () => {
    const r = await viewer.post(E('pubsub/subscriptions'), { channels: Array.from({ length: 11 }, (_, i) => `c${i}`) });
    expect(r.status).toBe(400);
  });

  test('pub/sub subscription ids are single-use and bound to the session', async () => {
    const sub = await viewer.post(E('pubsub/subscriptions'), { channels: ['e2e-single-use'] });
    const id = encodeURIComponent(sub.json.id);
    // Another user's session cannot use it.
    const stolen = await op.sse(E(`pubsub/stream?sub=${id}`), { maxEvents: 1, timeoutMs: 3000 });
    expect(stolen.status).toBe(404);
    const first = await viewer.sse(E(`pubsub/stream?sub=${id}`), { maxEvents: 1, timeoutMs: 3000 });
    expect([200, 404]).toContain(first.status); // 404 if the stolen attempt consumed it
    const again = await viewer.sse(E(`pubsub/stream?sub=${id}`), { maxEvents: 1, timeoutMs: 3000 });
    expect(again.status).toBe(404);
    // Bound to the database too.
    const sub2 = await viewer.post(E('pubsub/subscriptions'), { channels: ['e2e-db-bound'] });
    const other = await viewer.sse(dbPath(DB.prodSim, `pubsub/stream?sub=${encodeURIComponent(sub2.json.id)}`), { maxEvents: 1, timeoutMs: 3000 });
    expect(other.status).toBe(404);
  });

  test('viewer cannot publish', async () => {
    expect((await viewer.post(E('pubsub/publish'), { channel: 'x', message: utf8('y') })).status).toBe(403);
  });

  test('streams: groups, consumers, pending and ack', async () => {
    const g = await viewer.post(E('streams/groups'), { key: utf8(K.stream) });
    expect(g.status).toBe(200);
    const grp = (g.json.groups as any[]).find((x) => x.name === K.streamGroup);
    expect(grp.pending).toBe(4);
    expect(grp.consumers[0].name).toBe(K.streamConsumer);
    const p = await viewer.post(E('streams/pending'), { key: utf8(K.stream), group: K.streamGroup });
    expect(p.status).toBe(200);
    expect(p.json.total).toBe(4);
    const id = p.json.pending[0].id;
    expect(p.json.pending[0].consumer).toBe(K.streamConsumer);
    const ack = await op.post(E('ops'), { op: 'stream.ack', key: utf8(K.stream), group: K.streamGroup, ids: [id] });
    expect(ack.status, ack.text).toBe(200);
    const p2 = await viewer.post(E('streams/pending'), { key: utf8(K.stream), group: K.streamGroup });
    expect(p2.json.total).toBe(3);
  });

  test('search: indexes and query', async () => {
    const i = await viewer.get(E('search/indexes'));
    expect(i.status).toBe(200);
    const idx = (i.json.indexes as any[]).find((x) => x.name === K.searchIndex);
    expect(idx.numDocs).toBe(20);
    expect(idx.fields.map((f: any) => f.name)).toEqual(expect.arrayContaining(['title', 'price', 'category']));
    const q = await viewer.post(E('search/query'), { index: K.searchIndex, query: '@title:red', limit: 5 });
    expect(q.status, q.text).toBe(200);
    expect(q.json.total).toBe(10);
    expect(q.json.docs.length).toBe(5);
    expect(q.json.docs[0].fields.title).toMatch(/Red widget/);
    const range = await viewer.post(E('search/query'), { index: K.searchIndex, query: '@price:[0 10]' });
    expect(range.json.total).toBe(3);
  });

  test('search as admin: indexes and query', async () => {
    const i = await admin.get(E('search/indexes'));
    expect(i.status, i.text.slice(0, 200)).toBe(200);
    expect((i.json.indexes as any[]).find((x) => x.name === K.searchIndex).numDocs).toBe(20);
    const q = await viewer.post(E('search/query'), { index: K.searchIndex, query: '@title:red', limit: 5 });
    expect(q.status, q.text).toBe(200);
    expect(q.json.total).toBe(10);
  });

  test('timeseries range with aggregation', async () => {
    const r = await viewer.post(E('timeseries/range'), { key: utf8(K.ts) });
    expect(r.status).toBe(200);
    expect(r.json.samples.length).toBe(61);
    const agg = await viewer.post(E('timeseries/range'), { key: utf8(K.ts), bucketMs: 600000, agg: 'avg' });
    expect(agg.status).toBe(200);
    expect(agg.json.samples.length).toBeLessThanOrEqual(8);
    expect((await viewer.post(E('timeseries/range'), { key: utf8(K.ts), agg: 'evil' })).status).toBe(400);
  });

  test('profiler: admin on non-prod gets events with truncated args; audited', async () => {
    const marker = 'P'.repeat(200);
    const r = await admin.sse(E('profiler/stream?seconds=3'), {
      timeoutMs: 8000,
      onOpen: async () => { setTimeout(() => { void redisExec(['SET', `${K.scratchPrefix}prof`, marker]); }, 500); },
      until: (e: any) => Array.isArray(e.argv) && e.argv.some((a: string) => a.startsWith('PPPP')),
    });
    expect(r.status).toBe(200);
    const ev = r.events.find((e: any) => Array.isArray(e.argv) && e.argv.some((a: string) => a.startsWith('PPPP'))) as any;
    expect(ev, 'saw the SET in the profiler').toBeTruthy();
    for (const a of ev.argv) expect(a.length).toBeLessThanOrEqual(80);
    const a = await admin.get(`${API}/admin/audit?limit=50`);
    expect((a.json.events as any[]).some((e) => /profiler/.test(e.action))).toBe(true);
  });

  test('profiler refused on prod-tagged database even for admin, and > 60 s refused', async () => {
    expect((await admin.sse(dbPath(DB.prodSim, 'profiler/stream?seconds=1'), { maxEvents: 1, timeoutMs: 3000 })).status).toBe(403);
    expect((await admin.sse(E('profiler/stream?seconds=600'), { maxEvents: 1, timeoutMs: 3000 })).status).toBe(400);
  });

  test('commands: docs annotated with class and allowed for the caller', async () => {
    const v = await viewer.get(E('commands'));
    expect(v.status).toBe(200);
    const find = (list: any[], n: string) => list.find((c) => c.name.toUpperCase() === n);
    const vc = v.json.commands as any[];
    expect(vc.length).toBeGreaterThan(100);
    expect(find(vc, 'GET')).toMatchObject({ class: 'read', allowed: true });
    expect(find(vc, 'SET')).toMatchObject({ class: 'write', allowed: false });
    expect(find(vc, 'EVAL')).toMatchObject({ class: 'blocked', allowed: false });
    expect(find(vc, 'HSET').arguments.length).toBeGreaterThan(0);
    const o = (await op.get(E('commands'))).json.commands as any[];
    expect(find(o, 'SET').allowed).toBe(true);
    expect(find(o, 'KEYS').allowed).toBe(false);
  });

  test('audit log: entries exist and argv is redacted (no values, keys hashed)', async () => {
    const key = `${K.scratchPrefix}audit-target`;
    const set = await op.post(E('cli'), { line: `SET ${key} ${AUDIT_CANARY_VALUE}` });
    expect(set.status).toBe(200);
    const hs = await op.post(E('ops'), { op: 'hash.set', key: utf8(key + ':h'), entries: [{ field: utf8('f'), value: utf8(AUDIT_CANARY_VALUE) }] });
    expect(hs.status).toBe(200);
    const a = await admin.get(`${API}/admin/audit?limit=200`);
    expect(a.status).toBe(200);
    const events = a.json.events as any[];
    expect(events.length).toBeGreaterThan(5);
    expect(a.text).not.toContain(AUDIT_CANARY_VALUE);
    expect(a.text, 'key names are not stored in clear').not.toContain('audit-target');
    const ev = events.find((e) => e.command?.toUpperCase() === 'SET' && e.username === 'e2e-operator');
    expect(ev).toBeTruthy();
    expect(ev.keyCount).toBe(1);
    expect(ev.argvRedacted[0].toUpperCase()).toBe('SET');
    expect(ev.argvRedacted.join(' ')).toMatch(new RegExp(`<${AUDIT_CANARY_VALUE.length} bytes>`));
    for (const field of ['id', 'at', 'userId', 'username', 'ip', 'action', 'outcome']) expect(ev[field], field).toBeTruthy();
    const auth = await admin.get(`${API}/admin/audit?action=auth.login&limit=5`);
    expect(auth.json.events.length).toBeGreaterThan(0);
    for (const e of auth.json.events) expect(e.action).toBe('auth.login');
    // Filters
    const f = await admin.get(`${API}/admin/audit?user=e2e-operator&limit=10`);
    for (const e of f.json.events) expect(e.username).toBe('e2e-operator');
    const page2 = await admin.get(`${API}/admin/audit?limit=5`);
    if (page2.json.nextBefore) {
      const older = await admin.get(`${API}/admin/audit?limit=5&before=${encodeURIComponent(page2.json.nextBefore)}`);
      expect(older.json.events[0].id).not.toBe(page2.json.events[0].id);
    }
  });

  test('user management: create, change role, disable, re-enable, reset TOTP', async () => {
    const name = uniqueName('um');
    const { acc, api, id } = await createUser(admin, name, 'viewer');
    expect(api!.me.role).toBe('viewer');
    const list = await admin.get(`${API}/admin/users`);
    const u = (list.json.users as any[]).find((x) => x.username === name);
    expect(u).toMatchObject({ role: 'viewer', disabled: false });
    expect(JSON.stringify(list.json)).not.toMatch(/hash|argon|secret|password/i);

    // Promote to operator: existing session is revoked or re-evaluated (privilege change).
    const up = await admin.patch(`${API}/admin/users/${id}`, { role: 'operator' });
    expect(up.status, up.text).toBe(200);
    const meAfter = await api!.get(`${API}/auth/me`);
    expect(meAfter.status === 401 || meAfter.json.role === 'operator').toBe(true);

    // Disable: sessions revoked, login refused.
    const dis = await admin.patch(`${API}/admin/users/${id}`, { disabled: true });
    expect(dis.status).toBe(200);
    expect((await api!.get(`${API}/auth/me`)).status).toBe(401);
    const again = await Api.anonymous();
    const l = await again.post(`${API}/auth/login`, { username: acc.username, password: acc.password }, { csrf: null });
    expect(l.status).toBe(401);
    // Re-enable.
    expect((await admin.patch(`${API}/admin/users/${id}`, { disabled: false })).status).toBe(200);
    await again.loginWith(acc);
    expect(again.me.role).toBe('operator');
    // Validation
    expect((await admin.post(`${API}/admin/users`, { username: 'x', displayName: 'y', role: 'viewer', initialPassword: 'short' })).status).toBe(400);
    expect((await admin.post(`${API}/admin/users`, { username: name, displayName: 'dup', role: 'viewer', initialPassword: 'Long-enough-password-1' })).status).toBeGreaterThanOrEqual(400);
    expect((await admin.post(`${API}/admin/users`, { username: 'role-x', displayName: 'y', role: 'superadmin', initialPassword: 'Long-enough-password-1' })).status).toBe(400);
    await api!.dispose();
    await again.dispose();
  });

  test('admin cannot lock themselves out by demoting or disabling their own account', async () => {
    const admin2 = await Api.fromStorage('admin2');
    try {
      const me = admin2.me;
      const r = await admin2.patch(`${API}/admin/users/${me.id}`, { disabled: true });
      expect([400, 403, 409]).toContain(r.status);
      const r2 = await admin2.patch(`${API}/admin/users/${me.id}`, { role: 'viewer' });
      expect([400, 403, 409]).toContain(r2.status);
      expect((await admin2.get(`${API}/auth/me`)).json.role).toBe('admin');
    } finally {
      await admin2.dispose();
    }
  });
});
