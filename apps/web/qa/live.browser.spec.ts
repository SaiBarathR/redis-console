import { test, expect, type Page } from "@playwright/test";
import { createHash, createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
const hostile = "<img src=x onerror=alert(1)>";
const runTag = Date.now().toString(36);
const prefix = `webqa:20261023:${runTag}:`;
const indexName = `webqa_idx_${runTag}`;
const username = `webqa-${runTag}`;
const db = "sandbox-e2e";
function monitor(page: Page) {
  const violations: string[] = [];
  const errors: string[] = [];
  const remoteWrites: string[] = [];
  const urlLeaks: string[] = [];
  const readPost = (method: string, path: string) =>
    method === "POST" &&
    /^\/api\/v1\/databases\/[^/]+\/(?:keys\/scan|key\/read|streams\/groups|streams\/pending|timeseries\/range|pubsub\/channels|pubsub\/subscriptions)$/.test(
      path,
    );
  page.on("console", (message) => {
    if (
      /Content Security Policy|TrustedHTML|TrustedScript|Refused to|violates.*directive/i.test(
        message.text(),
      )
    )
      violations.push(
        `${message.text()} ${JSON.stringify(message.location())}`,
      );
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    for (const key of url.searchParams.keys())
      if (
        [
          "k",
          "key",
          "keys",
          "match",
          "pattern",
          "patterns",
          "channel",
          "channels",
          "group",
          "query",
          "q",
        ].includes(key)
      )
        urlLeaks.push(`${url.pathname}: ${key}`);
    if (
      request.url().includes("/databases/remote-6390/") &&
      request.method() !== "GET" &&
      !readPost(request.method(), url.pathname)
    )
      remoteWrites.push(request.method());
  });
  void page.route("**/api/v1/databases/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (
      req.method() !== "GET" &&
      !path.startsWith("/api/v1/databases/sandbox-e2e/") &&
      !readPost(req.method(), path)
    ) {
      remoteWrites.push(`Blocked ${req.method()} ${path}`);
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  return { violations, errors, remoteWrites, urlLeaks };
}
async function sso(page: Page, username: string) {
  await page.goto("/");
  await page.getByTestId("login-sso").click();
  await expect(page.locator("#username")).toBeVisible();
  {
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(process.env.KC_USER_PASSWORD!);
    await page.locator("#kc-login").click();
  }
  await expect(page.getByTestId("database-switcher")).toBeVisible({
    timeout: 20000,
  });
  if (
    process.env.WEB_QA_ORIGIN &&
    new URL(page.url()).origin !== process.env.WEB_QA_ORIGIN
  ) {
    await page.goto(process.env.WEB_QA_ORIGIN);
    await expect(page.getByTestId("database-switcher")).toBeVisible();
  }
  await expect(page.getByTestId("database-landing")).toBeVisible();
  await page.getByTestId("database-switcher").selectOption(db);
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
}
async function cli(page: Page, line: string) {
  await page.getByTestId("nav-console").click();
  await page.getByTestId("console-editor-input").fill(line);
  await expect(page.getByTestId("console-run")).toBeEnabled();
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/cli") && response.request().method() === "POST",
  );
  await page.getByTestId("console-run").click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  expect(payload.reply.t).not.toBe("err");
  await expect(
    page.getByTestId("console-results").locator(".result").first(),
  ).toBeVisible();
  return payload;
}
function totp(secret: string, timeOffset = 0) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, ""))
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(
    bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + timeOffset));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest.at(-1)! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
