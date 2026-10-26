/**
 * Compare-and-set edits (web review v0.2 r3): an op that replaces existing data carries what the client last read
 * (`EditExpect`), and the server writes only if Redis still holds exactly that. On one exclusive socket of the
 * caller's tier: `WATCH key`, read TYPE and the replaced bytes, compare, then `MULTI` + the op's command + `EXEC`.
 * A write by anyone else between WATCH and EXEC aborts the transaction (EXEC returns nil); the server then reads and
 * compares again, at most ATTEMPTS times. Lua is never used. In cluster mode the exchange runs on the primary of
 * the key's slot (see `CappedPool.exclusive`).
 */
import { createHash } from 'node:crypto';
import { ErrorReply, RESP_TYPES } from 'redis';
import { KEY_ELEMENT_PREVIEW_BYTES, KEY_VALUE_PREVIEW_BYTES, binFromBytes, type EditConflict, type EditExpect } from '@rconsole/shared';
import { HttpError } from '../http/errors.ts';
import { toHttpError } from './exec.ts';
import { TM_BIN, TM_STR, type Arg, type Conn, type ExclusiveSend } from './manager.ts';
import { TM_REPLY } from './reply.ts';

/** What an op replaces. Element probes read one element; `key` probes check the type (and a string/JSON value). */
export type Probe =
  | { kind: 'string' }
  | { kind: 'hash'; field: Buffer }
  | { kind: 'list'; index: number }
  | { kind: 'zset'; member: Buffer }
  | { kind: 'json' }
  | { kind: 'key' }
  // v0.4 arrays: `array` reads the element at `index` (ARGET; absent = null). `arrayInsert` reads the insert cursor
  // (ARNEXT) and counts existing elements in the `count` positions ARINSERT would write (AROP … USED): ARINSERT
  // overwrites them, so any count above zero is a conflict.
  | { kind: 'array'; index: string }
  | { kind: 'arrayInsert'; count: number };

export interface CheckedPlan {
  key: Buffer;
  probe: Probe;
  expect: EditExpect;
  /** The op's command, queued between MULTI and EXEC. */
  command: Arg[];
}

/** Types an expectation may name per probe (`none`: the key is absent, so the op creates it). */
const NATURAL: Record<Exclude<Probe['kind'], 'key'>, string> = { string: 'string', hash: 'hash', list: 'list', zset: 'zset', json: 'ReJSON-RL', array: 'array', arrayInsert: 'array' };
const MAY_BE_ABSENT = new Set<Probe['kind']>(['string', 'hash', 'zset', 'arrayInsert']);
/** v0.4 arrays: the highest index Redis accepts (ARRAY_MAX_INDEX). */
const ARRAY_LAST = 18446744073709551614n;
/** Integer replies as exact decimal text (array indices exceed 2^53). */
const TM_INT_STR = { ...TM_BIN, [RESP_TYPES.NUMBER]: String } as const;
/** Key-level ops compare bytes only for these types (a whole collection is never read). */
const KEY_VALUE_TYPES = new Set(['string', 'ReJSON-RL']);
/** WATCH aborts (someone wrote the key between the read and EXEC) before the server gives up with 409. */
export const ATTEMPTS = 3;

/** 400 for an expectation that cannot describe what the op replaces. */
export function validateExpect(probe: Probe, expect: EditExpect): void {
  const bad = (m: string) => { throw new HttpError('validation', `expect: ${m}`); };
  if (probe.kind === 'key') {
    if (expect.sha256 != null && !KEY_VALUE_TYPES.has(expect.type)) bad('sha256 is compared only for string and ReJSON-RL keys on key-level operations; send the type alone');
    if (expect.sha256 === null) bad('sha256 cannot be null on key-level operations');
    return;
  }
  const natural = NATURAL[probe.kind];
  if (probe.kind === 'arrayInsert') {
    if (expect.type !== 'array' && expect.type !== 'none') bad('type must be array (append to the array) or none (create the key) for this operation');
    if (expect.sha256 !== undefined) bad('sha256 is not used by array.insert; send the type alone (the server checks that the positions it writes are empty)');
    return;
  }
  if (expect.type === 'none') {
    if (!MAY_BE_ABSENT.has(probe.kind)) bad(`type none is not valid for this operation (expected ${natural})`);
    if (expect.sha256 != null) bad('sha256 must be absent or null when type is none');
    return;
  }
  if (expect.type !== natural) bad(`type must be ${natural}${MAY_BE_ABSENT.has(probe.kind) ? ' or none' : ''} for this operation`);
  if (expect.sha256 === undefined) bad('sha256 is required for this operation (null when the element did not exist)');
}

interface State {
  type: string;
  /** SHA-256 of the compared bytes; null = the element does not exist; undefined = not read. */
  sha?: string | null;
  bytes?: Buffer;
  /** Size of the element when it was too large to compare (or when only a prefix is kept). */
  total?: number;
  tooLarge?: boolean;
  /** The key's type changed between TYPE and the element read: someone replaced it meanwhile (review v0.2 r6 M1). */
  changed?: boolean;
  /** v0.4 arrays (`arrayInsert`): the insert cursor and how many existing elements ARINSERT would overwrite there. */
  occupied?: { next: string; used: number };
}

