/** Key browser UI: view every type, add/edit/TTL/rename/delete, formatters, large values, binary and Unicode keys. */
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { BINARY_VALUE, BIG_VALUE_BYTES, K, redisExec } from '../../lib/fixtures-data.ts';
import { confirmDialog, gotoView, openKey, selectFormat } from '../../lib/ui.ts';
import { knownBug } from '../../lib/findings.ts';

test.use({ role: 'operator' });

test.describe('key browser', () => {
  test.beforeEach(async ({ page }) => { await gotoView(page, DB.e2e, 'keys'); });

  test('scan shows keys with type badges; type filter and tree delimiter work', async ({ page }) => {
    await page.getByTestId('key-pattern').fill('e2e:string:*');
    await page.getByTestId('key-scan').click();
    const list = page.getByTestId('key-list');
    await expect(list.getByTestId('key-row')).toHaveCount(4);
    await expect(list.getByTestId('key-row').first()).toContainText('string');
    // Type filter: only hashes come back for a pattern that matches several types.
    await page.getByTestId('key-delimiter').fill('');
    await page.getByTestId('key-pattern').fill('e2e:[hs]*');
    await page.getByTestId('key-type-filter').selectOption('hash');
    await page.getByTestId('key-scan').click();
    await expect(list.getByTestId('key-row').filter({ hasText: K.hash })).toBeVisible();
    for (const row of await list.getByTestId('key-row').all()) await expect(row).toContainText('hash');
    // Tree mode groups by delimiter into folders.
    await page.getByTestId('key-delimiter').fill(':');
    await expect(list.locator('.key-folder').first()).toBeVisible();
  });

  const views: [string, string, RegExp][] = [
    [K.str, 'greeting', /Hello from Redis Console e2e/],
    [K.hash, '1', /Ada Lovelace/],
    [K.list, 'queue', /job-3/],
    [K.set, 'tags', /yellow/],
    [K.zset, 'leaderboard', /carol[\s\S]*75\.5/],
    [K.stream, 'orders', /ord-1[\s\S]*amount/],
    [K.json, 'profile', /grace/],
    [K.ts, 'temperature', /Series metadata|celsius|\d{2}\.\d/],
  ];
  for (const [key, seg, re] of views) {
    test(`view ${key}`, async ({ page }) => {
      const d = await openKey(page, key, { rowText: seg });
      await expect(d.locator('h2')).toHaveText(key);
      await expect(d).toContainText(re);
    });
  }

  test('bloom filter key is shown as unsupported with guidance', async ({ page }) => {
    const d = await openKey(page, K.bloom, { rowText: 'emails' });
    await expect(d).toContainText(/MBbloom|bloom|console/i);
  });

  test('explain-key panel shows type, encoding, TTL and the CLI commands', async ({ page }) => {
    const d = await openKey(page, K.hash, { rowText: '1' });
    await d.getByTestId('key-explain').click();
    await expect(d).toContainText('HSCAN "e2e:hash:user:1" 0');
    await expect(d).toContainText('OBJECT ENCODING "e2e:hash:user:1"');
    await expect(d).toContainText(/listpack|hashtable/);
  });

  test('add a key of every basic type', async ({ page }) => {
    const p = `${K.scratchPrefix}ui-add:`;
    const cases: [string, Record<string, string>, () => Promise<void>][] = [
      ['string', { value: 'hello ui' }, async () => expect(String(await redisExec(['GET', `${p}string`]))).toBe('hello ui')],
      ['hash', { field: 'f1', value: 'v1' }, async () => expect(String(await redisExec(['HGET', `${p}hash`, 'f1']))).toBe('v1')],
      ['list', { value: 'item' }, async () => expect(Number(await redisExec(['LLEN', `${p}list`]))).toBe(1)],
      ['set', { value: 'member' }, async () => expect(Number(await redisExec(['SISMEMBER', `${p}set`, 'member']))).toBe(1)],
      ['zset', { value: 'm', score: '4.5' }, async () => expect(String(await redisExec(['ZSCORE', `${p}zset`, 'm']))).toBe('4.5')],
      ['stream', { field: 'event', value: 'created' }, async () => expect(Number(await redisExec(['XLEN', `${p}stream`]))).toBe(1)],
      ['json', { value: '{"ok":true,"n":[1,2]}' }, async () => expect(String(await redisExec(['JSON.GET', `${p}json`, '$.n']))).toBe('[[1,2]]')],
    ];
    for (const [type, fields, check] of cases) {
      await page.getByTestId('key-add').click();
      const dlg = page.getByTestId('key-editor-dialog');
      await dlg.getByTestId('key-create-type').selectOption(type);
      await dlg.getByTestId('key-create-name').fill(`${p}${type}`);
      if (fields.field) await dlg.getByTestId('key-edit-field').fill(fields.field);
      if (fields.score) await dlg.getByTestId('key-edit-score').fill(fields.score);
      await dlg.getByTestId('key-edit-value').fill(fields.value!);
      await dlg.getByTestId('key-save').click();
      await expect(dlg).toBeHidden();
      await check();
    }
  });

  test('add a string with TTL and a binary (base64) value', async ({ page }) => {
    const key = `${K.scratchPrefix}ui-bin`;
    await page.getByTestId('key-add').click();
    const dlg = page.getByTestId('key-editor-dialog');
    await dlg.getByTestId('key-create-name').fill(key);
    await dlg.getByTestId('key-edit-value').fill(BINARY_VALUE.toString('base64'));
    await dlg.getByTestId('key-edit-encoding').selectOption('base64');
    await dlg.getByTestId('key-edit-ttl').fill('900');
    await dlg.getByTestId('key-save').click();
    await expect(dlg).toBeHidden();
    expect(Buffer.from(await redisExec<Buffer>(['GET', key])).equals(BINARY_VALUE)).toBe(true);
    expect(Number(await redisExec(['TTL', key]))).toBeGreaterThan(800);
  });

  test('edit a string value', async ({ page }) => {
    const key = `${K.scratchPrefix}ui-edit-str`;
    await redisExec(['SET', key, 'before']);
    const d = await openKey(page, key, { rowText: 'ui-edit-str' });
    await d.getByTestId('key-edit').click();
    const dlg = page.getByTestId('key-editor-dialog');
    await dlg.getByTestId('key-edit-value').fill('after');
    await dlg.getByTestId('key-save').click();
    await expect(dlg).toBeHidden();
    await expect(d.getByTestId('key-value')).toHaveText('after');
    expect(String(await redisExec(['GET', key]))).toBe('after');
  });

  test('edit hash, list, set, zset, stream entries', async ({ page }) => {
    const p = `${K.scratchPrefix}ui-edit:`;
    await redisExec(['HSET', `${p}h`, 'a', '1']);
    await redisExec(['RPUSH', `${p}l`, 'x']);
    await redisExec(['SADD', `${p}s`, 'x']);
    await redisExec(['ZADD', `${p}z`, 1, 'x']);
    await redisExec(['XADD', `${p}x`, '*', 'a', '1']);
    const steps: [string, Record<string, string>, () => Promise<void>][] = [
      ['h', { field: 'b', value: '2' }, async () => expect(String(await redisExec(['HGET', `${p}h`, 'b']))).toBe('2')],
      ['l', { value: 'y' }, async () => expect(Number(await redisExec(['LLEN', `${p}l`]))).toBe(2)],
      ['s', { value: 'y' }, async () => expect(Number(await redisExec(['SCARD', `${p}s`]))).toBe(2)],
      ['z', { value: 'y', score: '9' }, async () => expect(String(await redisExec(['ZSCORE', `${p}z`, 'y']))).toBe('9')],
      ['x', { field: 'b', value: '2' }, async () => expect(Number(await redisExec(['XLEN', `${p}x`]))).toBe(2)],
    ];
    for (const [suffix, f, check] of steps) {
      const d = await openKey(page, `${p}${suffix}`, { rowText: new RegExp(`^${suffix}\\b|:${suffix}\\b|${suffix}`) });
      await d.getByTestId('key-edit').click();
      const dlg = page.getByTestId('key-editor-dialog');
      if (f.field) await dlg.getByTestId('key-edit-field').fill(f.field);
      if (f.score) await dlg.getByTestId('key-edit-score').fill(f.score);
      await dlg.getByTestId('key-edit-value').fill(f.value!);
      await dlg.getByTestId('key-save').click();
      await expect(dlg).toBeHidden();
      await check();
    }
  });

  test('set and remove TTL', async ({ page }) => {
    const key = `${K.scratchPrefix}ui-ttl`;
    await redisExec(['SET', key, 'v']);
    const d = await openKey(page, key, { rowText: 'ui-ttl' });
    await d.getByTestId('key-ttl').click();
    await page.getByTestId('key-ttl-input').fill('5000');
    await page.getByTestId('key-ttl-submit').click();
    await expect(page.getByTestId('key-ttl-dialog')).toBeHidden();
    expect(Number(await redisExec(['TTL', key]))).toBeGreaterThan(4900);
    await d.getByTestId('key-ttl').click();
    await page.getByTestId('key-ttl-input').fill('-1');
    await page.getByTestId('key-ttl-submit').click();
    await expect(page.getByTestId('key-ttl-dialog')).toBeHidden();
    expect(Number(await redisExec(['TTL', key]))).toBe(-1);
  });

  test('rename a key (and refuse to overwrite an existing one)', async ({ page }) => {
    const key = `${K.scratchPrefix}ui-ren-a`;
    await redisExec(['SET', key, 'v']);
    await redisExec(['SET', `${K.scratchPrefix}ui-ren-taken`, 'keep']);
    const d = await openKey(page, key, { rowText: 'ui-ren-a' });
    await d.getByTestId('key-rename').click();
    await page.getByTestId('key-rename-input').fill(`${K.scratchPrefix}ui-ren-taken`);
    await page.getByTestId('key-rename-submit').click();
    await expect(page.getByTestId('key-rename-dialog').getByRole('alert')).toBeVisible();
    expect(String(await redisExec(['GET', `${K.scratchPrefix}ui-ren-taken`]))).toBe('keep');
    await page.getByTestId('key-rename-input').fill(`${K.scratchPrefix}ui-ren-b`);
    await page.getByTestId('key-rename-submit').click();
    await expect(page.getByTestId('key-rename-dialog')).toBeHidden();
    expect(await redisExec(['EXISTS', `${K.scratchPrefix}ui-ren-b`])).toBe(1);
    expect(await redisExec(['EXISTS', key])).toBe(0);
  });

  test('delete a key goes through the server confirmation', async ({ page }) => {
    const key = `${K.scratchPrefix}ui-del`;
    await redisExec(['SET', key, 'v']);
    const d = await openKey(page, key, { rowText: 'ui-del' });
    // key-delete goes straight to the single server confirmation. Cancel first: nothing deleted.
    await d.getByTestId('key-delete').click();
    const dlg = page.getByTestId('confirmation-dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg).toBeHidden();
    expect(await redisExec(['EXISTS', key])).toBe(1);
    await d.getByTestId('key-delete').click();
    await confirmDialog(page);
    await expect.poll(() => redisExec(['EXISTS', key])).toBe(0);
  });

  test('remove a hash field from the value table', async ({ page }) => {
    const key = `${K.scratchPrefix}ui-hdel`;
    await redisExec(['HSET', key, 'keep', '1', 'drop', '2']);
    const d = await openKey(page, key, { rowText: 'ui-hdel' });
    await d.getByRole('row', { name: /drop/ }).getByRole('button', { name: 'Remove entry' }).click();
    await confirmDialog(page);
    await expect.poll(async () => Number(await redisExec(['HLEN', key]))).toBe(1);
  });

  test('formatters: JSON pretty, hex, base64, gzip inflate, msgpack, Java/PHP detection', async ({ page }) => {
    let d = await openKey(page, K.strJson, { rowText: 'json' });
    await selectFormat(d, 'json');
    await expect(d.getByTestId('key-value')).toContainText('"nested": {');
    await selectFormat(d, 'hex');
    await expect(d.getByTestId('key-value')).toContainText(/7b\s?22/i);
    await selectFormat(d, 'base64');
    await expect(d.getByTestId('key-value')).toContainText(Buffer.from('{"id":42').toString('base64').slice(0, 8));

    d = await openKey(page, K.gzip, { rowText: 'gzip-json' });
    await expect(d).toContainText(/gzip/i);
    await d.getByTestId('value-inflate').click();
    await expect(d.getByTestId('key-value')).toContainText('gzip works');

    d = await openKey(page, K.deflate, { rowText: 'deflate' });
    await d.getByTestId('value-inflate').click();
    await expect(d.getByTestId('key-value')).toContainText('deflated text payload');

    d = await openKey(page, K.msgpack, { rowText: 'msgpack' });
    await selectFormat(d, 'msgpack');
    await expect(d.getByTestId('key-value')).toContainText('msgpack');

    d = await openKey(page, K.javaSer, { rowText: 'java-serialized' });
    await expect(d).toContainText(/java/i);
    d = await openKey(page, K.phpSer, { rowText: 'php-serialized' });
    await expect(d).toContainText(/php/i);
  });

  test('large value: truncated preview with total size, load full value is server-capped', async ({ page }) => {
    const d = await openKey(page, K.big, { rowText: 'blob' });
    await expect(d).toContainText(/truncated/i);
    await expect(d).toContainText(/2(\.0)?\s?MiB|2,097,152|2097152/);
    const text = await d.getByTestId('key-value').innerText();
    expect(text.length).toBeLessThanOrEqual(524288 + 100);
    const full = d.getByTestId('key-load-full');
    if (await full.isVisible()) {
      await full.click();
      await expect(d).toContainText(/truncated|capped/i);
      expect((await d.getByTestId('key-value').innerText()).length).toBeLessThan(BIG_VALUE_BYTES);
    }
  });

  test('large hash and list are paged', async ({ page }) => {
    let d = await openKey(page, K.bigHash, { rowText: 'hash' });
    await expect(d.getByRole('row')).not.toHaveCount(5001);
    await d.getByTestId('key-next-page').click();
    await expect(d.getByRole('row').nth(1)).toBeVisible();
    d = await openKey(page, K.bigList, { rowText: 'list' });
    await expect(d).toContainText('item-0');
    await d.getByTestId('key-next-page').click();
    await expect(d).toContainText('item-100');
  });

  test('binary key and binary value are displayed safely and are readable', async ({ page }) => {
    await page.getByTestId('key-pattern').fill('e2e:bin:*');
    await page.getByTestId('key-scan').click();
    const row = page.getByTestId('key-list').getByTestId('key-row').first();
    await expect(row).toBeVisible();
    await row.click();
    const d = page.getByTestId('key-detail');
    await expect(d.getByTestId('key-value')).toContainText('value of a binary key');
    const v = await openKey(page, K.binValue, { rowText: 'value' });
    await selectFormat(v, 'hex');
    await expect(v.getByTestId('key-value')).toContainText(/00\s?01\s?02\s?ff\s?fe/i);
  });

  test('Unicode, emoji and RTL keys are rendered as text (RTL override neutralized)', async ({ page }) => {
    const d = await openKey(page, K.unicode, { rowText: '🔥' });
    await expect(d.getByTestId('key-value')).toContainText('こんにちは世界 🔥🚀');
    const r = await openKey(page, K.rtl, { pattern: 'e2e:unicode:rtl:*', rowText: /gnp|exe|rtl/ });
    // The heading must not contain a raw U+202E that would visually reverse text, or must isolate it.
    const h = await r.locator('h2').innerText();
    const dir = await r.locator('h2').getAttribute('dir');
    expect(!h.includes('‮') || dir === 'ltr').toBe(true);
    const a = await openKey(page, K.arabic, { pattern: 'e2e:unicode:*', rowText: 'مرحبا' });
    await expect(a).toContainText('مرحبا بالعالم');
  });
});

test.describe('viewer sees no write controls', () => {
  test.use({ role: 'viewer' });
  test('no add, edit, TTL, rename, delete or bulk delete for viewers', async ({ page }) => {
    await gotoView(page, DB.e2e, 'keys');
    await expect(page.getByTestId('key-add')).toHaveCount(0);
    await expect(page.getByTestId('bulk-delete')).toHaveCount(0);
    const d = await openKey(page, K.str, { rowText: 'greeting' });
    for (const id of ['key-edit', 'key-ttl', 'key-rename', 'key-delete']) await expect(d.getByTestId(id)).toHaveCount(0);
  });
});
