import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Trash2, X } from "lucide-react";
import {
  VSET_ATTR_ROWS_MAX,
  VSET_EMBED_MAX_DIM,
  VSET_FILTER_EF_MAX,
  VSET_FILTER_MAX_CHARS,
  VSET_NUMBER,
  VSET_PAGE_DEFAULT,
  VSET_SEARCH_COUNT_MAX,
  VSET_SEARCH_EF_MAX,
  VSET_VALUES_MAX,
  binFromString,
  bytesFromBin,
  type Bin,
  type KeyDetails,
  type KeyValue,
  type VectorSetPage,
  type VsetAttributeCell,
  type VsetAttributesResponse,
  type VsetElementResponse,
  type VsetMembersResponse,
  type VsetSearchRequest,
  type VsetSearchResponse,
} from "@rconsole/shared";
import "./vectorset.css";
import { dbPath, request } from "../lib/api.ts";
import { canWrite, useDatabase } from "../lib/context.tsx";
import { digestBin } from "../lib/expect.ts";
import { cliArg, cliBin, displayBin, visibleText } from "../lib/format.ts";
import { parseJson } from "../lib/json.ts";
import { keyOperation } from "../lib/operations.ts";
import { InlineEdit } from "./InlineEdit.tsx";
import { ValueViewer } from "./ValueViewer.tsx";
import { CopyButton, Empty, ErrorState, Loading, Modal, Tabs } from "./ui.tsx";

type VectorSetValue = Extract<KeyValue, { type: "vectorset" }>;

/** `quant-type` as the user knows it from VADD's options. */
export function quantizationLabel(q: string | undefined) {
  if (q === "f32") return "None (FP32, NOQUANT)";
  if (q === "int8") return "8-bit (Q8)";
  if (q === "bin") return "Binary (BIN)";
  return q ?? "Unknown";
}

/**
 * Split a typed vector into coordinates exactly as typed (commas or whitespace between them). Throws a message for
 * the form when a coordinate is not a finite decimal number or there are too many.
 */
export function parseVector(text: string): string[] {
  const values = text.split(/[\s,]+/).filter(Boolean);
  if (!values.length) throw new Error("Enter the vector's coordinates, separated by commas or spaces.");
  if (values.length > VSET_VALUES_MAX) throw new Error(`A vector has at most ${VSET_VALUES_MAX.toLocaleString()} coordinates.`);
  const bad = values.find((v) => !VSET_NUMBER.test(v) || !Number.isFinite(Number(v)));
  if (bad !== undefined) throw new Error(`"${visibleText(bad.slice(0, 40))}" is not a finite decimal number.`);
  return values;
}

/** The VSIM command the search form will send (shown under the form; the server adds the same FILTER-EF). */
export function vsimPreview(key: Bin, q: Omit<VsetSearchRequest, "key">): string {
  const parts = ["VSIM", cliBin(key, 200)];
  if ("element" in q.query) parts.push("ELE", cliBin(q.query.element, 200));
  else parts.push("VALUES", String(q.query.values.length), ...q.query.values.slice(0, 8), ...(q.query.values.length > 8 ? [`… (${q.query.values.length - 8} more)`] : []));
  const count = q.count ?? 10;
  parts.push("COUNT", String(count), "WITHSCORES");
  if (q.withAttributes) parts.push("WITHATTRIBS");
  if (q.ef !== undefined) parts.push("EF", String(q.ef));
  if (q.filter !== undefined) parts.push("FILTER", cliArg(q.filter), "FILTER-EF", String(Math.min(q.filterEf ?? count * 100, VSET_FILTER_EF_MAX)));
  return parts.join(" ");
}

