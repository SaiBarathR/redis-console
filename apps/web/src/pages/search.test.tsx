import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSummary, SearchResult } from "@rconsole/shared";
import { DatabaseContext } from "../lib/context.tsx";
import { MemoryProvider } from "../lib/memory.tsx";
import { Diagnostics } from "./Diagnostics.tsx";

afterEach(() => vi.unstubAllGlobals());

const db: DatabaseSummary = {
  id: "db",
  name: "DB",
  environment: "test",
  effectiveRole: "viewer",
  features: { profiler: false },
  readOnly: false,
  status: "connected",
  server: { version: "8", mode: "standalone", modules: [{ name: "search", version: "8" }] },
};
const json = (data: unknown) =>
  new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

function setup(page: (body: { query: string; offset: number }) => SearchResult) {
  const queries: { index: string; query: string; offset: number }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/search/indexes"))
        return json({
          indexes: [{ name: "idx", numDocs: 26, indexing: false, prefixes: [], fields: [] }],
        });
      if (url.endsWith("/search/query")) {
        const body = JSON.parse(String(init?.body));
        queries.push(body);
        return json(page(body));
      }
      return json({});
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryProvider>
        <DatabaseContext value={db}>
          <MemoryRouter initialEntries={["/db/db/diagnostics/search"]}>
            <Routes>
              <Route path="/db/db/diagnostics/:tool" element={<Diagnostics />} />
              <Route path="/db/db/keys" element={<p>Key browser</p>} />
            </Routes>
          </MemoryRouter>
        </DatabaseContext>
      </MemoryProvider>
    </QueryClientProvider>,
  );
  return queries;
}

describe("web review round 1: Search (M5, M6)", () => {
  it("M6: paging uses the last executed query, not an unsubmitted draft", async () => {
    const queries = setup(({ offset }) => ({
      total: 26,
      docs: Array.from({ length: offset ? 6 : 20 }, (_, i) => ({ id: `d${offset + i}`, fields: {} })),
    }));
    await screen.findByRole("option", { name: "idx" });
    await userEvent.selectOptions(screen.getByTestId("search-index"), "idx");
    await userEvent.clear(screen.getByTestId("search-query"));
    await userEvent.type(screen.getByTestId("search-query"), "*");
    await userEvent.click(screen.getByTestId("search-run"));
    await screen.findByText("26 results");
    await userEvent.clear(screen.getByTestId("search-query"));
    await userEvent.type(screen.getByTestId("search-query"), "@n:[[1 1]");
    await userEvent.click(screen.getByRole("button", { name: "Next 20" }));
    await waitFor(() => expect(queries).toHaveLength(2));
    expect(queries[1]).toMatchObject({ index: "idx", query: "*", offset: 20 });
    await userEvent.click(screen.getByTestId("search-run"));
    await waitFor(() => expect(queries).toHaveLength(3));
    expect(queries[2]).toMatchObject({ query: "@n:[1 1]", offset: 0 });
  });

  it("M5: cut and budget-exhausted documents are marked, with Open in key browser", async () => {
    setup(() => ({
      total: 3,
      docs: [
        { id: "doc:short", fields: { title: "complete" } },
        { id: "doc:cut", fields: { title: "L".repeat(4097) }, truncated: true },
        { id: "doc:none", fields: {} as Record<string, string>, truncated: true },
      ],
    }));
    await screen.findByRole("option", { name: "idx" });
    await userEvent.selectOptions(screen.getByTestId("search-index"), "idx");
    await userEvent.click(screen.getByTestId("search-run"));
    const notices = await screen.findAllByTestId("search-doc-truncated");
    expect(notices).toHaveLength(2);
    expect(notices[0]).toHaveTextContent("Preview cut");
    expect(notices[1]).toHaveTextContent("Fields not returned");
    await userEvent.click(screen.getAllByRole("button", { name: "Open in key browser" })[0]!);
    expect(await screen.findByText("Key browser")).toBeInTheDocument();
  });

  it("withheld document ids (server sends id '' + idBytes) are labelled and never offered as a key", async () => {
    setup(() => ({
      total: 2,
      docs: [
        { id: "doc:ok", fields: { title: "x" } },
        { id: "", idBytes: 70000, fields: {} as Record<string, string>, truncated: true },
      ],
    }));
    await screen.findByRole("option", { name: "idx" });
    await userEvent.selectOptions(screen.getByTestId("search-index"), "idx");
    await userEvent.click(screen.getByTestId("search-run"));
    const withheld = await screen.findByTestId("search-doc-id-withheld");
    expect(withheld).toHaveTextContent("ID withheld (70,000 bytes, too large to list)");
    expect(screen.queryAllByRole("button", { name: "Open in key browser" })).toHaveLength(0);
  });
});
