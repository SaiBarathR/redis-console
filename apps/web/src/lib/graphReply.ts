/** FalkorDB's verbose result set: [header, rows, statistics], or [statistics] for writes without RETURN. */
import type { Reply } from '@rconsole/shared';
import { MAX_COLUMNS, MAX_PLAN_DEPTH, MAX_ROWS, replyText, type PlanNode, type RichTable } from './richReply.ts';

export const MAX_GRAPH_NODES = 200;
export const MAX_GRAPH_EDGES = 400;
export const MAX_GRAPH_PLAN_LINES = 1000;
export interface GraphNode { id: string; labels: string[]; properties: Reply; placeholder?: boolean }
export interface GraphEdge { id: string; type: string; source: string; target: string; properties: Reply }
export interface GraphViewData {
  table: RichTable;
  nodes: GraphNode[];
  edges: GraphEdge[];
  omittedNodes: number;
  omittedEdges: number;
  incomplete: boolean;
  statistics: string[];
}
const list = (r: Reply | undefined): r is Extract<Reply, { t: 'arr' }> => r?.t === 'arr';
const text = (r: Reply | undefined): string | undefined => r?.t === 'str' && r.v.enc === 'utf8' ? r.v.data : undefined;
const id = (r: Reply | undefined): string | undefined => r?.t === 'int' && /^(0|[1-9][0-9]*)$/.test(r.v) ? r.v : undefined;
function entityFields(r: Reply): Map<string, Reply> | undefined {
  if (!list(r) || !r.v.length || r.more) return undefined;
  const out = new Map<string, Reply>();
  for (const pair of r.v) {
    if (!list(pair) || pair.v.length !== 2 || pair.more || text(pair.v[0]) === undefined) return undefined;
    const key = text(pair.v[0])!;
    if (out.has(key)) return undefined;
    out.set(key, pair.v[1]!);
  }
  return out;
}

export function graphView(reply: Reply): GraphViewData | undefined {
  if (!list(reply)) return undefined;
  const last = reply.v.at(-1);
  const stats = list(last) && last.v.every((r) => text(r) !== undefined) ? last : undefined;
  const partial = reply.v.length === 2 && !!reply.more;
  if (!stats && !partial) return undefined;
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  let incomplete = !!reply.more || !!stats?.more;
  // The API bounds total elements to 10k and depth to 32; this walk also bounds its own work.
  const hasCuts = (r: Reply, depth = 0): boolean => depth > 32 || r.t === 'truncated' || ((r.t === 'arr' || r.t === 'set') && (!!r.more || r.v.some((x) => hasCuts(x, depth + 1)))) || (r.t === 'map' && (!!r.more || r.v.some(([k, v]) => hasCuts(k, depth + 1) || hasCuts(v, depth + 1))));
  let visits = 0;
  const walk = (r: Reply, depth = 0): void => {
    if (++visits > 10_000 || depth > 32) { incomplete = true; return; }
    if (r.t === 'truncated') { incomplete = true; return; }
    if (r.t === 'arr' || r.t === 'set' || r.t === 'map') incomplete ||= !!r.more;
    const f = entityFields(r);
    const key = id(f?.get('id'));
    const props = f?.get('properties');
    if (f && key !== undefined && list(props)) {
      incomplete ||= hasCuts(r);
      const labels = f.get('labels');
      if (list(labels) && labels.v.every((x) => text(x) !== undefined)) {
        nodes.set(key, { id: key, labels: labels.v.map(replyText), properties: props });
        return;
      }
      const source = id(f.get('src_node'));
      const target = id(f.get('dest_node'));
      const type = text(f.get('type'));
      if (source !== undefined && target !== undefined && type !== undefined) {
        edges.set(key, { id: key, type, source, target, properties: props });
        return;
      }
    }
    if (r.t === 'arr' || r.t === 'set') for (const x of r.v) walk(x, depth + 1);
    if (r.t === 'map') for (const [k, v] of r.v) { walk(k, depth + 1); walk(v, depth + 1); }
  };
  let columns: string[] = [];
  let rows: Reply[] = [];
  let moreRows = 0;
  let moreColumns = 0;
  if (reply.v.length === 3 || partial) {
    const header = reply.v[0];
    const body = reply.v[1];
    if (!list(header) || !header.v.every((x) => text(x) !== undefined) || !list(body)) return undefined;
    const seen = new Set<string>();
    columns = header.v.map((x, i) => {
      const base = text(x)!;
      let label = base;
      let suffix = i + 1;
      while (seen.has(label)) label = `${base} [${suffix++}]`;
      seen.add(label); return label;
    });
    rows = body.v;
    moreRows = body.more ?? 0;
    moreColumns = header.more ?? 0;
    incomplete ||= !!moreRows || !!moreColumns;
    if (!rows.every(list)) return undefined;
    for (const row of rows) walk(row);
  } else if (reply.v.length !== 1) return undefined;
  // Edge-only results still get endpoint placeholders. They are visibly distinguished from returned nodes.
  for (const edge of edges.values()) for (const endpoint of [edge.source, edge.target]) {
    if (!nodes.has(endpoint)) nodes.set(endpoint, { id: endpoint, labels: [], properties: { t: 'arr', v: [] }, placeholder: true });
  }
  const drawnNodes = [...nodes.values()].slice(0, MAX_GRAPH_NODES);
  const drawnIds = new Set(drawnNodes.map((n) => n.id));
  const drawnEdges = [...edges.values()].filter((e) => drawnIds.has(e.source) && drawnIds.has(e.target)).slice(0, MAX_GRAPH_EDGES);
  return {
    table: {
      columns: columns.slice(0, MAX_COLUMNS),
      rows: rows.slice(0, MAX_ROWS).map((row) => ({ fields: columns.slice(0, MAX_COLUMNS).flatMap((c, i): [string, Reply][] => list(row) && row.v[i] ? [[c, row.v[i]!]] : []) })),
      omittedRows: Math.max(0, rows.length - MAX_ROWS),
      omittedColumns: Math.max(0, columns.length - MAX_COLUMNS) + moreColumns,
      warnings: moreRows ? [`${moreRows} additional rows omitted by server reply limits`] : [],
    },
    nodes: drawnNodes, edges: drawnEdges,
    omittedNodes: nodes.size - drawnNodes.length, omittedEdges: edges.size - drawnEdges.length,
    incomplete, statistics: stats ? stats.v.map(replyText) : ['Statistics omitted by server reply limits; narrow the query.'],
  };
}

