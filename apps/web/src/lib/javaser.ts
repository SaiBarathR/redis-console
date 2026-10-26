/**
 * Inert structural view of a Java serialization stream (review v0.2.1 web L3). It reads the grammar of the Java
 * Object Serialization Specification (§6.4) into plain records: class descriptors (name, serialVersionUID, field
 * names and types), primitive field values, strings, arrays, enum constants and back references. It never creates
 * a Java object, looks up a class or runs code: `writeObject` / `Externalizable` data is shown as the block bytes and
 * nested values it contains, and references are shown as pointers to the handle they name. Depth, element count and
 * every length are checked against the remaining input before anything is read.
 */
const MAX_DEPTH = 64;
const MAX_ITEMS = 100_000;
const BASE_HANDLE = 0x7e0000;
const BLOCK_SHOWN = 64;

export class JavaSerError extends Error {}

export interface JavaField {
  code: string;
  name: string;
  /** Declared type of an object or array field (JVM signature, e.g. `Ljava/lang/String;`). */
  signature?: string;
}
export interface JavaClassDesc {
  kind: "class";
  handle: number;
  name: string;
  uid: string;
  flags: number;
  fields: JavaField[];
  annotation: JavaNode[];
  superDesc?: JavaClassDesc;
  /** Proxy classes: the interfaces instead of a name and fields. */
  interfaces?: string[];
}
export type JavaNode =
  | { t: "null" }
  | { t: "prim"; type: string; v: string }
  | { t: "string"; handle: number; v: string }
  | { t: "ref"; handle: number; target: string }
  | { t: "object"; handle: number; desc: JavaClassDesc; data: { desc: JavaClassDesc; values: [JavaField, JavaNode][]; annotation?: JavaNode[] }[] }
  | { t: "array"; handle: number; desc: JavaClassDesc; items: JavaNode[] }
  | { t: "enum"; handle: number; desc: JavaClassDesc; constant: string }
  | { t: "class"; handle: number; desc?: JavaClassDesc }
  | { t: "classdesc"; desc?: JavaClassDesc }
  | { t: "block"; bytes: Uint8Array }
  | { t: "reset" };

const PRIM: Record<string, string> = { B: "byte", C: "char", D: "double", F: "float", I: "int", J: "long", S: "short", Z: "boolean" };
const SC_WRITE_METHOD = 0x01, SC_EXTERNALIZABLE = 0x04, SC_BLOCK_DATA = 0x08;

function float(v: number) {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  if (Object.is(v, -0)) return "-0.0";
  const s = String(v);
  return /^-?\d+$/.test(s) ? `${s}.0` : s;
}

/** Java's "modified UTF-8" (NUL as C0 80, supplementary characters as two 3-byte surrogates). */
function modifiedUtf8(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; ) {
    const x = b[i]!;
    let code: number;
    if (x < 0x80) {
      code = x;
      i += 1;
    } else if ((x & 0xe0) === 0xc0 && i + 1 < b.length && (b[i + 1]! & 0xc0) === 0x80) {
      code = ((x & 0x1f) << 6) | (b[i + 1]! & 0x3f);
      i += 2;
    } else if ((x & 0xf0) === 0xe0 && i + 2 < b.length && (b[i + 1]! & 0xc0) === 0x80 && (b[i + 2]! & 0xc0) === 0x80) {
      code = ((x & 0x0f) << 12) | ((b[i + 1]! & 0x3f) << 6) | (b[i + 2]! & 0x3f);
      i += 3;
    } else throw new JavaSerError("Not valid Java modified UTF-8 text.");
    out += String.fromCharCode(code);
  }
  return out;
}

