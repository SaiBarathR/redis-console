/**
 * Read-only RESP proxy in front of the selected remote dataset.
 *
 * The e2e config points database `remote-6390` at this proxy (127.0.0.1:6430)
 * instead of at the upstream directly. Every command the server sends is parsed; only
 * read-only commands (Redis `readonly` flag, or an explicit allowlist of
 * connection / introspection commands) are forwarded. Anything else is NOT
 * forwarded: the proxy records a violation and drops the connection.
 *
 * This makes the "writes against readOnly/prod are rejected" tests safe even if
 * the server under test has a bug, and lets a test assert that no non-read
 * command ever reached the upstream.
 */
import net from 'node:net';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseCommand, RedisConn } from './resp.ts';
import { STATE_DIR } from './env.ts';

export const PROXY_VIOLATIONS_FILE = path.join(STATE_DIR, 'proxy-violations.jsonl');
export const PROXY_SEEN_FILE = path.join(STATE_DIR, 'proxy-seen.json');

/** Allowed even without the `readonly` flag: connection setup and pure introspection. */
const EXTRA_ALLOWED = new Set([
  'AUTH', 'HELLO', 'PING', 'ECHO', 'SELECT', 'READONLY', 'QUIT', 'RESET',
  'CLIENT|SETINFO', 'CLIENT|SETNAME', 'CLIENT|ID', 'CLIENT|GETNAME', 'CLIENT|INFO', 'CLIENT|LIST',
  'INFO', 'DBSIZE', 'TIME', 'ROLE', 'LASTSAVE', 'LOLWUT',
  'COMMAND', 'COMMAND|DOCS', 'COMMAND|INFO', 'COMMAND|COUNT', 'COMMAND|LIST', 'COMMAND|GETKEYS', 'COMMAND|GETKEYSANDFLAGS',
  'MODULE|LIST', 'CONFIG|GET', 'ACL|WHOAMI', 'ACL|CAT',
  'SLOWLOG|GET', 'SLOWLOG|LEN',
  'LATENCY|LATEST', 'LATENCY|HISTORY', 'LATENCY|DOCTOR', 'LATENCY|HISTOGRAM', 'LATENCY|GRAPH',
  'MEMORY|USAGE', 'MEMORY|STATS', 'MEMORY|DOCTOR',
  'PUBSUB|CHANNELS', 'PUBSUB|NUMSUB', 'PUBSUB|NUMPAT', 'PUBSUB|SHARDCHANNELS', 'PUBSUB|SHARDNUMSUB',
  'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'UNSUBSCRIBE', 'PUNSUBSCRIBE', 'SUNSUBSCRIBE',
  'CLUSTER|INFO', 'CLUSTER|NODES', 'CLUSTER|SLOTS', 'CLUSTER|SHARDS', 'CLUSTER|MYID', 'CLUSTER|KEYSLOT',
  'FT._LIST', 'FT.INFO', 'FT.SEARCH', 'FT.AGGREGATE', 'FT.EXPLAIN', 'FT.PROFILE',
]);
/** Never forwarded even if flagged readonly (side effects on the server or connection). */
const ALWAYS_BLOCKED = new Set(['MONITOR', 'DEBUG', 'SCRIPT', 'FUNCTION', 'EVAL_RO', 'EVALSHA_RO', 'FCALL_RO', 'CLIENT|KILL', 'CLIENT|PAUSE', 'CLIENT|NO-EVICT', 'CLIENT|TRACKING']);

export async function loadReadonlyCommandSet(opts: { host: string; port: number; username: string; password: string }): Promise<Set<string>> {
  const c = await RedisConn.connect(opts);
  try {
    const info = (await c.cmd(['COMMAND'])) as unknown[];
    const out = new Set<string>();
    const visit = (entry: unknown) => {
      if (!Array.isArray(entry)) return;
      const name = Buffer.isBuffer(entry[0]) ? entry[0].toString().toUpperCase() : String(entry[0]).toUpperCase();
      const flags = (entry[2] as unknown[] | undefined ?? []).map((f) => (Buffer.isBuffer(f) ? f.toString() : String(f)).toLowerCase());
      if (flags.includes('readonly') && !flags.includes('write')) out.add(name);
      const subs = entry[9];
      if (Array.isArray(subs)) for (const s of subs) visit(s);
    };
    for (const e of info) visit(e);
    return out;
  } finally {
    c.close();
  }
}

