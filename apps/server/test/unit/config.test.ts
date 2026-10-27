import { inspect } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, Secret, configWarnings, credentialForTier, hasPerTierCredentials, loadConfig, resolveConfig } from '../../src/config.ts';

const ENV = { NODE_ENV: 'test', PW_V: 'viewer-secret-value', PW_O: 'operator-secret-value', PW_A: 'admin-secret-value', OIDC_S: 'oidc-secret', BOOT: 'bootstrap-password-123', TOTP_K: 'totp-encryption-key-0123456789abcdef' };

type Raw = Record<string, any>;

function base(): Raw {
  return {
    server: { publicUrl: 'http://localhost:4100', secureCookies: false },
    auth: { local: { enabled: true, totpEncryptionKey: { env: 'TOTP_K' } } },
    databases: [
      {
        id: 'main',
        name: 'Main',
        environment: 'dev',
        url: 'redis://127.0.0.1:6379',
        credentials: { viewer: { username: 'v', password: { env: 'PW_V' } }, operator: { username: 'o', password: { env: 'PW_O' } }, admin: { username: 'a', password: { env: 'PW_A' } } },
      },
    ],
  };
}

const resolve = (raw: Raw, env: Record<string, string> = ENV, readFile?: (p: string) => string) =>
  resolveConfig(raw, { env, cwd: '/srv/app', ...(readFile ? { readFile } : {}) });

const fails = (raw: Raw, re: RegExp, env: Record<string, string> = ENV, readFile?: (p: string) => string) => {
  let msg = '';
  try {
    resolve(raw, env, readFile);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    msg = (e as Error).message;
  }
  expect(msg, 'expected resolveConfig to fail').not.toBe('');
  expect(msg).toMatch(re);
  return msg;
};

