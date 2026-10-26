/**
 * Test harness. Integration tests run against the sandbox Redis containers (6410, 6411) and, for the
 * optional configured remote dataset, strictly read-only through the viewer path.
 *
 * Env comes from the repo .env (loaded here if the variables are missing).
 */
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createClient } from 'redis';
import type { Role } from '@rconsole/shared';
import { buildApp, type BuildOptions } from '../src/app.ts';
import { resolveConfig, type AppConfig } from '../src/config.ts';
import type { AppContext } from '../src/context.ts';
import { hashPassword } from '../src/security/password.ts';

const REPO = path.resolve(import.meta.dirname, '../../..');

export function loadDotEnv(): void {
  const f = path.join(REPO, '.env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}
loadDotEnv();
// TOTP seeds are encrypted at rest; tests without a .env entry (fresh checkouts) get a throwaway key.
process.env.TOTP_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');

export const PUBLIC_URL = 'http://localhost:4100';
export const ORIGIN = PUBLIC_URL;

/** Unique key prefix per test file run, so parallel agents/tests on 6411 never collide. */
export function keyPrefix(name: string): string {
  return `rcsrv:${name}:${randomBytes(4).toString('hex')}:`;
}

const tierCreds = {
  viewer: { username: 'rc-viewer', password: { env: 'SANDBOX_REDIS_VIEWER_PASSWORD' } },
  operator: { username: 'rc-operator', password: { env: 'SANDBOX_REDIS_OPERATOR_PASSWORD' } },
  admin: { username: 'rc-admin', password: { env: 'SANDBOX_REDIS_ADMIN_PASSWORD' } },
};

/**
 * Test configuration. Databases (all on the disposable 6411 sandbox unless noted):
 * - e2e: environment=test, per-tier ACL users
 * - e2e-ro: readOnly
 * - e2e-prod: environment=prod (writes need typed name + reason; FLUSHDB is non-prod only)
 * - e2e-maxop: maxRole=operator
 * - e2e-default: only `default` credentials (= rc-operator) -> every tier uses that ACL user
 * - e2e-viewer-only: only viewer credentials -> operator/admin tiers have no connection (503, no fallback)
 * - main: 6410 (local sandbox)
 * - remote: explicit RC_TEST_REMOTE_HOST/PORT, prod + readOnly + maxRole viewer
 */
export function testConfigRaw(overrides: { local?: Record<string, unknown>; server?: Record<string, unknown>; oidc?: boolean } = {}): Record<string, unknown> {
  const databases: Record<string, unknown>[] = [
    { id: 'e2e', name: 'E2E', environment: 'test', url: 'redis://127.0.0.1:6411', credentials: tierCreds },
    { id: 'e2e-ro', name: 'E2E read-only', environment: 'test', readOnly: true, url: 'redis://127.0.0.1:6411', credentials: tierCreds },
    { id: 'e2e-prod', name: 'E2E prod', environment: 'prod', url: 'redis://127.0.0.1:6411', credentials: tierCreds },
    { id: 'e2e-maxop', name: 'E2E max operator', environment: 'test', maxRole: 'operator', url: 'redis://127.0.0.1:6411', credentials: tierCreds },
    { id: 'e2e-default', name: 'E2E default creds', environment: 'test', url: 'redis://127.0.0.1:6411', credentials: { default: tierCreds.operator } },
    { id: 'e2e-viewer-only', name: 'E2E viewer creds only', environment: 'test', url: 'redis://127.0.0.1:6411', credentials: { viewer: tierCreds.viewer } },
    { id: 'main', name: 'Sandbox main', environment: 'dev', url: 'redis://127.0.0.1:6410', credentials: tierCreds },
  ];
  if (process.env.RC_TEST_REMOTE_HOST && process.env.RC_TEST_REMOTE_PORT) {
    databases.push({
      id: 'remote', name: 'Read-only remote', environment: 'prod', readOnly: true, maxRole: 'viewer', url: `redis://${process.env.RC_TEST_REMOTE_HOST}:${process.env.RC_TEST_REMOTE_PORT}`,
      credentials: { default: { username: process.env.RC_TEST_REMOTE_USER ?? 'default', password: { env: process.env.RC_TEST_REMOTE_PASSWORD_ENV ?? 'RC_TEST_REMOTE_PASSWORD' } } },
    });
  }
  return {
    server: { host: '127.0.0.1', port: 4100, publicUrl: PUBLIC_URL, secureCookies: false, sessionTtlMinutes: 60, sessionIdleMinutes: 30, ...overrides.server },
    auth: {
      ...(overrides.oidc
        ? {
            oidc: {
              enabled: true, displayName: 'Keycloak', issuer: 'http://localhost:8089/realms/rconsole', clientId: 'rconsole',
              clientSecret: { env: 'OIDC_CLIENT_SECRET' }, groupsClaim: 'groups', allowInsecureHttpIssuer: true,
              roleMapping: { 'rconsole-admins': 'admin', 'rconsole-operators': 'operator', 'rconsole-viewers': 'viewer' },
            },
          }
        : {}),
      local: { enabled: true, requireTotpForRoles: [], totpEncryptionKey: { env: 'TOTP_ENCRYPTION_KEY' }, lockout: { maxAttempts: 5, windowMinutes: 15 }, ...overrides.local },
    },
    policy: { maxReplyBytes: 1_048_576, maxValueBytes: 524_288, commandTimeoutMs: 5000, scanBudgetMs: 300, profilerAllowedEnvironments: ['dev', 'test'], prodRequiresReason: true },
    databases,
  };
}

export function testConfig(overrides: Parameters<typeof testConfigRaw>[0] = {}): AppConfig {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'rconsole-test-'));
  const raw = testConfigRaw(overrides);
  (raw.server as Record<string, unknown>).dataDir = dataDir;
  return resolveConfig(raw, { env: { ...process.env, NODE_ENV: 'test', RCONSOLE_PORT: '', RCONSOLE_PUBLIC_URL: '', RCONSOLE_DATA_DIR: '' } });
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  auditLines: string[];
  close(): Promise<void>;
}

