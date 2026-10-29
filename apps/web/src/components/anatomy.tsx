/**
 * The signature element (docs/DESIGN.md §5): key anatomy, type glyphs and the TTL fuse.
 * Everything renders as text nodes; Redis data is never interpreted as markup.
 */
import { useSyncExternalStore } from "react";
import type { Bin, RedisType } from "@rconsole/shared";
import { cliBin, visibleText } from "../lib/format.ts";

export type SegmentKind = "ns" | "id" | "leaf";
export interface Segment {
  text: string;
  kind: SegmentKind;
}

const ID_PATTERNS = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9A-HJKMNP-TV-Z]{26}$/, // ULID
  /^[-+]?\d+(?:\.\d+)?$/, // number
  /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}$/i, // hex with digits and letters
  /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_+/=-]{16,}$/, // opaque token
];

/** True when a key segment looks like an identifier rather than a namespace word. */
export function isIdentifier(segment: string) {
  return ID_PATTERNS.some((pattern) => pattern.test(segment));
}

/** Splits a key into namespace, identifier and leaf segments. Joined text equals the input. */
export function segmentKey(text: string, delimiter = ":"): Segment[] {
  if (!delimiter || !text.includes(delimiter))
    return [{ text, kind: isIdentifier(text) ? "id" : "leaf" }];
  const parts = text.split(delimiter);
  return parts.map((part, index) => ({
    text: part,
    kind: isIdentifier(part)
      ? "id"
      : index === parts.length - 1
        ? "leaf"
        : "ns",
  }));
}

/**
 * A key name as anatomy: dimmed delimiters, distinguished IDs, emphasised leaf.
 * `prefix` (a folder path that ends with the delimiter) is kept in the accessible text
 * but not shown, so tree rows stay short while the row text still equals the full key.
 */
export function KeyName({
  name,
  delimiter = ":",
  prefix = "",
  limit = 1000,
  className = "",
}: {
  name: Bin;
  delimiter?: string;
  prefix?: string;
  limit?: number;
  className?: string;
}) {
  if (name.enc !== "utf8" || !/^[\x21-\x7e]+$/.test(name.data) || /["'\\]/.test(name.data))
    return (
      <span className={`key-anatomy binary ${className}`.trim()} dir="ltr">
        {cliBin(name, limit)}
      </span>
    );
  const full = name.data.slice(0, limit);
  const hidden = prefix && full.startsWith(prefix) ? prefix : "";
  const rest = full.slice(hidden.length);
  const segments = segmentKey(rest, delimiter);
  return (
    <span className={`key-anatomy ${className}`.trim()} dir="ltr">
      {hidden && <span className="sr-only">{visibleText(hidden)}</span>}
      {segments.map((segment, index) => (
        <span key={index}>
          {index > 0 && <span className="ka-d">{visibleText(delimiter)}</span>}
          <span className={`ka-${segment.kind}`}>
            {visibleText(segment.text)}
          </span>
        </span>
      ))}
      {name.data.length > limit && <span className="ka-d">…</span>}
    </span>
  );
}

const TYPE_INFO: Record<string, { code: string; family: string; label: string }> =
  {
    string: { code: "str", family: "string", label: "string" },
    hash: { code: "hsh", family: "hash", label: "hash" },
    list: { code: "lst", family: "list", label: "list" },
    set: { code: "set", family: "set", label: "set" },
    zset: { code: "zst", family: "zset", label: "zset" },
    stream: { code: "stm", family: "stream", label: "stream" },
    "ReJSON-RL": { code: "jsn", family: "json", label: "ReJSON-RL" },
    json: { code: "jsn", family: "json", label: "json" },
    "TSDB-TYPE": { code: "ts", family: "timeseries", label: "TSDB-TYPE" },
    timeseries: { code: "ts", family: "timeseries", label: "timeseries" },
    "MBbloom--": { code: "bf", family: "probabilistic", label: "MBbloom--" },
    MBbloomCF: { code: "cf", family: "probabilistic", label: "MBbloomCF" },
    "CMSk-TYPE": { code: "cms", family: "probabilistic", label: "CMSk-TYPE" },
    "TopK-TYPE": { code: "tk", family: "probabilistic", label: "TopK-TYPE" },
    "TDIS-TYPE": { code: "td", family: "probabilistic", label: "TDIS-TYPE" },
    vectorset: { code: "vec", family: "vector", label: "vectorset" },
    array: { code: "arr", family: "array", label: "array" },
  };

export function typeInfo(type: RedisType) {
  return (
    TYPE_INFO[type] ?? {
      code: type === "none" ? "—" : "?",
      family: "other",
      label: String(type),
    }
  );
}

/** Three-letter type tag in the type's hue; the full Redis type name is the accessible text. */
export function TypeGlyph({
  type,
  wide = false,
}: {
  type: RedisType;
  wide?: boolean;
}) {
  const info = typeInfo(type);
  return (
    <span
      className={`type-glyph t-${info.family} ${wide ? "wide" : ""}`.trim()}
      title={info.label}
    >
      {wide ? (
        info.label
      ) : (
        <>
          <span aria-hidden="true">{info.code}</span>
          <span className="sr-only">{info.label}</span>
        </>
      )}
    </span>
  );
}

/* One shared one-second clock for every fuse on the page. */
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer)
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
export function useNow() {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  );
}

const FULL_SECONDS = 7 * 24 * 3600;
/** Remaining fraction on a log scale: full at ≥ 7 days, empty at 0. */
export function fuseFraction(seconds: number) {
  if (seconds <= 0) return 0;
  return Math.min(1, Math.log1p(seconds) / Math.log1p(FULL_SECONDS));
}
export function ttlState(seconds: number) {
  if (seconds === -1) return "persist";
  if (seconds <= 0) return "expired";
  if (seconds <= 60) return "critical";
  if (seconds <= 3600) return "soon";
  return "long";
}
/** Compact countdown: 42s, 9m 05s, 3h 12m, 4d 6h. */
export function countdown(seconds: number) {
  if (seconds === -1) return "no expiry";
  if (seconds <= 0) return "expired";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Seconds left now, given the TTL the server reported at `readAt` (ms). */
export function remaining(ttl: number, readAt: number, at: number) {
  if (ttl < 0) return ttl;
  return Math.max(0, ttl - Math.floor((at - readAt) / 1000));
}

/**
 * The TTL fuse: a bar that burns down live plus a countdown label.
 * The bar is decorative (aria-hidden); the label carries the value.
 */
export function TtlFuse({
  ttl,
  readAt,
  size = "row",
  label = true,
}: {
  ttl: number;
  readAt: number;
  size?: "row" | "full";
  label?: boolean;
}) {
  const at = useNow();
  const left = remaining(ttl, readAt, at);
  const state = ttlState(left);
  return (
    <span
      className={`ttl-fuse ${size} ttl-${state}`}
      title={
        ttl === -1
          ? "No expiry (persistent key)"
          : left <= 0
            ? "Expired"
            : `Expires in ${countdown(left)} (TTL ${left}s)`
      }
    >
      <span className="fuse-track" aria-hidden="true">
        {state !== "persist" && (
          <span
            className="fuse-burn"
            style={{ transform: `scaleX(${fuseFraction(left)})` }}
          />
        )}
      </span>
      {label && <span className="fuse-label">{countdown(left)}</span>}
    </span>
  );
}
