import { direct } from './redis.mjs';
const r = await direct(6411);
for (const u of ['rc-viewer','rc-operator','rc-admin']) { const g = await r.sendCommand(['ACL','GETUSER',u]); const m = Array.isArray(g) ? Object.fromEntries(g.reduce((a,x,i)=>i%2?a:[...a,[String(x),g[i+1]]],[])) : g; console.log(u, String(m.commands ?? m.get?.('commands')), String(m.keys ?? ''), String(m.channels ?? '')); }
await r.quit();
