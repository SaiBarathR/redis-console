import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import {
  ARRAY_AGGREGATES,
  ARRAY_MAX_INDEX,
  ARRAY_PAGE_MAX,
  ARRAY_PREDICATES_MAX,
  ARRAY_SCAN_MAX_ELEMENTS,
  ARRAY_SEARCH_KINDS,
  isArrayIndex,
  keyToParam,
  type ArrayAggregateRequest,
  type ArrayAggregateResult,
  type ArrayElement,
  type ArrayPage,
  type ArraySearchRequest,
  type ArraySearchResult,
  type Bin,
  type EditConflict,
  type EditExpect,
  type ElementRef,
  type KeyDetails,
  type KeyValue,
} from "@rconsole/shared";
import "./array.css";
import { dbPath, request } from "../lib/api.ts";
import { canWrite, useDatabase } from "../lib/context.tsx";
import { digestBin, sameBin } from "../lib/expect.ts";
import { keyOperation } from "../lib/operations.ts";
import { lineValues } from "../lib/array.ts";
import { ConflictNotice, conflictOf, HandledError } from "./Conflict.tsx";
import { InlineEdit } from "./InlineEdit.tsx";
import { inputBin } from "./KeyOperations.tsx";
import { ActionForm, ErrorState, Field, Loading } from "./ui.tsx";

type ArrayValue = Extract<KeyValue, { type: "array" }>;
/** Which page is shown: a start index (or the far end), a direction and a size. */
interface View { start?: string; reverse: boolean; count: number }
type Row = { kind: "item"; item: ArrayElement } | { kind: "gap"; from: bigint; to: bigint; count: bigint };
type Encoding = "utf8" | "base64";

const PAGE_SIZES = [25, 100, 500, ARRAY_PAGE_MAX];
/** The page `key/read` returns: from index 0, ascending, 100 elements (KeyInspector reads 100). */
const FIRST: View = { reverse: false, count: 100 };
const KIND_LABEL: Record<(typeof ARRAY_SEARCH_KINDS)[number], string> = { exact: "Equals (EXACT)", match: "Contains (MATCH)", glob: "Glob pattern (GLOB)" };
const AGG_LABEL: Record<(typeof ARRAY_AGGREGATES)[number], string> = {
  sum: "Sum (SUM)", min: "Minimum (MIN)", max: "Maximum (MAX)", and: "Bitwise AND", or: "Bitwise OR", xor: "Bitwise XOR",
  used: "Existing elements (USED)", match: "Elements equal to a value (MATCH)",
};

const big = (s: string) => BigInt(s);
const count = (n: bigint | number) => n.toLocaleString("en-US");
/** The element count of a range of positions, with its unit. */
const positions = (n: bigint) => `${count(n)} empty position${n === 1n ? "" : "s"}`;

/** Page rows with the empty positions between existing elements made visible (arrays are sparse). */
export function arrayRows(page: ArrayPage, leadingGap: boolean): Row[] {
  const out: Row[] = [];
  const down = page.reverse;
  let previous: bigint | undefined = leadingGap ? (down ? big(page.start) + 1n : big(page.start) - 1n) : undefined;
  for (const item of page.items) {
    const at = big(item.index);
    if (previous !== undefined) {
      const gap = down ? previous - at - 1n : at - previous - 1n;
      if (gap > 0n) out.push({ kind: "gap", from: down ? previous - 1n : previous + 1n, to: down ? at + 1n : at - 1n, count: gap });
    }
    out.push({ kind: "item", item });
    previous = at;
  }
  return out;
}

/** "a–b" for a range of indices (one index alone when they are equal). */
const span = (a: bigint | string, b: bigint | string) => (String(a) === String(b) ? String(a) : `${a}–${b}`);

function checkIndex(text: string, label: string): string {
  const s = text.trim();
  if (!isArrayIndex(s)) throw new Error(`${label}: enter a whole index from 0 to ${ARRAY_MAX_INDEX}.`);
  return s;
}

