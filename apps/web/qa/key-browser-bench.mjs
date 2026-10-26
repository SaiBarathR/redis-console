#!/usr/bin/env node
/**
 * Key browser open benchmark (docs/qa/v021-key-browser.md).
 *
 * Opens the key browser of each database in Chromium as the local qa-viewer account (scripts/qa-accounts.mjs),
 * measures the time until the whole namespace tree is loaded, and counts the HTTP requests the page made. For
 * databases on the local sandbox (snapshot = 6412, sandbox-e2e = 6411) it also reads `INFO commandstats`
 * before and after, directly from Redis with the sandbox admin ACL user, and reports the delta of the commands the
 * key browser sends. remote-6390 is only ever read through the app (no direct Redis connection).
 *
 *   set -a; source .env; set +a
 *   node apps/web/qa/key-browser-bench.mjs http://localhost:4600 snapshot remote-6390
 *
 * Works against both builds: v0.2 (`/keys/scan` pages, "Scan to end" drained by clicking it) and v0.2.1
 * (`/keys/names` + `/keys/meta`, the tree is complete when `key-scan-summary` reports `data-done="true"`).
 */
import net from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const [base = "http://localhost:4600", ...dbs] = process.argv.slice(2);
const databases = dbs.length ? dbs : ["snapshot", "remote-6390"];
const PORTS = { "snapshot": 6412, "sandbox-e2e": 6411, "sandbox-main": 6410 };
const accounts = JSON.parse(readFileSync(path.join(ROOT, ".qa/accounts.json"), "utf8"));
const viewer = accounts.local["qa-viewer"];
const WATCH = ["scan", "type", "ttl", "pttl", "memory|usage", "dbsize", "exists", "info"];

/** INFO commandstats over a raw socket (AUTH as the sandbox admin user). Never used for remote-6390. */
function commandstats(port) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    const pass = process.env.SANDBOX_REDIS_ADMIN_PASSWORD ?? "";
    const cmd = (...a) => `*${a.length}\r\n${a.map((x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`).join("")}`;
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("$", buf.indexOf("+OK") >= 0 ? buf.indexOf("+OK") : 0);
      if (i < 0) return;
      const nl = buf.indexOf("\r\n", i);
      const len = Number(buf.slice(i + 1, nl));
      if (Buffer.byteLength(buf.slice(nl + 2)) < len) return;
      s.end();
      const stats = {};
      for (const line of buf.slice(nl + 2).split("\r\n")) {
        const m = /^cmdstat_([^:]+):calls=(\d+)/.exec(line);
        if (m) stats[m[1]] = Number(m[2]);
      }
      resolve(stats);
    });
    s.on("error", reject);
    s.write(cmd("AUTH", "rc-admin", pass) + cmd("INFO", "commandstats"));
  });
}
const delta = (a, b) => Object.fromEntries(WATCH.map((k) => [k, (b[k] ?? 0) - (a[k] ?? 0)]).filter(([, n]) => n));

const browser = await chromium.launch({ headless: true });
const results = [];
for (const db of databases) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/login`);
  await page.getByTestId("login-username").fill(viewer.username);
  await page.getByTestId("login-password").fill(viewer.password);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("database-switcher").or(page.getByTestId("database-landing")).first().waitFor({ timeout: 15_000 });
  // Warm the connection pools (overview) so the measurement is the key browser only.
  await page.goto(`${base}/db/${db}/overview`);
  await page.getByTestId("database-switcher").waitFor();
  await page.waitForTimeout(1500);

  const requests = {};
  const serverMs = {};
  page.on("request", (r) => {
    const m = /\/api\/v1\/databases\/[^/]+\/(keys\/\w+|key\/read)/.exec(r.url());
    if (m) requests[m[1]] = (requests[m[1]] ?? 0) + 1;
  });
  page.on("requestfinished", (r) => {
    const m = /\/api\/v1\/databases\/[^/]+\/(keys\/\w+)/.exec(r.url());
    if (!m) return;
    const t = r.timing();
    (serverMs[m[1]] ??= []).push(Math.round(t.responseEnd - t.requestStart));
  });
  const port = PORTS[db];
  const before = port ? await commandstats(port) : undefined;
  const t0 = performance.now();
  await page.goto(`${base}/db/${db}/keys`);
  const summary = page.getByTestId("key-scan-summary");
  const oldCount = page.locator(".count-line");
  await summary.or(oldCount.filter({ hasText: /keys loaded|matches/ })).first().waitFor({ timeout: 60_000 });
  let firstMs, fullMs, metaMs, line, mode;
  if (await summary.count()) {
    mode = "v0.2.1 names + visible metadata";
    await page.locator('[data-testid="key-scan-summary"][data-done="true"]').waitFor({ timeout: 120_000 });
    fullMs = performance.now() - t0;
    firstMs = fullMs;
    // Metadata for the visible rows: wait until no metadata request is pending for a second.
    await page.waitForFunction(() => !document.querySelector('[data-meta-pending="true"]'), undefined, { timeout: 60_000 });
    metaMs = performance.now() - t0;
    line = (await summary.innerText()).replace(/\s+/g, " ");
  } else {
    mode = "v0.2 pages with metadata";
    firstMs = performance.now() - t0;
    const full = page.getByRole("button", { name: "Scan to end", exact: true });
    if (await full.isEnabled()) {
      await full.click();
      await page.getByTestId("key-load-more").filter({ hasText: "Scan complete" }).waitFor({ timeout: 600_000 });
    }
    fullMs = performance.now() - t0;
    metaMs = fullMs;
    line = (await oldCount.innerText()).replace(/\s+/g, " ");
  }
  await page.waitForTimeout(1500);
  const after = port ? await commandstats(port) : undefined;
  const rows = await page.getByTestId("key-list").locator('[role="treeitem"]').count();
  const open = { requests: { ...requests }, serverMs: JSON.parse(JSON.stringify(serverMs)) };
  // Browse: open the largest folder and scroll five screens; metadata follows the rows on screen only.
  let browse;
  if (await summary.count()) {
    const folders = page.getByTestId("key-folder");
    let best = -1, bestCount = -1;
    for (let i = 0; i < (await folders.count()); i++) {
      const n = Number((await folders.nth(i).locator(".folder-count").innerText()).replace(/\D/g, ""));
      const expanded = (await folders.nth(i).getAttribute("aria-expanded")) === "true";
      if (!expanded && n > bestCount) { best = i; bestCount = n; }
    }
    const b0 = port ? await commandstats(port) : undefined;
    const r0 = requests["keys/meta"] ?? 0;
    if (best >= 0) await folders.nth(best).click();
    const list = page.getByTestId("key-list");
    for (let i = 0; i < 5; i++) {
      await list.evaluate((el) => el.scrollBy(0, el.clientHeight));
      await page.waitForTimeout(300);
    }
    await page.waitForFunction(() => !document.querySelector('[data-meta-pending="true"]'), undefined, { timeout: 60_000 });
    await page.waitForTimeout(1000);
    const b1 = port ? await commandstats(port) : undefined;
    browse = { folderKeys: bestCount, metaRequests: (requests["keys/meta"] ?? 0) - r0, redis: b0 && b1 ? delta(b0, b1) : "not measured" };
  }
  results.push({
    db, mode, firstMs: Math.round(firstMs), fullMs: Math.round(fullMs), metaMs: Math.round(metaMs), line, rows,
    requests: open.requests, serverMs: open.serverMs, redis: before && after ? delta(before, after) : "not measured (read through the app only)",
    ...(browse ? { browse } : {}),
  });
  console.log(JSON.stringify(results.at(-1)));
  await context.close();
}
await browser.close();
