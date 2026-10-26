/**
 * Redis connection manager. Scalar/topology and exclusive capped pools per (database, ACL tier). The tier is always the
 * caller's effective role; a missing tier never falls back to a lower one (`default` applies to all).
 * Databases (hosts, ports, TLS) come only from server config.
 */
import {
  createClientPool,
  createCluster,
  createSentinel,
  ErrorReply,
  RESP_TYPES,
  TimeoutError,
  type RedisClientOptions,
  type TypeMapping,
} from 'redis';
import type { Role } from '@rconsole/shared';
import { credentialForTier, type DatabaseConfig, type ResolvedCredential } from '../config.ts';
import { HttpError } from '../http/errors.ts';
import { CappedPool, CommandBudget, hashSlot, redirect, type CappedDedicated, type Endpoint, type ExclusiveSend, type Redirect, type RedirectPolicy } from './capped.ts';

export type { ExclusiveSend } from './capped.ts';

export type Arg = string | Buffer;

/** Binary-safe, flat: blob strings as Buffers, maps and sets as flat arrays. */
export const TM_BIN = { [RESP_TYPES.BLOB_STRING]: Buffer, [RESP_TYPES.MAP]: Array, [RESP_TYPES.SET]: Array } as const satisfies TypeMapping;
/** Text, flat: strings, maps and sets as flat arrays. */
export const TM_STR = { [RESP_TYPES.MAP]: Array, [RESP_TYPES.SET]: Array } as const satisfies TypeMapping;
/** For reply trees: keeps map/set structure (map keys are decoded as strings by node-redis). */
export const TM_TREE = { [RESP_TYPES.BLOB_STRING]: Buffer, [RESP_TYPES.MAP]: Map, [RESP_TYPES.SET]: Set } as const satisfies TypeMapping;
/** For reply trees of commands whose map keys are user data (HGETALL, XREAD): flat but binary-safe. */
export const TM_TREE_PAIRS = { [RESP_TYPES.BLOB_STRING]: Buffer, [RESP_TYPES.MAP]: Array, [RESP_TYPES.SET]: Set } as const satisfies TypeMapping;

export interface SendOpts {
  /** Force the measured path, including scalar commands from the console. */
  capped?: boolean;
  /** Internal metadata may use its own fixed cap; never populated from request input. */
  maxBytes?: number | undefined;
  /** Shared cumulative wire budget for a typed request that makes several Redis reads. */
  replyBudget?: { remaining: number } | undefined;
  signal?: AbortSignal | undefined;
  /** First key (routes the command in cluster mode). */
  key?: Arg | undefined;
  readonly?: boolean | undefined;
  /**
   * Whether the request's actor may still act. A command that carries it always goes through the measured transport,
   * which evaluates it synchronously with the write of the command's bytes: after every pool, budget and connection
   * wait, and again before a redirected re-dispatch. `false` refuses the command (401) before it is sent (review v0.2
   * N1). node-redis is never used for it: node-redis writes a queued command on a later turn of the event loop, so a
   * check before queueing could pass for an actor revoked before the bytes are written (N1 follow-up).
   */
  stillAllowed?: (() => boolean) | undefined;
  timeout?: number | undefined;
  typeMapping?: TypeMapping | undefined;
}

export interface Target {
  readonly label: string;
  send<T = unknown>(args: Arg[], o?: SendOpts): Promise<T>;
}

/** One command of a `Conn.pipeline` batch: its argv and the key that routes it in cluster mode. */
export interface PipelineCommand { args: Arg[]; key: Arg }

/** A dedicated, non-pooled connection (pub/sub, MONITOR). Caller must close it. */
export type DedicatedClient = CappedDedicated;

