/** Bulk delete by pattern: impact preview in the confirmation dialog, then deletion. */
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { K, BULK_COUNT, redisExec } from '../../lib/fixtures-data.ts';
import { gotoView } from '../../lib/ui.ts';

test.use({ role: 'operator' });

test('impact preview shows count and sample; confirm deletes exactly those keys', async ({ page }) => {
  await redisExec(['SET', 'e2e:bulk-survivor', 'x']);
  await gotoView(page, DB.e2e, 'keys');
  await page.getByTestId('bulk-delete').click();
  await page.getByTestId('bulk-delete-pattern').fill(`${K.bulkPrefix}*`);
  // Step 1: read-only SCAN sample (no server challenge yet).
  await page.getByTestId('bulk-delete-preview').click();
  await expect(page.getByTestId('bulk-delete-dialog')).toContainText(/Preview sample/);
  expect(Number(await redisExec(['EXISTS', `${K.bulkPrefix}0001`]))).toBe(1);
  // Step 2: server impact challenge.
  await page.getByTestId('bulk-delete-review').click();
  const dlg = page.getByTestId('confirmation-dialog');
  await expect(dlg).toBeVisible();
  const impact = dlg.getByTestId('confirmation-impact');
  await expect(impact).toContainText(`${BULK_COUNT} keys affected`);
  await expect(impact.locator('li').first()).toContainText(K.bulkPrefix);
  expect(Number(await redisExec(['EXISTS', `${K.bulkPrefix}0001`]))).toBe(1);
  const typed = dlg.getByTestId('confirmation-typed');
  if (await typed.isVisible()) {
    const label = await dlg.locator('label').filter({ has: page.getByTestId('confirmation-typed') }).innerText();
    await typed.fill(/“(.+)”/.exec(label)![1]!);
  }
  await dlg.getByTestId('confirmation-submit').click();
  await expect(page.getByTestId('bulk-delete-dialog')).toContainText(`Deleted ${BULK_COUNT} of`);
  expect(Number(await redisExec(['EXISTS', `${K.bulkPrefix}0001`]))).toBe(0);
  expect(Number(await redisExec(['EXISTS', 'e2e:bulk-survivor']))).toBe(1);
});

test('cancelling the impact preview deletes nothing', async ({ page }) => {
  for (let i = 0; i < 5; i++) await redisExec(['SET', `${K.scratchPrefix}bulk-cancel:${i}`, 'x']);
  await gotoView(page, DB.e2e, 'keys');
  await page.getByTestId('bulk-delete').click();
  await page.getByTestId('bulk-delete-pattern').fill(`${K.scratchPrefix}bulk-cancel:*`);
  await page.getByTestId('bulk-delete-preview').click();
  await page.getByTestId('bulk-delete-review').click();
  const dlg = page.getByTestId('confirmation-dialog');
  await expect(dlg).toContainText('5 keys affected');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  expect(Number(await redisExec(['EXISTS', `${K.scratchPrefix}bulk-cancel:0`]))).toBe(1);
});
