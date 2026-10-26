/**
 * v0.2.1 Insight UI: Make searchable + index wizard + index detail + admin drop (F7), the search workflow (F8),
 * analysis jobs with recommendations, history and comparison (F4), command-aware workbench results (F11),
 * command-file import (F10) and offline tutorials (F12). The page fixture fails a test on any CSP violation,
 * console error or page error.
 */
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';
import { confirmDialog, gotoView, openKey, setEditor } from '../../lib/ui.ts';

const RUN = `${K.scratchPrefix}insight:${Date.now().toString(36)}:`;

test.describe('as admin', () => {
  test.use({ role: 'admin' });

  test('Make searchable from a hash opens the wizard; create, inspect, query and drop the index', async ({ page }) => {
    const prefix = `${RUN}product:`;
    const index = `idx:${RUN}product`.replace(/:+$/, '');
    for (let i = 1; i <= 3; i++) await redisExec(['HSET', `${prefix}${i}`, 'name', i === 2 ? 'Red gadget' : `Blue gadget ${i}`, 'price', String(i * 10), 'category', i === 2 ? 'toys' : 'tools']);
    try {
      await gotoView(page, DB.e2e, 'keys');
      const detail = await openKey(page, `${prefix}1`);
      await detail.getByTestId('make-searchable').click();
      await expect(page).toHaveURL(/diagnostics\/search\?panel=create$/);
      await expect(page.getByTestId('wizard-sampled')).toContainText('3 keys sampled');
      await expect(page.getByTestId('wizard-field-row')).toHaveCount(3);
      await page.getByTestId('wizard-field-row').filter({ hasText: 'price' }).getByLabel('Sortable').check();
      await page.getByTestId('wizard-next').click();
      await page.getByTestId('wizard-index-name').fill(index);
      await expect(page.getByTestId('wizard-command')).toHaveText(
        new RegExp(`^FT\\.CREATE ${index.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ON HASH PREFIX 1 ${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} SCHEMA .*price NUMERIC SORTABLE`),
      );
      await page.getByTestId('wizard-create').click();
      const dlg = page.getByTestId('confirmation-dialog');
      await expect(dlg.getByTestId('confirmation-preview')).toContainText('FT.CREATE');
      await confirmDialog(page);
      await expect(page.getByTestId('search-index-detail')).toBeVisible();
      await expect(page.getByTestId('search-index-docs')).toHaveText('3', { timeout: 15_000 });
      await page.getByTestId('search-index-query').click();
      await page.getByTestId('search-query').fill('@name:gadget');
      await page.getByTestId('search-sort').selectOption('price');
      await page.getByTestId('search-sort-order').selectOption('DESC');
      await page.getByTestId('search-run').click();
      const results = page.getByTestId('search-results');
      await expect(results).toContainText('3 results');
      await expect(results.locator('tbody tr').first()).toContainText('Blue gadget 3');
      await page.getByTestId('search-explain').click();
      await expect(page.locator('[data-testid="result-rich"][data-kind="explain"] [data-testid="plan-tree"]')).toContainText('gadget');
      await page.getByTestId('search-run').click();
      await expect(results).toContainText('3 results');
      await results.getByTestId('search-open-doc').first().click();
      await expect(page.getByTestId('key-detail').locator('h2')).toHaveText(`${prefix}3`);
      // Admin drop: typed index name, documents kept.
      await gotoView(page, DB.e2e, 'diagnostics/search?panel=indexes');
      await page.getByRole('button', { name: index, exact: true }).click();
      await page.getByTestId('search-index-drop').click();
      await expect(page.getByTestId('confirmation-dialog')).toContainText('indexed keys are kept');
      await confirmDialog(page);
      await expect(page.getByTestId('search-index-detail')).toHaveCount(0);
      expect(((await redisExec<unknown[]>(['FT._LIST'])) as unknown[]).map(String)).not.toContain(index);
      expect(Number(await redisExec(['EXISTS', `${prefix}1`, `${prefix}2`, `${prefix}3`]))).toBe(3);
    } finally {
      await redisExec(['FT.DROPINDEX', index]).catch(() => undefined);
      await redisExec(['DEL', `${prefix}1`, `${prefix}2`, `${prefix}3`]).catch(() => undefined);
    }
  });

  test('prod: an import asks for the typed database name and a reason', async ({ page }) => {
    const key = `${RUN}prod`;
    try {
      await gotoView(page, DB.prodSim, 'guided?tab=import');
      await page.getByTestId('import-text').fill(`SET ${key} 1\nEXPIRE ${key} 600`);
      await page.getByTestId('import-check').click();
      await page.getByTestId('import-start').click();
      await expect(page.getByTestId('confirmation-typed')).toBeVisible();
      await confirmDialog(page, { reason: 'e2e prod import' });
      await expect(page.getByTestId('import-status')).toHaveAttribute('data-state', 'done');
    } finally {
      await redisExec(['DEL', key], 1).catch(() => undefined);
    }
  });
});

