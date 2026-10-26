// Reads that pass the preflight but buffer a reply far above 16 x maxReplyBytes in the server.
import { direct } from './redis.mjs';
import { local } from './lib.mjs';
import { execSync } from 'node:child_process';
const PID = process.argv[2];
const rss = () => Number(execSync(`ps -o rss= -p ${PID}`).toString().trim()) * 1024;
const r = await direct(6411);
const K = 'rc-review-s3:unsized';
const big = 'x'.repeat(40 * 1024 * 1024);
await r.del([K+':x', K+':l', K+':xs']);
// 1) stream whose last entry is 40 MiB: XINFO STREAM (no FULL) returns first + last entry.
await r.xAdd(K+':x', '*', { a: 'small' });
await r.xAdd(K+':x', '*', { payload: big });
// 2) list: first element 40 MiB, then 200k small ones (average ~ 200 B).
await r.rPush(K+':l', big);
for (let i = 0; i < 20; i++) await r.rPush(K+':l', Array.from({ length: 10000 }, (_, j) => 'e' + i + '-' + j));
// 3) stream with one 40 MiB entry first, then 100k tiny entries
await r.xAdd(K+':xs', '1-1', { payload: big });
for (let i = 0; i < 100; i++) { const m = r.multi(); for (let j = 0; j < 1000; j++) m.xAdd(K+':xs', '*', { a: 'b' }); await m.exec(); }
const v = await local('qa-viewer');
const out = {};
for (const argv of [['XINFO','STREAM',K+':x'], ['LRANGE',K+':l','0','0'], ['LINDEX',K+':l','0'], ['XRANGE',K+':xs','-','+','COUNT','1'], ['XREVRANGE',K+':x','+','-','COUNT','1'], ['LPOS', K+':l', 'zzz']]) {
  const before = rss();
  const res = await v.cli('sandbox-e2e', argv);
  out[argv.join(' ').replace(K,'K')] = { status: res.status, reply: res.json?.reply?.t, err: res.json?.error?.code, ms: res.ms, httpBytes: res.bytes, rssDeltaMiB: Math.round((rss() - before) / 1048576) };
}
console.log(JSON.stringify(out, null, 1));
await r.del([K+':x', K+':l', K+':xs']);
await r.quit();