test("live local bootstrap password change, enrollment and secure workspace", async ({
  page,
}) => {
  const state = monitor(page);
  await page.goto("/");
  await page.getByTestId("login-username").fill("admin");
  await page
    .getByTestId("login-password")
    .fill(process.env.BOOTSTRAP_ADMIN_PASSWORD!);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("password-change-submit")).toBeVisible();
  await page
    .getByTestId("current-password")
    .fill(process.env.BOOTSTRAP_ADMIN_PASSWORD!);
  await page.getByTestId("new-password").fill(
    createHash("sha256")
      .update(process.env.BOOTSTRAP_ADMIN_PASSWORD! + "web-qualification")
      .digest("hex"),
  );
  await page.getByTestId("password-change-submit").click();
  await expect(page.getByTestId("totp-enroll")).toBeVisible();
  await page.getByTestId("totp-enroll").click();
  await expect(page.getByTestId("totp-qr")).toBeVisible();
  const secret = await page.locator(".secret").textContent();
  await page.getByTestId("totp-enroll-code").fill(totp(secret!));
  await page.getByTestId("totp-enroll-confirm").click();
  await expect(page.getByTestId("database-switcher")).toBeVisible();
  await page.getByTestId("logout").click();
  await page.getByTestId("login-username").fill("admin");
  await page.getByTestId("login-password").fill(
    createHash("sha256")
      .update(process.env.BOOTSTRAP_ADMIN_PASSWORD! + "web-qualification")
      .digest("hex"),
  );
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("totp-code")).toBeVisible();
  await page.getByTestId("totp-code").fill(totp(secret!, 1));
  await page.getByTestId("totp-submit").click();
  await expect(page.getByTestId("database-switcher")).toBeVisible();
  expect(state.errors).toEqual([]);
  expect(state.violations).toEqual([]);
  expect(state.remoteWrites).toEqual([]);
  expect(state.urlLeaks).toEqual([]);
});
test("live operator: key types, hostile values, guided tasks, console and workbench", async ({
  page,
}) => {
  const state = monitor(page);
  await sso(page, "operator1");
  await expect(page.getByTestId("nav-audit")).toHaveCount(0);
  for (const [type, value] of [
    ["string", hostile + "\u202e\u200b"],
    ["hash", "hash-value"],
    ["list", "list-value"],
    ["set", "member-value"],
    ["zset", "sorted-value"],
    ["stream", "event-value"],
    ["json", '{"hello":"world"}'],
    ["timeseries", "12.5"],
    ["bloom", "bloom-member"],
    ["cuckoo", "cuckoo-member"],
    ["vectorset", "0.1, 0.2, 0.3"],
  ]) {
    await page.getByTestId("nav-keys").click();
    await page.getByTestId("key-add").click();
    await page.getByTestId("key-create-type").selectOption(type!);
    await page.getByTestId("key-create-name").fill(prefix + type);
    if (type === "hash" || type === "stream" || type === "vectorset")
      await page.getByTestId("key-edit-field").fill("field");
    await page.getByTestId("key-edit-value").fill(value!);
    await page.getByTestId("key-save").click();
    if (type === "vectorset") {
      // The sandbox operator ACL excludes this command; exercise its denial without weakening ACLs.
      await expect(
        page.getByTestId("key-editor-dialog").getByRole("alert"),
      ).toContainText("no permissions");
      await page.getByRole("button", { name: "Close dialog" }).click();
      continue;
    }
    await expect(page.getByTestId("key-editor-dialog")).toHaveCount(0);
    await page.getByTestId("key-pattern").fill(prefix + type);
    await page.getByTestId("key-scan").click();
    await page
      .getByTestId("key-row")
      .filter({ hasText: prefix + type })
      .click();
    await expect(page.getByTestId("key-detail")).toContainText(
      type === "json"
        ? "ReJSON"
        : type === "timeseries"
          ? "TSDB"
          : type === "bloom"
            ? "MBbloom--"
            : type === "cuckoo"
              ? "MBbloomCF"
              : type!,
    );
    if (type === "json") {
      await page.getByTestId("key-edit").click();
      await page
        .getByRole("combobox", { name: "Pick a JSON path", exact: true })
        .selectOption('$["hello"]');
      await page.getByTestId("key-edit-value").fill('"updated path"');
      await page.getByTestId("key-save").click();
      await expect(page.getByTestId("key-editor-dialog")).toHaveCount(0);
      await expect(page.getByTestId("key-value")).toContainText("updated path");
    }
    if (type === "string") {
      await expect(page.getByTestId("key-value")).toContainText(hostile);
      await expect(page.getByTestId("key-value")).toContainText(
        "\\u202e\\u200b",
      );
      await expect(page.locator("img")).toHaveCount(0);
      await page.getByTestId("value-format").selectOption("hex");
      await expect(page.getByTestId("key-value")).toContainText("3c 69 6d 67");
      await page.getByTestId("value-format").selectOption("base64");
      await expect(page.getByTestId("key-value")).not.toContainText(hostile);
    }
  }
  await page.getByTestId("nav-keys").click();
  await page.getByTestId("key-add").click();
  await page.getByTestId("key-create-name").fill(prefix + "import");
  await page
    .getByRole("button", { name: "Create key", exact: true })
    .isEnabled();
  await page
    .getByLabel("Import value from file", { exact: true })
    .setInputFiles({
      name: "value.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.from([255, 0, 60, 62]),
    });
  await expect(page.getByTestId("key-edit-encoding")).toHaveValue("base64");
  await page.getByTestId("key-save").click();
  await expect(page.getByTestId("key-editor-dialog")).toHaveCount(0);
  // Exercise arbitrary key/value bytes, full-value loading and local decompression.
  const binaryKey = Buffer.concat([
    Buffer.from(prefix + "binary:"),
    Buffer.from([255, 0]),
  ]).toString("base64");
  for (const [name, value, encoding, keyEncoding] of [
    [binaryKey, "/wA8Pg==", "base64", "base64"],
    [prefix + "long", "x".repeat(90000), "utf8", "utf8"],
    [
      prefix + "gzip",
      gzipSync(Buffer.from(hostile)).toString("base64"),
      "base64",
      "utf8",
    ],
  ]) {
    await page.getByTestId("nav-keys").click();
    await page.getByTestId("key-add").click();
    await page.getByTestId("key-create-name").fill(name!);
    await page.getByTestId("key-create-encoding").selectOption(keyEncoding!);
    await page.getByTestId("key-edit-encoding").selectOption(encoding!);
    await page.getByTestId("key-edit-value").fill(value!);
    await page.getByTestId("key-save").click();
    await expect(page.getByTestId("key-editor-dialog")).toHaveCount(0);
    await page
      .getByTestId("key-pattern")
      .fill(keyEncoding === "base64" ? prefix + "binary:*" : name!);
    await page.getByTestId("key-scan").click();
    await page.getByTestId("key-row").first().click();
    if (keyEncoding === "base64") {
      await expect(page.getByTestId("key-detail")).toContainText("\\xff\\x00");
      await page.getByTestId("value-format").selectOption("hex");
      await expect(page.getByTestId("key-value")).toContainText("ff 00 3c 3e");
    }
    if (name === prefix + "long") {
      await expect(page.getByTestId("key-edit")).toHaveCount(0);
      await page.getByTestId("key-load-full").click();
      await expect(page.getByTestId("key-edit")).toBeVisible();
    }
    if (name === prefix + "gzip") {
      await page.getByTestId("value-inflate").click();
      await expect(page.getByTestId("key-value")).toContainText(hostile);
      await expect(page.locator("img")).toHaveCount(0);
    }
  }
  await page.getByTestId("nav-keys").click();
  await cli(
    page,
    `RPUSH ${prefix}paged-list ${Array.from({ length: 101 }, (_, i) => "value-" + i).join(" ")}`,
  );
  await page.getByTestId("nav-workbench").click();
  await page
    .getByTestId("workbench-editor-input")
    .fill(
      Array.from(
        { length: 100 },
        (_, i) => `XADD ${prefix}stream * field page-${i}`,
      ).join("\n"),
    );
  const scriptResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/workbench") &&
      response.request().method() === "POST",
  );
  await page.getByTestId("workbench-run").click();
  expect((await scriptResponse).ok()).toBe(true);
  for (const name of ["paged-list", "stream"]) {
    await page.getByTestId("nav-keys").click();
    await page.getByTestId("key-pattern").fill(prefix + name);
    await page.getByTestId("key-scan").click();
    await page.getByTestId("key-row").first().click();
    await expect(
      page.getByTestId("key-detail").locator("tbody tr"),
    ).toHaveCount(100);
    await page.getByTestId("key-next-page").click();
    await expect(
      page.getByTestId("key-detail").locator("tbody tr"),
    ).toHaveCount(1);
  }
  await page.getByTestId("nav-console").click();
  await page.getByTestId("nav-keys").click();
  await page.getByTestId("key-pattern").fill(prefix + "string");
  await page.getByTestId("key-scan").click();
  await page.getByTestId("key-row").first().click();
  await page.getByTestId("key-ttl").click();
  await page.getByTestId("key-ttl-input").fill("3600");
  await page.getByTestId("key-ttl-submit").click();
  await expect(page.getByTestId("key-ttl-dialog")).toHaveCount(0);
  await page.getByTestId("key-edit").click();
  await page.getByTestId("key-edit-value").fill("edited");
  await page.getByTestId("key-save").click();
  await expect(page.getByTestId("key-editor-dialog")).toHaveCount(0);
  await expect(page.getByTestId("key-value")).toContainText("edited");
  await page.getByTestId("key-rename").click();
  await page.getByTestId("key-rename-input").fill(prefix + "renamed");
  await page.getByTestId("key-rename-submit").click();
  await expect(page.getByTestId("key-rename-dialog")).toHaveCount(0);
  await cli(page, `GET "${prefix}renamed"`);
  await expect(page.getByTestId("console-results")).toContainText("edited");
  await page.getByTestId("console-editor-input").press("ArrowUp");
  await expect(page.getByTestId("console-editor-input")).toContainText("GET");
  await page.getByTestId("console-editor-input").fill("KEYS *");
  await expect(page.getByTestId("console-run")).toBeDisabled();
  await page.getByTestId("nav-workbench").click();
  await page.getByTestId("workbench-editor-input").fill("PING\nDBSIZE");
  await page.getByTestId("workbench-run").click();
  await expect(page.getByTestId("console-results")).toContainText("PONG");
  await page.getByTestId("nav-guided").click();
  for (const task of [
    "edit",
    "ttl",
    "stream",
    "publish",
    "counter",
    "set",
    "zset",
    "find",
    "inspect",
  ]) {
    await page.getByTestId(`guided-${task}`).click();
    await page
      .getByTestId("guided-key")
      .fill(
        task === "find"
          ? prefix + "*"
          : task === "inspect" || task === "ttl"
            ? prefix + "guided-edit"
            : prefix + "guided-" + task,
      );
    if (await page.getByTestId("guided-value").count())
      await page
        .getByTestId("guided-value")
        .fill(task === "counter" ? "1" : "guided-value");
    if (await page.getByTestId("guided-field").count())
      await page.getByTestId("guided-field").fill("field");
    await page.getByTestId("guided-run").click();
    await expect(page.getByText("Done", { exact: true })).toBeVisible();
  }
  await page.getByTestId("nav-keys").click();
  await page.getByTestId("bulk-delete").click();
  await page.getByTestId("bulk-delete-pattern").fill(prefix + "*");
  await page.getByTestId("bulk-delete-preview").click();
  await page.getByTestId("bulk-delete-review").click();
  await expect(page.getByTestId("confirmation-dialog")).toBeVisible();
  await page.getByTestId("confirmation-typed").fill("E2E scratch");
  await page.getByTestId("confirmation-submit").click();
  await expect(page.getByTestId("confirmation-dialog")).toHaveCount(0);
  expect(state.errors).toEqual([]);
  expect(state.violations).toEqual([]);
  expect(state.remoteWrites).toEqual([]);
  expect(state.urlLeaks).toEqual([]);
});
test("live viewer: real read-only remote browsing and disabled writes", async ({
  page,
}) => {
  const state = monitor(page);
  await sso(page, "viewer1");
  await page.getByTestId("nav-keys").click();
  await expect(page.getByTestId("key-add")).toHaveCount(0);
  await page.getByTestId("database-switcher").selectOption("sandbox-main");
  await page.getByTestId("nav-keys").click();
  await expect(page.getByTestId("key-load-more")).toBeVisible();
  await expect(page.getByTestId("key-row").first()).toBeVisible();
  await page.getByTestId("key-row").first().click();
  await expect(page.getByTestId("key-detail")).toBeVisible();
  await page.getByTestId("database-switcher").selectOption("remote-6390");
  await expect(
    page.getByText("Production database · All writes are disabled"),
  ).toBeVisible();
  await page.getByTestId("nav-keys").click();
  await expect(page.getByTestId("key-row").first()).toBeVisible();
  await page.getByTestId("key-row").first().click();
  await expect(page.getByTestId("key-delete")).toHaveCount(0);
  await page.getByTestId("nav-console").click();
  await page
    .getByTestId("console-editor-input")
    .fill("SET never-run never-run");
  await expect(page.getByTestId("console-run")).toBeDisabled();
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("login-sso")).toBeVisible();
  expect(state.errors).toEqual([]);
  expect(state.violations).toEqual([]);
  expect(state.remoteWrites).toEqual([]);
  expect(state.urlLeaks).toEqual([]);
});
test("live admin: diagnostics, subscriptions, streams, profiler, audit and users", async ({
  page,
}) => {
  const state = monitor(page);
  await sso(page, "admin1");
  await cli(page, `SET ${prefix}admin-seed seeded`);
  await cli(page, `VADD ${prefix}admin-vector VALUES 3 0.1 0.2 0.3 member`);
  await cli(page, `XADD ${prefix}admin-stream * field initial`);
  await cli(page, `TS.ADD ${prefix}admin-ts * 12.5`);
  await page.getByTestId("nav-diagnostics").click();
  await page.getByTestId("diagnostics-slowlog").click();
  await page.getByTestId("slowlog-reset").click();
  await expect(page.getByTestId("confirmation-dialog")).toBeVisible();
  await page.getByTestId("confirmation-submit").click();
  await expect(page.getByTestId("confirmation-dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "All diagnostics" }).click();
  await page.getByTestId("diagnostics-analysis").click();
  await page.getByTestId("analysis-pattern").fill(prefix + "*");
  await page.getByTestId("analysis-run").click();
  await expect(page.getByTestId("analysis-report")).toBeVisible();
  await page.getByRole("link", { name: "All diagnostics" }).click();
  await page.getByTestId("diagnostics-pubsub").click();
  await page.getByTestId("pubsub-channel").fill(prefix + "channel");
  await page.getByTestId("pubsub-subscribe").click();
  await expect(page.getByText("live", { exact: true })).toBeVisible();
  await page.getByTestId("publish-channel").fill(prefix + "channel");
  await page.getByTestId("publish-message").fill("webqa-message");
  await page.getByTestId("pubsub-publish").click();
  await expect(
    page
      .locator(".panel")
      .filter({ has: page.getByRole("heading", { name: /^Messages/ }) })
      .locator("table"),
  ).toContainText("webqa-message");
  await page.getByTestId("pubsub-stop").click();
  await page.getByRole("link", { name: "All diagnostics" }).click();
  await page.getByTestId("diagnostics-streams").click();
  await page.getByTestId("stream-key").fill(prefix + "admin-stream");
  await page.getByTestId("stream-inspect").click();
  await page.getByTestId("stream-group-name").fill("webqa-workers");
  await page.getByTestId("stream-group-create").click();
  await expect(
    page.getByRole("button", { name: "webqa-workers" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "webqa-workers" }).click();
  await expect(
    page.getByRole("heading", { name: "Pending entries" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "All diagnostics" }).click();
  await cli(page, `XADD ${prefix}admin-stream * field pending`);
  await cli(
    page,
    `XREADGROUP GROUP webqa-workers webqa-consumer COUNT 1 STREAMS ${prefix}admin-stream >`,
  );
  await page.getByTestId("nav-diagnostics").click();
  await page.getByTestId("diagnostics-streams").click();
  await page.getByTestId("stream-key").fill(prefix + "admin-stream");
  await page.getByTestId("stream-inspect").click();
  await page.getByRole("button", { name: "webqa-workers" }).click();
  const pendingPanel = page.locator(".panel").filter({
    has: page.getByRole("heading", { name: "Pending entries", exact: true }),
  });
  await expect(pendingPanel.locator("tbody tr")).toHaveCount(1);
  const pendingId = (await pendingPanel
    .locator("tbody tr td")
    .first()
    .textContent())!.trim();
  await page.getByTestId("stream-ack-ids").fill(pendingId);
  await page.getByTestId("stream-ack").click();
  await expect(pendingPanel.getByText("No results to display.")).toBeVisible();
  await page.getByRole("link", { name: "All diagnostics" }).click();
  await page.getByTestId("diagnostics-timeseries").click();
  await page.getByTestId("timeseries-key").fill(prefix + "admin-ts");
  await page.getByTestId("timeseries-run").click();
  await expect(page.getByRole("heading", { name: "1 samples" })).toBeVisible();
  await cli(
    page,
    `FT.CREATE ${indexName} ON HASH PREFIX 1 ${prefix}search: SCHEMA name TEXT`,
  );
  await cli(page, `HSET ${prefix}search:1 name Example`);
  await page.getByTestId("nav-diagnostics").click();
  await page.getByTestId("diagnostics-search").click();
  await page.getByTestId("search-index").selectOption(indexName);
  await page.getByTestId("search-query").fill("*");
  await page.getByTestId("search-run").click();
  await expect(page.getByRole("heading", { name: "1 results" })).toBeVisible();
  for (const label of ["Explain query", "Profile query"]) {
    const response = page.waitForResponse(
      (reply) =>
        reply.url().endsWith("/cli") && reply.request().method() === "POST",
    );
    await page.getByRole("button", { name: label, exact: true }).click();
    const reply = await response;
    expect(reply.ok()).toBe(true);
    expect((await reply.json()).reply.t).not.toBe("err");
  }
  await page.getByRole("link", { name: "All diagnostics" }).click();
  await page.getByTestId("diagnostics-profiler").click();
  await page
    .getByRole("checkbox", {
      name: "Hide Redis Console connections (known client addresses)",
    })
    .uncheck();
  await page.getByTestId("profiler-seconds").fill("5");
  await page.getByTestId("profiler-start").click();
  await expect(page.getByText("live", { exact: true })).toBeVisible();
  const session = await (await page.request.get("/api/v1/auth/me")).json();
  await page.request.post(`/api/v1/databases/${db}/cli`, {
    headers: {
      Origin: "http://localhost:4300",
      "X-CSRF-Token": session.csrfToken,
    },
    data: { line: "PING" },
  });
  await expect(page.locator("table")).toContainText("PING");
  await page.getByTestId("profiler-stop").click();
  await expect(page.locator("table")).toContainText("PING");
  await page.getByTestId("profiler-seconds").fill("1");
  await page.getByTestId("profiler-start").click();
  await expect(page.getByTestId("profiler-start")).toBeEnabled({
    timeout: 4000,
  });
  const clientReply = await cli(page, "CLIENT ID");
  const clientId = String(clientReply.reply.v);
  await page.getByTestId("nav-diagnostics").click();
  await page.getByTestId("diagnostics-clients").click();
  const ownClient = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: clientId, exact: true }) });
  await expect(ownClient.getByTestId("client-kill")).toBeDisabled();
  await expect(ownClient).toContainText("Kill blocked");
  await page.getByTestId("nav-audit").click();
  await page.getByTestId("audit-action-filter").fill("cli.exec");
  await page.getByTestId("audit-filter").click();
  await expect(page.locator("table")).toContainText("cli.exec");
  await page.getByTestId("nav-users").click();
  await page.getByTestId("user-add").click();
  await page.getByTestId("user-username").fill(username);
  await page.getByTestId("user-display-name").fill("Web QA User");
  await page.getByTestId("user-role").selectOption("viewer");
  await page.getByTestId("user-password").fill(
    createHash("sha256")
      .update(process.env.BOOTSTRAP_ADMIN_PASSWORD! + "webqa-user-password")
      .digest("hex"),
  );
  await page.getByTestId("user-save").click();
  await expect(page.getByTestId("user-editor-dialog")).toHaveCount(0);
  await page
    .getByRole("row")
    .filter({ hasText: username })
    .getByTestId("user-edit")
    .click();
  await page.getByTestId("user-disabled").check();
  await page.getByTestId("user-save").click();
  await expect(page.getByTestId("user-editor-dialog")).toHaveCount(0);
  await expect(
    page.getByRole("row").filter({ hasText: username }),
  ).toContainText("Disabled");
  await page.getByTestId("nav-console").click();
  await page
    .getByTestId("console-editor-input")
    .fill(`FT.DROPINDEX ${indexName}`);
  await page.getByTestId("console-run").click();
  await page.getByTestId("confirmation-submit").click();
  await expect(page.getByTestId("confirmation-dialog")).toHaveCount(0);
  await page.getByTestId("nav-keys").click();
  await page.getByTestId("bulk-delete").click();
  await page.getByTestId("bulk-delete-pattern").fill(prefix + "*");
  await page.getByTestId("bulk-delete-preview").click();
  await page.getByTestId("bulk-delete-review").click();
  await page.getByTestId("confirmation-typed").fill("E2E scratch");
  await page.getByTestId("confirmation-submit").click();
  await expect(page.getByTestId("confirmation-dialog")).toHaveCount(0);
  expect(state.errors).toEqual([]);
  expect(state.violations).toEqual([]);
  expect(state.remoteWrites).toEqual([]);
  expect(state.urlLeaks).toEqual([]);
});

