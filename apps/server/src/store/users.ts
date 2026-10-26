/** Local user accounts (argon2id passwords, lockout, TOTP state). */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { LocalUser, Role } from '@rconsole/shared';
import type { Db } from './db.ts';
import { storedSeedFormat, TotpKeyring } from '../security/totpCipher.ts';

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  passwordHash: string;
  disabled: boolean;
  mustChangePassword: boolean;
  totpSecret: string | null;
  totpPendingSecret: string | null;
  totpLastStep: number;
  failedCount: number;
  failedWindowStart: number;
  lockedUntil: number;
  createdAt: number;
  lastLoginAt: number | null;
  passwordChangedAt: number;
  /** Bumped on role, disabled, password and TOTP changes; sessions must match it. */
  authGen: number;
}

/** Fields whose change invalidates existing sessions and in-flight sign-ins. */
const AUTH_FIELDS = new Set(['role', 'disabled', 'passwordHash', 'totpSecret']);

interface Row {
  id: string; username: string; display_name: string; role: string; password_hash: string; disabled: number; must_change_password: number;
  totp_secret: string | null; totp_pending_secret: string | null; totp_last_step: number; failed_count: number; failed_window_start: number;
  locked_until: number; created_at: number; last_login_at: number | null; password_changed_at: number; auth_gen: number;
}

const fromRow = (r: Row, seed: (stored: string | null, userId: string) => string | null): UserRecord => ({
  id: r.id, username: r.username, displayName: r.display_name, role: r.role as Role, passwordHash: r.password_hash, disabled: !!r.disabled,
  mustChangePassword: !!r.must_change_password, totpSecret: seed(r.totp_secret, r.id), totpPendingSecret: seed(r.totp_pending_secret, r.id), totpLastStep: r.totp_last_step,
  failedCount: r.failed_count, failedWindowStart: r.failed_window_start, lockedUntil: r.locked_until, createdAt: r.created_at,
  lastLoginAt: r.last_login_at, passwordChangedAt: r.password_changed_at, authGen: r.auth_gen,
});

export function toLocalUser(u: UserRecord): LocalUser {
  const out: LocalUser = {
    id: u.id, username: u.username, displayName: u.displayName, role: u.role, disabled: u.disabled, totpEnabled: !!u.totpSecret,
    createdAt: new Date(u.createdAt).toISOString(),
  };
  if (u.lastLoginAt) out.lastLoginAt = new Date(u.lastLoginAt).toISOString();
  return out;
}

export interface UserStoreOptions {
  /**
   * Encrypts TOTP seeds at rest (F-05). Required whenever local accounts are enabled. Without it (OIDC-only
   * deployments, and the admin CLI's reset and status commands) TOTP seeds cannot be written or read, and stored
   * values are only ever checked for presence.
   */
  totpKeyring?: TotpKeyring;
  now?: () => number;
}

/** Result of the startup re-wrap: how many stored values changed (never which seeds). */
export interface SeedMigration {
  /** Legacy clear-text values encrypted. */
  encrypted: number;
  /** Encrypted values (v1, or v2 under another key) re-encrypted under the primary key. */
  rewrapped: number;
  /** Users with a TOTP or pending seed. */
  users: number;
}

/** Stored TOTP seeds that no key of the ring decrypts. The server refuses to start; nothing was changed. */
export class TotpKeyError extends Error {
  override name = 'TotpKeyError';
  readonly affectedUsers: number;
  readonly missingKeyIds: string[];
  constructor(affectedUsers: number, missingKeyIds: string[]) {
    const missing = missingKeyIds.length ? ` (their seeds name key id(s) that are not in the ring: ${missingKeyIds.join(', ')})` : '';
    // Counts and key ids only: never user names, seeds or ciphertext (this goes to stderr and container logs).
    super(
      `${affectedUsers} local user(s) have a stored TOTP seed that no key of the TOTP key ring can decrypt${missing}. Nothing was changed.\n` +
        'Either put the missing key back into auth.local.totpEncryptionKeys (or restore the previous auth.local.totpEncryptionKey) and start again,\n' +
        'or reset those users\' TOTP on the server host (they enroll again at their next sign-in):\n' +
        '  node apps/server/src/cli/admin.ts status                      lists them\n' +
        '  node apps/server/src/cli/admin.ts reset-totp --user <name>    or: reset-totp --all --yes\n' +
        'Run these in the server\'s working directory with its environment (container: the same image, volume and environment);\n' +
        'in a source checkout `pnpm --filter @rconsole/server admin status` and `pnpm --filter @rconsole/server admin reset-totp --user <name>` work too.\n' +
        'See docs/OPERATIONS.md, "6a. TOTP keys and recovery".',
    );
    this.affectedUsers = affectedUsers;
    this.missingKeyIds = missingKeyIds;
  }
}

