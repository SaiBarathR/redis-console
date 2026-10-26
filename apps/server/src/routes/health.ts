import type { FastifyInstance } from 'fastify';
import type { HealthResponse, ReadyResponse } from '@rconsole/shared';
import type { AppContext } from '../context.ts';

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext) {
  // Liveness: the process is up and serving.
  app.get('/healthz', { config: { auth: 'public' }, logLevel: 'warn' }, async (): Promise<HealthResponse> => ({ status: 'ok' }));

  // Readiness: storage works and we are not shutting down. Redis availability is per database and is
  // reported in the UI instead (one down database must not take the console out of rotation).
  app.get('/readyz', { config: { auth: 'public' }, logLevel: 'warn' }, async (_req, reply): Promise<ReadyResponse> => {
    const checks: ReadyResponse['checks'] = {};
    try {
      ctx.db.prepare('SELECT 1').get();
      checks.storage = 'ok';
    } catch {
      checks.storage = 'error';
    }
    checks.accepting = ctx.state.shuttingDown ? 'error' : 'ok';
    if (ctx.oidc) checks.oidc = ctx.oidc.lastError ? 'error' : 'ok';
    const ready = checks.storage === 'ok' && checks.accepting === 'ok';
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', checks };
  });
}
