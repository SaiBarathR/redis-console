/** Data fidelity and safe editing, v0.2 web review round 2. Writes use the test sandbox only. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Page, BrowserContext } from '@playwright/test';
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';
import { confirmDialog, consoleRun, gotoView, openKey, selectFormat, uiLogin } from '../../lib/ui.ts';
const live = process.env.WEBFIX2_LIVE === '1';
const liveRole = process.env.WEBFIX2_ROLE ?? 'operator';
const target = process.env.WEBFIX2_DB ?? DB.e2e;
const P = `${K.scratchPrefix}w2:`;
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();
async function liveLogin(page: Page, role: string) {
  if (!live) return;
  const cached = sessions.get(role);
  if (cached) { await page.context().addCookies(cached.cookies); return; }
  const accounts = JSON.parse(readFileSync(new URL('../../../../.qa/accounts.json', import.meta.url), 'utf8'));
  await uiLogin(page, accounts.local[`qa-${role}`]);
  sessions.set(role, await page.context().storageState());
}
async function cleanupLive() {
  if (!live) return;
  // Only this spec's exact prefix, on a whitelisted sandbox port configured by the live config.
  let cursor = '0'; const keys: Buffer[] = [];
  do { const reply = await redisExec<[Buffer, Buffer[]]>(['SCAN', cursor, 'MATCH', `${P}*`, 'COUNT', 200]); cursor = String(reply[0]); keys.push(...reply[1]); } while (cursor !== '0');
  if (keys.length) await redisExec(['DEL', ...keys]);
}
test.afterAll(cleanupLive);
test.afterEach(async ({ page }, info) => {
  if (live && /H1:|M5:|M7\/|exact read-only/.test(info.title))
    await page.screenshot({ path: info.outputPath('live.png'), fullPage: true });
});

test.describe('web round 2 operator', () => {
  test.use({ role: live ? null : 'operator' });
  test.skip(live && liveRole === 'viewer', 'Viewer coverage is in the read-only group below.');
  test.beforeEach(async ({ page }) => { await liveLogin(page, liveRole); await gotoView(page, target, 'keys'); });
  test('H1: exact JSON number display, clipboard, tree and path-picker save', async ({ page }) => {
    const key = `${P}json`;
    const cached = `${P}cached`;
    const text = '{"big":9007199254740993,"decimal":1.0,"exp":1.5e3,"zero":-0}';
    await redisExec(['SET', cached, text]);
    await redisExec(['JSON.SET', key, '$', '{"big":9007199254740993,"name":"before"}']);
    let detail = await openKey(page, cached);
    for (const number of ['9007199254740993', '1.0', '1.5e3', '-0']) await expect(detail.getByTestId('key-value')).toContainText(number);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await detail.getByRole('button', { name: 'Copy value', exact: true }).click();
    await expect(detail.getByRole('button', { name: 'Copy value', exact: true })).toHaveText('Copied');
    // Native paste verifies the actual clipboard; clipboard-read is denied by the app's Permissions Policy.
    await page.getByTestId('key-pattern').fill('');
    await page.getByTestId('key-pattern').click();
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+v`);
    const copied = await page.getByTestId('key-pattern').inputValue();
    for (const number of ['9007199254740993', '1.0', '1.5e3', '-0']) expect(copied).toContain(number);
    await selectFormat(detail, 'tree');
    await expect(detail.getByTestId('key-value')).toContainText('1.5e3');
    detail = await openKey(page, key);
    await detail.getByTestId('key-edit').click();
    const dialog = page.getByTestId('key-editor-dialog');
    await dialog.getByLabel('Pick a JSON path').selectOption('$["name"]');
    await dialog.getByLabel('Pick a JSON path').selectOption('$');
    const edited = (await dialog.getByTestId('key-edit-value').inputValue()).replace('before', 'after');
    expect(edited).toContain('9007199254740993');
    await dialog.getByTestId('key-edit-value').fill(edited);
    const sent = page.waitForRequest(r => r.url().endsWith('/ops') && r.postDataJSON()?.op === 'json.set');
    await dialog.getByTestId('key-save').click();
    expect((await sent).postDataJSON().json).toBe(edited);
    await expect(dialog).toBeHidden();
    expect(String(await redisExec(['JSON.GET', key]))).toBe('{"big":9007199254740993,"name":"after"}');
    await gotoView(page, target, 'console');
    await page.getByTestId('reply-view-tree').click();
    await consoleRun(page, `GET ${cached}`);
    await expect(page.getByTestId('console-result').first()).toContainText('9007199254740993');
    await expect(page.getByTestId('console-result').first()).toContainText('1.5e3');
  });
  test('H2: manual and automatic refetch invalidate a displaced list draft', async ({ page }) => {
    const key = `${P}list`;
    await redisExec(['DEL', key]); await redisExec(['RPUSH', key, 'A0', 'A1', 'A2', 'A3']);
    const detail = await openKey(page, key);
    await detail.getByRole('button', { name: 'Edit list index 2' }).click();
    await detail.getByLabel('Value at index 2').fill('EDITED');
    await redisExec(['LPUSH', key, 'X']);
    await detail.getByRole('button', { name: 'Refresh key', exact: true }).click();
    await expect(detail.locator('form.row-panel')).toHaveCount(0);
    await expect(detail).toContainText('This list changed');
    expect(String(await redisExec(['LINDEX', key, 2]))).toBe('A1');
    await detail.getByRole('button', { name: 'Edit list index 2' }).click();
    await detail.getByLabel('Value at index 2').fill('EDITED');
    await detail.getByLabel('Key refresh interval').selectOption('5000');
    await redisExec(['LPUSH', key, 'Y']);
    await expect(detail.locator('form.row-panel')).toHaveCount(0, { timeout: 10000 });
    expect(String(await redisExec(['LINDEX', key, 2]))).toBe('A0');
  });
  test('H3: BOM and plain keys stay distinct through read and confirmed delete', async ({ page }) => {
    const key = `${P}bom`; const bom = `\ufeff${key}`;
    await redisExec(['SET', key, 'plain']); await redisExec(['SET', bom, '\ufeffBOM-value']);
    try {
      await page.getByTestId('key-delimiter').fill('');
      await page.getByTestId('key-pattern').fill(`*${key}`);
      await page.getByTestId('key-scan').click();
      await expect(page.getByTestId('key-list').getByTestId('key-row')).toHaveCount(2);
      await page.getByTestId('key-row').filter({ hasText: '\\xef\\xbb\\xbf' }).click();
      const detail = page.getByTestId('key-detail');
      await expect(detail.getByTestId('key-value')).toHaveText('\\ufeffBOM-value');
      await detail.getByTestId('key-delete').click(); await confirmDialog(page);
      await expect.poll(async () => String(await redisExec(['EXISTS', bom]))).toBe('0');
      expect(String(await redisExec(['GET', key]))).toBe('plain');
    } finally { await redisExec(['DEL', bom, key]); }
  });
  test('M1/M2: strings keep TTL and CRLF, and expiry removal is explicit', async ({ page }) => {
    const key = `${P}crlf`; await redisExec(['SET', key, 'a\r\nb\r\nc', 'EX', 3600]);
    const detail = await openKey(page, key);
    await expect(detail.getByTestId('key-value')).toContainText('\\u000d');
    await detail.getByTestId('key-edit').click();
    let dialog = page.getByTestId('key-editor-dialog');
    await expect(dialog.getByTestId('key-edit-encoding')).toHaveValue('base64');
    await expect(dialog.getByRole('checkbox', { name: /Keep current expiry/ })).toBeChecked();
    await dialog.getByTestId('key-edit-value').fill(Buffer.from('A\r\nb\r\nc').toString('base64'));
    await dialog.getByTestId('key-save').click(); await expect(dialog).toBeHidden();
    expect(String(await redisExec(['GET', key]))).toBe('A\r\nb\r\nc');
    expect(Number(await redisExec(['TTL', key]))).toBeGreaterThan(3500);
    await detail.getByTestId('key-edit').click(); dialog = page.getByTestId('key-editor-dialog');
    await dialog.getByRole('checkbox', { name: /Keep current expiry/ }).uncheck();
    await dialog.getByTestId('key-save').click(); await expect(dialog).toBeHidden();
    expect(Number(await redisExec(['TTL', key]))).toBe(-1);
  });
  test('M2/M3: inline bytes preserve CRLF and epoch-like values stay raw', async ({ page }) => {
    const key = `${P}hash`; await redisExec(['HSET', key, 'crlf', 'a\r\nb', 'id', '1700000000']);
    const detail = await openKey(page, key);
    await expect(detail.getByText('1700000000', { exact: true })).toBeVisible();
    await expect(detail).toContainText('Timestamp hint: 2023-11-14');
    await detail.getByRole('button', { name: 'Edit hash field crlf' }).click();
    await expect(detail.getByLabel(/Value of crlf/)).toHaveValue(Buffer.from('a\r\nb').toString('base64'));
    await detail.getByLabel(/Value of crlf/).fill(Buffer.from('A\r\nb').toString('base64'));
    await detail.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(detail.locator('form.row-panel')).toHaveCount(0);
    expect(String(await redisExec(['HGET', key, 'crlf']))).toBe('A\r\nb');
  });
  test('M5: key dialogs focus fields and restore their triggers', async ({ page }) => {
    const key = `${P}focus`; await redisExec(['SET', key, 'x']); const detail = await openKey(page, key);
    for (const [trigger, dialog, field] of [['key-rename','key-rename-dialog','key-rename-input'], ['key-ttl','key-ttl-dialog','key-ttl-input']] as const) {
      await detail.getByTestId(trigger).click();
      await expect(page.getByTestId(dialog).getByTestId(field)).toBeFocused();
      await page.keyboard.press('Escape'); await expect(detail.getByTestId(trigger)).toBeFocused();
    }
    await page.getByTestId('key-add').click();
    await expect(page.getByTestId('key-create-type')).toBeFocused();
    await page.keyboard.press('Escape'); await expect(page.getByTestId('key-add')).toBeFocused();
  });
  for (const view of ['console', 'workbench']) test(`M6: ${view} navigation retains an uncertain run`, async ({ page }) => {
    const key = `${P}${view}:blocked`; await redisExec(['DEL', key]);
    // Wait out a previous aborted blocking operation's admission slot.
    await page.waitForTimeout(3500);
    await gotoView(page, target, view);
    const editor = page.getByTestId(`${view}-editor-input`);
    await editor.fill(view === 'workbench' ? `BLPOP ${key} 3\nINCR ${P}must-not-run` : `BLPOP ${key} 3`);
    await page.getByTestId(`${view === 'workbench' ? 'workbench' : 'console'}-run`).click();
    await expect(page.getByTestId('console-running')).toBeVisible();
    await page.getByTestId('nav-keys').click(); await page.getByTestId(`nav-${view}`).click();
    const block = page.getByTestId('console-result').first();
    await expect(block).toHaveAttribute('data-status', 'cancelled');
    await expect(block).toContainText(/may have run|may still complete|which lines ran is unknown/i);
    if (view === 'workbench') expect(Number(await redisExec(['EXISTS', `${P}must-not-run`]))).toBe(0);
  });
  test('UX7: bulk expiry and delete report counts, seconds and limits', async ({ page }) => {
    const keys = Array.from({ length: 101 }, (_, i) => `${P}bulk:${i}`);
    await redisExec(['MSET', ...keys.flatMap(key => [key, 'x'])]);
    await page.getByTestId('key-delimiter').fill('');
    await page.getByTestId('key-pattern').fill(`${P}bulk:*`); await page.getByTestId('key-scan').click();
    await expect(page.getByTestId('key-scan')).toBeEnabled();
    // SCAN can return a partial first page; drain before selecting.
    const more = page.getByRole('button', { name: 'Scan to end', exact: true });
    if (await more.isEnabled()) { await more.click(); await expect(page.getByTestId('key-load-more')).toHaveText('Scan complete'); }
    await page.getByRole('checkbox', { name: 'Select all loaded keys', exact: true }).check();
    const selected = page.getByRole('region', { name: 'Selected keys' });
    await expect(selected.getByRole('button', { name: 'Set TTL', exact: true })).toBeDisabled();
    await expect(selected).toContainText('Set TTL supports up to 100 UTF-8 keys at a time.');
    await selected.getByRole('button', { name: 'Clear', exact: true }).click();
    await page.getByTestId('key-pattern').fill(`${P}bulk:0`); await page.getByTestId('key-scan').click();
    await page.getByRole('checkbox', { name: 'Select all loaded keys', exact: true }).check();
    await selected.getByRole('button', { name: 'Set TTL', exact: true }).click();
    await expect(page.getByText('TTL set on 1 of 1 keys (3600 seconds).', { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Select all loaded keys', exact: true }).check();
    await page.getByTestId('selection-delete').click(); await confirmDialog(page);
    await expect(page.getByText('Deleted 1 key.', { exact: true })).toBeVisible();
    await redisExec(['DEL', ...keys]);
  });
  test('L6: clearing the Console draft can be undone', async ({ page }) => {
    await gotoView(page, target, 'console');
    const editor = page.getByTestId('console-editor-input');
    const draft = `HSET ${P}undo f draft-not-run`;
    await editor.fill(draft); await editor.press('Escape'); await editor.press('Escape');
    await expect(editor.locator('.cm-placeholder')).toBeVisible();
    await editor.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
    await expect(editor).toHaveText(draft);
  });
  test('M7/UX4/UX5: Guided matches its preview and clears stale results; title identifies database', async ({ page }) => {
    await gotoView(page, target, 'guided');
    await expect(page).toHaveTitle(/Guided mode · .+ \[(?:test|dev)\] — Redis Console/);
    await expect(page.getByTestId('guided-key')).toHaveAttribute('placeholder', 'e.g. session:*');
    await expect(page.getByTestId('guided-command')).toHaveText('SCAN 0 MATCH * COUNT 200');
    await expect(page.getByText(/Empty pattern matches every key/)).toBeVisible();
    const sent = page.waitForRequest(r => r.url().endsWith('/keys/scan'));
    await page.getByTestId('guided-run').click(); expect((await sent).postDataJSON().match).toBe('*');
    await page.getByTestId('guided-ttl').click(); await page.getByTestId('guided-key').fill(`${P}missing`);
    await page.getByTestId('guided-run').click(); await expect(page.getByText('The key does not exist; nothing changed.')).toBeVisible();
    await page.getByTestId('guided-number').fill('42'); await expect(page.getByText('The key does not exist; nothing changed.')).toHaveCount(0);
    await expect(page.getByText('Done', { exact: true })).toHaveCount(0);
  });
});


test.describe('web round 2 viewer', () => {
  test.use({ role: live ? null : 'viewer' });
  test.skip(live && liveRole !== 'viewer', 'Separate live role run.');
  test.beforeEach(async ({ page }) => { await liveLogin(page, 'viewer'); });
  test('H1/H3/M3/M5/M7: exact read-only values, value-dialog focus, Guided defaults', async ({ page }) => {
    const key = `${P}viewer-json`;
    const bom = `\ufeff${P}viewer-bom`;
    await redisExec(['SET', key, '{"big":9007199254740993,"decimal":1.0,"zero":-0}']);
    await redisExec(['SET', bom, '\ufeffread-only']);
    await redisExec(['HSET', `${P}viewer-hash`, 'id', '1700000000']);
    try {
      await gotoView(page, target, 'keys');
      let detail = await openKey(page, key);
      await expect(detail.getByTestId('key-value')).toContainText('9007199254740993');
      await expect(detail.getByTestId('key-edit')).toHaveCount(0);
      await selectFormat(detail, 'tree'); await expect(detail.getByTestId('key-value')).toContainText('-0');
      detail = await openKey(page, bom, { rowText: /viewer-bom/ });
      await expect(detail.getByTestId('key-value')).toHaveText('\\ufeffread-only');
      detail = await openKey(page, `${P}viewer-hash`);
      const value = detail.getByRole('button', { name: /^1700000000/ });
      await expect(value).toContainText('1700000000');
      await value.click(); await expect(page.getByTestId('value-inspector-dialog')).toBeVisible();
      await page.keyboard.press('Escape'); await expect(value).toBeFocused();
      await gotoView(page, target, 'guided');
      await expect(page.getByText(/Empty pattern matches every key/)).toBeVisible();
    } finally { await redisExec(['DEL', key, bom, `${P}viewer-hash`]); }
  });
  test('M4: unattended Overview polling does not refresh the session', async ({ page }) => {
    await gotoView(page, target, 'overview');
    await expect(page.getByTestId('nav-overview')).toBeVisible();
    const requests: { path: string; background: string | undefined }[] = [];
    page.on('request', r => { if (r.url().includes('/api/v1/')) requests.push({ path: new URL(r.url()).pathname, background: r.headers()['x-rc-background'] }); });
    let lastSeen: number | undefined;
    let hash: string | undefined;
    if (live) {
      const cookie = (await page.context().cookies()).find(c => c.name === 'rc_session')!;
      hash = createHash('sha256').update(cookie.value).digest('hex');
      const db = new DatabaseSync('/tmp/rc-v02-webfix2/rconsole.sqlite', { readOnly: true });
      lastSeen = (db.prepare('SELECT last_seen_at FROM sessions WHERE id_hash = ?').get(hash) as { last_seen_at: number }).last_seen_at; db.close();
    }
    await page.waitForTimeout(32000);
    const polls = requests.filter(r => /\/(overview|databases)$/.test(r.path));
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(polls.every(r => r.background === '1')).toBe(true);
    expect(requests.filter(r => r.path.endsWith('/auth/me'))).toHaveLength(0);
    if (live) {
      const db = new DatabaseSync('/tmp/rc-v02-webfix2/rconsole.sqlite', { readOnly: true });
      expect((db.prepare('SELECT last_seen_at FROM sessions WHERE id_hash = ?').get(hash!) as {last_seen_at: number}).last_seen_at).toBe(lastSeen); db.close();
      // Our isolated instance only: expire this viewer session and verify sign-in stays usable.
      const ownDb = new DatabaseSync('/tmp/rc-v02-webfix2/rconsole.sqlite');
      ownDb.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?').run(Date.now() - 1000, hash!); ownDb.close();
      await page.getByTestId('nav-keys').click();
      await expect(page.getByTestId('session-ended')).toBeVisible();
      await expect(page.getByTestId('login-username')).toBeVisible();
    }
  });
});

test.describe('web round 2 admin', () => {
  test.use({ role: live ? null : 'admin' });
  test.skip(live && liveRole !== 'admin', 'Separate live admin run.');
  test('M5: create-user dialog focuses username and restores Add user', async ({ page }) => {
    await liveLogin(page, 'admin'); await page.goto('/admin/users');
    await page.getByTestId('user-add').click(); await expect(page.getByTestId('user-username')).toBeFocused();
    await page.keyboard.press('Escape'); await expect(page.getByTestId('user-add')).toBeFocused();
  });
});
