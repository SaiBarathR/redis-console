import type { FastifyInstance } from 'fastify';
import { ErrorReply, RESP_TYPES } from 'redis';
import {
  KEY_ELEMENT_PREVIEW_BYTES,
  KEY_VALUE_PREVIEW_BYTES,
  VSET_PAGE_MAX,
  binFromBytes,
  bytesFromBin,
  zBulkDelete,
  zKeyMetaRequest,
  zKeyNamesRequest,
  zKeyOp,
  zKeyRead,
  zKeyElementRequest,
  type KeyElementResponse,
  type ElementRef,
  zScanRequest,
  type Bin,
  type BulkDeleteResult,
  type ConfirmLevel,
  type KeyDetails,
  type KeyListItem,
  type KeyMetaItem,
  type KeyMetaResponse,
  type KeyNamesResponse,
  type KeyOp,
  type KeyValue,
  type OpResult,
  type ScanResponse,
  type StreamEntry,
} from '@rconsole/shared';
import { audit, dbScope, parse, rateLimit, sessionStillValid, type AppContext, type DbScope } from '../context.ts';
import { keyTag, redactArgv } from '../audit.ts';
import { HttpError } from '../http/errors.ts';
import { abortWhenClientGone } from '../http/clientGone.ts';
import { authorize, confirmationFor, fixedCommand } from '../policy/policy.ts';
import { auditDenied, auditedRead, confirmOrThrow, type AuditBase } from '../policy/enforce.ts';
import { buildPreview, previewCommand } from '../policy/preview.ts';
import { detailRead, identityDigest, rangeArgs, rawBytes, readFullElement, scanArgs, scoreMapping, scorePairs } from './keyDetail.ts';
import { checkedWrite, validateExpect, type CheckedPlan, type Probe } from '../redis/checked.ts';
import { bulkDelete, confirmBulkDelete, inSlotOrder, registerBulkDeleteJobRoutes } from './bulkDelete.ts';
import { run, toHttpError } from '../redis/exec.ts';
import { TM_BIN, TM_STR, type Arg, type Conn } from '../redis/manager.ts';
import { TM_REPLY, asNum, asStr, kv, toReply } from '../redis/reply.ts';
import { dbSize, globLiteral, scanPage, SCAN_COUNT_MAX } from '../redis/scan.ts';
import { planVsetOp, vsetProbe } from '../redis/vectorset.ts';
import { readVectorSet } from './vectorset.ts';
import { arrayProbe, planArrayOp, readArrayValue } from '../redis/array.ts';

const TM_BIN_DBL = { ...TM_BIN, [RESP_TYPES.DOUBLE]: String } as const;

/** Raw key bytes from a request body `Bin`; malformed base64 or an oversized key is a 400. */
export function keyBytes(k: Bin): Buffer {
  if (k.enc === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(k.data)) throw new HttpError('validation', 'key: invalid base64');
  const buf = Buffer.from(bytesFromBin(k));
  if (buf.length > MAX_KEY_BYTES) throw new HttpError('validation', `key: at most ${MAX_KEY_BYTES} bytes`);
  return buf;
}

/** Longest key accepted by the key-addressed read routes. */
export const MAX_KEY_BYTES = 65_536;
/** Body limit for the key-addressed read routes (a base64 key of MAX_KEY_BYTES plus options). */
export const READ_BODY_LIMIT = 256 * 1024;

const bin = (b: unknown): Bin => binFromBytes(Buffer.isBuffer(b) ? b : Buffer.from(asStr(b)));

/** Elements past a page's byte budget are still listed (paging stays complete), cut to this many bytes. */
export const OVER_BUDGET_PREVIEW_BYTES = 64;

/**
 * Response budget for one key-browser page (review H4): previews of all elements together use at most about
 * `bytes` (one element may overshoot it); later elements are cut to OVER_BUDGET_PREVIEW_BYTES and flagged.
 */
export class PageBudget {
  left: number;
  constructor(bytes: number) {
    this.left = bytes;
  }
  /** Cut an element to what the budget allows; returns the Bin and whether it was cut. */
  preview(b: unknown): { v: Bin; cut: boolean } {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(asStr(b));
    const max = Math.min(KEY_ELEMENT_PREVIEW_BYTES, Math.max(OVER_BUDGET_PREVIEW_BYTES, this.left));
    const n = Math.min(buf.length, max);
    this.left -= n;
    return buf.length > n ? { v: binFromBytes(buf.subarray(0, n)), cut: true } : { v: binFromBytes(buf), cut: false };
  }
}

// ---------------------------------------------------------------------------
// Typed operations -> fixed commands

interface OpPlan {
  argv: Arg[];
  confirm: ConfirmLevel;
  summary: string;
  /** argv indexes that are keys. */
  keys: number[];
  /** Split into per-key commands in cluster mode (multi-key DEL across slots). */
  perKey?: boolean;
  /** The audit argv when `redactArgv`'s one entry per argument would be needlessly long (v0.4 `vset.add`). */
  redacted?: string[];
}

const b = (x: Bin) => Buffer.from(bytesFromBin(x));

