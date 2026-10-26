import { describe, expect, it } from "vitest";
import {
  analyzeCommand,
  commandSuggestions,
  historySuggestion,
  lex,
  optionTokens,
  validNumber,
} from "./language.ts";
import type { CommandDoc } from "@rconsole/shared";
const docs: CommandDoc[] = [
  {
    name: "SET",
    class: "write",
    allowed: true,
    group: "string",
    summary: "",
    arguments: [
      { name: "key", type: "key" },
      { name: "value", type: "string" },
      {
        name: "condition",
        type: "oneof",
        optional: true,
        arguments: [
          { name: "nx", type: "pure-token", token: "NX" },
          { name: "xx", type: "pure-token", token: "XX" },
        ],
      },
      {
        name: "expiration",
        type: "oneof",
        optional: true,
        arguments: [
          { name: "seconds", type: "integer", token: "EX" },
          { name: "milliseconds", type: "integer", token: "PX" },
        ],
      },
    ],
  },
  {
    name: "MEMORY USAGE",
    class: "read",
    allowed: true,
    group: "generic",
    summary: "",
    arguments: [{ name: "key", type: "key" }],
  },
  {
    name: "HSET",
    class: "write",
    allowed: true,
    group: "hash",
    summary: "",
    arguments: [
      { name: "key", type: "key" },
      {
        name: "data",
        type: "block",
        multiple: true,
        arguments: [
          { name: "field", type: "string" },
          { name: "value", type: "string" },
        ],
      },
    ],
  },
];
describe("COMMAND DOCS grammar cues", () => {
  it("distinguishes key, value, optional oneof token and numeric argument", () => {
    expect(
      analyzeCommand('SET "a b" NX NX EX 60', docs).tokens.map(
        (token) => token.role,
      ),
    ).toEqual(["command", "key", "value", "flag", "flag", "number"]);
  });
  it("recognises optional Redis tokens in a different legal order without colouring a positional token-like value", () => {
    expect(
      analyzeCommand("SET k NX EX 60 NX", docs).tokens.map(
        (token) => token.role,
      ),
    ).toEqual(["command", "key", "value", "flag", "number", "flag"]);
  });
  it("keeps quoted segments inside a Redis token together, including escaped quotes", () => {
    expect(lex('SET cache:"my key" value').map((token) => token.text)).toEqual([
      "SET",
      "cache:my key",
      "value",
    ]);
    expect(
      analyzeCommand('SET cache:"my key" value', docs).tokens.map(
        (token) => token.role,
      ),
    ).toEqual(["command", "key", "value"]);
  });
  it("supports subcommands and repeated tuple blocks", () => {
    expect(
      analyzeCommand("MEMORY USAGE k", docs).tokens.map((token) => token.role),
    ).toEqual(["command", "subcommand", "key"]);
    expect(
      analyzeCommand("HSET k one 1 two 2", docs).tokens.map(
        (token) => token.argument?.name,
      ),
    ).toEqual([undefined, "key", "field", "value", "field", "value"]);
  });
  it("keeps incomplete quoted input legible without changing bytes", () => {
    expect(lex('SET "hello world')).toMatchObject([
      { text: "SET", from: 0, to: 3 },
      { from: 4, to: 16 },
    ]);
    expect(analyzeCommand("SET k ", docs).active?.name).toBe("value");
    expect(analyzeCommand("MEMORY USAGE ", docs).active?.name).toBe("key");
  });
  it("suggests close command spellings without guessing permission", () => {
    expect(commandSuggestions("SEY k v", docs)).toContain("SET");
    expect(commandSuggestions("SET k v", docs)).toEqual([]);
    expect(commandSuggestions("UNRELATED", docs)).toEqual([]);
  });
  it("suggests newest matching history and never expands empty or multiline drafts", () => {
    expect(historySuggestion("GET ", ["GET a", "GET b"])).toBe("b");
    expect(historySuggestion("", ["GET a"])).toBe("");
    expect(historySuggestion("GET a", ["GET a"])).toBe("");
    expect(historySuggestion("PING\n", ["PING\nDBSIZE"])).toBe("");
  });
});

