/**
 * v0.2.1 server review (`docs/research/23-v021-server-review.md`, Claude reviewer): F1–F4. Each test failed
 * before its fix. Writes go to the 6411 sandbox under a per-run prefix.
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesFromBin } from '@rconsole/shared';
import { resolveConfig } from '../../src/config.ts';
import { cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, testConfigRaw, userSession, utf8, type Client, type TestApp } from '../helpers.ts';
import { confirmed } from './data-helpers.ts';

const DB = '/api/v1/databases/e2e';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T>, done: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (done(v) || Date.now() > end) return v;
    await sleep(150); // status polls are rate limited (10/s)
  }
}

/** A heavy import line: 190 tokens (the reviewer's `HSET rs1:x a a … a`). */
const heavyScript = (prefix: string) => Array.from({ length: 10_000 }, () => `HSET ${prefix}heavy ${Array.from({ length: 188 }, () => 'a').join(' ')}`).join('\n');

describe.skipIf(!sandboxUp)('review v0.2.1 server (Claude reviewer)', () => {
  let t: TestApp;
  let r: Awaited<ReturnType<typeof sandboxAdmin>>;
  const P = keyPrefix('v021s');

  beforeAll(async () => {
    const raw = testConfigRaw();
    // The smallest workbench budget, so the F4 test does not wait 30 s.
    (raw.policy as Record<string, unknown>).workbenchBudgetMs = 1000;
    (raw.server as Record<string, unknown>).dataDir = mkdtempSync(path.join(tmpdir(), 'rconsole-test-'));
    t = await startApp(resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } }));
    r = await sandboxAdmin();
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  /** Plan, retrying the per-user plan rate limit (2/s, burst 6), which is for people. */
  const plan = async (c: Client, script: string, db = DB) => {
    for (;;) {
      const res = await c.req('POST', `${db}/import`, { script });
      if (res.status !== 429 || !/slow down/.test(res.json.error.message)) return res;
      await sleep(250);
    }
  };

  describe('F1: import planning', () => {
    it('imports are an operator feature: a viewer cannot plan, start, read or cancel one', async () => {
      const v = await userSession(t, 'viewer');
      const res = await v.req('POST', `${DB}/import`, { script: `GET ${P}a` });
      expect(res.status, res.body).toBe(403);
      expect(res.json.error.message).toMatch(/operator role/);
      const id = '0123456789abcdef01234567';
      expect((await v.req('POST', `${DB}/import/${id}/start`, {})).status).toBe(403);
      expect((await v.req('GET', `${DB}/import/${id}`)).status).toBe(403);
      expect((await v.req('POST', `${DB}/import/${id}/cancel`, {})).status).toBe(403);
      const op = await userSession(t, 'operator');
      expect((await op.req('POST', `${DB}/import`, { script: `GET ${P}a` })).status).toBe(200);
    });

    it('one account holds at most two plans or runs, so it cannot lock imports for everyone', async () => {
      const name = `op-many-${Date.now()}`;
      const sessions: Client[] = [];
      for (let i = 0; i < 16; i++) sessions.push(await userSession(t, 'operator', name));
      const ids: string[] = [];
      for (const s of sessions) {
        const res = await plan(s, `GET ${P}a`);
        expect(res.status, res.body).toBe(200);
        ids.push(res.json.id);
      }
      // The account's oldest plans gave way to its newer ones; the two newest are still there.
      expect((await sessions[0]!.req('GET', `${DB}/import/${ids[0]}`)).status).toBe(404);
      expect((await sessions[14]!.req('GET', `${DB}/import/${ids[14]}`)).json.state).toBe('planned');
      expect((await sessions[15]!.req('GET', `${DB}/import/${ids[15]}`)).json.state).toBe('planned');
      const other = await userSession(t, 'operator');
      const res = await plan(other, `SET ${P}other 1`);
      expect(res.status, res.body).toBe(200);
    });

    it('planning 10,000 heavy lines yields to the event loop', async () => {
      const op = await userSession(t, 'operator');
      const script = heavyScript(P);
      let last = performance.now(), worst = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
      }, 2);
      try {
        const res = await plan(op, script);
        expect(res.status, res.body.slice(0, 300)).toBe(200);
        expect(res.json.counts.write).toBe(10_000);
        // The response can resolve before the next timer callback: let it measure the last gap too.
        await sleep(20);
      } finally {
        clearInterval(timer);
      }
      // One synchronous pass over the file stalled every other request for ~0.7 s; chunks take a few milliseconds.
      expect(worst).toBeLessThan(250);
    });

    it('a held plan keeps about the script, not per-line objects', async () => {
      setFlagsFromString('--expose-gc');
      const gc = runInNewContext('gc') as () => void;
      const heap = () => {
        gc();
        gc();
        return process.memoryUsage().heapUsed;
      };
      const users = await Promise.all([1, 2, 3].map(() => userSession(t, 'operator')));
      const script = heavyScript(`${P}mem:`);
      const before = heap();
      for (const u of users) expect((await plan(u, script)).status).toBe(200);
      const held = heap() - before;
      // Before the fix, three operator plans of this 3.9 MB file held ~860 MiB (every line's argv, redacted audit argv and
      // confirmation preview); now each holds the file's text and one small record per line (~19 MiB for the three).
      expect(held / 2 ** 20).toBeLessThan(40);
    });
  });

  describe('F2: analysis job slots', () => {
    /** Start a job, retrying while the caller's or the server's analysis slots are busy, or the start rate limit. */
    const startJob = async (c: Client) => {
      for (;;) {
        const res = await c.req('POST', `${DB}/analysis/jobs`, { match: `${P}none:*`, sampleSize: 100 });
        if (res.status !== 429 || /held/.test(res.json.error.message)) return res;
        // Each attempt takes a token of the start rate limit (1/s, burst 3): wait for one rather than spin.
        await sleep(/slow down/.test(res.json.error.message) ? 500 : 50);
      }
    };

    it('jobs are kept per account (five), and a full table drops finished reports instead of refusing new jobs', async () => {
      const name = `viewer-jobs-${Date.now()}`;
      const sessions: Client[] = [];
      for (let i = 0; i < 3; i++) sessions.push(await userSession(t, 'viewer', name));
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const s = sessions[i % 3]!;
        const res = await startJob(s);
        expect(res.status, res.body).toBe(200);
        ids.push(res.json.id);
        await until(() => s.req('GET', `${DB}/analysis/jobs/${res.json.id}`), (x) => x.json.state !== 'running');
      }
      // Five per account across its sessions: the sixth job dropped the account's oldest finished one.
      expect((await sessions[0]!.req('GET', `${DB}/analysis/jobs/${ids[0]}`)).status).toBe(404);
      expect((await sessions[1]!.req('GET', `${DB}/analysis/jobs/${ids[1]}`)).status).toBe(200);
      // Thirteen more accounts fill the table (64) and beyond: nobody gets 429 for a table of finished reports.
      const others = await Promise.all(Array.from({ length: 13 }, () => userSession(t, 'viewer')));
      const statuses = await Promise.all(others.map(async (o) => {
        const out: number[] = [];
        for (let i = 0; i < 5; i++) out.push((await startJob(o)).status);
        return out;
      }));
      expect(statuses.flat()).toEqual(Array(65).fill(200));
      const late = await userSession(t, 'operator');
      expect((await startJob(late)).status).toBe(200);
    }, 60_000);
  });

  describe('F3: full list element reads', () => {
    it('a list row reference carries the element identity; a concurrent LPUSH gives 409, not another element', async () => {
      const key = `${P}list`;
      await r.rPush(key, ['X'.repeat(70_000), 'secret-B']);
      const v = await userSession(t, 'viewer');
      const page = await v.req('POST', `${DB}/key/read`, { key: utf8(key) });
      expect(page.status, page.body.slice(0, 300)).toBe(200);
      const row = page.json.value.items[0];
      expect(row.truncated).toBe(true);
      expect(row.ref).toMatchObject({ kind: 'list', index: 0, identity: expect.stringMatching(/^[0-9a-f]{64}$/) });
      const full = await v.req('POST', `${DB}/key/element`, { key: utf8(key), ref: row.ref });
      expect(full.status, full.body.slice(0, 300)).toBe(200);
      expect(Buffer.from(bytesFromBin(full.json.value)).toString()).toBe('X'.repeat(70_000));
      await r.lPush(key, 'INSERTED-OTHER');
      const moved = await v.req('POST', `${DB}/key/element`, { key: utf8(key), ref: row.ref });
      expect(moved.status, moved.body.slice(0, 300)).toBe(409);
      expect(moved.json.error.code).toBe('conflict');
      // A reference without the identity is refused (the server never addresses a list row by index alone).
      expect((await v.req('POST', `${DB}/key/element`, { key: utf8(key), ref: { kind: 'list', index: 0 } })).status).toBe(400);
    });
  });

  describe('F4: blocking commands in imports', () => {
    it('share the workbench time budget: later blocking lines are not sent once it is used', async () => {
      const op = await userSession(t, 'operator');
      const p = await plan(op, Array.from({ length: 8 }, () => `BLPOP ${P}nolist 0.4`).join('\n'));
      expect(p.status, p.body).toBe(200);
      expect(p.json.counts).toEqual({ read: 0, write: 8, admin: 0, blocked: 0 });
      const { second } = await confirmed(op, `${DB}/import/${p.json.id}/start`, {});
      expect(second.status, second.body).toBe(200);
      const started = Date.now();
      const done = await until(() => op.req('GET', `${DB}/import/${p.json.id}`), (x) => x.json.state !== 'running');
      expect(done.json.state).toBe('done');
      // workbenchBudgetMs is 1000 here: three 0.4 s waits use it, the other five lines are refused without being sent.
      expect(done.json.succeeded).toBeLessThanOrEqual(3);
      expect(done.json.failures).toEqual([expect.objectContaining({ command: 'BLPOP', code: 'timeout', count: 8 - done.json.succeeded })]);
      expect(Date.now() - started).toBeLessThan(2500);
      const denied = t.ctx.audit.query({ user: op.username, action: 'import.exec', outcome: 'denied', limit: 20 }).events;
      expect(denied).toHaveLength(8 - done.json.succeeded);
    });
  });
});
