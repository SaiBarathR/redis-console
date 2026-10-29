import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  binFromBytes,
  binFromString,
  type CliResponse,
  type CommandDoc,
  type DatabaseSummary,
} from "@rconsole/shared";
import { DatabaseContext } from "../lib/context.tsx";
import { MemoryProvider } from "../lib/memory.tsx";
import { analyzeCommand, keyFamily } from "../lib/console/language.ts";
import {
  CommandEcho,
  ConsoleResultBlock,
  continueScanLine,
  jsonDocument,
  replyExplanation,
  replySummary,
  replyText,
  resultText,
  type ConsoleResult,
} from "./ConsoleResult.tsx";
import { ConsoleAssist, keysToScan } from "./ConsoleAssist.tsx";
import { cancelledRunSummary, PolicyBadge, Prompt } from "../pages/Console.tsx";
import { historyMatches } from "./HistorySearch.tsx";
const hostile = '<img src=x onerror="alert(1)">';
const db: DatabaseSummary = {
  id: "sandbox-e2e",
  name: "E2E",
  environment: "dev",
  readOnly: false,
  effectiveRole: "operator",
} as DatabaseSummary;
const docs: CommandDoc[] = [
  {
    name: "GET",
    group: "string",
    summary: "Returns the string value of a key.",
    class: "read",
    allowed: true,
    arguments: [{ name: "key", type: "key" }],
  },
  {
    name: "HGETALL",
    group: "hash",
    summary: "Returns all fields and values in a hash.",
    class: "read",
    allowed: true,
    arguments: [{ name: "key", type: "key" }],
  },
  {
    name: "SCAN",
    group: "generic",
    summary: "Iterates over the key names in the database.",
    class: "read",
    allowed: true,
    arguments: [
      { name: "cursor", type: "integer" },
      { name: "pattern", type: "pattern", token: "MATCH", optional: true },
      { name: "count", type: "integer", token: "COUNT", optional: true },
    ],
  },
  {
    name: "PING",
    group: "connection",
    summary: "Returns the server's liveliness response.",
    class: "read",
    allowed: true,
    arguments: [{ name: "message", type: "string", optional: true }],
  },
  {
    name: "EXPIRE",
    group: "generic",
    summary: "Sets the expiration time of a key in seconds.",
    class: "write",
    allowed: true,
    arguments: [
      { name: "key", type: "key" },
      { name: "seconds", type: "integer" },
    ],
  },
];
function renderBlock(result: ConsoleResult, view: "terminal" | "tree" = "terminal") {
  const onDraft = vi.fn();
  render(
    <MemoryRouter>
      <MemoryProvider>
        <DatabaseContext value={db}>
          <ConsoleResultBlock
            result={result}
            view={view}
            docs={docs}
            busy={false}
            onRerun={vi.fn()}
            onDraft={onDraft}
          />
        </DatabaseContext>
      </MemoryProvider>
    </MemoryRouter>,
  );
  return { onDraft };
}
const response = (argv: string[], reply: CliResponse["reply"]): CliResponse =>
  ({ argv, reply, durationMs: 0.4, commandClass: "read" }) as CliResponse;
