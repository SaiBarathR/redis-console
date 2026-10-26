/**
 * Minimal, binary-safe RESP2 client used only by the test harness (fixtures,
 * assertions on Redis state) and the read-only proxy. Avoids pulling a Redis
 * client dependency into the test package.
 */
import net from 'node:net';

export type Arg = string | Buffer | number;
export type RespValue = string | Buffer | number | null | RespError | RespValue[];
export class RespError extends Error {}

export function encodeCommand(args: readonly Arg[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8');
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

/** Parses one RESP value from `buf` at `pos`. Returns undefined when incomplete. */
export function parseReply(buf: Buffer, pos: number): { value: RespValue; next: number } | undefined {
  if (pos >= buf.length) return undefined;
  const lineEnd = buf.indexOf('\r\n', pos);
  if (lineEnd < 0) return undefined;
  const type = String.fromCharCode(buf[pos]!);
  const line = buf.subarray(pos + 1, lineEnd).toString('utf8');
  const after = lineEnd + 2;
  switch (type) {
    case '+': return { value: line, next: after };
    case '-': return { value: new RespError(line), next: after };
    case ':': return { value: Number(line), next: after };
    case '$': {
      const len = Number(line);
      if (len < 0) return { value: null, next: after };
      if (buf.length < after + len + 2) return undefined;
      return { value: Buffer.from(buf.subarray(after, after + len)), next: after + len + 2 };
    }
    case '*': {
      const n = Number(line);
      if (n < 0) return { value: null, next: after };
      const arr: RespValue[] = [];
      let p = after;
      for (let i = 0; i < n; i++) {
        const r = parseReply(buf, p);
        if (!r) return undefined;
        arr.push(r.value);
        p = r.next;
      }
      return { value: arr, next: p };
    }
    default:
      throw new Error(`Unexpected RESP type byte ${JSON.stringify(type)}`);
  }
}

/**
 * Parses one client->server command (RESP array of bulk strings).
 * Returns null for inline commands (not produced by real clients; the proxy rejects them).
 */
export function parseCommand(buf: Buffer, pos: number): { argv: Buffer[]; next: number } | null | undefined {
  if (pos >= buf.length) return undefined;
  if (buf[pos] !== 0x2a /* * */) return null;
  const r = parseReply(buf, pos);
  if (!r) return undefined;
  if (!Array.isArray(r.value) || !r.value.every((x) => Buffer.isBuffer(x))) return null;
  return { argv: r.value as Buffer[], next: r.next };
}

export class RedisConn {
  private sock: net.Socket;
  private buf = Buffer.alloc(0);
  private waiters: { resolve: (v: RespValue) => void; reject: (e: Error) => void }[] = [];
  private closed = false;

  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      let pos = 0;
      for (;;) {
        const r = parseReply(this.buf, pos);
        if (!r) break;
        pos = r.next;
        const w = this.waiters.shift();
        if (w) w.resolve(r.value);
      }
      this.buf = this.buf.subarray(pos);
    });
    const fail = (e: Error) => { this.closed = true; for (const w of this.waiters.splice(0)) w.reject(e); };
    sock.on('error', fail);
    sock.on('close', () => fail(new Error('connection closed')));
  }

  static async connect(opts: { host: string; port: number; username?: string; password?: string; db?: number }): Promise<RedisConn> {
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(opts.port, opts.host, () => resolve(s));
      s.once('error', reject);
      s.setTimeout(15_000, () => s.destroy(new Error('redis socket timeout')));
    });
    const c = new RedisConn(sock);
    try {
      if (opts.password) await c.cmdOk(opts.username ? ['AUTH', opts.username, opts.password] : ['AUTH', opts.password]);
      if (opts.db) await c.cmdOk(['SELECT', opts.db]);
      return c;
    } catch (e) { c.close(); throw e; }
  }

  /** Raw command; Redis errors are returned as RespError values. */
  raw(args: readonly Arg[]): Promise<RespValue> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.sock.write(encodeCommand(args));
    });
  }

  /** Command that throws on Redis errors. */
  async cmd(args: readonly Arg[]): Promise<RespValue> {
    const v = await this.raw(args);
    if (v instanceof RespError) throw new Error(`${String(args[0])}: ${v.message}`);
    return v;
  }
  async cmdOk(args: readonly Arg[]): Promise<void> { await this.cmd(args); }
  async str(args: readonly Arg[]): Promise<string | null> {
    const v = await this.cmd(args);
    return v == null ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
  }

  close(): void { this.closed = true; this.sock.end(); this.sock.destroy(); }
}
