import { describe, expect, it, vi } from "vitest";
import { encode } from "@msgpack/msgpack";
import {
  binFromBytes,
  binFromString,
  bytesFromBin,
  tokenizeCommandLine,
} from "@rconsole/shared";
import {
  cliBin,
  cliQuote,
  detection,
  displayBin,
  DISPLAY_LIMIT,
  formatValue,
  inflateValue,
  visibleText,
} from "./format.ts";
import { inputBin } from "../components/KeyOperations.tsx";
describe("hostile binary and value formatting", () => {
  it("preserves hostile HTML as plain text", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    expect(displayBin(binFromString(hostile))).toBe(hostile);
    expect(formatValue(binFromString(hostile), "text")).toBe(hostile);
  });
  it("exposes bidi, zero-width and terminal controls", () => {
    expect(visibleText("key\u202E\u200B\x1b")).toBe("key\\u202e\\u200b\\u001b");
  });
  it("bounds long previews", () => {
    const output = displayBin(binFromString("x".repeat(DISPLAY_LIMIT + 123)));
    expect(output.length).toBeLessThan(DISPLAY_LIMIT + 100);
    expect(output).toContain("123 more");
  });
  it("formats binary safely in hex/base64", () => {
    const value = binFromBytes(new Uint8Array([0xff, 0, 60, 62]));
    expect(formatValue(value, "hex")).toContain("ff 00 3c 3e");
    expect(formatValue(value, "base64")).toBe("/wA8Pg==");
    expect(displayBin(value)).toBe("\\xff\\x00<>");
  });
  it("pretty prints JSON and rejects malformed JSON", () => {
    expect(formatValue(binFromString('{"a":1}'), "json")).toBe(
      '{\n  "a": 1\n}',
    );
    expect(() => formatValue(binFromString("not json"), "json")).toThrow();
  });
  it("decodes MessagePack with limits", () => {
    expect(
      formatValue(
        binFromBytes(encode({ key: "<img>", value: [1, 2] })),
        "msgpack",
      ),
    ).toContain('"<img>"');
  });
  it("detects serialized formats without deserialization", () => {
    expect(
      detection(binFromBytes(new Uint8Array([0xac, 0xed, 0, 5]))),
    ).toContain("Java serialization");
    expect(detection(binFromString('O:4:"Test":0:{}'))).toContain(
      "PHP serialization",
    );
  });
  it("detects gzip and zlib headers", () => {
    expect(detection(binFromBytes(new Uint8Array([0x1f, 0x8b, 8])))).toBe(
      "gzip",
    );
    expect(detection(binFromBytes(new Uint8Array([0x78, 0x9c, 0])))).toBe(
      "Possible zlib compression",
    );
  });
  it("rejects invalid base64 entry and preserves valid bytes", () => {
    expect(() => inputBin("not valid 💣", "base64")).toThrow();
    expect(Array.from(bytesFromBin(inputBin("/wA=", "base64")))).toEqual([
      255, 0,
    ]);
  });
  it("refuses to inflate unrecognized data", async () => {
    await expect(inflateValue(binFromString("plain"))).rejects.toThrow(
      "No gzip",
    );
  });
  it("cancels decompression as soon as the output cap is exceeded", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(65) });
    class MockBlob {
      stream() {
        return { pipeThrough: () => ({ getReader: () => ({ read, cancel }) }) };
      }
    }
    vi.stubGlobal("Blob", MockBlob);
    vi.stubGlobal("DecompressionStream", class {});
    try {
      await expect(
        inflateValue(binFromBytes(new Uint8Array([0x1f, 0x8b])), 64),
      ).rejects.toThrow("safety limit");
      expect(read).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("caps structured decoding input size", () => {
    expect(() =>
      formatValue(binFromString("x".repeat(4 * 1024 * 1024 + 1)), "json"),
    ).toThrow("formatter limit");
  });
});
describe("redis-cli quoting", () => {
  it.each([
    'spaces and "quotes"',
    "line\nnew\t\r",
    "\\backslash",
    "\x00\x01\x1b",
    "<img src=x onerror=alert(1)>",
    "",
    "é💡",
  ])("round trips %j through the shared tokenizer", (value) => {
    expect(tokenizeCommandLine(`SET k ${cliQuote(value)}`)).toEqual([
      "SET",
      "k",
      value,
    ]);
  });
  it("quotes binary arguments byte for byte", () => {
    expect(cliBin(binFromBytes(new Uint8Array([0xff, 0x00])))).toBe(
      '"\\xff\\x00"',
    );
  });
});
describe("redis-cli arguments", () => {
  it("leaves plain arguments bare and quotes the rest so tokenizing gives the same argv", async () => {
    const { cliArg } = await import("./format.ts");
    const { tokenizeCommandLine } = await import("@rconsole/shared");
    const args = ["session:*", "0", "", "two words", 'quote"d', "back\\slash", "tab\there", "ünï", "*"];
    expect(args.map(cliArg).slice(0, 2)).toEqual(["session:*", "0"]);
    expect(tokenizeCommandLine(["SET", ...args.map(cliArg)].join(" "))).toEqual(["SET", ...args]);
  });
});
