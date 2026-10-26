/** Admin UI: audit log (entries, filters, redaction) and local user management. */
import { test, expect } from '../../lib/test.ts';
import { Api } from '../../lib/api.ts';
import { DB } from '../../lib/env.ts';
import { AUDIT_CANARY_VALUE, K } from '../../lib/fixtures-data.ts';
import { newPassword, uniqueName } from '../../lib/accounts.ts';
import { registerExtraSecret } from '../../lib/leak.ts';
import { expectShell, uiLogin } from '../../lib/ui.ts';
import { knownBug } from '../../lib/findings.ts';

test.use({ role: 'admin' });

test('audit log lists events and never shows values', async ({ page }) => {
  const op = await Api.fromStorage('operator');
  await op.post(`/api/v1/databases/${DB.e2e}/cli`, { line: `SET ${K.scratchPrefix}audit-ui ${AUDIT_CANARY_VALUE}` });
  await op.dispose();
  await page.goto('/admin/audit');
  const main = page.locator('main');
  await expect(main.locator('table')).toBeVisible();
  await expect(main).toContainText('e2e-operator');
  await expect(main).toContainText(/bytes>/);
  expect(await main.innerText()).not.toContain(AUDIT_CANARY_VALUE);
  // Filters
  await page.getByTestId('audit-user-filter').fill('e2e-operator');
  await page.getByTestId('audit-outcome-filter').selectOption('allowed');
  await page.getByTestId('audit-filter').click();
  await expect(main.locator('tbody tr').first()).toContainText('e2e-operator');
  for (const row of (await main.locator('tbody tr').allInnerTexts()).slice(0, 20)) expect(row).toContain('e2e-operator');
});

test('audit log and user management are admin-only in the UI', async ({ browser }) => {
  for (const role of ['viewer', 'operator']) {
    const ctx = await browser.newContext({ storageState: (await import('../../lib/api.ts')).storageFile(role) });
    const p = await ctx.newPage();
    await p.goto('/admin/audit');
    await expectShell(p);
    await expect(p.getByTestId('nav-audit')).toHaveCount(0);
    await expect(p.locator('main table')).toHaveCount(0);
    await ctx.close();
  }
});

test('user editor renders and validates without console errors', async ({ page, guards }) => {
  await page.goto('/admin/users');
  await page.getByTestId('user-add').click();
  const username = page.getByTestId('user-editor-dialog').getByTestId('user-username');
  await username.fill('valid.name-1');
  // The browser compiles the pattern attribute when it validates the field.
  await username.evaluate((el: HTMLInputElement) => el.checkValidity());
  await page.waitForTimeout(300);
  expect(guards.consoleErrors).toEqual([]);
});

test('create a user, change role, disable and re-enable', async ({ page, browser, guards }) => {
  const username = uniqueName('ui-user');
  const pw = newPassword();
  registerExtraSecret(`password:${username}:initial`, pw);
  await page.goto('/admin/users');
  await page.getByTestId('user-add').click();
  const dlg = page.getByTestId('user-editor-dialog');
  await dlg.getByTestId('user-username').fill(username);
  await dlg.getByTestId('user-display-name').fill('UI Created');
  await dlg.getByTestId('user-role').selectOption('viewer');
  await dlg.getByTestId('user-password').fill(pw);
  await dlg.getByTestId('user-save').click();
  await expect(dlg).toBeHidden();
  const row = page.locator('main tr', { hasText: username });
  await expect(row).toContainText('viewer');

  // New user must change the password at first login.
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const p = await ctx.newPage();
  await uiLogin(p, { username, password: pw });
  await expect(p.getByTestId('current-password')).toBeVisible();
  await ctx.close();

  // Change role to operator.
  await row.getByTestId('user-edit').click();
  await dlg.getByTestId('user-role').selectOption('operator');
  await dlg.getByTestId('user-save').click();
  await expect(row).toContainText('operator');

  // Disable: login refused.
  await row.getByTestId('user-edit').click();
  await dlg.getByTestId('user-disabled').check();
  await dlg.getByTestId('user-save').click();
  await expect(row).toContainText(/disabled/i);
  const anon = await Api.anonymous();
  const r = await anon.post('/api/v1/auth/login', { username, password: pw }, { csrf: null });
  expect(r.status).toBe(401);
  await anon.dispose();

  // Re-enable.
  await row.getByTestId('user-edit').click();
  await dlg.getByTestId('user-disabled').uncheck();
  await dlg.getByTestId('user-save').click();
  await expect(row).not.toContainText(/disabled/i);
});

test('reset TOTP forces re-enrollment', async ({ page, browser }) => {
  const admin = await Api.fromStorage('admin');
  const { createUser } = await import('../../lib/accounts.ts');
  const { acc } = await createUser(admin, uniqueName('ui-totp'), 'admin');
  await admin.dispose();
  await page.goto('/admin/users');
  const row = page.locator('main tr', { hasText: acc.username });
  await row.getByTestId('user-edit').click();
  const dlg = page.getByTestId('user-editor-dialog');
  await dlg.getByTestId('user-reset-totp').check();
  await dlg.getByTestId('user-save').click();
  await expect(dlg).toBeHidden();
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const p = await ctx.newPage();
  await uiLogin(p, { username: acc.username, password: acc.password });
  await expect(p.getByTestId('totp-enroll')).toBeVisible();
  await ctx.close();
  void expectShell;
});
