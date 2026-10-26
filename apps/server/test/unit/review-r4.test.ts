/**
 * Review v0.2 round 4 (server, Claude reviewer): limits around the measured transport. In-process fake RESP servers,
 * no real Redis. Each test failed on `release/v0.2` @ 93a5720.
 */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CappedPool, CommandBudget, STREAM_RETAIN_BYTES, redirect, type Redirect, type RedirectPolicy } from '../../src/redis/capped.ts';
import { RespReader, RespTruncated } from '../../src/redis/resp.ts';
import { parseMonitorLine } from '../../src/routes/pubsub.ts';
import { Gate, KeyedGates } from '../../src/security/gate.ts';
import type { DatabaseConfig } from '../../src/config.ts';
import type { HttpError } from '../../src/http/errors.ts';
import { ErrorReply } from 'redis';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Fake { endpoint: { host: string; port: number }; seen: string[][]; open: Set<net.Socket>; connections: number }
/** A fake RESP server: HELLO/SELECT answer +OK (HELLO after `helloDelayMs`), everything else goes to `command`. */
async function fake(command: (args: string[], socket: net.Socket) => void, helloDelayMs = 0): Promise<Fake> {
  const f: Fake = { endpoint: { host: '127.0.0.1', port: 0 }, seen: [], open: new Set(), connections: 0 };
  const srv = net.createServer((socket) => {
    f.connections++;
    f.open.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => f.open.delete(socket));
    let reader = new RespReader(1 << 20);
    socket.on('data', (chunk) => {
      try {
        for (let i = 0; i < chunk.length;) {
          i += reader.feed(chunk.subarray(i), true);
          if (!reader.done) continue;
          const args = (reader.value as unknown[]).map(String);
          reader = new RespReader(1 << 20);
          f.seen.push(args);
          if (args[0] === 'HELLO') setTimeout(() => socket.writable && socket.write('+OK\r\n'), helloDelayMs);
          else if (args[0] === 'SELECT') socket.write('+OK\r\n');
          else command(args, socket);
        }
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  f.endpoint.port = (srv.address() as net.AddressInfo).port;
  cleanups.push(() => new Promise<void>((r) => { for (const s of f.open) s.destroy(); srv.close(() => r()); }));
  return f;
}
function pool(f: Fake, o: { size?: number; budget?: CommandBudget; streams?: CommandBudget; cap?: number } = {}) {
  const db: DatabaseConfig = { id: 'fake', name: 'Fake', environment: 'test', mode: 'standalone', url: `redis://127.0.0.1:${f.endpoint.port}`, db: 0, credentials: { default: { username: 'default' } }, poolSize: o.size ?? 2, maxRole: 'admin', readOnly: false };
  const p = new CappedPool(db, db.credentials.default!, 'viewer', o.cap ?? 1024, o.budget ?? new CommandBudget(16), o.streams ?? new CommandBudget(16));
  cleanups.push(() => p.close());
  return p;
}
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await sleep(5);
  }
};

describe('review v0.2 r4 H1: streams have their own budget', () => {
  it('an open stream never takes a command slot, and the stream budget is enforced on its own', async () => {
    const f = await fake(([cmd, ch], s) => {
      if (cmd === 'SUBSCRIBE') s.write(`>3\r\n$9\r\nsubscribe\r\n$${ch!.length}\r\n${ch}\r\n:1\r\n`);
      else if (cmd === 'PING') s.write('+PONG\r\n');
    });
    const p = pool(f, { budget: new CommandBudget(1), streams: new CommandBudget(1, 'stream budget used up') });
    const d = await p.dedicated(f.endpoint);
    await d.subscribe(['c'], () => {}, true);
    // The one command slot is still free while the stream stays open.
    expect(await p.send(['PING'], f.endpoint)).toBe('PONG');
    await expect(p.dedicated(f.endpoint)).rejects.toMatchObject({ code: 'rate_limited', message: 'stream budget used up' });
    expect(await p.send(['PING'], f.endpoint)).toBe('PONG');
    d.destroy();
    await sleep(30);
    (await p.dedicated(f.endpoint)).destroy();
  });
});

describe('review v0.2 r4 M1: a short bounded wait instead of an immediate 429', () => {
  it('a command waits for a busy pool socket, and for a busy global budget', async () => {
    const f = await fake(([cmd], s) => (cmd === 'SLOW' ? setTimeout(() => s.write('+done\r\n'), 150) : s.write('+PONG\r\n')));
    const p = pool(f, { size: 1 });
    expect(await Promise.all([p.send(['SLOW'], f.endpoint), p.send(['PING'], f.endpoint)])).toEqual(['done', 'PONG']);
    const global = new CommandBudget(1);
    const a = pool(f, { size: 1, budget: global }), b = pool(f, { size: 1, budget: global });
    expect(await Promise.all([a.send(['SLOW'], f.endpoint), b.send(['PING'], f.endpoint)])).toEqual(['done', 'PONG']);
  });

  it('the wait is bounded by time, queue length and abort, and names the limit', async () => {
    const f = await fake(([cmd], s) => (cmd === 'HOLD' ? setTimeout(() => s.write('+held\r\n'), 600) : s.write('+PONG\r\n')));
    const p = pool(f, { size: 1 });
    const held = p.send(['HOLD'], f.endpoint, { timeout: 2000 });
    await sleep(30);
    // Waiting stops at min(2 s, the command timeout).
    const start = Date.now();
    await expect(p.send(['PING'], f.endpoint, { timeout: 150 })).rejects.toMatchObject({ code: 'rate_limited', message: expect.stringContaining('All 1 Redis connections') });
    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
    expect(Date.now() - start).toBeLessThan(500);
    // At most poolSize x 4 commands wait; the next is refused at once.
    const waiting = Array.from({ length: 3 }, () => p.send(['PING'], f.endpoint));
    const stop = new AbortController();
    const aborted = p.send(['PING', 'aborted'], f.endpoint, { signal: stop.signal }).catch((e: { message: string }) => e.message);
    const t0 = Date.now();
    await expect(p.send(['PING'], f.endpoint)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(Date.now() - t0).toBeLessThan(50);
    // An aborted waiter leaves the queue without being sent.
    stop.abort();
    expect(await aborted).toMatch(/cancelled before it was sent/);
    expect(await held).toBe('held');
    expect(await Promise.all(waiting)).toEqual(['PONG', 'PONG', 'PONG']);
    expect(f.seen.some((a) => a[1] === 'aborted')).toBe(false);
  });

  it('the global budget names its limit', async () => {
    const b = new CommandBudget(1);
    const release = b.take();
    await expect(b.acquire(Date.now() + 20)).rejects.toMatchObject({ code: 'rate_limited', message: expect.stringContaining('limit 1') });
    release();
    (await b.acquire(Date.now() + 20))();
  });
});

describe('review v0.2 r4 M2: a 413 names the configured cap', () => {
  it('per-reply and cumulative overflows report the cap, never the leftover budget', async () => {
    const f = await fake(([cmd], s) => s.write(cmd === 'VALUE' ? '$6\r\nabcdef\r\n' : cmd === 'BIG' ? `$20\r\n${'x'.repeat(20)}\r\n` : `$2000\r\n${'y'.repeat(2000)}\r\n`));
    const p = pool(f, { cap: 1024 });
    const budget = { remaining: 20 };
    expect(await p.send(['VALUE'], f.endpoint, { replyBudget: budget })).toBe('abcdef');
    expect(budget.remaining).toBe(8);
    const cumulative = (await p.send(['BIG'], f.endpoint, { replyBudget: budget }).catch((e: unknown) => e)) as HttpError;
    expect(cumulative.code).toBe('too_large');
    expect(cumulative.message).toContain('combined 1024-byte');
    expect(JSON.stringify(cumulative.toBody())).not.toMatch(/\b8 bytes/);
    const single = (await p.send(['HUGE'], f.endpoint).catch((e: unknown) => e)) as HttpError;
    expect(single.toBody().error).toMatchObject({ code: 'too_large', message: expect.stringContaining('1024-byte'), hint: expect.stringContaining('1024 bytes') });
  });
});

describe('review v0.2 r4 M3: an abandoned stream handshake keeps nothing', () => {
  it('aborting during HELLO rejects at once, closes the socket and frees the stream slot', async () => {
    const f = await fake(() => {}, 400);
    const p = pool(f, { streams: new CommandBudget(1) });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const start = Date.now();
    await expect(p.dedicated(f.endpoint, stop.signal)).rejects.toMatchObject({ code: 'unavailable' });
    expect(Date.now() - start).toBeLessThan(300);
    await until(() => f.open.size === 0);
    (await p.dedicated(f.endpoint)).destroy();
  });
});

describe('review v0.2 r4 M4: oversized stream events arrive cut and the stream continues', () => {
  it('a MONITOR line over 64 KiB is cut, shown with an ellipsis, and later lines still arrive', async () => {
    const big = 'y'.repeat(70 * 1024);
    const f = await fake(([cmd], s) => {
      if (cmd !== 'MONITOR') return;
      s.write('+OK\r\n');
      setTimeout(() => s.write(`+1700000000.100000 [0 10.0.0.1:5000] "SET" "k" "${big}"\r\n+1700000000.200000 [0 10.0.0.1:5000] "SET" "after" "v"\r\n`), 20);
    });
    const p = pool(f);
    const d = await p.dedicated(f.endpoint);
    const errors: unknown[] = [];
    d.onError((e) => errors.push(e));
    const lines: [string, boolean][] = [];
    await d.monitor((line, cut) => lines.push([line, cut]));
    await until(() => lines.length === 2);
    expect(errors).toEqual([]);
    expect(lines[0]![1]).toBe(true);
    expect(Buffer.byteLength(lines[0]![0])).toBe(STREAM_RETAIN_BYTES);
    expect(parseMonitorLine(lines[0]![0], lines[0]![1])!.argv).toEqual(['SET', 'k', `${'y'.repeat(64)}…`]);
    expect(lines[1]).toEqual(['1700000000.200000 [0 10.0.0.1:5000] "SET" "after" "v"', false]);
    expect(parseMonitorLine(lines[1]![0])!.argv).toEqual(['SET', 'after', 'v']);
    d.destroy();
  });

  it('a pub/sub message larger than the data cap arrives cut with its size, without being buffered', async () => {
    const f = await fake(([cmd], s) => {
      if (cmd !== 'SUBSCRIBE') return;
      s.write('>3\r\n$9\r\nsubscribe\r\n$1\r\nc\r\n:1\r\n');
      const payload = Buffer.alloc(2 * 1024 * 1024, 0x61);
      setTimeout(() => {
        s.write(`>3\r\n$7\r\nmessage\r\n$1\r\nc\r\n$${payload.length}\r\n`);
        s.write(payload);
        s.write('\r\n>3\r\n$7\r\nmessage\r\n$1\r\nc\r\n$5\r\nsmall\r\n');
      }, 20);
    });
    const p = pool(f, { cap: 1024 });
    const d = await p.dedicated(f.endpoint);
    const errors: unknown[] = [];
    d.onError((e) => errors.push(e));
    const got: { size: number; total: number; channel: string }[] = [];
    await d.subscribe(['c'], (m, ch, total) => got.push({ size: m.length, total, channel: ch.toString() }), true);
    await until(() => got.length === 2);
    expect(errors).toEqual([]);
    expect(got).toEqual([{ size: STREAM_RETAIN_BYTES, total: 2 * 1024 * 1024, channel: 'c' }, { size: 5, total: 5, channel: 'c' }]);
    d.destroy();
  });

  it('event mode keeps the start of long strings, counts them in full and still bounds what it retains', () => {
    const r = new RespReader(4096, {}, undefined, undefined, { retain: 8 });
    r.feed(Buffer.from(`*2\r\n+${'a'.repeat(20)}\r\n$30\r\n${'b'.repeat(30)}\r\n`));
    const [line, bulk] = r.value as [RespTruncated, RespTruncated];
    expect(line).toEqual(new RespTruncated('a'.repeat(8), 20));
    expect(bulk).toEqual(new RespTruncated('b'.repeat(8), 30));
    expect(r.bytes).toBeGreaterThan(50);
    // Retained bytes, not wire bytes, are capped in event mode.
    const many = new RespReader(32, {}, undefined, undefined, { retain: 8 });
    expect(() => many.feed(Buffer.from(`*5${'\r\n$9\r\n123456789'.repeat(5)}\r\n`))).toThrow(expect.objectContaining({ code: 'too_large' }));
    // Command replies keep the structural line ceiling.
    expect(() => new RespReader(1 << 20).feed(Buffer.from(`+${'x'.repeat(70 * 1024)}\r\n`))).toThrow(expect.objectContaining({ code: 'too_large' }));
  });
});

describe('review v0.2 r4 L1: cluster redirects only to known primaries', () => {
  it('refused targets are never contacted; allowed ones reuse the redirected-from socket', async () => {
    const target = await fake(([cmd], s) => s.write(cmd === 'ASKING' ? '+OK\r\n' : ':1\r\n'));
    let kind = 'MOVED';
    const origin = await fake((_, s) => s.write(`-${kind} 7 127.0.0.1:${target.endpoint.port}\r\n`));
    const p = pool(origin, { size: 2 });
    const asked: Redirect[] = [];
    const refuse: RedirectPolicy = { allow: async (r) => (asked.push(r), false) };
    for (kind of ['MOVED', 'ASK']) {
      await expect(p.send(['INCR', 'k'], origin.endpoint, {}, refuse)).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('outside its known topology') });
    }
    expect(target.connections).toBe(0);
    expect(asked).toEqual([
      { kind: 'MOVED', slot: 7, endpoint: target.endpoint },
      { kind: 'ASK', slot: 7, endpoint: target.endpoint },
    ]);
    const allow: RedirectPolicy = { allow: async () => true };
    for (kind of ['MOVED', 'ASK', 'MOVED']) expect(await p.send(['INCR', 'k'], origin.endpoint, {}, allow)).toBe(1);
    // A redirect reply leaves the socket clean: the origin was authenticated once for all five commands.
    expect(origin.seen.filter((a) => a[0] === 'HELLO')).toHaveLength(1);
    expect(redirect(new ErrorReply('MOVED 16384 127.0.0.1:1'))).toBeUndefined();
  });
});

describe('review v0.2 r4: bounded wait gate', () => {
  it('hands slots over in FIFO order and cleans up per-key gates', async () => {
    const g = new Gate(1, 2);
    const first = g.tryAcquire()!;
    const order: number[] = [];
    const w1 = g.acquire({ until: Date.now() + 1000, busy: () => new Error('busy') }).then((r) => (order.push(1), r));
    const w2 = g.acquire({ until: Date.now() + 1000, busy: () => new Error('busy') }).then((r) => (order.push(2), r));
    await expect(g.acquire({ until: Date.now() + 1000, busy: () => new Error('full') })).rejects.toThrow('full');
    expect(g.tryAcquire()).toBeNull();
    first();
    (await w1)();
    (await w2)();
    expect(order).toEqual([1, 2]);
    expect(g.idle).toBe(true);
    const keyed = new KeyedGates(1);
    const a = await keyed.acquire('u1', { until: Date.now() + 50, busy: () => new Error('busy') });
    await expect(keyed.acquire('u1', { until: Date.now() + 20, busy: () => new Error('busy') })).rejects.toThrow('busy');
    (await keyed.acquire('u2', { until: Date.now() + 20, busy: () => new Error('busy') }))();
    a();
    expect(keyed.size).toBe(0);
  });
});
