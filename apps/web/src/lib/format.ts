import { parseJson, stringifyJson } from "./json.ts";
import { decodeMsgpack, msgpackText } from "./msgpack.ts";
import { parsePhpSerialized, phpText } from "./phpser.ts";
import { javaText, parseJavaSerialized } from "./javaser.ts";
import { binFromBytes, bytesFromBin, tokenizeCommandLineBytes, type Bin } from "@rconsole/shared";
/** Characters (or bytes, for hex/base64) a formatter view shows; longer output ends with an explicit marker. */
export const DISPLAY_LIMIT = 100_000;
/** Values up to this size are copied whole in every format; larger ones offer a labelled preview copy. */
export const COPY_FULL_LIMIT = 4 * 1024 * 1024;
export const INFLATE_LIMIT = 4 * 1024 * 1024;
/** Make directional and invisible control characters visible without changing stored bytes. */
export function visibleText(text: string) {
  return text.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
export function displayBin(value: Bin, limit = DISPLAY_LIMIT) {
  const bytes = value.enc === "base64" ? bytesFromBin(value) : undefined;
  const raw = bytes ? escapedBytes(bytes.subarray(0, limit)) : value.data;
  return (
    visibleText(raw.slice(0, limit)) +
    (raw.length > limit || (bytes && bytes.length > limit)
      ? `\n… ${bytes && bytes.length > limit ? bytes.length - limit : raw.length - limit} more ${bytes ? "bytes" : "characters"} (display capped)`
      : "")
  );
}
export function bytesLabel(bytes: number | undefined) {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
/** 3d 4h, 5h 12m, 12m: uptime at a glance. */
export function uptimeLabel(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
export function ttlLabel(ttl: number) {
  return ttl === -1
    ? "No expiry"
    : ttl === -2
      ? "Expired"
      : ttl < 3600
        ? `${ttl}s`
        : `${(ttl / 3600).toFixed(1)}h`;
}
export function detection(value: Bin) {
  const bytes = bytesFromBin(value);
  if (bytes[0] === 0xac && bytes[1] === 0xed)
    return "Java serialization · display only";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  if (
    bytes[0] === 0x78 &&
    bytes[1] !== undefined &&
    bytes[2] !== undefined &&
    (bytes[1] & 0x20) === 0 &&
    ((bytes[2] >> 1) & 3) !== 3 &&
    ((bytes[0] << 8) + bytes[1]) % 31 === 0
  )
    return "Possible zlib compression";
  if (
    /^(?:[aOC]:\d+:|s:\d+:"|i:-?\d+;|b:[01];|d:(?:-?(?:\d+(?:\.\d*)?(?:[Ee][+-]?\d+)?|INF)|NAN);|N;)/.test(
      new TextDecoder().decode(bytes.subarray(0, 64)),
    )
  )
    return "PHP serialization · display only";
  return value.enc === "base64" ? "Binary" : "UTF-8";
}
export type ValueFormat =
  | "text"
  | "json"
  | "tree"
  | "hex"
  | "base64"
  | "msgpack"
  /** Inert structural views of serialized PHP and Java (review v0.2.1 web L3): parsed, never deserialized. */
  | "php"
  | "java"
  | "float32le" | "float32be" | "float64le" | "float64be";
/** The end of a capped formatter view: says what is missing and that Copy is complete (web review v0.2 r3 M1). */
export function omitted(count: number, unit: "characters" | "bytes") {
  return `\n… ${count.toLocaleString()} more ${unit} not shown (display capped; Copy value copies all)`;
}
/**
 * A value in one format. `limit` caps what is shown (the default is the display budget, with an explicit marker);
 * `Infinity` gives the whole representation, which is what Copy copies.
 */
export function formatValue(value: Bin, format: ValueFormat, limit = DISPLAY_LIMIT): string {
  const bytes = bytesFromBin(value);
  if (format === "text") return displayBin(value, limit);
  if (format.startsWith("float")) {
    if (bytes.length > INFLATE_LIMIT) throw new Error("Vector exceeds the 4 MiB formatter limit.");
    const size = format.startsWith("float32") ? 4 : 8;
    if (bytes.length % size) throw new Error(`Vector byte length must be a multiple of ${size}.`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const littleEndian = format.endsWith("le");
    const numbers = Array.from({ length: bytes.length / size }, (_, i) => {
      const n = size === 4 ? view.getFloat32(i * size, littleEndian) : view.getFloat64(i * size, littleEndian);
      return Object.is(n, -0) ? "-0" : String(n);
    });
    const text = `[${numbers.join(", ")}]`;
    return text.length > limit ? text.slice(0, limit) + omitted(text.length - limit, "characters") : text;
  }
  if (format === "base64") {
    const shown = bytes.subarray(0, limit);
    let raw = "";
    for (let i = 0; i < shown.length; i += 0x8000)
      raw += String.fromCharCode(...shown.subarray(i, i + 0x8000));
    return (
      btoa(raw) + (bytes.length > shown.length ? omitted(bytes.length - shown.length, "bytes") : "")
    );
  }
  if (format === "hex")
    return (
      Array.from(
        { length: Math.ceil(Math.min(bytes.length, limit / 4) / 16) },
        (_, row) => {
          const slice = bytes.subarray(row * 16, row * 16 + 16);
          return `${(row * 16).toString(16).padStart(8, "0")}  ${Array.from(
            slice,
            (b) => b.toString(16).padStart(2, "0"),
          )
            .join(" ")
            .padEnd(
              47,
            )}  ${Array.from(slice, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("")}`;
        },
      ).join("\n") +
      (bytes.length > Math.ceil(Math.min(bytes.length, limit / 4) / 16) * 16
        ? omitted(bytes.length - Math.ceil(Math.min(bytes.length, limit / 4) / 16) * 16, "bytes")
        : "")
    );
  if (bytes.length > INFLATE_LIMIT)
    throw new Error(
      "Value exceeds the 4 MiB formatter limit. Use text, hex or base64.",
    );
  // MessagePack keeps exact integers and non-JSON scalars (review r3 H3); JSON keeps its number tokens.
  const text = visibleText(
    format === "msgpack"
      ? msgpackText(decodeMsgpack(bytes))
      : format === "php"
        ? phpText(parsePhpSerialized(bytes))
        : format === "java"
          ? javaText(parseJavaSerialized(bytes), limit + 1)
          : stringifyJson(parseValue(value)),
  );
  return text.length > limit ? text.slice(0, limit) + omitted(text.length - limit, "characters") : text;
}
export function parseValue(value: Bin): unknown {
  const bytes = bytesFromBin(value);
  if (bytes.length > INFLATE_LIMIT)
    throw new Error("Value exceeds the 4 MiB formatter limit.");
  return parseJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
}
export async function inflateValue(
  value: Bin,
  limit = INFLATE_LIMIT,
): Promise<Bin> {
  const kind = detection(value);
  if (kind !== "gzip" && kind !== "Possible zlib compression")
    throw new Error("No gzip or deflate header detected.");
  const source = new Blob([Uint8Array.from(bytesFromBin(value)).buffer]);
  const reader = source
    .stream()
    .pipeThrough(new DecompressionStream(kind === "gzip" ? "gzip" : "deflate"))
    .getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value: part, done } = await reader.read();
      if (done) break;
      total += part.byteLength;
      if (total > limit)
        throw new Error(
          `Inflated data exceeds the ${bytesLabel(limit)} safety limit.`,
        );
      parts.push(part);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return binFromBytes(bytes);
}
export function cliQuote(text: string) {
  return `"${text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(
      /[\x00-\x1f\x7f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,
      (c) => escapedBytes(new TextEncoder().encode(c)),
    )}"`;
}
/** One redis-cli argument: bare when it is printable ASCII without spaces, quotes or backslashes. */
export function cliArg(text: string) {
  return /^[\x21-\x7e]+$/.test(text) && !/["'\\]/.test(text)
    ? text
    : cliQuote(text);
}
/** A key as one redis-cli argument: bare when safe, quoted otherwise, escaped bytes for binary keys. */
export function cliKey(value: Bin) {
  return value.enc === "utf8" ? cliArg(value.data) : cliBin(value);
}
export function cliBin(value: Bin, limit = Infinity) {
  const text = value.enc === "utf8"
    ? cliQuote(value.data.slice(0, limit))
    : `"${escapedBytes(bytesFromBin(value).subarray(0, limit))}"`;
  return text.length > limit ? `${text.slice(0, limit)}\n… (display capped)` : text;
}

/** A rendered command must remain executable with the same bytes, including single-quoted controls. */
export function cliDisplayLine(line: string) {
  if (!/[\x00-\x1f\x7f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(line)) return line;
  try {
    return tokenizeCommandLineBytes(line).map(bytes => cliKey(binFromBytes(bytes))).join(" ");
  } catch {
    // An invalid draft has no executable representation.
    return visibleText(line);
  }
}

/** Byte display only. No object construction or deserialization of Java streams. */
export function javaDescriptor(value: Bin) {
  const b = bytesFromBin(value);
  if (
    b.length < 8 ||
    b[0] !== 0xac ||
    b[1] !== 0xed ||
    b[2] !== 0 ||
    b[3] !== 5
  )
    return;
  const start = b[4] === 0x73 && b[5] === 0x72 ? 6 : b[4] === 0x72 ? 5 : -1;
  if (start < 0) return;
  const size = (b[start]! << 8) | b[start + 1]!;
  const end = start + 2 + size;
  if (!size || size > 4096 || end + 8 > b.length) return;
  try {
    return {
      name: visibleText(
        new TextDecoder("utf-8", { fatal: true }).decode(
          b.subarray(start + 2, end),
        ),
      ),
      uid: new DataView(b.buffer, b.byteOffset + end, 8)
        .getBigInt64(0)
        .toString(),
    };
  } catch {
    return;
  }
}
export function escapedBytes(bytes: Uint8Array) {
  return visibleText(
    Array.from(bytes, (b) =>
      b >= 32 && b < 127 && b !== 34 && b !== 92
        ? String.fromCharCode(b)
        : b === 34
          ? '\\"'
          : b === 92
            ? "\\\\"
            : `\\x${b.toString(16).padStart(2, "0")}`,
    ).join(""),
  );
}
export function epochLabel(raw: string) {
  const match = /^(\d{10}|\d{13})(?:-\d+)?$/.exec(raw);
  if (!match) return;
  const ms = Number(match[1]) * (match[1]!.length === 10 ? 1000 : 1);
  const date = new Date(ms);
  if (date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) return;
  return date.toISOString();
}
export function namespaceRecipe(key: Bin) {
  if (key.enc !== "utf8") return;
  if (key.data.startsWith("bull:"))
    return "BullMQ · queue state (read-only interpretation)";
  if (
    /^(?:queue:|queues$|retry$|schedule$|dead$|stat:|sidekiq:)/.test(key.data)
  )
    return "Sidekiq · jobs / scheduling (read-only interpretation)";
  if (key.data.startsWith("spring:session:"))
    return "Spring Session · session / expiry index (read-only interpretation)";
  if (key.data.startsWith("socket.io"))
    return "Socket.IO · adapter namespace (read-only interpretation)";
}
/** Trial decode at most the first KiB; cancel immediately, never allocate unbounded output. */
export async function probeDeflate(value: Bin): Promise<boolean> {
  if (detection(value) !== "Possible zlib compression") return false;
  const reader = new Response(Uint8Array.from(bytesFromBin(value)))
    .body!.pipeThrough(new DecompressionStream("deflate"))
    .getReader();
  let total = 0;
  try {
    while (total < 1024) {
      const part = await reader.read();
      if (part.done) return true;
      total += part.value.byteLength;
    }
    return true;
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** A textarea normalizes CR/CRLF: use byte editing for these values. */
export function editableBin(value: Bin): Bin {
  return value.enc === "utf8" && value.data.includes("\r")
    ? { enc: "base64", data: btoa(Array.from(bytesFromBin(value), b => String.fromCharCode(b)).join("")) }
    : value;
}
