import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuditLog, clip, keyTag, redactArgv } from '../../src/audit.ts';
import { buildApp, loggerOptions } from '../../src/app.ts';
import { openDb } from '../../src/store/db.ts';
import { isSecretConfig, redactReply, sanitizeInfoText } from '../../src/policy/redactReply.ts';
import { ORIGIN, testConfig } from '../helpers.ts';

describe('redactArgv', () => {
  it('keeps the command name, tags keys, replaces values with byte counts', () => {
    const r = redactArgv(['set', 'user:alice@example.com', 'hunter2-password'], 1, [1]);
    expect(r.keyCount).toBe(1);
    expect(r.argv[0]).toBe('SET');
    expect(r.argv[1]).toMatch(/^key#[0-9a-f]{12}$/);
    expect(r.argv[2]).toBe('<16 bytes>');
    const text = JSON.stringify(r);
    expect(text).not.toContain('alice');
    expect(text).not.toContain('hunter2');
  });

  it('keeps subcommands when asked', () => {
    expect(redactArgv(['CLIENT', 'kill', 'ID', '42'], 2).argv).toEqual(['CLIENT', 'KILL', '<2 bytes>', '<2 bytes>']);
  });

  it('never keeps odd-looking command tokens verbatim', () => {
    expect(redactArgv(['GET secret'], 1).argv).toEqual(['<10 bytes>']);
    expect(redactArgv([Buffer.from([0xff, 0xfe])], 1).argv).toEqual(['<2 bytes>']);
  });

  it('counts bytes for binary and multi-byte values', () => {
    expect(redactArgv(['SET', 'k', Buffer.alloc(1000)], 1, [1]).argv[2]).toBe('<1000 bytes>');
    expect(redactArgv(['SET', 'k', 'é'], 1, [1]).argv[2]).toBe('<2 bytes>');
  });

  it('keyTag is a stable SHA-256 prefix', () => {
    const expected = createHash('sha256').update('k1').digest('hex').slice(0, 12);
    expect(keyTag('k1')).toBe(`key#${expected}`);
    expect(keyTag(Buffer.from('k1'))).toBe(keyTag('k1'));
    expect(keyTag('k2')).not.toBe(keyTag('k1'));
  });

  it('multi-key commands count every key', () => {
    const r = redactArgv(['UNLINK', 'a', 'b', 'c'], 1, [1, 2, 3]);
    expect(r.keyCount).toBe(3);
    expect(new Set(r.argv.slice(1)).size).toBe(3);
  });
});

describe('clip', () => {
  it('strips control characters and limits length', () => {
    expect(clip('a\nb\u0000c')).toBe('a b c');
    expect(clip('x'.repeat(600))!.length).toBe(501);
    expect(clip(undefined)).toBeUndefined();
  });
});

describe('AuditLog', () => {
  const make = () => {
    const db = openDb(':memory:');
    const lines: string[] = [];
    return { db, lines, log: new AuditLog(db, (l) => lines.push(l)) };
  };

  it('writes SQLite and a JSON line with audit:true', () => {
    const { db, lines, log } = make();
    const ev = log.record({ userId: 'u1', username: 'alice', ip: '1.2.3.4', action: 'cli.exec', outcome: 'allowed', databaseId: 'd', command: 'SET', argvRedacted: ['SET', 'key#abc', '<3 bytes>'], keyCount: 1, reason: 'ticket\n123' });
    expect(ev.id).toBe('1');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    const j = JSON.parse(lines[0]!);
    expect(j).toMatchObject({ audit: true, id: '1', username: 'alice', action: 'cli.exec', argvRedacted: ['SET', 'key#abc', '<3 bytes>'], keyCount: 1, reason: 'ticket 123' });
    const row = db.prepare('SELECT * FROM audit').get() as Record<string, unknown>;
    expect(row.username).toBe('alice');
    expect(JSON.parse(row.argv_redacted as string)).toEqual(['SET', 'key#abc', '<3 bytes>']);
  });

  it('is append-only (UPDATE and DELETE are rejected)', () => {
    const { db, log } = make();
    log.record({ userId: 'u', username: 'u', ip: '-', action: 'a', outcome: 'allowed' });
    expect(() => db.prepare("UPDATE audit SET username = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit').run()).toThrow(/append-only/);
    expect((db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n).toBe(1);
  });

  it('survives a failing stdout writer', () => {
    const db = openDb(':memory:');
    const log = new AuditLog(db, () => {
      throw new Error('EPIPE');
    });
    expect(() => log.record({ userId: 'u', username: 'u', ip: '-', action: 'a', outcome: 'allowed' })).not.toThrow();
  });

  it('query filters and paginates newest first', () => {
    const { log } = make();
    for (let i = 0; i < 7; i++) {
      log.record({ userId: `u${i % 2}`, username: i % 2 ? 'bob' : 'alice', ip: '-', action: i < 3 ? 'auth.login' : 'cli.exec', outcome: i === 6 ? 'denied' : 'allowed', databaseId: i % 3 === 0 ? 'db1' : 'db2' });
    }
    const p1 = log.query({ limit: 3 });
    expect(p1.events.map((e) => e.id)).toEqual(['7', '6', '5']);
    expect(p1.nextBefore).toBe('5');
    const p2 = log.query({ limit: 3, before: p1.nextBefore });
    expect(p2.events.map((e) => e.id)).toEqual(['4', '3', '2']);
    const p3 = log.query({ limit: 3, before: p2.nextBefore });
    expect(p3.events.map((e) => e.id)).toEqual(['1']);
    expect(p3.nextBefore).toBeUndefined();

    expect(log.query({ limit: 100, user: 'bob' }).events.every((e) => e.username === 'bob')).toBe(true);
    expect(log.query({ limit: 100, action: 'auth.login' }).events).toHaveLength(3);
    expect(log.query({ limit: 100, outcome: 'denied' }).events.map((e) => e.id)).toEqual(['7']);
    expect(log.query({ limit: 100, database: 'db1' }).events.map((e) => e.id)).toEqual(['7', '4', '1']);
    expect(log.query({ limit: 100, before: 'not-a-number' }).events).toHaveLength(7);
  });
});

describe('logger redaction', () => {
  it('never logs cookies, authorization, CSRF tokens or query strings', async () => {
    const out: string[] = [];
    const stream = { write: (s: string) => out.push(s) };
    const { app } = await buildApp(testConfig(), {
      logger: { ...(loggerOptions('trace') as object), stream } as never,
      dbPath: ':memory:',
      auditWrite: () => {},
    });
    await app.ready();
    const secrets = ['COOKIEVALUE123', 'BEARERTOKEN456', 'CSRFTOKEN789', 'QUERYSECRET000', 'BODYSECRET111'];
    const r1 = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me?token=QUERYSECRET000',
      headers: { cookie: 'rc_session=COOKIEVALUE123', authorization: 'Bearer BEARERTOKEN456', 'x-csrf-token': 'CSRFTOKEN789' },
    });
    expect(r1.statusCode).toBe(401);
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login?code=QUERYSECRET000',
      headers: { origin: ORIGIN, cookie: 'rc_session=COOKIEVALUE123', 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'nobody', password: 'BODYSECRET111' }),
    });
    expect(r2.statusCode).toBe(401);
    // A malformed body must not be echoed into logs either.
    await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN, 'content-type': 'application/json' }, payload: '{"password":"BODYSECRET111"' });
    await app.close();
    const all = out.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).toContain('/api/v1/auth/me');
    for (const s of secrets) expect(all, s).not.toContain(s);
  });
});

