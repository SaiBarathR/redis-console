/**
 * Built-in, command-aware result views for the console and workbench (v0.2.1, RI parity F11): a table for
 * FT.SEARCH / FT.AGGREGATE, a chart for TS.RANGE / TS.MRANGE, a plan tree for FT.EXPLAIN / FT.PROFILE.
 * Trusted code only (no plugins); every value is rendered as text, never HTML.
 */
import type { Bin, Reply } from "@rconsole/shared";
import {
  MAX_COLUMNS,
  MAX_ROWS,
  MAX_SERIES,
  aggregateTable,
  explainPlan,
  geoView,
  multiSeriesOf,
  profileView,
  replyText,
  searchTable,
  seriesOf,
  type PlanNode,
  type RichKind,
  type RichTable,
  type Series,
} from "../lib/richReply.ts";
import { displayBin, visibleText } from "../lib/format.ts";
import { Chart } from "./Chart.tsx";
import { GeoMap } from "./GeoMap.tsx";
import { KeyName } from "./anatomy.tsx";
import "../styles/insight.css";

const CELL_CHARS = 300;

/** A reply as compact one-line text (nested arrays and maps in JSON-like brackets), capped. */
export function compactReply(r: Reply, budget = CELL_CHARS): string {
  let out = "";
  const add = (s: string) => {
    if (out.length < budget) out += s;
  };
  const walk = (x: Reply, depth: number) => {
    if (out.length >= budget) return;
    if (depth > 6) return add("…");
    if (x.t === "str") return add(displayBin(x.v, budget));
    if (x.t === "arr" || x.t === "set") {
      add("[");
      x.v.forEach((c, i) => {
        if (i) add(", ");
        walk(c, depth + 1);
      });
      if (x.more) add(", …");
      return add("]");
    }
    if (x.t === "map") {
      add("{");
      x.v.forEach(([k, v], i) => {
        if (i) add(", ");
        walk(k, depth + 1);
        add(": ");
        walk(v, depth + 1);
      });
      return add("}");
    }
    add(replyText(x));
  };
  walk(r, 0);
  return out.length > budget ? `${out.slice(0, budget)}…` : out;
}

/**
 * A persistent notice that a bounded view leaves part of the reply out (review v0.2.1 web M2). The bounds stay;
 * the notice says what is missing and offers the raw reply, which is complete.
 */
function LimitNotice({ parts, narrow, onRaw }: { parts: string[]; narrow: string; onRaw?: () => void }) {
  if (!parts.length) return null;
  return (
    <p className="notice warning rich-limit" role="status" data-testid="rich-limit">
      <span>
        Showing {parts.join(" and ")}. {narrow}
      </span>
      {onRaw && (
        <button type="button" className="ghost" onClick={onRaw} data-testid="rich-limit-raw">
          Show the raw reply
        </button>
      )}
    </p>
  );
}

function tableLimits(table: RichTable): string[] {
  const parts: string[] = [];
  if (table.omittedRows > 0) parts.push(`${MAX_ROWS.toLocaleString()} of ${(MAX_ROWS + table.omittedRows).toLocaleString()} rows`);
  if (table.omittedColumns > 0) parts.push(`${MAX_COLUMNS} of ${MAX_COLUMNS + table.omittedColumns} columns`);
  return parts;
}

function Cell({ value }: { value: Reply | undefined }) {
  if (!value) return <span className="muted">—</span>;
  const text = compactReply(value);
  return <span className="data rich-cell">{visibleText(text)}</span>;
}

