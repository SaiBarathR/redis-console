import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { binFromString, type Bin, type DatabaseSummary } from "@rconsole/shared";
import { DatabaseContext } from "../lib/context.tsx";
import { MemoryProvider } from "../lib/memory.tsx";
import { Keys } from "./Keys.tsx";

const operator: DatabaseSummary = { id: "db", name: "DB", environment: "test", effectiveRole: "operator", features: { profiler: false }, readOnly: false, status: "connected" };
const viewer: DatabaseSummary = { ...operator, effectiveRole: "viewer" };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

// The virtual list needs a viewport: jsdom has no layout (the virtualizer reads clientHeight/clientWidth).
const saved = ["clientHeight", "clientWidth"].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const);
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 520 });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 480 });
});
afterAll(() => {
  for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
});
afterEach(() => vi.unstubAllGlobals());

/** A large folder (126 keys), a small one (24) and two loose keys: 152 keys, more than the 150 that start collapsed. */
const KEYS = [
  ...Array.from({ length: 126 }, (_, i) => `example:big:${i}`),
  ...Array.from({ length: 24 }, (_, i) => `example:small:${i}`),
  "example:cfg",
  "example:cfg2",
];
function api(o: { cursor?: string; metadataGate?: Promise<void> } = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace(/^.*\/databases\/db/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, body });
    if (path === "/keys/names") {
      const match = String(body.match);
      const prefix = match.endsWith("*") ? match.slice(0, -1).replace(/\\(.)/g, "$1") : match;
      const keys = KEYS.filter((k) => k.startsWith(prefix)).map(binFromString);
      return json({ cursor: match === "*" ? (o.cursor ?? "0") : "0", keys, scanned: KEYS.length, dbSize: KEYS.length, threshold: 10_000 });
    }
    if (path === "/keys/meta") {
      await o.metadataGate;
      return json({
        keys: (body.keys as Bin[]).map((key) => ({ key, type: "string", ...(body.ttl === false ? {} : { ttl: -1 }), ...(body.size === false ? {} : { size: 64 }) })),
      });
    }
    if (path === "/keys/scan") return json({ cursor: "0", keys: [], scanned: 0, dbSize: KEYS.length });
    return json({});
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}
const mount = (db = operator) =>
  render(
    <MemoryRouter>
      <MemoryProvider>
        <DatabaseContext value={db}>
          <Keys />
        </DatabaseContext>
      </MemoryProvider>
    </MemoryRouter>,
  );
const folder = (name: string) => screen.getAllByTestId("key-folder").find((row) => row.textContent?.startsWith(name))!;

