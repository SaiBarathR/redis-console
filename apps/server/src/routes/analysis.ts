/**
 * Memory analysis (v0.2.1, RI parity F4): the bounded sampling analysis, the recommendation rules that turn it into
 * a diagnosis, and analysis jobs with progress and cancellation. Every recommendation is about the sample only and
 * says so (`affected` of `basis` sampled keys, plus the report's coverage); none claims a database-wide fact.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ANALYSIS_RULES,
  binFromBytes,
  zAnalysisRequest,
  zJobCancel,
  type AnalysisCoverage,
  type AnalysisJob,
  type AnalysisRecommendation,
  type AnalysisReport,
  type Bin,
} from '@rconsole/shared';
import { audit, dbScope, parse, rateLimit, sessionStillValid, type AppContext, type DbScope } from '../context.ts';
import { HttpError } from '../http/errors.ts';
import { toHttpError } from '../redis/exec.ts';
import { TM_STR, type Conn, type Target } from '../redis/manager.ts';
import { asNum, asStr } from '../redis/reply.ts';
import { replyTooLarge } from '../redis/resp.ts';
import { dbSize, scanPage } from '../redis/scan.ts';

const LENGTH_CMD: Record<string, string> = { string: 'STRLEN', hash: 'HLEN', list: 'LLEN', set: 'SCARD', zset: 'ZCARD', stream: 'XLEN' };
/** Namespace segments that name short-lived data: keys under them usually should expire. */
const CACHE_SEGMENT = /^(cache|caches|cached|session|sessions|sess|tmp|temp|lock|locks|ratelimit|rate-limit|rate_limit|throttle|otp|token|tokens|nonce|csrf|verify|verification|reset|idempotency)$/i;
const MAX_NAMESPACES = 5000;
const MAX_EXPIRY_BUCKETS = 500;
const MAX_JSON_PROBES = 200;
/** Probe reads are bounded to this many bytes on the measured transport (a fixed server constant). */
const PROBE_BYTES = 4096;
const EXAMPLES = 10;

interface KeyMeta { k: Buffer; type: string; bytes: number; t: number; length: number }
type Example = AnalysisRecommendation['keys'][number];

/** Accumulates what the rules need while keys stream past; bounded independently of the sample size. */
export class RuleState {
  readonly delimiter: string;
  readonly readAt: number;
  sampled = 0;
  withTtl = 0;
  nameBytes = 0;
  bigKeys = { count: 0, top: [] as Example[] };
  manyFields = { count: 0, top: [] as Example[] };
  largeCollections = { count: 0, top: [] as Example[] };
  longNames = { count: 0, top: [] as Example[] };
  json = { probed: 0, candidates: 0, count: 0, top: [] as Example[] };
  /** Namespace (key up to its last delimiter) -> counts. */
  namespaces = new Map<string, { keys: number; noExpiry: number; cacheLike: boolean; hash: number; json: number }>();
  noTtlExamples: { ns: string; ex: Example }[] = [];
  buckets = new Map<number, { count: number; examples: Example[] }>();
  /** Bytes of key names kept for examples (charged to the report's key-name budget). */
  keep: (n: number) => void;
  constructor(delimiter: string, readAt: number, keep: (n: number) => void = () => {}) {
    this.delimiter = delimiter;
    this.readAt = readAt;
    this.keep = keep;
  }

