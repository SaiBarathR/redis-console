import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zAuditQuery, zCreateLocalUser, zUpdateLocalUser, type AuditResponse, type LocalUser, type UsersResponse } from '@rconsole/shared';
import { audit, parse, rateLimit, requireSession, sessionStillValid, type AppContext } from '../context.ts';
import { HttpError } from '../http/errors.ts';
import { hashPassword } from '../security/password.ts';
import type { Session } from '../store/sessions.ts';
import { toLocalUser } from '../store/users.ts';

const ADMIN = { config: { role: 'admin' as const }, bodyLimit: 16 * 1024 };

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const { users, sessions } = ctx;

  app.get('/api/v1/admin/audit', ADMIN, async (req): Promise<AuditResponse> => {
    const q = parse(zAuditQuery, req.query);
    return ctx.audit.query(q);
  });

  const localOnly = () => {
    if (!ctx.config.local?.enabled) throw new HttpError('not_found', 'Local accounts are disabled.');
    return ctx.config.local;
  };

  app.get('/api/v1/admin/users', ADMIN, async (): Promise<UsersResponse> => {
    localOnly();
    return { users: users.list().map(toLocalUser) };
  });

  /**
   * Password hashing takes a while, and the acting admin may be disabled, demoted or signed out meanwhile (review
   * v0.2 M5). Re-checked synchronously right before the write; a revoked actor changes nothing.
   */
  const actorStillValid = (req: FastifyRequest, me: Session, action: string, detail: string) => {
    if (sessionStillValid(ctx, me)) return;
    audit(ctx, req, { action, outcome: 'denied', detail: `${detail}; the session ended or the account changed during the request` });
    throw new HttpError('unauthenticated', 'Your session ended or your account changed; nothing was changed.');
  };

  app.post('/api/v1/admin/users', ADMIN, async (req, reply): Promise<LocalUser> => {
    const local = localOnly();
    const me = requireSession(req);
    const body = parse(zCreateLocalUser, req.body);
    if (body.initialPassword.length < local.minPasswordLength) throw new HttpError('validation', `initialPassword: must be at least ${local.minPasswordLength} characters`);
    if (users.byUsername(body.username)) throw new HttpError('validation', 'username: already exists');
    // argon2id costs ~19 MiB and tens of ms on the shared thread pool: bound it per admin, like sign-in.
    rateLimit(ctx, req, 'admin-password', 2, 10);
    const passwordHash = await hashPassword(body.initialPassword);
    actorStillValid(req, me, 'admin.user.create', `user=${body.username} role=${body.role}`);
    if (users.byUsername(body.username)) throw new HttpError('validation', 'username: already exists');
    const u = users.create({ username: body.username, displayName: body.displayName, role: body.role, passwordHash, mustChangePassword: true });
    audit(ctx, req, { action: 'admin.user.create', outcome: 'allowed', detail: `user=${u.username} role=${u.role}` });
    reply.code(201);
    return toLocalUser(u);
  });

  app.patch('/api/v1/admin/users/:id', ADMIN, async (req): Promise<LocalUser> => {
    const local = localOnly();
    const me = requireSession(req);
    const { id } = parse(z.object({ id: z.string().max(128) }), req.params);
    const body = parse(zUpdateLocalUser, req.body);
    if (body.newPassword !== undefined && body.newPassword.length < local.minPasswordLength) {
      throw new HttpError('validation', `newPassword: must be at least ${local.minPasswordLength} characters`);
    }
    const found = users.byId(id);
    if (!found) throw new HttpError('not_found', 'No such user.');
    // Everything after the hash is synchronous: checks and writes see one state (review v0.2 M5). The actor is
    // re-checked for every change, not only after a hash (review v0.2 r6 H2).
    if (body.newPassword !== undefined) rateLimit(ctx, req, 'admin-password', 2, 10);
    const passwordHash = body.newPassword !== undefined ? await hashPassword(body.newPassword) : undefined;
    actorStillValid(req, me, 'admin.user.update', `user=${found.username}`);
    let u = found;
    if (passwordHash !== undefined) {
      const now = users.byId(id);
      if (!now) throw new HttpError('not_found', 'No such user.');
      if (now.authGen !== found.authGen) {
        throw new HttpError('validation', 'This account was changed by someone else while your request ran; reload it and try again.');
      }
      u = now;
    }
    const self = me.userId === u.id;
    if (self && (body.role !== undefined && body.role !== u.role)) throw new HttpError('forbidden', 'You cannot change your own role.');
    if (self && body.disabled) throw new HttpError('forbidden', 'You cannot disable your own account.');
    const losingAdmin = u.role === 'admin' && !u.disabled && ((body.role !== undefined && body.role !== 'admin') || body.disabled === true);
    if (losingAdmin && users.list().filter((x) => x.role === 'admin' && !x.disabled).length <= 1 && !ctx.oidc) {
      throw new HttpError('forbidden', 'Cannot remove the last enabled local admin.');
    }
    const changes: string[] = [];
    if (body.displayName !== undefined) {
      users.update(u.id, { displayName: body.displayName });
      changes.push('displayName');
    }
    let revoke = false;
    if (body.role !== undefined && body.role !== u.role) {
      users.update(u.id, { role: body.role });
      changes.push(`role ${u.role}->${body.role}`);
      revoke = true;
    }
    if (body.disabled !== undefined && body.disabled !== u.disabled) {
      users.update(u.id, { disabled: body.disabled });
      changes.push(body.disabled ? 'disabled' : 'enabled');
      revoke ||= body.disabled;
      if (!body.disabled) users.resetFailures(u.id);
    }
    if (body.resetTotp) {
      users.resetTotp(u.id);
      changes.push('totp reset (seed and recovery codes cleared)');
      revoke = true;
    }
    if (passwordHash !== undefined) {
      users.update(u.id, { passwordHash, mustChangePassword: true });
      users.resetFailures(u.id);
      changes.push('password reset');
      revoke = true;
    }
    // Privilege or credential changes revoke the user's sessions (they sign in again).
    if (revoke) sessions.destroyUser(u.id, self ? me.idHash : undefined);
    // An admin changing their own password/TOTP keeps the session making the change, at the new generation.
    if (self) sessions.setAuthGen(me.idHash, users.authGen(u.id) ?? 0);
    audit(ctx, req, { action: 'admin.user.update', outcome: 'allowed', detail: `user=${u.username} ${changes.join(', ') || 'no changes'}` });
    return toLocalUser(users.byId(u.id)!);
  });
}
