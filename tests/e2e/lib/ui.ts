/** UI helpers built on the data-testids documented in apps/web/TESTIDS.md. */
import { expect, type Locator, type Page } from '@playwright/test';
import type { Account } from './api.ts';
import { freshTotp } from './totp.ts';
import { loginThrottle } from './throttle.ts';

export const dbUrl = (db: string, view = 'overview') => `/db/${encodeURIComponent(db)}/${view}`;

export async function gotoView(page: Page, db: string, view: string): Promise<void> {
  await page.goto(dbUrl(db, view));
  await expect(page.getByTestId('database-switcher')).toBeVisible();
  await expect(page.locator('main')).toBeVisible();
}

/** Local login through the login form (handles a TOTP prompt). Does not handle onboarding. */
export async function uiLogin(page: Page, acc: Pick<Account, 'username' | 'password' | 'totpSecret'>): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-username').fill(acc.username);
  await page.getByTestId('login-password').fill(acc.password);
  await loginThrottle();
  await page.getByTestId('login-submit').click();
  const totp = page.getByTestId('totp-code');
  const shell = page.getByTestId('database-switcher').or(page.getByTestId('database-landing'));
  const forced = page.getByTestId('current-password').or(page.getByTestId('totp-enroll'));
  await expect(totp.or(shell).or(forced).first()).toBeVisible({ timeout: 15_000 });
  if (await totp.isVisible()) {
    if (!acc.totpSecret) throw new Error('TOTP prompt but no secret');
    await totp.fill(await freshTotp(acc.totpSecret));
    await loginThrottle();
    await page.getByTestId('totp-submit').click();
  }
}

/** Signed in: either the database picker landing page or a database view. */
export async function expectShell(page: Page): Promise<void> {
  await expect(page.getByTestId('database-switcher').or(page.getByTestId('database-landing')).first()).toBeVisible({ timeout: 15_000 });
}

/** Escapes Redis glob metacharacters so a key name can be used as an exact SCAN pattern. */
export const globEscape = (s: string) => s.replace(/[*?[\]\\]/g, (c) => `\\${c}`);

/** Scans for exactly `key` (or `pattern`) in the key browser and opens the matching row. */
export async function openKey(page: Page, key: string, opts: { pattern?: string; rowText?: string | RegExp } = {}): Promise<Locator> {
  await page.getByTestId('key-pattern').fill(opts.pattern ?? globEscape(key));
  await page.getByTestId('key-scan').click();
  const row = page.getByTestId('key-list').getByTestId('key-row').filter({ hasText: opts.rowText ?? lastSegment(key) }).first();
  await expect(row).toBeVisible();
  await row.click();
  const detail = page.getByTestId('key-detail');
  await expect(detail.locator('h2')).toBeVisible();
  return detail;
}
const lastSegment = (k: string) => k.split(':').pop() || k;

/** Value formatter tabs (`value-format` tablist): text, json, tree, hex, base64, msgpack. */
const FORMAT_TABS: Record<string, string> = { text: 'Text', json: 'JSON', tree: 'Tree', hex: 'Hex', base64: 'Base64', msgpack: 'MsgPack' };
export async function selectFormat(scope: Locator, format: string): Promise<void> {
  const tab = scope.getByTestId('value-format').getByRole('tab', { name: FORMAT_TABS[format] ?? format, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

export async function consoleRun(page: Page, line: string, testId = 'console-editor'): Promise<void> {
  const input = page.getByTestId(`${testId}-input`);
  await input.click();
  await input.fill(line);
  await page.keyboard.press(testId === 'console-editor' ? 'Enter' : 'ControlOrMeta+Enter');
}

export async function setEditor(page: Page, text: string, testId = 'console-editor'): Promise<void> {
  const input = page.getByTestId(`${testId}-input`);
  await input.click();
  await input.fill(text);
}

/** Completes the universal confirmation dialog shown for every 428. */
export async function confirmDialog(page: Page, opts: { typed?: boolean; reason?: string } = {}): Promise<Locator> {
  const dlg = page.getByTestId('confirmation-dialog');
  await expect(dlg).toBeVisible();
  const typed = dlg.getByTestId('confirmation-typed');
  if (await typed.isVisible()) {
    const label = await dlg.locator('label').filter({ has: page.getByTestId('confirmation-typed') }).innerText();
    const expected = /“(.+)”/.exec(label)?.[1];
    if (!expected) throw new Error(`cannot find expected text in: ${label}`);
    await expect(dlg.getByTestId('confirmation-submit')).toBeDisabled();
    await typed.fill(expected);
  }
  const reason = dlg.getByTestId('confirmation-reason');
  if (await reason.isVisible()) {
    await expect(dlg.getByTestId('confirmation-submit')).toBeDisabled();
    await reason.fill(opts.reason ?? 'E2E test change');
  }
  await dlg.getByTestId('confirmation-submit').click();
  await expect(dlg).toBeHidden();
  return dlg;
}