test("live review regressions: full JSON, memory, inline edits and bulk intent", async ({
  page,
}) => {
  const state = monitor(page);
  const telemetry: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("/metrics/stream")) telemetry.push(req.url());
  });
  await sso(page, "admin1");
  expect(telemetry.every((url) => url.includes("/sandbox-e2e/"))).toBe(true);
  expect(await page.locator('meta[name="csp-nonce"]').count()).toBe(1);
  const p = prefix + "review:";
  const csrf = (await (await page.request.get("/api/v1/auth/me")).json())
    .csrfToken;
  const seed = await page.request.post(`/api/v1/databases/${db}/ops`, {
    headers: { Origin: "http://localhost:4300", "X-CSRF-Token": csrf },
    data: {
      op: "string.set",
      key: { enc: "utf8", data: p + "json" },
      value: {
        enc: "utf8",
        data: JSON.stringify({
          large: "x".repeat(120000),
          tail: "complete JSON tree",
        }),
      },
    },
  });
  expect(seed.ok()).toBe(true);
  await cli(page, `HSET ${p}hash f original`);
  await cli(page, `RPUSH ${p}list original`);
  await cli(page, `ZADD ${p}zset 1 member`);
  await cli(page, "PING");
  await page.getByTestId("nav-keys").click();
  await page.getByTestId("nav-console").click();
  await expect(page.getByTestId("console-results")).toContainText('"PONG"');
  await page.getByTestId("console-editor-input").press("ArrowUp");
  await expect(page.getByTestId("console-editor-input")).toContainText("PING");
  await page.getByTestId("nav-workbench").click();
  await page.getByTestId("workbench-editor-input").fill("PING\nDBSIZE");
  await page.getByTestId("workbench-run").click();
  await expect(page.getByTestId("console-results")).toContainText("(integer)");
  await page.getByTestId("nav-keys").click();
  await page.getByTestId("nav-workbench").click();
  await expect(page.getByTestId("console-results")).toContainText("PONG");
  await expect(page.getByTestId("workbench-editor-input")).toContainText(
    "DBSIZE",
  );
  async function inspect(name: string) {
    await page.getByTestId("nav-keys").click();
    await page.getByTestId("key-pattern").fill(p + name);
    await page.getByTestId("key-scan").click();
    await page
      .getByTestId("key-row")
      .filter({ hasText: p + name })
      .click();
  }
  await inspect("json");
  await expect(page.getByRole("option", { name: "JSON tree" })).toBeDisabled();
  await page.getByTestId("key-load-full").click();
  await page.getByTestId("value-format").selectOption("tree");
  await expect(
    page.getByText("complete JSON tree", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "qa-results/live-review-json.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Open in console", exact: true })
    .click();
  await expect(page.getByTestId("console-editor-input")).toContainText(
    `GET "${p}json"`,
  );
  await page.getByTestId("console-editor-input").fill("GET ");
  await page.getByTestId("console-editor-input").press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText(
    p + "json",
  );
  await page.keyboard.press("Escape");
  await inspect("hash");
  await page
    .getByRole("button", { name: "Edit hash field f", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Edit hash field f", exact: true })
    .fill("edited hash");
  await page
    .getByTestId("key-detail")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByTestId("key-detail")).toContainText("edited hash");
  await page.getByText("Field TTL (Redis 7.4+)", { exact: true }).click();
  await page
    .getByRole("button", { name: "Read field TTL", exact: true })
    .click();
  await expect(page.getByTestId("key-detail")).toContainText("(integer) -1");
  await page
    .getByRole("button", { name: "Set field TTL", exact: true })
    .click();
  await expect(page.getByTestId("key-detail")).toContainText("(integer) 1");
  await inspect("list");
  await page
    .getByRole("button", { name: "Edit list index 0", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Edit list index 0", exact: true })
    .fill("edited list");
  await page
    .getByTestId("key-detail")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByTestId("key-detail")).toContainText("edited list");
  await inspect("zset");
  await page
    .getByRole("button", { name: "Edit score for member", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Edit score for member", exact: true })
    .fill("42");
  await page
    .getByTestId("key-detail")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(page.getByTestId("key-detail").locator("tbody")).toContainText(
    "42",
  );
  await page.getByTestId("key-delete").click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByTestId("confirmation-dialog")).toContainText(
    p + "zset",
  );
  // Review M1: the server-built preview names the exact command, the database and the effective role.
  await expect(page.getByTestId("confirmation-command").first()).toContainText(
    `UNLINK ${p}zset`,
  );
  await expect(page.getByTestId("confirmation-total")).toHaveText("1 command");
  await expect(page.getByTestId("confirmation-target")).toContainText(
    "E2E scratch",
  );
  await expect(page.getByTestId("confirmation-target")).toContainText(
    "admin",
  );
  await page.screenshot({ path: "qa-results/live-confirm-preview.png" });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByTestId("key-detail")
    .getByRole("button", { name: "Remove entry", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByTestId("confirmation-dialog")).toContainText("member");
  await page.getByTestId("confirmation-submit").click();
  await expect(page.getByTestId("confirmation-dialog")).toHaveCount(0);
  await page.getByTestId("nav-guided").click();
  await page.getByTestId("guided-inspect").click();
  await page.getByTestId("guided-key").fill(p + "hash");
  await page.getByTestId("guided-run").click();
  await expect(page.getByTestId("guided-command")).toContainText(
    `HSCAN "${p}hash" 0 COUNT 100`,
  );
  await expect(page.locator(".guided-result")).toContainText("edited hash");
  await page.getByTestId("nav-keys").click();
  await page.getByTestId("bulk-delete").click();
  await expect(page.getByTestId("bulk-delete-pattern")).toHaveValue("");
  await page.getByTestId("bulk-delete-pattern").fill("*");
  await expect(page.getByTestId("bulk-delete-preview")).toBeDisabled();
  await page.getByTestId("bulk-delete-pattern").fill(p + "*");
  const bulkPosts: string[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/bulk-delete")) bulkPosts.push(req.method());
  });
  await page.getByTestId("bulk-delete-preview").click();
  await expect(page.getByTestId("bulk-delete-review")).toBeVisible();
  expect(bulkPosts).toEqual([]);
  await expect(page.getByTestId("confirmation-dialog")).toHaveCount(0);
  await page.getByTestId("bulk-delete-review").click();
  await expect(page.getByTestId("confirmation-bulk")).toContainText(p + "*");
  await expect(page.getByTestId("confirmation-impact")).toContainText(
    /\d+ keys? affected/,
  );
  await expect(page.getByTestId("confirmation-command").first()).toContainText(
    `SCAN 0 MATCH ${p}*`,
  );
  await page.getByTestId("confirmation-typed").fill("E2E scratch");
  await page.getByTestId("confirmation-submit").click();
  await expect(page.getByText(/Deleted \d+ of \d+ scanned\./)).toBeVisible();
  await page.screenshot({
    path: "qa-results/live-review-bulk.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByTestId("logout").click();
  await expect(page.getByTestId("login-sso")).toBeVisible();
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual([
    "rconsole.database",
    "rconsole.theme",
  ]);
  expect(await page.evaluate(() => Object.keys(sessionStorage))).toEqual([]);
  expect(await page.evaluate(() => indexedDB.databases())).toEqual([]);
  expect(await page.evaluate(() => caches.keys())).toEqual([]);
  expect(state.errors).toEqual([]);
  expect(state.violations).toEqual([]);
  expect(state.remoteWrites).toEqual([]);
  expect(state.urlLeaks).toEqual([]);
});

test("live metrics cap explains HTTP 429 without stacked dialogs", async ({
  page,
}) => {
  const state = monitor(page);
  await sso(page, "viewer1");
  const extras: Page[] = [];
  try {
    for (let i = 0; i < 5; i++) {
      const extra = await page.context().newPage();
      extras.push(extra);
      await extra.goto(`/db/${db}/overview`);
      await expect(
        extra.getByRole("heading", { name: "Overview", exact: true }),
      ).toBeVisible();
      if (i < 4)
        await expect(
          extra.getByText("Live telemetry", { exact: true }),
        ).toBeVisible();
    }
    const sixth = extras.at(-1)!;
    await expect(sixth.getByRole("alert")).toContainText("HTTP 429");
    await expect(sixth.getByRole("dialog")).toHaveCount(0);
    await sixth.screenshot({
      path: "qa-results/live-review-stream-cap.png",
      fullPage: true,
    });
  } finally {
    await Promise.all(extras.map((extra) => extra.close()));
  }
  expect(state.violations).toEqual([]);
  expect(state.errors).toEqual([]);
  expect(state.remoteWrites).toEqual([]);
  expect(state.urlLeaks).toEqual([]);
});

test("live account change: a demoted local user returns to sign-in with the reason", async ({
  page,
  browser,
}) => {
  const state = monitor(page);
  const name = `webqa-gen-${runTag}`;
  const first = createHash("sha256").update(process.env.BOOTSTRAP_ADMIN_PASSWORD! + "gen-1").digest("hex");
  const second = createHash("sha256").update(process.env.BOOTSTRAP_ADMIN_PASSWORD! + "gen-2").digest("hex");
  await sso(page, "admin1");
  await page.getByTestId("nav-users").click();
  await page.getByTestId("user-add").click();
  await page.getByTestId("user-username").fill(name);
  await page.getByTestId("user-display-name").fill("Web QA Generation");
  await page.getByTestId("user-role").selectOption("operator");
  await page.getByTestId("user-password").fill(first);
  await page.getByTestId("user-save").click();
  await expect(page.getByTestId("user-editor-dialog")).toHaveCount(0);

  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const user = await other.newPage();
  const userState = monitor(user);
  await user.goto("/");
  await user.getByTestId("login-username").fill(name);
  await user.getByTestId("login-password").fill(first);
  await user.getByTestId("login-submit").click();
  const forced = user.getByTestId("password-change-submit");
  const switcher = user.getByTestId("database-switcher");
  await expect(forced.or(switcher)).toBeVisible();
  if (await forced.isVisible()) {
    await user.getByTestId("current-password").fill(first);
    await user.getByTestId("new-password").fill(second);
    await forced.click();
  }
  await expect(switcher).toBeVisible();
  await switcher.selectOption(db);
  await expect(user.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();

  // Demote while the user is signed in: the session's auth generation is now stale.
  await page.getByRole("row").filter({ hasText: name }).getByTestId("user-edit").click();
  await page.getByTestId("user-role").selectOption("viewer");
  await page.getByTestId("user-save").click();
  await expect(page.getByTestId("user-editor-dialog")).toHaveCount(0);

  await user.getByTestId("nav-keys").click();
  await expect(user.getByTestId("session-ended")).toContainText(/account (was )?changed/i, { timeout: 15000 });
  await expect(user.getByTestId("login-username")).toBeVisible();
  await expect(user.getByTestId("database-switcher")).toHaveCount(0);
  await user.screenshot({ path: "qa-results/live-session-ended.png" });

  await page.getByRole("row").filter({ hasText: name }).getByTestId("user-edit").click();
  await page.getByTestId("user-disabled").check();
  await page.getByTestId("user-save").click();
  await expect(page.getByTestId("user-editor-dialog")).toHaveCount(0);
  await other.close();
  for (const s of [state, userState]) {
    expect(s.errors).toEqual([]);
    expect(s.violations).toEqual([]);
    expect(s.remoteWrites).toEqual([]);
    expect(s.urlLeaks).toEqual([]);
  }
});