/**
 * The array inspector (v0.4, F24): summary, a page of existing elements by index with the gaps between them, paging
 * and jump, search (ARGREP) and aggregates (AROP) over a range, and for operators: edit an element (compare-and-set),
 * append at the insert cursor, set a value at an index, delete an element or a range (server confirmation). Values
 * are text, rendered by the collection cell of the key inspector (formatters, value inspector, full element loads).
 */
export function ArrayDetail({
  details,
  value,
  refresh,
  cell,
}: {
  details: KeyDetails;
  value: ArrayValue;
  refresh: () => Promise<unknown>;
  /** The key inspector's value cell: formatting, the value inspector, and "Load full element" through `ref`. */
  cell: (value: Bin, truncated: boolean, ref: ElementRef) => ReactNode;
}) {
  const db = useDatabase();
  const writable = canWrite(db);
  const info = value.info;
  const lastIndex = big(info.length) > 0n ? String(big(info.length) - 1n) : "0";
  const [view, setView] = useState<View>(FIRST);
  const [history, setHistory] = useState<View[]>([]);
  const [jump, setJump] = useState("");
  const [jumpError, setJumpError] = useState<unknown>();
  const initial = view.start === undefined && !view.reverse && view.count === FIRST.count;
  const range = useQuery({
    queryKey: ["key", db.id, keyToParam(details.key), "array-range", view],
    enabled: !initial,
    queryFn: ({ signal }) =>
      request<ArrayPage>(dbPath(db.id, "/array/range"), { method: "POST", body: { key: details.key, ...view }, signal, background: true }),
  });
  const page: ArrayPage | undefined = initial ? value : range.data;
  const [panel, setPanel] = useState<{ index: string; opened: Bin }>();
  const [changed, setChanged] = useState<string>();
  const [rowError, setRowError] = useState<unknown>();
  const [pending, setPending] = useState<string>();

  // An open editor is bound to the bytes it opened: a page that shows other bytes there (or none) closes it.
  if (panel && page) {
    const now = page.items.find((i) => i.index === panel.index);
    if (!now || now.truncated || !sameBin(now.value, panel.opened)) {
      setPanel(undefined);
      setChanged(`The element at index ${panel.index} changed; reopen it to edit it.`);
    }
  }
  // The key inspector's refresh invalidates every query of this key, the page shown here included.
  const reread = refresh;
  const go = (next: View) => {
    setHistory((h) => [...h, view]);
    setView(next);
    setPanel(undefined);
    setChanged(undefined);
  };
  const reset = (next: View) => {
    setHistory([]);
    setView(next);
    setPanel(undefined);
    setChanged(undefined);
  };
  const remove = (index: string) => {
    if (pending) return;
    setPending(index);
    setRowError(undefined);
    void keyOperation(db.id, { op: "array.delete", key: details.key, indexes: [index] }, `Deletes the element at index ${index} (ARDEL).`)
      .then(reread)
      .catch(setRowError)
      .finally(() => setPending(undefined));
  };

  const rows = page ? arrayRows(page, !(page.reverse && view.start === undefined)) : [];
  const shown = page?.items ?? [];
  const truncated = shown.some((i) => i.truncated);
  const fill = big(info.length) > 0n ? Number((big(info.count) * 10000n) / big(info.length)) / 100 : 0;

  return (
    <div className="array-detail" data-testid="array-detail">
      <dl className="inline-facts" data-testid="array-summary">
        <dt>Elements (ARCOUNT)</dt>
        <dd data-testid="array-count">{count(big(info.count))}</dd>
        <dt>Length (ARLEN)</dt>
        <dd data-testid="array-length" title="Highest index + 1">{count(big(info.length))}</dd>
        <dt>Next insert index</dt>
        <dd data-testid="array-next-insert">{info.nextInsertIndex}</dd>
        <dt>Positions used</dt>
        <dd title="Elements / length: a sparse array has empty positions between its elements">{fill < 0.01 && big(info.count) > 0n ? "< 0.01" : fill}%</dd>
        {info.slices !== undefined && <><dt>Slices</dt><dd>{info.slices}</dd></>}
      </dl>

      <div className="array-nav" role="toolbar" aria-label="Array pages">
        <button type="button" onClick={() => reset({ ...FIRST, count: view.count })} disabled={view.start === undefined && !view.reverse} data-testid="array-first">First</button>
        <button type="button" onClick={() => reset({ reverse: true, count: view.count })} disabled={view.start === undefined && view.reverse} data-testid="array-last">Last (highest first)</button>
        <button type="button" onClick={() => { const previous = history.at(-1); if (previous) { setHistory((h) => h.slice(0, -1)); setView(previous); setPanel(undefined); } }} disabled={!history.length} data-testid="array-prev">Previous</button>
        <button type="button" onClick={() => page?.next && go({ ...view, start: page.next })} disabled={!page?.next} data-testid="array-next">Next</button>
        <form className="array-jump" onSubmit={(event) => {
          event.preventDefault();
          setJumpError(undefined);
          try { go({ start: checkIndex(jump, "Jump to index"), reverse: false, count: view.count }); } catch (error) { setJumpError(error); }
        }}>
          <label>Jump to index <input className="data" inputMode="numeric" value={jump} onChange={(e) => setJump(e.target.value)} placeholder="0" aria-label="Jump to index" data-testid="array-jump-input" /></label>
          <button type="submit" data-testid="array-jump">Go</button>
        </form>
        <label>Page size <select value={view.count} onChange={(e) => setView({ ...view, count: Number(e.target.value) })} aria-label="Array page size" data-testid="array-page-size">
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select></label>
      </div>
      <ErrorState error={jumpError} />
      <ErrorState error={range.error} onRetry={() => void range.refetch()} />
      {changed && <p role="status" className="notice warning">{changed}</p>}
      <ErrorState error={rowError} />
      {truncated && (
        <p className="notice warning">
          Some values are truncated previews: their edit actions are hidden. Open a value and choose Load full element (server capped).
        </p>
      )}
      {!page && range.isPending && <Loading label="Reading array elements…" />}
      {page && (
        <>
          <p className="page-note" data-testid="array-page-note">{pageNote(page)}</p>
          {rows.length ? (
            <div className="table-wrap value-table detail-value-table">
              <table className="array-table" data-testid="array-table">
                <colgroup><col style={{ width: "9rem" }} /><col />{writable && <col style={{ width: "72px" }} />}</colgroup>
                <thead><tr><th className="num">Index</th><th>Value</th>{writable && <th className="row-actions-col"><span className="sr-only">Actions</span></th>}</tr></thead>
                <tbody>
                  {rows.map((row) => row.kind === "gap" ? (
                    <tr key={`gap:${row.from}`} className="array-gap" data-testid="array-gap">
                      <td colSpan={writable ? 3 : 2}>⋯ {positions(row.count)}: {span(row.from, row.to)}</td>
                    </tr>
                  ) : (
                    <ItemRow
                      key={row.item.index}
                      item={row.item}
                      writable={writable}
                      cell={cell}
                      editing={panel?.index === row.item.index}
                      busy={pending === row.item.index}
                      onEdit={() => { setChanged(undefined); setPanel(panel?.index === row.item.index ? undefined : { index: row.item.index, opened: row.item.value }); }}
                      onDelete={() => remove(row.item.index)}
                      editor={panel?.index === row.item.index ? (
                        <InlineEdit
                          key={row.item.index}
                          value={panel.opened}
                          label={`Value at index ${row.item.index}`}
                          onClose={() => setPanel(undefined)}
                          onReload={() => { setPanel(undefined); void reread(); }}
                          onSave={async (next, expect) => {
                            await keyOperation(db.id, { op: "array.set", key: details.key, index: row.item.index, value: next, expect: expect ?? { type: "array", sha256: digestBin(panel.opened) } });
                            await reread();
                          }}
                        />
                      ) : undefined}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty compact" data-testid="array-empty-page">No elements from index {page.start} {page.reverse ? "down" : "up"} to {page.end}.</p>
          )}
        </>
      )}

      <ArraySearch keyName={details.key} lastIndex={lastIndex} cell={cell} onShow={(index) => go({ start: index, reverse: false, count: view.count })} />
      <ArrayAggregate keyName={details.key} lastIndex={lastIndex} />
      {writable && <ArrayWrites keyName={details.key} info={info} page={page} reread={reread} />}
    </div>
  );
}

function pageNote(page: ArrayPage) {
  if (!page.items.length) return "No elements on this page.";
  const first = page.items[0]!.index, last = page.items.at(-1)!.index;
  return `${count(page.items.length)} element${page.items.length === 1 ? "" : "s"} at indices ${span(first, last)}, ${page.reverse ? "highest first" : "lowest first"}.${page.next ? ` The next page starts at index ${page.next}.` : " End of the array in this direction."}`;
}

function ItemRow({ item, writable, cell, editing, busy, onEdit, onDelete, editor }: {
  item: ArrayElement; writable: boolean; cell: (value: Bin, truncated: boolean, ref: ElementRef) => ReactNode;
  editing: boolean; busy: boolean; onEdit: () => void; onDelete: () => void; editor?: ReactNode;
}) {
  return (
    <>
      <tr data-testid="array-row">
        <td className="num"><code>{item.index}</code></td>
        <td>{cell(item.value, !!item.truncated, item.ref)}</td>
        {writable && (
          <td className="row-actions">
            {!item.truncated && (
              <button type="button" className="icon-button row-button" aria-label={`Edit index ${item.index}`} title={`Edit index ${item.index}`} aria-pressed={editing} onClick={onEdit} data-testid="array-row-edit">
                <Pencil size={13} aria-hidden="true" />
              </button>
            )}
            <button type="button" className="icon-button row-button danger-text" aria-label={`Delete index ${item.index}`} title={`Delete index ${item.index} (asks the server for confirmation)`} disabled={busy} onClick={onDelete} data-testid="array-row-delete">
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </td>
        )}
      </tr>
      {editor && <tr className="row-panel-line"><td colSpan={3}>{editor}</td></tr>}
    </>
  );
}

/** A start/end pair of index inputs. */
function RangeFields({ start, end, onStart, onEnd, prefix }: { start: string; end: string; onStart: (s: string) => void; onEnd: (s: string) => void; prefix: string }) {
  return (
    <div className="form-row">
      <Field label="From index"><input className="data" inputMode="numeric" required value={start} onChange={(e) => onStart(e.target.value)} data-testid={`${prefix}-start`} /></Field>
      <Field label="To index (inclusive)"><input className="data" inputMode="numeric" required value={end} onChange={(e) => onEnd(e.target.value)} data-testid={`${prefix}-end`} /></Field>
    </div>
  );
}

interface Predicate { kind: (typeof ARRAY_SEARCH_KINDS)[number]; text: string; enc: Encoding }

/** ARGREP over a range: conditions, AND/OR, case, limit; results continue from where the search stopped. */
function ArraySearch({ keyName, lastIndex, cell, onShow }: { keyName: Bin; lastIndex: string; cell: (value: Bin, truncated: boolean, ref: ElementRef) => ReactNode; onShow: (index: string) => void }) {
  const db = useDatabase();
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState(lastIndex);
  const [predicates, setPredicates] = useState<Predicate[]>([{ kind: "match", text: "", enc: "utf8" }]);
  const [combine, setCombine] = useState<"or" | "and">("or");
  const [nocase, setNocase] = useState(false);
  const [limit, setLimit] = useState(100);
  const [found, setFound] = useState<{ request: ArraySearchRequest; result: ArraySearchResult }>();
  const [more, setMore] = useState<{ busy: boolean; error?: unknown }>({ busy: false });
  const run = async (body: ArraySearchRequest) => {
    const result = await request<ArraySearchResult>(dbPath(db.id, "/array/search"), { method: "POST", body });
    setFound({ request: body, result });
  };
  const update = (i: number, change: Partial<Predicate>) => setPredicates((list) => list.map((p, j) => (j === i ? { ...p, ...change } : p)));
  return (
    <details className="array-tool" data-testid="array-search">
      <summary>Search values (ARGREP)</summary>
      <ActionForm label="Search" testId="array-search-submit" onSubmit={() => run({
        key: keyName, start: checkIndex(start, "From index"), end: checkIndex(end, "To index"),
        predicates: predicates.map((p) => ({ kind: p.kind, value: inputBin(p.text, p.enc) })), combine, nocase, limit,
      })}>
        <RangeFields start={start} end={end} onStart={setStart} onEnd={setEnd} prefix="array-search" />
        {predicates.map((p, i) => (
          <div className="form-row array-predicate" key={i}>
            <Field label={`Condition ${i + 1}`}>
              <select value={p.kind} onChange={(e) => update(i, { kind: e.target.value as Predicate["kind"] })} data-testid="array-search-kind">
                {ARRAY_SEARCH_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </Field>
            <Field label="Value"><input className="data" value={p.text} onChange={(e) => update(i, { text: e.target.value })} placeholder={p.kind === "glob" ? "e.g. user:*" : ""} data-testid="array-search-value" /></Field>
            <Field label="Encoding">
              <select value={p.enc} onChange={(e) => update(i, { enc: e.target.value as Encoding })} aria-label={`Condition ${i + 1} encoding`}>
                <option value="utf8">UTF-8</option><option value="base64">Base64</option>
              </select>
            </Field>
            {predicates.length > 1 && <button type="button" className="ghost" onClick={() => setPredicates((list) => list.filter((_, j) => j !== i))} aria-label={`Remove condition ${i + 1}`}>Remove</button>}
          </div>
        ))}
        <div className="actions">
          <button type="button" disabled={predicates.length >= ARRAY_PREDICATES_MAX} onClick={() => setPredicates((list) => [...list, { kind: "match", text: "", enc: "utf8" }])} data-testid="array-search-add">Add condition</button>
          <label>Match <select value={combine} onChange={(e) => setCombine(e.target.value as "or" | "and")} aria-label="Combine conditions" data-testid="array-search-combine">
            <option value="or">any condition (OR)</option><option value="and">all conditions (AND)</option>
          </select></label>
          <label className="checkbox"><input type="checkbox" checked={nocase} onChange={(e) => setNocase(e.target.checked)} data-testid="array-search-nocase" /> Ignore case (NOCASE)</label>
          <label>Up to <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Search result limit">{PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}</select> matches</label>
        </div>
        <p className="muted">
          A search visits at most {count(ARRAY_SCAN_MAX_ELEMENTS)} elements per request and then offers to continue. Regular expressions (RE) are not
          available: Redis runs them without a time limit, and one pattern can block the server.
        </p>
      </ActionForm>
      {found && (
        <div className="array-results" data-testid="array-search-results">
          <p role="status" data-testid="array-search-summary">
            {count(found.result.items.length)} match{found.result.items.length === 1 ? "" : "es"} in indices {span(found.result.start, found.result.searchedTo)} ({count(found.result.elements)} elements searched).
            {found.result.next ? ` More of the range is left from index ${found.result.next}.` : " The whole range was searched."}
          </p>
          {!!found.result.items.length && (
            <table className="array-table">
              <thead><tr><th className="num">Index</th><th>Value</th></tr></thead>
              <tbody>{found.result.items.map((m) => (
                <tr key={m.index} data-testid="array-search-match">
                  <td className="num"><button type="button" className="ghost" onClick={() => onShow(m.index)} title="Show this index in the element table"><code>{m.index}</code></button></td>
                  <td>{m.value && m.ref ? cell(m.value, !!m.truncated, m.ref) : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {found.result.next && (
            <div className="actions">
              <button type="button" disabled={more.busy} data-testid="array-search-continue" onClick={() => {
                setMore({ busy: true });
                void run({ ...found.request, start: found.result.next! }).then(() => setMore({ busy: false }), (error: unknown) => setMore({ busy: false, error }));
              }}>{more.busy ? "Searching…" : `Continue from index ${found.result.next}`}</button>
            </div>
          )}
          <ErrorState error={more.error} />
        </div>
      )}
    </details>
  );
}

/** AROP over a range. */
function ArrayAggregate({ keyName, lastIndex }: { keyName: Bin; lastIndex: string }) {
  const db = useDatabase();
  const [start, setStart] = useState("0");
  const [end, setEnd] = useState(lastIndex);
  const [op, setOp] = useState<(typeof ARRAY_AGGREGATES)[number]>("sum");
  const [text, setText] = useState("");
  const [enc, setEnc] = useState<Encoding>("utf8");
  const [result, setResult] = useState<{ range: string; result: ArrayAggregateResult }>();
  return (
    <details className="array-tool" data-testid="array-aggregate">
      <summary>Aggregate a range (AROP)</summary>
      <ActionForm label="Compute" testId="array-aggregate-submit" onSubmit={async () => {
        const body: ArrayAggregateRequest = { key: keyName, start: checkIndex(start, "From index"), end: checkIndex(end, "To index"), op, ...(op === "match" ? { value: inputBin(text, enc) } : {}) };
        const out = await request<ArrayAggregateResult>(dbPath(db.id, "/array/aggregate"), { method: "POST", body });
        setResult({ range: span(body.start, body.end), result: out });
      }}>
        <RangeFields start={start} end={end} onStart={setStart} onEnd={setEnd} prefix="array-aggregate" />
        <div className="form-row">
          <Field label="Operation">
            <select value={op} onChange={(e) => setOp(e.target.value as typeof op)} data-testid="array-aggregate-op">
              {ARRAY_AGGREGATES.map((o) => <option key={o} value={o}>{AGG_LABEL[o]}</option>)}
            </select>
          </Field>
          {op === "match" && <>
            <Field label="Value"><input className="data" value={text} onChange={(e) => setText(e.target.value)} data-testid="array-aggregate-value" /></Field>
            <Field label="Encoding"><select value={enc} onChange={(e) => setEnc(e.target.value as Encoding)} aria-label="Aggregate value encoding"><option value="utf8">UTF-8</option><option value="base64">Base64</option></select></Field>
          </>}
        </div>
        <p className="muted">Numeric operations skip values that are not numbers. Ranges with more than {count(ARRAY_SCAN_MAX_ELEMENTS)} elements are refused: narrow the range.</p>
      </ActionForm>
      {result && (
        <p role="status" className="array-aggregate-result" data-testid="array-aggregate-result">
          {AGG_LABEL[result.result.op]} over indices {result.range} ({count(result.result.elements)} elements): <code className="data">{result.result.result ?? "no value (nothing in range it could use)"}</code>
        </p>
      )}
    </details>
  );
}

/** Operator actions: append at the insert cursor, set a value at an index, delete a range. */
function ArrayWrites({ keyName, info, page, reread }: { keyName: Bin; info: ArrayValue["info"]; page: ArrayPage | undefined; reread: () => Promise<unknown> }) {
  const db = useDatabase();
  const [values, setValues] = useState("");
  const [valuesEnc, setValuesEnc] = useState<Encoding>("utf8");
  const [index, setIndex] = useState(isArrayIndex(info.length) ? info.length : "");
  const [atValue, setAtValue] = useState("");
  const [atEnc, setAtEnc] = useState<Encoding>("utf8");
  const [conflict, setConflict] = useState<EditConflict>();
  const [busy, setBusy] = useState(false);
  const [overwriteError, setOverwriteError] = useState<unknown>();
  const [from, setFrom] = useState("0");
  const [to, setTo] = useState(big(info.length) > 0n ? String(big(info.length) - 1n) : "0");
  const cursorInside = big(info.nextInsertIndex) < big(info.length);
  const setAt = async (expect?: EditExpect) => {
    const at = checkIndex(index, "Index");
    const shown = page?.items.find((i) => i.index === at);
    if (!expect && shown?.truncated) throw new Error("The element at this index is a truncated preview here: open it in the value inspector, load the full element and edit it there.");
    await keyOperation(db.id, { op: "array.set", key: keyName, index: at, value: inputBin(atValue, atEnc), expect: expect ?? { type: "array", sha256: shown ? digestBin(shown.value) : null } });
    setConflict(undefined);
    await reread();
  };
  return (
    <>
      <details className="array-tool" data-testid="array-append">
        <summary>Append values (ARINSERT)</summary>
        <ActionForm label="Append" testId="array-append-submit" onSubmit={async () => {
          await keyOperation(db.id, { op: "array.insert", key: keyName, values: lineValues(values, valuesEnc), expect: { type: "array" } });
          setValues("");
          await reread();
        }}>
          <p className="muted">
            ARINSERT writes at the insert cursor, index <code>{info.nextInsertIndex}</code>, and moves it. It would overwrite elements already there, so the
            server refuses the append when any position it writes holds a value.
            {cursorInside && " The cursor is inside the array here; use Set value at index to add after the last element."}
          </p>
          <Field label="Values, one per line"><textarea className="data" rows={3} required value={values} onChange={(e) => setValues(e.target.value)} data-testid="array-append-values" /></Field>
          <Field label="Encoding (per line)"><select value={valuesEnc} onChange={(e) => setValuesEnc(e.target.value as Encoding)} aria-label="Append values encoding"><option value="utf8">UTF-8 text</option><option value="base64">Base64 bytes</option></select></Field>
        </ActionForm>
      </details>
      <details className="array-tool" data-testid="array-set">
        <summary>Set value at index (ARSET)</summary>
        <ActionForm label="Set value" testId="array-set-submit" disabled={!!conflict} onSubmit={async () => {
          try {
            await setAt();
          } catch (error) {
            const found = conflictOf(error);
            if (!found) throw error;
            setConflict(found);
            throw new HandledError("conflict");
          }
        }}>
          <p className="muted">The index defaults to the array length: the first position after the last element. A value someone else wrote there in the meantime is shown before anything is replaced.</p>
          <Field label="Index"><input className="data" inputMode="numeric" required value={index} onChange={(e) => { setIndex(e.target.value); setConflict(undefined); }} data-testid="array-set-index" /></Field>
          <Field label="Value"><textarea className="data" rows={3} value={atValue} onChange={(e) => setAtValue(e.target.value)} data-testid="array-set-value" /></Field>
          <Field label="Encoding"><select value={atEnc} onChange={(e) => setAtEnc(e.target.value as Encoding)} aria-label="Set value encoding"><option value="utf8">UTF-8 text</option><option value="base64">Base64 bytes</option></select></Field>
          {conflict && (
            <ConflictNotice
              conflict={conflict}
              title={`Index ${index.trim()} holds another value than this page showed.`}
              busy={busy}
              onReload={() => { setConflict(undefined); void reread(); }}
              onOverwrite={conflict.reason === "type" ? undefined : (expect) => {
                setBusy(true);
                setOverwriteError(undefined);
                void setAt(expect).catch((error: unknown) => { const found = conflictOf(error); if (found) setConflict(found); else setOverwriteError(error); }).finally(() => setBusy(false));
              }}
            />
          )}
          <ErrorState error={overwriteError} />
        </ActionForm>
      </details>
      <details className="array-tool" data-testid="array-delete-range">
        <summary>Delete a range (ARDELRANGE)</summary>
        <ActionForm label="Delete range…" danger testId="array-delete-range-submit" onSubmit={async () => {
          const start = checkIndex(from, "From index"), end = checkIndex(to, "To index");
          const used = await request<ArrayAggregateResult>(dbPath(db.id, "/array/aggregate"), { method: "POST", body: { key: keyName, start, end, op: "used" } });
          await keyOperation(db.id, { op: "array.delete-range", key: keyName, start, end }, `${count(used.elements)} element${used.elements === 1 ? "" : "s"} existed in this range when it was counted.`);
          await reread();
        }}>
          <RangeFields start={from} end={to} onStart={setFrom} onEnd={setTo} prefix="array-delete-range" />
          <p className="muted">The server asks for confirmation and shows the exact command first. Deleting every element deletes the key.</p>
        </ActionForm>
      </details>
    </>
  );
}
