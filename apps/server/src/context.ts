import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import { minRole, roleAtLeast, type Environment, type Me, type Role } from '@rconsole/shared';
import type { ZodType } from 'zod';
import type { AppConfig, DatabaseConfig } from './config.ts';
import type { AuditInput, AuditLog } from './audit.ts';
import type { Db } from './store/db.ts';
import type { Session, SessionStore } from './store/sessions.ts';
import type { UserRecord, UserStore } from './store/users.ts';
import type { Conn, RedisManager, Target } from './redis/manager.ts';
import type { CommandTable, CommandTables } from './policy/commandTable.ts';
import type { Confirmations } from './policy/confirm.ts';
import { clientNet, type RateLimiter, type Slots } from './security/ratelimit.ts';
import type { OidcService } from './auth/oidc.ts';
import type { StreamTickets } from './security/streamTickets.ts';
import type { BodyBudget } from './security/ingress.ts';
import { HttpError } from './http/errors.ts';

export type AuthMode = 'public' | 'pending' | 'session';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
    localUser: UserRecord | null;
    nonce: string;
    redisSignal: AbortSignal | null;
  }
  interface FastifyContextConfig {
    auth?: AuthMode;
    /** Minimum global role for the endpoint. */
    role?: Role;
    /** Reachable while the user must change password / enroll TOTP. */
    allowRestricted?: boolean;
  }
}

export interface AppContext {
  config: AppConfig;
  db: Db;
  sessions: SessionStore;
  users: UserStore;
  audit: AuditLog;
  redis: RedisManager;
  commandTables: CommandTables;
  confirmations: Confirmations;
  /** Single-use pub/sub stream subscriptions (channel names never travel in a URL). */
  pubsubTickets: StreamTickets<{ channels: string[]; patterns: string[] }>;
  limiter: RateLimiter;
  slots: Slots;
  /** Request bodies being received or handled (review v0.2 r6 H1). */
  ingress: BodyBudget;
  oidc: OidcService | undefined;
  log: FastifyBaseLogger;
  /** Close callbacks of open long-lived streams (SSE), run on shutdown. */
  streams: Set<() => void>;
  state: { shuttingDown: boolean };
  sessionCookie: string;
  loginLimits: { perIpPerSecond: number; perIpBurst: number };
}

export function requireSession(req: FastifyRequest): Session {
  if (!req.session || req.session.state !== 'active') throw new HttpError('unauthenticated', 'Not signed in.');
  return req.session;
}

export function audit(ctx: AppContext, req: FastifyRequest, e: Omit<AuditInput, 'userId' | 'username' | 'ip'> & Partial<Pick<AuditInput, 'userId' | 'username'>>) {
  return ctx.audit.record({
    userId: req.session?.userId ?? 'anonymous',
    username: req.session?.username ?? 'anonymous',
    ip: req.ip,
    ...e,
  });
}

export function mustEnrollTotp(ctx: AppContext, s: Session, u: UserRecord | null): boolean {
  return s.source === 'local' && !!u && !u.totpSecret && !!ctx.config.local?.requireTotpForRoles.includes(u.role);
}

export function buildMe(ctx: AppContext, s: Session, u: UserRecord | null): Me {
  return {
    id: s.userId,
    username: s.username,
    displayName: s.displayName,
    source: s.source,
    role: s.role,
    csrfToken: s.csrfToken,
    totpEnabled: !!u?.totpSecret,
    mustChangePassword: !!u?.mustChangePassword,
    mustEnrollTotp: mustEnrollTotp(ctx, s, u),
    sessionExpiresAt: new Date(ctx.sessions.effectiveExpiry(s)).toISOString(),
    ...(s.source === 'local' && u?.totpSecret ? { recoveryCodesRemaining: ctx.users.recoveryCodesRemaining(u.id) } : {}),
  };
}

export interface DbScope {
  db: DatabaseConfig;
  /** Effective role = min(user role, db.maxRole). */
  role: Role;
  session: Session;
  conn(): Promise<Conn>;
  table(): Promise<CommandTable | undefined>;
}

/** Whether the profiler may run for this effective role and environment (enforced by the profiler route, reported in DatabaseSummary.features). */
export function profilerAllowed(ctx: AppContext, environment: Environment, role: Role): boolean {
  return role === 'admin' && ctx.config.policy.profilerAllowedEnvironments.includes(environment);
}

