/**
 * Web review v0.2 round 3: editors bound to what they opened, compare-and-set saves (409 conflict UI), exact
 * MessagePack, complete copies, preview flags and RedisJSON paths. Writes use the test sandbox only. With
 * WEBFIX3_LIVE=1 (playwright.webfix3-live.config.ts) the same cases run against a live instance.
 */
import { readFileSync } from 'node:fs';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';
import { confirmDialog, consoleRun, gotoView, openKey, selectFormat, uiLogin } from '../../lib/ui.ts';

const live = process.env.WEBFIX3_LIVE === '1';
const liveRole = process.env.WEBFIX3_ROLE ?? 'operator';
const target = process.env.WEBFIX3_DB ?? DB.e2e;
const P = `${K.scratchPrefix}w3:`;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();
async function liveLogin(page: Page, role: string) {
  if (!live) return;
  const cached = sessions.get(role);
  if (cached) { await page.context().addCookies(cached.cookies); return; }
  const accounts = JSON.parse(readFileSync(new URL('../../../../.qa/accounts.json', import.meta.url), 'utf8'));
  await uiLogin(page, accounts.local[`qa-${role}`]);
  sessions.set(role, await page.context().storageState());
}
async function cleanup() {
  // Only this spec's exact prefix (the live config pins the port to an approved sandbox).
  let cursor = '0'; const keys: Buffer[] = [];
  do { const reply = await redisExec<[Buffer, Buffer[]]>(['SCAN', cursor, 'MATCH', `${P}*`, 'COUNT', 500]); cursor = String(reply[0]); keys.push(...reply[1]); } while (cursor !== '0');
  if (keys.length) await redisExec(['DEL', ...keys]);
}
test.afterAll(async () => { if (live) await cleanup(); });
test.afterEach(async ({ page }, info) => {
  if (live) await page.screenshot({ path: info.outputPath('live.png'), fullPage: true });
});
const bytes = async (args: (string | number)[]) => Buffer.from(await redisExec<Buffer>(args));
/** The clipboard through a native paste into a plain textarea (clipboard-read is off by Permissions Policy). */
async function pasted(page: Page): Promise<string> {
  await page.getByTestId('key-add').click();
  const dialog = page.getByTestId('key-editor-dialog');
  const area = dialog.getByTestId('key-edit-value');
  await area.fill('');
  await area.focus();
  await page.keyboard.press(`${mod}+v`);
  const text = await area.inputValue();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  return text;
}
const conflictIn = (scope: Locator) => scope.getByTestId('edit-conflict');

