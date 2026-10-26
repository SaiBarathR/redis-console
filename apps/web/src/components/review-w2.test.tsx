import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { binFromBytes, binFromString, bytesFromBin, type DatabaseSummary, type KeyDetails } from "@rconsole/shared";
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

describe("web review round 2", () => {
  it("H1: formatter and path picker preserve number lexemes", () => {
    const pretty = formatValue(binFromString(source), "json");
    for (const token of ["9007199254740993", "1.0", "1.5e3", "-0"]) expect(pretty).toContain(token);
    const paths = jsonPaths(parseValue(binFromString(source)));
    expect(paths.find(p => p.path === '$["big"]')?.json).toBe("9007199254740993");
    expect(paths.find(p => p.path === '$["negativeZero"]')?.json).toBe("-0");
  });
  it("H1: inspector and console trees render exact numbers", async () => {
    render(<><ValueViewer value={binFromString(source)} /><JsonTree value={jsonDocument({ t: "str", v: binFromString(source) })} /></>);
    expect(screen.getByText("9007199254740993")).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Tree" }));
    expect(screen.getAllByText("1.5e3")).toHaveLength(2);
  });
  it("H2: a changed element at the same list index invalidates its draft", async () => {
    const view = (text: string) => wrap(<KeyContent details={list(text)} refresh={async () => {}} />);
    const { rerender } = render(view("A3"));
    await userEvent.click(screen.getByRole("button", { name: "Edit list index 0" }));
    await userEvent.type(screen.getByLabelText("Value at index 0"), " draft");
    rerender(view("A2"));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/list changed/i)).toBeVisible();
    rerender(view("A3"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("H3: leading BOM keys and values round trip without aliasing", () => {
    const bytes = new TextEncoder().encode("\ufeffkey");
    const bin = binFromBytes(bytes);
    expect(bin).toEqual(binFromString("\ufeffkey"));
    expect(bytesFromBin(bin)).toEqual(bytes);
    expect(displayBin(bin)).toBe("\\ufeffkey");
  });
});
