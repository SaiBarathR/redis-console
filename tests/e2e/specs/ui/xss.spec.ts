/**
 * Hostile payloads in keys and values must render as inert text everywhere:
 * key list, every value viewer/format, console, workbench, streams, pub/sub, search.
 * The page fixture fails on any JS dialog, CSP/Trusted-Types violation or console error;
 * expectNoXss() checks for injected DOM and the window.__xss canary.
 */
import { test, expect, expectNoXss } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { K, XSS_KEYS, XSS_PAYLOADS, redisExec } from '../../lib/fixtures-data.ts';
import { consoleRun, gotoView, setEditor, selectFormat } from '../../lib/ui.ts';
import { knownBug } from '../../lib/findings.ts';
import { tokenizeCommandLineBytes } from '@rconsole/shared';

test.use({ role: 'operator' });

test('key list renders hostile key names as text', async ({ page }) => {
  await gotoView(page, DB.e2e, 'keys');
  await page.getByTestId('key-pattern').fill(`${K.xssPrefix}*`);
  await page.getByTestId('key-scan').click();
  await page.getByTestId('key-delimiter').fill('');
  const list = page.getByTestId('key-list');
  await expect(list.getByTestId('key-row').first()).toBeVisible();
  for (const [i, k] of XSS_KEYS.slice(0, 4).entries()) {
    const row = list.getByTestId('key-row').filter({ hasText: `${K.xssPrefix}${i}:` });
    await expect(row).toBeVisible();
    const shown = await row.locator('.key-anatomy').textContent();
    expect(Buffer.from(tokenizeCommandLineBytes(shown!)[0]!).equals(Buffer.from(k))).toBe(true);
  }
  await expectNoXss(page);
});

test('every string value viewer format renders payloads inertly', async ({ page }) => {
  await gotoView(page, DB.e2e, 'keys');
  await page.getByTestId('key-pattern').fill(`${K.xssPrefix}*`);
  await page.getByTestId('key-scan').click();
  await page.getByTestId('key-delimiter').fill('');
  for (const [i, k] of XSS_KEYS.entries()) {
    await page.getByTestId('key-list').getByTestId('key-row').filter({ hasText: `${K.xssPrefix}${i}:` }).first().click();
    const d = page.getByTestId('key-detail');
    await expect(d.getByTestId('key-value')).toHaveText(XSS_PAYLOADS[i]!);
    for (const fmt of ['json', 'tree', 'hex', 'base64', 'msgpack', 'text']) {
      await selectFormat(d, fmt);
      await page.waitForTimeout(50);
    }
    await d.getByTestId('key-explain').click();
    await expectNoXss(page);
  }
});

for (const suffix of ['hash', 'list', 'set', 'zset', 'stream', 'json']) {
  test(`${suffix} value with payloads`, async ({ page }) => {
    await gotoView(page, DB.e2e, 'keys');
    await page.getByTestId('key-delimiter').fill('');
    await page.getByTestId('key-pattern').fill(`${K.xssPrefix}${suffix}`);
    await page.getByTestId('key-scan').click();
    await page.getByTestId('key-list').getByTestId('key-row').first().click();
    const d = page.getByTestId('key-detail');
    await expect(d).toContainText('onerror');
    if (suffix === 'json') {
      await selectFormat(d, 'tree');
      await selectFormat(d, 'json');
    }
    await expectNoXss(page);
  });
}

test('console and workbench replies with payloads', async ({ page }) => {
  await gotoView(page, DB.e2e, 'console');
  await consoleRun(page, `GET "${XSS_KEYS[0]!.replace(/"/g, '\\"')}"`);
  await expect(page.getByTestId('console-results')).toContainText('onerror');
  await consoleRun(page, `HGETALL ${K.xssPrefix}hash`);
  await consoleRun(page, `LRANGE ${K.xssPrefix}list 0 -1`);
  await consoleRun(page, `XRANGE ${K.xssPrefix}stream - +`);
  await consoleRun(page, `JSON.GET ${K.xssPrefix}json`);
  await consoleRun(page, `ECHO "<img src=x onerror=window.__xss=1>"`);
  await expectNoXss(page);
  await gotoView(page, DB.e2e, 'workbench');
  await setEditor(page, `SCAN 0 MATCH ${K.xssPrefix}* COUNT 1000\nSMEMBERS ${K.xssPrefix}set\nZRANGE ${K.xssPrefix}zset 0 -1 WITHSCORES`, 'workbench-editor');
  await page.getByTestId('workbench-run').click();
  await expect(page.getByTestId('console-results')).toContainText('svg');
  await expectNoXss(page);
});

test('pub/sub message, stream tool and analysis with payloads', async ({ page }) => {
  // Pub/sub
  await gotoView(page, DB.e2e, 'diagnostics/pubsub');
  const channel = `<img src=x onerror=window.__xss=1>`;
  await page.getByTestId('pubsub-channel').fill(channel);
  await page.getByTestId('pubsub-subscribe').click();
  await page.waitForTimeout(500);
  await page.getByTestId('publish-channel').fill(channel);
  await page.getByTestId('publish-message').fill(XSS_PAYLOADS[1]!);
  await page.getByTestId('pubsub-publish').click();
  await expect(page.locator('main')).toContainText('<script>');
  await page.getByTestId('pubsub-stop').click();
  await expectNoXss(page);
  // Streams tool
  await gotoView(page, DB.e2e, 'diagnostics/streams');
  await page.getByTestId('stream-key').fill(`${K.xssPrefix}stream`);
  await page.getByTestId('stream-inspect').click();
  await expectNoXss(page);
  // Memory analysis top keys include hostile names
  await gotoView(page, DB.e2e, 'diagnostics/analysis');
  await page.getByTestId('analysis-pattern').fill(`${K.xssPrefix}*`);
  await page.getByTestId('analysis-run').click();
  await expect(page.getByTestId('analysis-report')).toBeVisible();
  await expectNoXss(page);
});

test.describe('search results with payloads (admin: see F-02 for other roles)', () => {
  test.use({ role: 'admin' });
  test('search result fields render inertly', async ({ page }) => {
    await redisExec(['HSET', `${K.docPrefix}xss`, 'title', XSS_PAYLOADS[0]!, 'price', '1', 'category', 'toys']);
    await gotoView(page, DB.e2e, 'diagnostics/search');
    await page.getByTestId('search-index').selectOption(K.searchIndex);
    await page.getByTestId('search-query').fill('@price:[1 1]');
    await page.getByTestId('search-run').click();
    await expect(page.locator('main')).toContainText('onerror');
    await expectNoXss(page);
    await redisExec(['DEL', `${K.docPrefix}xss`]);
  });
});

test('payload in a URL parameter or route is not reflected as HTML', async ({ page }) => {
  await page.goto(`/login?error=${encodeURIComponent('<img src=x onerror=window.__xss=1>')}`);
  await page.goto(`/db/${encodeURIComponent('<img src=x onerror=window.__xss=1>')}/keys`);
  await expectNoXss(page);
});
