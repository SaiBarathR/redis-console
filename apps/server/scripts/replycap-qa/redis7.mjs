// Re-run the sampling comparison on the permitted 6411 sandbox. Redis 7-specific behavior is not claimed.
import {direct} from './redis.mjs';
const c=await direct(6411);
const f = {}; for (let i = 0; i < 2000; i++) f['f' + i] = 'v' + i;
await c.hSet('rc-review-s3:redis7-h', f); await c.hSet('rc-review-s3:redis7-h', 'zz-big', 'x'.repeat(40 * 1024 * 1024));
await c.rPush('rc-review-s3:redis7-l', Array.from({ length: 2000 }, (_, i) => 'e' + i)); await c.rPush('rc-review-s3:redis7-l', 'x'.repeat(40 * 1024 * 1024));
const out = {};
for (const k of ['rc-review-s3:redis7-h', 'rc-review-s3:redis7-l']) out[k] = { encoding: await c.sendCommand(['OBJECT', 'ENCODING', k]), memoryUsageDefault: await c.sendCommand(['MEMORY', 'USAGE', k]), memoryUsageSamples0: await c.sendCommand(['MEMORY', 'USAGE', k, 'SAMPLES', '0']) };
console.log(out); await c.del(['rc-review-s3:redis7-h','rc-review-s3:redis7-l']); await c.quit();
