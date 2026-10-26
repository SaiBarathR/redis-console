/**
 * Search index management (v0.2.1, RI parity F7): index details, field sampling for the "Make searchable" wizard,
 * index creation and index drop. Queries stay in routes/modules.ts.
 *
 * Creation runs the FT.CREATE that `buildFtCreateArgv` builds from a validated definition (the wizard shows the
 * same argv), classified exactly like the console (COMMAND INFO: write, operator+; the Redis ACL user of the role
 * must also allow it), with a confirmation every time (prod: typed name + reason), the actor check and audit.
 * A drop is admin-only with a typed confirmation of the index name; documents are kept unless server policy
 * (`policy.searchDropDeletesDocuments`) allows `DD`.
 */
import type { FastifyInstance } from 'fastify';
import {
  binFromBytes,
  buildFtCreateArgv,
  globEscape,
  inferSearchFieldType,
  jsonPathChild,
  mergeSearchFieldTypes,
  zSearchIndexCreate,
  zSearchIndexDrop,
  zSearchIndexRef,
  zSearchSample,
  type PreviewArg,
  type PreviewCommand,
  type SearchFieldType,
  type SearchIndexCreateResponse,
  type SearchIndexDetail,
  type SearchIndexDropResponse,
  type SearchSampleField,
  type SearchSampleResponse,
} from '@rconsole/shared';
import { audit, dbScope, parse, rateLimit, type AppContext, type DbScope } from '../context.ts';
import { redactArgv } from '../audit.ts';
import { HttpError } from '../http/errors.ts';
import { auditDenied, auditedRead, confirmOrThrow } from '../policy/enforce.ts';
import { authorize, classify, confirmationFor, fixedCommand, isMutating, type ConfirmSpec } from '../policy/policy.ts';
import { buildPreview } from '../policy/preview.ts';
import { run, toHttpError } from '../redis/exec.ts';
import { TM_BIN, TM_STR } from '../redis/manager.ts';
import { asNum, asStr, kv } from '../redis/reply.ts';
import { scanPage } from '../redis/scan.ts';
import { READ_BODY_LIMIT, keyBytes } from './keys.ts';

/** Bytes read from one sampled key (HSCAN page or JSON document); larger keys are skipped, not cut. */
export const SAMPLE_READ_BYTES = 256 * 1024;
const SAMPLE_SCAN_MS = 1500;
const MAX_SAMPLE_FIELDS = 100;
const EXAMPLE_CHARS = 80;

const flat = (v: unknown): unknown[] => (Array.isArray(v) ? v : v instanceof Map ? [...v].flat() : []);
const scalar = (v: unknown): string => (typeof v === 'number' ? (Number.isFinite(v) ? String(v) : v > 0 ? 'inf' : v < 0 ? '-inf' : 'nan') : asStr(v));

/** FT.INFO attribute entry -> identifier, attribute, type and the remaining option tokens (RESP3 map or RESP2 list). */
function parseAttribute(raw: unknown): SearchIndexDetail['fields'][number] {
  const a = flat(raw);
  const out = { identifier: '', attribute: '', type: '', options: [] as string[] };
  for (let i = 0; i < a.length; i++) {
    const k = asStr(a[i]);
    const lower = k.toLowerCase();
    if (lower === 'identifier' || lower === 'attribute' || lower === 'type') {
      out[lower as 'identifier' | 'attribute' | 'type'] = asStr(a[++i]);
    } else if (lower === 'flags') {
      for (const f of flat(a[++i])) out.options.push(asStr(f));
    } else if (i + 1 < a.length && (typeof a[i + 1] === 'number' || /^(WEIGHT|SEPARATOR|PHONETIC|DIM|TYPE|DISTANCE_METRIC|ALGORITHM|M|EF_CONSTRUCTION|EF_RUNTIME|EPSILON|INITIAL_CAP|BLOCK_SIZE|data_type|dim|distance_metric|algorithm)$/i.test(k))) {
      out.options.push(`${k} ${scalar(a[++i])}`);
    } else {
      out.options.push(k);
    }
  }
  if (!out.attribute) out.attribute = out.identifier;
  return out;
}

const MEMORY = /_(sz_)?mb$|size_mb$/;

