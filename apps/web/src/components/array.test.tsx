/** v0.4 arrays: the array inspector (ArrayDetail through KeyContent), the create-key form and the helpers. */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARRAY_MAX_INDEX, binFromString, keyToParam, sha256Hex, type ArrayElement, type ArrayPage, type DatabaseSummary, type KeyDetails } from "@rconsole/shared";
import { DatabaseContext } from "../lib/context.tsx";
import { MemoryProvider } from "../lib/memory.tsx";
import { setConfirmHandler } from "../lib/api.ts";
import { lineValues } from "../lib/array.ts";
import { versionAtLeast } from "../pages/Landing.tsx";
import { KeyContent } from "./KeyContent.tsx";
import { KeyEditor } from "./KeyOperations.tsx";
import { arrayRows } from "./ArrayDetail.tsx";

const operatorDb: DatabaseSummary = { id: "db", name: "DB", environment: "test", readOnly: false, effectiveRole: "operator", features: { profiler: false }, status: "connected" };
const viewerDb: DatabaseSummary = { ...operatorDb, effectiveRole: "viewer" };
const bin = binFromString;
const sha = (s: string) => sha256Hex(new TextEncoder().encode(s));
const el = (index: string, value: string, truncated = false): ArrayElement => ({ index, value: bin(value), ref: { kind: "array", index, identity: sha(value) }, ...(truncated ? { truncated: true as const } : {}) });
const BIG = "9007199254740993";
const firstPage: ArrayPage = { items: [el("0", "zero"), el("1", "one"), el("1000", "thousand"), el(BIG, "beyond")], start: "0", end: ARRAY_MAX_INDEX, reverse: false, next: "9007199254740994" };
const details = (page: ArrayPage = firstPage, info = { count: "6", length: "18446744073709551615", nextInsertIndex: "0", slices: 3, sliceSize: 4096 }): KeyDetails =>
  ({ key: bin("arr"), type: "array", ttl: -1, encoding: "sliced-array", length: 6, value: { type: "array", info, ...page } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function mockServer(answer: (path: string, body: any) => Response = () => json({ ok: true })) {
  const sent: { path: string; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const path = String(url).replace(/^\/api\/v1\/databases\/db/, "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ path, body });
    return answer(path, body);
  }));
  return sent;
}
function wrap(node: React.ReactNode, database = operatorDb) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><MemoryProvider><DatabaseContext value={database}>{node}</DatabaseContext></MemoryProvider></MemoryRouter></QueryClientProvider>;
}
const show = (d = details(), database = operatorDb, refresh = async () => {}) => render(wrap(<KeyContent details={d} refresh={refresh} />, database));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setConfirmHandler(undefined); });

