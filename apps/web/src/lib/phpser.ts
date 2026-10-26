/**
 * Inert reading of PHP `serialize()` output (review v0.2.1 web L3). A small bounded parser turns the bytes into a
 * tree of plain records and prints it the way `var_dump` does. Nothing is unserialized: no class is looked up or
 * instantiated, no magic method runs, references are shown as pointers and never resolved, and a custom
 * (`C:`) payload is shown as its bytes. Integers keep their exact decimal text and floats their serialized token.
 * Depth, element count and every length are checked against the remaining input before anything is read.
 */
const MAX_DEPTH = 128;
const MAX_ITEMS = 100_000;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class PhpError extends Error {}

type Key = { t: "int"; v: string } | { t: "str"; v: Uint8Array };
export type PhpNode =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "int"; v: string }
  | { t: "float"; v: string }
  | { t: "str"; v: Uint8Array }
  | { t: "array"; entries: [Key, PhpNode][] }
  | { t: "object"; className: Uint8Array; entries: [Key, PhpNode][] }
  | { t: "custom"; className: Uint8Array; payload: Uint8Array }
  | { t: "enum"; name: Uint8Array }
  /** `r:` (a copy of value n) or `R:` (a PHP reference to value n); n counts values in serialization order from 1. */
  | { t: "ref"; kind: "r" | "R"; n: number };

export function parsePhpSerialized(bytes: Uint8Array): PhpNode {
  let pos = 0;
  let items = 0;
  const fail = (what: string): never => {
    throw new PhpError(`Not valid PHP serialization at byte ${pos}: ${what}.`);
  };
  const expect = (s: string) => {
    for (let i = 0; i < s.length; i++) if (bytes[pos + i] !== s.charCodeAt(i)) fail(`expected "${s}"`);
    pos += s.length;
  };
  /** Bytes up to (not including) `stop`, at most `max` of them. */
  const token = (stop: number, max = 64) => {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== stop) if (++pos - start > max) fail("number too long");
    if (pos >= bytes.length) fail("unexpected end");
    const out = String.fromCharCode(...bytes.subarray(start, pos));
    pos++;
    return out;
  };
  const integer = (stop: number) => {
    const text = token(stop);
    if (!/^[+-]?\d+$/.test(text)) fail("expected an integer");
    return text.replace(/^\+/, "");
  };
  const length = (stop: number) => {
    const n = Number(integer(stop));
    if (!Number.isSafeInteger(n) || n < 0 || n > bytes.length - pos) fail("length beyond the end of the value");
    return n;
  };
  const count = (n: number) => {
    items += n;
    if (items > MAX_ITEMS) throw new PhpError(`PHP value has more than ${MAX_ITEMS.toLocaleString()} elements; use Hex or Base64.`);
  };
  const quoted = (n: number) => {
    expect('"');
    const out = bytes.subarray(pos, pos + n);
    pos += n;
    expect('"');
    return out;
  };
  const key = (): Key => {
    const tag = bytes[pos];
    pos += 2;
    if (tag === 0x69 && bytes[pos - 1] === 0x3a) return { t: "int", v: integer(0x3b) };
    if (tag === 0x73 && bytes[pos - 1] === 0x3a) {
      const s = quoted(length(0x3a));
      expect(";");
      return { t: "str", v: s };
    }
    pos -= 2;
    return fail("an array key must be an integer or a string");
  };
  const entries = (depth: number) => {
    const n = length(0x3a);
    // Each entry takes at least six bytes ("i:0;N;").
    if (n * 6 > bytes.length - pos) fail("more entries than the value can hold");
    count(n);
    expect("{");
    const out: [Key, PhpNode][] = [];
    for (let i = 0; i < n; i++) out.push([key(), value(depth + 1)]);
    expect("}");
    return out;
  };
  const value = (depth: number): PhpNode => {
    if (depth > MAX_DEPTH) throw new PhpError(`PHP nesting exceeds ${MAX_DEPTH} levels.`);
    const tag = bytes[pos];
    if (tag === 0x4e) {
      expect("N;");
      return { t: "null" };
    }
    if (tag === undefined || bytes[pos + 1] !== 0x3a) return fail("unknown value type");
    pos += 2;
    switch (String.fromCharCode(tag)) {
      case "b": {
        const v = integer(0x3b);
        if (v !== "0" && v !== "1") fail("a boolean is 0 or 1");
        return { t: "bool", v: v === "1" };
      }
      case "i":
        return { t: "int", v: integer(0x3b) };
      case "d": {
        const v = token(0x3b);
        if (!/^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?|-?INF|NAN)$/.test(v)) fail("expected a float");
        return { t: "float", v };
      }
      case "s": {
        const v = quoted(length(0x3a));
        expect(";");
        return { t: "str", v };
      }
      case "a":
        return { t: "array", entries: entries(depth) };
      case "O": {
        const className = quoted(length(0x3a));
        expect(":");
        return { t: "object", className, entries: entries(depth) };
      }
      case "C": {
        const className = quoted(length(0x3a));
        expect(":");
        const n = length(0x3a);
        expect("{");
        const payload = bytes.subarray(pos, pos + n);
        pos += n;
        expect("}");
        return { t: "custom", className, payload };
      }
      case "E": {
        const name = quoted(length(0x3a));
        expect(";");
        return { t: "enum", name };
      }
      case "r":
      case "R": {
        const n = Number(integer(0x3b));
        if (!Number.isSafeInteger(n) || n < 1) fail("a reference points to a value number from 1");
        return { t: "ref", kind: String.fromCharCode(tag) as "r" | "R", n };
      }
      default:
        return fail(`unknown value type "${String.fromCharCode(tag)}"`);
    }
  };
  const root = value(0);
  if (pos !== bytes.length) throw new PhpError(`Not one PHP value: ${bytes.length - pos} byte(s) follow it. Use Hex to inspect.`);
  return root;
}

