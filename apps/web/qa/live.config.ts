import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "live.browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  reporter: "list",
  outputDir: "../qa-results/live",
  use: {
    baseURL: process.env.WEB_QA_ORIGIN ?? "http://localhost:4300",
    viewport: { width: 1366, height: 900 },
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
});
