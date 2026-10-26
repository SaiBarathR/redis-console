/**
 * Ports of the local development loop, shared by the root `pnpm dev` (scripts/dev-loop.ts), the server's `dev`/`start`
 * launcher (apps/server/scripts/dev.ts) and Vite (apps/web/vite.config.ts), so the server and Vite's `/api` proxy agree.
 *
 * - Server port: RCONSOLE_PORT, else the dev config's `server.port`, else 4000.
 * - Vite port: RCONSOLE_WEB_PORT, else 5173.
 * - Dev config: RCONSOLE_CONFIG, else config/rconsole.local.json if it exists, else config/rconsole.dev.json.
 * Variables come from the environment first, then the repository's `.env` (only these names are read from it).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');
export const DEFAULT_SERVER_PORT = 4000;
export const DEFAULT_WEB_PORT = 5173;

type Env = Record<string, string | undefined>;

/** RCONSOLE_PORT / RCONSOLE_WEB_PORT / RCONSOLE_CONFIG from the environment, else from the repository's .env. */
function setting(name: string, env: Env, root: string): string | undefined {
  if (env[name]) return env[name];
  try {
    return parseEnv(readFileSync(path.join(root, '.env'), 'utf8'))[name] || undefined;
  } catch {
    return undefined;
  }
}

function port(value: string, name: string): number {
  const p = Number(value);
  if (!/^\d+$/.test(value) || p < 1 || p > 65535) throw new Error(`${name} must be a port number (1-65535), not "${value}"`);
  return p;
}

/** The config file the server's dev/start launcher uses. A relative RCONSOLE_CONFIG resolves from `cwd`. */
export function devConfigFile(env: Env = process.env, root = REPO_ROOT, cwd = process.cwd()): string {
  const set = setting('RCONSOLE_CONFIG', env, root);
  if (set) return path.resolve(cwd, set);
  const local = path.join(root, 'config', 'rconsole.local.json');
  return existsSync(local) ? local : path.join(root, 'config', 'rconsole.dev.json');
}

function configServer(file: string): { port?: unknown; publicUrl?: unknown } {
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { server?: { port?: unknown; publicUrl?: unknown } }).server ?? {};
  } catch {
    return {};
  }
}

export function devServerPort(env: Env = process.env, root = REPO_ROOT, cwd = process.cwd()): number {
  const set = setting('RCONSOLE_PORT', env, root);
  if (set) return port(set, 'RCONSOLE_PORT');
  const p = configServer(devConfigFile(env, root, cwd)).port;
  return typeof p === 'number' && Number.isInteger(p) && p > 0 ? p : DEFAULT_SERVER_PORT;
}

export function devWebPort(env: Env = process.env, root = REPO_ROOT): number {
  const set = setting('RCONSOLE_WEB_PORT', env, root);
  return set ? port(set, 'RCONSOLE_WEB_PORT') : DEFAULT_WEB_PORT;
}

/**
 * The server launcher's public URL when only the port was changed: a local `http://localhost:<port>` (or 127.0.0.1)
 * publicUrl in the dev config follows RCONSOLE_PORT, so sign-in, cookies and the Origin check keep working. Undefined
 * when RCONSOLE_PUBLIC_URL is set, the port is not overridden, or the config's URL is not a local http one.
 */
export function devPublicUrl(env: Env = process.env, root = REPO_ROOT, cwd = process.cwd()): string | undefined {
  const set = setting('RCONSOLE_PORT', env, root);
  if (!set || setting('RCONSOLE_PUBLIC_URL', env, root)) return undefined;
  const configured = configServer(devConfigFile(env, root, cwd)).publicUrl;
  if (typeof configured !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) return undefined;
  url.port = String(port(set, 'RCONSOLE_PORT'));
  return url.origin;
}
