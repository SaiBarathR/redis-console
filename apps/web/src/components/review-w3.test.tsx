/** Web review v0.2 round 3: drafts bound to what they opened, compare-and-set edits, exact MessagePack, honest copies. */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
import {
  binFromBytes,
  binFromString,
  bytesFromBin,
  sha256Hex,
  type Bin,
  type DatabaseSummary,
  type EditConflict,
  type KeyDetails,
} from "@rconsole/shared";
import { DatabaseContext } from "../lib/context.tsx";
import { MemoryProvider } from "../lib/memory.tsx";
import { formatValue } from "../lib/format.ts";
import { parseJson } from "../lib/json.ts";
import { cliReply } from "./Reply.tsx";
import { KeyContent } from "./KeyContent.tsx";
import { KeyInspector } from "./KeyInspector.tsx";
import { jsonPaths } from "./KeyOperations.tsx";
import { JsonTree } from "./ui.tsx";
import { ValueViewer } from "./ValueViewer.tsx";

const db: DatabaseSummary = { id: "db", name: "DB", environment: "test", effectiveRole: "operator", features: { profiler: false }, readOnly: false, status: "connected" };
const wrap = (node: React.ReactNode) => <DatabaseContext value={db}>{node}</DatabaseContext>;
const digest = (b: Bin) => sha256Hex(bytesFromBin(b));
const text = (s: string) => sha256Hex(new TextEncoder().encode(s));
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const hash = (value: Bin, extra: Partial<KeyDetails["value"] & { type: "hash" }> = {}): KeyDetails => ({
  key: binFromString("h"), type: "hash", ttl: -1,
  value: { type: "hash", cursor: "0", total: 1, entries: [{ field: binFromString("f"), value }], ...extra },
});

/** Records every request body by path; `answer` decides the response. */
function server(answer: (path: string, body: any) => Response | undefined) {
  const sent: { path: string; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = String(url).replace(/^\/api\/v1\/databases\/db/, "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ path, body });
    return answer(path, body) ?? json({ ok: true, result: { t: "str", v: binFromString("OK") } });
  }));
  return sent;
}
const ops = (sent: { path: string; body: any }[]) => sent.filter((r) => r.path === "/ops").map((r) => r.body);

describe("H1: an open hash draft keeps the byte interpretation it opened with", () => {
  const view = (details: KeyDetails) => wrap(<KeyContent details={details} refresh={async () => {}} />);
  it.each([
    ["UTF-8 text to binary", binFromString("YWJj"), binFromBytes(new Uint8Array([0xff, 0x00, 0x0d]))],
    ["UTF-8 text to CRLF text", binFromString("YWJj"), binFromString("a\r\nb")],
    ["binary to UTF-8 text", binFromBytes(new Uint8Array([0xff, 0x00, 0x0d])), binFromString("REVG")],
  ])("%s: the refreshed field closes the draft and nothing is written", async (_name, before, after) => {
    const sent = server(() => undefined);
    const { rerender } = render(view(hash(before)));
    await userEvent.click(screen.getByRole("button", { name: "Edit hash field f" }));
    const field = screen.getByLabelText("Value of f");
    await userEvent.clear(field);
    await userEvent.type(field, "REVG");
    rerender(view(hash(after)));
    expect(screen.queryByLabelText("Value of f")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/field changed/i);
    expect(ops(sent)).toEqual([]);
  });
  it("an identical refresh keeps the draft, its encoding and its expectation", async () => {
    const sent = server(() => undefined);
    const { rerender } = render(view(hash(binFromString("YWJj"))));
    await userEvent.click(screen.getByRole("button", { name: "Edit hash field f" }));
    const field = screen.getByLabelText("Value of f");
    await userEvent.clear(field);
    await userEvent.type(field, "REVG");
    rerender(view(hash(binFromString("YWJj"))));
    expect(screen.getByText("(UTF-8)")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(ops(sent)).toHaveLength(1));
    expect(ops(sent)[0]).toEqual({ op: "hash.set", key: binFromString("h"), entries: [{ field: binFromString("f"), value: binFromString("REVG") }], expect: { type: "hash", sha256: text("YWJj") } });
  });
});

