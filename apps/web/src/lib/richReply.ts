/**
 * Command-aware readings of console/workbench replies (v0.2.1, RI parity F11): search and aggregate results as
 * tables, TimeSeries ranges as series, FT.EXPLAIN / FT.PROFILE as plan trees. Pure functions over the `Reply` tree;
 * the components in components/RichReply.tsx render their output as text only.
 *
 * Both reply shapes are understood: RESP3 maps (what the server negotiates) and the RESP2-style arrays some module
 * versions still send. Anything that does not have the expected shape returns undefined, and the generic view stays.
 */
import { bytesFromBin, type Bin, type Reply } from "@rconsole/shared";

export type RichKind = "search" | "aggregate" | "series" | "multiSeries" | "explain" | "profile" | "geo";

/** One table row: an optional document id (exact bytes) and its fields in reply order. */
export interface RichRow {
  id?: Bin;
  score?: string;
  fields: [string, Reply][];
}
export interface RichTable {
  total?: number;
  rows: RichRow[];
  /** Field names in first-seen order. */
  columns: string[];
  cursor?: string;
  warnings: string[];
  /** Rows and columns the reply had beyond the renderer's bounds (shown in the raw view only). */
  omittedRows: number;
  omittedColumns: number;
}
export interface Series {
  name: string;
  /** [epoch ms, value]; non-numeric values are dropped and counted. */
  samples: [number, number][];
  dropped: number;
  labels: [string, string][];
}
/** TS.MRANGE series: the first `MAX_SERIES` are drawn; `total` is how many the reply had. */
export interface SeriesSet {
  series: Series[];
  total: number;
}
export interface PlanNode {
  label: string;
  facts: [string, string][];
  children: PlanNode[];
}
export interface ProfileView {
  results?: RichTable;
  shards: { name: string; facts: [string, string][]; iterators?: PlanNode; processors: PlanNode[] }[];
}

// Renderer bounds. A view that hits one says so (review v0.2.1 web M2); the raw reply stays complete.
export const MAX_ROWS = 1000;
export const MAX_COLUMNS = 40;
export const MAX_SERIES = 12;
export const MAX_PLAN_DEPTH = 40;

/** A scalar reply as text (strings as UTF-8 text or escaped bytes are left to the caller via `bin`). */
export function replyText(r: Reply | undefined): string {
  if (!r) return "";
  switch (r.t) {
    case "str":
      return r.v.enc === "utf8" ? r.v.data : `<${Math.floor((r.v.data.length * 3) / 4)} bytes>`;
    case "status":
    case "err":
    case "int":
    case "dbl":
      return r.v;
    case "bool":
      return String(r.v);
    case "nil":
      return "(nil)";
    case "truncated":
      return `<truncated, ${r.bytes} bytes>`;
    default:
      return "";
  }
}

const isList = (r: Reply | undefined): r is Extract<Reply, { t: "arr" | "set" }> => !!r && (r.t === "arr" || r.t === "set");
const isScalar = (r: Reply | undefined) => !!r && !isList(r) && r.t !== "map";
const keyOf = (r: Reply) => replyText(r);

/** Map entries (RESP3 map, or a flat [k, v, k, v] array), keys as text. */
export function entries(r: Reply | undefined): [string, Reply][] | undefined {
  if (!r) return undefined;
  if (r.t === "map") return r.v.map(([k, v]) => [keyOf(k), v]);
  if (isList(r) && r.v.length % 2 === 0 && r.v.every((x, i) => i % 2 === 1 || x.t === "str")) {
    const out: [string, Reply][] = [];
    for (let i = 0; i + 1 < r.v.length; i += 2) out.push([keyOf(r.v[i]!), r.v[i + 1]!]);
    return out;
  }
  return undefined;
}
const get = (r: Reply | undefined, name: string) => entries(r)?.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const num = (r: Reply | undefined) => {
  const n = Number(replyText(r));
  return Number.isFinite(n) ? n : undefined;
};

function table(rows: RichRow[], total?: number, extra: Partial<RichTable> = {}): RichTable {
  const all = new Set<string>();
  for (const row of rows) for (const [f] of row.fields) all.add(f);
  const columns = [...all].slice(0, MAX_COLUMNS);
  return {
    rows: rows.slice(0, MAX_ROWS),
    columns,
    warnings: [],
    omittedRows: Math.max(0, rows.length - MAX_ROWS),
    omittedColumns: all.size - columns.length,
    ...(total !== undefined ? { total } : {}),
    ...extra,
  };
}

