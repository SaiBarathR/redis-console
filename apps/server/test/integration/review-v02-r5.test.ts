/** Round 5 compatibility: finite HTTP deadlines preserve SSE and large legitimate imports. */
import http from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { BODY_LIMIT } from '../../src/app.ts';
import { bk, cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, testConfig, userSession } from '../helpers.ts';
import { listen, openPubSub, openSse, sleep, type SseConn } from './auth-helpers.ts';

const P = keyPrefix('r5');
describe.skipIf(!sandboxUp)('review r5: SSE and upload compatibility', () => {
  it('keeps metrics, quiet pub/sub and profiler alive past an idle deadline with heartbeats', async () => {
    const config = testConfig();
    // Shorten only the idle deadline, still above the 5 s heartbeat.
    config.server.connectionTimeoutMs = 6000;
    config.policy.maxInflightCommands = 1;
    const t = await startApp(config);
    const base = await listen(t.app);
    const streams: SseConn[] = [];
    try {
      const viewer = await userSession(t, 'viewer');
      const admin = await userSession(t, 'admin');
      streams.push(await openSse(base, '/api/v1/databases/e2e/metrics/stream', viewer.cookie));
      streams.push(await openPubSub(base, viewer, 'e2e', [P + 'channel']));
      streams.push(await openSse(base, '/api/v1/databases/e2e/profiler/stream?seconds=30', admin.cookie));
      expect(streams.map((s) => s.status)).toEqual([200, 200, 200]);
      await streams[1]!.waitFor((e) => e.event === 'ready');
      await streams[2]!.waitFor((e) => e.event === 'ready');
      await sleep(7500);
      expect(streams.map((s) => s.isEnded())).toEqual([false, false, false]);
      const at = Date.now();
      expect((await admin.req('POST', '/api/v1/databases/e2e/pubsub/publish', { channel: P + 'channel', message: { enc: 'utf8', data: 'after idle deadline' } })).status).toBe(200);
      await streams[0]!.waitFor((e) => e.event === 'message' && e.data.t >= at);
      await streams[1]!.waitFor((e) => e.event === 'message' && e.data.channel === P + 'channel');
      await streams[2]!.waitFor((e) => e.event === 'message' && e.data.argv?.[0]?.toUpperCase() === 'PUBLISH');
      expect((await viewer.req('POST', '/api/v1/databases/e2e/cli', { line: 'PING' })).status).toBe(200);
    } finally { for (const s of streams) s.close(); await t.close(); }
  });

  it('imports a value in a paced request at the existing 12 MiB HTTP body limit', async () => {
    const t = await startApp();
    const base = await listen(t.app);
    const r = await sandboxAdmin();
    try {
      const op = await userSession(t, 'operator');
      const body = { op: 'string.set', key: bk(P + 'import'), value: { enc: 'utf8', data: '' }, ttl: 60 };
      const valueBytes = BODY_LIMIT - Buffer.byteLength(JSON.stringify(body));
      body.value.data = 'x'.repeat(valueBytes);
      const wire = Buffer.from(JSON.stringify(body));
      expect(wire.length).toBe(BODY_LIMIT);
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(base + '/api/v1/databases/e2e/ops', { method: 'POST', headers: {
          origin: 'http://localhost:4100', cookie: op.cookie, 'x-csrf-token': op.csrf,
          'content-type': 'application/json', 'content-length': wire.length,
        } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
        req.on('error', reject);
        void (async () => {
          for (let i = 0; i < wire.length; i += 256 * 1024) {
            if (!req.write(wire.subarray(i, i + 256 * 1024))) await once(req, 'drain');
            await sleep(10);
          }
          req.end();
        })().catch(reject);
      });
      expect(status).toBe(200);
      expect(await r.strLen(P + 'import')).toBe(valueBytes);
      expect(await r.getRange(P + 'import', -16, -1)).toBe('x'.repeat(16));
    } finally { await r.close(); await t.close(); await cleanupPrefix(P); }
  });
});
