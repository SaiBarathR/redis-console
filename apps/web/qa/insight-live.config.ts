import { defineConfig } from "@playwright/test";
process.env.INSIGHT_QA_RUN ??= `insightqa:${Date.now().toString(36)}`;
/**
 * v0.2.1 Insight live tour (search wizard, search workflow, analysis, rich workbench results, import, tutorials)
 * against a real server (default http://localhost:4700). Local QA accounts come from .qa/accounts.json
 * (scripts/qa-accounts.mjs). Results: $INSIGHT_QA_OUT (default /tmp/rc-insight-live) matrix.json + screenshots.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "insight-live.browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  outputDir: (process.env.INSIGHT_QA_OUT ?? "/tmp/rc-insight-live") + "/artifacts",
  use: {
    baseURL: process.env.WEB_QA_ORIGIN ?? "http://localhost:4700",
    viewport: { width: 1440, height: 900 },
    actionTimeout: 20_000,
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
});
