/**
 * Audit log: append-only SQLite table (UPDATE/DELETE are rejected by triggers; retention pruning is the one scoped
 * exception, store/auditRetention.ts) + JSON lines on stdout
 * (`"audit": true`) for SIEM ingestion. Never contains values, passwords, tokens or session IDs:
 * argv is redacted to command name (+ subcommand), key hashes, and `<n bytes>` placeholders.
 */
import { createHash } from 'node:crypto';
import type { AuditEvent } from '@rconsole/shared';
import type { Db } from './store/db.ts';

export type Outcome = AuditEvent['outcome'];

export interface AuditInput {
  userId: string;
  username: string;
  ip: string;
  action: string;
  outcome: Outcome;
  databaseId?: string | undefined;
  command?: string | undefined;
  argvRedacted?: string[] | undefined;
  keyCount?: number | undefined;
  reason?: string | undefined;
  detail?: string | undefined;
}

type Arg = string | Uint8Array;

const len = (a: Arg) => (typeof a === 'string' ? Buffer.byteLength(a) : a.byteLength);

/** Short, non-reversible correlation ID for a key (keys may contain PII). */
export function keyTag(key: Arg): string {
  return `key#${createHash('sha256').update(typeof key === 'string' ? Buffer.from(key) : key).digest('hex').slice(0, 12)}`;
}

/**
 * Redact argv. `keep` leading tokens (command name, subcommand) are kept verbatim (upper-cased, max 64 chars);
 * arguments at `keyIndexes` become key tags; everything else becomes `<n bytes>`.
 */
export function redactArgv(argv: readonly Arg[], keep: number, keyIndexes: Iterable<number> = []): { argv: string[]; keyCount: number } {
  const keys = new Set(keyIndexes);
  const out: string[] = [];
  let keyCount = 0;
  argv.forEach((a, i) => {
    if (i < keep) {
      const s = typeof a === 'string' ? a : Buffer.from(a).toString('latin1');
      out.push(/^[A-Za-z0-9._|-]{1,64}$/.test(s) ? s.toUpperCase() : `<${len(a)} bytes>`);
    } else if (keys.has(i)) {
      keyCount++;
      out.push(keyTag(a));
    } else {
      out.push(`<${len(a)} bytes>`);
    }
  });
  return { argv: out, keyCount };
}

/** The error code of a Redis error reply ("WRONGTYPE", "ERR", "NOPERM"); the rest may quote user data. */
export function redisErrorCode(message: string): string {
  return /^-?([A-Z][A-Z0-9_]{1,31})(?=\s|$)/.exec(message)?.[1] ?? 'ERR';
}

/**
 * Audit detail for a failed request. Redis error text can quote arguments ("unknown command 'x', with args
 * beginning with: ...", search syntax errors near the query text), so only its error code is kept. When the
 * command name itself was not recognised (it may be a pasted value), only the API error code is kept.
 */
export function failureDetail(code: string, message: string, nameKnown = true): string {
  if (code === 'redis_error') return `redis_error: ${redisErrorCode(message)}`;
  if (code === 'forbidden' && message.startsWith('Redis ACL denied the command: ')) return `forbidden: ${redisErrorCode(message.slice(30))}`;
  if (!nameKnown) return code;
  return `${code}: ${message}`;
}

/** Limit free text (reasons, error messages) stored in the audit log. Strips control characters. */
export function clip(s: string | undefined, max = 500): string | undefined {
  if (s === undefined) return undefined;
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

interface Row {
  id: number; at: string; user_id: string; username: string; ip: string; action: string; database_id: string | null; command: string | null;
  argv_redacted: string | null; key_count: number | null; outcome: string; reason: string | null; detail: string | null;
}

function fromRow(r: Row): AuditEvent {
  const e: AuditEvent = { id: String(r.id), at: r.at, userId: r.user_id, username: r.username, ip: r.ip, action: r.action, outcome: r.outcome as Outcome };
  if (r.database_id) e.databaseId = r.database_id;
  if (r.command) e.command = r.command;
  if (r.argv_redacted) e.argvRedacted = JSON.parse(r.argv_redacted) as string[];
  if (r.key_count != null) e.keyCount = r.key_count;
  if (r.reason) e.reason = r.reason;
  if (r.detail) e.detail = r.detail;
  return e;
}

export interface AuditQuery { user?: string | undefined; database?: string | undefined; action?: string | undefined; outcome?: Outcome | undefined; before?: string | undefined; limit: number }

export class AuditLog {
  readonly #db: Db;
  readonly #write: (line: string) => void;
  constructor(db: Db, write: (line: string) => void = (l) => process.stdout.write(l)) {
    this.#db = db;
    this.#write = write;
  }

  record(e: AuditInput): AuditEvent {
    const at = new Date().toISOString();
    const reason = clip(e.reason);
    const detail = clip(e.detail);
    const r = this.#db
      .prepare(`INSERT INTO audit (at,user_id,username,ip,action,database_id,command,argv_redacted,key_count,outcome,reason,detail)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(at, e.userId, e.username, e.ip, e.action, e.databaseId ?? null, e.command ?? null, e.argvRedacted ? JSON.stringify(e.argvRedacted) : null,
        e.keyCount ?? null, e.outcome, reason ?? null, detail ?? null);
    const ev: AuditEvent = { id: String(r.lastInsertRowid), at, userId: e.userId, username: e.username, ip: e.ip, action: e.action, outcome: e.outcome };
    if (e.databaseId) ev.databaseId = e.databaseId;
    if (e.command) ev.command = e.command;
    if (e.argvRedacted) ev.argvRedacted = e.argvRedacted;
    if (e.keyCount != null) ev.keyCount = e.keyCount;
    if (reason) ev.reason = reason;
    if (detail) ev.detail = detail;
    try {
      this.#write(`${JSON.stringify({ audit: true, ...ev })}\n`);
    } catch {
      /* stdout closed: SQLite copy is authoritative */
    }
    return ev;
  }

  query(q: AuditQuery): { events: AuditEvent[]; nextBefore?: string } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.user) { where.push('username = ?'); args.push(q.user); }
    if (q.database) { where.push('database_id = ?'); args.push(q.database); }
    if (q.action) { where.push('action = ?'); args.push(q.action); }
    if (q.outcome) { where.push('outcome = ?'); args.push(q.outcome); }
    if (q.before && /^\d+$/.test(q.before)) { where.push('id < ?'); args.push(Number(q.before)); }
    const sql = `SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    const rows = this.#db.prepare(sql).all(...args, q.limit + 1) as unknown as Row[];
    const events = rows.slice(0, q.limit).map(fromRow);
    const out: { events: AuditEvent[]; nextBefore?: string } = { events };
    if (rows.length > q.limit && events.length) out.nextBefore = events[events.length - 1]!.id;
    return out;
  }
}
