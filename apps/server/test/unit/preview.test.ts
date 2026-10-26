import { describe, expect, it } from 'vitest';
import { PREVIEW_KEY_MAX_BYTES, PREVIEW_MAX_ARGS, PREVIEW_MAX_COMMANDS, type KeyOp } from '@rconsole/shared';
import { buildPreview, previewArg, previewCommand, utf8Prefix } from '../../src/policy/preview.ts';
import { planOp, previewOp } from '../../src/routes/keys.ts';

const u = (data: string) => ({ enc: 'utf8' as const, data });
const text = (a: { v: { enc: string; data: string } }) => (a.v.enc === 'utf8' ? a.v.data : `b64:${a.v.data}`);

describe('confirmation preview: arguments', () => {
  it('shows short values whole and long values as a 16-byte prefix + size', () => {
    expect(previewArg('short value', 'arg')).toEqual({ kind: 'arg', v: u('short value') });
    expect(previewArg('x'.repeat(32), 'arg')).toEqual({ kind: 'arg', v: u('x'.repeat(32)) });
    expect(previewArg('0123456789abcdefSECRET-TAIL-xxxxxxxxx', 'arg')).toEqual({ kind: 'arg', v: u('0123456789abcdef'), bytes: 37 });
  });
  it('cuts at a UTF-8 boundary so text stays text', () => {
    const s = 'aaaaaaaaaaaaaaa✓✓✓✓✓✓✓✓✓✓✓✓'; // the 3-byte ✓ straddles byte 16
    const p = previewArg(s, 'arg');
    expect(p.v).toEqual(u('aaaaaaaaaaaaaaa'));
    expect(p.bytes).toBe(Buffer.byteLength(s));
    expect(utf8Prefix(Buffer.from('✓✓'), 1).length).toBe(1); // no boundary before the cut: keep the raw byte
  });
  it('binary values become base64 prefixes', () => {
    const b = Buffer.alloc(100, 0xff);
    const p = previewArg(b, 'arg');
    expect(p.v).toEqual({ enc: 'base64', data: Buffer.alloc(16, 0xff).toString('base64') });
    expect(p.bytes).toBe(100);
  });
  it('shows keys in full up to the key cap', () => {
    const k = 'user:' + 'a'.repeat(500);
    expect(previewArg(k, 'key')).toEqual({ kind: 'key', v: u(k) });
    const huge = 'k'.repeat(PREVIEW_KEY_MAX_BYTES + 10);
    expect(previewArg(huge, 'key')).toEqual({ kind: 'key', v: u('k'.repeat(PREVIEW_KEY_MAX_BYTES)), bytes: PREVIEW_KEY_MAX_BYTES + 10 });
  });
});

describe('confirmation preview: commands', () => {
  it('labels names, keys, patterns and values', () => {
    const c = previewCommand(['XGROUP', 'DESTROY', 'stream:1', 'grp'], 2, [2]);
    expect(c.argv.map((a) => a.kind)).toEqual(['command', 'command', 'key', 'arg']);
    const s = previewCommand(['SCAN', '0', 'MATCH', 'user:*', 'COUNT', '1000'], 1, [], [3]);
    expect(s.argv[3]).toEqual({ kind: 'pattern', v: u('user:*') });
  });
  it('lists at most PREVIEW_MAX_ARGS arguments and counts the rest', () => {
    const argv = ['DEL', ...Array.from({ length: 30 }, (_, i) => `k${i}`)];
    const c = previewCommand(argv, 1, argv.map((_, i) => i).slice(1));
    expect(c.argv.length).toBe(1 + PREVIEW_MAX_ARGS);
    expect(c.moreArgs).toBe(30 - PREVIEW_MAX_ARGS);
  });
  it('caps the list at PREVIEW_MAX_COMMANDS with a "more" count', () => {
    const cmds = Array.from({ length: 70 }, (_, i) => previewCommand(['DEL', `k${i}`], 1, [1]));
    const p = buildPreview(cmds);
    expect(p.total).toBe(70);
    expect(p.commands.length).toBe(PREVIEW_MAX_COMMANDS);
    expect(p.more).toBe(20);
    expect(p.commands.map((c) => text(c.argv[1]!))).toEqual(Array.from({ length: 50 }, (_, i) => `k${i}`));
    expect(buildPreview(cmds.slice(0, 3)).more).toBeUndefined();
  });
  it('stays within its byte budget even with huge keys', () => {
    const big = 'k'.repeat(PREVIEW_KEY_MAX_BYTES);
    const cmds = Array.from({ length: 50 }, () => previewCommand(['DEL', ...Array.from({ length: 20 }, () => big)], 1, Array.from({ length: 20 }, (_, i) => i + 1)));
    const p = buildPreview(cmds);
    expect(JSON.stringify(p).length).toBeLessThan(80 * 1024);
    expect(p.commands.length + (p.more ?? 0)).toBe(50);
    expect(p.commands.length).toBeGreaterThan(0);
  });
});