const fieldPairs = (r: Reply | undefined): [string, Reply][] => entries(r) ?? [];
const warnings = (r: Reply | undefined) => (isList(r) ? r.v.map(replyText).filter(Boolean) : []);

/** FT.SEARCH (and the Results part of FT.PROFILE SEARCH). */
export function searchTable(reply: Reply): RichTable | undefined {
  if (reply.t === "map") {
    const results = get(reply, "results");
    if (!isList(results)) return undefined;
    const rows = results.v.map((item): RichRow => {
      const id = get(item, "id");
      const score = get(item, "score");
      return {
        ...(id?.t === "str" ? { id: id.v } : {}),
        ...(score ? { score: replyText(score) } : {}),
        fields: fieldPairs(get(item, "extra_attributes")),
      };
    });
    return table(rows, num(get(reply, "total_results")), { warnings: warnings(get(reply, "warning")) });
  }
  // RESP2: [total, id, [f, v, …], id, [f, v, …] …] or, with NOCONTENT, [total, id, id …].
  if (!isList(reply) || reply.v[0]?.t !== "int") return undefined;
  const rest = reply.v.slice(1);
  const rows: RichRow[] = [];
  for (let i = 0; i < rest.length; ) {
    const id = rest[i];
    if (id?.t !== "str") return undefined;
    const next = rest[i + 1];
    if (isList(next)) {
      rows.push({ id: id.v, fields: fieldPairs(next) });
      i += 2;
    } else {
      rows.push({ id: id.v, fields: [] });
      i += 1;
    }
  }
  return table(rows, num(reply.v[0]));
}

/** FT.AGGREGATE / FT.CURSOR READ, with or without WITHCURSOR. */
export function aggregateTable(reply: Reply): RichTable | undefined {
  // WITHCURSOR: [reply, cursor]
  if (isList(reply) && reply.v.length === 2 && reply.v[1]?.t === "int" && (reply.v[0]?.t === "map" || isList(reply.v[0]))) {
    const inner = aggregateTable(reply.v[0]!);
    return inner ? { ...inner, cursor: reply.v[1].v } : undefined;
  }
  if (reply.t === "map") {
    const results = get(reply, "results");
    if (!isList(results)) return undefined;
    const rows = results.v.map((item): RichRow => ({ fields: fieldPairs(get(item, "extra_attributes") ?? item) }));
    return table(rows, num(get(reply, "total_results")), { warnings: warnings(get(reply, "warning")) });
  }
  if (!isList(reply) || reply.v[0]?.t !== "int") return undefined;
  const rows = reply.v.slice(1).map((item): RichRow => ({ fields: fieldPairs(item) }));
  return table(rows, num(reply.v[0]));
}

/** [[timestamp, value], …] -> samples. */
function samplesOf(r: Reply | undefined): { samples: [number, number][]; dropped: number } | undefined {
  if (!isList(r)) return undefined;
  const samples: [number, number][] = [];
  let dropped = 0;
  for (const s of r.v) {
    if (!isList(s) || s.v.length !== 2 || !isScalar(s.v[0]) || !isScalar(s.v[1])) return undefined;
    const t = num(s.v[0]);
    const v = num(s.v[1]);
    if (t === undefined) return undefined;
    if (v === undefined) dropped++;
    else samples.push([t, v]);
  }
  return { samples, dropped };
}

/** TS.RANGE / TS.REVRANGE (sorted by time for the chart). */
export function seriesOf(reply: Reply, name = "series"): Series | undefined {
  const s = samplesOf(reply);
  if (!s) return undefined;
  return { name, samples: [...s.samples].sort((a, b) => a[0] - b[0]), dropped: s.dropped, labels: [] };
}

const labelsOf = (r: Reply | undefined): [string, string][] =>
  r?.t === "map"
    ? r.v.map(([k, v]) => [replyText(k), replyText(v)])
    : isList(r)
      ? r.v.flatMap((pair) => (isList(pair) && pair.v.length === 2 ? [[replyText(pair.v[0]), replyText(pair.v[1])] as [string, string]] : []))
      : [];

