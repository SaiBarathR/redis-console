/** Regression tests for smaller hardening fixes from the security review. */
import { describe, expect, it } from 'vitest';
import { applyCaps, checkGlob, classify, MAX_GLOB_WILDCARDS } from '../../src/policy/policy.ts';
import { kv } from '../../src/redis/reply.ts';
import { sanitizeRedisError } from '../../src/redis/manager.ts';
import { parseDocs } from '../../src/routes/cli.ts';
import { parseFtSearch } from '../../src/routes/modules.ts';
import { startApp, testConfig } from '../helpers.ts';

describe('command names are matched as ASCII only', () => {
  it('Unicode case folding cannot turn an unknown name into a known command', () => {
    // 'ſ' (U+017F) upper-cases to 'S', 'ı' (U+0131) to 'I', 'ß' to 'SS' with String#toUpperCase.
    for (const name of ['ſcan', 'ınfo', 'ßcan', 'get ', 'GET​']) {
      const c = classify([name, 'x'], undefined);
      expect(c.class, name).toBe('blocked');
      expect(c.hint).toBe('Invalid command name.');
    }
    expect(classify([Buffer.from([0x67, 0x65, 0xf4])], undefined).class).toBe('blocked');
    expect(classify(['CLIENT', 'kıll'], undefined).class).toBe('blocked');
    expect(classify(['client', 'list'], undefined)).toMatchObject({ class: 'admin', name: 'CLIENT LIST' });
  });
});

describe('glob complexity limits', () => {
  it('allows ordinary patterns and refuses wildcard-heavy ones', () => {
    expect(() => checkGlob('user:*:session:*')).not.toThrow();
    expect(() => checkGlob('\\*'.repeat(20))).not.toThrow(); // escaped stars are literals
    expect(() => checkGlob('*a'.repeat(MAX_GLOB_WILDCARDS + 1))).toThrow(/wildcards/);
  });
  it('applies to SCAN-family MATCH and PUBSUB CHANNELS in the console', () => {
    expect(() => applyCaps(['SCAN', '0', 'MATCH', '*a'.repeat(9)])).toThrow(/wildcards/);
    expect(() => applyCaps(['HSCAN', 'k', '0', 'match', '*a'.repeat(9), 'COUNT', '10'])).toThrow(/wildcards/);
    expect(() => applyCaps(['PUBSUB', 'channels', '*a'.repeat(9)])).toThrow(/wildcards/);
    expect(() => applyCaps(['SCAN', '0', 'MATCH', 'a*b*', 'COUNT', '10'])).not.toThrow();
  });
});

