import { Chart } from "./Chart.tsx";
import { MemoryProvider, useMemorySlot } from "../lib/memory.tsx";
import { Keys } from "../pages/Keys.tsx";
import type { ScanState } from "../lib/keyscan.ts";
import { MemoryRouter } from "react-router";
import { Guided } from "../pages/Guided.tsx";
import { request } from "../lib/api.ts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binFromBytes, binFromString, bytesFromBin, sha256Hex, type DatabaseSummary, type KeyDetails } from "@rconsole/shared";
import { DatabaseContext } from "../lib/context.tsx";
import { formatValue, parseValue, displayBin } from "../lib/format.ts";
import { ValueViewer } from "./ValueViewer.tsx";
import { jsonDocument } from "./ConsoleResult.tsx";
import { jsonPaths, KeyEditor } from "./KeyOperations.tsx";
import { KeyContent } from "./KeyContent.tsx";
import { InlineEdit } from "./InlineEdit.tsx";
import { JsonTree, Modal } from "./ui.tsx";

const db: DatabaseSummary = { id: "db", name: "DB", environment: "test", effectiveRole: "operator", features: { profiler: false }, readOnly: false, status: "connected" };
const wrap = (node: React.ReactNode) => <DatabaseContext value={db}>{node}</DatabaseContext>;
const source = '{"big":9007199254740993,"decimal":1.0,"exponent":1.5e3,"negativeZero":-0}';
const list = (text: string): KeyDetails => ({ key: binFromString("l"), type: "list", ttl: -1, value: { type: "list", offset: 0, total: 1, items: [{ index: 0, value: binFromString(text) }] } });