/** One local user's second-factor state as stored, read without any key (admin CLI `status`). */
export interface TotpInventoryRow {
  id: string;
  username: string;
  /** Format of the stored seed: `v2:<key id>`, `v1`, `plain`, `malformed`, or null without TOTP. */
  seed: string | null;
  pending: string | null;
  recoveryRemaining: number;
  recoveryUsed: number;
}

const describeSeed = (stored: string | null): string | null => {
  if (stored === null) return null;
  const f = storedSeedFormat(stored);
  return f.format === 'v2' ? `v2:${f.keyId}` : f.format;
};

export class UserStore {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #ring: TotpKeyring | undefined;
  constructor(db: Db, opts: UserStoreOptions = {}) {
    this.#db = db;
    this.#now = opts.now ?? Date.now;
    this.#ring = opts.totpKeyring;
  }

  /** Decrypt a stored seed. Fails closed: a value that does not decrypt (unknown key, tampering, other user) throws. */
  readonly #readSeed = (stored: string | null, userId: string): string | null => {
    if (stored === null || !this.#ring) return stored;
    // Legacy clear-text rows are encrypted by migrateTotpSeeds() at startup; never trust one afterwards.
    if (!TotpKeyring.isEncrypted(stored)) throw new Error('clear-text TOTP seed found; run migrateTotpSeeds()');
    return this.#ring.decrypt(stored, userId);
  };

  #writeSeed(plain: string | null, userId: string): string | null {
    if (plain === null) return null;
    if (!this.#ring) throw new Error('cannot store a TOTP seed without auth.local.totpEncryptionKey(s)');
    return this.#ring.encrypt(plain, userId);
  }

  /** Run `fn` atomically (a savepoint, so it nests). */
  transaction<T>(fn: () => T): T {
    this.#db.exec('SAVEPOINT users_tx');
    try {
      const out = fn();
      this.#db.exec('RELEASE users_tx');
      return out;
    } catch (e) {
      this.#db.exec('ROLLBACK TO users_tx');
      this.#db.exec('RELEASE users_tx');
      throw e;
    }
  }

  /**
   * Startup migration (and `admin rotate-totp-key`): bring every stored seed to format v2 under the primary key.
   * Legacy clear-text values are encrypted; v1 values and v2 values under another key of the ring are re-wrapped.
   * All or nothing: when any value cannot be decrypted with any key of the ring (a key was removed while still in
   * use, or the key changed), it throws a TotpKeyError naming the number of affected users and changes nothing, so
   * the server never starts with unusable second factors. Re-wrapping does not change the auth generation (nobody is
   * signed out).
   */
  migrateTotpSeeds(): SeedMigration {
    const ring = this.#ring;
    const out: SeedMigration = { encrypted: 0, rewrapped: 0, users: 0 };
    if (!ring) return out;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.#db
        .prepare('SELECT id, totp_secret, totp_pending_secret FROM users WHERE totp_secret IS NOT NULL OR totp_pending_secret IS NOT NULL')
        .all() as { id: string; totp_secret: string | null; totp_pending_secret: string | null }[];
      out.users = rows.length;
      const affected = new Set<string>();
      const missing = new Set<string>();
      const updates: [string | null, string | null, string][] = [];
      for (const r of rows) {
        const fix = (v: string | null): string | null => {
          if (v === null) return null;
          const format = storedSeedFormat(v).format;
          if (format === 'plain') {
            out.encrypted++;
            return ring.encrypt(v, r.id);
          }
          if (format === 'malformed') {
            // Corrupted or crafted: never encrypt it as if it were a seed (it could be a value someone chose).
            affected.add(r.id);
            return v;
          }
          if (!ring.needsRewrap(v)) {
            // Under the primary already; still prove it decrypts (tampering, another user's row).
            try {
              ring.decrypt(v, r.id);
            } catch {
              affected.add(r.id);
            }
            return v;
          }
          try {
            const plain = ring.decrypt(v, r.id);
            out.rewrapped++;
            return ring.encrypt(plain, r.id);
          } catch {
            affected.add(r.id);
            const f = storedSeedFormat(v);
            if (f.format === 'v2' && !ring.keyIds.includes(f.keyId)) missing.add(f.keyId);
            return v;
          }
        };
        const secret = fix(r.totp_secret);
        const pending = fix(r.totp_pending_secret);
        if (secret !== r.totp_secret || pending !== r.totp_pending_secret) updates.push([secret, pending, r.id]);
      }
      if (affected.size) throw new TotpKeyError(affected.size, [...missing].sort());
      const upd = this.#db.prepare('UPDATE users SET totp_secret = ?, totp_pending_secret = ? WHERE id = ?');
      for (const u of updates) upd.run(...u);
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
    return out;
  }

