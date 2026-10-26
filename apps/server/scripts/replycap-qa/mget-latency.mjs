// Preflight round trips are sequential: MGET of N keys costs N STRLEN round trips before the MGET (remote-6390: reads only).
import { local } from './lib.mjs';
const v = await local('qa-viewer');
const p = (await v.api('POST', '/api/v1/databases/snapshot/keys/scan', { match: `${process.env.RC_QA_KEY_PREFIX ?? 'example'}:${process.env.RC_QA_KEY_PATH ?? 'group:items:v1'}:*`, count: 200, cursor: '0' })).json;
const keys = p.keys.filter((k) => k.key.enc === 'utf8').map((k) => k.key.data).slice(0, 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const db of ['snapshot', 'remote-6390']) {
  const row = { db };
  for (const [label, argv] of [['PING', ['PING']], ['MGET 1', ['MGET', keys[0]]], ['MGET 25', ['MGET', ...keys.slice(0, 25)]], ['MGET 100', ['MGET', ...keys.slice(0, 100)]]]) {
    await sleep(300); const r = await v.cli(db, argv); row[label] = `${r.status} ${r.ms}ms (redis ${r.json?.durationMs}ms)`;
  }
  console.log(row);
}