  #push(list: Example[], ex: Example, score: (e: Example) => number, k: Buffer) {
    if (list.length >= EXAMPLES && score(ex) <= score(list[list.length - 1]!)) return;
    this.keep(k.length);
    list.push(ex);
    list.sort((a, b) => score(b) - score(a));
    if (list.length > EXAMPLES) list.pop();
  }

  namespaceOf(k: Buffer): string | undefined {
    if (!this.delimiter) return undefined;
    const d = Buffer.from(this.delimiter, 'utf8');
    const i = k.lastIndexOf(d);
    if (i <= 0) return undefined;
    const ns = k.subarray(0, i + d.length);
    // Namespaces are shown and handed to the index wizard as text: only valid UTF-8 ones are tracked.
    const text = ns.toString('utf8');
    return Buffer.byteLength(text) === ns.length && ns.length <= 256 ? text : undefined;
  }

  add(m: KeyMeta) {
    this.sampled++;
    this.nameBytes += m.k.length;
    const ex: Example = { key: binFromBytes(m.k), type: m.type, bytes: m.bytes, ...(m.length ? { length: m.length } : {}), ttl: m.t };
    if (m.bytes >= ANALYSIS_RULES.bigKeyBytes || (m.type === 'string' && m.bytes >= ANALYSIS_RULES.bigStringBytes)) {
      this.bigKeys.count++;
      this.#push(this.bigKeys.top, ex, (e) => e.bytes ?? 0, m.k);
    }
    if (m.type === 'hash' && m.length >= ANALYSIS_RULES.hashManyFields) {
      this.manyFields.count++;
      this.#push(this.manyFields.top, ex, (e) => e.length ?? 0, m.k);
    }
    if ((m.type === 'list' || m.type === 'set' || m.type === 'zset') && m.length >= ANALYSIS_RULES.largeCollection) {
      this.largeCollections.count++;
      this.#push(this.largeCollections.top, ex, (e) => e.length ?? 0, m.k);
    }
    if (m.k.length >= ANALYSIS_RULES.longKeyNameBytes) {
      this.longNames.count++;
      if (this.longNames.top.length < EXAMPLES) {
        this.keep(m.k.length);
        this.longNames.top.push(ex);
      }
    }
    if (m.t > 0) {
      this.withTtl++;
      const bucket = Math.floor((this.readAt + m.t * 1000) / ANALYSIS_RULES.expiryWindowMs);
      let b = this.buckets.get(bucket);
      if (!b && this.buckets.size < MAX_EXPIRY_BUCKETS * 4) this.buckets.set(bucket, (b = { count: 0, examples: [] }));
      if (b) {
        b.count++;
        if (b.examples.length < 5 && this.buckets.size <= MAX_EXPIRY_BUCKETS) {
          this.keep(m.k.length);
          b.examples.push(ex);
        }
      }
    }
    const ns = this.namespaceOf(m.k);
    if (ns !== undefined) {
      let n = this.namespaces.get(ns);
      if (!n && this.namespaces.size < MAX_NAMESPACES) {
        this.keep(Buffer.byteLength(ns));
        const segments = ns.split(this.delimiter).filter(Boolean);
        this.namespaces.set(ns, (n = { keys: 0, noExpiry: 0, cacheLike: segments.some((s) => CACHE_SEGMENT.test(s)), hash: 0, json: 0 }));
      }
      if (n) {
        n.keys++;
        if (m.t === -1) n.noExpiry++;
        if (m.type === 'hash') n.hash++;
        if (m.type === 'ReJSON-RL') n.json++;
        if (m.t === -1 && this.noTtlExamples.length < 200) {
          this.keep(m.k.length);
          this.noTtlExamples.push({ ns, ex });
        }
      }
    }
  }

  /** A string that is at least `jsonStringMinBytes` in memory and worth probing for a JSON document. */
  wantsJsonProbe(m: KeyMeta): boolean {
    if (m.type !== 'string' || m.bytes < ANALYSIS_RULES.jsonStringMinBytes) return false;
    this.json.candidates++;
    return this.json.probed < MAX_JSON_PROBES;
  }

  jsonProbed(m: KeyMeta, head: Buffer | undefined) {
    this.json.probed++;
    if (head && looksLikeJson(head)) {
      this.json.count++;
      this.#push(this.json.top, { key: binFromBytes(m.k), type: m.type, bytes: m.bytes, ttl: m.t }, (e) => e.bytes ?? 0, m.k);
    }
  }
}

