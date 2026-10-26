/** Two-step confirmations (428 -> token -> resubmit), prod typed confirmation + reason, bulk delete impact. */
import { test, expect } from '@playwright/test';
import { API, Api, dbPath, utf8 } from '../../lib/api.ts';
import { DB } from '../../lib/env.ts';
import { K, BULK_COUNT, redisExec } from '../../lib/fixtures-data.ts';

const E = (s: string) => dbPath(DB.e2e, s);
const P = (s: string) => dbPath(DB.prodSim, s);

test.describe('confirmation flow', () => {
  let op: Api;
  let admin: Api;
  test.beforeAll(async () => { op = await Api.fromStorage('operator'); admin = await Api.fromStorage('admin'); });
  test.afterAll(async () => { await op.dispose(); await admin.dispose(); });

  test('DEL via CLI: 428 challenge, then single-use token executes exactly that request', async () => {
    const k1 = `${K.scratchPrefix}confirm-1`, k2 = `${K.scratchPrefix}confirm-2`;
    await redisExec(['SET', k1, 'a']);
    await redisExec(['SET', k2, 'b']);
    const first = await op.post(E('cli'), { line: `DEL ${k1}` });
    expect(first.status, first.text).toBe(428);
    expect(first.json.error.code).toBe('confirmation_required');
    const ch = first.json.error.confirmation;
    expect(ch.token.length).toBeGreaterThanOrEqual(16);
    expect(ch.level).toBe('confirm');
    expect(ch.reasonRequired).toBe(false);
    expect(ch.summary).toBeTruthy();
    expect(await redisExec(['EXISTS', k1]), 'nothing deleted before confirmation').toBe(1);

    // Token is bound to the exact request: using it for another key fails.
    const other = await op.post(E('cli'), { line: `DEL ${k2}`, confirmation: { token: ch.token } });
    expect([400, 403, 409, 428]).toContain(other.status);
    expect(await redisExec(['EXISTS', k2])).toBe(1);

    // Token is bound to the session: another user cannot use it.
    const stolen = await admin.post(E('cli'), { line: `DEL ${k1}`, confirmation: { token: ch.token } });
    expect([400, 403, 409, 428]).toContain(stolen.status);
    expect(await redisExec(['EXISTS', k1])).toBe(1);

    // Need a fresh token if the previous misuse consumed it.
    let token = ch.token;
    let ok = await op.post(E('cli'), { line: `DEL ${k1}`, confirmation: { token } });
    if (ok.status === 428) { token = ok.json.error.confirmation.token; ok = await op.post(E('cli'), { line: `DEL ${k1}`, confirmation: { token } }); }
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.reply).toEqual({ t: 'int', v: '1' });
    expect(await redisExec(['EXISTS', k1])).toBe(0);

    // Single use: replaying the token does not execute again.
    await redisExec(['SET', k1, 'again']);
    const replay = await op.post(E('cli'), { line: `DEL ${k1}`, confirmation: { token } });
    expect(replay.status).not.toBe(200);
    expect(await redisExec(['EXISTS', k1])).toBe(1);
  });

  test('forged / malformed tokens are rejected', async () => {
    const k = `${K.scratchPrefix}confirm-forged`;
    await redisExec(['SET', k, 'x']);
    for (const token of ['A'.repeat(32), 'not-a-token-but-long-enough', 'x'.repeat(256)]) {
      const r = await op.post(E('cli'), { line: `DEL ${k}`, confirmation: { token } });
      expect(r.status).not.toBe(200);
    }
    const bad = await op.post(E('cli'), { line: `DEL ${k}`, confirmation: { token: 'short' } });
    expect(bad.status).toBe(400);
    expect(await redisExec(['EXISTS', k])).toBe(1);
  });

  test('typed ops: key.delete requires confirmation', async () => {
    const k = `${K.scratchPrefix}confirm-op`;
    await redisExec(['SET', k, 'x']);
    const body = { op: 'key.delete', keys: [utf8(k)] };
    const first = await op.post(E('ops'), body);
    expect(first.status).toBe(428);
    const r = await op.post(E('ops'), { ...body, confirmation: { token: first.json.error.confirmation.token } });
    expect(r.status, r.text).toBe(200);
    expect(await redisExec(['EXISTS', k])).toBe(0);
  });

  test('FLUSHDB (admin, non-prod) requires a typed database name', async () => {
    // Use the prod-sim db index? No: FLUSHDB is nonProdOnly. Use sandbox-e2e but answer wrongly, never executing it.
    const first = await admin.post(E('cli'), { line: 'FLUSHDB' });
    expect(first.status).toBe(428);
    const ch = first.json.error.confirmation;
    expect(ch.level).toBe('typed');
    expect(ch.expectedText).toBeTruthy();
    const wrong = await admin.post(E('cli'), { line: 'FLUSHDB', confirmation: { token: ch.token, typed: 'wrong name' } });
    expect(wrong.status).not.toBe(200);
    expect(Number(await redisExec(['DBSIZE']))).toBeGreaterThan(100);
  });

  test('FLUSHDB is refused on prod even for admin', async () => {
    const r = await admin.post(P('cli'), { line: 'FLUSHDB' });
    expect(r.status).toBe(403);
    expect(Number(await redisExec(['DBSIZE'], 1))).toBeGreaterThan(0);
  });

  test('prod write: typed database name + reason required, reason lands in the audit log', async () => {
    const body = { op: 'string.set', key: utf8(K.prodSimKey), value: utf8('changed in prod-sim') };
    const first = await op.post(P('ops'), body);
    expect(first.status, first.text).toBe(428);
    const ch = first.json.error.confirmation;
    expect(ch.reasonRequired).toBe(true);
    expect(ch.level).toBe('typed');
    expect(ch.expectedText).toBeTruthy();

    const noReason = await op.post(P('ops'), { ...body, confirmation: { token: ch.token, typed: ch.expectedText } });
    expect(noReason.status).not.toBe(200);
    expect(String(await redisExec(['GET', K.prodSimKey], 1))).toBe('prod-like value');

    let tok = ch.token;
    const again = await op.post(P('ops'), body);
    if (again.status === 428) tok = again.json.error.confirmation.token;
    const wrongTyped = await op.post(P('ops'), { ...body, confirmation: { token: tok, typed: 'not the name', reason: 'e2e reason' } });
    expect(wrongTyped.status).not.toBe(200);

    const fresh = await op.post(P('ops'), body);
    expect(fresh.status).toBe(428);
    const reason = `E2E-REASON-${Date.now()}`;
    const ok = await op.post(P('ops'), { ...body, confirmation: { token: fresh.json.error.confirmation.token, typed: fresh.json.error.confirmation.expectedText, reason } });
    expect(ok.status, ok.text).toBe(200);
    expect(String(await redisExec(['GET', K.prodSimKey], 1))).toBe('changed in prod-sim');

    const audit = await admin.get(`${API}/admin/audit?database=${DB.prodSim}&limit=50`);
    expect(audit.status).toBe(200);
    const ev = (audit.json.events as any[]).find((e) => e.reason === reason);
    expect(ev, 'audit event with the reason').toBeTruthy();
    expect(ev.outcome).toBe('allowed');
    expect(JSON.stringify(ev)).not.toContain('changed in prod-sim');
  });

  test('prod CLI write also requires typed name + reason', async () => {
    const line = `SET ${K.prodSimKey} via-cli`;
    const first = await op.post(P('cli'), { line });
    expect(first.status).toBe(428);
    expect(first.json.error.confirmation.reasonRequired).toBe(true);
    const ch = first.json.error.confirmation;
    const ok = await op.post(P('cli'), { line, confirmation: { token: ch.token, typed: ch.expectedText, reason: 'e2e cli prod write' } });
    expect(ok.status, ok.text).toBe(200);
  });
});

