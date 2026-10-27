import type { Role } from './roles.ts';

/**
 * Command policy. The server is the only enforcement point (plus Redis ACLs underneath);
 * the web app imports this only to show hints before a request is sent.
 *
 * Unknown commands fail closed: the server classifies them from COMMAND INFO flags
 * (readonly -> read, write -> write, admin/dangerous -> blocked) and blocks anything
 * it cannot classify.
 */
export type CommandClass =
  | 'read' // viewer+
  | 'write' // operator+, blocked on read-only databases
  | 'admin' // admin only
  | 'dedicated' // only via a dedicated feature endpoint (pub/sub, profiler)
  | 'blocked'; // never executable from the app

export type ConfirmLevel = 'none' | 'confirm' | 'typed';

export interface CommandRule {
  class: CommandClass;
  /** Destructive operations need an explicit confirmation round-trip. */
  confirm?: ConfirmLevel;
  /** Shown to the user when the command is blocked or redirected. */
  hint?: string;
  /** Not allowed on databases tagged environment=prod, even for admins. */
  nonProdOnly?: boolean;
}

const B = (hint: string): CommandRule => ({ class: 'blocked', hint });

/** Top-level command rules. Keys are upper-case command names. */
export const COMMAND_RULES: Record<string, CommandRule> = {
  // Key enumeration
  KEYS: B('KEYS blocks the server on large keyspaces. Use SCAN (the key browser uses it automatically).'),
  SCAN: { class: 'read' },
  // Destructive key operations
  DEL: { class: 'write', confirm: 'confirm' },
  UNLINK: { class: 'write', confirm: 'confirm' },
  RENAME: { class: 'write', confirm: 'confirm' },
  RENAMENX: { class: 'write' },
  LTRIM: { class: 'write', confirm: 'confirm' },
  ZREMRANGEBYSCORE: { class: 'write', confirm: 'confirm' },
  ZREMRANGEBYRANK: { class: 'write', confirm: 'confirm' },
  ZREMRANGEBYLEX: { class: 'write', confirm: 'confirm' },
  XTRIM: { class: 'write', confirm: 'confirm' },
  FLUSHDB: { class: 'admin', confirm: 'typed', nonProdOnly: true },
  FLUSHALL: B('FLUSHALL is disabled. Admins can use FLUSHDB on non-production databases.'),
  SWAPDB: B('SWAPDB is disabled.'),
  MOVE: B('Moving keys between logical databases is disabled.'),
  COPY: { class: 'write' },
  RESTORE: B('RESTORE is disabled (accepts arbitrary serialized payloads).'),
  'RESTORE-ASKING': B('Internal cluster command.'),
  MIGRATE: B('MIGRATE is disabled (opens connections to other hosts).'),
  SELECT: B('Logical database is fixed by server configuration. Pick a different database in the sidebar.'),
  // Scripting / modules / server control
  EVAL: B('Lua scripting is disabled.'),
  EVALSHA: B('Lua scripting is disabled.'),
  EVAL_RO: B('Lua scripting is disabled.'),
  EVALSHA_RO: B('Lua scripting is disabled.'),
  FCALL: B('Redis Functions are disabled.'),
  FCALL_RO: B('Redis Functions are disabled.'),
  FUNCTION: B('Redis Functions are disabled.'),
  SCRIPT: B('Lua scripting is disabled.'),
  MODULE: B('Module management is disabled.'),
  DEBUG: B('DEBUG is disabled.'),
  SHUTDOWN: B('SHUTDOWN is disabled.'),
  REPLICAOF: B('Replication changes are disabled.'),
  SLAVEOF: B('Replication changes are disabled.'),
  FAILOVER: B('Failover is disabled.'),
  SYNC: B('Internal replication command.'),
  PSYNC: B('Internal replication command.'),
  REPLCONF: B('Internal replication command.'),
  SAVE: B('Persistence control is disabled.'),
  BGSAVE: B('Persistence control is disabled.'),
  BGREWRITEAOF: B('Persistence control is disabled.'),
  LASTSAVE: { class: 'read' },
  // Connection-level commands that would desync the server-side connection
  AUTH: B('Authentication is handled by the server.'),
  HELLO: B('Protocol negotiation is handled by the server.'),
  RESET: B('Connection state is managed by the server.'),
  QUIT: B('Connection state is managed by the server.'),
  MULTI: B('Transactions are not supported in the console; commands run one at a time.'),
  EXEC: B('Transactions are not supported in the console.'),
  DISCARD: B('Transactions are not supported in the console.'),
  WATCH: B('Transactions are not supported in the console.'),
  UNWATCH: B('Transactions are not supported in the console.'),
  WAIT: B('WAIT is disabled.'),
  WAITAOF: B('WAITAOF is disabled.'),
  // Dedicated features
  SUBSCRIBE: { class: 'dedicated', hint: 'Use the Pub/Sub page to subscribe.' },
  PSUBSCRIBE: { class: 'dedicated', hint: 'Use the Pub/Sub page to subscribe.' },
  SSUBSCRIBE: { class: 'dedicated', hint: 'Use the Pub/Sub page to subscribe.' },
  UNSUBSCRIBE: { class: 'dedicated', hint: 'Use the Pub/Sub page.' },
  PUNSUBSCRIBE: { class: 'dedicated', hint: 'Use the Pub/Sub page.' },
  SUNSUBSCRIBE: { class: 'dedicated', hint: 'Use the Pub/Sub page.' },
  MONITOR: { class: 'dedicated', hint: 'Use the Profiler page (admins only, time-limited).' },
  PUBLISH: { class: 'write' },
  SPUBLISH: { class: 'write' },
  // Server info
  INFO: { class: 'read' },
  PING: { class: 'read' },
  ECHO: { class: 'read' },
  TIME: { class: 'read' },
  DBSIZE: { class: 'read' },
  ROLE: { class: 'read' },
  LOLWUT: { class: 'read' },
  DUMP: { class: 'read' },
  // Modules (flags alone would block these: FT._LIST is @admin, FT.DROPINDEX is @dangerous)
  'FT._LIST': { class: 'read' },
  // v0.2.1 (F7): dropping an index is an admin action with a typed confirmation, wherever it is run. `DD` (delete the
  // indexed keys too) is refused by `argumentRule`; the Search tool's drop can do it only when server policy allows.
  'FT.DROPINDEX': { class: 'admin', confirm: 'typed' },
  // Module flags are set by module authors and are not trusted alone: the server treats a `readonly` command as
  // a read only when it is also in @read. These are reads that their modules put in no ACL category (or only
  // @search), reviewed one by one.
  'FT.INFO': { class: 'read' },
  'FT.EXPLAIN': { class: 'read' },
  'FT.EXPLAINCLI': { class: 'read' },
  'FT.SPELLCHECK': { class: 'read' },
  'FT.SYNDUMP': { class: 'read' },
  'FT.DICTDUMP': { class: 'read' },
  'FT.ALIASLIST': { class: 'read' },
  // v0.4 vector sets: every V* command has an explicit rule (module flags are not trusted alone; a command Redis adds
  // later fails closed until it is reviewed). The inspector sends these as fixed typed reads and `vset.*` ops; in the
  // console VREM needs no confirmation, like HDEL, SREM and ZREM (the inspector's typed `vset.remove` asks, like
  // `hash.delete`). VADD replaces an existing member's vector: the inspector's `vset.add` refuses that (409).
  VCARD: { class: 'read' },
  VDIM: { class: 'read' },
  VEMB: { class: 'read' },
  VGETATTR: { class: 'read' },
  VINFO: { class: 'read' },
  VISMEMBER: { class: 'read' },
  VLINKS: { class: 'read' },
  VRANDMEMBER: { class: 'read' },
  VRANGE: { class: 'read' },
  VSIM: { class: 'read' },
  VADD: { class: 'write' },
  VREM: { class: 'write' },
  VSETATTR: { class: 'write' },
  // Flagged readonly + @read, but they change state.
  'CF.COMPACT': { class: 'write' },
  // v0.4 arrays (Redis 8.8+). Reviewed one by one rather than left to COMMAND INFO flags. Reads are bounded by Redis
  // (ARGETRANGE refuses more than 1,000,000 items) or by the reply cap; ARGREP's RE predicate is refused by
  // `argumentRule` (no time bound inside Redis). Writes that drop elements confirm: ARDEL, ARDELRANGE, and ARRING,
  // which overwrites the oldest elements when it wraps and deletes the ones outside a smaller ring. ARSET, ARMSET and
  // ARINSERT replace elements the way SET and HSET do and need no confirmation (the inspector's own edits are
  // compare-and-set); ARSEEK moves the insert cursor only.
  ARGET: { class: 'read' },
  ARMGET: { class: 'read' },
  ARGETRANGE: { class: 'read' },
  ARSCAN: { class: 'read' },
  ARGREP: { class: 'read' },
  AROP: { class: 'read' },
  ARLASTITEMS: { class: 'read' },
  ARNEXT: { class: 'read' },
  ARLEN: { class: 'read' },
  ARCOUNT: { class: 'read' },
  ARINFO: { class: 'read' },
  ARSET: { class: 'write' },
  ARMSET: { class: 'write' },
  ARINSERT: { class: 'write' },
  ARSEEK: { class: 'write' },
  ARRING: { class: 'write', confirm: 'confirm' },
  ARDEL: { class: 'write', confirm: 'confirm' },
  ARDELRANGE: { class: 'write', confirm: 'confirm' },
};

