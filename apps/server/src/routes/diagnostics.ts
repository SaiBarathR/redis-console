import type { FastifyInstance } from 'fastify';
import {
  binFromBytes,
  zAnalysisRequest,
  zClientKill,
  zSlowlogQuery,
  type AnalysisReport,
  type ClientInfo,
  type ClientsResponse,
  type OkResponse,
  type SlowlogConfigResponse,
  type SlowlogEntry,
  type SlowlogResponse,
} from '@rconsole/shared';
import { failureDetail } from '../audit.ts';
import { audit, dbScope, parse, type AppContext } from '../context.ts';
import { HttpError } from '../http/errors.ts';
import { auditDenied, auditedRead, confirmOrThrow } from '../policy/enforce.ts';
import { allowedFor, authorize, classify, confirmationFor } from '../policy/policy.ts';
import { buildPreview, previewCommand } from '../policy/preview.ts';
import { HIDDEN } from '../policy/redactReply.ts';
import { run, toHttpError } from '../redis/exec.ts';
import { TM_STR, type Conn, type Target } from '../redis/manager.ts';
import { asNum, asStr } from '../redis/reply.ts';
import { replyTooLarge } from '../redis/resp.ts';
import { analysisSlots, analyze, registerAnalysisJobRoutes } from './analysis.ts';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function parseClientList(text: string): ClientInfo[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 10_000)
    .map((line) => {
      const f: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const part of line.split(' ')) {
        const i = part.indexOf('=');
        if (i > 0) f[part.slice(0, i)] = part.slice(i + 1);
      }
      return {
        id: f.id ?? '',
        addr: f.addr ?? '',
        name: f.name ?? '',
        age: Number(f.age ?? 0),
        idle: Number(f.idle ?? 0),
        db: Number(f.db ?? 0),
        cmd: f.cmd ?? '',
        user: f.user ?? '',
        flags: f.flags ?? '',
      };
    });
}

