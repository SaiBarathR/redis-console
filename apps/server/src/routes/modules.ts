import type { FastifyInstance } from 'fastify';
import { RESP_TYPES } from 'redis';
import {
  binFromBytes,
  buildFtSearchArgv,
  bytesFromBin,
  zSearchQuery,
  zStreamGroupsRequest,
  zStreamPendingRequest,
  zTsRangeRequest,
  type SearchIndexSummary,
  type SearchIndexesResponse,
  type SearchResult,
  type StreamGroupInfo,
  type StreamGroupsResponse,
  type StreamPendingResponse,
  type TimeSeriesRange,
} from '@rconsole/shared';
import type { AppConfig } from '../config.ts';
import { dbScope, parse, rateLimit, type AppContext, type DbScope } from '../context.ts';
import { keyTag } from '../audit.ts';
import { auditedRead } from '../policy/enforce.ts';
import { HttpError } from '../http/errors.ts';
import { authorize, fixedCommand } from '../policy/policy.ts';
import { run, toHttpError } from '../redis/exec.ts';
import { TM_BIN, TM_STR, type Conn } from '../redis/manager.ts';
import { asNum, asStr, kv } from '../redis/reply.ts';
import { detailRead, rawBytes } from './keyDetail.ts';
import { READ_BODY_LIMIT, keyBytes } from './keys.ts';
import { registerSearchRoutes } from './search.ts';

/** FT.SEARCH options of the typed query route (zSearchQuery after parsing). */
type SearchQueryOptions = Parameters<typeof buildFtSearchArgv>[0] & { offset: number; limit: number };

const TM_STR_DBL = { ...TM_STR, [RESP_TYPES.DOUBLE]: String } as const;

/** FT.INFO -> summary (RESP3 map flattened to arrays). */
export function parseFtInfo(name: string, raw: unknown): SearchIndexSummary {
  const info = kv(raw);
  const def = kv(info.index_definition);
  const prefixes = Array.isArray(def.prefixes) ? def.prefixes.map(asStr) : [];
  const attrs = Array.isArray(info.attributes) ? info.attributes : [];
  const fields = attrs.map((a) => {
    const f = Array.isArray(a) ? kv(a) : kv(a);
    return { name: asStr(f.attribute ?? f.identifier), type: asStr(f.type) };
  });
  return { name, numDocs: asNum(info.num_docs), indexing: asNum(info.indexing) === 1, prefixes, fields };
}

/** Document id bytes (exact, for "Open in key browser") and display text. */
const docId = (v: unknown) => {
  const b = Buffer.isBuffer(v) ? v : Buffer.from(asStr(v));
  return { id: asStr(v), key: binFromBytes(b) };
};
/** A field value as text: strings (Buffers) as UTF-8, nested replies as JSON. */
const fieldText = (v: unknown): string => (Buffer.isBuffer(v) || typeof v !== 'object' || v === null ? asStr(v) : JSON.stringify(v, (_k, x: unknown) => (Buffer.isBuffer(x) ? x.toString('utf8') : x)));

/** FT.SEARCH reply (RESP3 map, or RESP2-style array) -> SearchResult. */
export function parseFtSearch(raw: unknown): SearchResult {
  if (Array.isArray(raw) && raw.length && typeof raw[0] !== 'string' && !Buffer.isBuffer(raw[0])) {
    // RESP2 shape: [total, id, [f, v, ...], ...]
    const total = asNum(raw[0]);
    const docs: SearchResult['docs'] = [];
    for (let i = 1; i < raw.length; i += 2) {
      const f = kv(raw[i + 1]);
      docs.push({ ...docId(raw[i]), fields: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, asStr(v)])) });
    }
    return { total, docs };
  }
  const m = kv(raw);
  const results = Array.isArray(m.results) ? m.results : [];
  return {
    total: asNum(m.total_results),
    docs: results.map((r) => {
      const d = kv(r);
      const attrs = kv(d.extra_attributes);
      return { ...docId(d.id), fields: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, fieldText(v)])) };
    }),
  };
}

/** Search field names and values longer than this are cut for display. */
export const SEARCH_FIELD_CHARS = 4096;

/** JSON-text bytes of the character at `s[i]` (escapes included) and how many UTF-16 units it spans. */
function jsonChar(s: string, i: number): [bytes: number, units: number] {
  const c = s.charCodeAt(i);
  if (c === 0x22 || c === 0x5c) return [2, 1];
  if (c < 0x20) return [c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6, 1];
  if (c < 0x80) return [1, 1];
  if (c < 0x800) return [2, 1];
  if (c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) return [4, 2];
  return [c >= 0xd800 && c <= 0xdfff ? 6 : 3, 1]; // a lone surrogate is escaped
}

/** Bytes a string takes inside a JSON response body (escapes included, quotes excluded), without building it. */
export function jsonTextBytes(s: string, stopAbove = Infinity): number {
  let n = 0;
  for (let i = 0; i < s.length && n <= stopAbove; ) {
    const [b, u] = jsonChar(s, i);
    n += b;
    i += u;
  }
  return n;
}

