/**
 * A minimal in-process RESP3 server that node-redis and the measured sockets can both use, for timing cases a real
 * Redis cannot produce on demand (a slow handshake, a slow reply). Records command names only.
 */
import net from 'node:net';
import { RespReader } from '../../src/redis/resp.ts';

export interface FakeRedis {
  port: number;
  /** Open sockets that identified themselves as measured ("-capped") connections. */
  capped: Set<net.Socket>;
  commands: string[];
  close(): Promise<void>;
}

export interface FakeOptions {
  /** Delay before answering HELLO on measured sockets. */
  cappedHelloDelayMs?: number;
  /** Extra replies; return undefined to fall back to the defaults. */
  reply?: (args: string[], socket: net.Socket) => boolean | void;
}

export async function startFakeRedis(o: FakeOptions = {}): Promise<FakeRedis> {
  const sockets = new Set<net.Socket>();
  const f: FakeRedis = { port: 0, capped: new Set(), commands: [], close: async () => {} };
  const srv = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      f.capped.delete(socket);
    });
    let reader = new RespReader(1 << 20);
    socket.on('data', (chunk) => {
      try {
        for (let i = 0; i < chunk.length;) {
          i += reader.feed(chunk.subarray(i), true);
          if (!reader.done) continue;
          const args = (reader.value as unknown[]).map(String);
          reader = new RespReader(1 << 20);
          const cmd = args[0]!.toUpperCase();
          f.commands.push(cmd);
          if (o.reply?.(args, socket)) continue;
          if (cmd === 'HELLO') {
            const capped = args.some((a) => a.endsWith('-capped'));
            if (capped) f.capped.add(socket);
            const answer = () => socket.writable && socket.write('%1\r\n+server\r\n+fake\r\n');
            if (capped && o.cappedHelloDelayMs) setTimeout(answer, o.cappedHelloDelayMs);
            else answer();
          } else if (cmd === 'SUBSCRIBE') {
            socket.write(args.slice(1).map((ch, n) => `>3\r\n$9\r\nsubscribe\r\n$${Buffer.byteLength(ch)}\r\n${ch}\r\n:${n + 1}\r\n`).join(''));
          } else if (cmd === 'PING') socket.write('+PONG\r\n');
          else if (cmd === 'INFO') socket.write('$29\r\n# Server\r\nredis_version:8.0.0\r\n\r\n');
          else if (cmd === 'COMMAND') socket.write('*0\r\n');
          else if (cmd === 'ECHO') socket.write(`$${Buffer.byteLength(args[1] ?? '')}\r\n${args[1] ?? ''}\r\n`);
          else socket.write('+OK\r\n');
        }
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  f.port = (srv.address() as net.AddressInfo).port;
  f.close = () => new Promise<void>((r) => {
    for (const s of sockets) s.destroy();
    srv.close(() => r());
  });
  return f;
}
