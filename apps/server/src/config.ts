/**
 * Configuration loader. Fails closed: any validation error stops the server.
 *
 * - Loaded from the JSON file at RCONSOLE_CONFIG.
 * - RCONSOLE_PORT / RCONSOLE_PUBLIC_URL / RCONSOLE_DATA_DIR override server.port / publicUrl / dataDir.
 * - Secrets are never inline: `{ "env": "VAR" }` or `{ "file": "/path" }` only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { ENVIRONMENTS, ROLES, roleAtLeast, type Environment, type Role } from '@rconsole/shared';
import { IMPLICIT_KEY_ID, KEY_ID_RE, MIN_SECRET_LENGTH } from './security/totpCipher.ts';

// ---------------------------------------------------------------------------
// Secrets

const zSecretRef = z.union([
  z.object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid environment variable name') }).strict(),
  z.object({ file: z.string().min(1) }).strict(),
], { error: 'secrets must be { "env": "VAR" } or { "file": "/path" } — inline secret strings are not allowed' });
export type SecretRef = z.infer<typeof zSecretRef>;

/** A resolved secret. `toJSON`/`toString` never reveal the value, so accidental logging is harmless. */
export class Secret {
  readonly #value: string;
  readonly source: string;
  constructor(value: string, source: string) {
    this.#value = value;
    this.source = source;
  }
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return `<secret ${this.source}>`;
  }
  toString(): string {
    return `<secret ${this.source}>`;
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `<secret ${this.source}>`;
  }
}

export interface SecretResolver {
  env: NodeJS.ProcessEnv;
  readFile: (p: string) => string;
}

function resolveSecret(ref: SecretRef, r: SecretResolver, where: string): Secret {
  if ('env' in ref) {
    const v = r.env[ref.env];
    if (v === undefined || v === '') throw new ConfigError(`${where}: environment variable ${ref.env} is not set`);
    return new Secret(v, `env:${ref.env}`);
  }
  let v: string;
  try {
    v = r.readFile(ref.file);
  } catch (e) {
    throw new ConfigError(`${where}: cannot read secret file ${ref.file}: ${(e as Error).message}`);
  }
  v = v.replace(/\r?\n$/, '');
  if (v === '') throw new ConfigError(`${where}: secret file ${ref.file} is empty`);
  return new Secret(v, `file:${ref.file}`);
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

// ---------------------------------------------------------------------------
// Schema

const zRole = z.enum(ROLES);
const zEnv = z.enum(ENVIRONMENTS);
const zId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'ids must be lower-case [a-z0-9_-], max 64 chars');

const zRedisUrl = z
  .string()
  .refine((u) => {
    try {
      const x = new URL(u);
      return x.protocol === 'redis:' || x.protocol === 'rediss:';
    } catch {
      return false;
    }
  }, 'must be a redis:// or rediss:// URL')
  .refine((u) => {
    try {
      const x = new URL(u);
      return x.password === '' && x.username === '';
    } catch {
      return false;
    }
  }, 'URL must not contain credentials; use the credentials block with secret references')
  .refine((u) => {
    try {
      const x = new URL(u);
      return (x.pathname === '' || x.pathname === '/') && x.search === '' && x.hash === '';
    } catch {
      return false;
    }
  }, 'URL must not contain a path or query; use the "db" field for the logical database');

const zCredential = z
  .object({
    username: z.string().min(1).max(256),
    password: zSecretRef.optional(),
  })
  .strict();

const zTls = z
  .object({
    ca: zSecretRef.optional(),
    cert: zSecretRef.optional(),
    key: zSecretRef.optional(),
    servername: z.string().max(255).optional(),
    /** Disabling verification is refused for environment=prod. */
    rejectUnauthorized: z.boolean().default(true),
  })
  .strict()
  .refine((t) => (t.cert === undefined) === (t.key === undefined), 'tls.cert and tls.key must be set together');

const zHostPort = z.object({ host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535) }).strict();

