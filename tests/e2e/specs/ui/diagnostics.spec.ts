/** Dashboard and diagnostics tools: slowlog, clients, memory analysis, pub/sub round trip, streams/groups/ack, search, timeseries, profiler. */
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { K, e2eAdminConn, redisExec } from '../../lib/fixtures-data.ts';
import { gotoView, confirmDialog } from '../../lib/ui.ts';
import { knownBug } from '../../lib/findings.ts';

test.describe('as operator', () => {
  test.use({ role: 'operator' });

  test('dashboard shows live metrics, keyspace and memory', async ({ page }) => {
    await gotoView(page, DB.e2e, 'overview');
    const main = page.locator('main');
    await expect(main).toContainText(/memory/i);
    await expect(main).toContainText(/clients/i);
    await expect(main).toContainText(/keys/i);
    await expect(main).toContainText(/\d/);
    // Live metrics stream is open (SSE) and charts render after a sample or two.
    await expect.poll(async () => page.evaluate(() => (window as any).__rcSse?.length ?? 0), { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test('diagnostics index lists tools by role/module (no admin tools for operator)', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics');
    for (const t of ['slowlog', 'analysis', 'pubsub', 'streams', 'search', 'timeseries']) await expect(page.getByTestId(`diagnostics-${t}`)).toBeVisible();
    await expect(page.getByTestId('diagnostics-profiler')).toHaveCount(0);
  });

  test('slowlog lists entries', async ({ page }) => {
    await redisExec(['CONFIG', 'SET', 'slowlog-log-slower-than', '0']);
    await redisExec(['GET', K.str]);
    await redisExec(['CONFIG', 'SET', 'slowlog-log-slower-than', '1000']);
    await gotoView(page, DB.e2e, 'diagnostics/slowlog');
    await expect(page.locator('main table')).toBeVisible();
    await expect(page.getByTestId('slowlog-reset')).toHaveCount(0);
  });

  test('memory analysis report', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/analysis');
    await page.getByTestId('analysis-pattern').fill('e2e:*');
    await page.getByTestId('analysis-run').click();
    const r = page.getByTestId('analysis-report');
    await expect(r).toBeVisible({ timeout: 20_000 });
    await expect(r).toContainText(K.big);
    await expect(r).toContainText(/string/);
  });

  test('pub/sub round trip over SSE', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/pubsub');
    const channel = `e2e-ui-${Date.now()}`;
    await page.getByTestId('pubsub-channel').fill(channel);
    await page.getByTestId('pubsub-subscribe').click();
    await expect(page.getByTestId('pubsub-stop')).toBeVisible();
    // Wait until the server-side subscription exists, then publish from the UI.
    await expect.poll(async () => Number(((await redisExec<any[]>(['PUBSUB', 'NUMSUB', channel]))[1]))).toBe(1);
    await page.getByTestId('publish-channel').fill(channel);
    await page.getByTestId('publish-message').fill('hello from the e2e suite');
    await page.getByTestId('pubsub-publish').click();
    await expect(page.locator('main')).toContainText('hello from the e2e suite');
    // And a message published directly in Redis arrives too.
    await redisExec(['PUBLISH', channel, 'direct-from-redis']);
    await expect(page.locator('main')).toContainText('direct-from-redis');
    await page.getByTestId('pubsub-stop').click();
    await expect.poll(async () => Number(((await redisExec<any[]>(['PUBSUB', 'NUMSUB', channel]))[1]))).toBe(0);
  });

  test('streams: groups, consumers, pending; create group; ack', async ({ page }) => {
    const key = `${K.scratchPrefix}ui-stream`;
    for (let i = 0; i < 3; i++) await redisExec(['XADD', key, '*', 'n', String(i)]);
    await redisExec(['XGROUP', 'CREATE', key, 'g1', '0']);
    const read = await redisExec<any[]>(['XREADGROUP', 'GROUP', 'g1', 'c1', 'COUNT', 2, 'STREAMS', key, '>']);
    const id = String((read[0][1] as any[])[0][0]);
    await gotoView(page, DB.e2e, 'diagnostics/streams');
    await page.getByTestId('stream-key').fill(key);
    await page.getByTestId('stream-inspect').click();
    const main = page.locator('main');
    await expect(main).toContainText('g1');
    await page.getByRole('button', { name: 'g1', exact: true }).click();
    await expect(main).toContainText('c1');
    await expect(main).toContainText(id);
    await page.getByTestId('stream-group-name').fill('g-ui');
    await page.getByTestId('stream-group-create').click();
    await expect(main).toContainText('g-ui');
    expect((await redisExec<any[]>(['XINFO', 'GROUPS', key])).length).toBe(2);
    await page.getByTestId('stream-ack-ids').fill(id);
    await page.getByTestId('stream-ack').click();
    await expect.poll(async () => Number(((await redisExec<any[]>(['XPENDING', key, 'g1']))[0]))).toBe(1);
  });

  test('search: run a query against the index', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/search');
    const idx = page.getByTestId('search-index');
    if ((await idx.evaluate((e) => e.tagName)) === 'SELECT') await idx.selectOption(K.searchIndex);
    else await idx.fill(K.searchIndex);
    await page.getByTestId('search-query').fill('@title:gadget');
    await page.getByTestId('search-run').click();
    await expect(page.locator('main')).toContainText('Blue gadget');
    await expect(page.locator('main')).toContainText(/10/);
  });

  test('timeseries chart', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/timeseries');
    await page.getByTestId('timeseries-key').fill(K.ts);
    await page.getByTestId('timeseries-run').click();
    await expect(page.locator('main canvas, main svg.uplot, main .uplot').first()).toBeVisible();
  });
});

