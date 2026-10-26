/** Regressions for the v0.2 web review, round 1 (docs/REVIEW-LOG.md, "Round 1 – web (GPT reviewer)"). */
import { gzipSync } from 'node:zlib';
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';
import { gotoView, openKey, selectFormat } from '../../lib/ui.ts';

const P = `${K.scratchPrefix}w1:`;

test.describe('web review round 1 (operator)', () => {
  test.use({ role: 'operator' });
  test.beforeEach(async ({ page }) => { await gotoView(page, DB.e2e, 'keys'); });

  test('H1: a cached page change closes the list editor and writes nothing', async ({ page }) => {
    const key = `${P}h1:list`;
    await redisExec(['DEL', key]);
    await redisExec(['RPUSH', key, ...Array.from({ length: 205 }, (_, i) => `item-${i}`)]);
    const d = await openKey(page, key, { rowText: 'list' });
    // Warm page 2, return to page 1, open the editor, then revisit the cached page 2.
    await d.getByTestId('key-next-page').click();
    await expect(d).toContainText('item-100');
    await d.getByRole('button', { name: 'First page' }).click();
    await expect(d).toContainText('item-0');
    await d.getByRole('button', { name: 'Edit list index 0', exact: true }).click();
    await expect(d.getByLabel('Value at index 0')).toHaveValue('item-0');
    await d.getByTestId('key-next-page').click();
    await expect(d).toContainText('item-100');
    await expect(d.locator('form.row-panel')).toHaveCount(0);
    expect(String(await redisExec(['LINDEX', key, '100']))).toBe('item-100');
    await d.getByRole('button', { name: 'First page' }).click();
    await expect(d.locator('form.row-panel')).toHaveCount(0);
  });

  test('H2: Create key never changes an existing key, field or document', async ({ page }) => {
    const p = `${P}h2:`;
    await redisExec(['DEL', ...['json', 'hash', 'list', 'set', 'zset', 'stream', 'string'].map((t) => `${p}${t}`)]);
    await redisExec(['JSON.SET', `${p}json`, '$', '{"important":"must survive","version":1}']);
    await redisExec(['HSET', `${p}hash`, 'f', 'original']);
    await redisExec(['RPUSH', `${p}list`, 'a']);
    await redisExec(['SADD', `${p}set`, 'a']);
    await redisExec(['ZADD', `${p}zset`, 1, 'm']);
    await redisExec(['XADD', `${p}stream`, '*', 'a', '1']);
    await redisExec(['SET', `${p}string`, 'original']);
    const snapshot = async () => JSON.stringify(await Promise.all([
      redisExec(['JSON.GET', `${p}json`]), redisExec(['HGETALL', `${p}hash`]), redisExec(['LRANGE', `${p}list`, 0, -1]),
      redisExec(['SMEMBERS', `${p}set`]), redisExec(['ZRANGE', `${p}zset`, 0, -1, 'WITHSCORES']), redisExec(['XLEN', `${p}stream`]),
      redisExec(['GET', `${p}string`]),
    ].map(async (v) => String(await v))));
    const before = await snapshot();
    const inputs: [string, Record<string, string>][] = [
      ['json', { value: '{"new":true}' }], ['hash', { field: 'f', value: 'OVERWRITTEN-BY-CREATE' }], ['list', { value: 'x' }],
      ['set', { value: 'x' }], ['zset', { value: 'm', score: '99' }], ['stream', { field: 'b', value: '2' }], ['string', { value: 'x' }],
    ];
    for (const [type, f] of inputs) {
      await page.getByTestId('key-add').click();
      const dlg = page.getByTestId('key-editor-dialog');
      await dlg.getByTestId('key-create-type').selectOption(type);
      await dlg.getByTestId('key-create-name').fill(`${p}${type}`);
      if (f.field) await dlg.getByTestId('key-edit-field').fill(f.field);
      if (f.score) await dlg.getByTestId('key-edit-score').fill(f.score);
      await dlg.getByTestId('key-edit-value').fill(f.value!);
      await dlg.getByTestId('key-save').click();
      await expect(dlg.getByRole('alert')).toContainText('already exists');
      await page.keyboard.press('Escape');
      await expect(dlg).toBeHidden();
    }
    expect(await snapshot()).toBe(before);
  });

  test('M1: JSON Tree rows flow in the inspector', async ({ page }) => {
    const key = `${P}m1:json`;
    await redisExec(['SET', key, JSON.stringify({ a: 1, b: { c: 'two', d: [1, 2, 3] }, e: 'x'.repeat(600) })]);
    const d = await openKey(page, key, { rowText: 'json' });
    await selectFormat(d, 'tree');
    const rows = await d.locator('.json-tree .json-row').evaluateAll((els) =>
      els.map((e) => [getComputedStyle(e).position, Math.round(e.getBoundingClientRect().top)] as const));
    expect(rows.length).toBe(8);
    expect(new Set(rows.map(([, top]) => top)).size).toBe(rows.length);
    expect(rows.every(([position]) => position === 'static')).toBe(true);
    // Key list rows keep their virtual-row layout.
    expect(await page.getByTestId('key-row').first().evaluate((e) => getComputedStyle(e).position)).toBe('absolute');
  });

  test('M2: a refreshed value replaces the inflated view of the old bytes', async ({ page }) => {
    const key = `${P}m2:gz`;
    await redisExec(['SET', key, gzipSync(Buffer.from('OLD-INFLATED-CONTENT'))]);
    const d = await openKey(page, key, { rowText: 'gz' });
    await d.getByTestId('value-inflate').click();
    await expect(d.getByTestId('key-value')).toContainText('OLD-INFLATED-CONTENT');
    await redisExec(['SET', key, 'NEW-CONTENT']);
    await d.getByRole('button', { name: 'Refresh key' }).click();
    await expect(d.getByTestId('key-value')).toHaveText('NEW-CONTENT');
    await expect(d.getByText('Inflated locally')).toHaveCount(0);
  });

  test('M3: a key added outside the filter is not listed; the list asks for a rescan', async ({ page }) => {
    const p = `${P}m3:`;
    await redisExec(['DEL', `${p}in-1`, `${p}outside`]);
    await redisExec(['SET', `${p}in-1`, 'v']);
    await page.getByTestId('key-delimiter').fill('');
    await page.getByTestId('key-pattern').fill(`${p}in*`);
    await page.getByTestId('key-scan').click();
    const list = page.getByTestId('key-list');
    await expect(list.getByTestId('key-row')).toHaveCount(1);
    await page.getByTestId('key-add').click();
    const dlg = page.getByTestId('key-editor-dialog');
    await dlg.getByTestId('key-create-name').fill(`${p}outside`);
    await dlg.getByTestId('key-edit-value').fill('v');
    await dlg.getByTestId('key-save').click();
    await expect(dlg).toBeHidden();
    await expect(page.getByTestId('key-detail').locator('h2')).toHaveText(`${p}outside`);
    await expect(page.getByTestId('key-scan-changed')).toBeVisible();
    await expect(list.getByTestId('key-row')).toHaveCount(1);
    await page.getByRole('checkbox', { name: 'Select all loaded keys' }).check();
    const selection = page.getByRole('region', { name: 'Selected keys' });
    await expect(selection).toContainText('1 selected');
    await selection.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByTestId('key-scan-changed').getByRole('button', { name: 'Rescan' }).click();
    await expect(page.getByTestId('key-scan-changed')).toHaveCount(0);
  });

  test('M4: a write made in Guided mode marks the scan as changed', async ({ page }) => {
    const p = `${P}m4:`;
    await redisExec(['DEL', `${p}one`, `${p}via-guided`]);
    await redisExec(['SET', `${p}one`, 'v']);
    await page.getByTestId('key-delimiter').fill('');
    await page.getByTestId('key-pattern').fill(`${p}*`);
    await page.getByTestId('key-scan').click();
    const list = page.getByTestId('key-list');
    await expect(list.getByTestId('key-row')).toHaveCount(1);
    await expect(page.getByTestId('key-scan-changed')).toHaveCount(0);
    await page.getByTestId('nav-guided').click();
    await page.getByTestId('guided-edit').click();
    await page.getByTestId('guided-key').fill(`${p}via-guided`);
    await page.getByTestId('guided-value').fill('x');
    await page.getByTestId('guided-run').click();
    await expect.poll(async () => String(await redisExec(['GET', `${p}via-guided`]))).toBe('x');
    await page.getByTestId('nav-keys').click();
    await expect(page.getByTestId('key-scan-changed')).toBeVisible();
    await page.getByTestId('key-scan-changed').getByRole('button', { name: 'Rescan' }).click();
    await expect(list.getByTestId('key-row')).toHaveCount(2);
    await expect(page.getByTestId('key-scan-changed')).toHaveCount(0);
  });

  test('UX: maximize the inspector and bring the key list back', async ({ page }) => {
    const d = await openKey(page, K.str, { rowText: 'greeting' });
    await d.getByTestId('inspector-wide').click();
    await expect(page.getByTestId('key-list')).toBeHidden();
    await d.getByTestId('inspector-wide').click();
    await expect(page.getByTestId('key-list')).toBeVisible();
  });

  test('UX: Guided Find continues in the key browser with the pattern that ran', async ({ page }) => {
    await gotoView(page, DB.e2e, 'guided');
    await page.getByTestId('guided-find').click();
    await page.getByTestId('guided-key').fill('e2e:string:*');
    await page.getByTestId('guided-run').click();
    await expect(page.getByTestId('guided-continue-keys')).toBeVisible();
    await page.getByTestId('guided-key').fill('edited-not-run*');
    // Round 2 clears stale results rather than presenting the previous pattern beside new inputs.
    await expect(page.getByTestId('guided-continue-keys')).toHaveCount(0);
    await page.getByTestId('guided-key').fill('e2e:string:*');
    await page.getByTestId('guided-run').click();
    await page.getByTestId('guided-continue-keys').click();
    await expect(page.getByTestId('key-pattern')).toHaveValue('e2e:string:*');
    await page.getByTestId('key-delimiter').fill('');
    await expect(page.getByTestId('key-list').getByTestId('key-row')).toHaveCount(4);
  });
});