describe('resolveConfig', () => {
  it('accepts a valid minimal config and applies defaults', () => {
    const c = resolve(base());
    expect(c.production).toBe(false);
    expect(c.server.port).toBe(4000);
    expect(c.server.publicOrigin).toBe('http://localhost:4100');
    expect(c.server.allowedOrigins).toEqual(['http://localhost:4100']);
    expect(c.server.dataDir).toBe(path.resolve('/srv/app', './data'));
    expect(c.policy.maxReplyBytes).toBe(1024 * 1024);
    expect(c.databases[0]).toMatchObject({ id: 'main', mode: 'standalone', db: 0, readOnly: false, maxRole: 'admin', poolSize: 4 });
    expect(c.databases[0]!.credentials.viewer!.password!.reveal()).toBe('viewer-secret-value');
    expect(c.databases[0]!.tls).toBeUndefined();
    expect(c.local?.requireTotpForRoles).toEqual(['admin']);
  });

  it('sets finite HTTP deadlines and rejects disabled or inconsistent timeouts (review r5 H1/L2)', () => {
    expect(resolve(base()).server).toMatchObject({ requestTimeoutMs: 120000, headersTimeoutMs: 15000, connectionTimeoutMs: 30000, keepAliveTimeoutMs: 5000 });
    for (const key of ['requestTimeoutMs', 'headersTimeoutMs', 'connectionTimeoutMs', 'keepAliveTimeoutMs']) {
      const raw = base(); raw.server[key] = 0;
      fails(raw, /server/);
    }
    const raw = base(); raw.server.requestTimeoutMs = 1000;
    fails(raw, /headersTimeoutMs must be <= requestTimeoutMs/);
  });

  it('bounds request bodies in flight; a byte budget below one 12 MiB body is refused (review r6 H1)', () => {
    expect(resolve(base()).policy).toMatchObject({ maxBodiesInFlight: 256, maxBodyBytesInFlight: 48 * 1024 * 1024 });
    for (const [key, value] of [['maxBodiesInFlight', 0], ['maxBodyBytesInFlight', 12 * 1024 * 1024 - 1]] as const) {
      const raw = base(); raw.policy = { [key]: value };
      fails(raw, new RegExp(`policy\\.${key}`));
    }
    const raw = base(); raw.policy = { maxBodiesInFlight: 64, maxBodyBytesInFlight: 12 * 1024 * 1024 };
    expect(resolve(raw).policy).toMatchObject({ maxBodiesInFlight: 64, maxBodyBytesInFlight: 12 * 1024 * 1024 });
  });

  it('rejects inline secret strings', () => {
    const raw = base();
    raw.databases[0].credentials.viewer.password = 'hunter2';
    fails(raw, /inline secret strings are not allowed/);
    const raw2 = base();
    raw2.auth.oidc = { enabled: true, issuer: 'https://idp.example', clientId: 'c', clientSecret: 'plain', roleMapping: { g: 'viewer' } };
    fails(raw2, /inline secret/);
  });

  it('resolves env and file secret references', () => {
    const raw = base();
    raw.databases[0].credentials.admin.password = { file: '/run/secrets/admin' };
    const c = resolve(raw, ENV, (p) => (p === '/run/secrets/admin' ? 'from-file\n' : ''));
    expect(c.databases[0]!.credentials.admin!.password!.reveal()).toBe('from-file');
    expect(c.databases[0]!.credentials.admin!.password!.source).toBe('file:/run/secrets/admin');
  });

  it('fails on missing env vars, empty or unreadable files', () => {
    fails(base(), /PW_V is not set/, { ...ENV, PW_V: '' });
    const raw = base();
    raw.databases[0].credentials.admin.password = { file: '/x' };
    fails(raw, /secret file \/x is empty/, ENV, () => '\n');
    fails(raw, /cannot read secret file \/x: nope/, ENV, () => {
      throw new Error('nope');
    });
  });

  it('rejects invalid env var names in refs', () => {
    const raw = base();
    raw.databases[0].credentials.viewer.password = { env: 'bad-name' };
    fails(raw, /secret|environment variable/);
  });

  it('rejects URLs with credentials, paths or wrong schemes', () => {
    for (const url of ['redis://user:pass@h:6379', 'redis://:pass@h:6379', 'redis://user@h:6379']) {
      const raw = base();
      raw.databases[0].url = url;
      fails(raw, /must not contain credentials/);
    }
    const raw = base();
    raw.databases[0].url = 'redis://h:6379/2';
    fails(raw, /path or query/);
    raw.databases[0].url = 'http://h:6379';
    fails(raw, /redis:\/\/ or rediss:\/\//);
  });

  it('checks mode requirements', () => {
    const cluster = base();
    cluster.databases[0] = { ...cluster.databases[0], mode: 'cluster', url: undefined };
    fails(cluster, /cluster databases need "nodes"/);
    cluster.databases[0].nodes = ['redis://n1:7000', 'redis://n2:7000'];
    expect(resolve(cluster).databases[0]!.nodes).toHaveLength(2);
    cluster.databases[0].db = 2;
    fails(cluster, /cluster mode only supports db 0/);

    const sentinel = base();
    sentinel.databases[0] = { ...sentinel.databases[0], mode: 'sentinel', url: undefined };
    fails(sentinel, /need "sentinels"/);
    sentinel.databases[0].sentinels = [{ host: 's1', port: 26379 }];
    fails(sentinel, /need "masterName"/);
    sentinel.databases[0].masterName = 'mymaster';
    expect(resolve(sentinel).databases[0]).toMatchObject({ mode: 'sentinel', masterName: 'mymaster' });

    const standalone = base();
    standalone.databases[0].url = undefined;
    fails(standalone, /standalone databases need "url"/);
    const wrong = base();
    wrong.databases[0].nodes = ['redis://n1:7000'];
    fails(wrong, /"nodes" only applies to mode=cluster/);
  });

  it('TLS: block requires rediss://, rediss:// enables TLS, no mixing schemes', () => {
    const raw = base();
    raw.databases[0].tls = { ca: { env: 'PW_V' } };
    fails(raw, /requires rediss:\/\//);
    raw.databases[0].url = 'rediss://h:6380';
    const c = resolve(raw);
    expect(c.databases[0]!.tls).toMatchObject({ enabled: true, rejectUnauthorized: true });
    expect(c.databases[0]!.tls!.ca!.reveal()).toBe('viewer-secret-value');

    const implied = base();
    implied.databases[0].url = 'rediss://h:6380';
    expect(resolve(implied).databases[0]!.tls).toMatchObject({ enabled: true, rejectUnauthorized: true });

    const cert = base();
    cert.databases[0].url = 'rediss://h:6380';
    cert.databases[0].tls = { cert: { env: 'PW_V' } };
    fails(cert, /cert and tls.key must be set together/);

    const mixed = base();
    mixed.databases[0] = { ...mixed.databases[0], mode: 'cluster', url: undefined, nodes: ['redis://a:1', 'rediss://b:2'] };
    fails(mixed, /mixing redis:\/\/ and rediss:\/\//);
  });

  it('refuses disabling TLS verification for prod databases', () => {
    const raw = base();
    raw.databases[0].url = 'rediss://h:6380';
    raw.databases[0].tls = { rejectUnauthorized: false };
    expect(resolve(raw).databases[0]!.tls!.rejectUnauthorized).toBe(false);
    raw.databases[0].environment = 'prod';
    fails(raw, /cannot be disabled for environment=prod/);
  });

  describe('NODE_ENV=production', () => {
    const prodEnv = { ...ENV, NODE_ENV: 'production' };
    const prodOk = () => {
      const raw = base();
      raw.server = { publicUrl: 'https://console.example.com', secureCookies: true };
      return raw;
    };
    it('accepts a hardened config', () => {
      expect(resolve(prodOk(), prodEnv).production).toBe(true);
    });
    it('requires secureCookies', () => {
      const raw = prodOk();
      raw.server.secureCookies = false;
      fails(raw, /secureCookies must be true/, prodEnv);
    });
    it('requires an https publicUrl', () => {
      const raw = prodOk();
      raw.server.publicUrl = 'http://console.example.com';
      fails(raw, /publicUrl must be https/, prodEnv);
    });
    it('refuses allowInsecureHttpIssuer', () => {
      const raw = prodOk();
      raw.auth.oidc = { enabled: true, issuer: 'http://idp:8080/realms/x', clientId: 'c', clientSecret: { env: 'OIDC_S' }, roleMapping: { g: 'viewer' }, allowInsecureHttpIssuer: true };
      fails(raw, /allowInsecureHttpIssuer must be false/, prodEnv);
    });
    it('refuses http extra origins', () => {
      const raw = prodOk();
      raw.server.extraAllowedOrigins = ['http://localhost:5173'];
      fails(raw, /must be https in production/, prodEnv);
    });
    it('refuses trustProxy=true in production; accepts the hop count and CIDR forms', () => {
      const raw = prodOk();
      raw.server.trustProxy = true;
      fails(raw, /trustProxy=true/, prodEnv);
      for (const cidr of ['0.0.0.0/0', '::/0', '10.0.0.0/8, ::/0', '0:0:0:0:0:0:0:0/0', '192.168.0.0/0']) { raw.server.trustProxy = cidr; fails(raw, /trustProxy=true/, prodEnv); }
      raw.server.trustProxy = 1;
      expect(resolve(raw, prodEnv).server.trustProxy).toBe(1);
      raw.server.trustProxy = '10.0.0.0/8, 127.0.0.1';
      expect(resolve(raw, prodEnv).server.trustProxy).toBe('10.0.0.0/8, 127.0.0.1');
    });
    it('refuses hop counts longer than any real proxy chain in production (v0.3 follow-up 1)', () => {
      const raw = prodOk();
      for (const hops of [6, 50, 64]) { raw.server.trustProxy = hops; fails(raw, /hop count \d+ is longer than any real proxy chain/, prodEnv); }
      for (const hops of [0, 1, 2, 5]) { raw.server.trustProxy = hops; expect(resolve(raw, prodEnv).server.trustProxy).toBe(hops); }
      raw.server.trustProxy = 50;
      expect(resolve(raw, ENV).server.trustProxy).toBe(50);
      for (const bad of [65, -1, 1.5]) { raw.server.trustProxy = bad; fails(raw, /trustProxy/, ENV); }
    });
    it('refuses broad proxy ranges, including a split catch-all in either address family (review r5 L1)', () => {
      const raw = prodOk();
      for (const value of [
        '0.0.0.0/1,128.0.0.0/1', '::/1,8000::/1',
        '0.0.0.0/1,128.0.0.0/1,::/1,8000::/1', '0.0.0.0/2,64.0.0.0/2,128.0.0.0/1',
        '10.0.0.0/7', '2001::/15', '::ffff:0:0/96', '::ffff:4000:0/98',
      ]) {
        raw.server.trustProxy = value;
        fails(raw, /trustProxy/, prodEnv);
      }
      for (const value of [false, 0, 1, '10.0.0.0/8,127.0.0.1', '2001:db8::/32,::1/128', 'loopback,linklocal,uniquelocal']) {
        raw.server.trustProxy = value;
        expect(resolve(raw, prodEnv).server.trustProxy).toEqual(value);
      }
    });
    it('only warns about trustProxy=true outside production', () => {
      const raw = prodOk();
      raw.server.trustProxy = true;
      expect(configWarnings(resolve(raw, ENV)).join('\n')).toMatch(/trustProxy=true/);
    });
    it('warns about default-only credentials, prod without TLS and admins without TOTP', () => {
      const raw = prodOk();
      raw.auth.local.requireTotpForRoles = [];
      raw.databases[0].environment = 'prod';
      raw.databases[0].credentials = { default: { username: 'd', password: { env: 'PW_V' } } };
      raw.databases[0].acceptRisks = ['plaintext', 'default-credentials'];
      const w = configWarnings(resolve(raw, prodEnv)).join('\n');
      expect(w).toMatch(/only "default" credentials/);
      expect(w).toMatch(/production database without TLS/);
      expect(w).toMatch(/requireTotpForRoles/);
      raw.server.trustProxy = 1;
      expect(configWarnings(resolve(raw, prodEnv)).join('\n')).not.toMatch(/trustProxy/);
      expect(configWarnings(resolve(prodOk(), prodEnv))).toEqual([]);
    });
    it('refuses prod databases without TLS or per-tier ACL users unless the risk is explicitly accepted', () => {
      const raw = prodOk();
      raw.databases[0].environment = 'prod';
      fails(raw, /requires TLS \(rediss:\/\/\)/, prodEnv);
      raw.databases[0].url = 'rediss://h:6380';
      expect(resolve(raw, prodEnv).databases[0]!.tls!.enabled).toBe(true);
      raw.databases[0].credentials = { default: { username: 'd', password: { env: 'PW_V' } } };
      fails(raw, /requires per-tier ACL users/, prodEnv);
      raw.databases[0].acceptRisks = ['default-credentials'];
      expect(resolve(raw, prodEnv).databases[0]!.id).toBe('main');
      raw.databases[0].url = 'redis://h:6379';
      fails(raw, /requires TLS/, prodEnv);
      raw.databases[0].acceptRisks = ['default-credentials', 'plaintext'];
      expect(resolve(raw, prodEnv).databases[0]!.id).toBe('main');
      // Non-prod databases and non-production mode are unaffected.
      const dev = prodOk();
      dev.databases[0].credentials = { default: { username: 'd', password: { env: 'PW_V' } } };
      expect(resolve(dev, prodEnv).databases[0]!.id).toBe('main');
      const local = base();
      local.databases[0].environment = 'prod';
      expect(resolve(local).databases[0]!.id).toBe('main');
      raw.databases[0].acceptRisks = ['nonsense'];
      fails(raw, /acceptRisks/, prodEnv);
    });
    it('prod databases need their own ACL user for every tier reachable under maxRole (review v0.2 M4)', () => {
      const prodDb = () => {
        const raw = prodOk();
        raw.databases[0].environment = 'prod';
        raw.databases[0].url = 'rediss://h:6380';
        return raw;
      };
      const v = { username: 'v', password: { env: 'PW_V' } }, o = { username: 'o', password: { env: 'PW_O' } }, a = { username: 'a', password: { env: 'PW_A' } };
      // The review reproduction: a viewer credential next to `default` hid the default fallback for operator/admin.
      const raw = prodDb();
      raw.databases[0].credentials = { viewer: v, default: a };
      fails(raw, /operator, admin.*"default-credentials"/s, prodEnv);
      raw.databases[0].maxRole = 'operator';
      fails(raw, /missing: operator\b/, prodEnv);
      raw.databases[0].maxRole = 'viewer'; // only the viewer tier is reachable
      expect(resolve(raw, prodEnv).databases[0]!.maxRole).toBe('viewer');
      raw.databases[0].maxRole = 'admin';
      raw.databases[0].acceptRisks = ['default-credentials'];
      expect(resolve(raw, prodEnv).databases[0]!.id).toBe('main');
      // Missing tiers without `default` fail closed at runtime (503), so they need no exception.
      const op = prodDb();
      op.databases[0].maxRole = 'operator';
      op.databases[0].credentials = { viewer: v, operator: o };
      expect(resolve(op, prodEnv).databases[0]!.id).toBe('main');
      // One ACL user for two reachable tiers is the same loss of Redis-side separation.
      const shared = prodDb();
      shared.databases[0].credentials = { viewer: v, operator: a, admin: a };
      fails(shared, /operator and admin use the same ACL user/, prodEnv);
      shared.databases[0].maxRole = 'operator';
      expect(resolve(shared, prodEnv).databases[0]!.id).toBe('main');
      // Non-prod databases are unaffected.
      const dev = prodOk();
      dev.databases[0].credentials = { viewer: v, default: a };
      expect(resolve(dev, prodEnv).databases[0]!.id).toBe('main');
    });
    it('a tier that connects as Redis\'s "default" user is not its own ACL user (deployment trial)', () => {
      // Found by configuring an app's bundled Redis (default user only) as `viewer: { username: "default" }`: the
      // per-tier check passed without the exception, and nothing was logged.
      const raw = prodOk();
      raw.databases[0].environment = 'prod';
      raw.databases[0].url = 'rediss://h:6380';
      raw.databases[0].maxRole = 'viewer';
      raw.databases[0].readOnly = true;
      raw.databases[0].credentials = { viewer: { username: 'default', password: { env: 'PW_V' } } };
      fails(raw, /viewer connects as Redis's "default" user.*"acceptRisks": \["default-credentials"\]/s, prodEnv);
      raw.databases[0].maxRole = 'operator';
      raw.databases[0].readOnly = false;
      raw.databases[0].credentials = { viewer: { username: 'v', password: { env: 'PW_V' } }, operator: { username: 'default', password: { env: 'PW_O' } } };
      fails(raw, /operator connects as Redis's "default" user/, prodEnv);
      raw.databases[0].acceptRisks = ['default-credentials'];
      const db = resolve(raw, prodEnv).databases[0]!;
      expect(db.id).toBe('main');
      // Outside prod it is allowed, and the startup warning says the app enforces the policy alone.
      const dev = prodOk();
      dev.databases[0].credentials = { viewer: { username: 'default' } };
      const devDb = resolve(dev, prodEnv).databases[0]!;
      expect(hasPerTierCredentials(devDb)).toBe(false);
      expect(configWarnings(resolve(dev, prodEnv)).join('\n')).toMatch(/database main: .*"default" user.*enforces policy alone/);
    });
    it('logs every accepted risk at startup, and names an exception that is not needed (deployment trial)', () => {
      const raw = prodOk();
      raw.databases[0].environment = 'prod';
      raw.databases[0].maxRole = 'viewer';
      raw.databases[0].readOnly = true;
      raw.databases[0].credentials = { viewer: { username: 'default' } };
      raw.databases[0].acceptRisks = ['plaintext', 'default-credentials'];
      let w = configWarnings(resolve(raw, prodEnv)).join('\n');
      expect(w).toMatch(/database main: production database without TLS \(accepted risk "plaintext"\)/);
      expect(w).toMatch(/database main: viewer connects as Redis's "default" user.*\(accepted risk "default-credentials"\)/);
      // Listed but not needed: TLS is on and every reachable tier has its own user.
      raw.databases[0].url = 'rediss://h:6380';
      raw.databases[0].credentials = { viewer: { username: 'v', password: { env: 'PW_V' } } };
      w = configWarnings(resolve(raw, prodEnv)).join('\n');
      expect(w).toMatch(/database main: acceptRisks lists "plaintext", but the database uses TLS; remove it/);
      expect(w).toMatch(/database main: acceptRisks lists "default-credentials", but every reachable tier has its own ACL user; remove it/);
      // An exception on a database that is not prod has no effect (review L5).
      const dev = prodOk();
      dev.databases[0].acceptRisks = ['plaintext'];
      expect(configWarnings(resolve(dev, prodEnv)).join('\n')).toMatch(/database main: acceptRisks has no effect outside environment=prod; remove it/);
    });
    it('says why a tier that connects as Redis\'s "default" user loses its limits (review M1)', () => {
      const raw = prodOk();
      raw.databases[0].environment = 'prod';
      raw.databases[0].url = 'rediss://h:6380';
      raw.databases[0].credentials = { viewer: { username: 'v', password: { env: 'PW_V' } }, operator: { username: 'o', password: { env: 'PW_O' } }, admin: { username: 'default', password: { env: 'PW_A' } } };
      fails(raw, /admin connects as Redis's "default" user, which usually has every permission/, prodEnv);
    });
    it('refuses disabled TLS verification on any database', () => {
      const raw = prodOk();
      raw.databases[0].url = 'rediss://h:6380';
      raw.databases[0].tls = { rejectUnauthorized: false };
      fails(raw, /TLS verification cannot be disabled in production/, prodEnv);
    });
  });

  it('OIDC: https issuer unless allowInsecureHttpIssuer, openid scope, client secret required', () => {
    const raw = base();
    raw.auth.oidc = { enabled: true, issuer: 'http://idp/realms/x', clientId: 'c', clientSecret: { env: 'OIDC_S' }, roleMapping: { g: 'viewer' } };
    fails(raw, /issuer must be https/);
    raw.auth.oidc.allowInsecureHttpIssuer = true;
    expect(resolve(raw).oidc!.clientSecret.reveal()).toBe('oidc-secret');
    raw.auth.oidc.scopes = ['profile'];
    fails(raw, /must include "openid"/);
    delete raw.auth.oidc.scopes;
    delete raw.auth.oidc.clientSecret;
    fails(raw, /clientSecret is required/);
  });

  it('applies RCONSOLE_PORT / RCONSOLE_PUBLIC_URL / RCONSOLE_DATA_DIR overrides', () => {
    const c = resolve(base(), { ...ENV, RCONSOLE_PORT: '4555', RCONSOLE_PUBLIC_URL: 'http://localhost:4555', RCONSOLE_DATA_DIR: '/var/lib/rc' });
    expect(c.server.port).toBe(4555);
    expect(c.server.publicOrigin).toBe('http://localhost:4555');
    expect(c.server.dataDir).toBe('/var/lib/rc');
    fails(base(), /RCONSOLE_PORT must be an integer/, { ...ENV, RCONSOLE_PORT: 'abc' });
    fails(base(), /publicUrl/, { ...ENV, RCONSOLE_PUBLIC_URL: 'http://localhost:4555/app' });
  });

  it('rejects duplicate database ids, missing auth, unknown fields', () => {
    const dup = base();
    dup.databases.push({ ...dup.databases[0] });
    fails(dup, /duplicate database id "main"/);

    const noAuth = base();
    noAuth.auth = { local: { enabled: false } };
    fails(noAuth, /at least one of auth.oidc \/ auth.local/);

    const extra = base();
    extra.server.bogus = 1;
    fails(extra, /bogus|Unrecognized|unrecognized/);
    const extraDb = base();
    extraDb.databases[0].password = 'x';
    fails(extraDb, /password|nrecognized/);
    const extraTop = base();
    extraTop.secrets = {};
    fails(extraTop, /secrets|nrecognized/);
  });

  it('requires at least one credential tier', () => {
    const raw = base();
    raw.databases[0].credentials = {};
    fails(raw, /at least one credential tier/);
  });

  it('secureCookies over plain http is refused except for localhost', () => {
    const raw = base();
    raw.server = { publicUrl: 'http://console.internal', secureCookies: true };
    fails(raw, /requires an https publicUrl/);
    raw.server.publicUrl = 'http://localhost:4000';
    expect(resolve(raw).server.secureCookies).toBe(true);
  });

  it('bootstrap admin password must meet the minimum length', () => {
    const raw = base();
    raw.auth.local.bootstrapAdmin = { username: 'admin', password: { env: 'SHORT' } };
    fails(raw, /at least 12 characters/, { ...ENV, SHORT: 'short' });
    raw.auth.local.bootstrapAdmin.password = { env: 'BOOT' };
    expect(resolve(raw).local!.bootstrapAdmin!.password.reveal()).toBe('bootstrap-password-123');
  });

  it('reports every secret problem at once', () => {
    const msg = fails(base(), /PW_V/, { NODE_ENV: 'test' });
    expect(msg).toMatch(/PW_O/);
    expect(msg).toMatch(/PW_A/);
  });

  it('loadConfig requires RCONSOLE_CONFIG and valid JSON', () => {
    expect(() => loadConfig({ env: {} })).toThrow(/RCONSOLE_CONFIG is not set/);
    expect(() => loadConfig({ env: { RCONSOLE_CONFIG: '/nonexistent/x.json' } })).toThrow(/Cannot read config file/);
  });
});

describe('Secret', () => {
  it('never serializes its value', () => {
    const s = new Secret('super-secret', 'env:X');
    expect(JSON.stringify({ s })).not.toContain('super-secret');
    expect(String(s)).not.toContain('super-secret');
    expect(`${s}`).not.toContain('super-secret');
    expect(inspect(s)).not.toContain('super-secret');
    expect(inspect({ nested: { s } }, { depth: 5 })).not.toContain('super-secret');
    expect(s.reveal()).toBe('super-secret');
  });
  it('resolved config does not leak secrets when serialized', () => {
    const c = resolve(base());
    const text = JSON.stringify(c) + inspect(c, { depth: 10 });
    for (const v of ['viewer-secret-value', 'operator-secret-value', 'admin-secret-value']) expect(text).not.toContain(v);
  });
});

describe('credentialForTier', () => {
  it('never falls back to a lower tier', () => {
    const raw = base();
    delete raw.databases[0].credentials.admin;
    const db = resolve(raw).databases[0]!;
    expect(credentialForTier(db, 'viewer')!.username).toBe('v');
    expect(credentialForTier(db, 'operator')!.username).toBe('o');
    expect(credentialForTier(db, 'admin')).toBeUndefined();
    expect(hasPerTierCredentials(db)).toBe(true);
  });
  it('default applies to every tier', () => {
    const raw = base();
    raw.databases[0].credentials = { default: { username: 'd', password: { env: 'PW_V' } } };
    const db = resolve(raw).databases[0]!;
    for (const r of ['viewer', 'operator', 'admin'] as const) expect(credentialForTier(db, r)!.username).toBe('d');
    expect(hasPerTierCredentials(db)).toBe(false);
  });
  it('a tier-specific credential beats default', () => {
    const raw = base();
    raw.databases[0].credentials = { default: { username: 'd' }, admin: { username: 'a', password: { env: 'PW_A' } } };
    const db = resolve(raw).databases[0]!;
    expect(credentialForTier(db, 'admin')!.username).toBe('a');
    expect(credentialForTier(db, 'viewer')!.username).toBe('d');
  });
});
