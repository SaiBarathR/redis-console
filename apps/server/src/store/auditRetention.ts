/**
 * Audit retention (v0.3 follow-up 3): deletes audit rows older than `audit.retentionDays`, in batches, at startup and
 * daily, and audits what it did (`system.audit.prune`, counts only). The stdout copy for the SIEM is never touched.
 *
 * The audit table refuses UPDATE and DELETE through triggers. Pruning does not disable them: each batch runs in one
 * transaction that inserts an `audit_prune_grant` row naming the cutoff, deletes at most one batch of rows older than
 * it, and removes the grant before it commits, so no other connection ever sees a grant. The trigger lets a DELETE
 * through only for rows older than a grant's cutoff, and never for rows younger than 30 days (migration 4, db.ts).
 */
import type { AuditLog } from '../audit.ts';
import type { Db } from './db.ts';

export const AUDIT_PRUNE_BATCH = 5000;
export const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Delete at most `batch` audit rows older than `cutoff` (ISO time), oldest first. Returns how many went. */
export function pruneAuditBatch(db: Db, cutoff: string, batch = AUDIT_PRUNE_BATCH): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO audit_prune_grant (cutoff) VALUES (?)').run(cutoff);
    const r = db.prepare('DELETE FROM audit WHERE id IN (SELECT id FROM audit WHERE at < ? ORDER BY at, id LIMIT ?)').run(cutoff, batch);
    db.prepare('DELETE FROM audit_prune_grant').run();
    db.exec('COMMIT');
    return Number(r.changes);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface PruneResult { deleted: number; batches: number; cutoff: string }

export interface RetentionLog { info(o: object, msg: string): void; warn(o: object, msg: string): void }

export class AuditRetention {
  readonly #db: Db;
  readonly #audit: AuditLog;
  readonly #days: number;
  readonly #log: RetentionLog;
  readonly #batch: number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #startup: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<PruneResult | null> | undefined;
  #stopped = false;

  constructor(db: Db, audit: AuditLog, retentionDays: number, log: RetentionLog, batch = AUDIT_PRUNE_BATCH) {
    this.#db = db;
    this.#audit = audit;
    this.#days = retentionDays;
    this.#log = log;
    this.#batch = batch;
    // A grant can only outlive its transaction if SQLite lost the rollback; never keep one.
    db.prepare('DELETE FROM audit_prune_grant').run();
  }

  /** Prune now: every row older than the retention, a batch per transaction, yielding between batches. */
  run(now = Date.now()): Promise<PruneResult | null> {
    if (!this.#days || this.#stopped) return Promise.resolve(null);
    this.#running ??= this.#prune(now).finally(() => { this.#running = undefined; });
    return this.#running;
  }

  async #prune(now: number): Promise<PruneResult> {
    const cutoff = new Date(now - this.#days * DAY_MS).toISOString();
    let deleted = 0;
    let batches = 0;
    try {
      for (;;) {
        const n = pruneAuditBatch(this.#db, cutoff, this.#batch);
        deleted += n;
        if (n) batches++;
        if (n < this.#batch || this.#stopped) break;
        await new Promise((r) => setImmediate(r));
      }
    } catch (e) {
      this.#log.warn({ err: (e as Error).message, deleted }, 'audit retention: pruning failed');
      this.#audit.record({ userId: 'system', username: 'system', ip: '-', action: 'system.audit.prune', outcome: 'error', detail: `deleted=${deleted} before=${cutoff} retentionDays=${this.#days}; stopped: ${(e as Error).message.slice(0, 200)}` });
      return { deleted, batches, cutoff };
    }
    if (deleted) {
      this.#log.info({ deleted, batches, cutoff, retentionDays: this.#days }, 'audit retention: old audit rows deleted');
      this.#audit.record({ userId: 'system', username: 'system', ip: '-', action: 'system.audit.prune', outcome: 'allowed', detail: `deleted=${deleted} batches=${batches} before=${cutoff} retentionDays=${this.#days}` });
    }
    return { deleted, batches, cutoff };
  }

  /** At startup (on the next turn) and then daily. */
  start(): void {
    if (!this.#days) return;
    this.#startup = setTimeout(() => void this.run(), 0);
    this.#timer = setInterval(() => void this.run(), AUDIT_PRUNE_INTERVAL_MS);
    this.#startup.unref();
    this.#timer.unref();
  }

  /** Stop scheduling; a batch in progress finishes its transaction and the loop ends. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#startup);
    clearInterval(this.#timer);
    await this.#running;
  }
}
