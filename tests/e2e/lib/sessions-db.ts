/**
 * Direct access to the server's SQLite session table — used only to simulate the passage of
 * time for idle/absolute session expiry (we cannot wait 60 minutes in a test).
 */
import { createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './env.ts';

export function findDbFile(dir = DATA_DIR): string {
  const files = readdirSync(dir).map((f) => path.join(dir, f));
  for (const f of files) {
    if (statSync(f).isFile() && /\.(sqlite3?|db)$/.test(f)) {
      const db = new DatabaseSync(f);
      try {
        const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
        if (t) return f;
      } finally {
        db.close();
      }
    }
  }
  for (const f of files) if (statSync(f).isDirectory()) { try { return findDbFile(f); } catch { /* keep looking */ } }
  throw new Error(`no SQLite file with a sessions table under ${dir}`);
}

export function ageSession(rawCookieValue: string, change: { idleMs?: number; expire?: boolean }): number {
  const db = new DatabaseSync(findDbFile());
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const idHash = createHash('sha256').update(rawCookieValue).digest('hex');
    let n = 0;
    if (change.idleMs) n += Number(db.prepare('UPDATE sessions SET last_seen_at = last_seen_at - ? WHERE id_hash = ?').run(change.idleMs, idHash).changes);
    if (change.expire) n += Number(db.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?').run(Date.now() - 1000, idHash).changes);
    return n;
  } finally {
    db.close();
  }
}
