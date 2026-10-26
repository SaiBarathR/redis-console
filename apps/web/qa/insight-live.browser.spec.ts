import { test, expect, type Browser, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
/**
 * v0.2.1 Insight live tour, as viewer, operator and admin (local QA accounts):
 * - snapshot (6412) and remote-6390: memory analysis jobs, recommendations, history and comparison (reads only).
 * - sandbox-e2e (6411): command-file import, index wizard (also from Make searchable), search workflow, rich workbench
 *   results, tutorials, palette entries, admin index drop. Every key and index it creates lives under
 *   INSIGHT_QA_RUN and is removed by the caller's cleanup.
 * Safety: every non-GET request to remote-6390 that is not a documented read is aborted in the browser and fails
 * the tour. CSP violations, console errors and page errors fail the tour too.
 */
const OUT = process.env.INSIGHT_QA_OUT ?? "/tmp/rc-insight-live";
const SHOTS = path.join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });
const RUN = process.env.INSIGHT_QA_RUN!;
const P = `${RUN}:`;
const ACCOUNTS = path.resolve(import.meta.dirname, "../../../.qa/accounts.json");
/** Top-level key prefix of the data in the snapshot database (RC_QA_KEY_PREFIX, default `example`). */
const KEY_PREFIX = process.env.RC_QA_KEY_PREFIX ?? "example";
const REMOTE_READS = /\/api\/v1\/databases\/remote-6390\/(analysis\/jobs(\/[0-9a-f]+\/cancel)?|analysis|search\/(index\/info|sample|query)|keys\/scan|key\/read|commands)$/;

const results: { step: string; role: string; ok: boolean; note: string }[] = [];
const problems: string[] = [];
const save = () => writeFileSync(path.join(OUT, "matrix.json"), JSON.stringify({ run: RUN, at: new Date().toISOString(), results, problems }, null, 2));

function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    const i = alphabet.indexOf(char);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

