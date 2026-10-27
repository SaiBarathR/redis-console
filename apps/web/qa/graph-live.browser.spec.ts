import { readFileSync, mkdirSync } from 'node:fs';
import { test, expect, expectNoXss } from '../../../tests/e2e/lib/test.ts';
import { envVar } from '../../../tests/e2e/lib/env.ts';
import { totpAt, counterNow } from '../../../tests/e2e/lib/totp.ts';
import { GRAPH_DB, GRAPH_PREFIX, graphExec } from '../../../tests/e2e/lib/graph.ts';
import { confirmDialog, gotoView, openKey, setEditor } from '../../../tests/e2e/lib/ui.ts';

const OUT = '/tmp/rc-v04-graph-live';
mkdirSync(OUT, { recursive: true });
for (const source of ['local', 'oidc'] as const) for (const role of ['viewer', 'operator', 'admin'] as const) {
  test(`${source} ${role}: graph table, bounded diagram, plans and policy on built SPA`, async ({ page, guards }) => {
    await page.goto('/login');
    if (source === 'local') {
      const accounts = JSON.parse(readFileSync(new URL('../../../.qa/accounts.json', import.meta.url), 'utf8'));
      const a = accounts.local[`qa-${role}`];
      await page.getByTestId('login-username').fill(a.username);
      await page.getByTestId('login-password').fill(a.password);
      await page.getByTestId('login-submit').click();
      const code = page.getByTestId('totp-code');
      await expect(code.or(page.getByTestId('database-landing')).first()).toBeVisible();
      if (await code.isVisible()) { await code.fill(totpAt(a.totpSecret, counterNow())); await page.getByTestId('totp-submit').click(); }
    } else {
      await page.getByTestId('login-sso').click();
      await page.locator('#username').fill(`${role}1`);
      await page.locator('#password').fill(envVar('KC_USER_PASSWORD'));
      await page.locator('#kc-login').click();
    }
    await expect(page.getByTestId('database-landing')).toBeVisible();
    const me = await (await page.request.get('/api/v1/auth/me')).json();
    expect(me).toMatchObject({ role, source });
    const key = `${GRAPH_PREFIX}live:${source}:${role}:${Date.now()}`;
    await graphExec(['GRAPH.QUERY', key, "UNWIND range(0,299) AS i CREATE (:Person {id:i,name:'<b>Sandbox</b>'})"]);
    await graphExec(['GRAPH.QUERY', key, 'MATCH (a),(b) WHERE b.id=a.id+1 CREATE (a)-[:NEXT {weight:1}]->(b)']);
    try {
      const external: string[] = [];
      page.on('request', (r) => { if (new URL(r.url()).origin !== new URL(page.url()).origin) external.push(new URL(r.url()).origin); });
      await gotoView(page, GRAPH_DB, 'workbench');
      await setEditor(page, `GRAPH.RO_QUERY ${key} "MATCH (n) RETURN n LIMIT 300"\nGRAPH.RO_QUERY ${key} "MATCH (a)-[r]->(b) RETURN r LIMIT 250"\nGRAPH.EXPLAIN ${key} "MATCH (a)-[r]->(b) RETURN a,r,b"`, 'workbench-editor');
      await page.getByTestId('workbench-run').click();
      await expect(page.getByTestId('console-result')).toHaveCount(3);
      await page.getByTestId('reply-view-tree').click();
      const graph = page.getByTestId('graph-view').first();
      await expect(graph.getByTestId('graph-node')).toHaveCount(200);
      await expect(graph.getByTestId('graph-count')).toContainText('100 more nodes not drawn');
      await expect(page.getByTestId('graph-view').nth(1).getByTestId('graph-edge')).toHaveCount(199);
      await expect(graph.getByTestId('graph-statistics')).toContainText('Query internal execution time');
      const first = graph.getByTestId('graph-node').first();
      await first.focus(); await page.keyboard.press('Enter');
      await expect(first).toHaveAttribute('aria-pressed', 'true');
      await expect(graph.getByTestId('graph-selection')).toContainText('<b>Sandbox</b>');
      await expect(page.getByTestId('plan-tree')).toContainText('Conditional Traverse');
      expect(external).toEqual([]); await expectNoXss(page);
      await page.screenshot({ path: `${OUT}/${source}-${role}.png`, fullPage: false });
      await gotoView(page, GRAPH_DB, 'keys');
      await expect(await openKey(page, key)).toContainText('GRAPH.RO_QUERY');
      await gotoView(page, GRAPH_DB, 'workbench');
      await page.getByTestId('console-clear').click();
      await setEditor(page, `GRAPH.QUERY ${key} "CREATE (:Live) RETURN 1"\nGRAPH.PROFILE ${key} "CREATE (:Live)"`, 'workbench-editor');
      if (role === 'viewer') {
        await expect(page.getByTestId('confirmation-dialog')).toHaveCount(0);
        await expect(page.getByTestId('workbench-run')).toBeDisabled();
        await expect(page.getByTestId('workbench-policy')).toContainText('operator');
      } else {
        await page.getByTestId('workbench-run').click();
        await expect(page.getByTestId('confirmation-dialog')).toContainText('GRAPH.PROFILE');
        await confirmDialog(page);
        await page.getByTestId('reply-view-tree').click();
        await expect(page.getByTestId('plan-tree')).toContainText('Create');
      }
      await setEditor(page, `GRAPH.RO_QUERY ${key} "LOAD CSV FROM 'file://a.csv' AS row RETURN row"\nGRAPH.UDF LIST\nGRAPH.CONFIG SET TIMEOUT_MAX 0`, 'workbench-editor');
      await expect(page.getByTestId('workbench-run')).toBeDisabled();
      await expect(page.getByTestId('workbench-policy')).toContainText(/LOAD CSV/);
      for (const argv of [['GRAPH.RO_QUERY', key, "LOAD CSV FROM 'file://a.csv' AS row RETURN row"], ['GRAPH.UDF', 'LIST'], ['GRAPH.CONFIG', 'SET', 'TIMEOUT_MAX', '0']]) {
        const denied = await page.request.post(`/api/v1/databases/${GRAPH_DB}/cli`, { headers: { Origin: new URL(page.url()).origin, 'X-CSRF-Token': me.csrfToken }, data: { argv } });
        expect(denied.status()).toBe(403);
      }
      expect(await guards.cspViolations()).toEqual([]);
      expect(guards.consoleErrors.filter((s) => !s.includes('status of 4'))).toEqual([]);
    } finally { await graphExec(['GRAPH.DELETE', key]); }
  });
}