/**
 * Module-internal command families (cluster coordination, internal variants of public commands). Their flags
 * say "readonly" although some change the coordinator's topology, and some never reply on standalone servers.
 */
const INTERNAL_COMMAND = /^(?:_|SEARCH\.|TIMESERIES\.|FT\._|_FT\.)/;

/** Rules for "COMMAND SUBCOMMAND" pairs. Keys are "COMMAND|SUBCOMMAND", upper-case. */
export const SUBCOMMAND_RULES: Record<string, CommandRule> = {
  'CONFIG|GET': { class: 'admin' },
  'CONFIG|SET': B('CONFIG SET is disabled (can be abused to write files on the server).'),
  'CONFIG|REWRITE': B('CONFIG REWRITE is disabled.'),
  'CONFIG|RESETSTAT': B('CONFIG RESETSTAT is disabled.'),
  'CLIENT|LIST': { class: 'admin' },
  'CLIENT|INFO': { class: 'read' },
  'CLIENT|ID': { class: 'read' },
  'CLIENT|GETNAME': { class: 'read' },
  'CLIENT|KILL': { class: 'admin', confirm: 'confirm' },
  'SLOWLOG|GET': { class: 'read' },
  'SLOWLOG|LEN': { class: 'read' },
  'SLOWLOG|RESET': { class: 'admin', confirm: 'confirm' },
  'MEMORY|USAGE': { class: 'read' },
  'MEMORY|STATS': { class: 'read' },
  'MEMORY|DOCTOR': { class: 'read' },
  'MEMORY|MALLOC-STATS': { class: 'admin' },
  'MEMORY|PURGE': { class: 'admin' },
  'LATENCY|LATEST': { class: 'read' },
  'LATENCY|HISTORY': { class: 'read' },
  'LATENCY|DOCTOR': { class: 'read' },
  'LATENCY|GRAPH': { class: 'read' },
  'LATENCY|HISTOGRAM': { class: 'read' },
  'LATENCY|RESET': { class: 'admin' },
  'COMMAND|DOCS': { class: 'read' },
  'COMMAND|INFO': { class: 'read' },
  'COMMAND|COUNT': { class: 'read' },
  'COMMAND|LIST': { class: 'read' },
  'COMMAND|GETKEYS': { class: 'read' },
  'COMMAND|GETKEYSANDFLAGS': { class: 'read' },
  'OBJECT|ENCODING': { class: 'read' },
  'OBJECT|FREQ': { class: 'read' },
  'OBJECT|IDLETIME': { class: 'read' },
  'OBJECT|REFCOUNT': { class: 'read' },
  'ACL|WHOAMI': { class: 'read' },
  'ACL|CAT': { class: 'read' },
  'PUBSUB|CHANNELS': { class: 'read' },
  'PUBSUB|NUMSUB': { class: 'read' },
  'PUBSUB|NUMPAT': { class: 'read' },
  'PUBSUB|SHARDCHANNELS': { class: 'read' },
  'PUBSUB|SHARDNUMSUB': { class: 'read' },
  'CLUSTER|INFO': { class: 'read' },
  'CLUSTER|NODES': { class: 'read' },
  'CLUSTER|SHARDS': { class: 'read' },
  'CLUSTER|SLOTS': { class: 'read' },
  'CLUSTER|MYID': { class: 'read' },
  'CLUSTER|KEYSLOT': { class: 'read' },
  'CLUSTER|COUNTKEYSINSLOT': { class: 'read' },
  'XGROUP|DESTROY': { class: 'write', confirm: 'confirm' },
  'XGROUP|DELCONSUMER': { class: 'write', confirm: 'confirm' },
  'XINFO|STREAM': { class: 'read' },
  'XINFO|GROUPS': { class: 'read' },
  'XINFO|CONSUMERS': { class: 'read' },
  // FT.CURSOR DEL frees a cursor (any client's, by id); GC and anything newer stay blocked.
  'FT.CURSOR|READ': { class: 'read' },
  'FT.CURSOR|DEL': { class: 'write' },
};

