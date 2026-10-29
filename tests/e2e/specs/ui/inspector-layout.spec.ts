/** Layout regression: all writes stay under a caller-selectable scratch prefix. */
import { readFileSync } from 'node:fs';
import { test, expect } from '../../lib/test.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';
import { gotoView, openKey, uiLogin } from '../../lib/ui.ts';

const attach = process.env.RC_E2E_ATTACH === '1';
const prefix = process.env.UI_INSPECTOR_PREFIX ?? `${K.scratchPrefix}inspector-layout:`;
const key = `${prefix}hash`;
const field = 'abcdef0123456789'.repeat(4);
for (const role of ['viewer', 'operator', 'admin'] as const) {
  test.describe(`inspector layout ${role}`, () => {
    test.use({ role: attach ? null : role });
    test.beforeAll(async () => { await redisExec(['HSET', key, field, JSON.stringify({ body: 'x'.repeat(500) })]); });
    test.afterAll(async () => { await redisExec(['UNLINK', key]); });
    test('one full-width expansion, scrollable tabs, fixed action space and wide mode', async ({ page }) => {
      if (attach) {
        const accounts = JSON.parse(readFileSync(new URL('../../../../.qa/accounts.json', import.meta.url), 'utf8'));
        await uiLogin(page, accounts.local[`qa-${role}`]);
      }
      await gotoView(page, 'sandbox-e2e', 'keys');
      for (const width of [1024, 1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const theme of ['light', 'dark']) {
          if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByTestId('theme-toggle').click();
          const detail = await openKey(page, key);
          const buttons = detail.getByRole('button', { name: /^Expand (field|value)$/ });
          await buttons.first().click(); await buttons.nth(1).click();
          await expect(detail.locator('.collection-detail-line .value-viewer')).toHaveCount(1);
          await expect(detail.locator('.collection-detail-line td')).toHaveAttribute('colspan', '4');
          await expect(buttons.first()).toHaveAttribute('aria-expanded', 'false');
          await expect(buttons.nth(1)).toHaveAttribute('aria-expanded', 'true');
          await detail.getByLabel('Field column width').fill('80');
          const tabs = detail.getByTestId('value-format');
          expect(await tabs.evaluate(e => e.getBoundingClientRect().right <= e.parentElement!.getBoundingClientRect().right + 1)).toBe(true);
          await tabs.getByRole('tab', { name: 'Float64 BE', exact: true }).click();
          await expect(tabs.getByRole('tab', { name: 'Float64 BE', exact: true })).toBeInViewport();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await detail.getByTestId('inspector-wide').click();
          await expect(page.getByTestId('key-list')).toBeHidden();
          await detail.getByTestId('inspector-wide').click();
          await expect(page.getByTestId('key-list')).toBeVisible();
          await detail.getByRole('button', { name: 'Collapse value' }).click();
        }
      }
    });
  });
}