export interface Conn extends Target {
  readonly mode: DatabaseConfig['mode'];
  /** Every primary node (one entry in standalone/sentinel mode). Used for SCAN and per-node stats. */
  primaries(): Promise<Target[]>;
  /** `signal` aborts the connection handshake (the stream's client went away); see `SendOpts.stillAllowed`. */
  dedicated(signal?: AbortSignal, stillAllowed?: () => boolean): Promise<DedicatedClient>;
  /**
   * Run `fn` on one exclusive measured socket of the node that serves `key` (compare-and-set edits: WATCH, read,
   * MULTI/EXEC). The socket is closed afterwards. See `CappedPool.exclusive`.
   */
  exclusive<T>(key: Arg, fn: (send: ExclusiveSend) => Promise<T>, o?: SendOpts): Promise<T>;
  /**
   * Read-only, fixed-size per-key commands (the key browser's TYPE / PTTL / MEMORY USAGE), pipelined on measured
   * sockets: one batch per node (each primary in cluster mode), every reply measured. Results are in order; an error
   * reply is returned as an `ErrorReply`. A cluster key whose slot moved is re-sent on its own (redirect policy).
   */
  pipeline(commands: PipelineCommand[], o?: SendOpts): Promise<unknown[]>;
  close(): Promise<void>;
  /** Drop every socket now (in-flight commands fail). Used when a command outlives its timeout. */
  destroy(): void;
}

/**
 * Fixed, measured cap for server metadata the console itself reads (INFO, COMMAND DOCS): sized by the server's
 * structure, not by stored data, so lowering `policy.maxReadReplyBytes` for data never breaks them (review v0.2 r4
 * L2). Measured on Redis 8.10.2 with modules: COMMAND DOCS 449 KB, INFO under 10 KB.
 */
export const METADATA_REPLY_BYTES = 4 * 1024 * 1024;

/** Hard ceiling for commands sent without an explicit timeout. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
/** Grace after the requested timeout, so node-redis's own (queue-phase) TimeoutError wins whenever it applies. */
const HARD_TIMEOUT_GRACE_MS = 500;

/**
 * node-redis (5.12) clears a command's `timeout` as soon as the command is written to the socket, so a command
 * that Redis never answers (e.g. some module-internal commands) would pin its connection, and every command
 * pipelined behind it, forever. This timer runs from the moment the command is handed to its connection; when it
 * fires, the caller gets a TimeoutError and `onStuck` resets the connection, because a RESP connection cannot
 * skip one reply and stay usable.
 */
export function hardTimeout<T>(p: Promise<T>, ms: number | undefined, onStuck: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new TimeoutError());
      onStuck();
    }, (ms ?? DEFAULT_COMMAND_TIMEOUT_MS) + HARD_TIMEOUT_GRACE_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}

const errListener = (label: string, log: (msg: string) => void) => (e: unknown) => log(`redis ${label}: ${(e as Error)?.message ?? String(e)}`);

/** Connection phase shared by every socket of one Conn: fail fast until the first successful connect. */
interface Phase { connected: boolean }

function socketOpts(db: DatabaseConfig, phase: Phase, host?: string, port?: number) {
  const s: Record<string, unknown> = {
    connectTimeout: 5000,
    // Before the first successful connect, give up immediately (the request gets a clear 503 and the
    // next request retries); afterwards reconnect with exponential backoff.
    reconnectStrategy: (retries: number, cause: Error) => (phase.connected ? Math.min(250 * 2 ** retries, 10_000) : cause),
  };
  if (host) s.host = host;
  if (port) s.port = port;
  if (db.tls) {
    s.tls = true;
    s.rejectUnauthorized = db.tls.rejectUnauthorized;
    if (db.tls.ca) s.ca = db.tls.ca.reveal();
    if (db.tls.cert) s.cert = db.tls.cert.reveal();
    if (db.tls.key) s.key = db.tls.key.reveal();
    if (db.tls.servername) s.servername = db.tls.servername;
  }
  return s;
}

function baseClientOptions(db: DatabaseConfig, cred: ResolvedCredential, tier: string): RedisClientOptions {
  const o: Record<string, unknown> = {
    RESP: 3,
    username: cred.username,
    name: `rconsole-${tier}`,
    disableClientInfo: true,
    disableOfflineQueue: true,
    maintNotifications: 'disabled',
    pingInterval: 30_000,
  };
  if (cred.password) o.password = cred.password.reveal();
  return o as RedisClientOptions;
}

