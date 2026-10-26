/** Attach to our dev-config instance on :4800, never bootstrap/flush a shared Redis. */
import { defineConfig, devices } from '@playwright/test';
const db = process.env.WEBFIX3_DB ?? 'sandbox-e2e';
if (!['sandbox-e2e', 'snapshot'].includes(db)) throw new Error('Live round-3 writes require an approved sandbox.');
const role = process.env.WEBFIX3_ROLE ?? 'operator';
const label = process.env.WEBFIX3_LABEL ?? 'fix';
process.env.WEBFIX3_LIVE = '1';
process.env.RC_E2E_REDIS_PORT = db === 'snapshot' ? '6412' : '6411';
process.env.RC_E2E_BASE_URL = 'http://localhost:4800';
export default defineConfig({
  testDir: './specs/ui', testMatch: 'review-w3.spec.ts', workers: 1, fullyParallel: false,
  timeout: 90000, expect: { timeout: 10000 },
  reporter: [['list'], ['json', { outputFile: `../../apps/web/qa-results/webfix3-${label}-${role}-${db}.json` }]],
  outputDir: `../../apps/web/qa-results/webfix3-${label}-${role}-${db}-artifacts`,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4800', screenshot: 'only-on-failure', actionTimeout: 10000, trace: 'retain-on-failure' },
});