/** TS.MRANGE / TS.MREVRANGE: one series per key (RESP3 map key -> [labels, …, samples]; RESP2 [[key, labels, samples] …]). */
export function multiSeriesOf(reply: Reply): SeriesSet | undefined {
  const items: [string, Reply][] =
    reply.t === "map"
      ? reply.v.map(([k, v]) => [replyText(k), v])
      : isList(reply)
        ? reply.v.flatMap((x) => (isList(x) && x.v.length >= 2 ? [[replyText(x.v[0]), { t: "arr", v: x.v.slice(1) } as Reply] as [string, Reply]] : []))
        : [];
  if (!items.length && !(isList(reply) && reply.v.length === 0) && !(reply.t === "map" && reply.v.length === 0)) return undefined;
  const out: Series[] = [];
  for (const [name, body] of items.slice(0, MAX_SERIES)) {
    if (!isList(body)) return undefined;
    // The samples are the last element that reads as [[t, v] …]; labels are the first map / pair list.
    let s: ReturnType<typeof samplesOf>;
    for (let i = body.v.length - 1; i >= 0 && !s; i--) s = samplesOf(body.v[i]);
    if (!s) return undefined;
    out.push({ name, samples: [...s.samples].sort((a, b) => a[0] - b[0]), dropped: s.dropped, labels: labelsOf(body.v[0]) });
  }
  return { series: out, total: items.length };
}

/** FT.EXPLAIN text ("INTERSECT {", "}" lines) or FT.EXPLAINCLI lines -> a plan tree. */
export function explainPlan(reply: Reply): PlanNode | undefined {
  const lines =
    reply.t === "str" && reply.v.enc === "utf8"
      ? reply.v.data.split(/\r?\n/)
      : isList(reply) && reply.v.every((x) => x.t === "str")
        ? reply.v.map(replyText)
        : undefined;
  if (!lines) return undefined;
  const root: PlanNode = { label: "Query plan", facts: [], children: [] };
  const stack = [root];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "}") {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const open = line.endsWith("{");
    const node: PlanNode = { label: open ? line.slice(0, -1).trim() : line, facts: [], children: [] };
    stack.at(-1)!.children.push(node);
    if (open) stack.push(node);
  }
  return root.children.length === 1 ? root.children[0] : root;
}

const CHILDREN = /^child iterators?$/i;
/** An FT.PROFILE iterator (Type, Term/Query, Time, Counter, Child iterators). */
function iteratorNode(r: Reply | undefined, depth = 0): PlanNode | undefined {
  const e = entries(r);
  if (!e) return undefined;
  if (depth > MAX_PLAN_DEPTH) return { label: `… deeper iterators not shown (more than ${MAX_PLAN_DEPTH} levels); see the raw reply`, facts: [], children: [] };
  const facts: [string, string][] = [];
  const children: PlanNode[] = [];
  let type = "", detail = "";
  for (const [k, v] of e) {
    if (CHILDREN.test(k)) {
      const list = isList(v) ? v.v : [v];
      for (const c of list) {
        const n = iteratorNode(c, depth + 1);
        if (n) children.push(n);
      }
    } else if (/^type$/i.test(k)) type = replyText(v);
    else if (/^(term|query type|query)$/i.test(k)) detail = replyText(v);
    else if (isScalar(v)) facts.push([k, replyText(v)]);
  }
  return { label: [type || "Iterator", detail].filter(Boolean).join(" "), facts, children };
}

/** FT.PROFILE … SEARCH|AGGREGATE: results plus each shard's timings, iterator tree and result processors. */
export function profileView(reply: Reply): ProfileView | undefined {
  let results: Reply | undefined, profile: Reply | undefined;
  if (reply.t === "map") {
    results = get(reply, "results");
    profile = get(reply, "profile");
  } else if (isList(reply) && reply.v.length === 2) {
    [results, profile] = reply.v;
  }
  if (!profile) return undefined;
  const shardReplies = get(profile, "shards");
  const shards = isList(shardReplies) ? shardReplies.v : [profile];
  const view: ProfileView = { shards: [] };
  const rt = results && (searchTable(results) ?? aggregateTable(results));
  if (rt) view.results = rt;
  shards.forEach((shard, i) => {
    const facts: [string, string][] = [];
    let iterators: PlanNode | undefined;
    const processors: PlanNode[] = [];
    for (const [k, v] of entries(shard) ?? []) {
      if (/^iterators profile$/i.test(k)) iterators = iteratorNode(isList(v) && v.v.length === 1 ? v.v[0] : v);
      else if (/^result processors profile$/i.test(k)) {
        for (const p of isList(v) ? v.v : []) {
          const n = iteratorNode(p);
          if (n) processors.push(n);
        }
      } else if (isScalar(v)) facts.push([k, replyText(v)]);
      else if (isList(v) && v.v.every(isScalar) && v.v.length) facts.push([k, v.v.map(replyText).join(", ")]);
    }
    view.shards.push({ name: shards.length > 1 ? `Shard ${i + 1}` : "Profile", facts, ...(iterators ? { iterators } : {}), processors });
  });
  return view.shards.length ? view : undefined;
}