const zDatabase = z
  .object({
    id: zId,
    name: z.string().trim().min(1).max(128),
    description: z.string().max(500).optional(),
    /** Display-only labels shown on the landing page (no policy meaning). */
    tags: z.array(z.string().trim().min(1).max(32).regex(/^[\p{L}\p{N} ._\/-]+$/u, 'tags may use letters, digits, space and . _ / -')).max(8).optional(),
    environment: zEnv,
    mode: z.enum(['standalone', 'cluster', 'sentinel']).default('standalone'),
    url: zRedisUrl.optional(),
    /** cluster: seed node URLs (redis:// or rediss://, no credentials). */
    nodes: z.array(zRedisUrl).min(1).max(32).optional(),
    /** sentinel: sentinel addresses + master name. */
    sentinels: z.array(zHostPort).min(1).max(16).optional(),
    masterName: z.string().min(1).max(256).optional(),
    sentinelCredentials: zCredential.optional(),
    /** TLS for sentinel/cluster nodes is implied by rediss:// or the presence of `tls`. */
    db: z.number().int().min(0).max(15).optional(),
    readOnly: z.boolean().default(false),
    maxRole: zRole.default('admin'),
    credentials: z
      .object({ viewer: zCredential.optional(), operator: zCredential.optional(), admin: zCredential.optional(), default: zCredential.optional() })
      .strict()
      .refine((c) => Object.values(c).some(Boolean), 'at least one credential tier (or "default") is required'),
    tls: zTls.optional(),
    /** Optional per-database pool size per tier. */
    poolSize: z.number().int().min(1).max(32).default(4),
    /**
     * In production, prod databases must use TLS and per-tier ACL users. Listing a risk here is an explicit,
     * reviewed exception (it is still logged as a warning at every start).
     */
    acceptRisks: z.array(z.enum(['plaintext', 'default-credentials'])).max(2).default([]),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.mode === 'standalone' && !d.url) ctx.addIssue({ code: 'custom', message: 'standalone databases need "url"', path: ['url'] });
    if (d.mode === 'cluster') {
      if (!d.nodes && !d.url) ctx.addIssue({ code: 'custom', message: 'cluster databases need "nodes" (or "url" as a seed)', path: ['nodes'] });
      if (d.db !== undefined && d.db !== 0) ctx.addIssue({ code: 'custom', message: 'cluster mode only supports db 0', path: ['db'] });
    }
    if (d.mode === 'sentinel') {
      if (!d.sentinels) ctx.addIssue({ code: 'custom', message: 'sentinel databases need "sentinels"', path: ['sentinels'] });
      if (!d.masterName) ctx.addIssue({ code: 'custom', message: 'sentinel databases need "masterName"', path: ['masterName'] });
    }
    if (d.mode !== 'sentinel' && (d.sentinels || d.masterName)) ctx.addIssue({ code: 'custom', message: '"sentinels"/"masterName" only apply to mode=sentinel', path: ['mode'] });
    if (d.mode !== 'cluster' && d.nodes) ctx.addIssue({ code: 'custom', message: '"nodes" only applies to mode=cluster', path: ['mode'] });
    if (d.tls && d.tls.rejectUnauthorized === false && d.environment === 'prod') {
      ctx.addIssue({ code: 'custom', message: 'TLS certificate verification cannot be disabled for environment=prod', path: ['tls', 'rejectUnauthorized'] });
    }
    const urls = [d.url, ...(d.nodes ?? [])].filter((u): u is string => !!u);
    const schemes = new Set(urls.map((u) => new URL(u).protocol));
    if (schemes.size > 1) ctx.addIssue({ code: 'custom', message: 'mixing redis:// and rediss:// URLs is not allowed', path: ['url'] });
    if (d.tls && schemes.has('redis:')) ctx.addIssue({ code: 'custom', message: 'a "tls" block requires rediss:// URLs', path: ['tls'] });
  });

const zOidc = z
  .object({
    enabled: z.boolean(),
    displayName: z.string().min(1).max(128).default('Single sign-on'),
    issuer: z.string().url(),
    clientId: z.string().min(1).max(256),
    clientSecret: zSecretRef.optional(),
    scopes: z.array(z.string().regex(/^[\x21-\x7e]+$/)).default(['openid', 'profile', 'email']),
    groupsClaim: z.string().min(1).max(128).default('groups'),
    roleMapping: z.record(z.string().min(1).max(256), zRole).refine((m) => Object.keys(m).length > 0, 'roleMapping must map at least one group'),
    allowInsecureHttpIssuer: z.boolean().default(false),
    /** After local logout, also end the IdP session (RP-initiated logout) when the IdP supports it. */
    rpInitiatedLogout: z.boolean().default(false),
    usernameClaim: z.string().min(1).max(128).default('preferred_username'),
    /**
     * Absolute lifetime of OIDC sessions, if shorter than server.sessionTtlMinutes. Group membership is read at
     * sign-in only (no back-channel logout), so this bounds how long a user removed from an IdP group keeps the role.
     */
    sessionTtlMinutes: z.number().int().min(5).max(7 * 24 * 60).optional(),
  })
  .strict()
  .refine((o) => o.scopes.includes('openid'), 'scopes must include "openid"')
  .refine((o) => o.allowInsecureHttpIssuer || o.issuer.startsWith('https://'), 'OIDC issuer must be https (allowInsecureHttpIssuer is for local development only)');