/** FT.INFO -> full index detail (scalars become stats or memory facts; nested maps are summarised). */
export function parseFtInfoDetail(name: string, raw: unknown): SearchIndexDetail {
  const info = kv(raw);
  const def = kv(info.index_definition);
  const detail: SearchIndexDetail = {
    name,
    on: asStr(def.key_type) || 'HASH',
    prefixes: flat(def.prefixes).map(asStr),
    options: flat(info.index_options).map(asStr),
    fields: flat(info.attributes).map(parseAttribute),
    numDocs: asNum(info.num_docs),
    indexing: asNum(info.indexing) === 1,
    indexingFailures: asNum(info.hash_indexing_failures),
    memory: [],
    stats: [],
  };
  if (def.filter !== undefined) detail.filter = asStr(def.filter);
  if (def.default_language !== undefined) detail.language = asStr(def.default_language);
  if (info.percent_indexed !== undefined) detail.percentIndexed = asNum(info.percent_indexed);
  const skip = new Set(['index_name', 'index_options', 'index_definition', 'attributes', 'num_docs', 'indexing', 'percent_indexed', 'hash_indexing_failures', 'field statistics', 'Index Errors']);
  for (const [k, v] of Object.entries(info)) {
    if (skip.has(k)) continue;
    if (Array.isArray(v) || v instanceof Map) {
      // gc_stats, cursor_stats, dialect_stats: one line each.
      const m = kv(v);
      const parts = Object.entries(m).filter(([, x]) => !Array.isArray(x) && !(x instanceof Map)).map(([a, x]) => `${a} ${scalar(x)}`);
      if (parts.length) detail.stats.push({ name: k, value: parts.join(', ') });
    } else if (MEMORY.test(k)) {
      detail.memory.push({ name: k, mb: asNum(v) });
    } else {
      detail.stats.push({ name: k, value: scalar(v) });
    }
  }
  const errors = kv(info['Index Errors']);
  const last = asStr(errors['last indexing error']);
  if (last && last !== 'N/A') {
    detail.lastError = { message: last.slice(0, 1000) };
    const key = errors['last indexing error key'];
    const kb = Buffer.isBuffer(key) ? key : key === undefined ? undefined : Buffer.from(asStr(key));
    if (kb && kb.toString() !== 'N/A') detail.lastError.key = binFromBytes(kb);
  }
  return detail;
}

/** A JSON number keeps its source text (examples are shown exactly as stored, never rounded). */
class JsonNum {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
}
type Reviver = (this: unknown, key: string, value: unknown, context?: { source?: string }) => unknown;
const keepNumbers: Reviver = (_k, v, context) => (typeof v === 'number' ? new JsonNum(context?.source ?? String(v)) : v);
const parseDoc = (text: string): unknown => JSON.parse(text, keepNumbers as (this: unknown, key: string, value: unknown) => unknown);

const clipExample = (s: string) => (s.length > EXAMPLE_CHARS ? `${s.slice(0, EXAMPLE_CHARS)}…` : s);
const plain = (v: unknown): unknown => (v instanceof JsonNum ? Number(v.source) : Array.isArray(v) ? v.map(plain) : v);
const exampleOf = (v: unknown): string => {
  if (v instanceof JsonNum) return v.source;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `[${v.slice(0, 8).map(exampleOf).join(', ')}${v.length > 8 ? ', …' : ''}]`;
  return String(v);
};

/** Collects field observations across sampled keys. */
export class FieldSampler {
  readonly on: 'HASH' | 'JSON';
  readonly fields = new Map<string, SearchSampleField>();
  readonly ignored = new Map<string, string>();
  constructor(on: 'HASH' | 'JSON') {
    this.on = on;
  }

