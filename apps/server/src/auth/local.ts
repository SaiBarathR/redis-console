import type { AppContext } from '../context.ts';
import { hashPassword } from '../security/password.ts';

/** Create the bootstrap admin on first start (no local users yet). It must change its password on first login. */
export async function bootstrapAdmin(ctx: AppContext): Promise<void> {
  const b = ctx.config.local?.bootstrapAdmin;
  if (!b) return;
  if (ctx.users.count() > 0) return;
  const passwordHash = await hashPassword(b.password.reveal());
  const u = ctx.users.create({ username: b.username, displayName: b.displayName ?? 'Bootstrap admin', role: 'admin', passwordHash, mustChangePassword: true });
  ctx.audit.record({ userId: 'system', username: 'system', ip: '-', action: 'admin.user.bootstrap', outcome: 'allowed', detail: `created ${u.username}` });
}
