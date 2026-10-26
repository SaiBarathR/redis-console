/**
 * v0.2.1 shell parity (docs/RI-PARITY-AUDIT.md): bottom tools drawer with the shared Console, Command helper and
 * Profiler (F27/F25), persistent status metrics (F5), logical-database context (F13), landing sort and tags (F21),
 * Pub/Sub continuity and controls (F22), real slow log settings (F19) and Preferences (F26).
 */
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { redisExec } from '../../lib/fixtures-data.ts';
import { gotoView } from '../../lib/ui.ts';

const drawer = (page: import('@playwright/test').Page) => page.getByTestId('tools-drawer');

/** Nothing the drawer, Pub/Sub or the Console saw may end up in device storage, the URL or the title. */
async function expectNoDataStored(page: import('@playwright/test').Page, ...needles: string[]) {
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const needle of needles) {
    expect(storage).not.toContain(needle);
    expect(page.url()).not.toContain(needle);
    expect(await page.title()).not.toContain(needle);
  }
}

test.describe('as admin', () => {
  test.use({ role: 'admin' });

  test('drawer: shared Console, Command helper, preference-only state, keyboard resize (F27, F25)', async ({ page }) => {
    await gotoView(page, DB.e2e, 'keys');
    await expect(drawer(page)).toHaveAttribute('data-open', 'false');
    await page.keyboard.press('Control+`');
    await expect(drawer(page)).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('drawer-tab-profiler')).toBeVisible();
    const marker = `drawer-${Date.now()}`;
    const input = page.getByTestId('drawer-console-editor-input');
    await input.click();
    await input.fill(`ECHO ${marker}`);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('drawer-console-results')).toContainText(marker);
    // The Console page shows the same in-memory transcript; the drawer steps aside there.
    await page.getByTestId('nav-console').click();
    await expect(page.getByTestId('console-results')).toContainText(marker);
    await expect(drawer(page)).toContainText('The Console is open on this page');
    await page.getByTestId('nav-keys').click();
    // Command helper: search, policy annotation, insert onto the shared prompt.
    await page.getByTestId('drawer-tab-helper').click();
    await page.getByTestId('command-helper-search').fill('hgetall');
    await expect(page.getByTestId('command-helper-detail')).toContainText('HGETALL');
    await expect(page.getByTestId('command-helper-detail')).toContainText('read · allowed');
    await page.getByTestId('command-helper-insert').click();
    await expect(page.getByTestId('drawer-tab-console')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('drawer-console-editor-input')).toContainText('HGETALL');
    // Resize with the keyboard; the height and open state are presentation preferences only.
    const separator = page.getByTestId('drawer-resizer');
    const before = Number(await separator.getAttribute('aria-valuenow'));
    await separator.focus();
    await page.keyboard.press('ArrowUp');
    await expect(separator).toHaveAttribute('aria-valuenow', String(before + 24));
    const stored = JSON.parse((await page.evaluate(() => localStorage.getItem('rconsole.preferences'))) ?? '{}');
    expect(Object.keys(stored).sort()).toEqual(['drawerHeight', 'drawerOpen']);
    await expectNoDataStored(page, marker, 'HGETALL');
    // Reload: the drawer opens again; the Console transcript does not survive (memory only).
    await page.reload();
    await expect(drawer(page)).toHaveAttribute('data-open', 'true');
    await expect(page.getByTestId('drawer-console-results')).toBeVisible();
    await expect(page.getByTestId('drawer-console-results')).not.toContainText(marker);
    await page.getByTestId('drawer-toggle').click();
    await expect(drawer(page)).toHaveAttribute('data-open', 'false');
  });

  test('drawer profiler: time-boxed, keeps recording across pages, pause, clear, stop (F25)', async ({ page }) => {
    await gotoView(page, DB.e2e, 'keys');
    await page.getByTestId('drawer-tab-profiler').click();
    await page.getByTestId('drawer-profiler-seconds').fill('15');
    await page.getByTestId('drawer-profiler-start').click();
    await expect(page.getByTestId('drawer-profiler-stop')).toBeVisible();
    await page.getByTestId('nav-overview').click();
    const marker = `profiler-drawer-${Date.now()}`;
    await expect
      .poll(async () => {
        await redisExec(['GET', marker]);
        return page.getByTestId('drawer-profiler').innerText();
      }, { timeout: 10_000 })
      .toContain(marker);
    await page.getByTestId('drawer-profiler-pause').click();
    await expect(page.getByTestId('drawer-profiler-count')).toContainText('view paused');
    await page.getByTestId('drawer-profiler-clear').click();
    await expect(page.getByTestId('drawer-profiler-count')).toContainText('0 shown of 0');
    await page.getByTestId('drawer-profiler-pause').click();
    await page.getByTestId('drawer-profiler-stop').click();
    await expect(page.getByTestId('drawer-profiler-start')).toBeVisible();
    // Stopping must not start a new session (regression: the Stop click once submitted the Start form).
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('drawer-profiler-start')).toBeVisible();
    await expect(page.getByTestId('drawer-profiler-stop')).toHaveCount(0);
  });

  test('profiler is not offered in the drawer on the production database', async ({ page }) => {
    await gotoView(page, DB.prodSim, 'keys');
    await page.getByTestId('drawer-toggle').click();
    await expect(page.getByTestId('drawer-tab-console')).toBeVisible();
    await expect(page.getByTestId('drawer-tab-profiler')).toHaveCount(0);
  });

  test('logical database context and status metrics (F13, F5)', async ({ page }) => {
    await gotoView(page, DB.prodSim, 'overview');
    await expect(page.getByTestId('db-index')).toHaveText('db 1');
    await expect(page.getByTestId('status-keys')).toContainText('db 1');
    // The Overview stream feeds the status bar: no second polling loop, and CPU appears.
    await expect(page.getByTestId('status-freshness')).toHaveText('live', { timeout: 15_000 });
    await expect(page.getByTestId('status-cpu')).toHaveText(/CPU \d/);
    await expect(page.getByTestId('status-memory')).toHaveText(/mem \d/);
    await expect(page.getByTestId('status-clients')).toHaveText(/clients \d/);
    await expect(page.getByTestId('status-metrics')).toHaveAttribute('aria-label', 'Server-wide metrics');
    await gotoView(page, DB.e2e, 'keys');
    await expect(page.getByTestId('db-index')).toHaveText('db 0');
    await expect(page.getByTestId('status-ops')).toHaveText(/ops\/s \d/, { timeout: 15_000 });
  });

  test('slow log shows the real threshold and length, count and refresh (F19)', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/slowlog');
    const config = page.getByTestId('slowlog-config');
    await expect(config).toContainText('slowlog-log-slower-than');
    const [threshold, maxLen] = await Promise.all([
      redisExec<Buffer[]>(['CONFIG', 'GET', 'slowlog-log-slower-than']),
      redisExec<Buffer[]>(['CONFIG', 'GET', 'slowlog-max-len']),
    ]);
    await expect(config).toContainText(`slowlog-log-slower-than ${String(threshold[1])}`);
    await expect(config).toContainText(Number(String(maxLen[1])).toLocaleString('en-US'));
    const read = page.waitForRequest((r) => r.url().includes('/slowlog?count=25'));
    await page.getByTestId('slowlog-count').selectOption('25');
    await read;
    await page.getByTestId('slowlog-refresh').selectOption('5');
    await expect(page.getByTestId('slowlog-freshness')).toContainText('read');
    const again = page.waitForRequest((r) => r.url().includes('/slowlog?count=25'), { timeout: 9000 });
    await again;
  });

  test('preferences: UTC time display reaches the tools; no Redis data or policy stored (F26)', async ({ page }) => {
    await page.goto('/preferences');
    await page.getByTestId('pref-timeZone').selectOption('utc');
    await page.getByTestId('pref-dateStyle').selectOption('iso');
    await expect(page.getByTestId('pref-time-sample')).toContainText('2026-10-24 14:03:09Z');
    await redisExec(['CONFIG', 'SET', 'slowlog-log-slower-than', '0']);
    await redisExec(['PING']);
    await redisExec(['CONFIG', 'SET', 'slowlog-log-slower-than', '1000']);
    await gotoView(page, DB.e2e, 'diagnostics/slowlog');
    await expect(page.locator('main table tbody tr').first()).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z/);
    const stored = JSON.parse((await page.evaluate(() => localStorage.getItem('rconsole.preferences'))) ?? '{}');
    expect(stored).toEqual({ timeZone: 'utc', dateStyle: 'iso' });
    await page.goto('/preferences');
    await page.getByTestId('pref-reset').click();
    expect(await page.evaluate(() => localStorage.getItem('rconsole.preferences'))).toBeNull();
  });

  test('landing: display tags, capability badges, db index and metric sort (F21, F13)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const e2eRow = page.locator('tr', { has: page.getByText('sandbox-e2e', { exact: true }) });
    await expect(e2eRow.getByTestId('db-tag')).toHaveText(['e2e', 'scratch']);
    await expect(e2eRow.getByTestId('landing-db-index')).toHaveText('db 0');
    await expect(page.locator('tr', { has: page.getByText('e2e-prod-sim', { exact: true }) }).getByTestId('landing-db-index')).toHaveText('db 1');
    await expect(e2eRow.getByTestId('db-capability').filter({ hasText: 'Profiler' })).toHaveCount(1);
    // Wait for every row's figures, then sort by keys (largest first), reverse, and restore.
    await expect(page.getByTestId('landing-keys')).toHaveCount(3);
    await expect.poll(async () => (await page.getByTestId('landing-keys').allInnerTexts()).every((t) => /\d/.test(t))).toBe(true);
    const order = () => page.locator('a.db-link').allInnerTexts();
    const original = await order();
    await page.getByTestId('landing-sort-keys').click();
    const counts = (await page.getByTestId('landing-keys').allInnerTexts()).map((t) => Number(t.split(/\s/)[0]!.replace(/,/g, '')));
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    await expect(page.locator('th[aria-sort="descending"]')).toContainText('Keys');
    await page.getByTestId('landing-sort-keys').click();
    await expect(page.locator('th[aria-sort="ascending"]')).toContainText('Keys');
    await page.getByTestId('landing-sort-keys').click();
    expect(await order()).toEqual(original);
    await page.getByTestId('landing-sort-name').click();
    const names = await order();
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    await page.getByTestId('landing-sort-name').click();
    await page.getByTestId('landing-sort-name').click();
  });
});