const pages = new Map<string, Page>();
async function session(browser: Browser, role: "viewer" | "operator" | "admin"): Promise<Page> {
  const existing = pages.get(role);
  if (existing) return existing;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`), true);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource: the server responded with a status of (4\d\d)/.test(m.text())) problems.push(`${role} console: ${m.text().slice(0, 300)}`);
  });
  page.on("pageerror", (e) => problems.push(`${role} pageerror: ${e.message.slice(0, 300)}`));
  await page.route("**/api/v1/databases/remote-6390/**", async (route) => {
    const req = route.request();
    if (req.method() === "GET" || REMOTE_READS.test(new URL(req.url()).pathname)) return route.continue();
    problems.push(`${role}: blocked a non-read request to remote-6390: ${req.method()} ${new URL(req.url()).pathname}`);
    return route.abort();
  });
  const accounts = JSON.parse(readFileSync(ACCOUNTS, "utf8")) as { local: Record<string, { username: string; password: string; totpSecret?: string }> };
  const account = accounts.local[`qa-${role}`]!;
  await page.goto("/login");
  await page.getByTestId("login-username").fill(account.username);
  await page.getByTestId("login-password").fill(account.password);
  await page.getByTestId("login-submit").click();
  const code = page.getByTestId("totp-code");
  await expect(code.or(page.getByTestId("database-landing")).first()).toBeVisible();
  if (await code.isVisible()) {
    await code.fill(totp(account.totpSecret!));
    await page.getByTestId("totp-submit").click();
  }
  await expect(page.getByTestId("database-landing")).toBeVisible();
  pages.set(role, page);
  return page;
}

async function step(name: string, role: string, run: () => Promise<string | void>) {
  try {
    const note = (await run()) ?? "";
    results.push({ step: name, role, ok: true, note });
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).replace(/\u001b\[[0-9;]*m/g, "").split("\n").filter(Boolean).slice(0, 4).join(" | ");
    results.push({ step: name, role, ok: false, note: msg });
    problems.push(`${name} · ${role}: ${msg}`);
  }
  save();
}
async function shot(page: Page, name: string) {
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}
async function cspOf(page: Page) {
  return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}
async function confirmDialog(page: Page, reason = "insight live tour") {
  const dialog = page.getByTestId("confirmation-dialog");
  await expect(dialog).toBeVisible();
  const typed = dialog.getByTestId("confirmation-typed");
  if (await typed.isVisible()) {
    const label = await dialog.locator("label").filter({ has: page.getByTestId("confirmation-typed") }).innerText();
    await typed.fill(/“(.+)”/.exec(label)![1]!);
  }
  const why = dialog.getByTestId("confirmation-reason");
  if (await why.isVisible()) await why.fill(reason);
  await dialog.getByTestId("confirmation-submit").click();
  await expect(dialog).toBeHidden();
}

const IMPORT = [
  "# insight live tour seed",
  `HSET ${P}product:1 name "Blue gadget" price 25 category tools`,
  `HSET ${P}product:2 name "Red gadget" price 40 category toys`,
  `HSET ${P}product:3 name "Green widget" price 15 category tools`,
  `TS.ADD ${P}temp 1767225600000 21.5`,
  `TS.ADD ${P}temp 1767225660000 22.5`,
  `TS.ADD ${P}temp 1767225720000 21.0`,
  `EXPIRE ${P}product:1 7200`,
  `EXPIRE ${P}product:2 7200`,
  `EXPIRE ${P}product:3 7200`,
  `EXPIRE ${P}temp 7200`,
  `LPUSH ${P}product:1 oops`,
].join("\n");
const INDEX = `idx:${RUN}:product`;

test.describe.serial("insight live tour", () => {
  test.afterAll(async () => {
    for (const [role, page] of pages) {
      const csp = await cspOf(page).catch(() => []);
      for (const c of csp) problems.push(`${role} CSP: ${c}`);
      await page.context().close();
    }
    save();
  });

  for (const role of ["viewer", "operator", "admin"] as const) {
    test(`analysis on snapshot and remote-6390 as ${role}`, async ({ browser }) => {
      const page = await session(browser, role);
      await step("analysis snapshot: job, recommendations, history, comparison", role, async () => {
        await page.goto("/db/snapshot/diagnostics/analysis");
        await page.getByTestId("analysis-pattern").fill(`${KEY_PREFIX}:*`);
        await page.getByTestId("analysis-sample").fill("3000");
        await page.getByTestId("analysis-run").click();
        await expect(page.getByTestId("analysis-report")).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId("analysis-coverage")).toContainText(/Based on 3,000 sampled keys of/);
        const recs = await page.getByTestId("analysis-recommendation").evaluateAll((els) => els.map((e) => e.getAttribute("data-rule")));
        await shot(page, `analysis-example-${role}`);
        await page.getByTestId("analysis-sample").fill("1000");
        await page.getByTestId("analysis-run").click();
        await expect(page.getByTestId("analysis-coverage")).toContainText(/Based on 1,000 sampled keys/, { timeout: 60_000 });
        await page.getByTestId("analysis-compare").selectOption({ index: 1 });
        await expect(page.getByTestId("analysis-comparison")).toBeVisible();
        await shot(page, `analysis-compare-${role}`);
        // Cancel a large run.
        await page.getByTestId("analysis-sample").fill("100000");
        await page.getByTestId("analysis-pattern").fill("*");
        await page.getByTestId("analysis-run").click();
        const cancel = page.getByTestId("analysis-cancel");
        if (await cancel.isVisible({ timeout: 2000 }).catch(() => false)) await cancel.click();
        await expect(page.getByTestId("analysis-run")).toBeEnabled({ timeout: 60_000 });
        return `rules: ${recs.join(", ")}`;
      });
      await step("analysis remote-6390 (read-only)", role, async () => {
        await page.goto("/db/remote-6390/diagnostics/analysis");
        await page.getByTestId("analysis-pattern").fill("*");
        await page.getByTestId("analysis-sample").fill("1000");
        await page.getByTestId("analysis-run").click();
        await expect(page.getByTestId("analysis-report")).toBeVisible({ timeout: 60_000 });
        const recs = await page.getByTestId("analysis-recommendation").count();
        await shot(page, `analysis-remote-${role}`);
        await page.goto("/db/remote-6390/guided?tab=tutorials");
        await expect(page.getByTestId("tutorial")).toContainText(/viewer|read-only/);
        await page.goto("/db/remote-6390/guided?tab=import");
        await expect(page.getByTestId("import-panel")).toContainText(/read-only|viewer/);
        return `${recs} recommendations`;
      });
    });
  }

  test("import on sandbox-e2e: operator runs it, viewer is refused", async ({ browser }) => {
    const op = await session(browser, "operator");
    await step("import: plan, confirm, chunked run, failure summary", "operator", async () => {
      await op.goto("/db/sandbox-e2e/guided?tab=import");
      await op.getByTestId("import-file").setInputFiles({ name: "seed.redis", mimeType: "text/plain", buffer: Buffer.from(IMPORT) });
      await expect(op.getByTestId("import-text")).toHaveValue(IMPORT);
      await op.getByTestId("import-check").click();
      await expect(op.getByTestId("import-plan")).toContainText("11 write");
      await expect(op.getByTestId("import-plan")).toContainText("0 refused");
      await op.getByTestId("import-start").click();
      await confirmDialog(op);
      await expect(op.getByTestId("import-status")).toHaveAttribute("data-state", "done", { timeout: 30_000 });
      await expect(op.getByTestId("import-counts")).toContainText("11 of 11 sent · 10 succeeded · 1 failed");
      await expect(op.getByTestId("import-status")).toContainText("LPUSH");
      await shot(op, "import-operator");
    });
    const viewer = await session(browser, "viewer");
    await step("import: writes refused for a viewer", "viewer", async () => {
      await viewer.goto("/db/sandbox-e2e/guided?tab=import");
      await viewer.getByTestId("import-text").fill(IMPORT);
      await viewer.getByTestId("import-check").click();
      await expect(viewer.getByTestId("import-plan")).toContainText("11 refused");
      await expect(viewer.getByTestId("import-start")).toBeDisabled();
      await shot(viewer, "import-viewer");
    });
  });

  test("index wizard, search workflow, workbench renderers and drop", async ({ browser }) => {
    const admin = await session(browser, "admin");
    await step("Make searchable from the inspector", "admin", async () => {
      await admin.goto("/db/sandbox-e2e/keys");
      await admin.getByTestId("key-pattern").fill(`${P}product:*`);
      await admin.getByTestId("key-scan").click();
      const row = admin.getByTestId("key-list").getByTestId("key-row").first();
      await expect(row).toBeVisible();
      await row.click();
      await admin.getByTestId("make-searchable").click();
      await expect(admin).toHaveURL(/diagnostics\/search\?panel=create$/);
      await expect(admin.getByTestId("wizard-field-row")).toHaveCount(3);
      await shot(admin, "wizard-from-key");
    });
    await step("wizard: fields, review, create (confirmation)", "admin", async () => {
      await admin.getByTestId("wizard-field-row").filter({ hasText: "price" }).getByLabel("Sortable").check();
      await admin.getByTestId("wizard-next").click();
      await admin.getByTestId("wizard-index-name").fill(INDEX);
      await expect(admin.getByTestId("wizard-command")).toContainText(`FT.CREATE ${INDEX} ON HASH PREFIX 1 ${P}product: SCHEMA`);
      await expect(admin.getByTestId("wizard-command")).toContainText("price NUMERIC SORTABLE");
      await shot(admin, "wizard-review");
      await admin.getByTestId("wizard-create").click();
      await confirmDialog(admin);
      await expect(admin.getByTestId("search-index-detail")).toBeVisible();
      await expect(admin.getByTestId("search-index-docs")).toHaveText("3", { timeout: 15_000 });
      await shot(admin, "index-detail");
    });
    await step("query: completion, sort, return, table/JSON, save, open document", "admin", async () => {
      await admin.getByTestId("search-index-query").click();
      const q = admin.getByTestId("search-query");
      await q.fill("");
      await q.pressSequentially("@cat");
      await expect(admin.getByTestId("search-query-completions")).toContainText("@category");
      await admin.keyboard.press("Enter");
      await expect(q).toHaveValue("@category:{}");
      await q.fill("@category:{tools}");
      await admin.getByTestId("search-sort").selectOption("price");
      await admin.getByTestId("search-sort-order").selectOption("DESC");
      await admin.getByTestId("search-return").getByLabel("name", { exact: true }).check();
      await admin.getByTestId("search-return").getByLabel("price", { exact: true }).check();
      await expect(admin.getByTestId("search-command")).toContainText('RETURN 2 name price SORTBY price DESC LIMIT 0 20');
      await admin.getByTestId("search-run").click();
      const results = admin.getByTestId("search-results");
      await expect(results).toContainText("2 results");
      const text = await results.locator("tbody").innerText();
      expect(text.indexOf("Blue gadget")).toBeLessThan(text.indexOf("Green widget"));
      await shot(admin, "search-table");
      await admin.getByTestId("search-view").getByRole("tab", { name: "JSON" }).click();
      await expect(results).toContainText("Green widget");
      await admin.getByTestId("search-save-name").fill("tools by price");
      await admin.getByTestId("search-save").click();
      await expect(admin.getByTestId("search-saved")).toContainText("tools by price");
      await admin.getByTestId("search-explain").click();
      await expect(admin.getByTestId("plan-tree")).toBeVisible();
      await admin.getByTestId("search-profile").click();
      await expect(admin.getByTestId("result-rich")).toHaveAttribute("data-kind", "profile");
      await shot(admin, "search-profile");
      await admin.getByTestId("search-saved").getByRole("button", { name: "tools by price", exact: true }).click();
      await expect(results).toContainText("2 results");
      await results.getByTestId("search-open-doc").first().click();
      await expect(admin.getByTestId("key-detail").locator("h2")).toContainText(`${P}product:`);
    });
    await step("workbench: table, chart, plan and aggregate renderers", "admin", async () => {
      await admin.goto("/db/sandbox-e2e/workbench");
      const input = admin.getByTestId("workbench-editor-input");
      await input.click();
      await input.fill(
        [`FT.SEARCH ${INDEX} "@name:gadget"`, `TS.RANGE ${P}temp - +`, `FT.EXPLAIN ${INDEX} "@name:gadget @price:[10 30]"`, `FT.AGGREGATE ${INDEX} "*" GROUPBY 1 @category REDUCE COUNT 0 AS n`].join("\n"),
      );
      await admin.keyboard.press("ControlOrMeta+Enter");
      await expect(admin.getByTestId("console-result")).toHaveCount(4, { timeout: 20_000 });
      await admin.getByTestId("reply-view-tree").click();
      const kinds = await admin.getByTestId("result-rich").evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
      expect(kinds.sort()).toEqual(["aggregate", "explain", "search", "series"]);
      await expect(admin.locator('[data-kind="series"] canvas').first()).toBeVisible();
      await shot(admin, "workbench-rich");
      await admin.getByTestId("reply-view-terminal").click();
      await admin.getByTestId("result-rich-toggle").first().getByRole("button").first().click();
      await expect(admin.getByTestId("result-rich")).toHaveCount(1);
    });
    const op = await session(browser, "operator");
    await step("operator: wizard create is refused by the Redis ACL user (NOPERM)", "operator", async () => {
      await op.goto("/db/sandbox-e2e/diagnostics/search?panel=create");
      await op.getByTestId("wizard-prefix").fill(`${P}product:`);
      await op.getByTestId("wizard-sample").click();
      await op.getByTestId("wizard-next").click();
      await op.getByTestId("wizard-index-name").fill(`${INDEX}-op`);
      await op.getByTestId("wizard-create").click();
      await confirmDialog(op);
      await expect(op.locator("main [role=alert]").filter({ hasText: /NOPERM/ })).toBeVisible();
      await shot(op, "wizard-operator-noperm");
      await op.goto("/db/sandbox-e2e/diagnostics/search?panel=indexes");
      await op.getByRole("button", { name: INDEX }).click();
      await expect(op.getByTestId("search-index-drop")).toHaveCount(0);
    });
    const viewer = await session(browser, "viewer");
    await step("viewer: query works, create is disabled, no drop", "viewer", async () => {
      await viewer.goto("/db/sandbox-e2e/diagnostics/search");
      await viewer.getByTestId("search-index").selectOption(INDEX);
      await viewer.getByTestId("search-query").fill("@name:gadget");
      await viewer.getByTestId("search-run").click();
      await expect(viewer.getByTestId("search-results")).toContainText("2 results");
      await viewer.getByTestId("search-explain").click();
      await expect(viewer.locator("main [role=alert]").filter({ hasText: "Profile query shows the plan" })).toBeVisible();
      await viewer.getByTestId("search-profile").click();
      await expect(viewer.getByTestId("plan-tree").first()).toBeVisible();
      await viewer.goto("/db/sandbox-e2e/diagnostics/search?panel=create");
      await viewer.getByTestId("wizard-prefix").fill(`${P}product:`);
      await viewer.getByTestId("wizard-sample").click();
      await viewer.getByTestId("wizard-next").click();
      await expect(viewer.getByTestId("wizard-create")).toBeDisabled();
      await shot(viewer, "wizard-viewer");
    });
    await step("tutorials: insert into the workbench; palette destinations", "viewer", async () => {
      await viewer.goto("/db/sandbox-e2e/workbench");
      await viewer.getByTestId("workbench-tutorials").click();
      await viewer.getByTestId("tutorial-streams").click();
      await viewer.getByTestId("tutorial-insert").first().click();
      await expect(viewer).toHaveURL(/\/workbench$/);
      await expect(viewer.getByTestId("workbench-editor-input")).toContainText("XADD tutorial:orders");
      await viewer.getByTestId("command-palette-open").click();
      await viewer.getByTestId("command-palette-search").fill("Search");
      await expect(viewer.getByTestId("command-palette")).toContainText("Search: make keys searchable");
      await viewer.keyboard.press("Escape");
      await shot(viewer, "tutorial-inserted");
    });
    await step("admin drop: typed index name, documents kept", "admin", async () => {
      await admin.goto("/db/sandbox-e2e/diagnostics/search?panel=indexes");
      await admin.getByRole("button", { name: INDEX }).click();
      await admin.getByTestId("search-index-drop").click();
      await confirmDialog(admin);
      await expect(admin.getByTestId("search-index-detail")).toHaveCount(0);
      await admin.goto("/db/sandbox-e2e/keys");
      await admin.getByTestId("key-pattern").fill(`${P}product:*`);
      await admin.getByTestId("key-scan").click();
      await expect(admin.getByTestId("key-list").getByTestId("key-row")).toHaveCount(3);
    });
  });

  test("no CSP violations, console errors or page errors", async () => {
    for (const [role, page] of pages) for (const c of await cspOf(page)) problems.push(`${role} CSP: ${c}`);
    save();
    expect(problems).toEqual([]);
  });
});