/** The first bytes of a value look like the start of a JSON object or array. */
export function looksLikeJson(head: Buffer): boolean {
  const s = head.toString('utf8').replace(/^﻿/, '').trimStart();
  return /^\{\s*("|\})/.test(s) || /^\[\s*(["{[\]\d-]|true|false|null)/.test(s);
}

const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(part / whole < 0.1 ? 1 : 0)}%` : '0%');
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

/** Turn the accumulated sample into recommendations, most severe first. */
export function recommend(s: RuleState): AnalysisRecommendation[] {
  const out: AnalysisRecommendation[] = [];
  const basis = s.sampled;
  if (!basis) return out;
  const R = ANALYSIS_RULES;
  if (s.bigKeys.count) {
    out.push({
      id: 'bigKeys', severity: s.bigKeys.count >= 10 || (s.bigKeys.top[0]?.bytes ?? 0) >= 16 * R.bigKeyBytes ? 'high' : 'medium',
      title: `${count(s.bigKeys.count, 'big key')} in the sample`,
      detail: `${count(s.bigKeys.count, 'sampled key')} use at least ${mb(R.bigKeyBytes)} (strings: at least ${(R.bigStringBytes / 1000).toFixed(0)} kB). Big keys block Redis while they are read, written, expired or deleted, and make replication and failover slower.`,
      action: 'Split big values into smaller keys or a hash of parts; read collections with ranges or SCAN-family commands; delete them with UNLINK (non-blocking), not DEL.',
      affected: s.bigKeys.count, basis, keys: s.bigKeys.top,
    });
  }
  if (s.manyFields.count) {
    out.push({
      id: 'hashTooManyFields', severity: (s.manyFields.top[0]?.length ?? 0) >= 100_000 ? 'high' : 'medium',
      title: `${count(s.manyFields.count, 'hash', 'hashes')} with ${R.hashManyFields.toLocaleString('en-US')} or more fields`,
      detail: `${count(s.manyFields.count, 'sampled hash', 'sampled hashes')} hold at least ${R.hashManyFields.toLocaleString('en-US')} fields. HGETALL on them is slow and returns a large reply; they use the hashtable encoding rather than the compact listpack.`,
      action: 'Shard the hash into buckets (for example by a hash of the field into 100–1,000 keys), and read fields with HGET, HMGET or HSCAN instead of HGETALL.',
      affected: s.manyFields.count, basis, keys: s.manyFields.top,
    });
  }
  if (s.largeCollections.count) {
    out.push({
      id: 'largeCollections', severity: 'medium',
      title: `${count(s.largeCollections.count, 'list, set or sorted set', 'lists, sets or sorted sets')} with ${R.largeCollection.toLocaleString('en-US')} or more elements`,
      detail: `${count(s.largeCollections.count, 'sampled collection')} hold at least ${R.largeCollection.toLocaleString('en-US')} elements. Whole-collection reads (SMEMBERS, LRANGE 0 -1, ZRANGE 0 -1) on them are slow and large.`,
      action: 'Read with ranges (LRANGE, ZRANGE with LIMIT) or SSCAN/ZSCAN; trim lists that are used as logs (LTRIM, or capped streams with XADD MAXLEN).',
      affected: s.largeCollections.count, basis, keys: s.largeCollections.top,
    });
  }
  // No-TTL keys where they look like cache data: cache-like namespaces, or namespaces where most keys expire.
  const flagged: { prefix: string; keys: number; noExpiry: number }[] = [];
  for (const [prefix, n] of s.namespaces) {
    if (!n.noExpiry) continue;
    const mostlyExpire = n.keys >= 20 && (n.keys - n.noExpiry) / n.keys >= 0.8;
    if (n.cacheLike || mostlyExpire) flagged.push({ prefix, keys: n.keys, noExpiry: n.noExpiry });
  }
  if (flagged.length) {
    flagged.sort((a, b) => b.noExpiry - a.noExpiry);
    const affected = flagged.reduce((t, f) => t + f.noExpiry, 0);
    const names = new Set(flagged.slice(0, 50).map((f) => f.prefix));
    out.push({
      id: 'noTtlCacheKeys', severity: affected >= 100 ? 'high' : 'medium',
      title: `${count(affected, 'cache-like key')} without an expiry`,
      detail: `${count(affected, 'sampled key')} in ${count(flagged.length, 'namespace')} have no TTL although their namespace looks like cache, session or lock data, or most of its other keys expire. Keys without a TTL in a cache are never evicted under the noeviction policy and grow memory without bound.`,
      action: 'Give cache entries a TTL when they are written (SET … EX, EXPIRE; in Spring, a time-to-live on the cache configuration). For keys that already exist, set a TTL in the key browser or with EXPIRE.',
      affected, basis,
      keys: s.noTtlExamples.filter((e) => names.has(e.ns)).slice(0, EXAMPLES).map((e) => e.ex),
      prefixes: flagged.slice(0, 20),
    });
  }
  if (s.json.count) {
    out.push({
      id: 'stringJsonCouldBeRedisJson', severity: 'low', module: 'json',
      title: `${count(s.json.count, 'large string')} holding JSON`,
      detail: `${count(s.json.count, 'sampled string')} of at least ${R.jsonStringMinBytes.toLocaleString('en-US')} bytes start like a JSON document (${s.json.probed.toLocaleString('en-US')} of ${s.json.candidates.toLocaleString('en-US')} large strings were checked). Updating one property of such a string means reading and rewriting all of it.`,
      action: 'Store documents with RedisJSON (JSON.SET) to read and update single paths (JSON.GET key $.path, JSON.SET key $.path), or as a hash when the document is flat. A RedisJSON document can also be indexed for search.',
      affected: s.json.count, basis: s.json.probed, keys: s.json.top,
    });
  }
  let busiest: [number, { count: number; examples: Example[] }] | undefined;
  for (const entry of s.buckets) if (!busiest || entry[1].count > busiest[1].count) busiest = entry;
  if (busiest && busiest[1].count >= Math.max(R.expiryMinKeys, Math.ceil(s.withTtl * 0.1))) {
    const at = busiest[0] * R.expiryWindowMs;
    out.push({
      id: 'keysExpiringEnMasse', severity: busiest[1].count >= 1000 ? 'high' : 'medium',
      title: `${count(busiest[1].count, 'key')} expire within the same minute`,
      detail: `${count(busiest[1].count, 'sampled key')} (${pct(busiest[1].count, s.withTtl)} of the sampled keys with a TTL) expire in one ${R.expiryWindowMs / 1000}-second window starting at ${new Date(at).toISOString()}. When cache entries expire together, every client misses at once and reloads them from the backend (a cache stampede).`,
      action: 'Add random jitter to TTLs when writing (for example TTL ± 10%), or refresh popular entries before they expire.',
      affected: busiest[1].count, basis, keys: busiest[1].examples, at,
    });
  }
  const avgName = s.nameBytes / basis;
  if ((s.longNames.count >= 10 && s.longNames.count / basis >= 0.01) || avgName >= 100) {
    out.push({
      id: 'longKeyNames', severity: 'low',
      title: avgName >= 100 ? `Key names average ${Math.round(avgName)} bytes` : `${count(s.longNames.count, 'key name')} of ${R.longKeyNameBytes} bytes or more`,
      detail: `${count(s.longNames.count, 'sampled key')} have names of at least ${R.longKeyNameBytes} bytes; the average sampled name is ${Math.round(avgName)} bytes. Every key name is stored in memory, in the replication stream and in each command.`,
      action: 'Shorten namespaces and identifiers (for example hash long natural keys), keeping names readable.',
      affected: s.longNames.count, basis, keys: s.longNames.top,
    });
  }
  const searchable: { prefix: string; on: 'HASH' | 'JSON'; keys: number }[] = [];
  for (const [prefix, n] of s.namespaces) {
    if (n.hash >= R.searchableMinKeys) searchable.push({ prefix, on: 'HASH', keys: n.hash });
    if (n.json >= R.searchableMinKeys) searchable.push({ prefix, on: 'JSON', keys: n.json });
  }
  searchable.sort((a, b) => b.keys - a.keys);
  for (const ns of searchable.slice(0, 3)) {
    out.push({
      id: 'searchableNamespace', severity: 'low', module: 'search',
      title: `${count(ns.keys, ns.on === 'HASH' ? 'hash' : 'JSON document', ns.on === 'HASH' ? 'hashes' : 'JSON documents')} under ${ns.prefix}`,
      detail: `${count(ns.keys, 'sampled key')} under this namespace are ${ns.on === 'HASH' ? 'hashes' : 'JSON documents'}. Finding one by a field value today means scanning keys.`,
      action: 'Make them searchable: create a search index on this prefix (the wizard samples the fields and shows the FT.CREATE it will run), then query by field.',
      affected: ns.keys, basis, keys: [], prefixes: [{ prefix: ns.prefix, keys: ns.keys }], search: { prefix: ns.prefix, on: ns.on },
    });
  }
  const order = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

export interface AnalyzeHooks {
  signal?: AbortSignal | undefined;
  onProgress?: (p: { sampled: number; scanned: number; dbSize: number }) => void;
  /** Checked between pages: false ends the analysis (the actor was revoked). */
  stillValid?: () => boolean;
}

/**
 * SCAN pages are sampled and dropped, so each SCAN reply is capped on its own (review v0.2 r4 M2). What the report
 * keeps (key names in the top lists and examples, prefixes) shares one `cap`-byte budget instead.
 */
export async function analyze(conn: Conn, o: { sampleSize: number; match: string; delimiter: string }, maxMs: number, cap: number, hooks: AnalyzeHooks = {}): Promise<AnalysisReport> {
  const start = Date.now();
  const nodes: Target[] = await conn.primaries();
  const byType = new Map<string, { keys: number; bytes: number }>();
  const prefixes = new Map<string, { keys: number; bytes: number }>();
  const bySize: AnalysisReport['topKeysBySize'] = [];
  const byLength: AnalysisReport['topKeysByLength'] = [];
  const ttl = { noExpiry: 0, lt1h: 0, lt1d: 0, lt7d: 0, gt7d: 0 };
  let sampled = 0, total = 0, cursor = '0', kept = 0, scanned = 0;
  let stoppedBy: AnalysisCoverage['stoppedBy'] = 'complete';
  const TOP = 50;
  const keptBytes = new Map<object, number>();
  const keep = (n: number) => {
    kept += n;
    if (kept > cap) throw replyTooLarge(cap, `The analysis report's key names exceeded ${cap} bytes; narrow the match pattern.`);
  };
  const rules = new RuleState(o.delimiter, start, keep);
  const pushTop = <T extends object>(arr: T[], item: T, score: (x: T) => number, bytes: number) => {
    if (arr.length < TOP) arr.push(item);
    else if (score(item) > score(arr[arr.length - 1]!)) {
      kept -= keptBytes.get(arr[arr.length - 1]!) ?? 0;
      keptBytes.delete(arr[arr.length - 1]!);
      arr[arr.length - 1] = item;
    } else return;
    keep(bytes);
    keptBytes.set(item, bytes);
    arr.sort((a, b) => score(b) - score(a));
  };
  const signal = hooks.signal;
  const stopped = () => {
    if (signal?.aborted) return 'cancelled' as const;
    if (hooks.stillValid && !hooks.stillValid()) throw new HttpError('unauthenticated', 'Your session ended or your account changed; the analysis stopped.');
    return undefined;
  };

  // The keyspace size when the analysis starts (the denominator of its coverage).
  const size = await dbSize(conn).catch(() => 0);
  hooks.onProgress?.({ sampled, scanned, dbSize: size });
  do {
    if (stopped()) {
      stoppedBy = 'cancelled';
      break;
    }
    let page: Awaited<ReturnType<typeof scanPage>>;
    try {
      page = await scanPage(conn, { cursor, match: o.match, count: 1000, maxKeys: Math.min(1000, o.sampleSize - sampled), budgetMs: 250, pageBytes: cap }, nodes);
    } catch (e) {
      // Cancelled while a SCAN was in flight: report what was sampled so far.
      if (signal?.aborted) {
        stoppedBy = 'cancelled';
        break;
      }
      throw e;
    }
    cursor = page.cursor;
    scanned += page.scanned;
    const keys = page.keys.slice(0, o.sampleSize - sampled);
    for (let i = 0; i < keys.length; i += 250) {
      if (signal?.aborted) break;
      const meta = await Promise.all(
        keys.slice(i, i + 250).map(async (k): Promise<KeyMeta> => {
          const opts = { key: k, readonly: true, timeout: 5000, signal };
          const [type, bytes, t] = await Promise.all([
            conn.send(['TYPE', k], { ...opts, typeMapping: TM_STR }).then(asStr, () => 'unknown'),
            conn.send(['MEMORY', 'USAGE', k], opts).then(asNum, () => 0),
            conn.send(['TTL', k], opts).then(asNum, () => -2),
          ]);
          const lc = LENGTH_CMD[type];
          const length = lc ? await conn.send([lc, k], opts).then(asNum, () => 0) : 0;
          return { k, type, bytes, t, length };
        }),
      );
      for (const m of meta) {
        if (m.t === -2) continue; // expired meanwhile
        sampled++;
        total += m.bytes;
        const bt = byType.get(m.type) ?? { keys: 0, bytes: 0 };
        bt.keys++;
        bt.bytes += m.bytes;
        byType.set(m.type, bt);
        const keyStr = m.k.toString('latin1');
        const di = o.delimiter ? keyStr.indexOf(o.delimiter) : -1;
        const prefix = di > 0 ? Buffer.from(keyStr.slice(0, di), 'latin1').toString('utf8') + o.delimiter : '(no prefix)';
        const pf = prefixes.get(prefix) ?? { keys: 0, bytes: 0 };
        pf.keys++;
        pf.bytes += m.bytes;
        if (prefixes.has(prefix)) prefixes.set(prefix, pf);
        else if (prefixes.size < 10_000) {
          keep(Buffer.byteLength(prefix));
          prefixes.set(prefix, pf);
        }
        pushTop(bySize, { key: binFromBytes(m.k), type: m.type, bytes: m.bytes, ttl: m.t }, (x) => x.bytes, m.k.length);
        if (m.length) pushTop(byLength, { key: binFromBytes(m.k), type: m.type, length: m.length }, (x) => x.length, m.k.length);
        if (m.t === -1) ttl.noExpiry++;
        else if (m.t < 3600) ttl.lt1h++;
        else if (m.t < 86_400) ttl.lt1d++;
        else if (m.t < 7 * 86_400) ttl.lt7d++;
        else ttl.gt7d++;
        rules.add(m);
        // Large strings: read their first bytes (bounded, measured) to see whether they hold a JSON document.
        if (rules.wantsJsonProbe(m) && !signal?.aborted) {
          const head = await conn
            .send<Buffer>(['GETRANGE', m.k, '0', '63'], { key: m.k, readonly: true, timeout: 5000, maxBytes: PROBE_BYTES, signal })
            .then((b) => (Buffer.isBuffer(b) ? b : Buffer.from(asStr(b))), () => undefined);
          rules.jsonProbed(m, head);
        }
      }
      hooks.onProgress?.({ sampled, scanned, dbSize: size });
    }
    if (signal?.aborted) stoppedBy = 'cancelled';
    else if (cursor !== '0' && sampled >= o.sampleSize) stoppedBy = 'sampleLimit';
    else if (cursor !== '0' && Date.now() - start >= maxMs) stoppedBy = 'timeLimit';
  } while (cursor !== '0' && sampled < o.sampleSize && Date.now() - start < maxMs && !signal?.aborted);

  return {
    sampled,
    dbSize: size,
    durationMs: Date.now() - start,
    totalSampledBytes: total,
    byType: [...byType].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.bytes - a.bytes),
    topKeysBySize: bySize,
    topKeysByLength: byLength,
    prefixes: [...prefixes].map(([prefix, v]) => ({ prefix, ...v })).sort((a, b) => b.bytes - a.bytes).slice(0, 100),
    ttl,
    recommendations: recommend(rules),
    coverage: { sampled, dbSize: size, complete: cursor === '0' && stoppedBy !== 'cancelled', stoppedBy: cursor === '0' && stoppedBy !== 'cancelled' ? 'complete' : stoppedBy },
  };
}

