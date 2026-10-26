// JSON per-match commands count one element per stored BYTE of the document (not per 8-byte value), so
// JSON.TYPE/ARRLEN/STRLEN/OBJLEN with a wildcard are refused on ordinary ~120 KB documents.
import { direct } from './redis.mjs';
import { local } from './lib.mjs';
const r = await direct(6411);
const K = 'rc-review-s3:json';
const doc = { id: 1, title: 'x', items: Array.from({ length: 400 }, (_, i) => ({ id: i, name: 'item ' + i, tags: ['a', 'b'], text: 'lorem ipsum '.repeat(20) })) };
await r.sendCommand(['JSON.SET', K, '$', JSON.stringify(doc)]);
const mem = await r.sendCommand(['MEMORY', 'USAGE', K]);
const v = await local('qa-viewer');
const out = { memoryUsage: mem };
for (const argv of [['JSON.TYPE', K, '$.*'], ['JSON.OBJLEN', K, '$.items[*]'], ['JSON.STRLEN', K, '$.items[*].name'], ['JSON.ARRLEN', K, '$..tags'], ['JSON.GET', K, '$.items[*].id'], ['JSON.OBJKEYS', K, '$.items[0]']]) {
  await new Promise((ok) => setTimeout(ok, 100));
  const res = await v.cli('sandbox-e2e', argv);
  const direct_ = await r.sendCommand(argv);
  out[argv[0] + ' ' + argv[2]] = `${res.status} ${res.json?.error?.code ?? res.json?.reply?.t}; direct reply elements=${Array.isArray(direct_) ? direct_.length : 1}`;
}
console.log(out);
await r.del(K); await r.quit();
