import { describe, expect, it } from "vitest";
import type { CommandDoc, DatabaseSummary } from "@rconsole/shared";
import { commandPolicy } from "./policy.ts";
const database: DatabaseSummary = {
  id: "test",
  name: "Test",
  environment: "test",
  effectiveRole: "operator",
  features: { profiler: false },
  readOnly: false,
  status: "connected",
};
const docs: CommandDoc[] = [
  {
    name: "GET",
    summary: "Get",
    arguments: [],
    class: "read",
    allowed: true,
    group: "string",
  },
  {
    name: "SET",
    summary: "Set",
    arguments: [],
    class: "write",
    allowed: true,
    group: "string",
  },
];
describe("live command policy", () => {
  it("classifies reads from command docs", () =>
    expect(commandPolicy('GET "a b"', docs, database)).toMatchObject({
      class: "read",
      allowed: true,
    }));
  it("classifies writes from docs before execution", () =>
    expect(commandPolicy("SET k v", docs, database)).toMatchObject({
      class: "write",
      allowed: true,
    }));
  it("fails closed for unknown commands", () =>
    expect(commandPolicy("NEVERSEEN k", docs, database).allowed).toBe(false));
  it("shows shared tokenizer errors", () =>
    expect(commandPolicy('GET "bad', docs, database)).toMatchObject({
      allowed: false,
      hint: "Unbalanced quotes",
    }));
  it("blocks unknown subcommands", () =>
    expect(commandPolicy("CLIENT UNKNOWN", docs, database)).toMatchObject({
      class: "blocked",
      allowed: false,
    }));
  it("keeps KEYS blocked despite optimistic docs", () =>
    expect(
      commandPolicy("KEYS *", [{ ...docs[0]!, name: "KEYS" }], database),
    ).toMatchObject({ class: "blocked", allowed: false }));
  it("blocks writes for viewers", () =>
    expect(
      commandPolicy("SET k v", docs, { ...database, effectiveRole: "viewer" })
        .allowed,
    ).toBe(false));
  it("blocks writes on read-only databases for admins", () =>
    expect(
      commandPolicy("SET k v", docs, {
        ...database,
        effectiveRole: "admin",
        readOnly: true,
      }).allowed,
    ).toBe(false));
  it("blocks non-production-only commands in production", () =>
    expect(
      commandPolicy("FLUSHDB", [], {
        ...database,
        effectiveRole: "admin",
        environment: "prod",
      }).allowed,
    ).toBe(false));
  it("honors server allowed=false", () =>
    expect(
      commandPolicy("GET k", [{ ...docs[0]!, allowed: false }], database)
        .allowed,
    ).toBe(false));
  it("directs subscriptions to their dedicated feature", () =>
    expect(commandPolicy("SUBSCRIBE a", docs, database)).toMatchObject({
      class: "dedicated",
      allowed: false,
    }));
  it("blocks empty input", () =>
    expect(commandPolicy(" ", docs, database).allowed).toBe(false));
});

it("read-only policy explains the database restriction before the role hint (web R2 L5)", () => {
  expect(commandPolicy("SET k v", [{ name: "SET", class: "write", allowed: false, hint: "SET requires operator" } as CommandDoc], { ...database, readOnly: true }).hint).toBe("This database is read-only. Writes are refused for every role.");
});

describe("a shared rule for the typed command decides, not the catalog's verdict on the bare name", () => {
  // GET /commands classifies bare names; rules that refuse some argument shapes mark the bare name blocked there
  // (found in the v0.4 r1 live QA: every VSIM greyed out; GRAPH.INFO / MEMORY / SLOWLOG the same on FalkorDB).
  const viewer: DatabaseSummary = { ...database, effectiveRole: "viewer" };
  const admin: DatabaseSummary = { ...database, effectiveRole: "admin" };
  const bare = (name: string, cls: CommandDoc["class"], hint: string): CommandDoc => ({ name, summary: "", arguments: [], class: cls, allowed: false, hint, group: "module" });
  const catalog = [
    bare("graph.INFO", "blocked", "Use GRAPH.INFO ObjectPool; running/waiting queries can disclose other users’ query text."),
    bare("graph.MEMORY", "blocked", "Use GRAPH.MEMORY USAGE graph [SAMPLES count]."),
    bare("graph.SLOWLOG", "blocked", "Only GRAPH.SLOWLOG graph is allowed; RESET is disabled."),
    bare("graph.CONFIG", "blocked", "Only GRAPH.CONFIG GET is allowed."),
    bare("VSIM", "blocked", "This VSIM could not be read"),
  ];
  it("allows the valid shapes for the role the rule asks for", () => {
    for (const line of ["GRAPH.INFO ObjectPool", "GRAPH.MEMORY USAGE g", "GRAPH.MEMORY USAGE g SAMPLES 10", "VSIM k ELE m COUNT 3"]) {
      const p = commandPolicy(line, catalog, viewer);
      expect(p, line).toMatchObject({ class: "read", allowed: true });
      expect(p.hint, line).toBe("Reads data. Makes no changes.");
    }
    expect(commandPolicy("GRAPH.SLOWLOG g", catalog, admin)).toMatchObject({ class: "admin", allowed: true });
    expect(commandPolicy("GRAPH.CONFIG GET TIMEOUT", catalog, admin)).toMatchObject({ class: "admin", allowed: true });
    expect(commandPolicy("GRAPH.SLOWLOG g", catalog, viewer).allowed).toBe(false);
  });
  it("still refuses the shapes the rules refuse", () => {
    expect(commandPolicy("GRAPH.INFO", catalog, admin)).toMatchObject({ class: "blocked", allowed: false });
    expect(commandPolicy("GRAPH.SLOWLOG g RESET", catalog, admin).allowed).toBe(false);
    expect(commandPolicy("VSIM k ELE m TRUTH", catalog, admin).allowed).toBe(false);
  });
  it("commands without a shared rule keep the catalog's verdict", () => {
    const other = [{ ...bare("MODULE.CMD", "read", "Refused by the server for this database."), allowed: false }];
    expect(commandPolicy("MODULE.CMD x", other, admin)).toMatchObject({ allowed: false, hint: "Refused by the server for this database." });
  });
});