export function planOp(op: KeyOp): OpPlan {
  switch (op.op) {
    case 'string.set': {
      if (op.keepTtl && op.ttl) throw new HttpError('validation', 'keepTtl cannot be combined with ttl');
      const argv: Arg[] = ['SET', b(op.key), b(op.value)];
      if (op.ttl) argv.push('EX', String(op.ttl));
      if (op.nx) argv.push('NX');
      if (op.keepTtl) argv.push('KEEPTTL');
      return { argv, confirm: 'none', summary: 'Set string value', keys: [1] };
    }
    case 'key.delete':
      return { argv: ['UNLINK', ...op.keys.map(b)], confirm: 'confirm', summary: `Delete ${op.keys.length} key(s)`, keys: op.keys.map((_, i) => i + 1), perKey: true };
    case 'key.rename':
      return op.nx
        ? { argv: ['RENAMENX', b(op.key), b(op.newKey)], confirm: 'none', summary: 'Rename key', keys: [1, 2] }
        : { argv: ['RENAME', b(op.key), b(op.newKey)], confirm: 'confirm', summary: 'Rename key (overwrites the target if it exists)', keys: [1, 2] };
    case 'key.expire':
      return { argv: ['EXPIRE', b(op.key), String(op.ttl)], confirm: 'none', summary: 'Set TTL', keys: [1] };
    case 'key.persist':
      return { argv: ['PERSIST', b(op.key)], confirm: 'none', summary: 'Remove TTL', keys: [1] };
    case 'hash.set':
      return { argv: ['HSET', b(op.key), ...op.entries.flatMap((e) => [b(e.field), b(e.value)])], confirm: 'none', summary: 'Set hash fields', keys: [1] };
    case 'hash.expire':
      return { argv: ['HEXPIRE', b(op.key), String(op.ttl), 'FIELDS', String(op.fields.length), ...op.fields.map(b)], confirm: 'none', summary: 'Set hash field expiry', keys: [1] };
    case 'hash.persist':
      return { argv: ['HPERSIST', b(op.key), 'FIELDS', String(op.fields.length), ...op.fields.map(b)], confirm: 'none', summary: 'Remove hash field expiry', keys: [1] };
    case 'hash.delete':
      return { argv: ['HDEL', b(op.key), ...op.fields.map(b)], confirm: 'confirm', summary: `Delete ${op.fields.length} hash field(s)`, keys: [1] };
    case 'list.push':
      return { argv: [op.end === 'head' ? 'LPUSH' : 'RPUSH', b(op.key), ...op.values.map(b)], confirm: 'none', summary: 'Push list elements', keys: [1] };
    case 'list.set':
      return { argv: ['LSET', b(op.key), String(op.index), b(op.value)], confirm: 'none', summary: 'Set list element', keys: [1] };
    case 'list.remove':
      return { argv: ['LREM', b(op.key), String(op.count), b(op.value)], confirm: 'confirm', summary: 'Remove list elements', keys: [1] };
    case 'set.add':
      return { argv: ['SADD', b(op.key), ...op.members.map(b)], confirm: 'none', summary: 'Add set members', keys: [1] };
    case 'set.remove':
      return { argv: ['SREM', b(op.key), ...op.members.map(b)], confirm: 'confirm', summary: `Remove ${op.members.length} set member(s)`, keys: [1] };
    case 'zset.add':
      return { argv: ['ZADD', b(op.key), ...op.members.flatMap((m) => [m.score, b(m.member)])], confirm: 'none', summary: 'Add sorted set members', keys: [1] };
    case 'zset.remove':
      return { argv: ['ZREM', b(op.key), ...op.members.map(b)], confirm: 'confirm', summary: `Remove ${op.members.length} sorted set member(s)`, keys: [1] };
    case 'stream.add':
      return { argv: ['XADD', b(op.key), op.id, ...op.fields.flatMap((f) => [b(f.field), b(f.value)])], confirm: 'none', summary: 'Add stream entry', keys: [1] };
    case 'stream.delete':
      return { argv: ['XDEL', b(op.key), ...op.ids], confirm: 'confirm', summary: `Delete ${op.ids.length} stream entr(ies)`, keys: [1] };
    case 'stream.group.create': {
      const argv: Arg[] = ['XGROUP', 'CREATE', b(op.key), (typeof op.group === 'string' ? op.group : b(op.group)), op.id];
      if (op.mkstream) argv.push('MKSTREAM');
      return { argv, confirm: 'none', summary: 'Create consumer group', keys: [2] };
    }
    case 'stream.group.destroy':
      return { argv: ['XGROUP', 'DESTROY', b(op.key), (typeof op.group === 'string' ? op.group : b(op.group))], confirm: 'confirm', summary: 'Destroy consumer group', keys: [2] };
    case 'stream.consumer.delete':
      return { argv: ['XGROUP', 'DELCONSUMER', b(op.key), (typeof op.group === 'string' ? op.group : b(op.group)), (typeof op.consumer === 'string' ? op.consumer : b(op.consumer))], confirm: 'confirm', summary: 'Delete consumer (its pending entries are dropped from the group)', keys: [2] };
    case 'stream.claim':
      return { argv: ['XCLAIM', b(op.key), (typeof op.group === 'string' ? op.group : b(op.group)), (typeof op.consumer === 'string' ? op.consumer : b(op.consumer)), String(op.minIdleMs), ...op.ids, 'JUSTID'], confirm: 'confirm', summary: 'Claim pending stream entries', keys: [1] };
    case 'stream.ack':
      return { argv: ['XACK', b(op.key), (typeof op.group === 'string' ? op.group : b(op.group)), ...op.ids], confirm: op.confirmAck ? 'confirm' : 'none', summary: 'Acknowledge stream entries', keys: [1] };
    case 'json.set':
      return { argv: ['JSON.SET', b(op.key), op.path, op.json], confirm: 'none', summary: 'Set JSON value', keys: [1] };
    case 'json.delete':
      return { argv: ['JSON.DEL', b(op.key), op.path], confirm: 'confirm', summary: 'Delete JSON path', keys: [1] };
    // v0.4 vector sets
    case 'vset.add':
    case 'vset.setattr':
    case 'vset.remove':
      return planVsetOp(op);
    // v0.4 arrays
    case 'array.set':
    case 'array.insert':
    case 'array.delete':
    case 'array.delete-range':
      return planArrayOp(op);
  }
}

/**
 * The commands a plan sends, in order: one command, or one per key for multi-key deletes in cluster mode (keys
 * may live in different slots). Both execution and the confirmation preview use this.
 */
