import { describe, expect, it } from 'vitest';
import type { Role } from '@rconsole/shared';
import type { DatabaseConfig } from '../../src/config.ts';
import { HttpError } from '../../src/http/errors.ts';
import { keyIndexes, type CommandInfo, type CommandTable } from '../../src/policy/commandTable.ts';
import {
  MAX_BLOCK_SECONDS,
  allowedFor,
  applyCaps,
  authorize,
  classify,
  confirmationFor,
  fixedCommand,
  isMutating,
  timeoutFor,
} from '../../src/policy/policy.ts';

function info(name: string, flags: string[], cats: string[] = [], keys: [number, number, number] = [1, 1, 1], subs: CommandInfo[] = []): CommandInfo {
  return {
    name,
    arity: -2,
    flags: new Set(flags),
    categories: new Set(cats),
    firstKey: keys[0],
    lastKey: keys[1],
    step: keys[2],
    subcommands: new Map(subs.map((s) => [s.name.split('|')[1]!, s])),
  };
}

const TABLE: CommandTable = new Map(
  [
    info('get', ['readonly', 'fast'], ['@read', '@string']),
    info('set', ['write', 'denyoom'], ['@write']),
    info('mset', ['write'], ['@write'], [1, -1, 2]),
    info('hgetall', ['readonly'], ['@read']),
    info('ft.search', ['readonly', 'module'], ['@read', '@search'], [0, 0, 0]),
    info('ft.create', ['write', 'denyoom', 'module'], ['@search'], [0, 0, 0]),
    info('ft._list', ['readonly', 'module'], ['@admin', '@search'], [0, 0, 0]),
    info('ft.config', ['readonly', 'module'], ['@admin', '@search'], [0, 0, 0], [
      info('ft.config|get', ['readonly', 'module'], [], [0, 0, 0]),
      info('ft.config|set', ['write', 'module'], [], [0, 0, 0]),
    ]),
    info('sort', ['write', 'denyoom', 'movablekeys'], ['@write', '@dangerous']),
    info('sort_ro', ['readonly', 'movablekeys'], ['@read', '@dangerous']),
    info('acl', [], ['@slow'], [0, 0, 0], [info('acl|setuser', ['admin', 'noscript'], ['@admin', '@dangerous'], [0, 0, 0])]),
    info('weirdadmin', ['admin'], [], [0, 0, 0]),
    info('ssubscribelike', ['pubsub'], ['@pubsub'], [0, 0, 0]),
    info('noflags', ['fast'], ['@fast'], [0, 0, 0]),
    info('blpop', ['write', 'blocking'], ['@write', '@blocking'], [1, -2, 1]),
    info('modblock', ['readonly', 'blocking', 'module'], [], [1, 1, 1]),
    info('xread', ['readonly', 'blocking', 'movablekeys'], ['@read'], [0, 0, 0]),
    info('object', [], ['@slow'], [0, 0, 0], [info('object|encoding', ['readonly'], ['@keyspace'], [2, 2, 1])]),
    info('vadd', ['write', 'denyoom', 'module'], [], [1, 1, 1]),
  ].map((i) => [i.name, i]),
);

function db(over: Partial<DatabaseConfig> = {}): DatabaseConfig {
  return { id: 'd', name: 'My DB', environment: 'dev', mode: 'standalone', db: 0, readOnly: false, maxRole: 'admin', credentials: {}, poolSize: 1, ...over };
}

const err = (fn: () => void): HttpError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    return e as HttpError;
  }
  throw new Error('expected an HttpError');
};

