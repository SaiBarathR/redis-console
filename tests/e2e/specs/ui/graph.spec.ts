import { test, expect, expectNoXss } from '../../lib/test.ts';
import { GRAPH_DB, GRAPH_PREFIX, graphExec } from '../../lib/graph.ts';
import { confirmDialog, gotoView, openKey, setEditor } from '../../lib/ui.ts';

for (const role of ['viewer', 'operator', 'admin'] as const) {
  test.describe(`graph as ${role}`, () => {
    test.use({ role });
    test('Workbench shows bounded graph results, inert properties, statistics and indentation plans', async ({ page, baseURL }) => {
      const k = `${GRAPH_PREFIX}${role}:${Date.now()}`;
      await graphExec(['GRAPH.QUERY', k, "UNWIND range(0,299) AS i CREATE (:Person {id:i, name:'<b>Sandbox</b>'})"]);
      await graphExec(['GRAPH.QUERY', k, 'MATCH (a),(b) WHERE b.id=a.id+1 CREATE (a)-[:NEXT {weight:1}]->(b)']);
      try {
        const external: string[] = [];
        page.on('request', (r) => { if (new URL(r.url()).origin !== new URL(baseURL!).origin) external.push(r.url()); });
        await gotoView(page, GRAPH_DB, 'workbench');
        await setEditor(page, `GRAPH.RO_QUERY ${k} "MATCH (a) RETURN a LIMIT 300"\nGRAPH.RO_QUERY ${k} "MATCH (a)-[r]->(b) RETURN r LIMIT 250"\nGRAPH.EXPLAIN ${k} "MATCH (a)-[r]->(b) RETURN a,r,b"`, 'workbench-editor');
        await page.getByTestId('workbench-run').click();
        await expect(page.getByTestId('console-result')).toHaveCount(3);
        await page.getByTestId('reply-view-tree').click();
        const graph = page.locator('[data-testid="result-rich"][data-kind="graph"]').first();
        await expect(graph).toHaveCount(1);
        await expect(graph.getByTestId('graph-node')).toHaveCount(200);
        await expect(graph.getByTestId('graph-count')).toContainText('100 more nodes not drawn');
        await expect(graph.getByRole('table', { name: 'Graph result table' })).toContainText('<b>Sandbox</b>');
        await expect(graph.getByTestId('graph-statistics')).toContainText('Query internal execution time');
        const n = graph.getByTestId('graph-node').first();
        await n.focus(); await page.keyboard.press('Enter');
        await expect(n).toHaveAttribute('aria-pressed', 'true');
        await expect(graph.getByTestId('graph-selection')).toContainText('<b>Sandbox</b>');
        await expect(page.getByTestId('plan-tree')).toContainText('Conditional Traverse');
        await expectNoXss(page);
        expect(external).toEqual([]);
        await page.getByTestId('reply-view-terminal').click();
        await expect(page.getByTestId('graph-view')).toHaveCount(0);
        await gotoView(page, GRAPH_DB, 'keys');
        const d = await openKey(page, k);
        await expect(d).toContainText('GRAPH.RO_QUERY');
        await expect(d).toContainText('Workbench');
      } finally { await graphExec(['GRAPH.DELETE', k]); }
    });
    if (role === 'viewer') {
      test('cannot mutate through QUERY/PROFILE or use CSV, code or config writes', async ({ page }) => {
        await gotoView(page, GRAPH_DB, 'workbench');
        await setEditor(page, `GRAPH.QUERY ${GRAPH_PREFIX}refused "CREATE (:P)"\nGRAPH.PROFILE ${GRAPH_PREFIX}refused "CREATE (:P)"\nGRAPH.RO_QUERY ${GRAPH_PREFIX}refused "LOAD CSV FROM 'file://x.csv' AS row RETURN row"\nGRAPH.UDF LIST\nGRAPH.CONFIG SET TIMEOUT_MAX 0`, 'workbench-editor');
        await expect(page.getByTestId('workbench-run')).toBeDisabled();
        await expect(page.getByTestId('confirmation-dialog')).toHaveCount(0);
        expect(Number(await graphExec(['EXISTS', `${GRAPH_PREFIX}refused`]))).toBe(0);
        await expect(page.getByTestId('workbench-policy')).toContainText(/operator/i);
      });
    } else {
      test('QUERY and mutating PROFILE require exact-command confirmation; admin DELETE is typed', async ({ page }) => {
        const k = `${GRAPH_PREFIX}${role}:write:${Date.now()}`;
        try {
          await gotoView(page, GRAPH_DB, 'workbench');
          await setEditor(page, `GRAPH.QUERY ${k} "CREATE (:P {name:'Created in Workbench'}) RETURN 1"\nGRAPH.PROFILE ${k} "CREATE (:P)"\nGRAPH.RO_QUERY ${k} "MATCH (n) RETURN n"`, 'workbench-editor');
          await page.getByTestId('workbench-run').click();
          const dlg = page.getByTestId('confirmation-dialog');
          await expect(dlg).toContainText('GRAPH.QUERY');
          await expect(dlg).toContainText('GRAPH.PROFILE');
          expect(Number(await graphExec(['EXISTS', k]))).toBe(0);
          await confirmDialog(page);
          await expect(page.getByTestId('console-result')).toHaveCount(3);
          await page.getByTestId('reply-view-tree').click();
          await expect(page.getByTestId('graph-node')).toHaveCount(2);
          await expect(page.getByTestId('plan-tree')).toContainText('Create');
          if (role === 'admin') {
            await setEditor(page, `GRAPH.DELETE ${k}`, 'workbench-editor');
            await page.getByTestId('workbench-run').click();
            await expect(page.getByTestId('confirmation-typed')).toBeVisible();
            await confirmDialog(page);
            await expect.poll(async () => Number(await graphExec(['EXISTS', k]))).toBe(0);
          }
        } finally { if (Number(await graphExec(['EXISTS', k]))) await graphExec(['GRAPH.DELETE', k]); }
      });
    }
  });
}
