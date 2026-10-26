/**
 * Cluster + sentinel modes. Runs only when the disposable topology is up:
 *   RC_TOPO_PASSWORD=... apps/server/scripts/topology.sh up
 * (cluster 127.0.0.1:6420-6422, sentinel 127.0.0.1:6427 monitoring "mymaster" @ 6426).
 */
import { createHash } from 'node:crypto';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config.ts';
import { createClient, createCluster, TimeoutError } from 'redis';
import { hashSlot } from '../../src/redis/capped.ts';
import type { Arg, Target } from '../../src/redis/manager.ts';
import { bk, portOpen, startApp, testConfigRaw, userSession, utf8, type TestApp } from '../helpers.ts';
import { listen, openSse } from './auth-helpers.ts';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
/** Redis ports of the cluster primaries and the sentinel's master. */
const DATA_PORTS = [6420, 6421, 6422, 6426];

/** Calls `seen` when a chunk containing `marker` is written to a socket connected to one of `ports` (any socket of the process). */
function onSocketWrite(ports: number[], marker: string, seen: () => void): () => void {
  const proto = net.Socket.prototype as unknown as { write: (...a: unknown[]) => boolean };
  const write = proto.write;
  proto.write = function (this: net.Socket, ...a: unknown[]) {
    if (ports.includes(this.remotePort ?? -1) && String(a[0]).includes(marker)) seen();
    return write.apply(this, a);
  };
  return () => { proto.write = write; };
}

const topoUp = !!process.env.RC_TOPO_PASSWORD && (await portOpen(6420)) && (await portOpen(6427));
const creds = {
  viewer: { username: 'rc-viewer', password: { env: 'RC_TOPO_PASSWORD' } },
  operator: { username: 'rc-operator', password: { env: 'RC_TOPO_PASSWORD' } },
  admin: { username: 'rc-admin', password: { env: 'RC_TOPO_PASSWORD' } },
};

