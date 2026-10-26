/**
 * Delete by pattern: the shared confirmation (impact count, sample, typed name and prod reason), the synchronous
 * `bulk-delete` run, and the observable, cancellable job (v0.2.1, F20) the key browser uses.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ErrorReply } from 'redis';
import {
  binFromBytes,
  roleAtLeast,
  zBulkDelete,
  type BulkDeleteJob,
  type BulkDeleteJobResponse,
  type BulkDeleteResult,
} from '@rconsole/shared';
import { actorCheck, audit, dbScope, parse, rateLimit, type AppContext, type DbScope } from '../context.ts';
import { redisErrorCode } from '../audit.ts';
import { HttpError } from '../http/errors.ts';
import { authorize, confirmationFor, fixedCommand } from '../policy/policy.ts';
import { auditDenied, confirmOrThrow, type AuditBase } from '../policy/enforce.ts';
import type { Confirmed } from '../policy/confirm.ts';
import { buildPreview, previewCommand } from '../policy/preview.ts';
import { hashSlot } from '../redis/capped.ts';
import { toHttpError } from '../redis/exec.ts';
import type { Arg, Conn, Target } from '../redis/manager.ts';
import { isPureWildcard, scanPage } from '../redis/scan.ts';

type Body = ReturnType<typeof zBulkDelete.parse>;
const bin = (b: Buffer) => binFromBytes(b);

/** Concurrent per-key commands of one cluster request (see `inSlotOrder`). */
const CLUSTER_KEY_WORKERS = 4;

/**
 * Per-key commands of a cluster request: a multi-key delete split by slot, or a bulk-delete page. They carry the
 * actor check, so they run on measured sockets, one command per socket at a time (review v0.2 N1 follow-up). They are
 * sent in slot order on a few workers rather than all at once: a burst larger than the pool's short wait queue would
 * be refused (429), and keys of consecutive slots mostly live on one primary, so each worker keeps reusing that node's
 * socket. After the first failure no further command is started, and the first failure is rethrown only once the
 * commands already sent have settled, so the caller's counts and audit include them (review v0.2.1 F5).
 */
export async function inSlotOrder<T, R>(items: T[], keyOf: (item: T) => Arg, run: (item: T) => Promise<R>): Promise<R[]> {
  const order = items.map((item) => ({ item, slot: hashSlot(keyOf(item)) })).sort((a, b) => a.slot - b.slot);
  const out: R[] = [];
  let next = 0;
  let failure: { error: unknown } | undefined;
  // Workers never reject: each stops at the first failure (its own or another's) after its command has settled.
  const worker = async () => {
    while (!failure && next < order.length) {
      const { item } = order[next++]!;
      try {
        out.push(await run(item));
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CLUSTER_KEY_WORKERS, order.length) }, worker));
  if (failure) throw failure.error;
  return out;
}

const IMPACT_BUDGET_MS = 5000;
const BULK_BUDGET_MS = 60_000;
const BULK_MAX_KEYS = 1_000_000;

/**
 * Pages are counted and dropped: each SCAN reply is capped on its own (`pageBytes`), not by the request's
 * cumulative budget (review v0.2 r4 M2); only the kept sample shares `cap`.
 */
async function countMatches(conn: Conn, match: string, type: string | undefined, cap: number): Promise<{ count: number; sample: Buffer[]; complete: boolean }> {
  const nodes = await conn.primaries();
  let cursor = '0', count = 0, sampleBytes = 0;
  const sample: Buffer[] = [];
  const start = Date.now();
  do {
    const page = await scanPage(conn, { cursor, match, type, count: 1000, maxKeys: 10_000, budgetMs: 500, pageBytes: cap }, nodes);
    count += page.keys.length;
    for (const k of page.keys) {
      if (sample.length >= 20 || sampleBytes + k.length > cap) continue;
      sample.push(k);
      sampleBytes += k.length;
    }
    cursor = page.cursor;
  } while (cursor !== '0' && Date.now() - start < IMPACT_BUDGET_MS && count < BULK_MAX_KEYS);
  return { count, sample, complete: cursor === '0' };
}

