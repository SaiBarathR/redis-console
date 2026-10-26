import { oidc } from './lib.mjs';
import { direct } from './redis.mjs';
const r = await direct(6411);
const K = 'rc-review-s3:matrix';
console.log('keys:', (await r.scan('0', { MATCH: K + '*', COUNT: 100000 })).keys);
await r.del((await r.scan('0', { MATCH: K + '*', COUNT: 100000 })).keys);
for (const user of ['viewer1', 'operator1', 'admin1']) {
  const c = await oidc(user);
  for (const db of ['ro-e2e', 'viewer-e2e', 'op-e2e']) {
    const res = await c.api('POST', `/api/v1/databases/${db}/workbench`, { script: `SET ${K}:wb x`, stopOnError: false });
    console.log(user, db, res.json.results.map((x) => x.error?.code ?? x.reply?.t).join(','));
  }
}
console.log('after workbench:', (await r.scan('0', { MATCH: K + '*', COUNT: 100000 })).keys);
await r.del((await r.scan('0', { MATCH: K + '*', COUNT: 100000 })).keys.concat(['__none__']));
await r.quit();
