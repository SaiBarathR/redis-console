import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import {
  lookupRule,
  tokenizeCommandLine,
  type AnalysisReport,
  type CliResponse,
  type DatabaseSummary,
  type ImportPlan,
  type SearchSampleResponse,
} from "@rconsole/shared";
import { DatabaseContext } from "../lib/context.tsx";
import { MemoryProvider } from "../lib/memory.tsx";
import { RichReply } from "../components/RichReply.tsx";
import { ConsoleResultBlock } from "../components/ConsoleResult.tsx";
import { TUTORIALS } from "../content/tutorials.ts";
import { withInserted } from "./guided/Tutorials.tsx";
import { ImportPanel, countCommands } from "./guided/ImportPanel.tsx";
import { Guided } from "./Guided.tsx";
import { completionsFor, fieldCompletion, fieldRef, QueryEditor, type Completion } from "./search/QueryEditor.tsx";

/** A completion with its cursor drawn as "▮", for readable expectations. */
const shown = (c: Completion) => c.insert.slice(0, c.cursor) + "▮" + c.insert.slice(c.cursor);
import { documentColumns, formArgv } from "./search/QueryPanel.tsx";
import { EMPTY_FORM, defaultIndexName, folderPrefixes } from "./search/state.ts";
import { IndexWizard } from "./search/IndexWizard.tsx";
import { Comparison, coverageText, type StoredReport } from "./analysis/AnalysisTool.tsx";
import { insightPaletteEntries } from "../lib/insightPalette.ts";

afterEach(() => vi.unstubAllGlobals());

const db = (over: Partial<DatabaseSummary> = {}): DatabaseSummary => ({
  id: "db",
  name: "DB",
  environment: "test",
  effectiveRole: "admin",
  features: { profiler: false },
  readOnly: false,
  status: "connected",
  server: { version: "8", mode: "standalone", modules: [{ name: "search", version: "8" }, { name: "ReJSON", version: "8" }, { name: "timeseries", version: "8" }] },
  ...over,
});
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function wrap(children: ReactNode, database = db(), path = "/db/db/x") {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryProvider>
        <DatabaseContext value={database}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/db/db/keys" element={<p>Key browser</p>} />
              <Route path="/db/db/workbench" element={<p>Workbench page</p>} />
              <Route path="*" element={children} />
            </Routes>
          </MemoryRouter>
        </DatabaseContext>
      </MemoryProvider>
    </QueryClientProvider>
  );
}

describe("rich results render data as text and open documents by exact bytes", () => {
  it("search table: HTML-looking values stay text; the open action passes the binary id", async () => {
    const onOpen = vi.fn();
    const reply = {
      t: "map" as const,
      v: [
        [{ t: "str" as const, v: { enc: "utf8" as const, data: "results" } }, { t: "arr" as const, v: [{ t: "map" as const, v: [
          [{ t: "str" as const, v: { enc: "utf8" as const, data: "id" } }, { t: "str" as const, v: { enc: "base64" as const, data: "a2V5/w==" } }],
          [{ t: "str" as const, v: { enc: "utf8" as const, data: "extra_attributes" } }, { t: "map" as const, v: [[{ t: "str" as const, v: { enc: "utf8" as const, data: "title" } }, { t: "str" as const, v: { enc: "utf8" as const, data: '<img src=x onerror="window.__xss=1">' } }]] as [never, never][] }],
        ] as [never, never][] }] }],
        [{ t: "str" as const, v: { enc: "utf8" as const, data: "total_results" } }, { t: "int" as const, v: "1" }],
      ] as [never, never][],
    };
    const { container } = render(<RichReply kind="search" reply={reply} onOpen={onOpen} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText('<img src=x onerror="window.__xss=1">')).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Open key key\\xff/ }));
    expect(onOpen).toHaveBeenCalledWith({ enc: "base64", data: "a2V5/w==" });
  });

  it("console results: tree view shows the rich view; each result toggles back to the reply", async () => {
    const response: CliResponse = {
      argv: ["FT.EXPLAIN", "idx", "@t:x"],
      commandClass: "read",
      durationMs: 1,
      reply: { t: "str", v: { enc: "utf8", data: "INTERSECT {\n  @t:x\n}\n" } },
    };
    render(wrap(<ConsoleResultBlock result={{ id: "1", line: "FT.EXPLAIN idx @t:x", timestamp: 0, durationMs: 1, response }} view="tree" docs={[]} busy={false} onRerun={() => {}} />));
    expect(screen.getByTestId("result-rich")).toHaveAttribute("data-kind", "explain");
    expect(screen.getByTestId("plan-tree")).toHaveTextContent("INTERSECT");
    await userEvent.click(within(screen.getByTestId("result-rich-toggle")).getByRole("button", { name: "Tree" }));
    expect(screen.queryByTestId("result-rich")).toBeNull();
  });

  it("console results: the transcript view keeps the redis-cli text until the result asks for the chart", async () => {
    const response: CliResponse = {
      argv: ["TS.RANGE", "k", "-", "+"],
      commandClass: "read",
      durationMs: 1,
      reply: { t: "arr", v: [{ t: "arr", v: [{ t: "int", v: "1000" }, { t: "dbl", v: "1.5" }] }] },
    };
    render(wrap(<ConsoleResultBlock result={{ id: "1", line: "TS.RANGE k - +", timestamp: 0, durationMs: 1, response }} view="terminal" docs={[]} busy={false} onRerun={() => {}} />));
    expect(screen.queryByTestId("result-rich")).toBeNull();
    await userEvent.click(within(screen.getByTestId("result-rich-toggle")).getByRole("button", { name: "Chart" }));
    expect(screen.getByTestId("result-rich")).toHaveAttribute("data-kind", "series");
  });
});

