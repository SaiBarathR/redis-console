import { test, expect, type Locator, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
/**
 * v0.2 UI live tour: every page and feature the UI agent owns, as viewer, operator and admin, through Keycloak
 * SSO and local accounts, on snapshot, sandbox-main, sandbox-e2e and the read-only remote-6390.
 *
 * Safety: requests to remote-6390 are intercepted in the browser. Any non-GET that is not a documented read
 * (scan, key read, analysis sample, pub/sub listen, streams/search/timeseries reads, or a read-only console line)
 * is aborted before it leaves the browser and fails the tour. Writes on the sandboxes use the `uiqa:<run>:`
 * namespace and are deleted again through the UI. Port 6380 is never involved.
 *
 * Output: qa-results/v02-live/matrix.json (page × role × database results) and qa-results/v02-live/shots/.
 */
const OUT = path.resolve(import.meta.dirname, "../qa-results/v02-live");
const SHOTS = path.join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });
const RUN = process.env.UIQA_RUN ?? `uiqa:${Date.now().toString(36)}`;
const WRITABLE = ["snapshot", "sandbox-main", "sandbox-e2e"] as const;
const REMOTE = "remote-6390";
const DATABASES = [...WRITABLE, REMOTE] as const;
const ACCOUNTS = path.resolve(import.meta.dirname, "../../../.qa/accounts.json");
/** Top-level key prefix of the data in the snapshot database (RC_QA_KEY_PREFIX, default `example`). */
const KEY_PREFIX = process.env.RC_QA_KEY_PREFIX ?? "example";
/** Folders below KEY_PREFIX that lead to a namespace of JSON strings (RC_QA_KEY_PATH, default `group:items:v1`). */
const KEY_PATH = (process.env.RC_QA_KEY_PATH ?? "group:items:v1").split(":");

interface Row {
  page: string;
  role: string;
  login: string;
  db: string;
  result: "pass" | "fail" | "n/a";
  notes: string;
  ms?: number;
}
const matrix: Row[] = [];
const problems: string[] = [];
const httpNotes = new Set<string>();
// Resume this run's matrix when Playwright restarts the worker after a failed test.
if (existsSync(path.join(OUT, "matrix.json"))) {
  const previous = JSON.parse(readFileSync(path.join(OUT, "matrix.json"), "utf8")) as {
    run: string;
    matrix: Row[];
    problems: string[];
    http?: string[];
  };
  if (previous.run === RUN) {
    matrix.push(...previous.matrix);
    problems.push(...previous.problems);
    for (const entry of previous.http ?? []) httpNotes.add(entry);
  }
}
function save() {
  writeFileSync(
    path.join(OUT, "matrix.json"),
    JSON.stringify({ run: RUN, at: new Date().toISOString(), matrix, problems, http: [...httpNotes] }, null, 2),
  );
}
async function check(
  page: string,
  role: string,
  login: string,
  db: string,
  run: () => Promise<string | void>,
) {
  const started = Date.now();
  try {
    const notes = (await run()) ?? "";
    matrix.push({ page, role, login, db, result: "pass", notes, ms: Date.now() - started });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split("\n")
      .filter(Boolean)
      .slice(0, 4)
      .join(" | ");
    matrix.push({ page, role, login, db, result: "fail", notes: message, ms: Date.now() - started });
    problems.push(`${page} · ${role} · ${db}: ${message}`);
  }
  save();
}
function skip(page: string, role: string, login: string, db: string, notes: string) {
  matrix.push({ page, role, login, db, result: "n/a", notes });
  save();
}

const READ_POST =
  /\/api\/v1\/databases\/[^/]+\/(?:keys\/scan|key\/read|analysis|pubsub\/channels|pubsub\/subscriptions|streams\/groups|streams\/pending|search\/query|timeseries\/range)$/;
const READ_LINE = /^\s*(?:PING|DBSIZE|GET|TYPE|TTL|PTTL|EXISTS|STRLEN|HGETALL|HGET|HLEN|LLEN|LRANGE|SCARD|ZCARD|INFO|SCAN|COMMAND)\b/i;

