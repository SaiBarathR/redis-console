/** Server-sent events with caps: per-user stream limit, max duration, session liveness checks. */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { HttpError } from './errors.ts';
import { securityHeaders } from './headers.ts';

export const MAX_STREAMS_PER_USER = 3;
/** Above this many unsent bytes, events are dropped (counted) instead of buffered. */
export const SSE_SOFT_BUFFER = 1024 * 1024;
/** Above this many unsent bytes the client is considered stuck and the stream is closed. */
export const SSE_HARD_BUFFER = 8 * 1024 * 1024;

export interface SseStream {
  /** Returns false when the event was dropped because the client is not keeping up. */
  send(data: unknown, event?: string): boolean;
  close(reason?: string): void;
  onClose(cb: () => void): void;
  readonly closed: boolean;
}

/**
 * Reserve one of the user's stream slots and one of the server's (`policy.maxStreams` per class: live pub/sub and
 * profiler streams, metrics streams). Call this before opening anything expensive (a dedicated Redis connection), so
 * a burst of requests over the limit is refused before it costs Redis connections. Streams never hold the slots
 * of ordinary commands (review v0.2 r4 H1).
 */
export function reserveSse(ctx: AppContext, req: FastifyRequest, kind: string, limit = MAX_STREAMS_PER_USER): () => void {
  const s = req.session!;
  const cls = kind === 'metrics' ? 'metrics' : 'live';
  const release = ctx.slots.acquire(`sse:${cls}:${s.userId}`, limit);
  if (!release) throw new HttpError('rate_limited', `Too many open live streams (max ${limit}); close one first.`);
  const max = ctx.config.policy.maxStreams;
  const server = ctx.slots.acquire(`sse-server:${cls}`, max);
  if (!server) {
    release();
    throw new HttpError('rate_limited', `Too many ${cls === 'metrics' ? 'metrics' : 'live'} streams are open on this server (limit ${max}); try again later.`);
  }
  return () => {
    server();
    release();
  };
}

export function openSse(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { maxMs: number; kind: string; limit?: number; reserved?: () => void },
): SseStream {
  const s = req.session!;
  const release = opts.reserved ?? reserveSse(ctx, req, opts.kind, opts.limit);

  reply.hijack();
  const res = reply.raw;
  const hsts = ctx.config.server.secureCookies || ctx.config.server.publicOrigin.startsWith('https:');
  res.writeHead(200, {
    ...securityHeaders(req.nonce, { hsts, api: true }),
    'content-type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': stream open\n\n');

  let closed = false;
  const callbacks: (() => void)[] = [];
  const close = (reason?: string) => {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    clearTimeout(limit);
    ctx.streams.delete(closeFromShutdown);
    release();
    try {
      if (reason && !res.writableEnded) res.write(`event: end\ndata: ${JSON.stringify({ reason })}\n\n`);
      res.end();
    } catch {
      /* socket gone */
    }
    for (const cb of callbacks) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  };
  const closeFromShutdown = () => close('server shutting down');
  ctx.streams.add(closeFromShutdown);

  const beat = setInterval(() => {
    if (!ctx.sessions.alive(s.idHash)) return close('session ended');
    try {
      res.write(': ping\n\n');
    } catch {
      close();
    }
  }, 5000);
  const limit = setTimeout(() => close('time limit reached'), opts.maxMs);
  req.raw.on('close', () => close());
  res.on('close', () => close());
  res.on('error', () => close());
  // A client that left before this point never emits 'close' again: release everything now (review v0.2 r4 M3).
  if (res.destroyed || res.socket?.destroyed) close();

  return {
    send(data, event) {
      if (closed) return false;
      // Backpressure: never buffer without bound for a slow or paused client.
      if (res.writableLength > SSE_HARD_BUFFER) {
        close('client too slow');
        return false;
      }
      if (res.writableLength > SSE_SOFT_BUFFER && event !== 'end') return false;
      try {
        res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch {
        close();
        return false;
      }
    },
    close,
    onClose(cb) {
      if (closed) cb();
      else callbacks.push(cb);
    },
    get closed() {
      return closed;
    },
  };
}