export function registerDiagnosticsRoutes(app: FastifyInstance, ctx: AppContext) {
  const { policy } = ctx.config;

  // Slow log entries carry other clients' command arguments (key names, values): audited like any data read
  // (review v0.2 round 2, R2-M4), with counts only.
  app.get('/api/v1/databases/:db/slowlog', async (req): Promise<SlowlogResponse> => {
    const scope = dbScope(ctx, req);
    const q = parse(zSlowlogQuery, req.query);
    const base = { action: 'slowlog.read', databaseId: scope.db.id, command: 'SLOWLOG GET', argvRedacted: ['SLOWLOG', 'GET', `<${String(q.count).length} bytes>`] };
    return auditedRead(ctx, req, base, async () => {
      const conn = await scope.conn();
      const nodes = await conn.primaries();
      const entries: SlowlogEntry[] = [];
      let len = 0;
      for (const t of nodes) {
        const raw = await run<unknown[][]>(t, ['SLOWLOG', 'GET', String(q.count)], { typeMapping: TM_STR });
        // SLOWLOG LEN may be denied by the viewer ACL; fall back to the number of entries returned.
        len += await t.send(['SLOWLOG', 'LEN']).then(asNum, () => (raw ?? []).length);
        for (const e of raw ?? []) {
          const argv = (Array.isArray(e[3]) ? e[3] : []).slice(0, 32).map((a) => clip(asStr(a), 200));
          const entry: SlowlogEntry = { id: asNum(e[0]), timestamp: asNum(e[1]), durationMicros: asNum(e[2]), argv };
          // Client "ip:port": hidden from non-admins like every other network address.
          if (e[4] !== undefined) entry.client = scope.role === 'admin' ? asStr(e[4]) : HIDDEN;
          if (e[5] !== undefined && asStr(e[5])) entry.clientName = asStr(e[5]);
          entries.push(entry);
        }
      }
      entries.sort((a, b) => b.timestamp - a.timestamp || b.id - a.id);
      return { entries: entries.slice(0, q.count), len };
    }, (r) => `entries=${r.entries.length} len=${r.len}`);
  });

  app.post('/api/v1/databases/:db/slowlog/reset', { bodyLimit: 64 * 1024 }, async (req): Promise<OkResponse> => {
    const scope = dbScope(ctx, req);
    const body = parse(zConfirmOnly, req.body ?? {});
    const base = { action: 'slowlog.reset', databaseId: scope.db.id, command: 'SLOWLOG RESET', argvRedacted: ['SLOWLOG', 'RESET'] };
    try {
      const c = classify(['SLOWLOG', 'RESET'], undefined);
      authorize(c, scope);
      const spec = confirmationFor(c.confirm, true, scope.db, policy.prodRequiresReason, `Reset the slow log of ${scope.db.name}`, buildPreview([previewCommand(['SLOWLOG', 'RESET'], 2)]));
      const { reason } = confirmOrThrow(ctx, req, scope, 'slowlog-reset', req.body ?? {}, body.confirmation, spec, base);
      const conn = await scope.conn();
      for (const t of await conn.primaries()) await run(t, ['SLOWLOG', 'RESET']);
      audit(ctx, req, { ...base, outcome: 'allowed', reason });
      return { ok: true };
    } catch (e) {
      auditDenied(ctx, req, base, e);
    }
  });

  // The real slow log threshold and length (F19). CONFIG GET is an admin-class read; the server asks for exactly
  // these two parameters, so no other configuration value (passwords, file paths) can be read through this route.
  app.get('/api/v1/databases/:db/slowlog/config', async (req): Promise<SlowlogConfigResponse> => {
    const scope = dbScope(ctx, req);
    const verdict = allowedFor(classify(['CONFIG', 'GET'], undefined), scope);
    if (!verdict.allowed) {
      return { available: false, reason: `Reading the server configuration needs the admin role on this database (your role here is ${scope.role}).` };
    }
    const base = { action: 'slowlog.config', databaseId: scope.db.id, command: 'CONFIG GET', argvRedacted: ['CONFIG', 'GET', 'slowlog-log-slower-than', 'slowlog-max-len'] };
    try {
      const conn = await scope.conn();
      const [first] = await conn.primaries();
      const read = async (name: string) => {
        const raw = await run<unknown>(first ?? conn, ['CONFIG', 'GET', name], { typeMapping: TM_STR, timeout: 5000 });
        const flat = Array.isArray(raw) ? raw.map(asStr) : [];
        const i = flat.findIndex((v, j) => j % 2 === 0 && v.toLowerCase() === name);
        const n = i >= 0 ? Number(flat[i + 1]) : NaN;
        if (!Number.isFinite(n)) throw new HttpError('redis_error', `The server did not report ${name}.`);
        return n;
      };
      const out: SlowlogConfigResponse = { available: true, slowerThanMicros: await read('slowlog-log-slower-than'), maxLen: await read('slowlog-max-len') };
      audit(ctx, req, { ...base, outcome: 'allowed' });
      return out;
    } catch (e) {
      const he = e instanceof HttpError ? e : toHttpError(e);
      // A Redis ACL that denies CONFIG GET (or a managed service that renames it) is an explanation, not a failure.
      if (he.code === 'forbidden' || he.code === 'redis_error') {
        audit(ctx, req, { ...base, outcome: he.code === 'forbidden' ? 'denied' : 'error', detail: failureDetail(he.code, he.message) });
        return { available: false, reason: he.code === 'forbidden' ? 'The Redis ACL user for your role may not run CONFIG GET.' : 'The server did not answer CONFIG GET for the slow log settings.' };
      }
      auditDenied(ctx, req, base, he);
    }
  });

  app.get('/api/v1/databases/:db/clients', async (req): Promise<ClientsResponse> => {
    const scope = dbScope(ctx, req);
    const c = classify(['CLIENT', 'LIST'], undefined);
    authorize(c, scope);
    const conn = await scope.conn();
    const clients: ClientInfo[] = [];
    for (const t of await conn.primaries()) clients.push(...parseClientList(asStr(await run(t, ['CLIENT', 'LIST'], { typeMapping: TM_STR }))));
    return { clients };
  });

  app.post('/api/v1/databases/:db/clients/kill', { bodyLimit: 64 * 1024 }, async (req): Promise<OkResponse> => {
    const scope = dbScope(ctx, req);
    const body = parse(zClientKill, req.body);
    const base = { action: 'client.kill', databaseId: scope.db.id, command: 'CLIENT KILL', argvRedacted: ['CLIENT', 'KILL', 'ID', `<${body.id.length} bytes>`] };
    try {
      const c = classify(['CLIENT', 'KILL'], undefined);
      authorize(c, scope);
      const spec = confirmationFor(c.confirm, true, scope.db, policy.prodRequiresReason, `Disconnect client ${body.id} from ${scope.db.name}`, buildPreview([previewCommand(['CLIENT', 'KILL', 'ID', body.id], 2)]));
      const { reason } = confirmOrThrow(ctx, req, scope, 'client-kill', req.body, body.confirmation, spec, base);
      const conn = await scope.conn();
      let killed = 0;
      for (const t of await conn.primaries()) killed += asNum(await run(t, ['CLIENT', 'KILL', 'ID', body.id]));
      if (!killed) throw new HttpError('not_found', 'No such client.');
      audit(ctx, req, { ...base, outcome: 'allowed', reason, detail: `client id ${body.id}` });
      return { ok: true };
    } catch (e) {
      auditDenied(ctx, req, base, e);
    }
  });

  app.post('/api/v1/databases/:db/analysis', { bodyLimit: 64 * 1024 }, async (req): Promise<AnalysisReport> => {
    const scope = dbScope(ctx, req);
    const body = parse(zAnalysisRequest, req.body ?? {});
    const release = analysisSlots(ctx, scope.session.userId);
    try {
      const conn = await scope.conn();
      const report = await analyze(conn, body, policy.analysisMaxMs, policy.maxReadReplyBytes);
      audit(ctx, req, { action: 'analysis.run', outcome: 'allowed', databaseId: scope.db.id, detail: `sampled ${report.sampled} keys in ${report.durationMs} ms` });
      return report;
    } finally {
      release();
    }
  });
  // v0.2.1: analysis jobs with progress and cancellation (routes/analysis.ts).
  registerAnalysisJobRoutes(app, ctx);
}

const zConfirmOnly = zClientKill.pick({ confirmation: true }).strict();
