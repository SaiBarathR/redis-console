/**
 * Confirmation previews (review M1): the exact commands a confirmed request will run, built by the server from
 * the same argv it executes. The confirmation token is bound to the request hash, so what the user confirms is
 * what runs.
 *
 * Display rules: command/subcommand names and key names in full (the user can already read them; keys are cut
 * only above PREVIEW_KEY_MAX_BYTES), every other argument cut to a short prefix plus its size. Previews go to the
 * requesting user only and are never written to the audit log (which keeps its redacted argv).
 */
import {
  PREVIEW_KEY_MAX_BYTES,
  PREVIEW_MAX_ARGS,
  PREVIEW_MAX_COMMANDS,
  PREVIEW_QUERY_MAX_BYTES,
  PREVIEW_VALUE_FULL_BYTES,
  PREVIEW_VALUE_PREFIX_BYTES,
  binFromBytes,
  type ConfirmationPreview,
  type PreviewArg,
  type PreviewCommand,
} from '@rconsole/shared';

type Arg = string | Uint8Array;

/** Upper bound on displayed bytes per preview (keeps 428 bodies and pending challenges small). */
export const PREVIEW_BUDGET_BYTES = 64 * 1024;

const bytesOf = (a: Arg): Uint8Array => (typeof a === 'string' ? Buffer.from(a) : a);

/** First `max` bytes, moved back to a UTF-8 character boundary (so text stays text). */
export function utf8Prefix(b: Uint8Array, max: number): Uint8Array {
  if (b.length <= max) return b;
  let n = max;
  while (n > 0 && (b[n]! & 0xc0) === 0x80) n--;
  return b.subarray(0, n || max);
}

/**
 * Names, keys and patterns are shown in full (up to PREVIEW_KEY_MAX_BYTES); other arguments as a short prefix, except
 * a query (`full`, a graph command's Cypher), which is what is being confirmed: up to PREVIEW_QUERY_MAX_BYTES.
 */
export function previewArg(a: Arg, kind: PreviewArg['kind'], full = false): PreviewArg {
  const b = bytesOf(a);
  const max = full ? PREVIEW_QUERY_MAX_BYTES : kind === 'arg' ? PREVIEW_VALUE_FULL_BYTES : PREVIEW_KEY_MAX_BYTES;
  const prefix = full ? PREVIEW_QUERY_MAX_BYTES : kind === 'arg' ? PREVIEW_VALUE_PREFIX_BYTES : PREVIEW_KEY_MAX_BYTES;
  if (b.length <= max) return { kind, v: binFromBytes(b) };
  return { kind, v: binFromBytes(utf8Prefix(b, prefix)), bytes: b.length };
}

/**
 * Preview one command. `keep` leading tokens are command/subcommand names; `keyIndexes` hold keys;
 * `patternIndexes` hold glob patterns; `queryIndexes` hold queries shown up to PREVIEW_QUERY_MAX_BYTES.
 */
export function previewCommand(argv: readonly Arg[], keep: number, keyIndexes: Iterable<number> = [], patternIndexes: Iterable<number> = [], queryIndexes: Iterable<number> = []): PreviewCommand {
  const keys = new Set(keyIndexes);
  const patterns = new Set(patternIndexes);
  const queries = new Set(queryIndexes);
  const names = Math.max(keep, 1);
  const shown = Math.min(argv.length, names + PREVIEW_MAX_ARGS);
  const out: PreviewArg[] = [];
  for (let i = 0; i < shown; i++) {
    out.push(previewArg(argv[i]!, i < names ? 'command' : keys.has(i) ? 'key' : patterns.has(i) ? 'pattern' : 'arg', queries.has(i)));
  }
  return argv.length > shown ? { argv: out, moreArgs: argv.length - shown } : { argv: out };
}

const sizeOf = (c: PreviewCommand) => c.argv.reduce((n, a) => n + a.v.data.length + 16, 16);

/** Assemble a preview: at most PREVIEW_MAX_COMMANDS commands and PREVIEW_BUDGET_BYTES; the rest is `more`. */
export function buildPreview(commands: PreviewCommand[], total = commands.length): ConfirmationPreview {
  const listed: PreviewCommand[] = [];
  let budget = PREVIEW_BUDGET_BYTES;
  for (const c of commands) {
    if (listed.length >= PREVIEW_MAX_COMMANDS) break;
    const sz = sizeOf(c);
    if (listed.length && sz > budget) break;
    budget -= sz;
    listed.push(c);
  }
  const p: ConfirmationPreview = { total, commands: listed };
  if (total > listed.length) p.more = total - listed.length;
  return p;
}