test.describe('bulk delete', () => {
  let op: Api;
  let viewer: Api;
  test.beforeAll(async () => { op = await Api.fromStorage('operator'); viewer = await Api.fromStorage('viewer'); });
  test.afterAll(async () => { await op.dispose(); await viewer.dispose(); });

  test('viewer cannot bulk delete', async () => {
    const r = await viewer.post(E('bulk-delete'), { match: `${K.bulkPrefix}*` });
    expect(r.status).toBe(403);
  });

  test('impact preview (count + sample) then confirmed delete of exactly the matching keys', async () => {
    const prefix = `${K.scratchPrefix}bulkapi:`;
    for (let i = 0; i < 37; i++) await redisExec(['SET', `${prefix}${i}`, 'x']);
    await redisExec(['SET', `${K.scratchPrefix}bulkapi-survivor`, 'x']);
    const first = await op.post(E('bulk-delete'), { match: `${prefix}*` });
    expect(first.status, first.text).toBe(428);
    const ch = first.json.error.confirmation;
    expect(ch.impact.keys).toBe(37);
    expect(ch.impact.sample.length).toBeGreaterThan(0);
    expect(ch.impact.sample.length).toBeLessThanOrEqual(37);
    for (const s of ch.impact.sample) expect(s.data.startsWith(prefix)).toBe(true);
    expect(Number(await redisExec(['EXISTS', `${prefix}0`]))).toBe(1);

    const ok = await op.post(E('bulk-delete'), { match: `${prefix}*`, confirmation: { token: ch.token, typed: ch.expectedText } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.deleted).toBe(37);
    expect(await redisExec(['EXISTS', `${K.scratchPrefix}bulkapi-survivor`])).toBe(1);
    expect(await redisExec(['EXISTS', `${prefix}5`])).toBe(0);
  });

  test('type filter restricts the impact', async () => {
    const prefix = `${K.scratchPrefix}bulktype:`;
    await redisExec(['SET', `${prefix}s`, 'x']);
    await redisExec(['HSET', `${prefix}h`, 'f', 'v']);
    const r = await op.post(E('bulk-delete'), { match: `${prefix}*`, type: 'hash' });
    expect(r.status).toBe(428);
    expect(r.json.error.confirmation.impact.keys).toBe(1);
  });

  test('match "*" (whole database): refused for operator; admin gets a full-count preview (no silent cap)', async () => {
    const o = await op.post(E('bulk-delete'), { match: '*' });
    expect(o.status).toBe(403);
    const admin = await Api.fromStorage('admin');
    const r = await admin.post(E('bulk-delete'), { match: '*' });
    await admin.dispose();
    expect(r.status).toBe(428);
    expect(r.json.error.confirmation.impact.keys).toBeGreaterThan(BULK_COUNT);
    // never confirmed
  });
});
