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
