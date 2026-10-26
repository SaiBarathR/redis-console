/**
 * Server-side sessions. The browser only holds a 256-bit random ID; only its SHA-256 is stored.
 * Sessions expire on idle timeout and on an absolute lifetime, and are rotated on login and on
 * privilege change.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '@rconsole/shared';
import type { Db } from './db.ts';

export type SessionState = 'active' | 'totp_pending';

export interface Session {
  idHash: string;
  userId: string;
  username: string;
  displayName: string;
  source: 'oidc' | 'local';
  role: Role;
  csrfToken: string;
  state: SessionState;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string;
  idToken?: string;
  /** Local accounts: the user's auth generation when the session was issued (0 for OIDC). */
  authGen?: number;
}

export interface SessionOptions {
  ttlMs: number;
  idleMs: number;
  /** Lifetime of a half-authenticated (password ok, TOTP pending) session. */
  pendingMs?: number;
  now?: () => number;
}

export const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

interface Row {
  id_hash: string; user_id: string; username: string; display_name: string; source: string; role: string; csrf_token: string;
  state: string; created_at: number; last_seen_at: number; expires_at: number; ip: string; id_token: string | null; auth_gen: number;
}

function fromRow(r: Row): Session {
  const s: Session = {
    idHash: r.id_hash, userId: r.user_id, username: r.username, displayName: r.display_name, source: r.source as Session['source'],
    role: r.role as Role, csrfToken: r.csrf_token, state: r.state as SessionState, createdAt: r.created_at, lastSeenAt: r.last_seen_at,
    expiresAt: r.expires_at, ip: r.ip, authGen: r.auth_gen,
  };
  if (r.id_token) s.idToken = r.id_token;
  return s;
}

export class SessionRevokedError extends Error {
  constructor() {
    super('session no longer exists');
  }
}

export class SessionStore {
  readonly #db: Db;
  readonly #o: Required<SessionOptions>;
  constructor(db: Db, o: SessionOptions) {
    this.#db = db;
    this.#o = { pendingMs: 5 * 60_000, now: Date.now, ...o };
  }

  get ttlMs() { return this.#o.ttlMs; }
  get idleMs() { return this.#o.idleMs; }

  /** `ttlMs` shortens (never extends) the absolute lifetime of this session, e.g. for OIDC sessions. */
  create(data: Omit<Session, 'idHash' | 'csrfToken' | 'createdAt' | 'lastSeenAt' | 'expiresAt'>, o: { ttlMs?: number | undefined } = {}): { id: string; session: Session } {
    const id = randomToken(32);
    const now = this.#o.now();
    const session: Session = {
      ...data,
      idHash: hashToken(id),
      csrfToken: randomToken(32),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + (data.state === 'active' ? Math.min(this.#o.ttlMs, o.ttlMs ?? Infinity) : this.#o.pendingMs),
    };
    this.#insert(session);
    return { id, session };
  }

  /** Look up a live session by raw cookie value. Expired sessions are deleted and return null. */
  get(rawId: string | undefined): Session | null {
    if (!rawId || rawId.length < 32 || rawId.length > 128) return null;
    const idHash = hashToken(rawId);
    const row = this.#db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash) as Row | undefined;
    if (!row) return null;
    const s = fromRow(row);
    const now = this.#o.now();
    if (now >= s.expiresAt || (s.state === 'active' && now - s.lastSeenAt >= this.#o.idleMs)) {
      this.#db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
      return null;
    }
    return s;
  }

  /** Record activity (sliding idle window). Writes at most every 15 s per session. */
  touch(s: Session): void {
    const now = this.#o.now();
    if (now - s.lastSeenAt < 15_000) return;
    s.lastSeenAt = now;
    this.#db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, s.idHash);
  }

  /** When the session will end if the user stays idle (min of idle and absolute expiry). */
  effectiveExpiry(s: Session): number {
    return s.state === 'active' ? Math.min(s.expiresAt, s.lastSeenAt + this.#o.idleMs) : s.expiresAt;
  }

  /**
   * Replace the session ID (and CSRF token) — used on login, TOTP completion, password change and
   * privilege change. Optionally changes fields. The absolute lifetime restarts only when a
   * pending session becomes active.
   */
  #insert(s: Session) {
    this.#db
      .prepare(`INSERT INTO sessions (id_hash,user_id,username,display_name,source,role,csrf_token,state,created_at,last_seen_at,expires_at,ip,id_token,auth_gen)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(s.idHash, s.userId, s.username, s.displayName, s.source, s.role, s.csrfToken, s.state, s.createdAt, s.lastSeenAt, s.expiresAt, s.ip,
        s.idToken ?? null, s.authGen ?? 0);
  }

  /**
   * Replace a session (new ID and CSRF token). Throws SessionRevokedError, and creates nothing, when the old
   * session no longer exists (an admin revoked it while this request was in flight): rotation must never bring
   * a revoked session back.
   */
  rotate(s: Session, changes: Partial<Pick<Session, 'state' | 'role' | 'displayName' | 'idToken' | 'authGen'>> = {}): { id: string; session: Session } {
    const id = randomToken(32);
    const now = this.#o.now();
    const becameActive = s.state !== 'active' && changes.state === 'active';
    const next: Session = {
      ...s,
      ...changes,
      idHash: hashToken(id),
      csrfToken: randomToken(32),
      lastSeenAt: now,
      createdAt: becameActive ? now : s.createdAt,
      expiresAt: becameActive ? now + this.#o.ttlMs : s.expiresAt,
    };
    this.#db.exec('BEGIN');
    try {
      const del = this.#db.prepare('DELETE FROM sessions WHERE id_hash = ? AND expires_at > ?').run(s.idHash, now);
      if (Number(del.changes) !== 1) throw new SessionRevokedError();
      this.#insert(next);
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
    return { id, session: next };
  }

  /** Move a kept session to its user's new auth generation (an admin changing their own credentials). */
  setAuthGen(idHash: string, gen: number): void {
    this.#db.prepare('UPDATE sessions SET auth_gen = ? WHERE id_hash = ?').run(gen, idHash);
  }

  /** Whether a session (by hash) still exists and is not expired. Used by long-lived streams. */
  alive(idHash: string): boolean {
    const row = this.#db.prepare('SELECT expires_at, last_seen_at, state FROM sessions WHERE id_hash = ?').get(idHash) as
      | { expires_at: number; last_seen_at: number; state: string }
      | undefined;
    if (!row) return false;
    const now = this.#o.now();
    return now < row.expires_at && !(row.state === 'active' && now - row.last_seen_at >= this.#o.idleMs);
  }

  destroy(s: Pick<Session, 'idHash'>): void {
    this.#db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(s.idHash);
  }

  /** Revoke every session of a user (role change, disable, password reset). Optionally keep one. */
  destroyUser(userId: string, exceptIdHash?: string): number {
    const r = this.#db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(userId, exceptIdHash ?? '');
    return Number(r.changes);
  }

  purgeExpired(): number {
    const now = this.#o.now();
    const r = this.#db
      .prepare("DELETE FROM sessions WHERE expires_at <= ? OR (state = 'active' AND last_seen_at <= ?)")
      .run(now, now - this.#o.idleMs);
    return Number(r.changes);
  }
}