test.describe('web review round 1: Search (viewer)', () => {
  test.use({ role: 'viewer' });
  const idx = 'e2e-w1-idx';
  const prefix = `${P}search:`;
  test.beforeAll(async () => {
    try { await redisExec(['FT.DROPINDEX', idx]); } catch { /* not there */ }
    for (let i = 0; i < 26; i++)
      await redisExec(['HSET', `${prefix}${String(i).padStart(2, '0')}`, 'title', i === 0 ? 'L'.repeat(5000) : `doc ${i}`, 'n', i]);
    await redisExec(['FT.CREATE', idx, 'ON', 'HASH', 'PREFIX', 1, prefix, 'SCHEMA', 'title', 'TEXT', 'n', 'NUMERIC']);
  });
  test.afterAll(async () => {
    try { await redisExec(['FT.DROPINDEX', idx]); } catch { /* gone */ }
  });

  test('M5/M6/M1: truncation is marked, paging uses the executed query, results never cover the form', async ({ page }) => {
    const sent: { query: string; offset: number }[] = [];
    page.on('request', (r) => { if (r.url().endsWith('/search/query')) sent.push(r.postDataJSON()); });
    await gotoView(page, DB.e2e, 'diagnostics/search');
    await expect(page.getByRole('option', { name: idx })).toBeAttached();
    await page.getByTestId('search-index').selectOption(idx);
    await page.getByTestId('search-query').fill('@n:[0 0]');
    await page.getByTestId('search-run').click();
    await expect(page.getByTestId('search-doc-truncated')).toContainText('Preview cut');
    // M1: a 4 KiB field stays in its pane; an ordinary click still reaches Run search.
    await page.getByTestId('search-run').click({ timeout: 5_000 });
    await expect(page.getByTestId('search-doc-truncated')).toBeVisible();
    // M6: an edited but unsubmitted query does not change paging.
    await page.getByTestId('search-query').fill('*');
    await page.getByTestId('search-run').click();
    await expect(page.getByText('26 results')).toBeVisible();
    await page.getByTestId('search-query').fill('@n:[1 1]');
    await page.getByRole('button', { name: 'Next 20' }).click();
    await expect.poll(() => sent.at(-1)).toMatchObject({ query: '*', offset: 20 });
    await page.getByTestId('search-run').click();
    await expect.poll(() => sent.at(-1)).toMatchObject({ query: '@n:[1 1]', offset: 0 });
    // M5: open the cut document in the key browser (session memory, not the URL).
    await page.getByTestId('search-query').fill('@n:[0 0]');
    await page.getByTestId('search-run').click();
    await page.getByTestId('search-doc-truncated').getByRole('button', { name: 'Open in key browser' }).click();
    await expect(page.getByTestId('key-detail').locator('h2')).toHaveText(`${prefix}00`);
    expect(page.url()).not.toContain('search:');
  });

  test('M7: the palette shortcut focuses its search; typing and Enter navigate', async ({ page }) => {
    await gotoView(page, DB.e2e, 'overview');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('command-palette-search')).toBeFocused();
    await page.keyboard.type('diagn');
    await expect(page.getByTestId('command-palette').getByRole('option')).toHaveText('Diagnostics');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/diagnostics/);
  });
});

test.describe('web review round 1: audit at 1024 (admin)', () => {
  test.use({ role: 'admin', viewport: { width: 1024, height: 900 } });
  test('UX: Outcome stays visible next to time, user and action', async ({ page }) => {
    await page.goto('/admin/audit');
    const tag = page.locator('.outcome-tag').first();
    await expect(tag).toBeVisible();
    expect(await tag.evaluate((e) => e.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
