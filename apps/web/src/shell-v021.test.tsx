/** v0.2.1 SHELL stream: drawer (F27), command catalog and profiler (F25), status metrics (F5/F13), landing (F21),
 * Pub/Sub (F22), slow log (F19) and preferences (F26). */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  binFromString,
  type CommandDoc,
  type DatabaseOverview,
  type DatabaseSummary,
  type Me,
  type ProfilerEvent,
  type PubSubMessage,
} from "@rconsole/shared";
import { DatabaseContext } from "./lib/context.tsx";
import { MemoryProvider } from "./lib/memory.tsx";
import { LiveProvider, LiveSession } from "./lib/live.tsx";
import {
  DEFAULT_PREFERENCES,
  ageLabel,
  defaultValueFormat,
  formatDateTime,
  formatTime,
  getPreferences,
  reloadPreferences,
  resetPreferences,
  sanitizePreferences,
  setPreferences,
} from "./lib/preferences.ts";
import { cpuBetween, shellMetrics, summarizeOverview, type DatabaseStats } from "./lib/dbstats.ts";
import { capabilities, sortDatabases } from "./pages/Landing.tsx";
import { Preferences } from "./pages/Preferences.tsx";
import { addTopic, formatMessage, messagesText } from "./components/diagnostics/PubSub.tsx";
import { PROFILER_LOG_FILENAME, Profiler, downloadProfilerLog, profilerShown, profilerText } from "./components/diagnostics/Profiler.tsx";
import { durationText, thresholdText } from "./components/diagnostics/Slowlog.tsx";
import { CommandHelper, filterCatalog, groupLabel } from "./components/drawer/CommandHelper.tsx";
import { clampDrawerHeight, drawerPanes, drawerTabs, ToolsDrawer } from "./components/drawer/ToolsDrawer.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { catalogueConflicts, shortcut } from "./lib/keyboard/registry.ts";

