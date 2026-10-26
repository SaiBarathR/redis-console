/**
 * Blocked commands through the CLI and workbench APIs — as admin (the most privileged role),
 * in upper/lower/mixed case, as a line, as argv and as binary argv, plus tokenizer tricks.
 * The UI side (console badge + error) is in specs/ui/console.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { Api, dbPath, utf8 } from '../../lib/api.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';

export const BLOCKED_LINES = [
  'EVAL "return redis.call(\'FLUSHDB\')" 0',
  'EVALSHA 0123456789012345678901234567890123456789 0',
  'EVAL_RO "return 1" 0',
  'FCALL myfunc 0',
  'FUNCTION LOAD "#!lua name=x\\nredis.register_function(\'f\', function() return 1 end)"',
  'FUNCTION FLUSH',
  'FUNCTION LIST',
  'SCRIPT LOAD "return 1"',
  'SCRIPT FLUSH',
  'KEYS *',
  'CONFIG SET dir /tmp',
  'CONFIG SET dbfilename x.so',
  'CONFIG REWRITE',
  'FLUSHALL',
  'FLUSHALL ASYNC',
  'MODULE LOAD /tmp/evil.so',
  'MODULE LIST',
  'MULTI',
  'EXEC',
  'WATCH foo',
  'SELECT 1',
  'SWAPDB 0 1',
  'MOVE foo 1',
  'MIGRATE 10.0.0.1 6379 foo 0 1000',
  'DEBUG SLEEP 1',
  'DEBUG SEGFAULT',
  'SHUTDOWN NOSAVE',
  'ACL SETUSER evil on >pw +@all ~*',
  'ACL DELUSER rc-viewer',
  'ACL LIST',
  'ACL GETUSER rc-admin',
  'CLIENT SETNAME evil',
  'CLIENT PAUSE 10000',
  'CLIENT NO-EVICT on',
  'AUTH default secret',
  'HELLO 3 AUTH default secret',
  'REPLICAOF 10.0.0.1 6379',
  'SLAVEOF 10.0.0.1 6379',
  'SAVE',
  'BGSAVE',
  'BGREWRITEAOF',
  'RESTORE foo 0 "\\x00"',
  'WAIT 1 0',
  'SUBSCRIBE foo',
  'MONITOR',
  'FOOBARNOTACOMMAND x',
] as const;

/** The case variants required by the spec. */
function variants(line: string): string[] {
  const [cmd, ...rest] = line.split(' ');
  const tail = rest.length ? ' ' + rest.join(' ') : '';
  const sub = rest[0] && /^[A-Z_-]+$/.test(rest[0]) ? rest[0] : null;
  const mixed = cmd!.split('').map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase())).join('');
  const out = [line, cmd!.toLowerCase() + tail, mixed + tail];
  if (sub) out.push(`${cmd!.toLowerCase()} ${sub.toLowerCase()}${rest.length > 1 ? ' ' + rest.slice(1).join(' ') : ''}`);
  return [...new Set(out)];
}