export function planCommands(plan: OpPlan, cluster: boolean): { argv: Arg[]; keys: number[] }[] {
  if (plan.perKey && cluster && plan.keys.length > 1) return plan.keys.map((i) => ({ argv: [plan.argv[0]!, plan.argv[i]!], keys: [1] }));
  return [{ argv: plan.argv, keys: plan.keys }];
}

/** Confirmation preview of a typed op. */
export function previewOp(plan: OpPlan, cluster: boolean) {
  const keep = plan.argv[0] === 'XGROUP' ? 2 : 1;
  return buildPreview(planCommands(plan, cluster).map((c) => previewCommand(c.argv, keep, c.keys)));
}

/** Ops whose schema has `expect` (compare-and-set). */
export const CHECKED_OPS = ['string.set', 'hash.set', 'list.set', 'zset.add', 'json.set', 'json.delete', 'key.rename', 'key.delete', 'vset.add', 'vset.setattr', 'array.set', 'array.insert'] as const;

/**
 * The compare-and-set form of an op that carries `expect` (web review v0.2 r3): which key is watched, what is
 * compared and the single command run in MULTI/EXEC. 400 when the op cannot carry an expectation or it cannot
 * describe what the op replaces. `raw` is the request body before parsing: the op schemas drop unknown fields, so
 * an `expect` sent with an op that has none would otherwise be ignored and the op run unchecked (review v0.2 r6 L1).
 */
export function planChecked(op: KeyOp, plan: OpPlan, raw?: unknown): CheckedPlan | undefined {
  const bad = (m: string): never => { throw new HttpError('validation', `expect: ${m}`); };
  if (!('expect' in op) || !op.expect) {
    if (raw !== null && typeof raw === 'object' && 'expect' in raw) bad(`not supported for ${op.op} (only ${CHECKED_OPS.join(', ')} can carry it)`);
    return undefined;
  }
  let probe: Probe;
  let key: Buffer;
  switch (op.op) {
    case 'string.set':
      if (op.nx) bad('cannot be combined with nx');
      probe = { kind: 'string' }; key = b(op.key); break;
    case 'hash.set':
      if (op.entries.length !== 1) bad('hash.set with expect sets exactly one field');
      probe = { kind: 'hash', field: b(op.entries[0]!.field) }; key = b(op.key); break;
    case 'list.set':
      probe = { kind: 'list', index: op.index }; key = b(op.key); break;
    case 'zset.add':
      if (op.members.length !== 1) bad('zset.add with expect sets exactly one member');
      probe = { kind: 'zset', member: b(op.members[0]!.member) }; key = b(op.key); break;
    case 'json.set':
    case 'json.delete':
      probe = { kind: 'json' }; key = b(op.key); break;
    case 'key.rename':
      probe = { kind: 'key' }; key = b(op.key); break;
    case 'key.delete':
      if (op.keys.length !== 1) bad('key.delete with expect deletes exactly one key');
      probe = { kind: 'key' }; key = b(op.keys[0]!); break;
    // v0.4 vector sets: `expect` is required by their schemas (an add must find the member absent).
    case 'vset.add':
    case 'vset.setattr':
      probe = vsetProbe(op)!; key = b(op.key); break;
    // v0.4 arrays: array.set compares the element at its index; array.insert checks the positions it writes.
    case 'array.set':
    case 'array.insert':
      probe = arrayProbe(op)!; key = b(op.key); break;
    default:
      return bad(`not supported for ${(op as KeyOp).op} (only ${CHECKED_OPS.join(', ')} can carry it)`);
  }
  validateExpect(probe, op.expect);
  return { key, probe, expect: op.expect, command: plan.argv };
}

// ---------------------------------------------------------------------------

async function keyMeta(conn: Conn, keys: Buffer[], knownType: string | undefined): Promise<KeyListItem[]> {
  const items: KeyListItem[] = new Array(keys.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, keys.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= keys.length) return;
      const k = keys[i]!;
      const [type, ttl, size] = await Promise.all([
        knownType ? Promise.resolve(knownType) : conn.send(['TYPE', k], { key: k, typeMapping: TM_STR, readonly: true }).then(asStr, () => 'unknown'),
        conn.send(['TTL', k], { key: k, readonly: true }).then(asNum, () => -2),
        conn.send(['MEMORY', 'USAGE', k], { key: k, readonly: true }).then((v) => (v == null ? undefined : asNum(v)), () => undefined),
      ]);
      const item: KeyListItem = { key: bin(k), type, ttl };
      if (size !== undefined) item.size = size;
      items[i] = item;
    }
  }));
  return items;
}

/** Per-reply cap of the metadata pipeline: TYPE, PTTL and MEMORY USAGE replies are a few bytes each. */
export const META_REPLY_BYTES = 4096;
/** Body limit of `keys/meta`: 500 key names of up to about 6 KiB each as base64 (the browser batches by bytes too). */
export const META_BODY_LIMIT = 4 * 1024 * 1024;
/** Key tags listed in the audit event of one `keys/meta` request; the rest are counted. */
export const META_AUDIT_TAGS = 50;

/** SCAN/metadata type filter for audit details: the name when it is a plain identifier, otherwise its length. */
const typeTag = (type: string | undefined) =>
  type === undefined ? [] : [/^[A-Za-z0-9_-]{1,32}$/.test(type) ? `type=${type}` : `type=<${Buffer.byteLength(type)} bytes>`];

/**
 * TYPE, and when asked PTTL and `MEMORY USAGE … SAMPLES n`, of each distinct key, pipelined on measured sockets (one
 * round trip per node). `samples` is `policy.keyMetaMemorySamples`: 0 (the default, as Redis Insight) sizes every
 * element of a collection, so folder sums are exact, but costs Redis time in proportion to the collection; and Redis
 * keeps running pipelined commands after a client timeout drops the socket. Repeated keys are asked once. A TTL is
 * reported in whole seconds, rounded up, so a key with time left never shows as expired. A command the tier's ACL user
 * may not run fails the request (403); a key it may not access is reported with type `unknown`.
 */