const zLocal = z
  .object({
    enabled: z.boolean(),
    requireTotpForRoles: z.array(zRole).default(['admin']),
    bootstrapAdmin: z.object({ username: z.string().regex(/^[a-zA-Z0-9._-]{3,64}$/), password: zSecretRef, displayName: z.string().max(128).optional() }).strict().optional(),
    lockout: z.object({ maxAttempts: z.number().int().min(1).max(100).default(5), windowMinutes: z.number().int().min(1).max(1440).default(15) }).strict().default({ maxAttempts: 5, windowMinutes: 15 }),
    minPasswordLength: z.number().int().min(12).max(256).default(12),
    /**
     * Single-key form: a server secret (at least 32 characters, e.g. `openssl rand -hex 32`) from which the TOTP seed
     * encryption key is derived (HKDF). Treated as a one-key ring whose key id is "default".
     */
    totpEncryptionKey: zSecretRef.optional(),
    /**
     * Key ring form (instead of totpEncryptionKey): every key may decrypt, the primary encrypts. Rotation: add a key,
     * make it primary, restart (startup re-wraps every seed to the primary), later remove the old key.
     */
    totpEncryptionKeys: z
      .array(z.object({ id: z.string().regex(KEY_ID_RE, 'key ids are 1-64 of A-Z a-z 0-9 . _ -'), secret: zSecretRef }).strict())
      .min(1)
      .max(16)
      .optional(),
    /** Id of the key in totpEncryptionKeys that encrypts new and re-wrapped seeds. Required with totpEncryptionKeys. */
    totpPrimaryKeyId: z.string().regex(KEY_ID_RE, 'key ids are 1-64 of A-Z a-z 0-9 . _ -').optional(),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (l.totpEncryptionKey && l.totpEncryptionKeys) {
      ctx.addIssue({ code: 'custom', message: 'use either totpEncryptionKey (one key) or totpEncryptionKeys (key ring), not both; in a ring, give the old single key the id "default"', path: ['totpEncryptionKeys'] });
    }
    if (l.totpPrimaryKeyId !== undefined && !l.totpEncryptionKeys) {
      ctx.addIssue({ code: 'custom', message: 'totpPrimaryKeyId needs totpEncryptionKeys', path: ['totpPrimaryKeyId'] });
    }
    if (!l.totpEncryptionKeys) return;
    const ids = new Set<string>();
    l.totpEncryptionKeys.forEach((k, i) => {
      if (ids.has(k.id)) ctx.addIssue({ code: 'custom', message: `duplicate key id "${k.id}"`, path: ['totpEncryptionKeys', i, 'id'] });
      ids.add(k.id);
    });
    if (l.totpPrimaryKeyId === undefined) ctx.addIssue({ code: 'custom', message: 'totpPrimaryKeyId is required with totpEncryptionKeys (the key that encrypts)', path: ['totpPrimaryKeyId'] });
    else if (!ids.has(l.totpPrimaryKeyId)) ctx.addIssue({ code: 'custom', message: `totpPrimaryKeyId "${l.totpPrimaryKeyId}" is not one of the totpEncryptionKeys ids (${[...ids].join(', ')})`, path: ['totpPrimaryKeyId'] });
  });

/**
 * Longest proxy chain a production hop count may describe. A count beyond the real chain trusts entries the client
 * wrote itself, which is what `trustProxy: true` does; CDN → load balancer → ingress is three.
 */
export const MAX_PROXY_HOPS = 5;

/** Production accepts proxy IPs, narrow CIDRs and proxy-addr's fixed private/loopback aliases only. */
function narrowProxyRanges(value: string): boolean {
  return value.split(',').every((entry) => {
    const item = entry.trim();
    if (['loopback', 'linklocal', 'uniquelocal'].includes(item)) return true;
    const [address = '', bits, extra] = item.split('/');
    const family = isIP(address);
    if (!family || extra !== undefined) return false;
    if (bits === undefined) return true;
    if (!/^\d+$/.test(bits)) return false;
    const prefix = Number(bits);
    if (prefix < (family === 4 ? 8 : 16) || prefix > (family === 4 ? 32 : 128)) return false;
    if (family === 6 && prefix < 104) {
      // A syntactically narrow IPv6 subnet can contain all (or a broad half) of IPv4's mapped addresses.
      const range = new BlockList();
      range.addSubnet(address, prefix, 'ipv6');
      const mapped = new BlockList();
      mapped.addSubnet('::ffff:0:0', 96, 'ipv6');
      if (range.check('0.0.0.0', 'ipv4') || mapped.check(address, 'ipv6')) return false;
    }
    return true;
  });
}

