import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSummary, KeyDetails, Reply } from "@rconsole/shared";
import { gzipSync } from "node:zlib";
import { binFromBytes, binFromString, bytesFromBin } from "@rconsole/shared";
import { DatabaseContext } from "../lib/context.tsx";
import { KeyContent } from "./KeyContent.tsx";
import { KeyEditor } from "./KeyOperations.tsx";
import { JsonTree } from "./ui.tsx";
import { ValueViewer } from "./ValueViewer.tsx";

// jsdom has no Blob streams; the real inflation is covered by format tests and E2E.
vi.mock("../lib/format.ts", async (original) => ({
  ...(await original<typeof import("../lib/format.ts")>()),
  inflateValue: vi.fn(async () => binFromString("OLD-INFLATED-CONTENT")),
}));

afterEach(() => vi.unstubAllGlobals());

const db: DatabaseSummary = {
  id: "db",
  name: "DB",
  environment: "test",
  effectiveRole: "operator",
  features: { profiler: false },
  readOnly: false,
  status: "connected",
};

const listPage = (offset: number): KeyDetails => ({
  key: binFromString("l"),
  type: "list",
  ttl: -1,
  value: {
    type: "list",
    offset,
    total: 205,
    items: [0, 1, 2].map((i) => ({
      index: offset + i,
      value: binFromString(`item-${offset + i}`),
    })),
  },
});

const hashPage = (fields: string[]): KeyDetails => ({
  key: binFromString("h"),
  type: "hash",
  ttl: -1,
  value: {
    type: "hash",
    cursor: "0",
    total: fields.length,
    entries: fields.map((field) => ({
      field: binFromString(field),
      value: binFromString(`value of ${field}`),
    })),
  },
});

