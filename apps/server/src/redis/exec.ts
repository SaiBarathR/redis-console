import { ErrorReply, TimeoutError } from 'redis';
import { HttpError } from '../http/errors.ts';
import type { Arg, SendOpts, Target } from './manager.ts';
import { sanitizeRedisError } from './manager.ts';

export const isErrorReply = (e: unknown): e is ErrorReply => e instanceof ErrorReply;

/** Map a node-redis failure to an API error. Redis error replies become redis_error (NOPERM -> forbidden). */
export function toHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof ErrorReply) {
    const msg = sanitizeRedisError(e);
    if (msg.startsWith('NOPERM')) return new HttpError('forbidden', `Redis ACL denied the command: ${msg}`);
    return new HttpError('redis_error', msg);
  }
  if (e instanceof TimeoutError) return new HttpError('timeout', 'Redis command timed out.');
  const name = (e as Error)?.constructor?.name ?? '';
  if (/Closed|Offline|Socket|Connection|RootNodes|Reconnect|Disconnect/.test(name) || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH/.test(String((e as Error)?.message))) {
    return new HttpError('unavailable', `Database unavailable: ${sanitizeRedisError(e)}`);
  }
  return new HttpError('internal', 'Unexpected Redis client error.');
}

/** Send a fixed (server-built) command; failures become HttpErrors. */
export async function run<T = unknown>(conn: Target, args: Arg[], o: SendOpts = {}): Promise<T> {
  try {
    return await conn.send<T>(args, o);
  } catch (e) {
    throw toHttpError(e);
  }
}
