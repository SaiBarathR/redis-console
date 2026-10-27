import { describe, expect, it } from 'vitest';
import { argumentRule, lookupRule } from './commands.ts';
import { graphQueryRefusal } from './graphPolicy.ts';

const rule = (a: string[]) => argumentRule(a) ?? lookupRule(a);
describe('v0.4 graph policy', () => {
  it('explicitly classifies the entire reviewed family and fails closed for future commands', () => {
    for (const name of ['RO_QUERY', 'EXPLAIN', 'LIST', 'INFO', 'MEMORY']) expect(lookupRule([`GRAPH.${name}`])?.class).toBe('read');
    for (const name of ['QUERY', 'PROFILE']) expect(rule([`GRAPH.${name}`, 'g', 'RETURN 1'])).toMatchObject({ class: 'write', confirm: 'confirm' });
    expect(rule(['GRAPH.DELETE', 'g'])).toMatchObject({ class: 'admin', confirm: 'typed' });
    expect(rule(['graph.config', 'gEt', '*'])?.class).toBe('admin');
    expect(rule(['GRAPH.SLOWLOG', 'g'])?.class).toBe('admin');
    expect(rule(['GRAPH.SLOWLOG', 'g', 'RESET'])?.class).toBe('blocked');
    expect(rule(['GRAPH.MEMORY', 'PURGE', 'g'])?.class).toBe('blocked');
    for (const name of ['UDF', 'BULK', 'RESTORE', 'DEBUG', 'EFFECT', 'RECORD', 'COPY', 'CONSTRAINT', 'FUTURE']) expect(rule([`GRAPH.${name}`])?.class).toBe('blocked');
    for (const args of [[], ['SET', 'TIMEOUT', '0'], ['GET'], ['GET', '*', 'extra']]) expect(rule(['GRAPH.CONFIG', ...args])?.class).toBe('blocked');
    expect(rule(['GRAPH.INFO', 'ObjectPool'])?.class).toBe('read');
    for (const args of [[], ['RunningQueries'], ['ObjectPool', 'WaitingQueries']]) expect(rule(['GRAPH.INFO', ...args])?.class).toBe('blocked');
  });
  it.each(['LOAD CSV FROM "file://x" AS r RETURN r', 'load/*comment*/csv from "https://x" as r return r', 'CALL db.idx.fulltext.createNodeIndex("P","name")', 'CALL db.labels(1)', 'CALL db.labels', 'RETURN Library.fn()', 'RETURN Library/*gap*/ . fn ()', 'RETURN `Library.fn`()', 'RETURN `Library`.fn()', 'RETURN Library.`fn`()', 'RETURN Library.éfn()', 'RETURN 1 // comment\r LOAD CSV FROM "file://x" AS r RETURN r', "RETURN 'unterminated", 'RETURN 1 /*'])('blocks dangerous or ambiguous Cypher: %s', (query) => {
    for (const cmd of ['QUERY', 'RO_QUERY', 'EXPLAIN', 'PROFILE']) expect(rule([`GRAPH.${cmd}`, 'g', query])?.class).toBe('blocked');
  });
  it.each(["RETURN 'LOAD CSV CALL lib.fn()'", 'RETURN "CALL evil()"', '// LOAD CSV\nRETURN 1', '/* CALL evil() */ RETURN 1', 'MATCH (n:`odd label`) RETURN n', 'CALL db.labels() YIELD label RETURN label', 'CALL db.relationshipTypes()', 'CALL db.propertyKeys()', "RETURN 'escaped\\\' LOAD CSV'", 'CREATE (:P {x:"text"})'])('allows inert text and reviewed procedures: %s', (q) => expect(graphQueryRefusal(q)).toBeUndefined());
  it('does not treat a backslash as escaping a backtick identifier delimiter', () => {
    const query = 'RETURN `graph:20261027:quote-probe' + String.fromCharCode(92) + '`.f() //`';
    expect(graphQueryRefusal(query)).toBeDefined();
  });
  it('bounds guard work', () => expect(graphQueryRefusal('x'.repeat(65_537))).toMatch(/64 KiB/));

  // Review v0.4 r2 graph H1: FalkorDB ends a // comment at LF only, so a lone CR must not end it for the guard.
  const hiddenLoad = "//x\r`\nLOAD CSV FROM 'file:///nonexistent.csv' AS row RETURN row\n//`";
  const hiddenUdf = 'RETURN 1 AS a //x\r`\n, lib.fn(1) AS b\n//`';
  const hiddenCall = '//x\r`\nCALL algo.pageRank(null, null) YIELD node RETURN node\n//`';
  it.each([hiddenLoad, hiddenUdf, hiddenCall])('refuses a lone CR inside a line comment (%j) (review v0.4 r2 graph H1)', (q) => {
    expect(graphQueryRefusal(q)).toBeDefined();
    for (const cmd of ['GRAPH.QUERY', 'GRAPH.RO_QUERY', 'GRAPH.EXPLAIN', 'GRAPH.PROFILE']) expect(argumentRule([cmd, 'g', q])?.class).toBe('blocked');
  });
  it('comments end at LF or CRLF, as in FalkorDB; whitespace is ASCII only, so browser and server agree (graph L2)', () => {
    expect(graphQueryRefusal('RETURN 1 AS a //note\r\n, 2 AS b')).toBeUndefined();
    expect(graphQueryRefusal('RETURN 1 AS a //note\n, 2 AS b')).toBeUndefined();
    expect(graphQueryRefusal('RETURN 1\r\nAS a')).toBeUndefined();
    expect(graphQueryRefusal('MATCH (n)\tRETURN n')).toBeUndefined();
    // Unicode and other control whitespace fails closed outside strings, whatever the representation.
    for (const ws of ['\u00a0', '\u000b', '\u000c', '\u2028', '\u0000']) expect(graphQueryRefusal(`RETURN${ws}1`), JSON.stringify(ws)).toBeDefined();
    // The server's view of U+00A0: its UTF-8 bytes c2 a0 read as latin1.
    expect(graphQueryRefusal('RETURN\u00c2\u00a01')).toBeDefined();
    // Non-ASCII stays fine inside strings and quoted identifiers.
    expect(graphQueryRefusal("MATCH (n:`Persön`) WHERE n.name = 'Zoë\u00a0' RETURN n")).toBeUndefined();
  });
  it('a range or list slice is not a namespaced call; namespaced and quoted calls stay refused (graph L2)', () => {
    expect(graphQueryRefusal('RETURN [1,2,3,4][0..(1+1)]')).toBeUndefined();
    expect(graphQueryRefusal('RETURN [1,2,3,4][0..size([1])]')).toBeUndefined();
    expect(graphQueryRefusal('WITH [1,2,3] AS l RETURN l[0..size(l)-1]')).toBeUndefined();
    for (const q of ['RETURN lib.fn(1)', 'RETURN a.b.fn(1)', 'RETURN `lib`.fn(1)', 'RETURN a . fn (1)', 'RETURN `fn`(1)', 'RETURN $p.fn(1)'])
      expect(graphQueryRefusal(q), q).toMatch(/Namespaced and quoted function calls/);
  });
});
