// Key browser read of a stream: XINFO STREAM returns first+last entry in full, before any sizing.
import { direct } from './redis.mjs';
import { local } from './lib.mjs';
import { execSync } from 'node:child_process';
const PID = process.argv[2];
const rss = () => Number(execSync(`ps -o rss= -p ${PID}`).toString().trim()) * 1024;
const r = await direct(6411);
const K = 'rc-review-s3:kbstream';
await r.del(K);
await r.xAdd(K, '*', { payload: 'a'.repeat(30 * 1024 * 1024) });
for (let i = 0; i < 50; i++) { const m = r.multi(); for (let j = 0; j < 1000; j++) m.xAdd(K, '*', { a: 'b' }); await m.exec(); }
await r.xAdd(K, '*', { payload: 'z'.repeat(30 * 1024 * 1024) });
const v = await local('qa-viewer');
let peak = 0; const before = rss(); const t = setInterval(() => { peak = Math.max(peak, rss()); }, 2);
const res = await v.api('POST', '/api/v1/databases/sandbox-e2e/key/read', { key: { enc: 'utf8', data: K }, count: 100 });
clearInterval(t);
console.log({ status: res.status, httpBytes: res.bytes, entries: res.json?.value?.entries?.length, ms: res.ms, rssBeforeMiB: Math.round(before / 1048576), rssPeakMiB: Math.round(peak / 1048576) });
await r.del(K); await r.quit();
