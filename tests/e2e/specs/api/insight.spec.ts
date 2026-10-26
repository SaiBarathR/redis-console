/**
 * v0.2.1 insight API (F4/F7/F8/F10) against the built server: read-only and prod rules for index creation and
 * imports, analysis jobs on the read-only remote, search query options, and that nothing Redis-derived goes into
 * a URL (jobs are addressed by opaque ids only).
 */
import { test, expect } from '@playwright/test';
import { Api, dbPath } from '../../lib/api.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';

const E = (s: string) => dbPath(DB.e2e, s);
const R = (s: string) => dbPath(DB.remote, s);
const P = (s: string) => dbPath(DB.prodSim, s);

async function until<T>(fn: () => Promise<T>, done: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.describe('insight API', () => {
  let viewer: Api;
  let op: Api;
  let admin: Api;
  test.beforeAll(async () => {
    viewer = await Api.fromStorage('viewer');
    op = await Api.fromStorage('operator');
    admin = await Api.fromStorage('admin');
  });
  test.afterAll(async () => {
    for (const a of [viewer, op, admin]) await a.dispose();
  });

  test('remote-6390 (read-only, viewer cap): analysis jobs run; index creation and imports are refused', async () => {
    const start = await admin.post(R('analysis/jobs'), { match: '*', sampleSize: 200 });
    expect(start.status, start.text).toBe(200);
    expect(start.json.id).toMatch(/^[0-9a-f]{24}$/);
    const done = await until(() => admin.get(R(`analysis/jobs/${start.json.id}`)), (r) => r.json?.state !== 'running');
    expect(done.json.state).toBe('done');
    expect(done.json.report.coverage.sampled).toBe(done.json.report.sampled);
    expect(Array.isArray(done.json.report.recommendations)).toBe(true);
    const create = await admin.post(R('search/index/create'), { index: 'idx:e2e:remote-never', on: 'HASH', prefixes: ['never:'], schema: [{ name: 'f', type: 'TEXT' }] });
    expect(create.status).toBe(403);
    const drop = await admin.post(R('search/index/drop'), { index: 'idx:never' });
    expect(drop.status).toBe(403);
    // The viewer cap makes the admin a viewer here, and imports are operator and above (review v0.2.1 F1).
    const plan = await admin.post(R('import'), { script: 'GET a\nSET a 1\nDEL a' });
    expect(plan.status).toBe(403);
  });

  test('prod-sim: an import with writes needs the typed database name and a reason', async () => {
    const key = `${K.scratchPrefix}insight-prod`;
    try {
      const plan = await admin.post(P('import'), { script: `SET ${key} 1\nEXPIRE ${key} 600` });
      expect(plan.json.confirmation).toBe('typed');
      const first = await admin.post(P(`import/${plan.json.id}/start`), {});
      expect(first.status).toBe(428);
      expect(first.json.error.confirmation).toMatchObject({ level: 'typed', reasonRequired: true });
      const noReason = await admin.post(P(`import/${plan.json.id}/start`), { confirmation: { token: first.json.error.confirmation.token, typed: first.json.error.confirmation.expectedText } });
      expect(noReason.status).toBe(428);
      const ok = await admin.post(P(`import/${plan.json.id}/start`), {
        confirmation: { token: noReason.json.error.confirmation.token, typed: noReason.json.error.confirmation.expectedText, reason: 'e2e prod import' },
      });
      expect(ok.status, ok.text).toBe(200);
      const done = await until(() => admin.get(P(`import/${plan.json.id}`)), (r) => r.json?.state !== 'running');
      expect(done.json).toMatchObject({ state: 'done', succeeded: 2 });
      expect(String(await redisExec(['GET', key], 1))).toBe('1');
    } finally {
      await redisExec(['DEL', key], 1).catch(() => undefined);
    }
  });

  test('another session cannot read, start or cancel a job', async () => {
    const plan = await op.post(E('import'), { script: `SET ${K.scratchPrefix}insight-other 1` });
    // A viewer may not use imports at all (403); another operator-or-above session cannot see this one (404).
    for (const [api, status] of [[viewer, 403], [admin, 404]] as const) {
      expect((await api.get(E(`import/${plan.json.id}`))).status).toBe(status);
      expect((await api.post(E(`import/${plan.json.id}/start`), {})).status).toBe(status);
      expect((await api.post(E(`import/${plan.json.id}/cancel`), {})).status).toBe(status);
    }
    expect((await op.post(E(`import/${plan.json.id}/cancel`), {})).json.state).toBe('cancelled');
  });

  test('search query options and exact document ids', async () => {
    const r = await viewer.post(E('search/query'), { index: K.searchIndex, query: '@category:{toys}', sortBy: 'price', sortOrder: 'DESC', returnFields: ['title', 'price'], limit: 3 });
    expect(r.status, r.text).toBe(200);
    const prices = r.json.docs.map((d: { fields: { price: string } }) => Number(d.fields.price));
    expect(prices).toEqual([...prices].sort((a: number, b: number) => b - a));
    for (const d of r.json.docs) {
      expect(Object.keys(d.fields).sort()).toEqual(['price', 'title']);
      expect(d.key).toEqual({ enc: 'utf8', data: d.id });
    }
    const detail = await viewer.post(E('search/index/info'), { index: K.searchIndex });
    expect(detail.status).toBe(200);
    expect(detail.json.fields.map((f: { attribute: string }) => f.attribute)).toEqual(['title', 'price', 'category']);
  });

  test('the console refuses FT.DROPINDEX … DD and gives FT.DROPINDEX to admins only', async () => {
    const dd = await admin.post(E('cli'), { line: `FT.DROPINDEX ${K.searchIndex} DD` });
    expect(dd.status).toBe(403);
    expect(dd.json.error.code).toBe('command_blocked');
    const opDrop = await op.post(E('cli'), { line: `FT.DROPINDEX ${K.searchIndex}` });
    expect(opDrop.status).toBe(403);
    const adminDrop = await admin.post(E('cli'), { line: `FT.DROPINDEX ${K.searchIndex}` });
    expect(adminDrop.status).toBe(428);
    expect(adminDrop.json.error.confirmation.level).toBe('typed');
  });
});
