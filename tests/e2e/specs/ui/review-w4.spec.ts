/** Final web review: real Chromium clipboard, redis-cli display and re-run byte fidelity. */
import { readFileSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import { binFromBytes, bytesFromBin, tokenizeCommandLineBytes, type Bin, type CliResponse } from '@rconsole/shared';
import { test, expect } from '../../lib/test.ts';
import { DB, E2E_REDIS } from '../../lib/env.ts';
import { redisExec } from '../../lib/fixtures-data.ts';
import { consoleRun, gotoView, selectFormat, uiLogin } from '../../lib/ui.ts';

const live = process.env.WEBFIX4_LIVE === '1';
const prefix = 'e2e:scratch:w4:';
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();
const keys: Buffer[] = [];
const quote = (bytes: Buffer) => '"' + [...bytes].map(b => `\\x${b.toString(16).padStart(2, '0')}`).join('') + '"';
const raw = (bin: Bin) => Buffer.from(bytesFromBin(bin));
async function run(page: Page, line: string): Promise<CliResponse> {
  const response = page.waitForResponse(r => r.url().endsWith('/cli') && r.request().method() === 'POST');
  await consoleRun(page, line);
  const res = await response;
  expect(res.status()).toBe(200);
  await expect(page.getByTestId('console-running')).toHaveCount(0);
  return res.json();
}
/** Native paste gives the clipboard text before an editor normalizes CRLF/CR. No clipboard-read permission. */
async function paste(page: Page) {
  const input = page.getByTestId('console-editor-input');
  await input.fill('');
  await input.evaluate(el => {
    (window as any).__w4Paste = undefined;
    el.addEventListener('paste', event => { (window as any).__w4Paste = (event as ClipboardEvent).clipboardData?.getData('text/plain'); }, { once: true });
  });
  await input.focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
  await expect.poll(() => page.evaluate(() => (window as any).__w4Paste)).not.toBeUndefined();
  return page.evaluate(() => (window as any).__w4Paste as string);
}

test.describe('final web review byte fidelity', () => {
  test.use({ role: live ? null : 'operator', permissions: ['clipboard-read', 'clipboard-write'] });
  test.beforeEach(async ({ page }) => {
    expect([6411, 6431]).toContain(E2E_REDIS.port);
    // Only sandbox-e2e can receive browser writes in this spec; remote is never selected.
    await page.route('**/api/v1/databases/**', async route => {
      const db = new URL(route.request().url()).pathname.split('/')[4];
      if (db !== DB.e2e && route.request().method() !== 'GET') throw new Error(`Unexpected database request: ${db}`);
      await route.continue();
    });
    if (live) {
      const cached = sessions.get('operator');
      if (cached) await page.context().addCookies(cached.cookies);
      else {
        const accounts = JSON.parse(readFileSync(new URL('../../../../.qa/accounts.json', import.meta.url), 'utf8'));
        await uiLogin(page, accounts.local['qa-operator']);
        sessions.set('operator', await page.context().storageState());
      }
    }
    await gotoView(page, DB.e2e, 'console');
  });
  test.afterAll(async () => { if (keys.length) await redisExec(['DEL', ...keys]); });
  test.afterEach(async ({ page }, info) => { if (live) await page.screenshot({ path: info.outputPath('live.png'), fullPage: true }); });

  for (const [name, special] of [
    ['BOM', Buffer.from('\ufeff')], ['zero-width', Buffer.from('\u200b')],
    ['CR', Buffer.from('\r\n')], ['NUL', Buffer.from([0])], ['binary', Buffer.from([0xff, 0x80, 0])],
  ] as const) {
    test(`M1/M2: ${name} keys and values survive display, native copy/paste and re-run`, async ({ page }) => {
      const key = Buffer.concat([special, Buffer.from(`${prefix}${name}`)]);
      const value = Buffer.concat([special, Buffer.from('payload\\u000d"😀')]);
      const copy = Buffer.from(`${prefix}${name}-copy`);
      keys.push(key, copy);
      await redisExec(['SET', key, value]);
      const response = await run(page, `GET ${quote(key)}`);
      expect(response.reply.t).toBe('str');
      if (response.reply.t !== 'str') throw new Error('Expected bytes');
      expect(raw(response.reply.v).equals(value)).toBe(true);
      const result = page.getByTestId('console-result').last();
      const displayed = await result.locator('pre.cli-reply').textContent();
      expect(Buffer.from(tokenizeCommandLineBytes(displayed!)[0]!).equals(value)).toBe(true);
      await result.getByRole('button', { name: 'Copy result', exact: true }).click();
      await expect(result.getByRole('status')).toHaveText('Copy result: copied');
      const copied = await paste(page);
      expect(Buffer.from(tokenizeCommandLineBytes(copied)[0]!).equals(value)).toBe(true);
      await run(page, `SET ${quote(copy)} ${copied}`);
      expect(Buffer.from(await redisExec<Buffer>(['GET', copy])).equals(value)).toBe(true);
      const rerun = page.waitForResponse(r => r.url().endsWith('/cli'));
      await page.getByTestId('console-result').last().getByRole('button', { name: 'Re-run', exact: true }).click();
      expect((await rerun).status()).toBe(200);
      await expect(page.getByTestId('console-running')).toHaveCount(0);
      expect(Buffer.from(await redisExec<Buffer>(['GET', copy])).equals(value)).toBe(true);
      await run(page, `GET ${quote(key)}`);
      await page.getByTestId('console-result').last().getByRole('button', { name: /^Open key / }).click();
      const detail = page.getByTestId('key-detail');
      await expect(detail.locator('h2')).toBeVisible();
      const shownKey = await detail.locator('h2').textContent();
      expect(Buffer.from(tokenizeCommandLineBytes(shownKey!)[0]!).equals(key)).toBe(true);
      await detail.getByRole('button', { name: 'Copy CLI', exact: true }).click();
      // Navigating with the rail keeps the clipboard and the in-memory console transcript.
      await page.getByRole('link', { name: 'Console', exact: true }).click();
      const command = await paste(page);
      expect(Buffer.from(tokenizeCommandLineBytes(command)[1]!).equals(key)).toBe(true);
      const read = await run(page, command);
      expect(read.reply.t === 'str' && raw(read.reply.v).equals(value)).toBe(true);
      await page.getByTestId('console-result').last().getByRole('button', { name: /^Open key / }).click();
      if (name === 'BOM') await expect(detail.getByRole('tab', { name: 'Text', exact: true })).toHaveAttribute('aria-selected', 'true');
      if (name === 'binary') {
        await selectFormat(detail, 'text');
        await detail.getByRole('button', { name: 'Copy as redis-cli', exact: true }).click();
        await expect(detail.getByRole('button', { name: 'Copy as redis-cli', exact: true })).toContainText('Copied');
        await page.getByRole('link', { name: 'Console', exact: true }).click();
        const cli = await paste(page);
        expect(Buffer.from(tokenizeCommandLineBytes(cli)[0]!).equals(value)).toBe(true);
        await run(page, `SET ${quote(copy)} ${cli}`);
        expect(Buffer.from(await redisExec<Buffer>(['GET', copy])).equals(value)).toBe(true);
        await run(page, `GET ${quote(key)}`);
        await page.getByTestId('console-result').last().getByRole('button', { name: /^Open key / }).click();
      }
      await selectFormat(detail, name === 'binary' ? 'base64' : 'text');
      await detail.getByRole('button', { name: 'Copy value', exact: true }).click();
      await page.getByRole('link', { name: 'Console', exact: true }).click();
      const exact = await paste(page);
      expect(name === 'binary' ? Buffer.from(exact, 'base64').equals(value) : Buffer.from(exact).equals(value)).toBe(true);
      const typed = await run(page, `TYPE ${shownKey}`);
      expect(typed.reply).toEqual({ t: 'str', v: binFromBytes(Buffer.from('string')) });
      expect(Buffer.from(await redisExec<Buffer>(['GET', key])).equals(value)).toBe(true);
    });
  }

  test('L1: BOM-prefixed JSON opens on Text, copies exactly and stays exact in Console', async ({ page }) => {
    const key = Buffer.from(`${prefix}bom-json`), value = Buffer.from('\ufeff{"a":1}');
    keys.push(key); await redisExec(['SET', key, value]);
    await run(page, `GET ${quote(key)}`);
    await page.getByTestId('console-result').last().getByRole('button', { name: /^Open key / }).click();
    const detail = page.getByTestId('key-detail');
    await expect(detail.getByRole('tab', { name: 'Text', exact: true })).toHaveAttribute('aria-selected', 'true');
    await detail.getByRole('button', { name: 'Copy value', exact: true }).click();
    await page.getByRole('link', { name: 'Console', exact: true }).click();
    expect(Buffer.from(await paste(page)).equals(value)).toBe(true);
  });

  test('L2: a missing key hides stale content; EXPIRE 0 reports the missing key', async ({ page }) => {
    const key = Buffer.from(`${prefix}gone`); keys.push(key);
    await redisExec(['SET', key, 'STALE-VALUE']);
    await run(page, `GET ${quote(key)}`);
    await page.getByTestId('console-result').last().getByRole('button', { name: /^Open key / }).click();
    const detail = page.getByTestId('key-detail');
    await detail.getByTestId('key-ttl').click();
    await redisExec(['DEL', key]);
    const dialog = page.getByTestId('key-ttl-dialog');
    await dialog.getByTestId('key-ttl-input').fill('100');
    const expired = page.waitForResponse(r => r.url().endsWith('/ops'));
    await dialog.getByTestId('key-ttl-submit').click();
    const expiry = await expired;
    expect(expiry.status()).toBe(200);
    expect((await expiry.json()).result).toEqual({ t: 'int', v: '0' });
    // Successful HTTP transport triggers invalidation; its 404 replaces the form with the missing state.
    await expect(detail).toContainText('This key no longer exists.');
    await expect(detail.getByTestId('key-edit')).toHaveCount(0);
    await expect(detail.getByTestId('key-ttl')).toHaveCount(0);
    await expect(detail).not.toContainText('STALE-VALUE');
    expect(Number(await redisExec(['EXISTS', key]))).toBe(0);
    // Independently reproduce a manual refresh after another client deletes the key.
    await redisExec(['SET', key, 'STALE-VALUE']);
    await page.getByRole('link', { name: 'Console', exact: true }).click();
    await run(page, `GET ${quote(key)}`);
    await page.getByTestId('console-result').last().getByRole('button', { name: /^Open key / }).click();
    await expect(detail.getByTestId('key-edit')).toBeVisible();
    await redisExec(['DEL', key]);
    await detail.getByRole('button', { name: 'Refresh key', exact: true }).click();
    await expect(detail).toContainText('This key no longer exists.');
    await expect(detail.getByTestId('key-edit')).toHaveCount(0);
    await expect(detail).not.toContainText('STALE-VALUE');
  });
});
