/**
 * HTTP API contract between apps/web and apps/server.
 *
 * Conventions
 * - Base path: /api/v1. JSON only (Content-Type: application/json), UTF-8.
 * - Auth: server-side session; cookie is HttpOnly + SameSite=Strict (+ Secure/__Host- in prod).
 * - CSRF: every non-GET request must send header `X-CSRF-Token` equal to `me.csrfToken`,
 *   and a same-origin `Origin` header. GET/HEAD are side-effect free.
 * - Binary safety: Redis keys/values are arbitrary bytes. In JSON they travel as `Bin`.
 * - No Redis data in URLs: key names, glob patterns, channel names and stream group names travel only in
 *   JSON bodies (reverse proxies and load balancers log URLs). Reads that need them are POSTs with no side
 *   effects and no confirmation (they still need CSRF + Origin like every POST). The server rejects any
 *   /api request whose query string carries `k`, `key`, `match`, `pattern`, `channel`, `group`, `query`
 *   (or plurals) with 400. SSE streams that need such parameters take a single-use subscription id instead.
 * - Errors: non-2xx responses carry `ApiError`.
 * - Server-sent events (text/event-stream) for live data: metrics, pub/sub, profiler.
 *   Each SSE `data:` line is one JSON object of the documented event type.
 */
import { z } from 'zod';
import { ENVIRONMENTS, ROLES, type Environment, type Role } from './roles.ts';
import type { CommandClass, ConfirmLevel } from './commands.ts';
import type { AnalysisCoverage, AnalysisRecommendation } from './insight.ts';

export const API_BASE = '/api/v1';

// ---------------------------------------------------------------------------
// Primitives

export const zBin = z.object({ enc: z.enum(['utf8', 'base64']), data: z.string() });
/** Binary-safe string. `utf8` when the bytes are valid UTF-8, otherwise `base64`. */
export type Bin = z.infer<typeof zBin>;

export const zRole = z.enum(ROLES);
export const zEnvironment = z.enum(ENVIRONMENTS);

export const REDIS_TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream', 'ReJSON-RL', 'TSDB-TYPE', 'MBbloom--', 'MBbloomCF', 'vectorset', 'array', 'none', 'unknown'] as const;
export type RedisType = (typeof REDIS_TYPES)[number] | (string & {});

export interface ApiError {
  error: {
    code:
      | 'unauthenticated'
      | 'forbidden'
      | 'csrf'
      | 'not_found'
      | 'validation'
      | 'command_blocked'
      | 'confirmation_required'
      | 'conflict'
      | 'read_only'
      | 'rate_limited'
      | 'too_large'
      | 'timeout'
      | 'redis_error'
      | 'unavailable'
      | 'internal';
    message: string;
    /** Present for code=confirmation_required. Resubmit the same request with `confirmation`. */
    confirmation?: ConfirmationChallenge;
    /** Present for code=command_blocked. */
    hint?: string;
    /** Present for code=conflict (409): what Redis holds now, so the client can show it and offer to reload or overwrite. */
    conflict?: EditConflict;
    details?: unknown;
  };
}

/**
 * Destructive actions are two-step. The first request returns 428 + challenge;
 * the client shows a dialog and resubmits with `confirmation: { token, typed?, reason? }`.
 * Tokens are single-use, bound to session + exact request, and expire after 2 minutes.
 * The token is bound to a hash of the exact request body, so the `preview` (built by the server from that
 * body) is exactly what runs when the same body is resubmitted; any other body gets a fresh 428.
 */
export interface ConfirmationChallenge {
  token: string;
  level: Exclude<ConfirmLevel, 'none'>;
  /** For level=typed the user must type this exact text (database name). */
  expectedText?: string;
  /** Prod writes require a free-text reason that lands in the audit log. */
  reasonRequired: boolean;
  summary: string;
  /** e.g. number of keys affected by a bulk delete. */
  impact?: { keys?: number; sample?: Bin[] };
  /** What will execute. Always present; render it in the dialog (as text, never HTML). */
  preview: ConfirmationPreview;
}

/** At most this many commands are listed in a preview; the rest are counted in `more`. */
export const PREVIEW_MAX_COMMANDS = 50;
/** At most this many arguments (after the command name) are listed per command; the rest are counted in `moreArgs`. */
export const PREVIEW_MAX_ARGS = 20;
/** Value arguments up to this size are shown whole; longer ones are cut to `PREVIEW_VALUE_PREFIX_BYTES`. */
export const PREVIEW_VALUE_FULL_BYTES = 32;
export const PREVIEW_VALUE_PREFIX_BYTES = 16;
/** Key names and patterns are shown in full up to this size (then cut, with `bytes`). */
export const PREVIEW_KEY_MAX_BYTES = 1024;

/**
 * One argument of a previewed command.
 * - `command`: command or subcommand name; `key`: a key name (or the channel of PUBLISH); `pattern`: a glob pattern (bulk delete);
 *   `arg`: any other argument (values, options, ids).
 * - `bytes` is set when `v` is only a prefix of the argument (cut at a UTF-8 boundary): show it as
 *   `<v>… (<bytes> bytes)`.
 */
export interface PreviewArg { kind: 'command' | 'key' | 'pattern' | 'arg'; v: Bin; bytes?: number }
export interface PreviewCommand {
  argv: PreviewArg[];
  /** Arguments not listed (beyond PREVIEW_MAX_ARGS). */
  moreArgs?: number;
}
export interface ConfirmationPreview {
  /** Number of commands that will run (CLI 1; workbench: the destructive lines; ops: 1, or 1 per key in cluster mode). */
  total: number;
  /** In execution order. At most PREVIEW_MAX_COMMANDS (fewer if the preview hits its size budget). */
  commands: PreviewCommand[];
  /** `total - commands.length` when the list was cut: show "+N more". */
  more?: number;
  /**
   * Bulk delete: the pattern and type filter that select the keys, and (on the first challenge) the counted
   * matches with a sample. Keys are deleted in UNLINK batches as SCAN finds them, so the set can change if keys
   * are written meanwhile.
   */
  bulk?: { match: Bin; type?: string; keys?: number; complete?: boolean; sample?: Bin[] };
}

export const zConfirmation = z
  .object({
    token: z.string().min(16).max(256),
    typed: z.string().max(256).optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();
export type Confirmation = z.infer<typeof zConfirmation>;

// ---------------------------------------------------------------------------
// Auth & session

export interface AuthProviders {
  oidc: { enabled: boolean; displayName: string };
  local: { enabled: boolean };
}

export interface Me {
  id: string;
  username: string;
  displayName: string;
  source: 'oidc' | 'local';
  /** Global role (highest the user can have anywhere). Per-database effective roles are on DatabaseSummary. */
  role: Role;
  csrfToken: string;
  totpEnabled: boolean;
  /** Local users must change a bootstrap/expired password before anything else. */
  mustChangePassword: boolean;
  /**
   * Local users whose role is in `requireTotpForRoles` must enroll TOTP (POST /auth/totp/enroll +
   * /auth/totp/confirm) before anything else. Until then every other API returns 403.
   */
  mustEnrollTotp: boolean;
  sessionExpiresAt: string;
  /**
   * Local accounts with TOTP enabled: how many unused recovery codes are left (0..RECOVERY_CODE_COUNT). Absent for
   * OIDC sessions and accounts without TOTP. Warn at RECOVERY_CODES_LOW or fewer.
   */
  recoveryCodesRemaining?: number;
}

/** Recovery codes per set; each is single-use and stands in for one authenticator code. */
export const RECOVERY_CODE_COUNT = 10;
/** The UI warns when this many unused recovery codes or fewer are left. */
export const RECOVERY_CODES_LOW = 3;
/**
 * A recovery code as typed: `xxxx-xxxx-xxxx` (12 characters of Crockford base32). The server ignores case, spaces
 * and hyphens, and reads o as 0 and i/l as 1.
 */
export const zRecoveryCode = z.string().trim().min(12).max(32).regex(/^[A-Za-z0-9 -]+$/, 'not a recovery code');

/**
 * `recoveryCode` (optional): a local account with TOTP may finish sign-in in one request with a recovery code instead
 * of the TOTP step. Without it, an account with TOTP gets `{ totpRequired: true }`.
 */
export const zLocalLogin = z.object({ username: z.string().trim().min(1).max(128), password: z.string().min(1).max(1024), recoveryCode: zRecoveryCode.optional() }).strict();
/** Login returns either `{ me }` or `{ totpRequired: true }` (then POST /auth/totp/verify). */
export type LocalLoginResponse = { me: Me } | { totpRequired: true };
/** The TOTP step accepts an authenticator code or, instead, one unused recovery code (consumed on success). */
export const zTotpVerify = z.union([z.object({ code: z.string().regex(/^\d{6}$/) }).strict(), z.object({ recoveryCode: zRecoveryCode }).strict()]);
export const zPasswordChange = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(12).max(1024) }).strict();
export interface TotpEnrollResponse { otpauthUrl: string; secretBase32: string }
export const zTotpConfirm = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
/** POST /auth/recovery-codes: replace the recovery code set (re-authenticates with the password; TOTP must be on). */
export const zRecoveryCodesRegenerate = z.object({ currentPassword: z.string().min(1).max(1024) }).strict();
/** The new codes, shown once. The previous set no longer works. */
export interface RecoveryCodesResponse { recoveryCodes: string[]; me: Me }

