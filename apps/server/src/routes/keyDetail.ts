/** DETAIL reads: fixed policy, actor-checked measured transport, shared request wire budget. */
import { createHash } from 'node:crypto';
import { RESP_TYPES } from 'redis';
import { binFromBytes, bytesFromBin, zKeyRead, type Bin, type ElementRef, type KeyElementResponse } from '@rconsole/shared';
import type { DbScope } from '../context.ts';
import { HttpError } from '../http/errors.ts';
import { authorize, checkGlob, fixedCommand } from '../policy/policy.ts';
import { run } from '../redis/exec.ts';
import { TM_BIN, type Arg, type Conn, type SendOpts } from '../redis/manager.ts';
import { asStr } from '../redis/reply.ts';
import { readArrayElement } from '../redis/array.ts';

export const identityDigest = (v: Buffer) => createHash('sha256').update(v).digest('hex');
export const rawBytes = (v: unknown): Buffer => Buffer.isBuffer(v) ? v : Buffer.from(asStr(v));
export const scoreMapping = { ...TM_BIN, [RESP_TYPES.DOUBLE]: String } as const;
/** Do not mark these reads `readonly`: dbScope then attaches its synchronous actor check. */
export async function detailRead<T = unknown>(scope: DbScope, conn: Conn, args: Arg[], o: SendOpts = {}): Promise<T> {
  const name = String(args[0]) + (args[0] === 'XINFO' ? ` ${args[1]}` : '');
  authorize(fixedCommand(name, 'read'), scope);
  return run<T>(conn, args, o);
}
export function scanArgs(type: 'hash' | 'set' | 'zset', key: Buffer, cursor: string, count: number, match?: string): Arg[] {
  if (!/^\d+$/.test(cursor)) throw new HttpError('validation', 'A collection scan cursor must be numeric.');
  if (match !== undefined) checkGlob(match, 'Collection MATCH');
  return [type === 'hash' ? 'HSCAN' : type === 'set' ? 'SSCAN' : 'ZSCAN', key, cursor, ...(match !== undefined ? ['MATCH', match] : []), 'COUNT', String(count)];
}
export function rangeArgs(key: Buffer, q: { offset: number; count: number; reverse: boolean; scoreMin?: string; scoreMax?: string }): Arg[] {
  const scored = q.scoreMin !== undefined || q.scoreMax !== undefined;
  const low = q.scoreMin ?? '-inf', high = q.scoreMax ?? '+inf';
  return ['ZRANGE', key, scored ? (q.reverse ? high : low) : String(q.offset), scored ? (q.reverse ? low : high) : String(q.offset + q.count - 1), ...(scored ? ['BYSCORE'] : []), ...(q.reverse ? ['REV'] : []), ...(scored ? ['LIMIT', String(q.offset), String(q.count)] : []), 'WITHSCORES'];
}
export function scorePairs(raw: unknown[]): [unknown, unknown][] {
  if (Array.isArray(raw[0])) return raw as [unknown, unknown][];
  const pairs: [unknown, unknown][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i], raw[i + 1]]);
  return pairs;
}
export async function readFullElement(scope: DbScope, key: Buffer, ref: ElementRef, limit: number, timeout: number, wireCap: number): Promise<KeyElementResponse> {
  if (ref.kind === 'array') return readArrayElement(scope, key, ref, limit, timeout, wireCap); // v0.4 arrays
  const conn = await scope.conn();
  const replyBudget = { remaining: wireCap };
  const o = { key, timeout, typeMapping: scoreMapping, replyBudget };
  const read = <T = unknown>(args: Arg[], bounded = false) => detailRead<T>(scope, conn, args, { ...o, ...(bounded ? { maxBytes: Math.min(wireCap, limit + 64) } : {}) });
  let raw: unknown;
  let identity: Buffer | undefined;
  let score: string | undefined;
  const bin = (v: Bin) => {
    const bytes = Buffer.from(bytesFromBin(v));
    if (bytes.length > 65536) throw new HttpError('validation', 'Element identity exceeds 64 KiB; use its page reference.');
    return bytes;
  };
  if (ref.kind === 'hash') { identity = bin(ref.field); raw = await read(['HGET', key, identity], true); }
  else if (ref.kind === 'list') raw = await read(['LINDEX', key, String(ref.index)], true);
  else if (ref.kind === 'set') { identity = bin(ref.member); raw = Number(await read(['SISMEMBER', key, identity])) ? identity : null; }
  else if (ref.kind === 'zset') {
    identity = bin(ref.member); const s = await read(['ZSCORE', key, identity]);
    raw = s == null ? null : identity; if (s != null) score = asStr(s);
  } else if (ref.kind === 'stream') {
    const entries = await read<[unknown, unknown[]][]>(['XRANGE', key, ref.id, ref.id, 'COUNT', '1']);
    raw = entries[0]?.[1]?.[ref.position * 2 + 1];
    const f = entries[0]?.[1]?.[ref.position * 2];
    if (f != null) identity = rawBytes(f);
  } else if (ref.kind === 'scan') {
    const [, flat] = await read<[unknown, unknown[]]>(scanArgs(ref.type, key, ref.cursor, ref.count, ref.match));
    const i = ref.position * (ref.type === 'set' ? 1 : 2);
    if (flat[i] != null) {
      identity = rawBytes(flat[i]);
      raw = ref.type === 'hash' ? flat[i + 1] : identity;
      if (ref.type === 'zset') score = asStr(flat[i + 1]);
    }
  } else {
    // Reuse score validation; a reference is untrusted input like every other request.
    if (!zKeyRead.safeParse({ key: binFromBytes(key), scoreMin: ref.scoreMin, scoreMax: ref.scoreMax }).success) throw new HttpError('validation', 'Invalid score bounds in element reference.');
    const pairs = scorePairs(await read<unknown[]>(rangeArgs(key, { ...ref, count: 1 })));
    if (pairs[0]) { identity = rawBytes(pairs[0][0]); raw = identity; score = asStr(pairs[0][1]); }
  }
  if ((ref.kind === 'scan' || ref.kind === 'rank') && (!identity || identityDigest(identity) !== ref.identity))
    throw new HttpError('conflict', 'This collection page changed; refresh it before loading the element.');
  if (raw == null) throw new HttpError('not_found', 'This collection element no longer exists.');
  // A list row is addressed by index: another element there now (a push or pop moved it) is a conflict, not the row.
  if (ref.kind === 'list' && identityDigest(rawBytes(raw)) !== ref.identity)
    throw new HttpError('conflict', 'This list changed; refresh it before loading the element.');
  const bytes = rawBytes(raw);
  if (bytes.length > limit || (identity?.length ?? 0) > limit) throw new HttpError('too_large', `The full element exceeds the ${limit}-byte value cap.`);
  return { value: binFromBytes(bytes), ...(identity ? { identity: binFromBytes(identity) } : {}), ...(score !== undefined ? { score } : {}) };
}
