import { describe, expect, it } from 'vitest';
import {
  argumentRule,
  buildFtCreateArgv,
  buildFtSearchArgv,
  globEscape,
  inferSearchFieldType,
  jsonPathChild,
  mergeSearchFieldTypes,
  searchIndexProblems,
  zSearchIndexCreate,
  zSearchQuery,
} from './index.ts';

describe('index wizard contract', () => {
  it('builds the exact FT.CREATE argv for a hash index', () => {
    expect(
      buildFtCreateArgv({
        index: 'idx:users',
        on: 'HASH',
        prefixes: ['user:', 'member:'],
        noStopwords: true,
        schema: [
          { name: 'name', type: 'TEXT', noStem: true, weight: 2, sortable: true },
          { name: 'tags', type: 'TAG', separator: ';', caseSensitive: true },
          { name: 'age', type: 'NUMERIC', sortable: true, noIndex: true },
          { name: 'where', type: 'GEO' },
          { name: 'emb', type: 'VECTOR', vector: { algorithm: 'HNSW', dataType: 'FLOAT32', dim: 4, distance: 'COSINE' } },
        ],
      }),
    ).toEqual([
      'FT.CREATE', 'idx:users', 'ON', 'HASH', 'PREFIX', '2', 'user:', 'member:', 'STOPWORDS', '0', 'SCHEMA',
      'name', 'TEXT', 'NOSTEM', 'WEIGHT', '2', 'SORTABLE',
      'tags', 'TAG', 'SEPARATOR', ';', 'CASESENSITIVE',
      'age', 'NUMERIC', 'SORTABLE', 'NOINDEX',
      'where', 'GEO',
      'emb', 'VECTOR', 'HNSW', '6', 'TYPE', 'FLOAT32', 'DIM', '4', 'DISTANCE_METRIC', 'COSINE',
    ]);
  });

  it('JSON fields carry their alias', () => {
    expect(buildFtCreateArgv({ index: 'j', on: 'JSON', prefixes: ['doc:'], skipInitialScan: true, schema: [{ name: '$.title', as: 'title', type: 'TEXT' }] })).toEqual([
      'FT.CREATE', 'j', 'ON', 'JSON', 'PREFIX', '1', 'doc:', 'SKIPINITIALSCAN', 'SCHEMA', '$.title', 'AS', 'title', 'TEXT',
    ]);
  });

  it('refuses definitions that would index every key or that FT.CREATE would reject', () => {
    const ok = { index: 'i', on: 'HASH' as const, prefixes: ['a:'], schema: [{ name: 'f', type: 'TEXT' as const }] };
    expect(zSearchIndexCreate.safeParse(ok).success).toBe(true);
    expect(zSearchIndexCreate.safeParse({ ...ok, prefixes: [] }).success).toBe(false);
    expect(zSearchIndexCreate.safeParse({ ...ok, prefixes: [''] }).success).toBe(false);
    expect(zSearchIndexCreate.safeParse({ ...ok, index: 'bad name' }).success).toBe(false);
    expect(zSearchIndexCreate.safeParse({ ...ok, index: '-x' }).success).toBe(false);
    expect(zSearchIndexCreate.safeParse({ ...ok, schema: [] }).success).toBe(false);
    expect(zSearchIndexCreate.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(searchIndexProblems({ on: 'JSON', prefixes: ['a:'], schema: [{ name: 'title', type: 'TEXT' }] })).toEqual([
      'title: JSON fields are JSONPaths starting with $',
      'title: JSON fields need an alias (AS)',
    ]);
    expect(searchIndexProblems({ on: 'HASH', prefixes: ['a:', 'a:'], schema: [{ name: 'v', type: 'VECTOR' }, { name: 'v', type: 'NUMERIC', noIndex: true, weight: 1 }] })).toEqual([
      'Prefixes must be unique.',
      'Field name v is used twice.',
      'v: VECTOR needs algorithm, type, dimension and distance',
      'v: NOINDEX needs SORTABLE',
      'v: NOSTEM and WEIGHT only apply to TEXT',
    ]);
    expect(zSearchIndexCreate.safeParse({ ...ok, schema: [{ name: 'f', type: 'TAG', separator: '"' }] }).success).toBe(false);
    expect(zSearchIndexCreate.safeParse({ ...ok, schema: [{ name: 'f', as: '1x', type: 'TAG' }] }).success).toBe(false);
  });

  it('infers field types from sampled values', () => {
    expect(inferSearchFieldType('42', 'HASH')).toBe('NUMERIC');
    expect(inferSearchFieldType('-1.5e3', 'HASH')).toBe('NUMERIC');
    expect(inferSearchFieldType('42', 'JSON')).toBe('TAG');
    expect(inferSearchFieldType(42, 'JSON')).toBe('NUMERIC');
    expect(inferSearchFieldType('Blue gadget', 'HASH')).toBe('TEXT');
    expect(inferSearchFieldType('tools', 'HASH')).toBe('TAG');
    expect(inferSearchFieldType('x'.repeat(65), 'HASH')).toBe('TEXT');
    expect(inferSearchFieldType('13.4,52.5', 'HASH')).toBe('GEO');
    expect(inferSearchFieldType('200,52.5', 'HASH')).toBe('TAG'); // out of GEO range, not a number
    expect(inferSearchFieldType(true, 'JSON')).toBe('TAG');
    expect(inferSearchFieldType([1, 2, 3], 'JSON')).toBe('VECTOR');
    expect(inferSearchFieldType(['a', 'b'], 'JSON')).toBe('TAG');
    expect(inferSearchFieldType([{ a: 1 }], 'JSON')).toBeUndefined();
    expect(inferSearchFieldType({ a: 1 }, 'JSON')).toBeUndefined();
    expect(inferSearchFieldType(null, 'JSON')).toBeUndefined();
    expect(mergeSearchFieldTypes({ NUMERIC: 3 })).toBe('NUMERIC');
    expect(mergeSearchFieldTypes({ NUMERIC: 3, TAG: 1 })).toBe('TAG');
    expect(mergeSearchFieldTypes({ TAG: 3, TEXT: 1 })).toBe('TEXT');
  });

  it('escapes prefixes for SCAN and builds JSON paths', () => {
    expect(globEscape('a*b?[c]\\')).toBe('a\\*b\\?\\[c\\]\\\\');
    expect(jsonPathChild('$', 'title')).toBe('$.title');
    expect(jsonPathChild('$.a', 'odd name')).toBe('$.a["odd name"]');
    expect(jsonPathChild('$', '"q"')).toBe('$["\\"q\\""]');
  });
});

describe('search query options', () => {
  it('builds SORTBY / RETURN / LIMIT / DIALECT in FT.SEARCH order', () => {
    expect(buildFtSearchArgv({ index: 'i', query: '', offset: 20, limit: 10, sortBy: 'price', sortOrder: 'DESC', returnFields: ['title', 'price'], dialect: 2 })).toEqual([
      'FT.SEARCH', 'i', '*', 'RETURN', '2', 'title', 'price', 'SORTBY', 'price', 'DESC', 'LIMIT', '20', '10', 'DIALECT', '2',
    ]);
    expect(buildFtSearchArgv({ index: 'i', query: '@t:x' })).toEqual(['FT.SEARCH', 'i', '@t:x', 'LIMIT', '0', '20']);
  });
  it('bounds the options', () => {
    const base = { index: 'i', query: '*' };
    expect(zSearchQuery.safeParse({ ...base, returnFields: [] }).success).toBe(false);
    expect(zSearchQuery.safeParse({ ...base, returnFields: Array(33).fill('f') }).success).toBe(false);
    expect(zSearchQuery.safeParse({ ...base, dialect: 5 }).success).toBe(false);
    expect(zSearchQuery.safeParse({ ...base, sortOrder: 'UP' }).success).toBe(false);
    expect(zSearchQuery.safeParse({ ...base, sortBy: 'f', sortOrder: 'DESC', dialect: 4 }).success).toBe(true);
  });
});

describe('argument rules', () => {
  it('refuses FT.DROPINDEX … DD only', () => {
    expect(argumentRule(['FT.DROPINDEX', 'i', 'DD'])?.class).toBe('blocked');
    expect(argumentRule(['ft.dropindex', 'i', 'dd'])?.class).toBe('blocked');
    expect(argumentRule(['FT.DROPINDEX', 'DD'])).toBeUndefined();
    expect(argumentRule(['FT.DROPINDEX', 'i'])).toBeUndefined();
    expect(argumentRule(['GET', 'DD'])).toBeUndefined();
  });
});
