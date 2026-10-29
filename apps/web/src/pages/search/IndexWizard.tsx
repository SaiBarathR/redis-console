import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  SEARCH_ALIAS,
  SEARCH_FIELD_TYPES,
  SEARCH_INDEX_NAME,
  buildFtCreateArgv,
  searchIndexProblems,
  type SearchFieldSpec,
  type SearchFieldType,
  type SearchIndexCreateResponse,
  type SearchOn,
  type SearchSampleResponse,
} from "@rconsole/shared";
import { canWrite, useDatabase } from "../../lib/context.tsx";
import { RequestError, dbPath, post } from "../../lib/api.ts";
import { cliArg, visibleText } from "../../lib/format.ts";
import { useMemorySlot } from "../../lib/memory.tsx";
import { CopyButton, ErrorState, Field } from "../../components/ui.tsx";
import { defaultIndexName, searchSlots, type WizardHandoff } from "./state.ts";

/** One editable schema row: a sampled (or added) field and whether it goes into the index. */
interface Row {
  include: boolean;
  spec: SearchFieldSpec;
  seen?: number;
  examples?: string[];
  dim?: number;
}

const rowFromSample = (f: SearchSampleResponse["fields"][number], on: SearchOn): Row => {
  const spec: SearchFieldSpec = { name: f.name, type: f.suggested };
  if (on === "JSON") spec.as = f.as ?? "field";
  if (f.suggested === "VECTOR") spec.vector = { algorithm: "FLAT", dataType: "FLOAT32", dim: f.dim ?? 2, distance: "COSINE" };
  return { include: f.suggested !== "VECTOR", spec, seen: f.seen, examples: f.examples, ...(f.dim ? { dim: f.dim } : {}) };
};

/** Field options that only apply to some types are dropped when the type changes. */
function retype(spec: SearchFieldSpec, type: SearchFieldType, dim?: number): SearchFieldSpec {
  const next: SearchFieldSpec = { name: spec.name, type, ...(spec.as ? { as: spec.as } : {}) };
  if (type !== "VECTOR" && spec.sortable) next.sortable = true;
  if (type === "VECTOR") next.vector = spec.vector ?? { algorithm: "FLAT", dataType: "FLOAT32", dim: dim ?? 2, distance: "COSINE" };
  return next;
}

const commandText = (argv: string[]) => argv.map((a, i) => (i === 0 ? a : cliArg(a))).join(" ");

/**
 * "Make searchable": a three-step index wizard (source, fields, review). It samples keys under a prefix to suggest
 * fields and types, lets the user change them, and shows the exact FT.CREATE (built by the shared
 * `buildFtCreateArgv`, which the server also uses) before the server's confirmation.
 */
