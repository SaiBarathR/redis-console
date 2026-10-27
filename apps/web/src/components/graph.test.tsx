import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { binFromString, type Reply } from '@rconsole/shared';
import { graphLayout, graphPlan, graphView, MAX_GRAPH_EDGES, MAX_GRAPH_NODES } from '../lib/graphReply.ts';
import { richKind } from '../lib/richReply.ts';
import { RichReply } from './RichReply.tsx';

const s = (v: string): Reply => ({ t: 'str', v: binFromString(v) });
const int = (v: string | number): Reply => ({ t: 'int', v: String(v) });
const arr = (...v: Reply[]): Reply => ({ t: 'arr', v });
const node = (id: number | string, name = 'Ada') => arr(arr(s('id'), int(id)), arr(s('labels'), arr(s('Person'))), arr(s('properties'), arr(arr(s('name'), s(name)))));
const edge = (id: number, src = 0, dst = 1) => arr(arr(s('id'), int(id)), arr(s('type'), s('KNOWS')), arr(s('src_node'), int(src)), arr(s('dest_node'), int(dst)), arr(s('properties'), arr(arr(s('weight'), int(2)))));
const fixture = (rows: Reply[] = [arr(node(0), edge(0), node(1, 'Bo'))]) => arr(arr(s('a'), s('r'), s('b')), arr(...rows), arr(s('Cached execution: 0'), s('Nodes created: 2')));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('FalkorDB rich results', () => {
  it('parses verbose nodes, edges, properties, scalars, nested paths and statistics; preserves large IDs', () => {
    const reply = fixture([arr(node('9007199254740993'), edge(0), node(1)), arr(node(0), arr(node(0), edge(1)), s('scalar'))]);
    const view = graphView(reply)!;
    expect(view.nodes.map((n) => n.id)).toEqual(['9007199254740993', '1', '0']);
    expect(view.edges).toHaveLength(2);
    expect(view.edges[0]).toMatchObject({ source: '0', target: '1', type: 'KNOWS' });
    expect(view.table.columns).toEqual(['a', 'r', 'b']);
    expect(view.table.rows).toHaveLength(2);
    expect(view.statistics).toContain('Nodes created: 2');
    for (const cmd of ['GRAPH.RO_QUERY', 'graph.query']) expect(richKind([cmd], reply)).toBe('graph');
  });
  it('supports empty results, stats-only writes and scalars, and rejects compact or malformed replies', () => {
    expect(graphView(fixture([]))!.nodes).toEqual([]);
    expect(graphView(arr(arr(s('Nodes created: 1'))))!.statistics).toEqual(['Nodes created: 1']);
    expect(graphView(arr(arr(s('n')), arr(arr(int(42))), arr(s('Cached execution: 0'))))!.table.rows[0]!.fields[0]![1]).toEqual(int(42));
    for (const r of [arr(), arr(arr(arr(int(1), s('n'))), arr(), arr()), arr(s('x')), { t: 'err', v: 'ERR' } as Reply]) expect(graphView(r)).toBeUndefined();
    const duplicate = graphView(arr(arr(s('x'), s('x'), s('x [2]')), arr(arr(int(1), int(2), int(3))), arr()))!;
    expect(new Set(duplicate.table.columns).size).toBe(3);
  });
  it('caps unique entities, counts deduplicated omissions, supplies edge-only placeholders and detects truncation', () => {
    const many = fixture(Array.from({ length: 550 }, (_, i) => arr(node(i % 250), edge(i, i % 250, (i + 1) % 250), node((i + 1) % 250))));
    const view = graphView(many)!;
    expect(view.nodes).toHaveLength(MAX_GRAPH_NODES);
    expect(view.omittedNodes).toBe(50);
    expect(view.edges.length).toBeLessThanOrEqual(MAX_GRAPH_EDGES);
    expect(view.omittedEdges + view.edges.length).toBe(550);
    const edgeOnly = graphView(fixture([arr(edge(0, 4, 8))]))!;
    expect(edgeOnly.nodes.every((n) => n.placeholder)).toBe(true);
    const cut = fixture();
    if (cut.t === 'arr' && cut.v[1]?.t === 'arr') cut.v[1].more = 7;
    expect(graphView(cut)!.incomplete).toBe(true);
    expect(graphView(cut)!.table.omittedRows).toBe(7);
    const partial: Reply = { t: 'arr', v: [arr(s('n')), arr(arr(node(0)))], more: 1 };
    expect(graphView(partial)!.incomplete).toBe(true);
    expect(graphView(partial)!.statistics[0]).toContain('Statistics omitted');
  });
  it('lays out deterministically within bounds, independently of incoming order, including empty and singleton graphs', () => {
    const ns = graphView(fixture(Array.from({ length: 250 }, (_, i) => arr(node(i)))))!.nodes;
    const positions = graphLayout(ns);
    expect(positions).toEqual(graphLayout([...ns].reverse()));
    expect(positions.size).toBe(MAX_GRAPH_NODES);
    for (const p of positions.values()) { expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(960); expect(p.y).toBeGreaterThan(0); expect(p.y).toBeLessThan(640); }
    expect(graphLayout([]).size).toBe(0);
    expect(graphLayout(ns.slice(0, 1)).get('0')).toEqual({ x: 480, y: 320 });
  });
  it('renders hostile data as text, with keyboard selection, properties, statistics, table and no fetch', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const hostile = '<img src=x onerror="alert(1)">';
    const { container } = render(<RichReply kind="graph" reply={fixture([arr(node(0, hostile), edge(0), node(1))])} />);
    expect(screen.getByTestId('graph-count')).toHaveTextContent('2 nodes · 1 edges drawn');
    expect(screen.getByRole('table', { name: 'Graph result table' })).toHaveTextContent(hostile);
    expect(screen.getByTestId('graph-statistics')).toHaveTextContent('Nodes created: 2');
    const n = screen.getAllByTestId('graph-node')[0]!;
    n.focus(); await userEvent.keyboard('{Enter}');
    expect(n).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('graph-selection')).toHaveTextContent(hostile);
    expect(container.querySelector('img,script,foreignObject,[style]')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('renders bounded indentation plans for EXPLAIN and mutating PROFILE', () => {
    const r = arr(s('Project'), s('    Conditional Traverse | (a)-[r]->(b)'), s('        All Node Scan | (a)'), s('    Filter | <svg onload=alert(1)>'));
    const plan = graphPlan(r)!;
    expect(plan.children[0]!.children).toHaveLength(2);
    expect(plan.children[0]!.children[0]!.children).toHaveLength(1);
    expect(richKind(['GRAPH.EXPLAIN'], r)).toBe('graphPlan');
    expect(richKind(['GRAPH.PROFILE'], r)).toBe('graphPlan');
    const { container } = render(<RichReply kind="graphPlan" reply={r} />);
    expect(within(screen.getByTestId('plan-tree')).getByText('Filter | <svg onload=alert(1)>')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
    const deep = graphPlan(arr(...Array.from({ length: 90 }, (_, i) => s(' '.repeat(i * 4) + 'scan'))))!;
    expect(JSON.stringify(deep)).toContain('deeper plan omitted');
    expect(JSON.stringify(graphPlan(arr(...Array.from({ length: 1001 }, () => s('scan')))))).toContain('plan lines omitted');
  });
});