const zServer = z
  .object({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.number().int().min(0).max(65535).default(4000),
    publicUrl: z.string().url(),
    /**
     * Who may supply X-Forwarded-For (app.ts trustProxyOption): false | a hop count (the number of proxies in front,
     * e.g. 1; the client is that many entries from the right) | comma-separated proxy IPs/CIDRs/aliases. `true` (trust
     * every hop) is refused in production and warned about otherwise; production hop counts are at most MAX_PROXY_HOPS.
     */
    trustProxy: z.union([z.boolean(), z.number().int().min(0).max(64), z.string()]).default(false),
    /** Absolute receive deadlines; upload time is independent of the handler's Redis/workbench budget. */
    requestTimeoutMs: z.number().int().min(1000).max(3_600_000).default(120_000),
    headersTimeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
    /** Idle reads/writes, including bare TCP sockets. Longer than the SSE heartbeat (5 s). */
    connectionTimeoutMs: z.number().int().min(10_000).max(3_600_000).default(30_000),
    keepAliveTimeoutMs: z.number().int().min(1000).max(60_000).default(5000),
    dataDir: z.string().min(1).default('./data'),
    sessionTtlMinutes: z.number().int().min(5).max(7 * 24 * 60).default(480),
    sessionIdleMinutes: z.number().int().min(1).max(24 * 60).default(60),
    secureCookies: z.boolean().default(true),
    /** Extra origins accepted on state-changing requests (e.g. the Vite dev server). Must be https in production. */
    extraAllowedOrigins: z.array(z.string().url()).default([]),
    /** Directory with the built SPA. Default: apps/web/dist relative to the repo. */
    webDist: z.string().optional(),
  })
  .strict()
  .refine((s) => s.sessionIdleMinutes <= s.sessionTtlMinutes, 'sessionIdleMinutes must be <= sessionTtlMinutes')
  .refine((s) => s.headersTimeoutMs <= s.requestTimeoutMs, 'headersTimeoutMs must be <= requestTimeoutMs');

const zPolicy = z
  .object({
    maxReplyBytes: z.number().int().min(1024).max(64 * 1024 * 1024).default(1024 * 1024),
    /** Wire bytes, counted before decoding on command sockets (independent of display truncation). */
    maxReadReplyBytes: z.number().int().min(1024).max(64 * 1024 * 1024).default(16 * 1024 * 1024),
    maxInflightCommands: z.number().int().min(1).max(128).default(16),
    /** Server-wide open SSE streams per class (live pub/sub+profiler, metrics) and dedicated Redis stream sockets. */
    maxStreams: z.number().int().min(1).max(1024).default(64),
    /**
     * Request bodies being received or handled at once, reserved before the body is read (review r6 H1). Per user:
     * an eighth of the bodies, and half of the bytes (at least the 12 MiB body limit). Only bodies over 64 KiB
     * count towards the bytes.
     */
    maxBodiesInFlight: z.number().int().min(1).max(65_536).default(256),
    maxBodyBytesInFlight: z.number().int().min(12 * 1024 * 1024).max(4 * 1024 * 1024 * 1024).default(48 * 1024 * 1024),
    maxValueBytes: z.number().int().min(1024).max(64 * 1024 * 1024).default(512 * 1024),
    commandTimeoutMs: z.number().int().min(100).max(60_000).default(5000),
    scanBudgetMs: z.number().int().min(10).max(5000).default(300),
    /**
     * Most keyspace slots one key-names request may examine (`scanThreshold`, the browser's "Keys to scan"). Each
     * request also stops at `scanBudgetMs`; the browser continues with the cursor.
     */
    keyScanThresholdMax: z.number().int().min(1000).max(10_000_000).default(100_000),
    /**
     * `MEMORY USAGE key SAMPLES n` for the key list's sizes. 0 (default, as Redis Insight) is exact but walks every
     * element of a collection; a small number (Redis's own default is 5) estimates collections in constant time.
     */
    keyMetaMemorySamples: z.number().int().min(0).max(1000).default(5),
    profilerAllowedEnvironments: z.array(zEnv).default(['dev', 'test']),
    prodRequiresReason: z.boolean().default(true),
    analysisMaxMs: z.number().int().min(100).max(120_000).default(10_000),
    /** Total run time of one workbench script; remaining commands are skipped with a timeout error. */
    workbenchBudgetMs: z.number().int().min(1000).max(300_000).default(30_000),
    /**
     * v0.2.1: whether an admin may drop a search index together with its documents (FT.DROPINDEX … DD) from the
     * Search tool. Off by default: a drop keeps the keys. The console and workbench never accept DD.
     */
    searchDropDeletesDocuments: z.boolean().default(false),
  })
  .strict();

/** Oldest audit retention allowed (days); `0` keeps the audit table forever. */
export const MIN_AUDIT_RETENTION_DAYS = 30;

