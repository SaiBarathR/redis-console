// Argument text reaches the audit detail through 413 messages.
import { local } from './lib.mjs';
const v = await local('qa-viewer');
const res = await v.cli('sandbox-e2e', ['FT.SEARCH', 'anyidx', '*', 'FORMAT', 'canary-r3-4242']);
const a = await local('qa-admin');
const ev = (await a.api('GET', '/api/v1/admin/audit?limit=20')).json.events.find((e) => e.username === 'qa-viewer' && e.command === 'FT.SEARCH');
console.log({ status: res.status, auditDetail: ev?.detail, argvRedacted: ev?.argvRedacted });