export function dbScope(ctx: AppContext, req: FastifyRequest, minimum: Role = 'viewer'): DbScope {
  const session = requireSession(req);
  const id = (req.params as { db?: string }).db ?? '';
  const db = ctx.redis.database(id);
  if (!db) throw new HttpError('not_found', 'Unknown database.');
  const role = minRole(session.role, db.maxRole);
  if (!roleAtLeast(role, minimum)) {
    throw new HttpError('forbidden', `This action requires the ${minimum} role on this database (you have ${role}).`);
  }
  let connP: Promise<Conn> | undefined;
  const replyBudget = { remaining: ctx.config.policy.maxReadReplyBytes };
  const stillAllowed = actorCheck(ctx, req, session, db.id);
  // Internal metadata reads carry their own fixed cap (`maxBytes`) and stay outside the request's data budget.
  // Every command not marked read-only is refused when its actor was revoked while it waited (review v0.2 N1); the
  // read-only ones skip the check (the key list and memory analysis read metadata of thousands of keys).
  const scoped = (target: Target): Target => ({ label: target.label, send: (args, o = {}) => target.send(args, {
    signal: req.redisSignal ?? undefined, ...(o.capped || o.maxBytes ? {} : { replyBudget }), ...o, ...(o.readonly ? {} : { stillAllowed }),
  }) });
  const conn = () => (connP ??= ctx.redis.conn(db.id, role).then((c): Conn => ({
    ...scoped(c), mode: c.mode,
    primaries: async () => (await c.primaries()).map(scoped),
    // Stream handshakes stop when the request's client goes away (review v0.2 r4 M3).
    dedicated: (signal) => c.dedicated(signal ?? req.redisSignal ?? undefined, stillAllowed), close: () => c.close(), destroy: () => c.destroy(),
    exclusive: (key, fn, o = {}) => c.exclusive(key, fn, { signal: req.redisSignal ?? undefined, ...o, stillAllowed }),
    // Metadata batches are measured and actor-checked (once, with the write of the batch), and share the request's
    // cumulative reply budget besides their own per-reply cap.
    pipeline: (commands, o = {}) => c.pipeline(commands, { signal: req.redisSignal ?? undefined, ...o, replyBudget, stillAllowed }),
  })));
  return { db, role, session, conn, table: async () => ctx.commandTables.get(db.id, await ctx.redis.conn(db.id, role)) };
}

/**
 * Whether the scope's session may still act: it exists and is not expired, and (local accounts) the user is
 * enabled with the same role and auth generation as when the session was issued. Long-running multi-command
 * requests check this between commands, so revoking or demoting a user stops them (review M1).
 */
export function sessionStillValid(ctx: AppContext, s: Session): boolean {
  if (!ctx.sessions.alive(s.idHash)) return false;
  if (s.source !== 'local') return true;
  const u = ctx.users.byId(s.userId);
  return !!u && !u.disabled && u.role === s.role && u.authGen === (s.authGen ?? 0);
}

/**
 * The actor check every Redis command of a database request runs right before it is sent (`SendOpts.stillAllowed`):
 * the session is alive and the account enabled with the role and generation it had when the request was admitted.
 * The role is the one the command was authorized with, so it is still sufficient for the command's class. A command
 * waiting for a pool socket, a command slot or a connection can outlive the request gate's checks (review v0.2 N1).
 * The first refusal is audited as `auth.revoked`.
 */
export function actorCheck(ctx: AppContext, req: FastifyRequest, s: Session, databaseId: string): () => boolean {
  let refused = false;
  return () => {
    if (sessionStillValid(ctx, s)) return true;
    if (!refused) {
      refused = true;
      audit(ctx, req, {
        userId: s.userId, username: s.username, action: 'auth.revoked', outcome: 'denied', databaseId,
        detail: `${req.method} ${req.routeOptions.url ?? 'unknown route'} refused before a Redis command was sent: the session ended or the account changed`,
      });
    }
    return false;
  };
}

/** Parse with a zod schema; failures become 400 validation errors (messages only, never echoing values). */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new HttpError('validation', issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ').slice(0, 1000), { details: issues });
  }
  return r.data;
}

/** Per-user rate limit; throws 429. */
export function rateLimit(ctx: AppContext, req: FastifyRequest, bucket: string, perSecond: number, burst = perSecond) {
  const who = req.session?.userId ?? `ip:${clientNet(req.ip)}`;
  if (!ctx.limiter.take(`${bucket}:${who}`, perSecond, burst)) throw new HttpError('rate_limited', 'Too many requests; slow down.');
}

export type Reply = FastifyReply;