test.describe('as operator', () => {
  test.use({ role: 'operator' });

  test('Pub/Sub: several topics, session continues across pages, freeze, format, clear (F22)', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/pubsub');
    const stamp = `e2e-shell-${Date.now()}`;
    await page.getByTestId('pubsub-channel').fill(`${stamp}-a`);
    await page.getByTestId('pubsub-add-channel').click();
    await page.getByTestId('pubsub-channel').fill(`${stamp}-b`);
    await page.getByTestId('pubsub-add-channel').click();
    await page.getByTestId('pubsub-pattern').fill(`${stamp}-p*`);
    await page.getByTestId('pubsub-subscribe').click();
    await expect(page.getByTestId('pubsub-stop')).toBeVisible();
    await expect(page.getByTestId('pubsub-topics')).toContainText(`${stamp}-b`);
    // Leave the page: the session keeps running and the drawer bar says so.
    await page.getByTestId('nav-keys').click();
    await expect(page.getByTestId('drawer-pubsub-live')).toBeVisible();
    await redisExec(['PUBLISH', `${stamp}-a`, '{"n":1}']);
    await redisExec(['PUBLISH', `${stamp}-p9`, 'plain']);
    await expect(page.getByTestId('drawer-pubsub-live')).toContainText('2 messages');
    await page.getByTestId('drawer-pubsub-live').click();
    await expect(page.getByTestId('pubsub-status')).toContainText('Listening');
    await expect(page.getByTestId('pubsub-count')).toContainText('2 of');
    await page.getByTestId('pubsub-format').selectOption('json');
    await expect(page.locator('.pubsub-messages')).toContainText('"n": 1');
    await expect(page.locator('.pubsub-messages')).toContainText('Not JSON');
    await page.getByTestId('pubsub-freeze').click();
    await redisExec(['PUBLISH', `${stamp}-b`, 'later']);
    await expect(page.getByTestId('pubsub-frozen')).toContainText('1 message arrived');
    await expect(page.locator('.pubsub-messages')).not.toContainText('later');
    await page.getByTestId('pubsub-freeze').click();
    await expect(page.locator('.pubsub-messages')).toContainText('later');
    await page.getByTestId('pubsub-clear').click();
    await expect(page.getByTestId('pubsub-count')).toContainText('0 of');
    await expectNoDataStored(page, stamp);
    await page.getByTestId('pubsub-stop').click();
    await expect(page.getByTestId('pubsub-subscribe')).toBeVisible();
    await expect(page.getByTestId('drawer-pubsub-live')).toHaveCount(0);
  });

  test('slow log settings are explained, not shown, without the admin role (F19)', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/slowlog');
    await expect(page.getByTestId('slowlog-config-unavailable')).toContainText('needs the admin role');
  });
});