export function IndexWizard({ onCreated }: { onCreated: (index: string) => void }) {
  const db = useDatabase();
  const client = useQueryClient();
  const slots = searchSlots(db.id);
  const [handoff, setHandoff] = useMemorySlot<WizardHandoff | undefined>(slots.handoff, undefined);
  const [step, setStep] = useState(1);
  const [on, setOn] = useState<SearchOn>(handoff?.on ?? "HASH");
  const [prefix, setPrefix] = useState(handoff?.prefix ?? "");
  const [choices, setChoices] = useState<string[]>(handoff?.prefixes ?? []);
  const [fromKey, setFromKey] = useState(handoff?.key);
  const [sample, setSample] = useState<SearchSampleResponse>();
  const [rows, setRows] = useState<Row[]>([]);
  const [name, setName] = useState(handoff ? defaultIndexName(handoff.prefix) : "");
  const [noStopwords, setNoStopwords] = useState(false);
  const [skipInitialScan, setSkipInitialScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [extra, setExtra] = useState({ name: "", type: "TEXT" as SearchFieldType });
  // The source (type + prefix) the current sample and schema were read from. Each sample request takes a new
  // generation; changing the source takes one too, so a response that arrives late for an older source is dropped
  // (review v0.2.1 web M1: the schema must belong to the prefix the FT.CREATE indexes).
  const generation = useRef(0);
  const [sampledFrom, setSampledFrom] = useState<{ on: SearchOn; prefix: string }>();
  const changeSource = (next: { on?: SearchOn; prefix?: string; fromKey?: typeof fromKey }) => {
    generation.current++;
    if (next.on !== undefined) setOn(next.on);
    if (next.prefix !== undefined) setPrefix(next.prefix);
    if ("fromKey" in next) setFromKey(next.fromKey);
    setSample(undefined);
    setSampledFrom(undefined);
    setRows([]);
    setBusy(false);
  };
  // A handoff is consumed once: it prefills the form and samples right away; later visits start empty.
  useEffect(() => {
    if (!handoff) return;
    setHandoff(undefined);
    if (handoff.prefix) void runSample();
  }, []);

  const writable = canWrite(db);
  const schema = rows.filter((r) => r.include).map((r) => r.spec);
  const spec = { index: name, on, prefixes: prefix ? [prefix] : [], schema, ...(noStopwords ? { noStopwords } : {}), ...(skipInitialScan ? { skipInitialScan } : {}) };
  const problems = [
    ...(SEARCH_INDEX_NAME.test(name) ? [] : ["Index name: 1–128 letters, digits, _ . : - (starting with a letter or digit)."]),
    ...schema.filter((f) => f.as !== undefined && !SEARCH_ALIAS.test(f.as)).map((f) => `${f.name}: the alias must be a plain identifier (letters, digits, _).`),
    ...searchIndexProblems(spec),
    ...(sampledFrom && sampledFrom.on === on && sampledFrom.prefix === prefix ? [] : ["The fields were not sampled from this key type and prefix; go back and sample again."]),
  ];
  const argv = buildFtCreateArgv(spec);

  const runSample = async () => {
    const mine = ++generation.current;
    const from = { on, prefix };
    setError(undefined);
    setBusy(true);
    try {
      const r = await post<SearchSampleResponse>(dbPath(db.id, "/search/sample"), {
        on: from.on,
        prefix: from.prefix,
        keys: 20,
        ...(fromKey ? { key: fromKey } : {}),
      });
      if (mine !== generation.current) return;
      setSample(r);
      setSampledFrom(from);
      setRows(r.fields.map((f) => rowFromSample(f, from.on)));
      if (!name) setName(defaultIndexName(from.prefix));
      setStep(2);
    } catch (e) {
      if (mine === generation.current) setError(e);
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  };
  const create = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const r = await post<SearchIndexCreateResponse>(dbPath(db.id, "/search/index/create"), spec, "The wizard's review step shows the full FT.CREATE.");
      await client.invalidateQueries({ queryKey: ["search-indexes", db.id] });
      onCreated(r.index);
    } catch (e) {
      if (e instanceof RequestError && e.status === 403 && /NOPERM/.test(e.message))
        setError(new Error(`${e.message} The Redis user of your role may not create indexes on this database; ask an administrator.`));
      else setError(e);
    } finally {
      setBusy(false);
    }
  };
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setSpec = (i: number, patch: Partial<SearchFieldSpec>) =>
    setRows((rs) =>
      rs.map((r, j) => {
        if (j !== i) return r;
        const next = { ...r.spec, ...patch } as SearchFieldSpec;
        for (const k of Object.keys(patch) as (keyof SearchFieldSpec)[]) if (patch[k] === undefined || patch[k] === false) delete next[k];
        return { ...r, spec: next };
      }),
    );

  return (
    <section className="section first" aria-label="New search index" data-testid="index-wizard">
      <header>
        <h2>Make keys searchable</h2>
        <span className="meta">samples keys · suggests a schema · shows the FT.CREATE before anything runs</span>
      </header>
      <ol className="wizard-steps">
        {["Keys", "Fields", "Review"].map((label, i) => (
          <li key={label} aria-current={step === i + 1 ? "step" : undefined}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>
      {!writable && (
        <p className="notice warning" role="status">
          {db.readOnly
            ? "This database is read-only: you can sample keys and see the command, but not create the index."
            : `Your role here is ${db.effectiveRole}. Creating an index needs the operator or admin role (and a Redis user allowed to run FT.CREATE).`}
        </p>
      )}

      {step === 1 && (
        <div className="wizard-step">
          <div className="query-options">
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend>Key type</legend>
              <label className="checkbox">
                <input type="radio" name="wizard-on" checked={on === "HASH"} disabled={busy} onChange={() => changeSource({ on: "HASH" })} data-testid="wizard-on-hash" />
                Hashes
              </label>
              <label className="checkbox">
                <input type="radio" name="wizard-on" checked={on === "JSON"} disabled={busy} onChange={() => changeSource({ on: "JSON" })} data-testid="wizard-on-json" />
                JSON documents
              </label>
            </fieldset>
            <Field label="Key prefix (keys starting with)" hint="Literal text, not a pattern. Every new or changed key with this prefix is indexed.">
              <input
                className="data"
                value={prefix}
                disabled={busy}
                onChange={(e) => changeSource({ prefix: e.target.value, fromKey: undefined })}
                maxLength={512}
                placeholder="product:"
                spellCheck={false}
                data-testid="wizard-prefix"
              />
            </Field>
          </div>
          {choices.length > 1 && (
            <p className="actions" aria-label="Folders of the key">
              <span className="muted">Folders of the key:</span>
              {choices.map((p) => (
                <button key={p} type="button" className={`ghost data ${p === prefix ? "selected" : ""}`} aria-pressed={p === prefix} disabled={busy} onClick={() => changeSource({ prefix: p })}>
                  {visibleText(p)}
                </button>
              ))}
            </p>
          )}
          <div className="actions">
            <button type="button" className="primary" disabled={busy || !prefix} onClick={() => void runSample()} data-testid="wizard-sample">
              {busy ? "Sampling…" : "Sample keys"}
            </button>
            {(handoff || choices.length > 0) && (
              <button type="button" className="ghost" disabled={busy} onClick={() => { setChoices([]); changeSource({ fromKey: undefined }); }}>
                Forget the key
              </button>
            )}
          </div>
          <p className="muted">
            Reads up to 20 {on === "HASH" ? "hashes" : "JSON documents"} under the prefix (SCAN, then HSCAN or JSON.GET, at most 256 KiB
            each) to suggest fields. Nothing is written.
          </p>
        </div>
      )}

      {step === 2 && sample && (
        <div className="wizard-step">
          <p className="coverage-note" data-testid="wizard-sampled">
            {sample.sampled.toLocaleString()} {sample.sampled === 1 ? "key" : "keys"} sampled under{" "}
            <code className="data">{visibleText(sample.prefix)}</code>
            {sample.complete ? " (every matching key)" : " (a sample; other keys may have more fields)"}
            {sample.skipped > 0 && ` · ${sample.skipped} skipped (too large or changed)`}.
          </p>
          {sample.overlapping.length > 0 && (
            <p className="notice warning" role="status">
              Existing {sample.overlapping.length === 1 ? "index" : "indexes"} already cover keys like these:{" "}
              {sample.overlapping.map((o) => visibleText(o.name)).join(", ")}. A second index doubles the indexing work.
            </p>
          )}
          {!sample.sampled && <p className="notice warning">No {on === "HASH" ? "hashes" : "JSON documents"} found under this prefix. Add fields by hand, or go back and change the prefix.</p>}
          <div className="table-wrap dense">
            <table className="schema-table" aria-label="Fields to index">
              <thead>
                <tr>
                  <th>Index</th>
                  <th>{on === "JSON" ? "JSONPath" : "Field"}</th>
                  <th>{on === "JSON" ? "Name in queries" : "Alias (optional)"}</th>
                  <th>Type</th>
                  <th>Options</th>
                  <th>Seen</th>
                  <th>Examples</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.spec.name}-${i}`} className={r.include ? undefined : "excluded"} data-testid="wizard-field-row">
                    <td>
                      <input type="checkbox" checked={r.include} onChange={(e) => setRow(i, { include: e.target.checked })} aria-label={`Index ${r.spec.name}`} />
                    </td>
                    <td>
                      <code className="data">{visibleText(r.spec.name)}</code>
                    </td>
                    <td>
                      <input
                        className="data"
                        value={r.spec.as ?? ""}
                        placeholder={on === "JSON" ? "required" : "—"}
                        aria-label={`Alias of ${r.spec.name}`}
                        onChange={(e) => setSpec(i, { as: e.target.value || undefined })}
                      />
                    </td>
                    <td>
                      <select value={r.spec.type} aria-label={`Type of ${r.spec.name}`} onChange={(e) => setRow(i, { spec: retype(r.spec, e.target.value as SearchFieldType, r.dim) })}>
                        {SEARCH_FIELD_TYPES.map((t) => (
                          <option key={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <FieldOptions spec={r.spec} onChange={(p) => setSpec(i, p)} />
                    </td>
                    <td className="num tabular">{r.seen !== undefined ? `${r.seen}/${sample.sampled}` : "added"}</td>
                    <td>
                      <span className="data rich-cell" title={(r.examples ?? []).map(visibleText).join("  ·  ")}>{(r.examples ?? []).map(visibleText).join("  ·  ")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sample.ignored.length > 0 && (
            <details className="muted">
              <summary>{sample.ignored.length} not offered</summary>
              <ul>
                {sample.ignored.map((x) => (
                  <li key={x.name}>
                    <code className="data">{visibleText(x.name)}</code>: {x.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <form
            className="query-options"
            onSubmit={(e) => {
              e.preventDefault();
              if (!extra.name.trim()) return;
              const n = extra.name.trim();
              const s: SearchFieldSpec = retype({ name: n, type: extra.type }, extra.type);
              if (on === "JSON") s.as = (n.split(/[.[\]"]/).filter(Boolean).pop() ?? "field").replace(/[^A-Za-z0-9_]/g, "_").replace(/^(?=\d)/, "_");
              setRows((rs) => [...rs, { include: true, spec: s }]);
              setExtra({ name: "", type: extra.type });
            }}
          >
            <Field label={on === "JSON" ? "Add a JSONPath" : "Add a field"}>
              <input className="data" value={extra.name} onChange={(e) => setExtra({ ...extra, name: e.target.value })} placeholder={on === "JSON" ? "$.path" : "field"} maxLength={256} data-testid="wizard-add-name" />
            </Field>
            <Field label="Type">
              <select value={extra.type} onChange={(e) => setExtra({ ...extra, type: e.target.value as SearchFieldType })}>
                {SEARCH_FIELD_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <div className="actions">
              <button type="submit" className="ghost" disabled={!extra.name.trim()}>
                Add field
              </button>
            </div>
          </form>
          <div className="actions">
            <button type="button" onClick={() => setStep(1)} data-testid="wizard-back">
              Back
            </button>
            <button type="button" className="primary" disabled={!schema.length} onClick={() => setStep(3)} data-testid="wizard-next">
              Review {schema.length} {schema.length === 1 ? "field" : "fields"}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="wizard-step">
          <div className="query-options">
            <Field label="Index name">
              <input className="data" value={name} onChange={(e) => setName(e.target.value)} maxLength={128} spellCheck={false} data-testid="wizard-index-name" />
            </Field>
            <label className="checkbox">
              <input type="checkbox" checked={noStopwords} onChange={(e) => setNoStopwords(e.target.checked)} />
              Index every word (STOPWORDS 0)
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={skipInitialScan} onChange={(e) => setSkipInitialScan(e.target.checked)} />
              Only keys written from now on (SKIPINITIALSCAN)
            </label>
          </div>
          <div className="command-box">
            <span className="label">Will run</span>
            <pre className="data" data-testid="wizard-command">
              {visibleText(commandText(argv))}
            </pre>
            <CopyButton text={commandText(argv)} label="Copy FT.CREATE" iconOnly />
          </div>
          <p className="muted">
            {skipInitialScan
              ? "Existing keys stay unindexed; keys written after creation are indexed."
              : "Existing keys with this prefix are indexed in the background; the index details show progress."}{" "}
            The server asks you to confirm{db.environment === "prod" ? ", type the database name and give a reason" : ""} before it runs.
          </p>
          {problems.length > 0 && (
            <ul className="problems" data-testid="wizard-problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="actions">
            <button type="button" onClick={() => setStep(2)}>
              Back
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || problems.length > 0 || !writable}
              onClick={() => void create()}
              data-testid="wizard-create"
              title={writable ? "Asks the server for confirmation" : "Your role cannot create indexes on this database"}
            >
              {busy ? "Working…" : "Create index…"}
            </button>
          </div>
        </div>
      )}
      <ErrorState error={error} />
    </section>
  );
}

function FieldOptions({ spec, onChange }: { spec: SearchFieldSpec; onChange: (p: Partial<SearchFieldSpec>) => void }) {
  const box = (label: string, checked: boolean, set: (v: boolean) => void, title?: string) => (
    <label className="checkbox" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );
  return (
    <span className="opts">
      {spec.type !== "VECTOR" && box("Sortable", !!spec.sortable, (v) => onChange({ sortable: v || undefined, ...(v ? {} : { noIndex: undefined }) }), "SORTABLE: SORTBY can use it")}
      {spec.type === "TEXT" && box("No stemming", !!spec.noStem, (v) => onChange({ noStem: v || undefined }), "NOSTEM: match exact word forms")}
      {spec.type === "TAG" && box("Case-sensitive", !!spec.caseSensitive, (v) => onChange({ caseSensitive: v || undefined }), "CASESENSITIVE")}
      {spec.type === "TAG" && (
        <label className="checkbox" title="SEPARATOR: one character splitting several tags in one value (default ,)">
          Separator
          <input
            className="data tag-separator"
            maxLength={1}
            value={spec.separator ?? ""}
            onChange={(e) => onChange({ separator: e.target.value || undefined })}
            aria-label={`Tag separator of ${spec.name}`}
          />
        </label>
      )}
      {spec.type === "VECTOR" && spec.vector && (
        <>
          <select aria-label={`Vector algorithm of ${spec.name}`} value={spec.vector.algorithm} onChange={(e) => onChange({ vector: { ...spec.vector!, algorithm: e.target.value as "FLAT" | "HNSW" } })}>
            <option>FLAT</option>
            <option>HNSW</option>
          </select>
          <select aria-label={`Vector type of ${spec.name}`} value={spec.vector.dataType} onChange={(e) => onChange({ vector: { ...spec.vector!, dataType: e.target.value as "FLOAT32" | "FLOAT64" } })}>
            <option>FLOAT32</option>
            <option>FLOAT64</option>
          </select>
          <input
            type="number"
            min={1}
            max={32768}
            aria-label={`Vector dimension of ${spec.name}`}
            style={{ width: "8ch" }}
            value={spec.vector.dim}
            onChange={(e) => onChange({ vector: { ...spec.vector!, dim: Math.max(1, Number(e.target.value) || 1) } })}
          />
          <select aria-label={`Vector distance of ${spec.name}`} value={spec.vector.distance} onChange={(e) => onChange({ vector: { ...spec.vector!, distance: e.target.value as "L2" | "IP" | "COSINE" } })}>
            <option>COSINE</option>
            <option>L2</option>
            <option>IP</option>
          </select>
        </>
      )}
    </span>
  );
}