function RepeatedScan() {
  useMemorySlot<ScanState | undefined>("db:key-scan", {
    filter: { match: "one:*", type: "" }, cursor: "1", done: false, scanned: 599, dbSize: 465, threshold: 10_000,
    keys: [binFromString("one:key")], firstPage: 1, loadedAt: Date.now(), writes: 0,
  });
  return <Keys />;
}
afterEach(() => vi.unstubAllGlobals());
describe("web review round 2 medium", () => {
  it("L4: SCAN duplicates cannot make examined keys exceed the current key count", () => {
    render(<MemoryRouter><MemoryProvider>{wrap(<RepeatedScan />)}</MemoryProvider></MemoryRouter>);
    expect(screen.getByTestId("key-scan-summary")).toHaveTextContent("Results 1 · Scanned 465 / 465");
    expect(screen.queryByText(/599/)).toBeNull();
  });
  it("UX9: an empty chart takes only a compact waiting row", () => {
    render(<Chart samples={[]} label="Memory" />);
    expect(screen.getByRole("img")).toHaveStyle({ minHeight: "48px" });
  });
  it("M1: existing strings keep expiry by default and allow explicit removal", async () => {
    const fetch = vi.fn(async (_url: unknown, _options?: RequestInit) => new Response(JSON.stringify({ ok: true, result: { t: "str", v: binFromString("OK") } })));
    vi.stubGlobal("fetch", fetch);
    const details: KeyDetails = { key: binFromString("s"), type: "string", ttl: 3600, value: { type: "string", value: binFromString("old"), truncated: false, totalBytes: 3 } };
    render(wrap(<KeyEditor details={details} onClose={() => {}} onSaved={async () => {}} />));
    await userEvent.clear(screen.getByTestId("key-edit-value"));
    await userEvent.type(screen.getByTestId("key-edit-value"), "new");
    await userEvent.click(screen.getByTestId("key-save"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    // SET … KEEPTTL through the checked typed op since web review v0.2 r3 (it carries what the editor opened).
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ op: "string.set", key: binFromString("s"), value: binFromString("new"), keepTtl: true, expect: { type: "string", sha256: sha256Hex(new TextEncoder().encode("old")) } });
    await userEvent.click(screen.getByRole("checkbox", { name: /Keep current expiry/ }));
    await userEvent.click(screen.getByTestId("key-save"));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const operation = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
    expect(operation).toMatchObject({ op: "string.set", value: binFromString("new") });
    expect(operation).not.toHaveProperty("ttl");
    expect(operation).not.toHaveProperty("keepTtl");
  });
  it("M4: background requests carry the header without emitting activity", async () => {
    const fetch = vi.fn(async (_url: unknown, _options?: RequestInit) => new Response("{}")); vi.stubGlobal("fetch", fetch);
    const activity = vi.fn(); window.addEventListener("rconsole:request-completed", activity);
    try {
      await request("/databases", { background: true });
      expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ "X-RC-Background": "1" });
      expect(activity).not.toHaveBeenCalled();
      await request("/databases"); expect(activity).toHaveBeenCalledTimes(1);
    } finally { window.removeEventListener("rconsole:request-completed", activity); }
  });
  it("M7 / UX4: Guided states the empty pattern, explains results, clears stale results", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, _options?: RequestInit) => new Response(JSON.stringify({ argv: ["EXPIRE", "missing", "3600"], reply: { t: "int", v: "0" }, commandClass: "write", durationMs: 1 }))));
    render(<MemoryRouter><MemoryProvider>{wrap(<Guided />)}</MemoryProvider></MemoryRouter>);
    expect(screen.getByTestId("guided-key")).toHaveAttribute("placeholder", "e.g. session:*");
    expect(screen.getByText(/Empty pattern matches every key/)).toBeVisible();
    await userEvent.click(screen.getByTestId("guided-ttl"));
    await userEvent.type(screen.getByTestId("guided-key"), "missing");
    await userEvent.click(screen.getByTestId("guided-run"));
    expect(await screen.findByText("The key does not exist; nothing changed.")).toBeVisible();
    await userEvent.type(screen.getByTestId("guided-key"), "-new");
    expect(screen.queryByText("The key does not exist; nothing changed.")).toBeNull();
    expect(screen.queryByText("Done")).toBeNull();
  });
  it("M2: inline CRLF values open as exact Base64 bytes", async () => {
    const save = vi.fn(async () => {});
    render(<InlineEdit value={binFromString("a\r\nb\r\nc")} label="Value" onSave={save} onClose={() => {}} />);
    const field = screen.getByRole("textbox");
    expect(field).toHaveValue(btoa("a\r\nb\r\nc"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({ enc: "base64", data: btoa("a\r\nb\r\nc") });
    expect(displayBin(binFromString("a\r\nb"))).toBe("a\\u000d\nb");
  });
  it("M2: string CRLF editor opens in Base64 mode", () => {
    const details: KeyDetails = { key: binFromString("s"), type: "string", ttl: 3600, value: { type: "string", value: binFromString("a\r\nb"), truncated: false, totalBytes: 4 } };
    render(wrap(<KeyEditor details={details} onClose={() => {}} onSaved={async () => {}} />));
    expect(screen.getByTestId("key-edit-encoding")).toHaveValue("base64");
    expect(screen.getByTestId("key-edit-value")).toHaveValue(btoa("a\r\nb"));
  });
  it("M3: collection cells show stored numbers beside date hints", () => {
    render(wrap(<KeyContent details={list("1700000000")} refresh={async () => {}} />));
    expect(screen.getByText("1700000000")).toBeVisible();
    // The hint wraps only between date and time, so its text spans two inner spans.
    const hint = screen.getByText(/Timestamp hint:/);
    expect(hint).toBeVisible();
    expect(hint).toHaveTextContent("Timestamp hint: 2023-11-14T22:13:20.000Z");
  });
  it("M5: dialog focuses first field and returns to trigger", async () => {
    const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
    const { unmount } = render(<Modal title="Edit" onClose={() => {}}><input aria-label="Name" /></Modal>);
    expect(screen.getByLabelText("Name")).toHaveFocus();
    unmount(); expect(trigger).toHaveFocus(); trigger.remove();
  });
});