describe.skipIf(!topoUp)('cluster and sentinel modes', () => {
  let t: TestApp;
  const P = `rcsrv:topo:${Date.now()}:`;
  let url: string | undefined;
  const base = async () => (url ??= await listen(t.app));

  beforeAll(async () => {
    const raw = testConfigRaw();
    raw.databases = [
      { id: 'cl', name: 'Cluster', environment: 'test', mode: 'cluster', nodes: ['redis://127.0.0.1:6420', 'redis://127.0.0.1:6421', 'redis://127.0.0.1:6422'], credentials: creds },
      { id: 'sn', name: 'Sentinel', environment: 'test', mode: 'sentinel', sentinels: [{ host: '127.0.0.1', port: 6427 }], masterName: 'mymaster', credentials: creds },
    ];
    t = await startApp(resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } }));
  });
  afterAll(async () => {
    if (!t) return;
    const admin = await userSession(t, 'admin');
    for (const db of ['cl', 'sn']) {
      const r = await admin.req('POST', `/api/v1/databases/${db}/bulk-delete`, { match: `${P}*` });
      if (r.status === 428) await admin.req('POST', `/api/v1/databases/${db}/bulk-delete`, { match: `${P}*`, confirmation: { token: r.json.error.confirmation.token, typed: r.json.error.confirmation.expectedText } });
    }
    await t.close();
  });

  for (const db of ['cl', 'sn'] as const) {
    describe(db, () => {
      it('lists the database as connected with its mode', async () => {
        const v = await userSession(t, 'viewer');
        const r = await v.req('GET', '/api/v1/databases');
        const d = r.json.databases.find((x: { id: string }) => x.id === db);
        expect(d.status).toBe('connected');
        expect(d.server.mode).toBe(db === 'cl' ? 'cluster' : 'sentinel');
      });

      it('runs commands as the caller tier user and routes keys', async () => {
        for (const role of ['viewer', 'operator', 'admin'] as const) {
          const c = await userSession(t, role);
          const r = await c.req('POST', `/api/v1/databases/${db}/cli`, { line: 'CLIENT INFO' });
          expect(r.status).toBe(200);
          expect(r.json.reply.v.data).toContain(`user=rc-${role}`);
        }
        const op = await userSession(t, 'operator');
        // Keys spread over many slots (and so over all three primaries in cluster mode).
        const script = Array.from({ length: 30 }, (_, i) => `SET ${P}k${i} v${i}`).join('\n');
        const w = await op.req('POST', `/api/v1/databases/${db}/workbench`, { script });
        expect(w.status, JSON.stringify(w.json)).toBe(200);
        expect(w.json.results.map((x: { reply?: { t: string } }) => x.reply?.t)).toEqual(Array(30).fill('str'));
        const g = await op.req('POST', `/api/v1/databases/${db}/cli`, { argv: ['GET', `${P}k7`] });
        expect(g.json.reply).toEqual({ t: 'str', v: utf8('v7') });
      });

      it('scans across every primary with an opaque cursor', async () => {
        const v = await userSession(t, 'viewer');
        const seen = new Set<string>();
        let cursor = '0';
        let pages = 0;
        do {
          const r = await v.req('POST', `/api/v1/databases/${db}/keys/scan`, { match: `${P}k*`, count: 10, cursor });
          expect(r.status, JSON.stringify(r.json)).toBe(200);
          for (const k of r.json.keys) seen.add(k.key.data);
          cursor = r.json.cursor;
          pages++;
        } while (cursor !== "0" && pages < 50);
        expect(seen.size).toBe(30);
      });

      it('names scan: every primary with the opaque cursor, names only; exact lookups route by slot (v0.2.1)', async () => {
        const v = await userSession(t, 'viewer');
        const seen = new Set<string>();
        let cursor = '0';
        let requests = 0;
        do {
          const r = await v.req('POST', `/api/v1/databases/${db}/keys/names`, { match: `${P}k*`, cursor, scanThreshold: 100 });
          expect(r.status, JSON.stringify(r.json)).toBe(200);
          expect(r.json.scanned).toBeLessThanOrEqual(100);
          for (const k of r.json.keys) {
            expect(Object.keys(k).sort()).toEqual(['data', 'enc']);
            seen.add(k.data);
          }
          if (r.json.cursor !== '0' && db === 'cl') expect(r.json.cursor).toMatch(/^\d+$/);
          cursor = r.json.cursor;
          requests++;
        } while (cursor !== '0' && requests < 200);
        expect(seen.size).toBe(30);
        const full = await v.req('POST', `/api/v1/databases/${db}/keys/names`, { match: `${P}k*` });
        expect(full.json.cursor).toBe('0');
        expect(full.json.keys).toHaveLength(30);
        expect(full.json.dbSize).toBeGreaterThanOrEqual(30);
        for (const i of [0, 7, 29]) {
          const one = await v.req('POST', `/api/v1/databases/${db}/keys/names`, { match: `${P}k${i}` });
          expect(one.json).toMatchObject({ exact: true, keys: [utf8(`${P}k${i}`)] });
        }
      });

      it('metadata of keys on every primary in one request, pipelined per node, in request order (v0.2.1)', async () => {
        const v = await userSession(t, 'viewer');
        const keys = Array.from({ length: 30 }, (_, i) => utf8(`${P}k${i}`));
        const r = await v.req('POST', `/api/v1/databases/${db}/keys/meta`, { keys: [...keys, utf8(`${P}missing`)] });
        expect(r.status, JSON.stringify(r.json)).toBe(200);
        expect(r.json.keys.map((k: { key: { data: string } }) => k.key.data)).toEqual([...keys.map((k) => k.data), `${P}missing`]);
        expect(r.json.keys.slice(0, 30).every((k: { type: string; ttl: number; size: number }) => k.type === 'string' && k.ttl === -1 && k.size > 0)).toBe(true);
        expect(r.json.keys[30]).toMatchObject({ type: 'none', ttl: -2 });
        if (db === 'cl') expect(new Set(keys.map((k) => hashSlot(k.data) < 5461 ? 0 : hashSlot(k.data) < 10923 ? 1 : 2)).size).toBe(3);
      });

      it('pattern delete job runs across primaries and reports its counts (F20)', async () => {
        const op = await userSession(t, 'operator');
        const w = await op.req('POST', `/api/v1/databases/${db}/workbench`, { script: Array.from({ length: 20 }, (_, i) => `SET ${P}job${i} v`).join('\n') });
        expect(w.status).toBe(200);
        const body = { match: `${P}job*` };
        const c = await op.req('POST', `/api/v1/databases/${db}/bulk-delete/jobs`, body);
        expect(c.status).toBe(428);
        expect(c.json.error.confirmation.impact.keys).toBe(20);
        const s = await op.req('POST', `/api/v1/databases/${db}/bulk-delete/jobs`, { ...body, confirmation: { token: c.json.error.confirmation.token, typed: c.json.error.confirmation.expectedText } });
        expect(s.status, JSON.stringify(s.json)).toBe(200);
        let job = s.json.job;
        for (let i = 0; i < 100 && job.state === 'running'; i++) {
          await new Promise((r) => setTimeout(r, 50));
          job = (await op.req('GET', `/api/v1/databases/${db}/bulk-delete/jobs/${job.id}`)).json.job;
        }
        expect(job).toMatchObject({ state: 'done', deleted: 20, failed: 0, complete: true });
        const left = await op.req('POST', `/api/v1/databases/${db}/keys/names`, { match: `${P}job*` });
        expect(left.json.keys).toEqual([]);
      });

      it('reads key details and runs multi-key typed deletes across slots', async () => {
        const op = await userSession(t, 'operator');
        const d = await op.req('POST', `/api/v1/databases/${db}/key/read`, { key: bk(`${P}k3`) });
        expect(d.status).toBe(200);
        expect(d.json.value).toMatchObject({ type: 'string', value: utf8('v3') });
        const body = { op: 'key.delete', keys: [utf8(`${P}k1`), utf8(`${P}k2`), utf8(`${P}k3`)] };
        const c = await op.req('POST', `/api/v1/databases/${db}/ops`, body);
        expect(c.status).toBe(428);
        const ok = await op.req('POST', `/api/v1/databases/${db}/ops`, { ...body, confirmation: { token: c.json.error.confirmation.token } });
        expect(ok.status, JSON.stringify(ok.json)).toBe(200);
        expect(ok.json.result).toEqual({ t: 'int', v: '3' });
      });

      it('a command timeout destroys only its exclusive socket; requests and metrics streams recover (review v0.2 M3)', async () => {
        const v = await userSession(t, 'viewer');
        const metrics = await openSse(await base(), `/api/v1/databases/${db}/metrics/stream`, v.cookie);
        try {
          await metrics.waitFor((e) => e.event === 'message');
          const viewer = await t.ctx.redis.conn(db, 'viewer');
          const operator = await t.ctx.redis.conn(db, 'operator');
          // XREAD BLOCK 0 never answers (sent directly, without the console's block cap). Its exclusive capped
          // socket is destroyed, leaving this tier and the metrics connection available.
          const key = `${P}never`;
          await expect(viewer.send(['XREAD', 'BLOCK', '0', 'STREAMS', key, '$'], { key, readonly: true, timeout: 200 })).rejects.toBeInstanceOf(TimeoutError);
          expect(await t.ctx.redis.conn(db, 'viewer')).toBe(viewer);
          expect(await t.ctx.redis.conn(db, 'operator')).toBe(operator);
          const r = await v.req('POST', `/api/v1/databases/${db}/cli`, { line: 'PING' });
          expect(r.status, JSON.stringify(r.json)).toBe(200);
          const after = metrics.events.length;
          await metrics.waitFor((e) => e.event === 'message' && metrics.events.indexOf(e) >= after, 6000);
        } finally {
          metrics.close();
        }
      });

      it('caps oversized replies while reading them (the command is routed by key)', async () => {
        const op = await userSession(t, 'operator');
        // 17 MB string from a tiny request (SETRANGE zero-pads); over 16 x maxReplyBytes (1 MiB).
        expect((await op.req('POST', `/api/v1/databases/${db}/cli`, { argv: ['SETRANGE', `${P}huge`, '17000000', 'x'] })).status).toBe(200);
        const big = await op.req('POST', `/api/v1/databases/${db}/cli`, { argv: ['GET', `${P}huge`] });
        expect(big.status).toBe(413);
        const part = await op.req('POST', `/api/v1/databases/${db}/cli`, { argv: ['GETRANGE', `${P}huge`, '16999999', '17000000'] });
        expect(part.status).toBe(200);
        expect(part.json.reply).toEqual({ t: 'str', v: { enc: 'utf8', data: '\0x' } });
        const r = await op.req('POST', `/api/v1/databases/${db}/cli`, { argv: ['DEL', `${P}huge`] });
        if (r.status === 428) await op.req('POST', `/api/v1/databases/${db}/cli`, { argv: ['DEL', `${P}huge`], confirmation: { token: r.json.error.confirmation.token } });
      });

      it('checked edits run WATCH + MULTI/EXEC on the node of the key: same value writes, a change or a type change gets 409 (web review v0.2 r3)', async () => {
        const pw = process.env.RC_TOPO_PASSWORD!;
        // Fixtures and concurrent writers go through a direct client (as another application would).
        const direct = db === 'cl'
          ? createCluster({ rootNodes: [{ url: 'redis://127.0.0.1:6420' }], defaults: { username: 'rc-admin', password: pw } })
          : createClient({ url: 'redis://127.0.0.1:6426', username: 'rc-admin', password: pw });
        direct.on('error', () => {});
        await direct.connect();
        const C = `rcsrv:topo-cas:${db}:${Date.now()}:`;
        const op = await userSession(t, 'operator');
        const ops = (body: Record<string, unknown>) => op.req('POST', `/api/v1/databases/${db}/ops`, body);
        try {
          // Three keys in each third of the slot space, so every primary of the cluster runs exchanges (and the
          // per-user ops rate limit is not the subject here).
          const keys: string[] = [];
          for (let i = 0, per = [0, 0, 0]; keys.length < 9; i++) {
            const third = Math.min(2, Math.floor(hashSlot(`${C}cas${i}`) / 5462));
            if (per[third]! < 3) { per[third]!++; keys.push(`${C}cas${i}`); }
          }
          for (const [i, key] of keys.entries()) {
            await direct.set(key, `v${i}`);
            const ok = await ops({ op: 'string.set', key: utf8(key), value: utf8(`w${i}`), keepTtl: true, expect: { type: 'string', sha256: sha(`v${i}`) } });
            expect(ok.status, JSON.stringify(ok.json)).toBe(200);
            expect(await direct.get(key)).toBe(`w${i}`);
            await direct.set(key, `theirs${i}`);
            const late = await ops({ op: 'string.set', key: utf8(key), value: utf8('mine'), expect: { type: 'string', sha256: sha(`w${i}`) } });
            expect(late.status, JSON.stringify(late.json)).toBe(409);
            expect(late.json.error.conflict.current.value).toEqual(utf8(`theirs${i}`));
            expect(await direct.get(key)).toBe(`theirs${i}`);
          }
          const key = `${C}cas-type`;
          await direct.hSet(key, 'sensitive', 'KEEP-ME');
          const typed = await ops({ op: 'string.set', key: utf8(key), value: utf8('EDITED'), expect: { type: 'string', sha256: sha('ORIGINAL') } });
          expect(typed.status).toBe(409);
          expect(typed.json.error.conflict).toMatchObject({ reason: 'type', current: { type: 'hash' } });
          expect(await direct.type(key)).toBe('hash');
          expect(await direct.hGet(key, 'sensitive')).toBe('KEEP-ME');
          const field = await ops({ op: 'hash.set', key: utf8(key), entries: [{ field: utf8('sensitive'), value: utf8('NEW') }], expect: { type: 'hash', sha256: sha('KEEP-ME') } });
          expect(field.status, JSON.stringify(field.json)).toBe(200);
          expect(await direct.hGet(key, 'sensitive')).toBe('NEW');
        } finally {
          for (let i = 0; i < 200; i++) await direct.del(`${C}cas${i}`);
          await direct.del(`${C}cas-type`);
          await direct.close();
        }
      });

      it('overview, slowlog and memory analysis work', async () => {
        const v = await userSession(t, 'viewer');
        const o = await v.req('GET', `/api/v1/databases/${db}/overview`);
        expect(o.status).toBe(200);
        expect(o.json.keyspace.reduce((a: number, k: { keys: number }) => a + k.keys, 0)).toBeGreaterThanOrEqual(27);
        const sl = await v.req('GET', `/api/v1/databases/${db}/slowlog`);
        expect(sl.status, JSON.stringify(sl.json)).toBe(200);
        const a = await v.req('POST', `/api/v1/databases/${db}/analysis`, { sampleSize: 100, match: `${P}*` });
        expect(a.status, JSON.stringify(a.json)).toBe(200);
        expect(a.json.sampled).toBe(27);
      });

      it('fixed-size and console writes check the actor right before they are sent (review v0.2 N1)', async () => {
        const conn = await t.ctx.redis.conn(db, 'operator');
        const key = `${P}n1-guard`;
        expect(await conn.send(['SET', key, 'opened'], { key, capped: true })).toBe('OK');
        try {
          await expect(conn.send(['DEL', key], { key, stillAllowed: () => false })).rejects.toMatchObject({ code: 'unauthenticated' });
          await expect(conn.send(['SET', key, 'after'], { key, capped: true, stillAllowed: () => false })).rejects.toMatchObject({ code: 'unauthenticated' });
          expect(String(await conn.send(['GET', key], { key }))).toBe('opened');
          expect(await conn.send(['EXPIRE', key, '100'], { key, stillAllowed: () => true })).toBe(1);
        } finally {
          await conn.send(['DEL', key], { key });
        }
      });

      // Review v0.2 N1 follow-up: before the fix, these went to node-redis's pipelined client, checked when queued and
      // written on a later turn of the event loop (the reviewer's harness: a revocation queued from inside a passing
      // check landed before the write). Now they use the measured sockets, which check and write in one step.
      it('actor-checked fixed-size commands: the check and the write are one synchronous step (review v0.2 N1 follow-up)', async () => {
        const conn = await t.ctx.redis.conn(db, 'operator');
        const key = `${P}n1b-key`, hash = `${P}n1b-hash`;
        expect(await conn.send(['SET', key, 'opened'], { key, capped: true })).toBe('OK');
        await conn.send(['EXISTS', key], { key }); // node-redis knows the slot map, as in normal use
        const [node] = await conn.primaries(); // cluster: a per-primary target (key browser DBSIZE)
        const cases: [Target, Arg[], string][] = [
          [conn, ['EXPIRE', key, '100'], key], [conn, ['HSET', hash, 'f', 'v'], hash], [node!, ['DBSIZE'], 'DBSIZE'], [conn, ['UNLINK', key], key],
        ];
        try {
          for (const [target, argv, marker] of cases) {
            const events: string[] = [];
            let revoked = false;
            const stop = onSocketWrite(DATA_PORTS, marker, () => events.push(revoked ? 'write after revocation' : 'write'));
            try {
              await target.send(argv, {
                key: argv[1],
                stillAllowed: () => {
                  if (!revoked) queueMicrotask(() => { revoked = true; events.push('revoked'); });
                  return !revoked;
                },
              });
            } finally {
              stop();
            }
            expect(events, argv.join(' ')).toEqual(['write', 'revoked']);
          }
        } finally {
          for (const k of [key, hash]) await conn.send(['DEL', k], { key: k });
        }
      });

      it('actor-checked fixed-size commands: a revocation right after they were handed over refuses them; nothing is written (review v0.2 N1 follow-up)', async () => {
        const conn = await t.ctx.redis.conn(db, 'operator');
        const key = `${P}n1c-key`, hash = `${P}n1c-hash`;
        expect(await conn.send(['SET', key, 'opened'], { key, capped: true })).toBe('OK');
        await conn.send(['HSET', hash, 'f', 'opened'], { key: hash, capped: true });
        try {
          for (const argv of [['EXPIRE', key, '100'], ['HSET', hash, 'f', 'after'], ['UNLINK', key], ['DEL', hash]]) {
            let allowed = true;
            const sent = conn.send(argv, { key: argv[1], stillAllowed: () => allowed });
            allowed = false; // before any later turn of the event loop
            await expect(sent, argv.join(' ')).rejects.toMatchObject({ code: 'unauthenticated' });
          }
          expect(await conn.send(['TTL', key], { key })).toBe(-1);
          expect(String(await conn.send(['GET', key], { key }))).toBe('opened');
          expect(String(await conn.send(['HGET', hash, 'f'], { key: hash }))).toBe('opened');
        } finally {
          for (const k of [key, hash]) await conn.send(['DEL', k], { key: k });
        }
      });

      it('per-key deletes run on the measured sockets in bounded batches: a 200-key typed delete and a 600-key bulk delete remove every key (review v0.2 N1 follow-up)', async () => {
        const op = await userSession(t, 'operator');
        const conn = await t.ctx.redis.conn(db, 'operator');
        const F = `${P}fan:`;
        const keys = Array.from({ length: 800 }, (_, i) => `${F}${i}`);
        for (const key of keys) await conn.send(['SET', key, 'v'], { key, capped: true });
        const typed = { op: 'key.delete', keys: keys.slice(0, 200).map(utf8) };
        const c = await op.req('POST', `/api/v1/databases/${db}/ops`, typed);
        expect(c.status, JSON.stringify(c.json)).toBe(428);
        const del = await op.req('POST', `/api/v1/databases/${db}/ops`, { ...typed, confirmation: { token: c.json.error.confirmation.token } });
        expect(del.status, JSON.stringify(del.json)).toBe(200);
        expect(del.json.result).toEqual({ t: 'int', v: '200' });
        const b = await op.req('POST', `/api/v1/databases/${db}/bulk-delete`, { match: `${F}*` });
        expect(b.status, JSON.stringify(b.json)).toBe(428);
        const ch = b.json.error.confirmation;
        const bulk = await op.req('POST', `/api/v1/databases/${db}/bulk-delete`, { match: `${F}*`, confirmation: { token: ch.token, ...(ch.level === 'typed' ? { typed: ch.expectedText } : {}) } });
        expect(bulk.status, JSON.stringify(bulk.json)).toBe(200);
        expect(bulk.json).toEqual({ deleted: 600, scanned: 600 });
        const left = await Promise.all(keys.map((key) => conn.send(['EXISTS', key], { key })));
        expect(left.reduce<number>((a, x) => a + Number(x), 0)).toBe(0);
      });
    });
  }

  // Review v0.2 r4 L1: redirects are followed only within the known topology, and a MOVED after a reshard refreshes
  // the slot map, so later commands go straight to the new owner instead of reconnecting to the old one every time.
  it('cl: after a reshard, a MOVED refreshes the slot map; the old owner is not contacted per command', async () => {
    const pw = process.env.RC_TOPO_PASSWORD!;
    const nodes = await Promise.all([6420, 6421, 6422].map(async (port) => {
      const c = createClient({ url: `redis://127.0.0.1:${port}`, username: 'rc-admin', password: pw });
      c.on('error', () => {});
      await c.connect();
      return { port, c, id: String(await c.sendCommand(['CLUSTER', 'MYID'])) };
    }));
    const owner = async (slot: number) => {
      const ranges = (await nodes[0]!.c.sendCommand(['CLUSTER', 'SLOTS'])) as [number, number, [string, number, string]][];
      const r = ranges.find(([from, to]) => slot >= Number(from) && slot <= Number(to))!;
      return nodes.find((n) => n.port === Number(r[2][1]))!;
    };
    // An empty slot of a hash tag no other key of this run uses.
    let tag = '', slot = 0;
    for (let i = 0; ; i++) {
      tag = `{r4-moved-${Date.now()}-${i}}`;
      slot = hashSlot(tag);
      if (Number(await (await owner(slot)).c.sendCommand(['CLUSTER', 'COUNTKEYSINSLOT', String(slot)])) === 0) break;
    }
    const move = async (from: (typeof nodes)[number], to: (typeof nodes)[number]) => {
      await to.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'IMPORTING', from.id]);
      await from.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'MIGRATING', to.id]);
      for (const n of [to, from, ...nodes.filter((x) => x !== to && x !== from)]) await n.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'NODE', to.id]);
    };
    const src = await owner(slot);
    const dst = nodes.find((n) => n !== src)!;
    const key = `${P}${tag}moved`;
    const v = await userSession(t, 'viewer');
    const op = await userSession(t, 'operator');
    const cli = (c: typeof v, argv: string[]) => c.req('POST', '/api/v1/databases/cl/cli', { argv });
    // Both tiers learn the current map (the slot is still on src).
    expect((await cli(op, ['GET', key])).status).toBe(200);
    expect((await cli(v, ['GET', key])).status).toBe(200);
    await move(src, dst);
    try {
      expect((await cli(op, ['SET', key, 'moved'])).status).toBe(200);
      expect(await dst.c.get(key)).toBe('moved');
      const connections = async () => Number(/total_connections_received:(\d+)/.exec(String(await src.c.sendCommand(['INFO', 'stats'])))![1]);
      const before = await connections();
      for (let i = 0; i < 10; i++) {
        const g = await cli(v, ['GET', key]);
        expect(g.json.reply).toEqual({ t: 'str', v: utf8('moved') });
      }
      // Before the fix every GET opened a new authenticated connection to src (+10); now at most the first redirect
      // and node-redis's rediscovery touch it.
      expect((await connections()) - before).toBeLessThan(5);
    } finally {
      await dst.c.del(key);
      await move(dst, src);
      for (const n of nodes) await n.c.close();
    }
  });

  // v0.2.1: a metadata batch whose slot map is stale gets MOVED replies; the map is refreshed once and those keys go
  // out again as one batch per node of the new map.
  it('cl: key metadata after a reshard: MOVED replies are re-sent as a batch to the new owner', async () => {
    const pw = process.env.RC_TOPO_PASSWORD!;
    const nodes = await Promise.all([6420, 6421, 6422].map(async (port) => {
      const c = createClient({ url: `redis://127.0.0.1:${port}`, username: 'rc-admin', password: pw });
      c.on('error', () => {});
      await c.connect();
      return { port, c, id: String(await c.sendCommand(['CLUSTER', 'MYID'])) };
    }));
    const owner = async (slot: number) => {
      const ranges = (await nodes[0]!.c.sendCommand(['CLUSTER', 'SLOTS'])) as [number, number, [string, number, string]][];
      const r = ranges.find(([from, to]) => slot >= Number(from) && slot <= Number(to))!;
      return nodes.find((n) => n.port === Number(r[2][1]))!;
    };
    let tag = '', slot = 0;
    for (let i = 0; ; i++) {
      tag = `{kb-meta-moved-${Date.now()}-${i}}`;
      slot = hashSlot(tag);
      if (Number(await (await owner(slot)).c.sendCommand(['CLUSTER', 'COUNTKEYSINSLOT', String(slot)])) === 0) break;
    }
    const move = async (from: (typeof nodes)[number], to: (typeof nodes)[number]) => {
      await to.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'IMPORTING', from.id]);
      await from.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'MIGRATING', to.id]);
      for (const n of [to, from, ...nodes.filter((x) => x !== to && x !== from)]) await n.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'NODE', to.id]);
    };
    const src = await owner(slot);
    const dst = nodes.find((n) => n !== src)!;
    const keys = [`${P}${tag}a`, `${P}${tag}b`];
    const v = await userSession(t, 'viewer');
    const meta = () => v.req('POST', '/api/v1/databases/cl/keys/meta', { keys: [...keys.map(utf8), utf8(`${P}k9`)] });
    // The viewer tier learns the current map (the slot is still on src).
    expect((await meta()).status).toBe(200);
    await move(src, dst);
    try {
      for (const k of keys) await dst.c.hSet(k, 'f', 'v');
      const r = await meta();
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json.keys.map((k: { type: string }) => k.type)).toEqual(['hash', 'hash', 'string']);
      expect(r.json.keys[0].size).toBeGreaterThan(0);
    } finally {
      for (const k of keys) await dst.c.del(k);
      await move(dst, src);
      for (const n of nodes) await n.c.close();
    }
  });

  // Review v0.2 N1: a redirected re-dispatch checks the actor again, for fixed-size and console writes (both measured
  // since the N1 follow-up).
  it('cl: a MOVED re-dispatch checks the actor again for fixed-size and console writes; nothing is written', async () => {
    const pw = process.env.RC_TOPO_PASSWORD!;
    const nodes = await Promise.all([6420, 6421, 6422].map(async (port) => {
      const c = createClient({ url: `redis://127.0.0.1:${port}`, username: 'rc-admin', password: pw });
      c.on('error', () => {});
      await c.connect();
      return { port, c, id: String(await c.sendCommand(['CLUSTER', 'MYID'])) };
    }));
    const owner = async (slot: number) => {
      const ranges = (await nodes[0]!.c.sendCommand(['CLUSTER', 'SLOTS'])) as [number, number, [string, number, string]][];
      const r = ranges.find(([from, to]) => slot >= Number(from) && slot <= Number(to))!;
      return nodes.find((n) => n.port === Number(r[2][1]))!;
    };
    let tag = '', slot = 0;
    for (let i = 0; ; i++) {
      tag = `{n1-moved-${Date.now()}-${i}}`;
      slot = hashSlot(tag);
      if (Number(await (await owner(slot)).c.sendCommand(['CLUSTER', 'COUNTKEYSINSLOT', String(slot)])) === 0) break;
    }
    const move = async (from: (typeof nodes)[number], to: (typeof nodes)[number]) => {
      await to.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'IMPORTING', from.id]);
      await from.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'MIGRATING', to.id]);
      for (const n of [to, from, ...nodes.filter((x) => x !== to && x !== from)]) await n.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'NODE', to.id]);
    };
    const src = await owner(slot);
    const dst = nodes.find((n) => n !== src)!;
    const key = `${P}${tag}n1`;
    const conn = await t.ctx.redis.conn('cl', 'operator');
    // node-redis and the measured path know the current map (the slot is on src).
    await conn.send(['EXISTS', key], { key });
    await conn.send(['GET', key], { key, capped: true });
    let at = src;
    try {
      await move(src, dst);
      at = dst;
      await dst.c.set(key, 'opened');
      // A fixed-size DEL goes to src (stale map), MOVED, the map is refreshed, then the re-dispatch to dst is refused.
      let checks = 0;
      await expect(conn.send(['DEL', key], { key, stillAllowed: () => ++checks === 1 })).rejects.toMatchObject({ code: 'unauthenticated' });
      expect(checks).toBe(2);
      expect(await dst.c.get(key)).toBe('opened');
      // The map now says dst; the slot moves back: the measured SET goes to dst, MOVED, the re-dispatch to src is refused.
      await dst.c.del(key);
      await move(dst, src);
      at = src;
      await src.c.set(key, 'opened');
      checks = 0;
      await expect(conn.send(['SET', key, 'after'], { key, capped: true, stillAllowed: () => ++checks === 1 })).rejects.toMatchObject({ code: 'unauthenticated' });
      expect(checks).toBe(2);
      expect(await src.c.get(key)).toBe('opened');
      // Allowed commands still follow the redirect.
      expect(await conn.send(['SET', key, 'after'], { key, capped: true, stillAllowed: () => true })).toBe('OK');
    } finally {
      await at.c.del(key);
      if (at !== src) await move(at, src);
      for (const n of nodes) await n.c.close();
    }
  });
});

