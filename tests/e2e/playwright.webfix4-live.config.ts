/** Run the byte-fidelity spec against this fixer's dev instance; never bootstrap or flush shared data. */
import { defineConfig, devices } from '@playwright/test';
process.env.WEBFIX4_LIVE = '1';
process.env.RC_E2E_REDIS_PORT = '6411';
process.env.RC_E2E_BASE_URL = 'http://localhost:4800';
export default defineConfig({
  testDir: './specs/ui', testMatch: 'review-w4.spec.ts', workers: 1, fullyParallel: false,
  timeout: 90000, expect: { timeout: 10000 },
  reporter: [['list'], ['json', { outputFile: '../../apps/web/qa-results/webfix4-live.json' }]],
  outputDir: '../../apps/web/qa-results/webfix4-live-artifacts',
  use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4800', screenshot: 'only-on-failure', actionTimeout: 10000, trace: 'retain-on-failure' },
});
