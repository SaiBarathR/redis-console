/**
 * Synthetic, real-sized data for the anatomy lint: every key type at the sizes that break layouts (3 MiB string,
 * 7,000-field hash with 64-char hex names and 300-byte JSON values, long members, a 220-char key name, binary).
 * Attached runs (RC_E2E_ATTACH=1) write only under the scratch prefix `uiE:20261030:anatomy:<run>:`; the harness
 * run uses its own disposable Redis under `e2e:scratch:`. close() removes every key under the prefix and the index.
 */
import { randomBytes } from 'node:crypto';
import { RedisConn, type Arg } from './resp.ts';
import { E2E_REDIS, envVar } from './env.ts';

const run = randomBytes(4).toString('hex');
export const anatomyPrefix = `${process.env.RC_E2E_ATTACH === '1' ? 'uiE:20261030:' : 'e2e:scratch:'}anatomy:${run}:`;
export const anatomyIndex = `${anatomyPrefix}idx`;
export const KEY_TYPES = ['string', 'large', 'binary', 'hash', 'list', 'set', 'zset', 'stream', 'json', 'timeseries', 'bloom', 'cuckoo', 'cms', 'topk', 'tdigest', 'array', 'vectorset', 'geo'] as const;
export const longKey = `${anatomyPrefix}long-${'x'.repeat(220)}`;

async function withRedis<T>(fn: (r: RedisConn) => Promise<T>): Promise<T> {
  const r = await RedisConn.connect({ ...E2E_REDIS, username: 'default', password: envVar('SANDBOX_REDIS_DEFAULT_PASSWORD') });
  try { return await fn(r); } finally { r.close(); }
}
export const anatomyExec = (args: Arg[]) => withRedis(r => r.cmd(args));

export async function seedAnatomy(): Promise<{ keys: Record<string, string>; unsupported: string[] }> {
  const keys: Record<string, string> = {};
  const unsupported: string[] = [];
  await withRedis(async r => {
    const k = (t: string) => (keys[t] = `${anatomyPrefix}${t}`);
    const long = 'long-member-'.repeat(24);
    await r.cmdOk(['SET', k('string'), 'short value']);
    await r.cmdOk(['SET', k('large'), 'x'.repeat(3 * 1024 * 1024)]);
    await r.cmdOk(['SET', k('binary'), Buffer.from([0, 255, 128, 1, 7, 200, 13, 10])]);
    for (let start = 0; start < 7000; start += 500) {
      const args: Arg[] = ['HSET', k('hash')];
      for (let i = start; i < start + 500; i++) args.push(i.toString(16).padStart(64, '0'), JSON.stringify({ id: i, body: 'lorem ipsum '.repeat(24) }));
      await r.cmdOk(args);
    }
    await r.cmdOk(['RPUSH', k('list'), long, 'second', 'third']);
    await r.cmdOk(['SADD', k('set'), long, 'second', 'third']);
    await r.cmdOk(['ZADD', k('zset'), 1, long, 2.5, 'second', 1e9, 'third']);
    for (let i = 0; i < 6; i++) await r.cmdOk(['XADD', k('stream'), '*', 'field', i ? `value ${i}` : long, 'n', i]);
    await r.cmdOk(['XGROUP', 'CREATE', k('stream'), 'anatomy-group', '0']);
    await r.cmdOk(['XGROUP', 'CREATE', k('stream'), 'anatomy-second-group', '$']);
    await r.cmdOk(['XREADGROUP', 'GROUP', 'anatomy-group', 'consumer-1', 'COUNT', 3, 'STREAMS', k('stream'), '>']);
    await r.cmdOk(['GEOADD', k('geo'), 13.361389, 38.115556, 'Palermo', 15.087269, 37.502669, 'Catania', 2.3522, 48.8566, long]);
    await r.cmdOk(['SET', longKey, 'value']);
    keys['long-key'] = longKey;
    for (let i = 1; i <= 6; i++) await r.cmdOk(['HSET', `${anatomyPrefix}doc:${i}`, 'title', `Blue gadget ${i}`, 'price', i * 10, 'category', i % 2 ? 'tools' : 'toys']);
    const now = Date.now();
    const modules: [string, Arg[][]][] = [
      ['json', [['JSON.SET', k('json'), '$', JSON.stringify({ name: 'anatomy', description: 'A long JSON string value that wraps across the inspector and must stay readable. '.repeat(4), nested: { list: [1, 2, 3], flag: true } })]]],
      ['timeseries', Array.from({ length: 30 }, (_, i) => ['TS.ADD', k('timeseries'), now - (30 - i) * 60_000, (20 + Math.sin(i / 4) * 5).toFixed(2)])],
      ['bloom', [['BF.ADD', k('bloom'), 'entry']]],
      ['cuckoo', [['CF.ADD', k('cuckoo'), 'entry']]],
      ['cms', [['CMS.INITBYDIM', k('cms'), 100, 5], ['CMS.INCRBY', k('cms'), 'entry', 3]]],
      ['topk', [['TOPK.RESERVE', k('topk'), 10], ['TOPK.ADD', k('topk'), 'alpha', 'beta']]],
      ['tdigest', [['TDIGEST.CREATE', k('tdigest')], ['TDIGEST.ADD', k('tdigest'), 1, 2, 3, 40]]],
      ['array', [['ARSET', k('array'), 0, 'alpha', 'beta', long], ['ARSET', k('array'), 1000, 'far away']]],
      ['vectorset', [['VADD', k('vectorset'), 'VALUES', 3, 1, 0, 0, 'member-a'], ['VADD', k('vectorset'), 'VALUES', 3, 0, 1, 0, long]]],
    ];
    for (const [type, cmds] of modules) {
      try { for (const c of cmds) await r.cmdOk(c); } catch { unsupported.push(type); delete keys[type]; }
    }
    try {
      await r.cmdOk(['FT.CREATE', anatomyIndex, 'ON', 'HASH', 'PREFIX', 1, `${anatomyPrefix}doc:`, 'SCHEMA', 'title', 'TEXT', 'price', 'NUMERIC', 'SORTABLE', 'category', 'TAG']);
    } catch { unsupported.push('search'); }
  });
  return { keys, unsupported };
}

/** Removes everything under the run prefix (including keys the UI created) and the search index. */
export async function cleanupAnatomy(): Promise<number> {
  return withRedis(async r => {
    await r.cmd(['FT.DROPINDEX', anatomyIndex]).catch(() => undefined);
    let cursor = '0', removed = 0;
    do {
      const [next, batch] = await r.cmd(['SCAN', cursor, 'MATCH', `${anatomyPrefix}*`, 'COUNT', 1000]) as [Buffer, Buffer[]];
      cursor = next.toString();
      if (batch.length) { await r.cmdOk(['UNLINK', ...batch]); removed += batch.length; }
    } while (cursor !== '0');
    return removed;
  });
}
