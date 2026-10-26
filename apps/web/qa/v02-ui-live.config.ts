import { defineConfig } from "@playwright/test";
// One id per run, inherited by workers, so a worker restarted after a failure keeps adding to the same matrix.
process.env.UIQA_RUN ??= `uiqa:${Date.now().toString(36)}`;
/**
 * v0.2 UI live tour against a real server (default http://localhost:4200, the UI agent's port).
 * Source the repository .env first (KC_USER_PASSWORD); local QA accounts come from .qa/accounts.json
 * (scripts/qa-accounts.mjs). Results: qa-results/v02-live/matrix.json and screenshots next to it.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "v02-ui-live.browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  outputDir: "../qa-results/v02-live/artifacts",
  use: {
    baseURL: process.env.WEB_QA_ORIGIN ?? "http://localhost:4200",
    viewport: { width: 1440, height: 900 },
    actionTimeout: 20_000,
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
});
