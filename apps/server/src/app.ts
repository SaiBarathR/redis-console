import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { PUBSUB_SUBSCRIPTION_TTL_MS, roleAtLeast } from '@rconsole/shared';
import type { AppConfig } from './config.ts';
import { AuditLog, failureDetail, redisErrorCode } from './audit.ts';
import { OidcService } from './auth/oidc.ts';
import { audit, type AppContext, type AuthMode } from './context.ts';
import { parseCookies } from './http/cookies.ts';
import { HttpError, errorBody } from './http/errors.ts';
import { abortWhenClientGone } from './http/clientGone.ts';
import { newNonce, securityHeaders } from './http/headers.ts';
import { CommandTables } from './policy/commandTable.ts';
import { Confirmations } from './policy/confirm.ts';
import { isErrorReply } from './redis/exec.ts';
import { RedisManager } from './redis/manager.ts';
import { clientNet, RateLimiter, Slots } from './security/ratelimit.ts';
import { Gate, KeyedGates, MAX_WAIT_MS } from './security/gate.ts';
import { StreamTickets } from './security/streamTickets.ts';
import { BodyBudget, bodyBudgetLimits } from './security/ingress.ts';
import { openDb, type Db } from './store/db.ts';
import { SessionStore, type Session } from './store/sessions.ts';
import { UserStore } from './store/users.ts';
import { keyringFromConfig } from './security/totpCipher.ts';
import { acquireDataDirLock, type DataDirLock } from './store/lock.ts';
import { AuditRetention } from './store/auditRetention.ts';
import { bootstrapAdmin } from './auth/local.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerDatabaseRoutes } from './routes/databases.ts';
import { registerKeyRoutes } from './routes/keys.ts';
import { registerVectorSetRoutes } from './routes/vectorset.ts';
import { registerCliRoutes } from './routes/cli.ts';
import { registerDiagnosticsRoutes } from './routes/diagnostics.ts';
import { registerPubSubRoutes } from './routes/pubsub.ts';
import { registerModuleRoutes } from './routes/modules.ts';
import { registerArrayRoutes } from './routes/array.ts';
import { registerImportRoutes } from './routes/import.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerStatic } from './routes/static.ts';

export const BODY_LIMIT = 12 * 1024 * 1024;

export interface BuildOptions {
  /** Pino logger options, or false. */
  logger?: FastifyServerOptions['logger'];
  /** SQLite location (defaults to config.server.dataDir). */
  dbPath?: string | ':memory:';
  /** Audit stdout writer (tests capture it). */
  auditWrite?: (line: string) => void;
  /** Override the sign-in rate limits (tests). */
  loginLimits?: { perIpPerSecond: number; perIpBurst: number };
}

/** Pino options: never log cookies, auth headers, CSRF tokens, bodies or query strings (keys, OIDC codes). */
export function loggerOptions(level = process.env.LOG_LEVEL ?? 'info'): FastifyServerOptions['logger'] {
  return {
    level,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        'headers.cookie',
        'headers.authorization',
        'body',
        'req.body',
        '*.password',
        '*.newPassword',
        '*.currentPassword',
        '*.initialPassword',
        '*.clientSecret',
        '*.token',
        '*.recoveryCode',
        '*.recoveryCodes',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req(req: FastifyRequest) {
        return { method: req.method, url: (req.url ?? '').split('?')[0]!.slice(0, 200), id: req.id };
      },
      res(res: { statusCode: number }) {
        return { statusCode: res.statusCode };
      },
    },
  } as FastifyServerOptions['logger'];
}

/** Query parameter names that would carry Redis key names, glob patterns, channel names or queries. */
export const SENSITIVE_QUERY_PARAMS = new Set(['k', 'key', 'keys', 'match', 'pattern', 'patterns', 'channel', 'channels', 'group', 'query', 'q']);

/** Names of sensitive query parameters in a URL (case-insensitive; `name[]` counts as `name`). */
export function sensitiveQueryParams(url: string): string[] {
  const i = url.indexOf('?');
  if (i < 0) return [];
  const out = new Set<string>();
  for (const part of url.slice(i + 1).split('&')) {
    let name = part.split('=')[0] ?? '';
    try {
      name = decodeURIComponent(name.replace(/\+/g, ' '));
    } catch {
      /* keep raw */
    }
    const n = name.toLowerCase().replace(/\[\]$/, '').trim();
    if (SENSITIVE_QUERY_PARAMS.has(n)) out.add(n);
  }
  return [...out];
}