describe("parallel lists without complete key specs", () => {
  // Redis 8.10 flags XREAD's key spec incomplete, so the server omits it and the grammar decides.
  const xread: CommandDoc = {
    name: "XREAD",
    class: "read",
    allowed: true,
    group: "stream",
    summary: "",
    arguments: [
      { name: "count", type: "integer", token: "COUNT", optional: true },
      { name: "milliseconds", type: "integer", token: "BLOCK", optional: true },
      {
        name: "streams",
        type: "block",
        token: "STREAMS",
        arguments: [
          { name: "key", type: "key", multiple: true },
          { name: "id", type: "string", multiple: true },
        ],
      },
    ],
  };
  const roles = (line: string) =>
    analyzeCommand(line, [xread]).tokens.map((token) => token.role);
  it("splits keys and IDs evenly", () => {
    expect(roles("XREAD COUNT 5 STREAMS a b 0-0 1-0")).toEqual([
      "command",
      "flag",
      "number",
      "flag",
      "key",
      "key",
      "value",
      "value",
    ]);
  });
  it("keeps the words typed first as keys while the list is incomplete", () => {
    expect(roles("XREAD STREAMS a")).toEqual(["command", "flag", "key"]);
    expect(roles("XREAD STREAMS a b 0-0")).toEqual([
      "command",
      "flag",
      "key",
      "key",
      "value",
    ]);
  });
});

