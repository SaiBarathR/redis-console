/**
 * Control anatomy lint (permanent): every page and state at 1024 and 1440 px, light and dark, deviceScaleFactor 2.
 * Measures the inside of every control and painted surface (text and icon insets, select chevrons, icon gaps and
 * centring, row heights, clipping, focus rings; see lib/anatomy.ts) and fails on any violation not in the reviewed
 * allowlist. Evidence (measurements, 2x crops, contact sheets) goes to the gitignored .qa/ui/anatomy/.
 *
 * Harness run: the default global setup (role `admin`, disposable Redis, scratch prefix).
 * Attached run: RC_E2E_ATTACH=1 RC_E2E_BASE_URL=<server> RC_E2E_REDIS_PORT=<sandbox-e2e port> with `.qa/accounts.json`
 * from scripts/qa-accounts.mjs; writes only under `uiE:20261030:anatomy:<run>:` and removes them afterwards.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { Browser, Page } from '@playwright/test';
import { test, expect } from '../../lib/test.ts';
import { API, Api, storageFile } from '../../lib/api.ts';
import { newPassword, uniqueName } from '../../lib/accounts.ts';
import { registerExtraSecret } from '../../lib/leak.ts';
import { freshTotp } from '../../lib/totp.ts';
import { loginThrottle } from '../../lib/throttle.ts';
import { BASE_URL, REPO_ROOT } from '../../lib/env.ts';
import { anatomy, anatomyRun, finishRun, formatIssues, type AnatomyRun } from '../../lib/anatomy.ts';
import { KEY_TYPES, anatomyExec, anatomyIndex, anatomyPrefix, cleanupAnatomy, longKey, seedAnatomy } from '../../lib/anatomy-data.ts';
import { confirmDialog, consoleRun, gotoView, openKey, setEditor } from '../../lib/ui.ts';

const attach = process.env.RC_E2E_ATTACH === '1';
const ROLE = attach ? 'anatomy-admin' : 'admin';
const DB = 'sandbox-e2e';
const P = anatomyPrefix;
let keys: Record<string, string> = {};

test.beforeAll(async () => {
  test.setTimeout(180_000);
  if (attach) {
    // One stored session for every test: each sign-in would otherwise wait for a fresh TOTP step.
    let valid = false;
    if (existsSync(storageFile(ROLE))) valid = await Api.fromStorage(ROLE).then(a => a.dispose().then(() => true), () => false);
    if (!valid) {
      const acc = JSON.parse(readFileSync(`${REPO_ROOT}/.qa/accounts.json`, 'utf8')).local['qa-admin'];
      const api = await Api.login(acc);
      await api.saveStorage(ROLE);
      await api.dispose();
    }
  }
  const seeded = await seedAnatomy();
  expect(seeded.unsupported, 'every key type and the search module must be available').toEqual([]);
  keys = seeded.keys;
});
test.afterAll(async () => { await cleanupAnatomy(); });

/** Runs each state's setup, measures it, and collects unreachable states instead of hiding them. */
function stepper(page: Page, run: AnatomyRun) {
  const unreached: string[] = [];
  const step = async (name: string, setup: () => Promise<unknown>, after?: () => Promise<unknown>, opts?: { focus?: boolean; sweep?: boolean }) => {
    try {
      await setup();
      await anatomy(page, run, name, opts);
    } catch (e) {
      unreached.push(`${name}: ${String((e as Error).message).split('\n')[0]}`);
    }
    if (after) await after().catch(() => undefined);
  };
  return { step, unreached };
}

async function assertClean(page: Page, run: AnatomyRun, unreached: string[]) {
  const issues = await finishRun(page, run);
  expect(unreached, 'every listed state must be reached').toEqual([]);
  expect(issues.length, `anatomy violations:\n${formatIssues(issues)}`).toBe(0);
}

