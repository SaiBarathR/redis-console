/**
 * Global setup (runs once in the runner process):
 *  1. wipe .state / .data
 *  2. start the dedicated e2e Redis (127.0.0.1:6431)
 *  3. select the read-only upstream (explicit RC_E2E_REMOTE_* target, else a disposable seeded container) and start
 *     the filtering proxy for database remote-6390 on 127.0.0.1:6430. The read-only command table comes from the
 *     local e2e Redis, never from the upstream.
 *  4. seed fixtures, build, render .state/config.json and start the server on :4400
 * Returns the teardown function.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { DATA_DIR, E2E_REDIS, PROXY_PORT, STATE_DIR, envVar } from './lib/env.ts';
import { loadReadonlyCommandSet, startReadonlyProxy, type ProxyHandle } from './lib/readonly-proxy.ts';
import { ensureRemoteTarget, type RemoteTarget } from './lib/remote-target.ts';
import { graphExec } from './lib/graph.ts';
import { seedE2E } from './lib/fixtures-data.ts';
import { buildApps, startServer, stopServer, writeE2EConfig } from './lib/server.ts';
import { ensureE2ERedis, removeE2ERedis } from './lib/redis-container.ts';

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.RC_E2E_ATTACH === '1') return async () => {};
  const reuse = process.env.RC_E2E_REUSE_STATE === '1';
  if (!reuse) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
  mkdirSync(STATE_DIR, { recursive: true });
  let remote: RemoteTarget | undefined;
  let proxy: ProxyHandle | undefined;
  let server: Awaited<ReturnType<typeof startServer>>;
  const teardown = async () => {
    try { await stopServer(server); }
    finally {
      try { await proxy?.close(); }
      finally { remote?.close(); removeE2ERedis(); }
    }
  };
  try {
    await ensureE2ERedis();
    await graphExec(['PING']);
    const readonlyCommands = await loadReadonlyCommandSet({ ...E2E_REDIS, username: 'default', password: envVar('SANDBOX_REDIS_DEFAULT_PASSWORD') });
    remote = await ensureRemoteTarget();
    writeE2EConfig(remote);
    proxy = await startReadonlyProxy({ listenPort: PROXY_PORT, upstream: remote, readonlyCommands });
    await seedE2E();
    buildApps();
    server = await startServer({ freshData: !reuse });
    return teardown;
  } catch (e) { await teardown(); throw e; }
}