describe("console results render Redis data as text", () => {
  it("echoes a hostile command line as text spans", () => {
    const { container } = render(
      <CommandEcho line={`GET "${hostile}"`} docs={docs} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(hostile);
    expect(container.querySelector(".console-token-key")?.textContent).toBe(
      `"${hostile}"`,
    );
  });
  it("renders SCAN keys as key-browser links without interpreting markup", async () => {
    const { onDraft } = renderBlock({
      id: "1",
      line: "SCAN 0 MATCH x:* COUNT 10",
      timestamp: Date.now(),
      durationMs: 1,
      response: response(["SCAN", "0", "MATCH", "x:*", "COUNT", "10"], {
        t: "arr",
        v: [
          { t: "str", v: binFromString("17") },
          {
            t: "arr",
            v: [
              { t: "str", v: binFromString(`x:${hostile}`) },
              { t: "str", v: binFromString("x:1001:profile") },
              { t: "str", v: binFromBytes(new Uint8Array([0x62, 0x3a, 0xff, 0x00])) },
            ],
          },
        ],
      }),
    });
    expect(document.querySelector("img")).toBeNull();
    expect(
      screen.getByRole("button", { name: `Open key x:${hostile}` }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open key x:1001:profile" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open key b:\\xff\\x00" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue scan" }));
    expect(onDraft).toHaveBeenCalledWith("SCAN 17 MATCH x:* COUNT 10");
  });
  it("prints INFO-style text raw, like redis-cli, and keeps other strings quoted", () => {
    expect(
      replyText(
        response(["INFO", "keyspace"], {
          t: "str",
          v: binFromString("# Keyspace\r\ndb0:keys=5120\r\n"),
        }),
      ),
    ).toBe("# Keyspace\ndb0:keys=5120");
    expect(
      replyText(response(["GET", "k"], { t: "str", v: binFromString("a\nb") })),
    ).toBe('"a\\nb"');
  });
  it("offers TYPE after a WRONGTYPE error without running it", async () => {
    const { onDraft } = renderBlock({
      id: "2",
      line: "HGETALL session:1",
      timestamp: Date.now(),
      durationMs: 1,
      response: response(["HGETALL", "session:1"], {
        t: "err",
        v: "WRONGTYPE Operation against a key holding the wrong kind of value",
      }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Check its type" }));
    expect(onDraft).toHaveBeenCalledWith("TYPE session:1");
  });
  it("collapses to a one-line summary and keeps an accessible name per action", async () => {
    renderBlock({
      id: "3",
      line: "PING",
      timestamp: Date.now(),
      durationMs: 1,
      response: response(["PING"], { t: "status", v: "PONG" }),
    });
    for (const name of ["Copy result", "Copy JSON", "Copy as code", "Re-run"])
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.getByRole("button", { name: "Expand" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(document.querySelector(".result-preview")?.textContent).toBe("PONG");
  });
  it("folds long replies behind a Show all control", async () => {
    renderBlock({
      id: "4",
      line: "LRANGE big 0 -1",
      timestamp: Date.now(),
      durationMs: 1,
      response: response(["LRANGE", "big", "0", "-1"], {
        t: "arr",
        v: Array.from({ length: 60 }, (_, i) => ({
          t: "str" as const,
          v: binFromString(`item ${i}`),
        })),
      }),
    });
    expect(document.querySelector(".cli-reply")?.textContent).not.toContain(
      "item 59",
    );
    await userEvent.click(screen.getByRole("button", { name: "Show all 60 lines" }));
    expect(document.querySelector(".cli-reply")?.textContent).toContain(
      "item 59",
    );
  });
  it("shows a JSON string as a tree in the tree view, parsed as data only", () => {
    renderBlock(
      {
        id: "5",
        line: "GET cache:item",
        timestamp: Date.now(),
        durationMs: 1,
        response: response(["GET", "cache:item"], {
          t: "str",
          v: binFromString(JSON.stringify({ title: hostile, tags: ["a", "b"] })),
        }),
      },
      "tree",
    );
    expect(document.body).toHaveTextContent("JSON string, shown as a tree");
    expect(document.querySelector(".json-tree")).not.toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(document.body).toHaveTextContent(hostile);
    expect(jsonDocument({ t: "str", v: binFromString("not json") })).toBeUndefined();
    expect(jsonDocument({ t: "str", v: binFromString("42") })).toBeUndefined();
  });
  it("folds a very long single-line reply by length", async () => {
    renderBlock({
      id: "6",
      line: "GET big",
      timestamp: Date.now(),
      durationMs: 1,
      response: response(["GET", "big"], { t: "str", v: binFromString("x".repeat(9000)) }),
    });
    expect(document.querySelector(".cli-reply")!.textContent!.length).toBeLessThan(3000);
    await userEvent.click(screen.getByRole("button", { name: /Show all 9,002 characters/ }));
    expect(document.querySelector(".cli-reply")!.textContent!.length).toBe(9002);
  });
  it("describes replies in one short line for announcements", () => {
    expect(replySummary({ t: "int", v: "5120" })).toBe("(integer) 5120");
    expect(replySummary({ t: "arr", v: [] })).toBe("empty array");
    expect(
      replySummary({
        t: "arr",
        v: [{ t: "nil" }, { t: "nil" }],
      }),
    ).toBe("array of 2 items");
    expect(
      resultText({
        id: "c",
        line: "BLPOP q 5",
        timestamp: 0,
        durationMs: 0,
        cancelled: true,
      }),
    ).toMatch(/may still complete/);
  });
});
describe("console assist", () => {
  const assist = (line: string, workbench = false) =>
    render(
      <ConsoleAssist
        line={line}
        cursorLine={line}
        cursorFull={line}
        docs={docs}
        workbench={workbench}
        onEdit={vi.fn()}
        onDocs={vi.fn()}
      />,
    );
  it("stays quiet while a known command name is still being typed", () => {
    assist("HGETA");
    expect(screen.queryByTestId("command-suggestions")).toBeNull();
  });
  it("suggests close commands for an unknown one", () => {
    assist("PIGN");
    expect(screen.getByTestId("command-suggestions")).toHaveTextContent(
      "Did you mean",
    );
    expect(screen.getByRole("button", { name: "PING" })).toBeInTheDocument();
  });
  it("shows the big-O complexity next to the summary", () => {
    render(
      <ConsoleAssist
        line="GET k"
        cursorLine="GET k"
        cursorFull="GET k"
        docs={[{ ...docs[0]!, complexity: "O(1)" }]}
        workbench={false}
        onEdit={vi.fn()}
        onDocs={vi.fn()}
      />,
    );
    expect(screen.getByTestId("command-docs")).toHaveTextContent("O(1)");
  });
  it("marks the argument at the cursor in the signature", () => {
    assist("EXPIRE session:1 ");
    expect(screen.getByTestId("command-signature")).toHaveTextContent(
      "EXPIRE key seconds",
    );
    expect(document.querySelector("mark[aria-current]")).toHaveTextContent(
      "seconds",
    );
  });
  it("turns KEYS into a bounded SCAN that keeps the pattern", () => {
    expect(keysToScan("KEYS example:group:*")).toBe(
      "SCAN 0 MATCH example:group:* COUNT 100",
    );
    expect(keysToScan("KEYS")).toBe("SCAN 0 MATCH * COUNT 100");
    expect(keysToScan('KEYS "a b*"')).toBe('SCAN 0 MATCH "a b*" COUNT 100');
    // Raw bytes typed as \xHH stay exactly as typed (re-encoding them would match nothing).
    expect(keysToScan('KEYS "\\xef\\xbb\\xbfuser:*"')).toBe('SCAN 0 MATCH "\\xef\\xbb\\xbfuser:*" COUNT 100');
    expect(keysToScan("KEYS 'it\\'s*'")).toBe("SCAN 0 MATCH 'it\\'s*' COUNT 100");
    assist("KEYS user:*");
    expect(screen.getByTestId("keys-guidance")).toHaveTextContent(
      "SCAN 0 MATCH user:* COUNT 100",
    );
  });
  it("explains that console lines joined by Shift+Enter are one command", () => {
    assist("GET k\nvalue");
    expect(document.body).toHaveTextContent("These lines run as one command");
  });
});
describe("console helpers", () => {
  it("continues a SCAN from the returned cursor only", () => {
    expect(continueScanLine("SCAN 0 COUNT 20", "3328")).toBe(
      "SCAN 3328 COUNT 20",
    );
    expect(continueScanLine("scan   0", "12")).toBe("scan   12");
    expect(continueScanLine("SCAN 0", "not-a-cursor")).toBeUndefined();
  });
  it("matches history newest first without duplicates", () => {
    expect(
      historyMatches(["GET a", "SCAN 0", "get b", "GET a"], "get"),
    ).toEqual(["GET a", "get b"]);
    expect(historyMatches(["PING"], "")).toEqual(["PING"]);
  });
  it("colours keys by the type their command works on", () => {
    expect(keyFamily({ name: "HGETALL", group: "hash" })).toBe("hash");
    expect(keyFamily({ name: "ZADD", group: "sorted-set" })).toBe("zset");
    expect(keyFamily({ name: "GEOADD", group: "geo" })).toBe("zset");
    expect(keyFamily({ name: "SETBIT", group: "bitmap" })).toBe("string");
    expect(keyFamily({ name: "JSON.GET", group: "module" })).toBe("json");
    expect(keyFamily({ name: "TS.ADD", group: "module" })).toBe("timeseries");
    expect(keyFamily({ name: "BF.ADD", group: "module" })).toBe("probabilistic");
    expect(keyFamily({ name: "VADD", group: "module" })).toBe("vector");
    expect(keyFamily({ name: "DEL", group: "generic" })).toBeUndefined();
    expect(analyzeCommand("HGETALL k", docs).family).toBe("hash");
  });
  it("flags a non-numeric number argument and a finished unknown command", () => {
    const expire = analyzeCommand("EXPIRE k soon", docs).tokens;
    expect(expire[2]).toMatchObject({ role: "number", invalid: true });
    expect(analyzeCommand("EXPIRE k 60", docs).tokens[2]?.invalid).toBeUndefined();
    expect(analyzeCommand("NOPE ", docs).tokens[0]?.invalid).toBe(true);
    expect(analyzeCommand("NOP", docs).tokens[0]?.invalid).toBeUndefined();
  });
});

describe("prompt and policy per environment", () => {
  const show = (summary: DatabaseSummary, line: string) =>
    render(
      <DatabaseContext value={summary}>
        <Prompt id="p" />
        <PolicyBadge line={line} docs={docs} />
      </DatabaseContext>,
    );
  it("marks production on the prompt edge and asks for confirmation on every write", () => {
    show({ ...db, id: "orders-prod", environment: "prod", effectiveRole: "admin" }, "EXPIRE k 60");
    const prompt = screen.getByTestId("console-prompt");
    expect(prompt).toHaveAttribute("data-environment", "prod");
    expect(prompt).toHaveTextContent("orders-prod");
    expect(prompt).toHaveTextContent("Production");
    expect(prompt).toHaveTextContent("admin");
    expect(screen.getByTestId("policy-badge")).toHaveTextContent(
      "write · needs confirmation",
    );
  });
  it("shows read-only and the effective role, and blocks writes", () => {
    show({ ...db, readOnly: true, effectiveRole: "viewer" }, "EXPIRE k 60");
    const prompt = screen.getByTestId("console-prompt");
    expect(prompt).toHaveAttribute("data-readonly", "true");
    expect(prompt).toHaveTextContent("read-only");
    expect(prompt).toHaveTextContent("viewer");
    expect(screen.getByTestId("policy-badge")).toHaveTextContent("blocked");
  });
  it("says blocked once for a command that is blocked outright", () => {
    show(db, "NOPE x");
    expect(screen.getByTestId("policy-badge")).toHaveTextContent(/^blocked/);
    expect(screen.getByTestId("policy-badge")).not.toHaveTextContent("blocked · blocked");
  });
});

describe("console review round 1", () => {
  const response = (argv: string[], reply: CliResponse["reply"]): CliResponse => ({
    argv,
    commandClass: "read",
    durationMs: 0.1,
    reply,
  });
  it("explains conventional empty replies in domain terms and keeps the raw reply (UX 5)", () => {
    expect(replyExplanation(response(["GET", "k"], { t: "nil" }))).toBe("The key does not exist.");
    expect(replyExplanation(response(["TTL", "k"], { t: "int", v: "-1" }))).toBe("The key exists and has no expiry.");
    expect(replyExplanation(response(["pttl", "k"], { t: "int", v: "-2" }))).toBe("The key does not exist.");
    expect(replyExplanation(response(["TTL", "k"], { t: "int", v: "42" }))).toBeUndefined();
    expect(replyExplanation(response(["XINFO", "GROUPS", "s"], { t: "arr", v: [] }))).toBe("The stream has no consumer groups.");
    expect(replyExplanation(response(["TYPE", "k"], { t: "str", v: binFromString("none") }))).toBe("The key does not exist.");
    expect(replyExplanation(response(["BLPOP", "k", "1"], { t: "nil" }))).toBe("Timed out with nothing to pop.");
    expect(replyExplanation(response(["PING"], { t: "str", v: binFromString("PONG") }))).toBeUndefined();
    const result: ConsoleResult = { id: "1", line: "TTL k", timestamp: 0, durationMs: 1, response: response(["TTL", "k"], { t: "int", v: "-1" }) };
    renderBlock(result);
    expect(screen.getByTestId("result-explanation")).toHaveTextContent("no expiry");
    expect(screen.getByTestId("console-result")).toHaveTextContent("(integer) -1");
  });
  it("says which lines of a cancelled Workbench run finished, may have run and were not sent (H1)", () => {
    const base = { timestamp: 0, durationMs: 1, runId: "r" };
    const run = { total: 10, cancelled: "stopped" as const };
    const ok = (n: number): ConsoleResult => ({ ...base, id: `${n}`, line: "PING", lineNumber: n, run, response: response(["PING"], { t: "str", v: binFromString("PONG") }) });
    const group = [ok(1), ok(2), ok(3), { ...base, id: "4", line: "SET k v", lineNumber: 4, run, cancelled: true }];
    expect(cancelledRunSummary(group)).toBe("cancelled · 3 finished · line 4 may have run · 6 not run");
    expect(cancelledRunSummary([ok(1), ok(2)])).toBe("cancelled · 2 finished · 8 not run");
    expect(cancelledRunSummary([{ ...base, id: "x", line: "PING\nSET k v", run: { total: 2, cancelled: "unknown" }, cancelled: true }])).toBe(
      "cancelled · which lines ran is unknown",
    );
    expect(cancelledRunSummary([{ ...base, id: "y", line: "DEL k", run: { total: 1, cancelled: "declined" }, cancelled: true }])).toBe(
      "cancelled at the confirmation · nothing ran",
    );
    expect(resultText({ ...base, id: "z", line: "SET k v", cancelled: true, cancelNote: "Redis may have run it" })).toBe("Redis may have run it");
  });
});