// Review v0.2.1 web M2: a bounded rich view discloses what it leaves out and offers the complete raw reply.
describe("rich view bounds are disclosed", () => {
  const str = (data: string) => ({ t: "str" as const, v: { enc: "utf8" as const, data } });
  it("TS.MRANGE with 13 series: 12 drawn, a persistent 12 of 13 notice, and the raw reply one click away", async () => {
    const reply = {
      t: "map" as const,
      v: Array.from({ length: 13 }, (_, n) => [
        str(`rw:series:${n}`),
        { t: "arr" as const, v: [{ t: "map" as const, v: [[str("rw"), str("1")]] }, { t: "arr" as const, v: [] }, { t: "arr" as const, v: [1].map((ts) => ({ t: "arr" as const, v: [{ t: "int" as const, v: String(ts) }, { t: "dbl" as const, v: String(n) }] })) }] },
      ]),
    } as CliResponse["reply"];
    const response: CliResponse = { argv: ["TS.MRANGE", "-", "+", "FILTER", "rw=1"], commandClass: "read", durationMs: 1, reply };
    const { container } = render(wrap(<ConsoleResultBlock result={{ id: "1", line: "TS.MRANGE - + FILTER rw=1", timestamp: 0, durationMs: 1, response }} view="tree" docs={[]} busy={false} onRerun={() => {}} />));
    expect(container.querySelectorAll(".rich-series")).toHaveLength(12);
    expect(screen.getByTestId("rich-limit")).toHaveTextContent("Showing 12 of 13 series. 1 not drawn.");
    expect(screen.getByTestId("result-rich")).not.toHaveTextContent("rw:series:12");
    await userEvent.click(screen.getByTestId("rich-limit-raw"));
    expect(screen.queryByTestId("result-rich")).toBeNull();
    expect(container).toHaveTextContent("rw:series:12");
  });

  it("twelve series or fewer show no notice; a wide table names its 40 of 45 columns", () => {
    const series = (count: number) => ({ t: "map" as const, v: Array.from({ length: count }, (_, n) => [str(`k${n}`), { t: "arr" as const, v: [{ t: "map" as const, v: [] }, { t: "arr" as const, v: [] }] }]) }) as CliResponse["reply"];
    const { unmount } = render(<RichReply kind="multiSeries" reply={series(12)} />);
    expect(screen.queryByTestId("rich-limit")).toBeNull();
    unmount();
    const wide = {
      t: "map" as const,
      v: [
        [str("results"), { t: "arr" as const, v: [{ t: "map" as const, v: [[str("id"), str("d")], [str("extra_attributes"), { t: "map" as const, v: Array.from({ length: 45 }, (_, n) => [str(`f${n}`), str("v")]) }]] }] }],
        [str("total_results"), { t: "int" as const, v: "1" }],
      ],
    } as CliResponse["reply"];
    render(<RichReply kind="search" reply={wide} />);
    expect(screen.getByTestId("rich-limit")).toHaveTextContent("Showing 40 of 45 columns.");
    expect(screen.queryByTestId("rich-limit-raw")).toBeNull();
  });
});

