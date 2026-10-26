// Everyday reads on snapshot as viewer: status + number of Redis calls each console command costs (INFO commandstats delta).
import { direct } from './redis.mjs';
import { local } from './lib.mjs';
const r = await direct(6412);
const stats = async () => { const s = String(await r.sendCommand(['INFO', 'commandstats'])); let n = 0; for (const m of s.matchAll(/calls=(\d+)/g)) n += Number(m[1]); return n; };
const v = await local('qa-viewer');
const DB = 'snapshot';
// find keys of each type via the app's scan
const types = {};
let cursor = '0';
do { const p = (await v.api('POST', `/api/v1/databases/${DB}/keys/scan`, { match: '*', count: 1000, cursor })).json; cursor = p.cursor; for (const k of p.keys) { const name = k.key.enc === 'utf8' ? k.key.data : null; if (!name) continue; (types[k.type] ??= []).push({ name, size: k.size }); } } while (cursor !== '0');
for (const t in types) types[t].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
console.log(Object.fromEntries(Object.entries(types).map(([t, a]) => [t, a.length])));
const s = types.string, h = types.hash, z = types.zset;
const cmds = [
  ['GET', s[0].name], ['GET', s[s.length >> 1].name], ['MGET', ...s.slice(0, 20).map((x) => x.name)], ['MGET', ...s.slice(100, 300).map((x) => x.name)],
  ['STRLEN', s[0].name], ['GETRANGE', s[0].name, '0', '99'], ['TYPE', s[0].name], ['TTL', s[0].name], ['EXISTS', s[0].name], ['OBJECT', 'ENCODING', s[0].name], ['MEMORY', 'USAGE', s[0].name], ['DUMP', s[5].name],
  ['HGETALL', h[0].name], ['HLEN', h[0].name], ['HKEYS', h[0].name], ['HVALS', h[0].name], ['HSCAN', h[0].name, '0', 'COUNT', '100'], ['HSCAN', h[0].name, '0', 'MATCH', '*a*', 'COUNT', '1000'], ['HRANDFIELD', h[0].name, '5', 'WITHVALUES'], ['HRANDFIELD', h[0].name, '-5'],
  ['HMGET', h[0].name, 'a', 'b', 'c'],
  ['ZRANGE', z[0].name, '0', '-1', 'WITHSCORES'], ['ZRANGE', z[0].name, '0', '19', 'WITHSCORES'], ['ZREVRANGE', z[0].name, '0', '9'], ['ZRANGEBYSCORE', z[0].name, '-inf', '+inf', 'LIMIT', '0', '10'], ['ZSCAN', z[0].name, '0'], ['ZCARD', z[0].name],
  ['SCAN', '0', 'COUNT', '100'], ['SCAN', '0', 'MATCH', '*user*', 'COUNT', '1000', 'TYPE', 'string'], ['INFO'], ['INFO', 'memory'], ['DBSIZE'], ['SLOWLOG', 'GET', '10'], ['CLIENT', 'INFO'], ['MEMORY', 'STATS'], ['LATENCY', 'LATEST'], ['FT._LIST'], ['RANDOMKEY'], ['PING'], ['TIME'],
  ['SORT_RO', z[0].name, 'BY', 'nosort', 'LIMIT', '0', '10'], ['OBJECT', 'FREQ', s[0].name], ['LCS', s[0].name, s[1].name, 'LEN'], ['SMISMEMBER', 'x', 'a'], ['TOUCH', s[0].name],
];
const out = [];
for (const argv of cmds.slice(Number(process.argv[2] ?? 0))) { await new Promise((ok) => setTimeout(ok, 120));
  const before = await stats();
  const res = await v.cli(DB, argv);
  const after = await stats();
  out.push({ cmd: argv[0] + (argv.length > 2 ? ` …(${argv.length - 2} args)` : ''), status: res.status, reply: res.json?.reply?.t, err: res.json?.error?.code ?? (res.json?.reply?.t === 'err' ? String(res.json.reply.v).slice(0, 60) : undefined), redisCalls: after - before - 1, ms: res.ms });
}
console.table(out);
await r.quit();
