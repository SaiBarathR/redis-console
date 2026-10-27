/**
 * Command policy engine (server-side enforcement).
 *
 * classify:  static rule (shared lookupRule) -> else COMMAND INFO flags/categories -> else blocked.
 * authorize: class vs effective role, prod-only restrictions, readOnly databases.
 * caps:      blocking timeouts capped, SCAN COUNT capped.
 * confirm:   destructive rules + every write on prod (typed database name + reason).
 */
import {
  CLASS_MIN_ROLE,
  GRAPH_QUERY_COMMANDS,
  GRAPH_TIMEOUT_MS,
  COMMAND_RULES,
  SUBCOMMAND_PARENTS,
  SUBCOMMAND_RULES,
  argumentRule,
  lookupRule,
  roleAtLeast,
  type CommandClass,
  type ConfirmLevel,
  type ConfirmationPreview,
  type Role,
} from '@rconsole/shared';
import type { DatabaseConfig } from '../config.ts';
import { HttpError } from '../http/errors.ts';
import { keyIndexes, type CommandInfo, type CommandTable } from './commandTable.ts';

export const MAX_BLOCK_SECONDS = 5;
export const MAX_SCAN_COUNT = 1000;

export interface Classified {
  /** Display name: "GET", "CLIENT KILL". */
  name: string;
  /** Upper-case argv[0]. */
  command: string;
  subcommand?: string;
  class: CommandClass;
  confirm: ConfirmLevel;
  hint?: string;
  nonProdOnly: boolean;
  /** Whether the command can block (timeouts are capped). */
  blocking: boolean;
  /** argv indexes holding keys (for audit redaction and cluster routing). */
  keyIndexes: number[];
  /** Leading argv tokens that are command names (kept in audit). */
  keep: number;
  source: 'rule' | 'flags' | 'unknown';
}

/** Admin-class commands that do not change server state (allowed on readOnly databases for admins). */
const ADMIN_READS = new Set(['CONFIG GET', 'CLIENT LIST', 'MEMORY MALLOC-STATS', 'GRAPH.CONFIG', 'GRAPH.SLOWLOG']);

/** Blocking commands whose timeout we know how to cap. Value: how to find the timeout argument. */
const BLOCKING: Record<string, 'last' | 'second' | 'block-option'> = {
  BLPOP: 'last', BRPOP: 'last', BRPOPLPUSH: 'last', BLMOVE: 'last', BZPOPMIN: 'last', BZPOPMAX: 'last',
  BLMPOP: 'second', BZMPOP: 'second', XREAD: 'block-option', XREADGROUP: 'block-option',
};

const SCAN_LIKE = new Set(['SCAN', 'SSCAN', 'HSCAN', 'ZSCAN']);

const str = (a: string | Uint8Array | undefined) => (a === undefined ? '' : typeof a === 'string' ? a : Buffer.from(a).toString('latin1'));

/** Printable ASCII only: Redis matches command names byte-wise, so anything else is never a real command. */
const ASCII_NAME = /^[\x21-\x7e]{1,64}$/;

/**
 * Max `*` wildcards in a glob pattern (SCAN MATCH, PUBSUB CHANNELS, PSUBSCRIBE). Redis versions before
 * 6.2.11/7.0.9 match patterns with many wildcards in exponential time (CVE-2022-36021), and the console
 * can be pointed at older servers.
 */
export const MAX_GLOB_WILDCARDS = 8;

export function checkGlob(pattern: string | Uint8Array, what = 'pattern'): void {
  const s = typeof pattern === 'string' ? pattern : Buffer.from(pattern).toString('latin1');
  let stars = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '*') stars++;
  }
  if (stars > MAX_GLOB_WILDCARDS) throw new HttpError('validation', `${what}: at most ${MAX_GLOB_WILDCARDS} '*' wildcards are allowed`);
}

