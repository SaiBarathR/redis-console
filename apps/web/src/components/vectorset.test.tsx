import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binFromString, type DatabaseSummary, type KeyDetails } from "@rconsole/shared";
import { DatabaseContext } from "../lib/context.tsx";
import { MemoryProvider } from "../lib/memory.tsx";
import { inspectCommands, readCommand } from "./KeyInspector.tsx";
import { parseVector, quantizationLabel, VectorSetDetail, vsimPreview } from "./VectorSetDetail.tsx";

const bin = binFromString;
const operator: DatabaseSummary = { id: "db", name: "DB", environment: "test", readOnly: false, effectiveRole: "operator", features: { profiler: false }, status: "connected" };
const viewer: DatabaseSummary = { ...operator, effectiveRole: "viewer" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HOSTILE = '<img src=x onerror="alert(1)">';
const details = (): { details: KeyDetails; value: Extract<KeyDetails["value"], { type: "vectorset" }> } => {
  const value = {
    type: "vectorset" as const,
    info: { size: 3, dim: 3, quantization: "int8", hnswM: 16, maxLevel: 0, attributesCount: 1 },
    page: { members: [{ member: bin(HOSTILE) }, { member: bin("a") }, { member: bin("b") }] },
  };
  return { details: { key: bin("v"), type: "vectorset", ttl: -1, value }, value };
};
function server(answer: (path: string, body: any) => Response) {
  const sent: { path: string; body: any }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = String(url).replace(/^\/api\/v1\/databases\/db/, "");
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ path, body });
      return answer(path, body);
    }),
  );
  return sent;
}
const mount = (db: DatabaseSummary) => {
  const d = details();
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <MemoryProvider>
          <DatabaseContext value={db}>
            <VectorSetDetail details={d.details} value={d.value} refresh={async () => {}} />
          </DatabaseContext>
        </MemoryProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

describe("vector-set inspector helpers (v0.4 F23)", () => {
  it("parses typed vectors exactly and refuses what Redis would", () => {
    expect(parseVector("0.1, -2e3  .5")).toEqual(["0.1", "-2e3", ".5"]);
    expect(() => parseVector("")).toThrow(/coordinates/);
    expect(() => parseVector("1, inf")).toThrow(/finite decimal/);
    expect(() => parseVector("0x10")).toThrow(/finite decimal/);
  });
  it("previews the VSIM the server will send, with the default filter effort", () => {
    const preview = vsimPreview(bin("my set"), { query: { values: ["1", "0", "0"] }, count: 5, filter: ".even", withAttributes: true });
    expect(preview).toBe('VSIM "my set" VALUES 3 1 0 0 COUNT 5 WITHSCORES WITHATTRIBS FILTER .even FILTER-EF 500');
    expect(vsimPreview(bin("k"), { query: { element: bin("m") }, count: 10 })).toBe('VSIM "k" ELE "m" COUNT 10 WITHSCORES');
  });
  it("copies and explains the reads the inspector makes (review v0.4 r1 L4)", () => {
    const d = details().details;
    expect(readCommand(d)).toBe('VRANGE "v" - + 100');
    expect(inspectCommands(d.key, d)).toContain('VCARD "v"\nVDIM "v"\nVINFO "v"\nVRANGE "v" - + 101');
    expect(inspectCommands(d.key)).toContain("VRANGE");
  });
  it("names quantisation as VADD does", () => {
    expect(quantizationLabel("f32")).toContain("NOQUANT");
    expect(quantizationLabel("int8")).toContain("Q8");
    expect(quantizationLabel("bin")).toContain("BIN");
  });
});

describe("vector-set inspector (v0.4 F23)", () => {
  it("renders member names as text and gives viewers no write controls", async () => {
    server((path) => (path === "/vectorset/attributes" ? json({ attributes: [null, { value: bin('{"k":1}') }, null] }) : json({})));
    const { container } = mount(viewer);
    const members = screen.getByTestId("vset-members");
    expect(within(members).getAllByRole("row")[1]).toHaveTextContent(HOSTILE);
    expect(container.querySelector("img")).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId("vset-attr-cell")[1]).toHaveTextContent('{"k":1}'));
    expect(screen.queryByTestId("vset-remove")).toBeNull();
    expect(screen.getByTestId("vset-summary")).toHaveTextContent("8-bit (Q8)");
  });
  it("a new search clears the last results, so an error never sits above another query's rows", async () => {
    let fail = false;
    server((path) =>
      path === "/vectorset/search"
        ? fail
          ? json({ error: { code: "redis_error", message: "syntax error in FILTER expression" } }, 400)
          : json({ results: [{ member: bin("a"), score: "0.99" }] })
        : json({ attributes: [null, null, null] }),
    );
    mount(viewer);
    await userEvent.click(screen.getByRole("tab", { name: "Similarity search" }));
    await userEvent.type(screen.getByTestId("vset-search-member"), "a");
    await userEvent.click(screen.getByTestId("vset-search-submit"));
    await waitFor(() => expect(screen.getByTestId("vset-search-results")).toHaveTextContent("0.99"));
    fail = true;
    await userEvent.type(screen.getByTestId("vset-search-filter"), ".even == true");
    await userEvent.click(screen.getByTestId("vset-search-submit"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("syntax error"));
    expect(screen.queryByTestId("vset-search-results")).toBeNull();
  });
  it("refuses a vector whose length does not match the set's dimensions before sending", async () => {
    const sent = server(() => json({ attributes: [null, null, null] }));
    mount(operator);
    await userEvent.click(screen.getByRole("tab", { name: "Similarity search" }));
    await userEvent.click(screen.getByTestId("vset-search-by-vector"));
    await userEvent.type(screen.getByTestId("vset-search-vector"), "1, 0");
    expect(screen.getByText("This set has 3 dimensions; the vector has 2.")).toBeInTheDocument();
    expect(screen.getByTestId("vset-search-submit")).toBeDisabled();
    expect(sent.some((s) => s.path === "/vectorset/search")).toBe(false);
  });
});