const db = (over: Partial<DatabaseSummary> = {}): DatabaseSummary => ({
  id: "sandbox",
  name: "Sandbox",
  environment: "dev",
  readOnly: false,
  effectiveRole: "admin",
  features: { profiler: true },
  status: "connected",
  db: 0,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  reloadPreferences();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("preferences (F26)", () => {
  it("keeps only known fields with allowed values", () => {
    const p = sanitizePreferences({
      timeZone: "utc",
      hourCycle: "bogus",
      toolRefreshSeconds: 7,
      editorFontSize: 16,
      drawerHeight: 99999,
      key: "user:1001",
      __proto__: { drawerOpen: true },
    });
    expect(p.timeZone).toBe("utc");
    expect(p.hourCycle).toBe(DEFAULT_PREFERENCES.hourCycle);
    expect(p.toolRefreshSeconds).toBe(0);
    expect(p.editorFontSize).toBe(16);
    expect(p.drawerHeight).toBe(2000);
    expect(p.drawerOpen).toBe(false);
    expect(Object.keys(p).sort()).toEqual(Object.keys(DEFAULT_PREFERENCES).sort());
    expect(sanitizePreferences("x")).toEqual(DEFAULT_PREFERENCES);
    expect(sanitizePreferences([1])).toEqual(DEFAULT_PREFERENCES);
  });

  it("stores only values that differ from the defaults, under one key, and survives junk in storage", () => {
    setPreferences({ timeZone: "utc", drawerOpen: true });
    expect(JSON.parse(localStorage.getItem("rconsole.preferences")!)).toEqual({ timeZone: "utc", drawerOpen: true });
    resetPreferences();
    expect(localStorage.getItem("rconsole.preferences")).toBeNull();
    localStorage.setItem("rconsole.preferences", "{not json");
    reloadPreferences();
    expect(getPreferences()).toEqual(DEFAULT_PREFERENCES);
    // Unknown values never reach storage, even when a caller passes them.
    setPreferences({ landingSort: "evil" as never, timeZone: "utc" });
    expect(localStorage.getItem("rconsole.preferences")).toBe('{"timeZone":"utc"}');
  });

  it("formats times in UTC or local, 24 or 12 hour, ISO or locale", () => {
    const t = Date.UTC(2026, 9, 24, 14, 3, 9);
    expect(formatTime(t, { timeZone: "utc", hourCycle: "h23", dateStyle: "iso" })).toBe("14:03:09Z");
    expect(formatDateTime(t, { timeZone: "utc", hourCycle: "h23", dateStyle: "iso" })).toBe("2026-10-24 14:03:09Z");
    expect(formatDateTime(t, { timeZone: "utc", hourCycle: "h12", dateStyle: "iso" })).toBe("2026-10-24 02:03:09 PM Z".replace(" Z", "Z"));
    expect(formatTime(t, { timeZone: "utc", hourCycle: "h23", dateStyle: "locale" })).toMatch(/14:03:09 UTC$/);
    expect(formatDateTime(Number.NaN)).toBe("—");
    expect(ageLabel(1000, 1000)).toBe("just now");
    expect(ageLabel(0, 30_000)).toBe("30 s ago");
    expect(ageLabel(0, 600_000)).toBe("10 min ago");
  });

  it("chooses the string value format from the preference", () => {
    expect(defaultValueFormat("utf8", "text")).toBe("text");
    expect(defaultValueFormat("base64", "text")).toBe("text");
    expect(defaultValueFormat("base64", "binary-hex")).toBe("hex");
    expect(defaultValueFormat("utf8", "binary-hex")).toBe("text");
    expect(defaultValueFormat("utf8", "hex")).toBe("hex");
  });
});

// Review v0.2.1 web: the scan-size copy separates the server's hard limit from the user's own threshold.
describe("preferences page copy", () => {
  it("names the server's scan limit and the user-selectable Keys to scan separately, and offers the drawer layout", () => {
    render(<MemoryRouter><Preferences /></MemoryRouter>);
    const policy = screen.getByTestId("pref-server-policy");
    expect(policy).toHaveTextContent("The server sets the most keys one key-browser scan may cover");
    expect(policy).toHaveTextContent("up to that limit, is your choice: Keys to scan");
    expect(policy).not.toHaveTextContent(/^Scan sizes/);
    expect(screen.getByText("Side by side")).toBeInTheDocument();
  });
});

const overview = (keyspace: DatabaseOverview["keyspace"], cpu?: [string, string], uptime = 100): DatabaseOverview => ({
  id: "sandbox",
  info: { server: { redis_version: "8.2.1" }, ...(cpu ? { cpu: { used_cpu_sys: cpu[0], used_cpu_user: cpu[1] } } : {}) },
  keyspace,
  memory: { used: 1024, peak: 2048, maxmemory: 0, fragmentationRatio: 1, policy: "noeviction" },
  clients: { connected: 4, blocked: 0 },
  stats: { opsPerSec: 12, hitRate: 0.5, totalCommands: 1, evictedKeys: 0, expiredKeys: 0 },
  uptimeSeconds: uptime,
});

describe("status figures (F5, F13)", () => {
  it("counts the configured logical database separately from the server total", () => {
    const ks = [
      { db: 0, keys: 100, expires: 10, avgTtl: 0 },
      { db: 3, keys: 7, expires: 1, avgTtl: 0 },
    ];
    const s3 = summarizeOverview(overview(ks), 2, 1000, 3);
    expect(s3).toMatchObject({ keys: 7, expires: 1, serverKeys: 107, dbKnown: true, db: 3 });
    // A logical database without keys is absent from INFO keyspace: zero, not the server total.
    expect(summarizeOverview(overview(ks), 2, 1000, 5).keys).toBe(0);
    // Older servers do not report the index: the server total, labelled as before.
    expect(summarizeOverview(overview(ks), 2, 1000)).toMatchObject({ keys: 107, dbKnown: false });
  });

  it("derives CPU from two readings and refuses a figure across a restart or a short interval", () => {
    const first = summarizeOverview(overview([], ["10", "5"]), 1, 0, 0);
    expect(first.cpuPercent).toBeNull();
    const second = summarizeOverview(overview([], ["10.5", "5.5"], 130), 1, 10_000, 0, first);
    expect(second.cpuPercent).toBe(10);
    const restarted = summarizeOverview(overview([], ["0.1", "0.1"], 5), 1, 20_000, 0, second);
    expect(restarted.cpuPercent).toBeNull();
    expect(cpuBetween({ cpuSeconds: 1, readAt: 0, uptimeSeconds: 1 }, { cpuSeconds: 2, readAt: 500, uptimeSeconds: 2 })).toBeNull();
    expect(summarizeOverview(overview([]), 1, 0, 0).cpuSeconds).toBeNull();
  });

  it("prefers a newer live sample, else the INFO reading", () => {
    const stats = { ...summarizeOverview(overview([]), 1, 5000, 0), cpuPercent: 3 } as DatabaseStats;
    expect(shellMetrics(stats, undefined)).toMatchObject({ source: "poll", cpuPercent: 3, opsPerSec: 12 });
    const sample = { t: 6000, opsPerSec: 99, usedMemory: 5, connectedClients: 2, hitRate: null, netInputKbps: 0, netOutputKbps: 0, cpuSys: 1.25, cpuUser: 0.5 };
    expect(shellMetrics(stats, sample)).toMatchObject({ source: "live", cpuPercent: 1.8, opsPerSec: 99, clients: 2 });
    expect(shellMetrics(stats, { ...sample, t: 4000 })?.source).toBe("poll");
    expect(shellMetrics(undefined, undefined)).toBeUndefined();
  });

  it("the status bar always shows the logical database and says when figures are unavailable", () => {
    const me: Me = { id: "u", username: "u", displayName: "U", source: "local", role: "admin", csrfToken: "c", totpEnabled: false, mustChangePassword: false, mustEnrollTotp: false, sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString() };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StatusBar db={db({ db: 3, status: "error", statusMessage: "down" })} me={me} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("status-keys")).toHaveTextContent("db 3");
    expect(screen.getByTestId("status-freshness")).toHaveTextContent("unavailable");
    expect(screen.getByTestId("status-metrics")).toHaveTextContent("server");
    expect(screen.getByTestId("status-cpu")).toHaveTextContent("CPU —");
  });
});

describe("landing (F21)", () => {
  const dbs = [db({ id: "a", name: "Alpha" }), db({ id: "b", name: "Bravo" }), db({ id: "c", name: "Charlie", status: "error" })];
  const stats = new Map<string, DatabaseStats | undefined>([
    ["a", { keys: 5, opsPerSec: 1, memory: 10, hitRate: null } as DatabaseStats],
    ["b", { keys: 50, opsPerSec: 0, memory: 5, hitRate: 0.9 } as DatabaseStats],
    ["c", undefined],
  ]);
  it("sorts by metric with unknown figures last in both directions, by name, or the default order", () => {
    const ids = (list: DatabaseSummary[]) => list.map((d) => d.id).join("");
    expect(ids(sortDatabases(dbs, "", "keys", true, stats))).toBe("bac");
    expect(ids(sortDatabases(dbs, "", "keys", false, stats))).toBe("abc");
    expect(ids(sortDatabases(dbs, "", "hitRate", true, stats))).toBe("bac");
    expect(ids(sortDatabases(dbs, "", "name", true, stats))).toBe("cba");
    expect(ids(sortDatabases(dbs, "b", "default", false, stats))).toBe("bac");
  });
  it("derives display-only capability badges from reported modules and server-allowed tools", () => {
    const labels = capabilities(
      db({ server: { version: "8", mode: "cluster", modules: [{ name: "search", version: "1" }, { name: "ReJSON", version: "1" }, { name: "timeseries", version: "1" }] } }),
    ).map((c) => c.label);
    expect(labels).toEqual(["Search", "JSON", "TimeSeries", "Cluster", "Profiler"]);
    expect(capabilities(db({ features: { profiler: false } }))).toEqual([]);
  });
});

const message = (channel: string, text: string, pattern?: string): PubSubMessage => ({ t: Date.UTC(2026, 0, 1), channel, message: binFromString(text), ...(pattern ? { pattern } : {}) });

describe("Pub/Sub (F22)", () => {
  it("adds topics up to the server limit without duplicates", () => {
    let topics = { channels: [] as string[], patterns: [] as string[] };
    for (let i = 0; i < 10; i++) {
      const next = addTopic(topics, i % 2 ? "patterns" : "channels", `t${i}`);
      expect(typeof next).toBe("object");
      topics = next as typeof topics;
    }
    expect(addTopic(topics, "channels", "t11")).toMatch(/At most 10/);
    expect(addTopic({ channels: ["a"], patterns: [] }, "channels", "a")).toMatch(/already/);
    expect(addTopic({ channels: [], patterns: [] }, "channels", "")).toMatch(/Type/);
  });
  it("formats messages and falls back to text, saying so", () => {
    expect(formatMessage(message("c", '{"a":1}'), "json").text).toBe('{\n  "a": 1\n}');
    const notJson = formatMessage(message("c", "<b>hi</b>"), "json");
    expect(notJson.text).toBe("<b>hi</b>");
    expect(notJson.note).toMatch(/Not JSON/);
    expect(formatMessage(message("c", "AB"), "hex").text).toMatch(/^00000000 {2}41 42/);
  });
  it("copies the shown messages as tab-separated lines", () => {
    setPreferences({ timeZone: "utc", dateStyle: "iso" });
    expect(messagesText([message("orders", "x"), message("o.1", "y", "o.*")], "text")).toBe(
      "2026-01-01 00:00:00Z\torders\t\tx\n2026-01-01 00:00:00Z\to.1\to.*\ty",
    );
  });
});

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
  const push = (frame: string) => controller.enqueue(encoder.encode(frame));
  frames.forEach(push);
  return { response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }), push, end: () => controller.close() };
}