/**
 * Role, read-only and wildcard checks, then the confirmation: without one, a 428 whose preview counts the matching keys
 * and lists a sample; with one, the reason and the count it showed. `route` binds the token to this route.
 */
export async function confirmBulkDelete(ctx: AppContext, req: FastifyRequest, scope: DbScope, body: Body, base: AuditBase, route: string): Promise<Confirmed> {
  const { policy } = ctx.config;
  authorize(fixedCommand('UNLINK', 'write', 'typed'), scope);
  if (isPureWildcard(body.match) && (scope.db.environment === 'prod' || !roleAtLeast(scope.role, 'admin'))) {
    throw new HttpError('forbidden', 'Deleting every key requires the admin role on a non-production database. Use a more specific pattern.');
  }
  const scanArgv: Arg[] = ['SCAN', '0', 'MATCH', body.match, 'COUNT', '1000', ...(body.type ? ['TYPE', body.type] : [])];
  const preview = buildPreview([previewCommand(scanArgv, 1, [], [3]), previewCommand(['UNLINK'], 1)]);
  preview.bulk = { match: bin(Buffer.from(body.match)), ...(body.type ? { type: body.type } : {}) };
  const spec = confirmationFor('typed', true, scope.db, policy.prodRequiresReason, `Delete all keys matching ${JSON.stringify(body.match)}${body.type ? ` of type ${body.type}` : ''} on ${scope.db.name}`, preview);
  if (!body.confirmation && spec) {
    const impact = await countMatches(await scope.conn(), body.match, body.type, policy.maxReadReplyBytes);
    spec.impact = { keys: impact.count, sample: impact.sample.map(bin) };
    if (!impact.complete) spec.summary += ` (at least ${impact.count} keys; counting stopped early)`;
    // UNLINK of the matching keys (sample listed, the rest counted), then the counted totals.
    preview.commands[1] = previewCommand(['UNLINK', ...impact.sample], 1, impact.sample.map((_, i) => i + 1));
    const listed = Math.min(impact.sample.length, preview.commands[1].argv.length - 1);
    if (impact.count > listed) preview.commands[1].moreArgs = impact.count - listed;
    preview.bulk = { ...preview.bulk, keys: impact.count, complete: impact.complete, sample: spec.impact.sample! };
  }
  return confirmOrThrow(ctx, req, scope, route, req.body, body.confirmation, spec, base);
}

/** The synchronous `bulk-delete` run (60 s budget); see the job below for the observable form. */
export async function bulkDelete(conn: Conn, match: string, type: string | undefined, cap: number, stillValid: () => boolean): Promise<BulkDeleteResult & { stopped: boolean }> {
  const nodes = await conn.primaries();
  let cursor = '0', deleted = 0, scanned = 0;
  const start = Date.now();
  try {
    do {
      // Revoking or demoting the user stops a running bulk delete between batches (review M1).
      if (!stillValid()) return { deleted, scanned, stopped: true };
      // Each page is deleted and dropped: each SCAN reply is capped on its own, not by the request's cumulative budget.
      const page = await scanPage(conn, { cursor, match, type, count: 1000, maxKeys: 5000, budgetMs: 1000, pageBytes: cap }, nodes);
      scanned += page.keys.length;
      cursor = page.cursor;
      if (conn.mode === 'cluster') {
        // A key that fails counts as not deleted; a refused actor stops the delete (below), with what it deleted so far.
        await inSlotOrder(page.keys, (k) => k, async (k) => {
          const n = await conn.send(['UNLINK', k], { key: k }).catch((e: unknown) => {
            if (e instanceof HttpError && e.code === 'unauthenticated') throw e;
            return 0;
          });
          deleted += Number(n) || 0; // added after the await: workers run concurrently
        });
      } else {
        for (let i = 0; i < page.keys.length; i += 500) {
          try {
            deleted += Number(await conn.send(['UNLINK', ...page.keys.slice(i, i + 500)], { timeout: 10_000 })) || 0;
          } catch (e) {
            throw toHttpError(e);
          }
        }
      }
    } while (cursor !== '0' && Date.now() - start < BULK_BUDGET_MS && scanned < BULK_MAX_KEYS);
  } catch (e) {
    // A command refused right before it was sent: the account was revoked during a batch (review v0.2 N1).
    if (e instanceof HttpError && e.code === 'unauthenticated') return { deleted, scanned, stopped: true };
    throw e;
  }
  return { deleted, scanned, stopped: false };
}