/** The whole stream after the magic and version: usually one object. */
export function parseJavaSerialized(bytes: Uint8Array): JavaNode[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  let items = 0;
  let handles: (JavaNode | JavaClassDesc)[] = [];
  const fail = (what: string): never => {
    throw new JavaSerError(`Not a Java serialization stream this view can read (byte ${pos}): ${what}.`);
  };
  const need = (n: number) => {
    if (n < 0 || pos + n > bytes.length) fail("unexpected end (load the full value)");
  };
  const u8 = () => (need(1), bytes[pos++]!);
  const u16 = () => (need(2), (pos += 2), view.getUint16(pos - 2));
  const i32 = () => (need(4), (pos += 4), view.getInt32(pos - 4));
  const take = (n: number) => (need(n), (pos += n), bytes.subarray(pos - n, pos));
  const utf = () => modifiedUtf8(take(u16()));
  const count = (n: number) => {
    items += n;
    if (items > MAX_ITEMS) throw new JavaSerError(`The stream has more than ${MAX_ITEMS.toLocaleString()} values; use Hex or Base64.`);
  };
  const assign = <T extends JavaNode | JavaClassDesc>(node: T) => {
    count(1);
    handles.push(node);
    return node;
  };
  const short = (name: string) => (name.length > 120 ? `${name.slice(0, 120)}…` : name);
  const describe = (h: JavaNode | JavaClassDesc): string => {
    if ("kind" in h) return `class ${short(h.name)}`;
    if (h.t === "string") return JSON.stringify(h.v.length > 80 ? `${h.v.slice(0, 80)}…` : h.v);
    if (h.t === "object" || h.t === "array" || h.t === "enum") return short(h.desc.name);
    return h.t;
  };
  const prim = (code: string): JavaNode => {
    const type = PRIM[code]!;
    count(1);
    switch (code) {
      case "B": need(1); pos += 1; return { t: "prim", type, v: String(view.getInt8(pos - 1)) };
      case "C": { const c = u16(); return { t: "prim", type, v: JSON.stringify(String.fromCharCode(c)) }; }
      case "D": need(8); pos += 8; return { t: "prim", type, v: float(view.getFloat64(pos - 8)) };
      case "F": need(4); pos += 4; return { t: "prim", type, v: float(view.getFloat32(pos - 4)) };
      case "I": return { t: "prim", type, v: String(i32()) };
      case "J": need(8); pos += 8; return { t: "prim", type, v: view.getBigInt64(pos - 8).toString() };
      case "S": need(2); pos += 2; return { t: "prim", type, v: String(view.getInt16(pos - 2)) };
      case "Z": return { t: "prim", type, v: String(u8() !== 0) };
    }
    return fail(`unknown field type ${code}`);
  };
  const reference = () => {
    const h = i32() - BASE_HANDLE;
    const target = handles[h];
    if (!target) fail(`a reference to unknown handle ${h}`);
    return { h, target: target! };
  };
  /** A string, new or referenced (field types, enum constants). */
  const text = (depth: number, what: string): string => {
    if (bytes[pos] === 0x71) {
      pos++;
      const { target } = reference();
      if ("kind" in target || target.t !== "string") return fail(`${what} must be a string`);
      return target.v;
    }
    const node = content(depth);
    return node.t === "string" ? node.v : fail(`${what} must be a string`);
  };
  /** Contents up to TC_ENDBLOCKDATA: block data and nested values (classAnnotation / objectAnnotation). */
  const annotation = (depth: number): JavaNode[] => {
    const out: JavaNode[] = [];
    for (;;) {
      need(1);
      if (bytes[pos] === 0x78) {
        pos++;
        return out;
      }
      out.push(content(depth + 1));
    }
  };
  const classDesc = (depth: number): JavaClassDesc | undefined => {
    if (depth > MAX_DEPTH) throw new JavaSerError(`Nesting exceeds ${MAX_DEPTH} levels.`);
    const tc = u8();
    if (tc === 0x70) return undefined;
    if (tc === 0x71) {
      const { h, target } = reference();
      if (!("kind" in target)) fail(`handle ${h} is not a class descriptor`);
      return target as JavaClassDesc;
    }
    if (tc === 0x72) {
      const name = utf();
      need(8);
      pos += 8;
      const desc = assign<JavaClassDesc>({ kind: "class", handle: handles.length, name, uid: view.getBigInt64(pos - 8).toString(), flags: 0, fields: [], annotation: [] });
      desc.flags = u8();
      const n = u16();
      if (n * 3 > bytes.length - pos) fail("more fields than the stream can hold");
      count(n);
      for (let i = 0; i < n; i++) {
        const code = String.fromCharCode(u8());
        const fieldName = utf();
        if (code === "L" || code === "[") {
          desc.fields.push({ code, name: fieldName, signature: text(depth + 1, "a field type") });
        } else if (PRIM[code]) desc.fields.push({ code, name: fieldName });
        else fail(`unknown field type ${code}`);
      }
      desc.annotation = annotation(depth);
      const superDesc = classDesc(depth + 1);
      if (superDesc) desc.superDesc = superDesc;
      return desc;
    }
    if (tc === 0x7d) {
      const desc = assign<JavaClassDesc>({ kind: "class", handle: handles.length, name: "proxy", uid: "0", flags: 0, fields: [], annotation: [], interfaces: [] });
      const n = i32();
      if (n < 0 || n * 2 > bytes.length - pos) fail("more interfaces than the stream can hold");
      count(n);
      for (let i = 0; i < n; i++) desc.interfaces!.push(utf());
      desc.name = `proxy(${desc.interfaces!.join(", ")})`;
      desc.annotation = annotation(depth);
      const superDesc = classDesc(depth + 1);
      if (superDesc) desc.superDesc = superDesc;
      return desc;
    }
    return fail(`expected a class descriptor, found 0x${tc.toString(16)}`);
  };
  const object = (depth: number): JavaNode => {
    const desc = classDesc(depth + 1);
    if (!desc) return fail("an object without a class");
    const node = assign<Extract<JavaNode, { t: "object" }>>({ t: "object", handle: handles.length, desc: desc!, data: [] });
    const chain: JavaClassDesc[] = [];
    for (let d: JavaClassDesc | undefined = desc; d; d = d.superDesc) {
      chain.unshift(d);
      if (chain.length > MAX_DEPTH) fail("class hierarchy too deep");
    }
    for (const d of chain) {
      if (d.flags & SC_EXTERNALIZABLE) {
        if (!(d.flags & SC_BLOCK_DATA)) fail(`${d.name} is Externalizable in protocol 1, which needs the class to read`);
        node.data.push({ desc: d, values: [], annotation: annotation(depth) });
        continue;
      }
      const values: [JavaField, JavaNode][] = d.fields.map((f) => [f, f.code === "L" || f.code === "[" ? content(depth + 1) : prim(f.code)]);
      node.data.push({ desc: d, values, ...(d.flags & SC_WRITE_METHOD ? { annotation: annotation(depth) } : {}) });
    }
    return node;
  };
  const array = (depth: number): JavaNode => {
    const desc = classDesc(depth + 1);
    if (!desc) return fail("an array without a class");
    const node = assign<Extract<JavaNode, { t: "array" }>>({ t: "array", handle: handles.length, desc: desc!, items: [] });
    const size = i32();
    const code = desc!.name[1] ?? "";
    const width = { B: 1, C: 2, D: 8, F: 4, I: 4, J: 8, S: 2, Z: 1 }[code] ?? 1;
    if (size < 0 || size * width > bytes.length - pos) fail("an array longer than the stream");
    for (let i = 0; i < size; i++) node.items.push(PRIM[code] ? prim(code) : content(depth + 1));
    return node;
  };
  const content = (depth: number): JavaNode => {
    if (depth > MAX_DEPTH) throw new JavaSerError(`Nesting exceeds ${MAX_DEPTH} levels.`);
    const tc = u8();
    switch (tc) {
      case 0x70:
        count(1);
        return { t: "null" };
      case 0x71: {
        count(1);
        const { h, target } = reference();
        return { t: "ref", handle: h, target: describe(target) };
      }
      case 0x72:
      case 0x7d:
        pos--;
        return { t: "classdesc", desc: classDesc(depth + 1) };
      case 0x73:
        return object(depth);
      case 0x74:
        return assign<JavaNode>({ t: "string", handle: handles.length, v: utf() });
      case 0x7c: {
        need(8);
        const n = view.getBigInt64(pos);
        pos += 8;
        if (n < 0n || n > BigInt(bytes.length - pos)) fail("a string longer than the stream");
        return assign<JavaNode>({ t: "string", handle: handles.length, v: modifiedUtf8(take(Number(n))) });
      }
      case 0x75:
        return array(depth);
      case 0x76: {
        const desc = classDesc(depth + 1);
        return assign<JavaNode>({ t: "class", handle: handles.length, ...(desc ? { desc } : {}) });
      }
      case 0x7e: {
        const desc = classDesc(depth + 1);
        if (!desc) return fail("an enum without a class");
        const node = assign<Extract<JavaNode, { t: "enum" }>>({ t: "enum", handle: handles.length, desc: desc!, constant: "" });
        node.constant = text(depth + 1, "an enum constant");
        return node;
      }
      case 0x77:
        count(1);
        return { t: "block", bytes: take(u8()) };
      case 0x7a: {
        count(1);
        const n = i32();
        return { t: "block", bytes: take(n) };
      }
      case 0x79:
        handles = [];
        return { t: "reset" };
      case 0x7b:
        return fail("the stream holds a serialized exception, which this view does not read");
      default:
        return fail(`unknown type code 0x${tc.toString(16)}`);
    }
  };
  if (bytes[0] !== 0xac || bytes[1] !== 0xed || bytes[2] !== 0 || bytes[3] !== 5) throw new JavaSerError("Not a Java serialization stream (magic AC ED 00 05).");
  pos = 4;
  const out: JavaNode[] = [];
  while (pos < bytes.length) out.push(content(0));
  return out;
}

