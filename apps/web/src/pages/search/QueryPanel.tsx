import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  binFromString,
  buildFtSearchArgv,
  tokenizeCommandLine,
  type Bin,
  type CliResponse,
  type SearchIndexSummary,
  type SearchResult,
} from "@rconsole/shared";
import { useDatabase } from "../../lib/context.tsx";
import { dbPath, post } from "../../lib/api.ts";
import { cliArg, visibleText } from "../../lib/format.ts";
import { parseJson, stringifyJson, JsonNumber } from "../../lib/json.ts";
import { useMemorySlot } from "../../lib/memory.tsx";
import { executeCli } from "../../lib/operations.ts";
import { CopyButton, Empty, ErrorState, Field, JsonTree, Tabs } from "../../components/ui.tsx";
import { KeyName } from "../../components/anatomy.tsx";
import { RichReply } from "../../components/RichReply.tsx";
import { richKind } from "../../lib/richReply.ts";
import { QueryEditor } from "./QueryEditor.tsx";
import { queryFields, useIndexDetail } from "./IndexDetail.tsx";
import { EMPTY_FORM, MAX_RECENT, MAX_SAVED, searchSlots, type QueryForm, type SavedQuery } from "./state.ts";

type Applied = { form: QueryForm; offset: number };
type Outcome =
  | { kind: "search"; applied: Applied; result: SearchResult; argv: string[] }
  | { kind: "aggregate" | "explain" | "profile"; applied: Applied; response: CliResponse; argv: string[] };

const commandText = (argv: string[]) => argv.map((a, i) => (i === 0 ? a : cliArg(a))).join(" ");

/** The argv a form runs as (search: the typed endpoint's FT.SEARCH, without the server's TIMEOUT). */
export function formArgv(form: QueryForm, offset = 0, what: "run" | "explain" | "profile" = "run"): string[] {
  const dialect = form.dialect ? ["DIALECT", String(form.dialect)] : [];
  const pipeline = form.mode === "aggregate" && form.pipeline.trim() ? tokenizeCommandLine(form.pipeline) : [];
  if (what === "explain") return ["FT.EXPLAIN", form.index, form.query || "*", ...dialect];
  if (what === "profile") {
    return form.mode === "aggregate"
      ? ["FT.PROFILE", form.index, "AGGREGATE", "QUERY", form.query || "*", ...pipeline, ...dialect]
      : ["FT.PROFILE", form.index, "SEARCH", "QUERY", form.query || "*", ...buildFtSearchArgv({ ...searchOptions(form), index: form.index, query: form.query, offset }).slice(3)];
  }
  if (form.mode === "aggregate") return ["FT.AGGREGATE", form.index, form.query || "*", ...pipeline, ...dialect];
  return buildFtSearchArgv({ ...searchOptions(form), index: form.index, query: form.query, offset });
}

function searchOptions(form: QueryForm) {
  return {
    limit: form.limit,
    ...(form.sortBy ? { sortBy: form.sortBy, sortOrder: form.sortOrder } : {}),
    ...(form.returnFields.length ? { returnFields: form.returnFields } : {}),
    ...(form.dialect ? { dialect: form.dialect } : {}),
  };
}

/** Field text for display; a JSON document's `$` field is spread into its top-level properties. */
export function documentColumns(fields: Record<string, string>): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (name === "$" && /^\s*[[{]/.test(value)) {
      try {
        const parsed = parseJson(value);
        const doc = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
        if (doc && typeof doc === "object" && !Array.isArray(doc) && !(doc instanceof JsonNumber)) {
          for (const [k, v] of Object.entries(doc as Record<string, unknown>)) out.push([`$.${k}`, typeof v === "string" ? v : stringifyJson(v, 0)]);
          continue;
        }
      } catch {
        /* shown as text */
      }
    }
    out.push([name, value]);
  }
  return out;
}

function documentValue(fields: Record<string, string>): unknown {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => {
      if (k === "$" && /^\s*[[{]/.test(v)) {
        try {
          return [k, parseJson(v)];
        } catch {
          /* text */
        }
      }
      return [k, v];
    }),
  );
}

const sameForm = (a: QueryForm, b: QueryForm) => JSON.stringify(a) === JSON.stringify(b);