// ---------------------------------------------------------------------------
// Databases

export interface DatabaseSummary {
  id: string;
  name: string;
  description?: string;
  environment: Environment;
  /** True when config forces read-only (e.g. prod for everyone). */
  readOnly: boolean;
  effectiveRole: Role;
  /** Tools the caller may use on this database, computed by the server from its policy and the caller's role. */
  features: DatabaseFeatures;
  status: 'connected' | 'connecting' | 'error';
  statusMessage?: string;
  /**
   * The configured logical database index (`databases[].db`, 0 when unset). Display only: the server owns the
   * target, so the browser can never choose or change it (SELECT stays blocked). Added in v0.2.1; older servers omit it.
   */
  db?: number;
  /** Display-only labels from the server configuration (`databases[].tags`), e.g. team or service names. */
  tags?: string[];
  server?: {
    version: string;
    mode: 'standalone' | 'cluster' | 'sentinel';
    modules: { name: string; version: string }[];
  };
}

export interface DatabaseFeatures {
  /**
   * The profiler (`GET /databases/:db/profiler/stream`, MONITOR) is allowed: effective role admin and the
   * database environment is in `policy.profilerAllowedEnvironments`. Mirrors the server's enforcement.
   */
  profiler: boolean;
}

export interface DatabaseOverview {
  id: string;
  info: Record<string, Record<string, string>>; // INFO sections, parsed
  keyspace: { db: number; keys: number; expires: number; avgTtl: number }[];
  memory: { used: number; peak: number; maxmemory: number; fragmentationRatio: number; policy: string };
  clients: { connected: number; blocked: number };
  stats: { opsPerSec: number; hitRate: number | null; totalCommands: number; evictedKeys: number; expiredKeys: number };
  uptimeSeconds: number;
}

/** SSE event on GET /databases/:db/metrics/stream (every ~2s). */
export interface MetricsSample {
  t: number; // epoch ms
  opsPerSec: number;
  usedMemory: number;
  connectedClients: number;
  hitRate: number | null;
  netInputKbps: number;
  netOutputKbps: number;
  cpuSys: number;
  cpuUser: number;
}

// ---------------------------------------------------------------------------
// Keys

/** POST /databases/:db/keys/scan — one SCAN page (read-only; no confirmation). */
export const zScanRequest = z
  .object({
    cursor: z.string().regex(/^\d+$/).default('0'),
    match: z.string().max(512).default('*'),
    type: z.string().max(32).optional(),
    count: z.number().int().min(10).max(1000).default(200),
  })
  .strict();
export type ScanRequest = z.input<typeof zScanRequest>;
export interface KeyListItem {
  key: Bin;
  type: RedisType;
  ttl: number; // seconds, -1 = no expiry, -2 = gone
  size?: number; // bytes, from MEMORY USAGE (best effort)
}
export interface ScanResponse {
  cursor: string; // "0" when finished
  keys: KeyListItem[];
  /** Server stops a page after a time/iteration budget; the client may continue with `cursor`. */
  scanned: number;
  dbSize: number;
}

/** Most key names one `keys/names` request returns (the tree view asks for this many, as Redis Insight does). */
export const KEY_NAMES_MAX_COUNT = 10_000;
/** Keyspace slots a names scan examines by default before it stops ("Keys to scan"). */
export const KEY_SCAN_THRESHOLD_DEFAULT = 10_000;
/** Upper bound of `scanThreshold` in a request; the server further clamps it to `policy.keyScanThresholdMax`. */
export const KEY_SCAN_THRESHOLD_LIMIT = 10_000_000;
/** Most keys one `keys/meta` request describes. */
export const KEY_META_MAX_KEYS = 500;

/**
 * POST /databases/:db/keys/names (v0.2.1) — names only, binary-safe, read-only; no confirmation.
 * SCAN `COUNT` up to 2000 per call, looping until `count` names were found, `scanThreshold` keyspace slots were
 * examined, the cursor returned to 0, or the server's time budget (`policy.scanBudgetMs`) or byte budget ran out;
 * continue with `cursor`. A `match` without glob characters (`*`, `?`, `[`, after `\` escapes) is looked up
 * directly (EXISTS/TYPE) instead of scanned.
 */
export const zKeyNamesRequest = z
  .object({
    cursor: z.string().regex(/^\d{1,40}$/).default('0'),
    match: z.string().max(512).default('*'),
    type: z.string().max(32).optional(),
    count: z.number().int().min(1).max(KEY_NAMES_MAX_COUNT).default(KEY_NAMES_MAX_COUNT),
    scanThreshold: z.number().int().min(100).max(KEY_SCAN_THRESHOLD_LIMIT).default(KEY_SCAN_THRESHOLD_DEFAULT),
  })
  .strict();
export type KeyNamesRequest = z.input<typeof zKeyNamesRequest>;
export interface KeyNamesResponse {
  /** "0" when the whole keyspace was covered. Opaque in cluster mode (node index + node cursor). */
  cursor: string;
  keys: Bin[];
  /** Keyspace slots examined by this request (sum of SCAN COUNT hints; the key count for a direct lookup). */
  scanned: number;
  /** DBSIZE (summed over primaries). */
  dbSize: number;
  /** The `scanThreshold` the server applied (lower than requested when above `policy.keyScanThresholdMax`). */
  threshold: number;
  /** The match had no glob characters and was looked up directly. */
  exact?: true;
  /** Why the page ended before `count`, `threshold` or the end of the keyspace (continue with `cursor`). */
  stopped?: 'time' | 'bytes';
}

/**
 * POST /databases/:db/keys/meta (v0.2.1) — TYPE, PTTL and `MEMORY USAGE key SAMPLES 0` of up to
 * KEY_META_MAX_KEYS keys, pipelined; read-only, no confirmation. `ttl: false` / `size: false` skip PTTL / MEMORY
 * USAGE (hidden list columns), as Redis Insight's includeTTL / includeSize do.
 */
export const zKeyMetaRequest = z
  .object({ keys: z.array(zBin).min(1).max(KEY_META_MAX_KEYS), ttl: z.boolean().default(true), size: z.boolean().default(true) })
  .strict();
export type KeyMetaRequest = z.input<typeof zKeyMetaRequest>;
/**
 * One key's metadata, in request order. A key that no longer exists has type `none` (and ttl -2 when asked).
 * `ttl` is in whole seconds rounded up (-1 no expiry, -2 gone); present when asked. `size` (bytes) is present when
 * asked and MEMORY USAGE answered.
 */
export interface KeyMetaItem { key: Bin; type: RedisType; ttl?: number; size?: number }
export interface KeyMetaResponse { keys: KeyMetaItem[] }

// ---------------------------------------------------------------------------
// v0.4 arrays: the Redis 8.8+ native array type (`TYPE` = `array`), sparse and addressed by index.
// Server logic: apps/server/src/redis/array.ts and routes/array.ts; web: apps/web/src/components/ArrayDetail.tsx.

/** The largest index Redis accepts in an array (2^64 - 2). Indices travel as decimal strings: they exceed 2^53. */
export const ARRAY_MAX_INDEX = '18446744073709551614';
/** Whether `s` is an array index in canonical form: decimal digits without sign or leading zeros, at most ARRAY_MAX_INDEX. */
export function isArrayIndex(s: string): boolean {
  return /^(?:0|[1-9]\d{0,19})$/.test(s) && BigInt(s) <= BigInt(ARRAY_MAX_INDEX);
}
export const zArrayIndex = z.string().max(20).refine(isArrayIndex, `an array index is a whole number from 0 to ${ARRAY_MAX_INDEX}`);
/** Most elements one page, search or aggregate request returns (the `LIMIT` of ARSCAN and ARGREP). */
export const ARRAY_PAGE_MAX = 1000;
/**
 * Most existing elements one search (ARGREP) or aggregate (AROP) request makes Redis visit. A search over a range that
 * holds more stops after this many elements and says where to continue; an aggregate over such a range is refused
 * (400, with the count), so a result never covers less of the range than it claims.
 */
