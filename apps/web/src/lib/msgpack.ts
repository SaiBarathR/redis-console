/**
 * Exact MessagePack display (web review v0.2 r3 H3). A small bounded decoder keeps every value as MessagePack
 * defines it, instead of converting to JavaScript values first: 64-bit integers stay exact decimal text, maps keep
 * their order, duplicate keys and key types, and floats keep -0, NaN and the infinities. The output is JSON wherever
 * JSON has the type; values JSON cannot express are written with explicit markers that can never be mistaken for
 * JSON: NaN, Infinity, -Infinity, Binary("<base64>"), Timestamp("<ISO 8601 UTC>"), Ext(<type>, <n> bytes, 0x<hex>), and
 * non-string map keys written as their own notation. Integral floats keep a ".0" so they read as floats.
 */
type Node =
  | { t: "nil" }
  | { t: "bool"; v: boolean }
  | { t: "int"; v: string }
  | { t: "float"; v: number }
  | { t: "str"; v: string }
  | { t: "badstr"; v: Uint8Array }
  | { t: "bin"; v: Uint8Array }
  | { t: "arr"; v: Node[] }
  | { t: "map"; v: [Node, Node][] }
  | { t: "ext"; type: number; v: Uint8Array };

const MAX_DEPTH = 128;
const MAX_ITEMS = 100_000;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export class MsgpackError extends Error {}

export function decodeMsgpack(bytes: Uint8Array): Node {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  let items = 0;
  const need = (n: number) => {
    if (pos + n > bytes.length) throw new MsgpackError("Not valid MessagePack (or truncated). Load the full value to decode.");
  };
  const take = (n: number) => {
    need(n);
    const out = bytes.subarray(pos, pos + n);
    pos += n;
    return out;
  };
  const u8 = () => { need(1); return bytes[pos++]!; };
  const u16 = () => { need(2); const v = view.getUint16(pos); pos += 2; return v; };
  const u32 = () => { need(4); const v = view.getUint32(pos); pos += 4; return v; };
  const str = (n: number): Node => {
    const raw = take(n);
    try {
      return { t: "str", v: utf8.decode(raw) };
    } catch {
      return { t: "badstr", v: raw };
    }
  };
  const count = (n: number) => {
    items += n;
    if (items > MAX_ITEMS) throw new MsgpackError(`MessagePack value has more than ${MAX_ITEMS.toLocaleString()} elements; use Hex or Base64.`);
  };
  const value = (depth: number): Node => {
    if (depth > MAX_DEPTH) throw new MsgpackError(`MessagePack nesting exceeds ${MAX_DEPTH} levels.`);
    const b = u8();
    if (b <= 0x7f) return { t: "int", v: String(b) };
    if (b >= 0xe0) return { t: "int", v: String(b - 0x100) };
    if (b >= 0xa0 && b <= 0xbf) return str(b & 0x1f);
    if (b >= 0x90 && b <= 0x9f) return arr(b & 0x0f, depth);
    if (b >= 0x80 && b <= 0x8f) return map(b & 0x0f, depth);
    switch (b) {
      case 0xc0: return { t: "nil" };
      case 0xc2: return { t: "bool", v: false };
      case 0xc3: return { t: "bool", v: true };
      case 0xc4: return { t: "bin", v: take(u8()) };
      case 0xc5: return { t: "bin", v: take(u16()) };
      case 0xc6: return { t: "bin", v: take(u32()) };
      case 0xc7: { const n = u8(); return ext(n); }
      case 0xc8: { const n = u16(); return ext(n); }
      case 0xc9: { const n = u32(); return ext(n); }
      case 0xca: { need(4); const v = view.getFloat32(pos); pos += 4; return { t: "float", v }; }
      case 0xcb: { need(8); const v = view.getFloat64(pos); pos += 8; return { t: "float", v }; }
      case 0xcc: return { t: "int", v: String(u8()) };
      case 0xcd: return { t: "int", v: String(u16()) };
      case 0xce: return { t: "int", v: String(u32()) };
      case 0xcf: { need(8); const v = view.getBigUint64(pos); pos += 8; return { t: "int", v: v.toString() }; }
      case 0xd0: { need(1); const v = view.getInt8(pos); pos += 1; return { t: "int", v: String(v) }; }
      case 0xd1: { need(2); const v = view.getInt16(pos); pos += 2; return { t: "int", v: String(v) }; }
      case 0xd2: { need(4); const v = view.getInt32(pos); pos += 4; return { t: "int", v: String(v) }; }
      case 0xd3: { need(8); const v = view.getBigInt64(pos); pos += 8; return { t: "int", v: v.toString() }; }
      case 0xd4: return ext(1);
      case 0xd5: return ext(2);
      case 0xd6: return ext(4);
      case 0xd7: return ext(8);
      case 0xd8: return ext(16);
      case 0xd9: return str(u8());
      case 0xda: return str(u16());
      case 0xdb: return str(u32());
      case 0xdc: return arr(u16(), depth);
      case 0xdd: return arr(u32(), depth);
      case 0xde: return map(u16(), depth);
      case 0xdf: return map(u32(), depth);
      default: throw new MsgpackError(`Not valid MessagePack: byte 0x${b.toString(16)} at offset ${pos - 1}.`);
    }
  };
  const ext = (n: number): Node => {
    need(1);
    const type = view.getInt8(pos);
    pos += 1;
    return { t: "ext", type, v: take(n) };
  };
  const arr = (n: number, depth: number): Node => {
    count(n);
    const v: Node[] = [];
    for (let i = 0; i < n; i++) v.push(value(depth + 1));
    return { t: "arr", v };
  };
  const map = (n: number, depth: number): Node => {
    count(n);
    const v: [Node, Node][] = [];
    for (let i = 0; i < n; i++) v.push([value(depth + 1), value(depth + 1)]);
    return { t: "map", v };
  };
  const root = value(0);
  if (pos !== bytes.length) throw new MsgpackError(`Not one MessagePack value: ${bytes.length - pos} byte(s) follow it. Use Hex to inspect.`);
  return root;
}