describe('classify', () => {
  it('uses COMMAND INFO flags: readonly -> read, write -> write', () => {
    expect(classify(['GET', 'k'], TABLE)).toMatchObject({ class: 'read', name: 'GET', source: 'flags', keyIndexes: [1] });
    expect(classify(['set', 'k', 'v'], TABLE)).toMatchObject({ class: 'write', name: 'SET', source: 'flags' });
    expect(classify(['VADD', 'k', 'x'], TABLE).class).toBe('write');
    expect(classify(['FT.SEARCH', 'idx', '*'], TABLE).class).toBe('read');
    expect(classify(['FT.CREATE', 'idx'], TABLE).class).toBe('write');
  });

  it('admin flag and @admin/@dangerous categories are blocked', () => {
    expect(classify(['WEIRDADMIN'], TABLE).class).toBe('blocked');
    expect(classify(['SORT', 'k'], TABLE).class).toBe('blocked');
    expect(classify(['SORT_RO', 'k'], TABLE).class).toBe('blocked');
  });

  it('pubsub-flag commands and flagless commands are blocked', () => {
    expect(classify(['SSUBSCRIBELIKE'], TABLE).class).toBe('blocked');
    expect(classify(['NOFLAGS'], TABLE)).toMatchObject({ class: 'blocked', source: 'flags' });
  });

  it('unknown commands fail closed, with or without a table', () => {
    expect(classify(['NOSUCHCMD'], TABLE)).toMatchObject({ class: 'blocked', source: 'unknown' });
    expect(classify(['GET', 'k'], undefined)).toMatchObject({ class: 'blocked', source: 'unknown' });
    expect(classify([''], TABLE).class).toBe('blocked');
    expect(classify(['GE T'], TABLE).class).toBe('blocked');
    expect(classify([], TABLE).class).toBe('blocked');
  });

  it('module container commands: subcommand flags plus parent categories', () => {
    // parent FT.CONFIG is @admin -> every subcommand blocked
    expect(classify(['FT.CONFIG', 'SET', 'x', 'y'], TABLE)).toMatchObject({ class: 'blocked', name: 'FT.CONFIG SET' });
    expect(classify(['FT.CONFIG', 'GET', 'x'], TABLE).class).toBe('blocked');
    expect(classify(['FT.CONFIG', 'NOPE'], TABLE)).toMatchObject({ class: 'blocked', source: 'unknown' });
  });

  it('subcommand parents with unknown subcommands are blocked (static rules)', () => {
    expect(classify(['CLIENT', 'PAUSE', '1000'], TABLE).class).toBe('blocked');
    expect(classify(['CLIENT'], TABLE).class).toBe('blocked');
    expect(classify(['OBJECT', 'HELP'], TABLE).class).toBe('blocked');
    expect(classify(['ACL', 'SETUSER', 'x'], TABLE).class).toBe('blocked');
    expect(classify(['OBJECT', 'ENCODING', 'k'], TABLE)).toMatchObject({ class: 'read', name: 'OBJECT ENCODING', keep: 2, keyIndexes: [2] });
  });

  it('static rules win over flags', () => {
    for (const argv of [['KEYS', '*'], ['EVAL', 'return 1', '0'], ['FLUSHALL'], ['MULTI'], ['SELECT', '1'], ['CONFIG', 'SET', 'dir', '/tmp'], ['MODULE', 'LOAD', 'x'], ['SHUTDOWN'], ['DEBUG', 'SLEEP', '1'], ['SCRIPT', 'LOAD', 'x'], ['FUNCTION', 'LIST'], ['MIGRATE'], ['RESTORE', 'k', '0', 'x'], ['AUTH', 'p'], ['HELLO', '3'], ['WAIT', '1', '0'], ['SWAPDB', '0', '1'], ['REPLICAOF', 'h', '1'], ['BGSAVE']]) {
      const c = classify(argv, TABLE);
      expect(c.class, argv.join(' ')).toBe('blocked');
      expect(c.source).toBe('rule');
      expect(c.hint).toBeTruthy();
    }
    expect(classify(['SUBSCRIBE', 'c'], TABLE).class).toBe('dedicated');
    expect(classify(['MONITOR'], TABLE).class).toBe('dedicated');
    expect(classify(['FT._LIST'], TABLE).class).toBe('read');
    // v0.2.1 (F7): dropping an index is admin-only with a typed confirmation; DD (delete the documents) is refused.
    expect(classify(['FT.DROPINDEX', 'i'], TABLE)).toMatchObject({ class: 'admin', confirm: 'typed' });
    expect(classify(['FT.DROPINDEX', 'i', 'DD'], TABLE)).toMatchObject({ class: 'blocked', source: 'rule' });
    expect(classify(['ft.dropindex', 'i', 'dd'], TABLE).class).toBe('blocked');
    expect(classify(['FT.DROPINDEX', 'DD'], TABLE)).toMatchObject({ class: 'admin' });
    expect(classify(['DEL', 'k'], TABLE)).toMatchObject({ class: 'write', confirm: 'confirm' });
    expect(classify(['CONFIG', 'GET', 'x'], TABLE)).toMatchObject({ class: 'admin', name: 'CONFIG GET' });
  });

  it('FLUSHDB is admin, typed confirmation, non-prod only', () => {
    expect(classify(['FLUSHDB'], TABLE)).toMatchObject({ class: 'admin', confirm: 'typed', nonProdOnly: true });
  });

  it('blocking commands not in the cap list are blocked; known ones are capped', () => {
    expect(classify(['MODBLOCK', 'k'], TABLE)).toMatchObject({ class: 'blocked', blocking: true });
    expect(classify(['BLPOP', 'k', '0'], TABLE)).toMatchObject({ class: 'write', blocking: true });
    expect(classify(['XREAD', 'BLOCK', '0', 'STREAMS', 'k', '$'], TABLE)).toMatchObject({ class: 'read', blocking: true });
  });

  it('accepts Uint8Array argv', () => {
    expect(classify([Buffer.from('get'), Buffer.from([0xff, 0x00])], TABLE)).toMatchObject({ class: 'read', name: 'GET' });
  });
});