describe('console reply redaction', () => {
  const s = (x: string) => ({ t: 'str' as const, v: { enc: 'utf8' as const, data: x } });
  it('redacts secret CONFIG parameters in map and flat replies', () => {
    const map = redactReply('CONFIG', 'GET', { t: 'map', v: [[s('requirepass'), s('hunter2')], [s('maxmemory'), s('0')], [s('masterauth'), s('pw')]] });
    expect(JSON.stringify(map)).not.toMatch(/hunter2|"pw"/);
    expect(JSON.stringify(map)).toContain('"0"');
    const flat = redactReply('CONFIG', 'GET', { t: 'arr', v: [s('tls-key-file-pass'), s('secret'), s('dir'), s('/data')] });
    expect(JSON.stringify(flat)).not.toContain('secret');
    expect(JSON.stringify(flat)).toContain('/data');
    expect(isSecretConfig('search-oss-global-password')).toBe(true);
    expect(isSecretConfig('appendonly')).toBe(false);
  });
  it('strips hidden INFO lines and masks replica addresses', () => {
    const t = sanitizeInfoText('# Server\r\nredis_version:8.0.0\r\nexecutable:/usr/bin/redis-server\r\nrun_id:abc\r\n# Replication\r\nslave0:ip=10.1.2.3,port=6379,state=online\r\nmaster_host:10.0.0.9\r\n');
    expect(t).toContain('redis_version:8.0.0');
    expect(t).not.toMatch(/executable|run_id|10\.1\.2\.3|10\.0\.0\.9/);
    expect(t).toContain('slave0:ip=<hidden>,port=<hidden>,state=online');
  });
  it('hides listener addresses for non-admins only', () => {
    const info = '# Server\r\nlistener0:name=tcp,bind=10.0.0.5,bind=-::1,port=6379\r\nredis_version:8.0.0\r\n';
    const hidden = sanitizeInfoText(info, true);
    expect(hidden).toContain('listener0:name=tcp,bind=<hidden>,bind=<hidden>,port=<hidden>');
    expect(hidden).not.toMatch(/10\.0\.0\.5|6379/);
    expect(sanitizeInfoText(info, false)).toContain('10.0.0.5');
    const r = redactReply('INFO', undefined, s(info), { hideAddresses: true });
    expect(JSON.stringify(r)).not.toContain('10.0.0.5');
  });
  it('hides CLIENT LIST / CLIENT INFO addresses for non-admins', () => {
    const line = 'id=7 addr=192.168.1.20:51234 laddr=10.0.0.5:6379 fd=8 name=app user=rc-viewer cmd=client|info\n';
    for (const sub of ['LIST', 'INFO']) {
      const r = redactReply('CLIENT', sub, s(line), { hideAddresses: true });
      expect(JSON.stringify(r)).toContain('addr=<hidden> laddr=<hidden> fd=8 name=app');
      expect(JSON.stringify(r)).not.toMatch(/192\.168|10\.0\.0\.5/);
      expect(JSON.stringify(redactReply('CLIENT', sub, s(line)))).toContain('192.168.1.20');
    }
  });
  it('hides node addresses in CLUSTER NODES / SHARDS / SLOTS and ROLE for non-admins', () => {
    const nodes = 'abc123 10.0.0.1:6379@16379,node-a.internal myself,master - 0 0 1 connected 0-5460\ndef456 [fe80::1]:6379@16379 slave abc123 0 0 1 connected\n';
    const n = JSON.stringify(redactReply('CLUSTER', 'NODES', s(nodes), { hideAddresses: true }));
    expect(n).not.toMatch(/10\.0\.0\.1|node-a\.internal|fe80/);
    expect(n).toContain('myself,master');
    const shards = { t: 'arr' as const, v: [{ t: 'map' as const, v: [[s('ip'), s('10.0.0.2')], [s('hostname'), s('node-b.internal')], [s('endpoint'), s('node-b.internal')], [s('role'), s('master')]] as [any, any][] }] };
    const sh = JSON.stringify(redactReply('CLUSTER', 'SHARDS', shards, { hideAddresses: true }));
    expect(sh).not.toMatch(/10\.0\.0\.2|node-b/);
    expect(sh).toContain('master');
    const role = { t: 'arr' as const, v: [s('slave'), s('172.16.0.9'), { t: 'int' as const, v: '6379' }, s('connected')] };
    expect(JSON.stringify(redactReply('ROLE', undefined, role, { hideAddresses: true }))).not.toContain('172.16.0.9');
    expect(JSON.stringify(redactReply('ROLE', undefined, role))).toContain('172.16.0.9');
  });
});