const escape = (page: Page) => async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(150); };
const pageReady = async (page: Page) => {
  await expect(page.locator('main').first()).toBeVisible();
  await expect(page.getByTestId('login-submit')).toHaveCount(0);
  await page.waitForLoadState('networkidle').catch(() => undefined);
};
const go = (page: Page, view: string) => async () => { await gotoView(page, DB, view); await pageReady(page); };
const scanPrefix = async (page: Page, pattern = `${P}*`) => {
  await page.getByTestId('key-pattern').fill(pattern);
  await page.getByTestId('key-scan').click();
  await expect(page.getByTestId('key-scan-summary')).toHaveAttribute('data-done', 'true', { timeout: 20_000 });
};

for (const width of [1024, 1440]) for (const theme of ['light', 'dark'] as const) {
  test.describe(`anatomy ${width} ${theme}`, () => {
    test.use({ role: ROLE, viewport: { width, height: 1000 }, deviceScaleFactor: 2, colorScheme: theme });
    test.beforeEach(async ({ page }) => {
      test.setTimeout(900_000);
      await page.addInitScript(t => { try { localStorage.setItem('rconsole.theme', t); } catch { /* optional */ } }, theme);
    });

    test('pages', async ({ page }) => {
      const run = anatomyRun('pages', width, theme);
      const { step, unreached } = stepper(page, run);
      await step('landing', async () => { await page.goto('/'); await expect(page.getByTestId('database-landing')).toBeVisible(); await pageReady(page); });
      await step('overview', go(page, 'overview'));
      for (const tool of ['', '/slowlog', '/clients']) await step(`diagnostics${tool.replace('/', '-')}`, go(page, `diagnostics${tool}`));
      await step('audit', async () => { await page.goto('/admin/audit'); await pageReady(page); await expect(page.locator('main table').first()).toBeVisible(); });
      await step('users', async () => { await page.goto('/admin/users'); await pageReady(page); });
      await step('account', async () => { await page.goto('/account'); await pageReady(page); });
      await step('preferences', async () => { await page.goto('/preferences'); await pageReady(page); });
      await step('palette', async () => { await gotoView(page, DB, 'overview'); await page.getByTestId('command-palette-open').click(); await expect(page.getByTestId('command-palette')).toBeVisible(); }, escape(page));
      await step('palette-filtered', async () => { await page.getByTestId('command-palette-open').click(); await page.getByTestId('command-palette-search').fill('search'); }, escape(page));
      await step('shortcut-help', async () => { await page.locator('main h1').first().click(); await page.keyboard.press('?'); await expect(page.getByTestId('shortcut-help')).toBeVisible(); }, escape(page));
      // Empty and error states.
      await step('audit-empty', async () => {
        await page.goto('/admin/audit'); await pageReady(page);
        await page.getByTestId('audit-user-filter').fill('anatomy-nobody');
        await page.getByTestId('audit-filter').click();
        await page.waitForLoadState('networkidle');
      });
      await step('unknown-database', async () => { await page.goto('/db/anatomy-missing/overview'); await page.waitForLoadState('networkidle'); await expect(page.locator('main').first()).toBeVisible(); });
      await assertClean(page, run, unreached);
    });

    test('key browser and inspectors', async ({ page }) => {
      const run = anatomyRun('keys', width, theme);
      const { step, unreached } = stepper(page, run);
      await step('keys-list', async () => {
        await go(page, 'keys')();
        await page.getByTestId('key-view-list').click();
        await scanPrefix(page);
      });
      await step('keys-filtered-empty', async () => {
        await page.getByTestId('key-type-filter').selectOption('stream');
        await scanPrefix(page, `${P}no-such-*`);
      }, async () => { await page.getByTestId('key-type-filter').selectOption(''); });
      await step('keys-tree', async () => { await page.getByTestId('key-view-tree').click(); await scanPrefix(page); });
      await step('keys-selected', async () => {
        await page.getByTestId('key-view-list').click(); await scanPrefix(page);
        await page.getByTestId('key-list').getByRole('checkbox').first().check();
      }, async () => { await page.getByTestId('key-list').getByRole('checkbox').first().uncheck(); });
      for (const type of [...KEY_TYPES, 'long-key']) {
        await step(`key-${type}`, async () => {
          const detail = await openKey(page, keys[type]!, type === 'long-key' ? { rowText: 'long-xxx' } : {});
          await page.waitForLoadState('networkidle');
          await expect(detail.locator('[aria-busy="true"]')).toHaveCount(0);
        });
      }
      await step('hash-expanded', async () => {
        const detail = await openKey(page, keys.hash!);
        await detail.getByRole('button', { name: 'Expand value', exact: true }).first().click();
        await detail.getByRole('button', { name: 'Expand field', exact: true }).first().click();
      });
      await step('value-inspector', async () => {
        await page.getByTestId('key-detail').getByTestId('value-cell-open').nth(1).click();
        await expect(page.getByTestId('value-inspector-dialog')).toBeVisible();
      }, escape(page));
      await step('field-ttl', async () => {
        await page.getByTestId('key-detail').getByRole('button', { name: /^Field TTL for/ }).first().click();
        await expect(page.getByLabel('Field TTL seconds')).toBeVisible();
      }, escape(page));
      await step('set-field', async () => {
        await page.getByTestId('key-detail').getByTestId('key-edit').click();
        await expect(page.getByTestId('key-editor-dialog')).toBeVisible();
      }, escape(page));
      await step('multi-entry', async () => {
        await page.getByTestId('key-detail').getByTestId('collection-add').click();
        await expect(page.getByTestId('multi-entry-dialog')).toBeVisible();
      }, escape(page));
      await step('list-expanded', async () => {
        const detail = await openKey(page, keys.list!);
        await detail.getByRole('button', { name: /^Expand (value|element)$/ }).first().click();
      });
      await step('stream-groups', async () => {
        const detail = await openKey(page, keys.stream!);
        await detail.getByText('Consumer groups, consumers and pending messages', { exact: true }).click();
        await expect(detail.getByTestId('stream-inspector')).toContainText('anatomy-group');
      });
      await step('add-key', async () => { await page.getByTestId('key-add').click(); await expect(page.getByTestId('key-editor-dialog')).toBeVisible(); }, escape(page));
      await step('string-edit', async () => {
        const detail = await openKey(page, keys.string!);
        await detail.getByTestId('key-edit').click();
        await expect(page.getByTestId('key-editor-dialog')).toBeVisible();
      });
      await step('conflict', async () => {
        await anatomyExec(['SET', keys.string!, `changed elsewhere ${Date.now()}`]);
        await page.getByTestId('key-edit-value').fill('my edit');
        await page.getByTestId('key-save').click();
        await expect(page.getByTestId('key-editor-dialog').getByTestId('edit-conflict')).toBeVisible();
      }, escape(page));
      await step('ttl', async () => { await page.getByTestId('key-detail').getByTestId('key-ttl').click(); await expect(page.getByTestId('key-ttl-dialog')).toBeVisible(); }, escape(page));
      await step('rename', async () => { await page.getByTestId('key-detail').getByTestId('key-rename').click(); await expect(page.getByTestId('key-rename-dialog')).toBeVisible(); }, escape(page));
      await step('delete-confirm', async () => { await page.getByTestId('key-detail').getByTestId('key-delete').click(); await expect(page.getByTestId('confirmation-dialog')).toBeVisible(); }, escape(page));
      await step('inspector-wide', async () => { await page.getByTestId('inspector-wide').click(); }, async () => { await page.getByTestId('inspector-wide').click(); });
      await assertClean(page, run, unreached);
    });

    test('console, workbench, guided, search', async ({ page }) => {
      const run = anatomyRun('tools', width, theme);
      const { step, unreached } = stepper(page, run);
      await step('console', go(page, 'console'));
      await step('console-results', async () => {
        await consoleRun(page, `PING`);
        await consoleRun(page, `HGETALL ${keys.zset}`);
        await consoleRun(page, `ZRANGE ${keys.zset} 0 -1 WITHSCORES`);
        await consoleRun(page, `SCAN 0 MATCH ${P}* COUNT 100`);
        await expect(page.getByTestId('console-result')).toHaveCount(4);
      });
      await step('console-autocomplete', async () => {
        await page.getByTestId('console-editor-input').click();
        await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace');
        await page.keyboard.type('HG');
        await page.keyboard.press('Control+Space');
        await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
      }, escape(page), { focus: false });
      await step('console-signature', async () => {
        await page.getByTestId('console-editor-input').fill(`HSET ${P}x field `);
        await page.keyboard.press('End');
        await expect(page.getByTestId('command-signature')).toBeVisible();
      }, undefined, { focus: false });
      await step('console-suggestions', async () => {
        await page.getByTestId('console-editor-input').fill('PIGN');
        await expect(page.getByTestId('command-suggestions')).toBeVisible();
      }, undefined, { focus: false });
      await step('console-keys-guidance', async () => {
        await page.getByTestId('console-editor-input').fill(`KEYS ${P}*`);
        await expect(page.getByTestId('keys-guidance')).toBeVisible();
      }, undefined, { focus: false });
      await step('history-search', async () => {
        await page.getByTestId('console-editor-input').fill('');
        await page.getByTestId('console-editor-input').click();
        await page.keyboard.press('Control+r');
        await page.keyboard.insertText('ZRANGE');
        await expect(page.getByTestId('history-search')).toBeVisible();
      }, escape(page), { focus: false });
      await step('workbench', go(page, 'workbench'));
      await step('workbench-rich', async () => {
        await setEditor(page, [
          `FT.SEARCH ${anatomyIndex} "@title:gadget" LIMIT 0 5`,
          `TS.RANGE ${keys.timeseries} - +`,
          `FT.PROFILE ${anatomyIndex} SEARCH QUERY "@title:gadget @price:[1 40]" LIMIT 0 3`,
          `GEOSEARCH ${keys.geo} FROMLONLAT 13 38 BYRADIUS 500 km WITHCOORD`,
        ].join('\n'), 'workbench-editor');
        await page.getByTestId('workbench-run').click();
        await expect(page.getByTestId('console-result')).toHaveCount(4, { timeout: 20_000 });
        await page.getByTestId('reply-view-tree').click();
        await expect(page.locator('[data-testid="result-rich"][data-kind="search"]')).toBeVisible();
      });
      await step('workbench-terminal', async () => { await page.getByTestId('reply-view-terminal').click(); });
      await step('guided', go(page, 'guided'));
      await step('guided-tutorials', async () => { await page.getByTestId('guided-tab-tutorials').click(); await page.getByTestId('tutorial-search').click(); await expect(page.getByTestId('tutorial')).toBeVisible(); });
      await step('guided-import', async () => {
        await page.getByTestId('guided-tab-import').click();
        await page.getByTestId('import-text').fill(`SET ${P}imported 1\nEXPIRE ${P}imported 600\nFLUSHALL`);
        await page.getByTestId('import-check').click();
        await expect(page.getByTestId('import-plan')).toBeVisible();
      });
      await step('search-indexes', async () => { await go(page, 'diagnostics/search?panel=indexes')(); await page.getByRole('button', { name: anatomyIndex, exact: true }).click(); await expect(page.getByTestId('search-index-detail')).toBeVisible(); });
      await step('search-query', async () => {
        await go(page, 'diagnostics/search')();
        await page.getByTestId('search-index').selectOption(anatomyIndex);
        await page.getByTestId('search-query').fill('@title:gadget');
        await page.getByTestId('search-sort').selectOption('price');
        await page.getByTestId('search-run').click();
        await expect(page.getByTestId('search-results')).toContainText('6 results');
      });
      await step('search-json', async () => { await page.getByTestId('search-view').getByRole('tab', { name: 'JSON' }).click(); });
      await step('search-error', async () => {
        await page.getByTestId('search-query').fill('@title:(');
        await page.getByTestId('search-run').click();
        await expect(page.locator('main [role=alert]').first()).toBeVisible();
      });
      await step('wizard-fields', async () => {
        await page.getByTestId('search-panel-create').click();
        await page.getByTestId('wizard-prefix').fill(`${P}doc:`);
        await page.getByTestId('wizard-sample').click();
        await expect(page.getByTestId('wizard-sampled')).toContainText(/keys sampled/);
      });
      await step('wizard-review', async () => {
        await page.getByTestId('wizard-next').click();
        await page.getByTestId('wizard-index-name').fill(`${P}never`);
        await expect(page.getByTestId('wizard-command')).toBeVisible();
      });
      await step('analysis', async () => {
        await go(page, 'diagnostics/analysis')();
        await page.getByTestId('analysis-pattern').fill(`${P}*`);
        await page.getByTestId('analysis-run').click();
        await expect(page.getByTestId('analysis-report')).toBeVisible({ timeout: 60_000 });
      });
      await step('pubsub', async () => {
        await go(page, 'diagnostics/pubsub')();
        await page.getByTestId('pubsub-channel').fill(`${P}channel`);
        await page.getByTestId('pubsub-subscribe').click();
        await expect(page.getByTestId('pubsub-stop')).toBeVisible();
        await page.getByTestId('publish-channel').fill(`${P}channel`);
        await page.getByTestId('publish-message').fill('{"hello":"anatomy"}');
        await page.getByTestId('pubsub-publish').click();
        await expect(page.locator('main')).toContainText('anatomy');
      }, async () => { await page.getByTestId('pubsub-stop').click(); });
      await step('streams', async () => {
        await go(page, 'diagnostics/streams')();
        await page.getByTestId('stream-key').fill(keys.stream!);
        await page.getByTestId('stream-inspect').click();
        await page.getByRole('button', { name: 'anatomy-group', exact: true }).click();
        await expect(page.locator('main')).toContainText('consumer-1');
      });
      await step('timeseries', async () => {
        await go(page, 'diagnostics/timeseries')();
        await page.getByTestId('timeseries-key').fill(keys.timeseries!);
        await page.getByTestId('timeseries-run').click();
        await expect(page.locator('main canvas').first()).toBeVisible();
      });
      await step('profiler', async () => {
        await go(page, 'diagnostics/profiler')();
        await page.getByTestId('profiler-seconds').fill('5');
        await page.getByTestId('profiler-start').click();
        await expect(page.getByTestId('profiler-stop')).toBeVisible();
        await anatomyExec(['GET', `${P}profiled`]);
        await page.waitForTimeout(800);
      }, async () => { await page.getByTestId('profiler-stop').click(); });
      await step('drawer-console', async () => {
        await go(page, 'keys')();
        await page.getByTestId('drawer-toggle').click();
        await expect(page.getByTestId('tools-drawer')).toHaveAttribute('data-open', 'true');
        await page.getByTestId('drawer-tab-console').click();
      });
      await step('drawer-helper', async () => { await page.getByTestId('drawer-tab-helper').click(); await page.getByTestId('command-helper-item').first().click(); });
      await step('drawer-split', async () => { await page.getByTestId('drawer-split').click(); await expect(page.getByTestId('drawer-pane-helper')).toBeVisible(); },
        async () => { await page.getByTestId('drawer-split').click(); await page.getByTestId('drawer-toggle').click(); });
      await assertClean(page, run, unreached);
    });

    test('admin dialogs and audit', async ({ page }) => {
      const run = anatomyRun('admin', width, theme);
      const { step, unreached } = stepper(page, run);
      // A long multi-key command so the audit log offers "Show full command".
      await step('audit-command', async () => {
        await go(page, 'console')();
        const names = Array.from({ length: 12 }, (_, i) => `${P}audit-${i}-${'n'.repeat(10)}`);
        await consoleRun(page, `UNLINK ${names.join(' ')}`);
        if (await page.getByTestId('confirmation-dialog').isVisible().catch(() => false)) await confirmDialog(page);
        await page.goto('/admin/audit'); await pageReady(page);
        await page.getByRole('button', { name: 'Show full command' }).first().click();
      });
      await step('audit-filters', async () => {
        await page.getByTestId('audit-database-filter').fill(DB);
        await page.getByTestId('audit-filter').click();
        await page.waitForLoadState('networkidle');
      });
      await step('user-dialog', async () => { await page.goto('/admin/users'); await pageReady(page); await page.getByTestId('user-add').click(); await expect(page.getByTestId('user-editor-dialog')).toBeVisible(); }, escape(page));
      await step('user-edit', async () => { await page.getByTestId('user-edit').first().click(); await expect(page.getByTestId('user-editor-dialog')).toBeVisible(); }, escape(page));
      await assertClean(page, run, unreached);
    });

    test('sign-in, password change, TOTP enrolment, recovery codes (fresh context)', async ({ browser }) => {
      const page = await freshPage(browser, width, theme);
      const run = anatomyRun('auth', width, theme);
      const { step, unreached } = stepper(page, run);
      const admin = await Api.fromStorage(ROLE);
      const username = uniqueName('anat');
      const initialPassword = newPassword();
      registerExtraSecret(`password:${username}:initial`, initialPassword);
      const created = await admin.post(`${API}/admin/users`, { username, displayName: `Anatomy ${username}`, role: 'admin', initialPassword });
      expect(created.status).toBeLessThan(300);
      const id = (created.json.user?.id ?? created.json.id) as string;
      try {
        await step('sign-in', async () => { await page.goto('/login'); await expect(page.getByTestId('login-username')).toBeVisible(); });
        await step('sign-in-error', async () => {
          await page.getByTestId('login-username').fill(username);
          await page.getByTestId('login-password').fill('not-the-password');
          await loginThrottle();
          await page.getByTestId('login-submit').click();
          await expect(page.getByRole('alert')).toBeVisible();
        });
        await step('password-change', async () => {
          await page.getByTestId('login-password').fill(initialPassword);
          await loginThrottle();
          await page.getByTestId('login-submit').click();
          await expect(page.getByTestId('current-password')).toBeVisible();
        });
        let secret = '';
        await step('totp-enrol', async () => {
          const np = newPassword();
          registerExtraSecret(`password:${username}`, np);
          await page.getByTestId('current-password').fill(initialPassword);
          await page.getByTestId('new-password').fill(np);
          await loginThrottle();
          await page.getByTestId('password-change-submit').click();
          const enroll = page.waitForResponse(r => r.url().endsWith('/api/v1/auth/totp/enroll') && r.status() === 200);
          await page.getByTestId('totp-enroll').click();
          secret = (await (await enroll).json()).secretBase32;
          registerExtraSecret(`totp:${username}`, secret);
          await expect(page.getByTestId('totp-qr')).toBeVisible();
        });
        await step('recovery-codes', async () => {
          await page.getByTestId('totp-enroll-code').fill(await freshTotp(secret));
          await loginThrottle();
          await page.getByTestId('totp-enroll-confirm').click();
          await expect(page.getByTestId('recovery-codes')).toBeVisible();
        });
        await assertClean(page, run, unreached);
      } finally {
        await admin.patch(`${API}/admin/users/${id}`, { disabled: true }).catch(() => undefined);
        await admin.dispose();
        await page.context().close();
      }
    });
  });
}

async function freshPage(browser: Browser, width: number, theme: 'light' | 'dark'): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width, height: 1000 }, deviceScaleFactor: 2, colorScheme: theme, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.addInitScript(t => { try { localStorage.setItem('rconsole.theme', t); } catch { /* optional */ } }, theme);
  return page;
}