describe("live sessions (F22, F27)", () => {
  it("keeps a bounded buffer, freezes a snapshot, clears and stops", async () => {
    const stream = sseResponse([`data: ${JSON.stringify(message("c", "1"))}\n\n`]);
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));
    const session = new LiveSession<PubSubMessage>(2);
    session.start("/x", 60_000);
    await waitFor(() => expect(session.snapshot().events).toHaveLength(1));
    expect(session.snapshot().status).toBe("live");
    session.freeze(true);
    stream.push(`data: ${JSON.stringify(message("c", "2"))}\n\n`);
    stream.push(`data: ${JSON.stringify(message("c", "3"))}\n\n`);
    stream.push(`event: dropped\ndata: {"dropped":4}\n\n`);
    await waitFor(() => expect(session.snapshot().received).toBe(3));
    expect(session.snapshot().events.map((e) => e.message.data)).toEqual(["2", "3"]);
    expect(session.snapshot().frozen?.events).toHaveLength(1);
    expect(session.snapshot().dropped).toBe(4);
    session.clear();
    expect(session.snapshot().events).toEqual([]);
    expect(session.snapshot().frozen?.events).toEqual([]);
    session.stop();
    expect(session.snapshot().status).toBe("closed");
    expect(session.active).toBe(false);
  });
  it("reports the server's end and refusals", async () => {
    const ended = sseResponse([`event: end\ndata: {"reason":"Time limit reached"}\n\n`]);
    vi.stubGlobal("fetch", vi.fn(async () => ended.response));
    const session = new LiveSession<ProfilerEvent>(10);
    session.start("/x", 1000);
    await waitFor(() => expect(session.snapshot().status).toBe("closed"));
    expect(session.snapshot().message).toBe("Time limit reached");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "rate_limited", message: "Too many streams" } }), { status: 429 })));
    session.start("/x", 1000);
    await waitFor(() => expect(session.snapshot().status).toBe("error"));
    expect(session.snapshot().message).toMatch(/HTTP 429.*Too many streams/);
  });
});

