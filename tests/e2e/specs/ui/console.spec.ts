/** Console (autocomplete, policy badge, docs, history, blocked commands), workbench and guided mode. */
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';
import { consoleRun, gotoView, setEditor } from '../../lib/ui.ts';
import { tokenizeCommandLine } from '@rconsole/shared';

/** The guided preview may quote arguments; compare the argv it would run, like redis-cli would parse it. */
async function expectGuidedArgv(page: import('@playwright/test').Page, argv: string[]) {
  await expect.poll(async () => tokenizeCommandLine(await page.getByTestId('guided-command').innerText())).toEqual(argv);
}

const UI_BLOCKED = [
  'EVAL "return 1" 0', 'evalsha abc 0', 'Function load x', 'SCRIPT FLUSH', 'keys *', 'Keys user:*',
  'CONFIG SET dir /tmp', 'config set dir /tmp', 'FLUSHALL', 'flushall', 'MODULE LOAD /x.so', 'module load /x.so',
  'MULTI', 'multi', 'SELECT 1', 'select 1', 'MIGRATE h 1 k 0 1', 'DEBUG SLEEP 0', 'debug sleep 0',
  'SHUTDOWN', 'shutdown nosave', 'ACL SETUSER x on', 'acl setuser x on', 'CLIENT SETNAME x', 'client setname x',
];

test.describe('console', () => {
  test.use({ role: 'operator' });
  test.beforeEach(async ({ page }) => { await gotoView(page, DB.e2e, 'console'); });

  test('runs a command and renders a typed reply', async ({ page }) => {
    await consoleRun(page, `HGETALL ${K.hash}`);
    const results = page.getByTestId('console-results');
    await expect(results).toContainText('Ada Lovelace');
    await expect(results).toContainText('read');
    await consoleRun(page, 'DBSIZE');
    await expect(results.locator('section').filter({ hasText: 'DBSIZE' })).toContainText(/\(integer\) \d+/);
  });

  test('policy badge classifies before running (read / write / admin / blocked)', async ({ page }) => {
    const badge = page.getByTestId('policy-badge');
    for (const [line, cls] of [['GET foo', 'read'], ['SET foo bar', 'write'], ['CONFIG GET maxmemory', 'admin'], ['FLUSHALL', 'blocked'], ['KEYS *', 'blocked']] as const) {
      await setEditor(page, line);
      await expect(badge).toContainText(cls);
    }
    // operator: admin commands cannot be run
    await setEditor(page, 'CONFIG GET maxmemory');
    await expect(page.getByTestId('console-run')).toBeDisabled();
  });

  test('autocomplete suggests commands with inline docs', async ({ page }) => {
    const input = page.getByTestId('console-editor-input');
    await input.click();
    await input.pressSequentially('HGETA');
    const option = page.locator('.cm-tooltip-autocomplete li', { hasText: 'HGETALL' });
    await expect(option).toBeVisible();
    await page.keyboard.press('Enter'); // accepts the highlighted completion
    await expect(input).toContainText('HGETALL');
    await input.pressSequentially(' x');
    await expect(page.getByTestId('command-docs')).toContainText('HGETALL');
    await expect(page.getByTestId('command-docs')).toContainText(/key/i);
  });

  test('history with arrow keys, kept in memory only', async ({ page }) => {
    await consoleRun(page, 'PING first');
    await consoleRun(page, 'PING second');
    const input = page.getByTestId('console-editor-input');
    await input.click();
    await page.keyboard.press('ArrowUp');
    await expect(input).toContainText('PING second');
    await page.keyboard.press('ArrowUp');
    await expect(input).toContainText('PING first');
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain('PING first');
  });

  for (const line of UI_BLOCKED) {
    test(`blocked in the UI: ${line}`, async ({ page }) => {
      const requests: string[] = [];
      page.on('request', (r) => { if (r.url().includes('/cli')) requests.push(r.postData() ?? ''); });
      await setEditor(page, line);
      await expect(page.getByTestId('policy-badge')).toContainText('blocked');
      await expect(page.getByTestId('console-run')).toBeDisabled();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(200);
      expect(requests, 'blocked command is not sent').toEqual([]);
    });
  }

  test('write requiring confirmation from the console (DEL)', async ({ page }) => {
    const key = `${K.scratchPrefix}console-del`;
    await redisExec(['SET', key, 'x']);
    await consoleRun(page, `DEL ${key}`);
    const dlg = page.getByTestId('confirmation-dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByTestId('confirmation-submit').click();
    await expect(page.getByTestId('console-results')).toContainText('1');
    expect(await redisExec(['EXISTS', key])).toBe(0);
  });

  test('server-side refusal is shown when the client guard is bypassed', async ({ page }) => {
    // Simulate a tampered client: call the API from the page with the app's CSRF token.
    const status = await page.evaluate(async () => {
      const me = await (await fetch('/api/v1/auth/me')).json();
      const r = await fetch('/api/v1/databases/sandbox-e2e/cli', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrfToken }, body: JSON.stringify({ line: 'FLUSHALL' }) });
      return r.status;
    });
    expect(status).toBe(403);
  });
});