// ---------------------------------------------------------------------------
// Jobs

/** Finished jobs stay readable this long; each account keeps at most this many, across its sessions. */
export const ANALYSIS_JOB_RETAIN_MS = 10 * 60_000;
export const MAX_ANALYSIS_JOBS_PER_USER = 5;
/** Jobs held server-wide; a full table drops the oldest finished report (review v0.2.1 F2). */
export const MAX_ANALYSIS_JOBS = 64;
/** Finished reports held for polling, all sessions together; the oldest are dropped beyond it. */
export const ANALYSIS_RETAINED_BYTES = 32 * 1024 * 1024;

interface Job {
  view: AnalysisJob;
  userId: string;
  sessionHash: string;
  databaseId: string;
  abort: AbortController;
  finishedAt?: number;
  /** Approximate JSON size of the finished view (retention budget). */
  bytes?: number;
}

/** Holds the per-user and global analysis slots (shared with the synchronous POST /analysis). */
export function analysisSlots(ctx: AppContext, userId: string): () => void {
  const release = ctx.slots.acquire(`analysis:${userId}`, 1);
  if (!release) throw new HttpError('rate_limited', 'An analysis is already running for you; wait for it to finish or cancel it.');
  const global = ctx.slots.acquire('analysis:global', 4);
  if (!global) {
    release();
    throw new HttpError('rate_limited', 'Too many analyses are running; try again shortly.');
  }
  return () => {
    release();
    global();
  };
}

