import { ErrorReply } from 'redis';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  GRAPH_QUERY_COMMANDS,
  bytesFromBin,
  tokenizeCommandLine,
  tokenizeCommandLineBytes,
  zCliRequest,
  zWorkbenchCancel,
  zWorkbenchRequest,
  type ApiError,
  type CliResponse,
  type CommandArg,
  type CommandDoc,
  type CommandsResponse,
  type Confirmation,
  type WorkbenchCancelResponse,
  type WorkbenchResponse,
} from '@rconsole/shared';
import { audit, dbScope, parse, rateLimit, sessionStillValid, type AppContext, type DbScope } from '../context.ts';
import { failureDetail, redactArgv } from '../audit.ts';
import { HttpError } from '../http/errors.ts';
import { abortWhenClientGone } from '../http/clientGone.ts';
import { auditDenied, confirmOrThrow } from '../policy/enforce.ts';
import { allowedFor, applyCaps, auditName, authorize, classify, confirmationFor, isMutating, timeoutFor, type Classified, type ConfirmSpec } from '../policy/policy.ts';
import type { CommandTable } from '../policy/commandTable.ts';
import { buildPreview, previewCommand } from '../policy/preview.ts';
import { redactReply, slowlogArgv } from '../policy/redactReply.ts';
import { isErrorReply, toHttpError } from '../redis/exec.ts';
import { METADATA_REPLY_BYTES, TM_STR, sanitizeRedisError, type Arg } from '../redis/manager.ts';
import { PAIR_MAP_COMMANDS, TM_REPLY, TM_REPLY_PAIRS, asStr, toReply } from '../redis/reply.ts';

const MAX_WORKBENCH_COMMANDS = 100;
/** A workbench response holds at most this many x maxReplyBytes of results; later lines are not run (review M2). */
export const WORKBENCH_OUTPUT_FACTOR = 4;
/** Workbench scripts running at once: per user, and across the server (each holds its results in memory). */
export const MAX_WORKBENCH_PER_USER = 1;
export const MAX_WORKBENCH_GLOBAL = 16;
const clipLine = (l: string) => (l.length > 200 ? `${l.slice(0, 200)}…` : l);

function echo(argv: Arg[]): string[] {
  return argv.slice(0, 100).map((a) => {
    const s = typeof a === 'string' ? a : a.toString('utf8');
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  });
}

export interface Prepared {
  argv: Buffer[];
  c: Classified;
  confirmSpec: ConfirmSpec | null;
}

/** Tokenize, classify and authorize one command. Throws HttpError on policy failures. */
export function prepare(argv: Buffer[], table: CommandTable | undefined, scope: DbScope, ctx: AppContext): Prepared {
  if (!argv.length) throw new HttpError('validation', 'Empty command.');
  const c = classify(argv, table);
  authorize(c, scope);
  // Before any confirmation, and in an import's plan (review v0.4 r4 graph L3); executeGraph checks again.
  if (GRAPH_QUERY_COMMANDS.has(c.command) && scope.db.poolSize < 2) throw new HttpError('validation', GRAPH_POOL_TOO_SMALL);
  const capped = applyCaps(argv).map((a) => (typeof a === 'string' ? Buffer.from(a) : a));
  // The preview is built from the capped argv: exactly what will be sent to Redis.
  const preview = buildPreview([commandPreview(capped, c)]);
  const confirmSpec = confirmationFor(c.confirm, isMutating(c), scope.db, ctx.config.policy.prodRequiresReason, `${c.name} on ${scope.db.name}`, preview);
  return { argv: capped, c, confirmSpec };
}

/**
 * A console, Workbench or Import command's confirmation preview: names, keys and a short prefix of other arguments,
 * and a graph query's Cypher (argv[2]) whole up to PREVIEW_QUERY_MAX_BYTES (review v0.4 r2 graph M1, r3 M2).
 */
export function commandPreview(argv: readonly Buffer[], c: Classified) {
  return previewCommand(argv, c.keep, c.keyIndexes, [], GRAPH_QUERY_COMMANDS.has(c.command) ? [2] : []);
}

