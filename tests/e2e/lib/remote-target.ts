/**
 * Upstream for the read-only proxy (database `remote-6390` in the E2E config).
 *
 * Opt-in external target: RC_E2E_REMOTE_HOST + RC_E2E_REMOTE_PORT, user RC_E2E_REMOTE_USER (default `default`), and
 * the password from the variable named by RC_E2E_REMOTE_PASSWORD_ENV (default RC_E2E_REMOTE_PASSWORD). The harness
 * only authenticates and PINGs it here; afterwards it is reached exclusively through the filtering proxy.
 * Not configured, or not reachable: a disposable Redis container on a random loopback port, seeded with a few keys.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { envVarOpt } from './env.ts';
import { RedisConn } from './resp.ts';

export interface RemoteTarget {
  host: string;
  port: number;
  username: string;
  password: string;
  external: boolean;
  close(): void;
}

export async function ensureRemoteTarget(): Promise<RemoteTarget> {
  const host = envVarOpt('RC_E2E_REMOTE_HOST');
  const portText = envVarOpt('RC_E2E_REMOTE_PORT');
  if (host || portText) {
    try {
      if (!host || !portText || !/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('host and valid port are required');
      const username = envVarOpt('RC_E2E_REMOTE_USER') ?? 'default';
      const password = envVarOpt(envVarOpt('RC_E2E_REMOTE_PASSWORD_ENV') ?? 'RC_E2E_REMOTE_PASSWORD') ?? '';
      if (!password) throw new Error('remote password is required');
      const target = { host, port: Number(portText), username, password };
      // AUTH + PING only. Never seed, configure or otherwise mutate an external target.
      const conn = await RedisConn.connect(target);
      try { await conn.cmdOk(['PING']); } finally { conn.close(); }
      console.log('[e2e] using the configured external upstream behind the read-only proxy');
      return { ...target, external: true, close() {} };
    } catch (e) {
      console.log(`[e2e] configured remote unavailable (${e instanceof Error ? e.message : 'error'}); using a disposable fixture upstream`);
    }
  }
  const password = randomBytes(24).toString('hex');
  const name = `rconsole-e2e-readonly-${process.pid}`;
  const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let created = false;
  const close = () => { if (created) { docker(['rm', '-f', name]); created = false; } };
  try {
    // A random host port avoids collisions; only this handle owns/removes the container.
    docker(['run', '-d', '--name', name, '-p', '127.0.0.1::6379', '--read-only', '--tmpfs', '/data', '--tmpfs', '/tmp',
      '-e', `REDIS_PASSWORD=${password}`, 'redis:8', 'sh', '-c', 'exec redis-server --save "" --appendonly no --requirepass "$REDIS_PASSWORD"']);
    created = true;
    const port = Number(docker(['port', name, '6379/tcp']).split(':').at(-1));
    const target = { host: '127.0.0.1', port, username: 'default', password };
    let conn: RedisConn | undefined;
    for (let i = 0; i < 50; i++) {
      try { conn = await RedisConn.connect(target); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    if (!conn) throw new Error('disposable read-only fixture Redis did not become ready');
    try {
      await conn.cmd(['MSET', 'example:remote:a', 'one', 'example:remote:b', 'two']);
      await conn.cmd(['HSET', 'example:remote:hash', 'field', 'fixture value', 'another', 'second value']);
      await conn.cmd(['LPUSH', 'example:remote:list', 'first', 'second']);
    } finally { conn.close(); }
    console.log('[e2e] using a seeded disposable fixture upstream behind the read-only proxy');
    return { ...target, external: false, close };
  } catch (e) { close(); throw e; }
}
