// Exact Redis NOPERM text for a key-restricted ACL user, then what the app's error path stores in the audit detail.
import { createRequire } from 'node:module';
import { direct } from './redis.mjs';
const require = createRequire(new URL('../../package.json',import.meta.url));
const { createClient } = require('redis');
const adm = await direct(6411, 'default', 'SANDBOX_REDIS_DEFAULT_PASSWORD');
await adm.sendCommand(['ACL','SETUSER','rc-review-s3-tmp','on','>tmp-pass-rc-review-s3','~allowed:*','+@read']);
const c = createClient({ url: 'redis://127.0.0.1:6411', username: 'rc-review-s3-tmp', password: 'tmp-pass-rc-review-s3', RESP: 3 });
await c.connect();
let err; try { await c.get('customer:4242:alice@example.com'); } catch (e) { err = e; }
await c.quit();
await adm.sendCommand(['ACL','DELUSER','rc-review-s3-tmp']); await adm.quit();
const { toHttpError } = await import('../../src/redis/exec.ts');
const { failureDetail } = await import('../../src/audit.ts');
const he = toHttpError(err);
console.log({ redis: err.message, httpCode: he.code, auditDetail: failureDetail(he.code, he.message, true) });
