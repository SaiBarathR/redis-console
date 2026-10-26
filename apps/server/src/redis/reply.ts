/**
 * Convert node-redis RESP3 replies (decoded with TM_TREE / TM_TREE_PAIRS) into the binary-safe,
 * size-capped `Reply` tree of the API contract.
 *
 * Decoding conventions (see manager.ts): simple/blob/verbatim strings -> Buffer, integers -> decimal
 * string (exact 64-bit), doubles -> number, big numbers -> bigint, maps -> Map (keys are strings) or a
 * flat array, sets -> Set, nested errors -> Error.
 */
import { RESP_TYPES, type TypeMapping } from 'redis';
import { binFromBytes, type Reply } from '@rconsole/shared';

export const TM_REPLY = {
  [RESP_TYPES.SIMPLE_STRING]: Buffer,
  [RESP_TYPES.BLOB_STRING]: Buffer,
  [RESP_TYPES.VERBATIM_STRING]: Buffer,
  [RESP_TYPES.NUMBER]: String,
  [RESP_TYPES.MAP]: Map,
  [RESP_TYPES.SET]: Set,
} as const satisfies TypeMapping;

/** Same, but maps arrive as flat [k, v, k, v] arrays so binary keys survive; we re-pair them. */
export const TM_REPLY_PAIRS = { ...TM_REPLY, [RESP_TYPES.MAP]: Array } as const satisfies TypeMapping;

export interface ReplyLimits {
  maxBytes: number;
  maxElements: number;
}

const MAX_DEPTH = 32;

export function formatDouble(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  return String(n);
}

export function toReply(value: unknown, limits: ReplyLimits, opts: { pairs?: boolean } = {}): Reply {
  const budget = { bytes: limits.maxBytes, elems: limits.maxElements };

  const bytesOf = (b: Uint8Array): Reply => {
    if (b.byteLength > budget.bytes) {
      budget.bytes = 0;
      return { t: 'truncated', bytes: b.byteLength };
    }
    budget.bytes -= b.byteLength;
    return { t: 'str', v: binFromBytes(b) };
  };

  const conv = (v: unknown, depth: number, top: boolean): Reply => {
    if (depth > MAX_DEPTH) return { t: 'truncated', bytes: 0 };
    if (v === null || v === undefined) return { t: 'nil' };
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return bytesOf(v);
    if (typeof v === 'string') return { t: 'int', v };
    if (typeof v === 'bigint') return { t: 'int', v: v.toString() };
    if (typeof v === 'number') return { t: 'dbl', v: formatDouble(v) };
    if (typeof v === 'boolean') return { t: 'bool', v };
    if (v instanceof Error) {
      budget.bytes -= Math.min(budget.bytes, v.message.length);
      return { t: 'err', v: v.message.slice(0, 4096) };
    }
    if (v instanceof Map) {
      const out: [Reply, Reply][] = [];
      let i = 0;
      for (const [k, val] of v) {
        if (budget.elems <= 0 || budget.bytes <= 0) break;
        budget.elems--;
        const key = typeof k === 'string' ? bytesOf(Buffer.from(k)) : conv(k, depth + 1, false);
        out.push([key, conv(val, depth + 1, false)]);
        i++;
      }
      return i < v.size ? { t: 'map', v: out, more: v.size - i } : { t: 'map', v: out };
    }
    if (v instanceof Set) {
      const out: Reply[] = [];
      let i = 0;
      for (const x of v) {
        if (budget.elems <= 0 || budget.bytes <= 0) break;
        budget.elems--;
        out.push(conv(x, depth + 1, false));
        i++;
      }
      return i < v.size ? { t: 'set', v: out, more: v.size - i } : { t: 'set', v: out };
    }
    if (Array.isArray(v)) {
      if (top && opts.pairs) return pairsToMap(v, depth);
      const out: Reply[] = [];
      for (const x of v) {
        if (budget.elems <= 0 || budget.bytes <= 0) break;
        budget.elems--;
        out.push(conv(x, depth + 1, false));
      }
      return out.length < v.length ? { t: 'arr', v: out, more: v.length - out.length } : { t: 'arr', v: out };
    }
    // Unknown JS value (should not happen): show a type marker, never the object itself.
    return { t: 'status', v: `<unsupported reply type ${typeof v}>` };
  };

  /** Flat [k1, v1, k2, v2] from a RESP3 map decoded as an array (HGETALL, XREAD...). */
  const pairsToMap = (arr: unknown[], depth: number): Reply => {
    const out: [Reply, Reply][] = [];
    const total = Math.floor(arr.length / 2);
    for (let i = 0; i + 1 < arr.length; i += 2) {
      if (budget.elems <= 0 || budget.bytes <= 0) break;
      budget.elems--;
      out.push([conv(arr[i], depth + 1, false), conv(arr[i + 1], depth + 1, false)]);
    }
    return out.length < total ? { t: 'map', v: out, more: total - out.length } : { t: 'map', v: out };
  };

  return conv(value, 0, true);
}

/** Commands whose RESP3 map replies are keyed by user data (field names, stream keys). */
export const PAIR_MAP_COMMANDS = new Set(['HGETALL', 'XREAD', 'XREADGROUP', 'CONFIG']);

// ---------------------------------------------------------------------------
// Helpers for internal parsing of TM_BIN / TM_STR replies.

export const asBuf = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.from(v == null ? '' : String(v)));
export const asStr = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : v == null ? '' : String(v));
export const asNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(asStr(v));
  return Number.isFinite(n) ? n : 0;
};

/** Flat [k, v, k, v] (or a Map) -> record with string keys. */
export function kv(v: unknown): Record<string, unknown> {
  // Null prototype: keys come from Redis data (hash fields, consumer names, labels), e.g. "__proto__".
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (v instanceof Map) {
    for (const [k, x] of v) out[asStr(k)] = x;
  } else if (Array.isArray(v)) {
    for (let i = 0; i + 1 < v.length; i += 2) out[asStr(v[i])] = v[i + 1];
  } else if (v && typeof v === 'object') {
    Object.assign(out, v);
  }
  return out;
}

/** Parse INFO text into sections. */
export function parseInfo(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = 'default';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      section = line.slice(1).trim().toLowerCase();
      out[section] ??= {};
      continue;
    }
    const i = line.indexOf(':');
    if (i < 0) continue;
    const sec = (out[section] ??= {});
    let key = line.slice(0, i);
    // Repeated keys (e.g. one `module:` line per module) get a numeric suffix.
    if (key in sec) {
      let n = 2;
      while (`${key}#${n}` in sec) n++;
      key = `${key}#${n}`;
    }
    sec[key] = line.slice(i + 1);
  }
  return out;
}