describe('objects keyed by Redis data have no prototype', () => {
  it('kv keeps "__proto__" as a plain key and never changes the prototype', () => {
    const o = kv([Buffer.from('__proto__'), Buffer.from('x'), Buffer.from('constructor'), Buffer.from('y')]);
    expect(Object.getPrototypeOf(o)).toBeNull();
    expect(Object.keys(o)).toEqual(['__proto__', 'constructor']);
    const nested = kv(['__proto__', { polluted: true }]);
    expect((nested as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
  it('search results keep a "__proto__" field name as data', () => {
    const r = parseFtSearch(new Map<string, unknown>([
      ['total_results', 1],
      ['results', [new Map<string, unknown>([['id', 'doc:1'], ['extra_attributes', ['__proto__', 'p', 'title', 't']]])]],
    ]) as unknown as unknown[]);
    expect(r.docs[0]!.fields).toEqual(JSON.parse('{"__proto__":"p","title":"t"}'));
    expect(JSON.stringify(r.docs[0]!.fields)).toBe('{"__proto__":"p","title":"t"}');
  });
  it('command docs parsing is not affected by "__proto__" keys', () => {
    const docs = parseDocs(['get', ['__proto__', ['x', 1], 'summary', 'Get', 'group', 'string']]);
    expect(docs[0]).toMatchObject({ name: 'GET', summary: 'Get', group: 'string' });
  });
});

describe('error sanitizer input is bounded', () => {
  it('is fast on long, adversarial messages and still hides hosts', () => {
    const evil = 'a.'.repeat(200_000) + 'x';
    const t0 = performance.now();
    const out = sanitizeRedisError(new Error(evil));
    expect(performance.now() - t0).toBeLessThan(200);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(sanitizeRedisError(new Error('failed at redis.internal.example:6379 now'))).toBe('failed at <host> now');
  });
});

describe('only JSON request bodies are parsed', () => {
  it('text/plain bodies (what cross-site forms can send) are refused with 415', async () => {
    const t = await startApp(testConfig());
    try {
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost:4100', 'content-type': 'text/plain' }, payload: '{"username":"a","password":"b"}' });
      expect(r.statusCode).toBe(415);
    } finally {
      await t.close();
    }
  });
});

describe('workbench line and quoting tricks classify what actually runs', async () => {
  const { scriptLines } = await import('../../src/routes/cli.ts');
  const { tokenizeCommandLineBytes } = await import('@rconsole/shared');
  const argvOf = (line: string) => tokenizeCommandLineBytes(line).map((b) => Buffer.from(b));
  it('a lone CR or U+2028 does not start a new command (one command, extra args)', () => {
    for (const script of ['GET a\rFLUSHDB', 'GET a FLUSHDB', 'GET a\u0085FLUSHDB']) {
      const lines = scriptLines(script);
      expect(lines).toHaveLength(1);
      const argv = argvOf(lines[0]!);
      expect(classify(argv, undefined).command).toBe('GET');
      expect(argv.map(String).join(' ')).toContain('FLUSHDB'); // an argument of GET, never a command
    }
  });
  it('comments only hide whole lines; quoted and split names are classified after unquoting', () => {
    expect(scriptLines('# FLUSHDB\n  // FLUSHDB\nPING')).toEqual(['PING']);
    expect(classify(argvOf('F"LUSHDB"'), undefined)).toMatchObject({ command: 'FLUSHDB', class: 'admin', confirm: 'typed' });
    expect(() => argvOf('F"LUSH"DB')).toThrow(/Closing quote/);
    expect(classify(argvOf('"flushall"'), undefined).class).toBe('blocked');
    expect(classify(argvOf('"\\x46LUSHALL"'), undefined).class).toBe('blocked');
    expect(classify(argvOf("'CONFIG' 'SET' dir /tmp"), undefined).class).toBe('blocked');
    expect(classify(argvOf('CONFIG "SET\\x00" dir /tmp'), undefined).class).toBe('blocked');
  });
});

describe('no super-linear parsing on adversarial input (ReDoS)', async () => {
  const { tokenizeCommandLineBytes, tokenizeCommandLine, zKeyRead, zKeyOp, keyFromParam } = await import('@rconsole/shared');
  const { parseMonitorLine } = await import('../../src/routes/pubsub.ts');
  const { injectNonce } = await import('../../src/routes/static.ts');
  const { sensitiveQueryParams } = await import('../../src/app.ts');
  const fast = (f: () => unknown) => {
    const t0 = performance.now();
    try {
      f();
    } catch {
      /* errors are fine, time is what matters */
    }
    return performance.now() - t0;
  };
  it('tokenizer, validators and parsers stay fast at their size limits', () => {
    const n = 100_000;
    const inputs = ['"' + '\\x'.repeat(n / 2), '"' + '\\'.repeat(n), "'" + "\\'".repeat(n / 2), ' '.repeat(n) + 'x', '"a" '.repeat(n / 4), 'a"'.repeat(n / 2)];
    for (const s of inputs) {
      expect(fast(() => tokenizeCommandLineBytes(s))).toBeLessThan(500);
      expect(fast(() => tokenizeCommandLine(s))).toBeLessThan(500);
    }
    expect(fast(() => zKeyRead.safeParse({ key: { enc: 'utf8', data: 'a' }, cursor: '1'.repeat(50_000) + 'x' }))).toBeLessThan(100);
    expect(fast(() => zKeyOp.safeParse({ op: 'zset.add', key: { enc: 'utf8', data: 'k' }, members: [{ member: { enc: 'utf8', data: 'm' }, score: '1'.repeat(50_000) + 'e' }] }))).toBeLessThan(100);
    expect(fast(() => keyFromParam('A'.repeat(100_000) + '!'))).toBeLessThan(100);
    expect(fast(() => sensitiveQueryParams('/api/v1/x?' + 'a%2'.repeat(30_000) + '&k[]=1'))).toBeLessThan(200);
    expect(fast(() => parseMonitorLine('1.0 [0 x] ' + '"\\'.repeat(50_000)))).toBeLessThan(200);
    expect(fast(() => injectNonce('<head>' + '<meta '.repeat(20_000) + '<style'.repeat(20_000), 'n'))).toBeLessThan(500);
  });
});

describe('error text and slowlog clients do not reveal hosts (self-review finding 6)', () => {
  it('TLS errors become a fixed message with the error code only', () => {
    const e = Object.assign(new Error("Hostname/IP does not match certificate's altnames: Host: redis-prod.corp.internal. is not in the cert's altnames: DNS:cache01.corp.internal"), {
      code: 'ERR_TLS_CERT_ALTNAME_INVALID',
    });
    expect(sanitizeRedisError(e)).toBe('TLS connection failed (ERR_TLS_CERT_ALTNAME_INVALID)');
    expect(sanitizeRedisError(Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }))).toBe('TLS connection failed (SELF_SIGNED_CERT_IN_CHAIN)');
    expect(sanitizeRedisError(new Error('unable to verify the first certificate'))).toBe('TLS connection failed');
  });

  it('socket errors lose bare host names; Redis error replies keep their text', async () => {
    expect(sanitizeRedisError(new Error('getaddrinfo failed for redis-prod.corp.internal'))).toBe('getaddrinfo failed for <host>');
    expect(sanitizeRedisError(new Error('Connection to cache01.corp.internal. closed'))).toBe('Connection to <host> closed');
    const { ErrorReply } = await import('redis');
    expect(sanitizeRedisError(new ErrorReply("ERR unknown subcommand 'x'. Try FT.SEARCH HELP."))).toContain('FT.SEARCH');
  });

  it('host-name scrubbing stays linear on hostile input', () => {
    const evil = `${'a.'.repeat(1000)}!`;
    const t0 = performance.now();
    sanitizeRedisError(new Error(evil));
    sanitizeRedisError(new Error(`${'a-'.repeat(999)}.b`.repeat(2)));
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('console SLOWLOG GET hides the client address from non-admins', async () => {
    const { redactReply } = await import('../../src/policy/redactReply.ts');
    const s = (v: string) => ({ t: 'str' as const, v: { enc: 'utf8' as const, data: v } });
    const entry = { t: 'arr' as const, v: [{ t: 'int' as const, v: '1' }, { t: 'int' as const, v: '2' }, { t: 'int' as const, v: '3' }, { t: 'arr' as const, v: [s('GET'), s('k')] }, s('10.1.2.3:51234'), s('app')] };
    const reply = { t: 'arr' as const, v: [entry] };
    const hidden = redactReply('SLOWLOG', 'GET', reply, { hideAddresses: true });
    expect(JSON.stringify(hidden)).not.toContain('10.1.2.3');
    expect(JSON.stringify(hidden)).toContain('<hidden>');
    expect(JSON.stringify(hidden)).toContain('app');
    expect(JSON.stringify(redactReply('SLOWLOG', 'GET', reply, {}))).toContain('10.1.2.3:51234');
  });
});
