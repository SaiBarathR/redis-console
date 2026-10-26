// Key names are unbounded: CLI SCAN / RANDOMKEY are on the "bounded" list.
import { direct } from './redis.mjs';
import { local } from './lib.mjs';
const r = await direct(6411);
const P = 'rc-review-s3:kn:';
const names = [0,1,2].map(i => P + i + ':' + 'k'.repeat(20 * 1024 * 1024));
for (const n of names) await r.set(n, '1');
const v = await local('qa-viewer');
const out = {};
for (const argv of [['SCAN','0','MATCH',P+'*','COUNT','1000'], ['RANDOMKEY']]) {
  let res;
  for (let attempt=0;attempt<(argv[0]==='RANDOMKEY'?60:1);attempt++){
    res=await v.cli('sandbox-e2e',argv);
    if(res.status===413)break;
    await new Promise(r=>setTimeout(r,60));
  }
  out[argv[0]] = { status: res.status, reply: res.json?.reply?.t, err: res.json?.error?.code, httpBytes: res.bytes, ms: res.ms };
}
const ks = await v.api('POST', '/api/v1/databases/sandbox-e2e/keys/scan', { match: P + '*', count: 1000, cursor: '0' });
out['keys/scan'] = { status: ks.status, httpBytes: ks.bytes, err: ks.json?.error?.code, keys: ks.json?.keys?.length, msg: ks.json?.error?.message };
console.log(JSON.stringify(out, null, 1));
await r.del(names); await r.quit();