describe("array inspector: summary, sparseness and paging", () => {
  it("shows the summary and makes the gaps between indices visible, with exact indices beyond 2^53", () => {
    show();
    const summary = screen.getByTestId("array-summary");
    expect(within(summary).getByTestId("array-count")).toHaveTextContent("6");
    expect(within(summary).getByTestId("array-length")).toHaveTextContent("18,446,744,073,709,551,615");
    expect(within(summary).getByTestId("array-next-insert")).toHaveTextContent("0");
    const rows = screen.getAllByTestId("array-row");
    expect(rows.map((r) => r.querySelector("code")?.textContent)).toEqual(["0", "1", "1000", BIG]);
    const gaps = screen.getAllByTestId("array-gap");
    expect(gaps.map((g) => g.textContent)).toEqual([
      "⋯ 998 empty positions: 2–999",
      `⋯ 9,007,199,254,739,992 empty positions: 1001–9007199254740992`,
    ]);
    expect(screen.getByTestId("array-page-note")).toHaveTextContent("The next page starts at index 9007199254740994");
  });

  it("pages with array/range: Next starts after the last index, Previous returns, Last reads from the end, Jump validates", async () => {
    const sent = mockServer((path, body) => json({ items: [el(body.start ?? ARRAY_MAX_INDEX, "x")], start: body.start ?? ARRAY_MAX_INDEX, end: body.reverse ? "0" : ARRAY_MAX_INDEX, reverse: body.reverse }));
    show();
    await userEvent.click(screen.getByTestId("array-next"));
    await waitFor(() => expect(sent.at(-1)).toEqual({ path: "/array/range", body: { key: bin("arr"), start: "9007199254740994", reverse: false, count: 100 } }));
    await userEvent.click(screen.getByTestId("array-prev"));
    expect(await screen.findAllByTestId("array-row")).toHaveLength(4);
    await userEvent.click(screen.getByTestId("array-last"));
    await waitFor(() => expect(sent.at(-1)?.body).toEqual({ key: bin("arr"), reverse: true, count: 100 }));
    await userEvent.type(screen.getByTestId("array-jump-input"), "18446744073709551615");
    await userEvent.click(screen.getByTestId("array-jump"));
    expect(await screen.findByText(/Jump to index: enter a whole index from 0 to 18446744073709551614/)).toBeInTheDocument();
    await userEvent.clear(screen.getByTestId("array-jump-input"));
    await userEvent.type(screen.getByTestId("array-jump-input"), "500");
    await userEvent.click(screen.getByTestId("array-jump"));
    await waitFor(() => expect(sent.at(-1)?.body).toEqual({ key: bin("arr"), start: "500", reverse: false, count: 100 }));
    expect(sent.every((s) => !/[?&]/.test(s.path))).toBe(true);
  });

  it("a new read of the key re-reads the page shown (auto refresh), not only the summary", async () => {
    const sent = mockServer((_path, body) => json({ items: [el(body.start, "x")], start: body.start, end: ARRAY_MAX_INDEX, reverse: false }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const stable = (d: KeyDetails) => <QueryClientProvider client={client}><MemoryRouter><MemoryProvider><DatabaseContext value={operatorDb}><KeyContent details={d} refresh={async () => {}} /></DatabaseContext></MemoryProvider></MemoryRouter></QueryClientProvider>;
    const { rerender } = render(stable(details()));
    await userEvent.click(screen.getByTestId("array-next"));
    await waitFor(() => expect(sent.filter((s) => s.path === "/array/range")).toHaveLength(1));
    // The inspector's key/read completes again with the same first page (structural sharing keeps the object).
    client.setQueryData(["key", "db", keyToParam(bin("arr")), "0", 0, false, {}], details());
    await waitFor(() => expect(sent.filter((s) => s.path === "/array/range")).toHaveLength(2));
    // Reads of other keys or databases do not.
    client.setQueryData(["key", "db", keyToParam(bin("other")), "0", 0, false, {}], details());
    client.setQueryData(["key", "other-db", keyToParam(bin("arr")), "0", 0, false, {}], details());
    await new Promise((r) => setTimeout(r, 50));
    expect(sent.filter((s) => s.path === "/array/range")).toHaveLength(2);
    rerender(stable(details()));
    expect(sent.at(-1)?.body.start).toBe("9007199254740994");
  });

  it("computes gaps in both directions, with a leading gap from an explicit start", () => {
    const down: ArrayPage = { items: [el("10", "a"), el("7", "b"), el("6", "c")], start: "12", end: "0", reverse: true };
    expect(arrayRows(down, true).map((r) => (r.kind === "gap" ? `gap ${r.from}-${r.to} (${r.count})` : r.item.index))).toEqual(["gap 12-11 (2)", "10", "gap 9-8 (2)", "7", "6"]);
    const up: ArrayPage = { items: [el("3", "a"), el("4", "b")], start: "0", end: "9", reverse: false };
    expect(arrayRows(up, true).map((r) => (r.kind === "gap" ? `gap ${r.from}-${r.to}` : r.item.index))).toEqual(["gap 0-2", "3", "4"]);
    expect(arrayRows(up, false).map((r) => (r.kind === "gap" ? "gap" : r.item.index))).toEqual(["3", "4"]);
  });
});

describe("array inspector: search and aggregates", () => {
  it("offers EXACT, MATCH and GLOB only, sends the conditions in a POST body, and continues where the search stopped", async () => {
    const sent = mockServer((path, body) => json({ items: [el(body.start === "0" ? "1" : "40", "pineapple")], start: body.start, searchedTo: ARRAY_MAX_INDEX, elements: 6, ...(body.start === "0" ? { next: "2" } : {}) }));
    show();
    await userEvent.click(screen.getByText("Search values"));
    const kinds = within(screen.getByTestId("array-search")).getAllByTestId("array-search-kind")[0]!;
    expect([...kinds.querySelectorAll("option")].map((o) => o.value)).toEqual(["exact", "match", "glob"]);
    expect(screen.getByTestId("array-search")).toHaveTextContent("Regular expressions (RE) are not available");
    await userEvent.type(screen.getByTestId("array-search-value"), "apple");
    await userEvent.click(screen.getByTestId("array-search-add"));
    await userEvent.selectOptions(screen.getAllByTestId("array-search-kind")[1]!, "glob");
    await userEvent.type(screen.getAllByTestId("array-search-value")[1]!, "p*e");
    await userEvent.selectOptions(screen.getByTestId("array-search-combine"), "and");
    await userEvent.click(screen.getByTestId("array-search-nocase"));
    await userEvent.click(screen.getByTestId("array-search-submit"));
    await waitFor(() => expect(sent.at(-1)).toEqual({ path: "/array/search", body: {
      key: bin("arr"), start: "0", end: "18446744073709551614",
      predicates: [{ kind: "match", value: bin("apple") }, { kind: "glob", value: bin("p*e") }], combine: "and", nocase: true, limit: 100,
    } }));
    expect(await screen.findByTestId("array-search-summary")).toHaveTextContent("1 match in indices 0–18446744073709551614 (6 elements searched). More of the range is left from index 2.");
    await userEvent.click(screen.getByTestId("array-search-continue"));
    await waitFor(() => expect(sent.at(-1)?.body.start).toBe("2"));
    expect(await screen.findByTestId("array-search-summary")).toHaveTextContent("The whole range was searched.");
    expect(screen.queryByTestId("array-search-continue")).toBeNull();
  });

  it("an invalid index or base64 value is reported and the search can be corrected and run (review v0.4 r1 M1)", async () => {
    const sent = mockServer((_path, body) => json({ items: [], start: body.start, searchedTo: body.end, elements: 6 }));
    show();
    await userEvent.click(screen.getByText("Search values"));
    await userEvent.type(screen.getByTestId("array-search-value"), "apple");
    await userEvent.clear(screen.getByTestId("array-search-end"));
    await userEvent.type(screen.getByTestId("array-search-end"), "abc");
    await userEvent.click(screen.getByTestId("array-search-submit"));
    expect(await within(screen.getByTestId("array-search")).findByRole("alert")).toHaveTextContent("To index: enter a whole index");
    expect(screen.getByTestId("array-search-submit")).toBeEnabled();
    expect(screen.getByTestId("array-search-submit")).toHaveTextContent("Search");
    await userEvent.selectOptions(screen.getByLabelText("Condition 1 encoding"), "base64");
    await userEvent.clear(screen.getByTestId("array-search-end"));
    await userEvent.type(screen.getByTestId("array-search-end"), "9");
    await userEvent.click(screen.getByTestId("array-search-submit"));
    expect(await within(screen.getByTestId("array-search")).findByRole("alert")).toHaveTextContent(/base64/i);
    expect(sent.some((s) => s.path === "/array/search")).toBe(false);
    await userEvent.selectOptions(screen.getByLabelText("Condition 1 encoding"), "utf8");
    await userEvent.click(screen.getByTestId("array-search-submit"));
    await waitFor(() => expect(sent.at(-1)?.body).toMatchObject({ start: "0", end: "9", predicates: [{ kind: "match", value: bin("apple") }] }));
    expect(await screen.findByTestId("array-search-summary")).toHaveTextContent("The whole range was searched.");
  });

  it("names the values a search skipped because they are larger than one search reads (review v0.4 r2 H2)", async () => {
    mockServer((_path, body) => json({ items: [el("0", "apple")], start: body.start, searchedTo: "7", elements: 3, next: "8", skipped: ["7"] }));
    show();
    await userEvent.click(screen.getByText("Search values"));
    expect(screen.getByTestId("array-search")).toHaveTextContent("ARGREP is not run");
    await userEvent.type(screen.getByTestId("array-search-value"), "apple");
    await userEvent.click(screen.getByTestId("array-search-submit"));
    expect(await screen.findByTestId("array-search-skipped")).toHaveTextContent("Not searched (each value is larger than one search reads, 8.0 MiB): index 7.");
    expect(screen.getByTestId("array-search-summary")).toHaveTextContent("More of the range is left from index 8.");
  });

  it("computes an aggregate over a range and shows Redis's text", async () => {
    const sent = mockServer(() => json({ op: "sum", result: "45.5", elements: 10 }));
    show();
    await userEvent.click(screen.getByText("Aggregate a range (AROP)"));
    await userEvent.clear(screen.getByTestId("array-aggregate-end"));
    await userEvent.type(screen.getByTestId("array-aggregate-end"), "9");
    await userEvent.click(screen.getByTestId("array-aggregate-submit"));
    await waitFor(() => expect(sent.at(-1)).toEqual({ path: "/array/aggregate", body: { key: bin("arr"), start: "0", end: "9", op: "sum" } }));
    expect(await screen.findByTestId("array-aggregate-result")).toHaveTextContent("Sum (SUM) over indices 0–9 (10 elements): 45.5");
  });
});

describe("array inspector: roles and edits", () => {
  it("viewers get no write controls", () => {
    show(details(), viewerDb);
    expect(screen.queryByTestId("array-row-edit")).toBeNull();
    expect(screen.queryByTestId("array-row-delete")).toBeNull();
    for (const id of ["array-append", "array-set", "array-delete-range"]) expect(screen.queryByTestId(id)).toBeNull();
    expect(screen.getByTestId("array-search")).toBeInTheDocument();
  });

  it("edits a row with compare-and-set on the bytes it opened, and shows a 409 with Reload / Overwrite anyway", async () => {
    let calls = 0;
    const sent = mockServer((path) => {
      if (path !== "/ops") return json({});
      calls++;
      return calls === 1
        ? json({ error: { code: "conflict", message: "This value changed since you opened it; nothing was written.", conflict: { reason: "value", expected: { type: "array", sha256: sha("one") }, current: { type: "array", value: bin("theirs"), expect: { type: "array", sha256: sha("theirs") } } } } }, 409)
        : json({ ok: true, result: { t: "int", v: "0" } });
    });
    const refresh = vi.fn(async () => {});
    show(details(), operatorDb, refresh);
    await userEvent.click(screen.getByRole("button", { name: "Edit index 1" }));
    const box = screen.getByLabelText("Value at index 1");
    await userEvent.clear(box);
    await userEvent.type(box, "mine");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("edit-conflict-current")).toHaveTextContent("theirs");
    expect(sent.at(-1)?.body).toEqual({ op: "array.set", key: bin("arr"), index: "1", value: bin("mine"), expect: { type: "array", sha256: sha("one") } });
    await userEvent.click(screen.getByTestId("edit-conflict-overwrite"));
    await waitFor(() => expect(sent.at(-1)?.body.expect).toEqual({ type: "array", sha256: sha("theirs") }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("hides the row editor for truncated previews", () => {
    show(details({ ...firstPage, items: [el("0", "cut", true), el("1", "whole")] }));
    expect(screen.getAllByTestId("array-row-edit")).toHaveLength(1);
    expect(screen.getByText(/Some values are truncated previews/)).toBeInTheDocument();
  });

  it("deletes an index through the server confirmation", async () => {
    const challenge = { token: "t".repeat(32), level: "confirm", reasonRequired: false, summary: "Delete 1 array element(s) on DB", preview: { total: 1, commands: [] } };
    const notes: (string | undefined)[] = [];
    setConfirmHandler(async (_c, context) => { notes.push(context.note); return { token: "t".repeat(32) }; });
    const sent = mockServer((path, body) => (path === "/ops" && !body.confirmation ? json({ error: { code: "confirmation_required", message: "Confirm", confirmation: challenge } }, 428) : json({ ok: true, result: { t: "int", v: "1" } })));
    const refresh = vi.fn(async () => {});
    show(details(), operatorDb, refresh);
    await userEvent.click(screen.getByRole("button", { name: "Delete index 1000" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const ops = sent.filter((s) => s.path === "/ops");
    expect(ops.map((o) => o.body)).toEqual([
      { op: "array.delete", key: bin("arr"), indexes: ["1000"] },
      { op: "array.delete", key: bin("arr"), indexes: ["1000"], confirmation: { token: "t".repeat(32) } },
    ]);
    expect(notes[0]).toBe("Deletes the element at index 1000 (ARDEL).");
  });

  it("appends lines with ARINSERT (guarded on the server) and shows the server's refusal", async () => {
    const sent = mockServer(() => json({ error: { code: "conflict", message: "The insert cursor is at index 0 and ARINSERT would overwrite 2 existing elements there; nothing was written.", conflict: { reason: "value", expected: { type: "array" }, current: { type: "array" } } } }, 409));
    show();
    await userEvent.click(screen.getByText("Append values (ARINSERT)"));
    expect(screen.getByTestId("array-append")).toHaveTextContent("The cursor is inside the array here");
    await userEvent.type(screen.getByTestId("array-append-values"), "a{Enter}b{Enter}");
    await userEvent.click(screen.getByTestId("array-append-submit"));
    expect(await within(screen.getByTestId("array-append")).findByRole("alert")).toHaveTextContent("ARINSERT would overwrite 2 existing elements");
    expect(sent.at(-1)?.body).toEqual({ op: "array.insert", key: bin("arr"), values: [bin("a"), bin("b")], expect: { type: "array" } });
  });

  it("sets a value at an index: absent when the page does not show it, its bytes when it does", async () => {
    const sent = mockServer(() => json({ ok: true, result: { t: "int", v: "1" } }));
    show(details(firstPage, { count: "4", length: "1001", nextInsertIndex: "1001", slices: 1, sliceSize: 4096 }));
    await userEvent.click(screen.getByText("Set value at index (ARSET)"));
    expect(screen.getByTestId("array-set-index")).toHaveValue("1001");
    await userEvent.type(screen.getByTestId("array-set-value"), "new");
    await userEvent.click(screen.getByTestId("array-set-submit"));
    await waitFor(() => expect(sent.at(-1)?.body).toEqual({ op: "array.set", key: bin("arr"), index: "1001", value: bin("new"), expect: { type: "array", sha256: null } }));
    await userEvent.clear(screen.getByTestId("array-set-index"));
    await userEvent.type(screen.getByTestId("array-set-index"), "1000");
    await userEvent.click(screen.getByTestId("array-set-submit"));
    await waitFor(() => expect(sent.at(-1)?.body.expect).toEqual({ type: "array", sha256: sha("thousand") }));
  });

  it("index and range defaults follow the array as it grows, until the user types one", async () => {
    const info = (length: string) => ({ count: "4", length, nextInsertIndex: length, slices: 1, sliceSize: 4096 });
    const { rerender } = show(details(firstPage, info("1001")));
    await userEvent.click(screen.getByText("Set value at index (ARSET)"));
    await userEvent.click(screen.getByText("Delete a range (ARDELRANGE)"));
    expect(screen.getByTestId("array-set-index")).toHaveValue("1001");
    expect(screen.getByTestId("array-delete-range-end")).toHaveValue("1000");
    rerender(wrap(<KeyContent details={details(firstPage, info("1003"))} refresh={async () => {}} />));
    expect(screen.getByTestId("array-set-index")).toHaveValue("1003");
    expect(screen.getByTestId("array-delete-range-end")).toHaveValue("1002");
    await userEvent.clear(screen.getByTestId("array-set-index"));
    await userEvent.type(screen.getByTestId("array-set-index"), "7");
    rerender(wrap(<KeyContent details={details(firstPage, info("1004"))} refresh={async () => {}} />));
    expect(screen.getByTestId("array-set-index")).toHaveValue("7");
  });

  it("deletes a range after counting it, through the server confirmation", async () => {
    const notes: (string | undefined)[] = [];
    setConfirmHandler(async (_c, context) => { notes.push(context.note); return { token: "t".repeat(32) }; });
    const challenge = { token: "t".repeat(32), level: "confirm", reasonRequired: false, summary: "s", preview: { total: 1, commands: [] } };
    const sent = mockServer((path, body) => path === "/array/aggregate" ? json({ op: "used", result: "3", elements: 3 }) : !body.confirmation ? json({ error: { code: "confirmation_required", message: "Confirm", confirmation: challenge } }, 428) : json({ ok: true, result: { t: "int", v: "3" } }));
    show();
    await userEvent.click(screen.getByText("Delete a range (ARDELRANGE)"));
    await userEvent.clear(screen.getByTestId("array-delete-range-end"));
    await userEvent.type(screen.getByTestId("array-delete-range-end"), "1000");
    await userEvent.click(screen.getByTestId("array-delete-range-submit"));
    await waitFor(() => expect(sent.filter((s) => s.path === "/ops")).toHaveLength(2));
    expect(sent[0]).toEqual({ path: "/array/aggregate", body: { key: bin("arr"), start: "0", end: "1000", op: "used" } });
    expect(sent.at(-1)?.body).toMatchObject({ op: "array.delete-range", start: "0", end: "1000" });
    expect(notes[0]).toBe("3 elements existed in this range when it was counted.");
  });

  it("the value inspector edits a full array element with compare-and-set", async () => {
    const sent = mockServer((path) => (path === "/key/element" ? json({ value: bin("x".repeat(70_000)) }) : json({ ok: true, result: { t: "int", v: "0" } })));
    show(details({ ...firstPage, items: [el("7", "x".repeat(10), true)] }));
    await userEvent.click(screen.getAllByTestId("value-cell-open")[0]!);
    await userEvent.click(screen.getByTestId("element-load-full"));
    await userEvent.click(await screen.findByText("Edit full element"));
    const box = screen.getByLabelText("Full element value");
    await userEvent.clear(box);
    await userEvent.type(box, "y");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent.at(-1)?.body).toEqual({ op: "array.set", key: bin("arr"), index: "7", value: bin("y"), expect: { type: "array", sha256: sha("x".repeat(70_000)) } }));
    expect(sent.find((s) => s.path === "/key/element")?.body).toEqual({ key: bin("arr"), ref: { kind: "array", index: "7", identity: sha("x".repeat(10)) } });
  });
});

describe("create-key form and helpers", () => {
  it("creates an array with one value per line, never overwriting: a 409 reads as 'key exists'", async () => {
    let calls = 0;
    const sent = mockServer(() => (++calls === 1 ? json({ ok: true, result: { t: "int", v: "1" } }) : json({ error: { code: "conflict", message: "This key already exists; nothing was written.", conflict: { reason: "type", expected: { type: "none" }, current: { type: "array" } } } }, 409)));
    const onSaved = vi.fn(async () => {});
    render(wrap(<KeyEditor onClose={() => {}} onSaved={onSaved} />));
    await userEvent.selectOptions(screen.getByTestId("key-create-type"), "array");
    await userEvent.type(screen.getByTestId("key-create-name"), "new:arr");
    await userEvent.type(screen.getByTestId("key-edit-value"), "first{Enter}second");
    await userEvent.click(screen.getByTestId("key-save"));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ key: bin("new:arr"), type: "array", ttl: -1 }));
    expect(sent[0]).toEqual({ path: "/ops", body: { op: "array.insert", key: bin("new:arr"), values: [bin("first"), bin("second")], expect: { type: "none" } } });
    cleanup();
    render(wrap(<KeyEditor onClose={() => {}} onSaved={onSaved} />));
    await userEvent.selectOptions(screen.getByTestId("key-create-type"), "array");
    await userEvent.type(screen.getByTestId("key-create-name"), "new:arr");
    await userEvent.type(screen.getByTestId("key-edit-value"), "again");
    await userEvent.click(screen.getByTestId("key-save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("This key already exists");
  });

  it("splits lines exactly (CRLF, one trailing break) and checks base64 per line", () => {
    expect(lineValues("a\r\nb\n", "utf8")).toEqual([bin("a"), bin("b")]);
    expect(lineValues("a\n\n", "utf8")).toEqual([bin("a"), bin("")]);
    expect(lineValues("", "utf8")).toEqual([bin("")]);
    expect(lineValues("/wA=\nAA==", "base64")).toEqual([{ enc: "base64", data: "/wA=" }, { enc: "base64", data: "AA==" }]);
    expect(() => lineValues("ok\n%%%", "base64")).toThrow("Line 2 is not valid base64.");
    expect(() => lineValues(Array.from({ length: 1001 }, () => "x").join("\n"), "utf8")).toThrow("At most 1,000");
  });

  it("shows the Arrays capability from Redis 8.8 on", () => {
    expect(versionAtLeast("8.10.2", [8, 8])).toBe(true);
    expect(versionAtLeast("8.8.0", [8, 8])).toBe(true);
    expect(versionAtLeast("9.0.0", [8, 8])).toBe(true);
    expect(versionAtLeast("8.6.3", [8, 8])).toBe(false);
    expect(versionAtLeast("7.4.1", [8, 8])).toBe(false);
    expect(versionAtLeast(undefined, [8, 8])).toBe(false);
  });
});
