/**
 * Contract for the "Insight" features (v0.2.1, RI parity F4/F7/F8/F10): search index wizard and details,
 * analysis jobs with recommendations, and bulk command import jobs. Both apps import it; see
 * docs/CONTRACT-CHANGES.md ("v0.2.1 insight"). Route paths are in `ROUTES` (api.ts).
 *
 * Nothing here changes what the server enforces for other routes: index creation, index drops and imports run
 * through the same command policy, per-role Redis ACL users, actor checks, confirmations and audit as the console.
 */
import { z } from 'zod';
import { zBin, zConfirmation, type ApiError, type Bin } from './api.ts';

// ---------------------------------------------------------------------------
// Search: index wizard (F7)

export const SEARCH_FIELD_TYPES = ['TEXT', 'TAG', 'NUMERIC', 'GEO', 'VECTOR'] as const;
export type SearchFieldType = (typeof SEARCH_FIELD_TYPES)[number];
export const SEARCH_ON = ['HASH', 'JSON'] as const;
export type SearchOn = (typeof SEARCH_ON)[number];

/** Index names the wizard creates: short, printable and typeable (a drop asks the admin to type the name). */
export const SEARCH_INDEX_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Field aliases (`AS`): a query refers to them as `@alias`, so they must be plain identifiers. */
export const SEARCH_ALIAS = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const zSearchVectorOptions = z
  .object({
    algorithm: z.enum(['FLAT', 'HNSW']),
    dataType: z.enum(['FLOAT32', 'FLOAT64']),
    dim: z.number().int().min(1).max(32_768),
    distance: z.enum(['L2', 'IP', 'COSINE']),
  })
  .strict();

/**
 * One schema field. `name` is a hash field name (HASH) or a JSONPath starting with `$` (JSON; `as` required).
 * Type options: TEXT `noStem`/`weight`; TAG `separator`/`caseSensitive`; VECTOR `vector` (required).
 * `sortable` is not allowed on VECTOR; `noIndex` needs `sortable`.
 */
export const zSearchFieldSpec = z
  .object({
    name: z.string().min(1).max(256),
    as: z.string().regex(SEARCH_ALIAS).optional(),
    type: z.enum(SEARCH_FIELD_TYPES),
    sortable: z.boolean().optional(),
    noIndex: z.boolean().optional(),
    noStem: z.boolean().optional(),
    weight: z.number().min(0.01).max(100).optional(),
    separator: z.string().regex(/^[!-~]$/).refine((c) => !`"'\\`.includes(c), 'separator: not a quote or backslash').optional(),
    caseSensitive: z.boolean().optional(),
    vector: zSearchVectorOptions.optional(),
  })
  .strict();
export type SearchFieldSpec = z.infer<typeof zSearchFieldSpec>;

const fieldProblems = (on: SearchOn, f: SearchFieldSpec): string[] => {
  const p: string[] = [];
  if (on === 'JSON' && !f.name.startsWith('$')) p.push(`${f.name}: JSON fields are JSONPaths starting with $`);
  if (on === 'JSON' && !f.as) p.push(`${f.name}: JSON fields need an alias (AS)`);
  if (f.type === 'VECTOR' && !f.vector) p.push(`${f.name}: VECTOR needs algorithm, type, dimension and distance`);
  if (f.type !== 'VECTOR' && f.vector) p.push(`${f.name}: vector options only apply to VECTOR`);
  if (f.type === 'VECTOR' && f.sortable) p.push(`${f.name}: VECTOR fields cannot be SORTABLE`);
  if (f.noIndex && !f.sortable) p.push(`${f.name}: NOINDEX needs SORTABLE`);
  if (f.type !== 'TEXT' && (f.noStem || f.weight !== undefined)) p.push(`${f.name}: NOSTEM and WEIGHT only apply to TEXT`);
  if (f.type !== 'TAG' && (f.separator !== undefined || f.caseSensitive)) p.push(`${f.name}: SEPARATOR and CASESENSITIVE only apply to TAG`);
  return p;
};

/** Problems with an index definition (empty when valid). Shared so the wizard shows what the server refuses. */
export function searchIndexProblems(spec: Pick<SearchIndexCreateRequest, 'on' | 'prefixes' | 'schema'>): string[] {
  const p: string[] = [];
  if (!spec.prefixes.length || spec.prefixes.some((x) => !x.length)) p.push('At least one non-empty key prefix is required (an empty prefix would index every key).');
  if (new Set(spec.prefixes).size !== spec.prefixes.length) p.push('Prefixes must be unique.');
  if (!spec.schema.length) p.push('Add at least one field.');
  const names = spec.schema.map((f) => f.as ?? f.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) p.push(`Field name ${dup} is used twice.`);
  for (const f of spec.schema) p.push(...fieldProblems(spec.on, f));
  return p;
}

