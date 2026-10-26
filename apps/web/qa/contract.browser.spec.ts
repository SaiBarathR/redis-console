import { test, expect, type Page } from "@playwright/test";
const bin = (data: string) => ({ enc: "utf8", data });
const hostile = "<img src=x onerror=alert(1)>";
const me = {
  id: "admin",
  username: "admin",
  displayName: "Sandbox Admin",
  source: "local",
  role: "admin",
  csrfToken: "csrf-fixture",
  totpEnabled: false,
  mustChangePassword: false,
  mustEnrollTotp: false,
  sessionExpiresAt: "2027-01-01T00:00:00Z",
};
const databases = [
  {
    id: "sandbox-e2e",
    name: "E2E scratch",
    environment: "test",
    readOnly: false,
    effectiveRole: "admin",
    features: { profiler: true },
    status: "connected",
    server: {
      version: "8.2.1",
      mode: "standalone",
      modules: [
        { name: "search", version: "8" },
        { name: "timeseries", version: "8" },
      ],
    },
  },
  {
    id: "remote-6390",
    name: "Remote 6390 (read-only)",
    environment: "prod",
    readOnly: true,
    effectiveRole: "viewer",
    features: { profiler: false },
    status: "connected",
  },
];
/** Server-built preview (review M1): 50 listed commands of 61, a hostile key, a cut value and unlisted args. */
const fixturePreview = {
  total: 61,
  more: 11,
  commands: [
    {
      argv: [
        { kind: "command", v: bin("HSET") },
        { kind: "key", v: bin(hostile) },
        { kind: "arg", v: bin("payload") },
        { kind: "arg", v: bin("x".repeat(16)), bytes: 90000 },
      ],
      moreArgs: 38,
    },
    ...Array.from({ length: 49 }, (_, i) => ({
      argv: [
        { kind: "command", v: bin("UNLINK") },
        { kind: "key", v: bin(`qa:queue:${i}`) },
      ],
    })),
  ],
};
const key = { key: bin("qa:hostile"), type: "string", ttl: -1, size: 75 };
const docs = [
  {
    name: "GET",
    summary: "Get the value of a key",
    complexity: "O(1)",
    since: "1.0.0",
    arguments: [{ name: "key", type: "key" }],
    class: "read",
    allowed: true,
    group: "string",
  },
  {
    name: "SET",
    summary: "Set a value",
    arguments: [
      { name: "key", type: "key" },
      { name: "value", type: "string" },
    ],
    class: "write",
    allowed: true,
    group: "string",
  },
  {
    name: "PING",
    summary: "Ping the server",
    arguments: [],
    class: "read",
    allowed: true,
    group: "connection",
  },
];
async function fixture(page: Page) {
  const violations: string[] = [];
  const errors: string[] = [];
  const writes: { url: string; body: unknown; csrf: string | undefined }[] = [];
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
  await page.addInitScript(() => {
    window.addEventListener("securitypolicyviolation", (event) => {
      console.error(
        `CSP violation ${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber} ${event.sample}`,
      );
    });
  });
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    let body: Record<string, unknown> = {};
    if (req.method() !== "GET") {
      body = req.postDataJSON() ?? {};
      if (
        !/\/(?:keys\/scan|key\/read|streams\/groups|streams\/pending|timeseries\/range|pubsub\/channels|pubsub\/subscriptions)$/.test(
          path,
        )
      )
        writes.push({ url: path, body, csrf: req.headers()["x-csrf-token"] });
    }
    const send = (json: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(json),
      });
    if (path.endsWith("/metrics/stream")) {
      const events = [1, 2, 3].map((i) => ({
        t: Date.now() + i * 2000,
        opsPerSec: 100 + i * 12,
        usedMemory: 8e7 + i * 1e5,
        connectedClients: 10,
        hitRate: 0.95,
        netInputKbps: 10,
        netOutputKbps: 20,
        cpuSys: 1,
        cpuUser: 2,
      }));
      return route.fulfill({
        contentType: "text/event-stream",
        body: events
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
      });
    }
    if (path.endsWith("/auth/me")) return send(me);
    if (path.endsWith("/auth/providers"))
      return send({
        oidc: { enabled: true, displayName: "Company SSO" },
        local: { enabled: true },
      });
    if (path.endsWith("/auth/totp/enroll"))
      return send({
        secretBase32: "JBSWY3DPEHPK3PXP",
        otpauthUrl:
          "otpauth://totp/Redis%20Console:admin?secret=JBSWY3DPEHPK3PXP&issuer=Redis%20Console",
      });
    if (path.endsWith("/databases")) return send({ databases });
    if (path.endsWith("/overview"))
      return send({
        id: "sandbox-e2e",
        info: { server: { redis_version: "8.2.1" } },
        keyspace: [{ db: 0, keys: 14589, expires: 5200, avgTtl: 3600000 }],
        memory: {
          used: 8e7,
          peak: 1e8,
          maxmemory: 0,
          fragmentationRatio: 1.12,
          policy: "noeviction",
        },
        clients: { connected: 10, blocked: 0 },
        stats: {
          opsPerSec: 128,
          hitRate: 0.95,
          totalCommands: 2000000,
          evictedKeys: 0,
          expiredKeys: 200,
        },
        uptimeSeconds: 390000,
      });
    if (path.endsWith("/keys/scan"))
      return send({
        cursor: "0",
        keys: [
          key,
          ...[
            "users:1001",
            "users:1002",
            "sessions:web:1",
            "queue:jobs",
            "cache:products",
          ].map((name) => ({ ...key, key: bin(name) })),
        ],
        scanned: 6,
        dbSize: 6,
      });
    if (path.endsWith("/key/read"))
      return send({
        ...key,
        encoding: "embstr",
        length: hostile.length,
        value: {
          type: "string",
          value: bin(hostile + "\u202e\u200b"),
          truncated: false,
          totalBytes: 75,
        },
      });
    if (path.endsWith("/commands")) return send({ commands: docs });
    if (path.endsWith("/cli"))
      return send({
        argv:
          typeof body.line === "string"
            ? body.line.split(" ")
            : (body.argv ?? ["PING"]),
        commandClass: "read",
        durationMs: 0.36,
        reply: { t: "str", v: bin(hostile) },
      });
    if (path.endsWith("/workbench"))
      return send({
        results: [
          {
            argv: ["PING"],
            commandClass: "read",
            durationMs: 0.5,
            reply: { t: "status", v: "PONG" },
          },
          {
            argv: ["DBSIZE"],
            commandClass: "read",
            durationMs: 0.2,
            reply: { t: "int", v: "6" },
          },
        ],
      });
    if (path.endsWith("/ops") || path.endsWith("/bulk-delete")) {
      if (!body.confirmation)
        return send(
          {
            error: {
              code: "confirmation_required",
              message: "Confirm",
              confirmation: {
                token: "fixture-confirmation-token",
                level: "typed",
                expectedText: "E2E scratch",
                reasonRequired: true,
                summary: "Delete matching keys",
                impact: { keys: 1, sample: [bin(hostile)] },
                preview: fixturePreview,
              },
            },
          },
          428,
        );
      return send(
        path.endsWith("/bulk-delete")
          ? { deleted: 1, scanned: 1 }
          : { ok: true },
      );
    }
    if (path.endsWith("/slowlog")) return send({ entries: [], len: 0 });
    if (path.endsWith("/clients")) return send({ clients: [] });
    if (path.endsWith("/pubsub/channels"))
      return send({ channels: [], patterns: 0 });
    if (path.endsWith("/streams/groups"))
      return send({
        groups: [
          {
            name: "workers",
            consumers: [{ name: "worker-1", pending: 2, idleMs: 10 }],
            pending: 2,
            lastDeliveredId: "1-0",
          },
        ],
      });
    if (path.endsWith("/streams/pending"))
      return send({
        pending: [
          { id: "1-0", consumer: "worker-1", idleMs: 50, deliveries: 1 },
        ],
        total: 1,
      });
    if (path.endsWith("/search/indexes"))
      return send({
        indexes: [
          {
            name: "idx:products",
            numDocs: 3,
            indexing: false,
            prefixes: ["products:"],
            fields: [{ name: "name", type: "TEXT" }],
          },
        ],
      });
    if (path.endsWith("/admin/audit")) return send({ events: [] });
    if (path.endsWith("/admin/users"))
      return send({
        users: [
          {
            id: "operator1",
            username: "operator1",
            displayName: "Operator One",
            role: "operator",
            disabled: false,
            totpEnabled: false,
            createdAt: "2026-10-01",
          },
        ],
      });
    return send({ ok: true });
  });
  return { violations, errors, writes };
}
test("production CSP: charts, editor, hostile values, confirmation and QR", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/");
  await page.getByTestId("database-switcher").selectOption("sandbox-e2e");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".uplot").first()).toBeVisible();
  await page.screenshot({ path: "qa-results/overview.png", fullPage: true });
  await page.getByTestId("nav-keys").click();
  await page.getByTestId("key-row").filter({ hasText: "qa:hostile" }).click();
  await expect(page.getByTestId("key-value")).toContainText(hostile);
  await expect(page.locator("img")).toHaveCount(0);
  await expect(page.getByTestId("key-value")).toContainText("\\u202e\\u200b");
  await page.getByTestId("key-explain").click();
  await expect(
    page.getByRole("complementary", { name: "Explain this key" }),
  ).toContainText("Read it with redis-cli");
  await page.screenshot({ path: "qa-results/keys.png", fullPage: true });
  await page.getByTestId("key-delete").click();
  await expect(page.getByTestId("confirmation-dialog")).toBeVisible();
  await expect(page.getByTestId("confirmation-submit")).toBeDisabled();
  await expect(page.getByTestId("confirmation-command")).toHaveCount(50);
  await expect(page.getByTestId("confirmation-more")).toContainText("+11 more commands");
  await expect(page.getByTestId("confirmation-total")).toHaveText("61 commands");
  await expect(page.getByTestId("confirmation-command").first()).toContainText(
    "… (90,000 bytes) +38 more arguments",
  );
  await expect(page.locator("img")).toHaveCount(0);
  await page.screenshot({ path: "qa-results/confirmation-preview.png" });
  await page.getByTestId("confirmation-typed").fill("E2E scratch");
  await page.getByTestId("confirmation-reason").fill("Qualification cleanup");
  await page.getByTestId("confirmation-submit").click();
  await expect(page.getByTestId("confirmation-dialog")).toHaveCount(0);
  await page.getByTestId("nav-console").click();
  await page.getByTestId("console-editor-input").fill('GET "qa:hostile"');
  await expect(page.getByTestId("policy-badge")).toContainText("read");
  await expect(page.getByTestId("command-docs")).toContainText("O(1)");
  await page.getByTestId("console-run").click();
  await expect(page.getByTestId("console-results")).toContainText(hostile);
  expect(
    await page
      .locator("head style")
      .evaluateAll((styles) =>
        styles.every((style) => style.nonce === "web-qualification-nonce-2026"),
      ),
  ).toBe(true);
  await page.getByTestId("nav-workbench").click();
  await page.getByTestId("workbench-editor-input").fill("PING\nDBSIZE");
  await page.getByTestId("workbench-run").click();
  await expect(page.getByTestId("console-results")).toContainText("PONG");
  await page.getByTestId("account-link").click();
  await page.getByTestId("totp-enroll").click();
  await expect(page.getByTestId("totp-qr")).toBeVisible();
  expect(
    await page
      .getByTestId("totp-qr")
      .evaluate((canvas) => (canvas as HTMLCanvasElement).width),
  ).toBeGreaterThan(100);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([
    "rconsole.theme",
    "rconsole.database",
  ]);
  expect(state.writes.every((write) => write.csrf === "csrf-fixture")).toBe(
    true,
  );
  expect(state.errors).toEqual([]);
  expect(state.violations).toEqual([]);
});
test("all feature routes, read-only role, palette and laptop layout", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/");
  await page.getByTestId("database-switcher").selectOption("sandbox-e2e");
  await page.getByTestId("nav-guided").click();
  for (const task of [
    "find",
    "inspect",
    "edit",
    "ttl",
    "stream",
    "publish",
    "counter",
    "set",
    "zset",
  ]) {
    await page.getByTestId(`guided-${task}`).click();
    await expect(page.getByTestId("guided-command")).toBeVisible();
  }
  await page.getByTestId("nav-diagnostics").click();
  for (const id of [
    "slowlog",
    "analysis",
    "pubsub",
    "streams",
    "clients",
    "profiler",
    "search",
    "timeseries",
  ]) {
    // v0.2: a persistent tool list next to the tool pane (no "All diagnostics" menu page).
    await page.getByTestId(`diagnostics-${id}`).click();
    await expect(page.getByTestId(`diagnostics-${id}`)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator(".pane-head h2").first()).toBeVisible();
  }
  await page.getByTestId("nav-audit").click();
  await expect(page.getByTestId("database-switcher")).toHaveValue(
    "sandbox-e2e",
  );
  await expect(page.getByTestId("audit-filter")).toBeVisible();
  await page.getByTestId("nav-users").click();
  await page.getByTestId("user-add").click();
  await expect(page.getByTestId("user-editor-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("command-palette-open").click();
  await page.getByTestId("command-palette-search").fill("Console");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("console-editor")).toBeVisible();
  await page.getByTestId("database-switcher").selectOption("remote-6390");
  await expect(
    page.getByText("Production database · All writes are disabled"),
  ).toBeVisible();
  await page.getByTestId("nav-keys").click();
  await expect(page.getByTestId("key-add")).toHaveCount(0);
  await page.getByTestId("key-row").first().click();
  await expect(page.getByTestId("key-delete")).toHaveCount(0);
  await page.getByTestId("nav-console").click();
  await page.getByTestId("console-editor-input").fill("SET k v");
  await expect(page.getByTestId("console-run")).toBeDisabled();
  expect(
    state.writes.filter((write) => write.url.includes("remote-6390")),
  ).toEqual([]);
  await page.getByTestId("nav-workbench").click();
  await page.getByTestId("workbench-editor-input").fill("SET k v");
  await expect(page.getByTestId("workbench-run")).toBeDisabled();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("nav-keys").click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "qa-results/laptop.png", fullPage: true });
  expect(state.errors).toEqual([]);
  expect(state.violations).toEqual([]);
});
test("truncated values cannot be overwritten from a preview", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.route("**/api/v1/databases/*/key/read", (route) => {
    const full = route.request().postDataJSON().full === true;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...key,
        value: {
          type: "string",
          value: bin("x".repeat(full ? 90000 : 65536)),
          truncated: !full,
          totalBytes: 90000,
        },
      }),
    });
  });
  await page.goto("/db/sandbox-e2e/keys");
  await page.getByTestId("key-row").first().click();
  await expect(page.getByTestId("key-edit")).toHaveCount(0);
  await page.getByTestId("key-load-full").click();
  await expect(page.getByTestId("key-edit")).toBeVisible();
  expect(state.violations).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("remembered production database never starts telemetry on the picker", async ({
  page,
}) => {
  const state = await fixture(page);
  const streams: string[] = [];
  await page.addInitScript(() =>
    localStorage.setItem("rconsole.database", "remote-6390"),
  );
  await page.route("**/api/v1/databases", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ databases: [...databases].reverse() }),
    }),
  );
  page.on("request", (req) => {
    if (req.url().includes("/metrics/stream")) streams.push(req.url());
  });
  await page.goto("/");
  await expect(page.getByTestId("database-landing")).toBeVisible();
  expect(streams).toEqual([]);
  await page
    .getByTestId("database-landing")
    .getByRole("link", { name: /Remote 6390/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect.poll(() => streams.length).toBe(1);
  expect(streams[0]).toContain("/remote-6390/");
  expect(state.violations).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("server-budgeted collection pages neither skip entries nor stop streams early", async ({
  page,
}) => {
  const state = await fixture(page);
  let type = "list";
  const offsets: number[] = [];
  const cursors: string[] = [];
  await page.route("**/api/v1/databases/*/key/read", (route) => {
    const body = route.request().postDataJSON();
    const offset = body.offset ?? 0;
    let value;
    if (type === "list" || type === "zset") {
      offsets.push(offset);
      const entries = Array.from(
        { length: Math.min(2, 5 - offset) },
        (_, i) => ({ index: offset + i, value: bin(`value-${offset + i}`) }),
      );
      value =
        type === "list"
          ? { type, items: entries, offset, total: 5 }
          : {
              type,
              members: entries.map((item) => ({
                member: item.value,
                score: String(item.index),
              })),
              offset,
              total: 5,
            };
    } else {
      const cursor = body.cursor ?? "0";
      cursors.push(cursor);
      const id = cursor === "0" ? "3-0" : cursor === "3-0" ? "2-0" : "1-0";
      value = {
        type,
        entries: [{ id, fields: [{ field: bin("f"), value: bin("v") }] }],
        total: 3,
        lastId: "3-0",
        groups: 0,
      };
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...key, type, value }),
    });
  });
  for (type of ["list", "zset", "stream"]) {
    await page.goto("/db/sandbox-e2e/keys");
    await page.getByTestId("key-row").first().click();
    await expect(
      page.getByTestId("key-detail").locator("tbody tr"),
    ).toHaveCount(type === "stream" ? 1 : 2);
    for (let i = 0; i < 2; i++) {
      await expect(page.getByTestId("key-next-page")).toBeEnabled();
      const response = page.waitForResponse((reply) =>
        reply.url().endsWith("/key/read"),
      );
      await page.getByTestId("key-next-page").click();
      await response;
    }
    await expect(page.getByTestId("key-next-page")).toBeDisabled();
  }
  expect(offsets).toEqual([0, 2, 4, 0, 2, 4]);
  expect(cursors).toEqual(["0", "3-0", "2-0"]);
  expect(state.violations).toEqual([]);
  expect(state.errors).toEqual([]);
});

