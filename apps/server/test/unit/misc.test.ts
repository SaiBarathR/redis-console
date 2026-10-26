import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapRole } from '../../src/auth/oidc.ts';
import { resolveConfig } from '../../src/config.ts';
import { parseCookies, serializeCookie } from '../../src/http/cookies.ts';
import { decodeCursor, encodeCursor, globLiteral, isPureWildcard, scanPage } from '../../src/redis/scan.ts';
import type { Arg, Conn, Target } from '../../src/redis/manager.ts';
import { parseDocs, scriptLines } from '../../src/routes/cli.ts';
import { sanitizeInfo } from '../../src/routes/databases.ts';
import { parseClientList } from '../../src/routes/diagnostics.ts';
import { parseMonitorLine } from '../../src/routes/pubsub.ts';
import { injectNonce } from '../../src/routes/static.ts';
import { startApp, testConfigRaw, type TestApp } from '../helpers.ts';

describe('scan cursors', () => {
  it('node 0 uses the raw cursor; other nodes are prefixed and padded', () => {
    expect(encodeCursor(0, '12345')).toBe('12345');
    expect(encodeCursor(2, '7')).toBe(`2${'7'.padStart(20, '0')}`);
    for (const [n, raw] of [[0, '0'], [0, '18446744073709551615'], [1, '0'], [3, '42'], [12, '18446744073709551615']] as const) {
      expect(decodeCursor(encodeCursor(n, raw))).toEqual({ node: n, raw });
    }
  });
  it('rejects malformed cursors', () => {
    for (const c of ['', '-1', 'abc', '1e5', ' 1', '1'.repeat(41)]) expect(() => decodeCursor(c), c).toThrow(/invalid cursor/);
  });
  it('isPureWildcard', () => {
    for (const m of ['*', '**', '?', '*?*']) expect(isPureWildcard(m)).toBe(true);
    for (const m of ['user:*', 'a', '\\*', 'a[^]*', '[^]*a', '[a-z]\\:*']) expect(isPureWildcard(m)).toBe(false);
    // Self-review finding 3: classes are not literals ([^] matches any character in Redis).
    for (const m of ['[^]*', '[^a]*', '[a-z]*', '[a]*', '*[^]', '[^\\]]*', '[unclosed*', '[]*']) expect(isPureWildcard(m), m).toBe(true);
  });
});

describe('key names scan (v0.2.1)', () => {
  it('globLiteral: a pattern without *, ? or [ is one key name, with \\ escapes resolved', () => {
    expect(globLiteral('user:1001')).toBe('user:1001');
    expect(globLiteral('a\\*b')).toBe('a*b');
    expect(globLiteral('a\\[x\\]')).toBe('a[x]');
    expect(globLiteral('a\\\\b')).toBe('a\\b');
    expect(globLiteral('trailing\\')).toBe('trailing\\');
    expect(globLiteral('only]')).toBe('only]');
    expect(globLiteral('')).toBe('');
    for (const m of ['*', 'user:*', 'a?', 'a[bc]', '\\\\*']) expect(globLiteral(m), m).toBeUndefined();
  });

  /** A fake single-node keyspace of `size` keys answering SCAN with COUNT-sized steps. */
  function fakeConn(size: number, seen: number[] = []): Conn {
    const node: Target = {
      label: 'fake',
      send: async <T,>(args: Arg[]) => {
        const cursor = Number(args[1]);
        const count = Number(args[args.indexOf('COUNT') + 1]);
        seen.push(count);
        const end = Math.min(size, cursor + count);
        const keys = Array.from({ length: end - cursor }, (_, i) => Buffer.from(`k:${cursor + i}`));
        return [String(end >= size ? 0 : end), keys] as T;
      },
    };
    return { ...node, mode: 'standalone', primaries: async () => [node] } as unknown as Conn;
  }
  it('sends COUNT up to 2000 and stops at the scan threshold with the cursor to continue', async () => {
    const seen: number[] = [];
    const page = await scanPage(fakeConn(50_000, seen), { cursor: '0', match: '*', count: 5000, maxKeys: 10_000, maxScanned: 4500, budgetMs: 10_000 });
    expect(seen).toEqual([2000, 2000, 500]);
    expect(page).toMatchObject({ cursor: '4500', scanned: 4500 });
    expect(page.keys).toHaveLength(4500);
    expect(page.stopped).toBeUndefined();
  });
  it('stops at the requested number of names, at the end of the keyspace, or on the byte limit', async () => {
    expect((await scanPage(fakeConn(50_000), { cursor: '0', match: '*', count: 2000, maxKeys: 3000, maxScanned: 100_000, budgetMs: 10_000 })).keys).toHaveLength(3000);
    const all = await scanPage(fakeConn(6013), { cursor: '0', match: '*', count: 2000, maxKeys: 10_000, maxScanned: 10_000, budgetMs: 10_000 });
    expect(all).toMatchObject({ cursor: '0' });
    expect(all.keys).toHaveLength(6013);
    const bytes = await scanPage(fakeConn(50_000), { cursor: '0', match: '*', count: 2000, maxKeys: 10_000, maxScanned: 100_000, budgetMs: 10_000, keepBytes: 100 });
    expect(bytes).toMatchObject({ cursor: '2000', stopped: 'bytes' });
  });
});