/** One attribute cell of the members table or the search results: always text, never markup. */
function AttributeCell({ cell, loading }: { cell: VsetAttributeCell | undefined; loading?: boolean }) {
  if (loading) return <span className="muted">Reading…</span>;
  if (cell === undefined) return <span className="muted">—</span>;
  if (cell === null) return <span className="muted">No attributes</span>;
  if ("tooLarge" in cell) return <span className="muted">Too large to list here; open the member</span>;
  return (
    <span className="vset-attr data" title={cell.truncated ? `First bytes of ${cell.totalBytes?.toLocaleString()} bytes` : undefined}>
      {displayBin(cell.value, 400)}
      {cell.truncated && <small className="muted"> … ({cell.totalBytes?.toLocaleString()} bytes; open the member to read all)</small>}
    </span>
  );
}

function IconAction({ label, onClick, icon, danger = false, disabled = false, testId }: { label: string; onClick: () => void; icon: ReactNode; danger?: boolean; disabled?: boolean; testId?: string }) {
  return (
    <button type="button" className={`icon-button row-button ${danger ? "danger-text" : ""}`.trim()} aria-label={label} title={label} disabled={disabled} onClick={onClick} data-testid={testId}>
      {icon}
    </button>
  );
}

/**
 * The vector-set inspector (v0.4, F23): summary, members (lexicographic pages, prefix filter, attributes read lazily
 * for the page on screen), similarity search, and a member panel with attributes, embedding and HNSW neighbours.
 * Operators edit attributes (compare-and-set) and remove members (server confirmation); viewers only read.
 */
export function VectorSetDetail({ details, value, refresh }: { details: KeyDetails; value: VectorSetValue; refresh: () => Promise<unknown> }) {
  const db = useDatabase();
  const writable = canWrite(db);
  const client = useQueryClient();
  const key = details.key;
  const [tab, setTab] = useState<"members" | "search">("members");
  const [open, setOpen] = useState<Bin>();
  const [searchFor, setSearchFor] = useState<Bin>();
  const info = value.info;
  const reload = async () => {
    await client.invalidateQueries({ queryKey: ["vset", db.id, key.enc, key.data] });
    await refresh();
  };
  return (
    <div className="vset" data-testid="vset-detail">
      <dl className="inline-facts vset-summary" data-testid="vset-summary">
        <dt>Members</dt>
        <dd>{info.size.toLocaleString()}</dd>
        <dt>Dimensions</dt>
        <dd>{info.dim.toLocaleString()}{info.projectionInputDim ? ` (projected from ${info.projectionInputDim.toLocaleString()}, REDUCE)` : ""}</dd>
        <dt>Quantisation</dt>
        <dd>{quantizationLabel(info.quantization)}</dd>
        {info.hnswM !== undefined && (<><dt title="Links per node per layer (layer 0 has twice as many)">HNSW M</dt><dd>{info.hnswM}</dd></>)}
        {info.maxLevel !== undefined && (<><dt>Top layer</dt><dd>{info.maxLevel}</dd></>)}
        {info.attributesCount !== undefined && (<><dt>With attributes</dt><dd>{info.attributesCount.toLocaleString()}</dd></>)}
      </dl>
      <Tabs
        label="Vector set view"
        value={tab}
        onChange={setTab}
        testId="vset-tabs"
        options={[
          { id: "members", label: "Members" },
          { id: "search", label: "Similarity search" },
        ]}
      />
      {tab === "members" ? (
        <Members keyName={key} first={value.page} total={info.size} writable={writable} onOpen={setOpen} reload={reload} />
      ) : (
        <SimilaritySearch keyName={key} dim={info.dim} initialMember={searchFor} onOpen={setOpen} />
      )}
      {open && (
        <ElementPanel
          key={`${open.enc}:${open.data}`}
          keyName={key}
          member={open}
          writable={writable}
          onClose={() => setOpen(undefined)}
          onOpen={setOpen}
          onFindSimilar={(m) => { setSearchFor(m); setTab("search"); setOpen(undefined); }}
          reload={reload}
        />
      )}
    </div>
  );
}

