import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json',import.meta.url));
const { createClient } = require('redis');
// Only 6411 (sandbox-e2e) and 6412 (snapshot) are allowed.
export async function direct(port = 6411, user = 'rc-admin', pwEnv = 'SANDBOX_REDIS_ADMIN_PASSWORD') {
  if (port !== 6411 && port !== 6412) throw new Error('forbidden port');
  const c = createClient({ url: `redis://127.0.0.1:${port}`, username: user, password: process.env[pwEnv], RESP: 3 });
  await c.connect(); return c;
}