export const ARRAY_SCAN_MAX_ELEMENTS = 1_000_000;
/** At most this many predicates per search, each value at most ARRAY_PREDICATE_MAX_BYTES bytes. */
export const ARRAY_PREDICATES_MAX = 8;
/** 1 KiB, and 64 bytes for a MATCH with NOCASE (the console's limits: `ARGREP_VALUE_MAX_BYTES`, `ARGREP_NOCASE_MATCH_MAX_BYTES`). */
export const ARRAY_PREDICATE_MAX_BYTES = 1024;
export const ARRAY_NOCASE_MATCH_MAX_BYTES = 64;
/**
 * Element bytes one search request makes Redis read (review v0.4 r1 H1). The server estimates the array's average
 * element size (MEMORY USAGE / ARCOUNT) and searches at most this many bytes' worth of elements, divided by the cost
 * weight of the predicates (a NOCASE MATCH weighs its pattern length / 4), then says where to continue (`next`).
 */
export const ARRAY_SEARCH_MAX_BYTES = 64 * 1024 * 1024;
/**
 * ARGREP predicates the search offers: EXACT (whole value), MATCH (substring), GLOB (glob pattern, at most 8 `*`).
 * RE (regular expressions) is not offered and is blocked in the console: Redis evaluates it on every element of the
 * range with no time limit, and a 15-character pattern took about 1 s per KiB of value (docs/ARCHITECTURE.md § 7).
 */
export const ARRAY_SEARCH_KINDS = ['exact', 'match', 'glob'] as const;
/** AROP operations over a range (MATCH counts elements equal to `value`; USED counts existing elements). */
export const ARRAY_AGGREGATES = ['sum', 'min', 'max', 'and', 'or', 'xor', 'used', 'match'] as const;

/** ARINFO of an array. Numbers are decimal strings (`length` can be 2^64 - 1). */
export interface ArraySummary {
  /** ARCOUNT: elements that exist. */
  count: string;
  /** ARLEN: highest index + 1 (0 when empty). A sparse array has a `length` far above its `count`. */
  length: string;
  /** ARNEXT: where ARINSERT writes next (the insert cursor; ARSEEK and ARRING move it). */
  nextInsertIndex: string;
  slices?: number;
  sliceSize?: number;
}
/** One existing element. Long values are cut to KEY_ELEMENT_PREVIEW_BYTES (`truncated`); `ref` reads the full bytes through POST /key/element. */
export interface ArrayElement { index: string; value: Bin; truncated?: true; ref: ElementRef }
/** A page of existing elements, in index order (descending with `reverse`). Gaps between indices are empty positions. */
export interface ArrayPage {
  items: ArrayElement[];
  /** The range this page read, in its direction. */
  start: string;
  end: string;
  reverse: boolean;
  /** Where the next page starts (just past the last index returned); absent when the range is exhausted. */
  next?: string;
}

/**
 * POST /databases/:db/array/range (read-only; no confirmation): existing elements by index, `ARSCAN key start end LIMIT
 * count`. `start` defaults to 0 (ARRAY_MAX_INDEX with `reverse`), `end` to the far end of that direction. Continue with
 * the page's `next`; jump by passing any index as `start`.
 */
export const zArrayRange = z
  .object({
    key: zBin,
    start: zArrayIndex.optional(),
    end: zArrayIndex.optional(),
    count: z.number().int().min(1).max(ARRAY_PAGE_MAX).default(100),
    reverse: z.boolean().default(false),
  })
  .strict();
export type ArrayRangeRequest = z.input<typeof zArrayRange>;

/**
 * POST /databases/:db/array/search (read-only): `ARGREP key start end <predicates> AND|OR [NOCASE] LIMIT limit
 * [WITHVALUES]`. A range with more than ARRAY_SCAN_MAX_ELEMENTS elements is searched up to that many (`searchedTo`) and
 * continued with `next`. `start` > `end` searches downwards.
 */
export const zArraySearch = z
  .object({
    key: zBin,
    start: zArrayIndex.default('0'),
    end: zArrayIndex.default(ARRAY_MAX_INDEX),
    predicates: z.array(z.object({ kind: z.enum(ARRAY_SEARCH_KINDS), value: zBin }).strict()).min(1).max(ARRAY_PREDICATES_MAX),
    combine: z.enum(['and', 'or']).default('or'),
    nocase: z.boolean().default(false),
    limit: z.number().int().min(1).max(ARRAY_PAGE_MAX).default(100),
    values: z.boolean().default(true),
  })
  .strict();
export type ArraySearchRequest = z.input<typeof zArraySearch>;
export interface ArraySearchResult {
  /** Matches in the search direction. `value`, `truncated` and `ref` are absent when the request set `values: false`. */
  items: { index: string; value?: Bin; truncated?: true; ref?: ElementRef }[];
  start: string;
  /** The searched part of the range ends here (the request's `end` unless ARRAY_SCAN_MAX_ELEMENTS stopped it). */
  searchedTo: string;
  /** Existing elements in the searched part (AROP USED). */
  elements: number;
  /** Where to continue towards the same `end`: after the last match when `limit` was reached, else after `searchedTo`. Absent when done. */
  next?: string;
}

/**
 * POST /databases/:db/array/aggregate (read-only): `AROP key start end SUM|MIN|MAX|AND|OR|XOR|USED|MATCH value`. A range
 * holding more than ARRAY_SCAN_MAX_ELEMENTS elements is refused with 400 (narrow it). `value` is required for `match`.
 */
export const zArrayAggregate = z
  .object({ key: zBin, start: zArrayIndex, end: zArrayIndex, op: z.enum(ARRAY_AGGREGATES), value: zBin.optional() })
  .strict();
export type ArrayAggregateRequest = z.input<typeof zArrayAggregate>;
export interface ArrayAggregateResult {
  op: (typeof ARRAY_AGGREGATES)[number];
  /** AROP's reply as text (exact integers; SUM, MIN and MAX as Redis prints them); null when no element in range had a usable value. */
  result: string | null;
  /** Existing elements in the range (AROP USED). */
  elements: number;
}

/** Response of POST /databases/:db/key/read. */
export interface KeyDetails {
  key: Bin;
  type: RedisType;
  ttl: number;
  encoding?: string;
  size?: number;
  length?: number; // strlen/hlen/llen/scard/zcard/xlen; arcount (existing elements) for arrays
  value: KeyValue;
  /** Applied collection criteria; matches is this page, totalMatches only when exactly known. */
  filter?: { matches: number; totalMatches?: number };
  hashFieldExpiry?: { supported: boolean; reason?: string };
}

/**
 * Collection elements longer than `KEY_ELEMENT_PREVIEW_BYTES` are cut to that size and flagged
 * (`truncated: true` on the element; `truncatedMembers` counts cut set members). Re-fetch with
 * `full` is for strings/JSON; use POST /key/element with the supplied ref for full collection bytes.
 */
export type KeyValue =
  | { type: 'string'; value: Bin; truncated: boolean; totalBytes: number }
  | { type: 'hash'; entries: { field: Bin; value: Bin; truncated?: true; fieldTruncated?: true; ttl?: number; ref?: ElementRef }[]; cursor: string; total: number }
  | { type: 'list'; items: { index: number; value: Bin; truncated?: true; ref?: ElementRef }[]; offset: number; total: number }
  | { type: 'set'; members: Bin[]; cursor: string; total: number; truncatedMembers?: number; memberRefs?: ElementRef[] }
  | { type: 'zset'; members: { member: Bin; score: string; truncated?: true; ref?: ElementRef }[]; offset: number; total: number; cursor?: string; reverse?: boolean; matchedTotal?: number }
  /** Newest first. Next page: pass the last entry's id as `cursor` (exclusive). */
  | { type: 'stream'; entries: StreamEntry[]; total: number; lastId: string; groups: number }
  | { type: 'json'; json: string; truncated: boolean }
  | { type: 'timeseries'; info: Record<string, unknown>; samples: [number, string][] }
  /** v0.4: summary and the first page of members (further pages: POST /vectorset/members). */
  | { type: 'vectorset'; info: VectorSetInfo; page: VectorSetPage }
  /** v0.4 arrays: ARINFO and the first page (ARSCAN from `cursor` as the start index, or 0; `reverse` from the end). */
  | ({ type: 'array'; info: ArraySummary } & ArrayPage)
  | { type: 'unsupported'; message: string };

export interface StreamEntry { id: string; fields: { field: Bin; value: Bin; truncated?: true; ref?: ElementRef }[] }

export const KEY_ELEMENT_PREVIEW_BYTES = 65_536;
/** Default string/JSON preview size; `full=1` raises it to the server's `maxValueBytes`. */
export const KEY_VALUE_PREVIEW_BYTES = 65_536;

/**
 * POST /databases/:db/key/read (read-only; no confirmation)
 * - key: the key (raw bytes as Bin)
 * - cursor: HSCAN/SSCAN cursor (hash, set) or stream entry id to continue from (exclusive, newest first)
 * - offset: list/zset start index; count: page size (1..1000, default 100)
 * - full: load strings/JSON up to maxValueBytes instead of the preview size
 */