function urlHostPort(u: string): { host: string; port: number } {
  const x = new URL(u);
  return { host: x.hostname.replace(/^\[|\]$/g, ''), port: Number(x.port || 6379) };
}

/** The part of a pooled node-redis client used to replace its socket. */
interface Replaceable {
  destroy(): void;
  connect(): Promise<unknown>;
}

/** Only replies whose size is independent of stored values/names may stay on node-redis (see `measured`). */
export function fixedReply(args: Arg[]): boolean {
  const c = String(args[0]).toUpperCase();
  if (c === 'PING') return args.length === 1;
  if (c === 'MEMORY') return String(args[1]).toUpperCase() === 'USAGE';
  return new Set(['TYPE', 'TTL', 'PTTL', 'EXISTS', 'STRLEN', 'LLEN', 'HLEN', 'SCARD', 'ZCARD', 'XLEN',
    'HEXISTS', 'SISMEMBER', 'DBSIZE', 'LASTSAVE', 'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'PERSIST',
    'HSET', 'HDEL', 'LSET', 'LREM', 'LPUSH', 'RPUSH', 'SADD', 'SREM', 'ZADD', 'ZREM', 'XADD', 'XDEL', 'XACK']).has(c);
}

/**
 * Whether a command goes through the measured transport: every command whose reply size depends on data, every
 * console command (`capped`), and every command with an actor check (`stillAllowed`), so no actor-checked command
 * waits in node-redis's write queue (review v0.2 N1 follow-up). What stays on node-redis is fixed-size and unchecked:
 * read-only metadata of key lists and analysis, and the server's own probes.
 */
export function measured(args: Arg[], o: SendOpts): boolean {
  return !!o.capped || o.stillAllowed !== undefined || !fixedReply(args);
}

