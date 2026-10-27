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
  it('bounds guard work', () => expect(graphQueryRefusal('x'.repeat(65_537))).toMatch(/64 KiB/));
});