/** POST /databases/:db/search/index/create (write; confirmation always; prod: typed name + reason). */
export const zSearchIndexCreate = z
  .object({
    index: z.string().regex(SEARCH_INDEX_NAME, 'index: 1-128 letters, digits, _ . : - (starting with a letter or digit)'),
    on: z.enum(SEARCH_ON),
    prefixes: z.array(z.string().min(1).max(512)).min(1).max(10),
    schema: z.array(zSearchFieldSpec).min(1).max(64),
    /** STOPWORDS 0: index every word (no stop-word list). */
    noStopwords: z.boolean().optional(),
    /** SKIPINITIALSCAN: index only keys written after creation. */
    skipInitialScan: z.boolean().optional(),
    confirmation: zConfirmation.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const message of searchIndexProblems(v)) ctx.addIssue({ code: 'custom', message });
  });
export type SearchIndexCreateRequest = z.infer<typeof zSearchIndexCreate>;
export interface SearchIndexCreateResponse { ok: true; index: string; argv: string[] }

const num = (n: number) => String(n);

/** The exact FT.CREATE argv for a definition. The server runs this; the wizard shows the same text. */
export function buildFtCreateArgv(spec: Omit<SearchIndexCreateRequest, 'confirmation'>): string[] {
  const argv = ['FT.CREATE', spec.index, 'ON', spec.on, 'PREFIX', num(spec.prefixes.length), ...spec.prefixes];
  if (spec.noStopwords) argv.push('STOPWORDS', '0');
  if (spec.skipInitialScan) argv.push('SKIPINITIALSCAN');
  argv.push('SCHEMA');
  for (const f of spec.schema) {
    argv.push(f.name);
    if (f.as) argv.push('AS', f.as);
    argv.push(f.type);
    if (f.type === 'TEXT') {
      if (f.noStem) argv.push('NOSTEM');
      if (f.weight !== undefined) argv.push('WEIGHT', num(f.weight));
    }
    if (f.type === 'TAG') {
      if (f.separator !== undefined) argv.push('SEPARATOR', f.separator);
      if (f.caseSensitive) argv.push('CASESENSITIVE');
    }
    if (f.type === 'VECTOR' && f.vector) {
      argv.push(f.vector.algorithm, '6', 'TYPE', f.vector.dataType, 'DIM', num(f.vector.dim), 'DISTANCE_METRIC', f.vector.distance);
    }
    if (f.sortable) argv.push('SORTABLE');
    if (f.noIndex) argv.push('NOINDEX');
  }
  return argv;
}

/** Escapes Redis glob metacharacters, so a literal prefix can be used in `SCAN MATCH <prefix>*`. */
export const globEscape = (s: string) => s.replace(/[*?[\]\\]/g, (c) => `\\${c}`);

/** JSONPath of a property under `parent` (`$.name`, or `$["odd name"]` for other characters). */
export const jsonPathChild = (parent: string, key: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;

const GEO_TEXT = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const isNumericText = (s: string) => s.trim() !== '' && /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s.trim());

/**
 * The field type a sampled value suggests. `value` is a hash field's text (HASH), or a parsed JSON value (JSON).
 * Words with spaces suggest TEXT, short single tokens TAG, numbers NUMERIC, "lon,lat" GEO, number arrays VECTOR.
 * Returns undefined for values the wizard does not index (objects, arrays of objects, null).
 */
export function inferSearchFieldType(value: unknown, on: SearchOn): SearchFieldType | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return 'NUMERIC';
  if (typeof value === 'boolean') return 'TAG';
  if (Array.isArray(value)) {
    if (value.length >= 2 && value.every((x) => typeof x === 'number' && Number.isFinite(x))) return 'VECTOR';
    if (value.length && value.every((x) => typeof x === 'string')) return 'TAG';
    return undefined;
  }
  if (typeof value === 'object') return undefined;
  const s = String(value);
  const geo = GEO_TEXT.exec(s);
  if (geo && Math.abs(Number(geo[1])) <= 180 && Math.abs(Number(geo[2])) <= 90) return 'GEO';
  if (on === 'HASH' && isNumericText(s)) return 'NUMERIC';
  if (/\s/.test(s.trim())) return 'TEXT';
  return s.length <= 64 ? 'TAG' : 'TEXT';
}

/** One type for a field from the types its samples suggested (counts per type). */
export function mergeSearchFieldTypes(counts: Partial<Record<SearchFieldType, number>>): SearchFieldType {
  const has = (t: SearchFieldType) => (counts[t] ?? 0) > 0;
  const kinds = SEARCH_FIELD_TYPES.filter(has);
  if (kinds.length === 1) return kinds[0]!;
  if (has('TEXT')) return 'TEXT';
  if (has('TAG')) return 'TAG';
  return 'TEXT';
}