/** Records CSP / Trusted Types violations, page errors, console errors; blocks writes to remote-6390. */
async function guard(page: Page, label: string) {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) =>
      w.__csp.push(`${event.violatedDirective} ${event.blockedURI}`),
    );
  });
  page.on("pageerror", (error) => problems.push(`${label} pageerror: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy|Trusted Type/i.test(text)) problems.push(`${label} csp: ${text}`);
    else if (
      message.type() === "error" &&
      !/^Failed to load resource/.test(text) &&
      !new URL(page.url()).host.startsWith("localhost:8089")
    )
      problems.push(`${label} console: ${text}`);
  });
  // HTTP errors by URL: 5xx fails the tour; 401/403/404/409/428/429 are expected answers (permissions,
  // missing keys, confirmations, rate limits) and are listed in the matrix notes.
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/api/") || response.status() < 400) return;
    const entry = `${response.status()} ${response.request().method()} ${url.pathname}`;
    if (response.status() >= 500) problems.push(`${label} ${entry}`);
    else httpNotes.add(`${label}: ${entry}`);
  });
  await page.route(`**/api/v1/databases/${REMOTE}/**`, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" || READ_POST.test(url.pathname)) return route.continue();
    if (url.pathname.endsWith("/cli")) {
      const body = request.postDataJSON() as { line?: string } | undefined;
      if (body?.line && READ_LINE.test(body.line) && !/[\r\n]/.test(body.line)) return route.continue();
    }
    problems.push(`${label} BLOCKED write attempt to ${REMOTE}: ${request.method()} ${url.pathname}`);
    return route.abort("blockedbyclient");
  });
}
async function cspCount(page: Page) {
  return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp?.length ?? 0);
}

function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hmac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, "0");
}

async function sso(page: Page, user: string) {
  await page.goto("/");
  await page.getByTestId("login-sso").click();
  await page.locator("#username").fill(user);
  await page.locator("#password").fill(process.env.KC_USER_PASSWORD!);
  await page.locator("#kc-login").click();
}
async function local(page: Page, user: string) {
  const accounts = JSON.parse(readFileSync(ACCOUNTS, "utf8")) as {
    local: Record<string, { username: string; password: string; totpSecret?: string }>;
  };
  const account = accounts.local[user]!;
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
}
async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
async function settled(page: Page) {
  await expect(page.locator("main .spin")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator("main.fatal")).toHaveCount(0);
}
async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((value) => localStorage.setItem("rconsole.theme", value), theme);
}
async function confirmDialog(page: Page, reason = "UI QA") {
  const dialog = page.getByTestId("confirmation-dialog");
  await expect(dialog).toBeVisible();
  const typed = dialog.getByTestId("confirmation-typed");
  if (await typed.isVisible()) {
    // `has` takes a locator relative to the filtered element, so use the page-level test id.
    const label = await dialog.locator("label").filter({ has: page.getByTestId("confirmation-typed") }).innerText();
    await typed.fill(/“(.+)”/.exec(label)![1]!);
  }
  const why = dialog.getByTestId("confirmation-reason");
  if (await why.isVisible()) await why.fill(reason);
  await dialog.getByTestId("confirmation-submit").click();
  await expect(dialog).toBeHidden();
}
/** Opens a visible namespace folder (by its label) when it is collapsed. */
async function openFolder(page: Page, label: string) {
  const folder = page.getByRole("treeitem", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first();
  if ((await folder.getAttribute("aria-expanded")) === "false") await folder.click();
}
const tab = (scope: Locator, name: string) =>
  scope.getByTestId("value-format").getByRole("tab", { name, exact: true });

/** Pages every role can open on a database (diagnostics tools are added per role). */
const VIEWS = ["overview", "keys", "console", "workbench", "guided", "diagnostics"];
const TOOLS = ["slowlog", "analysis", "pubsub", "streams", "search", "timeseries"];

async function visitAll(page: Page, role: string, login: string) {
  for (const db of DATABASES) {
    for (const view of VIEWS) {
      await check(`View · ${view}`, role, login, db, async () => {
        await page.goto(`/db/${db}/${view}`);
        await expect(page.getByTestId("database-switcher")).toHaveValue(db);
        await settled(page);
        await expect(page.locator("main")).not.toBeEmpty();
        if (db === REMOTE)
          await expect(page.getByRole("status").filter({ hasText: /All writes are disabled/ })).toBeVisible();
      });
    }
    const admin = role === "admin" && db !== REMOTE;
    for (const tool of [...TOOLS, ...(admin ? ["clients", "profiler"] : [])]) {
      const link = `/db/${db}/diagnostics/${tool}`;
      await check(`Diagnostics · ${tool}`, role, login, db, async () => {
        await page.goto(link);
        await settled(page);
        const pane = page.locator(".diag-pane");
        await expect(pane).not.toBeEmpty();
        const unavailable = await pane.getByText(/Needs the|Requires the|module on this database|disabled by policy/i).count();
        return unavailable ? "tool pane explains why it is unavailable" : "";
      });
    }
    if (!admin) {
      for (const tool of ["clients", "profiler"])
        await check(`Diagnostics · ${tool}`, role, login, db, async () => {
          await page.goto(`/db/${db}/diagnostics`);
          await expect(page.getByTestId(`diagnostics-${tool}`)).toHaveCount(0);
          return "not offered (admin only, never on read-only)";
        });
    }
  }
}

async function landing(page: Page, role: string, login: string) {
  await check("Database landing", role, login, "all", async () => {
    await page.goto("/");
    const landing = page.getByTestId("database-landing");
    await expect(landing).toBeVisible();
    expect(await landing.locator("a.db-link").count()).toBeGreaterThanOrEqual(DATABASES.length);
    await expect(landing.locator("tbody tr").first().locator("td.num").first()).not.toHaveText("…", { timeout: 15_000 });
    // Keyboard: the first row is focused on load; ArrowDown then Enter opens the second database.
    const autofocus = await landing.locator("a.db-link").first().evaluate((link) => link === document.activeElement);
    await landing.locator("a.db-link").first().focus();
    await page.keyboard.press("ArrowDown");
    const second = await landing.locator("a.db-link").nth(1).getAttribute("href");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${second}$`));
    await page.goto("/");
    await expect(landing.locator("a.db-link").first()).toBeVisible();
    await page.locator("body").press("1");
    await expect(page).toHaveURL(/\/db\/[^/]+\/overview$/);
    return `${await landing.locator("a.db-link").count()} rows; first row ${autofocus ? "focused on load" : "NOT focused on load"}; arrows + Enter and 1–9 open databases`;
  });
}

async function browse(page: Page, role: string, login: string, db: string) {
  await check("Keys · browse, inspect, formatters, keyboard", role, login, db, async () => {
    await page.goto(`/db/${db}/keys`);
    const list = page.getByTestId("key-list");
    await expect(list).toBeVisible();
    await page.getByTestId("key-delimiter").fill("");
    await list.getByTestId("key-row").first().click();
    const detail = page.getByTestId("key-detail");
    await expect(detail.locator("h2")).toBeVisible();
    const tabs = detail.getByTestId("value-format");
    if (await tabs.count()) {
      await tab(detail, "Hex").click();
      // Hex rows: 8-digit offset, then bytes (an empty value has no rows).
      await expect(detail.getByTestId("key-value")).toHaveText(/^(?:00000000\s+[0-9a-f]{2}[\s\S]*)?$/);
      await tab(detail, "Text").click();
    }
    await page.getByTestId("key-delimiter").fill(":");
    await list.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(detail.locator("h2")).toBeVisible();
    // Selection works for every role; write actions only for writers.
    await page.getByRole("checkbox", { name: "Select all loaded keys" }).first().check();
    const bar = page.getByRole("region", { name: "Selected keys" });
    await expect(bar).toContainText("selected");
    await expect(bar.getByRole("button", { name: "Copy names" })).toBeVisible();
    const writes = await bar.getByTestId("selection-delete").count();
    await bar.getByRole("button", { name: "Clear" }).click();
    const writer = role !== "viewer" && db !== REMOTE;
    expect(writes > 0).toBe(writer);
    await expect(page.getByTestId("key-add")).toHaveCount(writer ? 1 : 0);
    return writer ? "selection bar offers Set TTL and Delete" : "selection bar offers Copy names only; no write controls";
  });
}

async function scanAll(page: Page, role: string, login: string) {
  await check("Keys · scan to end (7.5k keys)", role, login, "snapshot", async () => {
    await page.goto("/db/snapshot/keys");
    await expect(page.getByTestId("key-list")).toBeVisible();
    const started = Date.now();
    await page.getByRole("button", { name: "Scan to end" }).click();
    await expect(page.locator(".scan-foot")).toContainText("Cursor returned to 0", { timeout: 60_000 });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const count = await page.locator(".count-line").innerText();
    // With every key loaded the root has several namespaces (all start collapsed). Open the KEY_PREFIX namespace, then the first KEY_PATH folder.
    const roots = await page.getByRole("treeitem").count();
    const before = Date.now();
    await page.getByRole("treeitem", { name: new RegExp(`^${KEY_PREFIX}:`) }).click();
    await page.getByRole("treeitem", { name: new RegExp(`^${KEY_PATH[0]}:`) }).click();
    await expect(page.getByRole("treeitem", { name: new RegExp(`^${KEY_PATH[1]}:`) })).toBeVisible();
    const tree = Date.now() - before;
    await page.getByTestId("key-delimiter").fill("");
    // The list is virtualised: only the rows in view (plus overscan) exist in the DOM.
    const rendered = await page.getByTestId("key-row").count();
    const list = page.getByTestId("key-list");
    await list.focus();
    const jump = Date.now();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("key-detail").locator("h2")).toBeVisible();
    const end = Date.now() - jump;
    return `${count}; scan to end ${seconds}s; ${roots} root namespaces; opening two levels ${tree} ms; flat list renders ${rendered} rows of ${count.split(" ")[0]}; End + Enter on the last key ${end} ms`;
  });
}

async function writeFlow(page: Page, role: string, login: string, db: string) {
  const ns = `${RUN}:${role}:${db}:`;
  await check("Keys · add, edit, TTL, rename, hash field, bulk TTL/delete, delete by pattern", role, login, db, async () => {
    await page.goto(`/db/${db}/keys`);
    const add = async (type: string, name: string, value: string, field?: string) => {
      await page.getByTestId("key-add").click();
      const dialog = page.getByTestId("key-editor-dialog");
      await dialog.getByTestId("key-create-type").selectOption(type);
      await dialog.getByTestId("key-create-name").fill(name);
      if (field) await dialog.getByTestId("key-edit-field").fill(field);
      await dialog.getByTestId("key-edit-value").fill(value);
      await dialog.getByTestId("key-save").click();
      await expect(dialog).toBeHidden();
    };
    const detail = page.getByTestId("key-detail");
    await add("string", `${ns}str`, '{"hello":"world","n":[1,2]}');
    await expect(detail.locator("h2")).toHaveText(`${ns}str`);
    await expect(tab(detail, "JSON")).toHaveAttribute("aria-selected", "true");
    await detail.getByTestId("key-edit").click();
    await page.getByTestId("key-editor-dialog").getByTestId("key-edit-value").fill("plain text");
    await page.getByTestId("key-editor-dialog").getByTestId("key-save").click();
    await expect(page.getByTestId("key-editor-dialog")).toBeHidden();
    await expect(detail.getByTestId("key-value")).toHaveText("plain text");
    await detail.getByTestId("key-ttl").click();
    await page.getByTestId("key-ttl-input").fill("900");
    await page.getByTestId("key-ttl-submit").click();
    await expect(page.getByTestId("key-ttl-dialog")).toBeHidden();
    await expect(detail.locator(".inspector-facts .fuse-label")).toHaveText(/1[45]m/);
    await detail.getByTestId("key-rename").click();
    await page.getByTestId("key-rename-input").fill(`${ns}renamed`);
    await page.getByTestId("key-rename-submit").click();
    await expect(page.getByTestId("key-rename-dialog")).toBeHidden();
    await expect(detail.locator("h2")).toHaveText(`${ns}renamed`);
    await add("hash", `${ns}hash`, "v1", "f1");
    await detail.getByRole("button", { name: "Edit hash field f1" }).click();
    await detail.getByRole("textbox", { name: "Value of f1" }).fill("v2");
    await detail.getByRole("button", { name: "Save" }).click();
    await expect(detail.locator("tbody")).toContainText("v2");
    for (const n of [1, 2, 3]) await add("string", `${ns}bulk:${n}`, `b${n}`);
    await page.getByTestId("key-pattern").fill(`${ns}bulk:*`);
    await page.getByTestId("key-scan").click();
    await expect(page.getByTestId("key-row")).toHaveCount(3);
    await page.getByRole("checkbox", { name: "Select all loaded keys" }).check();
    const bar = page.getByRole("region", { name: "Selected keys" });
    await expect(bar).toContainText("3 selected");
    await bar.getByRole("spinbutton").fill("600");
    await bar.getByRole("button", { name: "Set TTL" }).click();
    await expect(page.getByTestId("key-row").first().locator(".fuse-label")).toHaveText(/(9|10)m/);
    await page.getByRole("checkbox", { name: "Select all loaded keys" }).check();
    await page.getByTestId("selection-delete").click();
    await confirmDialog(page);
    await expect(page.getByTestId("key-row")).toHaveCount(0);
    await page.getByTestId("bulk-delete").click();
    const bulk = page.getByTestId("bulk-delete-dialog");
    await bulk.getByTestId("bulk-delete-pattern").fill(`${ns}*`);
    await bulk.getByTestId("bulk-delete-preview").click();
    await expect(bulk).toContainText("Preview sample");
    await bulk.getByTestId("bulk-delete-review").click();
    await confirmDialog(page);
    await expect(bulk).toContainText(/Deleted \d+ of/);
    await page.keyboard.press("Escape");
    return "created, formatted, edited, expired, renamed, hash field edited, 3 keys bulk-expired and deleted, namespace deleted by pattern";
  });
}

async function guided(page: Page, role: string, login: string, db: string) {
  await check("Guided · find and inspect", role, login, db, async () => {
    await page.goto(`/db/${db}/guided`);
    await page.getByTestId("guided-find").click();
    await page.getByTestId("guided-key").fill(`${KEY_PREFIX}:*`);
    await page.getByTestId("guided-run").click();
    await expect(page.locator(".guided-result")).toBeVisible();
  });
  const writer = role !== "viewer" && db !== REMOTE;
  await check("Guided · write task", role, login, db, async () => {
    await page.getByTestId("guided-edit").click();
    if (!writer) {
      await expect(page.getByTestId("guided-run")).toBeDisabled();
      return "write task disabled with the reason shown";
    }
    await page.getByTestId("guided-key").fill(`${RUN}:${role}:${db}:guided`);
    await page.getByTestId("guided-value").fill("from guided mode");
    await expect(page.getByTestId("guided-command")).toContainText("SET");
    await page.getByTestId("guided-run").click();
    await expect(page.locator(".guided-result")).toBeVisible();
    return "SET ran; key removed by the delete-by-pattern step";
  });
}

async function diagnostics(page: Page, role: string, login: string, db: string) {
  await check("Diagnostics · memory analysis", role, login, db, async () => {
    await page.goto(`/db/${db}/diagnostics/analysis`);
    await page.getByTestId("analysis-pattern").fill("*");
    await page.getByTestId("analysis-run").click();
    await expect(page.getByTestId("analysis-report")).toBeVisible({ timeout: 30_000 });
  });
  await check("Diagnostics · pub/sub listen and publish", role, login, db, async () => {
    await page.goto(`/db/${db}/diagnostics/pubsub`);
    const channel = `${RUN}-${role}`;
    await page.getByTestId("pubsub-channel").fill(channel);
    await page.getByTestId("pubsub-subscribe").click();
    await expect(page.getByTestId("pubsub-stop")).toBeVisible();
    const writer = role !== "viewer" && db !== REMOTE;
    if (writer) {
      await page.waitForTimeout(500);
      await page.getByTestId("publish-channel").fill(channel);
      await page.getByTestId("publish-message").fill("hello from the UI tour");
      await page.getByTestId("pubsub-publish").click();
      await expect(page.locator("main")).toContainText("hello from the UI tour");
    } else await expect(page.getByTestId("pubsub-publish")).toBeDisabled();
    await page.getByTestId("pubsub-stop").click();
    return writer ? "message round trip" : "listen only; publish disabled";
  });
  if (role === "admin" && db !== REMOTE) {
    await check("Diagnostics · clients", role, login, db, async () => {
      await page.goto(`/db/${db}/diagnostics/clients`);
      await expect(page.locator("main table")).toBeVisible();
    });
    await check("Diagnostics · profiler", role, login, db, async () => {
      await page.goto(`/db/${db}/diagnostics/profiler`);
      await page.getByTestId("profiler-seconds").fill("4");
      await page.getByTestId("profiler-start").click();
      await expect(page.getByTestId("profiler-stop")).toBeVisible();
      await page.getByTestId("profiler-stop").click();
    });
  }
}

async function remote(page: Page, role: string, login: string) {
  await check("Read-only marking and refused writes", role, login, REMOTE, async () => {
    await page.goto(`/db/${REMOTE}/keys`);
    await expect(page.getByRole("status").filter({ hasText: /Read-only database · All writes are disabled/ })).toBeVisible();
    await expect(page.locator(".database-badges")).toContainText("Read-only");
    await expect(page.locator(".database-badges")).toContainText("viewer");
    await expect(page.locator(".statusbar")).toContainText("Read-only");
    await expect(page.getByTestId("key-add")).toHaveCount(0);
    await expect(page.getByTestId("bulk-delete")).toHaveCount(0);
    await page.getByTestId("key-delimiter").fill("");
    await page.getByTestId("key-list").getByTestId("key-row").first().click();
    const detail = page.getByTestId("key-detail");
    await expect(detail.locator("h2")).toBeVisible();
    for (const id of ["key-edit", "key-ttl", "key-rename", "key-delete"])
      await expect(detail.getByTestId(id)).toHaveCount(0);
    await page.goto(`/db/${REMOTE}/console`);
    const input = page.getByTestId("console-editor-input");
    await input.click();
    await input.fill(`SET ${RUN}:never x`);
    await expect(page.getByTestId("console-run")).toBeDisabled();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    return "frame + edge + both bars marked; no write controls; console refuses SET before sending";
  });
}

async function adminPages(page: Page, role: string, login: string) {
  if (role !== "admin") {
    await check("Admin · audit and users hidden", role, login, "—", async () => {
      await page.goto("/admin/audit");
      await expect(page.getByTestId("nav-audit")).toHaveCount(0);
      await expect(page.locator("main table")).toHaveCount(0);
    });
    return;
  }
  await check("Admin · audit log with filters", role, login, "—", async () => {
    await page.goto("/admin/audit");
    await expect(page.locator("main table")).toBeVisible();
    await page.getByTestId("audit-user-filter").fill("operator1");
    await page.getByTestId("audit-filter").click();
    await expect(page.locator("main tbody tr").first()).toContainText("operator1");
    expect(await page.locator("main").innerText()).not.toContain("hello from the UI tour");
    return "values never shown (published message absent)";
  });
  await check("Admin · local users", role, login, "—", async () => {
    await page.goto("/admin/users");
    await expect(page.locator("main table")).toBeVisible();
    await page.getByTestId("user-add").click();
    await expect(page.getByTestId("user-editor-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("user-editor-dialog")).toBeHidden();
  });
}

async function account(page: Page, role: string, login: string) {
  await check("Account", role, login, "—", async () => {
    await page.goto("/account");
    await expect(page.locator("main")).toContainText(/Account|password|authenticator|Session/i);
  });
}

test.afterAll(() => {
  save();
});

test("SSO refuses nogroup1", async ({ page }) => {
  await guard(page, "nogroup1");
  await check("Sign-in (SSO)", "no group", "SSO", "—", async () => {
    await sso(page, "nogroup1");
    await page.waitForURL(/\/login\?error=oidc_no_role/);
    await expect(page.getByRole("alert")).toContainText(/no Redis Console role/i);
    expect((await page.request.get("/api/v1/auth/me")).status()).toBe(401);
    return "refused with the reason; no session";
  });
});

for (const [user, role] of [
  ["viewer1", "viewer"],
  ["operator1", "operator"],
  ["admin1", "admin"],
] as const) {
  test(`SSO ${user} (${role}) tour`, async ({ page }) => {
    await guard(page, user);
    await check("Sign-in (SSO)", role, "SSO", "—", async () => {
      await sso(page, user);
      await expect(page.getByTestId("database-landing")).toBeVisible();
      const me = await (await page.request.get("/api/v1/auth/me")).json();
      expect(me.role).toBe(role);
    });
    await landing(page, role, "SSO");
    await visitAll(page, role, "SSO");
    for (const db of DATABASES) await browse(page, role, "SSO", db);
    await scanAll(page, role, "SSO");
    for (const db of DATABASES) {
      await guided(page, role, "SSO", db);
      await diagnostics(page, role, "SSO", db);
      if (role !== "viewer" && db !== REMOTE) await writeFlow(page, role, "SSO", db);
      else skip("Keys · add, edit, TTL, rename, hash field, bulk TTL/delete, delete by pattern", role, "SSO", db, db === REMOTE ? "read-only database: no write controls" : "viewer: no write controls");
    }
    await remote(page, role, "SSO");
    await adminPages(page, role, "SSO");
    await account(page, role, "SSO");
    expect(await cspCount(page)).toBe(0);
  });
}

for (const [user, role] of [
  ["qa-viewer", "viewer"],
  ["qa-operator", "operator"],
  ["qa-admin", "admin"],
] as const) {
  test(`local ${user} (${role})`, async ({ page }) => {
    await guard(page, user);
    await check("Sign-in (local)", role, "local", "—", async () => {
      await local(page, user);
      await expect(page.getByTestId("database-landing")).toBeVisible();
      return role === "admin" ? "password + TOTP" : "password";
    });
    await landing(page, role, "local");
    for (const db of DATABASES) await browse(page, role, "local", db);
    if (role !== "viewer") await writeFlow(page, role, "local", "sandbox-e2e");
    await remote(page, role, "local");
    await adminPages(page, role, "local");
    await account(page, role, "local");
    expect(await cspCount(page)).toBe(0);
  });
}

/** Curated screenshots for docs/qa/v02-ui (both themes; 1440 and 1024). */
test("screenshots", async ({ page }) => {
  await guard(page, "shots");
  await sso(page, "admin1");
  await expect(page.getByTestId("database-landing")).toBeVisible();
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const tag = `${theme}-${width}`;
      await page.goto("/");
      await expect(page.locator("td.num").first()).not.toHaveText("…", { timeout: 15_000 });
      await shot(page, `${tag}-landing`);
      await page.goto("/db/snapshot/overview");
      await page.waitForTimeout(5000);
      await shot(page, `${tag}-overview`);
      await page.goto("/db/snapshot/keys");
      await expect(page.getByTestId("key-list")).toBeVisible();
      for (const folder of [KEY_PREFIX, ...KEY_PATH].map((f) => `${f}:`)) await openFolder(page, folder);
      await page.getByTestId("key-row").nth(1).click();
      await expect(page.getByTestId("key-detail").locator("h2")).toBeVisible();
      await shot(page, `${tag}-keys-inspector`);
      if (width === 1440) {
        await page.goto("/db/sandbox-main/keys");
        await page.getByTestId("key-row").filter({ hasText: "v4" }).first().click();
        await page.getByTestId("key-row").nth(6).locator("input").click();
        await page.getByTestId("key-row").nth(7).locator("input").click({ modifiers: ["Shift"] });
        await page.getByTestId("key-row").nth(9).locator("input").click({ modifiers: ["Shift"] });
        await shot(page, `${tag}-keys-hash-selection`);
        await page.goto(`/db/${REMOTE}/keys`);
        await page.getByTestId("key-delimiter").fill("");
        await page.getByTestId("key-row").first().click();
        await page.getByTestId("key-explain").click();
        await shot(page, `${tag}-remote-readonly-explain`);
        await page.goto("/db/snapshot/diagnostics/analysis");
        await page.getByTestId("analysis-run").click();
        await expect(page.getByTestId("analysis-report")).toBeVisible({ timeout: 30_000 });
        await shot(page, `${tag}-diagnostics-analysis`);
        await page.goto("/db/sandbox-e2e/guided");
        await page.getByTestId("guided-inspect").click();
        await page.getByTestId("guided-key").fill(`${KEY_PREFIX}:session:1001`);
        await shot(page, `${tag}-guided`);
        await page.goto("/admin/audit");
        await expect(page.locator("main table")).toBeVisible();
        await shot(page, `${tag}-audit`);
      } else {
        await page.goto("/db/sandbox-main/diagnostics");
        await shot(page, `${tag}-diagnostics-slowlog`);
        await page.goto("/admin/users");
        await expect(page.locator("main table")).toBeVisible();
        await shot(page, `${tag}-users`);
        await page.goto("/account");
        await shot(page, `${tag}-account`);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const others = await (await page.request.get("/api/v1/databases")).json();
  for (const id of ["ui-prod-sim", "ui-staging-sim"]) {
    if (!others.databases.some((db: { id: string }) => db.id === id)) continue;
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      await page.goto(`/db/${id}/overview`);
      await page.waitForTimeout(3000);
      await shot(page, `${theme}-1440-${id}-frame`);
    }
  }
  await page.getByTestId("logout").click();
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.goto("/login");
    await expect(page.getByTestId("login-sso")).toBeVisible();
    await shot(page, `${theme}-1440-sign-in`);
  }
  expect(await cspCount(page)).toBe(0);
});

test.afterAll(() => {
  expect(problems, "problems recorded during the tour").toEqual([]);
});
