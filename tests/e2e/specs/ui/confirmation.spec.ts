/** Confirmation flow in the UI: 428 -> dialog -> typed confirmation -> reason (prod), and cancel. */
import { test, expect } from '../../lib/test.ts';
import { Api } from '../../lib/api.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';
import { confirmDialog, consoleRun, gotoView, openKey } from '../../lib/ui.ts';

test.use({ role: 'operator' });

test('prod database: banner, typed database name and reason are required; reason lands in audit', async ({ page }) => {
  await gotoView(page, DB.prodSim, 'console');
  await expect(page.getByRole('status').filter({ hasText: /Production database/ })).toBeVisible();
  const reason = `UI-REASON-${Date.now()}`;
  // SET has no shared rule: the console classifies it from the database's command catalog (GET …/commands). Enter
  // right after the page appears may beat that request; the console then holds the command ("Loading command
  // info…") and runs it when the catalog arrives (v0.3 follow-up 7), so no wait is needed here.
  await consoleRun(page, `SET ${K.prodSimKey} from-ui`);
  const dlg = page.getByTestId('confirmation-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('confirmation-typed')).toBeVisible();
  await expect(dlg.getByTestId('confirmation-reason')).toBeVisible();
  await expect(dlg.getByTestId('confirmation-submit')).toBeDisabled();
  await dlg.getByTestId('confirmation-typed').fill('wrong name');
  await dlg.getByTestId('confirmation-reason').fill(reason);
  await expect(dlg.getByTestId('confirmation-submit')).toBeDisabled();
  await dlg.getByTestId('confirmation-reason').fill('');
  await confirmDialog(page, { reason });
  await expect.poll(async () => String(await redisExec(['GET', K.prodSimKey], 1))).toBe('from-ui');
  const admin = await Api.fromStorage('admin');
  const a = await admin.get(`/api/v1/admin/audit?database=${DB.prodSim}&limit=20`);
  expect((a.json.events as any[]).some((e) => e.reason === reason)).toBe(true);
  await admin.dispose();
});

test('cancelling the dialog sends nothing and changes nothing', async ({ page }) => {
  const key = `${K.scratchPrefix}ui-cancel`;
  await redisExec(['SET', key, 'stay']);
  await gotoView(page, DB.e2e, 'console');
  await consoleRun(page, `DEL ${key}`);
  const dlg = page.getByTestId('confirmation-dialog');
  await expect(dlg).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  expect(await redisExec(['EXISTS', key])).toBe(1);
});

test('prod key edit from the key browser requires the reason too', async ({ page }) => {
  await gotoView(page, DB.prodSim, 'keys');
  const d = await openKey(page, 'e2e:prodsim:hash', { rowText: 'hash' });
  await d.getByTestId('key-edit').click();
  const ed = page.getByTestId('key-editor-dialog');
  await ed.getByTestId('key-edit-field').fill('b');
  await ed.getByTestId('key-edit-value').fill('2');
  await ed.getByTestId('key-save').click();
  await confirmDialog(page, { reason: 'UI prod hash edit' });
  await expect.poll(async () => String(await redisExec(['HGET', 'e2e:prodsim:hash', 'b'], 1))).toBe('2');
});