  #note(name: string, type: SearchFieldType | undefined, example: string, as?: string, dim?: number) {
    if (!type) return;
    let f = this.fields.get(name);
    if (!f) {
      if (this.fields.size >= MAX_SAMPLE_FIELDS) return;
      f = { name, suggested: type, seen: 0, types: {}, examples: [] };
      if (as) f.as = as;
      this.fields.set(name, f);
    }
    f.seen++;
    f.types[type] = (f.types[type] ?? 0) + 1;
    if (dim !== undefined && type === 'VECTOR') f.dim = dim;
    if (f.examples.length < 2 && example && !f.examples.includes(clipExample(example))) f.examples.push(clipExample(example));
  }

  /** One hash's fields and values (exact bytes). */
  hash(pairs: Buffer[]) {
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      const field = pairs[i]!, value = pairs[i + 1]!;
      const name = field.toString('utf8');
      if (Buffer.byteLength(name) !== field.length || /[\u0000-\u001f\u007f]/.test(name) || field.length > 256) {
        if (this.ignored.size < 50) this.ignored.set(`<${field.length} bytes>`, 'field names that are not plain text are not offered');
        continue;
      }
      const text = value.toString('utf8');
      const binary = Buffer.byteLength(text) !== value.length || /[\u0000-\u0008\u000e-\u001f]/.test(text);
      if (binary) {
        // Binary blobs whose size is a multiple of 4 are usually FLOAT32 vectors.
        if (value.length >= 8 && value.length % 4 === 0) this.#note(name, 'VECTOR', `<${value.length} bytes, binary>`, undefined, value.length / 4);
        else if (this.ignored.size < 50) this.ignored.set(name, 'binary values are not indexed by the wizard');
        continue;
      }
      this.#note(name, inferSearchFieldType(text, 'HASH'), text);
    }
  }

  /** One JSON document (the text of `JSON.GET key $`, an array holding the document). */
  json(text: string) {
    let doc: unknown;
    try {
      const arr = parseDoc(text);
      doc = Array.isArray(arr) ? arr[0] : arr;
    } catch {
      return;
    }
    const walk = (v: unknown, path: string, alias: string, depth: number) => {
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof JsonNum)) {
        if (depth >= 3) {
          if (this.ignored.size < 50) this.ignored.set(path, 'nested more than three levels deep');
          return;
        }
        for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, jsonPathChild(path, k), k, depth + 1);
        return;
      }
      const value = plain(v);
      const type = inferSearchFieldType(value, 'JSON');
      if (!type) {
        if (v !== null && this.ignored.size < 50) this.ignored.set(path, Array.isArray(v) ? 'arrays of objects or mixed values are not indexed by the wizard' : 'not indexable');
        return;
      }
      // An array of strings is a TAG over its elements.
      const fieldPath = type === 'TAG' && Array.isArray(v) ? `${path}[*]` : path;
      const as = alias.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=[0-9])/, '_').slice(0, 64) || 'field';
      this.#note(fieldPath, type, exampleOf(v), as, type === 'VECTOR' && Array.isArray(v) ? v.length : undefined);
    };
    if (doc && typeof doc === 'object' && !Array.isArray(doc)) walk(doc, '$', '', 0);
  }

  result(): { fields: SearchSampleField[]; ignored: { name: string; reason: string }[] } {
    const fields = [...this.fields.values()].map((f) => ({ ...f, suggested: mergeSearchFieldTypes(f.types) }));
    // Unique aliases (JSON paths with the same last segment).
    const used = new Set<string>();
    for (const f of fields) {
      if (!f.as) continue;
      let a = f.as, n = 2;
      while (used.has(a)) a = `${f.as}_${n++}`;
      used.add(a);
      f.as = a;
    }
    fields.sort((a, b) => b.seen - a.seen || a.name.localeCompare(b.name));
    return { fields, ignored: [...this.ignored].map(([name, reason]) => ({ name, reason })) };
  }
}

const KEYWORDS = new Set(['FT.CREATE', 'ON', 'PREFIX', 'STOPWORDS', 'SKIPINITIALSCAN', 'SCHEMA', 'AS', 'TEXT', 'TAG', 'NUMERIC', 'GEO', 'VECTOR', 'NOSTEM', 'WEIGHT', 'SEPARATOR', 'CASESENSITIVE', 'SORTABLE', 'NOINDEX', 'FLAT', 'HNSW', 'TYPE', 'DIM', 'DISTANCE_METRIC']);

/** The confirmation preview of FT.CREATE: every argument in full (they are bounded by validation). */
export function ftCreatePreview(argv: string[], prefixCount: number): PreviewCommand {
  const prefixFrom = argv.indexOf('PREFIX') + 2;
  const schemaAt = argv.indexOf('SCHEMA');
  return {
    argv: argv.map((a, i): PreviewArg => {
      const v = binFromBytes(Buffer.from(a));
      if (i === 0) return { kind: 'command', v };
      if (i >= prefixFrom && i < prefixFrom + prefixCount) return { kind: 'pattern', v };
      // Keywords stand out; names, aliases, numbers and the index name are plain arguments.
      if (i > 2 && KEYWORDS.has(a) && (i <= schemaAt || argv[i - 1] !== 'SCHEMA')) return { kind: 'command', v };
      return { kind: 'arg', v };
    }),
  };
}

