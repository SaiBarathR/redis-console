/**
 * Vector sets (v0.4, F23): fixed argv builders and reply parsers for the inspector. Every read the routes build here
 * is bounded in count (VRANGE count, VSIM COUNT/EF/FILTER-EF, VLINKS per layer), in bytes (the measured transport's
 * per-reply cap and the request budget) and in time (`policy.commandTimeoutMs`). Nothing here sends a command; the
 * routes do, through `detailRead` (policy + the caller's tier + actor check).
 */
import { RESP_TYPES } from 'redis';
import {
  KEY_ELEMENT_PREVIEW_BYTES,
  VSET_FILTER_EF_MAX,
  VSET_LINKS_PER_LAYER_MAX,
  VSET_LINK_LAYERS_MAX,
  VSET_MEMBER_MAX_BYTES,
  binFromBytes,
  bytesFromBin,
  type Bin,
  type ConfirmLevel,
  type KeyOp,
  type VectorSetInfo,
  type VectorSetMember,
  type VectorSetPage,
  type VsetNeighbour,
  type VsetSearchRequest,
} from '@rconsole/shared';
import { keyTag } from '../audit.ts';
import { HttpError } from '../http/errors.ts';
import type { Probe } from './checked.ts';
import { TM_BIN, type Arg } from './manager.ts';
import { asNum, asStr, kv } from './reply.ts';

/** Binary-safe, with doubles as the text Redis sent (scores, coordinates). */
export const TM_VSET = { ...TM_BIN, [RESP_TYPES.DOUBLE]: String } as const;
/** VINFO, VCARD and VDIM replies are a few hundred bytes; this cap is generous and independent of stored data. */
export const VSET_INFO_REPLY_BYTES = 64 * 1024;
/** Most bytes one VLINKS reply may take (neighbour names are data). Above it the links are left out. */
export const VSET_LINKS_REPLY_BYTES = 2 * 1024 * 1024;
/** Per-row VGETATTR cap of the members table; larger attributes are read from the element panel. */
export const VSET_ATTR_ROW_READ_BYTES = 64 * 1024;
/** After this many attributes too large for a row, the rest of the page is not read again one by one. */
export const VSET_ATTR_TOO_LARGE_RETRIES = 3;

/** VISMEMBER and VREM reply with a RESP3 boolean (an integer under RESP2). */
export const isTrue = (v: unknown): boolean => v === true || asNum(v) > 0;
const buf = (v: unknown): Buffer => (Buffer.isBuffer(v) ? v : Buffer.from(asStr(v)));
const bin = (v: unknown): Bin => binFromBytes(buf(v));

/** Request bytes of a member (paging start, element, search by member, edits): 400 when malformed or too long. */
export function memberBytes(m: Bin, what = 'member'): Buffer {
  if (m.enc === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(m.data)) throw new HttpError('validation', `${what}: invalid base64`);
  const b = Buffer.from(bytesFromBin(m));
  if (b.length > VSET_MEMBER_MAX_BYTES) throw new HttpError('validation', `${what}: at most ${VSET_MEMBER_MAX_BYTES} bytes`);
  return b;
}

/**
 * The smallest byte string greater than every string that starts with `prefix` (VRANGE orders members by bytes):
 * the prefix without its trailing 0xff bytes, with its last byte incremented. `undefined` when there is none (an
 * empty prefix or only 0xff bytes): the range then runs to `+`.
 */
export function prefixEnd(prefix: Buffer): Buffer | undefined {
  let n = prefix.length;
  while (n > 0 && prefix[n - 1] === 0xff) n--;
  if (n === 0) return undefined;
  const out = Buffer.from(prefix.subarray(0, n));
  out[n - 1]! += 1;
  return out;
}

/**
 * `VRANGE key start end count` for one page: after `after` (exclusive), within `prefix` (start `[prefix`, end
 * `(prefixEnd`), `count` members and one more, which only tells pageOf whether another page follows. `null` when the
 * range is empty (the start is past the prefix's end).
 */
export function vrangeArgs(key: Buffer, o: { after?: Buffer | undefined; prefix?: Buffer | undefined; count: number }): Arg[] | null {
  const prefix = o.prefix?.length ? o.prefix : undefined;
  const end = prefix ? prefixEnd(prefix) : undefined;
  let start: Buffer | string = '-';
  if (prefix && (!o.after || Buffer.compare(o.after, prefix) < 0)) start = Buffer.concat([Buffer.from('['), prefix]);
  // After the empty member (a legal name): `(` alone is not a range, so start at the smallest name after it.
  else if (o.after) start = o.after.length ? Buffer.concat([Buffer.from('('), o.after]) : Buffer.from([0x5b, 0x00]);
  if (end && o.after && Buffer.compare(o.after, end) >= 0) return null;
  return ['VRANGE', key, start, end ? Buffer.concat([Buffer.from('('), end]) : '+', String(o.count + 1)];
}

