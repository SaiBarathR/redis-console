import { ErrorReply } from 'redis';
import { describe, expect, it } from 'vitest';
import { keysMetadata } from '../../src/routes/keys.ts';
import type { Arg, Conn, PipelineCommand } from '../../src/redis/manager.ts';

/** A fake connection answering a metadata batch from `reply(command, key)`; records the batches it got. */
function fake(reply: (cmd: string, key: string) => unknown) {
  const batches: Arg[][][] = [];
  const conn = {
    pipeline: async (commands: PipelineCommand[]) => {
      batches.push(commands.map((c) => c.args));
      return commands.map((c) => reply(String(c.args[0]), String(c.args[c.args[0] === 'MEMORY' ? 2 : 1])));
    },
  } as unknown as Conn;
  return { conn, batches };
}
const o = { ttl: true, size: true, samples: 0, timeout: 1000 };

describe('key metadata (v0.2.1)', () => {
  it('asks each distinct key once and answers every requested position', async () => {
    const { conn, batches } = fake((cmd) => (cmd === 'TYPE' ? 'hash' : cmd === 'PTTL' ? 1500 : 4096));
    const keys = ['big', 'big', 'other', 'big'].map((k) => Buffer.from(k));
    const out = await keysMetadata(conn, keys, o);
    expect(batches[0]!.filter((a) => a[0] === 'MEMORY')).toHaveLength(2);
    expect(out.map((k) => k.key.data)).toEqual(['big', 'big', 'other', 'big']);
    expect(out[0]).toEqual({ key: { enc: 'utf8', data: 'big' }, type: 'hash', ttl: 2, size: 4096 });
  });
  it('uses the configured MEMORY USAGE samples', async () => {
    const { conn, batches } = fake(() => 1);
    await keysMetadata(conn, [Buffer.from('k')], { ...o, samples: 5 });
    expect(batches[0]!.find((a) => a[0] === 'MEMORY')).toEqual(['MEMORY', 'USAGE', Buffer.from('k'), 'SAMPLES', '5']);
  });
  it('a key the ACL user may not access is unknown; a command it may not run fails the request', async () => {
    const keyDenied = fake((cmd, key) => (key === 'secret' ? new ErrorReply('NOPERM No permissions to access a key') : cmd === 'TYPE' ? 'string' : 1));
    const out = await keysMetadata(keyDenied.conn, [Buffer.from('ok'), Buffer.from('secret')], o);
    expect(out[0]).toMatchObject({ type: 'string' });
    expect(out[1]).toEqual({ key: { enc: 'utf8', data: 'secret' }, type: 'unknown' });
    const commandDenied = fake((cmd) => (cmd === 'TYPE' ? new ErrorReply("NOPERM User rc-viewer has no permissions to run the 'type' command") : 1));
    await expect(keysMetadata(commandDenied.conn, [Buffer.from('ok')], o)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('a gone key is none with TTL -2 and no size', async () => {
    const { conn } = fake((cmd) => (cmd === 'TYPE' ? 'none' : cmd === 'PTTL' ? -2 : null));
    expect(await keysMetadata(conn, [Buffer.from('x')], o)).toEqual([{ key: { enc: 'utf8', data: 'x' }, type: 'none', ttl: -2 }]);
  });
  it('graphdata keys carry no size: core MEMORY USAGE is a constant unrelated to the graph (review v0.4 r2 graph L4)', async () => {
    const { conn } = fake((cmd, key) => (cmd === 'TYPE' ? (key === 'g' ? 'graphdata' : 'hash') : cmd === 'PTTL' ? -1 : 40));
    const out = await keysMetadata(conn, [Buffer.from('g'), Buffer.from('h')], o);
    expect(out[0]).toEqual({ key: { enc: 'utf8', data: 'g' }, type: 'graphdata', ttl: -1 });
    expect(out[1]).toMatchObject({ type: 'hash', size: 40 });
  });
});