/** The longest prefix of `s` whose JSON text fits in `room` bytes. */
function clipJson(s: string, room: number): string {
  let n = 0, i = 0;
  while (i < s.length) {
    const [b, u] = jsonChar(s, i);
    if (n + b > room) break;
    n += b;
    i += u;
  }
  return s.slice(0, i);
}

/** Read one measured search page, then budget ids and fields for display. */
export async function searchPage(conn: Conn, body: SearchQueryOptions, policy: AppConfig['policy']): Promise<SearchResult> {
  // Ids arrive as bytes (TM_BIN) so a binary key name survives for "Open in key browser" (v0.2.1, F8).
  const argv = [...buildFtSearchArgv(body), 'TIMEOUT', String(policy.commandTimeoutMs)];
  const page = parseFtSearch(await run(conn, argv, { typeMapping: TM_BIN, timeout: policy.commandTimeoutMs }));
  let left = policy.maxReplyBytes;
  // Ids first, so that as many documents as possible stay identifiable; one that does not fit is withheld, not cut.
  const shown = page.docs.map((d) => {
    const cost = (jsonTextBytes(d.id, left) + 16) * 2 + 32;
    if (cost > left) return false;
    left -= cost;
    return true;
  });
  const clip = (s: string) => (s.length > SEARCH_FIELD_CHARS ? `${s.slice(0, SEARCH_FIELD_CHARS)}…` : s);
  const docs = page.docs.map((d, i): SearchResult['docs'][number] => {
    if (!shown[i]) return { id: '', idBytes: d.key ? bytesFromBin(d.key).length : Buffer.byteLength(d.id), fields: {}, truncated: true };
    const fields = d.fields;
    const entries: [string, string][] = [];
    let cut = false;
    for (const [k, v] of Object.entries(fields)) {
      if (left <= 0) {
        cut = true;
        break;
      }
      const name = clip(k);
      let value = clip(v);
      const room = left - jsonTextBytes(name) - 8;
      if (jsonTextBytes(value, room) > room) value = `${clipJson(value, Math.max(0, room - 3))}…`;
      cut ||= value !== v || name !== k;
      left -= jsonTextBytes(name) + jsonTextBytes(value) + 8;
      entries.push([name, value]);
    }
    const doc = { id: d.id, ...(d.key ? { key: d.key } : {}), fields: Object.fromEntries(entries) };
    return cut ? { ...doc, truncated: true } : doc;
  });
  return { total: page.total, docs };
}

