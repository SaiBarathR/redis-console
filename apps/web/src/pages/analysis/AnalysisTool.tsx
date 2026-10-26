import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { AnalysisJob, AnalysisRecommendation, AnalysisReport, Bin } from "@rconsole/shared";
import { useDatabase } from "../../lib/context.tsx";
import { dbPath, post, request } from "../../lib/api.ts";
import { bytesLabel, displayBin, visibleText } from "../../lib/format.ts";
import { useMemorySlot } from "../../lib/memory.tsx";
import { DataTable, Empty, ErrorState, Field, Readout } from "../../components/ui.tsx";
import { KeyName, TtlFuse, TypeGlyph, typeInfo } from "../../components/anatomy.tsx";
import { ShareBar, ToolHead, percent } from "../../components/toolChrome.tsx";
import { hasSearchModule } from "../../components/MakeSearchable.tsx";
import { searchSlots, type WizardHandoff } from "../search/state.ts";
import "../../styles/insight.css";

interface Params {
  match: string;
  sampleSize: number;
  delimiter: string;
}
export interface StoredReport {
  id: string;
  at: number;
  params: Params;
  report: AnalysisReport;
}
/** Reports kept for comparison in this tab's memory (never device storage). */
export const MAX_REPORTS = 10;
const POLL_MS = 500;

const STOPPED: Record<string, string> = {
  complete: "the scan covered every matching key",
  sampleLimit: "sampling stopped at the sample limit",
  timeLimit: "sampling stopped at the server's time limit",
  cancelled: "the analysis was cancelled",
};

/** "Based on 2,000 of 8,000 keys (25%); sampling stopped at the sample limit." */
export function coverageText(r: AnalysisReport): string {
  const c = r.coverage;
  const base = `Based on ${r.sampled.toLocaleString()} sampled ${r.sampled === 1 ? "key" : "keys"} of ${r.dbSize.toLocaleString()} in the database (${percent(r.sampled, r.dbSize)})`;
  return c ? `${base}; ${STOPPED[c.stoppedBy] ?? c.stoppedBy}.` : `${base}.`;
}

const reportLabel = (s: StoredReport) =>
  `${new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · ${s.params.match} · ${s.report.sampled.toLocaleString()} keys${s.report.coverage?.stoppedBy === "cancelled" ? " · partial" : ""}`;

