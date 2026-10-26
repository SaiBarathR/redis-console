/**
 * Redis data (key names, patterns, channels, groups, queries) must never travel in URLs, where
 * proxies, load balancers and APM agents log it. Such query parameters are refused with 400
 * before routing or authentication; the old GET routes are gone.
 */
import { test, expect } from '@playwright/test';
import { API, Api, dbPath } from '../../lib/api.ts';
import { DB } from '../../lib/env.ts';
import { K } from '../../lib/fixtures-data.ts';

const PARAMS = ['k', 'key', 'keys', 'match', 'pattern', 'patterns', 'channel', 'channels', 'group', 'query', 'q'];

test.describe('no Redis data in URLs', () => {
  let viewer: Api;
  let anon: Api;
  test.beforeAll(async () => { viewer = await Api.fromStorage('viewer'); anon = await Api.anonymous(); });
  test.afterAll(async () => { await viewer.dispose(); await anon.dispose(); });

  for (const p of PARAMS) {
    test(`?${p}= is rejected with 400 on API, health and SPA routes (also unauthenticated)`, async () => {
      const v = encodeURIComponent(K.hash);
      for (const [api, url] of [
        [viewer, dbPath(DB.e2e, `overview?${p}=${v}`)],
        [viewer, `${API}/databases?${p}=${v}`],
        [anon, `${API}/auth/me?${p}=${v}`],
        [anon, `/healthz?${p}=${v}`],
        [anon, `/db/${DB.e2e}/keys?${p}=${v}`],
      ] as const) {
        const r = await api.get(url);
        expect(r.status, `${url}`).toBe(400);
        expect(r.text).not.toContain(K.hash);
      }
    });
  }

  test('legacy GET read routes are gone (404)', async () => {
    for (const sub of ['keys', 'key', 'streams/groups', 'streams/pending', 'timeseries/range', 'pubsub/channels']) {
      const r = await viewer.get(dbPath(DB.e2e, sub));
      expect([404, 405], sub).toContain(r.status);
    }
  });

  test('the SPA never puts key names in its own URLs or requests', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: (await import('../../lib/api.ts')).storageFile('viewer') });
    const page = await ctx.newPage();
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    await page.goto(`/db/${DB.e2e}/keys`);
    await page.getByTestId('key-pattern').fill('e2e:hash:*');
    await page.getByTestId('key-scan').click();
    await page.getByTestId('key-list').getByTestId('key-row').first().click();
    await expect(page.getByTestId('key-detail').locator('h2')).toContainText('e2e:hash');
    for (const u of [...urls, page.url()]) {
      expect(u, 'key name in a URL').not.toContain('e2e:hash');
      expect(u).not.toContain(encodeURIComponent('e2e:hash'));
    }
    await ctx.close();
  });
});