function Members({ keyName, first, total, writable, onOpen, reload }: { keyName: Bin; first: VectorSetPage; total: number; writable: boolean; onOpen: (m: Bin) => void; reload: () => Promise<unknown> }) {
  const db = useDatabase();
  const [draft, setDraft] = useState("");
  const [prefix, setPrefix] = useState<Bin>();
  /** Starts of the pages before this one, so Previous returns exactly. */
  const [history, setHistory] = useState<(Bin | undefined)[]>([]);
  const [after, setAfter] = useState<Bin>();
  const [showAttributes, setShowAttributes] = useState(true);
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const own = !!prefix || !!after;
  const members = useQuery({
    queryKey: ["vset", db.id, keyName.enc, keyName.data, "members", prefix, after],
    enabled: own,
    queryFn: ({ signal }) => request<VsetMembersResponse>(dbPath(db.id, "/vectorset/members"), { method: "POST", body: { key: keyName, prefix, after, count: VSET_PAGE_DEFAULT }, signal }),
  });
  const page = own ? members.data?.page : first;
  const setSize = own ? members.data?.total ?? total : total;
  const visible = (page?.members ?? []).filter((m) => !m.truncated).slice(0, VSET_ATTR_ROWS_MAX).map((m) => m.member);
  const attributes = useQuery({
    queryKey: ["vset", db.id, keyName.enc, keyName.data, "attributes", visible.map((m) => `${m.enc}:${m.data}`).join("\n")],
    enabled: showAttributes && visible.length > 0,
    queryFn: ({ signal }) => request<VsetAttributesResponse>(dbPath(db.id, "/vectorset/attributes"), { method: "POST", body: { key: keyName, members: visible }, signal, background: true }),
  });
  const attributeOf = (m: Bin) => {
    const i = visible.findIndex((v) => v.enc === m.enc && v.data === m.data);
    return i < 0 ? undefined : attributes.data?.attributes[i];
  };
  const go = (next: Bin | undefined, back = false) => {
    if (back) setHistory((h) => h.slice(0, -1));
    else setHistory((h) => [...h, after]);
    setAfter(next);
  };
  const remove = (member: Bin) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    void keyOperation(db.id, { op: "vset.remove", key: keyName, member }, `Removes member ${displayBin(member, 200)} and its vector, attributes and graph links.`)
      .then(reload)
      .catch(setError)
      .finally(() => setPending(false));
  };
  const firstIndex = history.length * VSET_PAGE_DEFAULT;
  return (
    <section className="vset-members" aria-label="Vector set members">
      <form
        className="collection-lookup vset-filter"
        onSubmit={(e) => {
          e.preventDefault();
          setPrefix(draft ? binFromString(draft) : undefined);
          setAfter(undefined);
          setHistory([]);
        }}
      >
        <label htmlFor="vset-prefix">Members starting with</label>
        <input id="vset-prefix" className="data" placeholder="Prefix (exact bytes, UTF-8)" value={draft} maxLength={1024} onChange={(e) => setDraft(e.target.value)} data-testid="vset-prefix" />
        <button type="submit" data-testid="vset-prefix-apply">Apply</button>
        {prefix && <button type="button" onClick={() => { setDraft(""); setPrefix(undefined); setAfter(undefined); setHistory([]); }} data-testid="vset-prefix-clear">Clear</button>}
        <label className="checkbox"><input type="checkbox" checked={showAttributes} onChange={(e) => setShowAttributes(e.target.checked)} data-testid="vset-show-attributes" />Show attributes</label>
      </form>
      <ErrorState error={members.error ?? error} />
      {attributes.error ? <ErrorState error={attributes.error} /> : null}
      {own && members.isPending && <Loading label="Reading members…" />}
      {page && (
        page.members.length === 0 ? (
          <Empty compact title={prefix ? "No members start with this prefix here." : "No members on this page."} />
        ) : (
          <div className="table-wrap value-table detail-value-table">
            <table data-testid="vset-members">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Member</th>
                  {showAttributes && <th>Attributes</th>}
                  {writable && <th className="row-actions-col"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {page.members.map((m, i) => (
                  <tr key={`${m.member.enc}:${m.member.data}`}>
                    <td className="num muted">{(firstIndex + i + 1).toLocaleString()}</td>
                    <td>
                      {m.truncated ? (
                        <span className="data" title="The name is longer than the inspector can address; use the console.">{displayBin(m.member, 200)} <small className="muted">(name cut)</small></span>
                      ) : (
                        <button type="button" className="value-cell data vset-member" onClick={() => onOpen(m.member)} data-testid="vset-member-open" aria-label={`Open member ${displayBin(m.member, 100)}`}>
                          {displayBin(m.member, 500)}
                        </button>
                      )}
                    </td>
                    {showAttributes && <td data-testid="vset-attr-cell"><AttributeCell cell={m.truncated ? undefined : attributeOf(m.member)} loading={!m.truncated && attributes.isPending && attributes.fetchStatus !== "idle"} /></td>}
                    {writable && (
                      <td className="row-actions">
                        {!m.truncated && <IconAction label={`Remove member ${displayBin(m.member, 100)}`} danger disabled={pending} icon={<Trash2 size={13} aria-hidden="true" />} onClick={() => remove(m.member)} testId="vset-remove" />}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      <footer className="inspector-foot vset-paging">
        {history.length > 0 && <button type="button" onClick={() => { setAfter(undefined); setHistory([]); }} data-testid="vset-first-page">First page</button>}
        {history.length > 0 && <button type="button" onClick={() => go(history.at(-1), true)} data-testid="vset-prev-page">Previous page</button>}
        <button type="button" disabled={!page?.next} onClick={() => go(page?.next)} data-testid="vset-next-page">Next page</button>
        <span className="page-note" data-testid="vset-page-note">
          {page?.members.length
            ? `Members ${(firstIndex + 1).toLocaleString()}–${(firstIndex + page.members.length).toLocaleString()}${
                // With a prefix the total is the whole set's size, not the number of matches (review v0.4 r1 L5).
                prefix ? ` starting with the prefix (the set has ${setSize.toLocaleString()})` : ` of ${setSize.toLocaleString()}`
              }, in byte order (VRANGE).`
            : ""}
          {page?.nextUnavailable ? " The last name on this page is too long to page from; use the console." : ""}
        </span>
      </footer>
    </section>
  );
}

function SimilaritySearch({ keyName, dim, initialMember, onOpen }: { keyName: Bin; dim: number; initialMember?: Bin; onOpen: (m: Bin) => void }) {
  const db = useDatabase();
  const [mode, setMode] = useState<"element" | "values">("element");
  const [member, setMember] = useState(initialMember ? (initialMember.enc === "utf8" ? initialMember.data : "") : "");
  const [memberBin, setMemberBin] = useState<Bin | undefined>(initialMember?.enc === "base64" ? initialMember : undefined);
  const [vector, setVector] = useState("");
  const [count, setCount] = useState("10");
  const [ef, setEf] = useState("");
  const [filter, setFilter] = useState("");
  const [filterEf, setFilterEf] = useState("");
  const [withAttributes, setWithAttributes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<{ request: Omit<VsetSearchRequest, "key">; response: VsetSearchResponse }>();
  let built: Omit<VsetSearchRequest, "key"> | undefined;
  let invalid = "";
  try {
    const n = (s: string, max: number, label: string) => {
      if (!s.trim()) return undefined;
      const v = Number(s);
      if (!Number.isInteger(v) || v < 1 || v > max) throw new Error(`${label} must be a whole number from 1 to ${max.toLocaleString()}.`);
      return v;
    };
    const values = mode === "values" && vector.trim() ? parseVector(vector) : [];
    if (values.length && dim && values.length !== dim) throw new Error(`This set has ${dim} dimensions; the vector has ${values.length}.`);
    const query: VsetSearchRequest["query"] = mode === "element" ? { element: memberBin ?? binFromString(member) } : { values };
    built = {
      query,
      count: n(count, VSET_SEARCH_COUNT_MAX, "Count") ?? 10,
      ...(n(ef, VSET_SEARCH_EF_MAX, "EF") !== undefined ? { ef: n(ef, VSET_SEARCH_EF_MAX, "EF") } : {}),
      ...(filter.trim() ? { filter: filter.trim() } : {}),
      ...(filter.trim() && n(filterEf, VSET_FILTER_EF_MAX, "Filter effort") !== undefined ? { filterEf: n(filterEf, VSET_FILTER_EF_MAX, "Filter effort") } : {}),
      withAttributes,
    };
  } catch (e) {
    invalid = (e as Error).message;
  }
  const ready = !!built && !invalid && (mode === "element" ? !!(memberBin ?? member) : vector.trim().length > 0);
  const run = () => {
    if (!built || !ready || busy) return;
    const body = built;
    setBusy(true);
    setError(undefined);
    // A new search replaces the last one, so an error never sits above results of a different query.
    setResult(undefined);
    void request<VsetSearchResponse>(dbPath(db.id, "/vectorset/search"), { method: "POST", body: { key: keyName, ...body } })
      .then((response) => setResult({ request: body, response }))
      .catch(setError)
      .finally(() => setBusy(false));
  };
  return (
    <section className="vset-search" aria-label="Similarity search">
      <form className="form vset-search-form" data-testid="vset-search-form" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <fieldset className="vset-mode">
          <legend>Search by</legend>
          <label className="checkbox"><input type="radio" name="vset-mode" checked={mode === "element"} onChange={() => setMode("element")} data-testid="vset-search-by-member" />A member's vector (ELE)</label>
          <label className="checkbox"><input type="radio" name="vset-mode" checked={mode === "values"} onChange={() => setMode("values")} data-testid="vset-search-by-vector" />A vector (VALUES)</label>
        </fieldset>
        {mode === "element" ? (
          <label className="field">
            <span>Member</span>
            {memberBin ? (
              <span className="vset-binary-member">
                <code className="data">{displayBin(memberBin, 200)}</code>
                <button type="button" onClick={() => { setMemberBin(undefined); setMember(""); }}>Type another member</button>
              </span>
            ) : (
              <input className="data" required value={member} maxLength={4096} onChange={(e) => setMember(e.target.value)} data-testid="vset-search-member" />
            )}
          </label>
        ) : (
          <label className="field">
            <span>Vector ({dim} coordinates, separated by commas or spaces)</span>
            <textarea className="data" rows={3} spellCheck={false} value={vector} onChange={(e) => setVector(e.target.value)} data-testid="vset-search-vector" />
          </label>
        )}
        <div className="form-row">
          <label className="field"><span>Results (COUNT, 1–{VSET_SEARCH_COUNT_MAX})</span><input type="number" min={1} max={VSET_SEARCH_COUNT_MAX} value={count} onChange={(e) => setCount(e.target.value)} data-testid="vset-search-count" /></label>
          <label className="field"><span>Exploration (EF, optional, at most {VSET_SEARCH_EF_MAX})</span><input type="number" min={1} max={VSET_SEARCH_EF_MAX} value={ef} onChange={(e) => setEf(e.target.value)} data-testid="vset-search-ef" /></label>
        </div>
        <div className="form-row">
          <label className="field">
            <span>Filter expression (optional)</span>
            <input className="data" placeholder='.year > 2000 and .genre == "drama"' value={filter} maxLength={VSET_FILTER_MAX_CHARS} onChange={(e) => setFilter(e.target.value)} data-testid="vset-search-filter" />
            <small>Evaluated by Redis against each candidate's JSON attributes.</small>
          </label>
          <label className="field"><span>Filter effort (FILTER-EF, default count × 100)</span><input type="number" min={1} max={VSET_FILTER_EF_MAX} value={filterEf} disabled={!filter.trim()} onChange={(e) => setFilterEf(e.target.value)} data-testid="vset-search-filter-ef" /></label>
        </div>
        <label className="checkbox"><input type="checkbox" checked={withAttributes} onChange={(e) => setWithAttributes(e.target.checked)} data-testid="vset-search-attributes" />Include attributes (WITHATTRIBS)</label>
        {invalid && <p className="notice warning" role="status">{invalid}</p>}
        {built && !invalid && <p className="muted">Will run <code className="data" data-testid="vset-search-command">{visibleText(vsimPreview(keyName, built))}</code></p>}
        <ErrorState error={error} />
        <div className="actions">
          <button type="submit" className="primary" disabled={!ready || busy} data-testid="vset-search-submit">
            <Search size={13} aria-hidden="true" />
            {busy ? "Searching…" : "Search"}
          </button>
        </div>
      </form>
      {result && (
        result.response.results.length === 0 ? (
          <Empty compact title={result.request.filter ? "No member matched the filter within the filter effort." : "No results."} />
        ) : (
          <div className="table-wrap value-table detail-value-table">
            <table data-testid="vset-search-results">
              <thead>
                <tr>
                  <th className="num">Rank</th>
                  <th>Member</th>
                  <th className="num" title="1 = identical direction, 0 = opposite">Similarity</th>
                  {result.request.withAttributes && <th>Attributes</th>}
                </tr>
              </thead>
              <tbody>
                {result.response.results.map((r, i) => (
                  <tr key={`${r.member.enc}:${r.member.data}`}>
                    <td className="num muted">{i + 1}</td>
                    <td>
                      {r.truncated ? (
                        <span className="data">{displayBin(r.member, 200)} <small className="muted">(name cut)</small></span>
                      ) : (
                        <button type="button" className="value-cell data vset-member" onClick={() => onOpen(r.member)} data-testid="vset-result-open" aria-label={`Open member ${displayBin(r.member, 100)}`}>{displayBin(r.member, 500)}</button>
                      )}
                    </td>
                    <td className="num"><code>{r.score}</code></td>
                    {result.request.withAttributes && <td><AttributeCell cell={r.attributes} /></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </section>
  );
}

const EMPTY = binFromString("");

function ElementPanel({ keyName, member, writable, onClose, onOpen, onFindSimilar, reload }: {
  keyName: Bin;
  member: Bin;
  writable: boolean;
  onClose: () => void;
  onOpen: (m: Bin) => void;
  onFindSimilar: (m: Bin) => void;
  reload: () => Promise<unknown>;
}) {
  const db = useDatabase();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<unknown>();
  const [removing, setRemoving] = useState(false);
  const element = useQuery({
    queryKey: ["vset", db.id, keyName.enc, keyName.data, "element", member.enc, member.data],
    queryFn: ({ signal }) => request<VsetElementResponse>(dbPath(db.id, "/vectorset/element"), { method: "POST", body: { key: keyName, member }, signal }),
  });
  const d = element.data;
  const name = displayBin(member, 120);
  const remove = () => {
    setRemoving(true);
    setError(undefined);
    void keyOperation(db.id, { op: "vset.remove", key: keyName, member }, `Removes member ${displayBin(member, 200)} and its vector, attributes and graph links.`)
      .then(async () => { onClose(); await reload(); })
      .catch(setError)
      .finally(() => setRemoving(false));
  };
  const embedding = d?.embedding;
  const quantised = d?.quantization && d.quantization !== "f32";
  return (
    <Modal title="Vector set member" className="value-modal vset-element" onClose={onClose} testId="vset-element-dialog">
      <p className="dialog-subject"><code className="data" data-testid="vset-element-name">{displayBin(member, 2000)}</code></p>
      <ErrorState error={element.error} onRetry={() => { void element.refetch(); }} />
      {element.isPending && <Loading label="Reading member…" />}
      {d && (
        <>
          <div className="actions vset-element-actions">
            <button type="button" onClick={() => onFindSimilar(member)} data-testid="vset-find-similar"><Search size={13} aria-hidden="true" />Find similar</button>
            {writable && <button type="button" className="ghost danger-text" disabled={removing} onClick={remove} data-testid="vset-element-remove"><Trash2 size={13} aria-hidden="true" />Remove member</button>}
          </div>
          <ErrorState error={error} />
          <section aria-labelledby="vset-attr-heading" data-testid="vset-attributes">
            <h3 id="vset-attr-heading">Attributes</h3>
            {d.attributesTooLarge ? (
              <p className="notice warning">The attributes are larger than the server reads for this panel (its value cap). Read them in the console with VGETATTR.</p>
            ) : editing ? (
              <InlineEdit
                value={d.attributes ?? EMPTY}
                label="Attributes (JSON; empty removes them)"
                onClose={() => setEditing(false)}
                onReload={() => { setEditing(false); void element.refetch(); }}
                onSave={async (next, expect) => {
                  const text = next.enc === "utf8" ? next.data : new TextDecoder().decode(bytesFromBin(next));
                  if (text.trim()) {
                    try { parseJson(text); } catch { throw new Error("Attributes must be JSON (FILTER expressions read them as a JSON object), or empty to remove them."); }
                  }
                  // The member must still have the attributes this editor opened (compare-and-set).
                  await keyOperation(db.id, { op: "vset.setattr", key: keyName, member, attributes: next, expect: expect ?? { type: "vectorset", sha256: digestBin(d.attributes ?? EMPTY) } });
                  await element.refetch();
                  await reload();
                }}
              />
            ) : d.attributes ? (
              <ValueViewer value={d.attributes} preferred="json" />
            ) : (
              <p className="muted">This member has no attributes.</p>
            )}
            {writable && !editing && !d.attributesTooLarge && (
              <button type="button" onClick={() => setEditing(true)} data-testid="vset-attr-edit">{d.attributes ? "Edit attributes" : "Add attributes"}</button>
            )}
          </section>
          {embedding && (
            <section aria-labelledby="vset-emb-heading" data-testid="vset-embedding">
              <h3 id="vset-emb-heading">Embedding</h3>
              {embedding.skipped ? (
                <p className="notice">This set has {embedding.dim.toLocaleString()} dimensions; the inspector reads embeddings of up to {VSET_EMBED_MAX_DIM.toLocaleString()}. Use VEMB in the console.</p>
              ) : (
                <>
                  <p className="muted">
                    {embedding.values.length.toLocaleString()} of {embedding.dim.toLocaleString()} values (VEMB).
                    {quantised ? " The set is quantised, so these are approximations of the vectors that were added." : ""}
                    {embedding.truncated ? ` Only the first ${embedding.values.length.toLocaleString()} values are shown and copied.` : ""}
                  </p>
                  <pre className="data vset-vector">{embedding.values.join(", ")}</pre>
                  <CopyButton text={() => embedding.values.join(", ")} label={embedding.truncated ? "Copy shown values" : "Copy vector"} />
                </>
              )}
            </section>
          )}
          {d.links && (
            <section aria-labelledby="vset-links-heading" data-testid="vset-links">
              <h3 id="vset-links-heading">Neighbours in the HNSW graph (VLINKS)</h3>
              {d.links.every((l) => !l.neighbours.length) && <p className="muted">No links.</p>}
              {d.links.map((layer) => layer.neighbours.length > 0 && (
                <details key={layer.layer} open={layer.layer === 0} className="vset-layer">
                  <summary>Layer {layer.layer} · {layer.neighbours.length + (layer.more ?? 0)} neighbours{layer.more ? ` (${layer.neighbours.length} shown)` : ""}</summary>
                  <ul>
                    {layer.neighbours.map((n) => (
                      <li key={`${n.member.enc}:${n.member.data}`}>
                        {n.truncated ? <span className="data">{displayBin(n.member, 200)}</span> : (
                          <button type="button" className="link-button data" onClick={() => onOpen(n.member)} aria-label={`Open neighbour ${displayBin(n.member, 100)}`}>{displayBin(n.member, 200)}</button>
                        )}
                        <code className="muted"> {n.score}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
              {d.moreLayers ? <p className="muted">{d.moreLayers} more layers not listed.</p> : null}
            </section>
          )}
          {d.linksTooLarge && <p className="notice">The neighbour lists are larger than the server reads for this panel; use VLINKS in the console.</p>}
        </>
      )}
      <div className="actions"><button type="button" onClick={onClose}><X size={13} aria-hidden="true" />Close</button></div>
      <span className="sr-only">{name}</span>
    </Modal>
  );
}