/** POST /databases/:db/search/sample (read-only): infer fields from up to `keys` keys under `prefix`. */
export const zSearchSample = z
  .object({
    on: z.enum(SEARCH_ON),
    prefix: z.string().min(1).max(512),
    keys: z.number().int().min(1).max(50).default(20),
    /** The key the wizard was opened from: read first, so its fields are always present. */
    key: zBin.optional(),
  })
  .strict();
export type SearchSampleRequest = z.input<typeof zSearchSample>;
export interface SearchSampleField {
  /** Hash field name, or JSONPath for JSON. */
  name: string;
  /** Suggested alias (JSON: the last path segment). */
  as?: string;
  suggested: SearchFieldType;
  /** How many sampled keys had this field, and what their values suggested. */
  seen: number;
  types: Partial<Record<SearchFieldType, number>>;
  /** VECTOR: the dimension seen (number arrays, or binary FLOAT32 blobs in hashes). */
  dim?: number;
  /** Up to two example values, cut to 80 characters (display only). */
  examples: string[];
}
export interface SearchSampleResponse {
  on: SearchOn;
  prefix: string;
  /** Keys read for the sample, and keys skipped (larger than the server's sample read cap, or unreadable). */
  sampled: number;
  skipped: number;
  /** SCAN calls x COUNT examined; `complete` when the scan reached the end of the keyspace. */
  scanned: number;
  complete: boolean;
  fields: SearchSampleField[];
  /** Properties the wizard does not index (nested objects, arrays of objects), with the reason. */
  ignored: { name: string; reason: string }[];
  /** Existing indexes whose prefixes overlap this prefix (an index for these keys may already exist). */
  overlapping: { name: string; prefixes: string[] }[];
}

/** POST /databases/:db/search/index/info (read-only) -> SearchIndexDetail. */
export const zSearchIndexRef = z.object({ index: z.string().min(1).max(256) }).strict();
export interface SearchIndexField {
  identifier: string;
  attribute: string;
  type: string;
  /** Remaining FT.INFO attribute tokens (SORTABLE, NOSTEM, WEIGHT 1, SEPARATOR ",", ...). */
  options: string[];
}
export interface SearchIndexDetail {
  name: string;
  on: string;
  prefixes: string[];
  filter?: string;
  language?: string;
  /** FT.INFO index_options (e.g. NOOFFSETS). */
  options: string[];
  fields: SearchIndexField[];
  numDocs: number;
  indexing: boolean;
  /** 0..1 */
  percentIndexed?: number;
  indexingFailures: number;
  /** Memory facts in MB, as FT.INFO reports them (e.g. inverted_sz_mb). */
  memory: { name: string; mb: number }[];
  /** Other scalar facts (num_terms, num_records, number_of_uses, ...). */
  stats: { name: string; value: string }[];
  /** Index errors from FT.INFO `Index Errors` (last error text and the key it happened on). */
  lastError?: { message: string; key?: Bin };
}

/**
 * POST /databases/:db/search/index/drop: admin only, typed confirmation (the index name), prod also a reason.
 * Documents (keys) are kept. `deleteDocuments` (FT.DROPINDEX ... DD) is refused unless the server policy
 * `searchDropDeletesDocuments` allows it; the console and workbench never accept DD.
 */
export const zSearchIndexDrop = z
  .object({ index: z.string().min(1).max(256), deleteDocuments: z.boolean().default(false), confirmation: zConfirmation.optional() })
  .strict();
export interface SearchIndexDropResponse { ok: true; documentsDeleted: boolean }

/** Options of a search query as the typed endpoint builds it (no TIMEOUT; the server appends its own). */
export function buildFtSearchArgv(q: {
  index: string;
  query: string;
  offset?: number;
  limit?: number;
  sortBy?: string | undefined;
  sortOrder?: 'ASC' | 'DESC' | undefined;
  returnFields?: string[] | undefined;
  dialect?: number | undefined;
}): string[] {
  const argv = ['FT.SEARCH', q.index, q.query || '*'];
  if (q.returnFields?.length) argv.push('RETURN', String(q.returnFields.length), ...q.returnFields);
  if (q.sortBy) argv.push('SORTBY', q.sortBy, q.sortOrder ?? 'ASC');
  argv.push('LIMIT', String(q.offset ?? 0), String(q.limit ?? 20));
  if (q.dialect) argv.push('DIALECT', String(q.dialect));
  return argv;
}

// ---------------------------------------------------------------------------
// Analysis: recommendations and jobs (F4)

/** Thresholds of the analysis rules (shown in the report so a recommendation can say what it measured). */
export const ANALYSIS_RULES = {
  bigKeyBytes: 1024 * 1024,
  bigStringBytes: 100_000,
  hashManyFields: 5000,
  largeCollection: 5000,
  jsonStringMinBytes: 1024,
  longKeyNameBytes: 200,
  expiryWindowMs: 60_000,
  expiryMinKeys: 50,
  searchableMinKeys: 50,
} as const;