export function QueryPanel({
  indexes,
  indexListError,
  onDetails,
}: {
  indexes: SearchIndexSummary[] | undefined;
  indexListError: boolean;
  onDetails: (index: string) => void;
}) {
  const db = useDatabase();
  const navigate = useNavigate();
  const slots = searchSlots(db.id);
  const [form, setForm] = useMemorySlot<QueryForm>(slots.form, EMPTY_FORM);
  const [saved, setSaved] = useMemorySlot<SavedQuery[]>(slots.saved, []);
  const [recent, setRecent] = useMemorySlot<QueryForm[]>(slots.recent, []);
  const [outcome, setOutcome] = useMemorySlot<Outcome | undefined>(`${db.id}:search:outcome`, undefined);
  const [, setSelectedKey] = useMemorySlot<Bin | undefined>(`${db.id}:selected-key`, undefined);
  const [, setWorkbenchDraft] = useMemorySlot(`${db.id}:workbench:draft`, "");
  const [view, setView] = useState<"table" | "json">("table");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saveName, setSaveName] = useState("");
  const detail = useIndexDetail(form.index);
  const fields = queryFields(detail.data);
  const fallbackFields = indexes?.find((i) => i.name === form.index)?.fields ?? [];
  const completion = fields.length ? fields : fallbackFields.map((f) => ({ name: f.name, type: f.type, sortable: false }));
  const sortable = fields.filter((f) => f.sortable);
  const update = (patch: Partial<QueryForm>) => setForm((f) => ({ ...f, ...patch }));
  let argvError = "";
  let argv: string[] = [];
  try {
    argv = form.index ? formArgv(form) : [];
  } catch (e) {
    argvError = e instanceof Error ? e.message : String(e);
  }

  const run = async (what: "run" | "explain" | "profile", offset = 0, f: QueryForm = form) => {
    setError(undefined);
    if (!f.index) {
      setError(new Error("Choose an index first."));
      return;
    }
    setBusy(true);
    try {
      const a = formArgv(f, offset, what);
      const applied = { form: f, offset };
      if (what === "run" && f.mode === "search") {
        const result = await post<SearchResult>(dbPath(db.id, "/search/query"), {
          index: f.index,
          query: f.query,
          offset,
          ...searchOptions(f),
        });
        setOutcome({ kind: "search", applied, result, argv: a });
      } else {
        const response = await executeCli(db.id, { argv: a });
        setOutcome({ kind: what === "run" ? "aggregate" : what, applied, response, argv: a });
      }
      if (what === "run" && offset === 0) setRecent((r) => [f, ...r.filter((x) => !sameForm(x, f))].slice(0, MAX_RECENT));
    } catch (e) {
      // FT.EXPLAIN is only in Redis's @search ACL category, so read-only Redis users are often denied it.
      if (what === "explain" && e instanceof Error && /NOPERM/.test(e.message))
        setError(new Error(`${e.message}. The Redis user of your role may not run FT.EXPLAIN on this database; Profile query shows the plan with timings.`));
      else setError(e);
    } finally {
      setBusy(false);
    }
  };
  const open = (key: Bin) => {
    setSelectedKey(key);
    navigate(`/db/${encodeURIComponent(db.id)}/keys`);
  };
  const page = outcome?.applied;
  const limit = page?.form.limit ?? 20;

  return (
    <>
      <section className="section first" aria-label="Query">
        <header>
          <h2>Query</h2>
          <span className="meta">{form.mode === "search" ? "FT.SEARCH" : "FT.AGGREGATE"} · @ lists fields, Ctrl+Space lists syntax</span>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run("run");
          }}
        >
          <div className="query-options">
          <Field label="Index">
            {indexListError ? (
              <input
                required
                className="data"
                value={form.index}
                onChange={(e) => update({ index: e.target.value, sortBy: "", returnFields: [] })}
                placeholder="Index name"
                spellCheck={false}
                data-testid="search-index"
              />
            ) : (
              <select
                required
                value={form.index}
                onChange={(e) => update({ index: e.target.value, sortBy: "", returnFields: [] })}
                data-testid="search-index"
              >
                <option value="">Select an index</option>
                {indexes?.map((row) => (
                  <option key={row.name} value={row.name}>
                    {visibleText(row.name)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Kind">
            <select value={form.mode} onChange={(e) => update({ mode: e.target.value as QueryForm["mode"] })} data-testid="search-mode">
              <option value="search">Search (documents)</option>
              <option value="aggregate">Aggregate (groups, counts)</option>
            </select>
          </Field>
          {form.mode === "search" && (
            <>
              <Field label="Sort by">
                <select value={form.sortBy} onChange={(e) => update({ sortBy: e.target.value })} data-testid="search-sort" disabled={!sortable.length} title={sortable.length ? undefined : "No SORTABLE fields in this index"}>
                  <option value="">Relevance</option>
                  {sortable.map((f) => (
                    <option key={f.name} value={f.name}>
                      @{visibleText(f.name)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Order">
                <select value={form.sortOrder} onChange={(e) => update({ sortOrder: e.target.value as "ASC" | "DESC" })} disabled={!form.sortBy} data-testid="search-sort-order">
                  <option value="ASC">Ascending</option>
                  <option value="DESC">Descending</option>
                </select>
              </Field>
              <Field label="Page size">
                <select value={form.limit} onChange={(e) => update({ limit: Number(e.target.value) })} data-testid="search-limit">
                  {[10, 20, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          <Field label="Dialect">
            <select value={form.dialect ?? ""} onChange={(e) => update({ dialect: e.target.value ? Number(e.target.value) : undefined })} data-testid="search-dialect">
              <option value="">Server default</option>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          </div>
          <div className="query-row">
          <label className="field">
            <span>Query</span>
            <QueryEditor
              value={form.query}
              onChange={(query) => update({ query })}
              onRun={() => void run("run")}
              fields={completion}
              label="Search query"
              placeholder="@title:gadget"
              testId="search-query"
            />
          </label>
          {form.mode === "aggregate" && (
            <label className="field">
              <span>Pipeline</span>
              <QueryEditor
                value={form.pipeline}
                onChange={(pipeline) => update({ pipeline })}
                onRun={() => void run("run")}
                fields={completion}
                kind="pipeline"
                label="Aggregate pipeline"
                placeholder="GROUPBY 1 @category REDUCE COUNT 0 AS count"
                testId="search-pipeline"
              />
            </label>
          )}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy || !form.index || !!argvError} data-testid="search-run">
              {busy ? "Working…" : form.mode === "search" ? "Run search" : "Run aggregate"}
            </button>
          </div>
          </div>
        </form>
        {form.mode === "search" && fields.length > 0 && (
          <fieldset className="query-options" data-testid="search-return">
            <legend className="muted">Return fields (RETURN; none selected returns every field)</legend>
            {fields.map((f) => (
              <label key={f.name} className="checkbox">
                <input
                  type="checkbox"
                  checked={form.returnFields.includes(f.name)}
                  onChange={(e) =>
                    update({ returnFields: e.target.checked ? [...form.returnFields, f.name] : form.returnFields.filter((x) => x !== f.name) })
                  }
                />
                <span className="data">{visibleText(f.name)}</span>
              </label>
            ))}
          </fieldset>
        )}
        {form.index && (
          <div className="command-box">
            <span className="label">Runs</span>
            <pre className="data" data-testid="search-command">
              {argvError ? `Pipeline: ${argvError}` : visibleText(commandText(argv))}
              {form.mode === "search" && !argvError && <span className="muted"> TIMEOUT (set by the server)</span>}
            </pre>
            {!argvError && <CopyButton text={commandText(argv)} label="Copy command" iconOnly />}
          </div>
        )}
        <div className="actions explain-actions">
          <button type="button" disabled={busy || !form.index} onClick={() => void run("explain")} data-testid="search-explain">
            Explain query plan
          </button>
          <button type="button" disabled={busy || !form.index} onClick={() => void run("profile")} data-testid="search-profile">
            Profile query
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!form.index || !!argvError}
            onClick={() => {
              setWorkbenchDraft(commandText(argv));
              navigate(`/db/${encodeURIComponent(db.id)}/workbench`);
            }}
            title="Puts this command in the workbench (it does not run)"
            data-testid="search-workbench"
          >
            Open in workbench
          </button>
          {form.index && (
            <button type="button" className="ghost" onClick={() => onDetails(form.index)}>
              Index details
            </button>
          )}
        </div>
        <ErrorState error={error} />
        <SavedQueries
          form={form}
          saved={saved}
          recent={recent}
          saveName={saveName}
          setSaveName={setSaveName}
          onSave={(name) => setSaved((s) => [{ name, form, savedAt: Date.now() }, ...s.filter((x) => x.name !== name)].slice(0, MAX_SAVED))}
          onDelete={(name) => setSaved((s) => s.filter((x) => x.name !== name))}
          onUse={(f, runNow) => {
            setForm(f);
            if (runNow) void run("run", 0, f);
          }}
          onClearRecent={() => setRecent([])}
        />
      </section>
      {outcome && (
        <section className="section" aria-label="Results" data-testid="search-results">
          <header>
            <h2>{outcomeTitle(outcome)}</h2>
            <span className="meta data">{visibleText(commandText(outcome.argv).slice(0, 300))}</span>
            {outcome.kind === "search" && (
              <div className="actions">
                <Tabs
                  label="Result view"
                  value={view}
                  onChange={setView}
                  testId="search-view"
                  options={[
                    { id: "table", label: "Table" },
                    { id: "json", label: "JSON" },
                  ]}
                />
                <button type="button" disabled={busy || page!.offset === 0} onClick={() => void run("run", Math.max(0, page!.offset - limit), page!.form)}>
                  Previous {limit}
                </button>
                <button type="button" disabled={busy || page!.offset + limit >= outcome.result.total} onClick={() => void run("run", page!.offset + limit, page!.form)}>
                  Next {limit}
                </button>
              </div>
            )}
          </header>
          {outcome.kind === "search" ? (
            <SearchDocuments result={outcome.result} view={view} onOpen={open} />
          ) : (
            <CliOutcome response={outcome.response} onOpen={open} />
          )}
        </section>
      )}
    </>
  );
}

function outcomeTitle(o: Outcome): ReactNode {
  if (o.kind === "search") {
    const { total } = o.result;
    const from = o.applied.offset;
    return (
      <>
        <span>{`${total.toLocaleString()} ${total === 1 ? "result" : "results"}`}</span>
        {total > 0 && <span className="muted"> · showing {from + 1}–{Math.min(from + o.applied.form.limit, total)}</span>}
      </>
    );
  }
  return o.kind === "aggregate" ? "Aggregation" : o.kind === "explain" ? "Query plan" : "Profile";
}

function CliOutcome({ response, onOpen }: { response: CliResponse; onOpen: (key: Bin) => void }) {
  const kind = richKind(response.argv, response.reply);
  return kind ? (
    <RichReply kind={kind} reply={response.reply} onOpen={onOpen} />
  ) : (
    <p className="muted">The reply has an unexpected shape; run it in the workbench to see it whole.</p>
  );
}

function SearchDocuments({ result, view, onOpen }: { result: SearchResult; view: "table" | "json"; onOpen: (key: Bin) => void }) {
  if (!result.docs.length) return <Empty compact>No documents match this query. Try a broader query such as *.</Empty>;
  const rows = result.docs.map((d) => ({ doc: d, cols: documentColumns(d.fields) }));
  const columns: string[] = [];
  for (const r of rows) for (const [c] of r.cols) if (!columns.includes(c) && columns.length < 30) columns.push(c);
  const idCell = (d: SearchResult["docs"][number]) =>
    d.idBytes !== undefined ? (
      <span className="muted" data-testid="search-doc-id-withheld">
        ID withheld ({d.idBytes.toLocaleString()} bytes, too large to list)
      </span>
    ) : (
      <button
        type="button"
        className="key-link data"
        aria-label={`Open key ${visibleText(d.id).slice(0, 200)} in the key browser`}
        title="Open in the key browser"
        data-testid="search-open-doc"
        onClick={() => onOpen(d.key ?? binFromString(d.id))}
      >
        <KeyName name={d.key ?? binFromString(d.id)} limit={300} />
      </button>
    );
  const truncation = (d: SearchResult["docs"][number]) =>
    d.truncated && d.idBytes === undefined ? (
      <div className="notice warning" data-testid="search-doc-truncated">
        <span>
          {Object.keys(d.fields).length
            ? "Preview cut: some values are shortened (4,096 characters each, and a shared reply budget)."
            : "Fields not returned: earlier documents used the reply budget."}
        </span>
        <button type="button" onClick={() => onOpen(d.key ?? binFromString(d.id))}>
          Open in key browser
        </button>
      </div>
    ) : null;
  if (view === "json")
    return (
      <ol className="search-json">
        {rows.map(({ doc }, i) => (
          <li key={i}>
            {idCell(doc)}
            {truncation(doc)}
            <JsonTree value={documentValue(doc.fields)} />
          </li>
        ))}
      </ol>
    );
  return (
    <div className="table-wrap dense rich-scroll">
      <table aria-label="Search results">
        <thead>
          <tr>
            <th>Document</th>
            {columns.map((c) => (
              <th key={c}>
                <span className="data">{visibleText(c)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ doc, cols }, i) => {
            const m = new Map(cols);
            return (
              <tr key={i}>
                <td>
                  {idCell(doc)}
                  {truncation(doc)}
                </td>
                {columns.map((c) => (
                  <td key={c}>
                    {m.has(c) ? <span className="data rich-cell">{visibleText(m.get(c)!.slice(0, 2000))}</span> : <span className="muted">—</span>}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SavedQueries({
  form,
  saved,
  recent,
  saveName,
  setSaveName,
  onSave,
  onDelete,
  onUse,
  onClearRecent,
}: {
  form: QueryForm;
  saved: SavedQuery[];
  recent: QueryForm[];
  saveName: string;
  setSaveName: (v: string) => void;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
  onUse: (form: QueryForm, run: boolean) => void;
  onClearRecent: () => void;
}) {
  const label = (f: QueryForm) => `${f.index} · ${f.query || "*"}${f.mode === "aggregate" ? ` · ${f.pipeline}` : ""}`.slice(0, 120);
  return (
    <div className="saved-block">
      <form
        className="query-options"
        onSubmit={(e) => {
          e.preventDefault();
          const name = saveName.trim() || label(form);
          onSave(name.slice(0, 80));
          setSaveName("");
        }}
      >
        <Field label="Save this query as">
          <input value={saveName} onChange={(e) => setSaveName(e.target.value)} maxLength={80} placeholder="Name (optional)" data-testid="search-save-name" />
        </Field>
        <div className="actions">
          <button type="submit" className="ghost" disabled={!form.index || saved.length >= MAX_SAVED} data-testid="search-save" title="Kept in this tab's memory only">
            Save query
          </button>
        </div>
        {recent.length > 0 && (
          <Field label="Recent">
            <select
              value=""
              data-testid="search-recent"
              onChange={(e) => {
                const f = recent[Number(e.target.value)];
                if (f) onUse(f, false);
              }}
            >
              <option value="" disabled>
                {recent.length} recent {recent.length === 1 ? "query" : "queries"}
              </option>
              {recent.map((f, i) => (
                <option key={i} value={i}>
                  {visibleText(label(f))}
                </option>
              ))}
            </select>
          </Field>
        )}
        {recent.length > 0 && (
          <div className="actions">
            <button type="button" className="ghost" onClick={onClearRecent}>
              Clear recent
            </button>
          </div>
        )}
      </form>
      {saved.length > 0 && (
        <>
          <p className="muted">Saved queries live in this tab's memory and are gone after sign-out or reload.</p>
          <ul className="saved-queries" data-testid="search-saved">
            {saved.map((s) => (
              <li key={s.name}>
                <button type="button" onClick={() => onUse(s.form, true)} title={visibleText(label(s.form))}>
                  {visibleText(s.name)}
                </button>
                <button type="button" className="icon-button" aria-label={`Load ${visibleText(s.name)} without running`} title="Load without running" onClick={() => onUse(s.form, false)}>
                  ✎
                </button>
                <button type="button" className="icon-button" aria-label={`Delete saved query ${visibleText(s.name)}`} title="Delete" onClick={() => onDelete(s.name)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