describe('keyIndexes', () => {
  it('handles first/last/step', () => {
    expect(keyIndexes(TABLE.get('mset'), 5)).toEqual([1, 3]);
    expect(keyIndexes(TABLE.get('blpop'), 4)).toEqual([1, 2]);
    expect(keyIndexes(TABLE.get('get'), 2)).toEqual([1]);
    expect(keyIndexes(TABLE.get('ft.search'), 3)).toEqual([]);
    expect(keyIndexes(undefined, 3)).toEqual([]);
  });
});

describe('authorize', () => {
  const read = classify(['GET', 'k'], TABLE);
  const write = classify(['SET', 'k', 'v'], TABLE);
  const admin = classify(['CONFIG', 'GET', 'x'], TABLE);
  const matrix: [Role, string, boolean][] = [
    ['viewer', 'read', true], ['viewer', 'write', false], ['viewer', 'admin', false],
    ['operator', 'read', true], ['operator', 'write', true], ['operator', 'admin', false],
    ['admin', 'read', true], ['admin', 'write', true], ['admin', 'admin', true],
  ];
  it.each(matrix)('%s x %s -> %s', (role, cls, ok) => {
    const c = cls === 'read' ? read : cls === 'write' ? write : admin;
    if (ok) expect(() => authorize(c, { role, db: db() })).not.toThrow();
    else expect(err(() => authorize(c, { role, db: db() })).code).toBe('forbidden');
  });

  it('blocked and dedicated commands are refused for everyone', () => {
    expect(err(() => authorize(classify(['KEYS', '*'], TABLE), { role: 'admin', db: db() })).code).toBe('command_blocked');
    const e = err(() => authorize(classify(['SUBSCRIBE', 'c'], TABLE), { role: 'admin', db: db() }));
    expect(e.code).toBe('command_blocked');
    expect(e.extra.hint).toMatch(/Pub\/Sub/);
  });

  it('readOnly databases reject writes and mutating admin commands', () => {
    const ro = db({ readOnly: true });
    expect(err(() => authorize(write, { role: 'admin', db: ro })).code).toBe('read_only');
    expect(err(() => authorize(classify(['SLOWLOG', 'RESET'], TABLE), { role: 'admin', db: ro })).code).toBe('read_only');
    expect(err(() => authorize(classify(['FLUSHDB'], TABLE), { role: 'admin', db: ro })).code).toBe('read_only');
    expect(() => authorize(read, { role: 'viewer', db: ro })).not.toThrow();
    expect(() => authorize(admin, { role: 'admin', db: ro })).not.toThrow();
    expect(() => authorize(classify(['CLIENT', 'LIST'], TABLE), { role: 'admin', db: ro })).not.toThrow();
  });

  it('nonProdOnly commands are refused on prod even for admins', () => {
    expect(err(() => authorize(classify(['FLUSHDB'], TABLE), { role: 'admin', db: db({ environment: 'prod' }) })).code).toBe('command_blocked');
    expect(() => authorize(classify(['FLUSHDB'], TABLE), { role: 'admin', db: db({ environment: 'staging' }) })).not.toThrow();
  });

  it('role check happens before readOnly (viewer on read-only gets forbidden for writes)', () => {
    expect(err(() => authorize(write, { role: 'viewer', db: db({ readOnly: true }) })).code).toBe('forbidden');
  });

  it('allowedFor reports without throwing', () => {
    expect(allowedFor(read, { role: 'viewer', db: db() })).toEqual({ allowed: true });
    const v = allowedFor(classify(['KEYS', '*'], TABLE), { role: 'admin', db: db() });
    expect(v.allowed).toBe(false);
    expect(v.hint).toMatch(/SCAN/);
  });
});