export async function keysMetadata(conn: Conn, keys: Buffer[], o: { ttl: boolean; size: boolean; samples: number; timeout: number }): Promise<KeyMetaItem[]> {
  const index = new Map<string, number>();
  const unique: Buffer[] = [];
  const slot = keys.map((key) => {
    const id = key.toString('latin1');
    let at = index.get(id);
    if (at === undefined) {
      at = unique.push(key) - 1;
      index.set(id, at);
    }
    return at;
  });
  const per = 1 + (o.ttl ? 1 : 0) + (o.size ? 1 : 0);
  const commands = unique.flatMap((key) => [
    { args: ['TYPE', key], key },
    ...(o.ttl ? [{ args: ['PTTL', key], key }] : []),
    ...(o.size ? [{ args: ['MEMORY', 'USAGE', key, 'SAMPLES', String(o.samples)], key }] : []),
  ]);
  let replies: unknown[];
  try {
    replies = await conn.pipeline(commands, { typeMapping: TM_STR, timeout: o.timeout, maxBytes: META_REPLY_BYTES });
  } catch (e) {
    throw toHttpError(e);
  }
  // NOPERM for the command itself ("… has no permissions to run the 'type' command") is the tier's ACL; NOPERM for a
  // key ("No permissions to access a key") concerns that key only.
  const denied = (r: unknown) => r instanceof ErrorReply && /^NOPERM\b/.test(r.message) && /permissions to run/i.test(r.message);
  const items = unique.map((key, i): KeyMetaItem => {
    const r = replies.slice(i * per, i * per + per);
    if (denied(r[0])) throw toHttpError(r[0]);
    const t = r[0] instanceof ErrorReply ? 'unknown' : asStr(r[0]);
    const item: KeyMetaItem = { key: bin(key), type: t };
    if (o.ttl && !(r[1] instanceof ErrorReply)) {
      const ms = asNum(r[1]);
      item.ttl = t === 'none' ? -2 : ms < 0 ? ms : Math.ceil(ms / 1000);
    } else if (o.ttl && t === 'none') item.ttl = -2;
    const size = o.size ? r[per - 1] : undefined;
    if (o.size && !(size instanceof ErrorReply) && size != null) item.size = asNum(size);
    return item;
  });
  return slot.map((at) => items[at]!);
}