describe("profiler (F25)", () => {
  const ev = (client: string, argv: string[]): ProfilerEvent => ({ t: Date.UTC(2026, 0, 1), db: 0, client, argv });
  it("filters own connections and by command, and copies redis-cli style lines", () => {
    const events = [ev("10.0.0.1:1", ["GET", "k"]), ev("10.0.0.2:2", ["HGET", "h", "a b"])];
    expect(profilerShown(events, new Set(["10.0.0.1:1"]), true, "")).toHaveLength(1);
    expect(profilerShown(events, new Set(["10.0.0.1:1"]), false, "hg")).toHaveLength(1);
    expect(profilerShown(events, new Set(), false, "")).toHaveLength(2);
    setPreferences({ timeZone: "utc", dateStyle: "iso" });
    expect(profilerText(events.slice(1))).toBe('2026-01-01 00:00:00Z [0 10.0.0.2:2] HGET h "a b"');
  });
});

// Review v0.2.1 web L4: a local file of the shown (bounded) commands with a static name.
describe("profiler log download", () => {
  it("saves exactly the shown lines as redis-profiler.log through an opaque Blob URL that is revoked", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const blobs: Blob[] = [];
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn((b: Blob) => (blobs.push(b), "blob:opaque")), revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe(PROFILER_LOG_FILENAME);
      expect(this.href).toBe("blob:opaque");
    });
    setPreferences({ timeZone: "utc", dateStyle: "iso" });
    const events: ProfilerEvent[] = [{ t: Date.UTC(2026, 0, 1), db: 0, client: "10.0.0.2:2", argv: ["HGET", "user:secret-key", "a b"] }];
    downloadProfilerLog(events);
    expect(PROFILER_LOG_FILENAME).toBe("redis-profiler.log");
    expect(click).toHaveBeenCalledTimes(1);
    expect(await blobs[0]!.text()).toBe('2026-01-01 00:00:00Z [0 10.0.0.2:2] HGET user:secret-key "a b"\n');
    expect(document.querySelector("a[download]")).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith("blob:opaque");
    click.mockRestore();
  });
});