/**
 * A page from VRANGE's reply. Members longer than KEY_ELEMENT_PREVIEW_BYTES, or past the page's display budget
 * (`budget` bytes for all names together; later names are cut to 64 bytes), are cut and flagged. VRANGE is asked for
 * `count + 1` members (vrangeArgs): when the extra one came back, the page is cut to `count` and `next` is its last
 * member in full, so the following page starts after it exactly and a full last page offers no next (review v0.4 r1 L1).
 */
export function pageOf(raw: unknown[], count: number, budget: number, prefix?: Buffer): VectorSetPage {
  let left = budget;
  const more = raw.length > count;
  const shown = more ? raw.slice(0, count) : raw;
  const members: VectorSetMember[] = shown.map((m) => {
    const b = buf(m);
    const max = Math.min(KEY_ELEMENT_PREVIEW_BYTES, Math.max(64, left));
    const n = Math.min(b.length, max);
    left -= n;
    return b.length > n ? { member: binFromBytes(b.subarray(0, n)), truncated: true } : { member: binFromBytes(b) };
  });
  const page: VectorSetPage = { members };
  if (prefix?.length) page.prefix = binFromBytes(prefix);
  if (more && shown.length) {
    const last = buf(shown[shown.length - 1]);
    if (last.length <= VSET_MEMBER_MAX_BYTES) page.next = binFromBytes(last);
    else page.nextUnavailable = true;
  }
  return page;
}

/** The inspector's summary from VCARD, VDIM and VINFO (a flat or map reply; unknown fields are ignored). */
export function infoOf(card: unknown, dim: unknown, vinfo: unknown): VectorSetInfo {
  const f = kv(vinfo);
  const num = (k: string) => (f[k] === undefined || f[k] === null ? undefined : asNum(f[k]));
  const info: VectorSetInfo = { size: asNum(card), dim: asNum(dim) };
  const quant = f['quant-type'];
  if (quant !== undefined && quant !== null) {
    const q = asStr(quant);
    if (/^[A-Za-z0-9_-]{1,16}$/.test(q)) info.quantization = q;
  }
  const set = (k: keyof VectorSetInfo, field: string) => { const v = num(field); if (v !== undefined) (info as unknown as Record<string, number>)[k] = v; };
  set('hnswM', 'hnsw-m');
  set('maxLevel', 'max-level');
  set('attributesCount', 'attributes-count');
  set('projectionInputDim', 'projection-input-dim');
  return info;
}

/** A neighbour or result name: full when it can be addressed again (at most VSET_MEMBER_MAX_BYTES), else cut. */
function named(v: unknown): { member: Bin; truncated?: true } {
  const b = buf(v);
  return b.length > VSET_MEMBER_MAX_BYTES ? { member: binFromBytes(b.subarray(0, VSET_MEMBER_MAX_BYTES)), truncated: true } : { member: binFromBytes(b) };
}

/**
 * VLINKS … WITHSCORES (RESP3, maps as flat arrays): one entry per layer, each `[member, score, …]`. At most
 * VSET_LINK_LAYERS_MAX layers and VSET_LINKS_PER_LAYER_MAX neighbours each are listed; the rest are counted.
 */
export function linksOf(raw: unknown): { links: { layer: number; neighbours: VsetNeighbour[]; more?: number }[]; moreLayers?: number } {
  const layers = Array.isArray(raw) ? raw : [];
  const links = layers.slice(0, VSET_LINK_LAYERS_MAX).map((layer, i) => {
    const flat = Array.isArray(layer) ? layer : [];
    const total = Math.floor(flat.length / 2);
    const neighbours: VsetNeighbour[] = [];
    for (let j = 0; j + 1 < flat.length && neighbours.length < VSET_LINKS_PER_LAYER_MAX; j += 2) neighbours.push({ ...named(flat[j]), score: asStr(flat[j + 1]) });
    return total > neighbours.length ? { layer: i, neighbours, more: total - neighbours.length } : { layer: i, neighbours };
  });
  return layers.length > links.length ? { links, moreLayers: layers.length - links.length } : { links };
}

/**
 * `VSIM` argv for a search request. COUNT and EF come bounded from the schema; with a filter FILTER-EF is always
 * sent (default `count × 100`, at most VSET_FILTER_EF_MAX) because FILTER-EF 0 would scan the whole set. TRUTH and
 * NOTHREAD are never sent.
 */