/** Commands with subcommands where unknown subcommands must be blocked (fail closed). */
export const SUBCOMMAND_PARENTS = new Set([
  'CONFIG', 'CLIENT', 'SLOWLOG', 'MEMORY', 'LATENCY', 'COMMAND', 'OBJECT', 'ACL', 'PUBSUB',
  'CLUSTER', 'XGROUP', 'XINFO', 'FUNCTION', 'SCRIPT', 'MODULE', 'FT.CURSOR',
]);

export const CLASS_MIN_ROLE: Record<Exclude<CommandClass, 'blocked' | 'dedicated'>, Role> = {
  read: 'viewer',
  write: 'operator',
  admin: 'admin',
};

/**
 * Rules that depend on arguments, not only on the command name. Checked before `lookupRule` by the server's
 * classification and by the browser's hints. Undefined when the arguments change nothing.
 */
export function argumentRule(argv: readonly string[]): CommandRule | undefined {
  const name = (argv[0] ?? '').toUpperCase();
  if (name === 'FT.DROPINDEX' && argv.slice(2).some((a) => a.toUpperCase() === 'DD')) {
    return B('FT.DROPINDEX ... DD also deletes every indexed key and is disabled here. Drop the index without DD to keep the documents.');
  }
  // v0.4 arrays
  if (name === 'ARGREP' && argrepPredicates(argv).includes('RE')) return B(ARGREP_RE_HINT);
  return undefined;
}