const zAudit = z
  .object({
    /**
     * Days the SQLite audit table keeps events (default 365). A daily job, also run at startup, deletes older rows in
     * batches and audits the count (`system.audit.prune`). 0 keeps everything. The stdout copy for the SIEM is
     * unaffected. The table's delete trigger refuses rows younger than MIN_AUDIT_RETENTION_DAYS whatever this says.
     */
    retentionDays: z
      .number()
      .int()
      .refine((d) => d === 0 || (d >= MIN_AUDIT_RETENTION_DAYS && d <= 36_500), `must be 0 (keep forever) or ${MIN_AUDIT_RETENTION_DAYS}–36500 days`)
      .default(365),
  })
  .strict();

export const zConfigFile = z
  .object({
    $comment: z.string().optional(),
    server: zServer,
    auth: z.object({ oidc: zOidc.optional(), local: zLocal.optional() }).strict(),
    policy: zPolicy.default(zPolicy.parse({})),
    audit: zAudit.default(zAudit.parse({})),
    databases: z.array(zDatabase).max(200),
  })
  .strict()
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.databases.forEach((d, i) => {
      if (ids.has(d.id)) ctx.addIssue({ code: 'custom', message: `duplicate database id "${d.id}"`, path: ['databases', i, 'id'] });
      ids.add(d.id);
    });
    if (!c.auth.oidc?.enabled && !c.auth.local?.enabled) ctx.addIssue({ code: 'custom', message: 'at least one of auth.oidc / auth.local must be enabled', path: ['auth'] });
    if (c.auth.local?.enabled && !c.auth.local.totpEncryptionKey && !c.auth.local.totpEncryptionKeys) {
      ctx.addIssue({ code: 'custom', message: 'auth.local.totpEncryptionKey (or the key ring auth.local.totpEncryptionKeys + totpPrimaryKeyId) is required when local accounts are enabled (TOTP seeds are encrypted at rest)', path: ['auth', 'local', 'totpEncryptionKey'] });
    }
    if (c.auth.oidc?.enabled && !c.auth.oidc.clientSecret) ctx.addIssue({ code: 'custom', message: 'auth.oidc.clientSecret is required (confidential client)', path: ['auth', 'oidc', 'clientSecret'] });
  });

export type ConfigFile = z.infer<typeof zConfigFile>;
type DbFile = ConfigFile['databases'][number];

// ---------------------------------------------------------------------------
// Resolved config (secrets resolved, overrides applied)

export interface ResolvedCredential { username: string; password?: Secret }
export type Tier = Role | 'default';

export interface DatabaseConfig {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  environment: Environment;
  mode: 'standalone' | 'cluster' | 'sentinel';
  url?: string;
  nodes?: string[];
  sentinels?: { host: string; port: number }[];
  masterName?: string;
  sentinelCredentials?: ResolvedCredential;
  db: number;
  readOnly: boolean;
  maxRole: Role;
  credentials: Partial<Record<Tier, ResolvedCredential>>;
  tls?: { enabled: true; ca?: Secret; cert?: Secret; key?: Secret; servername?: string; rejectUnauthorized: boolean };
  poolSize: number;
  /** Reviewed exceptions to the production rules; each is logged at every start (configWarnings). */
  acceptRisks?: ('plaintext' | 'default-credentials')[];
}

export interface AppConfig {
  production: boolean;
  server: Omit<ConfigFile['server'], 'webDist'> & { webDist: string; publicOrigin: string; allowedOrigins: string[] };
  oidc?: Omit<NonNullable<ConfigFile['auth']['oidc']>, 'clientSecret'> & { clientSecret: Secret };
  local?: Omit<NonNullable<ConfigFile['auth']['local']>, 'bootstrapAdmin' | 'totpEncryptionKey' | 'totpEncryptionKeys' | 'totpPrimaryKeyId'> & {
    bootstrapAdmin?: { username: string; password: Secret; displayName?: string };
    /** The TOTP seed key ring, normalized: the single-key form becomes `{ keys: [{ id: "default", … }], primaryId: "default" }`. */
    totpKeyring?: TotpKeyringConfig;
  };
  policy: ConfigFile['policy'];
  audit: ConfigFile['audit'];
  databases: DatabaseConfig[];
}

export interface TotpKeyringConfig {
  keys: { id: string; secret: Secret }[];
  primaryId: string;
}

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `  - ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`).join('\n');
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  readFile?: (p: string) => string;
  /** Base directory for relative paths (dataDir, webDist). Defaults to process.cwd(). */
  cwd?: string;
}