export function registerKeyRoutes(app: FastifyInstance, ctx: AppContext) {
  const { policy } = ctx.config;

  /**
   * Key names only (v0.2.1): what the key browser needs to build the whole namespace tree. Metadata for the rows on
   * screen comes from `keys/meta`. A pattern without glob characters is one direct TYPE lookup.
   */
  app.post('/api/v1/databases/:db/keys/names', { bodyLimit: 16 * 1024 }, async (req): Promise<KeyNamesResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'key-names', 10, 20);
    const q = parse(zKeyNamesRequest, req.body);
    const threshold = Math.min(q.scanThreshold, policy.keyScanThresholdMax);
    const base: AuditBase = { action: 'key.names', databaseId: scope.db.id, command: 'SCAN', argvRedacted: ['SCAN', `<match ${Buffer.byteLength(q.match)} bytes>`] };
    return auditedRead(ctx, req, base, async () => {
      const release = ctx.slots.acquire(`key-scan:${scope.session.userId}`, 2);
      if (!release) throw new HttpError('rate_limited', 'At most two key scans can run at once per user.');
      try {
        const conn = await scope.conn();
        const literal = globLiteral(q.match);
        if (literal !== undefined) {
          const key = Buffer.from(literal);
          base.command = 'TYPE';
          base.argvRedacted = ['TYPE', keyTag(key)];
          base.keyCount = 1;
          let type: unknown;
          try {
            [type] = await conn.pipeline([{ args: ['TYPE', key], key }], { typeMapping: TM_STR, timeout: policy.commandTimeoutMs, maxBytes: META_REPLY_BYTES });
          } catch (e) {
            throw toHttpError(e);
          }
          if (type instanceof ErrorReply) throw toHttpError(type);
          const found = asStr(type) !== 'none' && (q.type === undefined || asStr(type) === q.type);
          const size = await dbSize(conn).catch(() => 0);
          return { cursor: '0', keys: found ? [bin(key)] : [], scanned: size, dbSize: size, threshold, exact: true };
        }
        const page = await scanPage(conn, {
          cursor: q.cursor, match: q.match, type: q.type, count: SCAN_COUNT_MAX, maxKeys: q.count, maxScanned: threshold,
          budgetMs: policy.scanBudgetMs, keepBytes: Math.floor(policy.maxReadReplyBytes / 2),
        });
        const out: KeyNamesResponse = { cursor: page.cursor, keys: page.keys.map(bin), scanned: page.scanned, dbSize: await dbSize(conn).catch(() => 0), threshold };
        if (page.stopped) out.stopped = page.stopped;
        return out;
      } finally { release(); }
    }, (r) => [`keys=${r.keys.length}`, `scanned=${r.scanned}`, `threshold=${r.threshold}`, ...(r.exact ? ['exact'] : []), ...(r.stopped ? [`stopped=${r.stopped}`] : []), ...typeTag(q.type)].join(' '));
  });

  /** Type, TTL and size of the keys on screen (v0.2.1); the browser asks for visible rows only, in batches. */
  app.post('/api/v1/databases/:db/keys/meta', { bodyLimit: META_BODY_LIMIT }, async (req): Promise<KeyMetaResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'key-meta', 10, 30);
    const q = parse(zKeyMetaRequest, req.body);
    const keys = q.keys.map(keyBytes);
    const more = keys.length - META_AUDIT_TAGS;
    const base: AuditBase = {
      action: 'key.meta', databaseId: scope.db.id, command: 'TYPE', keyCount: keys.length,
      argvRedacted: ['TYPE', ...(q.ttl ? ['PTTL'] : []), ...(q.size ? ['MEMORY'] : []), ...keys.slice(0, META_AUDIT_TAGS).map(keyTag), ...(more > 0 ? [`<+${more} keys>`] : [])],
    };
    return auditedRead(ctx, req, base, async () => {
      const release = ctx.slots.acquire(`key-meta:${scope.session.userId}`, 2);
      if (!release) throw new HttpError('rate_limited', 'At most two key metadata requests can run at once per user.');
      try {
        return { keys: await keysMetadata(await scope.conn(), keys, { ttl: q.ttl, size: q.size, samples: policy.keyMetaMemorySamples, timeout: policy.commandTimeoutMs }) };
      } finally { release(); }
    }, (r) => `keys=${r.keys.length} missing=${r.keys.filter((k) => k.type === 'none').length}`);
  });

  // Reads that carry key names or patterns are POSTs (never in URLs); no side effects, no confirmation.
  app.post('/api/v1/databases/:db/keys/scan', { bodyLimit: 16 * 1024 }, async (req): Promise<ScanResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'scan', 10, 20);
    const q = parse(zScanRequest, req.body);
    const type = q.type === undefined ? [] : [/^[A-Za-z0-9_-]{1,32}$/.test(q.type) ? `type=${q.type}` : `type=<${Buffer.byteLength(q.type)} bytes>`];
    const base = { action: 'key.scan', databaseId: scope.db.id, command: 'SCAN', argvRedacted: ['SCAN', `<match ${Buffer.byteLength(q.match)} bytes>`] };
    return auditedRead(ctx, req, base, async () => {
      const release = ctx.slots.acquire(`key-scan:${scope.session.userId}`, 2);
      if (!release) throw new HttpError('rate_limited', 'At most two key scans can run at once per user.');
      try {
        const conn = await scope.conn();
        const page = await scanPage(conn, { cursor: q.cursor, match: q.match, type: q.type, count: q.count, maxKeys: q.count, budgetMs: policy.scanBudgetMs });
        const keys = await keyMeta(conn, page.keys, q.type);
        return { cursor: page.cursor, keys, scanned: page.scanned, dbSize: await dbSize(conn).catch(() => 0) };
      } finally { release(); }
    }, (r) => [`keys=${r.keys.length}`, `scanned=${r.scanned}`, ...type].join(' '));
  });

  app.post('/api/v1/databases/:db/key/read', { bodyLimit: READ_BODY_LIMIT }, async (req): Promise<KeyDetails> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'key', 20, 40);
    const q = parse(zKeyRead, req.body);
    if (q.exact && (q.match !== undefined || q.scoreMin !== undefined || q.scoreMax !== undefined)) throw new HttpError('validation', 'Exact lookup cannot be combined with pattern or score criteria.');
    if (q.match !== undefined && (q.scoreMin !== undefined || q.scoreMax !== undefined)) throw new HttpError('validation', 'Pattern and score lookup are separate modes.');
    const key = keyBytes(q.key);
    const base = { action: 'key.read', databaseId: scope.db.id, command: 'TYPE', argvRedacted: ['TYPE', keyTag(key)], keyCount: 1 };
    return auditedRead(ctx, req, base, () => readKey(scope, q, key, base), keyReadDetail);
  });

  async function readKey(scope: DbScope, q: ReturnType<typeof zKeyRead.parse>, key: Buffer, base: { command: string; argvRedacted: string[] }): Promise<KeyDetails> {
    const conn = await scope.conn();
    const o = { key, timeout: policy.commandTimeoutMs };
    const read = <T = unknown>(args: Arg[], opts = o) => detailRead<T>(scope, conn, args, opts);
    let hashFieldExpiry: KeyDetails['hashFieldExpiry'];
    let filter: KeyDetails['filter'];
    const type = asStr(await detailRead(scope, conn, ['TYPE', key], { ...o, typeMapping: TM_STR }));
    if (type === 'none') throw new HttpError('not_found', 'Key does not exist.');
    const command = VALUE_READ[type];
    if (command) {
      base.command = command;
      base.argvRedacted = [command, keyTag(key)];
    }
    const [ttl, encoding, size] = await Promise.all([
      detailRead(scope, conn, ['TTL', key], o).then(asNum),
      conn.send(['OBJECT', 'ENCODING', key], { ...o, typeMapping: TM_STR }).then(asStr, () => undefined),
      conn.send(['MEMORY', 'USAGE', key], o).then((v) => (v == null ? undefined : asNum(v)), () => undefined),
    ]);
    const full = q.full;
    const limit = full ? policy.maxValueBytes : Math.min(KEY_VALUE_PREVIEW_BYTES, policy.maxValueBytes);
    // The transport measures reads; this budget controls the displayed previews.
    const budget = new PageBudget(policy.maxReplyBytes);
    const preview = (x: unknown) => budget.preview(x);
    // Short identities are addressed inline. An exact lookup read no SCAN/rank page, so a page reference would
    // name a page that never held its row; it echoes the caller's own identity inline instead (bounded at 64 KiB).
    const inlineRef = (identity: Buffer) => identity.length <= OVER_BUDGET_PREVIEW_BYTES || (!!q.exact && identity.length <= KEY_ELEMENT_PREVIEW_BYTES);

    let value: KeyValue;
    let length: number | undefined;

    switch (type) {
      case 'string': {
        const total = asNum(await detailRead(scope, conn, ['STRLEN', key], o));
        const v = total === 0 ? Buffer.alloc(0) : ((await detailRead(scope, conn, ['GETRANGE', key, '0', String(Math.min(total, limit) - 1)], o)) as Buffer);
        length = total;
        value = { type: 'string', value: bin(v), truncated: total > limit, totalBytes: total };
        break;
      }
      case 'hash': {
        length = asNum(await read(['HLEN', key]));
        let cur: unknown = '0', flat: unknown[];
        if (q.exact) {
          const field = keyBytes(q.exact);
          const found = await read(['HGET', key, field]);
          flat = found == null ? [] : [field, found];
        } else [cur, flat] = await read<[unknown, unknown[]]>(scanArgs('hash', key, q.cursor ?? '0', q.count, q.match));
        const entries: Extract<KeyValue, { type: 'hash' }>['entries'] = [];
        const fields: Buffer[] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const field = rawBytes(flat[i]);
          const f = preview(field), v = preview(flat[i + 1]);
          const ref: ElementRef = inlineRef(field) ? { kind: 'hash', field: bin(field) } : { kind: 'scan', type: 'hash', cursor: q.cursor ?? '0', count: q.count, match: q.match, position: i / 2, identity: identityDigest(field) };
          entries.push({ field: f.v, value: v.v, ref, ...(f.cut || v.cut ? { truncated: true } : {}), ...(f.cut ? { fieldTruncated: true } : {}) });
          fields.push(field);
        }
        hashFieldExpiry = { supported: true };
        try {
          // An empty MATCH page still checks capability through the actor-checked transport, not an
          // unscoped COMMAND metadata connection. HTTL of the empty field is read-only and returns no value.
          const ttlFields = fields.length ? fields : [Buffer.alloc(0)];
          const ttls = await read<unknown[]>(['HTTL', key, 'FIELDS', String(ttlFields.length), ...ttlFields]);
          ttls.forEach((ttl, i) => { if (entries[i]) entries[i]!.ttl = asNum(ttl); });
        } catch (e) {
          if (!(e instanceof HttpError) || !((e.code === 'redis_error' && /unknown command/i.test(e.message)) || e.code === 'forbidden')) throw e;
          hashFieldExpiry = { supported: false, reason: e.code === 'forbidden' ? 'The Redis ACL does not allow hash field expiry reads.' : 'Hash field expiry requires Redis 7.4 or later.' };
        }
        if (q.match !== undefined || q.exact) filter = { matches: entries.length, ...(q.exact ? { totalMatches: entries.length } : {}) };
        value = { type: 'hash', entries, cursor: asStr(cur), total: length };
        break;
      }
      case 'list': {
        length = asNum(await detailRead(scope, conn, ['LLEN', key], o));
        const items = await detailRead<Buffer[]>(scope, conn, ['LRANGE', key, String(q.offset), String(q.offset + q.count - 1)], o);
        value = {
          type: 'list',
          items: items.map((x, i) => {
            const p = preview(x);
            // The digest of the whole element: a full read of this row refuses another element at the index (409).
            const ref = { kind: 'list' as const, index: q.offset + i, identity: identityDigest(rawBytes(x)) };
            return p.cut ? { index: q.offset + i, value: p.v, ref, truncated: true as const } : { index: q.offset + i, value: p.v, ref };
          }),
          offset: q.offset,
          total: length,
        };
        break;
      }
      case 'set': {
        length = asNum(await read(['SCARD', key]));
        let cur: unknown = '0', members: Buffer[];
        if (q.exact) { const m = keyBytes(q.exact); members = asNum(await read(['SISMEMBER', key, m])) ? [m] : []; }
        else [cur, members] = await read<[unknown, Buffer[]]>(scanArgs('set', key, q.cursor ?? '0', q.count, q.match));
        let cutCount = 0;
        const memberRefs: ElementRef[] = [];
        const out = members.map((m, position) => {
          const p = preview(m); if (p.cut) cutCount++;
          memberRefs.push(inlineRef(m) ? { kind: 'set', member: bin(m) } : { kind: 'scan', type: 'set', cursor: q.cursor ?? '0', count: q.count, match: q.match, position, identity: identityDigest(m) });
          return p.v;
        });
        if (q.match !== undefined || q.exact) filter = { matches: out.length, ...(q.exact ? { totalMatches: out.length } : {}) };
        value = { type: 'set', members: out, memberRefs, cursor: asStr(cur), total: length, ...(cutCount ? { truncatedMembers: cutCount } : {}) };
        break;
      }
      case 'zset': {
        length = asNum(await read(['ZCARD', key]));
        let pairs: [unknown, unknown][], cursor: string | undefined, matchedTotal: number | undefined;
        if (q.exact) {
          const m = keyBytes(q.exact), score = await detailRead(scope, conn, ['ZSCORE', key, m], { ...o, typeMapping: scoreMapping });
          pairs = score == null ? [] : [[m, score]]; matchedTotal = pairs.length;
        } else if (q.match !== undefined) {
          const [cur, flat] = await read<[unknown, unknown[]]>(scanArgs('zset', key, q.cursor ?? '0', q.count, q.match));
          cursor = asStr(cur); pairs = scorePairs(flat);
        } else {
          pairs = scorePairs(await detailRead<unknown[]>(scope, conn, rangeArgs(key, q), { ...o, typeMapping: scoreMapping }));
          if (q.scoreMin !== undefined || q.scoreMax !== undefined) matchedTotal = asNum(await read(['ZCOUNT', key, q.scoreMin ?? '-inf', q.scoreMax ?? '+inf']));
        }
        if (q.match !== undefined || q.exact || matchedTotal !== undefined) filter = { matches: pairs.length, ...(matchedTotal !== undefined ? { totalMatches: matchedTotal } : {}) };
        value = {
          type: 'zset',
          members: pairs.map(([m, s], position) => {
            const raw = rawBytes(m), p = preview(raw);
            const ref: ElementRef = inlineRef(raw) ? { kind: 'zset', member: bin(raw) }
              : cursor !== undefined ? { kind: 'scan', type: 'zset', cursor: q.cursor ?? '0', count: q.count, match: q.match, position, identity: identityDigest(raw) }
              : { kind: 'rank', offset: q.offset + position, reverse: q.reverse, scoreMin: q.scoreMin, scoreMax: q.scoreMax, identity: identityDigest(raw) };
            return { member: p.v, score: asStr(s), ref, ...(p.cut ? { truncated: true as const } : {}) };
          }),
          offset: q.offset, total: length, reverse: q.reverse, ...(cursor !== undefined ? { cursor } : {}), ...(matchedTotal !== undefined ? { matchedTotal } : {}),
        };
        break;
      }
      case 'stream': {
        length = asNum(await detailRead(scope, conn, ['XLEN', key], o));
        const info = kv(await detailRead(scope, conn, ['XINFO', 'STREAM', key], { ...o, typeMapping: TM_STR }));
        const end = q.cursor && q.cursor !== '0' ? `(${q.cursor}` : q.streamEnd ?? '+';
        const raw = await detailRead<[Buffer, Buffer[]][]>(scope, conn, ['XREVRANGE', key, end, q.streamStart ?? '-', 'COUNT', String(q.count)], o);
        const entries: StreamEntry[] = raw.map(([id, fields]) => {
          const fs: StreamEntry['fields'] = [];
          for (let i = 0; i + 1 < fields.length; i += 2) {
            const f = preview(fields[i]), v = preview(fields[i + 1]);
            fs.push({ field: f.v, value: v.v, ref: { kind: 'stream', id: asStr(id), position: i / 2 }, ...(f.cut || v.cut ? { truncated: true } : {}) });
          }
          return { id: asStr(id), fields: fs };
        });
        value = { type: 'stream', entries, total: length, lastId: asStr(info['last-generated-id']), groups: asNum(info.groups) };
        break;
      }
      case 'ReJSON-RL': {
        const j = asStr(await detailRead(scope, conn, ['JSON.GET', key], { ...o, typeMapping: TM_STR }));
        value = j.length > limit ? { type: 'json', json: j.slice(0, limit), truncated: true } : { type: 'json', json: j, truncated: false };
        break;
      }
      case 'TSDB-TYPE': {
        const infoRaw = await detailRead(scope, conn, ['TS.INFO', key], { ...o, typeMapping: TM_STR });
        const info = jsonSafe(kv(infoRaw)) as Record<string, unknown>;
        const samples = await detailRead<[unknown, unknown][]>(scope, conn, ['TS.REVRANGE', key, '-', '+', 'COUNT', String(Math.min(q.count, 1000))], { ...o, typeMapping: { ...TM_STR, [RESP_TYPES.DOUBLE]: String } });
        length = asNum(info.totalSamples ?? info.total_samples);
        value = { type: 'timeseries', info, samples: samples.map(([t, v]) => [asNum(t), asStr(v)] as [number, string]).reverse() };
        break;
      }
      // v0.4 vector sets: summary and the first VRANGE page (later pages: POST /vectorset/members).
      case 'vectorset': {
        const vset = await readVectorSet(scope, conn, key, { timeout: policy.commandTimeoutMs, count: Math.min(q.count, VSET_PAGE_MAX), budget: policy.maxReplyBytes, replyBudget: { remaining: policy.maxReadReplyBytes } });
        value = vset.value;
        length = vset.length;
        break;
      }
      // v0.4 arrays: ARINFO and a first page of existing elements (redis/array.ts).
      case 'array':
        ({ value, length } = await readArrayValue(scope, conn, key, q, (x) => budget.preview(x), policy.commandTimeoutMs));
        break;
      default:
        value = { type: 'unsupported', message: `Values of type ${type} are not shown in the browser. Use the console (e.g. ${hintFor(type)}).` };
    }
    const out: KeyDetails = { key: bin(key), type, ttl, value, ...(filter ? { filter } : {}), ...(hashFieldExpiry ? { hashFieldExpiry } : {}) };
    if (encoding) out.encoding = encoding;
    if (size !== undefined) out.size = size;
    if (length !== undefined) out.length = length;
    return out;
  }

  app.post('/api/v1/databases/:db/key/element', { bodyLimit: 256 * 1024 }, async (req): Promise<KeyElementResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'key-element', 10, 20);
    const q = parse(zKeyElementRequest, req.body), key = keyBytes(q.key);
    const command = q.ref.kind === 'scan' ? { hash: 'HSCAN', set: 'SSCAN', zset: 'ZSCAN' }[q.ref.type] : { hash: 'HGET', list: 'LINDEX', set: 'SISMEMBER', zset: 'ZSCORE', stream: 'XRANGE', rank: 'ZRANGE', array: 'ARGET' }[q.ref.kind];
    const base = { action: 'key.element', databaseId: scope.db.id, command, argvRedacted: [command, keyTag(key)], keyCount: 1 };
    return auditedRead(ctx, req, base, () => readFullElement(scope, key, q.ref, policy.maxValueBytes, policy.commandTimeoutMs, policy.maxReadReplyBytes), (r) => `bytes=${bytesFromBin(r.value).length}`);
  });

  app.post('/api/v1/databases/:db/ops', async (req): Promise<OpResult> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'ops', 20, 40);
    const op = parse(zKeyOp, req.body);
    const plan = planOp(op);
    const checked = planChecked(op, plan, req.body);
    const red = plan.redacted ? { argv: plan.redacted, keyCount: plan.keys.length } : redactArgv(plan.argv, plan.argv[0] === 'XGROUP' ? 2 : 1, plan.keys);
    const base = { action: op.op, databaseId: scope.db.id, command: String(plan.argv[0]), argvRedacted: red.argv, keyCount: red.keyCount };
    try {
      authorize(fixedCommand(String(plan.argv[0]), 'write', plan.confirm, plan.keys), scope);
      const cluster = scope.db.mode === 'cluster';
      const spec = confirmationFor(plan.confirm, true, scope.db, policy.prodRequiresReason, `${plan.summary} on ${scope.db.name}`, previewOp(plan, cluster));
      const { reason } = confirmOrThrow(ctx, req, scope, 'ops', req.body, op.confirmation, spec, base);
      const conn = await scope.conn();
      // Revoking or demoting the user while this request waited stops it before it writes; a checked write checks
      // again right before MULTI (review v0.2 r6 H2).
      const stillAllowed = () => sessionStillValid(ctx, scope.session);
      if (!stillAllowed()) throw new HttpError('unauthenticated', 'Your session ended or your account changed; nothing was written.');
      const result = checked
        ? await checkedWrite(conn, checked, { timeout: policy.commandTimeoutMs, maxValueBytes: policy.maxValueBytes, stillAllowed })
        : await execPlan(conn, plan, policy.commandTimeoutMs);
      audit(ctx, req, { ...base, outcome: 'allowed', reason, ...(checked ? { detail: 'checked' } : {}) });
      return { ok: true, result: toReply(result, { maxBytes: 64 * 1024, maxElements: 1000 }) };
    } catch (e) {
      auditDenied(ctx, req, base, e);
    }
  });

  app.post('/api/v1/databases/:db/bulk-delete', { bodyLimit: 64 * 1024 }, async (req, reply): Promise<BulkDeleteResult> => {
    const scope = dbScope(ctx, req, 'operator');
    rateLimit(ctx, req, 'bulk', 1, 3);
    const body = parse(zBulkDelete, req.body);
    const base = { action: 'key.bulk-delete', databaseId: scope.db.id, command: 'UNLINK', argvRedacted: ['SCAN', `<match ${Buffer.byteLength(body.match)} bytes>`] };
    try {
      const { reason } = await confirmBulkDelete(ctx, req, scope, body, base, 'bulk-delete');
      const conn = await scope.conn();
      // A client that went away (tab closed, request aborted) stops the delete between batches too (console review H1).
      const gone = new AbortController();
      abortWhenClientGone(reply, gone);
      const r = await bulkDelete(conn, body.match, body.type, policy.maxReadReplyBytes, () => !gone.signal.aborted && sessionStillValid(ctx, scope.session));
      const why = gone.signal.aborted ? 'client disconnected' : 'session ended or account changed';
      audit(ctx, req, { ...base, outcome: 'allowed', keyCount: r.deleted, reason, detail: `scanned ${r.scanned}${r.stopped ? `; stopped: ${why}` : ''}` });
      if (r.stopped) throw new HttpError('unauthenticated', `Your session ended or your account changed; stopped after deleting ${r.deleted} key(s).`);
      return { deleted: r.deleted, scanned: r.scanned };
    } catch (e) {
      auditDenied(ctx, req, base, e);
    }
  });
  registerBulkDeleteJobRoutes(app, ctx);
}

