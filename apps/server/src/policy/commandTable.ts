import type { CommandKeySpec } from '@rconsole/shared';
/** COMMAND (INFO) table per database: flags, ACL categories, key positions, subcommands. */
import type { Conn } from '../redis/manager.ts';
import { TM_STR } from '../redis/manager.ts';
import { asNum, asStr } from '../redis/reply.ts';

export interface CommandInfo {
  name: string; // lower-case, "client|kill" for subcommands
  arity: number;
  flags: Set<string>;
  categories: Set<string>;
  keySpecs?: CommandKeySpec[];
  firstKey: number;
  lastKey: number;
  step: number;
  subcommands: Map<string, CommandInfo>;
}

export type CommandTable = Map<string, CommandInfo>;

function parseEntry(e: unknown): CommandInfo | null {
  if (!Array.isArray(e) || e.length < 7) return null;
  const subs = new Map<string, CommandInfo>();
  const rawSubs = Array.isArray(e[9]) ? e[9] : [];
  for (const s of rawSubs) {
    const info = parseEntry(s);
    if (info) subs.set(info.name.split('|')[1] ?? info.name, info);
  }
  const list = (x: unknown) => new Set((Array.isArray(x) ? x : []).map((f) => asStr(f).toLowerCase()));
  return {
    name: asStr(e[0]).toLowerCase(),
    arity: asNum(e[1]),
    flags: list(e[2]),
    firstKey: asNum(e[3]),
    lastKey: asNum(e[4]),
    step: asNum(e[5]),
    categories: list(e[6]),
    subcommands: subs,
    keySpecs: parseKeySpecs(e[8]),
  };
}

export async function fetchCommandTable(conn: Conn): Promise<CommandTable> {
  const raw = await conn.send<unknown[]>(['COMMAND'], { typeMapping: TM_STR, timeout: 10_000, maxBytes: 2 * 1024 * 1024 });
  const table: CommandTable = new Map();
  for (const e of raw ?? []) {
    const info = parseEntry(e);
    if (info) table.set(info.name, info);
  }
  return table;
}

/** Lazily loaded, cached per database. Failures are not cached (fail closed meanwhile). */
export class CommandTables {
  readonly #tables = new Map<string, { at: number; table: CommandTable }>();
  readonly #pending = new Map<string, Promise<CommandTable>>();
  readonly #ttlMs: number;
  constructor(ttlMs = 30 * 60_000) {
    this.#ttlMs = ttlMs;
  }

  async get(dbId: string, conn: Conn): Promise<CommandTable | undefined> {
    const hit = this.#tables.get(dbId);
    if (hit && Date.now() - hit.at < this.#ttlMs) return hit.table;
    let p = this.#pending.get(dbId);
    if (!p) {
      p = fetchCommandTable(conn).finally(() => this.#pending.delete(dbId));
      this.#pending.set(dbId, p);
    }
    try {
      const table = await p;
      this.#tables.set(dbId, { at: Date.now(), table });
      return table;
    } catch {
      return hit?.table;
    }
  }
}

/** Argument positions (0-based in argv) that are keys, from the legacy first/last/step key spec. */
export function keyIndexes(info: CommandInfo | undefined, argc: number): number[] {
  if (!info || info.firstKey <= 0 || info.step <= 0) return [];
  const last = info.lastKey < 0 ? argc + info.lastKey : info.lastKey;
  const out: number[] = [];
  for (let i = info.firstKey; i <= last && i < argc; i += info.step) out.push(i);
  return out;
}

/** Expose only finite, supported metadata. Incomplete/unknown specifications remain absent. */
export function parseKeySpecs(raw: unknown): CommandKeySpec[] | undefined {
  if (!Array.isArray(raw) || raw.length > 64) return undefined;
  const map = (value: unknown) => {
    const fields = new Map<string, unknown>();
    if (Array.isArray(value)) for (let i = 0; i + 1 < value.length; i += 2) fields.set(asStr(value[i]), value[i + 1]);
    return fields;
  };
  const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 200_000;
  const out: CommandKeySpec[] = [];
  for (const value of raw) {
    const fields = map(value);
    const rawFlags = fields.get('flags');
    const flags = Array.isArray(rawFlags) ? rawFlags.map(flag => asStr(flag).toLowerCase()) : [];
    if (flags.includes('not_key')) continue;
    if (flags.includes('incomplete')) return undefined;
    const beginFields = map(fields.get('begin_search')), findFields = map(fields.get('find_keys'));
    const beginSpec = map(beginFields.get('spec')), findSpec = map(findFields.get('spec'));
    const index = beginSpec.get('index'), keyword = beginSpec.get('keyword'), startfrom = beginSpec.get('startfrom');
    let begin: CommandKeySpec['begin'];
    if (beginFields.get('type') === 'index' && integer(index) && index > 0) begin = { type: 'index', index };
    else if (beginFields.get('type') === 'keyword' && typeof keyword === 'string' && keyword.length > 0 && keyword.length <= 64 && integer(startfrom)) begin = { type: 'keyword', keyword, startfrom };
    else return undefined;
    const keystep = findSpec.get('keystep');
    if (!integer(keystep) || keystep < 1) return undefined;
    const lastkey = findSpec.get('lastkey'), limit = findSpec.get('limit'), keynumidx = findSpec.get('keynumidx'), firstkey = findSpec.get('firstkey');
    let find: CommandKeySpec['find'];
    if (findFields.get('type') === 'range' && integer(lastkey) && integer(limit) && limit >= 0) find = { type: 'range', lastkey, limit, keystep };
    else if (findFields.get('type') === 'keynum' && integer(keynumidx) && keynumidx >= 0 && integer(firstkey) && firstkey >= 0) find = { type: 'keynum', keynumidx, firstkey, keystep };
    else return undefined;
    out.push({ begin, find });
  }
  return out;
}
