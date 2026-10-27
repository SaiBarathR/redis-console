/**
 * v0.4 arrays (F24): the array inspector in Chromium for every role, with Redis readback. CSP, console, dialog and
 * leak guards come from lib/test. Reads use the seeded sparse array (K.array); writes use per-role scratch arrays.
 */
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';
import { confirmDialog, gotoView, openKey } from '../../lib/ui.ts';

const text = (v: unknown) => (Buffer.isBuffer(v) ? v.toString() : v == null ? null : String(v));

for (const role of ['viewer', 'operator', 'admin'] as const) {
  test.describe(`arrays as ${role}`, () => {
    test.use({ role });
    const scratch = `${K.scratchPrefix}array:${role}`;
    test.beforeAll(async () => {
      await redisExec(['UNLINK', scratch, `${scratch}:created`]);
      await redisExec(['ARSET', scratch, 0, 'a', 'b', 'c', 'd', 'e']);
    });
    test.afterAll(async () => { await redisExec(['UNLINK', scratch, `${scratch}:created`]); });

    test('summary, gaps between indices, paging, search and aggregates', async ({ page }) => {
      await gotoView(page, DB.e2e, 'keys');
      const detail = await openKey(page, K.array);
      const array = detail.getByTestId('array-detail');
      await expect(array.getByTestId('array-count')).toHaveText('5');
      await expect(array.getByTestId('array-length')).toHaveText('9,007,199,254,740,994');
      await expect(array.getByTestId('array-row')).toHaveCount(5);
      await expect(array.getByTestId('array-gap')).toHaveText(['⋯ 997 empty positions: 3–999', '⋯ 9,007,199,254,739,992 empty positions: 1001–9007199254740992']);
      await expect(array.getByTestId('array-table')).toContainText('9007199254740993');
      // Jump, then back; the last page starts with the highest index.
      await array.getByTestId('array-jump-input').fill('500');
      await array.getByTestId('array-jump').click();
      await expect(array.getByTestId('array-row').first()).toContainText('1000');
      await array.getByTestId('array-prev').click();
      await expect(array.getByTestId('array-row').first()).toContainText('alpha');
      await array.getByTestId('array-last').click();
      await expect(array.getByTestId('array-row').first()).toContainText('9007199254740993');
      // Search (MATCH, case-insensitive) and an aggregate over the whole array.
      await array.getByText('Search values', { exact: true }).click();
      await array.getByTestId('array-search-value').fill('A');
      await array.getByTestId('array-search-nocase').check();
      await array.getByTestId('array-search-submit').click();
      await expect(array.getByTestId('array-search-summary')).toContainText('4 matches in indices 0–9007199254740993 (5 elements searched)');
      await expect(array.getByTestId('array-search-kind').first().locator('option')).toHaveText(['Equals (EXACT)', 'Contains (MATCH)', 'Glob pattern (GLOB)']);
      await array.getByText('Aggregate a range (AROP)').click();
      await array.getByTestId('array-aggregate-op').selectOption('used');
      await array.getByTestId('array-aggregate-submit').click();
      await expect(array.getByTestId('array-aggregate-result')).toContainText('(5 elements): 5');
      // Write controls follow the role.
      const writer = role !== 'viewer';
      await expect(array.getByTestId('array-row-edit')).toHaveCount(writer ? 5 : 0);
      await expect(array.getByTestId('array-row-delete')).toHaveCount(writer ? 5 : 0);
      for (const id of ['array-append', 'array-set', 'array-delete-range']) await expect(array.getByTestId(id)).toHaveCount(writer ? 1 : 0);
      await expect(detail.getByTestId('key-edit')).toHaveCount(0);
    });

    test('edits, conflicts, appends and confirmed deletes', async ({ page }) => {
      test.skip(role === 'viewer', 'viewers have no write controls (checked above)');
      await gotoView(page, DB.e2e, 'keys');
      const detail = await openKey(page, scratch);
      const array = detail.getByTestId('array-detail');
      // Row edit with compare-and-set; then another client's write shows the conflict, and Overwrite anyway wins.
      await array.getByRole('button', { name: 'Edit index 1' }).click();
      await array.getByLabel('Value at index 1').fill('b2');
      await array.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(array.getByTestId('array-row').nth(1)).toContainText('b2');
      expect(text(await redisExec(['ARGET', scratch, 1]))).toBe('b2');
      await array.getByRole('button', { name: 'Edit index 1' }).click();
      await redisExec(['ARSET', scratch, 1, 'theirs']);
      await array.getByLabel('Value at index 1').fill('mine');
      await array.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(array.getByTestId('edit-conflict-current')).toHaveText('theirs');
      expect(text(await redisExec(['ARGET', scratch, 1]))).toBe('theirs');
      await array.getByTestId('edit-conflict-overwrite').click();
      await expect(array.getByTestId('edit-conflict')).toHaveCount(0);
      expect(text(await redisExec(['ARGET', scratch, 1]))).toBe('mine');
      // Append: the cursor of an ARSET-built array is 0, so ARINSERT would overwrite: refused, nothing written.
      await array.getByText('Append values (ARINSERT)').click();
      await array.getByTestId('array-append-values').fill('x');
      await array.getByTestId('array-append-submit').click();
      await expect(array.getByTestId('array-append').getByRole('alert')).toContainText('ARINSERT would overwrite 1 existing element');
      expect(text(await redisExec(['ARGET', scratch, 0]))).toBe('a');
      // Set at the first empty index (the default: the length).
      await array.getByText('Set value at index (ARSET)').click();
      await expect(array.getByTestId('array-set-index')).toHaveValue('5');
      await array.getByTestId('array-set-value').fill('f');
      await array.getByTestId('array-set-submit').click();
      await expect(array.getByTestId('array-count')).toHaveText('6');
      // Delete one index and a range, each after the server's confirmation of the exact command.
      await array.getByRole('button', { name: 'Delete index 0' }).click();
      const dlg = page.getByTestId('confirmation-dialog');
      await expect(dlg.getByTestId('confirmation-command')).toHaveText(new RegExp(`ARDEL\\s*${scratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*0`));
      await confirmDialog(page);
      await expect(array.getByTestId('array-count')).toHaveText('5');
      expect(await redisExec(['ARGET', scratch, 0])).toBeNull();
      await array.getByText('Delete a range (ARDELRANGE)').click();
      await array.getByTestId('array-delete-range-start').fill('1');
      await array.getByTestId('array-delete-range-end').fill('3');
      await array.getByTestId('array-delete-range-submit').click();
      await expect(dlg.getByTestId('confirmation-note')).toContainText('3 elements existed in this range');
      await expect(dlg.getByTestId('confirmation-command')).toContainText('ARDELRANGE');
      await confirmDialog(page);
      await expect(array.getByTestId('array-count')).toHaveText('2');
      expect(await redisExec(['ARCOUNT', scratch])).toBe(2);
    });

    test('create an array from the key form; creating it again changes nothing', async ({ page }) => {
      test.skip(role === 'viewer', 'viewers cannot create keys');
      await gotoView(page, DB.e2e, 'keys');
      for (const attempt of [1, 2]) {
        await page.getByTestId('key-add').click();
        await page.getByTestId('key-create-type').selectOption('array');
        await page.getByTestId('key-create-name').fill(`${scratch}:created`);
        await page.getByTestId('key-edit-value').fill(attempt === 1 ? 'one\ntwo' : 'other');
        await page.getByTestId('key-save').click();
        if (attempt === 1) await expect(page.getByTestId('key-editor-dialog')).toHaveCount(0);
        else await expect(page.getByTestId('key-editor-dialog').getByRole('alert')).toContainText('already exists');
      }
      expect(await redisExec(['ARCOUNT', `${scratch}:created`])).toBe(2);
      expect([text(await redisExec(['ARGET', `${scratch}:created`, 0])), text(await redisExec(['ARGET', `${scratch}:created`, 1]))]).toEqual(['one', 'two']);
    });
  });
}