/** Concurrent console commands per user, and concurrent blocking commands per user. */
export const MAX_INFLIGHT_PER_USER = 4;
export const MAX_BLOCKING_PER_USER = 1;
/**
 * v0.4 graph (review v0.4 r2 graph H2): FalkorDB checks a query's TIMEOUT between steps, so one expression (a `reduce`
 * over a long `range`) can run for seconds or minutes after the console has answered, and closing the socket does not
 * stop it. The console cannot cancel it, so it stops adding work: a graph query holds one slot per user and one of
 * GRAPH_ENGINE_SLOTS_PER_DB per database entry until the engine answers (its socket stays open, at most
 * GRAPH_ENGINE_HOLD_MS). A held query keeps a pooled connection, so never more than `poolSize - 1` of them, and none on a
 * pool of one (review v0.4 r3 graph L2): one long query must not take every connection of a tier.
 */
export const GRAPH_ENGINE_SLOTS_PER_DB = 2;
export const CANCELLED_NOT_SENT = 'Cancelled before it was sent; it did not run.';
const GRAPH_POOL_TOO_SMALL = 'Graph queries need a connection pool of at least 2 on this database (poolSize), so that a long-running query cannot hold every connection.';
export const GRAPH_ENGINE_HOLD_MS = 15 * 60_000;

export async function execute(ctx: AppContext, scope: DbScope, p: Prepared, signal?: AbortSignal): Promise<CliResponse> {
  // Cancelled before it started (an Import's retry wait, for one): nothing is sent. A graph query does not carry the
  // signal to its socket, so this is the only check it gets (review v0.4 r4 graph, Import retry).
  if (signal?.aborted) throw new HttpError('unavailable', CANCELLED_NOT_SENT);
  if (GRAPH_QUERY_COMMANDS.has(p.c.command)) return executeGraph(ctx, scope, p);
  // Blocking commands hold a pooled connection for up to 5 s; without a cap one user could park every
  // connection of a (database, tier) pool and stall everyone else on it.
  const uid = scope.session.userId;
  const inflight = ctx.slots.acquire(`cli:${uid}`, MAX_INFLIGHT_PER_USER);
  if (!inflight) throw new HttpError('rate_limited', `At most ${MAX_INFLIGHT_PER_USER} console commands can run at once.`);
  const blocking = p.c.blocking ? ctx.slots.acquire(`cli-blocking:${uid}`, MAX_BLOCKING_PER_USER) : () => {};
  if (!blocking) {
    inflight();
    throw new HttpError('rate_limited', 'Only one blocking command can run at a time.');
  }
  try {
    return await executeNow(ctx, scope, p, signal);
  } finally {
    blocking();
    inflight();
  }
}