function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function float(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  if (Object.is(v, -0)) return "-0.0";
  const s = String(v);
  return /^-?\d+$/.test(s) ? `${s}.0` : s;
}

/** The timestamp extension (type -1): 32-, 64- and 96-bit forms, exact to the nanosecond. */
function timestamp(data: Uint8Array): string | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let sec: bigint, nsec: number;
  if (data.length === 4) { sec = BigInt(view.getUint32(0)); nsec = 0; }
  else if (data.length === 8) {
    const hi = view.getUint32(0), lo = view.getUint32(4);
    nsec = hi >>> 2;
    sec = (BigInt(hi & 0x3) << 32n) | BigInt(lo);
  } else if (data.length === 12) { nsec = view.getUint32(0); sec = view.getBigInt64(4); }
  else return undefined;
  if (nsec > 999_999_999) return undefined;
  const ms = Number(sec) * 1000;
  if (!Number.isSafeInteger(Number(sec)) || Math.abs(ms) > 8.64e15) return `Timestamp(seconds=${sec}, nanoseconds=${nsec})`;
  const iso = new Date(ms).toISOString().replace(".000Z", "");
  return `Timestamp("${iso}${nsec ? `.${String(nsec).padStart(9, "0")}` : ""}Z")`;
}

/**
 * An application extension (review v0.2.1 web L3): its type and its bytes in hex, never interpreted. Only the
 * standard timestamp (type -1) is read.
 */
function extText(type: number, v: Uint8Array) {
  return `Ext(${type}, ${v.length} ${v.length === 1 ? "byte" : "bytes"}${v.length ? `, 0x${Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("")}` : ""})`;
}

/** Extension types in a decoded value (bounded by the decoder's limits), for the formatter's note. */
export function msgpackExtTypes(node: Node, out = new Set<number>()): number[] {
  if (node.t === "ext" && !(node.type === -1 && timestamp(node.v))) out.add(node.type);
  else if (node.t === "arr") for (const item of node.v) msgpackExtTypes(item, out);
  else if (node.t === "map") for (const [k, v] of node.v) (msgpackExtTypes(k, out), msgpackExtTypes(v, out));
  return [...out].sort((a, b) => a - b);
}

/** MessagePack as JSON text with explicit markers (see the module comment). Bounded by the decoder's limits. */
export function msgpackText(node: Node, indent = 2, depth = 0): string {
  switch (node.t) {
    case "nil": return "null";
    case "bool": return String(node.v);
    case "int": return node.v;
    case "float": return float(node.v);
    case "str": return JSON.stringify(node.v);
    case "badstr": return `InvalidUTF8("${base64(node.v)}")`;
    case "bin": return `Binary("${base64(node.v)}")`;
    case "ext": return (node.type === -1 && timestamp(node.v)) || extText(node.type, node.v);
    case "arr":
    case "map": {
      const pad = " ".repeat(indent * (depth + 1));
      const parts = node.t === "arr"
        ? node.v.map((item) => `${pad}${msgpackText(item, indent, depth + 1)}`)
        : node.v.map(([k, v]) => `${pad}${msgpackText(k, indent, depth + 1)}: ${msgpackText(v, indent, depth + 1)}`);
      const [open, close] = node.t === "arr" ? ["[", "]"] : ["{", "}"];
      return parts.length ? `${open}\n${parts.join(",\n")}\n${" ".repeat(indent * depth)}${close}` : `${open}${close}`;
    }
  }
}