describe('parseMonitorLine', () => {
  it('parses timestamp, db, client and argv', () => {
    expect(parseMonitorLine('1700000000.123456 [0 127.0.0.1:5000] "SET" "k" "v"')).toEqual({ t: 1700000000123, db: 0, client: '127.0.0.1:5000', argv: ['SET', 'k', 'v'] });
    expect(parseMonitorLine('1700000000.5 [3 lua] "GET" "x"')).toMatchObject({ db: 3, client: 'lua', argv: ['GET', 'x'] });
    expect(parseMonitorLine('1700000000.5 [0 unix:/tmp/redis.sock] "PING"')).toMatchObject({ client: 'unix:/tmp/redis.sock', argv: ['PING'] });
  });
  it('unescapes quotes and \\xHH', () => {
    expect(parseMonitorLine('1.0 [0 c] "SET" "a\\"b" "\\x41\\x42"')!.argv).toEqual(['SET', 'a"b', 'AB']);
  });
  it('decodes escapes in a single pass (escaped backslash, control characters)', () => {
    // Redis writes a literal backslash followed by "x41" as \\x41: that must stay "\x41", not become "A".
    expect(parseMonitorLine('1.0 [0 c] "SET" "\\\\x41" "a\\nb\\tc\\r"')!.argv).toEqual(['SET', '\\x41', 'a\nb\tc\r']);
  });
  it('truncates arguments to 64 chars and caps the count', () => {
    const long = 'x'.repeat(200);
    const ev = parseMonitorLine(`1.0 [0 c] "SET" "k" "${long}"`)!;
    expect(ev.argv[2]).toBe(`${'x'.repeat(64)}…`);
    const many = Array.from({ length: 100 }, (_, i) => `"a${i}"`).join(' ');
    expect(parseMonitorLine(`1.0 [0 c] ${many}`)!.argv).toHaveLength(64);
  });
  it('returns null for non-monitor lines', () => {
    expect(parseMonitorLine('OK')).toBeNull();
    expect(parseMonitorLine('')).toBeNull();
  });
});

describe('parseDocs', () => {
  const raw = [
    'get',
    ['summary', 'Returns the string value of a key.', 'since', '1.0.0', 'group', 'string', 'complexity', 'O(1)', 'arguments', [['name', 'key', 'type', 'key', 'display_text', 'key', 'key_spec_index', '0']]],
    'client',
    [
      'summary', 'A container for client connection commands.', 'since', '2.4.0', 'group', 'connection',
      'subcommands', [
        'client|kill',
        ['summary', 'Terminates open connections.', 'since', '2.4.0', 'group', 'connection', 'arguments', [
          ['name', 'filter', 'type', 'oneof', 'arguments', [
            ['name', 'id', 'type', 'integer', 'token', 'ID', 'flags', ['optional']],
            ['name', 'addr', 'type', 'string', 'token', 'ADDR', 'flags', ['optional', 'multiple']],
          ]],
        ]],
      ],
    ],
  ];
  it('flattens commands and subcommands with arguments', () => {
    const docs = parseDocs(raw);
    expect(docs.map((d) => d.name)).toEqual(['GET', 'CLIENT', 'CLIENT KILL']);
    expect(docs[0]).toEqual({ name: 'GET', summary: 'Returns the string value of a key.', since: '1.0.0', group: 'string', complexity: 'O(1)', arguments: [{ name: 'key', type: 'key' }] });
    expect(docs[2]!.arguments[0]).toEqual({
      name: 'filter',
      type: 'oneof',
      arguments: [
        { name: 'id', type: 'integer', token: 'ID', optional: true },
        { name: 'addr', type: 'string', token: 'ADDR', optional: true, multiple: true },
      ],
    });
  });
  it('tolerates junk', () => {
    expect(parseDocs(null)).toEqual([]);
    expect(parseDocs(['x'])).toEqual([]);
  });
});

