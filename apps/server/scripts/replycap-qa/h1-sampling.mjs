// MEMORY USAGE default sampling misses one huge element among many small ones -> whole-key reads pass the preflight.
import { direct } from './redis.mjs';
import { local } from './lib.mjs';
const r = await direct(6411);
const K = 'rc-review-s3:sample';
const big = 'x'.repeat(40 * 1024 * 1024); // 40 MiB > 16 MiB preflight budget
await r.del([K+':h', K+':s', K+':l', K+':z']);
const f = {}; for (let i = 0; i < 300; i++) f['f' + i] = 'v' + i;
await r.hSet(K+':h', f); await r.hSet(K+':h', 'zz-big', big);
const mem = await r.sendCommand(['MEMORY','USAGE',K+':h']);
const enc = await r.sendCommand(['OBJECT','ENCODING',K+':h']);
await r.sAdd(K+':s', Array.from({length:300},(_,i)=>'m'+i)); await r.sAdd(K+':s', big);
await r.rPush(K+':l', Array.from({length:300},(_,i)=>'e'+i)); await r.rPush(K+':l', big);
await r.zAdd(K+':z', Array.from({length:300},(_,i)=>({score:i,value:'z'+i}))); await r.zAdd(K+':z', {score: 1000, value: big});
const out = { hash: { memoryUsage: mem, encoding: enc } };
for (const t of ['s','l','z']) out[t] = { memoryUsage: await r.sendCommand(['MEMORY','USAGE',K+':'+t]), encoding: await r.sendCommand(['OBJECT','ENCODING',K+':'+t]) };
const v = await local('qa-viewer');
const rss0 = await rss();
for (const argv of [['HGETALL',K+':h'],['HVALS',K+':h'],['SMEMBERS',K+':s'],['LRANGE',K+':l','0','-1'],['ZRANGE',K+':z','0','-1'],['DUMP',K+':h'],['SUNION',K+':s']]) {
  const res = await v.cli('sandbox-e2e', argv);
  out[argv.join(' ').replace(K,'K')] = { status: res.status, replyType: res.json?.reply?.t, error: res.json?.error?.code, ms: res.ms, httpBytes: res.bytes };
}
console.log(JSON.stringify(out, null, 1));
await r.del([K+':h', K+':s', K+':l', K+':z']);
await r.quit();
async function rss() { return 0; }