export function RichTableView({
  table,
  onOpen,
  onRaw,
  label,
}: {
  table: RichTable;
  onOpen?: (key: Bin) => void;
  onRaw?: () => void;
  label: string;
}) {
  const ids = table.rows.some((r) => r.id);
  const scores = table.rows.some((r) => r.score !== undefined);
  return (
    <div className="rich-table" data-testid="rich-table">
      <LimitNotice parts={tableLimits(table)} narrow="Narrow the query (LIMIT, RETURN or LOAD fewer fields) to see the rest here." onRaw={onRaw} />
      <p className="rich-meta">
        {table.total !== undefined && (
          <span>
            {table.total.toLocaleString()} {table.total === 1 ? "match" : "matches"}
          </span>
        )}
        <span>
          {table.rows.length.toLocaleString()} {table.rows.length === 1 ? "row" : "rows"} shown
        </span>
        {table.cursor !== undefined && <span>cursor {visibleText(table.cursor)}</span>}
        {table.warnings.map((w, i) => (
          <span key={i} className="warn-text">
            {visibleText(w)}
          </span>
        ))}
      </p>
      {table.rows.length ? (
        <div className="table-wrap dense rich-scroll">
          <table aria-label={label}>
            <thead>
              <tr>
                {ids && <th>Document</th>}
                {scores && <th className="num">Score</th>}
                {table.columns.map((c) => (
                  <th key={c}>
                    <span className="data">{visibleText(c)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => {
                const fields = new Map(row.fields);
                return (
                  <tr key={i}>
                    {ids && (
                      <td>
                        {row.id ? (
                          onOpen ? (
                            <button
                              type="button"
                              className="key-link data"
                              aria-label={`Open key ${displayBin(row.id, 200)}`}
                              title="Open in the key browser"
                              onClick={() => onOpen(row.id!)}
                            >
                              <KeyName name={row.id} limit={200} />
                            </button>
                          ) : (
                            <KeyName name={row.id} limit={200} />
                          )
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    )}
                    {scores && <td className="num tabular">{visibleText(row.score ?? "")}</td>}
                    {table.columns.map((c) => (
                      <td key={c}>
                        <Cell value={fields.get(c)} />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No rows.</p>
      )}
    </div>
  );
}

function SeriesBlock({ series, single }: { series: Series; single: boolean }) {
  const values = series.samples.map(([, v]) => v);
  return (
    <section className="rich-series" aria-label={`Series ${series.name}`}>
      {!single && (
        <h4 className="data">
          {visibleText(series.name)}
          {series.labels.length > 0 && (
            <span className="muted">
              {" "}
              {series.labels.map(([k, v]) => `${k}=${v}`).join(" · ")}
            </span>
          )}
        </h4>
      )}
      <p className="rich-meta">
        <span>
          {series.samples.length.toLocaleString()} {series.samples.length === 1 ? "sample" : "samples"}
        </span>
        {values.length > 0 && (
          <>
            <span>min {Math.min(...values).toLocaleString()}</span>
            <span>max {Math.max(...values).toLocaleString()}</span>
            <span>last {values.at(-1)!.toLocaleString()}</span>
          </>
        )}
        {series.dropped > 0 && <span className="warn-text">{series.dropped} non-numeric values not drawn</span>}
      </p>
      <Chart
        label={single ? "TimeSeries range" : `TimeSeries ${series.name}`}
        color="--type-timeseries"
        samples={series.samples}
        height={140}
        waiting="Fewer than two samples: nothing to draw. Widen the range."
      />
    </section>
  );
}

export function PlanTree({ node, root = true }: { node: PlanNode; root?: boolean }) {
  const body = (
    <>
      <span className="plan-label data">{visibleText(node.label)}</span>
      {node.facts.length > 0 && (
        <span className="plan-facts">
          {node.facts.map(([k, v]) => (
            <span key={k}>
              <span className="muted">{visibleText(k)}</span> {visibleText(v)}
            </span>
          ))}
        </span>
      )}
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c, i) => (
            <PlanTree key={i} node={c} root={false} />
          ))}
        </ul>
      )}
    </>
  );
  return root ? (
    <ul className="plan-tree" data-testid="plan-tree">
      <li>{body}</li>
    </ul>
  ) : (
    <li>{body}</li>
  );
}

/** The rich view of one reply; `kind` comes from `richKind(argv, reply)`. */
export function RichReply({
  kind,
  reply,
  argv = [],
  onOpen,
  onRaw,
}: {
  kind: RichKind;
  reply: Reply;
  /** The command that ran (geo views read its flags and GEOPOS member names). */
  argv?: readonly string[];
  onOpen?: (key: Bin) => void;
  /** Switches the result to the raw reply view; offered when a bounded view leaves something out. */
  onRaw?: () => void;
}) {
  if (kind === "search" || kind === "aggregate") {
    const t = kind === "search" ? searchTable(reply) : aggregateTable(reply);
    return t ? (
      <div data-testid="result-rich" data-kind={kind}>
        <RichTableView table={t} onOpen={onOpen} onRaw={onRaw} label={kind === "search" ? "Search results" : "Aggregation results"} />
      </div>
    ) : null;
  }
  if (kind === "series" || kind === "multiSeries") {
    const set = kind === "series" ? undefined : multiSeriesOf(reply);
    const list = kind === "series" ? [seriesOf(reply)!].filter(Boolean) : (set?.series ?? []);
    const omitted = set ? set.total - set.series.length : 0;
    return (
      <div data-testid="result-rich" data-kind={kind} className="rich-series-list">
        <LimitNotice
          parts={omitted > 0 ? [`${MAX_SERIES} of ${set!.total.toLocaleString()} series`] : []}
          narrow={`${omitted.toLocaleString()} not drawn. Narrow the FILTER to chart them.`}
          onRaw={onRaw}
        />
        {list.length ? list.map((s, i) => <SeriesBlock key={i} series={s} single={kind === "series"} />) : <p className="muted">No series matched.</p>}
      </div>
    );
  }
  if (kind === "geo") {
    const view = geoView(argv, reply);
    return view ? (
      <div data-testid="result-rich" data-kind={kind}>
        <GeoMap view={view} />
      </div>
    ) : null;
  }
  if (kind === "explain") {
    const plan = explainPlan(reply);
    return plan ? (
      <div data-testid="result-rich" data-kind={kind}>
        <PlanTree node={plan} />
      </div>
    ) : null;
  }
  const p = profileView(reply);
  if (!p) return null;
  return (
    <div data-testid="result-rich" data-kind={kind} className="rich-profile">
      {p.results && <RichTableView table={p.results} onOpen={onOpen} onRaw={onRaw} label="Profiled results" />}
      {p.shards.map((s, i) => (
        <section key={i} className="rich-shard" aria-label={s.name}>
          <h4>{s.name}</h4>
          {s.facts.length > 0 && (
            <dl className="facts">
              {s.facts.map(([k, v]) => (
                <div key={k} className="fact-pair">
                  <dt>{visibleText(k)}</dt>
                  <dd className="data">{visibleText(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          {s.iterators && (
            <>
              <h5>Iterators</h5>
              <PlanTree node={s.iterators} />
            </>
          )}
          {s.processors.length > 0 && (
            <>
              <h5>Result processors</h5>
              <ol className="plan-steps">
                {s.processors.map((n, j) => (
                  <li key={j}>
                    <span className="plan-label data">{visibleText(n.label)}</span>{" "}
                    <span className="plan-facts">
                      {n.facts.map(([k, v]) => (
                        <span key={k}>
                          <span className="muted">{visibleText(k)}</span> {visibleText(v)}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      ))}
    </div>
  );
}