describe('scriptLines', () => {
  it('drops blank lines and comments', () => {
    expect(scriptLines('GET a\n\n  # comment\n// other\r\n  SET b 1  \n')).toEqual(['GET a', 'SET b 1']);
  });
});

describe('parseClientList', () => {
  it('parses CLIENT LIST lines', () => {
    const text = 'id=7 addr=10.0.0.1:5000 laddr=10.0.0.2:6379 fd=8 name=rconsole-admin age=12 idle=3 flags=N db=0 sub=0 cmd=client|list user=rc-admin\nid=9 addr=10.0.0.5:1 name= age=1 idle=0 flags=P db=2 cmd=subscribe user=default\n';
    expect(parseClientList(text)).toEqual([
      { id: '7', addr: '10.0.0.1:5000', name: 'rconsole-admin', age: 12, idle: 3, db: 0, cmd: 'client|list', user: 'rc-admin', flags: 'N' },
      { id: '9', addr: '10.0.0.5:1', name: '', age: 1, idle: 0, db: 2, cmd: 'subscribe', user: 'default', flags: 'P' },
    ]);
    expect(parseClientList('')).toEqual([]);
  });
});

describe('sanitizeInfo', () => {
  it('hides paths, ports, run ids and replica addresses', () => {
    const out = sanitizeInfo({
      server: { redis_version: '8.10.2', executable: '/usr/bin/redis-server', config_file: '/etc/redis.conf', tcp_port: '6379', run_id: 'abc' },
      replication: { role: 'master', master_host: '10.1.1.1', master_port: '6379', slave0: 'ip=10.0.0.9,port=6380,state=online,offset=1,lag=0', master_replid: 'x' },
    });
    expect(out.server).toEqual({ redis_version: '8.10.2' });
    expect(out.replication!.role).toBe('master');
    expect(out.replication!.master_host).toBeUndefined();
    expect(out.replication!.master_port).toBeUndefined();
    expect(out.replication!.master_replid).toBeUndefined();
    expect(out.replication!.slave0).toBe('ip=<hidden>,port=<hidden>,state=online,offset=1,lag=0');
    expect(JSON.stringify(out)).not.toMatch(/10\.0\.0\.9|10\.1\.1\.1|\/etc\/redis/);
  });
});

describe('mapRole', () => {
  const mapping = { 'rconsole-admins': 'admin', 'rconsole-operators': 'operator', 'rconsole-viewers': 'viewer' } as const;
  it('highest mapped role wins', () => {
    expect(mapRole(['rconsole-viewers', 'rconsole-admins', 'rconsole-operators'], mapping)).toBe('admin');
    expect(mapRole(['rconsole-viewers', 'rconsole-operators'], mapping)).toBe('operator');
    expect(mapRole(['other', 'rconsole-viewers'], mapping)).toBe('viewer');
  });
  it('accepts full-path group names', () => {
    expect(mapRole(['/rconsole-operators'], mapping)).toBe('operator');
  });
  it('no matching group -> null (login refused)', () => {
    expect(mapRole([], mapping)).toBeNull();
    expect(mapRole(['admins', 'RCONSOLE-ADMINS'], mapping)).toBeNull();
  });
  it('group names that are Object.prototype members map to nothing (self-review finding 8)', () => {
    for (const g of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '/constructor']) {
      expect(mapRole([g], mapping), g).toBeNull();
      expect(mapRole([g, 'rconsole-viewers'], mapping), g).toBe('viewer');
    }
  });
});

