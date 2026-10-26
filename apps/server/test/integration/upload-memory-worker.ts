/**
 * Child process of the constrained-heap upload test (review v0.2 r6 H1): the real app with its default limits and
 * the e2e sandbox (6411), run by the test under `--max-old-space-size=256`. It reports its port and sessions over
 * IPC, its heap use while it runs, and exits on 'stop'.
 */
import type { AddressInfo } from 'node:net';
import { buildApp } from '../../src/app.ts';
import { testConfig } from '../helpers.ts';

const { app, ctx } = await buildApp(testConfig(), { logger: false, dbPath: ':memory:', auditWrite: () => {} });
const sessions = Array.from({ length: Number(process.env.R6_MEMORY_USERS ?? 3) }, (_, i) => {
  const { id, session } = ctx.sessions.create({ userId: `oidc:r6-memory-${i}`, username: `r6-memory-${i}`, displayName: 'Memory test', source: 'oidc', role: 'operator', state: 'active', ip: '127.0.0.1' });
  return { cookie: `${ctx.sessionCookie}=${id}`, csrf: session.csrfToken };
});
await app.listen({ port: 0, host: '127.0.0.1' });
let peakHeap = 0;
const timer = setInterval(() => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); }, 10);
process.on('message', (m) => {
  if (m === 'peak') process.send!({ peakHeap });
  if (m === 'stop') { clearInterval(timer); void app.close().then(() => process.exit(0)); }
});
process.send!({ port: (app.server.address() as AddressInfo).port, sessions });
