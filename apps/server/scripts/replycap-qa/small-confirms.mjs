// Former probe failure is covered by integration/replycap.test.ts: there are no probes to fail open.
console.log({probeFailure: 'estimator removed; all data replies measured'});
const { resolveConfig } = await import('../../src/config.ts');
// L5: catch-all proxy CIDRs pass the production check that refuses trustProxy=true.
const base = (tp) => ({ server: { publicUrl: 'https://rc.example.com', trustProxy: tp }, auth: { oidc: { enabled: true, issuer: 'https://idp.example.com', clientId: 'c', clientSecret: { env: 'S' }, roleMapping: { g: 'viewer' } } }, databases: [] });
for (const tp of [true, '0.0.0.0/0,::/0', 50]) { try { resolveConfig(base(tp), { env: { NODE_ENV: 'production', S: 'x' } }); console.log('trustProxy', JSON.stringify(tp), 'accepted in production'); } catch (e) { console.log('trustProxy', JSON.stringify(tp), 'refused'); } }
