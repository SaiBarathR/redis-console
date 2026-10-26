/**
 * Entry point: `node src/main.ts` (Node >= 24 runs TypeScript natively via type stripping).
 * Requires RCONSOLE_CONFIG. Fails closed on any configuration error.
 */
import { buildApp } from './app.ts';
import { ConfigError, configWarnings, loadConfig } from './config.ts';
import { TotpKeyError } from './store/users.ts';
import { DataDirLockedError } from './store/lock.ts';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`[rconsole] refusing to start: ${e.message}`);
      process.exit(78); // EX_CONFIG
    }
    throw e;
  }
  let built;
  try {
    built = await buildApp(config);
  } catch (e) {
    if (e instanceof TotpKeyError) {
      console.error(`[rconsole] refusing to start: ${e.message}`);
      process.exit(78); // EX_CONFIG
    }
    if (e instanceof DataDirLockedError) {
      // Another server (or `admin rotate-totp-key`) owns the data directory; its lock is left as it is.
      console.error(`[rconsole] refusing to start: ${e.message}`);
      process.exit(75); // EX_TEMPFAIL
    }
    throw e;
  }
  const { app, ctx } = built;
  for (const w of configWarnings(config)) app.log.warn(`config: ${w}`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    ctx.state.shuttingDown = true;
    app.log.info(`${signal} received; shutting down`);
    const force = setTimeout(() => {
      app.log.error('graceful shutdown timed out; exiting');
      process.exit(1);
    }, 10_000);
    force.unref();
    try {
      await app.close();
      process.exit(0);
    } catch (e) {
      app.log.error({ err: (e as Error).message }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.server.host, port: config.server.port });
  app.log.info(`Redis Console listening on ${config.server.host}:${config.server.port} (public URL ${config.server.publicOrigin})`);
}

main().catch((e: unknown) => {
  console.error('[rconsole] fatal:', (e as Error)?.message ?? e);
  process.exit(1);
});