describe("refusals by the shared rule say why, as the server does", () => {
  it("names the role a command needs and the role you have (e2e regression after the catalog verdict fix)", () => {
    const viewer: DatabaseSummary = { ...database, effectiveRole: "viewer" };
    const graph = [{ name: "graph.QUERY", summary: "", arguments: [], class: "write" as const, allowed: false, hint: "x", group: "module" }];
    expect(commandPolicy('GRAPH.QUERY g "RETURN 1"', graph, viewer).hint).toBe("GRAPH.QUERY requires the operator role on this database (you have viewer).");
    expect(commandPolicy("SET k v", docs, viewer).hint).toBe("SET requires the operator role on this database (you have viewer).");
    expect(commandPolicy("FLUSHDB", docs, { ...database, environment: "prod", effectiveRole: "admin" }).hint).toMatch(/not allowed on production databases/);
  });
});

describe("admin reads on read-only databases (review v0.4 r2 graph L1)", () => {
  it("allows the reads the server exempts and still refuses admin writes, with the server's reason", () => {
    const ro: DatabaseSummary = { ...database, effectiveRole: "admin", readOnly: true };
    for (const line of ["GRAPH.SLOWLOG g", "GRAPH.CONFIG GET TIMEOUT_MAX", "CONFIG GET maxmemory"]) {
      const p = commandPolicy(line, [], ro);
      expect(p, line).toMatchObject({ class: "admin", allowed: true });
      expect(p.hint, line).not.toMatch(/read-only/);
    }
    expect(commandPolicy("FLUSHDB", [], ro)).toMatchObject({ allowed: false, hint: "This database is read-only. Writes are refused for every role." });
  });
});

describe("argument rules see the bytes the server sees (review v0.4 r3 graph L5)", () => {
  it("the graph query size limit counts UTF-8 bytes in the browser too", () => {
    const viewer: DatabaseSummary = { ...database, effectiveRole: "viewer" };
    // 40,000 é: 80,000 bytes, over the 64 KiB limit; 40,000 a: under it.
    expect(commandPolicy(`GRAPH.RO_QUERY g "RETURN '${"é".repeat(40_000)}'"`, [], viewer)).toMatchObject({ class: "blocked", allowed: false });
    expect(commandPolicy(`GRAPH.RO_QUERY g "RETURN '${"a".repeat(40_000)}'"`, [], viewer)).toMatchObject({ class: "read", allowed: true });
    // Non-ASCII inside a string stays allowed.
    expect(commandPolicy(`GRAPH.RO_QUERY g "RETURN 'Zoë'"`, [], viewer)).toMatchObject({ allowed: true });
  });
});

describe("argument rules count bytes as the server receives them (review v0.4 r4 graph L4, L5)", () => {
  const viewer: DatabaseSummary = { ...database, effectiveRole: "viewer" };
  it("a \\xHH escape is one byte, as the server receives it", () => {
    // 40,000 escaped 0x80 bytes: 40,000 bytes sent (under 64 KiB), 80,000 if each counted as a UTF-8 character.
    expect(commandPolicy(`GRAPH.RO_QUERY g "RETURN '${"\\x80".repeat(40_000)}'"`, [], viewer)).toMatchObject({ allowed: true });
  });
  it("the VSIM FILTER limit counts UTF-8 bytes once (300 × é is 600 bytes)", () => {
    expect(commandPolicy(`VSIM k ELE m FILTER ".name == '${"é".repeat(300)}'"`, [], viewer)).toMatchObject({ allowed: true });
    expect(commandPolicy(`VSIM k ELE m FILTER ".name == '${"é".repeat(520)}'"`, [], viewer).allowed).toBe(false);
  });
});