export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext) {
  const { policy } = ctx.config;
  const t = { typeMapping: TM_STR, timeout: policy.commandTimeoutMs };

  const indexPrefixes = async (scope: DbScope): Promise<{ name: string; prefixes: string[] }[]> => {
    const conn = await scope.conn();
    const names = await conn.send<unknown[]>(['FT._LIST'], t).then((r) => r.map(asStr), () => [] as string[]);
    const out: { name: string; prefixes: string[] }[] = [];
    for (const name of names.slice(0, 50)) {
      try {
        const def = kv(kv(await conn.send(['FT.INFO', name], t)).index_definition);
        out.push({ name, prefixes: flat(def.prefixes).map(asStr) });
      } catch {
        /* an index that cannot be read is not reported */
      }
    }
    return out;
  };

  app.post('/api/v1/databases/:db/search/index/info', { bodyLimit: READ_BODY_LIMIT }, async (req): Promise<SearchIndexDetail> => {
    const scope = dbScope(ctx, req);
    const body = parse(zSearchIndexRef, req.body);
    const base = { action: 'search.index.info', databaseId: scope.db.id, command: 'FT.INFO', argvRedacted: ['FT.INFO', `<${Buffer.byteLength(body.index)} bytes>`] };
    return auditedRead(ctx, req, base, async () => {
      authorize(fixedCommand('FT.INFO', 'read'), scope);
      const conn = await scope.conn();
      return parseFtInfoDetail(body.index, await run(conn, ['FT.INFO', body.index], t));
    }, (r) => `fields=${r.fields.length} docs=${r.numDocs}`);
  });

  app.post('/api/v1/databases/:db/search/sample', { bodyLimit: READ_BODY_LIMIT }, async (req): Promise<SearchSampleResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'search-sample', 2, 4);
    const body = parse(zSearchSample, req.body);
    const type = body.on === 'HASH' ? 'hash' : 'ReJSON-RL';
    const base = { action: 'search.sample', databaseId: scope.db.id, command: 'SCAN', argvRedacted: ['SCAN', '<cursor>', 'MATCH', `<${Buffer.byteLength(body.prefix) + 1} bytes>`, 'TYPE', type] };
    return auditedRead(ctx, req, base, async () => {
      const conn = await scope.conn();
      const prefix = Buffer.from(body.prefix);
      const keys: Buffer[] = [];
      const seen = new Set<string>();
      const add = (k: Buffer) => {
        const id = k.toString('base64');
        if (!seen.has(id) && keys.length < body.keys) {
          seen.add(id);
          keys.push(k);
        }
      };
      if (body.key) {
        const k = keyBytes(body.key);
        const kt = await run(conn, ['TYPE', k], { key: k, readonly: true, typeMapping: TM_STR, timeout: policy.commandTimeoutMs }).then(asStr);
        if (kt === type && k.subarray(0, prefix.length).equals(prefix)) add(k);
      }
      let cursor = '0', scanned = 0, complete = false;
      const start = Date.now();
      do {
        const page = await scanPage(conn, { cursor, match: `${globEscape(body.prefix)}*`, type, count: 1000, maxKeys: body.keys, budgetMs: 300, pageBytes: 1024 * 1024 });
        cursor = page.cursor;
        scanned += page.scanned;
        for (const k of page.keys) add(k);
        complete = cursor === '0';
      } while (!complete && keys.length < body.keys && Date.now() - start < SAMPLE_SCAN_MS);

      const sampler = new FieldSampler(body.on);
      let sampled = 0, skipped = 0;
      for (const k of keys) {
        const o = { key: k, readonly: true, timeout: policy.commandTimeoutMs, maxBytes: SAMPLE_READ_BYTES };
        try {
          if (body.on === 'HASH') {
            const r = await conn.send<[unknown, Buffer[]]>(['HSCAN', k, '0', 'COUNT', '200'], { ...o, typeMapping: TM_BIN });
            sampler.hash((r[1] ?? []).map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(asStr(b)))));
          } else {
            const r = await conn.send<unknown>(['JSON.GET', k, '$'], { ...o, typeMapping: TM_STR });
            sampler.json(asStr(r));
          }
          sampled++;
        } catch {
          // Too large for a sample read, gone, or changed type meanwhile: not counted.
          skipped++;
        }
      }
      const { fields, ignored } = sampler.result();
      const overlapping = (await indexPrefixes(scope)).filter((i) => i.prefixes.some((p) => p === '' || body.prefix.startsWith(p) || p.startsWith(body.prefix)));
      return { on: body.on, prefix: body.prefix, sampled, skipped, scanned, complete, fields, ignored, overlapping };
    }, (r) => `sampled=${r.sampled} fields=${r.fields.length}`);
  });

  app.post('/api/v1/databases/:db/search/index/create', { bodyLimit: READ_BODY_LIMIT }, async (req): Promise<SearchIndexCreateResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'search-admin', 5, 10);
    const body = parse(zSearchIndexCreate, req.body);
    const { confirmation, ...spec } = body;
    const argv = buildFtCreateArgv(spec);
    const table = await scope.table().catch(() => undefined);
    const base = { action: 'search.index.create', databaseId: scope.db.id, command: 'FT.CREATE', argvRedacted: [...redactArgv(argv.slice(0, 24), 1).argv, ...(argv.length > 24 ? [`<${argv.length - 24} more args>`] : [])] };
    try {
      // Classified like the console (COMMAND INFO flags: write), so role, read-only and prod rules match.
      const c = classify(argv, table);
      authorize(c, scope);
      const preview = buildPreview([ftCreatePreview(argv, spec.prefixes.length)]);
      const where = spec.prefixes.length === 1 ? `keys starting with "${spec.prefixes[0]}"` : `keys under ${spec.prefixes.length} prefixes`;
      const summary = `Create search index ${spec.index} on ${spec.on === 'HASH' ? 'hash' : 'JSON'} ${where} in ${scope.db.name}${spec.skipInitialScan ? ' (new and changed keys only)' : '; existing keys are indexed in the background'}`;
      const spec428: ConfirmSpec = confirmationFor('confirm', isMutating(c), scope.db, policy.prodRequiresReason, summary, preview)!;
      const { reason } = confirmOrThrow(ctx, req, scope, 'search-index-create', req.body, confirmation, spec428, base);
      const conn = await scope.conn();
      await run(conn, argv, { capped: true, timeout: policy.commandTimeoutMs });
      audit(ctx, req, { ...base, outcome: 'allowed', reason, detail: `fields=${spec.schema.length} prefixes=${spec.prefixes.length}` });
      return { ok: true, index: spec.index, argv };
    } catch (e) {
      auditDenied(ctx, req, base, e instanceof HttpError ? e : toHttpError(e));
    }
  });

  app.post('/api/v1/databases/:db/search/index/drop', { bodyLimit: READ_BODY_LIMIT }, async (req): Promise<SearchIndexDropResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'search-admin', 5, 10);
    const body = parse(zSearchIndexDrop, req.body);
    const argv = ['FT.DROPINDEX', body.index, ...(body.deleteDocuments ? ['DD'] : [])];
    const base = { action: 'search.index.drop', databaseId: scope.db.id, command: 'FT.DROPINDEX', argvRedacted: redactArgv(argv, 1).argv };
    try {
      const c = fixedCommand('FT.DROPINDEX', 'admin', 'typed');
      authorize(c, scope);
      if (body.deleteDocuments && !policy.searchDropDeletesDocuments) {
        throw new HttpError('forbidden', 'Deleting the indexed keys with the index is disabled by server policy. Drop the index alone to keep the documents.');
      }
      const typeable = /^[\x20-\x7e]{1,128}$/.test(body.index);
      const spec: ConfirmSpec = {
        level: 'typed',
        // The index name is what the admin types; production adds the reason (and names the database in the summary).
        expectedText: typeable ? body.index : scope.db.name,
        reasonRequired: scope.db.environment === 'prod' && policy.prodRequiresReason,
        summary: `Drop search index ${body.index} from ${scope.db.name}. ${body.deleteDocuments ? 'Every indexed key is DELETED too (DD).' : 'The indexed keys are kept; only the index is removed.'}`,
        preview: buildPreview([{ argv: argv.map((a, i): PreviewArg => ({ kind: i === 0 || a === 'DD' ? 'command' : 'arg', v: binFromBytes(Buffer.from(a)) })) }]),
      };
      const { reason } = confirmOrThrow(ctx, req, scope, 'search-index-drop', req.body, body.confirmation, spec, base);
      const conn = await scope.conn();
      await run(conn, argv, { capped: true, timeout: policy.commandTimeoutMs });
      audit(ctx, req, { ...base, outcome: 'allowed', reason, detail: body.deleteDocuments ? 'documents deleted' : 'documents kept' });
      return { ok: true, documentsDeleted: body.deleteDocuments };
    } catch (e) {
      auditDenied(ctx, req, base, e instanceof HttpError ? e : toHttpError(e));
    }
  });
}