test.describe('as operator', () => {
  test.use({ role: 'operator' });

  test('import: policy plan, one confirmation, progress and a per-command failure summary', async ({ page }) => {
    const script = [`# e2e import`, `HSET ${RUN}h name "two words"`, `SET ${RUN}s 1`, `INCR ${RUN}s`, `LPUSH ${RUN}h nope`, `EXPIRE ${RUN}h 600`, `EXPIRE ${RUN}s 600`].join('\n');
    try {
      await gotoView(page, DB.e2e, 'guided?tab=import');
      await page.getByTestId('import-file').setInputFiles({ name: 'seed.redis', mimeType: 'text/plain', buffer: Buffer.from(script) });
      await page.getByTestId('import-check').click();
      const plan = page.getByTestId('import-plan');
      await expect(plan).toContainText('6 write');
      await expect(plan).toContainText('0 refused');
      await page.getByTestId('import-start').click();
      await confirmDialog(page);
      const status = page.getByTestId('import-status');
      await expect(status).toHaveAttribute('data-state', 'done');
      await expect(page.getByTestId('import-counts')).toContainText('6 of 6 sent · 5 succeeded · 1 failed');
      await expect(status).toContainText('LPUSH');
      await expect(status).toContainText('WRONGTYPE');
      expect(String(await redisExec(['HGET', `${RUN}h`, 'name']))).toBe('two words');
      expect(String(await redisExec(['GET', `${RUN}s`]))).toBe('2');
    } finally {
      await redisExec(['DEL', `${RUN}h`, `${RUN}s`]).catch(() => undefined);
    }
  });

  test('workbench: Table, Chart and Plan views for search, TimeSeries and explain replies', async ({ page }) => {
    await gotoView(page, DB.e2e, 'workbench');
    await setEditor(page, [`FT.SEARCH ${K.searchIndex} "@title:gadget" LIMIT 0 5`, `TS.RANGE ${K.ts} - +`, `FT.PROFILE ${K.searchIndex} SEARCH QUERY "@title:gadget @price:[1 10]" LIMIT 0 3`].join('\n'), 'workbench-editor');
    await page.getByTestId('workbench-run').click();
    await expect(page.getByTestId('console-result')).toHaveCount(3);
    await page.getByTestId('reply-view-tree').click();
    await expect(page.locator('[data-testid="result-rich"][data-kind="search"]')).toContainText('Blue gadget');
    await expect(page.locator('[data-testid="result-rich"][data-kind="series"] canvas').first()).toBeVisible();
    // FT.PROFILE is in @read (FT.EXPLAIN only in @search, which the operator's Redis user lacks here).
    await expect(page.locator('[data-testid="result-rich"][data-kind="profile"] [data-testid="plan-tree"]').first()).toContainText(/INTERSECT|UNION|TEXT|NUMERIC/);
    await page.getByTestId('reply-view-terminal').click();
    await expect(page.getByTestId('result-rich')).toHaveCount(0);
  });

  test('wizard: creation follows the Redis ACL user of the role (operator lacks FT.CREATE here)', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/search?panel=create');
    await page.getByTestId('wizard-prefix').fill(K.docPrefix);
    await page.getByTestId('wizard-sample').click();
    await expect(page.getByTestId('wizard-sampled')).toContainText(/keys sampled/);
    await expect(page.getByTestId('wizard-sampled').locator('..')).toContainText(K.searchIndex);
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-index-name').fill(`idx:${RUN}never`.replace(/:+$/, ''));
    await page.getByTestId('wizard-create').click();
    await confirmDialog(page);
    await expect(page.locator('main [role=alert]').filter({ hasText: 'NOPERM' })).toBeVisible();
  });
});

