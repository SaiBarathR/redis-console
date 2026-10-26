#!/usr/bin/env node
/**
 * Key browser with a large keyspace (docs/qa/v021-key-browser.md): loads 100,000 small keys under a disposable prefix
 * into sandbox-e2e (127.0.0.1:6411 only), measures the key browser in Chromium, then deletes the keys again.
 *
 *   set -a; source .env; set +a
 *   node apps/web/qa/key-browser-large.mjs http://localhost:4600 [keys=100000]
 *
 * Take the E2E lock first (other E2E runs scan sandbox-e2e). Measures: time to the first "Keys to scan" step, time
 * for "Scan to end", Redis commands (INFO commandstats delta), long tasks while scanning, frame gaps while scrolling
 * a 10,000-key folder, and the time to switch Tree → List (100k flat rows) and to reverse the sort.
 */
import net from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const [base = "http://localhost:4600", total = "100000"] = process.argv.slice(2);
const N = Number(total);
const PORT = 6411;
const RUN = `kbqa:${Date.now().toString(36)}:`;
const account = JSON.parse(readFileSync(path.join(ROOT, ".qa/accounts.json"), "utf8")).local["qa-operator"];

/** A tiny RESP client for the sandbox (AUTH as rc-admin); replies are counted, not parsed beyond what is needed. */
async function redis() {
  const s = net.createConnection({ host: "127.0.0.1", port: PORT });
  await new Promise((r) => s.once("connect", r));
  let buf = Buffer.alloc(0);
  const waiting = [];
  s.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const r = parse(buf, 0);
      if (!r) return;
      buf = buf.subarray(r.end);
      waiting.shift()(r.value);
    }
  });
  const enc = (args) => `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("")}`;
  const send = (args) => new Promise((resolve) => { waiting.push(resolve); s.write(enc(args)); });
  const many = (cmds) => Promise.all(cmds.map((c) => { const p = new Promise((resolve) => waiting.push(resolve)); s.write(enc(c)); return p; }));
  await send(["AUTH", "rc-admin", process.env.SANDBOX_REDIS_ADMIN_PASSWORD ?? ""]);
  return { send, many, close: () => s.end() };
}
function parse(b, i) {
  const nl = b.indexOf("\r\n", i);
  if (nl < 0) return null;
  const t = String.fromCharCode(b[i]), line = b.toString("utf8", i + 1, nl);
  if (t === "+" || t === "-" || t === ":") return { value: t === ":" ? Number(line) : line, end: nl + 2 };
  if (t === "$") {
    const n = Number(line);
    if (n < 0) return { value: null, end: nl + 2 };
    if (b.length < nl + 2 + n + 2) return null;
    return { value: b.toString("utf8", nl + 2, nl + 2 + n), end: nl + 4 + n };
  }
  if (t === "*") {
    const n = Number(line), out = [];
    let at = nl + 2;
    for (let k = 0; k < n; k++) { const r = parse(b, at); if (!r) return null; out.push(r.value); at = r.end; }
    return { value: out, end: at };
  }
  throw new Error(`unexpected RESP ${t}`);
}
const stats = async (r) => {
  const text = await r.send(["INFO", "commandstats"]);
  const out = {};
  for (const line of String(text).split("\r\n")) {
    const m = /^cmdstat_([^:]+):calls=(\d+)/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
};
const WATCH = ["scan", "type", "pttl", "ttl", "memory|usage", "dbsize"];
const delta = (a, b) => Object.fromEntries(WATCH.map((k) => [k, (b[k] ?? 0) - (a[k] ?? 0)]).filter(([, n]) => n));

const r = await redis();
const NAMESPACES = ["blob", "item", "user", "session", "queue", "lock", "rate", "feed", "job", "cfg"];
console.log(`loading ${N} keys under ${RUN}`);
let t = performance.now();
for (let i = 0; i < N; i += 1000) {
  const cmds = [];
  for (let j = i; j < Math.min(N, i + 1000); j++) {
    // 40 % in blob: (≥ 10,000 keys in one folder), the rest spread; a tenth with a TTL.
    const ns = j % 10 < 4 ? "blob" : NAMESPACES[j % 10];
    const key = `${RUN}${ns}:${(j % 97).toString().padStart(2, "0")}:${j}`;
    cmds.push(j % 10 === 3 ? ["SET", key, "v", "EX", "86400"] : ["SET", key, "v"]);
  }
  await r.many(cmds);
}
console.log(`loaded in ${Math.round(performance.now() - t)} ms; DBSIZE ${await r.send(["DBSIZE"])}`);

const browser = await chromium.launch({ headless: true });
const result = { keys: N, prefix: RUN };
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(`${base}/login`);
  await page.getByTestId("login-username").fill(account.username);
  await page.getByTestId("login-password").fill(account.password);
  await page.getByTestId("login-submit").click();
  await page.getByTestId("database-switcher").or(page.getByTestId("database-landing")).first().waitFor();
  await page.goto(`${base}/db/sandbox-e2e/overview`);
  await page.getByTestId("database-switcher").waitFor();
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(e.duration); }).observe({ type: "longtask", buffered: true });
  });
  const requests = {};
  page.on("request", (q) => { const m = /\/(keys\/\w+)$/.exec(q.url()); if (m) requests[m[1]] = (requests[m[1]] ?? 0) + 1; });

  let s0 = await stats(r);
  t = performance.now();
  await page.goto(`${base}/db/sandbox-e2e/keys`);
  const summary = page.getByTestId("key-scan-summary");
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="key-scan-summary"]');
    return el && Number(el.getAttribute("data-scanned")) >= 10000;
  }, undefined, { timeout: 60_000 });
  await page.getByTestId("key-load-more").filter({ hasText: "Scan more" }).waitFor();
  result.openMs = Math.round(performance.now() - t);
  result.openLine = (await summary.innerText()).replace(/\s+/g, " ");
  await page.waitForFunction(() => !document.querySelector('[data-meta-pending="true"]'));
  result.openRedis = delta(s0, await stats(r));
  result.openRequests = { ...requests };

  await page.evaluate(() => { window.__long = []; new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(e.duration); }).observe({ type: "longtask" }); });
  s0 = await stats(r);
  t = performance.now();
  await page.getByTestId("key-scan-all").click();
  await page.locator('[data-testid="key-scan-summary"][data-done="true"]').waitFor({ timeout: 300_000 });
  result.scanToEndMs = Math.round(performance.now() - t);
  result.fullLine = (await summary.innerText()).replace(/\s+/g, " ");
  await page.waitForFunction(() => !document.querySelector('[data-meta-pending="true"]'));
  result.scanToEndRedis = delta(s0, await stats(r));
  result.scanToEndRequests = Object.fromEntries(Object.entries(requests).map(([k, v]) => [k, v - (result.openRequests[k] ?? 0)]));
  const long = await page.evaluate(() => window.__long);
  result.scanLongTasks = { count: long.length, maxMs: Math.round(Math.max(0, ...long)) };

  // Open our prefix, then the blob folder (40,000 keys) and scroll through it.
  const folder = (label) => page.getByTestId("key-folder").filter({ has: page.locator(".folder-name", { hasText: new RegExp(`^${label}:$`) }) }).first();
  const open = async (label) => {
    const row = folder(label);
    if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
  };
  for (const part of RUN.split(":").filter(Boolean)) await open(part);
  t = performance.now();
  await open("blob");
  await folder("00").waitFor();
  result.expandBlobMs = Math.round(performance.now() - t);
  const blobCount = await folder("blob").locator(".folder-count").innerText();
  await open("00");
  const frames = await page.getByTestId("key-list").evaluate(async (el) => {
    const gaps = [];
    let last = performance.now();
    let run = true;
    const tick = () => { const now = performance.now(); gaps.push(now - last); last = now; if (run) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    for (let i = 0; i < 40; i++) { el.scrollBy(0, el.clientHeight); await new Promise((r) => setTimeout(r, 50)); }
    run = false;
    gaps.sort((a, b) => a - b);
    return { frames: gaps.length, p95: gaps[Math.floor(gaps.length * 0.95)], max: gaps.at(-1) };
  });
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/large-scroll.png` });
  result.scroll = { folderKeys: blobCount, ...Object.fromEntries(Object.entries(frames).map(([k, v]) => [k, Math.round(v)])) };
  await page.waitForFunction(() => !document.querySelector('[data-meta-pending="true"]'));

  t = performance.now();
  await page.getByTestId("key-view-list").click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="key-folder"]').length === 0);
  result.treeToListMs = Math.round(performance.now() - t);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/large-list.png` });
  // Scroll the flat list of all 100k rows: 40 screens, measuring frame gaps.
  result.listScroll = await page.getByTestId("key-list").evaluate(async (el) => {
    const gaps = [];
    let last = performance.now();
    let run = true;
    const tick = () => { const now = performance.now(); gaps.push(now - last); last = now; if (run) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    for (let i = 0; i < 40; i++) { el.scrollBy(0, el.clientHeight * 25); await new Promise((r) => setTimeout(r, 50)); }
    run = false;
    gaps.sort((a, b) => a - b);
    return { rows: Math.round(el.scrollHeight / 26), frames: gaps.length, p95: Math.round(gaps[Math.floor(gaps.length * 0.95)]), max: Math.round(gaps.at(-1)) };
  });
  await page.waitForFunction(() => !document.querySelector('[data-meta-pending="true"]'), undefined, { timeout: 60_000 });
  t = performance.now();
  await page.getByTestId("key-sort-name").click();
  await page.waitForTimeout(0);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  result.reverseSortMs = Math.round(performance.now() - t);
  t = performance.now();
  await page.getByTestId("key-view-tree").click();
  try {
    await page.getByTestId("key-folder").first().waitFor({ timeout: 10_000 });
  } finally {
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/large-tree.png` });
  }
  result.listToTreeMs = Math.round(performance.now() - t);
  result.heapMB = Math.round((await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0)) / 1048576);
} finally {
  await browser.close();
  // Clean up: delete every key under the prefix.
  t = performance.now();
  let cursor = "0", deleted = 0;
  do {
    const [next, keys] = await r.send(["SCAN", cursor, "MATCH", `${RUN}*`, "COUNT", "2000"]);
    cursor = next;
    if (keys.length) deleted += await r.send(["UNLINK", ...keys]);
  } while (cursor !== "0");
  result.cleanup = { deleted, ms: Math.round(performance.now() - t) };
  r.close();
  console.log(JSON.stringify(result, null, 2));
}
