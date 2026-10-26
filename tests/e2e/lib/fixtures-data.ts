/**
 * Fixture data for the sandbox-e2e database (dedicated e2e Redis, 127.0.0.1:6431). Seeded fresh by global setup.
 * Tests import key names from here so the UI and API assertions stay in sync.
 */
import { gzipSync, deflateSync } from 'node:zlib';
import { RedisConn, RespError } from './resp.ts';
import { E2E_REDIS, envVar } from './env.ts';

export const XSS_PAYLOADS = [
  '<img src=x onerror="window.__xss=1;alert(1)">',
  '"><script>window.__xss=1;alert(1)</script>',
  "'><svg onload=window.__xss=1;alert(1)>",
  'javascript:window.__xss=1;alert(1)',
  '<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>',
  '{{constructor.constructor("window.__xss=1;alert(1)")()}}',
  '<a href="javascript:alert(1)" id="xss-anchor">click</a>',
  '<style>@import "http://evil.invalid/x.css";</style><b id="xss-bold">bold</b>',
] as const;

export const K = {
  str: 'e2e:string:greeting',
  strTtl: 'e2e:string:with-ttl',
  strJson: 'e2e:string:json',
  strNumber: 'e2e:string:counter',
  hash: 'e2e:hash:user:1',
  list: 'e2e:list:queue',
  set: 'e2e:set:tags',
  zset: 'e2e:zset:leaderboard',
  stream: 'e2e:stream:orders',
  streamGroup: 'g-orders',
  streamConsumer: 'worker-1',
  json: 'e2e:json:profile',
  ts: 'e2e:ts:temperature',
  bloom: 'e2e:bloom:emails',
  big: 'e2e:big:blob',
  bigHash: 'e2e:big:hash',
  bigList: 'e2e:big:list',
  gzip: 'e2e:fmt:gzip-json',
  deflate: 'e2e:fmt:deflate',
  msgpack: 'e2e:fmt:msgpack',
  javaSer: 'e2e:fmt:java-serialized',
  phpSer: 'e2e:fmt:php-serialized',
  binValue: 'e2e:binary:value',
  unicode: 'e2e:unicode:日本語:emoji:🔥',
  rtl: 'e2e:unicode:rtl:‮gnp.exe',
  arabic: 'e2e:unicode:مرحبا-بالعالم',
  zeroWidth: 'e2e:unicode:zero​width',
  xssPrefix: 'e2e:xss:',
  bulkPrefix: 'e2e:bulk:',
  docPrefix: 'e2e:doc:',
  searchIndex: 'idx:e2e:docs',
  scratchPrefix: 'e2e:scratch:',
  prodSimKey: 'e2e:prodsim:config',
  // v0.4 arrays: sparse (gaps, an index above 2^53), read by the role matrix and specs/*/array.spec.ts.
  array: 'e2e:array:sparse',
} as const;

/** A key whose bytes are not valid UTF-8. */
export const BINARY_KEY = Buffer.from([0x65, 0x32, 0x65, 0x3a, 0x62, 0x69, 0x6e, 0x3a, 0x00, 0xff, 0xfe, 0x80, 0x01]);
export const BINARY_VALUE = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x80, 0x81, 0x7f, 0x0a, 0x0d]);
export const BIG_VALUE_BYTES = 2 * 1024 * 1024; // 2 MiB > policy.maxValueBytes (512 KiB)
export const BULK_COUNT = 150;
export const BIG_HASH_FIELDS = 5000;
export const BIG_LIST_ITEMS = 20000;
export const XSS_KEYS = XSS_PAYLOADS.map((p, i) => `${K.xssPrefix}${i}:${p}`);
/** Value marker that must never appear in audit records. */
export const AUDIT_CANARY_VALUE = 'AUDIT-CANARY-VALUE-7f3a9c';

export function e2eAdminConn(db = 0): Promise<RedisConn> {
  return RedisConn.connect({ ...E2E_REDIS, username: 'default', password: envVar('SANDBOX_REDIS_DEFAULT_PASSWORD'), db });
}

function msgpackMap(obj: Record<string, string | number>): Buffer {
  const parts: Buffer[] = [];
  const entries = Object.entries(obj);
  parts.push(Buffer.from([0x80 | entries.length]));
  const str = (s: string) => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([0xa0 | b.length]), b]); };
  for (const [k, v] of entries) {
    parts.push(str(k));
    parts.push(typeof v === 'number' ? Buffer.from([v & 0x7f]) : str(v));
  }
  return Buffer.concat(parts);
}