test.describe('as viewer', () => {
  test.use({ role: 'viewer' });

  test('analysis: progress, recommendations qualified by the sample, history and comparison', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/analysis');
    await page.getByTestId('analysis-pattern').fill('e2e:*');
    await page.getByTestId('analysis-run').click();
    await expect(page.getByTestId('analysis-report')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('analysis-coverage')).toContainText(/Based on [\d,]+ sampled keys of [\d,]+ in the database/);
    const big = page.locator('[data-testid="analysis-recommendation"][data-rule="bigKeys"]');
    await expect(big).toContainText(K.big);
    await expect(big).toContainText(/of [\d,]+ sampled keys/);
    await expect(page.locator('[data-testid="analysis-recommendation"][data-rule="hashTooManyFields"]')).toContainText(K.bigHash);
    await page.getByTestId('analysis-pattern').fill('e2e:string:*');
    await page.getByTestId('analysis-run').click();
    await expect(page.getByTestId('analysis-coverage')).toContainText('e2e:string:*');
    await page.getByTestId('analysis-compare').selectOption({ index: 1 });
    await expect(page.getByTestId('analysis-comparison')).toContainText('different patterns');
  });

  test('search: sorted, returned fields, table and JSON views, saved queries; creation is not offered', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/search');
    await page.getByTestId('search-index').selectOption(K.searchIndex);
    await page.getByTestId('search-query').fill('@category:{toys}');
    await page.getByTestId('search-sort').selectOption('price');
    await page.getByTestId('search-sort-order').selectOption('DESC');
    await page.getByTestId('search-return').getByLabel('title', { exact: true }).check();
    await expect(page.getByTestId('search-command')).toContainText('RETURN 1 title SORTBY price DESC LIMIT 0 20');
    await page.getByTestId('search-run').click();
    const results = page.getByTestId('search-results');
    await expect(results).toContainText('6 results');
    await page.getByTestId('search-view').getByRole('tab', { name: 'JSON' }).click();
    await expect(results.locator('.json-tree').first()).toBeVisible();
    await page.getByTestId('search-save-name').fill('toys');
    await page.getByTestId('search-save').click();
    await expect(page.getByTestId('search-saved')).toContainText('toys');
    // The viewer's Redis user may not run FT.EXPLAIN (@search only): the denial says so and points to Profile.
    await page.getByTestId('search-explain').click();
    await expect(page.locator('main [role=alert]').filter({ hasText: 'Profile query shows the plan' })).toBeVisible();
    await page.getByTestId('search-profile').click();
    await expect(page.locator('[data-testid="result-rich"][data-kind="profile"]')).toBeVisible();
    await expect(page.getByTestId('plan-tree').first()).toBeVisible();
    await page.getByTestId('search-panel-create').click();
    await page.getByTestId('wizard-prefix').fill(K.docPrefix);
    await page.getByTestId('wizard-sample').click();
    await page.getByTestId('wizard-next').click();
    await expect(page.getByTestId('wizard-create')).toBeDisabled();
  });

  test('tutorials insert into the workbench; the palette has direct Search destinations', async ({ page }) => {
    await gotoView(page, DB.e2e, 'workbench');
    await page.getByTestId('workbench-tutorials').click();
    await expect(page).toHaveURL(/guided\?tab=tutorials$/);
    await page.getByTestId('tutorial-timeseries').click();
    await page.getByTestId('tutorial-insert').first().click();
    await expect(page).toHaveURL(/\/workbench$/);
    await expect(page.getByTestId('workbench-editor-input')).toContainText('TS.CREATE tutorial:temp:kitchen');
    await page.getByTestId('command-palette-open').click();
    await page.getByTestId('command-palette-search').fill('Search: indexes');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/diagnostics\/search\?panel=indexes$/);
  });

  test('import: hidden for a viewer (operator and above)', async ({ page }) => {
    await gotoView(page, DB.e2e, 'guided?tab=import');
    await expect(page.getByTestId('guided-tab-tasks')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('guided-tab-import')).toHaveCount(0);
    await expect(page.getByTestId('import-panel')).toHaveCount(0);
  });
});
