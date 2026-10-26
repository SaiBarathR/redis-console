import { describe, expect, it } from 'vitest';
import { tokenizeCommandLine, tokenizeCommandLineBytes } from '@rconsole/shared';

const hex = (line: string) => tokenizeCommandLineBytes(line).map((b) => Buffer.from(b).toString('hex'));
const txt = (line: string) => tokenizeCommandLineBytes(line).map((b) => Buffer.from(b).toString('utf8'));

describe('tokenizeCommandLine (string)', () => {
  it('splits on whitespace', () => {
    expect(tokenizeCommandLine('  SET   a  b ')).toEqual(['SET', 'a', 'b']);
    expect(tokenizeCommandLine('GET\tk\nx')).toEqual(['GET', 'k', 'x']);
  });
  it('handles empty and whitespace-only lines', () => {
    expect(tokenizeCommandLine('')).toEqual([]);
    expect(tokenizeCommandLine('   \t ')).toEqual([]);
  });
  it('double quotes with escapes', () => {
    expect(tokenizeCommandLine('SET "a b" "x\\ny\\t\\"z\\\\"')).toEqual(['SET', 'a b', 'x\ny\t"z\\']);
    expect(tokenizeCommandLine('ECHO "\\x41\\x42"')).toEqual(['ECHO', 'AB']);
  });
  it('single quotes only unescape \\\'', () => {
    expect(tokenizeCommandLine("SET 'it\\'s' 'a\\nb'")).toEqual(['SET', "it's", 'a\\nb']);
  });
  it('empty quoted token is kept', () => {
    expect(tokenizeCommandLine('SET k ""')).toEqual(['SET', 'k', '']);
  });
  it('unbalanced quotes throw', () => {
    expect(() => tokenizeCommandLine('SET "abc')).toThrow(/Unbalanced/);
    expect(() => tokenizeCommandLine("SET 'abc")).toThrow(/Unbalanced/);
  });
  it('closing quote must be followed by whitespace', () => {
    expect(() => tokenizeCommandLine('SET "a"b')).toThrow(/followed by a space/);
  });
});

describe('tokenizeCommandLineBytes', () => {
  it('\\xHH produces one raw byte (not UTF-8 encoded)', () => {
    expect(hex('SET "a\\xffb"')).toEqual(['534554', '61ff62']);
    expect(hex('"\\x00\\x80"')).toEqual(['0080']);
  });
  it('invalid \\x escapes are literal x', () => {
    expect(txt('"\\xZZ"')).toEqual(['xZZ']);
  });
  it('plain text is UTF-8 encoded, including astral characters', () => {
    expect(hex('é 😀')).toEqual(['c3a9', 'f09f9880']);
    expect(hex('"😀x"')).toEqual(['f09f988078']);
  });
  it('escapes and single quotes match the string tokenizer', () => {
    expect(txt('SET "a b" "x\\ny"')).toEqual(['SET', 'a b', 'x\ny']);
    expect(txt("SET 'it\\'s' 'a\\nb'")).toEqual(['SET', "it's", 'a\\nb']);
    expect(txt('"\\a\\b\\r"')).toEqual(['\x07\b\r']);
  });
  it('empty quoted token and empty line', () => {
    expect(hex('SET k ""')).toEqual(['534554', '6b', '']);
    expect(tokenizeCommandLineBytes('   ')).toEqual([]);
  });
  it('errors like redis-cli', () => {
    expect(() => tokenizeCommandLineBytes('"abc')).toThrow(/Unbalanced/);
    expect(() => tokenizeCommandLineBytes("'a'b")).toThrow(/followed by a space/);
  });
  it('adjacent quoted and unquoted parts join into one token', () => {
    expect(txt('ab"c d" e')).toEqual(['abc d', 'e']);
  });
});
