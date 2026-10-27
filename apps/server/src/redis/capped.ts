/**
 * Exclusive command sockets: no automatic retry of ambiguous writes, only a short bounded wait queue. A socket carries
 * one command at a time, except `CappedPool.pipeline`: a batch of fixed-size read-only metadata commands written at
 * once and read back reply by reply, each reply measured like any other (key browser metadata, v0.2.1).
 */
import net from 'node:net';
import tls from 'node:tls';
import { ErrorReply, TimeoutError, RESP_TYPES, type TypeMapping } from 'redis';
import type { DatabaseConfig, ResolvedCredential } from '../config.ts';
import { HttpError } from '../http/errors.ts';
import { Gate, MAX_WAIT_MS } from '../security/gate.ts';
import type { Arg, SendOpts } from './manager.ts';
import { RespReader, RespPush, RespTruncated, budgetTooLarge } from './resp.ts';

export interface Endpoint { host: string; port: number }
export const READ_CHUNK_BYTES = 64 * 1024;
/** Bytes kept of each string in a pub/sub message or MONITOR line; the rest is counted and skipped. */
export const STREAM_RETAIN_BYTES = 64 * 1024;
/**
 * Bytes one stream event may retain in total (a pub/sub message keeps its kind, channel, pattern and payload
 * preview). Fixed, so neither a large published value nor a small configured data cap ends a stream.
 */
export const STREAM_EVENT_BYTES = 4 * STREAM_RETAIN_BYTES;
const IDLE_MS = 30_000;
export function hashSlot(key: Arg): number {
  let b = Buffer.isBuffer(key) ? key : Buffer.from(key);
  const start = b.indexOf(123), end = start < 0 ? -1 : b.indexOf(125, start + 1);
  if (end > start + 1) b = b.subarray(start + 1, end);
  let crc = 0;
  for (const byte of b) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc % 16384;
}
export interface Redirect { kind: 'MOVED' | 'ASK'; slot: number; endpoint: Endpoint }
export function redirect(error: unknown): Redirect | undefined {
  if (!(error instanceof ErrorReply)) return;
  const m = /^(MOVED|ASK) (\d{1,5}) (?:\[([^\]]+)\]|([^ ]+)):(\d{1,5})$/.exec(error.message);
  if (!m || Number(m[2]) > 16383 || Number(m[5]) < 1 || Number(m[5]) > 65535) return;
  return { kind: m[1] as 'MOVED' | 'ASK', slot: Number(m[2]), endpoint: { host: m[3] ?? m[4]!, port: Number(m[5]) } };
}
/**
 * Cluster routing for redirects: a MOVED/ASK target is followed only when it is a primary of the known topology
 * (the cluster refreshes its slot map first when needed). Anything else is refused, so a node can never point the
 * server, and the tier's credentials, at an arbitrary host:port.
 */
