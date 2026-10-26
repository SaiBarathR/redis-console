/**
 * Regression tests for CLI/workbench/policy findings from the security review (sandbox 6411).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupPrefix, keyPrefix, sandboxAdmin, sandboxUp, startApp, testConfig, userSession, type TestApp } from '../helpers.ts';

type Admin = Awaited<ReturnType<typeof sandboxAdmin>>;
const CLI = '/api/v1/databases/e2e/cli';

describe.skipIf(!sandboxUp)('security: audit never stores values from errors or unknown names', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('seccli');
  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    await r.hSet(`${P}h`, { f: 'v' });
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });
  const auditText = () => t.auditLines.join('\n') + JSON.stringify(t.ctx.audit.query({ limit: 500 }));

  it('an unknown command (e.g. a pasted secret) is audited without its name or arguments', async () => {
    const v = await userSession(t, 'viewer');
    const res = await v.req('POST', CLI, { argv: ['Hunter2SecretToken', 'another-secret-arg'] });
    expect(res.status).toBe(403);
    const text = auditText();
    expect(text.toLowerCase()).not.toContain('hunter2secrettoken');
    expect(text).not.toContain('another-secret-arg');
    const ev = t.ctx.audit.query({ action: 'cli.exec', limit: 1 }).events[0]!;
    expect(ev.command).toBe('<unknown command>');
    expect(ev.argvRedacted).toEqual(['<18 bytes>', '<18 bytes>']);
    expect(ev.detail).toBe('command_blocked');
  });

  it('an unknown subcommand is not stored verbatim', async () => {
    const v = await userSession(t, 'admin');
    await v.req('POST', CLI, { argv: ['CONFIG', 'SecretSubcommandValue'] });
    const ev = t.ctx.audit.query({ action: 'cli.exec', limit: 1 }).events[0]!;
    expect(ev.command).toBe('CONFIG <unknown subcommand>');
    expect(ev.argvRedacted).toEqual(['CONFIG', '<21 bytes>']);
    expect(auditText().toLowerCase()).not.toContain('secretsubcommandvalue');
  });

  it('Redis error replies are audited by error code only (their text can quote arguments)', async () => {
    const v = await userSession(t, 'viewer');
    let res = await v.req('POST', CLI, { argv: ['GET', `${P}h`] });
    expect(res.json.reply).toMatchObject({ t: 'err' });
    expect(t.ctx.audit.query({ action: 'cli.exec', limit: 1 }).events[0]!.detail).toBe('redis_error: WRONGTYPE');
    res = await v.req('POST', CLI, { argv: ['FT.SEARCH', 'rcsrv-secret-index-name-42', '*'] });
    expect(res.json.reply).toMatchObject({ t: 'err' });
    expect(res.json.reply.v).toContain('rcsrv-secret-index-name-42');
    const ev = t.ctx.audit.query({ action: 'cli.exec', limit: 1 }).events[0]!;
    expect(ev.detail).toMatch(/^redis_error: [A-Z_]+$/);
    expect(auditText()).not.toContain('rcsrv-secret-index-name-42');
  });

  it('workbench error lines follow the same rules', async () => {
    const v = await userSession(t, 'viewer');
    const res = await v.req('POST', '/api/v1/databases/e2e/workbench', { script: `FT.SEARCH rcsrv-wb-secret-idx *\nWbSecretCmd x`, stopOnError: false });
    expect(res.status).toBe(200);
    expect(auditText()).not.toContain('rcsrv-wb-secret-idx');
    expect(auditText().toLowerCase()).not.toContain('wbsecretcmd');
  });
});

describe.skipIf(!sandboxUp)('security: console replies never carry credentials or server paths', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => t?.close());

  it('CONFIG GET redacts password parameters (requirepass, masterauth, TLS key passphrases)', async () => {
    const a = await userSession(t, 'admin');
    const res = await a.req('POST', CLI, { line: 'CONFIG GET *' });
    expect(res.status).toBe(200);
    const pairs = new Map<string, any>(res.json.reply.v.map(([k, v]: any) => [k.v.data, v]));
    expect(pairs.size).toBeGreaterThan(50);
    for (const name of ['requirepass', 'masterauth', 'tls-key-file-pass', 'tls-client-key-file-pass']) {
      expect(pairs.get(name), name).toEqual({ t: 'str', v: { enc: 'utf8', data: '<redacted>' } });
    }
    expect(pairs.get('maxmemory-policy').v.data).toBeTruthy();
    const one = await a.req('POST', CLI, { argv: ['config', 'get', 'REQUIREPASS'] });
    expect(JSON.stringify(one.json.reply)).toContain('<redacted>');
  });

  it('INFO from the console hides paths, run ids and replica addresses like the overview does', async () => {
    const v = await userSession(t, 'viewer');
    const res = await v.req('POST', CLI, { line: 'INFO' });
    expect(res.status).toBe(200);
    const text: string = res.json.reply.v.data;
    expect(text).toContain('redis_version:');
    for (const f of ['executable:', 'config_file:', 'run_id:', 'tcp_port:', 'master_replid:']) expect(text, f).not.toContain(f);
  });
});

describe.skipIf(!sandboxUp)('security: availability guards in the console', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('secdos');
  beforeAll(async () => {
    const { testConfig } = await import('../helpers.ts');
    const cfg = testConfig();
    cfg.policy.maxReplyBytes = 4096;
    cfg.policy.maxReadReplyBytes = 64 * 1024; // preflight byte limit = 16 x 4 KiB = 64 KiB
    cfg.policy.workbenchBudgetMs = 1000;
    t = await startApp(cfg);
    r = await sandboxAdmin();
    await r.sAdd(`${P}small-set`, ['a', 'b', 'c']);
    await r.set(`${P}big-string`, 'x'.repeat(100_000));
    await r.hSet(`${P}fat-hash`, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, 'y'.repeat(10_000)])));
    for (let i = 0; i < 12; i++) await r.rPush(`${P}long-list`, Array.from({ length: 10_000 }, (_, j) => String(i * 10_000 + j)));
  }, 60_000);
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('refuses replies that would be huge before Redis sends them (413), allows bounded ones', async () => {
    const v = await userSession(t, 'viewer');
    const cases: [string[], number][] = [
      [['SRANDMEMBER', `${P}small-set`, '-200000'], 413],
      [['SRANDMEMBER', `${P}small-set`, '-10'], 200],
      [['GET', `${P}big-string`], 413],
      [['GETRANGE', `${P}big-string`, '0', '99'], 200],
      [['HGETALL', `${P}fat-hash`], 413],
      [['HSCAN', `${P}fat-hash`, '0', 'COUNT', '2'], 200],
      [['LRANGE', `${P}long-list`, '0', '-1'], 413],
      [['LRANGE', `${P}long-list`, '0', '99'], 200],
      [['SMEMBERS', `${P}small-set`], 200],
      [['GET', `${P}missing`], 200],
    ];
    for (const [argv, status] of cases) {
      const res = await v.req('POST', CLI, { argv });
      expect(res.status, `${argv.join(' ')}: ${JSON.stringify(res.json).slice(0, 200)}`).toBe(status);
      if (status === 413) {
        expect(res.json.error.code).toBe('too_large');
        expect(res.json.error.hint).toMatch(/SCAN|range/i);
      }
    }
    const ev = t.ctx.audit.query({ action: 'cli.exec', outcome: 'denied', limit: 1 }).events[0]!;
    expect(ev.detail).toMatch(/^too_large/);
  });

  it('allows only one blocking command per user at a time (pool starvation guard)', async () => {
    const v = await userSession(t, 'viewer');
    const argv = ['XREAD', 'BLOCK', '1500', 'STREAMS', `${P}no-stream`, '$'];
    const [a, b] = await Promise.all([v.req('POST', CLI, { argv }), v.req('POST', CLI, { argv })]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    // Another user is not affected, and the slot is released afterwards.
    const w = await userSession(t, 'viewer');
    expect((await w.req('POST', CLI, { argv: ['XREAD', 'BLOCK', '100', 'STREAMS', `${P}no-stream`, '$'] })).status).toBe(200);
    expect((await v.req('POST', CLI, { argv: ['XREAD', 'BLOCK', '100', 'STREAMS', `${P}no-stream`, '$'] })).status).toBe(200);
  });

  it('stops a workbench script when its time budget is used up', async () => {
    const v = await userSession(t, 'viewer');
    const res = await v.req('POST', '/api/v1/databases/e2e/workbench', { script: `XREAD BLOCK 1200 STREAMS ${P}no-stream $\nPING`, stopOnError: false });
    expect(res.status).toBe(200);
    expect(res.json.results).toHaveLength(2);
    expect(res.json.results[0].reply).toBeDefined();
    expect(res.json.results[1].error.code).toBe('timeout');
  });
});

describe.skipIf(!sandboxUp)('security: wildcard-heavy glob patterns are refused on every route', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => t?.close());

  it('scan, analysis, bulk delete, pub/sub and console', async () => {
    const evil = '*a'.repeat(9);
    const v = await userSession(t, 'admin');
    expect((await v.req('POST', '/api/v1/databases/e2e/keys/scan', { match: evil })).status).toBe(400);
    expect((await v.req('POST', '/api/v1/databases/e2e/analysis', { match: evil, sampleSize: 100 })).status).toBe(400);
    expect((await v.req('POST', '/api/v1/databases/e2e/bulk-delete', { match: evil })).status).toBe(400);
    expect((await v.req('POST', '/api/v1/databases/e2e/pubsub/channels', { pattern: evil })).status).toBe(400);
    expect((await v.req('POST', '/api/v1/databases/e2e/pubsub/subscriptions', { patterns: [evil] })).status).toBe(400);
    expect((await v.req('POST', CLI, { argv: ['SCAN', '0', 'MATCH', evil] })).status).toBe(400);
    expect((await v.req('POST', '/api/v1/databases/e2e/keys/scan', { match: 'rcsrv:*:x*' })).status).toBe(200);
  });
});

describe.skipIf(!sandboxUp)('security: a read-only database cannot be changed through any route', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('secro');
  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    await r.set(`${P}k`, 'original');
    await r.xAdd(`${P}s`, '*', { f: 'v' });
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('admin on e2e-ro: CLI, workbench, ops, bulk delete, publish, slowlog reset, client kill', async () => {
    const a = await userSession(t, 'admin');
    const RO = '/api/v1/databases/e2e-ro';
    const lines = [
      `SET ${P}k changed`, `DEL ${P}k`, `UNLINK ${P}k`, `EXPIRE ${P}k 1`, `PUBLISH ${P}c x`, `SPUBLISH ${P}c x`, `FLUSHDB`,
      `XGROUP CREATE ${P}s g $`, `XREADGROUP GROUP g c STREAMS ${P}s >`, `SLOWLOG RESET`, `CLIENT KILL ID 1`, `MEMORY PURGE`,
      `LATENCY RESET`, `FT.DROPINDEX nope`, `COPY ${P}k ${P}k2`, `set ${P}k changed`, `"SET" ${P}k changed`,
    ];
    for (const line of lines) {
      const res = await a.req('POST', `${RO}/cli`, { line });
      expect(res.status, line).toBe(403);
      expect(['read_only', 'command_blocked'], line).toContain(res.json.error.code);
    }
    const wb = await a.req('POST', `${RO}/workbench`, { script: `GET ${P}k\nSET ${P}k changed`, stopOnError: false });
    expect(wb.status).toBe(200);
    expect(wb.json.results[1].error.code).toBe('read_only');
    const ops = [
      { op: 'string.set', key: { enc: 'utf8', data: `${P}k` }, value: { enc: 'utf8', data: 'changed' } },
      { op: 'key.delete', keys: [{ enc: 'utf8', data: `${P}k` }] },
      { op: 'key.expire', key: { enc: 'utf8', data: `${P}k` }, ttl: 1 },
      { op: 'stream.add', key: { enc: 'utf8', data: `${P}s` }, fields: [{ field: { enc: 'utf8', data: 'f' }, value: { enc: 'utf8', data: 'v' } }] },
    ];
    for (const body of ops) expect((await a.req('POST', `${RO}/ops`, body)).status, body.op).toBe(403);
    expect((await a.req('POST', `${RO}/bulk-delete`, { match: `${P}*` })).status).toBe(403);
    expect((await a.req('POST', `${RO}/pubsub/publish`, { channel: `${P}c`, message: { enc: 'utf8', data: 'x' } })).status).toBe(403);
    expect((await a.req('POST', `${RO}/slowlog/reset`, {})).status).toBe(403);
    expect((await a.req('POST', `${RO}/clients/kill`, { id: '1' })).status).toBe(403);
    expect(await r.get(`${P}k`)).toBe('original');
    expect(await r.ttl(`${P}k`)).toBe(-1);
    expect(await r.xLen(`${P}s`)).toBe(1);
  });
});

describe.skipIf(!sandboxUp)('security: addresses and multi-series reads in the console', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('secaddr');
  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });
  const text = (res: { json: any }) => JSON.stringify(res.json.reply);

  it('CLIENT INFO hides addr/laddr for non-admins, not for admins', async () => {
    const v = await userSession(t, 'viewer');
    const res = await v.req('POST', CLI, { line: 'CLIENT INFO' });
    expect(res.status).toBe(200);
    expect(text(res)).toContain('addr=<hidden>');
    expect(text(res)).not.toMatch(/addr=[\d[]/);
    const a = await userSession(t, 'admin');
    expect(text(await a.req('POST', CLI, { line: 'CLIENT INFO' }))).toMatch(/ addr=[\d[][^ ]*:\d+ laddr=/);
  });

  it('TS.MRANGE uses the actual series reply, not COUNT times a predicted series size', async () => {
    const label = P.replace(/[^a-z0-9]/gi, '');
    for (const i of [1, 2]) {
      await r.sendCommand(['TS.CREATE', `${P}ts${i}`, 'LABELS', 'grp', label]);
      await r.sendCommand(['TS.ADD', `${P}ts${i}`, '1000', String(i)]);
    }
    const v = await userSession(t, 'viewer');
    const res = await v.req('POST', CLI, { argv: ['TS.MRANGE', '-', '+', 'FILTER', `grp=${label}`] });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    // A large COUNT over two single-sample series returns a small measured reply.
    const big = await v.req('POST', CLI, { argv: ['TS.MRANGE', '-', '+', 'COUNT', '60000', 'FILTER', `grp=${label}`] });
    expect(big.status).toBe(200);
    expect(big.json.reply.t).not.toBe('err');
  });
});

describe.skipIf(!sandboxUp)('security: COPY ... DB cannot write into another logical database (H2)', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('seccopy');
  beforeAll(async () => {
    t = await startApp();
    r = await sandboxAdmin();
    await r.set(`${P}src`, 'cross-database');
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('is refused as line, argv and argvBin, and nothing lands in DB 1', async () => {
    const op = await userSession(t, 'operator');
    const b = (s: string) => ({ enc: 'base64', data: Buffer.from(s).toString('base64') });
    for (const body of [
      { line: `COPY ${P}src ${P}dst DB 1 REPLACE` },
      { argv: ['COPY', `${P}src`, `${P}dst`, 'db', '1'] },
      { argvBin: [b('COPY'), b(`${P}src`), b(`${P}dst`), b('Db'), b('1')] },
    ]) {
      const res = await op.req('POST', CLI, body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.json.error.code).toBe('command_blocked');
    }
    const wb = await op.req('POST', '/api/v1/databases/e2e/workbench', { script: `COPY ${P}src ${P}dst DB 1` });
    expect(wb.json.results[0].error.code).toBe('command_blocked');
    const db1 = r.duplicate({ database: 1 });
    db1.on('error', () => {});
    await db1.connect();
    try {
      expect(await db1.exists(`${P}dst`)).toBe(0);
    } finally {
      await db1.close();
    }
    // Same-database COPY still works.
    expect((await op.req('POST', CLI, { argv: ['COPY', `${P}src`, `${P}dst2`] })).status).toBe(200);
  });
});

describe.skipIf(!sandboxUp)('security: repeated-member reads (H3)', () => {
  let t: TestApp;
  let r: Admin;
  const P = keyPrefix('secrepeat');
  beforeAll(async () => {
    const cfg = testConfig();
    cfg.policy.maxReplyBytes = 1024;
    cfg.policy.maxReadReplyBytes = 16 * 1024;
    t = await startApp(cfg);
    r = await sandboxAdmin();
    await r.sAdd(`${P}s`, 'x'.repeat(1024));
    await r.hSet(`${P}h`, 'f', 'y'.repeat(1024));
    await r.zAdd(`${P}z`, { score: 1, value: 'z'.repeat(1024) });
  });
  afterAll(async () => {
    await r?.close();
    await t?.close();
    await cleanupPrefix(P);
  });

  it('SRANDMEMBER / HRANDFIELD / ZRANDMEMBER with large negative counts are refused before running', async () => {
    const v = await userSession(t, 'viewer');
    for (const argv of [
      ['SRANDMEMBER', `${P}s`, '-50'],
      ['HRANDFIELD', `${P}h`, '-50', 'WITHVALUES'],
      ['ZRANDMEMBER', `${P}z`, '-50', 'WITHSCORES'],
    ]) {
      const res = await v.req('POST', CLI, { argv });
      expect(res.status, argv[0]).toBe(413);
      expect(res.json.error.code).toBe('too_large');
    }
    expect((await v.req('POST', CLI, { argv: ['SRANDMEMBER', `${P}s`, '-1'] })).status).toBe(200);
  });
});