describe.skipIf(!topoUp)('cluster: checked edits across a reshard and a migration (web review v0.2 r3)', () => {
  let t: TestApp;
  const P = `rcsrv:topo-cas:${Date.now()}:`;
  beforeAll(async () => {
    const raw = testConfigRaw();
    raw.databases = [{ id: 'cl', name: 'Cluster', environment: 'test', mode: 'cluster', nodes: ['redis://127.0.0.1:6420', 'redis://127.0.0.1:6421', 'redis://127.0.0.1:6422'], credentials: creds }];
    t = await startApp(resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } }));
  });
  afterAll(async () => { await t?.close(); });

  it('a stale slot map: WATCH gets MOVED and the exchange restarts once on the new owner; ASK (migrating) is refused, nothing written', async () => {
    const pw = process.env.RC_TOPO_PASSWORD!;
    const nodes = await Promise.all([6420, 6421, 6422].map(async (port) => {
      const c = createClient({ url: `redis://127.0.0.1:${port}`, username: 'rc-admin', password: pw });
      c.on('error', () => {});
      await c.connect();
      return { port, c, id: String(await c.sendCommand(['CLUSTER', 'MYID'])) };
    }));
    const owner = async (slot: number) => {
      const ranges = (await nodes[0]!.c.sendCommand(['CLUSTER', 'SLOTS'])) as [number, number, [string, number, string]][];
      const r = ranges.find(([from, to]) => slot >= Number(from) && slot <= Number(to))!;
      return nodes.find((n) => n.port === Number(r[2][1]))!;
    };
    let tag = '', slot = 0;
    for (let i = 0; ; i++) {
      tag = `{w3-cas-${Date.now()}-${i}}`;
      slot = hashSlot(tag);
      if (Number(await (await owner(slot)).c.sendCommand(['CLUSTER', 'COUNTKEYSINSLOT', String(slot)])) === 0) break;
    }
    const move = async (from: (typeof nodes)[number], to: (typeof nodes)[number]) => {
      await to.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'IMPORTING', from.id]);
      await from.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'MIGRATING', to.id]);
      for (const n of [to, from, ...nodes.filter((x) => x !== to && x !== from)]) await n.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'NODE', to.id]);
    };
    const src = await owner(slot);
    const dst = nodes.find((n) => n !== src)!;
    const key = `${P}${tag}moved`;
    const absent = `${P}${tag}absent`;
    const op = await userSession(t, 'operator');
    const ops = (body: Record<string, unknown>) => op.req('POST', '/api/v1/databases/cl/ops', body);
    // The operator tier learns the current map (the slot is still on src).
    expect((await op.req('POST', '/api/v1/databases/cl/cli', { argv: ['GET', key] })).status).toBe(200);
    await move(src, dst);
    try {
      await dst.c.set(key, 'opened');
      const res = await ops({ op: 'string.set', key: utf8(key), value: utf8('mine'), expect: { type: 'string', sha256: sha('opened') } });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(await dst.c.get(key)).toBe('mine');
      const stale = await ops({ op: 'string.set', key: utf8(key), value: utf8('again'), expect: { type: 'string', sha256: sha('opened') } });
      expect(stale.status).toBe(409);
      expect(await dst.c.get(key)).toBe('mine');
      // Migrating dst -> src: a key that is not on dst gets ASK. The exchange never spans two nodes: 503, no write.
      await src.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'IMPORTING', dst.id]);
      await dst.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'MIGRATING', src.id]);
      const ask = await ops({ op: 'string.set', key: utf8(absent), value: utf8('x'), expect: { type: 'none' } });
      expect(ask.status, JSON.stringify(ask.json)).toBe(503);
      expect(ask.json.error.message).toMatch(/being migrated; nothing was written/);
      for (const n of nodes) expect(Number(await n.c.sendCommand(['CLUSTER', 'COUNTKEYSINSLOT', String(slot)]))).toBe(n === dst ? 1 : 0);
    } finally {
      for (const n of [src, dst]) await n.c.sendCommand(['CLUSTER', 'SETSLOT', String(slot), 'STABLE']);
      await dst.c.del(key);
      await move(dst, src);
      for (const n of nodes) await n.c.close();
    }
  });
});