/** Stable concentric rings: linear work, no physics loop, randomness, requests or data-derived styles. */
export function graphLayout(nodes: readonly GraphNode[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const ordered = nodes.slice(0, MAX_GRAPH_NODES).sort((a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (ordered.length === 1) { out.set(ordered[0]!.id, { x: 480, y: 320 }); return out; }
  let off = 0;
  for (let ring = 1; off < ordered.length; ring++) {
    const count = Math.min(ring * 16, ordered.length - off);
    const radius = Math.min(260, ring * 42);
    for (let j = 0; j < count; j++) {
      const angle = 2 * Math.PI * j / count - Math.PI / 2;
      out.set(ordered[off + j]!.id, { x: 480 + Math.cos(angle) * radius * 1.5, y: 320 + Math.sin(angle) * radius });
    }
    off += count;
  }
  return out;
}

/** GRAPH.EXPLAIN / PROFILE use four-space indentation, rather than the FT.EXPLAIN brace format. */
export function graphPlan(reply: Reply): PlanNode | undefined {
  if (!list(reply) || !reply.v.every((x) => text(x) !== undefined)) return undefined;
  const root: PlanNode = { label: 'Graph query plan', facts: [], children: [] };
  const stack: { indent: number; node: PlanNode }[] = [{ indent: -1, node: root }];
  for (const raw of reply.v.slice(0, MAX_GRAPH_PLAN_LINES).map(replyText)) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop();
    if (stack.length > MAX_PLAN_DEPTH) {
      stack.at(-1)!.node.children.push({ label: '… deeper plan omitted; see raw reply', facts: [], children: [] });
      break;
    }
    const node: PlanNode = { label: raw.trim().slice(0, 2000), facts: [], children: [] };
    stack.at(-1)!.node.children.push(node);
    stack.push({ indent, node });
  }
  if (reply.more || reply.v.length > MAX_GRAPH_PLAN_LINES) root.children.push({ label: '… plan lines omitted; see raw reply', facts: [], children: [] });
  return root;
}