export type AnalysisRecommendationId =
  | 'bigKeys'
  | 'hashTooManyFields'
  | 'largeCollections'
  | 'noTtlCacheKeys'
  | 'stringJsonCouldBeRedisJson'
  | 'keysExpiringEnMasse'
  | 'longKeyNames'
  | 'searchableNamespace';

/**
 * A rule's finding. Every recommendation is about the sample only: `affected` of `basis` sampled keys (the
 * report's `coverage` says how much of the keyspace that is). Text is plain; examples are key names (Bin).
 */
export interface AnalysisRecommendation {
  id: AnalysisRecommendationId;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  action: string;
  affected: number;
  basis: number;
  keys: { key: Bin; type: string; bytes?: number; length?: number; ttl?: number }[];
  prefixes?: { prefix: string; keys: number; noExpiry?: number }[];
  /** keysExpiringEnMasse: start of the busiest expiry window (epoch ms). */
  at?: number;
  /** Shown only when the database has this module (searchableNamespace: search; stringJson: json). */
  module?: 'search' | 'json';
  /** searchableNamespace: what the index wizard should open with. */
  search?: { prefix: string; on: SearchOn };
}

export interface AnalysisCoverage {
  sampled: number;
  dbSize: number;
  /** The SCAN reached the end of the matching keyspace (every match was sampled). */
  complete: boolean;
  stoppedBy: 'complete' | 'sampleLimit' | 'timeLimit' | 'cancelled';
}

/** POST /databases/:db/analysis/jobs (zAnalysisRequest body) starts a job; GET …/jobs/:id polls; POST …/jobs/:id/cancel. */
export interface AnalysisJob {
  id: string;
  state: 'running' | 'done' | 'cancelled' | 'failed';
  startedAt: number;
  /** `dbSize`: keys in the database when the job started (0 until read). `maxMs`: the server's time budget. */
  progress: { sampled: number; target: number; scanned: number; dbSize: number; elapsedMs: number; maxMs: number };
  /** Present when the job is no longer running (a cancelled job carries the partial report). */
  report?: import('./api.ts').AnalysisReport;
  error?: ApiError['error'];
}
export const zJobCancel = z.object({}).strict();

// ---------------------------------------------------------------------------
// Bulk import (F10)

/** At most this many commands per import, and this many bytes of script text. */
export const MAX_IMPORT_COMMANDS = 10_000;
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
/** Commands run in chunks of this size; progress and cancellation are checked between commands. */
export const IMPORT_CHUNK_SIZE = 100;

/**
 * POST /databases/:db/import: parse and policy-check a redis-cli command file (one command per line; blank lines
 * and lines starting with # or // are skipped). Returns the plan; nothing runs yet.
 */
export const zImportPlan = z.object({ script: z.string().max(MAX_IMPORT_BYTES), fileName: z.string().max(256).optional() }).strict();
export interface ImportPlan {
  id: string;
  fileName?: string;
  /** Commands (non-empty, non-comment lines). */
  total: number;
  counts: { read: number; write: number; admin: number; blocked: number };
  /** Commands whose rule asks for a confirmation of their own (DEL, UNLINK, ...). */
  destructive: number;
  /** Lines the policy refuses for this caller on this database (first 200), with the reason. */
  blocked: { line: number; command: string; reason: string }[];
  /** What starting needs: `none` (reads only), `confirm`, or `typed` (+ reason on production). */
  confirmation: 'none' | 'confirm' | 'typed';
  expiresAt: number;
}
/** POST /databases/:db/import/:id/start. Lines the policy refuses must be removed, or skipped with `skipBlocked`. */
export const zImportStart = z
  .object({ stopOnError: z.boolean().default(false), skipBlocked: z.boolean().default(false), confirmation: zConfirmation.optional() })
  .strict();
export interface ImportFailureGroup {
  /** Command name (`<unknown command>` when Redis does not know it). */
  command: string;
  code: string;
  /** The first failure's message (shown only to the user who runs the import; never audited). */
  message: string;
  count: number;
  /** Line numbers of the first 20 failures. */
  lines: number[];
}
export interface ImportStatus {
  id: string;
  state: 'planned' | 'running' | 'done' | 'cancelled' | 'stopped' | 'failed';
  total: number;
  /** Commands sent to Redis (succeeded + failed) and commands not sent (skipped by policy or after a stop). */
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  chunks: { size: number; done: number; total: number };
  startedAt?: number;
  finishedAt?: number;
  /** Why it ended early: cancelled by the user, stopped at a failure, session ended, time budget. */
  stopReason?: string;
  /** Cancelled while a command was in flight: it may have run. */
  inFlightLine?: number;
  failures: ImportFailureGroup[];
}
