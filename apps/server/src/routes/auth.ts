import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  zLocalLogin,
  zPasswordChange,
  zRecoveryCodesRegenerate,
  zTotpConfirm,
  zTotpVerify,
  type AuthProviders,
  type LocalLoginResponse,
  type LogoutResponse,
  type OidcLoginError,
  type RecoveryCodesResponse,
  type TotpConfirmResponse,
  type TotpEnrollResponse,
} from '@rconsole/shared';
import { audit, buildMe, parse, requireSession, type AppContext } from '../context.ts';
import { OidcError } from '../auth/oidc.ts';
import { parseCookies, serializeCookie } from '../http/cookies.ts';
import { HttpError } from '../http/errors.ts';
import { hashPassword, verifyDummy, verifyPassword } from '../security/password.ts';
import { keyTag } from '../audit.ts';
import { clientNet } from '../security/ratelimit.ts';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../security/totp.ts';
import { hashRecoveryCode, newRecoveryCodeSet, normalizeRecoveryCode } from '../security/recoveryCodes.ts';
import { SessionRevokedError, type Session } from '../store/sessions.ts';
import type { UserRecord } from '../store/users.ts';

const AUTH_BODY_LIMIT = 16 * 1024;
const GENERIC_LOGIN_ERROR = 'Invalid username or password, or the account is temporarily locked.';

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext) {
  const { config, sessions, users } = ctx;
  const secure = config.server.secureCookies;
  const flowCookie = secure ? '__Host-rc_oidc' : 'rc_oidc';

  const setSession = (reply: FastifyReply, id: string) =>
    reply.header('set-cookie', serializeCookie(ctx.sessionCookie, id, { secure, sameSite: 'Strict', httpOnly: true, path: '/' }));
  const clearSession = (reply: FastifyReply) =>
    reply.header('set-cookie', serializeCookie(ctx.sessionCookie, '', { secure, sameSite: 'Strict', httpOnly: true, path: '/', maxAgeSeconds: 0 }));

  const loginRateLimit = (req: FastifyRequest) => {
    // Per client network (IPv6 /64), then per IPv6 /48 (ten times the allowance), then globally (bounds the
    // argon2 work per second). Each check only runs when the narrower one passed.
    const { perIpPerSecond: rate, perIpBurst: burst } = ctx.loginLimits;
    if (
      !ctx.limiter.take(`login:ip:${clientNet(req.ip)}`, rate, burst) ||
      !ctx.limiter.take(`login:net:${clientNet(req.ip, 48)}`, rate * 10, burst * 10) ||
      !ctx.limiter.take('login:global', 20, 50)
    ) {
      throw new HttpError('rate_limited', 'Too many sign-in attempts; try again later.').retryAfter(1 / rate);
    }
  };

  /**
   * The stored hash an entered recovery code would have, or null when it cannot match (not a code, or the user has no
   * unused code). Costs one argon2id computation either way, like a password check.
   */
  const recoveryHash = async (userId: string, input: string): Promise<string | null> => {
    const code = normalizeRecoveryCode(input);
    const salt = users.recoveryCodeSalt(userId);
    if (code === null || salt === null) {
      await verifyDummy(input);
      return null;
    }
    return hashRecoveryCode(code, salt);
  };

  /**
   * Check and consume a recovery code for `u` (TOTP enabled, password already verified). Everything after the hash is
   * synchronous: the account must be unchanged (same generation, enabled, TOTP still on, not locked) and the code
   * unused; consuming it is one conditional UPDATE, so two requests with the same code cannot both succeed.
   */
  const useRecoveryCode = async (u: UserRecord, input: string, stillValid: () => boolean = () => true): Promise<'ok' | 'bad' | 'changed'> => {
    const hash = await recoveryHash(u.id, input);
    const cur = users.byId(u.id);
    if (!cur || cur.authGen !== u.authGen || cur.disabled || !cur.totpSecret || !stillValid()) return 'changed';
    if (hash === null || users.isLockedNow(u.id) || !users.consumeRecoveryCode(u.id, hash)) return 'bad';
    return 'ok';
  };

  const localEnabled = () => {
    if (!config.local?.enabled) throw new HttpError('not_found', 'Local accounts are disabled.');
    return config.local;
  };

  /** Replace any existing session (prevents fixation) and start a new one. */
  const startSession = (req: FastifyRequest, reply: FastifyReply, data: Omit<Session, 'idHash' | 'csrfToken' | 'createdAt' | 'lastSeenAt' | 'expiresAt' | 'ip'>) => {
    if (req.session) sessions.destroy(req.session);
    const { id, session } = sessions.create({ ...data, ip: req.ip });
    setSession(reply, id);
    req.session = session;
    return session;
  };

  /** Rotate, or 401 when the session was revoked while this request was in flight. */
  const rotateOrRefuse = (reply: FastifyReply, s: Session, changes: Parameters<typeof sessions.rotate>[1]) => {
    try {
      return sessions.rotate(s, changes);
    } catch (e) {
      if (!(e instanceof SessionRevokedError)) throw e;
      clearSession(reply);
      throw new HttpError('unauthenticated', 'Your session was ended; sign in again.');
    }
  };

  app.get('/api/v1/auth/providers', { config: { auth: 'public' } }, async (): Promise<AuthProviders> => ({
    oidc: { enabled: !!ctx.oidc, displayName: config.oidc?.displayName ?? '' },
    local: { enabled: !!config.local?.enabled },
  }));

  app.get('/api/v1/auth/me', { config: { allowRestricted: true } }, async (req) => {
    const s = requireSession(req);
    return buildMe(ctx, s, req.localUser);
  });

  app.post('/api/v1/auth/login', { config: { auth: 'public' }, bodyLimit: AUTH_BODY_LIMIT }, async (req, reply): Promise<LocalLoginResponse> => {
    const local = localEnabled();
    loginRateLimit(req);
    const body = parse(zLocalLogin, req.body);
    const u = users.byUsername(body.username);
    // Unknown usernames are not stored verbatim: people type passwords into the username field.
    const who = u ? u.username : 'unknown';
    const fail = (detail: string, userId = 'anonymous') => {
      audit(ctx, req, { action: 'auth.login', outcome: 'denied', userId, username: who, detail: u ? detail : `${detail} (${keyTag(body.username.toLowerCase()).replace('key#', 'name#')})` });
      return new HttpError('unauthenticated', GENERIC_LOGIN_ERROR);
    };
    if (!u) {
      await verifyDummy(body.password);
      throw fail('unknown user');
    }
    if (users.isLocked(u)) {
      await verifyDummy(body.password);
      throw fail('account locked', u.id);
    }
    const ok = await verifyPassword(body.password, u.passwordHash);
    if (!ok) {
      const { locked } = users.recordFailure(u, local.lockout.maxAttempts, local.lockout.windowMinutes * 60_000);
      throw fail(locked ? 'bad password; account now locked' : 'bad password', u.id);
    }
    // A concurrent failed attempt may have locked the account while this one was hashing.
    if (users.isLockedNow(u.id)) throw fail('account locked', u.id);
    // An admin (or the owner) may have changed the role, password, TOTP or disabled flag while this sign-in was
    // hashing: the verification above is for the old account state, so it does not count (review H1).
    const cur = users.byId(u.id);
    if (!cur || cur.authGen !== u.authGen) throw fail('account changed during sign-in', u.id);
    if (cur.disabled) throw fail('account disabled', u.id);

    const base = { userId: cur.id, username: cur.username, displayName: cur.displayName, source: 'local' as const, role: cur.role, authGen: cur.authGen };
    if (cur.totpSecret && body.recoveryCode !== undefined) {
      // One-step sign-in with a recovery code instead of the TOTP step.
      const used = await useRecoveryCode(cur, body.recoveryCode);
      if (used !== 'ok') {
        const { locked } = used === 'bad' ? users.recordFailure(cur, local.lockout.maxAttempts, local.lockout.windowMinutes * 60_000) : { locked: false };
        audit(ctx, req, { action: 'auth.recovery', outcome: 'denied', userId: cur.id, username: cur.username, detail: used === 'changed' ? 'account changed during sign-in' : locked ? 'bad or used recovery code; account now locked' : 'bad or used recovery code' });
        throw new HttpError('unauthenticated', GENERIC_LOGIN_ERROR);
      }
      users.resetFailures(u.id);
      users.update(u.id, { lastLoginAt: Date.now() });
      const s = startSession(req, reply, { ...base, state: 'active' });
      audit(ctx, req, { action: 'auth.recovery', outcome: 'allowed', detail: `sign-in with password and a recovery code; ${users.recoveryCodesRemaining(u.id)} left` });
      return { me: buildMe(ctx, s, users.byId(u.id)) };
    }
    if (cur.totpSecret) {
      startSession(req, reply, { ...base, state: 'totp_pending' });
      audit(ctx, req, { action: 'auth.login', outcome: 'allowed', detail: 'password ok; TOTP required' });
      return { totpRequired: true };
    }
    users.resetFailures(u.id);
    users.update(u.id, { lastLoginAt: Date.now() });
    const s = startSession(req, reply, { ...base, state: 'active' });
    audit(ctx, req, { action: 'auth.login', outcome: 'allowed', detail: 'local' });
    return { me: buildMe(ctx, s, users.byId(u.id)) };
  });

  app.post('/api/v1/auth/totp/verify', { config: { auth: 'pending' }, bodyLimit: AUTH_BODY_LIMIT }, async (req, reply) => {
    const local = localEnabled();
    loginRateLimit(req);
    const body = parse(zTotpVerify, req.body);
    const s = req.session!;
    const u = users.byId(s.userId);
    if (!u || u.disabled || !u.totpSecret || users.isLocked(u) || u.authGen !== (s.authGen ?? 0) || u.role !== s.role) {
      sessions.destroy(s);
      clearSession(reply);
      audit(ctx, req, { action: 'auth.totp', outcome: 'denied', detail: 'account unavailable or locked' });
      throw new HttpError('unauthenticated', GENERIC_LOGIN_ERROR);
    }
    if ('recoveryCode' in body) {
      const used = await useRecoveryCode(u, body.recoveryCode, () => sessions.alive(s.idHash));
      if (used === 'changed') {
        sessions.destroy(s);
        clearSession(reply);
        audit(ctx, req, { action: 'auth.recovery', outcome: 'denied', detail: 'account changed during sign-in' });
        throw new HttpError('unauthenticated', GENERIC_LOGIN_ERROR);
      }
      if (used === 'bad') {
        const { locked } = users.recordFailure(u, local.lockout.maxAttempts, local.lockout.windowMinutes * 60_000);
        audit(ctx, req, { action: 'auth.recovery', outcome: 'denied', detail: locked ? 'bad or used recovery code; account now locked' : 'bad or used recovery code' });
        if (locked) {
          sessions.destroy(s);
          clearSession(reply);
        }
        throw new HttpError('unauthenticated', 'Invalid code.');
      }
      users.resetFailures(u.id);
      users.update(u.id, { lastLoginAt: Date.now() });
      const { id, session } = rotateOrRefuse(reply, s, { state: 'active' });
      setSession(reply, id);
      req.session = session;
      audit(ctx, req, { action: 'auth.recovery', outcome: 'allowed', detail: `TOTP step with a recovery code; ${users.recoveryCodesRemaining(u.id)} left` });
      return { me: buildMe(ctx, session, users.byId(u.id)) };
    }
    const step = verifyTotp(u.totpSecret, body.code, u.totpLastStep);
    if (step === null || users.isLockedNow(u.id) || !users.consumeTotpStep(u.id, step)) {
      const { locked } = users.recordFailure(u, local.lockout.maxAttempts, local.lockout.windowMinutes * 60_000);
      audit(ctx, req, { action: 'auth.totp', outcome: 'denied', detail: locked ? 'bad or replayed code; account now locked' : 'bad or replayed code' });
      if (locked) {
        sessions.destroy(s);
        clearSession(reply);
      }
      throw new HttpError('unauthenticated', 'Invalid code.');
    }
    users.resetFailures(u.id);
    users.update(u.id, { lastLoginAt: Date.now() });
    const { id, session } = rotateOrRefuse(reply, s, { state: 'active' });
    setSession(reply, id);
    req.session = session;
    audit(ctx, req, { action: 'auth.totp', outcome: 'allowed' });
    return { me: buildMe(ctx, session, users.byId(u.id)) };
  });

  app.post('/api/v1/auth/logout', { config: { allowRestricted: true }, bodyLimit: AUTH_BODY_LIMIT }, async (req, reply): Promise<LogoutResponse> => {
    const s = requireSession(req);
    sessions.destroy(s);
    clearSession(reply);
    audit(ctx, req, { action: 'auth.logout', outcome: 'allowed' });
    const out: LogoutResponse = { ok: true };
    if (s.source === 'oidc' && ctx.oidc) {
      const url = await ctx.oidc.endSessionUrl(`${config.server.publicOrigin}/`);
      if (url) out.redirectUrl = url;
    }
    return out;
  });

  // ---------------------------------------------------------------------------
  // OIDC

  const loginRedirect = (reply: FastifyReply, err: OidcLoginError) => reply.redirect(`/login?error=${err}`, 302);

  app.get('/api/v1/auth/oidc/start', { config: { auth: 'public' } }, async (req, reply) => {
    if (!ctx.oidc) return loginRedirect(reply, 'oidc_disabled');
    if (!ctx.limiter.take(`oidc:ip:${clientNet(req.ip)}`, 1, 20)) throw new HttpError('rate_limited', 'Too many sign-in attempts; try again later.');
    let started: { url: string; binding: string };
    try {
      started = await ctx.oidc.start();
    } catch (e) {
      req.log.warn({ msg: (e as Error).message }, 'OIDC discovery failed');
      audit(ctx, req, { action: 'auth.oidc', outcome: 'error', detail: 'IdP unavailable' });
      return loginRedirect(reply, 'oidc_failed');
    }
    reply.header('set-cookie', serializeCookie(flowCookie, started.binding, { secure, sameSite: 'Lax', httpOnly: true, path: '/', maxAgeSeconds: 600 }));
    return reply.redirect(started.url, 302);
  });

  app.get('/api/v1/auth/oidc/callback', { config: { auth: 'public' } }, async (req, reply) => {
    if (!ctx.oidc) return loginRedirect(reply, 'oidc_disabled');
    const binding = parseCookies(req.headers.cookie)[flowCookie];
    reply.header('set-cookie', serializeCookie(flowCookie, '', { secure, sameSite: 'Lax', httpOnly: true, path: '/', maxAgeSeconds: 0 }));
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    try {
      const id = await ctx.oidc.callback(q, binding);
      if (!id.role) {
        audit(ctx, req, { action: 'auth.oidc', outcome: 'denied', userId: `oidc:${id.sub}`, username: id.username, detail: 'no mapped group' });
        return loginRedirect(reply, 'oidc_no_role');
      }
      const data = { userId: `oidc:${id.sub}`, username: id.username, displayName: id.displayName, source: 'oidc' as const, role: id.role, state: 'active' as const };
      if (req.session) sessions.destroy(req.session);
      const ttl = config.oidc?.sessionTtlMinutes;
      const { id: sid, session } = sessions.create({ ...data, ip: req.ip }, { ttlMs: ttl === undefined ? undefined : ttl * 60_000 });
      req.session = session;
      reply.header('set-cookie', serializeCookie(ctx.sessionCookie, sid, { secure, sameSite: 'Strict', httpOnly: true, path: '/' }));
      audit(ctx, req, { action: 'auth.login', outcome: 'allowed', detail: `oidc role=${id.role}` });
      return reply.redirect('/', 302);
    } catch (e) {
      const code: OidcLoginError = e instanceof OidcError ? e.code : 'oidc_failed';
      req.log.warn({ msg: (e as Error).message }, 'OIDC callback failed');
      audit(ctx, req, { action: 'auth.oidc', outcome: code === 'oidc_failed' ? 'error' : 'denied', detail: code });
      return loginRedirect(reply, code);
    }
  });

  // ---------------------------------------------------------------------------
  // Password + TOTP management (local accounts)

  const localSessionUser = (req: FastifyRequest) => {
    localEnabled();
    const s = requireSession(req);
    if (s.source !== 'local' || !req.localUser) throw new HttpError('forbidden', 'Only local accounts manage passwords and TOTP here.');
    return { s, u: req.localUser };
  };

  app.post('/api/v1/auth/password', { config: { allowRestricted: true }, bodyLimit: AUTH_BODY_LIMIT }, async (req, reply) => {
    const local = localEnabled();
    loginRateLimit(req);
    const { s, u } = localSessionUser(req);
    const body = parse(zPasswordChange, req.body);
    if (!(await verifyPassword(body.currentPassword, u.passwordHash))) {
      const { locked } = users.recordFailure(u, local.lockout.maxAttempts, local.lockout.windowMinutes * 60_000);
      audit(ctx, req, { action: 'auth.password', outcome: 'denied', detail: 'wrong current password' });
      if (locked) {
        sessions.destroyUser(u.id);
        clearSession(reply);
        throw new HttpError('unauthenticated', 'Too many failures; account locked.');
      }
      throw new HttpError('forbidden', 'Current password is incorrect.');
    }
    if (body.newPassword.length < local.minPasswordLength) throw new HttpError('validation', `newPassword: must be at least ${local.minPasswordLength} characters`);
    if (body.newPassword === body.currentPassword) throw new HttpError('validation', 'newPassword: must differ from the current password');
    if (body.newPassword.toLowerCase().includes(u.username.toLowerCase())) throw new HttpError('validation', 'newPassword: must not contain the username');
    const newHash = await hashPassword(body.newPassword);
    // Everything below is synchronous. If the account changed while hashing (role, password, TOTP, disabled),
    // or the session was revoked, the request is refused and nothing is written (review H1).
    if (users.authGen(u.id) !== u.authGen || !sessions.alive(s.idHash)) {
      sessions.destroy(s);
      clearSession(reply);
      audit(ctx, req, { action: 'auth.password', outcome: 'denied', detail: 'account changed during the request' });
      throw new HttpError('unauthenticated', 'Your account changed while this request was running; sign in again.');
    }
    users.update(u.id, { passwordHash: newHash, mustChangePassword: false });
    users.resetFailures(u.id);
    sessions.destroyUser(u.id, s.idHash);
    const { id, session } = rotateOrRefuse(reply, s, { authGen: users.authGen(u.id) ?? 0 });
    setSession(reply, id);
    req.session = session;
    audit(ctx, req, { action: 'auth.password', outcome: 'allowed' });
    return { me: buildMe(ctx, session, users.byId(u.id)) };
  });

  app.post('/api/v1/auth/totp/enroll', { config: { allowRestricted: true }, bodyLimit: AUTH_BODY_LIMIT }, async (req): Promise<TotpEnrollResponse> => {
    const { u } = localSessionUser(req);
    if (u.mustChangePassword) throw new HttpError('forbidden', 'Change your password first.', { hint: 'password_change_required' });
    if (u.totpSecret) throw new HttpError('forbidden', 'TOTP is already enabled. An admin can reset it.');
    const secret = generateTotpSecret();
    // A new seed starts a new replay counter: the old one belonged to a removed seed (review v0.3 TOTP L2).
    users.update(u.id, { totpPendingSecret: secret, totpLastStep: 0 });
    audit(ctx, req, { action: 'auth.totp.enroll', outcome: 'allowed' });
    return { otpauthUrl: otpauthUrl('Redis Console', u.username, secret), secretBase32: secret };
  });

  app.post('/api/v1/auth/totp/confirm', { config: { allowRestricted: true }, bodyLimit: AUTH_BODY_LIMIT }, async (req, reply): Promise<TotpConfirmResponse> => {
    loginRateLimit(req);
    const { s, u } = localSessionUser(req);
    const body = parse(zTotpConfirm, req.body);
    if (!u.totpPendingSecret || u.totpSecret) throw new HttpError('validation', 'No TOTP enrollment in progress.');
    const step = verifyTotp(u.totpPendingSecret, body.code, u.totpLastStep);
    if (step === null) {
      audit(ctx, req, { action: 'auth.totp.confirm', outcome: 'denied' });
      throw new HttpError('validation', 'Invalid code.');
    }
    const codes = await newRecoveryCodeSet();
    // Everything below is synchronous. An admin (or the admin CLI) may have reset TOTP or changed the account while
    // the codes were hashed: then nothing is written.
    const cur = users.byId(u.id);
    if (!cur || cur.authGen !== u.authGen || !sessions.alive(s.idHash)) {
      sessions.destroy(s);
      clearSession(reply);
      audit(ctx, req, { action: 'auth.totp.confirm', outcome: 'denied', detail: 'account changed during the request' });
      throw new HttpError('unauthenticated', 'Your account changed while this request was running; sign in again.');
    }
    if (cur.totpSecret || cur.totpPendingSecret !== u.totpPendingSecret) throw new HttpError('validation', 'No TOTP enrollment in progress.');
    users.transaction(() => {
      users.update(u.id, { totpSecret: u.totpPendingSecret, totpPendingSecret: null, totpLastStep: step });
      users.replaceRecoveryCodes(u.id, codes);
    });
    sessions.destroyUser(u.id, s.idHash);
    const { id, session } = rotateOrRefuse(reply, s, { authGen: users.authGen(u.id) ?? 0 });
    setSession(reply, id);
    req.session = session;
    audit(ctx, req, { action: 'auth.totp.confirm', outcome: 'allowed', detail: `${codes.codes.length} recovery codes issued` });
    return { me: buildMe(ctx, session, users.byId(u.id)), recoveryCodes: codes.codes };
  });

  app.post('/api/v1/auth/recovery-codes', { bodyLimit: AUTH_BODY_LIMIT }, async (req, reply): Promise<RecoveryCodesResponse> => {
    const local = localEnabled();
    loginRateLimit(req);
    const { s, u } = localSessionUser(req);
    const body = parse(zRecoveryCodesRegenerate, req.body);
    if (!u.totpSecret) throw new HttpError('validation', 'Turn on two-factor authentication first; recovery codes stand in for its codes.');
    // Re-authentication: a stolen session alone must not be able to mint a second factor.
    if (!(await verifyPassword(body.currentPassword, u.passwordHash))) {
      const { locked } = users.recordFailure(u, local.lockout.maxAttempts, local.lockout.windowMinutes * 60_000);
      audit(ctx, req, { action: 'auth.recovery.regenerate', outcome: 'denied', detail: locked ? 'wrong current password; account now locked' : 'wrong current password' });
      if (locked) {
        sessions.destroyUser(u.id);
        clearSession(reply);
        throw new HttpError('unauthenticated', 'Too many failures; account locked.');
      }
      throw new HttpError('forbidden', 'Current password is incorrect.');
    }
    const codes = await newRecoveryCodeSet();
    if (users.authGen(u.id) !== u.authGen || !sessions.alive(s.idHash) || users.isLockedNow(u.id)) {
      sessions.destroy(s);
      clearSession(reply);
      audit(ctx, req, { action: 'auth.recovery.regenerate', outcome: 'denied', detail: 'account changed during the request' });
      throw new HttpError('unauthenticated', 'Your account changed while this request was running; sign in again.');
    }
    users.replaceRecoveryCodes(u.id, codes);
    users.resetFailures(u.id);
    audit(ctx, req, { action: 'auth.recovery.regenerate', outcome: 'allowed', detail: `${codes.codes.length} recovery codes issued; the previous set was revoked` });
    return { recoveryCodes: codes.codes, me: buildMe(ctx, s, users.byId(u.id)) };
  });
}