test.describe('as admin', () => {
  test.use({ role: 'admin' });

  test('search: run a query against the index (admin)', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/search');
    const idx = page.getByTestId('search-index');
    if ((await idx.evaluate((e) => e.tagName)) === 'SELECT') await idx.selectOption(K.searchIndex);
    else await idx.fill(K.searchIndex);
    await page.getByTestId('search-query').fill('@title:gadget');
    await page.getByTestId('search-run').click();
    await expect(page.locator('main')).toContainText('Blue gadget');
  });

  test('clients list and kill (with confirmation)', async ({ page }) => {
    const victim = await e2eAdminConn();
    await victim.cmd(['CLIENT', 'SETNAME', 'e2e-victim']);
    try {
      await gotoView(page, DB.e2e, 'diagnostics/clients');
      await expect(page.locator('main table')).toBeVisible();
      await expect(page.locator('main')).toContainText('rc-');
      const row = page.locator('main tr', { hasText: 'e2e-victim' });
      await expect(row).toBeVisible();
      await row.getByTestId('client-kill').click();
      await confirmDialog(page);
      await expect.poll(async () => victim.raw(['PING']).then(() => 'alive', () => 'killed'), { timeout: 10_000 }).toBe('killed');
    } finally {
      victim.close();
    }
  });

  test('slowlog reset requires confirmation', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/slowlog');
    await page.getByTestId('slowlog-reset').click();
    await confirmDialog(page);
    await expect.poll(async () => Number(await redisExec(['SLOWLOG', 'LEN']))).toBeLessThanOrEqual(1);
  });

  test('profiler streams commands (admin, non-prod) and stops', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/profiler');
    await page.getByTestId('profiler-seconds').fill('10');
    await page.getByTestId('profiler-start').click();
    await expect(page.getByTestId('profiler-stop')).toBeVisible();
    const marker = `profiler-marker-${Date.now()}`;
    await expect.poll(async () => { await redisExec(['GET', marker]); return page.locator('main').innerText(); }, { timeout: 10_000 }).toContain(marker);
    await page.getByTestId('profiler-stop').click();
  });

  test('profiler is not offered on prod-tagged databases', async ({ page }) => {
    await gotoView(page, DB.prodSim, 'diagnostics');
    await expect(page.getByTestId('diagnostics-slowlog')).toBeVisible();
    await expect(page.getByTestId('diagnostics-profiler')).toHaveCount(0);
    await page.goto(`/db/${DB.prodSim}/diagnostics/profiler`);
    const start = page.getByTestId('profiler-start');
    if (await start.isVisible().catch(() => false)) {
      await start.click();
      await expect(page.getByRole('alert')).toBeVisible();
    }
  });
});