const TLS_DIR = process.env.RC_TOPO_TLS_DIR ?? '/tmp/rc-topo-tls';
const tlsUp = !!process.env.RC_TOPO_PASSWORD && (await portOpen(6428));

describe.skipIf(!tlsUp)('TLS (rediss://, CA + client certificate)', () => {
  let t: TestApp;
  const P = `rcsrv:tls:${Date.now()}:`;
  const tls = (over: Record<string, unknown> = {}) => ({
    ca: { file: `${TLS_DIR}/ca.crt` }, cert: { file: `${TLS_DIR}/client.crt` }, key: { file: `${TLS_DIR}/client.key` }, servername: 'localhost', ...over,
  });

  beforeAll(async () => {
    const raw = testConfigRaw();
    raw.databases = [
      { id: 'tls', name: 'TLS', environment: 'test', url: 'rediss://localhost:6428', tls: tls(), credentials: creds },
      // No client certificate: the server requires one (tls-auth-clients yes).
      { id: 'tls-nocert', name: 'TLS without client cert', environment: 'test', url: 'rediss://localhost:6428', tls: { ca: { file: `${TLS_DIR}/ca.crt` } }, credentials: creds },
      // Wrong trust anchor: the server certificate must not verify.
      { id: 'tls-wrongca', name: 'TLS wrong CA', environment: 'test', url: 'rediss://localhost:6428', tls: tls({ ca: { file: `${TLS_DIR}/client.crt` } }), credentials: creds },
    ];
    t = await startApp(resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } }));
  });
  afterAll(async () => {
    if (!t) return;
    const op = await userSession(t, 'operator');
    const r = await op.req('POST', '/api/v1/databases/tls/ops', { op: 'key.delete', keys: [utf8(`${P}a`)] });
    if (r.status === 428) await op.req('POST', '/api/v1/databases/tls/ops', { op: 'key.delete', keys: [utf8(`${P}a`)], confirmation: { token: r.json.error.confirmation.token } });
    await t.close();
  });

  it('connects with mutual TLS and runs commands as the tier user', async () => {
    const op = await userSession(t, 'operator');
    const info = await op.req('POST', '/api/v1/databases/tls/cli', { line: 'CLIENT INFO' });
    expect(info.status, JSON.stringify(info.json)).toBe(200);
    expect(info.json.reply.v.data).toContain('user=rc-operator');
    expect((await op.req('POST', '/api/v1/databases/tls/cli', { argv: ['SET', `${P}a`, 'secure'] })).status).toBe(200);
    const g = await op.req('POST', '/api/v1/databases/tls/cli', { argv: ['GET', `${P}a`] });
    expect(g.json.reply).toEqual({ t: 'str', v: utf8('secure') });
  });

  it('fails closed without a client certificate or with the wrong CA', async () => {
    const v = await userSession(t, 'viewer');
    for (const db of ['tls-nocert', 'tls-wrongca']) {
      const r = await v.req('POST', `/api/v1/databases/${db}/cli`, { line: 'PING' });
      expect(r.status, `${db}: ${JSON.stringify(r.json)}`).toBe(503);
      expect(r.json.error.code).toBe('unavailable');
    }
    const list = await v.req('GET', '/api/v1/databases');
    const byId = Object.fromEntries(list.json.databases.map((d: { id: string; status: string }) => [d.id, d.status]));
    expect(byId).toMatchObject({ tls: 'connected', 'tls-nocert': 'error', 'tls-wrongca': 'error' });
  });
});