export function vsimArgs(key: Buffer, q: Required<Pick<VsetSearchRequest, 'count' | 'withAttributes'>> & Omit<VsetSearchRequest, 'count' | 'withAttributes' | 'key'>, element?: Buffer): Arg[] {
  const argv: Arg[] = ['VSIM', key];
  if ('element' in q.query) argv.push('ELE', element ?? memberBytes(q.query.element));
  else argv.push('VALUES', String(q.query.values.length), ...q.query.values);
  argv.push('COUNT', String(q.count), 'WITHSCORES');
  if (q.withAttributes) argv.push('WITHATTRIBS');
  if (q.ef !== undefined) argv.push('EF', String(q.ef));
  if (q.filter !== undefined) argv.push('FILTER', q.filter, 'FILTER-EF', String(Math.min(q.filterEf ?? q.count * 100, VSET_FILTER_EF_MAX)));
  return argv;
}

/** VSIM … WITHSCORES [WITHATTRIBS] (RESP3 map as a flat array): member, then a score or `[score, attributes]`. */
export function similarOf(raw: unknown, withAttributes: boolean): { member: Buffer; score: string; attributes?: Buffer | null }[] {
  const flat = Array.isArray(raw) ? raw : [];
  const out: { member: Buffer; score: string; attributes?: Buffer | null }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const v = flat[i + 1];
    if (withAttributes && Array.isArray(v)) out.push({ member: buf(flat[i]), score: asStr(v[0]), attributes: v[1] == null ? null : buf(v[1]) });
    else out.push({ member: buf(flat[i]), score: asStr(v) });
  }
  return out;
}

/** A Redis error from VSIM/VEMB/VLINKS that describes the request, not a failure: shown as 404/400. */
export function vsetRequestError(e: unknown): HttpError | undefined {
  if (!(e instanceof HttpError) || e.code !== 'redis_error') return undefined;
  if (/element not found/i.test(e.message)) return new HttpError('not_found', 'This member does not exist in the vector set.');
  if (/dimension mismatch/i.test(e.message)) return new HttpError('validation', 'The query vector has a different number of dimensions than the set.');
  if (/syntax error in FILTER/i.test(e.message)) return new HttpError('validation', `Invalid filter expression: ${e.message.replace(/^ERR\s+/, '').slice(0, 300)}`);
  if (/invalid vector specification/i.test(e.message)) return new HttpError('validation', 'Redis refused the vector: each coordinate must be a number it can read as a double.');
  return undefined;
}

// ---------------------------------------------------------------------------
// Typed ops (POST /ops)

type VsetOp = Extract<KeyOp, { op: 'vset.add' | 'vset.setattr' | 'vset.remove' }>;
const b = (x: Bin) => Buffer.from(bytesFromBin(x));

/** The fixed command of a vector-set op (same shape as `planOp` in routes/keys.ts). */
export function planVsetOp(op: VsetOp): { argv: Arg[]; confirm: ConfirmLevel; summary: string; keys: number[]; redacted?: string[] } {
  switch (op.op) {
    case 'vset.add': {
      const member = memberBytes(op.member);
      const argv: Arg[] = ['VADD', b(op.key), 'VALUES', String(op.values.length), ...op.values, member];
      if (op.quantization) argv.push(op.quantization);
      if (op.attributes) argv.push('SETATTR', b(op.attributes));
      // The audit records the shape, not one `<n bytes>` per coordinate (up to VSET_VALUES_MAX of them).
      const redacted = ['VADD', keyTag(b(op.key)), 'VALUES', `<${op.values.length} values>`, `<${member.length} bytes>`, ...(op.quantization ? [op.quantization] : []), ...(op.attributes ? ['SETATTR', `<${b(op.attributes).length} bytes>`] : [])];
      return { argv, confirm: 'none', summary: 'Add vector set member', keys: [1], redacted };
    }
    case 'vset.setattr':
      return { argv: ['VSETATTR', b(op.key), memberBytes(op.member), b(op.attributes)], confirm: 'none', summary: 'Set vector set member attributes', keys: [1] };
    case 'vset.remove':
      return { argv: ['VREM', b(op.key), memberBytes(op.member)], confirm: 'confirm', summary: 'Remove 1 vector set member', keys: [1] };
  }
}

/** The compare-and-set probe of a vector-set op that carries `expect` (add: member absent; setattr: attribute bytes). */
export function vsetProbe(op: VsetOp): Probe | undefined {
  if (op.op === 'vset.add') return { kind: 'vmember', member: memberBytes(op.member) };
  if (op.op === 'vset.setattr') return { kind: 'vattr', member: memberBytes(op.member) };
  return undefined;
}