  /** Every local user's stored second-factor state, read without any key. Never returns seeds or code hashes. */
  totpInventory(): TotpInventoryRow[] {
    const rows = this.#db
      .prepare(
        `SELECT u.id, u.username, u.totp_secret, u.totp_pending_secret,
                (SELECT COUNT(*) FROM recovery_codes r WHERE r.user_id = u.id AND r.used_at IS NULL) AS remaining,
                (SELECT COUNT(*) FROM recovery_codes r WHERE r.user_id = u.id AND r.used_at IS NOT NULL) AS used
         FROM users u ORDER BY u.username`,
      )
      .all() as { id: string; username: string; totp_secret: string | null; totp_pending_secret: string | null; remaining: number; used: number }[];
    return rows.map((r) => ({
      id: r.id, username: r.username, seed: describeSeed(r.totp_secret), pending: describeSeed(r.totp_pending_secret),
      recoveryRemaining: r.remaining, recoveryUsed: r.used,
    }));
  }

  /**
   * Turn TOTP off for a user (admin reset, admin CLI): clears the seed, the pending enrollment, the replay counter (it
   * belonged to the removed seed; review v0.3 TOTP L2) and every recovery code, and bumps the auth generation so
   * existing sessions and in-flight sign-ins stop working. Returns false when the user does not exist.
   */
  resetTotp(id: string): boolean {
    return this.transaction(() => {
      const r = this.#db.prepare('UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_last_step = 0, auth_gen = auth_gen + 1 WHERE id = ?').run(id);
      this.#db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(id);
      return Number(r.changes) === 1;
    });
  }

  // ---------------------------------------------------------------------------
  // Recovery codes (hashes only; see security/recoveryCodes.ts)

  /** Replace the user's recovery code set (the old codes stop working). */
  replaceRecoveryCodes(id: string, set: { salt: string; hashes: string[] }): void {
    this.transaction(() => {
      this.#db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(id);
      const ins = this.#db.prepare('INSERT INTO recovery_codes (user_id, code_hash, salt, created_at) VALUES (?, ?, ?, ?)');
      const now = this.#now();
      for (const h of set.hashes) ins.run(id, h, set.salt, now);
    });
  }

  /** Salt of the user's current set (shared by all its codes), or null when the user has no unused code. */
  recoveryCodeSalt(id: string): string | null {
    const r = this.#db.prepare('SELECT salt FROM recovery_codes WHERE user_id = ? AND used_at IS NULL LIMIT 1').get(id) as { salt: string } | undefined;
    return r?.salt ?? null;
  }

  /**
   * Mark the unused code with this hash as used; false when it is not an unused code of this user (wrong, used,
   * replaced). The hash is compared in constant time against every unused hash of the user (one set, at most 10), not
   * by an SQL equality; the conditional UPDATE then makes the use single, so two concurrent requests with the same
   * code cannot both succeed. Synchronous from the SELECT to the UPDATE.
   */
  consumeRecoveryCode(id: string, hash: string): boolean {
    const want = Buffer.from(hash, 'utf8');
    const rows = this.#db.prepare('SELECT code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').all(id) as { code_hash: string }[];
    let match: string | null = null;
    for (const r of rows) {
      const have = Buffer.from(r.code_hash, 'utf8');
      // Every candidate is compared (no early exit); the length is public (one format for all hashes).
      if (have.length === want.length && timingSafeEqual(have, want)) match ??= r.code_hash;
    }
    if (match === null) return false;
    const r = this.#db.prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').run(this.#now(), id, match);
    return Number(r.changes) === 1;
  }

