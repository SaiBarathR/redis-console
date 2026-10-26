import type { FastifyRequest } from 'fastify';
import type { Confirmation } from '@rconsole/shared';
import { audit, type AppContext, type DbScope } from '../context.ts';
import { failureDetail, type AuditInput } from '../audit.ts';
import { HttpError } from '../http/errors.ts';
import { toHttpError } from '../redis/exec.ts';
import { requestHash, type Confirmed } from './confirm.ts';
import type { ConfirmSpec } from './policy.ts';

export type AuditBase = Omit<AuditInput, 'userId' | 'username' | 'ip' | 'outcome'>;

/**
 * Enforce a confirmation (when `spec` is non-null). On 428 the challenge is audited. Returns the
 * reason supplied with the confirmation (prod writes).
 */
export function confirmOrThrow(
  ctx: AppContext,
  req: FastifyRequest,
  scope: DbScope,
  route: string,
  body: unknown,
  confirmation: Confirmation | undefined,
  spec: ConfirmSpec | null,
  auditBase: AuditBase,
): Confirmed {
  if (!spec) return {};
  try {
    return ctx.confirmations.require(scope.session.idHash, requestHash(route, scope.db.id, body), spec, confirmation);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'confirmation_required') {
      audit(ctx, req, { ...auditBase, databaseId: scope.db.id, outcome: 'confirmation_required', detail: e.message });
    }
    throw e;
  }
}

/**
 * Run a data read (key browser, stream, time-series and search routes) and record exactly one audit event for it
 * (review v0.2 M6): `allowed` with `detail(result)`, which must hold counts only, never data; or `denied`/`error`
 * with the failure code. `base` is read when the event is written, so a handler may fill in the command once it
 * knows it. Keys go in `argvRedacted` as key tags (audit.keyTag).
 */
export async function auditedRead<T>(ctx: AppContext, req: FastifyRequest, base: AuditBase, read: () => Promise<T>, detail?: (r: T) => string): Promise<T> {
  let r: T;
  let release: (() => void) | undefined;
  try {
    release = ctx.slots.acquire(`data-read:${req.session?.userId}`, 4) ?? undefined;
    if (!release) throw new HttpError('rate_limited', 'At most four data reads can run at once per user.');
    r = await read();
  } catch (e) {
    try {
      auditDenied(ctx, req, base, e instanceof HttpError ? e : toHttpError(e));
    } catch {
      // auditDenied rethrows; the original error is rethrown below.
    }
    throw e;
  } finally { release?.(); }
  audit(ctx, req, { ...base, outcome: 'allowed', ...(detail ? { detail: detail(r) } : {}) });
  return r;
}

/** Audit a denial and rethrow. */
export function auditDenied(ctx: AppContext, req: FastifyRequest, base: AuditBase, e: unknown): never {
  if (e instanceof HttpError && e.code !== 'confirmation_required') {
    const outcome = e.status >= 500 || e.code === 'redis_error' || e.code === 'timeout' ? 'error' : 'denied';
    audit(ctx, req, { ...base, outcome, detail: failureDetail(e.code, e.message, !String(base.command ?? '').includes('<unknown')) });
  }
  throw e;
}
