import { defineConfig } from '@playwright/test';
/** Run against an already started built-SPA QA instance after scripts/qa-accounts.mjs. */
export default defineConfig({
  testDir: '.', testMatch: 'graph-live.browser.spec.ts', workers: 1, retries: 0,
  timeout: 60_000, reporter: 'list', outputDir: '/tmp/rc-v04-graph-live/artifacts',
  use: { baseURL: process.env.WEB_QA_ORIGIN ?? 'http://localhost:4300', viewport: { width: 1440, height: 1000 }, headless: true },
});