describe("profiler controls (F25)", () => {
  it("Stop ends the session and does not start a new one", async () => {
    const streams: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/profiler/stream")) {
          streams.push(url);
          return sseResponse([]).response;
        }
        return new Response(JSON.stringify({ clients: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DatabaseContext value={db()}>
          <LiveProvider>
            <Profiler compact />
          </LiveProvider>
        </DatabaseContext>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByTestId("drawer-profiler-start"));
    await userEvent.click(await screen.findByTestId("drawer-profiler-stop"));
    expect(await screen.findByTestId("drawer-profiler-start")).toBeInTheDocument();
    expect(screen.queryByTestId("drawer-profiler-stop")).toBeNull();
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatch(/seconds=15$/);
  });
});

describe("slow log (F19)", () => {
  it("explains the threshold and formats durations", () => {
    expect(thresholdText(-1)).toMatch(/off/);
    expect(thresholdText(0)).toMatch(/every command/);
    expect(thresholdText(10_000)).toBe("Records commands slower than 10 ms");
    expect(thresholdText(500)).toBe("Records commands slower than 500 µs");
    expect(durationText(12_345, "ms")).toBe("12.35 ms");
    expect(durationText(12_345, "us")).toMatch(/^12.345 µs$|^12,345 µs$/);
  });
});

const doc = (name: string, group: string, allowed = true, summary = ""): CommandDoc => ({ name, group, allowed, summary, class: allowed ? "read" : "write", arguments: [] });

describe("command helper (F25)", () => {
  const docs = [doc("HGET", "hash", true, "Returns a field"), doc("HSET", "hash", false), doc("GET", "string", true, "Returns the value"), doc("GETEX", "string", false, "Get and set expiry"), doc("EXPIRE", "generic", false, "Set a timeout; get")];
  it("filters by search, group and policy, name matches first", () => {
    const names = (groups: ReturnType<typeof filterCatalog>) => groups.map(([g, list]) => `${g}:${list.map((d) => d.name).join(",")}`);
    expect(names(filterCatalog(docs, "get", "", "all"))).toEqual(["generic:EXPIRE", "hash:HGET", "string:GET,GETEX"]);
    expect(names(filterCatalog(docs, "", "hash", "all"))).toEqual(["hash:HGET,HSET"]);
    expect(names(filterCatalog(docs, "", "", "allowed"))).toEqual(["hash:HGET", "string:GET"]);
    expect(names(filterCatalog(docs, "", "", "not-allowed"))).toEqual(["generic:EXPIRE", "hash:HSET", "string:GETEX"]);
    expect(groupLabel("sorted-set")).toBe("Sorted set");
    expect(groupLabel("")).toBe("Other");
  });
});

// Review v0.2.1 web L1: the detail and Insert follow the filtered list, never a selection the filters hide.
describe("command helper selection follows the filters", () => {
  const catalog = [doc("HSET", "hash", true, "Sets fields"), doc("HGET", "hash", true, "Returns a field"), doc("GET", "string", true, "Returns the value"), doc("GETEX", "string", true, "Get and set expiry")];
  const mountHelper = (onInsert: (c: string) => void) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ commands: catalog }), { status: 200, headers: { "content-type": "application/json" } })));
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <DatabaseContext value={db()}>
          <CommandHelper onInsert={onInsert} />
        </DatabaseContext>
      </QueryClientProvider>,
    );
  };
  const selectedName = () => screen.getAllByTestId("command-helper-item").find((b) => b.getAttribute("aria-selected") === "true")?.querySelector("code")?.textContent;

  it("a search that hides the selection selects and inserts its first result, and forgets the hidden one", async () => {
    const onInsert = vi.fn();
    mountHelper(onInsert);
    const search = await screen.findByTestId("command-helper-search");
    await userEvent.type(search, "HSET");
    await userEvent.click(screen.getByRole("option", { name: /HSET/ }));
    expect(screen.getByTestId("command-helper-detail")).toHaveTextContent("HSET");
    await userEvent.clear(search);
    await userEvent.type(search, "GET");
    // The first listed result (groups are in name order, so the hash group's HGET comes first).
    await waitFor(() => expect(selectedName()).toBe("HGET"));
    expect(screen.getByTestId("command-helper-detail")).not.toHaveTextContent("HSET");
    await userEvent.click(screen.getByTestId("command-helper-insert"));
    expect(onInsert).toHaveBeenLastCalledWith("HGET ");
    // Clearing the search does not bring the hidden HSET back: the first listed command is shown.
    await userEvent.clear(search);
    await waitFor(() => expect(screen.getAllByTestId("command-helper-item")).toHaveLength(4));
    expect(selectedName()).toBe("HGET");
    expect(screen.getByTestId("command-helper-detail")).not.toHaveTextContent("HSET");
  });

  it("a group filter that excludes the selection resets it; a selection still listed is kept", async () => {
    const onInsert = vi.fn();
    mountHelper(onInsert);
    await screen.findByTestId("command-helper-search");
    await userEvent.click(screen.getByRole("option", { name: /GETEX/ }));
    await userEvent.selectOptions(screen.getByTestId("command-helper-group"), "string");
    expect(selectedName()).toBe("GETEX");
    await userEvent.selectOptions(screen.getByTestId("command-helper-group"), "hash");
    await waitFor(() => expect(selectedName()).toBe("HGET"));
    await userEvent.click(screen.getByTestId("command-helper-insert"));
    expect(onInsert).toHaveBeenLastCalledWith("HGET ");
  });
});