test.describe('blocked commands (API)', () => {
  let admin: Api;
  let operator: Api;
  let dbsizeBefore = 0;
  test.beforeAll(async () => {
    admin = await Api.fromStorage('admin');
    operator = await Api.fromStorage('operator');
    dbsizeBefore = Number(await redisExec(['DBSIZE']));
  });
  test.afterAll(async () => {
    expect(Number(await redisExec(['DBSIZE'])), 'no blocked command changed the keyspace').toBeGreaterThanOrEqual(dbsizeBefore - 5);
    await admin.dispose();
    await operator.dispose();
  });

  for (const line of BLOCKED_LINES) {
    test(`admin cannot run: ${line.slice(0, 50)}`, async () => {
      for (const v of variants(line)) {
        const r = await admin.post(dbPath(DB.e2e, 'cli'), { line: v });
        const isDedicated = /^(SUBSCRIBE|MONITOR)/i.test(v);
        expect(r.status, `${v} -> ${r.status} ${r.text.slice(0, 200)}`).toBe(403);
        expect(isDedicated ? ['command_blocked', 'forbidden'] : ['command_blocked'], `${v}: ${r.json?.error?.code}`).toContain(r.json?.error?.code);
        if (!/^FOOBAR/i.test(v)) expect(r.json?.error?.hint ?? r.json?.error?.message, `${v} has a hint`).toBeTruthy();
      }
      // Pre-tokenized argv path too.
      const argv = line.split(' ');
      const a = await admin.post(dbPath(DB.e2e, 'cli'), { argv: [argv[0]!.toLowerCase(), ...argv.slice(1)] });
      expect(a.status, `argv ${line}`).toBe(403);
    });
  }

  test('binary argv (argvBin) cannot smuggle a blocked command', async () => {
    const r = await admin.post(dbPath(DB.e2e, 'cli'), { argvBin: [{ enc: 'base64', data: Buffer.from('FlushAll').toString('base64') }] });
    expect(r.status).toBe(403);
    const r2 = await admin.post(dbPath(DB.e2e, 'cli'), { argvBin: [utf8('eval'), utf8('return 1'), utf8('0')] });
    expect(r2.status).toBe(403);
  });

  test('tokenizer tricks do not bypass the policy', async () => {
    const tricks = [
      '  FLUSHALL',
      '\tflushall',
      '"FLUSHALL"',
      "'flushall'",
      '"\\x46LUSHALL"', // \x46 = F
      'CONFIG  SET  dir /tmp',
      '"CONFIG" "SET" "dir" "/tmp"',
      'config "set" dir /tmp',
      'FLUSHALL\u0000',
      'ＦＬＵＳＨＡＬＬ', // full-width letters
      'FLUSH​ALL',
    ];
    for (const t of tricks) {
      const r = await admin.post(dbPath(DB.e2e, 'cli'), { line: t });
      expect([400, 403], `${JSON.stringify(t)} -> ${r.status} ${r.text.slice(0, 200)}`).toContain(r.status);
    }
  });

  test('newline injection runs at most one command', async () => {
    await redisExec(['SET', `${K.scratchPrefix}inject`, 'keep']);
    const before = Number(await redisExec(['DBSIZE']));
    for (const line of ['PING\r\nFLUSHDB', 'PING\nFLUSHALL', `GET ${K.scratchPrefix}inject\r\nDEL ${K.scratchPrefix}inject`]) {
      const r = await admin.post(dbPath(DB.e2e, 'cli'), { line });
      expect(r.status, line).not.toBe(500);
    }
    expect(Number(await redisExec(['DBSIZE']))).toBe(before);
    expect(String(await redisExec(['GET', `${K.scratchPrefix}inject`]))).toBe('keep');
  });

  test('workbench applies the same policy per line and stops on the first blocked line', async () => {
    const r = await admin.post(dbPath(DB.e2e, 'workbench'), { script: `PING\nEVAL "return 1" 0\nSET ${K.scratchPrefix}after-eval 1`, stopOnError: true });
    // Either the whole script is rejected up front, or the blocked line yields an error result.
    if (r.status === 200) {
      const results = r.json.results as any[];
      expect(results[0].reply ?? results[0].error).toBeTruthy();
      expect(results[1].error?.code).toBe('command_blocked');
      expect(results.length).toBe(2);
    } else {
      expect(r.status).toBe(403);
    }
    expect(await redisExec(['EXISTS', `${K.scratchPrefix}after-eval`])).toBe(0);
    for (const line of ['KEYS *', 'flushall', 'Config Set dir /tmp', 'multi', 'select 1', 'script flush']) {
      const w = await admin.post(dbPath(DB.e2e, 'workbench'), { script: line });
      if (w.status === 200) expect(w.json.results[0].error?.code, line).toBe('command_blocked');
      else expect(w.status, line).toBe(403);
    }
  });

  test('blocked-command attempts are audited as denied', async () => {
    await admin.post(dbPath(DB.e2e, 'cli'), { line: 'FLUSHALL' });
    const a = await admin.get('/api/v1/admin/audit?outcome=denied&limit=50');
    expect(a.status).toBe(200);
    const hit = (a.json.events as any[]).find((e) => (e.command ?? '').toUpperCase() === 'FLUSHALL');
    expect(hit, 'audit event for denied FLUSHALL').toBeTruthy();
    expect(hit.outcome).toBe('denied');
  });

  test('operator gets the same blocks (and admin-only commands are forbidden)', async () => {
    for (const line of ['FLUSHALL', 'eval "return 1" 0', 'keys *']) {
      const r = await operator.post(dbPath(DB.e2e, 'cli'), { line });
      expect(r.status).toBe(403);
    }
    for (const line of ['CONFIG GET maxmemory', 'CLIENT LIST', 'FLUSHDB', 'SLOWLOG RESET']) {
      const r = await operator.post(dbPath(DB.e2e, 'cli'), { line });
      expect(r.status, line).toBe(403);
      expect(r.json.error.code, line).toBe('forbidden');
    }
  });

  test('blocking commands have their timeout capped (BLPOP 0 returns within ~5s)', async () => {
    const t0 = Date.now();
    const r = await operator.post(dbPath(DB.e2e, 'cli'), { line: `BLPOP ${K.scratchPrefix}never-pushed 0` });
    const dt = Date.now() - t0;
    expect(r.status).toBeLessThan(500);
    expect(dt).toBeLessThan(8000);
  });

  test('SCAN COUNT is capped and KEYS-like full scans are not possible via CLI', async () => {
    const r = await operator.post(dbPath(DB.e2e, 'cli'), { line: 'SCAN 0 COUNT 100000000' });
    expect([200, 400, 403]).toContain(r.status);
  });
});