export async function startApp(config: AppConfig = testConfig(), opts: BuildOptions = {}): Promise<TestApp> {
  const auditLines: string[] = [];
  const { app, ctx } = await buildApp(config, { logger: false, dbPath: ':memory:', auditWrite: (l) => auditLines.push(l), ...opts });
  await app.ready();
  return { app, ctx, auditLines, close: () => app.close() };
}

export interface Client {
  cookie: string;
  csrf: string;
  userId: string;
  username: string;
  /** Inject a request with session cookie, Origin and CSRF headers. */
  req(method: InjectOptions['method'], url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any; headers: Record<string, unknown>; body: string }>;
}

export function clientFor(app: FastifyInstance, cookieName: string, rawId: string, csrf: string, userId = '', username = ''): Client {
  const c: Client = {
    cookie: rawId ? `${cookieName}=${rawId}` : '',
    csrf,
    userId,
    username,
    async req(method, url, body, headers = {}) {
      const h: Record<string, string> = { origin: ORIGIN, ...headers };
      if (c.cookie) h.cookie = c.cookie;
      if (c.csrf && method !== 'GET') h['x-csrf-token'] = c.csrf;
      const opts: InjectOptions = { method, url, headers: h };
      if (body !== undefined) opts.payload = body as InjectOptions['payload'];
      const r = await app.inject(opts);
      let json: any;
      try {
        json = r.json();
      } catch {
        json = undefined;
      }
      const sc = r.headers['set-cookie'];
      const setCookie = Array.isArray(sc) ? sc : sc ? [sc] : [];
      for (const s of setCookie) {
        const [kvp] = s.split(';');
        if (kvp!.startsWith(`${cookieName}=`)) c.cookie = kvp!.endsWith('=') ? '' : kvp!;
      }
      if (json?.me?.csrfToken) c.csrf = json.me.csrfToken;
      return { status: r.statusCode, json, headers: r.headers as Record<string, unknown>, body: r.body };
    },
  };
  return c;
}

/** Create a local user directly (fast; no HTTP) and an active session for it. */
export async function userSession(t: TestApp, role: Role, name = `${role}-${randomBytes(3).toString('hex')}`, password = 'correct horse battery staple'): Promise<Client> {
  let u = t.ctx.users.byUsername(name);
  if (!u) u = t.ctx.users.create({ username: name, displayName: name, role, passwordHash: await hashPassword(password), mustChangePassword: false });
  const { id, session } = t.ctx.sessions.create({ userId: u.id, username: u.username, displayName: u.displayName, source: 'local', role, state: 'active', ip: '127.0.0.1', authGen: u.authGen });
  return clientFor(t.app, t.ctx.sessionCookie, id, session.csrfToken, u.id, u.username);
}

/** An OIDC-style session (no local user record). */
export function oidcSession(t: TestApp, role: Role, sub = randomBytes(4).toString('hex')): Client {
  const { id, session } = t.ctx.sessions.create({ userId: `oidc:${sub}`, username: `oidc-${sub}`, displayName: 'OIDC user', source: 'oidc', role, state: 'active', ip: '127.0.0.1' });
  return clientFor(t.app, t.ctx.sessionCookie, id, session.csrfToken, session.userId, session.username);
}

export function anonymous(t: TestApp): Client {
  return clientFor(t.app, t.ctx.sessionCookie, '', '');
}

/** A key as a request-body `Bin` (always base64, so binary keys round-trip exactly). */
export const bk = (key: string | Buffer) => ({ enc: 'base64' as const, data: Buffer.from(key).toString('base64') });
export const utf8 = (s: string) => ({ enc: 'utf8' as const, data: s });
export const b64 = (b: Buffer) => ({ enc: 'base64' as const, data: b.toString('base64') });

/** Direct admin connection to the 6411 sandbox for fixtures/cleanup (never used for external targets). */
export async function sandboxAdmin(port: 6410 | 6411 = 6411) {
  const c = createClient({ url: `redis://127.0.0.1:${port}`, username: 'rc-admin', password: process.env.SANDBOX_REDIS_ADMIN_PASSWORD!, RESP: 3 });
  c.on('error', () => {});
  await c.connect();
  return c;
}

export async function cleanupPrefix(prefix: string): Promise<void> {
  const c = await sandboxAdmin();
  try {
    for await (const keys of c.scanIterator({ MATCH: `${prefix}*`, COUNT: 1000 })) if (keys.length) await c.unlink(keys);
  } finally {
    await c.close();
  }
}

export function portOpen(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export const sandboxUp = await portOpen(6411);
export const mainUp = await portOpen(6410);
export const remoteUp = !!process.env.RC_TEST_REMOTE_HOST && !!process.env.RC_TEST_REMOTE_PORT && (await portOpen(Number(process.env.RC_TEST_REMOTE_PORT), process.env.RC_TEST_REMOTE_HOST));
export const keycloakUp = await portOpen(8089);

