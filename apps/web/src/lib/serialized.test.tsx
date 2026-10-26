/**
 * Inert PHP / Java structure views and MessagePack extension display (review v0.2.1 web L3).
 *
 * The fixtures are real payloads, not hand-made bytes:
 * - PHP: `serialize()` of PHP 8.3 (php:8.3-cli-alpine) for scalars (null, bools, ints, 1.5, -0.0, INF, NAN, UTF-8 and
 *   quote/semicolon strings), an associative array with 9007199254740993, an `App\Models\User` object with public,
 *   protected and private properties, an array holding one stdClass twice (`r:2`), a backed enum, a legacy
 *   `Serializable` class (`C:`) and a binary string.
 * - Java: `ObjectOutputStream` of Temurin 21 for a `Gen$Person` (every primitive type, NaN, -0.0, a long beyond 2^53,
 *   an enum, a shared `Address` written once and referenced, an int[], an ArrayList and a self reference), a String
 *   with NUL (modified UTF-8), ArrayList, HashMap<String,Integer>, Long, Date and String[] {"p", null}.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { binFromBytes, binFromString } from "@rconsole/shared";
import { parsePhpSerialized, phpText, PhpError } from "./phpser.ts";
import { JavaSerError, javaText, jvmType, parseJavaSerialized } from "./javaser.ts";
import { decodeMsgpack, msgpackExtTypes, msgpackText } from "./msgpack.ts";
import { formatValue } from "./format.ts";
import { ValueViewer } from "../components/ValueViewer.tsx";

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const php: Record<string, string> = {
  scalars: "YToxMTp7aTowO047aToxO2I6MTtpOjI7YjowO2k6MztpOjQyO2k6NDtpOi03O2k6NTtkOjEuNTtpOjY7ZDotMDtpOjc7ZDpJTkY7aTo4O2Q6TkFOO2k6OTtzOjY6ImjDqWxsbyI7aToxMDtzOjU6ImEiYjtjIjt9",
  assoc: "YTo0OntzOjI6ImlkIjtpOjkwMDcxOTkyNTQ3NDA5OTM7czo0OiJuYW1lIjtzOjQ6Ilpvw6siO2k6NTtzOjQ6ImZpdmUiO3M6NjoibmVzdGVkIjthOjE6e3M6MToieCI7YToyOntpOjA7aToxO2k6MTtpOjI7fX19",
  object: "TzoxNToiQXBwXE1vZGVsc1xVc2VyIjo1OntzOjQ6Im5hbWUiO3M6MzoiQWRhIjtzOjg6IgAqAGVtYWlsIjtzOjE1OiJhZGFAZXhhbXBsZS5jb20iO3M6MjM6IgBBcHBcTW9kZWxzXFVzZXIAc2VjcmV0IjtzOjI6InMzIjtzOjQ6InRhZ3MiO2E6Mjp7aTowO3M6MToiYSI7aToxO3M6MToiYiI7fXM6NjoicGFyZW50IjtOO30=",
  refs: "YToyOntpOjA7Tzo4OiJzdGRDbGFzcyI6MTp7czoxOiJuIjtpOjE7fWk6MTtyOjI7fQ==",
  enum: "RToyMjoiQXBwXE1vZGVsc1xTdWl0OkhlYXJ0cyI7",
  custom: "QzoxNDoiQXBwXE1vZGVsc1xCb3giOjM6e3Jhd30=",
  binary: "czozOiIA/xAiOw==",
};
const java: Record<string, string> = {
  person: "rO0ABXNyAApHZW4kUGVyc29uAAAAAAAAACoCAA9aAAVhZG1pbkkAA2FnZUIAAWJKAAJpZEMAB2luaXRpYWxGAAVyYXRpb1MAAXNEAAVzY29yZUwABmZyaWVuZHQADExHZW4kUGVyc29uO0wABGhvbWV0AA1MR2VuJEFkZHJlc3M7WwAFbHVja3l0AAJbSUwABG5hbWV0ABJMamF2YS9sYW5nL1N0cmluZztMAAZzdGF0dXN0AAxMR2VuJFN0YXR1cztMAAR0YWdzdAAQTGphdmEvdXRpbC9MaXN0O0wABHdvcmtxAH4AAnhwAQAAACT/ACAAAAAAAAEAQX/AAAABLIAAAAAAAAAAcQB+AAdzcgALR2VuJEFkZHJlc3MAAAAAAAAABwIAAkkAA3ppcEwABGNpdHlxAH4ABHhwAAAfQXQAB1rDvHJpY2h1cgACW0lNumAmduqypQIAAHhwAAAAAgAAAAMAAAAHdAADQWRhfnIACkdlbiRTdGF0dXMAAAAAAAAAABIAAHhyAA5qYXZhLmxhbmcuRW51bQAAAAAAAAAAEgAAeHB0AAZBQ1RJVkVzcgATamF2YS51dGlsLkFycmF5TGlzdHiB0h2Zx2GdAwABSQAEc2l6ZXhwAAAAAncEAAAAAnQAAXh0AAF5eHEAfgAJ",
  string: "rO0ABXQACGjDqWxsb8CA",
  list: "rO0ABXNyABNqYXZhLnV0aWwuQXJyYXlMaXN0eIHSHZnHYZ0DAAFJAARzaXpleHAAAAACdwQAAAACdAABYXQAAWJ4",
  map: "rO0ABXNyABFqYXZhLnV0aWwuSGFzaE1hcAUH2sHDFmDRAwACRgAKbG9hZEZhY3RvckkACXRocmVzaG9sZHhwP0AAAAAAAAx3CAAAABAAAAABdAADb25lc3IAEWphdmEubGFuZy5JbnRlZ2VyEuKgpPeBhzgCAAFJAAV2YWx1ZXhyABBqYXZhLmxhbmcuTnVtYmVyhqyVHQuU4IsCAAB4cAAAAAF4",
  long: "rO0ABXNyAA5qYXZhLmxhbmcuTG9uZzuL5JDMjyPfAgABSgAFdmFsdWV4cgAQamF2YS5sYW5nLk51bWJlcoaslR0LlOCLAgAAeHAAAAAAAAAABQ==",
  date: "rO0ABXNyAA5qYXZhLnV0aWwuRGF0ZWhqgQFLWXQZAwAAeHB3CAAAAAAAAAAAeA==",
  array: "rO0ABXVyABNbTGphdmEubGFuZy5TdHJpbmc7rdJW5+kde0cCAAB4cAAAAAJ0AAFwcA==",
};
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe("PHP serialize() as an inert var_dump tree", () => {
  it("reads every scalar exactly, keeping the serialized float tokens", () => {
    expect(phpText(parsePhpSerialized(b64(php.scalars!)))).toBe([
      "array(11) {",
      "  [0] => NULL",
      "  [1] => bool(true)",
      "  [2] => bool(false)",
      "  [3] => int(42)",
      "  [4] => int(-7)",
      "  [5] => float(1.5)",
      "  [6] => float(-0)",
      "  [7] => float(INF)",
      "  [8] => float(NAN)",
      '  [9] => string(6) "héllo"',
      '  [10] => string(5) "a\\"b;c"',
      "}",
    ].join("\n"));
  });
  it("keeps integers beyond 2^53 exact and nests arrays", () => {
    const text = phpText(parsePhpSerialized(b64(php.assoc!)));
    expect(text).toContain('["id"] => int(9007199254740993)');
    expect(text).toContain('["name"] => string(4) "Zoë"');
    expect(text).toContain("[5] => string(4) \"five\"");
    expect(text).toContain('    ["x"] => array(2) {');
  });
  it("shows objects by class name and property visibility without creating them", () => {
    expect(phpText(parsePhpSerialized(b64(php.object!)))).toBe([
      "object(App\\Models\\User) (5) {",
      '  ["name"] => string(3) "Ada"',
      '  ["email":protected] => string(15) "ada@example.com"',
      '  ["secret":"App\\Models\\User":private] => string(2) "s3"',
      '  ["tags"] => array(2) {',
      '    [0] => string(1) "a"',
      '    [1] => string(1) "b"',
      "  }",
      '  ["parent"] => NULL',
      "}",
    ].join("\n"));
  });
  it("shows references, enums, custom payloads and binary strings as data", () => {
    expect(phpText(parsePhpSerialized(b64(php.refs!)))).toContain("[1] => copy of value #2");
    expect(phpText(parsePhpSerialized(ascii('a:1:{i:0;R:1;}')))).toContain("[0] => reference to value #1");
    expect(phpText(parsePhpSerialized(b64(php.enum!)))).toBe("enum(App\\Models\\Suit::Hearts)");
    expect(phpText(parsePhpSerialized(b64(php.custom!)))).toBe('object(App\\Models\\Box) custom serialized, 3 bytes, not read: "raw"');
    expect(phpText(parsePhpSerialized(b64(php.binary!)))).toBe('string(3) b"\\x00\\xff\\x10"');
  });
  it("is bounded: lying lengths, truncation, trailing bytes, depth and element counts fail cleanly", () => {
    const bad = (s: string | Uint8Array) => () => parsePhpSerialized(typeof s === "string" ? ascii(s) : s);
    expect(bad('s:99:"abc";')).toThrow(PhpError);
    expect(bad("a:99999999:{")).toThrow(/length beyond the end/);
    expect(bad("a:3:{i:0;N;}")).toThrow(/more entries/);
    expect(bad("a:1:{i:0;")).toThrow(PhpError);
    expect(bad("i:1;i:2;")).toThrow(/byte\(s\) follow/);
    expect(bad("x:1;")).toThrow(/unknown value type/);
    expect(bad("a:1:{d:1;N;}")).toThrow(/integer or a string/);
    expect(bad("b:2;")).toThrow(/boolean/);
    expect(bad("i:" + "9".repeat(100) + ";")).toThrow(/too long/);
    expect(bad("a:1:{i:0;".repeat(200) + "N;" + "}".repeat(200))).toThrow(/nesting exceeds 128/);
    const wide = "a:60000:{" + Array.from({ length: 60000 }, (_, i) => `i:${i};a:1:{i:0;N;}`).join("") + "}";
    expect(bad(wide)).toThrow(/more than 100,000 elements/);
  });
  it("never treats a PHP-looking value as code: class names and strings stay text", () => {
    const value = 'O:21:"<img src=x onerror=1>":1:{s:1:"a";s:8:"<script>";}';
    expect(phpText(parsePhpSerialized(ascii(value)))).toContain('object(<img src=x onerror=1>) (1)');
  });
});

describe("Java serialization as an inert structure", () => {
  it("reads class descriptors, every primitive, enums, shared and self references of a real object graph", () => {
    const text = javaText(parseJavaSerialized(b64(java.person!)));
    for (const line of [
      "Gen$Person (serialVersionUID 42) #7 {",
      "  admin: boolean = true",
      "  age: int = 36",
      "  b: byte = -1",
      "  id: long = 9007199254740993",
      '  initial: char = "A"',
      "  ratio: float = NaN",
      "  s: short = 300",
      "  score: double = -0.0",
      "  friend: Gen$Person = → #7 Gen$Person",
      "  home: Gen$Address = Gen$Address (serialVersionUID 7) #9 {",
      "    zip: int = 8001",
      '    city: java.lang.String = "Zürich"',
      "  lucky: int[] = int[2] #12 [3, 7]",
      '  name: java.lang.String = "Ada"',
      "  status: Gen$Status = Gen$Status.ACTIVE (enum, #16)",
      "  tags: java.util.List = java.util.ArrayList (serialVersionUID 8683452581122892189) #19 {",
      "    writeObject data of java.util.ArrayList:",
      "      block data, 4 bytes: 00 00 00 02",
      "  work: Gen$Address = → #9 Gen$Address",
    ]) expect(text.split("\n")).toContain(line);
  });
  it("reads collections, boxed numbers, dates, arrays and modified UTF-8 strings", () => {
    expect(javaText(parseJavaSerialized(b64(java.string!)))).toBe('"héllo\\u0000"');
    expect(javaText(parseJavaSerialized(b64(java.map!)))).toContain('    java.lang.Integer (serialVersionUID 1360826667806852920) #5 {\n      value: int = 1\n    }');
    expect(javaText(parseJavaSerialized(b64(java.long!)))).toBe("java.lang.Long (serialVersionUID 4290774380558885855) #2 {\n  value: long = 5\n}");
    expect(javaText(parseJavaSerialized(b64(java.date!)))).toContain("block data, 8 bytes: 00 00 00 00 00 00 00 00");
    expect(javaText(parseJavaSerialized(b64(java.array!)))).toBe('java.lang.String[2] #1 [\n  [0] "p"\n  [1] null\n]');
    expect(javaText(parseJavaSerialized(b64(java.list!)))).toContain('    "a"\n    "b"');
    expect(jvmType("[[Ljava/lang/String;")).toBe("java.lang.String[][]");
  });
  it("is bounded: truncation, unknown handles, huge lengths, exceptions and deep nesting fail cleanly", () => {
    const person = b64(java.person!);
    for (let cut = 5; cut < person.length; cut += 37) expect(() => parseJavaSerialized(person.subarray(0, cut))).toThrow(JavaSerError);
    const head = [0xac, 0xed, 0x00, 0x05];
    expect(() => parseJavaSerialized(Uint8Array.from([...head, 0x71, 0x00, 0x7e, 0x00, 0x09]))).toThrow(/unknown handle 9/);
    expect(() => parseJavaSerialized(Uint8Array.from([...head, 0x7c, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))).toThrow(/longer than the stream/);
    expect(() => parseJavaSerialized(Uint8Array.from([...head, 0x7b]))).toThrow(/exception/);
    expect(() => parseJavaSerialized(Uint8Array.from([0xac, 0xed, 0x00, 0x04]))).toThrow(/magic/);
    // An array of 2^31-1 ints in a few bytes is refused before any element is read.
    const arrayHead = [...head, 0x75, 0x72, 0x00, 0x02, 0x5b, 0x49, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x00, 0x00, 0x78, 0x70];
    expect(() => parseJavaSerialized(Uint8Array.from([...arrayHead, 0x7f, 0xff, 0xff, 0xff]))).toThrow(/longer than the stream/);
    // Nested Object[] arrays, each holding the next: the depth bound stops it.
    const nested: number[] = [...head];
    for (let i = 0; i < 100; i++) nested.push(...(i === 0 ? [0x75, 0x72, 0x00, 0x13, ...ascii("[Ljava.lang.Object;"), 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x00, 0x00, 0x78, 0x70] : [0x75, 0x71, 0x00, 0x7e, 0x00, 0x00]), 0, 0, 0, 1);
    expect(() => parseJavaSerialized(Uint8Array.from(nested))).toThrow(/Nesting exceeds 64/);
  });
});

describe("Java view resource bounds (v0.2.1 verify M3)", () => {
  // A serializable object whose class name is `n` bytes long, no fields, followed by `refs` TC_REFERENCE records to it.
  const amplifier = (n: number, refs: number) => {
    const head = [0xac, 0xed, 0, 5, 0x73, 0x72, (n >> 8) & 0xff, n & 0xff];
    const parts: number[] = [...head, ...new Array(n).fill(65), ...new Array(8).fill(0), 2, 0, 0, 0x78, 0x70];
    for (let i = 0; i < refs; i++) parts.push(0x71, 0, 0x7e, 0, 1);
    return Uint8Array.from(parts);
  };

  it("stops building text at the budget instead of expanding every reference", () => {
    const text = javaText(parseJavaSerialized(amplifier(10_000, 1_000)), 50_000);
    expect(text.length).toBeLessThan(50_000 + 200);
    expect(text).toContain("output stopped at 50,000 characters");
    // Reference lines carry a shortened class name, never the 10,000-character one.
    expect(text.split("\n").filter((l) => l.startsWith("→")).every((l) => l.length < 200)).toBe(true);
  });

  it("the formatter returns a capped view of a small amplifying value without building the whole tree", () => {
    const out = formatValue(binFromBytes(amplifier(60_000, 5_000)), "java");
    expect(out.length).toBeLessThan(100_000 + 300);
  });

  it("null and reference records count against the value budget", () => {
    const nulls = Uint8Array.from([0xac, 0xed, 0, 5, ...new Array(150_000).fill(0x70)]);
    expect(() => parseJavaSerialized(nulls)).toThrow(JavaSerError);
    expect(() => parseJavaSerialized(amplifier(1, 150_000))).toThrow(JavaSerError);
  });
});

describe("MessagePack extensions and the formatter tabs", () => {
  it("shows an application extension as its type and bytes, and lists the types", () => {
    const node = decodeMsgpack(Uint8Array.from([0x92, 0xd4, 0x05, 0x2a, 0xc7, 0x00, 0x07]));
    expect(msgpackText(node, 0)).toContain("Ext(5, 1 byte, 0x2a)");
    expect(msgpackText(node, 0)).toContain("Ext(7, 0 bytes)");
    expect(msgpackExtTypes(node)).toEqual([5, 7]);
    // The timestamp type is read, so it is not listed as uninterpreted.
    expect(msgpackExtTypes(decodeMsgpack(Uint8Array.from([0xd6, 0xff, 0, 0, 0, 1])))).toEqual([]);
  });
  it("offers the PHP and Java views only for detected values and keeps them inert", async () => {
    const { unmount } = render(<ValueViewer value={binFromString("plain")} />);
    expect(screen.queryByRole("tab", { name: "PHP" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Java" })).toBeNull();
    unmount();
    const { container, unmount: unmount2 } = render(<ValueViewer value={binFromBytes(b64(php.object!))} />);
    await userEvent.click(screen.getByRole("tab", { name: "PHP" }));
    expect(screen.getByTestId("key-value")).toHaveTextContent('["email":protected] => string(15) "ada@example.com"');
    expect(screen.getByTestId("value-serialized-note")).toHaveTextContent("Nothing is unserialized");
    expect(container.querySelector("img, script")).toBeNull();
    unmount2();
    render(<ValueViewer value={binFromBytes(b64(java.person!))} />);
    expect(screen.getByText(/Java class Gen\$Person/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Java" }));
    expect(screen.getByTestId("key-value")).toHaveTextContent("friend: Gen$Person = → #7 Gen$Person");
    expect(formatValue(binFromBytes(b64(java.person!)), "java")).toContain("Gen$Person (serialVersionUID 42) #7 {");
  });
  it("structured serialized views are off for a truncated preview", () => {
    render(<ValueViewer value={binFromBytes(b64(php.object!).subarray(0, 40))} truncated />);
    expect(screen.getByRole("tab", { name: "PHP" })).toBeDisabled();
  });
});
