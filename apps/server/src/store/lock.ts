/**
 * Exclusive ownership of a data directory: `<dataDir>/server.lock` (review v0.3 TOTP M1).
 *
 * A server takes the lock before it opens the database (so before schema migrations and the TOTP seed re-wrap) and
 * holds it until it shuts down; `admin rotate-totp-key` holds it while it re-wraps seeds. The lock is created
 * exclusively (`O_CREAT | O_EXCL`, Node's `wx` flag) with the owner's pid, host, start time, boot id and a random
 * nonce, so a second process can never overwrite it: it either finds a live owner and refuses, or proves the lock
 * stale and takes it over under a separate takeover lock. Only the owner (same nonce) removes it.
 *
 * Stale means:
 * - on this host: the process is gone, the host has rebooted since (boot id), the lock names the process that is
 *   now trying to take it (a restarted container, where the server is pid 1 again), or the process exists but has not
 *   refreshed the lock for LEASE_STALE_MS (its pid was reused by something else);
 * - written on another host (a shared volume), which cannot be checked: not refreshed for LEASE_STALE_MS.
 * The owner refreshes the lock's modification time every LEASE_REFRESH_MS.
 *
 * SQLite (WAL, busy timeout) still serializes writers, so `admin status` and `admin reset-totp` stay safe next to a
 * running server and only read the lock (serverState).
 */
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

export const LOCK_FILE = 'server.lock';
const TAKEOVER_FILE = 'server.lock.takeover';
/** How often the owner refreshes the lock's modification time. */
export const LEASE_REFRESH_MS = 15_000;
/** A lock not refreshed for this long has no live owner (another host, or a reused pid on this host). */
export const LEASE_STALE_MS = 120_000;

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  /** Random per acquisition; release and refresh only touch a lock that still carries it. */
  nonce?: string;
  /** Linux boot id when the lock was taken (a lock from before a reboot is stale). */
  bootId?: string;
  /** `server` or the admin command holding the lock. */
  owner?: string;
}

export type ServerState =
  | { running: false }
  | { running: true; info: LockInfo; certain: boolean; unreadable?: boolean };

/** Thrown when the data directory has a live owner. `state` says who. */
export class DataDirLockedError extends Error {
  readonly state: Extract<ServerState, { running: true }>;
  constructor(state: Extract<ServerState, { running: true }>, message: string) {
    super(message);
    this.name = 'DataDirLockedError';
    this.state = state;
  }
}

export interface LockOptions {
  /** Who holds it (shown to whoever is refused). */
  owner: string;
  /** Take over a lock that cannot be checked (another host, unreadable). Never a lock with a live owner on this host. */
  force?: boolean;
  /** Tests: the current boot id (default: Linux's /proc/sys/kernel/random/boot_id, none elsewhere). */
  bootId?: string | null;
  /** Tests: called when the owner finds its lock replaced or removed. */
  onLost?: (message: string) => void;
  /**
   * How long to watch a lock whose process exists but whose lease is old before taking it over (default: one refresh
   * period and a margin). A live owner that was suspended refreshes it within that time; a reused pid does not.
   */
  observeMs?: number;
}