/**
 * v0.4 arrays: why `ARGREP … RE …` is blocked. Redis runs the regular expression on every element of the range inside
 * its main thread, with no time limit and no way to stop it, and the cost grows with the pattern's states times the
 * value bytes: on Redis 8.10, `((.?){255}){4}b` took about 1 s for one 1 KiB element, and `((a?){50}){5}b` blocked the
 * server for 60 s over 50,000 elements of 28 bytes. Range, LIMIT and pattern-length caps do not bound that.
 */
export const ARGREP_RE_HINT = 'ARGREP with RE is disabled: Redis runs the regular expression on every element of the range without a time limit, and one pattern can block the server for minutes. Use EXACT, MATCH (substring) or GLOB.';

/**
 * The predicate keywords of an `ARGREP key start end <predicate>… [option]…` argv, upper-cased (EXACT, MATCH, GLOB,
 * RE), read the way Redis reads them: a predicate keyword and LIMIT take the next argument as their value, so a value
 * that happens to be "RE" (`EXACT RE`) is not a predicate.
 */
export function argrepPredicates(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 4; i < argv.length; i++) {
    const t = (argv[i] ?? '').toUpperCase();
    if (t === 'EXACT' || t === 'MATCH' || t === 'GLOB' || t === 'RE') {
      out.push(t);
      i++;
    } else if (t === 'LIMIT') i++;
  }
  return out;
}

/** Static lookup only (no COMMAND INFO). Returns undefined when the server must classify from flags. */
export function lookupRule(argv: readonly string[]): CommandRule | undefined {
  const name = (argv[0] ?? '').toUpperCase();
  if (SUBCOMMAND_PARENTS.has(name)) {
    const sub = (argv[1] ?? '').toUpperCase();
    const subRule = SUBCOMMAND_RULES[`${name}|${sub}`];
    if (subRule) return subRule;
    const parentRule = COMMAND_RULES[name];
    if (parentRule?.class === 'blocked') return parentRule;
    return B(`${name} ${sub || '(no subcommand)'} is not allowed.`);
  }
  const rule = COMMAND_RULES[name];
  if (rule) return rule;
  if (INTERNAL_COMMAND.test(name)) return B(`${name} is an internal module command and is not allowed.`);
  return undefined;
}