describe('isMutating', () => {
  it('classifies writes and admin commands', () => {
    expect(isMutating(classify(['SET', 'k', 'v'], TABLE))).toBe(true);
    expect(isMutating(classify(['GET', 'k'], TABLE))).toBe(false);
    expect(isMutating(classify(['CONFIG', 'GET', 'x'], TABLE))).toBe(false);
    expect(isMutating(classify(['CLIENT', 'LIST'], TABLE))).toBe(false);
    expect(isMutating(classify(['CLIENT', 'KILL', 'ID', '1'], TABLE))).toBe(true);
    expect(isMutating(classify(['SLOWLOG', 'RESET'], TABLE))).toBe(true);
    expect(isMutating(fixedCommand('UNLINK', 'write'))).toBe(true);
  });
});

describe('applyCaps', () => {
  const s = (a: (string | Buffer)[]) => a.map(String);
  it('caps BLPOP/BRPOP last-arg timeouts', () => {
    expect(s(applyCaps(['BLPOP', 'a', 'b', '0']))).toEqual(['BLPOP', 'a', 'b', String(MAX_BLOCK_SECONDS)]);
    expect(s(applyCaps(['BRPOP', 'a', '100']))).toEqual(['BRPOP', 'a', '5']);
    expect(s(applyCaps(['BLMOVE', 'a', 'b', 'LEFT', 'RIGHT', '2.5']))).toEqual(['BLMOVE', 'a', 'b', 'LEFT', 'RIGHT', '2.5']);
    expect(s(applyCaps(['bzpopmin', 'z', '0']))).toEqual(['bzpopmin', 'z', '5']);
  });
  it('caps BLMPOP/BZMPOP second-arg timeouts', () => {
    expect(s(applyCaps(['BLMPOP', '0', '1', 'k', 'LEFT']))).toEqual(['BLMPOP', '5', '1', 'k', 'LEFT']);
    expect(s(applyCaps(['BZMPOP', '60', '1', 'k', 'MIN']))).toEqual(['BZMPOP', '5', '1', 'k', 'MIN']);
  });
  it('caps XREAD/XREADGROUP BLOCK in milliseconds, only before STREAMS', () => {
    expect(s(applyCaps(['XREAD', 'BLOCK', '0', 'STREAMS', 'k', '$']))).toEqual(['XREAD', 'BLOCK', '5000', 'STREAMS', 'k', '$']);
    expect(s(applyCaps(['XREAD', 'COUNT', '1', 'BLOCK', '99999', 'STREAMS', 'k', '$']))).toEqual(['XREAD', 'COUNT', '1', 'BLOCK', '5000', 'STREAMS', 'k', '$']);
    expect(s(applyCaps(['XREAD', 'BLOCK', '100', 'STREAMS', 'k', '$']))).toEqual(['XREAD', 'BLOCK', '100', 'STREAMS', 'k', '$']);
    expect(s(applyCaps(['XREADGROUP', 'GROUP', 'g', 'c', 'BLOCK', '0', 'STREAMS', 'BLOCK', '0']))).toEqual(['XREADGROUP', 'GROUP', 'g', 'c', 'BLOCK', '5000', 'STREAMS', 'BLOCK', '0']);
    // A group or consumer literally named BLOCK is not the option.
    expect(s(applyCaps(['XREADGROUP', 'GROUP', 'BLOCK', 'BLOCK', 'COUNT', '1', 'STREAMS', 'k', '>']))).toEqual(['XREADGROUP', 'GROUP', 'BLOCK', 'BLOCK', 'COUNT', '1', 'STREAMS', 'k', '>']);
    expect(s(applyCaps(['XREADGROUP', 'GROUP', 'BLOCK', 'c', 'BLOCK', '0', 'STREAMS', 'k', '>']))).toEqual(['XREADGROUP', 'GROUP', 'BLOCK', 'c', 'BLOCK', '5000', 'STREAMS', 'k', '>']);
  });
  it('caps SCAN-family COUNT at 1000', () => {
    expect(s(applyCaps(['SCAN', '0', 'COUNT', '5000']))).toEqual(['SCAN', '0', 'COUNT', '1000']);
    expect(s(applyCaps(['HSCAN', 'h', '0', 'MATCH', '*', 'count', '100000']))).toEqual(['HSCAN', 'h', '0', 'MATCH', '*', 'count', '1000']);
    expect(s(applyCaps(['SSCAN', 's', '0', 'COUNT', '10']))).toEqual(['SSCAN', 's', '0', 'COUNT', '10']);
  });
  it('rejects malformed timeouts and counts with 400', () => {
    expect(err(() => applyCaps(['BLPOP', 'k', 'abc'])).code).toBe('validation');
    expect(err(() => applyCaps(['BLPOP', 'k', '-1'])).code).toBe('validation');
    expect(err(() => applyCaps(['XREAD', 'BLOCK', '1.5', 'STREAMS', 'k', '$'])).code).toBe('validation');
    expect(err(() => applyCaps(['SCAN', '0', 'COUNT', '0'])).code).toBe('validation');
    expect(err(() => applyCaps(['SCAN', '0', 'COUNT', 'x'])).code).toBe('validation');
  });
  it('does not mutate the input and leaves other commands alone', () => {
    const argv = ['BLPOP', 'k', '0'];
    applyCaps(argv);
    expect(argv).toEqual(['BLPOP', 'k', '0']);
    expect(s(applyCaps(['GET', 'k']))).toEqual(['GET', 'k']);
  });
  it('timeoutFor gives blocking commands room for the capped block', () => {
    expect(timeoutFor(classify(['BLPOP', 'k', '0'], TABLE), 5000)).toBeGreaterThan(MAX_BLOCK_SECONDS * 1000);
    expect(timeoutFor(classify(['GET', 'k'], TABLE), 5000)).toBe(5000);
  });
});

