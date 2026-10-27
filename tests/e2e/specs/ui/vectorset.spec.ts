/**
 * v0.4 (F23): the vector-set inspector. Viewers read (summary, member pages, prefix filter, lazy attributes, member
 * panel, similarity search); operators also edit attributes (compare-and-set) and remove members (confirmation).
 * The page fixture fails a test on any CSP violation, console error or page error.
 */
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';
import { confirmDialog, gotoView, openKey } from '../../lib/ui.ts';

const RUN = `${K.scratchPrefix}vset:${Date.now().toString(36)}:`;
const HOSTILE = '<img src=x onerror=alert(1)>';

/** 150 members `m000`…`m149` with 3-dimensional vectors (every third with attributes), plus one hostile name. */
async function seed(key: string) {
  for (let i = 0; i < 150; i++) {
    const v = [Math.cos(i), Math.sin(i), (i % 7) / 7].map((x) => x.toFixed(4));
    const args = ['VADD', key, 'VALUES', '3', ...v, `m${String(i).padStart(3, '0')}`];
    if (i % 3 === 0) args.push('SETATTR', JSON.stringify({ i, even: i % 2 === 0 }));
    await redisExec(args);
  }
  await redisExec(['VADD', key, 'VALUES', '3', '1', '0', '0', HOSTILE]);
}

test.describe('as viewer', () => {
  test.use({ role: 'viewer' });

  test('summary, member pages, prefix filter, attributes, member panel and similarity search, read only', async ({ page }) => {
    const key = `${RUN}viewer`;
    await seed(key);
    try {
      await gotoView(page, DB.e2e, 'keys');
      const detail = await openKey(page, key);
      const summary = detail.getByTestId('vset-summary');
      await expect(summary).toContainText('151');
      await expect(summary).toContainText('Dimensions');
      const members = detail.getByTestId('vset-members');
      await expect(members.locator('tbody tr')).toHaveCount(100);
      // Byte order puts "<" before "m"; the hostile name is text, never markup.
      await expect(members.locator('tbody tr').first()).toContainText(HOSTILE);
      await expect(detail.locator('img')).toHaveCount(0);
      await expect(members.locator('tbody tr').filter({ hasText: 'm000' }).getByTestId('vset-attr-cell')).toContainText('"even":true');
      await expect(detail.getByTestId('vset-remove')).toHaveCount(0);
      await detail.getByTestId('vset-next-page').click();
      await expect(members.locator('tbody tr')).toHaveCount(51);
      await expect(detail.getByTestId('vset-page-note')).toContainText('101–151');
      await detail.getByTestId('vset-prev-page').click();
      await expect(members.locator('tbody tr')).toHaveCount(100);
      await detail.getByTestId('vset-prefix').fill('m14');
      await detail.getByTestId('vset-prefix-apply').click();
      await expect(members.locator('tbody tr')).toHaveCount(10);
      await expect(members.locator('tbody tr').first()).toContainText('m140');
      await detail.getByTestId('vset-prefix-clear').click();

      await members.getByRole('button', { name: 'Open member m003' }).click();
      const dialog = page.getByTestId('vset-element-dialog');
      await expect(dialog.getByTestId('vset-element-name')).toHaveText('m003');
      await expect(dialog.getByTestId('vset-attributes')).toContainText('even');
      await expect(dialog.getByTestId('vset-embedding')).toContainText('3 of 3 values');
      await expect(dialog.getByTestId('vset-links')).toBeVisible();
      await expect(dialog.getByTestId('vset-attr-edit')).toHaveCount(0);
      await expect(dialog.getByTestId('vset-element-remove')).toHaveCount(0);
      await dialog.getByTestId('vset-find-similar').click();
      await expect(detail.getByTestId('vset-search-command')).toContainText('VSIM');
      await detail.getByTestId('vset-search-submit').click();
      const results = detail.getByTestId('vset-search-results');
      await expect(results.locator('tbody tr')).toHaveCount(10);
      await expect(results.locator('tbody tr').first()).toContainText('m003');

      await detail.getByTestId('vset-search-by-vector').check();
      await detail.getByTestId('vset-search-vector').fill('1, 0');
      await expect(detail.getByText('This set has 3 dimensions; the vector has 2.')).toBeVisible();
      await expect(detail.getByTestId('vset-search-submit')).toBeDisabled();
      await detail.getByTestId('vset-search-vector').fill('1, 0, 0');
      await detail.getByTestId('vset-search-count').fill('5');
      // Redis filter booleans are truthy values (`.even`); `== true` is a syntax error the form reports.
      await detail.getByTestId('vset-search-filter').fill('.even == true');
      await detail.getByTestId('vset-search-submit').click();
      // The filter's text is not repeated in the message (it would reach the audit log; review v0.4 r2 M1).
      await expect(detail.getByRole('alert')).toContainText('Invalid filter expression: Redis could not read it');
      await expect(detail.getByRole('alert')).not.toContainText('even == true');
      await expect(results).toHaveCount(0);
      await detail.getByTestId('vset-search-filter').fill('.even');
      await detail.getByTestId('vset-search-submit').click();
      // The filtered search: at most 5 results, each with even == true.
      await expect.poll(() => results.locator('tbody tr').count()).toBeLessThanOrEqual(5);
      await expect(results.locator('tbody tr').first()).toBeVisible();
      for (const text of await results.locator('tbody tr').allInnerTexts()) expect(text).toContain('"even":true');
    } finally {
      await redisExec(['DEL', key]).catch(() => undefined);
    }
  });
});