export function classify(argv: readonly (string | Uint8Array)[], table: CommandTable | undefined): Classified {
  // ASCII upper-casing only: String#toUpperCase maps e.g. 'ſ' to 'S' and 'ß' to 'SS', which would let a
  // name that Redis does not know be classified as a different, known command.
  const asciiUpper = (s: string) => s.replace(/[a-z]+/g, (m) => m.toUpperCase());
  const rawName = str(argv[0]);
  const command = asciiUpper(rawName);
  const names = argv.slice(0, 2).map((a) => str(a));
  const info = table?.get(command.toLowerCase());
  const hasSubs = SUBCOMMAND_PARENTS.has(command) || (info?.subcommands.size ?? 0) > 0;
  const subcommand = hasSubs && argv.length > 1 ? asciiUpper(str(argv[1])) : undefined;
  const subInfo = subcommand ? info?.subcommands.get(subcommand.toLowerCase()) : undefined;
  const effInfo: CommandInfo | undefined = subInfo ?? (hasSubs ? undefined : info);
  const base = {
    name: subcommand ? `${command} ${subcommand}` : command,
    command,
    ...(subcommand ? { subcommand } : {}),
    keyIndexes: keyIndexes(effInfo, argv.length),
    keep: subcommand ? 2 : 1,
    blocking: command in BLOCKING || !!effInfo?.flags.has('blocking'),
  };

  if (!command || !ASCII_NAME.test(rawName) || !/^[A-Z0-9._|-]{1,64}$/.test(command) || (subcommand !== undefined && !ASCII_NAME.test(subcommand))) {
    return { ...base, class: 'blocked', confirm: 'none', nonProdOnly: false, hint: 'Invalid command name.', source: 'unknown' };
  }

  const rule = argumentRule(argv.map((a) => str(a))) ?? lookupRule(names);
  if (rule) {
    return { ...base, class: rule.class, confirm: rule.confirm ?? 'none', nonProdOnly: !!rule.nonProdOnly, ...(rule.hint ? { hint: rule.hint } : {}), source: 'rule' };
  }

  if (!info) {
    return { ...base, class: 'blocked', confirm: 'none', nonProdOnly: false, hint: `Unknown command '${command}'.`, source: 'unknown' };
  }
  if (hasSubs && !subInfo) {
    return { ...base, class: 'blocked', confirm: 'none', nonProdOnly: false, hint: `Unknown or missing subcommand for ${command}.`, source: 'unknown' };
  }
  const i = effInfo!;
  const cats = new Set([...i.categories, ...(subInfo ? info.categories : [])]);
  const flagsOf = i.flags;
  let cls: CommandClass;
  let hint: string | undefined;
  if (flagsOf.has('admin') || cats.has('@admin') || cats.has('@dangerous')) {
    cls = 'blocked';
    hint = `${base.name} is an administrative or dangerous command and is not available in the console.`;
  } else if (flagsOf.has('pubsub')) {
    cls = 'blocked';
    hint = 'Use the Pub/Sub page.';
  } else if (flagsOf.has('write')) {
    cls = 'write';
  } else if (flagsOf.has('readonly') && cats.has('@read') && !cats.has('@write')) {
    // Module authors set flags themselves; a read must also be in @read (internal or unreviewed module commands
    // without it fail closed, see COMMAND_RULES for the reviewed exceptions).
    cls = 'read';
  } else {
    cls = 'blocked';
    hint = `${base.name} cannot be classified as read or write and is not allowed.`;
  }
  if (cls !== 'blocked' && base.blocking && !(command in BLOCKING)) {
    cls = 'blocked';
    hint = `${base.name} is a blocking command and is not allowed.`;
  }
  return { ...base, class: cls, confirm: 'none', nonProdOnly: false, ...(hint ? { hint } : {}), source: 'flags' };
}

/**
 * Name and number of leading argv tokens that may be stored verbatim in the audit log. Only names Redis or
 * our rules know are kept: an unknown "command" may be a value pasted into the console.
 */
export function auditName(c: Pick<Classified, 'command' | 'subcommand'>, table: CommandTable | undefined): { command: string; keep: number } {
  const info = table?.get(c.command.toLowerCase());
  const cmdKnown = /^[A-Z0-9._|-]{1,64}$/.test(c.command) && (c.command in COMMAND_RULES || SUBCOMMAND_PARENTS.has(c.command) || !!info);
  if (!cmdKnown) return { command: '<unknown command>', keep: 0 };
  if (c.subcommand === undefined) return { command: c.command, keep: 1 };
  const subKnown = /^[A-Z0-9._|-]{1,64}$/.test(c.subcommand) && (`${c.command}|${c.subcommand}` in SUBCOMMAND_RULES || !!info?.subcommands.has(c.subcommand.toLowerCase()));
  return subKnown ? { command: `${c.command} ${c.subcommand}`, keep: 2 } : { command: `${c.command} <unknown subcommand>`, keep: 1 };
}

