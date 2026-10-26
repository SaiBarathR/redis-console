/** Read-only remote qualification: reads only, never seed or mutate this target. */
import { readFileSync } from 'node:fs';
import { test, expect } from '../../lib/test.ts';
import { gotoView, openKey, uiLogin } from '../../lib/ui.ts';
const live = process.env.DETAIL_LIVE === '1';
const roles = live ? [process.env.DETAIL_ROLE ?? 'viewer'] : ['viewer', 'operator', 'admin'];
for (const role of roles) {
  test.describe(`DETAIL remote read-only ${role}`, () => {
    test.use({ role: live ? null : role });
    test('lookup, formatting, expiry capability and bounded download use effective viewer access', async ({ page }) => {
      if (live) {
        const accounts = JSON.parse(readFileSync(new URL('../../../../.qa/accounts.json', import.meta.url), 'utf8'));
        await uiLogin(page, accounts.local[`qa-${role}`]);
      }
      await gotoView(page, 'remote-6390', 'keys');
      const me = await (await page.request.get('/api/v1/auth/me')).json();
      const scan = await page.request.post('/api/v1/databases/remote-6390/keys/scan', { headers: { Origin: 'http://localhost:' + (live ? '4800' : '4400'), 'X-CSRF-Token': me.csrfToken }, data: { type: 'hash', count: 100, match: '*' } });
      expect(scan.status()).toBe(200); const pageData = await scan.json();
      const key = pageData.keys.find((k: any) => k.key.enc === 'utf8')?.key;
      expect(key, 'existing remote hash; no remote fixtures are created').toBeTruthy();
      const detail = await openKey(page, key.data);
      await expect(detail.getByTestId('collection-add')).toHaveCount(0); await expect(detail.getByTestId('key-edit')).toHaveCount(0);
      const firstField = detail.getByTestId('value-cell-open').first(); const field = await firstField.textContent();
      await detail.getByLabel('Collection lookup mode').selectOption('exact'); await detail.getByLabel('Collection lookup', { exact: true }).fill(field ?? ''); await detail.getByText('Apply lookup', { exact: true }).click();
      await expect(detail.getByTestId('collection-filter-count')).toContainText('1 filter matches');
      await detail.getByLabel('Collection value format').selectOption('hex'); await expect(detail.getByTestId('value-cell-open').nth(1)).toContainText('00000000');
      const unavailable = detail.getByRole('button', { name: /Field TTL unavailable:/ });
      if (await unavailable.count()) await expect(unavailable).toBeDisabled();
      else { await detail.getByRole('button', { name: /^Field TTL for/ }).click(); await expect(detail.getByText('Read field TTL', { exact: true })).toBeVisible(); await expect(detail.getByText('Set field TTL', { exact: true })).toHaveCount(0); }
      await detail.getByTestId('value-cell-open').nth(1).click(); const dialog = page.getByTestId('value-inspector-dialog');
      if (await dialog.getByTestId('element-load-full').isVisible()) await dialog.getByTestId('element-load-full').click();
      await expect(dialog.getByTestId('value-download')).toBeEnabled();
      const downloadPromise = page.waitForEvent('download'); await dialog.getByTestId('value-download').click(); expect((await downloadPromise).suggestedFilename()).toBe('redis-value.bin');
      await expect(dialog.getByText('Edit full element', { exact: true })).toHaveCount(0);
      expect(page.url()).toMatch(/\/db\/remote-6390\/keys$/);
      expect((await page.context().storageState()).origins.every(origin => origin.localStorage.every(item => ['rconsole.theme', 'rconsole.database'].includes(item.name)))).toBe(true);
    });
  });
}