describe("search workflow", () => {
  it("completion: @ lists fields with the syntax of their type; Ctrl+Space adds operators", () => {
    const fields = [{ name: "title", type: "TEXT" }, { name: "category", type: "TAG" }, { name: "price", type: "NUMERIC" }];
    expect(completionsFor("@ca", 3, fields, "query").items.map(shown)).toEqual(["@category:{▮}"]);
    expect(completionsFor("hello", 5, fields, "query").items).toEqual([]);
    expect(completionsFor("", 0, fields, "query", true).items.some((c) => c.label === "%fuzzy%")).toBe(true);
    expect(completionsFor("GRO", 3, fields, "pipeline", true).items[0]!.label).toBe("GROUPBY");
    expect(shown(fieldCompletion({ name: "price", type: "NUMERIC" }))).toBe("@price:[▮ +inf]");
    // The OR snippet keeps its literal pipe; only the first one in the template marks the cursor.
    expect(shown(completionsFor("", 0, fields, "query", true).items.find((c) => c.detail === "OR")!)).toBe("(▮ | )");
  });

  it("escapes punctuation in field names and never takes a | in a name for the cursor (v0.4 S1)", () => {
    expect(fieldRef("a|b")).toBe("@a\\|b");
    expect(fieldRef("my-num")).toBe("@my\\-num");
    expect(fieldRef("plain_name1")).toBe("@plain_name1");
    expect(shown(fieldCompletion({ name: "a|b", type: "TAG" }))).toBe("@a\\|b:{▮}");
    expect(shown(fieldCompletion({ name: "my-num", type: "NUMERIC" }))).toBe("@my\\-num:[▮ +inf]");
    expect(shown(fieldCompletion({ name: "a|b", type: "TEXT" }))).toBe("@a\\|b:▮");
    expect(fieldCompletion({ name: "a|b", type: "TAG" }).label).toBe("@a|b");
  });

  it("the editor accepts a completion with Enter and runs with Enter otherwise", async () => {
    const onRun = vi.fn();
    let latest = "";
    function Harness() {
      const [value, setValue] = useState("");
      latest = value;
      return <QueryEditor value={value} onChange={setValue} onRun={onRun} fields={[{ name: "category", type: "TAG" }]} label="Search query" testId="q" />;
    }
    render(<Harness />);
    await userEvent.type(screen.getByTestId("q"), "@c");
    expect(screen.getByRole("listbox")).toHaveTextContent("@category");
    await userEvent.keyboard("{Enter}");
    expect(latest).toBe("@category:{}");
    expect(onRun).not.toHaveBeenCalled();
    await userEvent.keyboard("tools{Enter}");
    expect(latest).toBe("@category:{tools}");
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("completing a field whose name contains | puts the cursor inside the braces (v0.4 S1)", async () => {
    let latest = "";
    function Harness() {
      const [value, setValue] = useState("");
      latest = value;
      return <QueryEditor value={value} onChange={setValue} onRun={() => {}} fields={[{ name: "a|b", type: "TAG" }]} label="Search query" testId="q" />;
    }
    render(<Harness />);
    await userEvent.type(screen.getByTestId("q"), "@a");
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("x");
    expect(latest).toBe("@a\\|b:{x}");
  });

  it("the exact command for each mode (no data in URLs; DD never offered by the query view)", () => {
    const f = { ...EMPTY_FORM, index: "idx", query: "@t:x", sortBy: "price", sortOrder: "DESC" as const, returnFields: ["t"], dialect: 2 };
    expect(formArgv(f)).toEqual(["FT.SEARCH", "idx", "@t:x", "RETURN", "1", "t", "SORTBY", "price", "DESC", "LIMIT", "0", "20", "DIALECT", "2"]);
    expect(formArgv({ ...f, mode: "aggregate", pipeline: 'GROUPBY 1 @c REDUCE COUNT 0 AS "n n"' })).toEqual(["FT.AGGREGATE", "idx", "@t:x", "GROUPBY", "1", "@c", "REDUCE", "COUNT", "0", "AS", "n n", "DIALECT", "2"]);
    expect(formArgv(f, 0, "explain")).toEqual(["FT.EXPLAIN", "idx", "@t:x", "DIALECT", "2"]);
    expect(formArgv(f, 0, "profile").slice(0, 5)).toEqual(["FT.PROFILE", "idx", "SEARCH", "QUERY", "@t:x"]);
  });

  it("JSON documents spread into columns with exact numbers", () => {
    expect(documentColumns({ $: '{"name":"Ada","n":9007199254740993,"tags":["a"]}', score: "1" })).toEqual([
      ["$.name", "Ada"],
      ["$.n", "9007199254740993"],
      ["$.tags", '["a"]'],
      ["score", "1"],
    ]);
    expect(documentColumns({ $: "not json {" })).toEqual([["$", "not json {"]]);
  });

  it("prefix helpers", () => {
    expect(folderPrefixes("a:b:c", ":")).toEqual(["a:", "a:b:"]);
    expect(folderPrefixes("abc", ":")).toEqual([]);
    expect(defaultIndexName("example:group: items:")).toBe("idx:example:group:_items");
  });

  it("wizard: sampled fields become an editable schema and the exact FT.CREATE; viewers cannot create", async () => {
    const sample: SearchSampleResponse = {
      on: "HASH", prefix: "product:", sampled: 3, skipped: 0, scanned: 100, complete: true, ignored: [], overlapping: [{ name: "old", prefixes: ["product:"] }],
      fields: [
        { name: "title", suggested: "TEXT", seen: 3, types: { TEXT: 3 }, examples: ["Blue gadget"] },
        { name: "price", suggested: "NUMERIC", seen: 3, types: { NUMERIC: 3 }, examples: ["25"] },
      ],
    };
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return url.endsWith("/search/sample") ? json(sample) : json({});
    }));
    render(wrap(<IndexWizard onCreated={() => {}} />, db({ effectiveRole: "viewer" })));
    await userEvent.type(screen.getByTestId("wizard-prefix"), "product:");
    await userEvent.click(screen.getByTestId("wizard-sample"));
    await screen.findByTestId("wizard-sampled");
    expect(screen.getByText(/already cover keys like these/)).toBeInTheDocument();
    expect(screen.getAllByTestId("wizard-field-row")).toHaveLength(2);
    await userEvent.selectOptions(screen.getByLabelText("Type of title"), "TAG");
    await userEvent.click(screen.getByTestId("wizard-next"));
    expect(screen.getByTestId("wizard-command")).toHaveTextContent("FT.CREATE idx:product ON HASH PREFIX 1 product: SCHEMA title TAG price NUMERIC");
    expect(screen.getByTestId("wizard-create")).toBeDisabled();
    expect(bodies[0]).toEqual({ on: "HASH", prefix: "product:", keys: 20 });
  });

  // Review v0.2.1 web M1: a sample answered late for an earlier source must not become the schema of another source.
  describe("wizard: the schema belongs to the source the FT.CREATE indexes", () => {
    const sampleOf = (on: "HASH" | "JSON", prefix: string, field: string): SearchSampleResponse => ({
      on, prefix, sampled: 1, skipped: 0, scanned: 10, complete: true, ignored: [], overlapping: [],
      fields: [{ name: on === "JSON" ? `$.${field}` : field, suggested: "TEXT", seen: 1, types: { TEXT: 1 }, examples: ["x"], ...(on === "JSON" ? { as: field } : {}) }],
    });
    /** Holds every sample response until `release` is called, like a slow server. */
    function heldSamples() {
      const pending: { body: { on: "HASH" | "JSON"; prefix: string }; resolve: (r: Response) => void }[] = [];
      vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (!url.endsWith("/search/sample")) return Promise.resolve(json({}));
        return new Promise<Response>((resolve) => pending.push({ body, resolve }));
      }));
      const release = (i: number, field: string) => pending[i]!.resolve(json(sampleOf(pending[i]!.body.on, pending[i]!.body.prefix, field)));
      return { pending, release };
    }

    it("locks the source controls while sampling", async () => {
      const { pending, release } = heldSamples();
      render(wrap(<IndexWizard onCreated={() => {}} />));
      await userEvent.type(screen.getByTestId("wizard-prefix"), "a:");
      await userEvent.click(screen.getByTestId("wizard-sample"));
      await waitFor(() => expect(pending).toHaveLength(1));
      expect(screen.getByTestId("wizard-prefix")).toBeDisabled();
      expect(screen.getByTestId("wizard-on-json")).toBeDisabled();
      expect(screen.getByTestId("wizard-on-hash")).toBeDisabled();
      release(0, "name");
      await screen.findByTestId("wizard-sampled");
      await userEvent.click(screen.getByTestId("wizard-next"));
      expect(screen.getByTestId("wizard-command")).toHaveTextContent("FT.CREATE idx:a ON HASH PREFIX 1 a: SCHEMA name TEXT");
    });

    it("drops a late response after a prefix change", async () => {
      const { pending, release } = heldSamples();
      render(wrap(<IndexWizard onCreated={() => {}} />));
      await userEvent.type(screen.getByTestId("wizard-prefix"), "a:");
      await userEvent.click(screen.getByTestId("wizard-sample"));
      await waitFor(() => expect(pending).toHaveLength(1));
      // The input is disabled; a change event that still reaches it (another input path) must invalidate the sample.
      fireEvent.change(screen.getByTestId("wizard-prefix"), { target: { value: "b:" } });
      release(0, "name");
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByTestId("wizard-sampled")).toBeNull();
      expect(screen.getByTestId("wizard-prefix")).toHaveValue("b:");
      await userEvent.click(screen.getByTestId("wizard-sample"));
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(pending[1]!.body).toMatchObject({ on: "HASH", prefix: "b:" });
      release(1, "username");
      await screen.findByTestId("wizard-sampled");
      await userEvent.click(screen.getByTestId("wizard-next"));
      expect(screen.getByTestId("wizard-command")).toHaveTextContent("FT.CREATE idx:b ON HASH PREFIX 1 b: SCHEMA username TEXT");
      expect(screen.queryByTestId("wizard-problems")).toBeNull();
    });

    it("drops a late response after a key type change, and going back to change the source clears the schema", async () => {
      const { pending, release } = heldSamples();
      render(wrap(<IndexWizard onCreated={() => {}} />));
      await userEvent.type(screen.getByTestId("wizard-prefix"), "a:");
      await userEvent.click(screen.getByTestId("wizard-sample"));
      await waitFor(() => expect(pending).toHaveLength(1));
      fireEvent.click(screen.getByTestId("wizard-on-json"));
      fireEvent.change(screen.getByTestId("wizard-on-json"), { target: { checked: true } });
      release(0, "name");
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByTestId("wizard-sampled")).toBeNull();
      await userEvent.click(screen.getByTestId("wizard-sample"));
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(pending[1]!.body).toMatchObject({ on: "JSON", prefix: "a:" });
      release(1, "title");
      await screen.findByTestId("wizard-sampled");
      await userEvent.click(screen.getByTestId("wizard-next"));
      expect(screen.getByTestId("wizard-command")).toHaveTextContent("FT.CREATE idx:a ON JSON PREFIX 1 a: SCHEMA $.title AS title TEXT");
      // Back to the source step: a new prefix invalidates the reviewed schema until it is sampled again.
      await userEvent.click(screen.getByText("Back"));
      await userEvent.click(screen.getByTestId("wizard-back"));
      await userEvent.type(screen.getByTestId("wizard-prefix"), "x");
      expect(screen.queryByTestId("wizard-field-row")).toBeNull();
      expect(screen.queryByTestId("wizard-next")).toBeNull();
    });
  });

  it("palette destinations carry fixed words only and follow the modules", () => {
    const entries = insightPaletteEntries("/db/x", db());
    expect(entries.map((e) => e.path)).toEqual([
      "/db/x/diagnostics/search",
      "/db/x/diagnostics/search?panel=indexes",
      "/db/x/diagnostics/search?panel=create",
      "/db/x/diagnostics/analysis",
      "/db/x/guided?tab=tutorials",
      "/db/x/guided?tab=import",
    ]);
    expect(insightPaletteEntries("/db/x", db({ server: { version: "7", mode: "standalone", modules: [] } })).some((e) => e.path.includes("search"))).toBe(false);
    // Imports are an operator feature (review v0.2.1 F1): no palette entry for a viewer, also on a read-only database.
    expect(insightPaletteEntries("/db/x", db({ effectiveRole: "viewer" })).some((e) => e.path.includes("import"))).toBe(false);
    expect(insightPaletteEntries("/db/x", db({ effectiveRole: "operator", readOnly: true })).some((e) => e.path.includes("import"))).toBe(true);
  });
});