/**
 * The element read of a type TYPE has just reported failed because the key now holds another type: Redis's
 * WRONGTYPE, or RedisJSON's wording for JSON.GET. Only these mean a concurrent change; ACL, connection and other
 * command errors still propagate as themselves.
 */
const typeChanged = (e: unknown) => e instanceof ErrorReply && /^(?:WRONGTYPE\b|Existing key has wrong Redis type)/.test(e.message);

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const TM_SCORE = { ...TM_BIN, [RESP_TYPES.DOUBLE]: String } as const;

function readsElement(probe: Probe, type: string): boolean {
  return probe.kind === 'key' ? KEY_VALUE_TYPES.has(type) : type === NATURAL[probe.kind];
}

/** Bytes the comparison may read of one element: what the key browser can hand to an editor, at least. */
export function compareLimit(maxValueBytes: number): number {
  return Math.max(maxValueBytes, KEY_ELEMENT_PREVIEW_BYTES);
}

async function readState(send: ExclusiveSend, plan: CheckedPlan, limit: number, wantElement: boolean): Promise<State> {
  const type = String(await send(['TYPE', plan.key], { typeMapping: TM_STR }));
  if (!wantElement || !readsElement(plan.probe, type)) return { type };
  try {
    return await readElement(send, plan, limit, type);
  } catch (e) {
    // WATCH makes a later EXEC fail, but TYPE and the reads after it are not one snapshot.
    if (typeChanged(e)) return { type, changed: true };
    throw e;
  }
}

async function readElement(send: ExclusiveSend, plan: CheckedPlan, limit: number, type: string): Promise<State> {
  const { key, probe } = plan;
  const kind = probe.kind === 'key' ? (type === 'string' ? 'string' : 'json') : probe.kind;
  const big = (total: number): State => ({ type, tooLarge: true, total });
  const bounded = async (args: Arg[], typeMapping: object = TM_BIN): Promise<unknown> => {
    try {
      return await send(args, { typeMapping, maxBytes: limit + 64 });
    } catch (e) {
      // The reply is larger than anything an editor could hold; the transport has dropped the socket.
      if (e instanceof HttpError && e.code === 'too_large') return TOO_LARGE;
      throw e;
    }
  };
  const done = (raw: unknown): State => {
    if (raw === TOO_LARGE) return { type, tooLarge: true };
    if (raw === null || raw === undefined) return { type, sha: null };
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    return { type, sha: sha(bytes), bytes, total: bytes.length };
  };
  switch (kind) {
    case 'string': {
      const total = Number(await send(['STRLEN', key]));
      if (total > limit) {
        const head = await send(['GETRANGE', key, '0', String(KEY_VALUE_PREVIEW_BYTES - 1)]);
        return { ...big(total), bytes: Buffer.isBuffer(head) ? head : Buffer.alloc(0) };
      }
      return done(await bounded(['GET', key]));
    }
    case 'hash': {
      const field = (probe as Extract<Probe, { kind: 'hash' }>).field;
      if (Number(await send(['HEXISTS', key, field])) === 0) return { type, sha: null };
      const total = Number(await send(['HSTRLEN', key, field]));
      if (total > limit) return big(total);
      return done(await bounded(['HGET', key, field]));
    }
    case 'list':
      return done(await bounded(['LINDEX', key, String((probe as Extract<Probe, { kind: 'list' }>).index)]));
    case 'zset':
      return done(await send(['ZSCORE', key, (probe as Extract<Probe, { kind: 'zset' }>).member], { typeMapping: TM_SCORE }));
    // v0.4 arrays
    case 'array':
      return done(await bounded(['ARGET', key, (probe as Extract<Probe, { kind: 'array' }>).index]));
    case 'arrayInsert': {
      const next = String(await send(['ARNEXT', key], { typeMapping: TM_INT_STR }));
      const last = BigInt(next) + BigInt((probe as Extract<Probe, { kind: 'arrayInsert' }>).count) - 1n;
      const used = Number(await send(['AROP', key, next, String(last > ARRAY_LAST ? ARRAY_LAST : last), 'USED'], { typeMapping: TM_INT_STR }));
      return used > 0 ? { type, occupied: { next, used } } : { type };
    }
    default: {
      // The document as the key browser reads it (JSON.GET, decoded as UTF-8): the client hashes that text.
      const raw = await send(['JSON.GET', key], { typeMapping: TM_BIN }).catch((e: unknown) => (e instanceof HttpError && e.code === 'too_large' ? TOO_LARGE : Promise.reject(e)));
      if (raw === TOO_LARGE) return { type, tooLarge: true };
      if (raw === null) return { type, sha: null };
      const text = Buffer.from((Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))).toString('utf8'), 'utf8');
      return { type, sha: sha(text), bytes: text, total: text.length };
    }
  }
}
const TOO_LARGE = Symbol('too large');