// ---------------------------------------------------------------------------
// Jobs (F20)

/** A job ends at this age or after visiting this many keys; the report says which limit stopped it. */
export const JOB_BUDGET_MS = 10 * 60_000;
export const JOB_MAX_KEYS = 1_000_000;
/** Finished jobs are kept this long for their report. */
export const JOB_KEEP_MS = 10 * 60_000;
/** Running jobs: one per user, a few per server. */
export const JOBS_PER_SERVER = 4;
/** Distinct error codes kept per job; further codes count as `other`. */
const ERROR_CODES = 8;
/** Pages in a row on which every UNLINK failed before the job gives up. */
const FAILED_PAGES = 3;

export interface Job {
  view: BulkDeleteJob;
  userId: string;
  sessionHash: string;
  databaseId: string;
  started: number;
  cancel: boolean;
  done: Promise<void>;
  errors: Map<string, number>;
}

/** The failure code of one UNLINK: the Redis error code (NOPERM, ERR, …) or the API error code; never the text. */
function failureCode(e: unknown): string {
  if (e instanceof ErrorReply) return redisErrorCode(e.message);
  if (e instanceof HttpError) return e.code === 'forbidden' && e.message.startsWith('Redis ACL denied') ? 'NOPERM' : e.code === 'redis_error' ? redisErrorCode(e.message) : e.code;
  return 'internal';
}

