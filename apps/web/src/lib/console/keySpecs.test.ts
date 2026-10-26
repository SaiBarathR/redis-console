import { expect, it } from "vitest";
import { commandKeyPositions } from "./keySpecs.ts";
import { analyzeCommand } from "./language.ts";
import type { CommandDoc, CommandKeySpec } from "@rconsole/shared";
const range = (
  index: number,
  lastkey = -1,
  keystep = 1,
  limit = 0,
): CommandKeySpec => ({
  begin: { type: "index", index },
  find: { type: "range", lastkey, keystep, limit },
});
it("extracts alternating MSET keys and counted ZUNION keys", () => {
  expect([
    ...commandKeyPositions(["MSET", "a", "1", "b", "2"], [range(1, -1, 2)])!,
  ]).toEqual([1, 3]);
  expect([
    ...commandKeyPositions(
      ["ZUNION", "2", "a", "b", "WEIGHTS", "1", "2"],
      [
        {
          begin: { type: "index", index: 1 },
          find: { type: "keynum", keynumidx: 0, firstkey: 1, keystep: 1 },
        },
      ],
    )!,
  ]).toEqual([2, 3]);
});
const streams: CommandKeySpec = {
  begin: { type: "keyword", keyword: "STREAMS", startfrom: 1 },
  find: { type: "range", lastkey: -1, keystep: 1, limit: 2 },
};
it("separates XREAD keys from IDs and preserves ID signature roles", () => {
  const doc: CommandDoc = {
    name: "XREAD",
    group: "stream",
    summary: "",
    class: "read",
    allowed: true,
    keySpecs: [streams],
    arguments: [
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
  const result = analyzeCommand("XREAD STREAMS a b 0-0 1-0", [doc]);
  expect(result.tokens.map((token) => token.role)).toEqual([
    "command",
    "flag",
    "key",
    "key",
    "value",
    "value",
  ]);
  expect(result.active?.name).toBe("id");
});
it("supports reverse keyword search and absent optional keywords", () => {
  const reverse: CommandKeySpec = {
    begin: { type: "keyword", keyword: "STORE", startfrom: -2 },
    find: { type: "range", lastkey: 0, limit: 0, keystep: 1 },
  };
  expect([
    ...commandKeyPositions(
      ["SORT", "a", "STORE", "b"],
      [range(1, 0), reverse],
    )!,
  ]).toEqual([1, 3]);
  expect([
    ...commandKeyPositions(["SORT", "a"], [range(1, 0), reverse])!,
  ]).toEqual([1]);
});
it("falls back for incomplete drafts or absent metadata without looping on malformed steps", () => {
  expect(
    commandKeyPositions(["XREAD", "STREAMS", "a", "b", "0-0"], [streams]),
  ).toBeUndefined();
  expect(commandKeyPositions(["GET", "a"], undefined)).toBeUndefined();
  expect(commandKeyPositions(["GET", "a"], [range(1, 0, 0)])).toBeUndefined();
});