function matches(state: State, expect: EditExpect): boolean {
  if (state.type !== expect.type) return false;
  if (state.occupied) return false;
  if (expect.sha256 === undefined) return true;
  if (state.tooLarge || state.sha === undefined) return state.type === 'none' && expect.sha256 === null;
  return state.sha === expect.sha256;
}

/** Whether "overwrite anyway" may target this state: a type the op can write (never across types). */
function overwritable(probe: Probe, type: string): boolean {
  if (probe.kind === 'key') return type !== 'none';
  // ARINSERT over existing elements, or over a key created meanwhile, is never offered as "overwrite anyway".
  if (probe.kind === 'arrayInsert') return false;
  return type === NATURAL[probe.kind] || (type === 'none' && MAY_BE_ABSENT.has(probe.kind));
}

export function conflictOf(plan: CheckedPlan, state: State): HttpError {
  const reason: EditConflict['reason'] = state.type !== plan.expect.type ? 'type' : 'value';
  const current: EditConflict['current'] = { type: state.type };
  if (state.bytes) {
    const cut = state.bytes.length > KEY_VALUE_PREVIEW_BYTES || (state.total ?? 0) > state.bytes.length;
    current.value = binFromBytes(state.bytes.subarray(0, KEY_VALUE_PREVIEW_BYTES));
    if (cut) current.truncated = true;
  }
  if (state.total !== undefined && (state.tooLarge || current.truncated)) current.totalBytes = state.total;
  if (!state.tooLarge && !state.changed && overwritable(plan.probe, state.type)) {
    current.expect = { type: state.type };
    if (state.sha !== undefined) current.expect.sha256 = state.sha;
  }
  const message = state.occupied
    ? `The insert cursor is at index ${state.occupied.next} and ARINSERT would overwrite ${state.occupied.used} existing element${state.occupied.used === 1 ? '' : 's'} there; nothing was written. Set values at empty indices instead.`
    : plan.probe.kind === 'arrayInsert' && plan.expect.type === 'none' && state.type !== 'none'
    ? 'This key already exists; nothing was written.'
    : reason === 'type'
    ? state.type === 'none'
      ? 'This key no longer exists; nothing was written.'
      : `This key changed since you opened it: it is now a ${state.type} (you opened ${/^[A-Za-z0-9_-]{1,32}$/.test(plan.expect.type) ? `a ${plan.expect.type}` : 'a different type'}); nothing was written.`
    : 'This value changed since you opened it; nothing was written.';
  return new HttpError('conflict', message, { conflict: { reason, expected: plan.expect, current } });
}

/**
 * Run the op's command only if Redis still holds what `plan.expect` describes. Returns the command's reply
 * (decoded for `toReply`). Throws 409 `conflict` (nothing written), or the usual mapped errors.
 */
export async function checkedWrite(conn: Conn, plan: CheckedPlan, o: { timeout: number; maxValueBytes: number; stillAllowed?: () => boolean }): Promise<unknown> {
  const limit = compareLimit(o.maxValueBytes);
  // Bytes are read when the expectation compares them, and for the conflict response when the type differs.
  const wantElement = plan.expect.sha256 !== undefined || plan.probe.kind !== 'key';
  try {
    return await conn.exclusive(plan.key, async (send) => {
      for (let attempt = 1; ; attempt++) {
        await send(['WATCH', plan.key]);
        const state = await readState(send, plan, limit, wantElement);
        if (state.changed) {
          // The type changed while it was read: read again (the same bound as aborted transactions), then 409.
          // UNWATCH clears the touched-key flag WATCH has set, so the next EXEC is not refused for this change.
          if (attempt < ATTEMPTS) { await send(['UNWATCH']); continue; }
          throw conflictOf(plan, { type: String(await send(['TYPE', plan.key], { typeMapping: TM_STR })), changed: true });
        }
        if (!matches(state, plan.expect)) throw conflictOf(plan, state);
        // The actor's session or account may have changed during the reads (review v0.2 r6 H2).
        if (o.stillAllowed && !o.stillAllowed()) throw new HttpError('unauthenticated', 'Your session ended or your account changed; nothing was written.');
        await send(['MULTI']);
        const queued = await send(plan.command, { typeMapping: TM_REPLY }).catch((e: unknown) => e);
        if (queued instanceof Error) {
          await send(['DISCARD']).catch(() => {});
          throw queued;
        }
        const out = await send(['EXEC'], { typeMapping: TM_REPLY });
        if (out === null) {
          // WATCH saw a write between the read and EXEC: nothing ran. Compare again with what is there now.
          if (attempt < ATTEMPTS) continue;
          throw conflictOf(plan, await readState(send, plan, limit, true));
        }
        const result = (out as unknown[])[0];
        if (result instanceof ErrorReply) throw result;
        return result;
      }
    }, { timeout: o.timeout });
  } catch (e) {
    const err = toHttpError(e);
    if (err.code === 'forbidden' && /\b(?:watch|unwatch|multi|exec|discard)\b/i.test(err.message)) {
      throw new HttpError('forbidden', err.message, { hint: "Checked edits use WATCH and MULTI/EXEC: grant +@transaction to this tier's Redis ACL user." });
    }
    throw err;
  }
}
