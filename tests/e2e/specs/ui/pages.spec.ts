/** Every page for every role loads without CSP/Trusted-Types violations, console errors or leaks. */
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { dbUrl } from '../../lib/ui.ts';

const DB_VIEWS = ['overview', 'keys', 'console', 'workbench', 'guided', 'diagnostics', 'diagnostics/slowlog', 'diagnostics/analysis', 'diagnostics/pubsub', 'diagnostics/streams', 'diagnostics/search', 'diagnostics/timeseries'];
const ADMIN_VIEWS = ['diagnostics/clients', 'diagnostics/profiler'];

for (const role of ['viewer', 'operator', 'admin'] as const) {
  test.describe(`all pages as ${role}`, () => {
    test.use({ role });
    for (const db of [DB.e2e, DB.prodSim, DB.remote]) {
      test(`${db}: every view renders under the production CSP`, async ({ page }) => {
        const views = [...DB_VIEWS, ...(role === 'admin' && db === DB.e2e ? ADMIN_VIEWS : [])];
        for (const v of views) {
          await page.goto(dbUrl(db, v));
          await expect(page.getByTestId('database-switcher')).toBeVisible();
          await expect(page.locator('main')).not.toBeEmpty();
          await page.waitForTimeout(300);
        }
        await page.goto('/account');
        await expect(page.locator('main')).toContainText(/Account|password|authenticator/i);
        await expect(page.getByTestId('about-notices')).toHaveAttribute('href', '/THIRD-PARTY-NOTICES.txt');
        if (role === 'admin') {
          await page.goto('/admin/audit');
          await expect(page.locator('main table')).toBeVisible();
          await page.goto('/admin/users');
          await expect(page.locator('main table')).toBeVisible();
        }
      });
    }
  });
}

test.describe('shell', () => {
  test.use({ role: 'operator' });
  test('database switcher, command palette and theme toggle', async ({ page }) => {
    await page.goto(dbUrl(DB.e2e, 'overview'));
    await page.getByTestId('database-switcher').selectOption(DB.prodSim);
    await expect(page).toHaveURL(new RegExp(`/db/${DB.prodSim}/overview`));
    await page.getByTestId('command-palette-open').click();
    await page.getByTestId('command-palette-search').fill('Console');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/console$/);
    await expect(page.getByTestId('command-palette')).toBeHidden();
    const before = await page.locator('html').getAttribute('class') ?? await page.locator('html').getAttribute('data-theme');
    await page.getByTestId('theme-toggle').click();
    const after = await page.locator('html').getAttribute('class') ?? await page.locator('html').getAttribute('data-theme');
    expect(after).not.toBe(before);
    const stored = await page.evaluate(() => Object.keys(localStorage));
    // Only UI preferences may be persisted (theme, last database id, "Keys to scan"), never values or history.
    expect(stored.every((k) => ['rconsole.theme', 'rconsole.database', 'rconsole.keyScanCount'].includes(k))).toBe(true);
    const values = await page.evaluate(() => Object.values(localStorage).join('|'));
    expect(values.length).toBeLessThan(200);
  });
});