export function registerAnalysisJobRoutes(app: FastifyInstance, ctx: AppContext) {
  const { policy } = ctx.config;
  const jobs = new Map<string, Job>();
  const sweep = () => {
    const now = Date.now();
    for (const [id, j] of jobs) if (j.finishedAt && now - j.finishedAt > ANALYSIS_JOB_RETAIN_MS) jobs.delete(id);
    // Bound what finished reports keep in memory: drop the oldest first.
    let held = 0;
    for (const j of jobs.values()) held += j.bytes ?? 0;
    for (const [id, j] of [...jobs].filter(([, x]) => x.finishedAt).sort((a, b) => a[1].finishedAt! - b[1].finishedAt!)) {
      if (held <= ANALYSIS_RETAINED_BYTES) break;
      held -= j.bytes ?? 0;
      jobs.delete(id);
    }
  };
  const find = (req: FastifyRequest, scope: DbScope): Job => {
    sweep();
    const id = (req.params as { id?: string }).id ?? '';
    const j = jobs.get(id);
    // Another session's (or database's) job is indistinguishable from a missing one.
    if (!j || j.sessionHash !== scope.session.idHash || j.databaseId !== scope.db.id) throw new HttpError('not_found', 'No such analysis job (it may have expired).');
    return j;
  };
  ctx.streams.add(() => {
    for (const j of jobs.values()) j.abort.abort(new Error('server shutting down'));
  });

  /** Drops the oldest finished job among `held`; false when every one of them is still running. */
  const dropOldestFinished = (held: Job[]): boolean => {
    const oldest = held.filter((j) => j.finishedAt).sort((a, b) => a.finishedAt! - b.finishedAt!)[0];
    if (oldest) jobs.delete(oldest.view.id);
    return !!oldest;
  };

  app.post('/api/v1/databases/:db/analysis/jobs', { bodyLimit: 64 * 1024 }, async (req): Promise<AnalysisJob> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'analysis-job', 1, 3);
    const body = parse(zAnalysisRequest, req.body ?? {});
    const release = analysisSlots(ctx, scope.session.userId);
    try {
      sweep();
      // Each account keeps at most MAX_ANALYSIS_JOBS_PER_USER jobs across its sessions, its oldest finished going first;
      // a full table drops the oldest finished report of anyone (reports are a polling cache), never a running job.
      // Finished reports alone can therefore never refuse a new job (review v0.2.1 F2).
      while ([...jobs.values()].filter((j) => j.userId === scope.session.userId).length >= MAX_ANALYSIS_JOBS_PER_USER) {
        if (!dropOldestFinished([...jobs.values()].filter((j) => j.userId === scope.session.userId))) throw new HttpError('rate_limited', 'Too many analysis jobs of yours are running; wait for one to finish.');
      }
      while (jobs.size >= MAX_ANALYSIS_JOBS) {
        if (!dropOldestFinished([...jobs.values()])) throw new HttpError('rate_limited', 'Too many analysis jobs are running; try again shortly.');
      }
    } catch (e) {
      release();
      throw e;
    }
    const id = randomBytes(12).toString('hex');
    const abort = new AbortController();
    const job: Job = {
      view: { id, state: 'running', startedAt: Date.now(), progress: { sampled: 0, target: body.sampleSize, scanned: 0, dbSize: 0, elapsedMs: 0, maxMs: policy.analysisMaxMs } },
      userId: scope.session.userId,
      sessionHash: scope.session.idHash,
      databaseId: scope.db.id,
      abort,
    };
    jobs.set(id, job);
    // The job outlives this request: its Redis commands follow the job's own signal, not the request's.
    const run = async () => {
      const base = await scope.conn();
      const conn: Conn = {
        ...base,
        send: (args, o = {}) => base.send(args, { ...o, signal: abort.signal }),
        primaries: async () => (await base.primaries()).map((t) => ({ label: t.label, send: (args, o = {}) => t.send(args, { ...o, signal: abort.signal }) })),
      };
      return analyze(conn, body, policy.analysisMaxMs, policy.maxReadReplyBytes, {
        signal: abort.signal,
        stillValid: () => sessionStillValid(ctx, scope.session),
        onProgress: (p) => {
          job.view.progress = { ...job.view.progress, ...p, elapsedMs: Date.now() - job.view.startedAt };
        },
      });
    };
    // During shutdown the audit store may already be closed: the job's outcome is then not audited (nothing ran).
    const record = (e: Parameters<typeof audit>[2]) => {
      if (!ctx.state.shuttingDown) audit(ctx, req, e);
    };
    void run()
      .then((report) => {
        job.view.report = report;
        job.view.state = abort.signal.aborted ? 'cancelled' : 'done';
        record({ action: 'analysis.run', outcome: 'allowed', databaseId: scope.db.id, detail: `job: sampled ${report.sampled} keys in ${report.durationMs} ms${job.view.state === 'cancelled' ? ' (cancelled)' : ''}` });
      })
      .catch((e: unknown) => {
        const he = e instanceof HttpError ? e : toHttpError(e);
        job.view.state = abort.signal.aborted ? 'cancelled' : 'failed';
        job.view.error = he.toBody().error;
        record({ action: 'analysis.run', outcome: he.code === 'unauthenticated' ? 'denied' : 'error', databaseId: scope.db.id, detail: `job: ${he.code}` });
      })
      .finally(() => {
        job.finishedAt = Date.now();
        job.view.progress.elapsedMs = job.finishedAt - job.view.startedAt;
        job.bytes = Buffer.byteLength(JSON.stringify(job.view));
        release();
        sweep();
      });
    return job.view;
  });

  app.get('/api/v1/databases/:db/analysis/jobs/:id', async (req): Promise<AnalysisJob> => {
    const scope = dbScope(ctx, req);
    const j = find(req, scope);
    if (j.view.state === 'running') j.view.progress.elapsedMs = Date.now() - j.view.startedAt;
    return j.view;
  });

  app.post('/api/v1/databases/:db/analysis/jobs/:id/cancel', { bodyLimit: 1024 }, async (req): Promise<AnalysisJob> => {
    const scope = dbScope(ctx, req);
    parse(zJobCancel, req.body ?? {});
    const j = find(req, scope);
    if (j.view.state === 'running') j.abort.abort(new Error('cancelled by the user'));
    return j.view;
  });
}

export type { Bin };