export function registerBulkDeleteJobRoutes(app: FastifyInstance, ctx: AppContext) {
  const { policy } = ctx.config;
  const jobs = new Map<string, Job>();
  const sweep = () => {
    const now = Date.now();
    for (const [id, job] of jobs) if (job.view.state !== 'running' && now - job.started - job.view.elapsedMs > JOB_KEEP_MS) jobs.delete(id);
  };
  const snapshot = (job: Job): BulkDeleteJob => ({
    ...job.view,
    errors: [...job.errors].map(([code, count]) => ({ code, count })),
    elapsedMs: job.view.state === 'running' ? Date.now() - job.started : job.view.elapsedMs,
  });
  // Before the app's onClose closes Redis and the audit database: stop running jobs between batches and let them
  // record their outcome (bounded, so a stuck command cannot hold up shutdown).
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
    await Promise.race([Promise.allSettled([...jobs.values()].map((job) => job.done)), new Promise((r) => setTimeout(r, 10_000).unref())]);
  });

  /** The caller's own job (same session) on this database, or 404. */
  const own = (req: FastifyRequest, scope: DbScope): Job => {
    const { id } = req.params as { id?: string };
    const job = id ? jobs.get(id) : undefined;
    if (!job || job.sessionHash !== scope.session.idHash || job.databaseId !== scope.db.id) throw new HttpError('not_found', 'No such delete job in this session.');
    return job;
  };

  app.post('/api/v1/databases/:db/bulk-delete/jobs', { bodyLimit: 64 * 1024 }, async (req): Promise<BulkDeleteJobResponse> => {
    const scope = dbScope(ctx, req, 'operator');
    rateLimit(ctx, req, 'bulk', 1, 3);
    const body = parse(zBulkDelete, req.body);
    const base: AuditBase = { action: 'key.bulk-delete', databaseId: scope.db.id, command: 'UNLINK', argvRedacted: ['SCAN', `<match ${Buffer.byteLength(body.match)} bytes>`] };
    try {
      sweep();
      const running = [...jobs.values()].filter((j) => j.view.state === 'running');
      if (running.some((j) => j.userId === scope.session.userId)) throw new HttpError('rate_limited', 'You already have a delete job running; wait for it or stop it first.');
      if (running.length >= JOBS_PER_SERVER) throw new HttpError('rate_limited', `Too many delete jobs are running on this server (limit ${JOBS_PER_SERVER}); try again shortly.`);
      const confirmed = await confirmBulkDelete(ctx, req, scope, body, base, 'bulk-delete-job');
      const raw = await ctx.redis.conn(scope.db.id, scope.role);
      // Checked again after the awaits above, with no await before the job is registered: two confirmed requests sent
      // together cannot both start.
      const now = [...jobs.values()].filter((j) => j.view.state === 'running');
      if (now.some((j) => j.userId === scope.session.userId)) throw new HttpError('rate_limited', 'You already have a delete job running; wait for it or stop it first.');
      if (now.length >= JOBS_PER_SERVER) throw new HttpError('rate_limited', `Too many delete jobs are running on this server (limit ${JOBS_PER_SERVER}); try again shortly.`);
      // Every command of the job carries the actor check (measured transport): revoking or demoting the user stops it.
      const stillAllowed = actorCheck(ctx, req, scope.session, scope.db.id);
      const wrap = (t: Target): Target => ({ label: t.label, send: (args, o = {}) => t.send(args, { ...o, stillAllowed }) });
      const conn = { ...wrap(raw), mode: raw.mode, primaries: async () => (await raw.primaries()).map(wrap) } satisfies Pick<Conn, 'send' | 'mode' | 'primaries'>;
      const id = randomBytes(12).toString('base64url');
      const job: Job = {
        view: {
          id, state: 'running', scanned: 0, deleted: 0, failed: 0, errors: [], complete: false,
          startedAt: new Date().toISOString(), elapsedMs: 0,
          ...(confirmed.confirmedKeys?.complete ? { expected: confirmed.confirmedKeys.keys } : {}),
        },
        userId: scope.session.userId, sessionHash: scope.session.idHash, databaseId: scope.db.id,
        started: Date.now(), cancel: false, done: Promise.resolve(), errors: new Map(),
      };
      jobs.set(id, job);
      audit(ctx, req, { ...base, action: 'key.bulk-delete.start', outcome: 'allowed', reason: confirmed.reason, detail: `job ${id}${job.view.expected !== undefined ? `; expected ${job.view.expected}` : ''}` });
      job.done = runJob(job, conn, body, () => stillAllowed(), policy.maxReadReplyBytes, () => closing || ctx.state.shuttingDown).then(() => {
        const v = job.view;
        const errors = [...job.errors].map(([code, n]) => `${code}x${n}`).join(',');
        audit(ctx, req, {
          ...base, outcome: v.state === 'failed' ? 'error' : 'allowed', keyCount: v.deleted, reason: confirmed.reason,
          detail: `job ${id}; scanned ${v.scanned}; deleted ${v.deleted}; failed ${v.failed}; ${v.state}${v.stopReason ? ` (${v.stopReason})` : ''}${errors ? `; errors ${errors}` : ''}`,
        });
      }).catch((e: unknown) => {
        // The outcome could not be audited (shutdown, storage error); it must not take the process down.
        ctx.log.error({ err: e instanceof Error ? e.message : String(e) }, `bulk-delete job ${id}: final audit failed`);
      });
      return { job: snapshot(job) };
    } catch (e) {
      auditDenied(ctx, req, base, e);
    }
  });

  app.get('/api/v1/databases/:db/bulk-delete/jobs/:id', async (req): Promise<BulkDeleteJobResponse> => {
    const scope = dbScope(ctx, req, 'operator');
    rateLimit(ctx, req, 'bulk-status', 10, 20);
    return { job: snapshot(own(req, scope)) };
  });

  app.post('/api/v1/databases/:db/bulk-delete/jobs/:id/cancel', { bodyLimit: 1024 }, async (req): Promise<BulkDeleteJobResponse> => {
    const scope = dbScope(ctx, req, 'operator');
    rateLimit(ctx, req, 'bulk-status', 10, 20);
    const job = own(req, scope);
    if (job.view.state === 'running') job.cancel = true;
    return { job: snapshot(job) };
  });
}

