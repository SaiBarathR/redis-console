/** remote-6390 in the UI: read-only badge/banner, no write controls even for admin; reads work. */
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { gotoView, setEditor } from '../../lib/ui.ts';

test.use({ role: 'admin' });

test('read-only prod database shows banner, viewer effective role, and no write controls', async ({ page }) => {
  await gotoView(page, DB.remote, 'keys');
  await expect(page.getByRole('status').filter({ hasText: /All writes are disabled/ })).toBeVisible();
  await expect(page.locator('.database-badges')).toContainText('Read-only');
  await expect(page.locator('.database-badges')).toContainText('viewer');
  await expect(page.getByTestId('key-add')).toHaveCount(0);
  await expect(page.getByTestId('bulk-delete')).toHaveCount(0);
  // A large first page starts with namespaces collapsed; a flat list shows keys directly.
  await page.getByTestId('key-delimiter').fill('');
  const first = page.getByTestId('key-list').getByTestId('key-row').first();
  await expect(first).toBeVisible();
  await first.click();
  const d = page.getByTestId('key-detail');
  await expect(d.locator('h2')).toBeVisible();
  for (const id of ['key-edit', 'key-ttl', 'key-rename', 'key-delete']) await expect(d.getByTestId(id)).toHaveCount(0);
});

test('console on read-only database: writes are disabled, reads run', async ({ page }) => {
  await gotoView(page, DB.remote, 'console');
  await setEditor(page, 'SET rconsole-e2e:never x');
  await expect(page.getByTestId('console-run')).toBeDisabled();
  await setEditor(page, 'DBSIZE');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('console-results')).toContainText(/\d+/);
});

test('profiler and admin tools are not offered on the read-only prod database', async ({ page }) => {
  await gotoView(page, DB.remote, 'diagnostics');
  await expect(page.getByTestId('diagnostics-slowlog')).toBeVisible();
  await expect(page.getByTestId('diagnostics-profiler')).toHaveCount(0);
  await expect(page.getByTestId('diagnostics-clients')).toHaveCount(0);
});