/** Validate + resolve a parsed JSON config object. Throws ConfigError with every problem listed. */
export function resolveConfig(raw: unknown, opts: LoadOptions = {}): AppConfig {
  const env = opts.env ?? process.env;
  const r: SecretResolver = { env, readFile: opts.readFile ?? ((p) => readFileSync(p, 'utf8')) };
  const cwd = opts.cwd ?? process.cwd();

  const parsed = zConfigFile.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`Invalid configuration:\n${formatZodError(parsed.error)}`);
  const c = parsed.data;
  const production = env.NODE_ENV === 'production';

  // Overrides
  const server = { ...c.server };
  if (env.RCONSOLE_PORT !== undefined && env.RCONSOLE_PORT !== '') {
    const p = Number(env.RCONSOLE_PORT);
    if (!Number.isInteger(p) || p < 0 || p > 65535) throw new ConfigError('RCONSOLE_PORT must be an integer port');
    server.port = p;
  }
  if (env.RCONSOLE_PUBLIC_URL) server.publicUrl = env.RCONSOLE_PUBLIC_URL;
  if (env.RCONSOLE_DATA_DIR) server.dataDir = env.RCONSOLE_DATA_DIR;

  const problems: string[] = [];
  let publicUrl: URL | undefined;
  try {
    publicUrl = new URL(server.publicUrl);
    if (publicUrl.protocol !== 'http:' && publicUrl.protocol !== 'https:') problems.push('server.publicUrl must be http(s)');
    if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) problems.push('server.publicUrl must be an origin without a path (the app is served at /)');
  } catch {
    problems.push('server.publicUrl is not a valid URL');
  }
  const extra: string[] = [];
  for (const o of server.extraAllowedOrigins) {
    const u = new URL(o);
    extra.push(u.origin);
    if (production && u.protocol !== 'https:') problems.push(`server.extraAllowedOrigins: ${o} must be https in production`);
  }

  if (production) {
    if (!server.secureCookies) problems.push('production: server.secureCookies must be true');
    if (publicUrl && publicUrl.protocol !== 'https:') problems.push('production: server.publicUrl must be https');
    if (c.auth.oidc?.allowInsecureHttpIssuer) problems.push('production: auth.oidc.allowInsecureHttpIssuer must be false');
    if (server.trustProxy === true || (typeof server.trustProxy === 'string' && !narrowProxyRanges(server.trustProxy))) {
      problems.push('production: server.trustProxy=true lets clients choose their own IP (X-Forwarded-For) and evade per-IP limits; set the proxy hop count (e.g. 1) or narrow proxy IPs/CIDRs (IPv4 /8 or longer, IPv6 /16 or longer)');
    }
    if (typeof server.trustProxy === 'number' && server.trustProxy > MAX_PROXY_HOPS) {
      problems.push(`production: server.trustProxy hop count ${server.trustProxy} is longer than any real proxy chain (at most ${MAX_PROXY_HOPS}); hops beyond the chain are X-Forwarded-For entries the client wrote, as with trustProxy=true. Set the number of proxies in front of the server, or their addresses`);
    }
    for (const d of c.databases) {
      if (d.tls && !d.tls.rejectUnauthorized) problems.push(`production: databases.${d.id}: TLS verification cannot be disabled in production`);
      if (d.environment !== 'prod') continue;
      const tlsOn = !!d.tls || [d.url, ...(d.nodes ?? [])].some((u) => !!u && u.startsWith('rediss:'));
      if (!tlsOn && !d.acceptRisks.includes('plaintext')) {
        problems.push(`production: databases.${d.id}: environment=prod requires TLS (rediss://), or "acceptRisks": ["plaintext"] as a reviewed exception`);
      }
      // Every tier reachable under maxRole needs its own ACL user (review v0.2 M4; Redis's `default` user since the
      // deployment trial). A tier with no credential at all fails closed at runtime (503).
      if (!d.acceptRisks.includes('default-credentials')) {
        for (const p of tierUserProblems(d)) problems.push(`production: databases.${d.id}: ${p}, or "acceptRisks": ["default-credentials"] as a reviewed exception`);
      }
    }
  }
  if (server.secureCookies && publicUrl && publicUrl.protocol !== 'https:' && publicUrl.hostname !== 'localhost') {
    problems.push('server.secureCookies=true requires an https publicUrl (browsers drop Secure cookies over http)');
  }
  if (problems.length) throw new ConfigError(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  // Secrets
  const errors: string[] = [];
  const sec = (ref: SecretRef, where: string): Secret | undefined => {
    try {
      return resolveSecret(ref, r, where);
    } catch (e) {
      errors.push(`  - ${(e as Error).message}`);
      return undefined;
    }
  };
  const cred = (cr: { username: string; password?: SecretRef } | undefined, where: string): ResolvedCredential | undefined => {
    if (!cr) return undefined;
    const out: ResolvedCredential = { username: cr.username };
    if (cr.password) {
      const s = sec(cr.password, where);
      if (s) out.password = s;
    }
    return out;
  };

  let oidc: AppConfig['oidc'];
  if (c.auth.oidc) {
    const { clientSecret, ...rest } = c.auth.oidc;
    if (rest.enabled) {
      const s = clientSecret ? sec(clientSecret, 'auth.oidc.clientSecret') : undefined;
      if (s) oidc = { ...rest, clientSecret: s };
    }
  }
  let local: AppConfig['local'];
  if (c.auth.local) {
    const { bootstrapAdmin, totpEncryptionKey, totpEncryptionKeys, totpPrimaryKeyId, ...rest } = c.auth.local;
    local = { ...rest };
    const refs = totpEncryptionKeys
      ? totpEncryptionKeys.map((k, i) => ({ id: k.id, ref: k.secret, where: `auth.local.totpEncryptionKeys[${i}] (id "${k.id}")` }))
      : totpEncryptionKey
        ? [{ id: IMPLICIT_KEY_ID, ref: totpEncryptionKey, where: 'auth.local.totpEncryptionKey' }]
        : [];
    const keys: TotpKeyringConfig['keys'] = [];
    const seen = new Map<string, string>();
    for (const k of refs) {
      const s = sec(k.ref, k.where);
      if (!s) continue;
      if (s.reveal().length < MIN_SECRET_LENGTH) {
        errors.push(`  - ${k.where} must be at least ${MIN_SECRET_LENGTH} characters (generate one with \`openssl rand -hex 32\`)`);
        continue;
      }
      const dup = seen.get(s.reveal());
      if (dup !== undefined) errors.push(`  - ${k.where} has the same secret as key "${dup}"; a new key needs a new secret`);
      seen.set(s.reveal(), k.id);
      keys.push({ id: k.id, secret: s });
    }
    if (refs.length && keys.length === refs.length) local.totpKeyring = { keys, primaryId: totpPrimaryKeyId ?? IMPLICIT_KEY_ID };
    if (bootstrapAdmin) {
      const s = sec(bootstrapAdmin.password, 'auth.local.bootstrapAdmin.password');
      if (s) {
        if (s.reveal().length < rest.minPasswordLength) errors.push(`  - auth.local.bootstrapAdmin.password must be at least ${rest.minPasswordLength} characters`);
        local.bootstrapAdmin = { username: bootstrapAdmin.username, password: s, ...(bootstrapAdmin.displayName ? { displayName: bootstrapAdmin.displayName } : {}) };
      }
    }
  }

  const databases = c.databases.map((d: DbFile): DatabaseConfig => {
    const where = `databases.${d.id}`;
    const credentials: DatabaseConfig['credentials'] = {};
    for (const t of ['viewer', 'operator', 'admin', 'default'] as const) {
      const v = cred(d.credentials[t], `${where}.credentials.${t}.password`);
      if (v) credentials[t] = v;
    }
    const urls = [d.url, ...(d.nodes ?? [])].filter((u): u is string => !!u);
    const tlsOn = !!d.tls || urls.some((u) => u.startsWith('rediss:'));
    const out: DatabaseConfig = {
      id: d.id,
      name: d.name,
      environment: d.environment,
      mode: d.mode,
      db: d.db ?? 0,
      readOnly: d.readOnly,
      maxRole: d.maxRole,
      credentials,
      poolSize: d.poolSize,
      acceptRisks: d.acceptRisks,
    };
    if (d.description) out.description = d.description;
    if (d.tags?.length) out.tags = [...new Set(d.tags)];
    if (d.url) out.url = d.url;
    if (d.nodes) out.nodes = d.nodes;
    if (d.sentinels) out.sentinels = d.sentinels;
    if (d.masterName) out.masterName = d.masterName;
    const sc = cred(d.sentinelCredentials, `${where}.sentinelCredentials.password`);
    if (sc) out.sentinelCredentials = sc;
    if (tlsOn) {
      const t: NonNullable<DatabaseConfig['tls']> = { enabled: true, rejectUnauthorized: d.tls?.rejectUnauthorized ?? true };
      if (d.tls?.ca) { const s = sec(d.tls.ca, `${where}.tls.ca`); if (s) t.ca = s; }
      if (d.tls?.cert) { const s = sec(d.tls.cert, `${where}.tls.cert`); if (s) t.cert = s; }
      if (d.tls?.key) { const s = sec(d.tls.key, `${where}.tls.key`); if (s) t.key = s; }
      if (d.tls?.servername) t.servername = d.tls.servername;
      out.tls = t;
    }
    return out;
  });
  if (errors.length) throw new ConfigError(`Invalid configuration (secrets):\n${errors.join('\n')}`);

  const { webDist, ...serverRest } = server;
  const publicOrigin = publicUrl!.origin;
  return {
    production,
    server: {
      ...serverRest,
      dataDir: path.resolve(cwd, server.dataDir),
      webDist: path.resolve(cwd, webDist ?? defaultWebDist()),
      publicOrigin,
      allowedOrigins: [publicOrigin, ...extra],
    },
    ...(oidc ? { oidc } : {}),
    ...(local ? { local } : {}),
    policy: c.policy,
    audit: c.audit,
    databases,
  };
}

