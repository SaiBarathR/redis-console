/**
 * Bulk import of a redis-cli command file (v0.2.1, RI parity F10).
 *
 * 1. POST …/import {script}: every line is tokenized and checked by the same `prepare` as a workbench line (command
 *    policy, effective role, read-only database, prod rules). The plan lists counts by class and every refused line.
 *    Nothing runs.
 * 2. POST …/import/:id/start: one confirmation covers the import (any write: confirm; prod: typed name + reason;
 *    stronger rules such as FLUSHDB's typed confirmation win). Refused lines must be removed or explicitly skipped.
 * 3. The commands run one at a time through `execute` (measured transport, the role's ACL user, the actor check
 *    right before each write), in chunks of IMPORT_CHUNK_SIZE; each is audited like a workbench line
 *    (`import.exec`). GET …/import/:id reports progress; POST …/import/:id/cancel stops before the next command.
 *
 * The script stays in server memory only while the job is planned or running, never in logs or the audit. A plan keeps
 * each line's text and verdict only; the run tokenizes and checks each line again, with the plan's command table.
 *
 * Imports are an operator feature (a viewer's import could only run reads), at most two per account, planned in
 * chunks that yield to the event loop; blocking commands share the workbench's time budget (review v0.2.1 F1, F4).
 */
import { randomBytes } from 'node:crypto';
import { setImmediate as yieldNow } from 'node:timers/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  IMPORT_CHUNK_SIZE,
  MAX_IMPORT_COMMANDS,
  tokenizeCommandLineBytes,
  zImportPlan,
  zImportStart,
  zJobCancel,
  type ApiError,
  type ImportFailureGroup,
  type ImportPlan,
  type ImportStatus,
  type PreviewCommand,
} from '@rconsole/shared';
import { audit, dbScope, parse, rateLimit, sessionStillValid, type AppContext, type DbScope } from '../context.ts';
import { failureDetail } from '../audit.ts';
import { HttpError } from '../http/errors.ts';
import { confirmOrThrow, type AuditBase } from '../policy/enforce.ts';
import type { CommandTable } from '../policy/commandTable.ts';
import { classify, confirmationFor, isMutating, type ConfirmSpec } from '../policy/policy.ts';
import { buildPreview } from '../policy/preview.ts';
import { toHttpError } from '../redis/exec.ts';
import { CANCELLED_NOT_SENT, STRONGER, auditBase, commandPreview, execute, prepare, type Prepared } from './cli.ts';

/** Planned imports expire unstarted after this long; finished ones stay readable this long. */
export const IMPORT_PLAN_TTL_MS = 10 * 60_000;
export const IMPORT_RETAIN_MS = 10 * 60_000;
/** Total run time of one import. */
export const IMPORT_MAX_MS = 15 * 60_000;
const MAX_JOBS = 16;
/** Imports planned or running per account, across its sessions and databases: a new plan replaces its oldest unstarted one. */
export const MAX_IMPORTS_PER_USER = 2;
/** Imports running at once, server-wide: each keeps one measured command in flight, so they never take every slot. */
export const MAX_RUNNING_IMPORTS = 4;
/** Files being checked at once, server-wide (one per account). */
const MAX_PLANNING = 2;
/** Lines checked between two turns of the event loop while planning. */
const PLAN_CHUNK = 200;
const MAX_LISTED_BLOCKED = 200;
const MAX_PREVIEWED = 60;
const MAX_FAILURE_GROUPS = 50;

/** A planned line: its text (tokenized and checked again when it runs) and whether the plan admitted it. */
interface Item {
  line: number;
  text: string;
  ok: boolean;
}

interface Job {
  plan: ImportPlan;
  status: ImportStatus;
  sessionHash: string;
  userId: string;
  databaseId: string;
  /** Freed when the job ends. */
  items: Item[] | null;
  /** The command table the plan was checked with; the run checks every line again with the same one. */
  table: CommandTable | undefined;
  spec: ConfirmSpec | null;
  abort: AbortController;
  finishedAt?: number;
}

