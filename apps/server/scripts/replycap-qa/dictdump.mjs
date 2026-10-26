// FT.DICTDUMP is on BOUNDED_READS but returns a whole dictionary (any size).
import { direct } from './redis.mjs';
import { local } from './lib.mjs';
const r = await direct(6411);
const D = 'rc-review-s3-dict';
const terms = [];
for (let i = 0; i < 300; i++) { const batch = Array.from({ length: 1000 }, (_, j) => `t${i}_${j}_` + 'w'.repeat(100)); await r.sendCommand(['FT.DICTADD', D, ...batch]); }
const v = await local(process.argv[2] ?? 'qa-viewer');
const res = await v.cli('sandbox-e2e', ['FT.DICTDUMP', D]);
console.log({ msg: res.json?.reply?.t === 'err' ? res.json.reply.v : undefined, status: res.status, reply: res.json?.reply?.t, elementsShown: res.json?.reply?.v?.length, more: res.json?.reply?.more, ms: res.ms, actualElements: 300000, actualBytesApprox: 300000 * 110 });
// cleanup
for (let i = 0; i < 300; i++) { const batch = Array.from({ length: 1000 }, (_, j) => `t${i}_${j}_` + 'w'.repeat(100)); await r.sendCommand(['FT.DICTDEL', D, ...batch]); }
console.log('left', (await r.sendCommand(['FT.DICTDUMP', D])).length);
await r.quit();