// ---------------------------------------------------------------------------
// v0.4 (F11): geo results on a map. GEOSEARCH / GEORADIUS* with WITHCOORD and GEOPOS.

export const MAX_GEO_POINTS = 2000;
const GEO_SEARCH = new Set(["GEOSEARCH", "GEORADIUS", "GEORADIUS_RO", "GEORADIUSBYMEMBER", "GEORADIUSBYMEMBER_RO"]);
const UNIT_M: Record<string, number> = { M: 1, KM: 1000, MI: 1609.344, FT: 0.3048 };

export interface GeoPoint {
  /** The member (from the reply), or for GEOPOS the name as it was typed (argv). */
  member?: Bin;
  label?: string;
  lon: number;
  lat: number;
  /** WITHDIST, in the query's unit. */
  dist?: string;
  hash?: string;
}
export interface GeoView {
  points: GeoPoint[];
  /** Positions the reply had beyond the renderer's bound, and GEOPOS members that do not exist. */
  omitted: number;
  missing: string[];
  unit?: string;
  /** The search area when the command names it: a centre with a radius or a box (metres). */
  center?: { lon: number; lat: number };
  radiusM?: number;
  boxM?: { width: number; height: number };
}

const geoNumber = (r: Reply | undefined): number | undefined => {
  if (!r) return undefined;
  const t = r.t === "str" ? new TextDecoder().decode(bytesFromBin(r.v)) : r.t === "dbl" || r.t === "int" ? r.v : undefined;
  if (t === undefined) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};
const coord = (r: Reply | undefined): { lon: number; lat: number } | undefined => {
  if (!r || r.t !== "arr" || r.v.length < 2) return undefined;
  const lon = geoNumber(r.v[0]);
  const lat = geoNumber(r.v[1]);
  return lon !== undefined && lat !== undefined && Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? { lon, lat } : undefined;
};
const word = (argv: readonly string[], token: string) => argv.findIndex((a, i) => i > 1 && a.toUpperCase() === token);

/** The search area a GEOSEARCH / GEORADIUS command names, in metres (undefined parts when it does not say). */
function geoArea(name: string, argv: readonly string[]): Pick<GeoView, "center" | "radiusM" | "boxM" | "unit"> {
  const out: Pick<GeoView, "center" | "radiusM" | "boxM" | "unit"> = {};
  const lonlat = (i: number) => {
    const lon = Number(argv[i]);
    const lat = Number(argv[i + 1]);
    if (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lon) <= 180 && Math.abs(lat) <= 90) out.center = { lon, lat };
  };
  if (name === "GEOSEARCH") {
    const from = word(argv, "FROMLONLAT");
    if (from > 0) lonlat(from + 1);
    const radius = word(argv, "BYRADIUS");
    const box = word(argv, "BYBOX");
    if (radius > 0) {
      const unit = (argv[radius + 2] ?? "").toUpperCase();
      if (UNIT_M[unit]) (out.radiusM = Number(argv[radius + 1]) * UNIT_M[unit]!), (out.unit = unit.toLowerCase());
    } else if (box > 0) {
      const unit = (argv[box + 3] ?? "").toUpperCase();
      if (UNIT_M[unit]) {
        out.boxM = { width: Number(argv[box + 1]) * UNIT_M[unit]!, height: Number(argv[box + 2]) * UNIT_M[unit]! };
        out.unit = unit.toLowerCase();
      }
    }
  } else if (name === "GEORADIUS" || name === "GEORADIUS_RO") {
    lonlat(2);
    const unit = (argv[5] ?? "").toUpperCase();
    if (UNIT_M[unit]) (out.radiusM = Number(argv[4]) * UNIT_M[unit]!), (out.unit = unit.toLowerCase());
  } else {
    const unit = (argv[4] ?? "").toUpperCase();
    if (UNIT_M[unit]) (out.radiusM = Number(argv[3]) * UNIT_M[unit]!), (out.unit = unit.toLowerCase());
  }
  if (out.radiusM !== undefined && !(out.radiusM > 0)) delete out.radiusM;
  if (out.boxM && !(out.boxM.width > 0 && out.boxM.height > 0)) delete out.boxM;
  return out;
}

