import { Blob as NativeBlob } from "node:buffer";
import { gzipSync } from "node:zlib";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binFromBytes, binFromString, sha256Hex, bytesFromBin, type DatabaseSummary, type KeyDetails } from "@rconsole/shared";
import { DatabaseContext } from "../lib/context.tsx";
import { MemoryProvider } from "../lib/memory.tsx";
import { formatValue } from "../lib/format.ts";
import { setConfirmHandler } from "../lib/api.ts";
import { KeyContent } from "./KeyContent.tsx";
import { KeyInspector } from "./KeyInspector.tsx";
import { CollectionLookup } from "./CollectionLookup.tsx";
import { HashExpiry } from "./HashExpiry.tsx";
import { entryOperations, MultiEntryAdd } from "./MultiEntryAdd.tsx";
import { StreamInspector } from "./StreamInspector.tsx";
import { downloadBytes, ValueViewer } from "./ValueViewer.tsx";

const db: DatabaseSummary = { id: "db", name: "DB", environment: "test", readOnly: false, effectiveRole: "operator", features: { profiler: false }, status: "connected" };
const bin = binFromString;
const hash = (extra: Partial<KeyDetails> = {}): KeyDetails => ({ key: bin("hash"), type: "hash", ttl: -1, length: 1200, hashFieldExpiry: { supported: true }, value: { type: "hash", total: 1200, cursor: "9", entries: [{ field: bin("f"), value: bin('{"n":9007199254740993}'), ttl: -1, ref: { kind: "hash", field: bin("f") } }] }, ...extra });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function mockServer(answer: (path: string, body: any) => Response = () => json({ ok: true })) {
  const sent: { path: string; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => { const path = String(url).replace(/^\/api\/v1\/databases\/db/, ""); const body = init.body ? JSON.parse(String(init.body)) : undefined; sent.push({ path, body }); return answer(path, body); }));
  return sent;
}
function wrap(node: React.ReactNode, database = db) { return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><MemoryProvider><DatabaseContext value={database}>{node}</DatabaseContext></MemoryProvider></MemoryRouter></QueryClientProvider>; }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("F1 collection lookup", () => {
  it("applies byte-exact binary exact lookup without URL data", async () => {
    const apply = vi.fn(); render(<CollectionLookup type="hash" apply={apply} />);
    await userEvent.selectOptions(screen.getByLabelText("Collection lookup mode"), "exact");
    await userEvent.selectOptions(screen.getByLabelText("Lookup encoding"), "base64");
    await userEvent.type(screen.getByLabelText("Collection lookup", { exact: true }), "/wA=");
    await userEvent.click(screen.getByText("Apply lookup"));
    expect(apply).toHaveBeenCalledWith({ reverse: false, exact: { enc: "base64", data: "/wA=" } }, 0);
  });
  it("rejects fractional list indices", async () => {
    const apply = vi.fn(); render(<CollectionLookup type="list" apply={apply} />);
    await userEvent.type(screen.getByLabelText("List index", { exact: true }), "1.5"); await userEvent.click(screen.getByText("Apply lookup"));
    expect(screen.getByRole("alert")).toHaveTextContent("whole index"); expect(apply).not.toHaveBeenCalled();
  });
  it("resets paging when MATCH changes and shows filter count separately from the total", async () => {
    const sent = mockServer((path, body) => json(hash({ filter: body?.match ? { matches: 1 } : undefined })));
    render(wrap(<KeyInspector selected={bin("hash")} delimiter=":" onDeleted={() => {}} />));
    await screen.findByRole("button", { name: "Next page" });
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(sent.at(-1)?.body.cursor).toBe("9"));
    await userEvent.type(screen.getByLabelText("Collection lookup", { exact: true }), "target*"); await userEvent.click(screen.getByText("Apply lookup"));
    await waitFor(() => expect(sent.at(-1)?.body).toMatchObject({ match: "target*", offset: 0 }));
    expect(sent.at(-1)?.body.cursor).toBeUndefined();
    expect(screen.getByTestId("collection-filter-count")).toHaveTextContent("1 filter matches on this page");
    expect(screen.getByTestId("collection-filter-count")).toHaveTextContent("Collection total: 1,200");
  });
});
describe("F3 in-place formats and widths", () => {
  it("formats collection JSON without rounding and expands a row in place", async () => {
    render(wrap(<KeyContent details={hash()} refresh={async () => {}} />));
    await userEvent.selectOptions(screen.getByLabelText("Collection value format"), "json");
    const cells = screen.getAllByTestId("value-cell-open");
    expect(cells[1]).toHaveTextContent('"n": 9007199254740993');
    await userEvent.click(screen.getAllByText("Expand value")[1]!);
    await waitFor(() => expect(screen.getByTestId("key-value")).toHaveTextContent("9007199254740993"));
    fireEvent.change(screen.getByLabelText("Field column width"), { target: { value: "65" } });
    expect(document.querySelector("col")).toHaveStyle({ width: "65%" });
  });
  it("invalid codec data remains inert text with an explicit error", async () => {
    render(wrap(<KeyContent details={hash()} refresh={async () => {}} />));
    await userEvent.selectOptions(screen.getByLabelText("Collection value format"), "float64le");
    expect(screen.getAllByTestId("value-cell-open")[1]).toHaveTextContent("Cannot format");
    expect(document.querySelector("script")).toBeNull();
  });
});
describe("F6 hash expiry", () => {
  it("shows batched TTL cells and an unsupported-server reason", async () => {
    const detail = hash({ hashFieldExpiry: { supported: false, reason: "Requires Redis 7.4" } });
    render(wrap(<KeyContent details={detail} refresh={async () => {}} />));
    expect(screen.getByRole("columnheader", { name: "Field TTL" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Field TTL unavailable: Requires Redis 7.4" })).toBeDisabled();
  });
  it("removes field expiry with a typed op and refreshes TTL", async () => {
    const refresh = vi.fn(async () => {}); const sent = mockServer(path => path === "/key/read" ? json(hash()) : json({ ok: true }));
    render(wrap(<HashExpiry keyName={bin("hash")} field={bin("f")} initialTtl={120} refresh={refresh} onClose={() => {}} />));
    await userEvent.click(screen.getByText("Remove field expiry"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(sent[0]?.body).toEqual({ op: "hash.persist", key: bin("hash"), fields: [bin("f")] });
    expect(screen.getByRole("status")).toHaveTextContent("no expiry");
  });
  it("viewers can read TTL but cannot change it", () => {
    render(wrap(<HashExpiry keyName={bin("hash")} field={bin("f")} onClose={() => {}} />, { ...db, effectiveRole: "viewer" }));
    expect(screen.getByText("Read field TTL")).toBeVisible(); expect(screen.queryByText("Set field TTL")).toBeNull();
  });
});
describe("F9 full element retrieval", () => {
  it("loads a truncated element through its typed ref and enables full-byte download", async () => {
    const full = binFromBytes(Uint8Array.from([255, 0, 13, 10])); const sent = mockServer(() => json({ value: full }));
    const detail = hash(); if (detail.value.type === "hash") detail.value.entries[0]!.truncated = true;
    render(wrap(<KeyContent details={detail} refresh={async () => {}} />));
    await userEvent.click(screen.getAllByTestId("value-cell-open")[1]!);
    const modal = screen.getByTestId("value-inspector-dialog");
    expect(within(modal).getByText("Download bytes")).toBeDisabled();
    await userEvent.click(within(modal).getByText("Load full element (server capped)"));
    await waitFor(() => expect(within(modal).getByText("Download bytes")).toBeEnabled());
    expect(sent[0]).toEqual({ path: "/key/element", body: { key: bin("hash"), ref: { kind: "hash", field: bin("f") } } });
    expect(within(modal).queryByText(/Truncated preview:/)).toBeNull();
  });
  it("leaves a capped element as a labelled preview when retrieval is refused", async () => {
    mockServer(() => json({ error: { code: "too_large", message: "Cap exceeded" } }, 413));
    const detail = hash(); if (detail.value.type === "hash") detail.value.entries[0]!.truncated = true;
    render(wrap(<KeyContent details={detail} refresh={async () => {}} />));
    await userEvent.click(screen.getAllByTestId("value-cell-open")[1]!); await userEvent.click(screen.getByText("Load full element (server capped)"));
    await screen.findByText(/Cap exceeded/); expect(screen.getByText("Download bytes")).toBeDisabled();
  });
  it("long identities sharing a preview retain distinct rows and full-element addresses", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const common = bin("p".repeat(65536));
    const refs = [0, 1].map(position => ({ kind: "scan" as const, type: "hash" as const, cursor: "0", count: 100, position, identity: String(position + 1).repeat(64) }));
    const detail = hash({ value: { type: "hash", total: 2, cursor: "0", entries: refs.map((ref, i) => ({ field: common, value: bin(`preview-${i}`), truncated: true, fieldTruncated: true, ref })) } });
    const sent = mockServer((_path, body) => json({ value: bin(body.ref.identity === refs[1]!.identity ? "full-second" : "full-first") }));
    render(wrap(<KeyContent details={detail} refresh={async () => {}} />));
    expect(screen.getAllByTestId("value-cell-open")).toHaveLength(4);
    await userEvent.click(screen.getAllByTestId("value-cell-open")[3]!);
    await userEvent.click(screen.getByTestId("element-load-full"));
    await waitFor(() => expect(screen.getByTestId("key-value")).toHaveTextContent("full-second"));
    expect(sent[0]!.body.ref).toEqual(refs[1]); expect(errors).not.toHaveBeenCalled();
  });
  it("download preserves original compressed bytes after local inflation", async () => {
    vi.stubGlobal("Blob", NativeBlob);
    const source = gzipSync(Buffer.from('{"message":"a long enough document to differ from its gzip size"}'));
    const create = vi.fn((_blob: Blob) => "blob:opaque");
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<ValueViewer value={binFromBytes(source)} />);
    await userEvent.click(screen.getByTestId("value-inflate"));
    await screen.findByText("Inflated locally");
    await userEvent.click(screen.getByTestId("value-download"));
    expect(create.mock.calls[0]![0].size).toBe(source.length);
  });
  it("download uses exact raw bytes, a static filename and an opaque local Blob URL", () => {
    const create = vi.fn((_blob: Blob) => "blob:opaque"), revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { expect(this.download).toBe("redis-value.bin"); expect(this.href).toBe("blob:opaque"); });
    const raw = binFromBytes(Uint8Array.from([255, 0, 13, 10])); downloadBytes(raw);
    const blob = create.mock.calls[0]?.[0] as Blob; expect(blob.size).toBe(4); expect(document.querySelector("a")).toBeNull();
  });
});
describe("F18 multi-entry validation and expectations", () => {
  const row = (field: string, value = "v") => ({ field, value, score: "1", encoding: "utf8" as const, fieldEncoding: "utf8" as const });
  it("validates duplicate identities and numeric scores before submitting", () => {
    expect(() => entryOperations(hash(), [row("a"), row("a")], "tail")).toThrow("Duplicate");
    const z: KeyDetails = { key: bin("z"), type: "zset", ttl: -1, value: { type: "zset", members: [], offset: 0, total: 0 } };
    expect(() => entryOperations(z, [{ ...row(""), score: "NaN" }], "tail")).toThrow("numeric");
  });
  it("each replacing hash write carries exact observed bytes; unseen fields are expected absent", () => {
    const detail = hash(); const ops = entryOperations(detail, [row("f"), row("new")], "tail");
    expect(ops[0]).toMatchObject({ expect: { type: "hash", sha256: sha256Hex(bytesFromBin(bin('{"n":9007199254740993}'))) } });
    expect(ops[1]).toMatchObject({ expect: { type: "hash", sha256: null } });
  });
  it("stops at a conflict, shows partial results and never sends the next row", async () => {
    const sent = mockServer((_path, body) => {
      if (body.entries?.[0]?.field.data !== "b") return json({ ok: true });
      return json({ error: { code: "conflict", message: "changed", conflict: {
        reason: "value", expected: body.expect,
        current: { type: "hash", value: bin("other"), expect: { type: "hash", sha256: "a".repeat(64) } },
      } } }, 409);
    });
    render(wrap(<MultiEntryAdd details={hash()} onClose={() => {}} refresh={async () => {}} />));
    await userEvent.type(screen.getByLabelText("Field 1", { exact: true }), "a");
    await userEvent.click(screen.getByText("Add another entry")); await userEvent.type(screen.getByLabelText("Field 2", { exact: true }), "b");
    await userEvent.click(screen.getByText("Add another entry")); await userEvent.type(screen.getByLabelText("Field 3", { exact: true }), "c");
    await userEvent.click(screen.getByText("Review entries")); await userEvent.click(screen.getByText("Apply entries"));
    await screen.findByTestId("edit-conflict"); expect(sent).toHaveLength(2); expect(screen.getByTestId("multi-entry-summary")).toHaveTextContent("1 of 3 commands completed");
  });
  it("closes once every command has run, while the key is still refreshing (CI flake on PR 1)", async () => {
    mockServer();
    const onClose = vi.fn();
    // A large key refreshes slowly; here the refresh never finishes.
    render(wrap(<MultiEntryAdd details={hash()} onClose={onClose} refresh={() => new Promise(() => {})} />));
    await userEvent.type(screen.getByLabelText("Field 1", { exact: true }), "a");
    await userEvent.click(screen.getByText("Review entries")); await userEvent.click(screen.getByText("Apply entries"));
    await waitFor(() => expect(screen.getByTestId("multi-entry-summary")).toHaveTextContent("1 of 1 commands completed"));
    await userEvent.click(within(screen.getByTestId("multi-entry-dialog")).getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalled();
  });
});
describe("F15 inspector groups and pending", () => {
  it("a group reorder preserves selection by bytes; removal cannot retarget pending actions", async () => {
    const info = (name: string) => ({ name, nameBin: bin(name), consumers: [], pending: 1, lastDeliveredId: "1-0" });
    let list = [info("g1"), info("g2")];
    mockServer(path => json(path === "/streams/groups" ? { groups: list } : { total: 1, pending: [{ id: "1-0", consumer: "c", idleMs: 5, deliveries: 1 }] }));
    render(wrap(<StreamInspector keyName={bin("stream")} refresh={async () => {}} />));
    await userEvent.click(screen.getByText("Consumer groups, consumers and pending messages"));
    const select = await screen.findByLabelText("Inspector consumer group");
    await userEvent.selectOptions(select, "1");
    list = [info("a"), ...list];
    await userEvent.click(screen.getByText("Refresh stream groups", { exact: true }));
    await waitFor(() => expect(within(select).getByRole("option", { selected: true })).toHaveTextContent("g2"));
    list = list.filter(g => g.name !== "g2");
    await userEvent.click(screen.getByText("Refresh stream groups", { exact: true }));
    await screen.findByText("The selected group was removed. Choose a group to continue.");
    expect(screen.queryByText("Acknowledge selected (confirm)")).toBeNull();
    expect(within(select).getByRole("option", { selected: true })).toHaveTextContent("not available");
  });
  it("binds group/consumer queries to the inspected binary key and hides writes for viewers", async () => {
    const sent = mockServer(path => json(path === "/streams/groups" ? { groups: [{ name: "g", nameBin: { enc: "base64", data: "/w==" }, consumers: [{ name: "c", pending: 1, idleMs: 5 }], pending: 1, lastDeliveredId: "1-0" }] } : { total: 1, pending: [{ id: "1-0", consumer: "c", idleMs: 5, deliveries: 1 }] }));
    render(wrap(<StreamInspector keyName={{ enc: "base64", data: "/g==" }} refresh={async () => {}} />, { ...db, effectiveRole: "viewer" }));
    await userEvent.click(screen.getByText("Consumer groups, consumers and pending messages"));
    await screen.findByText("Find pending IDs");
    await waitFor(() => expect(sent.some(x => x.path === "/streams/pending")).toBe(true));
    const pending = sent.find(x => x.path === "/streams/pending")!;
    expect(pending.body.key).toEqual({ enc: "base64", data: "/g==" }); expect(pending.body.group).toEqual({ enc: "base64", data: "/w==" });
    expect(screen.queryByText("Claim selected (confirm)")).toBeNull();
    await userEvent.click(screen.getByText("Pending for consumer 1"));
    await waitFor(() => expect(sent.at(-1)?.body.consumer).toEqual(bin("c")));
  });
});
// Review v0.2.1 web L2: consumer delete and group lifecycle inside the inspector, by exact bytes, through confirmed typed ops.
describe("L2 inspector consumer delete and group lifecycle", () => {
  afterEach(() => setConfirmHandler(undefined));
  const groupsBody = () => ({ groups: [{ name: "g", nameBin: { enc: "base64", data: "/w==" }, consumers: [{ name: "c", nameBin: { enc: "base64", data: "/mM=" }, pending: 3, idleMs: 5 }], consumerTotal: 1, pending: 3, lastDeliveredId: "1-0" }] });
  const challenge = { token: "t".repeat(32), level: "confirm", reasonRequired: false, summary: "s", preview: { total: 1, commands: [] } };
  const server = () => mockServer((path, body) => {
    if (path === "/streams/groups") return json(groupsBody());
    if (path === "/streams/pending") return json({ total: 0, pending: [] });
    if (path === "/ops" && !body.confirmation && body.op !== "stream.group.create") return json({ error: { code: "confirmation_required", message: "Confirm", confirmation: challenge } }, 428);
    return json({ ok: true, result: { t: "int", v: body.op === "stream.consumer.delete" ? "3" : "1" } });
  });
  const open = async () => { await userEvent.click(screen.getByText("Consumer groups, consumers and pending messages")); await screen.findByText("Find pending IDs"); };
  it("deletes a consumer by its bytes after a confirmation that names the pending entries it drops", async () => {
    const notes: (string | undefined)[] = [];
    setConfirmHandler(async (_c, context) => { notes.push(context.note); return { token: "t".repeat(32) }; });
    const sent = server();
    render(wrap(<StreamInspector keyName={{ enc: "base64", data: "/g==" }} refresh={async () => {}} />));
    await open();
    await userEvent.click(screen.getByTestId("stream-consumer-delete"));
    expect(await screen.findByTestId("stream-lifecycle-outcome")).toHaveTextContent("Redis dropped 3 pending entries.");
    const ops = sent.filter((x) => x.path === "/ops");
    expect(ops).toHaveLength(2);
    expect(ops[0]!.body).toEqual({ op: "stream.consumer.delete", key: { enc: "base64", data: "/g==" }, group: { enc: "base64", data: "/w==" }, consumer: { enc: "base64", data: "/mM=" } });
    expect(ops[1]!.body.confirmation).toEqual({ token: "t".repeat(32) });
    expect(notes[0]).toMatch(/had 3 pending entries at the last refresh/);
  });
  it("destroys the selected group (confirmed) and creates one at a chosen ID with MKSTREAM", async () => {
    const notes: (string | undefined)[] = [];
    setConfirmHandler(async (_c, context) => { notes.push(context.note); return { token: "t".repeat(32) }; });
    const sent = server();
    render(wrap(<StreamInspector keyName={bin("orders")} refresh={async () => {}} />));
    await open();
    await userEvent.click(screen.getByTestId("stream-group-destroy"));
    await screen.findByText("Group \\xff destroyed.");
    expect(sent.filter((x) => x.path === "/ops")[0]!.body).toEqual({ op: "stream.group.destroy", key: bin("orders"), group: { enc: "base64", data: "/w==" } });
    expect(notes[0]).toMatch(/1 consumers and 3 pending entries/);
    await userEvent.type(screen.getByTestId("stream-new-group-name"), "workers");
    await userEvent.selectOptions(screen.getByTestId("stream-new-group-start"), "id");
    await userEvent.type(screen.getByTestId("stream-new-group-id"), "12-x");
    expect(screen.getByTestId("stream-new-group-create")).toBeDisabled();
    await userEvent.clear(screen.getByTestId("stream-new-group-id"));
    await userEvent.type(screen.getByTestId("stream-new-group-id"), "12-0");
    await userEvent.click(screen.getByTestId("stream-new-group-mkstream"));
    expect(screen.getByTestId("stream-new-group-command")).toHaveTextContent("XGROUP CREATE orders workers 12-0 MKSTREAM");
    await userEvent.click(screen.getByTestId("stream-new-group-create"));
    await screen.findByText("Group workers created at 12-0.");
    expect(sent.filter((x) => x.path === "/ops").at(-1)!.body).toEqual({ op: "stream.group.create", key: bin("orders"), group: "workers", id: "12-0", mkstream: true });
  });
  it("viewers see no lifecycle or delete controls", async () => {
    server();
    render(wrap(<StreamInspector keyName={bin("orders")} refresh={async () => {}} />, { ...db, effectiveRole: "viewer" }));
    await open();
    expect(screen.queryByTestId("stream-consumer-delete")).toBeNull();
    expect(screen.queryByTestId("stream-group-destroy")).toBeNull();
    expect(screen.queryByTestId("stream-new-group-name")).toBeNull();
  });
});
describe("F17 float vectors", () => {
  it.each(["float32le", "float32be", "float64le", "float64be"] as const)("%s interprets endianness, negative zero, NaN and Infinity explicitly", format => {
    const size = format.startsWith("float32") ? 4 : 8, bytes = new Uint8Array(size * 5), view = new DataView(bytes.buffer);
    [1.5, -0, NaN, Infinity, -Infinity].forEach((v, i) => { if (size === 4) view.setFloat32(i * size, v, format.endsWith("le")); else view.setFloat64(i * size, v, format.endsWith("le")); });
    expect(formatValue(binFromBytes(bytes), format)).toBe("[1.5, -0, NaN, Infinity, -Infinity]");
  });
  it("rejects misaligned buffers and disables vectors for truncated previews", () => {
    expect(() => formatValue(bin("abc"), "float32le")).toThrow("multiple of 4");
    render(<ValueViewer value={bin("abc")} truncated />);
    expect(screen.getByRole("tab", { name: "Float32 LE" })).toBeDisabled();
  });
});