async function ignore(p: Promise<unknown>): Promise<void> { try { await p; } catch { /* ignore */ } }

export async function seedE2E(): Promise<void> {
  // Prod-simulation database (logical db 1). Seeded FIRST: RediSearch drops every index on a
  // FLUSHDB of any logical database, so db 0 (with the search index) must be flushed last.
  const p = await e2eAdminConn(1);
  try {
    await p.cmdOk(['FLUSHDB']);
    await p.cmdOk(['SET', K.prodSimKey, 'prod-like value']);
    await p.cmdOk(['HSET', 'e2e:prodsim:hash', 'a', '1']);
  } finally {
    p.close();
  }

  const r = await e2eAdminConn(0);
  try {
    await ignore(r.cmd(['FT.DROPINDEX', K.searchIndex]));
    await r.cmdOk(['FLUSHDB']);
    await r.cmdOk(['SLOWLOG', 'RESET']);

    // Strings
    await r.cmdOk(['SET', K.str, 'Hello from Redis Console e2e']);
    await r.cmdOk(['SET', K.strTtl, 'expires later', 'EX', 86400]);
    await r.cmdOk(['SET', K.strJson, JSON.stringify({ id: 42, name: 'Widget', tags: ['a', 'b'], nested: { ok: true } })]);
    await r.cmdOk(['SET', K.strNumber, '100']);

    // Hash / list / set / zset
    await r.cmdOk(['HSET', K.hash, 'name', 'Ada Lovelace', 'email', 'ada@example.test', 'role', 'engineer', 'logins', '42']);
    await r.cmdOk(['RPUSH', K.list, 'job-1', 'job-2', 'job-3', 'job-4', 'job-5']);
    await r.cmdOk(['SADD', K.set, 'red', 'green', 'blue', 'yellow']);
    await r.cmdOk(['ZADD', K.zset, 100, 'alice', 250, 'bob', 75.5, 'carol', 1000, 'dave']);

    // Stream with a consumer group and pending entries
    for (let i = 1; i <= 10; i++) await r.cmdOk(['XADD', K.stream, '*', 'order', `ord-${i}`, 'amount', String(i * 10), 'status', 'new']);
    await r.cmdOk(['XGROUP', 'CREATE', K.stream, K.streamGroup, '0']);
    await r.cmdOk(['XREADGROUP', 'GROUP', K.streamGroup, K.streamConsumer, 'COUNT', 4, 'STREAMS', K.stream, '>']);
    await r.cmdOk(['XGROUP', 'CREATE', K.stream, 'g-analytics', '$']);

    // Modules: JSON, TimeSeries, Bloom, Search
    await r.cmdOk(['JSON.SET', K.json, '$', JSON.stringify({ user: 'grace', langs: ['COBOL', 'FLOW-MATIC'], address: { city: 'Arlington', zip: '22201' }, active: true, score: 99.5 })]);
    await r.cmdOk(['TS.CREATE', K.ts, 'RETENTION', 0, 'LABELS', 'sensor', 'e2e', 'unit', 'celsius']);
    const now = Date.now();
    for (let i = 60; i >= 0; i--) await r.cmdOk(['TS.ADD', K.ts, now - i * 60_000, (20 + Math.sin(i / 5) * 5).toFixed(2)]);
    await r.cmdOk(['BF.RESERVE', K.bloom, '0.01', 1000]);
    await r.cmdOk(['BF.MADD', K.bloom, 'a@example.test', 'b@example.test', 'c@example.test']);
    for (let i = 1; i <= 20; i++) await r.cmdOk(['HSET', `${K.docPrefix}${i}`, 'title', i % 2 ? `Red widget ${i}` : `Blue gadget ${i}`, 'price', String(i * 3), 'category', i % 3 ? 'tools' : 'toys']);
    await r.cmdOk(['FT.CREATE', K.searchIndex, 'ON', 'HASH', 'PREFIX', 1, K.docPrefix, 'SCHEMA', 'title', 'TEXT', 'price', 'NUMERIC', 'SORTABLE', 'category', 'TAG']);

    // Formatter fixtures
    await r.cmdOk(['SET', K.gzip, gzipSync(Buffer.from(JSON.stringify({ compressed: true, payload: 'gzip works' })))]);
    await r.cmdOk(['SET', K.deflate, deflateSync(Buffer.from('deflated text payload'))]);
    await r.cmdOk(['SET', K.msgpack, msgpackMap({ kind: 'msgpack', n: 7 })]);
    await r.cmdOk(['SET', K.javaSer, Buffer.concat([Buffer.from([0xac, 0xed, 0x00, 0x05, 0x73, 0x72]), Buffer.from('java.util.HashMap')])]);
    await r.cmdOk(['SET', K.phpSer, 'a:2:{s:3:"foo";s:3:"bar";s:3:"num";i:5;}']);

    // Binary key and value
    await r.cmdOk(['SET', BINARY_KEY, 'value of a binary key']);
    await r.cmdOk(['SET', K.binValue, BINARY_VALUE]);

    // Huge values
    await r.cmdOk(['SET', K.big, Buffer.alloc(BIG_VALUE_BYTES, 0x61)]);
    const hargs: (string | number)[] = ['HSET', K.bigHash];
    for (let i = 0; i < BIG_HASH_FIELDS; i++) hargs.push(`field-${i}`, `value-${i}`);
    await r.cmdOk(hargs);
    for (let off = 0; off < BIG_LIST_ITEMS; off += 2000) {
      const largs: (string | number)[] = ['RPUSH', K.bigList];
      for (let i = off; i < off + 2000; i++) largs.push(`item-${i}`);
      await r.cmdOk(largs);
    }

    // XSS payloads in keys, values, hash fields, list items, stream fields, JSON
    for (const [i, p] of XSS_PAYLOADS.entries()) {
      await r.cmdOk(['SET', XSS_KEYS[i]!, p]);
    }
    await r.cmdOk(['HSET', `${K.xssPrefix}hash`, ...XSS_PAYLOADS.flatMap((p, i) => [`${p}#${i}`, p])]);
    await r.cmdOk(['RPUSH', `${K.xssPrefix}list`, ...XSS_PAYLOADS]);
    await r.cmdOk(['SADD', `${K.xssPrefix}set`, ...XSS_PAYLOADS]);
    await r.cmdOk(['ZADD', `${K.xssPrefix}zset`, ...XSS_PAYLOADS.flatMap((p, i) => [i, p])]);
    await r.cmdOk(['XADD', `${K.xssPrefix}stream`, '*', ...XSS_PAYLOADS.flatMap((p) => [p, p])]);
    await r.cmdOk(['JSON.SET', `${K.xssPrefix}json`, '$', JSON.stringify({ html: XSS_PAYLOADS[0], list: XSS_PAYLOADS.slice(1) })]);

    // v0.4 arrays (Redis 8.8+): a sparse array and the XSS payloads as array values.
    await r.cmdOk(['ARSET', K.array, 0, 'alpha', 'beta', 'gamma']);
    await r.cmdOk(['ARSET', K.array, 1000, 'thousand']);
    await r.cmdOk(['ARSET', K.array, '9007199254740993', 'beyond 2^53']);
    await r.cmdOk(['ARSET', `${K.xssPrefix}array`, 0, ...XSS_PAYLOADS]);

    // Unicode / RTL
    await r.cmdOk(['SET', K.unicode, 'こんにちは世界 🔥🚀 — ünïcödé']);
    await r.cmdOk(['SET', K.rtl, 'RTL override ‮txt.exe‬ and Hebrew שלום']);
    await r.cmdOk(['HSET', K.arabic, 'تحية', 'مرحبا بالعالم', 'emoji', '👩‍💻']);
    await r.cmdOk(['SET', K.zeroWidth, 'zero​width‍value']);

    // Bulk keys
    for (let i = 0; i < BULK_COUNT; i++) await r.cmdOk(['SET', `${K.bulkPrefix}${String(i).padStart(4, '0')}`, `bulk-${i}`]);

    // Slow command so the slowlog has an entry (slowlog-log-slower-than 1000us).
    await ignore(r.cmd(['DEBUG', 'SLEEP', '0.01']));
    await r.cmd(['SORT', K.bigList, 'ALPHA', 'LIMIT', 0, 1]);
  } finally {
    r.close();
  }
}

/** Runs a command directly on the e2e Redis (default user) — used to verify UI/API side effects. */
export async function redisExec<T = unknown>(args: (string | Buffer | number)[], db = 0): Promise<T> {
  const c = await e2eAdminConn(db);
  try {
    const v = await c.raw(args);
    if (v instanceof RespError) throw new Error(v.message);
    return v as T;
  } finally {
    c.close();
  }
}
