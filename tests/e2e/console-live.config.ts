import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./specs/ui",
  testMatch: "console-keyboard.spec.ts",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/console-live.json" }],
  ],
  outputDir: "test-results/console-live",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:4300",
    actionTimeout: 10000,
    navigationTimeout: 20000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
