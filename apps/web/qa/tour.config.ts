import { defineConfig } from "@playwright/test";
/** Read-only visual/console tour of every page per role, theme and width. Real server on 4300. */
export default defineConfig({
  testDir: ".",
  testMatch: process.env.SHOTS ? "shots.browser.spec.ts" : "tour.browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 240000,
  reporter: "list",
  outputDir: "../qa-results/tour",
  use: {
    baseURL: process.env.WEB_QA_ORIGIN ?? "http://localhost:4300",
    screenshot: "only-on-failure",
    trace: "off",
    video: "off",
  },
});
