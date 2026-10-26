import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    totp_secret TEXT,
    totp_pending_secret TEXT,
    totp_last_step INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    failed_window_start INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    password_changed_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    source TEXT NOT NULL,
    role TEXT NOT NULL,
    csrf_token TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT NOT NULL,
    id_token TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expires ON sessions(expires_at);
  CREATE TABLE oidc_flows (
    state_hash TEXT PRIMARY KEY,
    binding_hash TEXT NOT NULL,
    nonce TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    ip TEXT NOT NULL,
    action TEXT NOT NULL,
    database_id TEXT,
    command TEXT,
    argv_redacted TEXT,
    key_count INTEGER,
    outcome TEXT NOT NULL,
    reason TEXT,
    detail TEXT
  );
  CREATE INDEX audit_user ON audit(username);
  CREATE INDEX audit_db ON audit(database_id);
  CREATE INDEX audit_action ON audit(action);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  `,
  // Authentication generation: bumped on every role/disabled/password/TOTP change. A session carries the
  // generation it was issued under; the request gate refuses sessions whose user has moved on (review H1).
  `
  ALTER TABLE users ADD COLUMN auth_gen INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN auth_gen INTEGER NOT NULL DEFAULT 0;
  `,
  // TOTP recovery codes: argon2id hashes only (all codes of a set share one salt), single use (used_at).
  `
  CREATE TABLE recovery_codes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER,
    PRIMARY KEY (user_id, code_hash)
  );
  `,
  // Audit retention (v0.3 follow-up 3). The table stays append-only; the one exception is the retention job, and it is
  // scoped in the trigger itself: a DELETE passes only for a row older than the cutoff of an audit_prune_grant row,
  // which the job inserts and removes inside its own transaction (no other connection ever sees it), and never for a
  // row younger than 30 days, whatever a grant says. UPDATE stays refused. The index serves the oldest-first batches.
  `
  CREATE INDEX audit_at ON audit(at);
  CREATE TABLE audit_prune_grant (cutoff TEXT NOT NULL);
  DROP TRIGGER audit_no_delete;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
    WHEN NOT EXISTS (SELECT 1 FROM audit_prune_grant g WHERE OLD.at < g.cutoff)
      OR OLD.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
    BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  `,
];

export type Db = DatabaseSync;

/** Open (or create) the SQLite database. Pass ':memory:' for tests. */
export function openDb(dataDir: string | ':memory:'): Db {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    file = path.join(dataDir, 'rconsole.sqlite');
  }
  const db = new DatabaseSync(file);
  if (file !== ':memory:') {
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
  const row = db.prepare('SELECT v FROM schema_version').get() as { v: number } | undefined;
  let v = row?.v ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      v++;
      db.prepare('UPDATE schema_version SET v = ?').run(v);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}
