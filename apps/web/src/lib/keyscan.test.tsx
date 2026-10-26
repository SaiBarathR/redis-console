import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { binFromString } from "@rconsole/shared";
import { post } from "./api.ts";
import { readScanCount, useKeyScan, useScanCount } from "./keyscan.ts";
import { MemoryProvider } from "./memory.tsx";

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => localStorage.clear());

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

let scan: ReturnType<typeof useKeyScan>;
function Browser({ threshold = 10_000 }: { threshold?: number }) {
  scan = useKeyScan("db-w1", threshold);
  return null;
}
const app = (open: boolean, threshold?: number) => (
  <MemoryProvider>{open ? <Browser threshold={threshold} /> : <span>Guided</span>}</MemoryProvider>
);
const write = () =>
  act(async () => {
    await post("/databases/db-w1/ops", { op: "string.set", key: { enc: "utf8", data: "k" }, value: { enc: "utf8", data: "v" } });
  });

/** A fake keyspace of `size` keys served 2,000 slots per SCAN step, at most `perRequest` slots per request. */
function keyspace(size: number, perRequest = 4000) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.endsWith("/keys/names")) return json({ ok: true, result: { t: "status", v: "OK" } });
    const body = JSON.parse(String(init?.body)) as { cursor: string; scanThreshold: number; count: number };
    bodies.push(body);
    const from = Number(body.cursor);
    const to = Math.min(size, from + Math.min(perRequest, body.scanThreshold));
    return json({
      cursor: to >= size ? "0" : String(to),
      keys: Array.from({ length: to - from }, (_, i) => binFromString(`k:${from + i}`)),
      scanned: to - from,
      dbSize: size,
      threshold: Math.min(body.scanThreshold, 100_000),
    });
  });
  vi.stubGlobal("fetch", fetch);
  return { bodies, fetch };
}

describe("names-only key scan (v0.2.1)", () => {
  it("on open, continues with the cursor until 'Keys to scan' slots are covered, then stops", async () => {
    const { bodies } = keyspace(50_000);
    render(app(true, 10_000));
    await act(() => scan.start({ match: "*", type: "" }));
    // The server stops each request at its time budget (here 4,000 slots); the hook continues to the threshold.
    expect(bodies.map((b) => [b.cursor, b.scanThreshold])).toEqual([["0", 10_000], ["4000", 6000], ["8000", 2000]]);
    expect(bodies[0]).toMatchObject({ match: "*", count: 10_000 });
    expect(scan.state).toMatchObject({ done: false, scanned: 10_000, dbSize: 50_000, firstPage: 4000 });
    expect(scan.state?.keys).toHaveLength(10_000);
    // Scan more: another threshold from the cursor.
    await act(() => scan.more());
    expect(scan.state?.keys).toHaveLength(20_000);
    // Scan to end: drains the cursor.
    await act(() => scan.all());
    expect(scan.state).toMatchObject({ done: true, cursor: "0" });
    expect(scan.state?.keys).toHaveLength(50_000);
  });
  it("a small keyspace is complete after one request; duplicates from SCAN are listed once", async () => {
    const fetch = vi.fn(async () =>
      json({ cursor: "0", keys: [binFromString("a"), binFromString("a"), { enc: "base64", data: btoa("b") }], scanned: 3, dbSize: 2, threshold: 10_000 }),
    );
    vi.stubGlobal("fetch", fetch);
    render(app(true));
    await act(() => scan.start({ match: "*", type: "" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(scan.state).toMatchObject({ done: true, keys: [binFromString("a"), binFromString("b")] });
  });
  it("refresh re-reads as far as the list reached and replaces it at the end", async () => {
    const { bodies } = keyspace(6000);
    render(app(true, 10_000));
    await act(() => scan.start({ match: "x*", type: "hash" }));
    expect(scan.state?.done).toBe(true);
    bodies.length = 0;
    await act(() => scan.refresh({ background: true }));
    expect(bodies.map((b) => b.cursor)).toEqual(["0", "4000"]);
    expect(bodies[0]).toMatchObject({ match: "x*", type: "hash" });
    expect(scan.state?.keys).toHaveLength(6000);
  });
  it("waits and retries when the server says 429", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++calls === 1
          ? json({ error: { code: "rate_limited", message: "slow down" } }, 429)
          : json({ cursor: "0", keys: [binFromString("a")], scanned: 1, dbSize: 1, threshold: 10_000 }),
      ),
    );
    render(app(true));
    const started = scan.start({ match: "*", type: "" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
      await started;
    });
    vi.useRealTimers();
    expect(calls).toBe(2);
    expect(scan.state?.keys).toHaveLength(1);
    expect(scan.error).toBeUndefined();
  });
  it("Stop keeps what was found", async () => {
    keyspace(1_000_000, 2000);
    render(app(true, 2000));
    await act(() => scan.start({ match: "*", type: "" }));
    let running!: Promise<void>;
    act(() => {
      running = scan.all();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
      scan.halt();
      await running;
    });
    expect(scan.busy).toBeNull();
    expect(scan.state?.done).toBe(false);
    expect(scan.state!.keys.length).toBeGreaterThanOrEqual(2000);
  });
});

describe("'Keys to scan' preference", () => {
  it("defaults to 10,000, stores only the number, and ignores bad values", () => {
    expect(readScanCount()).toBe(10_000);
    let value!: ReturnType<typeof useScanCount>;
    function Probe() {
      value = useScanCount();
      return null;
    }
    render(<Probe />);
    act(() => value[1](50_000));
    expect(localStorage.getItem("rconsole.keyScanCount")).toBe("50000");
    expect(readScanCount()).toBe(50_000);
    act(() => value[1](10_000));
    expect(localStorage.getItem("rconsole.keyScanCount")).toBeNull();
    localStorage.setItem("rconsole.keyScanCount", "abc");
    expect(readScanCount()).toBe(10_000);
    localStorage.setItem("rconsole.keyScanCount", "99999999");
    expect(readScanCount()).toBe(10_000);
    expect(Object.keys(localStorage).filter((k) => k !== "rconsole.keyScanCount")).toEqual([]);
  });
});

describe("web review round 1: the key scan knows when it is older than the database (M3, M4)", () => {
  it("writes made while the key browser is closed mark the scan as outdated until a rescan", async () => {
    keyspace(10);
    const { rerender } = render(app(true));
    await act(() => scan.start({ match: "*", type: "" }));
    expect(scan.outdated).toBe(false);
    // The key browser's own write keeps the list current (it patches membership itself).
    await write();
    expect(scan.outdated).toBe(false);
    // A write from another page (key browser unmounted, e.g. Guided mode).
    rerender(app(false));
    await write();
    rerender(app(true));
    expect(scan.outdated).toBe(true);
    // A later key-browser write does not hide the older outside write.
    await write();
    expect(scan.outdated).toBe(true);
    await act(() => scan.refresh());
    expect(scan.outdated).toBe(false);
    // Changes the browser cannot place in the list, and key-count deltas.
    act(() => scan.patch((list) => list, 1));
    expect(scan.state?.dbSize).toBe(11);
    act(() => scan.markChanged());
    expect(scan.outdated).toBe(true);
  });
});
