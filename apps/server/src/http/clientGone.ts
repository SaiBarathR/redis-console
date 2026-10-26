import type { FastifyReply, FastifyRequest } from 'fastify';

/** True once the request's client has disconnected: nothing sent now can reach it. */
export function clientIsGone(req: FastifyRequest, reply: FastifyReply): boolean {
  return !!req.redisSignal?.aborted || reply.raw.destroyed || !!reply.raw.socket?.destroyed;
}

/**
 * Aborts `controller` when the client goes away before its response is sent (fetch aborted, tab closed,
 * connection lost). Multi-command routes check the signal before each command, so nothing more is sent to
 * Redis for a request nobody is waiting for (console review round 1, H1). A completed response does not abort.
 */
export function abortWhenClientGone(reply: FastifyReply, controller: AbortController): void {
  const res = reply.raw;
  const gone = () => {
    if (!res.writableFinished) controller.abort(new Error('client disconnected'));
  };
  if (res.destroyed || res.socket?.destroyed) gone();
  else res.once('close', gone);
}
