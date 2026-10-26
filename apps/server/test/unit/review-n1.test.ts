/**
 * Review v0.2 fix verification, N1: the measured transport checks the actor (`SendOpts.stillAllowed`) synchronously
 * right before a command's bytes are written: after the pool and command-budget waits, after the connection
 * handshake, and again on a redirected re-dispatch. A refusal sends nothing and releases the slot and the socket.
 */
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CappedPool, CommandBudget, type RedirectPolicy } from '../../src/redis/capped.ts';
import { fixedReply, measured } from '../../src/redis/manager.ts';
import { RespReader } from '../../src/redis/resp.ts';
import type { DatabaseConfig } from '../../src/config.ts';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const anyPrimary: RedirectPolicy = { allow: async () => true };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const refused = { code: 'unauthenticated', status: 401, message: expect.stringMatching(/was not sent/) };

/** A fake Redis: HELLO/SELECT are answered after `handshake()` resolves; other commands by `command`. */
async function server(command: (args: string[], socket: net.Socket) => void, handshake: () => Promise<void> = async () => {}) {
  const sockets = new Set<net.Socket>(), seen: string[][] = [];
  const srv = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let reader = new RespReader(128 * 1024);
    socket.on('data', (chunk) => {
      for (let i = 0; i < chunk.length;) {
        i += reader.feed(chunk.subarray(i), true);
        if (!reader.done) continue;
        const args = (reader.value as unknown[]).map(String);
        reader = new RespReader(128 * 1024);
        seen.push(args);
        if (args[0] === 'HELLO' || args[0] === 'SELECT') void handshake().then(() => socket.write('+OK\r\n'));
        else command(args, socket);
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }));
  return { endpoint: { host: '127.0.0.1', port: (srv.address() as net.AddressInfo).port }, seen, sockets };
}
function pool(port: number, budget: CommandBudget, size = 1) {
  const db: DatabaseConfig = { id: 'fake', name: 'Fake', environment: 'test', mode: 'standalone', url: `redis://127.0.0.1:${port}`, db: 0, credentials: { default: { username: 'default' } }, poolSize: size, maxRole: 'admin', readOnly: false };
  const p = new CappedPool(db, db.credentials.default!, 'operator', 1024, budget, new CommandBudget(16));
  cleanups.push(async () => p.close());
  return p;
}
const sent = (s: { seen: string[][] }, cmd: string) => s.seen.filter((a) => a[0] === cmd).length;

