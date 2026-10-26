/**
 * v0.3 follow-up 3: audit retention. `audit.retentionDays` (default 365, at least 30, 0 = forever); a job at startup
 * and daily deletes older rows in batches through a grant that exists only inside its own transaction; the append-only
 * triggers still refuse every other UPDATE/DELETE, and any DELETE of a row younger than 30 days; pruning is audited
 * with counts; the stdout (SIEM) stream gets only the prune event.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit.ts';
import { resolveConfig } from '../../src/config.ts';
import { openDb, type Db } from '../../src/store/db.ts';
import { AuditRetention, pruneAuditBatch } from '../../src/store/auditRetention.ts';

const DAY = 86_400_000;
const iso = (msAgo: number, now = Date.now()) => new Date(now - msAgo).toISOString();
const insert = (db: Db, at: string, action = 'cli.exec') =>
  db.prepare("INSERT INTO audit (at,user_id,username,ip,action,outcome) VALUES (?,'u','u','127.0.0.1',?,'allowed')").run(at, action);
const count = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n;
const log = { info: () => {}, warn: () => {} };

function fixture() {
  const db = openDb(':memory:');
  const lines: string[] = [];
  const audit = new AuditLog(db, (l) => lines.push(l));
  return { db, lines, audit };
}

describe('audit retention (v0.3 follow-up 3)', () => {
  it('config: 365 days by default, 0 keeps everything, below 30 is refused', () => {
    const base = { server: { publicUrl: 'http://localhost:4600', secureCookies: false }, auth: { local: { enabled: true, totpEncryptionKey: { env: 'K' } } }, databases: [] };
    const env = { NODE_ENV: 'test', K: 'k'.repeat(40) };
    expect(resolveConfig(base, { env }).audit.retentionDays).toBe(365);
    for (const d of [0, 30, 400, 36_500]) expect(resolveConfig({ ...base, audit: { retentionDays: d } }, { env }).audit.retentionDays).toBe(d);
    for (const d of [1, 29, -1, 36_501, 1.5]) expect(() => resolveConfig({ ...base, audit: { retentionDays: d } }, { env })).toThrow(/audit\.retentionDays/);
    expect(() => resolveConfig({ ...base, audit: { retentionDays: 90, keep: true } }, { env })).toThrow(/audit/);
  });

  it('the table stays append-only: UPDATE and DELETE outside the job are refused, also for old rows', () => {
    const { db } = fixture();
    insert(db, iso(400 * DAY));
    expect(() => db.prepare('DELETE FROM audit').run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE audit SET action = 'x'").run()).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM audit WHERE id = 1')).toThrow(/append-only/);
    expect(count(db)).toBe(1);
  });

  it('a grant never reaches rows younger than 30 days, nor rows newer than its own cutoff', () => {
    const { db } = fixture();
    insert(db, iso(10 * DAY));
    insert(db, iso(40 * DAY));
    db.exec('BEGIN');
    db.prepare('INSERT INTO audit_prune_grant (cutoff) VALUES (?)').run(iso(-DAY));
    expect(() => db.prepare('DELETE FROM audit WHERE id = 1').run()).toThrow(/append-only/);
    db.prepare('DELETE FROM audit WHERE id = 2').run();
    db.exec('ROLLBACK');
    db.exec('BEGIN');
    db.prepare('INSERT INTO audit_prune_grant (cutoff) VALUES (?)').run(iso(50 * DAY));
    expect(() => db.prepare('DELETE FROM audit WHERE id = 2').run()).toThrow(/append-only/);
    db.exec('ROLLBACK');
    expect(count(db)).toBe(2);
  });

  it('prunes rows older than the retention in batches, keeps the rest, audits the count and leaves no grant', async () => {
    const { db, lines, audit } = fixture();
    const now = Date.now();
    for (let i = 0; i < 7; i++) insert(db, iso((400 + i) * DAY, now));
    insert(db, iso(364 * DAY, now), 'auth.login');
    insert(db, iso(DAY, now), 'auth.login');
    const job = new AuditRetention(db, audit, 365, log, 3);
    const r = await job.run(now);
    expect(r).toMatchObject({ deleted: 7, batches: 3 });
    const rows = db.prepare('SELECT action FROM audit ORDER BY id').all() as { action: string }[];
    expect(rows.map((x) => x.action)).toEqual(['auth.login', 'auth.login', 'system.audit.prune']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM audit_prune_grant').get() as { n: number }).n).toBe(0);
    // The SIEM stream gets the prune event (counts only) and nothing else: no deleted row is re-sent or retracted.
    expect(lines).toHaveLength(1);
    const ev = JSON.parse(lines[0]!);
    expect(ev).toMatchObject({ audit: true, action: 'system.audit.prune', outcome: 'allowed', username: 'system' });
    expect(ev.detail).toMatch(/^deleted=7 batches=3 before=\S+ retentionDays=365$/);
    // Nothing left to delete: no event.
    expect(await job.run(now)).toMatchObject({ deleted: 0 });
    expect(lines).toHaveLength(1);
    await job.stop();
  });

  it('retentionDays 0 keeps everything', async () => {
    const { db, audit } = fixture();
    insert(db, iso(5000 * DAY));
    const job = new AuditRetention(db, audit, 0, log);
    job.start();
    expect(await job.run()).toBeNull();
    expect(count(db)).toBe(1);
    await job.stop();
  });

  it('runs at startup, and another connection never sees a grant', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rconsole-retention-'));
    const db = openDb(dir);
    const audit = new AuditLog(db, () => {});
    for (let i = 0; i < 5; i++) insert(db, iso(500 * DAY));
    const other = new DatabaseSync(path.join(dir, 'rconsole.sqlite'));
    other.exec('PRAGMA busy_timeout = 5000');
    let sawGrant = false;
    const job = new AuditRetention(db, audit, 365, log, 1);
    const peek = setInterval(() => { if ((other.prepare('SELECT COUNT(*) AS n FROM audit_prune_grant').get() as { n: number }).n) sawGrant = true; }, 0);
    job.start();
    await new Promise((r) => setTimeout(r, 50));
    await job.stop();
    clearInterval(peek);
    expect(sawGrant).toBe(false);
    expect((other.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'cli.exec'").get() as { n: number }).n).toBe(0);
    expect((other.prepare("SELECT detail FROM audit WHERE action = 'system.audit.prune'").get() as { detail: string }).detail).toMatch(/^deleted=5 batches=5 /);
    other.close();
    db.close();
  });

  it('a failed batch rolls back, leaves no grant and is audited as an error', async () => {
    const { db, lines, audit } = fixture();
    insert(db, iso(400 * DAY));
    // Simulate a schema problem: the grant insert fails inside the batch.
    db.exec('DROP TABLE audit_prune_grant; CREATE TABLE audit_prune_grant (cutoff TEXT NOT NULL CHECK (0))');
    expect(() => pruneAuditBatch(db, iso(365 * DAY))).toThrow();
    const r = await new AuditRetention(db, audit, 365, log).run();
    expect(r).toMatchObject({ deleted: 0 });
    expect(count(db)).toBe(2);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ action: 'system.audit.prune', outcome: 'error' });
  });
});
