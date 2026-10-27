/** Only the disposable FalkorDB sandbox. Never routes graph fixtures to the read-only proxy. */
import { envVar } from './env.ts';
import { RedisConn, RespError } from './resp.ts';
export const GRAPH_DB = 'sandbox-graph';
export const GRAPH_PREFIX = 'graph:20261027:e2e:';
export async function graphExec(args: (string | number)[]): Promise<unknown> {
  const c = await RedisConn.connect({ host: '127.0.0.1', port: 6413, username: 'default', password: envVar('SANDBOX_REDIS_DEFAULT_PASSWORD') });
  try { const v = await c.raw(args); if (v instanceof RespError) throw new Error(v.message); return v; }
  finally { c.close(); }
}