export const zKeyRead = z
  .object({
    key: zBin,
    cursor: z.string().regex(/^(\d+|\d+-\d+)$/).optional(),
    offset: z.number().int().min(0).default(0),
    count: z.number().int().min(1).max(1000).default(100),
    full: z.boolean().default(false),
    match: z.string().max(512).optional(),
    exact: zBin.optional(),
    reverse: z.boolean().default(false),
    scoreMin: z.string().regex(/^(?:\(?[-+]?(?:\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|inf))$/).max(64).optional(),
    scoreMax: z.string().regex(/^(?:\(?[-+]?(?:\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|inf))$/).max(64).optional(),
    streamStart: z.string().regex(/^(?:-|\d+-\d+)$/).optional(),
    streamEnd: z.string().regex(/^(?:\+|\d+-\d+)$/).optional(),
  })
  .strict();
export type KeyReadRequest = z.input<typeof zKeyRead>;

/**
 * Address of a collection element, entirely in POST bodies. Scan, rank and list references recheck the identity digest
 * (a list's is the SHA-256 of the whole element the page read, so a push that moved the index gives 409).
 */
export const zElementRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hash'), field: zBin }).strict(),
  z.object({ kind: z.literal('list'), index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), identity: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  z.object({ kind: z.literal('set'), member: zBin }).strict(),
  z.object({ kind: z.literal('zset'), member: zBin }).strict(),
  z.object({ kind: z.literal('stream'), id: z.string().regex(/^\d+-\d+$/), position: z.number().int().min(0).max(99999) }).strict(),
  z.object({ kind: z.literal('scan'), type: z.enum(['hash', 'set', 'zset']), cursor: z.string().regex(/^\d+$/), count: z.number().int().min(1).max(1000), match: z.string().max(512).optional(), position: z.number().int().min(0).max(99999), identity: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  z.object({ kind: z.literal('rank'), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), reverse: z.boolean(), scoreMin: z.string().max(64).optional(), scoreMax: z.string().max(64).optional(), identity: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  // v0.4 arrays: an element by index; `identity` is the SHA-256 of the whole element the page read (409 when another value is there now).
  z.object({ kind: z.literal('array'), index: zArrayIndex, identity: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
]);
export type ElementRef = z.infer<typeof zElementRef>;
export const zKeyElementRequest = z.object({ key: zBin, ref: zElementRef }).strict();
export interface KeyElementResponse { value: Bin; /** Full identity for hash/set/zset when a preview cut it. */ identity?: Bin; score?: string }

const zKey = zBin;
const zConfirmOpt = { confirmation: zConfirmation.optional() };

/**
 * Compare-and-set expectation (web review v0.2 r3): what the client last read of the data an op replaces. The
 * server checks it atomically before writing: on its own connection for the caller's tier it sends `WATCH key`,
 * reads the key's TYPE and the replaced bytes, compares, and writes in `MULTI`/`EXEC` (no Lua). On a mismatch, or
 * when the key changes between that read and `EXEC` more often than the server retries, nothing is written and
 * the request gets **409 `conflict`** with `error.conflict` (`EditConflict`).
 *
 * - `type`: the Redis `TYPE` reply the client read (`string`, `hash`, `list`, `zset`, `ReJSON-RL`, ...).
 * - `sha256`: lowercase hex SHA-256 of the exact bytes the op replaces, as last read; `null` when that element did
 *   not exist (a hash field or sorted-set member that was not there). Per op:
 *   - `string.set`: the whole string value.
 *   - `hash.set`: the value of its single field (`entries` must hold exactly one entry).
 *   - `list.set`: the element at `index` (`LINDEX`; `null` = out of range).
 *   - `zset.add`: the score of its single member, as Redis prints it (`ZSCORE`, the same text as the key
 *     browser's `score`; `members` must hold exactly one entry).
 *   - `json.set` / `json.delete`: the whole document as `JSON.GET key` returns it (`KeyValue.json`).
 *   - `key.rename` / `key.delete` (one key): optional; when sent, the value of a string or the document of a
 *     JSON key. Other types are checked by `type` only (their content is never read whole).
 *   - `array.set` (v0.4): the element at `index` (`ARGET`; `null` = the index is empty). Required.
 *   - `array.insert` (v0.4): none (send the type alone: `array`, or `none` to create the key). The server checks that
 *     every index ARINSERT would write is empty.
 *   Omit `sha256` to check the type alone.
 */
export const zEditExpect = z
  .object({
    type: z.string().min(1).max(64),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  })
  .strict();
export type EditExpect = z.infer<typeof zEditExpect>;

/** `error.conflict` of a 409: the compare-and-set expectation did not hold, and nothing was written. */
export interface EditConflict {
  /** `type`: the key's type changed (`current.type` is `none` when the key no longer exists); `value`: the compared bytes differ. */
  reason: 'type' | 'value';
  /** The expectation the request carried. */
  expected: EditExpect;
  current: {
    type: RedisType;
    /**
     * The compared element now (string value, hash field value, list element, score text, JSON document). Absent
     * when it does not exist, when the type differs, or when the op checks the type only.
     */
    value?: Bin;
    /** `value` holds only the first `KEY_VALUE_PREVIEW_BYTES` bytes; the element has `totalBytes` bytes. */
    truncated?: boolean;
    totalBytes?: number;
    /**
     * An expectation that matches what Redis holds now. Resend the op with it to overwrite this exact state
     * ("Overwrite anyway"); it is checked again like any other. Absent when the current state cannot be compared
     * (the element is larger than the server reads for a comparison).
     */
    expect?: EditExpect;
  };
}

// ---------------------------------------------------------------------------
// v0.4 vector sets (stream S2, F23). Reads: `key/read` (summary + first page) and the `vectorset/*` routes below.
// Writes: the `vset.*` typed ops of POST /databases/:db/ops. Every bound below is enforced by the server.

/** Members per page (`VRANGE … count`): default and maximum. */
export const VSET_PAGE_DEFAULT = 100;
export const VSET_PAGE_MAX = 500;
/** Members whose attributes one `vectorset/attributes` request reads (the rows on screen). */
export const VSET_ATTR_ROWS_MAX = 100;
/** Bytes of each attribute a members row shows; the element panel reads up to the server's `maxValueBytes`. */
export const VSET_ATTR_PREVIEW_BYTES = 1024;
/** Largest member name accepted in a request (paging start, element, search by member, edits). */
export const VSET_MEMBER_MAX_BYTES = 65_536;
/** Embeddings of sets with more dimensions than this are not read (VEMB has no range). */
export const VSET_EMBED_MAX_DIM = 16_384;
/** Values of an embedding returned to the browser; the rest are counted (`embedding.truncated`). */
export const VSET_EMBED_PREVIEW_VALUES = 4096;
/** Neighbours listed per HNSW layer (`VLINKS`), and layers listed. */
export const VSET_LINKS_PER_LAYER_MAX = 64;
export const VSET_LINK_LAYERS_MAX = 32;
/** Similarity search bounds: results (`COUNT`), `EF`, filter expression length and filter effort (`FILTER-EF`). */
export const VSET_SEARCH_COUNT_MAX = 100;
export const VSET_SEARCH_EF_MAX = 1000;
export const VSET_FILTER_MAX_CHARS = 1024;
export const VSET_FILTER_EF_MAX = 100_000;
/** Coordinates in a query vector or a new element (`VALUES n …`). */
export const VSET_VALUES_MAX = VSET_EMBED_MAX_DIM;
/** A finite decimal coordinate as Redis parses it (no inf/nan, no hex). */
export const VSET_NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d{1,3})?$/;

// Redis reads each coordinate as a double and refuses one beyond its range (review v0.4 r1 L3).
const zVsetNumber = z.string().max(40).regex(VSET_NUMBER, 'not a finite decimal number').refine((x) => Number.isFinite(Number(x)), 'not a finite decimal number');
const zVsetValues = z.array(zVsetNumber).min(1).max(VSET_VALUES_MAX);

/** `VINFO` fields the inspector shows (absent when this Redis does not report them), plus `VCARD` and `VDIM`. */
export interface VectorSetInfo {
  /** VCARD */
  size: number;
  /** VDIM (after any REDUCE projection). */
  dim: number;
  /** `quant-type`: `f32` (NOQUANT), `int8` (Q8, the default) or `bin` (BIN). */
  quantization?: string;
  /** `hnsw-m`: links per node per layer (layer 0 has twice as many). */
  hnswM?: number;
  /** `max-level`: highest HNSW layer. */
  maxLevel?: number;
  /** `attributes-count`: members with attributes. */
  attributesCount?: number;
  /** `projection-input-dim`: the input dimension when the set was created with REDUCE (0 = no projection). */
  projectionInputDim?: number;
}
/**
 * One member in a page. `member` is cut at KEY_ELEMENT_PREVIEW_BYTES when longer (`truncated`): such a row cannot be
 * opened, edited or removed from the inspector.
 */
export interface VectorSetMember { member: Bin; truncated?: true }
/**
 * A page of members in lexicographic (byte) order, from `VRANGE key start end count`. `next`: pass as `after` to
 * read the following page (absent on the last page). `prefix`: the applied prefix filter. `nextUnavailable`: the
 * page's last member is longer than VSET_MEMBER_MAX_BYTES, so the following page cannot be addressed from here.
 */
export interface VectorSetPage { members: VectorSetMember[]; next?: Bin; prefix?: Bin; nextUnavailable?: true }

/** POST /databases/:db/vectorset/members (read-only): one page of members, optionally with a byte prefix. */
export const zVsetMembersRequest = z
  .object({ key: zBin, after: zBin.optional(), prefix: zBin.optional(), count: z.number().int().min(1).max(VSET_PAGE_MAX).default(VSET_PAGE_DEFAULT) })
  .strict();
export type VsetMembersRequest = z.input<typeof zVsetMembersRequest>;
export interface VsetMembersResponse { page: VectorSetPage; /** VCARD now. */ total: number }

/**
 * POST /databases/:db/vectorset/attributes (read-only): `VGETATTR` of the members on screen, in request order.
 * `null`: no attributes (or no such member). `value` is cut at VSET_ATTR_PREVIEW_BYTES (`truncated`, `totalBytes`).
 * `tooLarge`: the attribute is larger than the server reads for a row; open the member to read it.
 */
export const zVsetAttributesRequest = z.object({ key: zBin, members: z.array(zBin).min(1).max(VSET_ATTR_ROWS_MAX) }).strict();
export type VsetAttributeCell = { value: Bin; truncated?: true; totalBytes?: number } | { tooLarge: true } | null;
export interface VsetAttributesResponse { attributes: VsetAttributeCell[] }

/**
 * POST /databases/:db/vectorset/element (read-only): one member's attributes (whole, up to `maxValueBytes`), its
 * embedding (`VEMB`, at most VSET_EMBED_PREVIEW_VALUES values, not read above VSET_EMBED_MAX_DIM dimensions) and its
 * HNSW neighbours per layer (`VLINKS … WITHSCORES`, bounded). 404 when the member does not exist.
 */
export const zVsetElementRequest = z.object({ key: zBin, member: zBin, links: z.boolean().default(true) }).strict();
export type VsetElementRequest = z.input<typeof zVsetElementRequest>;
export interface VsetNeighbour { member: Bin; score: string; truncated?: true }
export interface VsetElementResponse {
  member: Bin;
  /** The attribute bytes; null when the member has none. Compare-and-set edits hash these bytes (empty when null). */
  attributes: Bin | null;
  /** The attribute is larger than `maxValueBytes`: not read, so it cannot be edited here. */
  attributesTooLarge?: true;
  /**
   * Coordinates as Redis prints them (approximations for `int8`/`bin` sets). `skipped`: the set has more than
   * VSET_EMBED_MAX_DIM dimensions and VEMB was not sent.
   */
  embedding: { values: string[]; dim: number; truncated: boolean; skipped?: true };
  quantization?: string;
  /** Layer 0 (the densest) first, upwards; Redis lists the highest layer first. `more`: neighbours not listed. */
  links?: { layer: number; neighbours: VsetNeighbour[]; more?: number }[];
  /** Layers not listed (beyond VSET_LINK_LAYERS_MAX). */
  moreLayers?: number;
  /** The neighbour lists are larger than the server reads for this panel; `links` is absent. */
  linksTooLarge?: true;
}

/**
 * POST /databases/:db/vectorset/search (read-only): `VSIM key (ELE member | VALUES n …) COUNT n WITHSCORES
 * [WITHATTRIBS] [EF ef] [FILTER expr FILTER-EF fe]`. The server always sends FILTER-EF with a filter (default
 * `count × 100`, at most VSET_FILTER_EF_MAX), so a filter never scans the whole set. Never TRUTH or NOTHREAD.
 */
export const zVsetSearchRequest = z
  .object({
    key: zBin,
    query: z.union([z.object({ element: zBin }).strict(), z.object({ values: zVsetValues }).strict()]),
    count: z.number().int().min(1).max(VSET_SEARCH_COUNT_MAX).default(10),
    ef: z.number().int().min(1).max(VSET_SEARCH_EF_MAX).optional(),
    filter: z.string().min(1).max(VSET_FILTER_MAX_CHARS).optional(),
    filterEf: z.number().int().min(1).max(VSET_FILTER_EF_MAX).optional(),
    withAttributes: z.boolean().default(false),
  })
  .strict();
export type VsetSearchRequest = z.input<typeof zVsetSearchRequest>;
export interface VsetSearchResult { member: Bin; score: string; truncated?: true; attributes?: VsetAttributeCell }
export interface VsetSearchResponse { results: VsetSearchResult[] }

/**
 * Vector-set typed ops (POST /databases/:db/ops), operator and up, refused on read-only databases:
 * - `vset.add`: `VADD key VALUES n … member [NOQUANT|Q8|BIN] [SETATTR attributes]`. VADD replaces the vector of an
 *   existing member, so `expect` is required and must say the member is absent: `{ type: 'vectorset', sha256: null }`
 *   on an existing set, `{ type: 'none' }` to create the key. A member that exists meanwhile is a 409 (no overwrite).
 * - `vset.setattr`: `VSETATTR key member attributes` (empty attributes remove them). `expect` is required:
 *   `{ type: 'vectorset', sha256 }` of the attribute bytes as read (the SHA-256 of nothing when it had none).
 * - `vset.remove`: `VREM key member` (VREM takes one member), with the same confirmation as removing a hash field.
 */
export const zVsetOps = [
  z.object({
    op: z.literal('vset.add'), key: zBin, member: zBin, values: zVsetValues,
    quantization: z.enum(['NOQUANT', 'Q8', 'BIN']).optional(), attributes: zBin.optional(), expect: zEditExpect,
  }),
  z.object({ op: z.literal('vset.setattr'), key: zBin, member: zBin, attributes: zBin, expect: zEditExpect }),
  z.object({ op: z.literal('vset.remove'), key: zBin, member: zBin }),
] as const;

/** Typed write operations: POST /databases/:db/ops. Server maps each op to a fixed command. */
export const zKeyOp = z.discriminatedUnion('op', [
  /** `keepTtl`: SET … KEEPTTL (keeps the key's current expiry; not with `ttl`). */
  z.object({ op: z.literal('string.set'), key: zKey, value: zBin, ttl: z.number().int().positive().optional(), nx: z.boolean().optional(), keepTtl: z.boolean().optional(), expect: zEditExpect.optional() }),
  z.object({ op: z.literal('key.delete'), keys: z.array(zKey).min(1).max(1000), expect: zEditExpect.optional() }),
  z.object({ op: z.literal('key.rename'), key: zKey, newKey: zKey, nx: z.boolean().default(true), expect: zEditExpect.optional() }),
  z.object({ op: z.literal('key.expire'), key: zKey, ttl: z.number().int().positive() }),
  z.object({ op: z.literal('key.persist'), key: zKey }),
  z.object({ op: z.literal('hash.set'), key: zKey, entries: z.array(z.object({ field: zBin, value: zBin })).min(1).max(1000), expect: zEditExpect.optional() }),
  z.object({ op: z.literal('hash.delete'), key: zKey, fields: z.array(zBin).min(1).max(1000) }),
  z.object({ op: z.literal('list.push'), key: zKey, values: z.array(zBin).min(1).max(1000), end: z.enum(['head', 'tail']) }),
  z.object({ op: z.literal('list.set'), key: zKey, index: z.number().int(), value: zBin, expect: zEditExpect.optional() }),
  z.object({ op: z.literal('list.remove'), key: zKey, value: zBin, count: z.number().int().default(1) }),
  z.object({ op: z.literal('set.add'), key: zKey, members: z.array(zBin).min(1).max(1000) }),
  z.object({ op: z.literal('set.remove'), key: zKey, members: z.array(zBin).min(1).max(1000) }),
  z.object({ op: z.literal('zset.add'), key: zKey, members: z.array(z.object({ member: zBin, score: z.string().regex(/^[-+]?(\d+(\.\d+)?([eE][-+]?\d+)?|inf|\+inf|-inf)$/) })).min(1).max(1000), expect: zEditExpect.optional() }),
  z.object({ op: z.literal('zset.remove'), key: zKey, members: z.array(zBin).min(1).max(1000) }),
  z.object({ op: z.literal('stream.add'), key: zKey, id: z.string().regex(/^(\*|\d+(-(\d+|\*))?)$/).default('*'), fields: z.array(z.object({ field: zBin, value: zBin })).min(1).max(1000) }),
  z.object({ op: z.literal('stream.delete'), key: zKey, ids: z.array(z.string().regex(/^\d+-\d+$/)).min(1).max(1000) }),
  z.object({ op: z.literal('stream.group.create'), key: zKey, group: z.union([z.string().min(1).max(256), zBin]), id: z.string().max(64).default('$'), mkstream: z.boolean().default(false) }),
  z.object({ op: z.literal('stream.group.destroy'), key: zKey, group: z.union([z.string().min(1).max(256), zBin]) }),
  /** XGROUP DELCONSUMER (v0.2.1 web review L2): its pending entries leave the group's PEL; confirmed. */
  z.object({ op: z.literal('stream.consumer.delete'), key: zKey, group: z.union([z.string().min(1).max(256), zBin]), consumer: z.union([z.string().min(1).max(256), zBin]) }),
  z.object({ op: z.literal('stream.claim'), key: zKey, group: z.union([z.string().min(1).max(256), zBin]), consumer: z.union([z.string().min(1).max(256), zBin]), minIdleMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), ids: z.array(z.string().regex(/^\d+-\d+$/)).min(1).max(1000) }),
  z.object({ op: z.literal('hash.expire'), key: zKey, fields: z.array(zBin).min(1).max(1000), ttl: z.number().int().positive().max(2147483647) }),
  z.object({ op: z.literal('hash.persist'), key: zKey, fields: z.array(zBin).min(1).max(1000) }),
  z.object({ op: z.literal('stream.ack'), confirmAck: z.boolean().optional(), key: zKey, group: z.union([z.string().min(1).max(256), zBin]), ids: z.array(z.string().regex(/^\d+-\d+$/)).min(1).max(1000) }),
  z.object({ op: z.literal('json.set'), key: zKey, path: z.string().max(1024).default('$'), json: z.string().max(10_000_000), expect: zEditExpect.optional() }),
  z.object({ op: z.literal('json.delete'), key: zKey, path: z.string().max(1024), expect: zEditExpect.optional() }),
  ...zVsetOps,
  // v0.4 arrays (planned in apps/server/src/redis/array.ts).
  /**
   * `ARSET key index value`, always compare-and-set: `expect` is `{ type: 'array', sha256 }` with the SHA-256 of the
   * element at `index`, or `null` when that index was empty.
   */
  z.object({ op: z.literal('array.set'), key: zKey, index: zArrayIndex, value: zBin, expect: zEditExpect }),
  /**
   * `ARINSERT key value…` at the insert cursor (ARNEXT). ARINSERT overwrites whatever sits there, so the server checks
   * under WATCH that every index it writes is empty (409 otherwise). `expect`: `{ type: 'array' }` appends to an existing
   * array; `{ type: 'none' }` creates the key and fails with 409 if it exists (creates never overwrite).
   */
  z.object({ op: z.literal('array.insert'), key: zKey, values: z.array(zBin).min(1).max(1000), expect: zEditExpect }),
  /** `ARDEL key index…` (confirmation). */
  z.object({ op: z.literal('array.delete'), key: zKey, indexes: z.array(zArrayIndex).min(1).max(1000) }),
  /** `ARDELRANGE key start end` (confirmation): every element from `start` to `end`, inclusive, either order. */
  z.object({ op: z.literal('array.delete-range'), key: zKey, start: zArrayIndex, end: zArrayIndex }),
]).and(z.object(zConfirmOpt));
export type KeyOp = z.infer<typeof zKeyOp>;
export interface OpResult { ok: true; result?: unknown }

/** Bulk delete by pattern. Always returns 428 with impact (count + sample) first. */
export const zBulkDelete = z.object({ match: z.string().min(1).max(512), type: z.string().max(32).optional(), ...zConfirmOpt }).strict();
export interface BulkDeleteResult { deleted: number; scanned: number }

/**
 * Pattern delete as a job (v0.2.1, F20). `POST /databases/:db/bulk-delete/jobs` takes the same body and the same
 * 428 impact challenge (count, sample, typed name and reason on production) as `bulk-delete`; once confirmed it starts
 * the delete and answers at once with the job. Poll `GET …/bulk-delete/jobs/:id` and stop it with
 * `POST …/bulk-delete/jobs/:id/cancel` (between batches: what was deleted stays deleted). Only the session that
 * started a job can see or cancel it; finished jobs are kept for 10 minutes. The job keeps running when the browser
 * goes away; revoking or demoting the user stops it.
 */
export type BulkDeleteJobState = 'running' | 'done' | 'cancelled' | 'stopped' | 'failed';
export interface BulkDeleteJob {
  id: string;
  state: BulkDeleteJobState;
  /** Keys visited by SCAN so far. */
  scanned: number;
  /** Keys UNLINK removed (keys that vanished meanwhile are not counted). */
  deleted: number;
  /** Keys whose UNLINK failed. */
  failed: number;
  /** The impact count shown in the confirmation, when it was counted. */
  expected?: number;
  /** Failures by error code (at most 8 codes; never key names or Redis error text). */
  errors: { code: string; count: number }[];
  /** Every key matching the pattern was visited (the cursor returned to 0). */
  complete: boolean;
  /**
   * Why a job ended before the end of the keyspace: `cancelled` by the user, `session` ended or account changed,
   * `time` (10 minutes) or `keys` (1,000,000 visited) limit, `errors` (every UNLINK failed on three pages in a row),
   * `shutdown` (the server stopped).
   */
  stopReason?: 'cancelled' | 'session' | 'time' | 'keys' | 'errors' | 'shutdown';
  startedAt: string;
  finishedAt?: string;
  elapsedMs: number;
}
export interface BulkDeleteJobResponse { job: BulkDeleteJob }

// ---------------------------------------------------------------------------
// Console (smart CLI) & workbench

export const zCliRequest = z
  .object({
    /** Either a redis-cli style line or a pre-tokenized argv. */
    line: z.string().max(100_000).optional(),
    argv: z.array(z.string().max(10_000_000)).min(1).max(10_000).optional(),
    /** For binary args encoded by the client. */
    argvBin: z.array(zBin).min(1).max(10_000).optional(),
    ...zConfirmOpt,
  })
  .strict()
  .refine((v) => [v.line, v.argv, v.argvBin].filter((x) => x !== undefined).length === 1, 'exactly one of line, argv, argvBin');
export type CliRequest = z.infer<typeof zCliRequest>;

/** RESP3 reply tree, binary safe, size-capped by the server. */
export type Reply =
  | { t: 'str'; v: Bin }
  | { t: 'status'; v: string }
  | { t: 'err'; v: string }
  | { t: 'int'; v: string } // string to keep 64-bit precision
  | { t: 'dbl'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'nil' }
  | { t: 'arr'; v: Reply[]; more?: number }
  | { t: 'set'; v: Reply[]; more?: number }
  | { t: 'map'; v: [Reply, Reply][]; more?: number }
  | { t: 'truncated'; bytes: number };

export interface CliResponse {
  argv: string[]; // echo of what ran (args truncated to 200 chars each)
  commandClass: CommandClass;
  durationMs: number;
  reply: Reply;
}

export const zWorkbenchRequest = z.object({ script: z.string().max(200_000), stopOnError: z.boolean().default(true), ...zConfirmOpt }).strict();
/**
 * Runs non-empty, non-comment (#, //) lines sequentially; each is policy-checked like /cli. Max 100 commands.
 * `cancelled`: the script was stopped by `POST …/workbench/cancel`. `results` holds the lines that finished, in
 * script order; with `inFlight`, the next line had been sent and was still running (Redis may have run it); no
 * later line was sent.
 */
export interface WorkbenchResponse { results: (CliResponse | { line: string; error: ApiError['error'] })[]; cancelled?: { inFlight: boolean } }
/** POST /databases/:db/workbench/cancel (body `{}`): stops the caller's running script on this database before its next line. */
export const zWorkbenchCancel = z.object({}).strict();
/** `cancelled: false` when this session has no script running on the database (it may just have finished). */
export interface WorkbenchCancelResponse { cancelled: boolean }

/** Redis COMMAND key extraction metadata. Editing/navigation hints only; never an authorization input. */
export interface CommandKeySpec {
  begin: { type: 'index'; index: number } | { type: 'keyword'; keyword: string; startfrom: number };
  find: { type: 'range'; lastkey: number; keystep: number; limit: number } | { type: 'keynum'; keynumidx: number; firstkey: number; keystep: number };
}

/** GET /databases/:db/commands — command docs for autocomplete, annotated with policy for the caller. */
export interface CommandDoc {
  name: string; // e.g. "HSET" or "CLIENT KILL"
  summary: string;
  since?: string;
  group: string;
  complexity?: string;
  arguments: CommandArg[];
  /** Optional complete, supported COMMAND key specs; absent on older/unknown metadata. */
  keySpecs?: CommandKeySpec[];
  class: CommandClass;
  allowed: boolean; // for the caller on this database
  hint?: string;
}
export interface CommandArg {
  name: string;
  type: string; // key | string | integer | double | pattern | unix-time | pure-token | oneof | block
  token?: string;
  optional?: boolean;
  multiple?: boolean;
  arguments?: CommandArg[];
}

// ---------------------------------------------------------------------------
// Diagnostics

export interface SlowlogEntry { id: number; timestamp: number; durationMicros: number; argv: string[]; client?: string; clientName?: string }
export interface ClientInfo { id: string; addr: string; name: string; age: number; idle: number; db: number; cmd: string; user: string; flags: string }

/** POST /databases/:db/analysis — sampled memory analysis (bounded: max keys sampled, max time). */
export const zAnalysisRequest = z.object({ sampleSize: z.number().int().min(100).max(100_000).default(10_000), match: z.string().max(512).default('*'), delimiter: z.string().max(4).default(':') }).strict();
export interface AnalysisReport {
  sampled: number;
  dbSize: number;
  durationMs: number;
  totalSampledBytes: number;
  byType: { type: string; keys: number; bytes: number }[];
  topKeysBySize: { key: Bin; type: string; bytes: number; ttl: number }[];
  topKeysByLength: { key: Bin; type: string; length: number }[];
  prefixes: { prefix: string; keys: number; bytes: number }[];
  ttl: { noExpiry: number; lt1h: number; lt1d: number; lt7d: number; gt7d: number };
  /** v0.2.1: actionable findings about the sample (insight.ts). Absent from older servers. */
  recommendations?: AnalysisRecommendation[];
  /** v0.2.1: how much of the keyspace the report saw, and why sampling stopped. */
  coverage?: AnalysisCoverage;
}

// ---------------------------------------------------------------------------
// Pub/Sub (viewer+). Live messages are two steps, so channel names never appear in a URL:
//  1. POST /databases/:db/pubsub/subscriptions {channels, patterns} -> PubSubSubscription
//  2. GET  /databases/:db/pubsub/stream?sub=<id> (SSE; EventSource can only GET)
// The id is opaque, single-use, bound to the session and database, and must be used within 60 s.
// Max 10 channels + patterns; the stream auto-closes after 15 min. Reconnecting needs a new id.

export const PUBSUB_SUBSCRIPTION_TTL_MS = 60_000;
export const zPubSubSubscribe = z
  .object({
    channels: z.array(z.string().min(1).max(1024)).max(10).default([]),
    patterns: z.array(z.string().min(1).max(1024)).max(10).default([]),
  })
  .strict();
export type PubSubSubscribeRequest = z.input<typeof zPubSubSubscribe>;
export interface PubSubSubscription { id: string; expiresAt: string }
/** POST /databases/:db/pubsub/channels — active channels matching `pattern` (default `*`). */
export const zPubSubChannels = z.object({ pattern: z.string().max(512).default('*') }).strict();

/** Messages over 64 KiB are cut to that size: `truncated: true` and `totalBytes` (original size) are set. */
export interface PubSubMessage { t: number; channel: string; pattern?: string; message: Bin; truncated?: true; totalBytes?: number }
export const zPublish = z.object({ channel: z.string().min(1).max(1024), message: zBin, ...zConfirmOpt }).strict();
export interface PubSubChannels { channels: { name: string; subscribers: number }[]; patterns: number }

// ---------------------------------------------------------------------------
// Profiler — GET /databases/:db/profiler/stream?seconds=30 (SSE, admin only, non-prod unless config allows, max 60s)
// Argument values are truncated to 64 chars; the event is audited.

export interface ProfilerEvent { t: number; db: number; client: string; argv: string[] }

// ---------------------------------------------------------------------------
// Search / TimeSeries (only when the module is present)

export interface SearchIndexSummary { name: string; numDocs: number; indexing: boolean; prefixes: string[]; fields: { name: string; type: string }[] }
/**
 * v0.2.1 options (all optional): `sortBy` + `sortOrder` (SORTBY field ASC|DESC), `returnFields` (RETURN n f…, at most
 * 32 fields), `dialect` (DIALECT 1-4). The server builds the argv with `buildFtSearchArgv` (insight.ts) and appends
 * its own TIMEOUT.
 */
export const zSearchQuery = z
  .object({
    index: z.string().min(1).max(256),
    query: z.string().max(10_000),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(20),
    sortBy: z.string().min(1).max(256).optional(),
    sortOrder: z.enum(['ASC', 'DESC']).optional(),
    returnFields: z.array(z.string().min(1).max(256)).min(1).max(32).optional(),
    dialect: z.number().int().min(1).max(4).optional(),
  })
  .strict();
export type SearchQueryRequest = z.input<typeof zSearchQuery>;
/**
 * `docs[].truncated`: some field values of this document were shortened (each is cut at 4096 characters, and the
 * response shares `policy.maxReplyBytes`), or its fields were not read at all (`fields` is `{}`) because the page's
 * documents together exceed the server's read budget. Open the key in the key browser to see it in full.
 * `docs[].idBytes`: the document's id (its key name) did not fit in the response and was withheld: `id` is `''` and
 * `idBytes` is the id's length in bytes. Never treat `''` as a key.
 */
/** `docs[].key` (v0.2.1): the document id's exact bytes, to open it in the key browser (absent when `idBytes` is set). */
export interface SearchResult { total: number; docs: { id: string; key?: Bin; idBytes?: number; fields: Record<string, string>; truncated?: boolean }[] }
export interface TimeSeriesRange { key: Bin; samples: [number, string][]; aggregation?: string }

// ---------------------------------------------------------------------------
// Admin

export const AUDIT_OUTCOMES = ['allowed', 'denied', 'error', 'confirmation_required'] as const;
export interface AuditEvent {
  id: string;
  at: string; // ISO
  userId: string;
  username: string;
  ip: string;
  action: string; // e.g. "cli.exec", "key.delete", "auth.login", "profiler.start"
  databaseId?: string;
  /** Command name and redacted argv (values replaced by <n bytes>). Never contains values or secrets. */
  command?: string;
  argvRedacted?: string[];
  keyCount?: number;
  outcome: (typeof AUDIT_OUTCOMES)[number];
  reason?: string;
  detail?: string;
}
export const zAuditQuery = z.object({
  user: z.string().max(128).optional(),
  database: z.string().max(128).optional(),
  action: z.string().max(64).optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  before: z.string().max(64).optional(), // cursor (event id)
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export interface LocalUser { id: string; username: string; displayName: string; role: Role; disabled: boolean; totpEnabled: boolean; createdAt: string; lastLoginAt?: string }
export const zCreateLocalUser = z.object({ username: z.string().regex(/^[a-zA-Z0-9._-]{3,64}$/), displayName: z.string().trim().min(1).max(128), role: zRole, initialPassword: z.string().min(12).max(1024) }).strict();
export const zUpdateLocalUser = z.object({ displayName: z.string().trim().min(1).max(128).optional(), role: zRole.optional(), disabled: z.boolean().optional(), resetTotp: z.boolean().optional(), newPassword: z.string().min(12).max(1024).optional() }).strict();

// ---------------------------------------------------------------------------
// Route table (method, path) — the single source of truth for both sides.

export const ROUTES = {
  health: 'GET /healthz',
  ready: 'GET /readyz',
  providers: 'GET /api/v1/auth/providers',
  me: 'GET /api/v1/auth/me',
  login: 'POST /api/v1/auth/login',
  totpVerify: 'POST /api/v1/auth/totp/verify',
  logout: 'POST /api/v1/auth/logout',
  oidcStart: 'GET /api/v1/auth/oidc/start',
  oidcCallback: 'GET /api/v1/auth/oidc/callback',
  passwordChange: 'POST /api/v1/auth/password',
  totpEnroll: 'POST /api/v1/auth/totp/enroll',
  totpConfirm: 'POST /api/v1/auth/totp/confirm',
  recoveryCodesRegenerate: 'POST /api/v1/auth/recovery-codes',
  databases: 'GET /api/v1/databases',
  overview: 'GET /api/v1/databases/:db/overview',
  metricsStream: 'GET /api/v1/databases/:db/metrics/stream',
  scan: 'POST /api/v1/databases/:db/keys/scan',
  keyNames: 'POST /api/v1/databases/:db/keys/names',
  keyMeta: 'POST /api/v1/databases/:db/keys/meta',
  key: 'POST /api/v1/databases/:db/key/read',
  keyElement: 'POST /api/v1/databases/:db/key/element',
  ops: 'POST /api/v1/databases/:db/ops',
  bulkDelete: 'POST /api/v1/databases/:db/bulk-delete',
  bulkDeleteJobs: 'POST /api/v1/databases/:db/bulk-delete/jobs',
  bulkDeleteJob: 'GET /api/v1/databases/:db/bulk-delete/jobs/:id',
  bulkDeleteJobCancel: 'POST /api/v1/databases/:db/bulk-delete/jobs/:id/cancel',
  cli: 'POST /api/v1/databases/:db/cli',
  workbench: 'POST /api/v1/databases/:db/workbench',
  commands: 'GET /api/v1/databases/:db/commands',
  slowlog: 'GET /api/v1/databases/:db/slowlog',
  slowlogReset: 'POST /api/v1/databases/:db/slowlog/reset',
  slowlogConfig: 'GET /api/v1/databases/:db/slowlog/config',
  clients: 'GET /api/v1/databases/:db/clients',
  clientKill: 'POST /api/v1/databases/:db/clients/kill',
  analysis: 'POST /api/v1/databases/:db/analysis',
  pubsubChannels: 'POST /api/v1/databases/:db/pubsub/channels',
  pubsubSubscribe: 'POST /api/v1/databases/:db/pubsub/subscriptions',
  pubsubStream: 'GET /api/v1/databases/:db/pubsub/stream', // ?sub=<id from pubsubSubscribe>
  publish: 'POST /api/v1/databases/:db/pubsub/publish',
  profilerStream: 'GET /api/v1/databases/:db/profiler/stream',
  searchIndexes: 'GET /api/v1/databases/:db/search/indexes',
  searchQuery: 'POST /api/v1/databases/:db/search/query',
  searchIndexInfo: 'POST /api/v1/databases/:db/search/index/info', // {index} -> SearchIndexDetail
  searchSample: 'POST /api/v1/databases/:db/search/sample', // {on, prefix, keys, key?} -> SearchSampleResponse
  searchIndexCreate: 'POST /api/v1/databases/:db/search/index/create', // zSearchIndexCreate (confirmation)
  searchIndexDrop: 'POST /api/v1/databases/:db/search/index/drop', // {index, deleteDocuments?} (admin, typed)
  analysisJobStart: 'POST /api/v1/databases/:db/analysis/jobs', // zAnalysisRequest -> AnalysisJob
  analysisJob: 'GET /api/v1/databases/:db/analysis/jobs/:id',
  analysisJobCancel: 'POST /api/v1/databases/:db/analysis/jobs/:id/cancel',
  importPlan: 'POST /api/v1/databases/:db/import', // {script, fileName?} -> ImportPlan
  importStart: 'POST /api/v1/databases/:db/import/:id/start', // {stopOnError, skipBlocked} (confirmation) -> ImportStatus
  importStatus: 'GET /api/v1/databases/:db/import/:id',
  importCancel: 'POST /api/v1/databases/:db/import/:id/cancel',
  streamGroups: 'POST /api/v1/databases/:db/streams/groups', // {key}; groups + consumers + pending summary
  streamPending: 'POST /api/v1/databases/:db/streams/pending', // {key, group, count}
  tsRange: 'POST /api/v1/databases/:db/timeseries/range', // {key, from, to, bucketMs, agg, count}
  // v0.4 vector sets
  vsetMembers: 'POST /api/v1/databases/:db/vectorset/members', // zVsetMembersRequest -> VsetMembersResponse
  vsetAttributes: 'POST /api/v1/databases/:db/vectorset/attributes', // zVsetAttributesRequest -> VsetAttributesResponse
  vsetElement: 'POST /api/v1/databases/:db/vectorset/element', // zVsetElementRequest -> VsetElementResponse
  vsetSearch: 'POST /api/v1/databases/:db/vectorset/search', // zVsetSearchRequest -> VsetSearchResponse
  // v0.4 arrays (read-only; writes are typed ops on `ops`)
  arrayRange: 'POST /api/v1/databases/:db/array/range', // zArrayRange -> ArrayPage
  arraySearch: 'POST /api/v1/databases/:db/array/search', // zArraySearch -> ArraySearchResult
  arrayAggregate: 'POST /api/v1/databases/:db/array/aggregate', // zArrayAggregate -> ArrayAggregateResult
  audit: 'GET /api/v1/admin/audit',
  users: 'GET /api/v1/admin/users',
  userCreate: 'POST /api/v1/admin/users',
  userUpdate: 'PATCH /api/v1/admin/users/:id',
} as const;

export type { Environment, Role };

export interface StreamGroupInfo {
  name: string;
  nameBin?: Bin;
  consumerTotal?: number;
  consumers: { name: string; nameBin?: Bin; pending: number; idleMs: number; inactiveMs?: number }[];
  pending: number;
  lastDeliveredId: string;
  entriesRead?: number;
  lag?: number;
}
export interface StreamPendingEntry { id: string; consumer: string; consumerBin?: Bin; idleMs: number; deliveries: number }

// ---------------------------------------------------------------------------
// Response bodies and request schemas for routes not covered above (added by the server).
// HTTP status per ApiError code: unauthenticated 401, forbidden/csrf/command_blocked/read_only 403,
// not_found 404, conflict 409, validation 400, too_large 413, confirmation_required 428, rate_limited 429,
// internal 500, redis_error 502, unavailable 503, timeout 504.

export interface HealthResponse { status: 'ok' }
export interface ReadyResponse { status: 'ready' | 'not_ready'; checks: Record<string, 'ok' | 'error'> }
export interface TotpVerifyResponse { me: Me }
export interface PasswordChangeResponse { me: Me }
/** `recoveryCodes`: the account's first recovery code set, shown once. */
export interface TotpConfirmResponse { me: Me; recoveryCodes: string[] }
/** `redirectUrl` is set when the IdP session should also be ended (RP-initiated logout); navigate there. */
export interface LogoutResponse { ok: true; redirectUrl?: string }
/**
 * GET /auth/oidc/start is a browser navigation (302 to the IdP). The callback redirects to `/` on
 * success, or to `/login?error=<OidcLoginError>` on failure.
 */
export type OidcLoginError = 'oidc_failed' | 'oidc_state' | 'oidc_no_role' | 'oidc_disabled';

export interface DatabasesResponse { databases: DatabaseSummary[] }
export interface CommandsResponse { commands: CommandDoc[] }
/** GET /databases/:db/slowlog?count=1..1000 (default 128) */
export const zSlowlogQuery = z.object({ count: z.coerce.number().int().min(1).max(1000).default(128) });
export interface SlowlogResponse { entries: SlowlogEntry[]; len: number }
/**
 * GET /databases/:db/slowlog/config — the real slow log settings, read with `CONFIG GET` for the two fixed
 * parameters only (never a caller-chosen one). Admin-class read: other roles get `available: false` and a reason.
 * In cluster mode the values come from the first primary.
 */
export type SlowlogConfigResponse =
  | { available: true; slowerThanMicros: number; maxLen: number }
  | { available: false; reason: string };
export interface OkResponse { ok: true }
export interface ClientsResponse { clients: ClientInfo[] }
/** POST /databases/:db/clients/kill (admin; confirmation required). */
export const zClientKill = z.object({ id: z.string().regex(/^\d{1,20}$/), ...zConfirmOpt }).strict();
export interface PublishResponse { receivers: number }
export interface SearchIndexesResponse { indexes: SearchIndexSummary[] }
export interface StreamGroupsResponse { groups: StreamGroupInfo[]; total?: number }
/** POST /databases/:db/streams/groups (read-only). */
export const zStreamGroupsRequest = z.object({ key: zBin }).strict();
/** POST /databases/:db/streams/pending (read-only); count 1..1000 (default 100). */
export const zStreamPendingRequest = z.object({ key: zBin, group: z.union([z.string().min(1).max(256), zBin]), count: z.number().int().min(1).max(1000).default(100), start: z.string().regex(/^(?:-|\(?\d+-\d+)$/).default('-'), end: z.string().regex(/^(?:\+|\d+-\d+)$/).default('+'), consumer: z.union([z.string().min(1).max(256), zBin]).optional() }).strict();
export interface StreamPendingResponse { pending: StreamPendingEntry[]; total: number; minId?: string; maxId?: string }
/** POST /databases/:db/timeseries/range (read-only). from/to: epoch ms, or '-' / '+'. */
export const zTsRangeRequest = z
  .object({
    key: zBin,
    from: z.union([z.literal('-'), z.number().int().min(0)]).default('-'),
    to: z.union([z.literal('+'), z.number().int().min(0)]).default('+'),
    bucketMs: z.number().int().min(1).max(365 * 24 * 3600_000).optional(),
    agg: z.enum(['avg', 'sum', 'min', 'max', 'range', 'count', 'first', 'last', 'std.p', 'std.s', 'var.p', 'var.s', 'twa']).optional(),
    count: z.number().int().min(1).max(10_000).default(2000),
  })
  .strict();
export type TsRangeRequest = z.input<typeof zTsRangeRequest>;
export interface AuditResponse { events: AuditEvent[]; /** Pass as `before` to get the next (older) page. */ nextBefore?: string }
export interface UsersResponse { users: LocalUser[] }
