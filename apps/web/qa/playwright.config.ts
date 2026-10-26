import { defineConfig } from "@playwright/test";
const port = Number(process.env.QA_CSP_PORT ?? 4810);
export default defineConfig({
  testDir: ".",
  testMatch: "contract.browser.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: "../qa-results",
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "off",
  },
  webServer: {
    command: "node csp-server.mjs",
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 10000,
  },
});