export interface DataDirLock {
  readonly file: string;
  readonly info: LockInfo;
  /** Remove the lock if it is still ours; idempotent. */
  release(): void;
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function currentBootId(): string | undefined {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

type Read = { kind: 'missing' } | { kind: 'unreadable'; raw: string } | { kind: 'ok'; raw: string; info: LockInfo; mtimeMs: number };

/** Read the lock. An exclusive create and its single write are not atomic together, so a just-created empty lock is re-read briefly. */
function readLock(file: string): Read {
  for (let attempt = 0; ; attempt++) {
    let raw: string;
    let mtimeMs: number;
    try {
      raw = readFileSync(file, 'utf8');
      mtimeMs = statSync(file).mtimeMs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      throw e;
    }
    try {
      const info = JSON.parse(raw) as LockInfo;
      if (info && typeof info.pid === 'number' && Number.isInteger(info.pid) && typeof info.host === 'string') return { kind: 'ok', raw, info, mtimeMs };
    } catch {
      /* fall through */
    }
    if (attempt >= 10 || Date.now() - mtimeMs > 2000) return { kind: 'unreadable', raw };
    sleep(50);
  }
}

/** `quiet`: the process exists but the lease is old, which is a reused pid, or an owner that was asleep (a laptop). */
type Verdict = { live: true; certain: boolean } | { live: false; why: string; quiet?: boolean };

function judge(info: LockInfo, mtimeMs: number, self: boolean, bootId: string | undefined): Verdict {
  const age = Date.now() - mtimeMs;
  const leaseOver = age > LEASE_STALE_MS;
  if (info.host !== hostname()) {
    return leaseOver ? { live: false, why: `written on host ${info.host} and not refreshed for ${Math.round(age / 1000)} s` } : { live: true, certain: false };
  }
  if (self && info.pid === process.pid) return { live: false, why: 'it names this process (a restarted container)' };
  if (bootId && info.bootId && info.bootId !== bootId) return { live: false, why: 'written before this host restarted' };
  try {
    process.kill(info.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return { live: false, why: `process ${info.pid} is gone` };
  }
  if (leaseOver) return { live: false, quiet: true, why: `process ${info.pid} has not refreshed it for ${Math.round(age / 1000)} s (its pid was reused)` };
  return { live: true, certain: true };
}

/** Whether something holds the data directory (read-only; the admin CLI's status and reset use it). */
export function serverState(dataDir: string, bootId: string | null = currentBootId() ?? null): ServerState {
  const r = readLock(path.join(dataDir, LOCK_FILE));
  if (r.kind === 'missing') return { running: false };
  if (r.kind === 'unreadable') return { running: true, info: { pid: -1, host: 'unknown', startedAt: 'unknown' }, certain: false, unreadable: true };
  const v = judge(r.info, r.mtimeMs, false, bootId ?? undefined);
  return v.live ? { running: true, info: r.info, certain: v.certain } : { running: false };
}

/** One line naming the holder of a lock, for refusals. */
export function describeHolder(s: Extract<ServerState, { running: true }>): string {
  if (s.unreadable) return 'server.lock exists but cannot be read';
  const who = s.info.owner && s.info.owner !== 'server' ? `\`${s.info.owner}\`` : 'a server';
  return s.certain
    ? `${who} is running on it (pid ${s.info.pid}, started ${s.info.startedAt})`
    : `server.lock names pid ${s.info.pid} on host ${s.info.host}, which cannot be checked from here`;
}

// Locks this process owns, released on process.exit() too (a failed listen exits without closing the app).
const owned = new Set<DataDirLock>();
let exitHook = false;

function create(file: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, `${JSON.stringify(info)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Remove `file` only if it still holds `raw` (the stale lock that was judged), under the takeover lock. */
function removeIfUnchanged(dataDir: string, file: string, raw: string): void {
  const guard = path.join(dataDir, TAKEOVER_FILE);
  for (let attempt = 0; attempt < 100; attempt++) {
    let fd: number;
    try {
      fd = openSync(guard, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        // A takeover never takes more than a moment; an old guard was left by a process that died during one.
        if (Date.now() - statSync(guard).mtimeMs > 10_000) rmSync(guard, { force: true });
      } catch {
        /* gone meanwhile */
      }
      sleep(50);
      continue;
    }
    closeSync(fd);
    try {
      let now: string | undefined;
      try {
        now = readFileSync(file, 'utf8');
      } catch {
        now = undefined;
      }
      if (now === raw) rmSync(file, { force: true });
    } finally {
      rmSync(guard, { force: true });
    }
    return;
  }
  throw new Error(`could not take over ${file}: ${TAKEOVER_FILE} stays busy`);
}

/**
 * Take the data directory's lock or throw DataDirLockedError naming the live owner. The directory must exist.
 * The returned lock refreshes itself and is released by `release()`, on process exit, or never if it was replaced.
 */
export function acquireDataDirLock(dataDir: string, opts: LockOptions): DataDirLock {
  const file = path.join(dataDir, LOCK_FILE);
  const bootId = opts.bootId === undefined ? currentBootId() : opts.bootId ?? undefined;
  const info: LockInfo = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), nonce: randomUUID(), owner: opts.owner, ...(bootId ? { bootId } : {}) };
  for (let attempt = 0; attempt < 20; attempt++) {
    if (create(file, info)) return own(file, info, opts.onLost);
    const cur = readLock(file);
    if (cur.kind === 'missing') continue;
    if (cur.kind === 'unreadable') {
      const state = { running: true as const, info: { pid: -1, host: 'unknown', startedAt: 'unknown' }, certain: false, unreadable: true };
      if (!opts.force) throw new DataDirLockedError(state, `${file} exists but cannot be read. If no server uses ${dataDir}, delete it and start again.`);
      removeIfUnchanged(dataDir, file, cur.raw);
      continue;
    }
    let v = judge(cur.info, cur.mtimeMs, true, bootId);
    if (!v.live && v.quiet) {
      sleep(opts.observeMs ?? LEASE_REFRESH_MS + 2000);
      const later = readLock(file);
      if (later.kind === 'ok' && (later.raw !== cur.raw || later.mtimeMs !== cur.mtimeMs)) {
        if (later.raw !== cur.raw) continue; // replaced meanwhile: judge the new lock
        v = { live: true, certain: true }; // refreshed: the owner is alive (it was asleep)
      }
    }
    if (v.live && (v.certain || !opts.force)) {
      const state = { running: true as const, info: cur.info, certain: v.certain };
      throw new DataDirLockedError(
        state,
        v.certain
          ? `${describeHolder(state)}: ${dataDir} is in use. Stop it first, or use another data directory.`
          : `${describeHolder(state)}; it was refreshed ${Math.round((Date.now() - cur.mtimeMs) / 1000)} s ago, so that server may still use ${dataDir}. ` +
            `Stop it first. A lock that is not refreshed for ${LEASE_STALE_MS / 1000} s is taken over automatically.`,
      );
    }
    removeIfUnchanged(dataDir, file, cur.raw);
  }
  throw new Error(`could not take ${file}: it keeps changing`);
}

function own(file: string, info: LockInfo, onLost?: (message: string) => void): DataDirLock {
  const ours = () => {
    try {
      return (JSON.parse(readFileSync(file, 'utf8')) as LockInfo).nonce === info.nonce;
    } catch {
      return false;
    }
  };
  let lost = false;
  const timer = setInterval(() => {
    if (ours()) {
      try {
        const now = new Date();
        utimesSync(file, now, now);
      } catch {
        /* next time */
      }
    } else if (!lost) {
      lost = true;
      onLost?.(`${file} no longer names this process; another process may use the data directory`);
    }
  }, LEASE_REFRESH_MS);
  timer.unref();
  const lock: DataDirLock = {
    file,
    info,
    release() {
      clearInterval(timer);
      if (!owned.delete(lock)) return;
      if (ours()) rmSync(file, { force: true });
    },
  };
  owned.add(lock);
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => {
      for (const l of [...owned]) l.release();
    });
  }
  return lock;
}
