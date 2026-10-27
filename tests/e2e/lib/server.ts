/**
 * Builds the SPA and starts apps/server on :4400 with config/rconsole.e2e.json,
 * serving the built SPA from the server (single origin), like production.
 * Server stdout/stderr go to .state/server.log (scanned for leaks by a test).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_URL, DATA_DIR, REPO_ROOT, STATE_DIR, SECRET_ENV_NAMES, envVarOpt } from './env.ts';

export const SERVER_LOG = path.join(STATE_DIR, 'server.log');
export const E2E_CONFIG = path.join(STATE_DIR, 'config.json');

export function writeE2EConfig(remote: { username: string; password: string }): void {
  const config = JSON.parse(readFileSync(path.join(REPO_ROOT, 'config/rconsole.e2e.json'), 'utf8'));
  for (const db of config.databases) {
    // The graph module lives on its own FalkorDB sandbox, not the disposable plain Redis.
    if (db.id === 'sandbox-graph') continue;
    const port = db.id === 'remote-6390' ? process.env.RC_E2E_PROXY_PORT ?? '6430' : process.env.RC_E2E_REDIS_PORT ?? '6431';
    db.url = `redis://127.0.0.1:${port}`;
    if (db.id === 'remote-6390') db.credentials.default.username = remote.username;
  }
  config.auth.oidc.issuer = `${process.env.RC_E2E_KEYCLOAK_URL ?? 'http://localhost:8089'}/realms/rconsole`;
  process.env.RC_E2E_REMOTE_PASSWORD = remote.password;
  writeFileSync(E2E_CONFIG, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function serverEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const n of SECRET_ENV_NAMES) {
    const v = envVarOpt(n);
    if (v) env[n] = v;
  }
  env.RCONSOLE_CONFIG = E2E_CONFIG;
  env.RCONSOLE_DATA_DIR = DATA_DIR;
  env.RCONSOLE_PORT = new URL(BASE_URL).port || '4400';
  env.RCONSOLE_PUBLIC_URL = BASE_URL;
  env.NODE_ENV = process.env.RC_E2E_NODE_ENV ?? 'test';
  return env;
}

function pkgScripts(rel: string): Record<string, string> {
  const f = path.join(REPO_ROOT, rel, 'package.json');
  if (!existsSync(f)) return {};
  return (JSON.parse(readFileSync(f, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
}

export function buildApps(): void {
  if (process.env.RC_E2E_SKIP_BUILD === '1') return;
  for (const app of ['packages/shared', 'apps/server', 'apps/web']) {
    if (!pkgScripts(app).build) continue;
    const r = spawnSync('pnpm', ['--dir', path.join(REPO_ROOT, app), 'run', 'build'], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
    if (r.status !== 0) throw new Error(`build of ${app} failed`);
  }
}

/** Command used to start the server. Override with RC_E2E_SERVER_CMD. */
function serverCommand(): string[] {
  if (process.env.RC_E2E_SERVER_CMD) return ['sh', '-c', process.env.RC_E2E_SERVER_CMD];
  const scripts = pkgScripts('apps/server');
  if (scripts.start) return ['pnpm', '--dir', path.join(REPO_ROOT, 'apps/server'), 'run', 'start'];
  for (const cand of ['apps/server/src/main.ts', 'apps/server/src/index.ts', 'apps/server/src/server.ts']) {
    if (existsSync(path.join(REPO_ROOT, cand))) return ['node', path.join(REPO_ROOT, cand)];
  }
  throw new Error('Cannot find apps/server entry point (set RC_E2E_SERVER_CMD)');
}

export async function waitForHealth(url: string, timeoutMs: number, proc?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) throw new Error(`server exited with code ${proc.exitCode}; see ${SERVER_LOG}`);
    try {
      const r = await fetch(url);
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server not healthy after ${timeoutMs}ms (${last}); see ${SERVER_LOG}`);
}

export async function startServer(opts: { freshData: boolean }): Promise<ChildProcess | undefined> {
  if (process.env.RC_E2E_EXTERNAL_SERVER === '1') {
    await waitForHealth(`${BASE_URL}/healthz`, 30_000);
    return undefined;
  }
  try {
    await fetch(`${BASE_URL}/healthz`);
    throw new Error(`Something is already listening on ${BASE_URL}. Stop it (or set RC_E2E_EXTERNAL_SERVER=1).`);
  } catch (e) {
    if (String(e).includes('already listening')) throw e;
  }
  if (opts.freshData) rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  const log = createWriteStream(SERVER_LOG, { flags: opts.freshData ? 'w' : 'a' });
  const [cmd, ...args] = serverCommand();
  const proc = spawn(cmd!, args, { cwd: REPO_ROOT, env: serverEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  proc.stdout!.pipe(log);
  proc.stderr!.pipe(log);
  await waitForHealth(`${BASE_URL}/healthz`, 60_000, proc);
  return proc;
}

export async function stopServer(proc: ChildProcess | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
  const t = setTimeout(() => { try { process.kill(-proc.pid!, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } }, 5000);
  await exited;
  clearTimeout(t);
}
