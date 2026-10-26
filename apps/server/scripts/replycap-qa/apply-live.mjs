import { local, oidc, BASE } from './lib.mjs';
const v = process.env.RC_OIDC ? await oidc('viewer1') : await local('qa-viewer');
for (const n of (process.argv[2] ?? '16,20,22').split(',').map(Number)) {
  const argv = ['FT.AGGREGATE', 'noidx', '*', 'LOAD', '1', '@x'];
  for (let i = 0; i < n; i++) argv.push('APPLY', '@x+@x', 'AS', 'x');
  argv.push('LIMIT', '0', '10');
  let hz = [];
  const probe = setInterval(async () => { const t = Date.now(); try { await fetch(BASE + '/healthz'); hz.push(Date.now() - t); } catch { hz.push(-1); } }, 50);
  let res; try { res = await v.cli('sandbox-e2e', argv); } catch (e) { res = { status: 'conn-error ' + e.cause?.code }; }
  clearInterval(probe);
  console.log({ applies: n, bodyBytes: JSON.stringify({ argv }).length, status: res.status, err: res.json?.error?.code, ms: res.ms, healthzMaxMs: Math.max(...hz, 0) });
}
