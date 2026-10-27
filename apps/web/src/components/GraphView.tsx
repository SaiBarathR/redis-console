/** Offline, deterministic graph diagram. Redis supplies text and IDs, never HTML, URLs, styles or SVG paths. */
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { graphLayout, type GraphViewData } from '../lib/graphReply.ts';
import { visibleText } from '../lib/format.ts';
import { compactReply } from './RichReply.tsx';
import '../styles/graph.css';

const caption = (id: string, labels: string[]) => `#${id}${labels.length ? ` :${labels.join(' :')}` : ''}`;
/** Edges listed for a selected node; the diagram draws at most MAX_GRAPH_EDGES, so this only guards hub nodes. */
const MAX_LISTED_EDGES = 50;
export function GraphView({ view }: { view: GraphViewData }) {
  const arrow = useId();
  const [selected, setSelected] = useState<string>();
  const [focused, setFocused] = useState<string>();
  const [edgeId, setEdgeId] = useState<string>();
  const circles = useRef(new Map<string, SVGCircleElement>());
  const positions = useMemo(() => graphLayout(view.nodes), [view.nodes]);
  const chosen = view.nodes.find((n) => n.id === selected);
  const select = (id: string) => { setSelected((old) => old === id ? undefined : id); setEdgeId(undefined); };
  // Roving tabindex: the diagram is one tab stop (the focused node, else the selected one, else the first).
  const ids = view.nodes.map((n) => n.id);
  const active = ids.includes(focused ?? '') ? focused! : ids.includes(selected ?? '') ? selected! : ids[0];
  const key = (id: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(id); return; }
    const at = ids.indexOf(id);
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? Math.min(at + 1, ids.length - 1)
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? Math.max(at - 1, 0)
      : e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : undefined;
    if (to === undefined) return;
    e.preventDefault();
    setFocused(ids[to]);
    circles.current.get(ids[to]!)?.focus();
  };
  const edges = chosen ? view.edges.filter((e) => e.source === chosen.id || e.target === chosen.id) : [];
  const chosenEdge = edges.find((e) => e.id === edgeId);
  return <section className="graph-view" data-testid="graph-view" aria-label="Graph results">
    <p className="rich-meta" data-testid="graph-count">
      {view.nodes.length} nodes · {view.edges.length} edges drawn
      {view.omittedNodes > 0 && <span className="warn-text">{view.omittedNodes} more nodes not drawn</span>}
      {view.omittedEdges > 0 && <span className="warn-text">{view.omittedEdges} more edges not drawn</span>}
    </p>
    {view.incomplete && <p className="notice warning" role="status">The server reply is incomplete. Counts cover received entities only. Narrow the query with LIMIT.</p>}
    {(view.omittedNodes > 0 || view.omittedEdges > 0) && <p className="muted">Narrow the query with LIMIT or use the raw reply for remaining entities.</p>}
    {view.nodes.some((n) => n.placeholder) && <p className="muted">Dashed nodes are edge endpoints whose properties were not returned.</p>}
    {view.nodes.length > 0 ? <svg className="graph-svg" viewBox="0 0 960 640" role="group" aria-label={`Diagram of ${view.nodes.length} nodes and ${view.edges.length} directed edges`}>
      <defs><marker id={arrow} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path className="graph-arrow" d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
      {view.edges.map((e) => {
        const from = positions.get(e.source)!;
        const to = positions.get(e.target)!;
        const dx = to.x - from.x, dy = to.y - from.y;
        const distance = Math.hypot(dx, dy) || 1;
        const end = { x: to.x - dx / distance * 11, y: to.y - dy / distance * 11 };
        return <g key={e.id} className="graph-edge" data-testid="graph-edge">
          {e.source === e.target
            ? <path d={`M ${from.x} ${from.y - 10} C ${from.x + 50} ${from.y - 65}, ${from.x - 50} ${from.y - 65}, ${from.x - 8} ${from.y - 8}`} markerEnd={`url(#${arrow})`} />
            : <line x1={from.x} y1={from.y} x2={end.x} y2={end.y} markerEnd={`url(#${arrow})`} />}
          <title>{visibleText(`#${e.id} :${e.type} (#${e.source} → #${e.target})`)}</title>
          {view.edges.length <= 30 && <text x={(from.x + to.x) / 2 + 4} y={(from.y + to.y) / 2 - 5}>{visibleText(e.type.slice(0, 40))}</text>}
        </g>;
      })}
      {view.nodes.map((n) => {
        const p = positions.get(n.id)!;
        const name = visibleText(caption(n.id, n.labels));
        return <g key={n.id}>
          <circle cx={p.x} cy={p.y} r={n.id === selected ? 12 : 9} className={`graph-node${n.id === selected ? ' selected' : ''}${n.placeholder ? ' placeholder' : ''}`}
            ref={(el) => { if (el) circles.current.set(n.id, el); else circles.current.delete(n.id); }}
            tabIndex={n.id === active ? 0 : -1} role="button" aria-pressed={n.id === selected} aria-label={name} data-testid="graph-node"
            onClick={() => { setFocused(n.id); select(n.id); }} onFocus={() => setFocused(n.id)} onKeyDown={key(n.id)}>
            <title>{name}</title>
          </circle>
          {(view.nodes.length <= 30 || n.id === selected) && <text className="graph-label" x={p.x + 14} y={p.y + 4}>{name.slice(0, 80)}</text>}
        </g>;
      })}
    </svg> : <p className="muted">No nodes or edges returned. Scalar and property results appear in the table.</p>}
    {chosen && <div className="graph-selection" data-testid="graph-selection" aria-live="polite">
      <strong>{visibleText(caption(chosen.id, chosen.labels))}</strong>
      <pre className="data">{chosen.placeholder ? 'Endpoint only; return this node to see its properties.' : visibleText(compactReply(chosen.properties, 4000))}</pre>
      {edges.length === 0 ? <p className="muted">No relationships drawn for this node.</p> : <>
        <p className="muted">Relationships ({edges.length}{edges.length > MAX_LISTED_EDGES ? `, first ${MAX_LISTED_EDGES} listed` : ''})</p>
        <ul className="graph-edge-list" aria-label="Relationships of the selected node" data-testid="graph-edges">
          {edges.slice(0, MAX_LISTED_EDGES).map((e) => {
            const outgoing = e.source === chosen.id;
            const other = outgoing ? e.target : e.source;
            return <li key={e.id}><button type="button" className="graph-edge-item" data-testid="graph-edge-item" aria-pressed={e.id === edgeId}
              onClick={() => setEdgeId((old) => old === e.id ? undefined : e.id)}>
              {visibleText(`:${e.type.slice(0, 80)} ${outgoing ? 'outgoing to' : 'incoming from'} #${other}${e.source === e.target ? ' (itself)' : ''}`)}
            </button></li>;
          })}
        </ul>
        {chosenEdge && <div className="graph-edge-detail" data-testid="graph-edge-detail">
          <strong>{visibleText(`#${chosenEdge.id} :${chosenEdge.type.slice(0, 80)} (#${chosenEdge.source} → #${chosenEdge.target})`)}</strong>
          <pre className="data">{visibleText(compactReply(chosenEdge.properties, 4000))}</pre>
        </div>}
      </>}
    </div>}
    <ul className="graph-statistics" aria-label="Graph statistics" data-testid="graph-statistics">{view.statistics.map((s, i) => <li key={i} className="data">{visibleText(s)}</li>)}</ul>
  </section>;
}