class StandaloneConn implements Conn {
  readonly #capped: CappedPool;
  readonly #phase: Phase = { connected: false };
  readonly mode = 'standalone' as const;
  readonly label: string;
  readonly #pool;
  readonly #opts: RedisClientOptions;
  readonly #endpoint;
  readonly #onStuck: () => void;
  readonly #log: (m: string) => void;
  #closed = false;
  constructor(db: DatabaseConfig, cred: ResolvedCredential, tier: string, log: (m: string) => void, onStuck: () => void, cap: number, budget: CommandBudget, streams: CommandBudget) {
    this.#capped = new CappedPool(db, cred, tier, cap, budget, streams);
    this.#onStuck = onStuck;
    this.#log = log;
    const { host, port } = urlHostPort(db.url!);
    this.#endpoint = { host, port };
    this.label = `${db.id}/${tier}`;
    this.#opts = { ...baseClientOptions(db, cred, tier), database: db.db, socket: socketOpts(db, this.#phase, host, port) } as RedisClientOptions;
    this.#pool = createClientPool(this.#opts as RedisClientOptions<{}, {}, {}, 3, {}>, { minimum: 1, maximum: db.poolSize, acquireTimeout: 5000, cleanupDelay: 5000 });
    this.#pool.on('error', errListener(this.label, log));
  }
  async connect() {
    await this.#pool.connect();
    this.#phase.connected = true;
  }
  send<T>(args: Arg[], o: SendOpts = {}): Promise<T> {
    if (measured(args, o)) return this.#capped.send(args, this.#endpoint, { ...o, typeMapping: o.typeMapping ?? TM_BIN });
    return new Promise<T>((resolve, reject) => {
      // The timer starts once a pooled client is acquired (waiting for one is bounded by acquireTimeout).
      this.#pool
        .execute(async (client) => {
          let stuck = false;
          const p = client.sendCommand(args, { typeMapping: o.typeMapping ?? TM_BIN, ...(o.timeout ? { timeout: o.timeout } : {}) }) as Promise<T>;
          try {
            resolve(await hardTimeout(p, o.timeout, () => (stuck = true)));
          } catch (e) {
            reject(e as Error);
            // The client goes back to the pool only once its socket has been replaced (review v0.2 M3).
            if (stuck) await this.#replace(client);
          }
        })
        .catch(reject);
    });
  }
  /**
   * A command on this pooled client outlived its timeout. A RESP connection cannot skip one reply, so its socket is
   * dropped and reopened before the pool hands the client out again; the tier's other connections, and the commands
   * in flight on them, are untouched. Only if no new socket can be opened is the whole tier reset.
   */
  async #replace(client: Replaceable) {
    this.#log(`redis ${this.label}: a command exceeded its timeout; replacing its connection`);
    client.destroy();
    if (this.#closed) return;
    try {
      await withTimeout(client.connect(), 6000, 'reconnect timeout');
      if (this.#closed) client.destroy();
    } catch {
      client.destroy();
      this.#onStuck();
    }
  }
  async primaries(): Promise<Target[]> {
    return [this];
  }
  async dedicated(signal?: AbortSignal, stillAllowed?: () => boolean): Promise<DedicatedClient> { return this.#capped.dedicated(this.#endpoint, signal, stillAllowed); }
  exclusive<T>(_key: Arg, fn: (send: ExclusiveSend) => Promise<T>, o: SendOpts = {}): Promise<T> {
    return this.#capped.exclusive(this.#endpoint, { ...o, typeMapping: o.typeMapping ?? TM_BIN }, fn);
  }
  pipeline(commands: PipelineCommand[], o: SendOpts = {}): Promise<unknown[]> {
    return this.#capped.pipeline(commands.map((c) => c.args), this.#endpoint, { ...o, typeMapping: o.typeMapping ?? TM_BIN });
  }
  async close() {
    this.#capped.close();
    this.#closed = true;
    await this.#pool.close().catch(() => this.#pool.destroy());
  }
  destroy() {
    this.#capped.close();
    this.#closed = true;
    this.#pool.destroy();
  }
}

class ClusterConn implements Conn {
  readonly #capped: CappedPool;
  readonly #phase: Phase = { connected: false };
  readonly mode = 'cluster' as const;
  readonly label: string;
  readonly #cluster;
  readonly #client: RedisClientOptions;
  readonly #onStuck: () => void;
  /**
   * MOVED/ASK are followed only to a primary of the node-redis topology. A MOVED that disagrees with the slot map
   * refreshes it first (as node-redis itself does), so after a reshard later commands route directly again; a
   * target that is still unknown afterwards is refused (review v0.2 r4 L1).
   */
  readonly #redirects: RedirectPolicy = {
    allow: async (r: Redirect, deadline: number) => {
      const same = (n: { host: string; port: number } | undefined) => !!n && n.host === r.endpoint.host && n.port === r.endpoint.port;
      const known = () => this.#cluster.masters.some(same);
      if (r.kind === 'MOVED' ? !same(this.#cluster.slots[r.slot]?.master) : !known()) await this.#refresh(deadline);
      return known();
    },
  };
  constructor(db: DatabaseConfig, cred: ResolvedCredential, tier: string, log: (m: string) => void, onStuck: () => void, cap: number, budget: CommandBudget, streams: CommandBudget) {
    this.#capped = new CappedPool(db, cred, tier, cap, budget, streams);
    this.#onStuck = onStuck;
    this.label = `${db.id}/${tier}`;
    const seeds = (db.nodes ?? [db.url!]).map((u) => {
      const { host, port } = urlHostPort(u);
      return { socket: socketOpts(db, this.#phase, host, port) };
    });
    this.#client = { ...baseClientOptions(db, cred, tier), socket: socketOpts(db, this.#phase) } as RedisClientOptions;
    this.#cluster = createCluster({
      rootNodes: seeds as never,
      defaults: this.#client as never,
      useReplicas: false,
      minimizeConnections: true,
      RESP: 3,
    });
    this.#cluster.on('error', errListener(this.label, log));
  }
  async connect() {
    await this.#cluster.connect();
    this.#phase.connected = true;
  }
  /** Re-read the slot map through node-redis (deduplicated by node-redis), bounded by the command deadline. */
  async #refresh(deadline: number): Promise<void> {
    const m = this.#cluster.masters[0];
    if (!m) return;
    try {
      await withTimeout((async () => this.#cluster._slots.rediscover(await this.#cluster.nodeClient(m)))(), Math.max(1, deadline - Date.now()), 'rediscover timeout');
    } catch {
      // Keep the current map; the redirect is judged against it.
    }
  }
  send<T>(args: Arg[], o: SendOpts = {}): Promise<T> {
    if (measured(args, o)) {
      const node = o.key === undefined ? this.#cluster.masters[Math.floor(Math.random() * this.#cluster.masters.length)] : this.#cluster.slots[hashSlot(o.key)]?.master;
      if (!node) return Promise.reject(new HttpError('unavailable', 'cluster has no reachable primary'));
      return this.#capped.send(args, node, { ...o, typeMapping: o.typeMapping ?? TM_BIN }, this.#redirects);
    }
    const p = this.#cluster.sendCommand(o.key, o.readonly ?? false, args, { typeMapping: o.typeMapping ?? TM_BIN, ...(o.timeout ? { timeout: o.timeout } : {}) }) as Promise<T>;
    return hardTimeout(p, o.timeout, this.#onStuck);
  }
  async primaries(): Promise<Target[]> {
    const masters = this.#cluster.masters;
    return Promise.all(
      masters.map(async (m) => {
        const client = await this.#cluster.nodeClient(m);
        return {
          label: `${this.label}@${m.host}:${m.port}`,
          send: <T,>(args: Arg[], o: SendOpts = {}) =>
            measured(args, o) ? this.#capped.send<T>(args, m, { ...o, typeMapping: o.typeMapping ?? TM_BIN }, this.#redirects) : hardTimeout(client.sendCommand(args, { typeMapping: o.typeMapping ?? TM_BIN, ...(o.timeout ? { timeout: o.timeout } : {}) }) as Promise<T>, o.timeout, this.#onStuck),
        } satisfies Target;
      }),
    );
  }
  async dedicated(signal?: AbortSignal, stillAllowed?: () => boolean): Promise<DedicatedClient> {
    const m = this.#cluster.masters[0];
    if (!m) throw new HttpError('unavailable', 'cluster has no reachable primary');
    return this.#capped.dedicated(m, signal, stillAllowed);
  }
  /**
   * One batch per primary (keys grouped by the slot map), at most four batches at once, all within one deadline; after
   * a failure no further batch starts. Replies that are MOVED (a stale slot map) make node-redis rediscover the map once;
   * those commands then go out again as one batch per node of the refreshed map (known primaries only). What is still
   * redirected after that (ASK during a migration, a map still in flux) is returned as the error reply.
   */
  async pipeline(commands: PipelineCommand[], o: SendOpts = {}): Promise<unknown[]> {
    const deadline = Date.now() + (o.timeout ?? 5000);
    const opts = { ...o, typeMapping: o.typeMapping ?? TM_BIN };
    const results: unknown[] = new Array(commands.length);
    const pass = async (indexes: number[]) => {
      const groups = new Map<{ host: string; port: number }, number[]>();
      for (const i of indexes) {
        const node = this.#cluster.slots[hashSlot(commands[i]!.key)]?.master;
        if (!node) throw new HttpError('unavailable', 'cluster has no reachable primary');
        const list = groups.get(node);
        if (list) list.push(i);
        else groups.set(node, [i]);
      }
      const queue = [...groups];
      let failed = false;
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
        for (let next = queue.shift(); next && !failed; next = queue.shift()) {
          const [node, group] = next;
          try {
            const replies = await this.#capped.pipeline(group.map((i) => commands[i]!.args), node as Endpoint, { ...opts, timeout: Math.max(1, deadline - Date.now()) });
            group.forEach((i, j) => { results[i] = replies[j]; });
          } catch (e) {
            failed = true;
            throw e;
          }
        }
      }));
    };
    await pass(commands.map((_, i) => i));
    const moved = commands.flatMap((_, i) => (redirect(results[i])?.kind === 'MOVED' ? [i] : []));
    if (moved.length && Date.now() < deadline) {
      await this.#refresh(deadline);
      await pass(moved);
    }
    return results;
  }
  /** On the primary of the key's slot: WATCH and MULTI/EXEC of one key always stay on its node. */
  exclusive<T>(key: Arg, fn: (send: ExclusiveSend) => Promise<T>, o: SendOpts = {}): Promise<T> {
    const node = this.#cluster.slots[hashSlot(key)]?.master;
    if (!node) return Promise.reject(new HttpError('unavailable', 'cluster has no reachable primary'));
    return this.#capped.exclusive(node, { ...o, typeMapping: o.typeMapping ?? TM_BIN }, fn, this.#redirects);
  }
  async close() {
    this.#capped.close();
    await this.#cluster.close().catch(() => this.#cluster.destroy());
  }
  destroy() {
    this.#capped.close();
    this.#cluster.destroy();
  }
}

/** Simple FIFO semaphore. */
class Semaphore {
  #free: number;
  readonly #waiters: (() => void)[] = [];
  constructor(n: number) {
    this.#free = n;
  }
  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((r) => this.#waiters.push(r));
    try {
      return await f();
    } finally {
      const next = this.#waiters.shift();
      if (next) next();
      else this.#free++;
    }
  }
}

class SentinelConn implements Conn {
  readonly #capped: CappedPool;
  readonly #phase: Phase = { connected: false };
  readonly mode = 'sentinel' as const;
  readonly label: string;
  readonly #sentinel;
  readonly #node: RedisClientOptions;
  /**
   * node-redis (5.12) sentinel pools can stall a command that has to wait for a free master client
   * when the burst exceeds masterPoolSize; we never let more than poolSize commands in flight.
   */
  readonly #limit: Semaphore;
  readonly #onStuck: () => void;
  constructor(db: DatabaseConfig, cred: ResolvedCredential, tier: string, log: (m: string) => void, onStuck: () => void, cap: number, budget: CommandBudget, streams: CommandBudget) {
    this.#capped = new CappedPool(db, cred, tier, cap, budget, streams);
    this.#onStuck = onStuck;
    this.label = `${db.id}/${tier}`;
    this.#limit = new Semaphore(db.poolSize);
    this.#node = { ...baseClientOptions(db, cred, tier), database: db.db, socket: socketOpts(db, this.#phase) } as RedisClientOptions;
    const sentinelClient: Record<string, unknown> = { socket: socketOpts(db, this.#phase), RESP: 3 };
    if (db.sentinelCredentials) {
      sentinelClient.username = db.sentinelCredentials.username;
      if (db.sentinelCredentials.password) sentinelClient.password = db.sentinelCredentials.password.reveal();
    }
    this.#sentinel = createSentinel({
      name: db.masterName!,
      sentinelRootNodes: db.sentinels!,
      nodeClientOptions: this.#node as never,
      sentinelClientOptions: sentinelClient as never,
      masterPoolSize: db.poolSize,
      RESP: 3,
    });
    this.#sentinel.on('error', errListener(this.label, log));
  }
  async connect() {
    await this.#sentinel.connect();
    this.#phase.connected = true;
  }
  send<T>(args: Arg[], o: SendOpts = {}): Promise<T> {
    if (measured(args, o)) {
      const node = this.#sentinel.getMasterNode();
      if (!node) return Promise.reject(new HttpError('unavailable', 'sentinel has no known master'));
      return this.#capped.send(args, node, { ...o, typeMapping: o.typeMapping ?? TM_BIN });
    }
    return this.#limit.run(() =>
      hardTimeout(this.#sentinel.sendCommand(false, args, { typeMapping: o.typeMapping ?? TM_BIN, ...(o.timeout ? { timeout: o.timeout } : {}) }) as Promise<T>, o.timeout, this.#onStuck),
    );
  }
  async primaries(): Promise<Target[]> {
    return [this];
  }
  async dedicated(signal?: AbortSignal, stillAllowed?: () => boolean): Promise<DedicatedClient> {
    const m = this.#sentinel.getMasterNode();
    if (!m) throw new HttpError('unavailable', 'sentinel has no known master');
    return this.#capped.dedicated(m, signal, stillAllowed);
  }
  exclusive<T>(_key: Arg, fn: (send: ExclusiveSend) => Promise<T>, o: SendOpts = {}): Promise<T> {
    const m = this.#sentinel.getMasterNode();
    if (!m) return Promise.reject(new HttpError('unavailable', 'sentinel has no known master'));
    return this.#capped.exclusive(m, { ...o, typeMapping: o.typeMapping ?? TM_BIN }, fn);
  }
  pipeline(commands: PipelineCommand[], o: SendOpts = {}): Promise<unknown[]> {
    const m = this.#sentinel.getMasterNode();
    if (!m) return Promise.reject(new HttpError('unavailable', 'sentinel has no known master'));
    return this.#capped.pipeline(commands.map((c) => c.args), m, { ...o, typeMapping: o.typeMapping ?? TM_BIN });
  }
  async close() {
    this.#capped.close();
    await this.#sentinel.close().catch(() => this.#sentinel.destroy());
  }
  destroy() {
    this.#capped.close();
    this.#sentinel.destroy();
  }
}

type AnyConn = StandaloneConn | ClusterConn | SentinelConn;

export interface DbStatus { status: 'connected' | 'connecting' | 'error'; message?: string }

export class RedisManager {
  readonly #dbs: Map<string, DatabaseConfig>;
  readonly #conns = new Map<string, Promise<AnyConn>>();
  readonly #status = new Map<string, DbStatus>();
  readonly #log: (m: string) => void;
  readonly #budget: CommandBudget;
  /** Dedicated pub/sub and MONITOR sockets: their own global budget, so open streams never use command slots. */
  readonly #streams: CommandBudget;
  readonly #cap: number;
  constructor(databases: DatabaseConfig[], log: (m: string) => void, maxReadReplyBytes = 16 * 1024 * 1024, maxInflightCommands = 16, maxStreams = 64) {
    this.#cap = maxReadReplyBytes;
    this.#budget = new CommandBudget(maxInflightCommands);
    this.#streams = new CommandBudget(maxStreams, `Too many live streams are open on this server (limit ${maxStreams}); close one or try again later.`);
    this.#dbs = new Map(databases.map((d) => [d.id, d]));
    this.#log = log;
  }

  database(id: string): DatabaseConfig | undefined {
    return this.#dbs.get(id);
  }

  list(): DatabaseConfig[] {
    return [...this.#dbs.values()];
  }

  /** Connection for the caller's tier. Throws 503 when the tier has no credentials or the server is down. */
  async conn(dbId: string, role: Role): Promise<Conn> {
    const db = this.#dbs.get(dbId);
    if (!db) throw new HttpError('not_found', 'unknown database');
    const tierKey = db.credentials[role] ? role : 'default';
    const cred = credentialForTier(db, role);
    if (!cred) throw new HttpError('unavailable', `no Redis credentials are configured for the ${role} tier of this database`);
    const key = `${dbId}\u0000${tierKey}`;
    let p = this.#conns.get(key);
    if (!p) {
      this.#status.set(key, { status: 'connecting' });
      p = (async () => {
        const onStuck = () => this.#reset(key, p!, c);
        const c: AnyConn =
          db.mode === 'cluster'
            ? new ClusterConn(db, cred, tierKey, this.#log, onStuck, this.#cap, this.#budget, this.#streams)
            : db.mode === 'sentinel'
              ? new SentinelConn(db, cred, tierKey, this.#log, onStuck, this.#cap, this.#budget, this.#streams)
              : new StandaloneConn(db, cred, tierKey, this.#log, onStuck, this.#cap, this.#budget, this.#streams);
        try {
          await withTimeout(c.connect(), 6000, 'connect timeout');
        } catch (e) {
          void c.close().catch(() => {});
          throw e;
        }
        return c;
      })();
      this.#conns.set(key, p);
      p.then(
        () => this.#status.set(key, { status: 'connected' }),
        (e: unknown) => {
          this.#status.set(key, { status: 'error', message: sanitizeRedisError(e) });
          // Allow a retry on the next request.
          if (this.#conns.get(key) === p) this.#conns.delete(key);
        },
      );
    }
    try {
      return await p;
    } catch (e) {
      throw new HttpError('unavailable', `cannot connect to database: ${sanitizeRedisError(e)}`);
    }
  }

  /**
   * A command outlived its timeout and its socket could not be replaced on its own: drop this tier's connections
   * and let the next request connect afresh. Standalone tiers get here only when reopening the stuck socket fails;
   * cluster and sentinel node-redis scalar pools share a pipelined socket per node (node-redis has no
   * per-socket replacement there), so a stuck command resets the tier and commands in flight on it fail once with
   * 503. Only the current Conn for the key is evicted, once. Long-lived users (metrics streams) look the Conn up
   * again instead of keeping it.
   */
  #reset(key: string, p: Promise<AnyConn>, c: AnyConn) {
    if (this.#conns.get(key) !== p) return;
    this.#conns.delete(key);
    this.#status.set(key, { status: 'connecting' });
    this.#log(`redis ${c.label}: a command exceeded its timeout; resetting this tier's connections`);
    try {
      c.destroy();
    } catch {
      // already closed
    }
  }

  status(dbId: string, role: Role): DbStatus {
    const db = this.#dbs.get(dbId);
    if (!db) return { status: 'error', message: 'unknown database' };
    const tierKey = db.credentials[role] ? role : 'default';
    return this.#status.get(`${dbId}\u0000${tierKey}`) ?? { status: 'connecting' };
  }

  async closeAll(): Promise<void> {
    const all = [...this.#conns.values()];
    this.#conns.clear();
    await Promise.allSettled(all.map(async (p) => (await p).close()));
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, rej) => {
      t = setTimeout(() => rej(new Error(msg)), ms);
    }),
  ]);
}

/** Error text safe to show users: no credentials, URLs, hosts or ports. */
export function sanitizeRedisError(e: unknown): string {
  // Clip first: the host-matching regexes below must never see unbounded input.
  const m = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
  const code = (e as { code?: string })?.code ?? /\b(E[A-Z]{3,})\b/.exec(m)?.[1];
  const friendly: Record<string, string> = {
    ECONNREFUSED: 'connection refused',
    ECONNRESET: 'connection reset',
    ETIMEDOUT: 'connection timed out',
    ENOTFOUND: 'host not found',
    EAI_AGAIN: 'host lookup failed',
    EHOSTUNREACH: 'host unreachable',
    ENETUNREACH: 'network unreachable',
  };
  if (code && friendly[code]) return friendly[code];
  // TLS/X.509 failures quote host names and certificate subjects ("Host: x. is not in the cert's altnames: DNS:y"):
  // only the error code is shown. The full text is in the server log.
  if ((code && /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_|ERR_OSSL_)/.test(code)) || /certificate|altnames|\bTLS\b|\bSSL\b/i.test(m)) {
    return `TLS connection failed${code && /^[A-Z0-9_]{1,64}$/.test(code) ? ` (${code})` : ''}`;
  }
  const out = m
    .replace(/rediss?:\/\/\S*/g, '<url>')
    .replace(/\[[0-9a-f:.]+\](:\d+)?/gi, '<host>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<host>')
    .replace(/\b[a-z0-9-]+(\.[a-z0-9-]+)+:\d{2,5}\b/gi, '<host>');
  // Redis error replies keep their text (WRONGTYPE, NOPERM ...; command names like FT.SEARCH look like host
  // names). Socket-level errors lose anything that looks like a DNS name as well.
  return (e instanceof ErrorReply ? out : out.replace(/\b(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*\.?(?=[\s,;:)'"]|$)/gi, '<host>')).slice(0, 300);
}
