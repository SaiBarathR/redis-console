/** Live DETAIL qualification; only disposable names in the explicitly approved sandboxes. */
import { defineConfig, devices } from '@playwright/test';
const db = process.env.DETAIL_DB ?? 'sandbox-e2e';
if (!['sandbox-e2e', 'snapshot'].includes(db)) throw new Error('DETAIL fixtures require an approved sandbox.');
process.env.DETAIL_LIVE = '1';
process.env.RC_E2E_REDIS_PORT = db === 'snapshot' ? '6412' : '6411';
process.env.RC_E2E_BASE_URL = 'http://localhost:4800';
export default defineConfig({
  testDir: './specs/ui', testMatch: process.env.DETAIL_READONLY === '1' ? 'detail-readonly.spec.ts' : 'detail.spec.ts', workers: 1, fullyParallel: false,
  timeout: 90000, expect: { timeout: 10000 },
  reporter: [['list'], ['json', { outputFile: `../../apps/web/qa-results/detail-${process.env.DETAIL_READONLY === '1' ? 'readonly-' : ''}${process.env.DETAIL_ROLE ?? 'operator'}-${db}.json` }]],
  outputDir: `../../apps/web/qa-results/detail-${process.env.DETAIL_READONLY === '1' ? 'readonly-' : ''}${process.env.DETAIL_ROLE ?? 'operator'}-${db}-artifacts`,
  use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4800', screenshot: 'only-on-failure', trace: 'retain-on-failure', actionTimeout: 10000 },
});