describe("tools drawer (F27)", () => {
  it("offers the profiler only where the server allows it and clamps the height", () => {
    expect(drawerTabs({ profiler: false }).map((t) => t.id)).toEqual(["console", "helper"]);
    expect(drawerTabs({ profiler: true }).map((t) => t.id)).toEqual(["console", "helper", "profiler"]);
    expect(clampDrawerHeight(10, 1000)).toBe(160);
    expect(clampDrawerHeight(900, 1000)).toBe(750);
    expect(clampDrawerHeight(300, 1000)).toBe(300);
  });

  it("has a conflict-free shortcut in the registry", () => {
    expect(shortcut("drawer").keys).toEqual(["Ctrl+`"]);
    expect(catalogueConflicts(true)).toEqual([]);
    expect(catalogueConflicts(false)).toEqual([]);
  });

  const mount = (database: DatabaseSummary) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ commands: [doc("GET", "string")] }), { status: 200, headers: { "content-type": "application/json" } })));
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/db/sandbox/keys"]}>
          <MemoryProvider>
            <DatabaseContext value={database}>
              <LiveProvider>
                <ToolsDrawer />
              </LiveProvider>
            </DatabaseContext>
          </MemoryProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  };

  it("is collapsed by default, opens on a tab, remembers only the open state, and shows the role context", async () => {
    mount(db({ effectiveRole: "viewer", features: { profiler: false }, readOnly: true, db: 2 }));
    expect(screen.getByTestId("tools-drawer")).toHaveAttribute("data-open", "false");
    expect(screen.queryByTestId("drawer-tab-profiler")).toBeNull();
    expect(screen.getByTestId("tools-drawer")).toHaveTextContent("db 2");
    expect(screen.getByTestId("tools-drawer")).toHaveTextContent("read-only");
    await userEvent.click(screen.getByTestId("drawer-tab-helper"));
    expect(screen.getByTestId("tools-drawer")).toHaveAttribute("data-open", "true");
    expect(await screen.findByTestId("command-helper")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("rconsole.preferences")!)).toEqual({ drawerOpen: true, drawerTab: "helper" });
    await userEvent.click(screen.getByTestId("drawer-toggle"));
    expect(screen.getByTestId("tools-drawer")).toHaveAttribute("data-open", "false");
  });

  // Review v0.2.1 web L5: an optional side-by-side layout; tabs stay the default.
  it("lays out one tool by default, or the Console beside the helper or profiler", () => {
    expect(drawerPanes("helper", false, false)).toEqual(["helper"]);
    expect(drawerPanes("console", true, false)).toEqual(["console", "helper"]);
    expect(drawerPanes("profiler", true, false)).toEqual(["console", "profiler"]);
    expect(drawerPanes("helper", true, true)).toEqual(["helper"]);
    expect(DEFAULT_PREFERENCES.drawerSplit).toBe(false);
    expect(sanitizePreferences({ drawerSplit: "yes" }).drawerSplit).toBe(false);
  });

  it("side by side shows the Console and the helper together, in focus order, and insertion keeps both", async () => {
    setPreferences({ drawerOpen: true, drawerTab: "helper" });
    mount(db());
    expect(screen.queryByTestId("drawer-pane-console")).toBeNull();
    expect(screen.getByTestId("drawer-split")).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByTestId("drawer-split"));
    expect(getPreferences().drawerSplit).toBe(true);
    const left = await screen.findByTestId("drawer-pane-console");
    const right = screen.getByTestId("drawer-pane-helper");
    expect(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(left).toHaveAttribute("role", "tabpanel");
    expect(screen.getByTestId("drawer-tab-console")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("drawer-tab-helper")).toHaveAttribute("aria-selected", "true");
    await screen.findByTestId("command-helper-insert");
    expect(screen.getByTestId("drawer-pane-console").querySelector(".cm-content")?.textContent ?? "").not.toContain("GET");
    await userEvent.click(await screen.findByTestId("command-helper-insert"));
    await waitFor(() => expect(screen.getByTestId("drawer-pane-console").querySelector(".cm-content")?.textContent).toContain("GET"));
    // Both stay visible: the helper does not give way to the Console.
    expect(screen.getByTestId("drawer-pane-helper")).toBeInTheDocument();
    expect(screen.getByTestId("drawer-pane-console")).toBeInTheDocument();
    // The profiler tab replaces the helper on the right; the Console stays.
    await userEvent.click(screen.getByTestId("drawer-tab-profiler"));
    expect(await screen.findByTestId("drawer-pane-profiler")).toBeInTheDocument();
    expect(screen.queryByTestId("drawer-pane-helper")).toBeNull();
    expect(screen.getByTestId("drawer-pane-console")).toBeInTheDocument();
    // The keyboard resize still works side by side.
    act(() => screen.getByTestId("drawer-resizer").focus());
    await userEvent.keyboard("{ArrowUp}");
    expect(getPreferences().drawerHeight).toBe(344);
    await userEvent.click(screen.getByTestId("drawer-split"));
    expect(screen.queryByTestId("drawer-pane-console")).toBeNull();
    expect(screen.getByTestId("drawer-panel")).toHaveAttribute("role", "tabpanel");
  });

  it("resizes with the keyboard within bounds", async () => {
    setPreferences({ drawerOpen: true, drawerTab: "helper", drawerHeight: 300 });
    mount(db());
    const separator = screen.getByTestId("drawer-resizer");
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    act(() => separator.focus());
    await userEvent.keyboard("{ArrowUp}");
    expect(getPreferences().drawerHeight).toBe(324);
    await userEvent.keyboard("{Home}");
    expect(getPreferences().drawerHeight).toBe(160);
    expect(screen.getByTestId("drawer-tab-profiler")).toBeInTheDocument();
  });
});