describe("analysis reports", () => {
  const report = (over: Partial<AnalysisReport> = {}): AnalysisReport => ({
    sampled: 1000, dbSize: 4000, durationMs: 10, totalSampledBytes: 1_000_000,
    byType: [{ type: "string", keys: 1000, bytes: 1_000_000 }], topKeysBySize: [], topKeysByLength: [],
    prefixes: [{ prefix: "a:", keys: 1000, bytes: 1_000_000 }], ttl: { noExpiry: 10, lt1h: 0, lt1d: 0, lt7d: 0, gt7d: 990 },
    recommendations: [], coverage: { sampled: 1000, dbSize: 4000, complete: false, stoppedBy: "sampleLimit" },
    ...over,
  });
  it("coverage says how much of the keyspace a report is based on", () => {
    expect(coverageText(report())).toBe("Based on 1,000 sampled keys of 4,000 in the database (25%); sampling stopped at the sample limit.");
  });
  it("comparison shows deltas and recommendation changes, and warns about different parameters", () => {
    const a: StoredReport = { id: "a", at: 0, params: { match: "*", sampleSize: 1000, delimiter: ":" }, report: report() };
    const b: StoredReport = {
      id: "b", at: 1, params: { match: "a:*", sampleSize: 1000, delimiter: ":" },
      report: report({ dbSize: 4100, ttl: { noExpiry: 30, lt1h: 0, lt1d: 0, lt7d: 0, gt7d: 970 }, recommendations: [{ id: "bigKeys", severity: "medium", title: "", detail: "", action: "", affected: 1, basis: 1000, keys: [] }] }),
    };
    render(wrap(<Comparison a={a} b={b} />));
    const c = screen.getByTestId("analysis-comparison");
    expect(c).toHaveTextContent("different patterns");
    expect(c).toHaveTextContent("+100");
    expect(c).toHaveTextContent("+20");
    expect(c).toHaveTextContent("new: bigKeys");
  });
});