describe("key browser v0.2.1", () => {
  it("opens with the whole namespace tree from names only: counts, % of results, Results · Scanned / DBSIZE", async () => {
    const calls = api();
    mount();
    const summary = await screen.findByTestId("key-scan-summary");
    await waitFor(() => expect(summary).toHaveAttribute("data-done", "true"));
    expect(summary).toHaveTextContent("Results 152 · Scanned 152 / 152");
    expect(calls.filter((c) => c.path === "/keys/names")).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ cursor: "0", match: "*", count: 10_000, scanThreshold: 10_000 });
    // More than 150 keys: folders start collapsed, single-child chains open (example: → big, small).
    const big = folder("big");
    expect(big).toHaveTextContent("126");
    expect(big).toHaveTextContent("83%");
    expect(big.getAttribute("title")).toContain("example:big:*");
    expect(big.getAttribute("title")).toContain("82.89% of matching keys");
    expect(folder("small")).toHaveTextContent("16%");
    expect(screen.getByTestId("key-share-note")).toHaveTextContent("folder %");
    expect(screen.getByTestId("key-share-note")).toHaveAttribute("title", "The percentage on each folder row: its share of matching keys");
    // Only folders are on screen except the two loose keys: metadata is asked for those rows only.
    await waitFor(() => expect(calls.some((c) => c.path === "/keys/meta")).toBe(true));
    const meta = calls.filter((c) => c.path === "/keys/meta");
    expect(meta).toHaveLength(1);
    expect((meta[0]!.body.keys as Bin[]).map((k) => k.data).sort()).toEqual(["example:cfg", "example:cfg2"]);
  });

  it("loads type, TTL and size lazily for rows coming into view, with placeholders until then", async () => {
    let release!: () => void;
    const metadataGate = new Promise<void>(resolve => { release = resolve; });
    const calls = api({ metadataGate });
    mount();
    await waitFor(() => expect(screen.getByTestId("key-scan-summary")).toHaveAttribute("data-done", "true"));
    await userEvent.click(folder("small"));
    const rows = await screen.findAllByTestId("key-row");
    try { expect(rows.some((row) => row.getAttribute("data-meta") === "pending")).toBe(true); }
    finally { release(); }
    await waitFor(() => expect(screen.getAllByTestId("key-row").every((row) => row.getAttribute("data-meta") === "loaded")).toBe(true));
    const batches = calls.filter((c) => c.path === "/keys/meta").map((c) => (c.body.keys as Bin[]).length);
    expect(batches.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(26);
    // The folder's size sum is complete once every key below it has metadata.
    await waitFor(() => expect(folder("small")).toHaveTextContent("1.5 KiB"));
    expect(folder("big").querySelector(".folder-bytes")).toHaveTextContent("");
  });

  it("folder actions: filter to the folder, and delete its keys through the confirmed bulk delete", async () => {
    const calls = api();
    mount();
    await waitFor(() => expect(screen.getByTestId("key-scan-summary")).toHaveAttribute("data-done", "true"));
    await userEvent.click(within(folder("small")).getByTestId("folder-delete"));
    const dialog = await screen.findByTestId("bulk-delete-dialog");
    expect(within(dialog).getByTestId("bulk-delete-pattern")).toHaveValue("example:small:*");
    expect(calls.some((c) => c.path.startsWith("/bulk-delete"))).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: /close/i }));
    await userEvent.click(within(folder("big")).getByTestId("folder-filter"));
    await waitFor(() => expect(calls.filter((c) => c.path === "/keys/names").at(-1)!.body.match).toBe("example:big:*"));
    expect(screen.getByTestId("key-pattern")).toHaveValue("example:big:*");
    await waitFor(() => expect(screen.getByTestId("key-scan-summary")).toHaveTextContent("Results 126"));
  });

  it("viewers can filter to a folder but get no delete action", async () => {
    api();
    mount(viewer);
    await waitFor(() => expect(screen.getByTestId("key-scan-summary")).toHaveAttribute("data-done", "true"));
    expect(within(folder("big")).getByTestId("folder-filter")).toBeInTheDocument();
    expect(within(folder("big")).queryByTestId("folder-delete")).toBeNull();
  });

  it("partial inventories say so: percentages of loaded matches, and Scan more", async () => {
    api({ cursor: "123" });
    mount();
    await waitFor(() => expect(screen.getByTestId("key-scan-summary")).toHaveTextContent("Results 152"));
    expect(screen.getByTestId("key-scan-summary")).toHaveAttribute("data-done", "false");
    expect(screen.getByTestId("key-share-note")).toHaveTextContent("folder %");
    expect(screen.getByTestId("key-share-note")).toHaveAttribute("title", "The percentage on each folder row: its share of loaded matches");
    expect(folder("big").getAttribute("title")).toContain("of loaded matches");
    expect(screen.getByTestId("key-load-more")).toHaveTextContent("Scan more");
    expect(screen.getByTestId("key-load-more")).toBeEnabled();
  });

  it("Tree/List toggle keeps the delimiter; the column chooser stops reading hidden columns", async () => {
    const calls = api();
    mount();
    await waitFor(() => expect(screen.getByTestId("key-scan-summary")).toHaveAttribute("data-done", "true"));
    await userEvent.click(screen.getByTestId("key-view-list"));
    expect(screen.queryAllByTestId("key-folder")).toHaveLength(0);
    expect(screen.queryByTestId("key-delimiter")).toBeNull();
    await userEvent.click(screen.getByTestId("key-columns"));
    await userEvent.click(screen.getByTestId("key-column-size"));
    await userEvent.click(screen.getByTestId("key-column-ttl"));
    // Rows not loaded yet are asked without PTTL / MEMORY USAGE.
    await userEvent.click(screen.getByTestId("key-sort-name"));
    await waitFor(() => expect(calls.filter((c) => c.path === "/keys/meta").some((c) => c.body.size === false && c.body.ttl === false)).toBe(true));
    await userEvent.click(screen.getByTestId("key-view-tree"));
    expect(screen.getByTestId("key-delimiter")).toHaveValue(":");
    expect(screen.getAllByTestId("key-folder").length).toBeGreaterThan(0);
  });

  it("descending name sort reverses folders and keys", async () => {
    api();
    mount();
    await waitFor(() => expect(screen.getByTestId("key-scan-summary")).toHaveAttribute("data-done", "true"));
    const order = () =>
      screen.getAllByRole("treeitem").map((row) => row.querySelector(".key-anatomy")?.textContent ?? (row.getAttribute("aria-label") ?? "").split(" ")[0]);
    expect(order()).toEqual(["example:", "example:big:", "example:small:", "example:cfg", "example:cfg2"]);
    expect(screen.getByTestId("key-sort-name")).toHaveAttribute("aria-pressed", "true");
    // The row text is the full key (anatomy hides the folder path visually only).
    await userEvent.click(screen.getByTestId("key-sort-name"));
    expect(order()).toEqual(["example:", "example:small:", "example:big:", "example:cfg2", "example:cfg"]);
  });

  it("refresh re-reads names from cursor 0 and shows the last refresh age; auto-refresh is opt-in", async () => {
    const calls = api();
    mount();
    await waitFor(() => expect(screen.getByTestId("key-scan-summary")).toHaveAttribute("data-done", "true"));
    expect(screen.getByTestId("key-last-refresh")).toHaveTextContent("Refreshed now");
    expect(screen.getByTestId("key-auto-refresh")).toHaveValue("0");
    await userEvent.click(screen.getByTestId("key-refresh"));
    await waitFor(() => expect(calls.filter((c) => c.path === "/keys/names")).toHaveLength(2));
    expect(calls.filter((c) => c.path === "/keys/names")[1]!.body.cursor).toBe("0");
  });

  it("auto-refresh runs on its interval and pauses while keys are selected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const calls = api();
      mount();
      await waitFor(() => expect(screen.getByTestId("key-scan-summary")).toHaveAttribute("data-done", "true"));
      fireEvent.change(screen.getByTestId("key-auto-refresh"), { target: { value: "5" } });
      const names = () => calls.filter((c) => c.path === "/keys/names").length;
      await act(() => vi.advanceTimersByTimeAsync(5100));
      await waitFor(() => expect(names()).toBe(2));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all loaded keys" }));
      await act(() => vi.advanceTimersByTimeAsync(11_000));
      expect(names()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
