/**
 * Packaging: the deploy/ example configs must pass the server's own validation with
 * NODE_ENV=production (https publicUrl, secure cookies, prod databases on rediss:// with per-tier
 * ACL users, trustProxy as a hop count). Uses the real config loader from apps/server.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveConfig } from '../../../../apps/server/src/config.ts';
import { REPO_ROOT } from '../../lib/env.ts';

const opts = { env: { NODE_ENV: 'production' }, readFile: () => 'dummy-secret-value-at-least-32-characters\n', cwd: '/tmp' };
const compose = () => JSON.parse(readFileSync(path.join(REPO_ROOT, 'deploy/config.prod.example.json'), 'utf8'));
const k8s = () => {
  const y = readFileSync(path.join(REPO_ROOT, 'deploy/k8s/configmap.yaml'), 'utf8');
  return JSON.parse(y.split('config.json: |')[1]!.split('\n').map((l) => l.replace(/^ {4}/, '')).join('\n'));
};

for (const [name, load] of [['deploy/config.prod.example.json', compose], ['deploy/k8s/configmap.yaml', k8s]] as const) {
  test(`${name} is valid under production rules`, () => {
    const raw = load();
    expect(() => resolveConfig(raw, opts)).not.toThrow();
    expect(raw.server.trustProxy, 'trustProxy must be a hop count or CIDRs, never true').not.toBe(true);
    expect(raw.server.secureCookies).toBe(true);
    for (const db of raw.databases) {
      if (db.environment !== 'prod') continue;
      expect(db.url, `${db.id} uses TLS`).toMatch(/^rediss:\/\//);
      expect(Object.keys(db.credentials).some((t) => t !== 'default'), `${db.id} has per-tier ACL users`).toBe(true);
      expect(db.acceptRisks ?? []).toEqual([]);
    }
  });
}

test('production refuses a plaintext / default-credential prod database unless acceptRisks lists it', () => {
  const raw = compose();
  const prod = raw.databases.find((d: any) => d.environment === 'prod');
  prod.url = 'redis://orders-redis.internal.example.com:6379';
  delete prod.tls;
  expect(() => resolveConfig(raw, opts)).toThrow(/requires TLS/);
  prod.acceptRisks = ['plaintext'];
  expect(() => resolveConfig(raw, opts)).not.toThrow();
  prod.credentials = { default: { username: 'default', password: { file: '/run/secrets/x' } } };
  expect(() => resolveConfig(raw, opts)).toThrow(/per-tier ACL users/);
  prod.acceptRisks = ['plaintext', 'default-credentials'];
  expect(() => resolveConfig(raw, opts)).not.toThrow();
});
