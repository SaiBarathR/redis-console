import { describe, expect, it } from 'vitest';
import { isRedisSpace, tokenizeCommandLine, tokenizeCommandLineBytes } from './commands.ts';

const utf8 = (b: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(b);

describe('command tokenizer whitespace (redis-cli isspace semantics)', () => {
  it('splits only on ASCII space, tab, newline, vertical tab, form feed and carriage return', () => {
    for (const c of [' ', '\t', '\n', '\v', '\f', '\r']) expect(isRedisSpace(c)).toBe(true);
    for (const c of ['﻿', ' ', ' ', ' ', '　', '​', 'a']) expect(isRedisSpace(c)).toBe(false);
  });

  it('keeps a BOM-prefixed key as one argument instead of silently dropping the BOM', () => {
    expect(tokenizeCommandLine('DEL ﻿user:1')).toEqual(['DEL', '﻿user:1']);
    expect(tokenizeCommandLineBytes('DEL ﻿user:1').map(utf8)).toEqual(['DEL', '﻿user:1']);
  });

  it('keeps non-breaking and other Unicode spaces inside an argument', () => {
    expect(tokenizeCommandLine('GET a b')).toEqual(['GET', 'a b']);
    expect(tokenizeCommandLineBytes('SET k　x v').map(utf8)).toEqual(['SET', 'k　x', 'v']);
  });

  it('still splits on ASCII whitespace runs', () => {
    expect(tokenizeCommandLine(' SET\tk \r\n v ')).toEqual(['SET', 'k', 'v']);
  });
});