function defaultWebDist(): string {
  // apps/server/src -> apps/web/dist
  return path.resolve(import.meta.dirname, '../../web/dist');
}

export function loadConfig(opts: LoadOptions = {}): AppConfig {
  const env = opts.env ?? process.env;
  const file = env.RCONSOLE_CONFIG;
  if (!file) throw new ConfigError('RCONSOLE_CONFIG is not set (path to the JSON config file)');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`Cannot read config file ${file}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`Config file ${file} is not valid JSON: ${(e as Error).message}`);
  }
  return resolveConfig(raw, opts);
}

type TierCredentials = Partial<Record<Tier, { username: string }>>;

/**
 * Why Redis cannot enforce a prod database's roles by itself: reachable tiers (under `maxRole`) that fall back to the
 * `default` credential entry, connect as Redis's built-in `default` user, or share one ACL user with another tier.
 * Empty when every reachable tier has its own user.
 */
export function tierUserProblems(d: { maxRole: Role; credentials: TierCredentials }): string[] {
  const out: string[] = [];
  const perTier = !!(d.credentials.viewer || d.credentials.operator || d.credentials.admin);
  const reachable = (['viewer', 'operator', 'admin'] as const).filter((t) => roleAtLeast(d.maxRole, t));
  const missing = reachable.filter((t) => !d.credentials[t]);
  if (!perTier || (d.credentials.default && missing.length)) {
    out.push(`environment=prod requires per-tier ACL users for every tier reachable under maxRole (missing: ${missing.join(', ')}${d.credentials.default ? '; they would connect as "default"' : ''})`);
  }
  const asDefault = reachable.filter((t) => d.credentials[t]?.username === 'default');
  if (asDefault.length) {
    const one = asDefault.length === 1;
    out.push(`${asDefault.join(' and ')} ${one ? 'connects' : 'connect'} as Redis's "default" user, so Redis cannot enforce ${one ? 'that role' : 'those roles'}; give each tier its own ACL user`);
  }
  const byUser = new Map<string, string[]>();
  for (const t of reachable) {
    const u = d.credentials[t]?.username;
    if (u !== undefined && u !== 'default') byUser.set(u, [...(byUser.get(u) ?? []), t]);
  }
  for (const tiers of byUser.values()) {
    if (tiers.length > 1) out.push(`${tiers.join(' and ')} use the same ACL user, so Redis cannot tell these roles apart; give each tier its own user`);
  }
  return out;
}