describe("tutorials (offline, reviewed, insertable)", () => {
  it("every script line parses like the workbench and is not refused by a static rule; writes stay under tutorial:", () => {
    for (const t of TUTORIALS)
      for (const step of t.steps)
        for (const line of (step.script ?? "").split("\n").filter((l) => l.trim() && !l.startsWith("#"))) {
          const argv = tokenizeCommandLine(line);
          expect(lookupRule(argv)?.class, `${t.id}: ${line}`).not.toBe("blocked");
          const keyish = argv.slice(1).filter((a) => /^[a-z]+:[^ ]+/.test(a) && !a.startsWith("idx:"));
          for (const k of keyish) if (!/^(tutorial:|spring:session|example)/.test(k) && !k.startsWith("$")) expect(k, `${t.id}: ${line}`).toMatch(/^(tutorial:|spring:)/);
        }
  });
  it("inserting appends under a comment naming the step", () => {
    const t = TUTORIALS[0]!;
    expect(withInserted("PING\n\n", t, t.steps[0]!)).toBe(`PING\n\n# ${t.title} · ${t.steps[0]!.title}\n${t.steps[0]!.script}`);
    expect(withInserted("", t, t.steps[1]!)).toBe(`# ${t.title} · ${t.steps[1]!.title}\n${t.steps[1]!.script}`);
  });
  it("covers Search, JSON, Streams, TimeSeries and Spring/Node caching", () => {
    expect(TUTORIALS.map((t) => t.id)).toEqual(["search", "json", "streams", "timeseries", "spring-cache", "node-cache"]);
  });
});

