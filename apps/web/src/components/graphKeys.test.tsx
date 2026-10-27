/** Review v0.4 r2 graph L4: graph keys are not sized by core MEMORY USAGE and show one type hint. */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binFromString, type DatabaseSummary, type KeyDetails } from "@rconsole/shared";
import { DatabaseContext } from "../lib/context.tsx";
import { MemoryProvider } from "../lib/memory.tsx";
import { KeyContent } from "./KeyContent.tsx";
import { KeyInspector } from "./KeyInspector.tsx";

const db: DatabaseSummary = { id: "db", name: "DB", environment: "test", readOnly: false, effectiveRole: "viewer", features: { profiler: false }, status: "connected" };
const graph = (extra: Partial<KeyDetails> = {}): KeyDetails => ({
  key: binFromString("g"), type: "graphdata", ttl: -1,
  value: { type: "unsupported", message: "Values of type graphdata are not shown in the browser. Use the console (e.g. GRAPH.RO_QUERY in the Workbench, which shows graph results)." },
  ...extra,
});
const wrap = (node: React.ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><MemoryProvider><DatabaseContext value={db}>{node}</DatabaseContext></MemoryProvider></MemoryRouter></QueryClientProvider>;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("graph keys in the key browser (L4)", () => {
  it("shows only the graph hint, not the generic 'does not read this type yet' sentence", () => {
    render(wrap(<KeyContent details={graph()} refresh={async () => {}} />));
    expect(document.body).toHaveTextContent("GRAPH.RO_QUERY in the Workbench");
    expect(document.body).not.toHaveTextContent("does not read this type yet");
  });
  it("keeps the generic sentence for a type without a specific hint", () => {
    const other: KeyDetails = { ...graph(), type: "weird", value: { type: "unsupported", message: "Values of type weird are not shown in the browser. Use the console (e.g. TYPE / OBJECT ENCODING)." } };
    render(wrap(<KeyContent details={other} refresh={async () => {}} />));
    expect(document.body).toHaveTextContent("does not read this type yet");
  });
  it("labels the size of a graph key 'not measured' in the inspector, never a byte count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(graph()), { status: 200, headers: { "Content-Type": "application/json" } })));
    render(wrap(<KeyInspector selected={binFromString("g")} delimiter=":" onDeleted={() => {}} />));
    expect((await screen.findAllByText("not measured")).length).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent(/\b40 B\b/);
  });
  it("does not show a stale core size either when one arrives for a graph key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(graph({ size: 40 })), { status: 200, headers: { "Content-Type": "application/json" } })));
    render(wrap(<KeyInspector selected={binFromString("g")} delimiter=":" onDeleted={() => {}} />));
    expect((await screen.findAllByText("not measured")).length).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent(/\b40 B\b/);
  });
});