/**
 * Scans and deletes page by page, updating the job's counts as it goes. Stops between batches when cancelled, when
 * the actor may no longer act, at the time or key limit, or after three pages in a row on which every UNLINK failed. Failed UNLINKs are
 * counted by error code; what was deleted stays deleted.
 */
export async function runJob(job: Job, conn: Pick<Conn, 'send' | 'mode' | 'primaries'>, body: Body, stillValid: () => boolean, cap: number, shuttingDown: () => boolean = () => false): Promise<void> {
  const v = job.view;
  const fail = (e: unknown, keys: number) => {
    const code = failureCode(e);
    const key = job.errors.has(code) || job.errors.size < ERROR_CODES ? code : 'other';
    job.errors.set(key, (job.errors.get(key) ?? 0) + keys);
    v.failed += keys;
  };
  const end = (state: BulkDeleteJob['state'], reason?: BulkDeleteJob['stopReason']) => {
    v.state = state;
    if (reason) v.stopReason = reason;
    v.finishedAt = new Date().toISOString();
    v.elapsedMs = Date.now() - job.started;
  };
  let failedPages = 0;
  const revoked = (e: unknown) => e instanceof HttpError && e.code === 'unauthenticated';
  /** A stop that is not a failure of the delete (server shutting down mid-batch): counts stay as they are. */
  const stopping = () => job.cancel || shuttingDown();
  try {
    const nodes = await conn.primaries();
    let cursor = '0';
    do {
      if (shuttingDown()) return end('stopped', 'shutdown');
      if (job.cancel) return end('cancelled', 'cancelled');
      if (!stillValid()) return end('stopped', 'session');
      if (Date.now() - job.started >= JOB_BUDGET_MS) return end('stopped', 'time');
      if (v.scanned >= JOB_MAX_KEYS) return end('stopped', 'keys');
      const page = await scanPage(conn, { cursor, match: body.match, type: body.type, count: 1000, maxKeys: 2000, budgetMs: 1000, pageBytes: cap }, nodes);
      v.scanned += page.keys.length;
      cursor = page.cursor;
      let ok = 0, failed = 0;
      if (conn.mode === 'cluster') {
        await inSlotOrder(page.keys, (k) => k, async (k) => {
          try {
            // Read the reply first: `v.deleted += await …` would read the count before the await and lose the
            // updates of the other workers.
            const n = Number(await conn.send(['UNLINK', k], { key: k })) || 0;
            v.deleted += n;
            ok++;
          } catch (e) {
            if (revoked(e)) throw e;
            if (stopping()) return;
            fail(e, 1);
            failed++;
          }
        });
      } else {
        for (let i = 0; i < page.keys.length; i += 500) {
          const batch = page.keys.slice(i, i + 500);
          try {
            const n = Number(await conn.send(['UNLINK', ...batch], { timeout: 10_000 })) || 0;
            v.deleted += n;
            ok++;
          } catch (e) {
            if (revoked(e)) throw e;
            if (stopping()) break;
            fail(e, batch.length);
            failed++;
          }
        }
      }
      failedPages = failed && !ok ? failedPages + 1 : 0;
      if (failedPages >= FAILED_PAGES) return end('failed', 'errors');
      if (cursor === '0') v.complete = true;
    } while (cursor !== '0');
    end('done');
  } catch (e) {
    if (revoked(e)) return end('stopped', 'session');
    if (shuttingDown()) return end('stopped', 'shutdown');
    if (job.cancel) return end('cancelled', 'cancelled');
    fail(e, 0);
    end('failed', 'errors');
  }
}
