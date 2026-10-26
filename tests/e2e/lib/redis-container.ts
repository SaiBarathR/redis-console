/**
 * Dedicated, disposable Redis 8 for the e2e suite (127.0.0.1:6431, container `rconsole-e2e-redis`).
 *
 * Why not the shared sandbox-e2e on 6411: other agents/developers use 6411 concurrently; the suite
 * flushes and reseeds its Redis and asserts exact contents, so sharing makes both sides flaky.
 * This container is configured exactly like infra's redis-e2e: same redis.conf template and the
 * same per-tier ACL users (infra/redis/users.acl.template, passwords from .env).
 *
 * Set RC_E2E_REDIS_EXTERNAL=1 when something else provides it (CI service container).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { E2E_DIR, E2E_REDIS, REPO_ROOT, envVar } from './env.ts';
import { RedisConn } from './resp.ts';

export const CONTAINER = 'rconsole-e2e-redis';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function renderAclFile(): string {
  return readFileSync(path.join(REPO_ROOT, 'infra/redis/users.acl.template'), 'utf8')
    .replace('__DEFAULT_HASH__', sha(envVar('SANDBOX_REDIS_DEFAULT_PASSWORD')))
    .replace('__VIEWER_HASH__', sha(envVar('SANDBOX_REDIS_VIEWER_PASSWORD')))
    .replace('__OPERATOR_HASH__', sha(envVar('SANDBOX_REDIS_OPERATOR_PASSWORD')))
    .replace('__ADMIN_HASH__', sha(envVar('SANDBOX_REDIS_ADMIN_PASSWORD')));
}

async function ping(): Promise<boolean> {
  try {
    const c = await RedisConn.connect({ ...E2E_REDIS, username: 'default', password: envVar('SANDBOX_REDIS_DEFAULT_PASSWORD') });
    await c.cmd(['PING']);
    c.close();
    return true;
  } catch {
    return false;
  }
}

export async function ensureE2ERedis(): Promise<void> {
  if (process.env.RC_E2E_REDIS_EXTERNAL === '1') {
    if (!(await ping())) throw new Error(`RC_E2E_REDIS_EXTERNAL=1 but Redis on ${E2E_REDIS.host}:${E2E_REDIS.port} is not reachable with the sandbox default user`);
    return;
  }
  // Outside .state (which global setup wipes): Docker Desktop file sharing can miss files created
  // a moment before the bind mount, so keep them stable across runs.
  const dir = path.join(E2E_DIR, '.redis');
  mkdirSync(dir, { recursive: true });
  const acl = path.join(dir, 'users.acl');
  const conf = path.join(dir, 'redis.conf');
  writeFileSync(acl, renderAclFile());
  writeFileSync(conf, readFileSync(path.join(REPO_ROOT, 'infra/redis/redis.conf.template'), 'utf8'));
  chmodSync(acl, 0o644);
  chmodSync(conf, 0o644);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { docker(['rm', '-f', CONTAINER]); } catch { /* not running */ }
    docker([
    'run', '-d', '--name', CONTAINER,
    '-p', `127.0.0.1:${E2E_REDIS.port}:6379`,
    '--read-only', '--tmpfs', '/data', '--tmpfs', '/tmp', '--security-opt', 'no-new-privileges:true',
    '-v', `${conf}:/usr/local/etc/redis/redis.conf:ro`,
    '-v', `${acl}:/usr/local/etc/redis/users.acl:ro`,
    'redis:8', 'redis-server', '/usr/local/etc/redis/redis.conf',
    ]);
    for (let i = 0; i < 50; i++) {
      if (await ping()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`e2e Redis container did not become ready (docker logs ${CONTAINER})`);
}

export function removeE2ERedis(): void {
  if (process.env.RC_E2E_REDIS_EXTERNAL === '1' || process.env.RC_E2E_KEEP_REDIS === '1') return;
  try { docker(['rm', '-f', CONTAINER]); } catch { /* ignore */ }
}