describe('review v0.2 N1: the measured transport checks the actor right before it writes', () => {
  it('a command that waited for the full pool is refused when its actor was revoked meanwhile; nothing is sent, slots are released', async () => {
    const s = await server(([cmd], sock) => { if (cmd !== 'HANG') sock.write('+OK\r\n'); });
    const budget = new CommandBudget(1);
    const p = pool(s.endpoint.port, budget);
    const stop = new AbortController();
    const hang = p.send(['HANG'], s.endpoint, { signal: stop.signal }).catch((e: unknown) => e);
    await sleep(20);
    let allowed = true;
    const queued = p.send(['SET', 'k', 'v'], s.endpoint, { stillAllowed: () => allowed });
    await sleep(20);
    allowed = false; // revoked while it waits for the pool socket
    stop.abort();
    await expect(queued).rejects.toMatchObject(refused);
    await hang;
    expect(sent(s, 'SET')).toBe(0);
    expect(budget.active).toBe(0);
    expect(await p.send(['SET', 'k', 'v'], s.endpoint, { stillAllowed: () => true })).toBe('OK');
  });

  it('a command whose new connection is still authenticating is refused when its actor was revoked meanwhile', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const s = await server((_, sock) => sock.write('+OK\r\n'), () => gate);
    const budget = new CommandBudget(1);
    const p = pool(s.endpoint.port, budget);
    let allowed = true;
    const pending = p.send(['PUBLISH', 'c', 'm'], s.endpoint, { stillAllowed: () => allowed });
    for (let i = 0; i < 100 && !sent(s, 'HELLO'); i++) await sleep(5);
    expect(sent(s, 'HELLO')).toBe(1);
    allowed = false;
    open();
    await expect(pending).rejects.toMatchObject(refused);
    expect(sent(s, 'PUBLISH')).toBe(0);
    expect(budget.active).toBe(0);
    // The refused command's socket is not reused (closed): the next command authenticates a new one.
    expect(await p.send(['PUBLISH', 'c', 'm'], s.endpoint)).toBe('OK');
    expect(sent(s, 'HELLO')).toBe(2);
  });

  it('a MOVED or ASK re-dispatch is checked again', async () => {
    const dest = await server(([cmd], sock) => sock.write(cmd === 'ASKING' ? '+OK\r\n' : '$3\r\nyes\r\n'));
    for (const kind of ['MOVED', 'ASK']) {
      const origin = await server((_, sock) => sock.write(`-${kind} 1 127.0.0.1:${dest.endpoint.port}\r\n`));
      const p = pool(origin.endpoint.port, new CommandBudget(2), 2);
      let checks = 0;
      await expect(p.send(['SET', 'k', 'v'], origin.endpoint, { stillAllowed: () => ++checks === 1 }, anyPrimary)).rejects.toMatchObject(refused);
      expect(checks).toBe(2);
      expect(sent(origin, 'SET')).toBe(1);
      expect(sent(dest, 'SET')).toBe(0);
    }
  });

  it('every command of an exclusive exchange is checked; the exchange stops at the first refusal', async () => {
    const s = await server((_, sock) => sock.write('+OK\r\n'));
    const budget = new CommandBudget(1);
    const p = pool(s.endpoint.port, budget);
    let allowed = true;
    await expect(p.exclusive(s.endpoint, { stillAllowed: () => allowed }, async (send) => {
      await send(['WATCH', 'k']);
      allowed = false; // revoked during the reads
      await send(['MULTI']);
      return send(['EXEC']);
    })).rejects.toMatchObject(refused);
    expect(s.seen.map((a) => a[0]).filter((c) => c !== 'HELLO')).toEqual(['WATCH']);
    expect(budget.active).toBe(0);
  });

  it('a stream socket checks the actor before SUBSCRIBE or MONITOR', async () => {
    const s = await server((_, sock) => sock.write('>3\r\n+subscribe\r\n$1\r\nc\r\n:1\r\n'));
    const p = pool(s.endpoint.port, new CommandBudget(1));
    const c = await p.dedicated(s.endpoint, undefined, () => false);
    await expect(c.subscribe(['c'], () => {}, true)).rejects.toMatchObject(refused);
    await expect(c.monitor(() => {})).rejects.toMatchObject(refused);
    c.destroy();
    expect(sent(s, 'SUBSCRIBE') + sent(s, 'MONITOR')).toBe(0);
    const ok = await p.dedicated(s.endpoint, undefined, () => true);
    await ok.subscribe(['c'], () => {}, true);
    ok.destroy();
    expect(sent(s, 'SUBSCRIBE')).toBe(1);
  });

  it('every command with an actor check goes through the measured transport; node-redis keeps only unchecked fixed-size ones (N1 follow-up)', () => {
    for (const argv of [['EXPIRE', 'k', '1'], ['HSET', 'k', 'f', 'v'], ['UNLINK', 'k'], ['DEL', 'k'], ['LSET', 'k', '0', 'v'], ['XADD', 'k', '*', 'f', 'v'], ['DBSIZE'], ['PING'], ['TYPE', 'k']]) {
      expect(fixedReply(argv)).toBe(true);
      expect(measured(argv, { stillAllowed: () => true })).toBe(true);
      expect(measured(argv, { stillAllowed: () => false })).toBe(true);
      expect(measured(argv, { readonly: true })).toBe(false);
      expect(measured(argv, {})).toBe(false);
    }
    expect(measured(['GET', 'k'], {})).toBe(true);
    expect(measured(['PING'], { capped: true })).toBe(true);
  });
});