/** The command that reads a type's value in the key browser (audit). */
const VALUE_READ: Record<string, string> = {
  string: 'GETRANGE', hash: 'HSCAN', list: 'LRANGE', set: 'SSCAN', zset: 'ZRANGE', stream: 'XREVRANGE', 'ReJSON-RL': 'JSON.GET', 'TSDB-TYPE': 'TS.REVRANGE',
  vectorset: 'VRANGE',
  array: 'ARSCAN', // v0.4 arrays
};

/** Audit detail of a key read: type and counts, never data. */
export function keyReadDetail(d: KeyDetails): string {
  const v = d.value as Record<string, unknown>;
  const list = ['entries', 'items', 'members', 'samples'].map((f) => v[f]).find(Array.isArray) ?? (d.value.type === 'vectorset' ? d.value.page.members : undefined);
  const parts = [`type=${/^[A-Za-z0-9_-]{1,32}$/.test(d.type) ? d.type : 'other'}`];
  if (list) parts.push(`returned=${list.length}`);
  if (d.length !== undefined) parts.push(`length=${d.length}`);
  if (v.truncated === true || (list as { truncated?: boolean }[] | undefined)?.some((x) => x?.truncated) || v.truncatedMembers) parts.push('truncated');
  return parts.join(' ');
}

