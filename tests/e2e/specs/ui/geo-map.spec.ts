/**
 * v0.4 (F11): geo replies in the workbench get an offline map (bundled outline, no tiles, no fetches) with a table.
 * The page fixture fails a test on any CSP violation, console error or page error.
 */
import { test, expect } from '../../lib/test.ts';
import { DB } from '../../lib/env.ts';
import { K, redisExec } from '../../lib/fixtures-data.ts';
import { gotoView, setEditor } from '../../lib/ui.ts';

const RUN = `${K.scratchPrefix}geo:${Date.now().toString(36)}:`;

test.describe('as viewer', () => {
  test.use({ role: 'viewer' });

  test('GEOSEARCH WITHCOORD and GEOPOS show a map with keyboard-selectable points', async ({ page, baseURL }) => {
    const key = `${RUN}cities`;
    await redisExec(['GEOADD', key, '2.3522', '48.8566', 'Paris', '4.8357', '45.764', 'Lyon', '13.405', '52.52', 'Berlin', '-0.1276', '51.5072', '<b>London</b>']);
    try {
      const external: string[] = [];
      const origin = new URL(baseURL!).origin;
      page.on('request', (r) => {
        if (new URL(r.url()).origin !== origin) external.push(r.url());
      });
      await gotoView(page, DB.e2e, 'workbench');
      await setEditor(page, [`GEOSEARCH ${key} FROMLONLAT 2.35 48.85 BYRADIUS 600 km ASC WITHCOORD WITHDIST`, `GEOPOS ${key} Berlin Nowhere`].join('\n'), 'workbench-editor');
      await page.getByTestId('workbench-run').click();
      await expect(page.getByTestId('console-result')).toHaveCount(2);
      await page.getByTestId('reply-view-tree').click();
      const maps = page.locator('[data-testid="result-rich"][data-kind="geo"]');
      await expect(maps).toHaveCount(2);
      const search = maps.first();
      await expect(search.getByTestId('geo-count')).toHaveText('3 points');
      await expect(search).toContainText('radius 600 km');
      await expect(search.getByTestId('geo-land')).toHaveCount(1);
      await expect(search.getByTestId('geo-row')).toHaveCount(3);
      await expect(search.getByTestId('geo-row').first()).toContainText('Paris');
      await expect(search.getByTestId('geo-table')).toContainText('<b>London</b>');
      await search.getByTestId('geo-point').nth(1).focus();
      await page.keyboard.press('Enter');
      await expect(search.getByTestId('geo-point').nth(1)).toHaveAttribute('aria-pressed', 'true');
      await expect(search.getByTestId('geo-row').nth(1)).toHaveClass(/selected/);
      await search.getByTestId('geo-world').click();
      await expect(search.locator('svg.geo-svg')).toHaveAttribute('viewBox', '0 0 3600 1800');
      const positions = maps.nth(1);
      await expect(positions.getByTestId('geo-count')).toHaveText('1 point');
      await expect(positions).toContainText('Not found: Nowhere');
      expect(external, 'the map loads nothing from outside the console').toEqual([]);
      await page.getByTestId('reply-view-terminal').click();
      await expect(page.getByTestId('result-rich')).toHaveCount(0);
    } finally {
      await redisExec(['DEL', key]).catch(() => undefined);
    }
  });
});

test.describe('as operator', () => {
  test.use({ role: 'operator' });

  test('GEOADD from the workbench, then a box search draws the added points', async ({ page }) => {
    const key = `${RUN}added`;
    try {
      await gotoView(page, DB.e2e, 'workbench');
      await setEditor(page, [`GEOADD ${key} 139.6917 35.6895 Tokyo 135.5023 34.6937 Osaka`, `GEOSEARCH ${key} FROMMEMBER Tokyo BYBOX 900 400 km WITHCOORD`].join('\n'), 'workbench-editor');
      await page.getByTestId('workbench-run').click();
      await expect(page.getByTestId('console-result')).toHaveCount(2);
      await page.getByTestId('reply-view-tree').click();
      const map = page.locator('[data-testid="result-rich"][data-kind="geo"]');
      await expect(map).toHaveCount(1);
      await expect(map.getByTestId('geo-point')).toHaveCount(2);
      await expect(map).toContainText('Tokyo');
      expect(Number(await redisExec(['ZCARD', key]))).toBe(2);
    } finally {
      await redisExec(['DEL', key]).catch(() => undefined);
    }
  });
});
