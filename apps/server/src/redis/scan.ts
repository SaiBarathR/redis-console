/**
 * Time-budgeted SCAN across every primary. The cursor is opaque to clients: for node 0 it is the raw
 * Redis cursor; for node k >= 1 it is `${k}${rawCursor padded to 20 digits}` (always > 20 digits).
 */
import { HttpError } from '../http/errors.ts';
import { checkGlob } from '../policy/policy.ts';
import type { Conn, Target } from './manager.ts';
import { asStr } from './reply.ts';
import { toHttpError } from './exec.ts';

export function encodeCursor(node: number, raw: string): string {
  return node === 0 ? raw : `${node}${raw.padStart(20, '0')}`;
}

export function decodeCursor(c: string): { node: number; raw: string } {
  if (!/^\d{1,40}$/.test(c)) throw new HttpError('validation', 'invalid cursor');
  if (c.length <= 20) return { node: 0, raw: c };
  return { node: Number(c.slice(0, c.length - 20)), raw: c.slice(-20).replace(/^0+(?=\d)/, '') };
}

/** Largest COUNT hint a typed scan sends per SCAN call (the console's own SCAN COUNT stays capped at 1000). */
export const SCAN_COUNT_MAX = 2000;

export interface ScanOptions {
  cursor: string;
  match: string;
  type?: string | undefined;
  /** COUNT hint per SCAN call (<= SCAN_COUNT_MAX). */
  count: number;
  /** Stop once this many keys were collected. */
  maxKeys: number;
  /** Stop once this many keyspace slots were examined (sum of COUNT hints; the key names `scanThreshold`). */
  maxScanned?: number | undefined;
  budgetMs: number;
  /**
   * Key browser names scans: end the page once the kept key names reach this many bytes, so a page of long names
   * returns early with its cursor instead of exhausting the request's cumulative read budget (which still applies).
   */
  keepBytes?: number | undefined;
  /**
   * For callers that drop each page (bulk delete, impact counts, analysis): every SCAN reply gets its own
   * `pageBytes` cap instead of the request's cumulative budget, and the page ends once its key names reach
   * `pageBytes`, so it holds at most about twice that (review v0.2 r4 M2). Unset (key browser): the page is returned
   * whole and the request's cumulative budget applies.
   */
  pageBytes?: number | undefined;
}

export interface ScanPage {
  cursor: string;
  keys: Buffer[];
  /** Approximate number of keyspace slots examined (SCAN calls x COUNT). */
  scanned: number;
  /** The page ended on the time budget or the byte limit, not on maxKeys, maxScanned or the end of the keyspace. */
  stopped?: 'time' | 'bytes';
}

export async function scanPage(conn: Pick<Conn, 'primaries'>, o: ScanOptions, nodes?: Target[]): Promise<ScanPage> {
  checkGlob(o.match, 'match');
  const all = nodes ?? (await conn.primaries());
  let { node, raw } = decodeCursor(o.cursor);
  if (node >= all.length) throw new HttpError('validation', 'invalid cursor');
  const keys: Buffer[] = [];
  const start = Date.now();
  let scanned = 0, bytes = 0;
  const count = Math.min(Math.max(o.count, 1), SCAN_COUNT_MAX);
  const maxScanned = o.maxScanned ?? Infinity;
  for (;;) {
    // Ask for no more than the page still has room for, so a page stays close to maxKeys (and maxScanned). Every key
    // a SCAN call returns is kept: the cursor has already moved past them, so dropping any would lose them for good.
    const step = Math.max(10, Math.min(count, o.maxKeys - keys.length, maxScanned - scanned));
    const args = ['SCAN', raw, 'MATCH', o.match, 'COUNT', String(step)];
    if (o.type) args.push('TYPE', o.type);
    let r: [unknown, Buffer[]];
    try {
      r = await all[node]!.send<[unknown, Buffer[]]>(args, { timeout: 5000, ...(o.pageBytes ? { replyBudget: { remaining: o.pageBytes } } : {}) });
    } catch (e) {
      throw toHttpError(e);
    }
    raw = asStr(r[0]);
    for (const k of r[1] ?? []) {
      keys.push(k);
      bytes += k.length;
    }
    scanned += step;
    if (raw === '0') {
      node++;
      if (node >= all.length) return { cursor: '0', keys, scanned };
    }
    if (keys.length >= o.maxKeys || scanned >= maxScanned) return { cursor: encodeCursor(node, raw), keys, scanned };
    if ((o.pageBytes !== undefined && bytes >= o.pageBytes) || (o.keepBytes !== undefined && bytes >= o.keepBytes)) {
      return { cursor: encodeCursor(node, raw), keys, scanned, stopped: 'bytes' };
    }
    if (Date.now() - start >= o.budgetMs) return { cursor: encodeCursor(node, raw), keys, scanned, stopped: 'time' };
  }
}

/** Sum of DBSIZE over primaries. */
export async function dbSize(conn: Conn): Promise<number> {
  const nodes = await conn.primaries();
  let n = 0;
  for (const t of nodes) n += Number(await t.send(['DBSIZE'], { timeout: 5000 })) || 0;
  return n;
}

/**
 * The one key a glob can match when it has no wildcard: `*`, `?` and `[` are special; `\x` stands for `x` (a trailing
 * `\` is a literal backslash, as in Redis's stringmatchlen). `undefined` when the pattern is a real glob.
 */
export function globLiteral(match: string): string | undefined {
  let out = '';
  for (let i = 0; i < match.length; i++) {
    const c = match[i]!;
    if (c === '*' || c === '?' || c === '[') return undefined;
    if (c === '\\' && i + 1 < match.length) out += match[++i];
    else out += c;
  }
  return out;
}

/**
 * True when a glob has no literal character outside `[...]` classes, so it can match keys of any name: `*`, `?*`,
 * but also `[^]*` (Redis reads `[^]` as "any one character") or `[a-z]*`. Classes are parsed like Redis's
 * stringmatchlen: optional `^`, `\` escapes, closed by the first unescaped `]` (an unclosed class runs to the
 * end). An escaped character (`\*`) is a literal.
 */
export function isPureWildcard(match: string): boolean {
  for (let i = 0; i < match.length; i++) {
    const c = match[i];
    if (c === '*' || c === '?') continue;
    if (c === '[') {
      i++;
      if (match[i] === '^') i++;
      while (i < match.length && match[i] !== ']') i += match[i] === '\\' ? 2 : 1;
      continue;
    }
    return false;
  }
  return true;
}