  recoveryCodesRemaining(id: string): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(id) as { n: number }).n;
  }

  count(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  byUsername(username: string): UserRecord | null {
    const r = this.#db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Row | undefined;
    return r ? fromRow(r, this.#readSeed) : null;
  }

  byId(id: string): UserRecord | null {
    const r = this.#db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return r ? fromRow(r, this.#readSeed) : null;
  }

  list(): UserRecord[] {
    return (this.#db.prepare('SELECT * FROM users ORDER BY username').all() as unknown as Row[]).map((r) => fromRow(r, this.#readSeed));
  }

  create(u: { username: string; displayName: string; role: Role; passwordHash: string; mustChangePassword: boolean }): UserRecord {
    const now = this.#now();
    const id = `local:${randomUUID()}`;
    this.#db
      .prepare(`INSERT INTO users (id,username,display_name,role,password_hash,must_change_password,created_at,password_changed_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, u.username, u.displayName, u.role, u.passwordHash, u.mustChangePassword ? 1 : 0, now, now);
    return this.byId(id)!;
  }

  update(id: string, f: Partial<Pick<UserRecord, 'displayName' | 'role' | 'disabled' | 'mustChangePassword' | 'passwordHash' | 'totpSecret' | 'totpPendingSecret' | 'totpLastStep' | 'lastLoginAt'>>): void {
    const map: Record<string, string> = {
      displayName: 'display_name', role: 'role', disabled: 'disabled', mustChangePassword: 'must_change_password', passwordHash: 'password_hash',
      totpSecret: 'totp_secret', totpPendingSecret: 'totp_pending_secret', totpLastStep: 'totp_last_step', lastLoginAt: 'last_login_at',
    };
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined) continue;
      sets.push(`${map[k]} = ?`);
      if (k === 'totpSecret' || k === 'totpPendingSecret') vals.push(this.#writeSeed(v as string | null, id));
      else vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number | null));
    }
    if ('passwordHash' in f && f.passwordHash) {
      sets.push('password_changed_at = ?');
      vals.push(this.#now());
    }
    if (Object.entries(f).some(([k, v]) => v !== undefined && AUTH_FIELDS.has(k))) sets.push('auth_gen = auth_gen + 1');
    if (!sets.length) return;
    this.#db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  }

  /** Current authentication generation (fresh from storage), or null when the user is gone. */
  authGen(id: string): number | null {
    const r = this.#db.prepare('SELECT auth_gen FROM users WHERE id = ?').get(id) as { auth_gen: number } | undefined;
    return r ? r.auth_gen : null;
  }

  isLocked(u: UserRecord): boolean {
    return u.lockedUntil > this.#now();
  }

  /**
   * Record a failed attempt within the lockout window; locks the account at maxAttempts. Atomic in SQL
   * (not read-modify-write from `u`), so concurrent guesses cannot all see the same old count.
   */
  recordFailure(u: Pick<UserRecord, 'id'>, maxAttempts: number, windowMs: number): { locked: boolean } {
    const now = this.#now();
    const r = this.#db
      .prepare(
        `UPDATE users SET
           failed_count = CASE WHEN ? - failed_window_start > ? THEN 1 ELSE failed_count + 1 END,
           failed_window_start = CASE WHEN ? - failed_window_start > ? THEN ? ELSE failed_window_start END
         WHERE id = ? RETURNING failed_count`,
      )
      .get(now, windowMs, now, windowMs, now, u.id) as { failed_count: number } | undefined;
    const count = r?.failed_count ?? 0;
    if (count >= maxAttempts) {
      this.#db.prepare('UPDATE users SET locked_until = MAX(locked_until, ?) WHERE id = ?').run(now + windowMs, u.id);
      return { locked: true };
    }
    return { locked: false };
  }

  /** Fresh lock check from storage (another request may have locked the account meanwhile). */
  isLockedNow(id: string): boolean {
    const r = this.#db.prepare('SELECT locked_until FROM users WHERE id = ?').get(id) as { locked_until: number } | undefined;
    return !!r && r.locked_until > this.#now();
  }

  resetFailures(id: string): void {
    this.#db.prepare('UPDATE users SET failed_count = 0, failed_window_start = 0, locked_until = 0 WHERE id = ?').run(id);
  }

  /** Atomically record a used TOTP step; false if the step was already used (replay). */
  consumeTotpStep(id: string, step: number): boolean {
    const r = this.#db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?').run(step, id, step);
    return Number(r.changes) === 1;
  }
}
