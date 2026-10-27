/** Offline, deterministic graph diagram. Redis supplies text and IDs, never HTML, URLs, styles or SVG paths. */
import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { graphLayout, type GraphViewData } from '../lib/graphReply.ts';
import { visibleText } from '../lib/format.ts';
import { compactReply } from './RichReply.tsx';
import '../styles/graph.css';

const caption = (id: string, labels: string[]) => `#${id}${labels.length ? ` :${labels.join(' :')}` : ''}`;
export function GraphView({ view }: { view: GraphViewData }) {
  const arrow = useId();
  const [selected, setSelected] = useState<string>();
  const positions = useMemo(() => graphLayout(view.nodes), [view.nodes]);
  const chosen = view.nodes.find((n) => n.id === selected);
  const select = (id: string) => setSelected((old) => old === id ? undefined : id);
  const key = (id: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(id); }
  };
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
            tabIndex={0} role="button" aria-pressed={n.id === selected} aria-label={name} data-testid="graph-node" onClick={() => select(n.id)} onKeyDown={key(n.id)}>
            <title>{name}</title>
          </circle>
          {(view.nodes.length <= 30 || n.id === selected) && <text className="graph-label" x={p.x + 14} y={p.y + 4}>{name.slice(0, 80)}</text>}
        </g>;
      })}
    </svg> : <p className="muted">No nodes or edges returned. Scalar and property results appear in the table.</p>}
    {chosen && <div className="graph-selection" data-testid="graph-selection" aria-live="polite">
      <strong>{visibleText(caption(chosen.id, chosen.labels))}</strong>
      <pre className="data">{chosen.placeholder ? 'Endpoint only; return this node to see its properties.' : visibleText(compactReply(chosen.properties, 4000))}</pre>
    </div>}
    <ul className="graph-statistics" aria-label="Graph statistics" data-testid="graph-statistics">{view.statistics.map((s, i) => <li key={i} className="data">{visibleText(s)}</li>)}</ul>
  </section>;
}