/**
 * Risky but valid settings, logged at startup. (Hard errors are raised by resolveConfig.)
 */
export function configWarnings(c: AppConfig): string[] {
  const w: string[] = [];
  if (c.server.trustProxy === true) {
    w.push('server.trustProxy=true trusts every X-Forwarded-For hop, so clients can choose their own IP and evade the per-IP sign-in limit; set the number of proxy hops (e.g. 1) or the proxy CIDRs instead');
  }
  for (const d of c.databases) {
    if (!hasPerTierCredentials(d)) {
      w.push(`database ${d.id}: only "default" credentials configured, or tiers that connect as Redis's "default" user; the app enforces policy alone (configure per-tier ACL users)`);
    }
    if (d.environment !== 'prod') continue;
    // Each accepted risk is named at every start, and an exception that is no longer needed is called out.
    const accepted = d.acceptRisks ?? [];
    const plaintext = accepted.includes('plaintext');
    if (!d.tls) w.push(`database ${d.id}: production database without TLS${plaintext ? ' (accepted risk "plaintext")' : ''}`);
    else if (plaintext) w.push(`database ${d.id}: acceptRisks lists "plaintext", but the database uses TLS; remove it`);
    if (accepted.includes('default-credentials')) {
      const issues = tierUserProblems(d);
      for (const p of issues) w.push(`database ${d.id}: ${p} (accepted risk "default-credentials")`);
      if (!issues.length) w.push(`database ${d.id}: acceptRisks lists "default-credentials", but every reachable tier has its own ACL user; remove it`);
    }
  }
  if (c.production && c.local?.enabled && !c.local.requireTotpForRoles.includes('admin')) {
    w.push('auth.local.requireTotpForRoles does not include "admin": local admins can sign in with a password only');
  }
  return w;
}

/** Credentials for a tier. `default` applies to every tier; a missing tier never falls back to a lower one. */
export function credentialForTier(db: DatabaseConfig, role: Role): ResolvedCredential | undefined {
  return db.credentials[role] ?? db.credentials.default;
}

/** Whether some tier has its own ACL user (not the shared `default` entry, and not Redis's `default` user). */
export function hasPerTierCredentials(db: DatabaseConfig): boolean {
  return (['viewer', 'operator', 'admin'] as const).some((t) => db.credentials[t] && db.credentials[t].username !== 'default');
}
