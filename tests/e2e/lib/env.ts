/**
 * Loads the repository `.env` (sandbox secrets) without printing anything.
 * Every value in it is treated as a secret by the leak scanner.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(E2E_DIR, '../..');
export const STATE_DIR = path.join(E2E_DIR, '.state');
export const DATA_DIR = path.join(E2E_DIR, '.data');

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

const fileEnv = parseEnvFile(path.join(REPO_ROOT, '.env'));
/** process.env wins (CI provides values as env vars). */
export function envVar(name: string): string {
  const v = process.env[name] ?? fileEnv[name];
  if (!v) throw new Error(`Missing ${name} (set it in .env or the environment)`);
  return v;
}
export function envVarOpt(name: string): string | undefined {
  return process.env[name] ?? fileEnv[name];
}

export const SECRET_ENV_NAMES = [
  'SANDBOX_REDIS_DEFAULT_PASSWORD',
  'SANDBOX_REDIS_VIEWER_PASSWORD',
  'SANDBOX_REDIS_OPERATOR_PASSWORD',
  'SANDBOX_REDIS_ADMIN_PASSWORD',
  'OIDC_CLIENT_SECRET',
  'KC_ADMIN_PASSWORD',
  'KC_USER_PASSWORD',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'TOTP_ENCRYPTION_KEY',
  'RC_E2E_REMOTE_PASSWORD',
] as const;

/** Secret values from .env (and the environment), longest first; target addresses are public config. */
export function secretValues(): { name: string; value: string }[] {
  const names = new Set<string>([...SECRET_ENV_NAMES, ...Object.keys(fileEnv).filter(n => !/^(RC_E2E|RC_TEST)_REMOTE_(HOST|PORT|USER|PASSWORD_ENV)$/.test(n)), envVarOpt('RC_E2E_REMOTE_PASSWORD_ENV') ?? 'RC_E2E_REMOTE_PASSWORD']);
  const out: { name: string; value: string }[] = [];
  for (const n of names) {
    const v = envVarOpt(n);
    if (v && v.length >= 8 && v !== 'CHANGE_ME') out.push({ name: n, value: v });
  }
  return out.sort((a, b) => b.value.length - a.value.length);
}

export const BASE_URL = process.env.RC_E2E_BASE_URL ?? 'http://localhost:4400';
/** Dedicated e2e Redis (see lib/redis-container.ts); database ids sandbox-e2e (db 0) and e2e-prod-sim (db 1). */
export const E2E_REDIS = { host: '127.0.0.1', port: Number(process.env.RC_E2E_REDIS_PORT ?? 6431) };
/** Read-only filtering proxy in front of the selected upstream (see lib/remote-target.ts). */
export const PROXY_PORT = Number(process.env.RC_E2E_PROXY_PORT ?? 6430);
export const KEYCLOAK_URL = process.env.RC_E2E_KEYCLOAK_URL ?? 'http://localhost:8089';

export const DB = { e2e: 'sandbox-e2e', prodSim: 'e2e-prod-sim', remote: 'remote-6390' } as const;