/** A graph query (see GRAPH_ENGINE_SLOTS_PER_DB): answered within the console timeout, its slots held until FalkorDB answers. */
async function executeGraph(ctx: AppContext, scope: DbScope, p: Prepared): Promise<CliResponse> {
  const uid = scope.session.userId;
  const mine = ctx.slots.acquire(`graph-engine:${scope.db.id}:${uid}`, 1);
  if (!mine) throw new HttpError('rate_limited', 'Your previous graph query is still running in FalkorDB; run the next one when it has finished.');
  const perDb = Math.min(GRAPH_ENGINE_SLOTS_PER_DB, scope.db.poolSize - 1);
  if (perDb < 1) {
    mine();
    throw new HttpError('validation', GRAPH_POOL_TOO_SMALL);
  }
  const db = ctx.slots.acquire(`graph-engine:${scope.db.id}`, perDb);
  if (!db) {
    mine();
    throw new HttpError('rate_limited', `FalkorDB is still running ${perDb} console ${perDb === 1 ? 'query' : 'queries'} on this database; try again when one has finished.`);
  }
  // No abort signal and a long transport timeout: the socket stays open until the engine answers, so the slots
  // free when the work does. The request itself is answered within the console timeout.
  const run = executeNow(ctx, scope, p, undefined, GRAPH_ENGINE_HOLD_MS);
  const release = () => { db(); mine(); };
  run.then(release, release);
  const answerMs = timeoutFor(p.c, ctx.config.policy.commandTimeoutMs);
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError('timeout', `FalkorDB is still running this query: its time limit is checked between steps, so one expression can run longer. Your graph slot stays taken until it finishes (at most ${GRAPH_ENGINE_HOLD_MS / 60_000} minutes).`)), answerMs);
  });
  try {
    return await Promise.race([run, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function executeNow(ctx: AppContext, scope: DbScope, p: Prepared, signal?: AbortSignal, timeoutMs?: number): Promise<CliResponse> {
  const conn = await scope.conn();
  const { maxReplyBytes, commandTimeoutMs } = ctx.config.policy;
  const pairs = PAIR_MAP_COMMANDS.has(p.c.command);
  let raw: unknown;
  let durationMs = 0;
  {
    const start = performance.now();
    try {
      raw = await conn.send(p.argv, {
        capped: true, signal,
        key: p.argv[p.c.keyIndexes[0] ?? -1],
        readonly: p.c.class === 'read',
        timeout: timeoutMs ?? timeoutFor(p.c, commandTimeoutMs),
        typeMapping: pairs ? TM_REPLY_PAIRS : TM_REPLY,
      });
    } catch (e) {
      if (!isErrorReply(e)) throw toHttpError(e);
      raw = new ErrorReply(sanitizeRedisError(e));
    }
    durationMs = Math.round((performance.now() - start) * 1000) / 1000;
  }
  // Slow-log arguments are other users' data: non-admins see command names and keys only (review v0.4 r2 graph M2).
  const table = p.c.command === 'SLOWLOG' && scope.role !== 'admin' ? await scope.table().catch(() => undefined) : undefined;
  const reply = redactReply(p.c.command, p.c.subcommand, toReply(raw, { maxBytes: ctx.config.policy.maxReplyBytes, maxElements: 10_000 }, { pairs }), {
    hideAddresses: scope.role !== 'admin',
    ...(scope.role !== 'admin' ? { slowlogArgs: (argv: string[]) => slowlogArgv(argv, classify(argv, table)) } : {}),
  });
  return { argv: echo(p.argv), commandClass: p.c.class, durationMs, reply };
}

function argvFromRequest(body: { line?: string | undefined; argv?: string[] | undefined; argvBin?: { enc: 'utf8' | 'base64'; data: string }[] | undefined }): Buffer[] {
  if (body.line !== undefined) {
    try {
      return tokenizeCommandLineBytes(body.line).map((u) => Buffer.from(u));
    } catch (e) {
      throw new HttpError('validation', (e as Error).message);
    }
  }
  if (body.argv) return body.argv.map((s) => Buffer.from(s));
  return body.argvBin!.map((x) => Buffer.from(bytesFromBin(x)));
}

export function auditBase(scope: DbScope, p: Pick<Prepared, 'argv' | 'c'>, action: string, table: CommandTable | undefined) {
  const name = auditName(p.c, table);
  const red = redactArgv(p.argv, name.keep, name.keep ? p.c.keyIndexes : []);
  return { action, databaseId: scope.db.id, command: name.command, argvRedacted: red.argv, keyCount: red.keyCount };
}

/** Workbench script lines: non-empty, not comments (# or //). */
export function scriptLines(script: string): string[] {
  return script
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
}

export const STRONGER = (a: ConfirmSpec | null, b: ConfirmSpec | null): ConfirmSpec | null => {
  if (!a) return b;
  if (!b) return a;
  const level = a.level === 'typed' || b.level === 'typed' ? 'typed' : 'confirm';
  const out: ConfirmSpec = { level, reasonRequired: a.reasonRequired || b.reasonRequired, summary: a.summary, preview: a.preview };
  const exp = a.expectedText ?? b.expectedText;
  if (level === 'typed' && exp !== undefined) out.expectedText = exp;
  return out;
};

export function registerCliRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/api/v1/databases/:db/cli', async (req, reply): Promise<CliResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'cli', 20, 20);
    const body = parse(zCliRequest, req.body);
    const argv = argvFromRequest(body);
    const table = await scope.table().catch(() => undefined);
    const pre = { argv, c: classify(argv, table) };
    const base = auditBase(scope, pre, 'cli.exec', table);
    try {
      const p = prepare(argv, table, scope, ctx);
      const { reason } = confirmOrThrow(ctx, req, scope, 'cli', req.body, body.confirmation, p.confirmSpec, base);
      const stop = new AbortController();
      abortWhenClientGone(reply, stop);
      const res = await execute(ctx, scope, p, stop.signal);
      audit(ctx, req, { ...base, outcome: res.reply.t === 'err' ? 'error' : 'allowed', reason, ...(res.reply.t === 'err' ? { detail: failureDetail('redis_error', res.reply.v) } : {}) });
      return res;
    } catch (e) {
      auditDenied(ctx, req, base, e);
    }
  });

  /** The running script of each (session, database), so the session can cancel it before its next line. */
  const running = new Map<string, AbortController>();
  const runKey = (scope: DbScope) => `${scope.session.idHash}:${scope.db.id}`;

  app.post('/api/v1/databases/:db/workbench', { bodyLimit: 1024 * 1024 }, async (req, reply): Promise<WorkbenchResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'workbench', 2, 4);
    const body = parse(zWorkbenchRequest, req.body);
    const lines = scriptLines(body.script);
    if (lines.length > MAX_WORKBENCH_COMMANDS) throw new HttpError('validation', `A workbench script may contain at most ${MAX_WORKBENCH_COMMANDS} commands.`);
    if (!lines.length) return { results: [] };
    const mine = ctx.slots.acquire(`workbench:${scope.session.userId}`, MAX_WORKBENCH_PER_USER);
    if (!mine) throw new HttpError('rate_limited', 'A workbench script of yours is still running; wait for it to finish.');
    const global = ctx.slots.acquire('workbench:global', MAX_WORKBENCH_GLOBAL);
    if (!global) {
      mine();
      throw new HttpError('rate_limited', 'Too many workbench scripts are running; try again shortly.');
    }
    // Cancelled by the user (…/workbench/cancel) or by the client going away: no further line is sent.
    const stop = new AbortController();
    const key = runKey(scope);
    running.set(key, stop);
    abortWhenClientGone(reply, stop);
    let inFlight: Promise<unknown> | undefined;
    try {
      const run = await runWorkbench(req, scope, body, lines, stop.signal);
      inFlight = run.inFlight;
      return run.response;
    } finally {
      if (running.get(key) === stop) running.delete(key);
      // A line cancelled while running still holds the script's slots until Redis answers it.
      const release = () => {
        global();
        mine();
      };
      if (inFlight) void inFlight.finally(release);
      else release();
    }
  });

  app.post('/api/v1/databases/:db/workbench/cancel', { bodyLimit: 1024 }, async (req): Promise<WorkbenchCancelResponse> => {
    const scope = dbScope(ctx, req);
    rateLimit(ctx, req, 'workbench-cancel', 5, 10);
    parse(zWorkbenchCancel, req.body ?? {});
    const run = running.get(runKey(scope));
    if (!run || run.signal.aborted) return { cancelled: false };
    run.abort(new Error('cancelled by the user'));
    return { cancelled: true };
  });

  async function runWorkbench(
    req: FastifyRequest,
    scope: DbScope,
    body: { stopOnError: boolean; confirmation?: Confirmation | undefined },
    lines: string[],
    signal: AbortSignal,
  ): Promise<{ response: WorkbenchResponse; inFlight?: Promise<unknown> }> {
    const table = await scope.table().catch(() => undefined);

    // Pass 1: tokenize + policy for every line; collect the strongest confirmation needed.
    type Item = { line: string; p?: Prepared; error?: ApiError['error']; base?: ReturnType<typeof auditBase> };
    const items: Item[] = lines.map((line) => {
      let argv: Buffer[];
      try {
        argv = tokenizeCommandLineBytes(line).map((u) => Buffer.from(u));
      } catch (e) {
        return { line, error: { code: 'validation', message: (e as Error).message } };
      }
      const base = auditBase(scope, { argv, c: classify(argv, table) }, 'workbench.exec', table);
      try {
        return { line, p: prepare(argv, table, scope, ctx), base };
      } catch (e) {
        const he = e instanceof HttpError ? e : toHttpError(e);
        return { line, error: he.toBody().error, base };
      }
    });
    let spec: ConfirmSpec | null = null;
    for (const it of items) if (it.p) spec = STRONGER(spec, it.p.confirmSpec);
    if (spec) {
      // Every line that needs confirmation, in execution order (the token covers the whole script).
      const confirmed = items.filter((i) => i.p?.confirmSpec).flatMap((i) => i.p!.confirmSpec!.preview.commands);
      spec.summary = `Run a workbench script on ${scope.db.name} with ${confirmed.length === 1 ? '1 command that needs' : `${confirmed.length} commands that need`} confirmation`;
      spec.preview = buildPreview(confirmed);
    }
    const { reason } = confirmOrThrow(ctx, req, scope, 'workbench', req.body, body.confirmation, spec, {
      action: 'workbench.exec', databaseId: scope.db.id, command: 'WORKBENCH', argvRedacted: [`<${lines.length} commands>`],
    });

    // Pass 2: execute sequentially, within a total time budget.
    const results: WorkbenchResponse['results'] = [];
    const deadline = Date.now() + ctx.config.policy.workbenchBudgetMs;
    const outputBudget = ctx.config.policy.maxReplyBytes * WORKBENCH_OUTPUT_FACTOR;
    let output = 0;
    const push = (r: WorkbenchResponse['results'][number]) => {
      results.push(r);
      output += Buffer.byteLength(JSON.stringify(r));
    };
    let revoked = false;
    const cancelled = new Promise<'cancelled'>((resolve) => signal.addEventListener('abort', () => resolve('cancelled'), { once: true }));
    for (const it of items) {
      // Cancelled (or the client went away) after the previous line: nothing more is sent (console review H1).
      if (signal.aborted) return { response: { results, cancelled: { inFlight: false } } };
      if (output > outputBudget) {
        results.push({ line: clipLine(it.line), error: { code: 'too_large', message: `Workbench output budget (${outputBudget} bytes) used up; this command was not run.` } });
        continue;
      }
      // The user may have been disabled, demoted or signed out while earlier lines ran: send nothing more.
      if (!revoked && !sessionStillValid(ctx, scope.session)) revoked = true;
      if (revoked) {
        results.push({ line: clipLine(it.line), error: { code: 'unauthenticated', message: 'Your session ended or your account changed; the rest of the script was not run.' } });
        continue;
      }
      if (!it.error && Date.now() >= deadline) {
        it.error = { code: 'timeout', message: `Workbench time budget (${ctx.config.policy.workbenchBudgetMs} ms) used up; this command was not run.` };
      }
      if (it.error) {
        if (it.base) audit(ctx, req, { ...it.base, outcome: 'denied', detail: failureDetail(it.error.code, it.error.message, !it.base.command.includes('<unknown')) });
        push({ line: it.line, error: it.error });
        if (body.stopOnError) break;
        continue;
      }
      // Audited when Redis answers, even if the script was cancelled while this line was running.
      const done = execute(ctx, scope, it.p!, signal).then(
        (r) => {
          const isErr = r.reply.t === 'err';
          audit(ctx, req, { ...it.base!, outcome: isErr ? 'error' : 'allowed', reason, ...(isErr && r.reply.t === 'err' ? { detail: failureDetail('redis_error', r.reply.v) } : {}) });
          return { r };
        },
        (e: unknown) => {
          const he = e instanceof HttpError ? e : toHttpError(e);
          audit(ctx, req, { ...it.base!, outcome: he.code === 'unauthenticated' ? 'denied' : 'error', detail: failureDetail(he.code, he.message, !it.base!.command.includes('<unknown')) });
          return { he };
        },
      );
      const outcome = await Promise.race([done, cancelled]);
      // Answer at once: this line was sent and may still run; later lines are not sent.
      if (outcome === 'cancelled') return { response: { results, cancelled: { inFlight: true } }, inFlight: done };
      if ('r' in outcome) {
        push(outcome.r);
        if (outcome.r.reply.t === 'err' && body.stopOnError) break;
      } else {
        push({ line: it.line, error: outcome.he.toBody().error });
        // Refused before it was sent: the account was revoked while this line waited for Redis (review v0.2 N1).
        if (outcome.he.code === 'unauthenticated') revoked = true;
        else if (body.stopOnError) break;
      }
    }
    return { response: { results } };
  }

  // Command docs (autocomplete), annotated with policy for the caller on this database.
  const docsCache = new Map<string, { at: number; docs: Omit<CommandDoc, 'class' | 'allowed' | 'hint'>[] }>();
  app.get('/api/v1/databases/:db/commands', async (req): Promise<CommandsResponse> => {
    const scope = dbScope(ctx, req);
    const conn = await scope.conn();
    let cached = docsCache.get(scope.db.id);
    if (!cached || Date.now() - cached.at > 30 * 60_000) {
      let raw: unknown;
      try {
        // Server metadata: a fixed cap, independent of a lowered data cap (review v0.2 r4 L2).
        raw = await conn.send(['COMMAND', 'DOCS'], { typeMapping: TM_STR, timeout: 10_000, maxBytes: METADATA_REPLY_BYTES });
      } catch (e) {
        throw toHttpError(e);
      }
      cached = { at: Date.now(), docs: parseDocs(raw) };
      docsCache.set(scope.db.id, cached);
    }
    const table = await scope.table().catch(() => undefined);
    const commands = cached.docs.map((d): CommandDoc => {
      const argv = d.name.split(' ');
      const c = classify(argv, table);
      const v = allowedFor(c, scope);
      const doc: CommandDoc = { ...d, class: c.class, allowed: v.allowed };
      let info = table?.get(argv[0]!.toLowerCase());
      for (const part of argv.slice(1)) info = info?.subcommands.get(part.toLowerCase());
      if (info?.keySpecs?.length) doc.keySpecs = info.keySpecs;
      const hint = c.hint ?? v.hint;
      if (hint) doc.hint = hint;
      return doc;
    });
    commands.sort((a, b) => a.name.localeCompare(b.name));
    return { commands };
  });
}