describe('cookies', () => {
  it('serializes secure session cookies', () => {
    expect(serializeCookie('__Host-rc_session', 'abc', { secure: true })).toBe('__Host-rc_session=abc; Path=/; HttpOnly; Secure; SameSite=Strict');
    expect(serializeCookie('rc_oidc', '', { sameSite: 'Lax', maxAgeSeconds: 0 })).toBe('rc_oidc=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    expect(() => serializeCookie('bad name', 'x')).toThrow();
    expect(serializeCookie('n', 'a;b=c')).toMatch(/^n=a%3Bb%3Dc;/);
  });
  it('parses, keeps the first duplicate, tolerates junk', () => {
    expect(parseCookies('a=1; b="2"; a=3; junk; =x; c=%41')).toEqual({ a: '1', b: '2', c: 'A' });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('d=%E0%A4%A')).toEqual({ d: '%E0%A4%A' });
    const proto = parseCookies('__proto__=x; constructor=y');
    expect(proto.__proto__).toBe('x');
    expect(proto.constructor).toBe('y');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('injectNonce', () => {
  it('adds the meta tag after <head> and nonces <style> tags', () => {
    const html = '<!doctype html><html><head><title>x</title><style>a{}</style><style nonce="keep">b{}</style></head><body><header>h</header></body></html>';
    const out = injectNonce(html, 'N0NCE');
    expect(out).toContain('<head><meta name="csp-nonce" content="N0NCE"><title>');
    expect(out).toContain('<style nonce="N0NCE">a{}</style>');
    expect(out).toContain('<style nonce="keep">');
    expect(out.match(/csp-nonce/g)).toHaveLength(1);
    expect(out).toContain('<header>h</header>');
  });
  it('fills the SPA placeholder meta instead of adding a second one (single nonce meta)', () => {
    // apps/web/index.html ships <meta name="csp-nonce" content=""> as a placeholder.
    const html = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="csp-nonce" content=""><title>Redis Console</title></head><body></body></html>';
    const out = injectNonce(html, 'abc+/=');
    expect(out.match(/csp-nonce/g)).toHaveLength(1);
    expect(out).toContain('<head><meta name="csp-nonce" content="abc+/=">');
    const alt = injectNonce("<head><meta content='stale' name='csp-nonce' /></head>", 'n');
    expect(alt.match(/csp-nonce/g)).toHaveLength(1);
    expect(alt).not.toContain('stale');
  });
  it('handles <head> with attributes and documents without one', () => {
    expect(injectNonce('<head lang="en"><x>', 'n')).toBe('<head lang="en"><meta name="csp-nonce" content="n"><x>');
    expect(injectNonce('<header>no head</header>', 'n')).toBe('<meta name="csp-nonce" content="n"><header>no head</header>');
  });
});

describe('static SPA serving', () => {
  let t: TestApp;
  let dir: string;
  beforeAll(async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'rconsole-web-'));
    dir = path.join(parent, 'dist');
    mkdirSync(path.join(dir, 'assets'), { recursive: true });
    // Same shape as the real Vite build of apps/web (placeholder nonce meta, hashed module + stylesheet).
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="csp-nonce" content=""><title>RC</title><script type="module" crossorigin src="/assets/index-AbC123.js"></script><link rel="stylesheet" crossorigin href="/assets/index-DeF456.css"></head><body><div id="root"></div></body></html>');
    writeFileSync(path.join(dir, 'assets', 'index-AbC123.js'), 'console.log(1)');
    writeFileSync(path.join(dir, 'assets', 'index-DeF456.css'), 'body{}');
    symlinkSync(path.join(parent, 'package.json'), path.join(dir, 'assets', 'linked.js'));
    writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>');
    writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    writeFileSync(path.join(parent, 'package.json'), '{"secret":"outside"}');
    const env = { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' };
    t = await startApp(resolveConfig(testConfigRaw({ server: { webDist: dir } }), { env }));
  });
  afterAll(() => t.close());

  const nonceOf = (csp: unknown) => /'nonce-([^']+)'/.exec(String(csp))?.[1];

  it('serves index.html with the per-request nonce at / and SPA routes', async () => {
    for (const url of ['/', '/index.html', '/databases/e2e/keys', '/login?error=oidc_failed']) {
      const r = await t.app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.headers['cache-control']).toBe('no-store');
      const nonce = nonceOf(r.headers['content-security-policy']);
      expect(nonce).toBeTruthy();
      expect(r.body).toContain(`<meta name="csp-nonce" content="${nonce}">`);
      expect(r.body.match(/csp-nonce/g)).toHaveLength(1);
      expect(r.headers['x-frame-options']).toBe('DENY');
    }
    // A fresh nonce on every request.
    const a = await t.app.inject({ method: 'GET', url: '/' });
    const b = await t.app.inject({ method: 'GET', url: '/' });
    expect(nonceOf(a.headers['content-security-policy'])).not.toBe(nonceOf(b.headers['content-security-policy']));
  });

  it('serves the Vite build assets with the right types and caching', async () => {
    const js = await t.app.inject({ method: 'GET', url: '/assets/index-AbC123.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/^text\/javascript/);
    const css = await t.app.inject({ method: 'GET', url: '/assets/index-DeF456.css' });
    expect(css.headers['content-type']).toMatch(/^text\/css/);
    expect(css.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('does not follow symlinks out of the dist directory', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/assets/linked.js' });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('outside');
  });

  it('serves hashed assets with immutable caching and other files with no-cache', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/javascript/);
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(r.headers['content-security-policy']).toBeTruthy();
    const f = await t.app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(f.statusCode).toBe(200);
    expect(f.headers['content-type']).toBe('image/svg+xml');
    expect(f.headers['cache-control']).toBe('no-cache');
  });

  it('missing assets are real 404s, not index.html', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain('csp-nonce');
  });

  it('never shadows /api with the SPA', async () => {
    for (const url of ['/api/v1/nope', '/api', '/api/v1/auth/oidc/nope']) {
      const r = await t.app.inject({ method: 'GET', url });
      expect([401, 404], url).toContain(r.statusCode);
      expect(r.headers['content-type']).toMatch(/application\/json/);
      expect(r.body).not.toContain('<html');
    }
  });

  it('does not escape the dist directory or serve dotfiles', async () => {
    for (const url of ['/../package.json', '/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json', '/..%2fpackage.json', '/.env', '/assets/%2e%2e/.env', '/%00index.html']) {
      const r = await t.app.inject({ method: 'GET', url });
      expect(r.body, url).not.toContain('outside');
      expect(r.body, url).not.toContain('SECRET=1');
    }
  });

  it('non-GET methods on unknown paths are 404', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/some/page', headers: { origin: 'http://localhost:4100', 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(404);
  });
});