/** One line tokenized and checked by the workbench policy, with its audit base (like a workbench line). */
interface Checked {
  name: string;
  p?: Prepared;
  error?: ApiError['error'];
  base?: AuditBase;
}

/** Non-empty, non-comment lines with their 1-based line numbers (comments: # or //, like the workbench). */
export function importLines(script: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  script.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.trim();
    if (text && !text.startsWith('#') && !text.startsWith('//')) out.push({ line: i + 1, text });
  });
  return out;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

export function registerImportRoutes(app: FastifyInstance, ctx: AppContext) {
  const jobs = new Map<string, Job>();
  const sweep = () => {
    const now = Date.now();
    for (const [id, j] of jobs) {
      if (j.status.state === 'planned' && now > j.plan.expiresAt) jobs.delete(id);
      else if (j.finishedAt && now - j.finishedAt > IMPORT_RETAIN_MS) jobs.delete(id);
    }
  };
  const find = (req: FastifyRequest, scope: DbScope): Job => {
    sweep();
    const id = (req.params as { id?: string }).id ?? '';
    const j = jobs.get(id);
    if (!j || j.sessionHash !== scope.session.idHash || j.databaseId !== scope.db.id) throw new HttpError('not_found', 'No such import (it may have expired; plan it again).');
    return j;
  };
  ctx.streams.add(() => {
    for (const j of jobs.values()) j.abort.abort(new Error('server shutting down'));
  });

  const active = (j: Job) => j.status.state === 'planned' || j.status.state === 'running';
  /**
   * Room for a new plan of this session on this database: it replaces the session's unstarted plan there (never a
   * running import), the account's oldest unstarted plans give way beyond MAX_IMPORTS_PER_USER, and the server holds
   * at most MAX_JOBS. Throws 429 otherwise.
   */
  const admit = (scope: DbScope) => {
    sweep();
    for (const [id, j] of jobs) {
      if (j.sessionHash !== scope.session.idHash || j.databaseId !== scope.db.id) continue;
      if (j.status.state === 'running') throw new HttpError('rate_limited', 'An import is running on this database; wait for it or cancel it first.');
      if (j.status.state === 'planned') jobs.delete(id);
    }
    const own = [...jobs].filter(([, j]) => j.userId === scope.session.userId && active(j));
    const plans = own.filter(([, j]) => j.status.state === 'planned').sort((a, b) => a[1].plan.expiresAt - b[1].plan.expiresAt);
    let held = own.length;
    for (; held >= MAX_IMPORTS_PER_USER && plans.length; held--) jobs.delete(plans.shift()![0]);
    if (held >= MAX_IMPORTS_PER_USER) throw new HttpError('rate_limited', `You have ${MAX_IMPORTS_PER_USER} imports running; wait for one to finish.`);
    if ([...jobs.values()].filter(active).length >= MAX_JOBS) {
      throw new HttpError('rate_limited', 'Too many imports are planned or running on this server; try again shortly.');
    }
  };

  /** Tokenize and check one line with the workbench policy, as a workbench line is (same audit base). */
  const check = (scope: DbScope, table: CommandTable | undefined, text: string): Checked => {
    let argv: Buffer[];
    try {
      argv = tokenizeCommandLineBytes(text).map((u) => Buffer.from(u));
    } catch (e) {
      return { name: '(invalid line)', error: { code: 'validation', message: (e as Error).message } };
    }
    const base = auditBase(scope, { argv, c: classify(argv, table) }, 'import.exec', table);
    try {
      return { name: base.command, p: prepare(argv, table, scope, ctx), base };
    } catch (e) {
      return { name: base.command, error: (e instanceof HttpError ? e : toHttpError(e)).toBody().error, base };
    }
  };

  // Operator and above: a viewer's import could only run reads, and a plan costs the server CPU and memory (review v0.2.1 F1).
  app.post('/api/v1/databases/:db/import', { bodyLimit: 8 * 1024 * 1024 }, async (req): Promise<ImportPlan> => {
    const scope = dbScope(ctx, req, 'operator');
    rateLimit(ctx, req, 'import-plan', 2, 6);
    const body = parse(zImportPlan, req.body);
    const lines = importLines(body.script);
    if (!lines.length) throw new HttpError('validation', 'The file has no commands (blank lines and # or // comments are skipped).');
    if (lines.length > MAX_IMPORT_COMMANDS) throw new HttpError('validation', `An import may contain at most ${MAX_IMPORT_COMMANDS.toLocaleString('en-US')} commands; this file has ${lines.length.toLocaleString('en-US')}. Split it.`);
    const mine = ctx.slots.acquire(`import-plan:${scope.session.userId}`, 1);
    if (!mine) throw new HttpError('rate_limited', 'A file of yours is still being checked; wait for it.');
    const global = ctx.slots.acquire('import-plan:global', MAX_PLANNING);
    if (!global) {
      mine();
      throw new HttpError('rate_limited', 'Other files are being checked on this server; try again shortly.');
    }
    const table = await scope.table().catch(() => undefined);
    const counts = { read: 0, write: 0, admin: 0, blocked: 0 };
    const blocked: ImportPlan['blocked'] = [];
    let destructive = 0;
    let changing = 0;
    // Destructive changes are listed first, then the other changes, in file order.
    const previews: { destructive: PreviewCommand[]; other: PreviewCommand[] } = { destructive: [], other: [] };
    let lineSpec: ConfirmSpec | null = null;
    const items: Item[] = [];
    try {
      admit(scope);
      for (let n = 0; n < lines.length; n++) {
        // A large file is checked in chunks: other requests run in between.
        if (n > 0 && n % PLAN_CHUNK === 0) await yieldNow();
        const { line, text } = lines[n]!;
        const c = check(scope, table, text);
        items.push({ line, text, ok: !!c.p });
        if (!c.p) {
          counts.blocked++;
          if (blocked.length < MAX_LISTED_BLOCKED) blocked.push({ line, command: c.name, reason: c.error!.message });
          continue;
        }
        const p = c.p;
        const cls = p.c.class as 'read' | 'write' | 'admin';
        counts[cls] = (counts[cls] ?? 0) + 1;
        if (p.c.confirm !== 'none') destructive++;
        if (!isMutating(p.c)) continue;
        changing++;
        const list = p.confirmSpec && p.c.confirm !== 'none' ? previews.destructive : previews.other;
        if (list.length < MAX_PREVIEWED) list.push(commandPreview(p.argv, p.c));
        lineSpec = STRONGER(lineSpec, p.confirmSpec);
      }
    } finally {
      global();
      mine();
    }
    // Checked again after the awaits, with no await before the job is registered.
    admit(scope);
    // One confirmation for the whole import: any change needs one; prod and stronger line rules raise it.
    let spec: ConfirmSpec | null = null;
    if (changing) {
      const summary = `Import ${lines.length.toLocaleString('en-US')} commands into ${scope.db.name}: ${changing.toLocaleString('en-US')} change data${destructive ? `, ${destructive.toLocaleString('en-US')} of them destructive` : ''}`;
      const preview = buildPreview([...previews.destructive, ...previews.other].slice(0, MAX_PREVIEWED), changing);
      spec = STRONGER(confirmationFor('confirm', true, scope.db, ctx.config.policy.prodRequiresReason, summary, preview), lineSpec);
      if (spec) {
        spec.summary = summary;
        spec.preview = preview;
      }
    }
    const id = randomBytes(12).toString('hex');
    const plan: ImportPlan = {
      id,
      ...(body.fileName ? { fileName: body.fileName.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 256) } : {}),
      total: lines.length,
      counts,
      destructive,
      blocked,
      confirmation: spec?.level ?? 'none',
      expiresAt: Date.now() + IMPORT_PLAN_TTL_MS,
    };
    const chunks = Math.ceil(lines.length / IMPORT_CHUNK_SIZE);
    jobs.set(id, {
      plan,
      status: { id, state: 'planned', total: lines.length, processed: 0, succeeded: 0, failed: 0, skipped: 0, chunks: { size: IMPORT_CHUNK_SIZE, done: 0, total: chunks }, failures: [] },
      sessionHash: scope.session.idHash,
      userId: scope.session.userId,
      databaseId: scope.db.id,
      items,
      table,
      spec,
      abort: new AbortController(),
    });
    audit(ctx, req, { action: 'import.plan', outcome: 'allowed', databaseId: scope.db.id, command: 'IMPORT', argvRedacted: [`<${lines.length} commands>`], detail: `read=${counts.read} write=${counts.write} admin=${counts.admin} blocked=${counts.blocked}` });
    return plan;
  });

  app.post('/api/v1/databases/:db/import/:id/start', { bodyLimit: 64 * 1024 }, async (req): Promise<ImportStatus> => {
    const scope = dbScope(ctx, req, 'operator');
    rateLimit(ctx, req, 'import-start', 2, 6);
    const body = parse(zImportStart, req.body ?? {});
    const job = find(req, scope);
    if (job.status.state !== 'planned' || !job.items) throw new HttpError('validation', 'This import has already started; plan the file again to rerun it.');
    const base: AuditBase = { action: 'import.start', databaseId: scope.db.id, command: 'IMPORT', argvRedacted: [`<${job.plan.total} commands>`] };
    if (job.plan.counts.blocked && !body.skipBlocked) {
      throw new HttpError('validation', `${job.plan.counts.blocked.toLocaleString('en-US')} ${job.plan.counts.blocked === 1 ? 'line is' : 'lines are'} refused by the policy. Remove ${job.plan.counts.blocked === 1 ? 'it' : 'them'} from the file, or skip refused lines.`);
    }
    if (!sessionStillValid(ctx, scope.session)) throw new HttpError('unauthenticated', 'Your session ended or your account changed.');
    // The token covers this job and these options only.
    // Slots first, so a confirmation is never spent on an import that could not start.
    const own = ctx.slots.acquire(`import:${scope.session.userId}`, 1);
    if (!own) throw new HttpError('rate_limited', 'An import of yours is already running; wait for it to finish.');
    const global = ctx.slots.acquire('import:global', MAX_RUNNING_IMPORTS);
    if (!global) {
      own();
      throw new HttpError('rate_limited', `${MAX_RUNNING_IMPORTS} imports are running on this server; try again shortly.`);
    }
    const mine = () => {
      global();
      own();
    };
    let reason: string | undefined;
    try {
      ({ reason } = confirmOrThrow(ctx, req, scope, `import-start:${job.plan.id}`, req.body ?? {}, body.confirmation, job.spec, base));
    } catch (e) {
      mine();
      throw e;
    }
    job.status.state = 'running';
    job.status.startedAt = Date.now();
    audit(ctx, req, { ...base, outcome: 'allowed', reason, detail: `stopOnError=${body.stopOnError} skipBlocked=${body.skipBlocked}` });
    void runImport(req, scope, job, body, reason)
      .catch((e: unknown) => {
        // Unexpected failure of the job itself (not of a command): report it, run nothing more.
        job.status.state = 'failed';
        job.status.stopReason = `The import stopped: ${(e instanceof HttpError ? e : toHttpError(e)).message}`;
      })
      .finally(() => {
        job.items = null;
        job.finishedAt = Date.now();
        job.status.finishedAt = job.finishedAt;
        mine();
        // During shutdown the audit store may already be closed; the job's outcome must not become an unhandled error.
        if (ctx.state.shuttingDown) return;
        audit(ctx, req, {
          action: 'import.finish', outcome: job.status.state === 'done' ? 'allowed' : 'error', databaseId: scope.db.id, command: 'IMPORT', argvRedacted: [`<${job.plan.total} commands>`],
          // Counts only: a stop reason can carry error text, which stays with the user who ran the import.
          detail: `${job.status.state}: succeeded=${job.status.succeeded} failed=${job.status.failed} skipped=${job.status.skipped}`,
        });
      });
    return job.status;
  });

  app.get('/api/v1/databases/:db/import/:id', async (req): Promise<ImportStatus> => {
    const scope = dbScope(ctx, req, 'operator');
    rateLimit(ctx, req, 'import-status', 10, 20);
    return find(req, scope).status;
  });

  app.post('/api/v1/databases/:db/import/:id/cancel', { bodyLimit: 1024 }, async (req): Promise<ImportStatus> => {
    const scope = dbScope(ctx, req, 'operator');
    rateLimit(ctx, req, 'import-cancel', 5, 10);
    parse(zJobCancel, req.body ?? {});
    const job = find(req, scope);
    if (job.status.state === 'planned') {
      job.status.state = 'cancelled';
      job.status.stopReason = 'Cancelled before it started; nothing ran.';
      job.items = null;
      job.finishedAt = Date.now();
    } else if (job.status.state === 'running') job.abort.abort(new Error('cancelled by the user'));
    return job.status;
  });

  async function runImport(req: FastifyRequest, scope: DbScope, job: Job, opts: { stopOnError: boolean }, reason: string | undefined): Promise<void> {
    const items = job.items!;
    const st = job.status;
    const signal = job.abort.signal;
    const deadline = Date.now() + IMPORT_MAX_MS;
    // The job outlives the start request: its commands follow the job's signal (cancel aborts the one in flight),
    // except a command that set its own: a graph query keeps its socket until FalkorDB answers, so its slots stay held
    // after a cancel (review v0.4 r3 graph M1).
    const jobScope: DbScope = {
      ...scope,
      conn: async () => {
        const c = await scope.conn();
        return { ...c, send: (args, o = {}) => c.send(args, 'signal' in o ? o : { ...o, signal }) };
      },
    };
    const groups = new Map<string, ImportFailureGroup>();
    const fail = (it: Item, name: string, error: ApiError['error']) => {
      const k = `${name}\n${error.code}`;
      let g = groups.get(k);
      if (!g) {
        if (groups.size >= MAX_FAILURE_GROUPS) return;
        g = { command: name, code: error.code, message: error.message.slice(0, 500), count: 0, lines: [] };
        groups.set(k, g);
      }
      g.count++;
      if (g.lines.length < 20) g.lines.push(it.line);
      st.failures = [...groups.values()].sort((a, b) => b.count - a.count);
    };
    // Blocking commands share the workbench's time budget (each still waits at most 5 s): once it is used, later
    // blocking lines are not sent (review v0.2.1 F4).
    const blockingBudgetMs = ctx.config.policy.workbenchBudgetMs;
    let blockingMs = 0;
    const end = (state: ImportStatus['state'], why: string | undefined, from: number) => {
      st.state = state;
      if (why) st.stopReason = why;
      st.skipped += items.length - from;
    };
    for (let i = 0; i < items.length; i++) {
      if (i > 0 && i % IMPORT_CHUNK_SIZE === 0) {
        st.chunks.done++;
        await yieldNow();
      }
      if (signal.aborted) return end('cancelled', 'Cancelled; the remaining commands were not sent.', i);
      if (!sessionStillValid(ctx, scope.session)) return end('failed', 'Your session ended or your account changed; the remaining commands were not sent.', i);
      if (Date.now() > deadline) return end('stopped', `The import time budget (${IMPORT_MAX_MS / 60_000} minutes) ran out; the remaining commands were not sent.`, i);
      const it = items[i]!;
      // The same check as when it was planned (same role, database and command table), so the same verdict.
      const c = check(scope, job.table, it.text);
      const known = !c.name.includes('<unknown');
      if (!it.ok) {
        // Refused by the policy and explicitly skipped (skipBlocked): audited like a refused workbench line.
        st.skipped++;
        if (c.base) {
          const error = c.error ?? { code: 'forbidden', message: 'Refused by the policy when the import was planned.' };
          audit(ctx, req, { ...c.base, outcome: 'denied', detail: failureDetail(error.code, error.message, known) });
        }
        continue;
      }
      // `notSent`: refused before anything went to Redis, audited as denied.
      let outcome: { ok: true; err?: string } | { ok: false; he: HttpError; notSent?: true };
      if (!c.p) outcome = { ok: false, he: new HttpError(c.error!.code, c.error!.message), notSent: true };
      else if (c.p.c.blocking && blockingMs >= blockingBudgetMs) {
        outcome = { ok: false, he: new HttpError('timeout', `Blocking commands may wait at most ${blockingBudgetMs} ms in total in one import (the workbench time budget); this command was not sent.`), notSent: true };
      } else {
        const started = Date.now();
        for (let attempt = 0; ; attempt++) {
          // Cancelled while waiting to retry: the line is not sent (a graph line would not see the signal itself).
          if (signal.aborted) {
            outcome = { ok: false, he: new HttpError('unavailable', CANCELLED_NOT_SENT), notSent: true };
            break;
          }
          try {
            const r = await execute(ctx, jobScope, c.p, signal);
            outcome = r.reply.t === 'err' ? { ok: true, err: r.reply.v } : { ok: true };
          } catch (e) {
            const he = e instanceof HttpError ? e : toHttpError(e);
            // The console's own per-user command slots are busy: wait briefly instead of failing the line.
            if (he.code === 'rate_limited' && attempt < 20 && !signal.aborted) {
              await sleep(250, signal);
              continue;
            }
            // Every rate_limited refusal (a graph slot, the pool gate, the command budget) comes before anything is
            // sent (review v0.4 r4 graph L2).
            outcome = he.code === 'rate_limited' ? { ok: false, he, notSent: true } : { ok: false, he };
          }
          break;
        }
        if (c.p.c.blocking) blockingMs += Date.now() - started;
      }
      // Cancelled while this line waited to be sent: it was not run.
      if (signal.aborted && !outcome.ok && outcome.notSent && c.p) return end('cancelled', 'Cancelled; the remaining commands were not sent.', i);
      if (signal.aborted && !outcome.ok && !outcome.notSent && outcome.he.code !== 'unauthenticated') {
        // Aborted while in flight: Redis may have run it.
        st.inFlightLine = it.line;
        audit(ctx, req, { ...c.base!, outcome: 'error', reason, detail: 'cancelled while in flight' });
        return end('cancelled', `Cancelled while line ${it.line} was running (it may have run); the remaining commands were not sent.`, i + 1);
      }
      st.processed++;
      if (outcome.ok && outcome.err === undefined) {
        st.succeeded++;
        audit(ctx, req, { ...c.base!, outcome: 'allowed', reason });
        continue;
      }
      st.failed++;
      const error: ApiError['error'] = outcome.ok ? { code: 'redis_error', message: outcome.err! } : outcome.he.toBody().error;
      if (c.base) audit(ctx, req, { ...c.base, outcome: !outcome.ok && (outcome.notSent || outcome.he.code === 'unauthenticated') ? 'denied' : 'error', detail: failureDetail(error.code, error.message, known) });
      fail(it, c.name, error);
      if (!outcome.ok && outcome.he.code === 'unauthenticated') return end('failed', 'Your session ended or your account changed; the remaining commands were not sent.', i + 1);
      if (opts.stopOnError) return end('stopped', `Stopped at the first failure (line ${it.line}); the remaining commands were not sent.`, i + 1);
    }
    st.chunks.done = st.chunks.total;
    // Cancelled while the last line ran and Redis answered it (a graph query is never aborted; review v0.4 r4 graph L1).
    if (signal.aborted) return end('cancelled', `Cancelled while line ${items.at(-1)!.line} was running; it finished and is counted above.`, items.length);
    st.state = 'done';
  }
}