function hintFor(type: string): string {
  if (type.startsWith('MBbloom')) return 'BF.INFO / CF.INFO';
  if (type === 'vectorset') return 'VCARD / VINFO / VSIM';
  return 'TYPE / OBJECT ENCODING';
}

/** Make a decoded reply JSON-safe (Buffers -> strings, bigint -> string, Maps -> objects). */
export function jsonSafe(v: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (Array.isArray(v)) return v.slice(0, 1000).map((x) => jsonSafe(x, depth + 1));
  if (v instanceof Map) return Object.fromEntries([...v].slice(0, 1000).map(([k, x]) => [String(k), jsonSafe(x, depth + 1)]));
  if (v instanceof Error) return v.message;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 1000).map(([k, x]) => [k, jsonSafe(x, depth + 1)]));
  return v;
}

async function execPlan(conn: Conn, plan: OpPlan, timeout: number): Promise<unknown> {
  const cmds = planCommands(plan, conn.mode === 'cluster');
  try {
    if (cmds.length > 1) {
      const results = await inSlotOrder(cmds, (c) => c.argv[c.keys[0]!]!, (c) => conn.send(c.argv, { key: c.argv[c.keys[0]!], timeout, typeMapping: TM_REPLY }));
      return String(results.reduce<number>((a, r) => a + (Number(r) || 0), 0));
    }
    return await conn.send(plan.argv, { key: plan.argv[plan.keys[0] ?? 1], timeout, typeMapping: TM_REPLY });
  } catch (e) {
    throw toHttpError(e);
  }
}