describe('without a built SPA', () => {
  it('answers / with a plain-text notice and keeps /api JSON', async () => {
    const env = { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' };
    const t = await startApp(resolveConfig(testConfigRaw({ server: { webDist: path.join(tmpdir(), 'definitely-missing-dist') } }), { env }));
    try {
      const r = await t.app.inject({ method: 'GET', url: '/' });
      expect(r.statusCode).toBe(404);
      expect(r.headers['content-type']).toMatch(/text\/plain/);
      const a = await t.app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
      expect(a.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });
});

describe('static: index.html symlinked out of dist (review L2)', () => {
  it('is not served, at startup or on re-read', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'rconsole-web-'));
    const dir = path.join(parent, 'dist');
    mkdirSync(dir);
    writeFileSync(path.join(parent, 'outside.txt'), 'AUDIT_FAKE_SECRET_OUTSIDE_DIST');
    symlinkSync('../outside.txt', path.join(dir, 'index.html'));
    const env = { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' };
    const t = await startApp(resolveConfig(testConfigRaw({ server: { webDist: dir } }), { env }));
    try {
      for (const url of ['/', '/index.html', '/some/spa/route']) {
        const r = await t.app.inject({ method: 'GET', url });
        expect(r.statusCode, url).not.toBe(200);
        expect(r.body).not.toContain('AUDIT_FAKE_SECRET');
      }
    } finally {
      await t.close();
    }
  });

  it('an index.html swapped for an outside symlink after startup is refused on re-read (development)', async () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'rconsole-web-'));
    const dir = path.join(parent, 'dist');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'index.html'), '<html><head></head><body>ok</body></html>');
    writeFileSync(path.join(parent, 'outside.txt'), 'AUDIT_FAKE_SECRET_OUTSIDE_DIST');
    const env = { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' };
    const t = await startApp(resolveConfig(testConfigRaw({ server: { webDist: dir } }), { env }));
    try {
      expect((await t.app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200);
      const { rmSync } = await import('node:fs');
      rmSync(path.join(dir, 'index.html'));
      symlinkSync('../outside.txt', path.join(dir, 'index.html'));
      const r = await t.app.inject({ method: 'GET', url: '/' });
      expect(r.body).not.toContain('AUDIT_FAKE_SECRET');
      expect(r.statusCode).not.toBe(200);
    } finally {
      await t.close();
    }
  });
});
