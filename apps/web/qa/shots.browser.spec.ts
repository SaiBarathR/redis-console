import { test, expect } from "@playwright/test";
/** Ad-hoc screenshots of named pages for visual review: SHOTS="/path,/path" SHOT_USER=operator1. Read-only. */
test("shots", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("login-sso").click();
  await page.locator("#username").fill(process.env.SHOT_USER ?? "operator1");
  await page.locator("#password").fill(process.env.KC_USER_PASSWORD!);
  await page.locator("#kc-login").click();
  await expect(page.getByTestId("database-switcher")).toBeVisible({ timeout: 20000 });
  for (const theme of (process.env.SHOT_THEMES ?? "light").split(",")) {
    await page.evaluate((t) => localStorage.setItem("rconsole.theme", t), theme);
    await page.setViewportSize({ width: Number(process.env.SHOT_WIDTH ?? 1280), height: 900 });
    for (const path of (process.env.SHOTS ?? "/").split(",")) {
      await page.goto(path);
      await page.waitForTimeout(Number(process.env.SHOT_WAIT ?? 1200));
      await page.screenshot({ path: `qa-results/shots/${theme}-${path.replace(/\W+/g, "_") || "home"}.png` });
    }
  }
});