describe('confirmationFor', () => {
  const PV = { total: 1, commands: [] };
  it('prod writes need typed db name + reason', () => {
    expect(confirmationFor('none', true, db({ environment: 'prod' }), true, 's', PV)).toEqual({ level: 'typed', expectedText: 'My DB', reasonRequired: true, summary: 's', preview: PV });
    expect(confirmationFor('confirm', true, db({ environment: 'prod' }), true, 's', PV)).toMatchObject({ level: 'typed', reasonRequired: true });
  });
  it('prod reads and prodRequiresReason=false fall back to the rule', () => {
    expect(confirmationFor('none', false, db({ environment: 'prod' }), true, 's', PV)).toBeNull();
    expect(confirmationFor('confirm', true, db({ environment: 'prod' }), false, 's', PV)).toEqual({ level: 'confirm', reasonRequired: false, summary: 's', preview: PV });
  });
  it('rule levels on non-prod', () => {
    expect(confirmationFor('typed', true, db(), true, 's', PV)).toEqual({ level: 'typed', expectedText: 'My DB', reasonRequired: false, summary: 's', preview: PV });
    expect(confirmationFor('confirm', true, db(), true, 's', PV)).toEqual({ level: 'confirm', reasonRequired: false, summary: 's', preview: PV });
    expect(confirmationFor('none', true, db(), true, 's', PV)).toBeNull();
  });
});

describe('COPY cannot reach another logical database (review H2)', () => {
  it('refuses the DB option in any case and encoding; plain COPY and REPLACE are fine', () => {
    for (const argv of [
      ['COPY', 'a', 'b', 'DB', '1'],
      ['copy', 'a', 'b', 'db', '0', 'REPLACE'],
      ['COPY', 'a', 'b', 'REPLACE', 'Db', '2'],
      [Buffer.from('COPY'), Buffer.from('a'), Buffer.from('b'), Buffer.from('dB'), Buffer.from('1')],
    ]) {
      expect(() => applyCaps(argv as (string | Buffer)[]), String(argv)).toThrow(expect.objectContaining({ code: 'command_blocked' }));
    }
    expect(applyCaps(['COPY', 'a', 'b'])).toEqual(['COPY', 'a', 'b']);
    expect(applyCaps(['COPY', 'a', 'b', 'REPLACE'])).toEqual(['COPY', 'a', 'b', 'REPLACE']);
    // Key names that happen to be "DB" are keys (positions 1 and 2), not the option.
    expect(applyCaps(['COPY', 'DB', 'db'])).toEqual(['COPY', 'DB', 'db']);
  });
});