test.describe('as operator', () => {
  test.use({ role: 'operator' });

  test('edit attributes with compare-and-set, refuse non-JSON, and remove a member with confirmation', async ({ page }) => {
    const key = `${RUN}operator`;
    await seed(key);
    try {
      await gotoView(page, DB.e2e, 'keys');
      const detail = await openKey(page, key);
      const members = detail.getByTestId('vset-members');
      await members.getByRole('button', { name: 'Open member m003' }).click();
      let dialog = page.getByTestId('vset-element-dialog');
      await dialog.getByTestId('vset-attr-edit').click();
      const field = dialog.getByLabel('Attributes (JSON; empty removes them)');
      await field.fill('not json');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toContainText('Attributes must be JSON');
      await field.fill('{"i":3,"tag":"edited"}');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog.getByTestId('vset-attributes')).toContainText('edited');
      expect(String(await redisExec(['VGETATTR', key, 'm003']))).toBe('{"i":3,"tag":"edited"}');

      // Someone else changes the attributes after the editor opened: the save is a conflict, not an overwrite.
      await dialog.getByTestId('vset-attr-edit').click();
      await redisExec(['VSETATTR', key, 'm003', '{"changed":true}']);
      await dialog.getByLabel('Attributes (JSON; empty removes them)').fill('{"mine":1}');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog.getByTestId('edit-conflict')).toContainText('changed');
      expect(String(await redisExec(['VGETATTR', key, 'm003']))).toBe('{"changed":true}');
      await dialog.getByTestId('edit-conflict-overwrite').click();
      await expect(dialog.getByTestId('vset-attributes')).toContainText('mine');
      expect(String(await redisExec(['VGETATTR', key, 'm003']))).toBe('{"mine":1}');

      await dialog.getByTestId('vset-element-remove').click();
      await confirmDialog(page);
      await expect(dialog).toBeHidden();
      expect(Number(await redisExec(['VISMEMBER', key, 'm003']))).toBe(0);
      expect(Number(await redisExec(['VCARD', key]))).toBe(150);

      await members.getByRole('button', { name: 'Open member m006' }).click();
      dialog = page.getByTestId('vset-element-dialog');
      await expect(dialog.getByTestId('vset-element-name')).toHaveText('m006');
    } finally {
      await redisExec(['DEL', key]).catch(() => undefined);
    }
  });
});

test.describe('as admin', () => {
  test.use({ role: 'admin' });

  test('removes a member from its row after confirming', async ({ page }) => {
    const key = `${RUN}admin`;
    await seed(key);
    try {
      await gotoView(page, DB.e2e, 'keys');
      const detail = await openKey(page, key);
      const row = detail.getByTestId('vset-members').locator('tbody tr').filter({ hasText: 'm010' });
      await row.getByTestId('vset-remove').click();
      await confirmDialog(page);
      await expect(detail.getByTestId('vset-members').locator('tbody tr').filter({ hasText: 'm010' })).toHaveCount(0);
      expect(Number(await redisExec(['VISMEMBER', key, 'm010']))).toBe(0);
    } finally {
      await redisExec(['DEL', key]).catch(() => undefined);
    }
  });
});