describe('confirmation preview: typed ops map to the commands that run', () => {
  const op = (o: Record<string, unknown>) => o as unknown as KeyOp;
  it('key.delete: one UNLINK, or one per key in cluster mode', () => {
    const plan = planOp(op({ op: 'key.delete', keys: [u('a:1'), u('b:2')] }));
    const one = previewOp(plan, false);
    expect(one.total).toBe(1);
    expect(one.commands[0]!.argv.map((a) => [a.kind, text(a)])).toEqual([['command', 'UNLINK'], ['key', 'a:1'], ['key', 'b:2']]);
    const per = previewOp(plan, true);
    expect(per.total).toBe(2);
    expect(per.commands.map((c) => c.argv.map(text))).toEqual([['UNLINK', 'a:1'], ['UNLINK', 'b:2']]);
  });
  it('keys are shown in full; fields and values are arguments (short prefix + size when long)', () => {
    const p = previewOp(planOp(op({ op: 'hash.set', key: u('user:42'), entries: [{ field: u('email'), value: u('someone@example.com-with-a-long-tail') }] })), false);
    expect(p.commands[0]!.argv).toEqual([
      { kind: 'command', v: u('HSET') },
      { kind: 'key', v: u('user:42') },
      { kind: 'arg', v: u('email') },
      { kind: 'arg', v: u('someone@example.'), bytes: 36 },
    ]);
  });
  it('rename shows both keys; XGROUP keeps its subcommand', () => {
    expect(previewOp(planOp(op({ op: 'key.rename', key: u('a'), newKey: u('b'), nx: false })), false).commands[0]!.argv.map((a) => a.kind)).toEqual(['command', 'key', 'key']);
    expect(previewOp(planOp(op({ op: 'stream.group.destroy', key: u('s'), group: 'g' })), false).commands[0]!.argv.map((a) => [a.kind, text(a)])).toEqual([
      ['command', 'XGROUP'],
      ['command', 'DESTROY'],
      ['key', 's'],
      ['arg', 'g'],
    ]);
    // Review v0.2.1 web L2: consumer delete is a confirmed XGROUP DELCONSUMER that keeps the group and consumer bytes.
    const del = planOp(op({ op: 'stream.consumer.delete', key: u('s'), group: { enc: 'base64', data: '/0E=' }, consumer: 'c' }));
    expect(del.confirm).toBe('confirm');
    expect(Buffer.from(del.argv[3] as Buffer)).toEqual(Buffer.from([0xff, 0x41]));
    expect(previewOp(del, false).commands[0]!.argv.map((a) => [a.kind, text(a)])).toEqual([
      ['command', 'XGROUP'],
      ['command', 'DELCONSUMER'],
      ['key', 's'],
      ['arg', 'b64:/0E='],
      ['arg', 'c'],
    ]);
  });
});