export function Analysis() {
  const db = useDatabase();
  const [params, setParams] = useMemorySlot<Params>(`${db.id}:analysis:form`, { match: "*", sampleSize: 10000, delimiter: ":" });
  const [reports, setReports] = useMemorySlot<StoredReport[]>(`${db.id}:analysis:reports`, []);
  const [currentId, setCurrentId] = useMemorySlot<string>(`${db.id}:analysis:current`, "");
  const [compareId, setCompareId] = useState("");
  // The running job (id and the parameters it runs with), in session memory so polling resumes after navigation.
  const [runningJob, setRunningJob] = useMemorySlot<{ id: string; params: Params } | undefined>(`${db.id}:analysis:job`, undefined);
  const jobId = runningJob?.id ?? "";
  const [job, setJob] = useState<AnalysisJob>();
  const [error, setError] = useState<unknown>();
  const [starting, setStarting] = useState(false);
  const current = reports.find((r) => r.id === currentId) ?? reports[0];
  const other = reports.find((r) => r.id === compareId && r.id !== current?.id);

  // Poll the running job (also after navigating away and back: its id is in session memory).
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try {
        const j = await request<AnalysisJob>(dbPath(db.id, `/analysis/jobs/${encodeURIComponent(jobId)}`), { background: true });
        if (stop) return;
        setJob(j);
        if (j.state === "running") {
          timer = setTimeout(tick, POLL_MS);
          return;
        }
        const ran = runningJob?.params ?? params;
        setRunningJob(undefined);
        if (j.report) {
          const stored: StoredReport = { id: j.id, at: Date.now(), params: ran, report: j.report };
          setReports((rs) => [stored, ...rs.filter((r) => r.id !== j.id)].slice(0, MAX_REPORTS));
          setCurrentId(j.id);
        }
        if (j.state === "failed" && j.error) setError(new Error(j.error.message));
      } catch (e) {
        if (stop) return;
        setRunningJob(undefined);
        setError(e);
      }
    };
    let timer = setTimeout(tick, 50);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [jobId, db.id]);

  const start = async () => {
    setError(undefined);
    setStarting(true);
    try {
      const j = await post<AnalysisJob>(dbPath(db.id, "/analysis/jobs"), params);
      setJob(j);
      setRunningJob({ id: j.id, params: { ...params } });
    } catch (e) {
      setError(e);
    } finally {
      setStarting(false);
    }
  };
  const running = !!jobId;
  const p = job?.progress;
  return (
    <>
      <ToolHead title="Memory analysis" meta="A bounded sample with recommendations. The server caps keys and time." />
      <div className="pane-body">
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!running) void start();
          }}
        >
          <Field label="Key pattern">
            <input
              className="data"
              value={params.match}
              onChange={(e) => setParams({ ...params, match: e.target.value })}
              maxLength={512}
              data-testid="analysis-pattern"
            />
          </Field>
          <Field label="Sample limit">
            <input
              type="number"
              min={100}
              max={100000}
              required
              value={params.sampleSize}
              onChange={(e) => setParams({ ...params, sampleSize: Number(e.target.value) })}
              data-testid="analysis-sample"
            />
          </Field>
          <Field label="Namespace delimiter">
            <input className="data narrow" maxLength={4} value={params.delimiter} onChange={(e) => setParams({ ...params, delimiter: e.target.value })} />
          </Field>
          <div className="actions">
            <button type="submit" className="primary" disabled={running || starting} data-testid="analysis-run">
              {running ? "Analyzing…" : "Analyze memory"}
            </button>
          </div>
        </form>
        {running && p && (
          <div className="progress-row" role="status" data-testid="analysis-progress">
            <span className="progress-bar" aria-hidden="true">
              <span style={{ transform: `scaleX(${Math.min(1, p.target ? p.sampled / p.target : 0)})` }} />
            </span>
            <span>
              {p.sampled.toLocaleString()} of {p.target.toLocaleString()} keys sampled
              {p.dbSize ? ` · ${p.dbSize.toLocaleString()} in the database` : ""} · {(p.elapsedMs / 1000).toFixed(1)} s of{" "}
              {(p.maxMs / 1000).toFixed(0)} s
            </span>
            <button
              type="button"
              className="ghost"
              data-testid="analysis-cancel"
              onClick={() => {
                void post<AnalysisJob>(dbPath(db.id, `/analysis/jobs/${encodeURIComponent(jobId)}/cancel`), {}).catch(setError);
              }}
            >
              Cancel
            </button>
          </div>
        )}
        <ErrorState error={error} />
        {reports.length > 0 && (
          <div className="report-history" data-testid="analysis-history">
            <Field label={`Report (${reports.length} in this tab)`}>
              <select value={current?.id ?? ""} onChange={(e) => setCurrentId(e.target.value)} data-testid="analysis-report-select">
                {reports.map((r) => (
                  <option key={r.id} value={r.id}>
                    {visibleText(reportLabel(r))}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Compare with">
              <select value={other?.id ?? ""} onChange={(e) => setCompareId(e.target.value)} disabled={reports.length < 2} data-testid="analysis-compare">
                <option value="">No comparison</option>
                {reports
                  .filter((r) => r.id !== current?.id)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {visibleText(reportLabel(r))}
                    </option>
                  ))}
              </select>
            </Field>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setReports([]);
                setCurrentId("");
                setCompareId("");
              }}
            >
              Clear reports
            </button>
          </div>
        )}
        {!current && !running && (
          <Empty compact title="No analysis yet.">
            Choose a pattern and run the analysis. It samples keys with <code>SCAN</code>, reads each size with <code>MEMORY USAGE</code>, and
            turns what it finds into recommendations. Reports stay in this tab's memory so you can compare runs.
          </Empty>
        )}
        {current && other && <Comparison a={other} b={current} />}
        {current && <Report stored={current} />}
      </div>
    </>
  );
}

