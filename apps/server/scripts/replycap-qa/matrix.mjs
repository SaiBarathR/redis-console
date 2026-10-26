// Every write path x (readOnly, maxRole=viewer, maxRole=operator) as OIDC admin1/operator1/viewer1; checks nothing is written.
import { oidc } from './lib.mjs';
import { direct } from './redis.mjs';
const r = await direct(6411);
const K = 'rc-review-s3:matrix';
const utf8 = (s) => ({ enc: 'utf8', data: s });
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const paths = (db) => [
  ['cli SET', 'POST', `/api/v1/databases/${db}/cli`, { argv: ['SET', K + ':cli', 'x'] }],
  ['cli DEL', 'POST', `/api/v1/databases/${db}/cli`, { argv: ['DEL', K + ':cli'] }],
  ['cli FLUSHDB', 'POST', `/api/v1/databases/${db}/cli`, { argv: ['FLUSHDB'] }],
  ['cli CLIENT KILL', 'POST', `/api/v1/databases/${db}/cli`, { argv: ['CLIENT', 'KILL', 'ID', '999999'] }],
  ['cli FT.CURSOR DEL', 'POST', `/api/v1/databases/${db}/cli`, { argv: ['FT.CURSOR', 'DEL', 'idx', '1'] }],
  ['cli CONFIG GET', 'POST', `/api/v1/databases/${db}/cli`, { argv: ['CONFIG', 'GET', 'maxmemory'] }],
  ['workbench SET', 'POST', `/api/v1/databases/${db}/workbench`, { script: `SET ${K}:wb x`, stopOnError: false }],
  ['ops string.set', 'POST', `/api/v1/databases/${db}/ops`, { op: 'string.set', key: utf8(K + ':op'), value: utf8('x') }],
  ['ops key.expire', 'POST', `/api/v1/databases/${db}/ops`, { op: 'key.expire', key: utf8(K + ':op'), ttl: 100 }],
  ['bulk-delete', 'POST', `/api/v1/databases/${db}/bulk-delete`, { match: K + ':*' }],
  ['publish', 'POST', `/api/v1/databases/${db}/pubsub/publish`, { channel: K, message: utf8('x') }],
  ['slowlog reset', 'POST', `/api/v1/databases/${db}/slowlog/reset`, {}],
  ['clients kill', 'POST', `/api/v1/databases/${db}/clients/kill`, { id: '999999' }],
  ['clients list', 'GET', `/api/v1/databases/${db}/clients`],
  
];
const rows = [];
for (const user of ['viewer1', 'operator1', 'admin1']) {
  const c = await oidc(user);
  for (const db of ['ro-e2e', 'viewer-e2e', 'op-e2e']) {
    for (const [name, m, p, body] of paths(db)) {
      await sleep(80);
      const ac = new AbortController(); setTimeout(() => ac.abort(), 2500);
      let res; try { res = await c.api(m, p, body); } catch { res = { status: 'aborted' }; }
      rows.push({ user, db, name, status: res.status, code: res.json?.error?.code ?? (res.json?.reply?.t === 'err' ? 'reply-err' : '') });
    }
  }
}
const written = (await r.scan('0', { MATCH: K + '*', COUNT: 100000 })).keys;
const pivot = {};
for (const x of rows) { const k = `${x.name}`; pivot[k] ??= {}; pivot[k][`${x.user.replace('1','')}@${x.db.replace('-e2e','')}`] = `${x.status}${x.code ? ' ' + x.code : ''}`; }
console.table(pivot);
console.log('keys written:', written.length);
await r.quit();