/** A PHP string: quoted text when it is UTF-8, otherwise b"…" with \xNN escapes. */
function phpString(v: Uint8Array) {
  try {
    return JSON.stringify(utf8.decode(v));
  } catch {
    return `b"${Array.from(v, (b) => (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`)).join("")}"`;
  }
}

const text = (v: Uint8Array) => {
  try {
    return utf8.decode(v);
  } catch {
    return phpString(v);
  }
};

/** `var_dump` style property name: protected "\0*\0name", private "\0Class\0name". */
function propertyName(k: Key) {
  if (k.t === "int") return `[${k.v}]`;
  if (k.v[0] === 0) {
    const second = k.v.indexOf(0, 1);
    if (second > 0) {
      const owner = k.v.subarray(1, second);
      const name = phpString(k.v.subarray(second + 1));
      return owner.length === 1 && owner[0] === 0x2a ? `[${name}:protected]` : `[${name}:"${text(owner)}":private]`;
    }
  }
  return `[${phpString(k.v)}]`;
}

/** The tree as `var_dump` prints it, indented by two spaces per level. Bounded by the parser's limits. */
export function phpText(node: PhpNode, depth = 0): string {
  const pad = "  ".repeat(depth + 1);
  const close = "  ".repeat(depth);
  const block = (head: string, list: [Key, PhpNode][], object: boolean) =>
    list.length
      ? `${head} {\n${list.map(([k, v]) => `${pad}${object ? propertyName(k) : k.t === "int" ? `[${k.v}]` : `[${phpString(k.v)}]`} => ${phpText(v, depth + 1)}`).join("\n")}\n${close}}`
      : `${head} {}`;
  switch (node.t) {
    case "null":
      return "NULL";
    case "bool":
      return `bool(${node.v})`;
    case "int":
      return `int(${node.v})`;
    case "float":
      return `float(${node.v})`;
    case "str":
      return `string(${node.v.length}) ${phpString(node.v)}`;
    case "array":
      return block(`array(${node.entries.length})`, node.entries, false);
    case "object":
      return block(`object(${text(node.className)}) (${node.entries.length})`, node.entries, true);
    case "custom":
      return `object(${text(node.className)}) custom serialized, ${node.payload.length} bytes, not read: ${phpString(node.payload)}`;
    case "enum":
      return `enum(${text(node.name).replace(":", "::")})`;
    case "ref":
      return node.kind === "R" ? `reference to value #${node.n}` : `copy of value #${node.n}`;
  }
}