describe("web review round 1", () => {
  it("H1: a cached page change does not move an open list editor to another index", async () => {
    const view = (details: KeyDetails) => (
      <DatabaseContext value={db}>
        <KeyContent details={details} refresh={async () => {}} />
      </DatabaseContext>
    );
    const { rerender } = render(view(listPage(0)));
    await userEvent.click(
      screen.getByRole("button", { name: "Edit list index 0" }),
    );
    expect(screen.getByLabelText("Value at index 0")).toHaveValue("item-0");
    // Same component instance, new rows (what a cached page does): the editor must not survive on row 0.
    rerender(view(listPage(100)));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByLabelText(/Value at index/)).toBeNull();
    rerender(view(listPage(0)));
    expect(screen.queryByLabelText("Value at index 0")).toBeNull();
  });

  it("H1: a hash editor follows its field, not its row position", async () => {
    const view = (details: KeyDetails) => (
      <DatabaseContext value={db}>
        <KeyContent details={details} refresh={async () => {}} />
      </DatabaseContext>
    );
    const { rerender } = render(view(hashPage(["a", "b"])));
    await userEvent.click(
      screen.getByRole("button", { name: "Edit hash field a" }),
    );
    await userEvent.type(screen.getByLabelText("Value of a"), " draft");
    const draft = (screen.getByLabelText("Value of a") as HTMLTextAreaElement).value;
    expect(draft).toContain("draft");
    // The field moved to another row: the editor stays bound to it (row b gets none).
    rerender(view(hashPage(["b", "a"])));
    expect(screen.getByLabelText("Value of a")).toHaveValue(draft);
    expect(screen.queryByLabelText("Value of b")).toBeNull();
    // A read that no longer shows the field closes the draft for good (web review v0.2 r3 H1): it does not
    // come back on a later read that shows the field again.
    rerender(view(hashPage(["c", "d"])));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("This field changed");
    rerender(view(hashPage(["b", "a"])));
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

/** Fake /cli and /ops endpoints: records each request; `replies` answers /cli commands by name. */
function fakeServer(replies: Record<string, Reply>) {
  const sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const name = url.endsWith("/cli")
        ? new TextDecoder().decode(bytesFromBin(body.argvBin[0]))
        : body.op;
      sent.push(name);
      const reply = replies[name] ?? { t: "int", v: "1" };
      const data = url.endsWith("/cli")
        ? { argv: [], commandClass: "write", durationMs: 1, reply }
        : { ok: true, result: reply };
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return sent;
}

async function create(type: string, fields: Record<string, string>) {
  const onSaved = vi.fn(async () => {});
  render(
    <DatabaseContext value={db}>
      <KeyEditor onClose={() => {}} onSaved={onSaved} />
    </DatabaseContext>,
  );
  await userEvent.selectOptions(screen.getByTestId("key-create-type"), type);
  await userEvent.type(screen.getByTestId("key-create-name"), "k");
  if (fields.field && ["hash", "stream"].includes(type))
    await userEvent.type(screen.getByTestId("key-edit-field"), fields.field);
  await userEvent.type(
    screen.getByTestId("key-edit-value"),
    fields.value!.replace(/[{[]/g, (c) => c + c),
  );
  await userEvent.click(screen.getByTestId("key-save"));
  return onSaved;
}

describe("web review round 1: Create key never changes an existing key (H2)", () => {
  for (const type of ["hash", "list", "set", "zset", "stream"]) {
    it(`refuses an existing ${type} before writing`, async () => {
      const sent = fakeServer({ EXISTS: { t: "int", v: "1" } });
      const saved = await create(type, { field: "f", value: "v" });
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This key already exists",
      );
      expect(sent).toEqual(["EXISTS"]);
      expect(saved).not.toHaveBeenCalled();
    });
  }
  it("creates JSON with JSON.SET NX and refuses when the document exists", async () => {
    const sent = fakeServer({ "JSON.SET": { t: "nil" } });
    const saved = await create("json", { value: '{"new":true}' });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This key already exists",
    );
    expect(sent).toEqual(["JSON.SET"]);
    expect(saved).not.toHaveBeenCalled();
  });
  it("a hash created between the check and the write keeps its field (HSETNX)", async () => {
    const sent = fakeServer({
      EXISTS: { t: "int", v: "0" },
      HSETNX: { t: "int", v: "0" },
    });
    const saved = await create("hash", { field: "f", value: "v" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This key already exists",
    );
    expect(sent).toEqual(["EXISTS", "HSETNX"]);
    expect(saved).not.toHaveBeenCalled();
  });
  it("a sorted set is created with ZADD NX, a list with RPUSH after the check", async () => {
    let sent = fakeServer({ EXISTS: { t: "int", v: "0" } });
    let saved = await create("zset", { value: "m" });
    expect(sent).toEqual(["EXISTS", "ZADD"]);
    expect(saved).toHaveBeenCalled();
    cleanup();
    sent = fakeServer({ EXISTS: { t: "int", v: "0" } });
    saved = await create("list", { value: "x" });
    expect(sent).toEqual(["EXISTS", "list.push"]);
    expect(saved).toHaveBeenCalled();
  });
});

describe("web review round 1: JSON tree layout (M1)", () => {
  it("JSON tree rows do not reuse the key list's absolutely positioned .tree-row", () => {
    const { container } = render(
      <JsonTree value={{ a: 1, b: { c: "x".repeat(5000) } }} />,
    );
    expect(container.querySelectorAll(".json-row")).toHaveLength(3);
    expect(container.querySelector(".tree-row")).toBeNull();
  });
});

describe("web review round 1: inflated values follow their source (M2)", () => {
  it("a refreshed value replaces the inflated view of the old bytes", async () => {
    const gz = binFromBytes(
      new Uint8Array(gzipSync(Buffer.from("OLD-INFLATED-CONTENT"))),
    );
    const { rerender } = render(<ValueViewer value={gz} />);
    await userEvent.click(screen.getByTestId("value-inflate"));
    expect(await screen.findByText("Inflated locally")).toBeInTheDocument();
    expect(screen.getByTestId("key-value")).toHaveTextContent(
      "OLD-INFLATED-CONTENT",
    );
    rerender(<ValueViewer value={binFromString("NEW-CONTENT")} />);
    expect(screen.getByTestId("key-value")).toHaveTextContent("NEW-CONTENT");
    expect(screen.queryByText("Inflated locally")).toBeNull();
  });
});