/** A key inspector whose reads answer from `reads` (the last entry repeats; a number is an error status). */
function inspector(reads: (KeyDetails | number)[], opsAnswer?: (body: any) => Response | undefined) {
  let n = 0;
  const sent = server((path, body) => {
    if (path === "/key/read") {
      const read = reads[Math.min(n++, reads.length - 1)]!;
      return typeof read === "number" ? json({ error: { code: "not_found", message: "Key does not exist." } }, read) : json(read);
    }
    if (path === "/ops") return opsAnswer?.(body);
    return undefined;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <MemoryProvider>
        <QueryClientProvider client={client}>{wrap(<KeyInspector selected={(reads[0] as KeyDetails).key} delimiter=":" onDeleted={() => {}} />)}</QueryClientProvider>
      </MemoryProvider>
    </MemoryRouter>,
  );
  return { sent, refresh: () => userEvent.click(screen.getByRole("button", { name: "Refresh key" })) };
}
const str = (s: string, key = "k"): KeyDetails => ({ key: binFromString(key), type: "string", ttl: 3600, value: { type: "string", value: binFromString(s), truncated: false, totalBytes: s.length } });
const doc = (s: string): KeyDetails => ({ key: binFromString("j"), type: "ReJSON-RL", ttl: -1, value: { type: "json", json: s, truncated: false } });

describe("inline editors and type conflicts", () => {
  it("a row editor whose key was deleted offers Reload only", async () => {
    const conflict: EditConflict = { reason: "type", expected: { type: "hash", sha256: text("YWJj") }, current: { type: "none", expect: { type: "none" } } };
    const sent = server((path) => (path === "/ops" ? json({ error: { code: "conflict", message: "This key no longer exists; nothing was written.", conflict } }, 409) : undefined));
    render(wrap(<KeyContent details={hash(binFromString("YWJj"))} refresh={async () => {}} />));
    await userEvent.click(screen.getByRole("button", { name: "Edit hash field f" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const notice = await screen.findByTestId("edit-conflict");
    expect(notice).toHaveTextContent("The key no longer exists.");
    expect(within(notice).queryByTestId("edit-conflict-overwrite")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(ops(sent)).toHaveLength(1);
  });
});

describe("H2: the main editor is bound to the snapshot it opened", () => {
  it("A: a string editor that observes the key become a hash cannot replace it", async () => {
    const asHash: KeyDetails = { ...hash(binFromString("KEEP-ME")), key: binFromString("k") };
    const { sent, refresh } = inspector([str("ORIGINAL"), asHash]);
    await userEvent.click(await screen.findByTestId("key-edit"));
    const dialog = screen.getByTestId("key-editor-dialog");
    expect(within(dialog).getByRole("heading")).toHaveTextContent("Edit value");
    await userEvent.clear(within(dialog).getByTestId("key-edit-value"));
    await userEvent.type(within(dialog).getByTestId("key-edit-value"), "EDITED");
    await refresh();
    const conflict = await within(dialog).findByTestId("edit-conflict");
    expect(conflict).toHaveTextContent(/changed since you opened it/);
    expect(conflict).toHaveTextContent(/now a hash/);
    // The title, the form and the operation still describe the string it opened; Save is unavailable.
    expect(within(dialog).getByRole("heading")).toHaveTextContent("Edit value");
    expect(within(dialog).getByTestId("key-save")).toBeDisabled();
    expect(within(conflict).queryByTestId("edit-conflict-overwrite")).toBeNull();
    await userEvent.click(within(dialog).getByTestId("key-save"));
    expect(ops(sent)).toEqual([]);
  });
  it("B: a JSON path draft whose array item moved cannot overwrite the item now at that index", async () => {
    const before = '{"items":[{"id":"A","v":1},{"id":"B","v":2}]}';
    const after = '{"items":[{"id":"X","v":0},{"id":"A","v":1},{"id":"B","v":2}]}';
    const { sent, refresh } = inspector([doc(before), doc(after)]);
    await userEvent.click(await screen.findByTestId("key-edit"));
    const dialog = screen.getByTestId("key-editor-dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText("Pick a JSON path"), '$["items"][1]');
    await userEvent.clear(within(dialog).getByTestId("key-edit-value"));
    await userEvent.type(within(dialog).getByTestId("key-edit-value"), '{{"id":"B","v":99}');
    await refresh();
    const conflict = await within(dialog).findByTestId("edit-conflict");
    expect(within(conflict).getByTestId("edit-conflict-current")).toHaveTextContent('"id":"X"');
    expect(within(dialog).getByTestId("key-save")).toBeDisabled();
    expect(ops(sent)).toEqual([]);
    // Overwrite anyway is an explicit choice that sends the new expectation (never skips the check).
    await userEvent.click(within(conflict).getByTestId("edit-conflict-overwrite"));
    await waitFor(() => expect(ops(sent)).toHaveLength(1));
    expect(ops(sent)[0]).toEqual({ op: "json.set", key: binFromString("j"), path: '$["items"][1]', json: '{"id":"B","v":99}', expect: { type: "ReJSON-RL", sha256: text(after) } });
  });
  it("every save carries what the editor opened; a 409 shows the current value with Reload and Overwrite anyway", async () => {
    const current = binFromString("theirs");
    const conflict: EditConflict = { reason: "value", expected: { type: "string", sha256: text("opened") }, current: { type: "string", value: current, expect: { type: "string", sha256: digest(current) } } };
    let answered = 0;
    const { sent } = inspector([str("opened")], () => (answered++ === 0 ? json({ error: { code: "conflict", message: "This value changed since you opened it; nothing was written.", conflict } }, 409) : undefined));
    await userEvent.click(await screen.findByTestId("key-edit"));
    const dialog = screen.getByTestId("key-editor-dialog");
    await userEvent.clear(within(dialog).getByTestId("key-edit-value"));
    await userEvent.type(within(dialog).getByTestId("key-edit-value"), "mine");
    await userEvent.click(within(dialog).getByTestId("key-save"));
    const notice = await within(dialog).findByTestId("edit-conflict");
    expect(within(notice).getByTestId("edit-conflict-current")).toHaveTextContent("theirs");
    expect(within(notice).getByTestId("edit-conflict-diff")).toHaveTextContent("- opened");
    expect(within(notice).getByTestId("edit-conflict-diff")).toHaveTextContent("+ theirs");
    expect(within(notice).getByTestId("edit-conflict-reload")).toBeVisible();
    expect(ops(sent)[0]).toEqual({ op: "string.set", key: binFromString("k"), value: binFromString("mine"), keepTtl: true, expect: { type: "string", sha256: text("opened") } });
    await userEvent.click(within(notice).getByTestId("edit-conflict-overwrite"));
    await waitFor(() => expect(ops(sent)).toHaveLength(2));
    expect(ops(sent)[1]).toMatchObject({ op: "string.set", value: binFromString("mine"), expect: { type: "string", sha256: digest(current) } });
    await waitFor(() => expect(screen.queryByTestId("key-editor-dialog")).toBeNull());
  });
  it("Reload after a conflict closes the editor when the key is gone, and offers no overwrite of a deleted key", async () => {
    const conflict: EditConflict = { reason: "type", expected: { type: "string", sha256: text("opened") }, current: { type: "none", expect: { type: "none" } } };
    const { sent } = inspector([str("opened"), 404], () => json({ error: { code: "conflict", message: "This key no longer exists; nothing was written.", conflict } }, 409));
    await userEvent.click(await screen.findByTestId("key-edit"));
    const dialog = screen.getByTestId("key-editor-dialog");
    await userEvent.click(within(dialog).getByTestId("key-save"));
    const notice = await within(dialog).findByTestId("edit-conflict");
    expect(notice).toHaveTextContent("The key no longer exists.");
    expect(within(notice).queryByTestId("edit-conflict-overwrite")).toBeNull();
    await userEvent.click(within(notice).getByTestId("edit-conflict-reload"));
    await waitFor(() => expect(screen.queryByTestId("key-editor-dialog")).toBeNull());
    expect(ops(sent)).toHaveLength(1);
  });
  it("delete and rename from the inspector carry the key's type and value", async () => {
    const { sent } = inspector([str("v1")]);
    await userEvent.click(await screen.findByTestId("key-delete"));
    await waitFor(() => expect(ops(sent)).toHaveLength(1));
    expect(ops(sent)[0]).toEqual({ op: "key.delete", keys: [binFromString("k")], expect: { type: "string", sha256: text("v1") } });
  });
});

describe("H3: MessagePack keeps exact integers and non-JSON scalars", () => {
  const mp = (bytes: number[]) => formatValue(binFromBytes(new Uint8Array(bytes)), "msgpack");
  it.each([
    ["uint64 2^53 + 1", [0xcf, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01], "9007199254740993"],
    ["int64 -(2^53 + 1)", [0xd3, 0xff, 0xdf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], "-9007199254740993"],
    ["uint64 max", [0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], "18446744073709551615"],
    ["float64 negative zero", [0xcb, 0x80, 0, 0, 0, 0, 0, 0, 0], "-0.0"],
    ["float64 +infinity", [0xcb, 0x7f, 0xf0, 0, 0, 0, 0, 0, 0], "Infinity"],
    ["float64 -infinity", [0xcb, 0xff, 0xf0, 0, 0, 0, 0, 0, 0], "-Infinity"],
    ["float64 NaN", [0xcb, 0x7f, 0xf8, 0, 0, 0, 0, 0, 0], "NaN"],
    ["float64 3.0", [0xcb, 0x40, 0x08, 0, 0, 0, 0, 0, 0], "3.0"],
    ["timestamp 32", [0xd6, 0xff, 0x00, 0x00, 0x00, 0x01], 'Timestamp("1970-01-01T00:00:01Z")'],
    ["timestamp 96 with nanoseconds", [0xc7, 12, 0xff, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 1], 'Timestamp("1970-01-01T00:00:01.000000005Z")'],
    ["binary", [0xc4, 0x03, 0x00, 0x01, 0xff], 'Binary("AAH/")'],
    ["extension", [0xd4, 0x05, 0x2a], 'Ext(5, 1 byte, 0x2a)'],
  ])("%s", (_name, bytes, shown) => {
    expect(mp(bytes)).toBe(shown);
  });
  it("maps keep their order, duplicate and non-string keys; nested big integers stay exact", () => {
    // {"n": uint64 2^53+1, 1: "one", "n": true}
    const bytes = [0x83, 0xa1, 0x6e, 0xcf, 0x00, 0x20, 0, 0, 0, 0, 0, 0x01, 0x01, 0xa3, 0x6f, 0x6e, 0x65, 0xa1, 0x6e, 0xc3];
    expect(mp(bytes)).toBe('{\n  "n": 9007199254740993,\n  1: "one",\n  "n": true\n}');
  });
  it("ordinary documents still read as JSON", () => {
    expect(formatValue(binFromBytes(encode({ key: "<img>", value: [1, 2.5, null] })), "msgpack")).toBe('{\n  "key": "<img>",\n  "value": [\n    1,\n    2.5,\n    null\n  ]\n}');
  });
  it("the MsgPack view and its copy hold the exact integer", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<ValueViewer value={binFromBytes(new Uint8Array([0x81, 0xa1, 0x6e, 0xcf, 0x00, 0x20, 0, 0, 0, 0, 0, 0x01]))} />);
    await userEvent.click(screen.getByRole("tab", { name: "MsgPack" }));
    expect(screen.getByTestId("key-value")).toHaveTextContent("9007199254740993");
    await userEvent.click(screen.getByRole("button", { name: "Copy value" }));
    expect(writeText).toHaveBeenCalledWith('{\n  "n": 9007199254740993\n}');
  });
});

describe("M1: display limits never cut what Copy copies", () => {
  const long = `{"big":"${"x".repeat(120_000)}","end":9007199254740993}`;
  it("JSON: the view says it is capped; Copy value copies the whole document", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<ValueViewer value={binFromString(long)} preferred="json" />);
    expect(screen.getByTestId("key-value")).toHaveTextContent(/more characters not shown/);
    await userEvent.click(screen.getByRole("button", { name: "Copy value" }));
    const copied = writeText.mock.calls[0]![0];
    expect(() => parseJson(copied)).not.toThrow();
    expect(copied).toContain("9007199254740993");
    expect(copied.replace(/\s/g, "")).toBe(long);
  });
  it("Console: string replies are copied whole; the transcript marks what it does not show", () => {
    const reply = { t: "str" as const, v: binFromString("y".repeat(120_000)) };
    expect(cliReply(reply)).toBe(`"${"y".repeat(120_000)}"`);
  });
  it("Tree: long strings carry an omission marker", () => {
    const { container } = render(<JsonTree value={"z".repeat(12_000)} />);
    expect(container.textContent).toContain("2,000 more characters");
  });
});

describe("M2: the value inspector keeps the server's truncation flag", () => {
  it("a truncated hash value opens as a labelled preview without structured decoding", async () => {
    const details = hash(binFromString('{"a":1}'), { entries: [{ field: binFromString("f"), value: binFromString('{"a":1}'), truncated: true }] });
    render(wrap(<KeyContent details={details} refresh={async () => {}} />));
    await userEvent.click(screen.getAllByTestId("value-cell-open")[1]!);
    const dialog = screen.getByTestId("value-inspector-dialog");
    expect(within(dialog).getByText(/truncated preview/i)).toBeVisible();
    expect(within(dialog).getByRole("tab", { name: "JSON" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Copy preview" })).toBeVisible();
  });
});

describe("L1: generated JSON paths use the RedisJSON bracket grammar", () => {
  it("escapes only quote and backslash; control characters stay literal and line breaks are not offered", () => {
    const paths = jsonPaths(parseJson('{"a\\nb":"target","a\\\\nb":"decoy","q\\"x":1,"t\\tx":2,"z\\u0000z":3}'));
    const byPath = new Map(paths.map((p) => [p.path, p]));
    expect(byPath.get('$["a\\\\nb"]')?.json).toBe('"decoy"');
    expect(byPath.get('$["q\\"x"]')?.json).toBe("1");
    expect(byPath.get('$["t\tx"]')?.json).toBe("2");
    expect(byPath.get('$["z\u0000z"]')?.json).toBe("3");
    expect(byPath.get('$["a\nb"]')?.unavailable).toMatch(/line break/);
    expect(byPath.has('$["a\\nb"]')).toBe(false);
  });
});

void act;