test.describe('console as viewer', () => {
  test.use({ role: 'viewer' });
  test('writes are classified and disabled for viewers', async ({ page }) => {
    await gotoView(page, DB.e2e, 'console');
    await setEditor(page, `SET ${K.scratchPrefix}viewer x`);
    await expect(page.getByTestId('policy-badge')).toContainText('write');
    await expect(page.getByTestId('console-run')).toBeDisabled();
  });
});

test.describe('workbench', () => {
  test.use({ role: 'operator' });
  test('runs a multi-line script with per-command results and comments skipped', async ({ page }) => {
    await gotoView(page, DB.e2e, 'workbench');
    const k = `${K.scratchPrefix}wb`;
    await setEditor(page, `# comment line\nSET ${k} 1\n// another comment\nINCR ${k}\nGET ${k}`, 'workbench-editor');
    await page.getByTestId('workbench-run').click();
    const res = page.getByTestId('console-results');
    await expect(res.locator('section')).toHaveCount(3);
    await expect(res).toContainText('GET');
    expect(String(await redisExec(['GET', k]))).toBe('2');
  });

  test('stops at a blocked line', async ({ page }) => {
    await gotoView(page, DB.e2e, 'workbench');
    const k = `${K.scratchPrefix}wb-stop`;
    await setEditor(page, `PING\nFLUSHALL\nSET ${k} 1`, 'workbench-editor');
    // The script policy flags the blocked line before running; the server enforces it regardless.
    await expect(page.getByTestId('workbench-policy')).toContainText(/FLUSHALL|disabled|blocked/i);
    const run = page.getByTestId('workbench-run');
    if (await run.isEnabled()) {
      await run.click();
      await expect(page.getByTestId('console-results')).toContainText(/disabled|blocked/i);
    }
    expect(await redisExec(['EXISTS', k])).toBe(0);
  });
});

test.describe('guided mode', () => {
  test.use({ role: 'operator' });
  test('find keys shows the SCAN command and results', async ({ page }) => {
    await gotoView(page, DB.e2e, 'guided');
    await page.getByTestId('guided-find').click();
    await page.getByTestId('guided-key').fill('e2e:string:*');
    await expectGuidedArgv(page, ['SCAN', '0', 'MATCH', 'e2e:string:*', 'COUNT', '200']);
    await page.getByTestId('guided-run').click();
    await expect(page.locator('.guided-result')).toContainText('greeting');
  });

  test('set a value, set TTL, increment, add to set/zset/stream, publish — each shows the exact command', async ({ page }) => {
    await gotoView(page, DB.e2e, 'guided');
    const p = `${K.scratchPrefix}guided:`;
    const tasks: [string, Record<string, string>, string[], () => Promise<void>][] = [
      ['edit', { key: `${p}s`, value: 'hello world' }, ['SET', `${p}s`, 'hello world'], async () => expect(String(await redisExec(['GET', `${p}s`]))).toBe('hello world')],
      ['ttl', { key: `${p}s`, number: '600' }, ['EXPIRE', `${p}s`, '600'], async () => expect(Number(await redisExec(['TTL', `${p}s`]))).toBeGreaterThan(500)],
      ['counter', { key: `${p}n`, number: '5' }, ['INCRBY', `${p}n`, '5'], async () => expect(String(await redisExec(['GET', `${p}n`]))).toBe('5')],
      ['set', { key: `${p}set`, value: 'm1' }, ['SADD', `${p}set`, 'm1'], async () => expect(Number(await redisExec(['SCARD', `${p}set`]))).toBe(1)],
      ['zset', { key: `${p}z`, number: '3', value: 'm' }, ['ZADD', `${p}z`, '3', 'm'], async () => expect(String(await redisExec(['ZSCORE', `${p}z`, 'm']))).toBe('3')],
      ['stream', { key: `${p}x`, field: 'f', value: 'v' }, ['XADD', `${p}x`, '*', 'f', 'v'], async () => expect(Number(await redisExec(['XLEN', `${p}x`]))).toBe(1)],
      ['publish', { key: 'guided-channel', value: 'hi' }, ['PUBLISH', 'guided-channel', 'hi'], async () => undefined],
    ];
    for (const [task, f, cmd, check] of tasks) {
      await page.getByTestId(`guided-${task}`).click();
      await page.getByTestId('guided-key').fill(f.key!);
      if (f.field) await page.getByTestId('guided-field').fill(f.field);
      if (f.value) await page.getByTestId('guided-value').fill(f.value);
      if (f.number) await page.getByTestId('guided-number').fill(f.number);
      await expectGuidedArgv(page, cmd);
      await page.getByTestId('guided-run').click();
      await expect(page.locator('.guided-result')).toBeVisible();
      await check();
    }
  });

  test('inspect a value', async ({ page }) => {
    await gotoView(page, DB.e2e, 'guided');
    await page.getByTestId('guided-inspect').click();
    await page.getByTestId('guided-key').fill(K.hash);
    await page.getByTestId('guided-run').click();
    await expect(page.locator('.guided-result')).toContainText('Ada Lovelace');
  });
});
