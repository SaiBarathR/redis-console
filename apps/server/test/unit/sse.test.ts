import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { openSse, reserveSse, SSE_HARD_BUFFER, SSE_SOFT_BUFFER } from '../../src/http/sse.ts';
import { Slots } from '../../src/security/ratelimit.ts';
import type { AppContext } from '../../src/context.ts';

function fixture() {
  const ctx = {
    slots: new Slots(),
    streams: new Set<() => void>(),
    sessions: { alive: () => true },
    config: { server: { secureCookies: false, publicOrigin: 'http://localhost:4100' }, policy: { maxStreams: 4 } },
  } as unknown as AppContext;
  const res = Object.assign(new EventEmitter(), {
    writableLength: 0,
    writableEnded: false,
    chunks: [] as string[],
    writeHead() {},
    write(chunk: string) {
      // Simulates a client that never reads: everything stays buffered.
      this.chunks.push(chunk);
      this.writableLength += Buffer.byteLength(chunk);
      return false;
    },
    end() {
      this.writableEnded = true;
    },
  });
  const req = { session: { userId: 'u1', idHash: 'h' }, nonce: 'n', raw: new EventEmitter() } as unknown as FastifyRequest;
  const reply = { hijack() {}, raw: res } as unknown as FastifyReply;
  return { ctx, req, reply, res };
}

describe('SSE backpressure', () => {
  it('drops events above the soft buffer and closes a stuck client above the hard buffer', () => {
    const { ctx, req, reply, res } = fixture();
    const sse = openSse(ctx, req, reply, { maxMs: 60_000, kind: 'pubsub' });
    const big = 'x'.repeat(64 * 1024);
    let sent = 0, dropped = 0;
    for (let i = 0; i < 40; i++) (sse.send({ big }) ? sent++ : dropped++);
    expect(res.writableLength).toBeLessThan(SSE_SOFT_BUFFER + 128 * 1024);
    expect(sent).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
    expect(sse.closed).toBe(false);
    res.writableLength = SSE_HARD_BUFFER + 1;
    expect(sse.send({ big })).toBe(false);
    expect(sse.closed).toBe(true);
    expect(ctx.slots.count('sse:live:u1')).toBe(0);
    sse.close();
  });

  it('a reserved slot is used (not taken twice) and the limit applies before any Redis work', () => {
    const { ctx, req, reply } = fixture();
    const r1 = reserveSse(ctx, req, 'pubsub');
    reserveSse(ctx, req, 'profiler');
    reserveSse(ctx, req, 'pubsub');
    expect(() => reserveSse(ctx, req, 'pubsub')).toThrow(/Too many open live streams/);
    const sse = openSse(ctx, req, reply, { maxMs: 60_000, kind: 'pubsub', reserved: r1 });
    expect(ctx.slots.count('sse:live:u1')).toBe(3);
    sse.close();
    expect(ctx.slots.count('sse:live:u1')).toBe(2);
  });

  it('streams have a server-wide limit per class, apart from command slots (review v0.2 r4 H1)', () => {
    const { ctx, req } = fixture();
    const other = { ...req, session: { userId: 'u2', idHash: 'h2' } } as unknown as FastifyRequest;
    for (let i = 0; i < 3; i++) reserveSse(ctx, req, 'pubsub');
    const last = reserveSse(ctx, other, 'profiler');
    expect(() => reserveSse(ctx, other, 'pubsub')).toThrow(/live streams are open on this server \(limit 4\)/);
    expect(ctx.slots.count('sse:live:u2')).toBe(1);
    // Metrics streams are counted separately.
    reserveSse(ctx, other, 'metrics', 5)();
    last();
    reserveSse(ctx, other, 'pubsub');
  });

  it('a client that left before the stream opened releases its slots at once (review v0.2 r4 M3)', () => {
    const { ctx, req, reply, res } = fixture();
    Object.assign(res, { destroyed: true });
    let closed = false;
    const sse = openSse(ctx, req, reply, { maxMs: 60_000, kind: 'pubsub' });
    sse.onClose(() => (closed = true));
    expect(sse.closed).toBe(true);
    expect(closed).toBe(true);
    expect(ctx.slots.count('sse:live:u1')).toBe(0);
  });
});
