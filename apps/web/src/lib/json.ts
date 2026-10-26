/** Redis JSON numbers are tokens, never JavaScript doubles. Bounded, data-only parsing. */
export class JsonNumber {
  readonly text: string;
  constructor(text: string) { this.text = text; }
  toString() { return this.text; }
}
export function parseJson(text: string): unknown {
  let pos = 0;
  const fail = (): never => { throw new SyntaxError(`Invalid JSON at character ${pos}.`); };
  const space = () => { while (/[\x20\t\r\n]/.test(text[pos] ?? "") && pos < text.length) pos++; };
  const string = () => {
    if (text[pos++] !== '"') fail();
    let result = "";
    while (pos < text.length) {
      const c = text[pos++]!;
      if (c === '"') return result;
      if (c.charCodeAt(0) < 32) fail();
      if (c !== "\\") { result += c; continue; }
      const escaped = text[pos++]!;
      if (escaped === "u") {
        const hex = text.slice(pos, pos + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
        result += String.fromCharCode(parseInt(hex, 16)); pos += 4;
      } else {
        const escapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (!Object.hasOwn(escapes, escaped)) fail();
        result += escapes[escaped];
      }
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 128) throw new Error("JSON nesting exceeds the 128-level formatter limit.");
    space();
    const c = text[pos];
    if (c === '"') return string();
    if (c === "{" || c === "[") {
      pos++; space();
      const array = c === "[";
      const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null) as Record<string, unknown>;
      const end = array ? "]" : "}";
      if (text[pos] === end) { pos++; return result; }
      while (pos < text.length) {
        if (array) (result as unknown[]).push(value(depth + 1));
        else {
          space(); const key = string(); space();
          if (text[pos++] !== ":") fail();
          (result as Record<string, unknown>)[key] = value(depth + 1);
        }
        space(); const separator = text[pos++];
        if (separator === end) return result;
        if (separator !== ",") fail();
      }
      return fail();
    }
    for (const [token, result] of [["true", true], ["false", false], ["null", null]] as const)
      if (text.startsWith(token, pos)) { pos += token.length; return result; }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(pos));
    if (!number) return fail();
    pos += number[0].length;
    return new JsonNumber(number[0]);
  };
  const result = value(0); space(); if (pos !== text.length) fail(); return result;
}
/** JSON.stringify is used only for strings, keys and non-JSON (MessagePack) scalars. */
export function stringifyJson(value: unknown, indent = 2, depth = 0): string {
  if (value instanceof JsonNumber) return value.text;
  if (value === null || typeof value !== "object")
    return JSON.stringify(typeof value === "bigint" ? value.toString() : value) ?? "null";
  const array = Array.isArray(value);
  const entries = Object.entries(value);
  const pad = " ".repeat(indent * (depth + 1));
  const separator = indent ? ",\n" : ",";
  const body = entries.map(([key, item]) => `${indent ? pad : ""}${array ? "" : `${JSON.stringify(key)}:${indent ? " " : ""}`}${stringifyJson(item, indent, depth + 1)}`).join(separator);
  return `${array ? "[" : "{"}${body && indent ? "\n" : ""}${body}${body && indent ? `\n${" ".repeat(indent * depth)}` : ""}${array ? "]" : "}"}`;
}
