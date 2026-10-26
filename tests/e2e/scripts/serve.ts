/**
 * Starts the full e2e stack (dedicated Redis, read-only proxy, fixtures, built SPA + server on
 * :4400) without running tests, for debugging specs by hand. Ctrl-C stops everything.
 *   pnpm --filter @rconsole/e2e serve
 */
import globalSetup from '../global-setup.ts';

const teardown = await globalSetup();
console.log('e2e stack up: http://localhost:4400 (Ctrl-C to stop)');
const stop = async () => { await teardown(); process.exit(0); };
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
setInterval(() => {}, 1 << 30);