/**
 * Fastify's `trustProxy` for the configured value. Fastify 5.12.7 turns a number into "trust no proxy" (every client
 * then appears as the proxy), so a hop count N becomes the trust function Express and proxy-addr document: trust the
 * N nearest hops, the socket peer included, so the client is the Nth X-Forwarded-For entry from the right. Like any
 * hop count it cannot tell the proxy from a direct client, so the app port must be reachable only through the proxy
 * chain (docs/INSTALL.md "Setting trustProxy"). `0` is `false`; `true`, addresses, CIDRs and aliases pass through.
 */
export function trustProxyOption(value: AppConfig['server']['trustProxy']): boolean | string | ((address: string, hop: number) => boolean) {
  if (typeof value !== 'number') return value;
  const hops = value;
  return hops > 0 ? (_address: string, hop: number) => hop < hops : false;
}

export async function buildApp(config: AppConfig, opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: opts.logger ?? loggerOptions(),
    bodyLimit: BODY_LIMIT,
    trustProxy: trustProxyOption(config.server.trustProxy),
    genReqId: () => randomUUID(),
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    return503OnClosing: true,
    // No implicit HEAD routes: a HEAD on an SSE endpoint must not start a stream.
    exposeHeadRoutes: false,
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true, maxParamLength: 200 },
    requestTimeout: config.server.requestTimeoutMs,
    connectionTimeout: config.server.connectionTimeoutMs,
    keepAliveTimeout: config.server.keepAliveTimeoutMs,
    // Node checks parser deadlines periodically, including clients trickling headers/body bytes.
    http: {
      headersTimeout: config.server.headersTimeoutMs,
      requestTimeout: config.server.requestTimeoutMs,
      connectionsCheckingInterval: Math.min(1000, config.server.headersTimeoutMs, config.server.requestTimeoutMs),
    },
  });

  // JSON only. Fastify also parses text/plain by default, which is what cross-site HTML forms can send.
  app.removeContentTypeParser('text/plain');

  // Own the data directory before anything touches it (schema migrations, the TOTP re-wrap): a second server on the
  // same directory refuses here (DataDirLockedError) and leaves the first one's lock alone (review v0.3 TOTP M1).
  const dataDir = opts.dbPath ?? config.server.dataDir;
  let lock: DataDirLock | undefined;
  if (dataDir !== ':memory:') {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    lock = acquireDataDirLock(dataDir, { owner: 'server', onLost: (m) => app.log.error(m) });
  }
  const { db, sessions, totpKeyring, users, auditLog, seeds } = (() => {
    let opened: Db | undefined;
    try {
      const db: Db = (opened = openDb(dataDir));
      const sessions = new SessionStore(db, { ttlMs: config.server.sessionTtlMinutes * 60_000, idleMs: config.server.sessionIdleMinutes * 60_000 });
      const totpKeyring = config.local?.enabled ? keyringFromConfig(config.local.totpKeyring) : undefined;
      const users = new UserStore(db, totpKeyring ? { totpKeyring } : {});
      const auditLog = new AuditLog(db, opts.auditWrite);
      // F-05 + key ring: encrypt clear-text TOTP seeds left by earlier versions and re-wrap every seed to the primary
      // key. Refuses to start (TotpKeyError, nothing changed) when a seed cannot be decrypted with any key of the ring.
      const seeds = users.migrateTotpSeeds();
      return { db, sessions, totpKeyring, users, auditLog, seeds };
    } catch (e) {
      try {
        opened?.close();
      } catch {
        /* closing is best effort */
      }
      lock?.release();
      throw e;
    }
  })();
  if (seeds.encrypted || seeds.rewrapped) {
    const detail = `encrypted=${seeds.encrypted} rewrapped=${seeds.rewrapped} primary=${totpKeyring!.primaryId}`;
    app.log.info({ encrypted: seeds.encrypted, rewrapped: seeds.rewrapped, primaryKeyId: totpKeyring!.primaryId }, 'TOTP seeds re-encrypted under the primary key');
    auditLog.record({ userId: 'system', username: 'system', ip: '-', action: 'system.totp.rewrap', outcome: 'allowed', detail });
  }
  const redis = new RedisManager(config.databases, (m) => app.log.warn(m), config.policy.maxReadReplyBytes, config.policy.maxInflightCommands, config.policy.maxStreams);
  const ctx: AppContext = {
    config,
    db,
    sessions,
    users,
    audit: auditLog,
    redis,
    commandTables: new CommandTables(),
    confirmations: new Confirmations(),
    pubsubTickets: new StreamTickets(PUBSUB_SUBSCRIPTION_TTL_MS),
    limiter: new RateLimiter(),
    slots: new Slots(),
    ingress: new BodyBudget(bodyBudgetLimits(config.policy.maxBodiesInFlight, config.policy.maxBodyBytesInFlight, BODY_LIMIT)),
    oidc: config.oidc?.enabled ? new OidcService(config.oidc, config.server.publicOrigin, db) : undefined,
    log: app.log,
    streams: new Set(),
    state: { shuttingDown: false },
    sessionCookie: config.server.secureCookies ? '__Host-rc_session' : 'rc_session',
    loginLimits: opts.loginLimits ?? { perIpPerSecond: 10 / 60, perIpBurst: 10 },
  };

  if (config.local?.enabled && config.local.bootstrapAdmin) await bootstrapAdmin(ctx);

  app.decorateRequest('session', null);
  app.decorateRequest('localUser', null);
  app.decorateRequest('nonce', '');
  app.decorateRequest('redisSignal', null);

  const hsts = config.server.secureCookies || config.server.publicOrigin.startsWith('https:');
  const allowedOrigins = new Set(config.server.allowedOrigins);

  // 1. Security headers + per-request CSP nonce on every response.
  app.addHook('onRequest', async (req, reply) => {
    const stop = new AbortController();
    req.redisSignal = stop.signal;
    abortWhenClientGone(reply, stop);
    req.nonce = newNonce();
    const isApi = req.url.startsWith('/api/') || req.url === '/api' || req.url.startsWith('/healthz') || req.url.startsWith('/readyz');
    reply.headers(securityHeaders(req.nonce, { hsts, api: isApi }));
  });

  // 2. Coarse per-IP rate limit (availability guard), stricter one for auth endpoints is per route.
  app.addHook('onRequest', async (req) => {
    if (!ctx.limiter.take(`ip:${clientNet(req.ip)}`, 100, 300)) throw new HttpError('rate_limited', 'Too many requests.');
  });

  // 3. Redis data never travels in URLs (proxies and load balancers log them): refuse key/pattern/channel
  //    query parameters on every request (API, health and SPA deep links), so no current or future route
  //    can accept them.
  app.addHook('onRequest', async (req) => {
    const bad = sensitiveQueryParams(req.url);
    if (bad.length) throw new HttpError('validation', `Query parameter(s) not allowed in URLs: ${bad.join(', ')}. Send them in a POST body.`);
  });

  const authMode = (req: FastifyRequest): AuthMode => req.routeOptions.config?.auth ?? (req.url.startsWith('/api/') ? 'session' : 'public');

  /** Checks of an active session's account (local accounts: enabled, unchanged, unrestricted) and the route's role. */
  const checkAccount = (req: FastifyRequest, s: Session) => {
    const cfg = req.routeOptions.config ?? {};
    if (s.source === 'local') {
      const u = users.byId(s.userId);
      if (!u || u.disabled) {
        sessions.destroy(s);
        req.session = null;
        throw new HttpError('unauthenticated', 'Account disabled or removed.');
      }
      // The account's role, password, TOTP or disabled flag changed after this session was issued (review H1).
      if (u.authGen !== (s.authGen ?? 0) || u.role !== s.role) {
        sessions.destroy(s);
        req.session = null;
        throw new HttpError('unauthenticated', 'Your account changed; sign in again.');
      }
      req.localUser = u;
      if (!cfg.allowRestricted) {
        if (u.mustChangePassword) throw new HttpError('forbidden', 'You must change your password first.', { hint: 'password_change_required' });
        if (!u.totpSecret && config.local?.requireTotpForRoles.includes(u.role)) {
          throw new HttpError('forbidden', 'You must enroll two-factor authentication first.', { hint: 'totp_enrollment_required' });
        }
      }
    }
    if (cfg.role && !roleAtLeast(s.role, cfg.role)) {
      throw new HttpError('forbidden', `This endpoint requires the ${cfg.role} role.`);
    }
  };

  // 4. Session lookup + CSRF + auth gates (before the body is parsed).
  app.addHook('onRequest', async (req) => {
    const mode = authMode(req);
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[ctx.sessionCookie];
    const s = raw ? sessions.get(raw) : null;
    req.session = s;

    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (unsafe) {
      const origin = req.headers.origin;
      if (!origin || !allowedOrigins.has(origin)) throw new HttpError('csrf', 'Cross-origin request rejected (Origin header missing or not allowed).');
    }

    if (mode === 'public') return;
    if (mode === 'pending') {
      if (!s || s.state !== 'totp_pending') throw new HttpError('unauthenticated', 'No pending sign-in; start again.');
      return;
    }
    if (!s || s.state !== 'active') throw new HttpError('unauthenticated', 'Not signed in.');
    if (unsafe) {
      const t = req.headers['x-csrf-token'];
      const tok = typeof t === 'string' ? Buffer.from(t) : Buffer.alloc(0);
      const want = Buffer.from(s.csrfToken);
      if (tok.length !== want.length || !timingSafeEqual(tok, want)) throw new HttpError('csrf', 'Missing or invalid CSRF token.');
    }
    checkAccount(req, s);
    if (req.headers['x-rc-background'] !== '1') sessions.touch(s);
  });

  /**
   * The checks above run when the headers arrive, but the client chooses when to finish its body, and a request may
   * then wait for a work slot. Both are re-run right before dispatch, after the body was received and after a slot
   * wait: a session that ended, or an account that was disabled, demoted or changed meanwhile gets 401 and the
   * denial is audited (review v0.2 r6 H2). Pending sign-ins (TOTP verify) re-check their account themselves.
   */
  const revalidate = (req: FastifyRequest, stage: string) => {
    const s = req.session;
    if (!s || authMode(req) !== 'session') return;
    let failure: unknown;
    try {
      if (!sessions.alive(s.idHash)) {
        req.session = null;
        throw new HttpError('unauthenticated', 'Your session has ended; sign in again.');
      }
      checkAccount(req, s);
      return;
    } catch (e) {
      failure = e;
    }
    const db = (req.params as { db?: unknown } | undefined)?.db;
    audit(ctx, req, {
      userId: s.userId,
      username: s.username,
      action: 'auth.revoked',
      outcome: 'denied',
      ...(typeof db === 'string' && redis.database(db) ? { databaseId: db } : {}),
      detail: `${req.method} ${req.routeOptions.url ?? 'unknown route'} refused ${stage}: ${(failure as Error).message}`,
    });
    throw failure;
  };

  // 5. Request-body budget, reserved before any body byte is read and held until the response is done or the
  //    connection closes; full means a prompt 429 (review v0.2 r6 H1). Chunked bodies reserve the route's limit.
  const BODYLESS = new Set(['GET', 'HEAD', 'TRACE']);
  const bodyReleases = new WeakMap<FastifyRequest, () => void>();
  app.addHook('onRequest', async (req, reply) => {
    if (BODYLESS.has(req.method)) return;
    const length = req.headers['content-length'];
    const chunked = req.headers['transfer-encoding'] !== undefined;
    if (!chunked && (length === undefined || length === '0')) return;
    const limit = req.routeOptions.bodyLimit ?? BODY_LIMIT;
    const size = chunked ? limit : Number(length);
    if (!(size <= limit)) {
      // As Fastify's own body-limit refusal: close instead of reading the unwanted body.
      reply.header('connection', 'close');
      throw new HttpError('too_large', 'Request body too large.');
    }
    const release = ctx.ingress.reserve(req.session?.userId ?? `ip:${clientNet(req.ip)}`, size);
    const done = () => {
      bodyReleases.delete(req);
      reply.raw.off('close', done);
      release();
    };
    bodyReleases.set(req, done);
    if (reply.raw.closed) done();
    else reply.raw.once('close', done);
  });

  // Every request that may carry a body, also one whose client has already gone (its reservation is released then).
  app.addHook('preValidation', async (req) => {
    if (!BODYLESS.has(req.method)) revalidate(req, 'after its body was received');
  });

  // Hold a global slot through response serialization too: typed multi-read routes may retain earlier replies.
  // Requests wait briefly (bounded FIFO) instead of failing at once, and one user holds at most half of the slots
  // (review v0.2 r4 M1, L2).
  const requestSlots = new Gate(config.policy.maxInflightCommands);
  const userRequestSlots = new KeyedGates(Math.max(1, Math.ceil(config.policy.maxInflightCommands / 2)));
  const releases = new WeakMap<FastifyRequest, () => void>();
  const slotExemptRoutes = new Set([
    '/api/v1/databases/:db/metrics/stream',
    '/api/v1/databases/:db/pubsub/stream',
    '/api/v1/databases/:db/profiler/stream',
    '/api/v1/databases/:db/workbench/cancel',
  ]);
  // Bodies have been parsed before admission: a stalled upload must never occupy work slots (review r5 H1).
  app.addHook('preHandler', async (req, reply) => {
    const route = req.routeOptions.url ?? '';
    if (!route.startsWith('/api/v1/databases/') || slotExemptRoutes.has(route)) return;
    const until = Date.now() + MAX_WAIT_MS;
    const signal = req.redisSignal ?? undefined;
    const mine = await userRequestSlots.acquire(req.session?.userId ?? `ip:${clientNet(req.ip)}`, {
      until, signal, busy: () => new HttpError('rate_limited', `You have too many database requests running (limit ${userRequestSlots.max}); try again shortly.`),
    });
    let all: () => void;
    try {
      all = await requestSlots.acquire({
        until, signal, busy: () => new HttpError('rate_limited', `Too many database requests are running on this server (limit ${requestSlots.max}); try again shortly.`),
      });
    } catch (e) {
      mine();
      throw e;
    }
    const release = () => {
      releases.delete(req);
      reply.raw.off('close', release);
      all(); mine();
    };
    try {
      revalidate(req, 'after waiting for a database request slot');
    } catch (e) {
      all(); mine();
      throw e;
    }
    releases.set(req, release);
    // A client that left while this request waited has already closed: release at once.
    if (signal?.aborted || reply.raw.closed) release();
    else reply.raw.once('close', release);
  });

  // onSend sees the serialized payload, before Node writes it. Slow readers cannot hold work slots.
  // The close listener remains a fallback for aborted requests and failures before onSend.
  app.addHook('onSend', async (req, _reply, payload) => {
    releases.get(req)?.();
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      // Redis error text can quote the request (search syntax errors near the query, unknown-command arguments):
      // server logs get the same redacted detail as the audit log, the error code only (review v0.2 round 2, R2-M5).
      if (err.status >= 500) req.log.warn({ code: err.code, detail: failureDetail(err.code, err.message) }, 'request failed');
      // Every 429 says when to try again; the web client retries reads with backoff and never earlier (v0.3 follow-up 6).
      if (err.status === 429) reply.header('retry-after', String(err.retryAfterSeconds ?? 1));
      return reply.code(err.status).type('application/json').send(err.toBody());
    }
    const e = err as { statusCode?: number; code?: string; validation?: unknown; message?: string };
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || e.statusCode === 413) return reply.code(413).send(errorBody('too_large', 'Request body too large.'));
    if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || e.statusCode === 415) return reply.code(415).send(errorBody('validation', 'Content-Type must be application/json.'));
    if (e.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || e.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || e.validation || e.statusCode === 400) {
      return reply.code(400).send(errorBody('validation', 'Malformed request.'));
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send(errorBody('validation', 'Bad request.'));
    req.log.error({ err: { message: isErrorReply(err) ? `redis error ${redisErrorCode(err.message)}` : e.message, code: e.code } }, 'unhandled error');
    return reply.code(500).send(errorBody('internal', 'Internal error.'));
  });

  registerHealthRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerDatabaseRoutes(app, ctx);
  registerKeyRoutes(app, ctx);
  registerVectorSetRoutes(app, ctx);
  registerCliRoutes(app, ctx);
  registerDiagnosticsRoutes(app, ctx);
  registerPubSubRoutes(app, ctx);
  registerModuleRoutes(app, ctx);
  registerArrayRoutes(app, ctx); // v0.4 arrays
  registerImportRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerStatic(app, ctx);

  const purge = setInterval(() => {
    try {
      sessions.purgeExpired();
    } catch {
      /* ignore */
    }
  }, 60_000);
  purge.unref();
  // Audit retention (v0.3 follow-up 3): at startup and daily; `audit.retentionDays: 0` keeps everything.
  const retention = new AuditRetention(db, auditLog, config.audit.retentionDays, app.log);
  retention.start();

  app.addHook('onClose', async () => {
    clearInterval(purge);
    await retention.stop();
    ctx.state.shuttingDown = true;
    for (const close of [...ctx.streams]) {
      try {
        close();
      } catch {
        /* ignore */
      }
    }
    await redis.closeAll();
    db.close();
    // Last: only now may another server open this data directory.
    lock?.release();
  });

  return { app, ctx };
}