/** Classification for a fixed, server-built command (typed ops and feature endpoints). */
export function fixedCommand(name: string, cls: 'read' | 'write' | 'admin', confirm: ConfirmLevel = 'none', keyIdx: number[] = []): Classified {
  return { name, command: name.split(' ')[0]!, class: cls, confirm, nonProdOnly: false, blocking: false, keyIndexes: keyIdx, keep: name.includes(' ') ? 2 : 1, source: 'rule' };
}

/** Whether the classified command changes data or server state. */
export function isMutating(c: Pick<Classified, 'class' | 'name'>): boolean {
  if (c.class === 'write') return true;
  if (c.class === 'admin') return !ADMIN_READS.has(c.name);
  return false;
}

export interface PolicyContext {
  role: Role; // effective role on this database
  db: DatabaseConfig;
}

/** Throws a 403 HttpError when the caller may not run the command. */
export function authorize(c: Classified, ctx: PolicyContext): void {
  if (c.class === 'blocked') throw new HttpError('command_blocked', `${c.name} is blocked by policy.`, c.hint ? { hint: c.hint } : {});
  if (c.class === 'dedicated') throw new HttpError('command_blocked', `${c.name} is only available through its dedicated page.`, c.hint ? { hint: c.hint } : {});
  const needed = CLASS_MIN_ROLE[c.class];
  if (!roleAtLeast(ctx.role, needed)) {
    throw new HttpError('forbidden', `${c.name} requires the ${needed} role on this database (you have ${ctx.role}).`);
  }
  if (c.nonProdOnly && ctx.db.environment === 'prod') {
    throw new HttpError('command_blocked', `${c.name} is not allowed on production databases.`, c.hint ? { hint: c.hint } : {});
  }
  if (ctx.db.readOnly && isMutating(c)) throw new HttpError('read_only', 'This database is read-only.');
}

/** Policy verdict without throwing (for command docs annotation). */
export function allowedFor(c: Classified, ctx: PolicyContext): { allowed: boolean; hint?: string } {
  try {
    authorize(c, ctx);
    return { allowed: true };
  } catch (e) {
    const h = e instanceof HttpError ? (e.extra.hint ?? e.message) : 'not allowed';
    return { allowed: false, hint: h };
  }
}

export interface ConfirmSpec {
  level: Exclude<ConfirmLevel, 'none'>;
  expectedText?: string;
  reasonRequired: boolean;
  summary: string;
  impact?: { keys?: number; sample?: import('@rconsole/shared').Bin[] };
  /** What will execute (built from the same argv that runs). Sent to the user, never audited. */
  preview: ConfirmationPreview;
}

/**
 * Confirmation needed for a mutating action on `db`, combining the rule's level with prod rules. `preview` is
 * what the dialog shows; build it from the exact argv that will run.
 */
export function confirmationFor(
  ruleLevel: ConfirmLevel,
  mutating: boolean,
  db: DatabaseConfig,
  prodRequiresReason: boolean,
  summary: string,
  preview: ConfirmationPreview,
): ConfirmSpec | null {
  const prod = db.environment === 'prod' && mutating && prodRequiresReason;
  if (prod) return { level: 'typed', expectedText: db.name, reasonRequired: true, summary, preview };
  if (ruleLevel === 'typed') return { level: 'typed', expectedText: db.name, reasonRequired: false, summary, preview };
  if (ruleLevel === 'confirm') return { level: 'confirm', reasonRequired: false, summary, preview };
  return null;
}

/**
 * Apply availability caps to argv: blocking timeouts <= 5 s (0 = "forever" becomes 5 s),
 * SCAN-family COUNT <= 1000. Returns a new argv; throws on malformed timeouts.
 */