export interface RedirectPolicy { allow(r: Redirect, deadline: number): Promise<boolean> }
/** Global concurrency for measured commands, or for dedicated stream sockets (separate budgets). */
export class CommandBudget {
  readonly max: number;
  readonly #gate: Gate;
  readonly #busy: string;
  constructor(max = 16, busy = `Too many Redis commands are running on this server (limit ${max}); try again shortly.`) {
    this.max = max; this.#busy = busy; this.#gate = new Gate(max);
  }
  /** Wait (bounded, FIFO) for a slot until `until`. */
  acquire(until: number, signal?: AbortSignal): Promise<() => void> {
    return this.#gate.acquire({ until, signal, busy: () => new HttpError('rate_limited', this.#busy), aborted: notSent });
  }
  /** A slot now or 429 (long-lived streams never queue). */
  take(): () => void {
    const release = this.#gate.tryAcquire();
    if (!release) throw new HttpError('rate_limited', this.#busy);
    return release;
  }
  get active(): number { return this.#gate.active; }
}
function cancelled(): HttpError { return new HttpError('unavailable', 'Redis command cancelled; it may already have executed.'); }
function notSent(): HttpError { return new HttpError('unavailable', 'Redis command cancelled before it was sent.'); }
/** The actor's session ended or account changed while the command waited for Redis (review v0.2 N1). */
export function revokedBeforeSend(): HttpError {
  return new HttpError('unauthenticated', 'Your session ended or your account changed; the command was not sent.');
}
class CommandSocket {
  readonly endpoint: Endpoint;
  readonly socket: net.Socket;
  idle: NodeJS.Timeout | undefined;
  ready = false;
  #stream: { reader: RespReader; receive(v: unknown): void; fail(e: unknown): void } | undefined;
  #pending: { reader: RespReader; resolve(v: unknown): void; reject(e: unknown): void; cleanup(): void; budget?: { remaining: number } | undefined; capBound?: boolean } | undefined;
  #pipe: PipeState | undefined;
  constructor(db: DatabaseConfig, endpoint: Endpoint) {
    this.endpoint = endpoint;
    const common = { ...endpoint, highWaterMark: READ_CHUNK_BYTES, noDelay: true };
    this.socket = db.tls ? tls.connect({
      ...common, rejectUnauthorized: db.tls.rejectUnauthorized,
      ...(db.tls.ca ? { ca: db.tls.ca.reveal() } : {}),
      ...(db.tls.cert ? { cert: db.tls.cert.reveal() } : {}),
      ...(db.tls.key ? { key: db.tls.key.reveal() } : {}),
      ...(db.tls.servername ? { servername: db.tls.servername } : {}),
    }) : net.createConnection(common);
    this.socket.on('data', (chunk: Buffer) => {
      if (this.#stream) {
        try {
          for (let offset = 0; offset < chunk.length;) {
            const stream = this.#stream;
            if (!stream) return;
            offset += stream.reader.feed(chunk.subarray(offset), true);
            if (stream.reader.done) {
              const value = stream.reader.value;
              stream.reader = this.#eventReader();
              stream.receive(value);
            }
          }
        } catch (e) { this.#fail(e); }
        return;
      }
      if (this.#pipe) { this.#pipeData(this.#pipe, chunk); return; }
      const p = this.#pending;
      if (!p) { this.destroy(); return; }
      try {
        const before = p.reader.bytes;
        try { p.reader.feed(chunk); } finally { if (p.budget) p.budget.remaining -= p.reader.bytes - before; }
        if (p.reader.done) {
          this.#pending = undefined; p.cleanup();
          const v = p.reader.value;
          if (v instanceof RespPush) { this.destroy(); p.reject(new HttpError('redis_error', 'Unexpected Redis push on a command connection.')); return; }
          if (v instanceof ErrorReply) p.reject(v); else p.resolve(v);
        }
      } catch (e) {
        // The bytes read are already charged. A reply that overflowed its own per-reply cap leaves the rest of the
        // request's budget to later reads (a too-large optional part is not the request's end; review v0.4 r2 M2);
        // any other failure, including a spent budget, ends it.
        if (p.budget && !(p.capBound && e instanceof HttpError && e.code === 'too_large')) p.budget.remaining = 0;
        this.#fail(e);
      }
    });
    this.socket.on('error', (e) => this.#fail(e));
    this.socket.on('close', () => this.#fail(new HttpError('unavailable', 'Redis connection closed.')));
  }
  #fail(e: unknown): void {
    const stream = this.#stream; this.#stream = undefined;
    stream?.fail(e);
    const p = this.#pending; this.#pending = undefined;
    const pipe = this.#pipe; this.#pipe = undefined;
    this.destroy();
    if (p) { p.cleanup(); p.reject(e); }
    if (pipe) { pipe.cleanup(); pipe.reject(e); }
  }
  /**
   * Replies of a pipeline, in order. Each reply gets its own reader with the per-reply cap (or less when the
   * request's cumulative budget is nearly spent). Error replies are results; a push, a malformed reply, an overflow or
   * bytes after the last expected reply fail the whole batch and drop the socket.
   */
  #pipeData(pipe: PipeState, chunk: Buffer): void {
    try {
      for (let offset = 0; offset < chunk.length;) {
        if (!pipe.reader) {
          if (pipe.budget && pipe.budget.remaining <= 0) throw budgetTooLarge(pipe.cap);
          pipe.reader = new RespReader(Math.min(pipe.cap, pipe.budget?.remaining ?? pipe.cap), pipe.mapping, undefined, undefined, { cap: pipe.cap });
        }
        const reader = pipe.reader;
        const before = reader.bytes;
        try { offset += reader.feed(chunk.subarray(offset), true); } finally { if (pipe.budget) pipe.budget.remaining -= reader.bytes - before; }
        if (!reader.done) continue;
        const v = reader.value;
        if (v instanceof RespPush) throw new HttpError('redis_error', 'Unexpected Redis push on a command connection.');
        pipe.results.push(v);
        pipe.reader = undefined;
        if (pipe.results.length === pipe.total) {
          if (offset < chunk.length) throw new HttpError('redis_error', 'Malformed Redis reply.');
          this.#pipe = undefined; pipe.cleanup();
          pipe.resolve(pipe.results);
          return;
        }
      }
    } catch (e) {
      if (pipe.budget) pipe.budget.remaining = 0;
      this.#fail(e);
    }
  }
  destroy(): void { clearTimeout(this.idle); this.socket.destroy(); }
  // Each event keeps at most STREAM_RETAIN_BYTES per string and STREAM_EVENT_BYTES in total; longer strings arrive cut.
  #eventReader(): RespReader { return new RespReader(STREAM_EVENT_BYTES, { [RESP_TYPES.BLOB_STRING]: Buffer }, undefined, undefined, { retain: STREAM_RETAIN_BYTES }); }
  stream(receive: (v: unknown) => void, fail: (e: unknown) => void): void {
    this.#stream = { reader: this.#eventReader(), receive, fail };
  }
  /**
   * Writes every command at once and resolves with every reply in order (`ErrorReply` objects for error replies).
   * Same checks as `send`; the actor check runs once, synchronously with the write of the whole batch.
   */
  sendMany(commands: Arg[][], cap: number, o: SendOpts): Promise<unknown[]> {
    if (o.signal?.aborted) return Promise.reject(cancelled());
    if (o.timeout !== undefined && o.timeout <= 0) return Promise.reject(new TimeoutError());
    if (o.replyBudget && o.replyBudget.remaining <= 0) return Promise.reject(budgetTooLarge(cap));
    if (this.socket.destroyed) return Promise.reject(new HttpError('unavailable', 'Redis connection closed.'));
    if (o.stillAllowed && !o.stillAllowed()) return Promise.reject(revokedBeforeSend());
    if (!commands.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const abort = () => this.#fail(cancelled());
      const timer = setTimeout(() => this.#fail(new TimeoutError()), Math.max(1, o.timeout ?? 5000));
      const cleanup = () => { clearTimeout(timer); o.signal?.removeEventListener('abort', abort); };
      this.#pipe = { total: commands.length, results: [], reader: undefined, resolve, reject, cleanup, budget: o.replyBudget, cap, mapping: o.typeMapping };
      o.signal?.addEventListener('abort', abort, { once: true });
      this.socket.cork();
      for (const args of commands) this.write(args);
      this.socket.uncork();
    });
  }
  write(args: Arg[]): void {
    this.socket.cork(); this.socket.write(`*${args.length}\r\n`);
    for (const a of args) { this.socket.write(`$${Buffer.byteLength(a)}\r\n`); this.socket.write(a); this.socket.write('\r\n'); }
    this.socket.uncork();
  }
  async connect(db: DatabaseConfig, cred: ResolvedCredential, tier: string, deadline: number, signal?: AbortSignal): Promise<void> {
    // Install the error/abort/timeout handlers before the socket can connect, including TLS verification.
    await new Promise<void>((resolve, reject) => {
      const event = db.tls ? 'secureConnect' : 'connect';
      const cleanup = () => { clearTimeout(timer); this.socket.off(event, ready); this.socket.off('error', fail); this.socket.off('close', closed); signal?.removeEventListener('abort', abort); };
      const ready = () => { cleanup(); resolve(); };
      const fail = (e: unknown) => { cleanup(); this.destroy(); reject(e); };
      const closed = () => fail(new HttpError('unavailable', 'Redis connection closed.'));
      const abort = () => fail(cancelled());
      const timer = setTimeout(() => fail(new TimeoutError()), Math.max(1, deadline - Date.now()));
      this.socket.once(event, ready); this.socket.once('error', fail); this.socket.once('close', closed);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    const hello: Arg[] = ['HELLO', '3'];
    if (cred.password || cred.username !== 'default') hello.push('AUTH', cred.username, cred.password?.reveal() ?? '');
    hello.push('SETNAME', `rconsole-${tier}-capped`);
    await this.send(hello, 64 * 1024, { timeout: deadline - Date.now(), signal });
    if (db.db) await this.send(['SELECT', String(db.db)], 1024, { timeout: deadline - Date.now(), signal });
    this.ready = true;
  }
  send(args: Arg[], cap: number, o: SendOpts): Promise<unknown> {
    if (o.signal?.aborted) return Promise.reject(cancelled());
    if (o.timeout !== undefined && o.timeout <= 0) return Promise.reject(new TimeoutError());
    if (o.replyBudget && o.replyBudget.remaining <= 0) return Promise.reject(budgetTooLarge(cap));
    if (this.socket.destroyed) return Promise.reject(new HttpError('unavailable', 'Redis connection closed.'));
    // The last check before the bytes are written, synchronously with the write: after the pool, budget and
    // connection waits, and on every redirected attempt (review v0.2 N1). The socket is dropped by the caller.
    if (o.stillAllowed && !o.stillAllowed()) return Promise.reject(revokedBeforeSend());
    return new Promise((resolve, reject) => {
      const abort = () => this.#fail(cancelled());
      const timer = setTimeout(() => this.#fail(new TimeoutError()), Math.max(1, o.timeout ?? 5000));
      const cleanup = () => { clearTimeout(timer); o.signal?.removeEventListener('abort', abort); };
      // The limit is the per-reply cap, or less when a cumulative request budget is nearly spent; errors name the cap.
      const limit = Math.min(cap, o.replyBudget?.remaining ?? cap);
      this.#pending = { reader: new RespReader(limit, o.typeMapping, undefined, undefined, { cap }), resolve, reject, cleanup, budget: o.replyBudget, capBound: limit === cap && (o.replyBudget === undefined || o.replyBudget.remaining > cap) };
      o.signal?.addEventListener('abort', abort, { once: true });
      this.write(args);
    });
  }
}
interface PipeState {
  total: number;
  results: unknown[];
  reader: RespReader | undefined;
  resolve(v: unknown[]): void;
  reject(e: unknown): void;
  cleanup(): void;
  budget: { remaining: number } | undefined;
  cap: number;
  mapping: TypeMapping | undefined;
}
/** A command of an exclusive exchange (`CappedPool.exclusive`); replies are measured like every other. */
export type ExclusiveSend = (args: Arg[], o?: { typeMapping?: TypeMapping | undefined; maxBytes?: number | undefined }) => Promise<unknown>;
/** `message` holds at most STREAM_RETAIN_BYTES; `totalBytes` is the published size. */
export type MessageCallback = (message: Buffer, channel: Buffer, totalBytes: number) => void;
export interface CappedDedicated {
  destroy(): void;
  onError(callback: (e: unknown) => void): void;
  subscribe(channels: string[], callback: MessageCallback, binary: true): Promise<void>;
  pSubscribe(pattern: string, callback: MessageCallback, binary: true): Promise<void>;
  /** `cut` is true when the line was longer than STREAM_RETAIN_BYTES and only its start is given. */
  monitor(callback: (line: string, cut: boolean) => void): Promise<void>;
}
const bytesOf = (v: unknown): [Buffer, number] => {
  if (v instanceof RespTruncated) return [Buffer.isBuffer(v.head) ? v.head : Buffer.from(v.head), v.total];
  const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v));
  return [b, b.length];
};
export class CappedPool {
  readonly #db: DatabaseConfig;
  readonly #cred: ResolvedCredential;
  readonly #tier: string;
  readonly #cap: number;
  readonly #budget: CommandBudget;
  readonly #streamBudget: CommandBudget;
  /** In-flight commands of this pool: each holds at most one socket, so at most poolSize sockets exist. */
  readonly #slots: Gate;
  readonly #idle = new Set<CommandSocket>();
  readonly #all = new Set<CommandSocket>();
  #closed = false;
  readonly #streams = new Set<CommandSocket>();
  constructor(db: DatabaseConfig, cred: ResolvedCredential, tier: string, cap: number, budget: CommandBudget, streamBudget: CommandBudget) {
    this.#db = db; this.#cred = cred; this.#tier = tier; this.#cap = cap; this.#budget = budget; this.#streamBudget = streamBudget;
    this.#slots = new Gate(db.poolSize);
  }
  #busy(): HttpError {
    return new HttpError('rate_limited', `All ${this.#db.poolSize} Redis connections of this database's ${this.#tier} pool are busy; try again shortly.`);
  }
  async send<T>(args: Arg[], endpoint: Endpoint, o: SendOpts = {}, redirects?: RedirectPolicy): Promise<T> {
    if (this.#closed) throw new HttpError('unavailable', 'Redis pool closed.');
    const timeout = o.timeout ?? 5000;
    // A short FIFO wait for a pool socket, then for a global slot; the command's own deadline starts afterwards.
    const until = Date.now() + Math.min(MAX_WAIT_MS, timeout);
    const releasePool = await this.#slots.acquire({ until, signal: o.signal, busy: () => this.#busy(), aborted: notSent });
    let release: () => void;
    try { release = await this.#budget.acquire(until, o.signal); } catch (e) { releasePool(); throw e; }
    const cap = o.maxBytes ?? this.#cap;
    const deadline = Date.now() + timeout;
    try {
      for (let attempt = 0; ; attempt++) {
        let c: CommandSocket | undefined;
        let reusable = false;
        try {
          if (o.signal?.aborted) throw cancelled();
          c = await this.#socket(endpoint, deadline, o.signal);
          if (Date.now() >= deadline) throw new TimeoutError();
          const value = await c.send(args, cap, { ...o, timeout: deadline - Date.now() });
          reusable = true; return value as T;
        } catch (e) {
          // A complete error reply (MOVED/ASK included) leaves the socket clean; anything else drops it.
          reusable = e instanceof ErrorReply && c?.ready === true;
          const move = redirects && attempt === 0 ? redirect(e) : undefined;
          if (!move) throw e;
          // Only explicit redirects to a known primary are retried. Network errors/timeouts never retry ambiguous mutations.
          if (!(await redirects!.allow(move, deadline))) {
            throw new HttpError('unavailable', 'The Redis cluster redirected the command to a node outside its known topology; refused.');
          }
          endpoint = move.endpoint;
          if (move.kind === 'ASK') {
            if (c) this.#return(c, reusable);
            c = undefined; reusable = false;
            c = await this.#socket(endpoint, deadline, o.signal);
            await c.send(['ASKING'], 1024, { timeout: deadline - Date.now(), signal: o.signal });
            const result = await c.send(args, cap, { ...o, timeout: deadline - Date.now() });
            reusable = true; return result as T;
          }
        } finally {
          if (c) this.#return(c, reusable);
        }
      }
    } finally { release(); releasePool(); }
  }
  /**
   * A batch of read-only, fixed-size commands on one socket of `endpoint`, written at once (one round trip): the key
   * browser's per-key metadata (TYPE, PTTL, MEMORY USAGE). Takes one pool socket and one global command slot like a
   * single command, shares its deadline, and measures every reply (per-reply `cap`, plus the request's cumulative
   * budget). Results are in order; an error reply is a result (an `ErrorReply`), so one missing permission or one
   * redirected key does not fail the batch. Redirects are not followed here (see `ClusterConn.pipeline`).
   */
  async pipeline(commands: Arg[][], endpoint: Endpoint, o: SendOpts = {}): Promise<unknown[]> {
    if (this.#closed) throw new HttpError('unavailable', 'Redis pool closed.');
    const timeout = o.timeout ?? 5000;
    const until = Date.now() + Math.min(MAX_WAIT_MS, timeout);
    const releasePool = await this.#slots.acquire({ until, signal: o.signal, busy: () => this.#busy(), aborted: notSent });
    let release: () => void;
    try { release = await this.#budget.acquire(until, o.signal); } catch (e) { releasePool(); throw e; }
    const cap = o.maxBytes ?? this.#cap;
    const deadline = Date.now() + timeout;
    let c: CommandSocket | undefined;
    let reusable = false;
    try {
      if (o.signal?.aborted) throw cancelled();
      c = await this.#socket(endpoint, deadline, o.signal);
      if (Date.now() >= deadline) throw new TimeoutError();
      const results = await c.sendMany(commands, cap, { ...o, timeout: deadline - Date.now() });
      reusable = true;
      return results;
    } finally {
      if (c) this.#return(c, reusable);
      release(); releasePool();
    }
  }
  /**
   * One socket for a short exchange that needs connection state: compare-and-set edits send WATCH, read, then
   * MULTI/EXEC on it (Lua is not used). `fn` gets a `send` bound to that socket; every command shares one deadline
   * and the per-reply cap (or a smaller `maxBytes`). The socket is closed afterwards whatever happened, so no WATCH
   * or MULTI state can reach a later borrower. In cluster mode a MOVED answer to the first command (nothing has been
   * read or written yet) restarts `fn` once on the target, under the same redirect policy as single commands; ASK
   * (the slot is migrating) is refused with 503 so the exchange never spans two nodes.
   */
  async exclusive<T>(endpoint: Endpoint, o: SendOpts, fn: (send: ExclusiveSend) => Promise<T>, redirects?: RedirectPolicy): Promise<T> {
    if (this.#closed) throw new HttpError('unavailable', 'Redis pool closed.');
    const timeout = o.timeout ?? 5000;
    const until = Date.now() + Math.min(MAX_WAIT_MS, timeout);
    const releasePool = await this.#slots.acquire({ until, signal: o.signal, busy: () => this.#busy(), aborted: notSent });
    let release: () => void;
    try { release = await this.#budget.acquire(until, o.signal); } catch (e) { releasePool(); throw e; }
    const cap = o.maxBytes ?? this.#cap;
    const deadline = Date.now() + timeout;
    try {
      for (let attempt = 0; ; attempt++) {
        let c: CommandSocket | undefined;
        let moved: Redirect | undefined;
        try {
          if (o.signal?.aborted) throw cancelled();
          const socket = c = await this.#socket(endpoint, deadline, o.signal);
          let sent = 0;
          return await fn(async (args, so = {}) => {
            if (Date.now() >= deadline) throw new TimeoutError();
            const first = sent++ === 0;
            try {
              return await socket.send(args, Math.min(cap, so.maxBytes ?? cap), { typeMapping: so.typeMapping ?? o.typeMapping, timeout: deadline - Date.now(), signal: o.signal, stillAllowed: o.stillAllowed });
            } catch (e) {
              if (first && redirects) moved = redirect(e);
              throw e;
            }
          });
        } catch (e) {
          if (!moved || attempt > 0) throw e;
          if (moved.kind === 'ASK') throw new HttpError('unavailable', "The key's cluster slot is being migrated; nothing was written. Try again shortly.");
          if (!(await redirects!.allow(moved, deadline))) {
            throw new HttpError('unavailable', 'The Redis cluster redirected the command to a node outside its known topology; refused.');
          }
          endpoint = moved.endpoint;
        } finally {
          if (c) this.#drop(c);
        }
      }
    } finally { release(); releasePool(); }
  }
  /** An idle socket to `endpoint`, or a new authenticated one (evicting an idle socket of another node if needed). */
  async #socket(endpoint: Endpoint, deadline: number, signal?: AbortSignal): Promise<CommandSocket> {
    if (this.#closed) throw new HttpError('unavailable', 'Redis pool closed.');
    const idle = [...this.#idle].find((x) => !x.socket.destroyed && x.endpoint.host === endpoint.host && x.endpoint.port === endpoint.port);
    if (idle) { this.#idle.delete(idle); clearTimeout(idle.idle); return idle; }
    // Evict an idle node when routing changes; the pool has no unbounded endpoint/redirect cache.
    if (this.#all.size >= this.#db.poolSize && this.#idle.size) this.#drop(this.#idle.values().next().value!);
    if (this.#all.size >= this.#db.poolSize) throw this.#busy();
    const c = new CommandSocket(this.#db, endpoint); this.#all.add(c);
    this.#track(c);
    try { await c.connect(this.#db, this.#cred, this.#tier, deadline, signal); } catch (e) { this.#drop(c); throw e; }
    return c;
  }
  #return(c: CommandSocket, reusable: boolean): void {
    if (reusable && !c.socket.destroyed && !this.#closed) {
      this.#idle.add(c);
      c.idle = setTimeout(() => this.#drop(c), IDLE_MS).unref();
    } else this.#drop(c);
  }
  /**
   * A long-lived pub/sub or MONITOR socket. It takes a slot of the separate stream budget, never a command slot, so
   * open streams cannot starve ordinary commands. `signal` aborts the handshake when the client has already gone;
   * `stillAllowed` is checked right before SUBSCRIBE/PSUBSCRIBE/MONITOR is written (review v0.2 N1).
   */
  async dedicated(endpoint: Endpoint, signal?: AbortSignal, stillAllowed?: () => boolean): Promise<CappedDedicated> {
    if (this.#closed) throw new HttpError('unavailable', 'Redis pool closed.');
    if (signal?.aborted) throw notSent();
    const release = this.#streamBudget.take();
    const c = new CommandSocket(this.#db, endpoint);
    this.#streams.add(c);
    c.socket.once('close', () => { this.#streams.delete(c); release(); });
    try { await c.connect(this.#db, this.#cred, this.#tier, Date.now() + 5000, signal); }
    catch (e) { c.destroy(); throw e; }
    let error: ((e: unknown) => void) | undefined;
    let pending: { left: number; resolve(): void; reject(e: unknown): void; timer: NodeJS.Timeout } | undefined;
    let monitor: ((line: string, cut: boolean) => void) | undefined;
    const channels = new Map<string, MessageCallback>();
    const patterns = new Map<string, MessageCallback>();
    const fail = (e: unknown) => {
      if (pending) { clearTimeout(pending.timer); pending.reject(e); pending = undefined; }
      error?.(e); c.destroy();
    };
    const deliver = (cb: MessageCallback | undefined, channel: unknown, message: unknown) => {
      if (!cb) return;
      const [m, total] = bytesOf(message);
      cb(m, bytesOf(channel)[0], total);
    };
    c.stream((v) => {
      if (v instanceof ErrorReply) { fail(v); return; }
      if (v instanceof RespPush) {
        const kind = String(v[0]);
        if (kind === 'message') deliver(channels.get(String(v[1])), v[1], v[2]);
        else if (kind === 'pmessage') deliver(patterns.get(String(v[1])), v[2], v[3]);
        else if (/^(?:p?subscribe)$/.test(kind) && pending && --pending.left === 0) {
          clearTimeout(pending.timer); pending.resolve(); pending = undefined;
        }
      } else if (pending && --pending.left === 0) { clearTimeout(pending.timer); pending.resolve(); pending = undefined; }
      else if (monitor) monitor(String(v instanceof RespTruncated ? v.head : v), v instanceof RespTruncated);
    }, fail);
    const send = (args: Arg[], count: number): Promise<void> => {
      if (stillAllowed && !stillAllowed()) return Promise.reject(revokedBeforeSend());
      return new Promise((resolve, reject) => {
        pending = { left: count, resolve, reject, timer: setTimeout(() => fail(new TimeoutError()), 5000) };
        c.write(args);
      });
    };
    return {
      destroy: () => c.destroy(), onError: (cb) => { error = cb; },
      subscribe: async (names, callback) => { for (const name of names) channels.set(name, callback); await send(['SUBSCRIBE', ...names], names.length); },
      pSubscribe: async (pattern, callback) => { patterns.set(pattern, callback); await send(['PSUBSCRIBE', pattern], 1); },
      monitor: async (callback) => { monitor = callback; await send(['MONITOR'], 1); },
    };
  }
  #track(c: CommandSocket): void { c.socket.once('close', () => { this.#all.delete(c); this.#idle.delete(c); }); }
  #drop(c: CommandSocket): void { this.#idle.delete(c); this.#all.delete(c); c.destroy(); }
  close(): void { this.#closed = true; for (const c of this.#all) this.#drop(c); for (const c of this.#streams) c.destroy(); }
}