type Flat = unknown[];
const fields = (v: unknown): Record<string, unknown> => {
  const o: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  if (Array.isArray(v)) for (let i = 0; i + 1 < v.length; i += 2) o[asStr(v[i])] = v[i + 1];
  return o;
};

function parseArgs(v: unknown, depth = 0): CommandArg[] {
  if (!Array.isArray(v) || depth > 6) return [];
  return v.map((a) => {
    const f = fields(a);
    const flags = Array.isArray(f.flags) ? f.flags.map(asStr) : [];
    const arg: CommandArg = { name: asStr(f.name), type: asStr(f.type) };
    if (f.token !== undefined) arg.token = asStr(f.token);
    if (flags.includes('optional')) arg.optional = true;
    if (flags.includes('multiple')) arg.multiple = true;
    if (Array.isArray(f.arguments)) arg.arguments = parseArgs(f.arguments, depth + 1);
    return arg;
  });
}

export function parseDocs(raw: unknown): Omit<CommandDoc, 'class' | 'allowed' | 'hint'>[] {
  const out: Omit<CommandDoc, 'class' | 'allowed' | 'hint'>[] = [];
  const walk = (flat: Flat, parent?: string) => {
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const rawName = asStr(flat[i]);
      const f = fields(flat[i + 1]);
      const name = (parent ? rawName.split('|').pop()! : rawName).toUpperCase();
      const full = parent ? `${parent} ${name}` : name;
      const doc: Omit<CommandDoc, 'class' | 'allowed' | 'hint'> = { name: full, summary: asStr(f.summary), group: asStr(f.group), arguments: parseArgs(f.arguments) };
      if (f.since !== undefined) doc.since = asStr(f.since);
      if (f.complexity !== undefined) doc.complexity = asStr(f.complexity);
      out.push(doc);
      if (Array.isArray(f.subcommands)) walk(f.subcommands, full);
    }
  };
  if (Array.isArray(raw)) walk(raw);
  return out;
}

export { tokenizeCommandLine };
export type { FastifyRequest };