/** The points of a geo reply, or undefined when it has no coordinates to draw. */
export function geoView(argv: readonly string[], reply: Reply): GeoView | undefined {
  const name = (argv[0] ?? "").toUpperCase();
  if (reply.t !== "arr") return undefined;
  if (name === "GEOPOS") {
    const names = argv.slice(2);
    const points: GeoPoint[] = [];
    const missing: string[] = [];
    reply.v.forEach((r, i) => {
      const c = coord(r);
      if (c && points.length < MAX_GEO_POINTS) points.push({ label: names[i] ?? `#${i + 1}`, ...c });
      else if (!c) missing.push(names[i] ?? `#${i + 1}`);
    });
    const omitted = Math.max(0, reply.v.length - points.length - missing.length) + (reply.more ?? 0);
    return points.length ? { points, omitted, missing } : undefined;
  }
  if (!GEO_SEARCH.has(name)) return undefined;
  // STORE / STOREDIST write the result to a key and reply with a count.
  if (word(argv, "STORE") > 0 || word(argv, "STOREDIST") > 0 || word(argv, "WITHCOORD") < 0) return undefined;
  const withDist = word(argv, "WITHDIST") > 0;
  const withHash = word(argv, "WITHHASH") > 0;
  // Each item is [member, dist?, hash?, [lon, lat]] in this order whatever order the flags were typed in.
  const points: GeoPoint[] = [];
  for (const item of reply.v) {
    if (points.length >= MAX_GEO_POINTS) break;
    if (item.t !== "arr" || item.v[0]?.t !== "str") continue;
    let i = 1;
    const dist = withDist ? item.v[i++] : undefined;
    const hash = withHash ? item.v[i++] : undefined;
    const c = coord(item.v[i]);
    if (!c) continue;
    points.push({
      member: item.v[0].v,
      ...c,
      ...(dist ? { dist: replyText(dist) } : {}),
      ...(hash ? { hash: replyText(hash) } : {}),
    });
  }
  if (!points.length) return undefined;
  return { points, omitted: reply.v.length - points.length + (reply.more ?? 0), missing: [], ...geoArea(name, argv) };
}

/** Which rich view a reply of this command has (undefined: the generic view only). */
export function richKind(argv: readonly string[], reply: Reply): RichKind | undefined {
  if (reply.t === "err" || reply.t === "truncated" || reply.t === "nil") return undefined;
  const name = (argv[0] ?? "").toUpperCase();
  const sub = (argv[1] ?? "").toUpperCase();
  if (name === "FT.SEARCH") return searchTable(reply) ? "search" : undefined;
  if (name === "FT.AGGREGATE" || (name === "FT.CURSOR" && sub === "READ")) return aggregateTable(reply) ? "aggregate" : undefined;
  if (name === "TS.RANGE" || name === "TS.REVRANGE") return seriesOf(reply) ? "series" : undefined;
  if (name === "TS.MRANGE" || name === "TS.MREVRANGE") return multiSeriesOf(reply) ? "multiSeries" : undefined;
  if (name === "FT.EXPLAIN" || name === "FT.EXPLAINCLI") return explainPlan(reply) ? "explain" : undefined;
  if (name === "FT.PROFILE") return profileView(reply) ? "profile" : undefined;
  if (name === "GEOPOS" || GEO_SEARCH.has(name)) return geoView(argv, reply) ? "geo" : undefined;
  return undefined;
}

export const RICH_LABEL: Record<RichKind, string> = {
  search: "Table",
  aggregate: "Table",
  series: "Chart",
  multiSeries: "Chart",
  explain: "Plan",
  profile: "Profile",
  geo: "Map",
};
