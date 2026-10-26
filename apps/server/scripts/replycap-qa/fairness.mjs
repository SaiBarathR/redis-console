// One viewer floods the shared viewer-tier pool with key-browser scans; another viewer's PING latency.
import { local, oidc } from './lib.mjs';
const a = await local('qa-viewer');
const b = await oidc('viewer1');
const ping = async () => { const t = Date.now(); const r = await b.cli('snapshot', ['PING']); return { status: r.status, ms: Date.now() - t }; };
console.log('baseline', await ping());
const flood = Array.from({ length: 20 }, () => a.api('POST', '/api/v1/databases/snapshot/keys/scan', { match: '*', count: 1000, cursor: '0' }));
await new Promise((r) => setTimeout(r, 30));
const during = await Promise.all([ping(), new Promise(r=>setTimeout(r,200)).then(ping), new Promise(r=>setTimeout(r,600)).then(ping)]);
const fr = await Promise.all(flood);
console.log('during', during, 'flood statuses', fr.map((r) => r.status).join(','), 'flood max ms', Math.max(...fr.map((r) => r.ms)));
