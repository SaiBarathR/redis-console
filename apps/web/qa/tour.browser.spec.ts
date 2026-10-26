import { test, expect, type Page } from "@playwright/test";
/**
 * Visits every page as viewer, operator and admin in light and dark at 1440 and 1280 wide. Read-only: it only
 * navigates (GETs and documented read POSTs). Fails on page errors, CSP/Trusted Types violations, unexpected
 * non-GET requests, and API 5xx responses. Screenshots go to qa-results/tour/ for visual review.
 */
const db = "sandbox-e2e";
const tools = ["slowlog", "analysis", "pubsub", "streams", "clients", "profiler", "search", "timeseries"];
const pages = [
  "/",
  `/db/${db}/overview`,
  `/db/${db}/keys`,
  `/db/${db}/console`,
  `/db/${db}/workbench`,
  `/db/${db}/guided`,
  `/db/${db}/diagnostics`,
  ...tools.map((tool) => `/db/${db}/diagnostics/${tool}`),
  "/db/remote-6390/overview",
  "/db/remote-6390/keys",
  "/account",
  "/admin/audit",
  "/admin/users",
];
const readPost = /^\/api\/v1\/databases\/[^/]+\/(?:keys\/scan|key\/read|streams\/groups|streams\/pending|timeseries\/range|pubsub\/channels|search\/query)$/;
async function sso(page: Page, user: string) {
  await page.goto("/");
  await page.getByTestId("login-sso").click();
  await page.locator("#username").fill(user);
  await page.locator("#password").fill(process.env.KC_USER_PASSWORD!);
  await page.locator("#kc-login").click();
  await expect(page.getByTestId("database-switcher")).toBeVisible({ timeout: 20000 });
}
for (const user of ["viewer1", "operator1", "admin1"]) {
  test(`tour ${user}`, async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (/Content Security Policy|Trusted|Refused to|violates/i.test(m.text())) problems.push(`csp: ${m.text()}`);
      else if (m.type() === "error" && !/status of (401|403|404|429|503)/.test(m.text())) problems.push(`console: ${m.text()}`);
    });
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (path.startsWith("/api/") && r.method() !== "GET" && !readPost.test(path) && path !== "/api/v1/auth/logout")
        problems.push(`write: ${r.method()} ${path}`);
    });
    page.on("response", (r) => {
      if (r.url().includes("/api/") && r.status() >= 500) problems.push(`5xx: ${r.status()} ${new URL(r.url()).pathname}`);
    });
    await sso(page, user);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((t) => localStorage.setItem("rconsole.theme", t), theme);
      for (const width of [1440, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of pages) {
          if (path.startsWith("/admin/") && user !== "admin1") continue;
          await page.goto(path);
          // SSE keeps the network busy, so wait for loading indicators to settle instead of network idle.
          await page.waitForTimeout(300);
          await expect(page.locator(".spin")).toHaveCount(0, { timeout: 8000 }).catch(() => problems.push(`still loading after 8s: ${path} (${theme} ${width})`));
          await expect(page.locator("main.fatal")).toHaveCount(0);
          const name = `${user}-${theme}-${width}-${path.replace(/\W+/g, "_").replace(/^_|_$/g, "") || "home"}`;
          await page.screenshot({ path: `qa-results/tour/${name}.png`, fullPage: true });
        }
      }
    }
    expect(problems).toEqual([]);
  });
}