describe('module flags are not trusted alone (self-review finding 2)', () => {
  // Shapes copied from the Redis 8 COMMAND table (sandbox 6411).
  const MODULES: CommandTable = new Map(
    [
      info('search.clusterinfo', ['readonly', 'module', 'noscript', 'loading'], ['@search'], [0, 0, 0]),
      info('search.clusterset', ['readonly', 'module', 'noscript', 'loading'], ['@search'], [0, 0, 0]),
      info('search.clusterrefresh', ['readonly', 'module', 'noscript'], ['@search'], [0, 0, 0]),
      info('timeseries.clusterset', ['readonly', 'module', 'noscript'], [], [0, 0, 0]),
      info('ft._createifnx', ['write', 'denyoom', 'module'], ['@search'], [0, 0, 0]),
      info('_ft.debug', ['readonly', 'module'], ['@read'], [0, 0, 0]),
      info('ft.cursor', ['readonly', 'module'], ['@read', '@search'], [0, 0, 0], [
        info('ft.cursor|read', ['readonly', 'module'], ['@read', '@search'], [0, 0, 0]),
        info('ft.cursor|del', ['readonly', 'module'], ['@read', '@search'], [0, 0, 0]),
        info('ft.cursor|gc', ['readonly', 'module'], ['@read', '@search'], [0, 0, 0]),
      ]),
      info('cf.compact', ['readonly', 'module', 'fast'], ['@read', '@cuckoo']),
      info('ft.info', ['readonly', 'module'], ['@search'], [0, 0, 0]),
      info('vcard', ['readonly', 'module', 'fast'], []),
      info('newmod.peek', ['readonly', 'module'], ['@newmod']),
      info('newmod.get', ['readonly', 'module'], ['@read', '@newmod']),
      info('newmod.both', ['readonly', 'module'], ['@read', '@write']),
    ].map((i) => [i.name, i]),
  );
  const cls = (...argv: string[]) => classify(argv, MODULES).class;

  it('internal coordinator commands are blocked whatever their flags say', () => {
    for (const c of ['search.CLUSTERINFO', 'SEARCH.CLUSTERSET', 'search.clusterrefresh', 'timeseries.CLUSTERSET', 'FT._CREATEIFNX', '_FT.DEBUG']) {
      expect(cls(c, 'x'), c).toBe('blocked');
    }
  });

  it('FT.CURSOR: READ is a read, DEL is a write, GC and unknown subcommands are blocked', () => {
    expect(cls('FT.CURSOR', 'READ', 'idx', '1')).toBe('read');
    expect(cls('ft.cursor', 'del', 'idx', '1')).toBe('write');
    expect(cls('FT.CURSOR', 'GC', 'idx')).toBe('blocked');
    expect(cls('FT.CURSOR', 'NEWTHING')).toBe('blocked');
  });

  it('CF.COMPACT is a write (it rewrites the filter)', () => {
    expect(cls('CF.COMPACT', 'k')).toBe('write');
  });

  it('a readonly flag without @read fails closed; reviewed exceptions are rules', () => {
    expect(cls('NEWMOD.PEEK', 'k')).toBe('blocked');
    expect(cls('NEWMOD.BOTH', 'k')).toBe('blocked');
    expect(cls('NEWMOD.GET', 'k')).toBe('read');
    expect(cls('FT.INFO', 'idx')).toBe('read');
    expect(cls('VCARD', 'k')).toBe('read');
  });

  it('blocked internals are refused on read-only and prod databases too', () => {
    const c = classify(['SEARCH.CLUSTERINFO'], MODULES);
    expect(() => authorize(c, { role: 'admin', db: { readOnly: true, environment: 'prod' } as DatabaseConfig })).toThrow(HttpError);
  });
});