export function applyCaps(argv: readonly (string | Buffer)[]): (string | Buffer)[] {
  const out = [...argv];
  const cmd = str(out[0]).toUpperCase();
  // v0.4 graph: accept only the reviewed option grammar and always send a positive execution bound.
  if (GRAPH_QUERY_COMMANDS.has(cmd)) {
    if (out.length < 3) throw new HttpError('validation', `${cmd}: graph and query are required`);
    let timeout = GRAPH_TIMEOUT_MS;
    let seenTimeout = false;
    let compact = false;
    for (let i = 3; i < out.length; i++) {
      const opt = str(out[i]).toUpperCase();
      if (opt === '--COMPACT' && !compact) { compact = true; continue; }
      if (opt !== 'TIMEOUT' || seenTimeout) throw new HttpError('validation', `${cmd}: only TIMEOUT and --compact options are allowed`);
      seenTimeout = true;
      const value = str(out[++i]);
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HttpError('validation', `${cmd}: TIMEOUT must be an integer in milliseconds`);
      const n = Number(value);
      timeout = n === 0 ? GRAPH_TIMEOUT_MS : Math.min(n, GRAPH_TIMEOUT_MS);
    }
    return [...out.slice(0, 3), ...(compact ? ['--compact'] : []), 'TIMEOUT', String(timeout)];
  }
  if (cmd === 'GRAPH.MEMORY') {
    const raw = str(out[4] ?? '100');
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new HttpError('validation', 'GRAPH.MEMORY: SAMPLES must be a non-negative integer');
    const n = Number(raw);
    return [...out.slice(0, 3), 'SAMPLES', String(n === 0 ? 100 : Math.min(n, 100))];
  }
  const mode = BLOCKING[cmd];
  const capSeconds = (i: number) => {
    const n = Number(str(out[i]));
    if (!Number.isFinite(n) || n < 0) throw new HttpError('validation', `${cmd}: timeout must be a non-negative number`);
    out[i] = String(n === 0 || n > MAX_BLOCK_SECONDS ? MAX_BLOCK_SECONDS : n);
  };
  if (mode === 'last' && out.length >= 3) capSeconds(out.length - 1);
  if (mode === 'second' && out.length >= 3) capSeconds(1);
  if (mode === 'block-option') {
    // XREADGROUP GROUP <group> <consumer> ...: skip the group/consumer names (they may be literally "BLOCK").
    const first = cmd === 'XREADGROUP' && str(out[1]).toUpperCase() === 'GROUP' ? 4 : 1;
    for (let i = first; i < out.length - 1; i++) {
      const t = str(out[i]).toUpperCase();
      if (t === 'STREAMS') break;
      if (t === 'BLOCK') {
        const n = Number(str(out[i + 1]));
        if (!Number.isInteger(n) || n < 0) throw new HttpError('validation', `${cmd}: BLOCK must be a non-negative integer`);
        out[i + 1] = String(n === 0 || n > MAX_BLOCK_SECONDS * 1000 ? MAX_BLOCK_SECONDS * 1000 : n);
        i++;
      }
    }
  }
  // The logical database is fixed by configuration (SELECT, MOVE, SWAPDB are blocked). COPY's DB option would
  // write into another logical database without that database's readOnly/maxRole/prod rules (review H2).
  // Options start after source and destination; COPY takes only DB <n> and REPLACE.
  if (cmd === 'COPY') {
    for (let i = 3; i < out.length; i++) {
      if (str(out[i]).toUpperCase() === 'DB') {
        throw new HttpError('command_blocked', 'COPY ... DB is blocked: the logical database is fixed by server configuration.', {
          hint: 'Copy within this database (omit DB), or run the command against the destination database.',
        });
      }
    }
  }
  if (cmd === 'PUBSUB' && /^(CHANNELS|SHARDCHANNELS)$/i.test(str(out[1])) && out[2] !== undefined) checkGlob(out[2], `${cmd} pattern`);
  if (SCAN_LIKE.has(cmd)) {
    for (let i = 1; i < out.length - 1; i++) {
      if (str(out[i]).toUpperCase() === 'MATCH') checkGlob(out[i + 1]!, `${cmd} MATCH`);
      if (str(out[i]).toUpperCase() === 'COUNT') {
        const n = Number(str(out[i + 1]));
        if (!Number.isInteger(n) || n < 1) throw new HttpError('validation', `${cmd}: COUNT must be a positive integer`);
        if (n > MAX_SCAN_COUNT) out[i + 1] = String(MAX_SCAN_COUNT);
      }
    }
  }
  return out;
}

/** Command timeout for a capped command (blocking commands get their block time plus a margin). */
export function timeoutFor(c: Classified, baseMs: number): number {
  return c.blocking ? Math.max(baseMs, MAX_BLOCK_SECONDS * 1000 + 2000) : baseMs;
}
