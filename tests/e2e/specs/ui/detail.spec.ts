/** DETAIL parity: real Chromium, Redis byte readback, CSP/secret/storage guards from lib/test. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Cookie } from '@playwright/test';
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';
import { confirmDialog, gotoView, openKey, uiLogin } from '../../lib/ui.ts';

const live = process.env.DETAIL_LIVE === '1';
const target = process.env.DETAIL_DB ?? DB.e2e;
const liveCookies = new Map<string, Cookie[]>();
const roles = live ? [process.env.DETAIL_ROLE ?? 'operator'] : ['viewer', 'operator', 'admin'];
const P = `${K.scratchPrefix}detail:${live ? process.env.DETAIL_ROLE : 'suite'}:`;
const b = (s: string) => ({ enc: 'utf8', data: s });
const fullBytes = Buffer.concat([Buffer.from([0xff, 0, 13, 10]), Buffer.alloc(80000, 65)]);
const sha = (v: Buffer) => createHash('sha256').update(v).digest('hex');
async function clean() {
  let cursor = '0'; const keys: Buffer[] = [];
  do { const res = await redisExec<[Buffer, Buffer[]]>(['SCAN', cursor, 'MATCH', `${P}*`, 'COUNT', 1000]); cursor = String(res[0]); keys.push(...res[1]); } while (cursor !== '0');
  if (keys.length) await redisExec(['UNLINK', ...keys]);
}
async function seed() {
  const fields = Array.from({ length: 1200 }, (_, i) => [`f:${i}`, `v:${i}`]).flat();
  await redisExec(['HSET', `${P}hash`, ...fields]);
  await redisExec(['HSET', `${P}formats`, 'json', '{"n":9007199254740993,"x":"<img src=x onerror=alert(1)>"}', 'vector', Buffer.from(new Float32Array([1.5, -2, 0]).buffer), 'large', fullBytes]);
  await redisExec(['SADD', `${P}set`, ...Array.from({ length: 1200 }, (_, i) => `m:${i}`)]);
  await redisExec(['RPUSH', `${P}list`, ...Array.from({ length: 1200 }, (_, i) => `v:${i}`)]);
  await redisExec(['ZADD', `${P}zset`, ...Array.from({ length: 1200 }, (_, i) => [i, `m:${i}`]).flat()]);
  for (let i = 1; i <= 3; i++) await redisExec(['XADD', `${P}stream`, `${i}-0`, 'f', `v${i}`]);
  await redisExec(['XGROUP', 'CREATE', `${P}stream`, 'g', '0']);
  await redisExec(['XREADGROUP', 'GROUP', 'g', 'worker', 'COUNT', 3, 'STREAMS', `${P}stream`, '>']);
  for (const name of ['hash', 'formats', 'set', 'list', 'zset', 'stream']) await redisExec(['EXPIRE', P + name, 3600]);
}
for (const role of roles) {
  test.describe(`DETAIL ${role}`, () => {
    test.use({ role: live ? null : role, permissions: ["clipboard-read", "clipboard-write"] });
    test.beforeAll(async () => { await clean(); await seed(); });
    test.afterAll(clean);
    test.afterEach(async ({ page }, info) => {
      if (live && info.title.includes('F3/F17')) await page.screenshot({ path: info.outputPath('collection-format.png'), fullPage: true });
    });
    test.beforeEach(async ({ page }) => {
      if (live) {
        const accounts = JSON.parse(readFileSync(new URL('../../../../.qa/accounts.json', import.meta.url), 'utf8'));
        const cookies = liveCookies.get(role);
        if (cookies) await page.context().addCookies(cookies);
        else { await uiLogin(page, accounts.local[`qa-${role}`]); liveCookies.set(role, await page.context().cookies()); }
      }
      await gotoView(page, target, 'keys');
    });
    test('F1: unloaded hash/set/zset lookup, list jump, reverse and score ranges', async ({ page }) => {
      let detail = await openKey(page, `${P}hash`);
      await detail.getByLabel('Collection lookup mode').selectOption('exact');
      await detail.getByLabel('Collection lookup', { exact: true }).fill('f:1199'); await detail.getByText('Apply lookup', { exact: true }).click();
      await expect(detail.getByTestId('collection-filter-count')).toContainText('1 filter matches'); await expect(detail).toContainText('v:1199');
      await detail.getByLabel('Collection lookup mode').selectOption('match'); await detail.getByLabel('Collection lookup', { exact: true }).fill('f:119?'); await detail.getByText('Apply lookup', { exact: true }).click();
      await expect(detail.getByTestId('collection-filter-count')).toContainText('total matches unknown');
      detail = await openKey(page, `${P}set`);
      await detail.getByLabel('Collection lookup mode').selectOption('exact'); await detail.getByLabel('Collection lookup', { exact: true }).fill('m:1199'); await detail.getByText('Apply lookup', { exact: true }).click();
      await expect(detail.getByTestId('collection-filter-count')).toContainText('1 filter matches'); await expect(detail.getByTestId('value-cell-open')).toHaveText('m:1199');
      detail = await openKey(page, `${P}list`); await detail.getByLabel('List index', { exact: true }).fill('1100'); await detail.getByText('Apply lookup', { exact: true }).click();
      await expect(detail.getByTestId('value-cell-open').first()).toContainText('v:1100'); await expect(detail.getByText('Previous page', { exact: true })).toBeVisible();
      detail = await openKey(page, `${P}zset`); await detail.getByLabel('Highest score first (range reads)').check(); await detail.getByText('Apply lookup', { exact: true }).click();
      await expect(detail.getByTestId('value-cell-open').first()).toHaveText('m:1199');
      await detail.getByLabel('Collection lookup mode').selectOption('score'); await detail.getByLabel('Minimum score').fill('100'); await detail.getByLabel('Maximum score').fill('105'); await detail.getByText('Apply lookup', { exact: true }).click();
      await expect(detail.getByTestId('collection-filter-count')).toContainText('6 filter matches'); await expect(detail.getByTestId('value-cell-open').first()).toHaveText('m:105');
      await detail.getByLabel('Collection lookup mode').selectOption('match'); await detail.getByLabel('Collection lookup', { exact: true }).fill('m:119?'); await detail.getByText('Apply lookup', { exact: true }).click(); await expect(detail).toContainText('ZSCAN; scan order');
      expect(page.url()).not.toContain('1199');
    });
    test('F3/F17: collection JSON and vector formatting, expansion and column widths', async ({ page }) => {
      const detail = await openKey(page, `${P}formats`);
      await detail.getByLabel('Collection lookup mode').selectOption('exact'); await detail.getByLabel('Collection lookup', { exact: true }).fill('json'); await detail.getByText('Apply lookup', { exact: true }).click();
      await detail.getByLabel('Collection value format').selectOption('json');
      await expect(detail.getByTestId('value-cell-open').nth(1)).toContainText('9007199254740993');
      await expect(detail.getByTestId('value-cell-open').nth(1)).toContainText('"n": 9007199254740993');
      await detail.getByText('Expand value', { exact: true }).nth(1).click(); await expect(detail.getByTestId('key-value')).toContainText('9007199254740993');
      await detail.getByLabel('Field column width').fill('60'); await expect(detail.locator('col').first()).toHaveAttribute('style', 'width: 60%;');
      await detail.getByLabel('Collection lookup', { exact: true }).fill('vector'); await detail.getByText('Apply lookup', { exact: true }).click();
      await detail.getByLabel('Collection value format').selectOption('float32le'); await expect(detail.getByTestId('value-cell-open').nth(1)).toHaveText('[1.5, -2, 0]');
      expect(await page.locator('img[src="x"]').count()).toBe(0);
    });
    test('F6: batch field TTL and role-gated expiry set/remove', async ({ page }) => {
      const detail = await openKey(page, `${P}hash`);
      await detail.getByLabel('Collection lookup mode').selectOption('exact'); await detail.getByLabel('Collection lookup', { exact: true }).fill('f:1199'); await detail.getByText('Apply lookup', { exact: true }).click();
      await expect(detail.getByRole('columnheader', { name: 'Field TTL' })).toBeVisible(); await expect(detail.getByText('No expiry', { exact: true }).first()).toBeVisible();
      await detail.getByRole('button', { name: 'Field TTL for f:1199', exact: true }).click();
      if (role === 'viewer') { await expect(detail.getByText('Set field TTL', { exact: true })).toHaveCount(0); return; }
      await detail.getByLabel('Field TTL seconds').fill('600'); await detail.getByText('Set field TTL', { exact: true }).click();
      await expect.poll(async () => Number((await redisExec<any[]>(['HTTL', `${P}hash`, 'FIELDS', 1, 'f:1199']))[0])).toBeGreaterThan(590);
      await detail.getByText('Remove field expiry', { exact: true }).click(); await expect.poll(async () => Number((await redisExec<any[]>(['HTTL', `${P}hash`, 'FIELDS', 1, 'f:1199']))[0])).toBe(-1);
    });
    test('F9: full binary element retrieval and exact bounded download', async ({ page }) => {
      const detail = await openKey(page, `${P}formats`);
      await detail.getByLabel('Collection lookup mode').selectOption('exact'); await detail.getByLabel('Collection lookup', { exact: true }).fill('large'); await detail.getByText('Apply lookup', { exact: true }).click();
      await detail.getByTestId('value-cell-open').nth(1).click(); const dialog = page.getByTestId('value-inspector-dialog');
      await expect(dialog.getByTestId('value-download')).toBeDisabled(); await dialog.getByTestId('element-load-full').click(); await expect(dialog.getByTestId('value-download')).toBeEnabled();
      const downloadPromise = page.waitForEvent('download'); await dialog.getByTestId('value-download').click(); const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe('redis-value.bin'); expect(sha(readFileSync((await download.path())!))).toBe(sha(fullBytes));
      await dialog.getByRole('tab', { name: 'Base64', exact: true }).click(); await expect(dialog.getByTestId('key-value')).toHaveText(fullBytes.toString('base64'));
      await dialog.getByText('Copy value', { exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Copy value', exact: true })).toHaveText('Copied');
      if (role !== 'viewer') {
        await dialog.getByText('Edit full element', { exact: true }).click();
        await dialog.getByLabel('Full element value').fill(Buffer.from([0xff, 0, 13, 10, 66]).toString('base64'));
        await redisExec(['HSET', `${P}formats`, 'large', 'concurrent']);
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(dialog.getByTestId('edit-conflict')).toContainText('concurrent');
        await dialog.getByTestId('edit-conflict-overwrite').click(); await expect(dialog).toBeHidden();
        expect(Buffer.from(await redisExec<Buffer>(['HGET', `${P}formats`, 'large'])).toString('hex')).toBe('ff000d0a42');
      } else await dialog.getByRole('button', { name: 'Close dialog' }).click();
      const input = detail.getByLabel('Collection lookup', { exact: true }); await input.fill(''); await input.press('ControlOrMeta+v'); await expect(input).not.toHaveValue(''); expect(sha(Buffer.from(await input.inputValue(), 'base64'))).toBe(sha(fullBytes));
    });
    test('F18: repeatable additions and exact replacement conflicts', async ({ page }) => {
      if (role === 'viewer') { const detail = await openKey(page, `${P}hash`); await expect(detail.getByTestId('collection-add')).toHaveCount(0); return; }
      const detail = await openKey(page, `${P}hash`); await detail.getByTestId('collection-add').click(); let dialog = page.getByTestId('multi-entry-dialog');
      await dialog.getByLabel('Field 1', { exact: true }).fill('multi-a'); await dialog.getByLabel('Value 1', { exact: true }).fill('A'); await dialog.getByText('Add another entry', { exact: true }).click(); await dialog.getByLabel('Field 2', { exact: true }).fill('multi-b'); await dialog.getByLabel('Value 2', { exact: true }).fill('B'); await dialog.getByText('Review entries', { exact: true }).click();
      await redisExec(['HSET', `${P}hash`, 'multi-b', 'changed']); await dialog.getByText('Apply entries', { exact: true }).click();
      await expect(dialog.getByTestId('multi-entry-summary')).toContainText('1 of 2 commands completed'); await expect(dialog.getByTestId('edit-conflict')).toContainText('changed');
      expect(String(await redisExec(['HGET', `${P}hash`, 'multi-a']))).toBe('A'); expect(String(await redisExec(['HGET', `${P}hash`, 'multi-b']))).toBe('changed');
      await dialog.getByTestId('edit-conflict-overwrite').click(); await expect(dialog.getByTestId('multi-entry-summary')).toContainText('2 of 2 commands completed'); expect(String(await redisExec(['HGET', `${P}hash`, 'multi-b']))).toBe('B');
      await dialog.getByRole('button', { name: 'Close dialog' }).click();
      for (const type of ['set', 'zset', 'list']) {
        const d = await openKey(page, `${P}${type}`); await d.getByTestId('collection-add').click(); dialog = page.getByTestId('multi-entry-dialog');
        await dialog.getByLabel('Value 1', { exact: true }).fill('added-1'); await dialog.getByText('Add another entry', { exact: true }).click(); await dialog.getByLabel('Value 2', { exact: true }).fill('added-2'); await dialog.getByText('Review entries', { exact: true }).click(); await dialog.getByText('Apply entries', { exact: true }).click();
        await expect(dialog.getByTestId('multi-entry-summary')).toContainText(type === 'zset' ? '2 of 2' : '1 of 1'); await dialog.getByRole('button', { name: 'Close dialog' }).click();
        if (type === 'set') expect(Number(await redisExec(['SISMEMBER', `${P}set`, 'added-2']))).toBe(1);
        if (type === 'zset') expect(String(await redisExec(['ZSCORE', `${P}zset`, 'added-2']))).toBe('0');
        if (type === 'list') expect(String(await redisExec(['LINDEX', `${P}list`, -1]))).toBe('added-2');
      }
    });
    test('F15: groups to consumers to pending, ID range and confirmed claim/ack', async ({ page }) => {
      const detail = await openKey(page, `${P}stream`); await detail.getByText('Consumer groups, consumers and pending messages', { exact: true }).click();
      const inspector = detail.getByTestId('stream-inspector'); await expect(inspector).toContainText('worker');
      await redisExec(['XGROUP', 'CREATE', `${P}stream`, 'a', '0']); await inspector.getByText('Refresh stream groups', { exact: true }).click();
      await expect(inspector.getByLabel('Inspector consumer group').locator('option:checked')).toHaveText(/^g ·/);
      await inspector.getByText('Pending for consumer 1', { exact: true }).click();
      await inspector.getByLabel('Pending start ID').fill('2-0'); await inspector.getByLabel('Pending end ID').fill('2-0'); await inspector.getByText('Find pending IDs', { exact: true }).click();
      await expect(inspector).toContainText('1 matching pending messages on this page');
      await inspector.getByRole('button', { name: 'Inspect pending entry 2-0', exact: true }).click(); await expect(page.getByTestId('pending-entry-dialog')).toContainText('v2'); await page.getByTestId('pending-entry-dialog').getByRole('button', { name: 'Close dialog' }).click();
      if (role === 'viewer') { await expect(inspector.getByText('Claim selected (confirm)', { exact: true })).toHaveCount(0); return; }
      await inspector.getByLabel('Select pending 2-0').check(); await inspector.getByLabel('Claim target consumer').fill('new-worker'); await inspector.getByLabel('Claim minimum idle milliseconds').fill('0'); await inspector.getByText('Claim selected (confirm)', { exact: true }).click(); await confirmDialog(page);
      await inspector.getByText('All consumers', { exact: true }).click(); await expect(inspector.getByRole('cell', { name: 'new-worker', exact: true }).last()).toBeVisible();
      await inspector.getByLabel('Select pending 2-0').check(); await inspector.getByText('Acknowledge selected (confirm)', { exact: true }).click(); await confirmDialog(page);
      // On a slow runner the refresh after the acknowledgement can hit the per-user limit of four concurrent data
      // reads (HTTP 429, shown inline). Refresh again until the inspector reflects the acknowledgement.
      await expect(async () => {
        if ((await inspector.textContent())?.includes('Too many requests at once')) await inspector.getByText('Refresh stream groups', { exact: true }).click();
        await expect(inspector).toContainText('0 matching pending messages on this page', { timeout: 3_000 });
      }).toPass({ timeout: 20_000 });
      expect(Number((await redisExec<any[]>(['XPENDING', `${P}stream`, 'g']))[0])).toBe(2);
    });
  });
}