test("production confirmation is loud, scrolls, and passes strict CSP in both themes", async ({
  page,
}) => {
  const state = await fixture(page);
  const prod = {
    id: "orders-prod",
    name: "Orders",
    environment: "prod",
    readOnly: false,
    effectiveRole: "admin",
    features: { profiler: false },
    status: "connected",
  };
  await page.route("**/api/v1/databases", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ databases: [...databases, prod] }),
    }),
  );
  for (const [theme, width] of [
    ["light", 1440],
    ["dark", 1280],
  ] as const) {
    await page.addInitScript((t) => localStorage.setItem("rconsole.theme", t), theme);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/db/orders-prod/keys");
    await page.getByTestId("key-row").filter({ hasText: "qa:hostile" }).click();
    await page.getByTestId("key-delete").click();
    const dialog = page.getByTestId("confirmation-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveClass(/prod/);
    await expect(page.getByTestId("confirmation-target")).toContainText("Production");
    await expect(page.getByTestId("confirmation-target")).toContainText("admin");
    await expect(page.getByTestId("confirmation-submit")).toHaveText("Confirm on production");
    const list = page.getByTestId("confirmation-preview");
    const [scrollHeight, clientHeight] = await list.evaluate((el) => [el.scrollHeight, el.clientHeight]);
    expect(scrollHeight).toBeGreaterThan(clientHeight);
    await list.focus();
    await page.keyboard.press("End");
    await expect(page.getByTestId("confirmation-command").last()).toBeInViewport();
    await page.screenshot({ path: `qa-results/confirmation-prod-${theme}-${width}.png` });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  expect(state.violations).toEqual([]);
  expect(state.errors).toEqual([]);
});