function Recommendation({ rec, delimiter }: { rec: AnalysisRecommendation; delimiter: string }) {
  const db = useDatabase();
  const navigate = useNavigate();
  const [, setSelectedKey] = useMemorySlot<Bin | undefined>(`${db.id}:selected-key`, undefined);
  const [, setHandoff] = useMemorySlot<WizardHandoff | undefined>(searchSlots(db.id).handoff, undefined);
  const jsonModule = !!db.server?.modules.some((m) => /rejson|json/i.test(m.name));
  return (
    <li className="recommendation" data-severity={rec.severity} data-testid="analysis-recommendation" data-rule={rec.id}>
      <header>
        <span className={`severity ${rec.severity}`}>{rec.severity === "high" ? "High" : rec.severity === "medium" ? "Medium" : "Low"}</span>
        <h3>{visibleText(rec.title)}</h3>
        <span className="basis">
          {rec.affected.toLocaleString()} of {rec.basis.toLocaleString()} {rec.id === "stringJsonCouldBeRedisJson" ? "checked strings" : "sampled keys"} ({percent(rec.affected, rec.basis)})
        </span>
      </header>
      <p>{visibleText(rec.detail)}</p>
      <p className="next">
        <strong>Next step:</strong> {visibleText(rec.action)}
        {rec.module === "json" && !jsonModule && " RedisJSON is not loaded on this database, so a hash is the option here."}
      </p>
      {rec.at !== undefined && <p className="muted">Window starts {new Date(rec.at).toLocaleString()}.</p>}
      {rec.prefixes && rec.prefixes.length > 0 && rec.id !== "searchableNamespace" && (
        <ul className="rec-keys" aria-label="Namespaces">
          {rec.prefixes.slice(0, 8).map((p) => (
            <li key={p.prefix}>
              <code className="data">{visibleText(p.prefix)}</code>{" "}
              <span className="muted">
                {p.noExpiry !== undefined ? `${p.noExpiry.toLocaleString()} of ${p.keys.toLocaleString()} without TTL` : `${p.keys.toLocaleString()} keys`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rec.keys.length > 0 && (
        <ul className="rec-keys" aria-label="Example keys">
          {rec.keys.slice(0, 6).map((k, i) => (
            <li key={i}>
              <button
                type="button"
                className="key-link data"
                aria-label={`Open key ${displayBin(k.key, 200)}`}
                title="Open in the key browser"
                onClick={() => {
                  setSelectedKey(k.key);
                  navigate(`/db/${encodeURIComponent(db.id)}/keys`);
                }}
              >
                <KeyName name={k.key} delimiter={delimiter} limit={160} />
              </button>{" "}
              <span className="muted">
                {k.length !== undefined && k.type !== "string"
                  ? `${k.length.toLocaleString()} elements`
                  : k.bytes !== undefined
                    ? `${bytesLabel(k.bytes)} in memory`
                    : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rec.search && hasSearchModule(db) && (
        <p className="actions">
          <button
            type="button"
            data-testid="analysis-make-searchable"
            onClick={() => {
              setHandoff({ on: rec.search!.on, prefix: rec.search!.prefix, prefixes: [] });
              navigate(`/db/${encodeURIComponent(db.id)}/diagnostics/search?panel=create`);
            }}
          >
            Make searchable…
          </button>
        </p>
      )}
    </li>
  );
}

function Report({ stored }: { stored: StoredReport }) {
  const db = useDatabase();
  const report = stored.report;
  const delimiter = stored.params.delimiter;
  const readAt = stored.at;
  const recs = (report.recommendations ?? []).filter((r) => !r.module || r.module !== "search" || hasSearchModule(db));
  const ttlRows = (
    [
      ["noExpiry", "No expiry"],
      ["lt1h", "Under 1 hour"],
      ["lt1d", "1 hour to 1 day"],
      ["lt7d", "1 to 7 days"],
      ["gt7d", "7 days or longer"],
    ] as const
  ).map(([id, label]) => ({ id, label, count: report.ttl[id] }));
  const maxPrefix = Math.max(1, ...report.prefixes.map((p) => p.bytes));
  return (
    <div data-testid="analysis-report" className="analysis-report">
      <p className="coverage-note" data-testid="analysis-coverage">
        {coverageText(report)} Pattern <code className="data">{visibleText(stored.params.match)}</code>.
      </p>
      <div className="readouts">
        <Readout label="Sampled keys" value={report.sampled.toLocaleString()} sub={`of ${report.dbSize.toLocaleString()} keys · ${percent(report.sampled, report.dbSize)}`} />
        <Readout label="Sample memory" value={bytesLabel(report.totalSampledBytes)} sub="Sampled keys only" />
        <Readout label="Average key" value={bytesLabel(report.sampled ? Math.round(report.totalSampledBytes / report.sampled) : 0)} sub="Memory per sampled key" />
        <Readout label="No expiry" value={percent(report.ttl.noExpiry, report.sampled)} sub={`${report.ttl.noExpiry.toLocaleString()} keys persist`} />
        <Readout label="Analysis time" value={report.durationMs.toFixed(0)} unit="ms" sub="Bounded scan" />
      </div>
      <section className="section">
        <header>
          <h2>Recommendations</h2>
          <span className="meta">rules over this sample, not the whole database</span>
        </header>
        {recs.length ? (
          <ul className="recommendations" data-testid="analysis-recommendations">
            {recs.map((r, i) => (
              <Recommendation key={`${r.id}-${i}`} rec={r} delimiter={delimiter} />
            ))}
          </ul>
        ) : (
          <Empty compact>
            {report.recommendations ? "No rule found anything to recommend in this sample." : "This server does not send recommendations."}
          </Empty>
        )}
      </section>
      <div className="grid-2">
        <section className="section">
          <header>
            <h2>Memory by type</h2>
            <span className="meta">share of sampled memory</span>
          </header>
          <table className="bar-table">
            <thead>
              <tr>
                <th>Type</th>
                <th className="num">Keys</th>
                <th className="num">Memory</th>
                <th className="bar-col">
                  <span className="sr-only">Share</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {report.byType.map((row) => (
                <tr key={row.type}>
                  <td>
                    <TypeGlyph type={row.type} wide />
                  </td>
                  <td className="num">{row.keys.toLocaleString()}</td>
                  <td className="num">{bytesLabel(row.bytes)}</td>
                  <td className="bar-col">
                    <ShareBar share={row.bytes / (report.totalSampledBytes || 1)} family={typeInfo(row.type).family} label={percent(row.bytes, report.totalSampledBytes)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="section">
          <header>
            <h2>Time to expiry</h2>
            <span className="meta">share of sampled keys</span>
          </header>
          <table className="bar-table">
            <thead>
              <tr>
                <th>Expires</th>
                <th className="num">Keys</th>
                <th className="bar-col">
                  <span className="sr-only">Share</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ttlRows.map((row) => (
                <tr key={row.id}>
                  <td>{row.label}</td>
                  <td className="num">{row.count.toLocaleString()}</td>
                  <td className="bar-col">
                    <ShareBar share={row.count / (report.sampled || 1)} label={percent(row.count, report.sampled)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      <section className="section">
        <header>
          <h2>Largest keys</h2>
          <span className="meta">by MEMORY USAGE</span>
        </header>
        <DataTable
          className="dense"
          columns={["Type", "Key", <span className="num">Memory</span>, "Expiry"]}
          rows={report.topKeysBySize.map((row) => [
            <TypeGlyph type={row.type} />,
            <KeyName name={row.key} delimiter={delimiter} limit={500} />,
            <span className="num tabular">{bytesLabel(row.bytes)}</span>,
            <TtlFuse ttl={row.ttl} readAt={readAt} />,
          ])}
          empty="No keys matched the pattern in this sample."
        />
      </section>
      <section className="section">
        <header>
          <h2>Longest collections</h2>
          <span className="meta">elements per key</span>
        </header>
        <DataTable
          className="dense"
          columns={["Type", "Key", <span className="num">Length</span>]}
          rows={report.topKeysByLength.map((row) => [
            <TypeGlyph type={row.type} />,
            <KeyName name={row.key} delimiter={delimiter} limit={500} />,
            <span className="num tabular">{row.length.toLocaleString()}</span>,
          ])}
          empty="No collections in this sample."
        />
      </section>
      <section className="section">
        <header>
          <h2>Namespaces</h2>
          <span className="meta">first segment before “{visibleText(delimiter)}”</span>
        </header>
        <table className="bar-table">
          <thead>
            <tr>
              <th>Prefix</th>
              <th className="num">Keys</th>
              <th className="num">Memory</th>
              <th className="bar-col">
                <span className="sr-only">Share</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {report.prefixes.map((row) => (
              <tr key={row.prefix}>
                <td>
                  <code className="data">{visibleText(row.prefix)}</code>
                </td>
                <td className="num">{row.keys.toLocaleString()}</td>
                <td className="num">{bytesLabel(row.bytes)}</td>
                <td className="bar-col">
                  <ShareBar share={row.bytes / maxPrefix} label={percent(row.bytes, report.totalSampledBytes)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!report.prefixes.length && <Empty compact>No namespaces in this sample.</Empty>}
      </section>
    </div>
  );
}

const signed = (n: number, fmt: (x: number) => string = (x) => x.toLocaleString()) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : "±0");
function Delta({ n, fmt }: { n: number; fmt?: (x: number) => string }) {
  return <span className={`delta tabular ${n > 0 ? "up" : n < 0 ? "down" : ""}`.trim()}>{signed(n, fmt)}</span>;
}

/** Compare two session reports (older `a`, newer `b`): totals, types, namespaces and recommendations. */
export function Comparison({ a, b }: { a: StoredReport; b: StoredReport }) {
  const ra = a.report, rb = b.report;
  const sameParams = a.params.match === b.params.match && a.params.delimiter === b.params.delimiter;
  const types = [...new Set([...ra.byType.map((t) => t.type), ...rb.byType.map((t) => t.type)])];
  const typeOf = (r: AnalysisReport, t: string) => r.byType.find((x) => x.type === t) ?? { keys: 0, bytes: 0 };
  const prefixes = [...new Set([...ra.prefixes.slice(0, 20).map((p) => p.prefix), ...rb.prefixes.slice(0, 20).map((p) => p.prefix)])];
  const prefixOf = (r: AnalysisReport, p: string) => r.prefixes.find((x) => x.prefix === p) ?? { keys: 0, bytes: 0 };
  const ids = (r: AnalysisReport) => new Set((r.recommendations ?? []).map((x) => x.id));
  const before = ids(ra), after = ids(rb);
  const added = [...after].filter((x) => !before.has(x));
  const resolved = [...before].filter((x) => !after.has(x));
  const avg = (r: AnalysisReport) => (r.sampled ? r.totalSampledBytes / r.sampled : 0);
  return (
    <section className="section" data-testid="analysis-comparison" aria-label="Report comparison">
      <header>
        <h2>Comparison</h2>
        <span className="meta">
          {visibleText(reportLabel(a))} → {visibleText(reportLabel(b))}
        </span>
      </header>
      {!sameParams && <p className="notice warning">The reports used different patterns or delimiters, so their numbers are not directly comparable.</p>}
      <p className="coverage-note">
        Both are samples: differences can come from sampling as well as from changes in the data. Before: {coverageText(ra)} After: {coverageText(rb)}
      </p>
      <DataTable
        className="dense"
        columns={["Measure", <span className="num">Before</span>, <span className="num">After</span>, <span className="num">Change</span>]}
        rows={[
          ["Keys in the database", ra.dbSize, rb.dbSize, (x: number) => x.toLocaleString()],
          ["Sampled keys", ra.sampled, rb.sampled, (x: number) => x.toLocaleString()],
          ["Sample memory", ra.totalSampledBytes, rb.totalSampledBytes, bytesLabel],
          ["Average key", Math.round(avg(ra)), Math.round(avg(rb)), bytesLabel],
          ["Keys without expiry", ra.ttl.noExpiry, rb.ttl.noExpiry, (x: number) => x.toLocaleString()],
        ].map(([label, x, y, f]) => {
          const fmt = f as (n: number) => string;
          return [label as string, <span className="num tabular">{fmt(x as number)}</span>, <span className="num tabular">{fmt(y as number)}</span>, <span className="num"><Delta n={(y as number) - (x as number)} fmt={fmt} /></span>];
        })}
      />
      <div className="grid-2">
        <DataTable
          className="dense"
          columns={["Type", <span className="num">Keys</span>, <span className="num">Memory</span>]}
          rows={types.map((t) => [
            <TypeGlyph type={t} wide />,
            <span className="num"><Delta n={typeOf(rb, t).keys - typeOf(ra, t).keys} /></span>,
            <span className="num"><Delta n={typeOf(rb, t).bytes - typeOf(ra, t).bytes} fmt={bytesLabel} /></span>,
          ])}
        />
        <DataTable
          className="dense"
          columns={["Namespace", <span className="num">Keys</span>, <span className="num">Memory</span>]}
          rows={prefixes.map((p) => [
            <code className="data">{visibleText(p)}</code>,
            <span className="num"><Delta n={prefixOf(rb, p).keys - prefixOf(ra, p).keys} /></span>,
            <span className="num"><Delta n={prefixOf(rb, p).bytes - prefixOf(ra, p).bytes} fmt={bytesLabel} /></span>,
          ])}
        />
      </div>
      <p className="coverage-note">
        Recommendations: {added.length ? `new: ${added.join(", ")}` : "none new"} · {resolved.length ? `no longer found: ${resolved.join(", ")}` : "none resolved"}.
      </p>
    </section>
  );
}