/**
 * Argument separators, exactly as redis-cli splits a line (C `isspace`: space, \t, \n, \v, \f, \r).
 * JavaScript's `\s` also matches BOM, NBSP and other Unicode spaces; treating those as separators would
 * silently drop them from a key name and target a different key.
 */
export function isRedisSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';
}

/**
 * Tokenize a redis-cli style command line into raw bytes. Supports "double quotes" with
 * \n \r \t \b \a \" \\ \xHH escapes (\xHH is one raw byte), and 'single quotes' with \' only
 * (redis-cli semantics). Text outside escapes is UTF-8 encoded. Throws on unbalanced quotes.
 */
export function tokenizeCommandLineBytes(line: string): Uint8Array[] {
  const enc = new TextEncoder();
  const out: Uint8Array[] = [];
  let i = 0;
  const n = line.length;
  const isSpace = isRedisSpace;
  while (i < n) {
    while (i < n && isSpace(line[i]!)) i++;
    if (i >= n) break;
    const bytes: number[] = [];
    const text = (s: string) => { for (const b of enc.encode(s)) bytes.push(b); };
    let started = false;
    while (i < n && !isSpace(line[i]!)) {
      const c = line[i]!;
      if (c === '"' || c === "'") {
        const q = c;
        i++;
        let closed = false;
        while (i < n) {
          const d = line[i]!;
          if (d === '\\' && i + 1 < n) {
            const e = line[i + 1]!;
            if (q === "'") {
              if (e === "'") { text("'"); i += 2; continue; }
              text(d); i++; continue;
            }
            if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
              bytes.push(parseInt(line.slice(i + 2, i + 4), 16)); i += 4; continue;
            }
            const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07', '"': '"', '\\': '\\' };
            text(map[e] ?? e); i += 2; continue;
          }
          if (d === q) { closed = true; i++; break; }
          // Keep surrogate pairs together.
          const cp = line.codePointAt(i)!;
          const ch = String.fromCodePoint(cp);
          text(ch); i += ch.length;
        }
        if (!closed) throw new Error('Unbalanced quotes');
        started = true;
        // redis-cli requires whitespace after a closing quote
        if (i < n && !isSpace(line[i]!)) throw new Error('Closing quote must be followed by a space');
      } else {
        const cp = line.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        text(ch); i += ch.length; started = true;
      }
    }
    if (started) out.push(Uint8Array.from(bytes));
  }
  return out;
}

/**
 * Tokenize a redis-cli style command line. Supports "double quotes" with
 * \n \r \t \" \\ \xHH escapes, and 'single quotes' with \' only (redis-cli semantics).
 * Throws on unbalanced quotes.
 */
export function tokenizeCommandLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && isRedisSpace(line[i]!)) i++;
    if (i >= n) break;
    let tok = '';
    let started = false;
    while (i < n && !isRedisSpace(line[i]!)) {
      const c = line[i]!;
      if (c === '"' || c === "'") {
        const q = c;
        i++;
        let closed = false;
        while (i < n) {
          const d = line[i]!;
          if (d === '\\' && i + 1 < n) {
            const e = line[i + 1]!;
            if (q === "'") {
              if (e === "'") { tok += "'"; i += 2; continue; }
              tok += d; i++; continue;
            }
            if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
              tok += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16)); i += 4; continue;
            }
            const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07', '"': '"', '\\': '\\' };
            tok += map[e] ?? e; i += 2; continue;
          }
          if (d === q) { closed = true; i++; break; }
          tok += d; i++;
        }
        if (!closed) throw new Error('Unbalanced quotes');
        started = true;
        // redis-cli requires whitespace after a closing quote
        if (i < n && !isRedisSpace(line[i]!)) throw new Error('Closing quote must be followed by a space');
      } else {
        tok += c; i++; started = true;
      }
    }
    if (started) out.push(tok);
  }
  return out;
}
