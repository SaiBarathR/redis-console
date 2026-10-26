/**
 * Real Chromium keyboard flows for the Console and Workbench. The same guarded harness (CSP and
 * Trusted Types violations, console errors, dialogs and secret leaks fail the test) runs against
 * the isolated E2E server, or with RC_CONSOLE_LIVE=1 against the :4300 QA server on every database.
 */
import { test as guarded, expect } from "../../lib/test.ts";
import { storageFile } from "../../lib/api.ts";
import { gotoView } from "../../lib/ui.ts";
import type { Page, Locator } from "@playwright/test";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const live = process.env.RC_CONSOLE_LIVE === "1";
const test = guarded.extend({
  storageState: async ({ role }, use) => {
    await use(
      live
        ? path.resolve(`../../.qa/console-storage-${role}.json`)
        : storageFile(role!),
    );
  },
});
const DATABASES = live
  ? ["snapshot", "sandbox-main", "sandbox-e2e", "remote-6390"]
  : ["sandbox-e2e"];
const mac = process.platform === "darwin";
const mod = mac ? "Meta" : "Control";
const alt = mac ? "Option" : "Alt";
async function tabTo(page: Page, testId: string) {
  await tabToLocator(page, page.getByTestId(testId));
}
async function tabToLocator(page: Page, locator: Locator) {
  // A control that is not on screen yet (its view still loading) cannot take focus: wait for it, then
  // reach it with the keyboard. A fixed number of Tabs raced the view's code load (review round 1, L2).
  await expect(locator).toBeVisible();
  for (let i = 0; i < 120; i++) {
    if (await locator.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  const active = await page.evaluate(() => {
    const node = document.activeElement;
    return node
      ? `${node.tagName.toLowerCase()} ${node.getAttribute("data-testid") ?? node.getAttribute("aria-label") ?? ""}`.trim()
      : "nothing";
  });
  throw new Error(`Control is not reachable using Tab (focus ended on ${active})`);
}
const editorInput = (page: Page, workbench = false) =>
  page.getByTestId(workbench ? "workbench-editor-input" : "console-editor-input");
/** Argument-role spans inside the editor only (signatures and result echoes reuse the classes). */
const tokens = (page: Page, role: string) =>
  editorInput(page).locator(`.console-token-${role}`);
async function typeCommand(page: Page, command: string, workbench = false) {
  await tabTo(page, workbench ? "workbench-editor-input" : "console-editor-input");
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText(command);
  // Programmatic insertion is still a Chromium input event, without timing-dependent auto-popup.
  await page.keyboard.press("Escape"); // dismiss completion/ghost (Console: or clear), then reinsert
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText(command);
}
async function runRead(page: Page, command: string) {
  await typeCommand(page, command);
  const count = await page.getByTestId("console-result").count();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("console-result")).toHaveCount(count + 1);
}
const focused = (locator: Locator) =>
  expect
    .poll(() => locator.evaluate((node) => node.contains(document.activeElement)))
    .toBe(true);
/** Fails the test if anything but an audited read reaches the read-only remote. */
function guardRemote(page: Page) {
  const unsafe: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/databases/remote-6390/") &&
      /\/(cli|workbench)$/.test(request.url())
    ) {
      const body = request.postDataJSON();
      const lines: string[] = body.script?.split("\n") ?? [body.line ?? ""];
      for (const line of lines)
        if (line.trim() && !/^(PING|GET|DBSIZE|SCAN|TYPE|TTL|INFO)(?:\s|$)/i.test(line.trim()))
          unsafe.push(line.split(" ")[0] ?? "unknown");
    }
  });
  return unsafe;
}
async function readKeyboardFlow(page: Page, db: string, role: string) {
  const unsafeRemote = guardRemote(page);
  await gotoView(page, db, "console");
  const prompt = page.getByTestId("console-prompt");
  await expect(prompt).toContainText(db);
  await expect(prompt).toContainText(db === "remote-6390" ? "viewer" : role);
  if (db === "remote-6390") await expect(prompt).toContainText("read-only");
  // Every shortcut has a visible control with its key hint.
  for (const name of [
    "Previous command in history",
    "Next command in history",
    "Previous result",
    "Next result",
    "Copy last result",
  ])
    await expect(page.getByRole("button", { name })).toBeVisible();
  await expect(page.getByTestId("console-clear")).toContainText("Ctrl+L");
  await expect(page.getByTestId("console-run")).toContainText("Enter");
  await expect(page.getByTestId("console-docs-open")).toContainText("F1");
  await expect(page.getByTestId("console-cancel")).toContainText("Ctrl+C");
  // The palette opens from the editor and shows view shortcuts; the registry leaves its input alone.
  await tabTo(page, "console-editor-input");
  await page.keyboard.press(`${mod}+k`);
  await expect(page.getByTestId("command-palette-search")).toBeFocused();
  await expect(page.getByTestId("command-palette")).toContainText(`${alt}+2`);
  await page.keyboard.insertText("?");
  await page.keyboard.press("Control+l");
  await expect(page.getByTestId("command-palette-search")).toHaveValue("?");
  await page.keyboard.press("Escape");
  await tabTo(page, "console-editor-input");
  await page.keyboard.press("?"); // text in the editor, not the overlay
  await expect(page.getByTestId("shortcut-help")).toHaveCount(0);
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible();
  await page.keyboard.press("Escape");
  await typeCommand(page, "DBSIZ");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("DBSIZE");
  await page.keyboard.press("Tab");
  await expect(editorInput(page)).toContainText("DBSIZE");
  await page.keyboard.press("Control+c");
  await typeCommand(page, "PIN");
  await page.keyboard.press("Control+Space");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("PING");
  await page.keyboard.press("ArrowRight");
  await expect(editorInput(page)).toContainText("PING");
  await page.keyboard.press("Control+c");
  // Argument roles from COMMAND DOCS and key specs.
  await typeCommand(page, "XREAD STREAMS example:one example:two 0-0 1-0");
  await expect(tokens(page, "key")).toHaveText(["example:one", "example:two"]);
  await expect(tokens(page, "value")).toHaveText(["0-0", "1-0"]);
  await expect(tokens(page, "key").first()).toHaveClass(/t-stream/);
  await typeCommand(page, "ZUNION 2 example:one example:two WEIGHTS 1 2");
  await expect(tokens(page, "key")).toHaveText(["example:one", "example:two"]);
  await expect(tokens(page, "flag")).toHaveText("WEIGHTS");
  await expect(tokens(page, "key").first()).toHaveClass(/t-zset/);
  await typeCommand(page, "MSET example:one 1 example:two 2");
  await expect(tokens(page, "key")).toHaveText(["example:one", "example:two"]);
  await typeCommand(page, "HGETALL example:hash");
  await expect(tokens(page, "key")).toHaveClass(/t-hash/);
  await typeCommand(page, "EXPIRE example:one soon");
  await expect(tokens(page, "number")).toHaveClass(/console-token-invalid/);
  // Results: status gutter, time, duration, size; aria-live announcement.
  await runRead(page, "PING keyboard:first");
  await runRead(page, "PING keyboard:second");
  await expect(page.getByTestId("console-announcement")).toContainText(
    "Completed in",
  );
  const result = page.getByTestId("console-result").last();
  await expect(result).toHaveAttribute("data-status", "success");
  await expect(result).toContainText(/\d ms/);
  await expect(result).toContainText(/\d+ B/);
  await expect(result.locator("time")).toHaveAttribute("datetime", /T/);
  // Ghost suggestion from history: Esc dismisses, → accepts.
  await typeCommand(page, "PING keyboard:");
  await expect(page.locator(".console-ghost")).toHaveText("second");
  await page.keyboard.press("Escape"); // popup before ghost when both are open
  if (await page.locator(".console-ghost").count())
    await page.keyboard.press("Escape");
  await expect(page.locator(".console-ghost")).toHaveCount(0);
  await page.keyboard.press("Escape"); // then clears the line
  await expect(editorInput(page).locator(".cm-placeholder")).toBeVisible();
  await typeCommand(page, "PING keyboard:");
  await page.keyboard.press("ArrowRight");
  await expect(editorInput(page)).toContainText("PING keyboard:second");
  // ↑/↓ history with the unfinished draft restored.
  await page.keyboard.press("Control+c");
  await page.keyboard.insertText("DBSIZE");
  await page.keyboard.press("ArrowUp");
  await expect(editorInput(page)).toContainText("PING keyboard:second");
  await page.keyboard.press("ArrowUp");
  await expect(editorInput(page)).toContainText("PING keyboard:first");
  await page.keyboard.press("ArrowDown");
  await expect(editorInput(page)).toContainText("PING keyboard:second");
  await page.keyboard.press("ArrowDown");
  await expect(editorInput(page)).toHaveText("DBSIZE");
  // Ctrl+R reverse search: incremental, older match, arrows, use without running, Esc.
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+r");
  const search = page.getByRole("combobox", { name: "Search command history" });
  await expect(search).toBeFocused();
  await page.keyboard.insertText("keyboard:");
  await expect(page.getByTestId("history-search")).toContainText("1 of 2 matches");
  await expect(page.getByTestId("history-search").locator("mark").first()).toHaveText(
    "keyboard:",
  );
  await page.keyboard.press("Control+r");
  await expect(page.getByTestId("history-search")).toContainText("2 of 2 matches");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("history-search")).toContainText("1 of 2 matches");
  await page.keyboard.press("ArrowDown");
  const before = await page.getByTestId("console-result").count();
  await page.keyboard.press("Enter");
  await expect(editorInput(page)).toContainText("PING keyboard:first");
  await expect(page.getByTestId("console-result")).toHaveCount(before);
  await page.keyboard.press("Control+r");
  await page.keyboard.press("Escape");
  await expect(editorInput(page)).toBeFocused();
  await expect(editorInput(page)).toContainText("PING keyboard:first");
  // Shift+Enter continues the command; ↑/↓ move between its lines, not through history.
  await page.keyboard.press("Control+c");
  await typeCommand(page, "PING");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.insertText("DBSIZE");
  await expect(page.locator(".console-assist")).toContainText(
    "These lines run as one command",
  );
  await page.keyboard.press("ArrowUp");
  await expect(editorInput(page)).toContainText("DBSIZE");
  await page.keyboard.press(`${mod}+Home`);
  await page.keyboard.press("ArrowDown");
  await expect(editorInput(page)).toContainText("DBSIZE");
  // Signature with the argument at the cursor; policy before running; F1 and Mod+/ docs.
  await page.keyboard.press("Control+c");
  await typeCommand(page, "GET keyboard:missing");
  await expect(tokens(page, "command")).toHaveText("GET");
  await expect(tokens(page, "key")).toHaveText("keyboard:missing");
  await expect(page.getByTestId("policy-badge")).toContainText("read");
  await expect(page.getByTestId("command-signature")).toContainText("GET key");
  await expect(
    page.getByTestId("command-signature").locator("mark[aria-current]"),
  ).toHaveText("key");
  await page.keyboard.press(`${mod}+Home`); // docs still identify the command when the caret precedes it
  await page.keyboard.press("F1");
  await expect(page.getByTestId("command-docs-dialog")).toContainText("GET");
  await expect(page.getByTestId("command-docs-dialog")).toContainText("Policy here");
  await page.keyboard.press("Escape");
  await expect(editorInput(page)).toBeFocused();
  await page.keyboard.press(`${mod}+/`);
  await expect(page.getByTestId("command-docs-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(editorInput(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("console-result")).toHaveCount(3);
  // Mod+Shift+C copies the last result (verified through native paste, not clipboard-read).
  await page.keyboard.press(`${mod}+Shift+c`);
  await expect(page.getByTestId("console-announcement")).toContainText(
    "Last result copied",
  );
  await page.keyboard.press(`${mod}+v`);
  await expect(editorInput(page)).toContainText("(nil)");
  await page.keyboard.press("Control+c");
  // Alt+↑/↓ move between result blocks; past the newest returns to the prompt; Esc too.
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.getByTestId("console-result").last()).toBeFocused();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(page.getByTestId("console-result").nth(1)).toBeFocused();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.getByTestId("console-result").last()).toBeFocused();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(editorInput(page)).toBeFocused();
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Escape");
  await expect(editorInput(page)).toBeFocused();
  // Collapse and expand by keyboard from the focused block.
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Tab"); // collapse action
  await page.keyboard.press("Enter");
  const expand = page
    .getByTestId("console-result")
    .last()
    .getByRole("button", { name: "Expand", exact: true });
  await expect(expand).toBeFocused();
  await expect(page.getByTestId("console-result").last().locator(".result-preview")).toHaveText(
    "(nil)",
  );
  await page.keyboard.press("Enter");
  // `?` outside inputs: overlay grouped by context, this view first, both platforms' labels.
  await page.keyboard.press("?");
  const help = page.getByTestId("shortcut-help");
  await expect(help).toContainText("Workbench editor");
  await expect(help.locator("h3").first()).toContainText("Console prompt");
  await expect(help.locator("h3").first()).toContainText("this view");
  await tabToLocator(page, help.getByRole("button", { name: mac ? "Windows / Linux" : "macOS" }));
  await page.keyboard.press("Enter");
  await expect(help.locator("kbd", { hasText: mac ? /^Alt$/ : /^Option$/ }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  // Did you mean, KEYS → SCAN with the pattern kept.
  await typeCommand(page, "PIGN");
  await expect(page.getByTestId("command-suggestions")).toContainText("PING");
  await typeCommand(page, "KEYS keyboard:*");
  await expect(page.getByTestId("keys-guidance")).toContainText(
    "SCAN 0 MATCH keyboard:* COUNT 100",
  );
  await expect(page.getByTestId("console-run")).toBeDisabled();
  await tabToLocator(page, page.getByTestId("keys-guidance").getByRole("button"));
  await page.keyboard.press("Enter");
  await expect(editorInput(page)).toHaveText("SCAN 0 MATCH keyboard:* COUNT 100");
  await expect(editorInput(page)).toBeFocused();
  // Write and destructive cues before running (never executed in this flow).
  await typeCommand(page, 'SET keyboard:missing "a value" EX 60 NX');
  await expect(tokens(page, "value")).toContainText('"a value"');
  await expect(tokens(page, "number")).toHaveText("60");
  await expect(tokens(page, "flag")).toHaveText(["EX", "NX"]);
  await expect(page.getByTestId("policy-badge")).toContainText("write");
  if (role === "viewer" || db === "remote-6390") {
    await expect(page.getByTestId("console-run")).toBeDisabled();
    await expect(page.getByTestId("policy-badge")).toContainText("blocked");
  }
  if (db !== "remote-6390") {
    await typeCommand(page, "DEL keyboard:missing");
    await expect(page.getByTestId("policy-badge")).toContainText(
      role === "viewer" ? "destructive · blocked" : "needs confirmation",
    );
    if (role === "viewer") {
      // Blocked outright: no promise of a confirmation step it can never reach.
      await expect(page.locator(".console-danger-message")).toHaveCount(0);
      await expect(page.getByTestId("console-run")).toBeDisabled();
    } else {
      await expect(page.locator(".console-danger-message")).toContainText(
        "Destructive command",
      );
      await expect(page.locator(".console-dock")).toHaveClass(/is-danger/);
      await expect(page.getByTestId("console-run")).toContainText("Run…");
    }
    await typeCommand(page, "CONFIG GET maxmemory");
    await expect(page.getByTestId("policy-badge")).toContainText("admin");
    await expect(tokens(page, "subcommand")).toHaveText("GET");
  }
  // Ctrl+L clears the screen and keeps history.
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+l");
  await expect(page.getByTestId("console-result")).toHaveCount(0);
  await expect(page.getByTestId("console-announcement")).toContainText(
    "History is kept",
  );
  await page.keyboard.press("ArrowUp");
  await expect(editorInput(page)).toContainText("GET keyboard:missing");
  expect(unsafeRemote, "only audited read commands reached remote-6390").toEqual([]);
  // History and results are memory only: not in storage, gone after reload.
  const stored = await page.evaluate(
    () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
  );
  expect(stored).not.toContain("keyboard:");
  await page.reload();
  await expect(page.getByTestId("console-result")).toHaveCount(0);
  await tabTo(page, "console-editor-input");
  await page.keyboard.press("ArrowUp");
  await expect(editorInput(page).locator(".cm-placeholder")).toBeVisible();
}
/** SCAN on the real keyspace: key anatomy links, continue from the cursor, open the key browser. */
async function scanFlow(page: Page, db: string) {
  const unsafeRemote = guardRemote(page);
  await gotoView(page, db, "console");
  await runRead(page, "SCAN 0 COUNT 50");
  const block = page.getByTestId("console-result").last();
  await expect(block).toContainText(/Scan complete|Cursor \d+/);
  const links = block.locator(".scan-keys .key-link");
  if ((await links.count()) === 0) return; // empty database
  await expect(links.first().locator(".key-anatomy")).toBeVisible();
  const next = block.getByRole("button", { name: "Continue scan" });
  if (await next.count()) {
    await tabToLocator(page, next);
    await page.keyboard.press("Enter");
    await expect(editorInput(page)).toHaveText(/^SCAN [1-9]\d* COUNT 50$/);
    await expect(editorInput(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("console-result")).toHaveCount(2);
  }
  await page.keyboard.press("Alt+ArrowUp");
  const first = page
    .getByTestId("console-result")
    .last()
    .locator(".scan-keys .key-link")
    .first();
  if (!(await first.count())) return;
  const name = (await first.getAttribute("aria-label"))!.replace(/^Open key /, "");
  await tabToLocator(page, first);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/db/${db}/keys$`));
  await expect(page.getByTestId("key-detail")).toContainText(name.slice(-12));
  await page.keyboard.press("Alt+2");
  await expect(page).toHaveURL(/\/console$/);
  await expect(page.getByTestId("console-result").first()).toBeVisible(); // results kept in memory
  expect(unsafeRemote).toEqual([]);
}
for (const role of ["viewer", "operator", "admin"]) {
  test.describe(`keyboard ${role}`, () => {
    test.use({ role, permissions: ["clipboard-read", "clipboard-write"] });
    for (const db of DATABASES) {
      test(`all read shortcuts, policy cues and memory isolation on ${db}`, async ({
        page,
      }) => {
        await readKeyboardFlow(page, db, role);
      });
      test(`SCAN key links, continue scan and key browser on ${db}`, async ({
        page,
      }) => {
        await scanFlow(page, db);
      });
      test(`Workbench line, selection, all, policy and error gutter on ${db}`, async ({
        page,
      }) => {
        const unsafeRemote = guardRemote(page);
        await gotoView(page, db, "workbench");
        await expect(page.getByTestId("console-prompt")).toContainText(db);
        await expect(page.getByTestId("workbench-run")).toContainText(
          mac ? "⌘+Enter" : "Ctrl+Enter",
        );
        await typeCommand(page, "PING\nDBSIZE", true);
        // Esc and an idle Ctrl+C never wipe a script.
        await page.keyboard.press("Escape");
        await page.keyboard.press("Control+c");
        await expect(editorInput(page, true)).toContainText("DBSIZE");
        await page.keyboard.press(`${mod}+Home`);
        await delay(550); // respect the server's 2/s Workbench token bucket
        await page.keyboard.press("Shift+Enter");
        await expect(page.getByTestId("console-result")).toHaveCount(1);
        await expect(page.getByTestId("console-results")).toContainText("PONG");
        await expect(page.getByTestId("console-result").first()).toContainText("line 1");
        await expect(
          page.locator('.console-line-marker[aria-label^="success"]'),
        ).toHaveCount(1);
        await page.keyboard.press(`${mod}+a`);
        await delay(550);
        await page.keyboard.press("Shift+Enter");
        await expect(page.getByTestId("console-result")).toHaveCount(3);
        await delay(550);
        await page.keyboard.press(`${mod}+Enter`);
        await expect(page.getByTestId("console-result")).toHaveCount(5);
        await expect(page.locator(".run-header").first()).toContainText("all succeeded");
        // Newest run first, its lines in script order.
        await expect(page.getByTestId("console-result").first()).toContainText("PING");
        // Alt+↓ from the editor reaches the newest run; Alt+↑ from it returns to the editor.
        await page.keyboard.press("Alt+ArrowDown");
        await expect(page.getByTestId("console-result").first()).toBeFocused();
        await page.keyboard.press("Alt+ArrowUp");
        await expect(editorInput(page, true)).toBeFocused();
        await typeCommand(page, "GET", true);
        await delay(550);
        await page.keyboard.press(`${mod}+Enter`);
        await expect(page.getByTestId("console-result")).toHaveCount(6);
        await expect(
          page.locator('.console-line-marker[aria-label^="error"]'),
        ).toHaveCount(1);
        await expect(page.locator(".run-header").first()).toContainText("1 error");
        await typeCommand(page, "PING\nFLUSHALL", true);
        await expect(page.getByTestId("workbench-run")).toBeDisabled();
        await expect(page.locator(".console-line-marker.tone-blocked")).toHaveCount(1);
        await expect(page.getByTestId("workbench-policy")).toContainText("Line 2");
        if (db !== "remote-6390" && role !== "viewer") {
          await typeCommand(page, "PING\nDEL keyboard:missing", true);
          await expect(page.locator(".console-line-marker.tone-danger")).toHaveCount(1);
          await expect(page.locator(".console-danger-message")).toContainText(
            "Line 2 is destructive",
          );
        }
        expect(unsafeRemote).toEqual([]);
      });
    }
  });
}
test.describe("write confirmation and cancellation", () => {
  test.use({
    role: "operator",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  test("keyboard-only DEL confirmation cancellation, acceptance and safe rerun", async ({
    page,
  }) => {
    await gotoView(page, "sandbox-e2e", "console");
    const key = `webqa:20261023:console:${Date.now()}`;
    await typeCommand(page, `SET ${key} safe`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("console-result")).toHaveCount(1);
    await typeCommand(page, `DEL ${key}`);
    await expect(page.locator(".console-danger-message")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("confirmation-dialog")).toContainText(key);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("console-result").last()).toHaveAttribute(
      "data-status",
      "cancelled",
    );
    await typeCommand(page, `GET ${key}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("console-result").last()).toContainText("safe");
    await typeCommand(page, `DEL ${key}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("confirmation-dialog")).toBeVisible();
    await tabTo(page, "confirmation-submit");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("confirmation-dialog")).toBeHidden();
    await expect(page.getByTestId("console-result").last()).toHaveAttribute(
      "data-status",
      "success",
    );
    await expect(page.getByTestId("console-result").last()).toContainText("(integer) 1");
    await tabTo(page, "console-editor-input");
    await page.keyboard.press("Alt+ArrowUp");
    const block = page.getByTestId("console-result").last();
    await tabToLocator(page, block.getByRole("button", { name: "Re-run", exact: true }));
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("confirmation-dialog")).toContainText(key); // re-run repeats server confirmation
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("confirmation-dialog")).toBeHidden();
  });
  test("Ctrl+C aborts a real blocking fetch and reports cancellation", async ({
    page,
  }) => {
    await gotoView(page, "sandbox-e2e", "console");
    const key = `webqa:20261023:console:empty:${Date.now()}`;
    await typeCommand(page, `BLPOP ${key} 5`);
    // BLPOP's policy comes from command metadata; Enter must follow that initial read.
    await expect(page.getByTestId("console-run")).toBeEnabled();
    await page.keyboard.press("Enter");
    const running = page.getByTestId("console-running");
    await expect(running).toContainText("Running");
    await expect(running).toContainText("BLPOP");
    await expect(running).not.toContainText("0.0 s");
    await expect(page.getByTestId("console-cancel")).toContainText("cancel request");
    const failed = page.waitForEvent("requestfailed", (request) =>
      request.url().endsWith("/cli"),
    );
    await page.keyboard.press("Control+c");
    expect((await failed).failure()?.errorText).toContain("ERR_ABORTED");
    await expect(page.getByTestId("console-result")).toHaveAttribute(
      "data-status",
      "cancelled",
    );
    await expect(page.getByTestId("console-results")).toContainText(
      "may still complete",
    );
    await expect(page.getByTestId("console-announcement")).toContainText(
      "Request cancelled",
    );
  });
});

test.describe("additional keyboard affordances", () => {
  test.use({ role: "viewer" });
  test("safe example, tree view and key-browser result action", async ({
    page,
  }) => {
    await gotoView(page, "sandbox-e2e", "console");
    await tabToLocator(
      page,
      page.getByRole("button", {
        name: /SCAN 0 COUNT 20.*Browse a small batch of keys/,
      }),
    );
    await page.keyboard.press("Enter");
    await expect(editorInput(page)).toContainText("SCAN 0 COUNT 20");
    await expect(editorInput(page)).toBeFocused();
    await page.keyboard.press("Enter");
    const block = page.getByTestId("console-result");
    await expect(block).toHaveCount(1);
    await tabTo(page, "reply-view-tree");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("reply-view-tree")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(block.locator(".reply-list").first()).toBeVisible();
    const open = block.getByRole("button", { name: /^Open key / }).first();
    await expect(open).toBeVisible();
    await tabToLocator(page, open);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/db\/sandbox-e2e\/keys$/);
    await expect(page.getByTestId("key-detail")).toBeVisible();
    // Global navigation bindings fire outside inputs. Focus the rail control directly: how many Tab
    // stops the inspector has depends on the key the first SCAN batch happens to return.
    await page.getByTestId("nav-console").focus();
    await page.keyboard.press("Alt+2");
    await expect(page).toHaveURL(/\/console$/);
    await page.keyboard.press("Alt+1");
    await expect(page).toHaveURL(/\/keys$/);
  });
});
test.describe("admin typed confirmation", () => {
  test.use({ role: "admin" });
  test("FLUSHDB typed-name challenge is keyboard-operable and cancelled before execution", async ({
    page,
  }) => {
    const requests: { line?: string; confirmation?: unknown }[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/cli")) requests.push(request.postDataJSON());
    });
    await gotoView(page, "sandbox-e2e", "console");
    await typeCommand(page, "FLUSHDB");
    await expect(page.locator(".console-danger-message")).toContainText(
      "type the database name",
    );
    await page.keyboard.press("Enter");
    const dialog = page.getByTestId("confirmation-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("confirmation-submit")).toBeDisabled();
    const typed = dialog.getByTestId("confirmation-typed");
    const label = await dialog
      .locator("label")
      .filter({ has: page.getByTestId("confirmation-typed") })
      .innerText();
    const name = /“(.+)”/.exec(label)?.[1];
    if (!name) throw new Error("Typed confirmation has no target name");
    await tabTo(page, "confirmation-typed");
    await page.keyboard.insertText("wrong");
    await expect(dialog.getByTestId("confirmation-submit")).toBeDisabled();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.insertText(name);
    await expect(dialog.getByTestId("confirmation-submit")).toBeEnabled();
    await page.keyboard.press("Control+c");
    await expect(typed).toHaveValue(name); // page bindings leave this input alone
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("console-result")).toHaveAttribute(
      "data-status",
      "cancelled",
    );
    expect(requests).toEqual([{ line: "FLUSHDB" }]); // no confirmation retry, so no FLUSHDB reaches Redis
  });
});

if (live)
  test.describe("Console visual qualification", () => {
    test.use({ role: "operator" });
    test("light and dark Console/Workbench at 1024, 1280, 1440 and 1920", async ({
      page,
    }, testInfo) => {
      for (const theme of ["light", "dark"]) {
        for (const width of [1024, 1280, 1440, 1920]) {
          await page.setViewportSize({ width, height: 900 });
          await gotoView(page, "snapshot", "console");
          await expect(editorInput(page)).toBeVisible(); // the view is ready, not only the shell
          if ((await page.locator("html").getAttribute("data-theme")) !== theme) {
            await tabTo(page, "theme-toggle");
            await page.keyboard.press("Enter");
          }
          await runRead(page, "SCAN 0 COUNT 20");
          await runRead(page, "INFO keyspace");
          await typeCommand(page, 'SET example:session:1001 "hello" EX 60');
          await expect(page.locator(".console-dock")).toBeVisible();
          // The prompt and the newest result are on screen without scrolling the page.
          await expect(page.getByTestId("console-result").last()).toBeInViewport();
          await expect(page.getByTestId("console-prompt")).toBeInViewport();
          await page.screenshot({
            path: testInfo.outputPath(`console-${theme}-${width}.png`),
          });
          if (width === 1440) {
            await typeCommand(page, "DEL example:session:1001");
            await delay(300); // let the 120 ms colour transitions settle
            await page.screenshot({
              path: testInfo.outputPath(`console-danger-${theme}.png`),
            });
            await page.keyboard.press("Control+c");
            await page.keyboard.press("Control+r");
            await page.keyboard.insertText("scan");
            await page.screenshot({
              path: testInfo.outputPath(`console-search-${theme}.png`),
            });
            await page.keyboard.press("Escape");
            await page.keyboard.press("Alt+ArrowUp");
            await page.keyboard.press("?");
            await page.screenshot({
              path: testInfo.outputPath(`shortcut-help-${theme}.png`),
            });
            await page.keyboard.press("Escape");
          }
          await gotoView(page, "snapshot", "workbench");
          await typeCommand(
            page,
            "# Look at a session\nPING\nGET example:session:1001\nSET example:session:1001 hello\nDEL example:session:1001\nFLUSHALL",
            true,
          );
          await page.screenshot({
            path: testInfo.outputPath(`workbench-${theme}-${width}.png`),
          });
        }
      }
    });
  });

test.describe("additional keyboard input regression", () => {
  test.use({ role: "operator" });
  test("native select-all replacement updates policy and replaces the whole Workbench draft", async ({
    page,
  }) => {
    await gotoView(page, "sandbox-e2e", "console");
    const input = editorInput(page);
    await input.fill("GET example:selection");
    await expect(page.getByTestId("policy-badge")).toContainText("read");
    await input.fill("SET example:selection value");
    await expect(page.getByTestId("policy-badge")).toContainText("write");
    await expect(input).toHaveText("SET example:selection value");
    await gotoView(page, "sandbox-e2e", "workbench");
    await editorInput(page, true).fill("# replacement\nPING\nDBSIZE");
    await expect(page.getByTestId("workbench-policy")).toContainText("2 commands");
    await page.keyboard.press(`${mod}+Enter`);
    await expect(page.getByTestId("console-result")).toHaveCount(2);
    await expect(page.getByTestId("console-results")).toContainText("PONG");
  });
});

/**
 * Waits until this user has no blocking command left on the server: an earlier case's cancelled BLPOP keeps
 * running up to its timeout and holds the user's one blocking slot (the server answers 429 meanwhile).
 */
async function blockingSlotFree(page: Page) {
  const payload = await (await page.request.get("/api/v1/auth/me")).json();
  const headers = {
    "X-CSRF-Token": (payload.me ?? payload).csrfToken,
    Origin: new URL(page.url()).origin,
  };
  await expect
    .poll(
      async () =>
        (
          await page.request.post("/api/v1/databases/sandbox-e2e/cli", {
            headers,
            data: { line: "BLPOP webqa:20261023:console:slot-probe 0.01" },
          })
        ).status(),
      { timeout: 10_000 },
    )
    .toBe(200);
}
test.describe("console review round 1", () => {
  test.use({ role: "operator", permissions: ["clipboard-read", "clipboard-write"] });
  test("Workbench Ctrl+C stops the script before its next line and says which lines ran (H1)", async ({
    page,
  }) => {
    await gotoView(page, "sandbox-e2e", "workbench");
    await blockingSlotFree(page);
    const key = `webqa:20261023:console:cancel:${Date.now()}`;
    await typeCommand(page, `PING\nBLPOP ${key}:empty 2\nSET ${key} after-cancel EX 60\nGET ${key}`, true);
    await delay(550); // the server's 2/s Workbench token bucket
    await page.keyboard.press(`${mod}+Enter`);
    const running = page.getByTestId("console-running");
    await expect(running).toContainText("Running");
    await expect(running).not.toContainText("0.0 s"); // BLPOP is blocking on Redis now
    const cancelRequest = page.waitForRequest((request) => request.url().endsWith("/workbench/cancel"));
    await page.keyboard.press("Control+c");
    await cancelRequest;
    await expect(page.locator(".run-header").first()).toContainText(
      "cancelled · 1 finished · line 2 may have run · 2 not run",
    );
    const results = page.getByTestId("console-result");
    await expect(results).toHaveCount(2);
    await expect(results.nth(0)).toHaveAttribute("data-status", "success");
    await expect(results.nth(1)).toHaveAttribute("data-status", "cancelled");
    await expect(results.nth(1)).toContainText("Redis may have run it");
    await expect(page.getByTestId("console-announcement")).toContainText(
      "1 of 4 finished; line 2 was running and may have run; 2 not run",
    );
    await expect(page.locator('.console-line-marker[aria-label^="success"]')).toHaveCount(1);
    await expect(page.locator('.console-line-marker[aria-label^="may have run"]')).toHaveCount(1);
    await expect(page.locator('.console-line-marker[aria-label^="not run"]')).toHaveCount(2);
    // Past the BLPOP timeout: the write after it was never sent.
    await delay(2300);
    await gotoView(page, "sandbox-e2e", "console");
    await runRead(page, `GET ${key}`);
    await expect(page.getByTestId("console-result").last()).toContainText("(nil)");
    await expect(page.getByTestId("result-explanation")).toHaveText("The key does not exist.");
  });

  test("if the server cannot be told, Workbench cancel closes the request, says it is unknown what ran, and the server still stops (H1)", async ({
    page,
    guards,
  }) => {
    guards.allowConsole(/Failed to load resource: net::ERR_FAILED/);
    await page.route(/\/workbench\/cancel$/, (route) => route.abort("failed"));
    await gotoView(page, "sandbox-e2e", "workbench");
    await blockingSlotFree(page);
    const key = `webqa:20261023:console:cancel-fallback:${Date.now()}`;
    await typeCommand(page, `BLPOP ${key}:empty 2\nSET ${key} after-cancel EX 60`, true);
    await delay(550);
    const aborted = page.waitForEvent("requestfailed", (request) => request.url().endsWith("/workbench"));
    await page.keyboard.press(`${mod}+Enter`);
    await expect(page.getByTestId("console-running")).not.toContainText("0.0 s");
    await page.keyboard.press("Control+c");
    expect((await aborted).failure()?.errorText).toContain("ERR_ABORTED");
    await expect(page.locator(".run-header").first()).toContainText("cancelled · which lines ran is unknown");
    await expect(page.getByTestId("console-result")).toContainText("which lines ran is unknown");
    await expect(page.locator('.console-line-marker[aria-label^="unknown"]')).toHaveCount(2);
    await delay(2300);
    await gotoView(page, "sandbox-e2e", "console");
    await runRead(page, `GET ${key}`);
    await expect(page.getByTestId("console-result").last()).toContainText("(nil)");
  });

  test("empty key argument: signature, Ctrl+Space keys and options; Enter runs a complete command; numeric cues (M2, L1)", async ({
    page,
  }) => {
    await gotoView(page, "sandbox-e2e", "console");
    await expect(editorInput(page)).toBeFocused(); // nothing was focused on arrival: ready to type
    const key = `webqa:20261023:console:complete:${Date.now()}`;
    await typeCommand(page, `SET ${key} v EX 60`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("console-result")).toHaveCount(1);
    await runRead(page, `SCAN 0 MATCH ${key}* COUNT 1000`);
    await expect(page.getByTestId("console-result").last()).toContainText(key);
    const signature = page.getByTestId("command-signature").locator("mark[aria-current]");
    // Typing the space after GET opens nothing by itself; the signature marks the key to type.
    await page.keyboard.press("Control+c");
    await page.keyboard.type("GET ");
    await expect(signature).toHaveText("key");
    await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
    await page.keyboard.press("Control+Space");
    const popup = page.locator(".cm-tooltip-autocomplete");
    await expect(popup).toContainText(key);
    await page.keyboard.press("Escape");
    for (const line of ["TYPE ", "MEMORY USAGE "]) {
      await typeCommand(page, line);
      await expect(signature, line).toHaveText("key");
    }
    // Options the command accepts, on request.
    await typeCommand(page, `SET ${key} v `);
    await page.keyboard.press("Control+Space");
    await expect(popup).toContainText("NX");
    await expect(popup).toContainText("KEEPTTL");
    await page.keyboard.press("Escape");
    // Numeric cues by type: integers refuse fractions, doubles accept infinities.
    await typeCommand(page, `EXPIRE ${key} 1.5`);
    await expect(tokens(page, "number")).toHaveClass(/console-token-invalid/);
    await typeCommand(page, `ZADD ${key}:z +inf member`);
    await expect(tokens(page, "number")).toHaveText("+inf");
    await expect(tokens(page, "number")).not.toHaveClass(/console-token-invalid/);
    // A command typed in full runs on the first Enter, even while its completion is open.
    await page.keyboard.press("Control+c");
    await page.keyboard.type("PING");
    await expect(popup).toContainText("PING");
    const count = await page.getByTestId("console-result").count();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("console-result")).toHaveCount(count + 1);
    await expect(page.getByTestId("console-result").last()).toContainText("PONG");
  });

  test("Esc from a result's actions returns to the editor, in the Console and the Workbench (M3)", async ({
    page,
  }) => {
    await gotoView(page, "sandbox-e2e", "console");
    await runRead(page, "GET webqa:20261023:console:esc");
    const block = page.getByTestId("console-result").last();
    for (const name of ["Collapse", "Copy result", "Re-run", /^Open key /]) {
      await page.keyboard.press("Alt+ArrowUp");
      await expect(block).toBeFocused();
      const action = block.getByRole("button", { name, exact: typeof name === "string" }).first();
      await tabToLocator(page, action);
      await page.keyboard.press("Escape");
      await expect(editorInput(page), String(name)).toBeFocused();
    }
    await gotoView(page, "sandbox-e2e", "workbench");
    await expect(editorInput(page, true)).toBeFocused();
    await typeCommand(page, "PING", true);
    await delay(550);
    await page.keyboard.press(`${mod}+Enter`);
    await expect(page.getByTestId("console-result")).toHaveCount(1);
    await page.keyboard.press("Alt+ArrowDown");
    await expect(page.getByTestId("console-result")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("console-result").getByRole("button", { name: "Collapse" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(editorInput(page, true)).toBeFocused();
  });

  test("a SCAN reply's keys are one Tab stop with arrow-key movement (UX 3)", async ({ page }) => {
    await gotoView(page, "sandbox-e2e", "console");
    const prefix = `webqa:20261023:console:roving:${Date.now()}`;
    for (const n of [1, 2, 3]) {
      await typeCommand(page, `SET ${prefix}:${n} v EX 60`);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("console-result")).toHaveCount(n);
    }
    await runRead(page, `SCAN 0 MATCH ${prefix}:* COUNT 1000`);
    const links = page.getByTestId("console-result").last().locator(".scan-keys .key-link");
    await expect(links).toHaveCount(3);
    await page.keyboard.press("Alt+ArrowUp");
    await tabToLocator(page, links.first());
    await page.keyboard.press("ArrowDown");
    await expect(links.nth(1)).toBeFocused();
    await page.keyboard.press("End");
    await expect(links.nth(2)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(links.nth(0)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab"); // leaves the list in one step
    await expect(links.nth(2)).not.toBeFocused();
    expect(await links.evaluateAll((nodes) => nodes.some((node) => node === document.activeElement))).toBe(false);
    // Shift+Tab comes back to the key that was last focused.
    await page.keyboard.press("Shift+Tab");
    await expect(links.nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(editorInput(page)).toBeFocused();
  });

  test("Workbench line policy and status are in the accessibility tree (M4)", async ({ page }) => {
    await gotoView(page, "sandbox-e2e", "workbench");
    await typeCommand(page, "PING\nSET webqa:20261023:console:a11y v\nDEL webqa:20261023:console:a11y\nFLUSHALL", true);
    // getByRole only finds what assistive technology can reach (the gutter itself is aria-hidden).
    const lines = page.getByRole("list", { name: "Script lines and their status" }).getByRole("listitem");
    await expect(lines).toHaveText([
      /^Line 1, PING: pending: read; /,
      /^Line 2, SET .*: pending: write; /,
      /^Line 3, DEL .*: pending: write; confirmation required; /,
      /^Line 4, FLUSHALL: pending: .*FLUSHALL is disabled/,
    ]);
    // The cursor is on line 4: its policy is part of the editor's description.
    await expect(editorInput(page, true)).toHaveAccessibleDescription(/Line 4: pending: .*FLUSHALL is disabled/);
    // After a run, lines skipped after an error say so.
    await typeCommand(page, "PING\nGET\nPING", true);
    await delay(550);
    await page.keyboard.press(`${mod}+Enter`);
    await expect(page.getByTestId("console-result")).toHaveCount(2);
    await expect(lines).toHaveText([/^Line 1, PING: success: read/, /^Line 2, GET: error: read/, /^Line 3, PING: not run: read/]);
    await expect(editorInput(page, true)).toHaveAccessibleDescription(/Line 3: not run: read/);
  });

  test("the shell stays usable while a view's code loads (L2)", async ({ page }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/assets\/Console-[^/]*\.js$/, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/db/sandbox-e2e/console");
    await expect(page.getByText("Opening view…")).toBeVisible();
    await expect(page.getByTestId("theme-toggle")).toBeVisible();
    await tabTo(page, "theme-toggle"); // reachable by keyboard while the view is still loading
    release();
    await expect(editorInput(page)).toBeVisible();
    await expect(page.getByText("Opening view…")).toHaveCount(0);
  });
});