test.describe('as viewer', () => {
  test.use({ role: 'viewer' });

  test('drawer on the read-only remote: context visible, no profiler, policy in the helper (F27, F25)', async ({ page }) => {
    await gotoView(page, DB.remote, 'keys');
    await page.getByTestId('drawer-toggle').click();
    await expect(drawer(page)).toContainText('read-only');
    await expect(page.getByTestId('drawer-tab-profiler')).toHaveCount(0);
    await page.getByTestId('drawer-tab-helper').click();
    await page.getByTestId('command-helper-search').fill('set');
    await page.getByTestId('command-helper-item').filter({ has: page.locator('code', { hasText: /^SET$/ }) }).click();
    await expect(page.getByTestId('command-helper-detail')).toContainText('not allowed');
    await expect(page.getByTestId('command-helper-insert')).toBeDisabled();
    await page.getByTestId('command-helper-policy').selectOption('allowed');
    await expect(page.getByTestId('command-helper-item').filter({ hasText: /not allowed/ })).toHaveCount(0);
    // Read-only framing stays on screen with the drawer open.
    await expect(page.locator('.env-edge')).toContainText('All writes are disabled');
    await expect(page.locator('.statusbar')).toContainText('Read-only');
    await page.getByTestId('drawer-toggle').click();
  });

  test('viewer cannot publish; the profiler stays off in the drawer (F22, F27)', async ({ page }) => {
    await gotoView(page, DB.e2e, 'diagnostics/pubsub');
    await expect(page.getByTestId('pubsub-publish')).toBeDisabled();
    await page.getByTestId('drawer-toggle').click();
    await expect(page.getByTestId('drawer-tab-profiler')).toHaveCount(0);
    await page.getByTestId('drawer-toggle').click();
  });
});
