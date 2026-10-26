/**
 * v0.3 follow-up 7: pressing Enter right after the Console opens, before the database's command catalog (GET
 * …/commands) has loaded, said "unavailable for your role or database" for allowed commands such as SET (they have no
 * shared rule and are classified from the catalog). The Console now shows "Loading command info…", holds the command
 * and runs it once the catalog arrives; it never shows a false "unavailable".
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandDoc, DatabaseSummary } from "@rconsole/shared";
import { DatabaseContext } from "../lib/context.tsx";
import { MemoryProvider, useMemorySlot } from "../lib/memory.tsx";
import { commandPolicy } from "../lib/policy.ts";
import { keyboard } from "../lib/keyboard/registry.ts";
import { Console } from "./Console.tsx";

const SET: CommandDoc = { name: "SET", group: "string", summary: "Sets the string value of a key.", class: "write", allowed: true, arguments: [] };
const database = (over: Partial<DatabaseSummary> = {}): DatabaseSummary =>
  ({ id: "sandbox", name: "Sandbox", environment: "dev", readOnly: false, effectiveRole: "operator", features: { profiler: false }, status: "connected", db: 0, ...over }) as DatabaseSummary;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The draft is in session memory; seed it before the Console mounts. */
function Draft({ line }: { line: string }) {
  useMemorySlot("sandbox:console:draft", line);
  return null;
}

function mount(line: string, db = database()) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/db/sandbox/console"]}>
        <MemoryProvider>
          <Draft line={line} />
          <DatabaseContext value={db}>
            <Console />
          </DatabaseContext>
        </MemoryProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** fetch: the catalog answers when `release` is called (with `catalog`, or an error); /cli answers OK. */
function api() {
  const gates: (() => void)[] = [];
  const cli: unknown[] = [];
  let failNext = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/commands")) {
      await new Promise<void>((r) => gates.push(r));
      if (failNext) { failNext = false; return json({ error: { code: "unavailable", message: "Down" } }, 503); }
      return json({ commands: [SET] });
    }
    if (url.endsWith("/cli")) {
      cli.push(JSON.parse(String(init?.body)));
      return json({ argv: ["SET", "k", "v"], reply: { t: "status", v: "OK" }, durationMs: 1, commandClass: "write" });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetcher);
  return {
    cli,
    failNextCatalog: () => { failNext = true; },
    release: async () => { await waitFor(() => expect(gates.length).toBeGreaterThan(0)); await act(async () => { gates.shift()!(); }); },
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Console before the command catalog has loaded (v0.3 follow-up 7)", () => {
  it("policy: unknown class while loading or failed, never 'unavailable'; shared rules still apply", () => {
    const db = database();
    expect(commandPolicy("SET k v", [], db, "loading")).toMatchObject({ class: "loading", allowed: false, pending: true, hint: "Loading command info…" });
    expect(commandPolicy("SET k v", [], db, "error")).toMatchObject({ pending: true, hint: expect.stringContaining("could not be loaded") });
    expect(commandPolicy("SET k v", [], db, "ready")).toMatchObject({ class: "blocked", allowed: false, hint: "This command is unavailable for your role or database." });
    expect(commandPolicy("KEYS *", [], db, "loading")).toMatchObject({ class: "blocked", allowed: false });
    expect(commandPolicy("KEYS *", [], db, "loading").pending).toBeUndefined();
    expect(commandPolicy("SET k v", [SET], db, "loading")).toMatchObject({ class: "write", allowed: true });
  });

  it("Run before the catalog arrives shows 'Loading command info…', then runs the command once", async () => {
    const server = api();
    mount("SET k v");
    const badge = screen.getByTestId("policy-badge");
    expect(badge).toHaveTextContent("Loading command info…");
    expect(badge).not.toHaveTextContent(/unavailable|blocked/);
    const run = screen.getByTestId("console-run");
    expect(run).toBeEnabled();
    await userEvent.click(run);
    expect(screen.getByTestId("console-announcement")).toHaveTextContent("Loading command info… The command runs as soon as it has loaded.");
    expect(badge).toHaveTextContent("The command runs as soon as it has loaded.");
    expect(server.cli).toEqual([]);
    await server.release();
    await waitFor(() => expect(server.cli).toEqual([{ line: "SET k v" }]));
    expect(screen.getByTestId("console-announcement")).not.toHaveTextContent(/unavailable|Not run/);
  });

  it("Enter in the editor is held the same way", async () => {
    const server = api();
    const view = mount("SET k v");
    const disconnect = keyboard.connect(window);
    try {
      const editor = view.container.querySelector<HTMLElement>(".cm-content")!;
      editor.focus();
      fireEvent.keyDown(editor, { key: "Enter", code: "Enter", keyCode: 13 });
    } finally {
      disconnect();
    }
    expect(screen.getByTestId("console-announcement")).toHaveTextContent("Loading command info…");
    await server.release();
    await waitFor(() => expect(server.cli).toEqual([{ line: "SET k v" }]));
  });

  it("a failed catalog says so; Run retries it and then runs", async () => {
    const server = api();
    server.failNextCatalog();
    mount("SET k v");
    await server.release();
    await waitFor(() => expect(screen.getByTestId("policy-badge")).toHaveTextContent("Command info could not be loaded. Press Enter to try again."));
    expect(screen.getByTestId("policy-badge")).not.toHaveTextContent(/unavailable|blocked/);
    await userEvent.click(screen.getByTestId("console-run"));
    expect(screen.getByTestId("console-announcement")).toHaveTextContent("Loading command info…");
    await server.release();
    await waitFor(() => expect(server.cli).toEqual([{ line: "SET k v" }]));
  });

  it("once loaded, a command really unavailable for the role is still refused", async () => {
    const server = api();
    mount("SET k v", database({ effectiveRole: "viewer" }));
    await userEvent.click(screen.getByTestId("console-run"));
    await server.release();
    await waitFor(() => expect(screen.getByTestId("console-announcement")).toHaveTextContent("Not run. This command is unavailable for your role or database."));
    expect(server.cli).toEqual([]);
  });
});
