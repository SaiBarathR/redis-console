import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './lib/env.ts';

/**
 * Projects run in dependency order on one worker (shared Redis state, per-user
 * rate limits and TOTP replay protection make parallel runs non-deterministic):
 *   setup, then api, ui, final (declaration order)
 * `screenshots` is opt-in (RC_SCREENSHOTS=1) and regenerates docs/screenshots.
 */
const screenshots = process.env.RC_SCREENSHOTS === '1';

export default defineConfig({
  testDir: './specs',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: BASE_URL,
    ...devices['Desktop Chrome'],
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    // Patterns are matched against absolute paths: anchor them to specs/ so a checkout path containing
    // "ui/" or "api/" (e.g. a worktree named v02-ui) does not pull other projects' specs in twice.
    { name: 'setup', testMatch: /specs\/setup\/.*\.setup\.ts/ },
    { name: 'api', testMatch: /specs\/api\/.*\.spec\.ts/, dependencies: ['setup'] },
    { name: 'ui', testMatch: /specs\/ui\/.*\.spec\.ts/, dependencies: ['setup'] },
    // Not a dependency chain on purpose: a failing api/ui test must not skip later projects.
    // With one worker, projects run in declaration order, so `final` runs last.
    { name: 'final', testMatch: /specs\/final\/.*\.spec\.ts/, dependencies: ['setup'] },
    ...(screenshots ? [{ name: 'screenshots', testMatch: /specs\/screenshots\/.*\.spec\.ts/, dependencies: ['setup'] }] : []),
  ],
});