describe("import", () => {
  it("is hidden for a viewer: no Guided tab, ?tab=import shows the tasks, the panel itself only explains (review v0.2.1 F1)", () => {
    const fetchMock = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchMock);
    const viewer = db({ effectiveRole: "viewer" });
    const { unmount } = render(wrap(<Guided />, viewer, "/db/db/guided?tab=import"));
    expect(screen.getByTestId("guided-tab-tasks")).toBeInTheDocument();
    expect(screen.getByTestId("guided-tab-tutorials")).toBeInTheDocument();
    expect(screen.queryByTestId("guided-tab-import")).toBeNull();
    expect(screen.queryByTestId("import-panel")).toBeNull();
    unmount();
    render(wrap(<ImportPanel />, viewer));
    expect(screen.getByTestId("import-panel")).toHaveTextContent("needs the operator role");
    expect(screen.queryByTestId("import-text")).toBeNull();
    expect(screen.queryByTestId("import-check")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("shows the Import tab to an operator, with the read-only notice on a read-only database", () => {
    render(wrap(<Guided />, db({ effectiveRole: "operator", readOnly: true }), "/db/db/guided?tab=import"));
    expect(screen.getByTestId("guided-tab-import")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("import-panel")).toHaveTextContent("This database is read-only");
    expect(screen.getByTestId("import-text")).toBeInTheDocument();
  });
  it("counts commands like the server (blank and comment lines skipped)", () => {
    expect(countCommands("# c\n\nSET a 1\r\n  // x\nGET a\n")).toBe(2);
  });
  it("lists refused lines and only starts after they are removed or skipped", async () => {
    const plan: ImportPlan = {
      id: "p1", total: 3, counts: { read: 1, write: 1, admin: 0, blocked: 1 }, destructive: 0,
      blocked: [{ line: 3, command: "FLUSHALL", reason: "FLUSHALL is blocked by policy." }], confirmation: "confirm", expiresAt: Date.now() + 60_000,
    };
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/import")) return json(plan);
      if (url.endsWith("/start")) return json({ id: "p1", state: "running", total: 3, processed: 0, succeeded: 0, failed: 0, skipped: 0, chunks: { size: 100, done: 0, total: 1 }, failures: [] });
      return json({ id: "p1", state: "done", total: 3, processed: 2, succeeded: 1, failed: 1, skipped: 1, chunks: { size: 100, done: 1, total: 1 }, failures: [{ command: "LPUSH", code: "redis_error", message: "WRONGTYPE <b>x</b>", count: 1, lines: [2] }] });
    }));
    render(wrap(<ImportPanel />));
    await userEvent.type(screen.getByTestId("import-text"), "GET a\nLPUSH a x\nFLUSHALL");
    await userEvent.click(screen.getByTestId("import-check"));
    const p = await screen.findByTestId("import-plan");
    expect(p).toHaveTextContent("1 refused");
    expect(p).toHaveTextContent("FLUSHALL is blocked by policy.");
    expect(screen.getByTestId("import-start")).toBeDisabled();
    await userEvent.click(screen.getByTestId("import-skip-blocked"));
    await userEvent.click(screen.getByTestId("import-start"));
    await waitFor(() => expect(screen.getByTestId("import-status")).toHaveAttribute("data-state", "done"));
    expect(screen.getByTestId("import-status")).toHaveTextContent("WRONGTYPE <b>x</b>");
    expect(screen.getByTestId("import-status").querySelector("b")).toBeNull();
    expect(calls.every((u) => !u.includes("FLUSHALL") && !u.includes("LPUSH"))).toBe(true);
  });
});