export function classifyForProxy(argv: Buffer[], readonly: Set<string>): boolean {
  const name = (argv[0]?.toString('utf8') ?? '').toUpperCase();
  const sub = argv[1] ? `${name}|${argv[1].toString('utf8').toUpperCase()}` : '';
  if (ALWAYS_BLOCKED.has(name) || (sub && ALWAYS_BLOCKED.has(sub))) return false;
  if (sub && (EXTRA_ALLOWED.has(sub) || readonly.has(sub))) return true;
  if (EXTRA_ALLOWED.has(name)) return true;
  // Parents with subcommands must match a subcommand entry (fail closed).
  const hasSubcommands = [...readonly].some((c) => c.startsWith(`${name}|`)) || [...EXTRA_ALLOWED].some((c) => c.startsWith(`${name}|`));
  if (hasSubcommands) return false;
  return readonly.has(name);
}

export interface ProxyHandle { close(): Promise<void>; port: number }

export async function startReadonlyProxy(opts: {
  listenPort: number;
  upstream: { host: string; port: number };
  readonlyCommands: Set<string>;
}): Promise<ProxyHandle> {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PROXY_VIOLATIONS_FILE, '');
  const seen: Record<string, number> = {};
  const flushSeen = () => writeFileSync(PROXY_SEEN_FILE, JSON.stringify(seen, null, 1));
  flushSeen();
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    sockets.add(client);
    const upstream = net.connect(opts.upstream.port, opts.upstream.host);
    sockets.add(upstream);
    let buf = Buffer.alloc(0);
    const kill = () => { client.destroy(); upstream.destroy(); };
    upstream.on('data', (d) => client.write(d));
    upstream.on('error', kill);
    upstream.on('close', kill);
    client.on('error', kill);
    client.on('close', () => { kill(); sockets.delete(client); sockets.delete(upstream); });
    client.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      let pos = 0;
      const forward: Buffer[] = [];
      for (;;) {
        const parsed = parseCommand(buf, pos);
        if (parsed === undefined) break;
        if (parsed === null) {
          // Say what arrived without recording data: an HTTP request line's method (a port probe from another
          // process), or that the bytes were not RESP. The app's own client always speaks RESP arrays.
          const http = /^(GET|HEAD|POST|PUT|OPTIONS|CONNECT|PRI) /.exec(buf.subarray(pos, pos + 16).toString('latin1'));
          appendFileSync(PROXY_VIOLATIONS_FILE, JSON.stringify({ at: new Date().toISOString(), command: http ? `<HTTP ${http[1]} request>` : '<inline or malformed>', clientPort: client.remotePort }) + '\n');
          kill();
          return;
        }
        const name = (parsed.argv[0]?.toString('utf8') ?? '').toUpperCase();
        const label = parsed.argv[1] && /^[A-Za-z._-]{1,32}$/.test(parsed.argv[1].toString('utf8')) ? `${name} ${parsed.argv[1].toString('utf8').toUpperCase()}` : name;
        if (!classifyForProxy(parsed.argv, opts.readonlyCommands)) {
          // Only the command name (+ subcommand) is recorded, never arguments.
          appendFileSync(PROXY_VIOLATIONS_FILE, JSON.stringify({ at: new Date().toISOString(), command: label }) + '\n');
          if (forward.length) upstream.write(Buffer.concat(forward));
          kill();
          return;
        }
        seen[label] = (seen[label] ?? 0) + 1;
        forward.push(buf.subarray(pos, parsed.next));
        pos = parsed.next;
      }
      buf = buf.subarray(pos);
      if (forward.length) { upstream.write(Buffer.concat(forward)); flushSeen(); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.listenPort, '127.0.0.1', () => resolve());
  });
  return {
    port: opts.listenPort,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}
