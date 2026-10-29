/**
 * Key browser v0.2.1: the whole namespace tree from a names-only scan, lazy metadata for the rows on screen, folder
 * percentages and actions, Tree/List and columns, "Keys to scan", refresh, and pattern delete as a job.
 */
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';
import { confirmDialog, gotoView } from '../../lib/ui.ts';

const P = `${K.scratchPrefix}kb21:`;
const fill = async () => {
  const args: string[] = [];
  for (let i = 0; i < 240; i++) args.push(`${P}img:${i}`, 'x');
  for (let i = 0; i < 60; i++) args.push(`${P}meta:${i}`, 'x');
  await redisExec(['MSET', ...args]);
};
const cleanup = async () => {
  let cursor = '0';
  do {
    const [next, keys] = await redisExec<[Buffer, Buffer[]]>(['SCAN', cursor, 'MATCH', `${P}*`, 'COUNT', '1000']);
    cursor = String(next);
    if (keys.length) await redisExec(['UNLINK', ...keys]);
  } while (cursor !== '0');
};
const folder = (page: import('@playwright/test').Page, label: string) =>
  page.getByTestId('key-folder').filter({ has: page.locator('.folder-name', { hasText: new RegExp(`^${label}:$`) }) }).first();

test.describe('key browser v0.2.1', () => {
  test.use({ role: 'operator' });
  test.beforeEach(async () => { await cleanup(); await fill(); });
  test.afterEach(cleanup);

  test('folders show counts and % of the results; rows get metadata lazily; filter and delete a folder', async ({ page }) => {
    await gotoView(page, DB.e2e, 'keys');
    // Metadata requests for this test's keys (the browser's first scan of the whole database may still be loading).
    const metaBodies: { keys: { data: string }[] }[] = [];
    page.on('request', (r) => {
      if (!r.url().endsWith('/keys/meta')) return;
      const body = r.postDataJSON();
      if (body.keys.some((k: { data: string }) => k.data.startsWith(P))) metaBodies.push(body);
    });
    await page.getByTestId('key-pattern').fill(`${P}*`);
    await page.getByTestId('key-scan').click();
    const summary = page.getByTestId('key-scan-summary');
    await expect(summary).toHaveAttribute('data-done', 'true');
    await expect(summary).toContainText('Results 300');
    await expect(page.getByTestId('key-share-note')).toHaveText('folder %');
    await expect(page.getByTestId('key-share-note')).toHaveAttribute('title', /its share of matching keys$/);
    // More than 150 results: collapsed start, the single-child chain e2e: → scratch: → kb21: is open.
    await expect(folder(page, 'img')).toContainText('240');
    await expect(folder(page, 'img')).toContainText('80%');
    await expect(folder(page, 'meta')).toContainText('20%');
    expect(await folder(page, 'img').getAttribute('title')).toContain(`${P}img:*`);
    // No key row on screen yet: no metadata was requested.
    expect(metaBodies).toHaveLength(0);
    await folder(page, 'meta').click();
    const rows = page.getByTestId('key-list').getByTestId('key-row');
    await expect(rows.first()).toContainText('string');
    await expect(rows.first()).toHaveAttribute('data-meta', 'loaded');
    const asked = metaBodies.reduce((n, b) => n + b.keys.filter((k) => k.data.startsWith(P)).length, 0);
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThanOrEqual(60);
    // Filter to a folder.
    await folder(page, 'img').hover();
    await folder(page, 'img').getByTestId('folder-filter').click();
    await expect(page.getByTestId('key-pattern')).toHaveValue(`${P}img:*`);
    await expect(summary).toContainText('Results 240');
    // Delete keys in a folder: the confirmed bulk delete, pre-filled, as a job with a report.
    await page.getByTestId('key-pattern').fill(`${P}*`);
    await page.getByTestId('key-scan').click();
    await expect(summary).toContainText('Results 300');
    await folder(page, 'meta').hover();
    await folder(page, 'meta').getByTestId('folder-delete').click();
    const dialog = page.getByTestId('bulk-delete-dialog');
    await expect(dialog.getByTestId('bulk-delete-pattern')).toHaveValue(`${P}meta:*`);
    await dialog.getByTestId('bulk-delete-preview').click();
    await dialog.getByTestId('bulk-delete-review').click();
    await expect(page.getByTestId('confirmation-impact')).toContainText('60 keys affected');
    await confirmDialog(page);
    await expect(dialog.getByTestId('bulk-job')).toHaveAttribute('data-state', 'done');
    await expect(dialog).toContainText('Deleted 60 of 60 scanned keys.');
    expect(Number(await redisExec(['EXISTS', `${P}meta:0`]))).toBe(0);
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    // The list refreshes when the job ends.
    await expect(summary).toContainText('Results 240');
  });

  test('Tree/List toggle, column chooser, descending sort, refresh and "Keys to scan"', async ({ page }) => {
    // Enough keys that a 500-slot scan of the whole database cannot finish in one step.
    await redisExec(['MSET', ...Array.from({ length: 600 }, (_, i) => [`${P}more:${i}`, 'x']).flat()]);
    await gotoView(page, DB.e2e, 'keys');
    await page.getByTestId('key-pattern').fill(`${P}meta:*`);
    await page.getByTestId('key-scan').click();
    await expect(page.getByTestId('key-scan-summary')).toContainText('Results 60');
    await page.getByTestId('key-view-list').click();
    await expect(page.getByTestId('key-folder')).toHaveCount(0);
    const rows = page.getByTestId('key-list').getByTestId('key-row');
    await expect(rows.first()).toContainText(`${P}meta:0`);
    await page.getByTestId('key-sort-name').click();
    await expect(rows.first()).toContainText(`${P}meta:59`);
    // Hidden columns are not read: once the size column is hidden, metadata batches skip MEMORY USAGE. Wait for the
    // batches already sent for the rows on screen, so only requests made after hiding the column are counted.
    await expect(page.getByTestId('key-list')).toHaveAttribute('data-meta-pending', 'false');
    await page.getByTestId('key-columns').click();
    await page.getByTestId('key-column-size').uncheck();
    await expect(page.getByTestId('key-sort-size')).toHaveCount(0);
    const sizes: (boolean | undefined)[] = [];
    page.on('request', (r) => { if (r.url().endsWith('/keys/meta')) sizes.push(r.postDataJSON().size); });
    await page.getByTestId('key-refresh').click();
    await expect.poll(() => sizes.length).toBeGreaterThan(0);
    expect(sizes.every((s) => s === false)).toBe(true);
    await page.getByTestId('key-column-size').check();
    await page.getByTestId('key-view-tree').click();
    await expect(page.getByTestId('key-delimiter')).toHaveValue(':');
    await expect(page.getByTestId('key-last-refresh')).toContainText(/now|ago/);
    // "Keys to scan" is a preference in localStorage (a number only) and survives a reload.
    await page.getByTestId('key-scan-count').selectOption('500');
    expect(await page.evaluate(() => localStorage.getItem('rconsole.keyScanCount'))).toBe('500');
    await page.reload();
    await expect(page.getByTestId('key-scan-count')).toHaveValue('500');
    await page.getByTestId('key-pattern').fill('*');
    await page.getByTestId('key-scan').click();
    const summary = page.getByTestId('key-scan-summary');
    await expect(summary).toHaveAttribute('data-done', 'false');
    expect(Number(await summary.getAttribute('data-scanned'))).toBeLessThanOrEqual(600);
    await expect(page.getByTestId('key-share-note')).toHaveText('folder %');
    await expect(page.getByTestId('key-share-note')).toHaveAttribute('title', /its share of loaded matches$/);
    await page.getByTestId('key-scan-all').click();
    await expect(summary).toHaveAttribute('data-done', 'true', { timeout: 30_000 });
    await page.getByTestId('key-scan-count').selectOption('10000');
    expect(await page.evaluate(() => localStorage.getItem('rconsole.keyScanCount'))).toBeNull();
  });
});

test.describe('key browser v0.2.1 as viewer', () => {
  test.use({ role: 'viewer' });
  test.beforeEach(async () => { await cleanup(); await fill(); });
  test.afterEach(cleanup);
  test('viewers can filter to a folder but get no delete action', async ({ page }) => {
    await gotoView(page, DB.e2e, 'keys');
    await page.getByTestId('key-pattern').fill(`${P}*`);
    await page.getByTestId('key-scan').click();
    await expect(page.getByTestId('key-scan-summary')).toContainText('Results 300');
    await folder(page, 'img').hover();
    await expect(folder(page, 'img').getByTestId('folder-filter')).toBeVisible();
    await expect(folder(page, 'img').getByTestId('folder-delete')).toHaveCount(0);
  });
});