test.describe('web round 3 operator', () => {
  test.use({ role: live ? null : 'operator' });
  test.skip(live && liveRole === 'viewer', 'Write cases need operator or admin.');
  test.beforeEach(async ({ page }) => { await liveLogin(page, liveRole); await gotoView(page, target, 'keys'); });

  test('H1: a refreshed hash field closes the open draft; an unseen change gets 409 with the stored bytes', async ({ page }) => {
    const key = `${P}hash-live`;
    await redisExec(['DEL', key]); await redisExec(['HSET', key, 'f', 'YWJj']);
    const detail = await openKey(page, key);
    await detail.getByRole('button', { name: 'Edit hash field f' }).click();
    await detail.getByLabel('Value of f').fill('REVG');
    await redisExec(['HSET', key, 'f', Buffer.from([0xff, 0x00, 0x0d])]);
    await detail.getByRole('button', { name: 'Refresh key', exact: true }).click();
    await expect(detail.locator('form.row-panel')).toHaveCount(0);
    await expect(detail.getByRole('status')).toContainText('This field changed');
    expect((await bytes(['HGET', key, 'f'])).toString('hex')).toBe('ff000d');
    // Unobserved: the change happens after the last read; the server refuses and shows what it holds.
    await detail.getByRole('button', { name: 'Edit hash field f' }).click();
    await expect(detail.getByText('(base64; preserves CR / CRLF bytes)')).toBeVisible();
    await detail.getByLabel('Value of f').fill(Buffer.from('REVG').toString('base64'));
    await redisExec(['HSET', key, 'f', 'DEF']);
    await detail.getByRole('button', { name: 'Save', exact: true }).click();
    const conflict = conflictIn(detail);
    await expect(conflict).toContainText('This value changed since you opened it.');
    await expect(conflict.getByTestId('edit-conflict-current')).toHaveText('DEF');
    expect((await bytes(['HGET', key, 'f'])).toString('hex')).toBe('444546');
    await conflict.getByTestId('edit-conflict-overwrite').click();
    await expect(detail.locator('form.row-panel')).toHaveCount(0);
    expect((await bytes(['HGET', key, 'f'])).toString('hex')).toBe(Buffer.from('REVG').toString('hex'));
    // Console readback through the app (redis-cli quoting shows every byte).
    await gotoView(page, target, 'console');
    await consoleRun(page, `HGET ${key} f`);
    await expect(page.getByTestId('console-result').first().locator('pre.cli-reply')).toHaveText('"REVG"');
  });

  test('H2 A: a string editor never replaces a hash it observed or did not observe', async ({ page }) => {
    const key = `${P}type-change`;
    await redisExec(['DEL', key]); await redisExec(['SET', key, 'ORIGINAL']);
    let detail = await openKey(page, key);
    await detail.getByLabel('Key refresh interval').selectOption('5000');
    await detail.getByTestId('key-edit').click();
    let dialog = page.getByTestId('key-editor-dialog');
    await dialog.getByTestId('key-edit-value').fill('EDITED');
    await redisExec(['DEL', key]); await redisExec(['HSET', key, 'sensitive', 'KEEP-ME']);
    await expect(conflictIn(dialog)).toContainText('now a hash', { timeout: 12_000 });
    await expect(dialog.getByRole('heading')).toHaveText('Edit value');
    await expect(dialog.getByTestId('key-save')).toBeDisabled();
    await expect(conflictIn(dialog).getByTestId('edit-conflict-overwrite')).toHaveCount(0);
    expect(String(await redisExec(['TYPE', key]))).toBe('hash');
    // Reload reopens the editor on what the key is now.
    await conflictIn(dialog).getByTestId('edit-conflict-reload').click();
    await expect(dialog.getByRole('heading')).toHaveText('Set a hash field');
    await page.keyboard.press('Escape');
    await detail.getByLabel('Key refresh interval').selectOption('0');
    // Unobserved: no refresh between the change and Save.
    await redisExec(['DEL', key]); await redisExec(['SET', key, 'ORIGINAL']);
    detail = await openKey(page, key);
    await detail.getByRole('button', { name: 'Refresh key', exact: true }).click();
    await detail.getByTestId('key-edit').click();
    dialog = page.getByTestId('key-editor-dialog');
    await dialog.getByTestId('key-edit-value').fill('EDITED');
    await redisExec(['DEL', key]); await redisExec(['HSET', key, 'sensitive', 'KEEP-ME']);
    await dialog.getByTestId('key-save').click();
    await expect(conflictIn(dialog)).toContainText('now a hash');
    expect(String(await redisExec(['TYPE', key]))).toBe('hash');
    expect(String(await redisExec(['HGET', key, 'sensitive']))).toBe('KEEP-ME');
    await page.keyboard.press('Escape');
    await gotoView(page, target, 'console');
    await consoleRun(page, `TYPE ${key}`);
    await expect(page.getByTestId('console-result').first().locator('pre.cli-reply')).toHaveText('"hash"');
    await consoleRun(page, `HGET ${key} sensitive`);
    await expect(page.getByTestId('console-result').filter({ hasText: 'HGET' }).locator('pre.cli-reply')).toHaveText('"KEEP-ME"');
  });

  test('H2 B: a JSON item draft is never written to the item an insert moved under its index', async ({ page }) => {
    const key = `${P}array-retarget`;
    const before = '{"items":[{"id":"A","v":1},{"id":"B","v":2}]}';
    const after = '{"items":[{"id":"X","v":0},{"id":"A","v":1},{"id":"B","v":2}]}';
    await redisExec(['DEL', key]); await redisExec(['JSON.SET', key, '$', before]);
    const detail = await openKey(page, key);
    await detail.getByLabel('Key refresh interval').selectOption('5000');
    await detail.getByTestId('key-edit').click();
    const dialog = page.getByTestId('key-editor-dialog');
    await dialog.getByLabel('Pick a JSON path').selectOption('$["items"][1]');
    await dialog.getByTestId('key-edit-value').fill('{"id":"B","v":99}');
    await redisExec(['JSON.ARRINSERT', key, '$.items', 0, '{"id":"X","v":0}']);
    await expect(conflictIn(dialog)).toBeVisible({ timeout: 12_000 });
    await expect(conflictIn(dialog).getByTestId('edit-conflict-current')).toContainText('"id":"X"');
    await expect(dialog.getByTestId('key-save')).toBeDisabled();
    expect(String(await redisExec(['JSON.GET', key]))).toBe(after);
    // Reload reopens the editor on the document as it is now.
    await conflictIn(dialog).getByTestId('edit-conflict-reload').click();
    await expect(conflictIn(dialog)).toHaveCount(0);
    await expect.poll(() => dialog.getByLabel('Pick a JSON path').evaluate((select: HTMLSelectElement) => [...select.options].map((o) => o.value))).toContain('$["items"][2]');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Unobserved: no refresh between another insert and Save.
    await detail.getByLabel('Key refresh interval').selectOption('0');
    await detail.getByTestId('key-edit').click();
    await dialog.getByLabel('Pick a JSON path').selectOption('$["items"][2]');
    await dialog.getByTestId('key-edit-value').fill('{"id":"B","v":99}');
    await redisExec(['JSON.ARRINSERT', key, '$.items', 0, '{"id":"Y","v":-1}']);
    await dialog.getByTestId('key-save').click();
    await expect(conflictIn(dialog)).toContainText('This value changed since you opened it.');
    expect(String(await redisExec(['JSON.GET', key]))).toBe('{"items":[{"id":"Y","v":-1},{"id":"X","v":0},{"id":"A","v":1},{"id":"B","v":2}]}');
  });

  test('CAS: list and score edits, delete and rename refuse unseen changes; "anyway" sends a new expectation', async ({ page }) => {
    const list = `${P}list`, zset = `${P}zset`, del = `${P}del`, ren = `${P}ren`;
    await redisExec(['DEL', list, zset, del, ren, `${ren}-2`]);
    await redisExec(['RPUSH', list, 'A', 'B', 'C']); await redisExec(['ZADD', zset, 1, 'm']);
    await redisExec(['SET', del, 'v1']); await redisExec(['SET', ren, 'v1']);
    let detail = await openKey(page, list);
    await detail.getByRole('button', { name: 'Edit list index 1' }).click();
    await detail.getByLabel('Value at index 1').fill('X');
    await redisExec(['LSET', list, 1, 'Z']);
    await detail.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(conflictIn(detail).getByTestId('edit-conflict-current')).toHaveText('Z');
    expect(String(await redisExec(['LINDEX', list, 1]))).toBe('Z');
    await conflictIn(detail).getByTestId('edit-conflict-overwrite').click();
    await expect.poll(async () => String(await redisExec(['LINDEX', list, 1]))).toBe('X');

    detail = await openKey(page, zset);
    await detail.getByRole('button', { name: 'Edit score for m' }).click();
    await detail.getByLabel('Score of m').fill('5');
    await redisExec(['ZADD', zset, 2, 'm']);
    await detail.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(conflictIn(detail).getByTestId('edit-conflict-current')).toHaveText('2');
    expect(String(await redisExec(['ZSCORE', zset, 'm']))).toBe('2');

    detail = await openKey(page, del);
    await redisExec(['SET', del, 'v2']);
    await detail.getByTestId('key-delete').click();
    await confirmDialog(page);
    await expect(conflictIn(detail)).toContainText('This key changed since you read it.');
    await expect(conflictIn(detail).getByTestId('edit-conflict-current')).toHaveText('v2');
    expect(Number(await redisExec(['EXISTS', del]))).toBe(1);
    await conflictIn(detail).getByRole('button', { name: 'Delete anyway' }).click();
    await confirmDialog(page);
    await expect.poll(async () => Number(await redisExec(['EXISTS', del]))).toBe(0);

    detail = await openKey(page, ren);
    await detail.getByTestId('key-rename').click();
    const dialog = page.getByTestId('key-rename-dialog');
    await dialog.getByTestId('key-rename-input').fill(`${ren}-2`);
    await redisExec(['SET', ren, 'v2']);
    await dialog.getByTestId('key-rename-submit').click();
    await expect(conflictIn(dialog)).toContainText('This key changed since you read it.');
    expect(Number(await redisExec(['EXISTS', `${ren}-2`]))).toBe(0);
    await conflictIn(dialog).getByRole('button', { name: 'Rename anyway' }).click();
    await expect.poll(async () => String(await redisExec(['GET', `${ren}-2`]))).toBe('v2');
  });

  test('H3: MessagePack shows and copies exact 64-bit integers and non-JSON scalars', async ({ page }) => {
    const key = `${P}msgpack`;
    await redisExec(['SET', key, Buffer.from([0x82, 0xa1, 0x6e, 0xcf, 0x00, 0x20, 0, 0, 0, 0, 0, 0x01, 0xa1, 0x74, 0xd6, 0xff, 0, 0, 0, 1])]);
    const detail = await openKey(page, key);
    await selectFormat(detail, 'msgpack');
    await expect(detail.getByTestId('key-value')).toHaveText('{\n  "n": 9007199254740993,\n  "t": Timestamp("1970-01-01T00:00:01Z")\n}');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await detail.getByRole('button', { name: 'Copy value', exact: true }).click();
    expect(await pasted(page)).toBe('{\n  "n": 9007199254740993,\n  "t": Timestamp("1970-01-01T00:00:01Z")\n}');
    expect((await bytes(['GET', key])).toString('hex')).toBe('82a16ecf0020000000000001a174d6ff00000001');
  });

  test('M1: a capped JSON view and a Show-all console reply say so; their copies are complete', async ({ page }) => {
    const key = `${P}long-json`;
    const doc = `{"big":"${'x'.repeat(120000)}","end":9007199254740993}`;
    await redisExec(['SET', key, doc]);
    const detail = await openKey(page, key);
    await detail.getByTestId('key-load-full').click();
    await selectFormat(detail, 'json');
    await expect(detail.getByTestId('key-value')).toContainText('more characters not shown');
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await detail.getByRole('button', { name: 'Copy value', exact: true }).click();
    const copied = await pasted(page);
    expect(JSON.parse(copied).end).toBe(9007199254740992); // parsed by JS; the text keeps the token:
    expect(copied).toContain('"end": 9007199254740993');
    expect(copied.replace(/\s/g, '')).toBe(doc);
    await gotoView(page, target, 'console');
    await consoleRun(page, `GET ${key}`);
    const result = page.getByTestId('console-result').first();
    await result.getByRole('button', { name: /^Show all [\d,]+ characters$/ }).click();
    await expect(result.locator('pre.cli-reply')).toContainText('9007199254740993}"');
    await result.getByRole('button', { name: 'Copy result' }).click();
    // The clipboard write is asynchronous: wait for it before leaving the page.
    await expect(result.getByRole('button', { name: 'Copy result' })).toContainText('Copied');
    await gotoView(page, target, 'keys');
    const reply = await pasted(page);
    expect(reply.slice(0, 13)).toBe('"{\\"big\\":\\"x');
    expect(reply.slice(-32)).toBe('xxx\\",\\"end\\":9007199254740993}"');
    expect(reply.length).toBe(doc.length + 2 + (doc.match(/"/g) ?? []).length);
  });

  test('M2: a truncated hash value opens as a labelled preview', async ({ page }) => {
    const key = `${P}truncated-hash`;
    await redisExec(['DEL', key]); await redisExec(['HSET', key, 'f', `{"a":1}${' '.repeat(75000)}SECRET-END`]);
    const detail = await openKey(page, key);
    await expect(detail).toContainText('Some elements are truncated previews');
    await detail.getByTestId('value-cell-open').nth(1).click();
    const modal = page.getByTestId('value-inspector-dialog');
    await expect(modal).toContainText('Truncated preview');
    await expect(modal.getByRole('tab', { name: 'JSON' })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Copy preview' })).toBeVisible();
    await expect(modal.getByTestId('key-value')).not.toContainText('SECRET-END');
  });

  test('L1: generated paths address the property they name in RedisJSON; line breaks are not offered', async ({ page }) => {
    const key = `${P}path-0`;
    await redisExec(['DEL', key]);
    await redisExec(['JSON.SET', key, '$', JSON.stringify({ 'a\nb': 'target', 'a\\nb': 'decoy', 't\tx': 'tab', 'q"x': 'quote' })]);
    const detail = await openKey(page, key);
    const edit = async (path: string, value: string) => {
      await detail.getByTestId('key-edit').click();
      const dialog = page.getByTestId('key-editor-dialog');
      await dialog.getByLabel('Pick a JSON path').selectOption({ value: path });
      await dialog.getByTestId('key-edit-value').fill(value);
      await dialog.getByTestId('key-save').click();
      await expect(dialog).toBeHidden();
    };
    await detail.getByTestId('key-edit').click();
    const dialog = page.getByTestId('key-editor-dialog');
    const lineBreak = dialog.getByLabel('Pick a JSON path').locator('option', { hasText: 'not addressable here' });
    await expect(lineBreak).toHaveCount(1);
    await expect(lineBreak).toHaveAttribute('disabled', '');
    await expect(lineBreak).toHaveText('$["a\\u000ab"] (not addressable here)');
    await page.keyboard.press('Escape');
    await edit('$["t\tx"]', '"TAB-EDITED"');
    await edit('$["a\\\\nb"]', '"DECOY-EDITED"');
    await edit('$["q\\"x"]', '"QUOTE-EDITED"');
    expect(JSON.parse(String(await redisExec(['JSON.GET', key])))).toEqual({ 'a\nb': 'target', 'a\\nb': 'DECOY-EDITED', 't\tx': 'TAB-EDITED', 'q"x': 'QUOTE-EDITED' });
  });
});

test.describe('web round 3 viewer (read-only findings)', () => {
  test.use({ role: live ? null : 'viewer' });
  test.skip(live && liveRole !== 'viewer', 'The operator group covers these for writers.');
  test.beforeEach(async ({ page }) => { await liveLogin(page, 'viewer'); await gotoView(page, target, 'keys'); });
  test('H3 / M2: exact MessagePack and a labelled element preview, with no edit controls', async ({ page }) => {
    const mp = `${P}viewer-msgpack`, hash = `${P}viewer-truncated`;
    await redisExec(['SET', mp, Buffer.from([0xd3, 0xff, 0xdf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])]);
    await redisExec(['DEL', hash]); await redisExec(['HSET', hash, 'f', `{"a":1}${' '.repeat(75000)}SECRET-END`]);
    let detail = await openKey(page, mp);
    await selectFormat(detail, 'msgpack');
    await expect(detail.getByTestId('key-value')).toHaveText('-9007199254740993');
    for (const id of ['key-edit', 'key-rename', 'key-delete']) await expect(detail.getByTestId(id)).toHaveCount(0);
    detail = await openKey(page, hash);
    await detail.getByTestId('value-cell-open').nth(1).click();
    const modal = page.getByTestId('value-inspector-dialog');
    await expect(modal).toContainText('Truncated preview');
    await expect(modal.getByRole('tab', { name: 'JSON' })).toBeDisabled();
    await expect(modal.getByRole('button', { name: 'Copy preview' })).toBeVisible();
    if (!live) await redisExec(['DEL', mp, hash]);
  });
});
