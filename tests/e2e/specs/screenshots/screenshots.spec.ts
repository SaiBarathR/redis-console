/** Regenerates docs/screenshots/*.png (opt-in: RC_SCREENSHOTS=1, project "screenshots"). */
import path from 'node:path';
import { test, expect } from '../../lib/test.ts';
import { DB, REPO_ROOT } from '../../lib/env.ts';
import { K } from '../../lib/fixtures-data.ts';
import { consoleRun, gotoView, openKey, setEditor, selectFormat } from '../../lib/ui.ts';

const out = (name: string) => path.join(REPO_ROOT, 'docs', 'screenshots', `${name}.png`);
test.use({ viewport: { width: 1440, height: 900 } });

test.describe('anonymous', () => {
  test('login', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByTestId('login-sso')).toBeVisible();
    await page.screenshot({ path: out('login') });
  });
});

test.describe('operator', () => {
  test.use({ role: 'operator' });

  test('dashboard', async ({ page }) => {
    await gotoView(page, DB.e2e, 'overview');
    await page.waitForTimeout(4500); // a couple of live samples
    await page.screenshot({ path: out('dashboard') });
  });

  test('key browser', async ({ page }) => {
    await gotoView(page, DB.e2e, 'keys');
    const d = await openKey(page, K.json, { pattern: 'e2e:[jhs]*', rowText: 'profile' });
    await selectFormat(d, 'json');
    await page.screenshot({ path: out('key-browser') });
  });

  test('console', async ({ page }) => {
    await gotoView(page, DB.e2e, 'console');
    await consoleRun(page, `HGETALL ${K.hash}`);
    await consoleRun(page, `ZRANGE ${K.zset} 0 -1 WITHSCORES`);
    await setEditor(page, 'KEYS *');
    await expect(page.getByTestId('policy-badge')).toContainText('blocked');
    await page.screenshot({ path: out('console') });
  });

  test('guided mode', async ({ page }) => {
    await gotoView(page, DB.e2e, 'guided');
    await page.getByTestId('guided-ttl').click();
    await page.getByTestId('guided-key').fill('session:9f2a');
    await page.screenshot({ path: out('guided') });
  });

  test('prod confirmation', async ({ page }) => {
    await gotoView(page, DB.prodSim, 'console');
    await consoleRun(page, `SET ${K.prodSimKey} new-value`);
    const dlg = page.getByTestId('confirmation-dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByTestId('confirmation-reason').fill('INC-1234 rotate feature flag');
    await page.screenshot({ path: out('prod-confirmation') });
    await page.keyboard.press('Escape');
  });

  test('pub/sub', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/pubsub');
    await page.getByTestId('pubsub-channel').fill('orders.events');
    await page.getByTestId('pubsub-subscribe').click();
    await page.waitForTimeout(500);
    for (const m of ['{"order":"ord-1","status":"paid"}', '{"order":"ord-2","status":"shipped"}']) {
      await page.getByTestId('publish-channel').fill('orders.events');
      await page.getByTestId('publish-message').fill(m);
      await page.getByTestId('pubsub-publish').click();
    }
    await expect(page.locator('main')).toContainText('shipped');
    await page.screenshot({ path: out('pubsub') });
    await page.getByTestId('pubsub-stop').click();
  });
});

test.describe('admin', () => {
  test.use({ role: 'admin' });
  test('audit log', async ({ page }) => {
    await page.goto('/admin/audit');
    await expect(page.locator('main table')).toBeVisible();
    await page.screenshot({ path: out('audit-log') });
  });
  test('memory analysis', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/analysis');
    await page.getByTestId('analysis-run').click();
    await expect(page.getByTestId('analysis-report')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: out('memory-analysis') });
  });
});