const hex = (b: Uint8Array) => Array.from(b.subarray(0, BLOCK_SHOWN), (x) => x.toString(16).padStart(2, "0")).join(" ");
/** A JVM type descriptor as Java source writes it: `[I` → `int[]`, `Ljava/lang/String;` → `java.lang.String`. */
export function jvmType(sig: string): string {
  if (sig.startsWith("[")) return `${jvmType(sig.slice(1))}[]`;
  if (PRIM[sig]) return PRIM[sig]!;
  return sig.replace(/^L(.*);$/, "$1").replace(/\//g, ".");
}
const typeName = (f: JavaField) => PRIM[f.code] ?? jvmType(f.signature ?? "");
const classLine = (d: JavaClassDesc) => `${d.name} (serialVersionUID ${d.uid})`;

/** The stream as an indented text tree. Handles are numbered from 0 (`#n`); a reference names its handle. */
export function javaText(nodes: JavaNode[], maxChars = 200_000): string {
  const out: string[] = [];
  let used = 0;
  const FULL = Symbol("full");
  // Repeated references or long class names can make the text far larger than the stream; stop at the budget
  // instead of building the whole tree and truncating afterwards (v0.2.1 verify M3).
  const lines = {
    push(line: string) {
      if (used + line.length + 1 > maxChars) {
        out.push(line.slice(0, Math.max(0, maxChars - used)));
        throw FULL;
      }
      out.push(line);
      used += line.length + 1;
    },
  };
  const write = (node: JavaNode, depth: number, prefix: string) => {
    const pad = "  ".repeat(depth);
    switch (node.t) {
      case "null":
        lines.push(`${pad}${prefix}null`);
        return;
      case "prim":
        lines.push(`${pad}${prefix}${node.v}`);
        return;
      case "string":
        lines.push(`${pad}${prefix}${JSON.stringify(node.v)}`);
        return;
      case "ref":
        lines.push(`${pad}${prefix}→ #${node.handle} ${node.target}`);
        return;
      case "enum":
        lines.push(`${pad}${prefix}${node.desc.name}.${node.constant} (enum, #${node.handle})`);
        return;
      case "class":
        lines.push(`${pad}${prefix}class ${node.desc?.name ?? "?"} #${node.handle}`);
        return;
      case "classdesc":
        lines.push(`${pad}${prefix}class descriptor ${node.desc ? classLine(node.desc) : "null"}`);
        return;
      case "reset":
        lines.push(`${pad}${prefix}(stream reset: later references start again from #0)`);
        return;
      case "block":
        lines.push(`${pad}${prefix}block data, ${node.bytes.length} bytes: ${hex(node.bytes)}${node.bytes.length > BLOCK_SHOWN ? ` … ${node.bytes.length - BLOCK_SHOWN} more` : ""}`);
        return;
      case "array": {
        const prims = node.items.every((i) => i.t === "prim");
        if (prims) {
          lines.push(`${pad}${prefix}${jvmType(node.desc.name.slice(1))}[${node.items.length}] #${node.handle} [${node.items.map((i) => (i as { v: string }).v).join(", ")}]`);
          return;
        }
        lines.push(`${pad}${prefix}${jvmType(node.desc.name.slice(1))}[${node.items.length}] #${node.handle} [`);
        node.items.forEach((item, i) => write(item, depth + 1, `[${i}] `));
        lines.push(`${pad}]`);
        return;
      }
      case "object": {
        lines.push(`${pad}${prefix}${classLine(node.desc)} #${node.handle} {`);
        const parts = node.data.filter((part) => part.values.length || part.annotation);
        const inherited = parts.length > 1 || (parts.length === 1 && parts[0]!.desc !== node.desc);
        for (const part of parts) {
          const inner = depth + 1;
          if (inherited) lines.push(`${"  ".repeat(inner)}— fields of ${part.desc.name}${part.desc === node.desc ? "" : ` (serialVersionUID ${part.desc.uid})`}:`);
          for (const [f, v] of part.values) write(v, inner, `${f.name}: ${typeName(f)} = `);
          if (part.annotation) {
            lines.push(`${"  ".repeat(inner)}${part.desc.flags & SC_EXTERNALIZABLE ? "writeExternal" : "writeObject"} data of ${part.desc.name}:`);
            for (const a of part.annotation) write(a, inner + 1, "");
          }
        }
        lines.push(`${pad}}`);
        return;
      }
    }
  };
  try {
    for (const node of nodes) write(node, 0, "");
  } catch (e) {
    if (e !== FULL) throw e;
    return `${out.join("\n")}\n… (output stopped at ${maxChars.toLocaleString()} characters; use Hex or Base64 for the rest)`;
  }
  return out.join("\n");
}