/** COMMAND DOCS and key specs exactly as GET /databases/:db/commands returns them from Redis 8. */
const real: CommandDoc[] = (
  [
    ["GET", "string", [{ name: "key", type: "key" }], [{ begin: { type: "index", index: 1 }, find: { type: "range", lastkey: 0, limit: 0, keystep: 1 } }]],
    ["TYPE", "generic", [{ name: "key", type: "key" }], [{ begin: { type: "index", index: 1 }, find: { type: "range", lastkey: 0, limit: 0, keystep: 1 } }]],
    [
      "MEMORY USAGE",
      "server",
      [{ name: "key", type: "key" }, { name: "count", type: "integer", token: "SAMPLES", optional: true }],
      [{ begin: { type: "index", index: 2 }, find: { type: "range", lastkey: 0, limit: 0, keystep: 1 } }],
    ],
    ["DEL", "generic", [{ name: "key", type: "key", multiple: true }], [{ begin: { type: "index", index: 1 }, find: { type: "range", lastkey: -1, limit: 0, keystep: 1 } }]],
    [
      "MSET",
      "string",
      [{ name: "data", type: "block", multiple: true, arguments: [{ name: "key", type: "key" }, { name: "value", type: "string" }] }],
      [{ begin: { type: "index", index: 1 }, find: { type: "range", lastkey: -1, limit: 0, keystep: 2 } }],
    ],
    [
      "EXPIRE",
      "generic",
      [
        { name: "key", type: "key" },
        { name: "seconds", type: "integer" },
        { name: "condition", type: "oneof", optional: true, arguments: [{ name: "nx", type: "pure-token", token: "NX" }, { name: "xx", type: "pure-token", token: "XX" }] },
      ],
      [{ begin: { type: "index", index: 1 }, find: { type: "range", lastkey: 0, limit: 0, keystep: 1 } }],
    ],
    [
      "ZADD",
      "sorted-set",
      [
        { name: "key", type: "key" },
        { name: "condition", type: "oneof", optional: true, arguments: [{ name: "nx", type: "pure-token", token: "NX" }, { name: "xx", type: "pure-token", token: "XX" }] },
        { name: "change", type: "pure-token", token: "CH", optional: true },
        { name: "data", type: "block", multiple: true, arguments: [{ name: "score", type: "double" }, { name: "member", type: "string" }] },
      ],
      [{ begin: { type: "index", index: 1 }, find: { type: "range", lastkey: 0, limit: 0, keystep: 1 } }],
    ],
    [
      "ZCOUNT",
      "sorted-set",
      [{ name: "key", type: "key" }, { name: "min", type: "double" }, { name: "max", type: "double" }],
      [{ begin: { type: "index", index: 1 }, find: { type: "range", lastkey: 0, limit: 0, keystep: 1 } }],
    ],
  ] as const
).map(([name, group, args, keySpecs]) => ({
  name,
  group,
  class: "read",
  allowed: true,
  summary: "",
  arguments: args as unknown as CommandDoc["arguments"],
  keySpecs: keySpecs as unknown as CommandDoc["keySpecs"],
}));
describe("an empty key argument with real key specs (console review round 1, M2)", () => {
  const active = (line: string) => analyzeCommand(line, real).active;
  it("marks the key as the argument to type next", () => {
    for (const line of ["GET ", "TYPE ", "MEMORY USAGE "])
      expect(active(line), line).toMatchObject({ name: "key", type: "key" });
  });
  it("keeps the key active at repeated key positions", () => {
    expect(active("DEL a ")).toMatchObject({ type: "key" });
    expect(active("MSET ")).toMatchObject({ type: "key" });
    expect(active("MSET a 1 ")).toMatchObject({ type: "key" });
    expect(active("MSET a ")).toMatchObject({ name: "value" });
  });
  it("still reads existing words by their key-spec role", () => {
    expect(analyzeCommand("GET a", real).tokens.map((token) => token.role)).toEqual(["command", "key"]);
    expect(analyzeCommand("MEMORY USAGE k SAMPLES 5", real).tokens.map((token) => token.role)).toEqual([
      "command",
      "subcommand",
      "key",
      "flag",
      "number",
    ]);
    expect(active("GET a ")).toBeUndefined();
  });
  it("lists the option tokens a command accepts", () => {
    expect(optionTokens(docs[0]!)).toEqual(["NX", "XX", "EX", "PX"]);
    expect(optionTokens(real.find((doc) => doc.name === "ZADD")!)).toEqual(["NX", "XX", "CH"]);
  });
});
describe("numeric cues follow the argument's Redis type (console review round 1, L1)", () => {
  const invalid = (line: string) =>
    analyzeCommand(line, real)
      .tokens.filter((token) => token.invalid)
      .map((token) => token.text);
  it("refuses fractions and exponents for integers, as string2ll does", () => {
    expect(invalid("EXPIRE k 1.5")).toEqual(["1.5"]);
    expect(invalid("EXPIRE k 1e3")).toEqual(["1e3"]);
    expect(invalid("EXPIRE k soon")).toEqual(["soon"]);
    expect(invalid("EXPIRE k 60")).toEqual([]);
    expect(invalid("EXPIRE k -1")).toEqual([]);
  });
  it("accepts infinities for doubles and exclusive score ranges", () => {
    expect(invalid("ZADD k +inf member")).toEqual([]);
    expect(invalid("ZADD k -inf a 1.5 b 2e3 c")).toEqual([]);
    expect(invalid("ZADD k nope member")).toEqual(["nope"]);
    expect(invalid("ZCOUNT k (1 +inf")).toEqual([]);
    expect(invalid("ZCOUNT k -inf (2.5")).toEqual([]);
    expect(invalid("ZADD k (1 member")).toEqual(["(1"]);
  });
  it("validNumber by type", () => {
    expect(validNumber("1.5", { name: "seconds", type: "integer" })).toBe(false);
    expect(validNumber("+inf", { name: "score", type: "double" })).toBe(true);
    expect(validNumber("Infinity", { name: "score", type: "double" })).toBe(true);
    expect(validNumber("nan", { name: "score", type: "double" })).toBe(false);
    expect(validNumber("1700000000", { name: "unix-time-seconds", type: "unix-time" })).toBe(true);
  });
});