export function registerModuleRoutes(app: FastifyInstance, ctx: AppContext) {
  const { policy } = ctx.config;

  app.get('/api/v1/databases/:db/search/indexes', async (req): Promise<SearchIndexesResponse> => {
    const scope = dbScope(ctx, req);
    const conn = await scope.conn();
    let names: string[];
    try {
      names = (await conn.send<unknown[]>(['FT._LIST'], { typeMapping: TM_STR, timeout: policy.commandTimeoutMs })).map(asStr);
    } catch (e) {
      if (/unknown command/i.test((e as Error).message)) return { indexes: [] };
      throw toHttpError(e);
    }
    const indexes: SearchIndexSummary[] = [];
    for (const name of names.slice(0, 200)) {
      try {
        indexes.push(parseFtInfo(name, await conn.send(['FT.INFO', name], { typeMapping: TM_STR, timeout: policy.commandTimeoutMs })));
      } catch {
        indexes.push({ name, numDocs: 0, indexing: false, prefixes: [], fields: [] });
      }
    }
    return { indexes };
  });

  app.post('/api/v1/databases/:db/search/query', { bodyLimit: 64 * 1024 }, async (req): Promise<SearchResult> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'search', 5, 10);
    const body = parse(zSearchQuery, req.body);
    const base = { action: 'search.query', databaseId: scope.db.id, command: 'FT.SEARCH', argvRedacted: ['FT.SEARCH', `<${Buffer.byteLength(body.index)} bytes>`, `<${Buffer.byteLength(body.query)} bytes>`] };
    return auditedRead(ctx, req, base, async () => {
      authorize(fixedCommand('FT.SEARCH', 'read'), scope);
      return searchPage(await scope.conn(), body, policy);
    }, (r) => `total=${r.total} returned=${r.docs.length}${r.docs.some((d) => d.truncated) ? ' truncated' : ''}`);
  });

  // v0.2.1 (F7): index details, field sampling, create and drop (routes/search.ts).
  registerSearchRoutes(app, ctx);

  // Key-addressed reads are POSTs (keys never in URLs); no side effects, no confirmation.
  app.post('/api/v1/databases/:db/streams/groups', { bodyLimit: READ_BODY_LIMIT }, async (req): Promise<StreamGroupsResponse> => {
    const scope = dbScope(ctx, req);
    const q = parse(zStreamGroupsRequest, req.body);
    const key = keyBytes(q.key);
    const base = { action: 'stream.groups', databaseId: scope.db.id, command: 'XINFO', argvRedacted: ['XINFO', 'GROUPS', keyTag(key)], keyCount: 1 };
    return auditedRead(ctx, req, base, () => streamGroups(scope, key), (r) => `groups=${r.groups.length}`);
  });

  async function streamGroups(scope: DbScope, key: Buffer): Promise<StreamGroupsResponse> {
    const conn = await scope.conn();
    const o = { key, typeMapping: TM_BIN, timeout: policy.commandTimeoutMs };
    const raw = await detailRead<unknown[]>(scope, conn, ['XINFO', 'GROUPS', key], o);
    const groups: StreamGroupInfo[] = [];
    for (const g of raw.slice(0, 100)) {
      const f = kv(g);
      const name = asStr(f.name);
      const nameBin = binFromBytes(rawBytes(f.name));
      const consumersRaw = await detailRead<unknown[]>(scope, conn, ['XINFO', 'CONSUMERS', key, rawBytes(f.name)], o);
      const info: StreamGroupInfo = {
        name, nameBin, consumerTotal: consumersRaw.length,
        consumers: consumersRaw.slice(0, 100).map((c) => {
          const cf = kv(c);
          const out: StreamGroupInfo['consumers'][number] = { name: asStr(cf.name), nameBin: binFromBytes(rawBytes(cf.name)), pending: asNum(cf.pending), idleMs: asNum(cf.idle) };
          if (cf.inactive !== undefined) out.inactiveMs = asNum(cf.inactive);
          return out;
        }),
        pending: asNum(f.pending),
        lastDeliveredId: asStr(f['last-delivered-id']),
      };
      if (f['entries-read'] != null) info.entriesRead = asNum(f['entries-read']);
      if (f.lag != null) info.lag = asNum(f.lag);
      groups.push(info);
    }
    return { groups, total: raw.length };
  }

  app.post('/api/v1/databases/:db/streams/pending', { bodyLimit: READ_BODY_LIMIT }, async (req): Promise<StreamPendingResponse> => {
    const scope = dbScope(ctx, req);
    const q = parse(zStreamPendingRequest, req.body);
    const key = keyBytes(q.key);
    const group = typeof q.group === 'string' ? q.group : Buffer.from(bytesFromBin(q.group));
    const consumer = q.consumer === undefined ? undefined : typeof q.consumer === 'string' ? q.consumer : Buffer.from(bytesFromBin(q.consumer));
    if (Buffer.byteLength(group) > 65536 || (consumer !== undefined && Buffer.byteLength(consumer) > 65536)) throw new HttpError('validation', 'Stream names must fit within 64 KiB.');
    const base = { action: 'stream.pending', databaseId: scope.db.id, command: 'XPENDING', argvRedacted: ['XPENDING', keyTag(key), `<${Buffer.byteLength(group)} bytes>`], keyCount: 1 };
    return auditedRead(ctx, req, base, async () => {
      const conn = await scope.conn();
      const o = { key, typeMapping: TM_BIN, timeout: policy.commandTimeoutMs };
      const summary = await detailRead<unknown[]>(scope, conn, ['XPENDING', key, group], o);
      const list = await detailRead<unknown[][]>(scope, conn, ['XPENDING', key, group, q.start, q.end, String(q.count), ...(consumer === undefined ? [] : [consumer])], o);
      const out: StreamPendingResponse = {
        total: asNum(summary[0]),
        pending: list.map((e) => ({ id: asStr(e[0]), consumer: asStr(e[1]), consumerBin: binFromBytes(rawBytes(e[1])), idleMs: asNum(e[2]), deliveries: asNum(e[3]) })),
      };
      if (summary[1] != null) out.minId = asStr(summary[1]);
      if (summary[2] != null) out.maxId = asStr(summary[2]);
      return out;
    }, (r) => `pending=${r.total} returned=${r.pending.length}`);
  });

  app.post('/api/v1/databases/:db/timeseries/range', { bodyLimit: READ_BODY_LIMIT }, async (req): Promise<TimeSeriesRange> => {
    const scope = dbScope(ctx, req);
    const q = parse(zTsRangeRequest, req.body);
    if ((q.bucketMs === undefined) !== (q.agg === undefined)) throw new HttpError('validation', 'bucketMs and agg must be given together');
    const key = keyBytes(q.key);
    const base = { action: 'timeseries.range', databaseId: scope.db.id, command: 'TS.RANGE', argvRedacted: ['TS.RANGE', keyTag(key)], keyCount: 1 };
    return auditedRead(ctx, req, base, async () => {
      const conn = await scope.conn();
      const args = ['TS.RANGE', key, String(q.from), String(q.to), 'COUNT', String(q.count)] as (string | Buffer)[];
      if (q.agg && q.bucketMs) args.push('AGGREGATION', q.agg, String(q.bucketMs));
      const raw = await run<[unknown, unknown][]>(conn, args, { key, readonly: true, typeMapping: TM_STR_DBL, timeout: policy.commandTimeoutMs });
      const out: TimeSeriesRange = { key: binFromBytes(key), samples: raw.map(([t, v]) => [asNum(t), asStr(v)]) };
      if (q.agg) out.aggregation = `${q.agg}/${q.bucketMs}ms`;
      return out;
    }, (r) => `samples=${r.samples.length}${q.agg ? ` aggregation=${q.agg}` : ''}`);
  });
}
