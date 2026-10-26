/**
 * M1: every confirmation challenge carries a server-built preview of exactly what will run, and the token only
 * works for the request it was issued for. The preview never reaches the audit log.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, userSession, utf8, type Client, type TestApp } from '../helpers.ts';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;
type Arg = { kind: string; v: { enc: string; data: string }; bytes?: number };
const show = (argv: Arg[]) => argv.map((a) => `${a.kind}:${a.v.enc === 'utf8' ? a.v.data : `b64:${a.v.data}`}${a.bytes ? `…(${a.bytes})` : ''}`);
const db = (id: string, path: string) => `/api/v1/databases/${id}/${path}`;

describe.skipIf(!sandboxUp)('confirmation previews (M1)', () => {
  let t: TestApp;
  let r: Admin;
  let op: Client;
  let admin: Client;
  const P = keyPrefix('preview');
  /** Everything the audit log holds (SQLite rows + stdout lines), for leak checks. */
  const auditText = () => JSON.stringify(t.ctx.audit.query({ limit: 500 }).events) + t.auditLines.join('\n');

  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    op = await userSession(t, 'operator');
    admin = await userSession(t, 'admin');
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('CLI: DEL shows the key in full; nothing of it reaches the audit log', async () => {
    const key = `${P}cli:user@example.com`;
    await r.set(key, 'v');
    const res = await op.req('POST', db('e2e', 'cli'), { argv: ['DEL', key] });
    expect(res.status).toBe(428);
    const pv = res.json.error.confirmation.preview;
    expect(pv.total).toBe(1);
    expect(show(pv.commands[0].argv)).toEqual(['command:DEL', `key:${key}`]);
    expect(auditText()).not.toContain('user@example.com');
    expect(await r.exists(key)).toBe(1);
  });

  it('CLI on prod: values are a short prefix + size; the prefix is not audited either', async () => {
    const value = 'TOPSECRETPREFIX!' + 'z'.repeat(100);
    const res = await op.req('POST', db('e2e-prod', 'cli'), { argv: ['SET', `${P}prod`, value, 'EX', '100'] });
    expect(res.status).toBe(428);
    const ch = res.json.error.confirmation;
    expect(ch).toMatchObject({ level: 'typed', expectedText: 'E2E prod', reasonRequired: true });
    expect(show(ch.preview.commands[0].argv)).toEqual(['command:SET', `key:${P}prod`, `arg:TOPSECRETPREFIX!…(116)`, 'arg:EX', 'arg:100']);
    expect(auditText()).not.toContain('TOPSECRETPREFIX');
  });

  it('CLI: the preview shows the capped argv that actually runs', async () => {
    const res = await op.req('POST', db('e2e-prod', 'cli'), { argv: ['BLMOVE', `${P}a`, `${P}b`, 'LEFT', 'RIGHT', '0'] });
    expect(res.status).toBe(428);
    expect(show(res.json.error.confirmation.preview.commands[0].argv).at(-1)).toBe('arg:5'); // 0 = forever -> 5 s
  });

  it('the token is bound to the exact request: confirming DEL k1 cannot delete k2', async () => {
    await r.set(`${P}k1`, '1');
    await r.set(`${P}k2`, '2');
    const first = await op.req('POST', db('e2e', 'cli'), { argv: ['DEL', `${P}k1`] });
    const token = first.json.error.confirmation.token;
    const swapped = await op.req('POST', db('e2e', 'cli'), { argv: ['DEL', `${P}k2`], confirmation: { token } });
    expect(swapped.status).toBe(428);
    expect(show(swapped.json.error.confirmation.preview.commands[0].argv)).toEqual(['command:DEL', `key:${P}k2`]);
    expect(await r.exists([`${P}k1`, `${P}k2`])).toBe(2);
    const ok = await op.req('POST', db('e2e', 'cli'), { argv: ['DEL', `${P}k2`], confirmation: { token: swapped.json.error.confirmation.token } });
    expect(ok.status).toBe(200);
    expect(await r.exists([`${P}k1`, `${P}k2`])).toBe(1);
  });

  it('workbench: lists each destructive line in order; reads are not listed', async () => {
    const script = [`GET ${P}w0`, `DEL ${P}w1`, `SET ${P}w2 v`, `UNLINK ${P}w3 ${P}w4`, `EXISTS ${P}w1`].join('\n');
    const res = await op.req('POST', db('e2e', 'workbench'), { script });
    expect(res.status).toBe(428);
    const pv = res.json.error.confirmation.preview;
    expect(pv.total).toBe(2);
    expect(pv.commands.map((c: { argv: Arg[] }) => show(c.argv))).toEqual([
      ['command:DEL', `key:${P}w1`],
      ['command:UNLINK', `key:${P}w3`, `key:${P}w4`],
    ]);
    // On prod every write is listed.
    const prod = await op.req('POST', db('e2e-prod', 'workbench'), { script });
    expect(prod.json.error.confirmation.preview.commands.map((c: { argv: Arg[] }) => c.argv[0]!.v.data)).toEqual(['DEL', 'SET', 'UNLINK']);
  });

  it('workbench: more than 50 destructive lines -> 50 listed + "more"', async () => {
    const script = Array.from({ length: 60 }, (_, i) => `DEL ${P}many${i}`).join('\n');
    const pv = (await op.req('POST', db('e2e', 'workbench'), { script })).json.error.confirmation.preview;
    expect(pv).toMatchObject({ total: 60, more: 10 });
    expect(pv.commands.length).toBe(50);
    expect(pv.commands[49].argv[1].v.data).toBe(`${P}many49`);
  });

  it('typed ops: the mapped command with keys in full and values shortened', async () => {
    let res = await op.req('POST', db('e2e', 'ops'), { op: 'key.delete', keys: [utf8(`${P}d1`), utf8(`${P}d2`)] });
    expect(res.status).toBe(428);
    expect(show(res.json.error.confirmation.preview.commands[0].argv)).toEqual(['command:UNLINK', `key:${P}d1`, `key:${P}d2`]);
    res = await op.req('POST', db('e2e-prod', 'ops'), { op: 'hash.set', key: utf8(`${P}h`), entries: [{ field: utf8('f'), value: utf8('v'.repeat(40)) }] });
    expect(show(res.json.error.confirmation.preview.commands[0].argv)).toEqual(['command:HSET', `key:${P}h`, 'arg:f', `arg:${'v'.repeat(16)}…(40)`]);
    res = await op.req('POST', db('e2e', 'ops'), { op: 'stream.group.destroy', key: utf8(`${P}s`), group: 'g1' });
    expect(show(res.json.error.confirmation.preview.commands[0].argv)).toEqual(['command:XGROUP', 'command:DESTROY', `key:${P}s`, 'arg:g1']);
  });

  it('bulk delete: pattern, count and sample; the UNLINK lists the sample and counts the rest', async () => {
    for (let i = 0; i < 25; i++) await r.set(`${P}bulk:${i}`, 'v');
    const res = await op.req('POST', db('e2e', 'bulk-delete'), { match: `${P}bulk:*` });
    expect(res.status).toBe(428);
    const pv = res.json.error.confirmation.preview;
    expect(pv.bulk).toMatchObject({ match: utf8(`${P}bulk:*`), keys: 25, complete: true });
    expect(pv.bulk.sample.length).toBe(20);
    expect(show(pv.commands[0].argv)).toEqual(['command:SCAN', 'arg:0', 'arg:MATCH', `pattern:${P}bulk:*`, 'arg:COUNT', 'arg:1000']);
    expect(pv.commands[1].argv[0]).toEqual({ kind: 'command', v: utf8('UNLINK') });
    expect(pv.commands[1].argv.length - 1 + pv.commands[1].moreArgs).toBe(25);
    expect(auditText()).not.toContain(`${P}bulk:`);
  });

  it('client kill, slowlog reset and FLUSHDB show their commands (never confirmed here)', async () => {
    let res = await admin.req('POST', db('e2e', 'clients/kill'), { id: '987654321' });
    expect(res.status).toBe(428);
    expect(show(res.json.error.confirmation.preview.commands[0].argv)).toEqual(['command:CLIENT', 'command:KILL', 'arg:ID', 'arg:987654321']);
    res = await admin.req('POST', db('e2e', 'slowlog/reset'), {});
    expect(show(res.json.error.confirmation.preview.commands[0].argv)).toEqual(['command:SLOWLOG', 'command:RESET']);
    res = await admin.req('POST', db('e2e', 'cli'), { line: 'FLUSHDB' });
    expect(res.status).toBe(428);
    expect(res.json.error.confirmation).toMatchObject({ level: 'typed', preview: { total: 1, commands: [{ argv: [{ kind: 'command', v: utf8('FLUSHDB') }] }] } });
  });

  it('publish shows the channel in full and the message as a value', async () => {
    const res = await op.req('POST', db('e2e-prod', 'pubsub/publish'), { channel: `${P}chan`, message: utf8('m'.repeat(50)) });
    expect(res.status).toBe(428);
    expect(show(res.json.error.confirmation.preview.commands[0].argv)).toEqual(['command:PUBLISH', `key:${P}chan`, `arg:${'m'.repeat(16)}…(50)`]);
  });
});
