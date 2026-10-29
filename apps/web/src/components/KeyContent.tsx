import { cloneElement, isValidElement, createContext, Fragment, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Pencil, Timer, Trash2 } from "lucide-react";
import {
  binFromString,
  bytesFromBin,
  type Bin,
  type ElementRef,
  type KeyElementResponse,
  type KeyDetails,
  type KeyOp,
  type KeyValue,
} from "@rconsole/shared";
import "./detail.css";
import { dbPath, request } from "../lib/api.ts";
import { canWrite, useDatabase } from "../lib/context.tsx";
import { digestBin, sameBin } from "../lib/expect.ts";
import { bytesLabel, displayBin, epochLabel, visibleText, formatValue, type ValueFormat } from "../lib/format.ts";
import { keyOperation } from "../lib/operations.ts";
import { Chart } from "./Chart.tsx";
import { HashExpiry } from "./HashExpiry.tsx";
import { InlineEdit } from "./InlineEdit.tsx";
import { Empty, ErrorState, Modal } from "./ui.tsx";
import { StreamInspector } from "./StreamInspector.tsx";
import { VectorSetDetail } from "./VectorSetDetail.tsx";
import { ArrayDetail } from "./ArrayDetail.tsx";
import { FORMATS, ValueViewer } from "./ValueViewer.tsx";

/**
 * An open row panel is bound to the element it edits (hash field, list index, zset member), never to its row
 * position: a refresh or a page change that moves another element under that row must not retarget the editor.
 * An edit panel also keeps the bytes it opened (`opened`): a refresh that shows other bytes for that element, or
 * none, closes it (web review v0.2 r2 H2 for lists, r3 H1 for hash fields and scores).
 */
type Panel = { id: string; kind: "edit" | "ttl"; opened?: Bin };
const elementId = (bin: Bin, ref?: ElementRef) =>
  ref?.kind === "scan" || ref?.kind === "rank" ? `identity:${ref.identity}` : `${bin.enc}:${bin.data}`;

/** The element an edit panel is bound to, as the current page shows it (a score as its text). */
/** Types whose unsupported-value message already names the command to use (see the server's hintFor). */
const UNSUPPORTED_TYPES: Record<string, { name: string; hint: string }> = {
  "MBbloom--": { name: "Bloom filter", hint: "BF.INFO" },
  MBbloomCF: { name: "Cuckoo filter", hint: "CF.INFO" },
  "CMSk-TYPE": { name: "Count-min sketch", hint: "CMS.INFO" },
  "TopK-TYPE": { name: "Top-K", hint: "TOPK.INFO or TOPK.LIST" },
  "TDIS-TYPE": { name: "t-digest", hint: "TDIGEST.INFO" },
};
const hasTypeHint = (type: string) => type === "graphdata" || type.startsWith("MBbloom");

function elementOf(value: KeyValue, id: string): { value: Bin; truncated?: boolean } | undefined {
  if (value.type === "hash" && id.startsWith("field:")) {
    const entry = value.entries.find((e) => `field:${elementId(e.field, e.ref)}` === id);
    return entry && { value: entry.value, truncated: entry.truncated };
  }
  if (value.type === "list" && id.startsWith("index:")) {
    const index = Number(id.slice(6));
    const item = value.items.find((i) => i.index === index);
    return item && { value: item.value, truncated: item.truncated };
  }
  if (value.type === "zset" && id.startsWith("member:")) {
    const member = value.members.find((m) => `member:${elementId(m.member, m.ref)}` === id);
    return member && { value: binFromString(member.score), truncated: member.truncated };
  }
  return undefined;
}
const CHANGED: Partial<Record<KeyValue["type"], string>> = {
  list: "This list changed; reopen the element to edit it.",
  hash: "This field changed; reopen it to edit it.",
  zset: "This member's score changed; reopen it to edit it.",
};
const ColumnWidths = createContext<{ width?: number; set: (n: number) => void } | null>(null);
const RowExpansion = createContext<{ selected?: number; column: number; noun: string; toggle: () => void } | null>(null);
/** "Field" → "field": the collection toggles name what they expand. */
const nounOf = (column: string | undefined) => (column ?? "value").toLowerCase();

interface Row {
  /** Element identity, so a reordered page keeps an open panel (and its draft) mounted. */
  id?: string;
  cells: ReactNode[];
  actions?: ReactNode;
  panel?: ReactNode;
}

/** An ISO timestamp that wraps only between its date and its time, never inside "2026-10-29". */
function IsoTime({ iso }: { iso: string }) {
  const at = iso.indexOf("T") + 1;
  return at > 0 ? <><span className="nowrap">{iso.slice(0, at)}</span><wbr /><span className="nowrap">{iso.slice(at)}</span></> : <>{iso}</>;
}

/** Dense element table; a row's edit or field-TTL panel opens on a full-width line under it. */
function ValueTable({
  columns,
  rows,
  numeric = [],
  empty,
  firstShare,
}: {
  columns: string[];
  rows: Row[];
  numeric?: number[];
  empty: string;
  /** The first column's default share (%) of the row, before the user drags the width control. */
  firstShare?: number;
}) {
  const [expanded, setExpanded] = useState<{ row: string | number; column: number }>();
  const tableRef = useRef<HTMLTableElement>(null);
  const [tableWidth, setTableWidth] = useState(0);
  const hasRows = rows.length > 0;
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const measure = () => setTableWidth(table.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    return () => observer.disconnect();
  }, [hasRows]);
  const [localWidth, setLocalWidth] = useState<number>();
  const widths = useContext(ColumnWidths);
  // Until the user drags the control, a short numeric column (list index, score, sample value) gets a small share
  // of the row; otherwise the first column takes about a third.
  const firstWidth = (widths ? widths.width : localWidth) ?? firstShare ?? (numeric.includes(0) ? 15 : numeric.includes(1) ? 75 : 35);
  const setFirstWidth = widths?.set ?? setLocalWidth;
  if (!rows.length) return <Empty compact title={empty} />;
  const hasActions = rows.some((row) => row.actions);
  const ttlColumn = columns[2] === "Field TTL";
  const reservedWidth = (hasActions ? 96 : 0) + (ttlColumn ? 112 : 0);
  return (
    <div className="table-wrap value-table detail-value-table">
      {columns.length > 1 && <label className="column-width-control">{columns[0]} / {columns[1]} widths <input type="range" min="15" max="80" aria-label={`${columns[0]} column width`} value={firstWidth} onChange={e => setFirstWidth(Number(e.target.value))} /></label>}
      <table ref={tableRef} style={{ tableLayout: "fixed", width: "100%" }}>
        <colgroup>{columns.map((_, i) => <col key={i} style={i === 0 && columns.length > 1 ? { width: tableWidth ? `${Math.max(0, tableWidth - reservedWidth) * firstWidth / 100}px` : `${firstWidth}%` } : i === 2 && ttlColumn ? { width: "112px" } : undefined} />)}{hasActions && <col style={{ width: "96px" }} />}</colgroup>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index} className={numeric.includes(index) ? "num" : ""}>
                {column}
              </th>
            ))}
            {hasActions && (
              <th className="row-actions-col">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <Fragment key={row.id ?? index}>
              <tr>
                {row.cells.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className={numeric.includes(cellIndex) ? "num" : ""}
                  >
                    <RowExpansion value={isValidElement(cell) && cell.type === CollectionCell ? {
                      selected: expanded?.row === (row.id ?? index) ? expanded.column : undefined,
                      column: cellIndex,
                      noun: nounOf(columns[cellIndex]),
                      toggle: () => setExpanded(current =>
                        current?.row === (row.id ?? index) && current.column === cellIndex
                          ? undefined : { row: row.id ?? index, column: cellIndex }),
                    } : null}>{cell}</RowExpansion>
                  </td>
                ))}
                {hasActions && <td className="row-actions">{row.actions}</td>}
              </tr>
              {expanded?.row === (row.id ?? index) && isValidElement<{ expandedOnly?: boolean }>(row.cells[expanded.column]) && (
                <tr className="row-panel-line collection-detail-line">
                  <td colSpan={columns.length + (hasActions ? 1 : 0)}>
                    <div className="collection-detail-heading"><strong>{columns[expanded.column]}</strong><button type="button" className="ghost" onClick={() => setExpanded(undefined)}>Collapse {nounOf(columns[expanded.column])}</button></div>
                    {cloneElement(row.cells[expanded.column] as React.ReactElement<{ expandedOnly?: boolean }>, { expandedOnly: true, key: `${row.id ?? index}:${expanded.column}` })}
                  </td>
                </tr>
              )}
              {row.panel && (
                <tr className="row-panel-line">
                  <td colSpan={columns.length + (hasActions ? 1 : 0)}>
                    {row.panel}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowButton({
  label,
  icon,
  onClick,
  danger = false,
  disabled = false,
  pressed,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button row-button ${danger ? "danger-text" : ""}`.trim()}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

/**
 * The value of a key, by type. Strings and JSON use the formatter tabs; collections are tables whose cells open
 * the value inspector. Everything is text: Redis data is never rendered as markup.
 */
export function KeyContent({
  details,
  refresh, valueFormat, onValueFormat, columnWidth, onColumnWidth,
}: {
  valueFormat?: ValueFormat; onValueFormat?: (f: ValueFormat) => void;
  columnWidth?: number; onColumnWidth?: (n: number) => void;
  details: KeyDetails;
  refresh: () => Promise<unknown>;
}) {
  const db = useDatabase();
  const writable = canWrite(db);
  const value = details.value;
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  /** The value inspector's element, with the server's truncation flag (review r3 M2). */
  const [inspected, setInspected] = useState<{ value: Bin; truncated: boolean; ref?: ElementRef; part?: "value" | "identity"; identity?: Bin; score?: string }>();
  const [editingFull, setEditingFull] = useState(false);
  const [localFormat, setLocalFormat] = useState<ValueFormat>("text");
  const format = valueFormat ?? localFormat, setFormat = onValueFormat ?? setLocalFormat;
  const [fullBusy, setFullBusy] = useState(false);
  const [fullError, setFullError] = useState<unknown>();
  const [panel, setPanel] = useState<Panel>();
  const [changed, setChanged] = useState<string>();
  if (panel?.kind === "edit") {
    const now = elementOf(value, panel.id);
    if (!panel.opened && now && !now.truncated) setPanel({ ...panel, opened: now.value });
    else if (!now || now.truncated || (panel.opened && !sameBin(now.value, panel.opened))) {
      setPanel(undefined);
      setChanged(CHANGED[value.type]);
    }
  }
  const toggle = (id: string, kind: Panel["kind"], opened?: Bin) =>
    setPanel((current) =>
      current?.id === id && current.kind === kind ? undefined : { id, kind, ...(opened ? { opened } : {}) },
    );
  /** Reload after a conflict: re-read the key, then reopen the editor on the element as it is now. */
  const reload = (id: string) => async () => {
    setPanel(undefined);
    setChanged(undefined);
    await refresh();
    setPanel({ id, kind: "edit" });
  };
  const open = (id: string, kind: Panel["kind"]) =>
    panel?.id === id && panel.kind === kind;
  const remove = (operation: KeyOp) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    void keyOperation(db.id, operation)
      .then(refresh)
      .catch(setError)
      .finally(() => setPending(false));
  };
  const cell = (bin: Bin, truncated = false, ref?: ElementRef, part?: "value" | "identity", formatted = false) => (
    <CollectionCell value={bin} truncated={truncated} format={formatted ? format : "text"} open={() => { setFullError(undefined); setEditingFull(false); setInspected({ value: bin, truncated, ref, part }); }} />
  );
  const removeButton = (
    operation: KeyOp,
    truncated = false,
    label = "Remove entry",
  ) =>
    writable && !truncated ? (
      <RowButton
        label={label}
        danger
        disabled={pending}
        icon={<Trash2 size={13} aria-hidden="true" />}
        onClick={() => remove(operation)}
      />
    ) : null;
  const editButton = (id: string, label: string, opened: Bin, truncated?: boolean) =>
    writable && !truncated ? (
      <RowButton
        label={label}
        pressed={open(id, "edit")}
        icon={<Pencil size={13} aria-hidden="true" />}
        onClick={() => toggle(id, "edit", opened)}
      />
    ) : null;
  let result: ReactNode;
  switch (value.type) {
    case "string":
      result = (
        <>
          {value.truncated && (
            <div className="notice warning">
              Preview truncated: showing the first{" "}
              {bytesLabel(bytesFromBin(value.value).length)} of{" "}
              {bytesLabel(value.totalBytes)}. Use Load full value below to read up
              to the server cap.
            </div>
          )}
          <ValueViewer value={value.value} truncated={value.truncated} />
        </>
      );
      break;
    case "json":
      result = (
        <>
          {value.truncated && (
            <div className="notice warning">
              JSON preview truncated. Load the full value, or read a smaller path
              in the console with JSON.GET.
            </div>
          )}
          <ValueViewer
            value={binFromString(value.json)}
            truncated={value.truncated}
            preferred="json"
          />
        </>
      );
      break;
    case "hash":
      result = (
        <ValueTable
          columns={["Field", "Value", "Field TTL"]}
          empty="This page has no fields. Go back to the first page."
          rows={value.entries.map((entry) => {
            const label = displayBin(entry.field, 100);
            const id = `field:${elementId(entry.field, entry.ref)}`;
            return {
              id,
              cells: [cell(entry.field, !!entry.fieldTruncated, entry.ref, "identity"), cell(entry.value, entry.truncated, entry.ref, "value", true), <span title={details.hashFieldExpiry?.reason}>{details.hashFieldExpiry?.supported === false ? "Unavailable" : entry.ttl === undefined ? "—" : entry.ttl === -1 ? "No expiry" : entry.ttl === -2 ? "Missing" : `${entry.ttl}s`}</span>],
              actions: (
                <>
                  {editButton(id, `Edit hash field ${label}`, entry.value, entry.truncated)}
                  {!entry.fieldTruncated && (
                    <RowButton
                      label={details.hashFieldExpiry?.supported === false ? `Field TTL unavailable: ${details.hashFieldExpiry.reason}` : `Field TTL for ${label}`}
                      disabled={details.hashFieldExpiry?.supported === false}
                      pressed={open(id, "ttl")}
                      icon={<Timer size={13} aria-hidden="true" />}
                      onClick={() => toggle(id, "ttl")}
                    />
                  )}
                  {removeButton(
                    { op: "hash.delete", key: details.key, fields: [entry.field] },
                    entry.truncated,
                  )}
                </>
              ),
              panel: open(id, "edit") && panel?.opened ? (
                <InlineEdit
                  key={id}
                  value={panel.opened}
                  label={`Value of ${label}`}
                  onClose={() => setPanel(undefined)}
                  onReload={reload(id)}
                  onSave={async (next, expect) => {
                    await keyOperation(db.id, {
                      op: "hash.set",
                      key: details.key,
                      entries: [{ field: entry.field, value: next }],
                      expect: expect ?? { type: details.type, sha256: digestBin(panel.opened!) },
                    });
                    await refresh();
                  }}
                />
              ) : open(id, "ttl") ? (
                <HashExpiry
                  key={id}
                  keyName={details.key}
                  field={entry.field}
                  initialTtl={entry.ttl}
                  refresh={refresh}
                  onClose={() => setPanel(undefined)}
                />
              ) : undefined,
            };
          })}
        />
      );
      break;
    case "list":
      result = (
        <>
        <ValueTable
          columns={["Index", "Value"]}
          numeric={[0]}
          empty="No items at this offset. Go back to the first page."
          rows={value.items.map((item) => ({
            id: `index:${item.index}`,
            cells: [item.index, cell(item.value, item.truncated, item.ref, "value", true)],
            actions: (
              <>
                {editButton(
                  `index:${item.index}`,
                  `Edit list index ${item.index}`,
                  item.value,
                  item.truncated,
                )}
                {removeButton(
                  {
                    op: "list.remove",
                    key: details.key,
                    value: item.value,
                    count: 1,
                  },
                  item.truncated,
                  "Remove first matching list value",
                )}
              </>
            ),
            panel: open(`index:${item.index}`, "edit") && panel?.opened ? (
              <InlineEdit
                key={`index:${item.index}`}
                value={panel.opened}
                label={`Value at index ${item.index}`}
                onClose={() => setPanel(undefined)}
                onReload={reload(`index:${item.index}`)}
                onSave={async (next, expect) => {
                  await keyOperation(db.id, {
                    op: "list.set",
                    key: details.key,
                    index: item.index,
                    value: next,
                    expect: expect ?? { type: details.type, sha256: digestBin(panel.opened!) },
                  });
                  await refresh();
                }}
              />
            ) : undefined,
          }))}
        />
        </>
      );
      break;
    case "set":
      result = (
        <ValueTable
          columns={["Member"]}
          empty="This page has no members. Go back to the first page."
          rows={value.members.map((member, i) => ({
            id: elementId(member, value.memberRefs?.[i]),
            cells: [cell(member, !!value.truncatedMembers, value.memberRefs?.[i], "value", true)],
            actions: removeButton(
              { op: "set.remove", key: details.key, members: [member] },
              !!value.truncatedMembers,
            ),
          }))}
        />
      );
      break;
    case "zset":
      result = (
        <ValueTable
          columns={["Member", "Score"]}
          numeric={[1]}
          empty="No members at this offset. Go back to the first page."
          rows={value.members.map((member) => ({
            id: `member:${elementId(member.member, member.ref)}`,
            cells: [
              cell(member.member, member.truncated, member.ref, "value", true),
              <code title={member.score}>
                {member.score}
                {epochLabel(member.score) && <small className="muted"> · Timestamp hint: {epochLabel(member.score)}</small>}
              </code>,
            ],
            actions: (
              <>
                {editButton(
                  `member:${elementId(member.member, member.ref)}`,
                  `Edit score for ${displayBin(member.member, 100)}`,
                  binFromString(member.score),
                  member.truncated,
                )}
                {removeButton(
                  { op: "zset.remove", key: details.key, members: [member.member] },
                  member.truncated,
                )}
              </>
            ),
            panel: open(`member:${elementId(member.member, member.ref)}`, "edit") && panel?.opened ? (
              <InlineEdit
                key={`member:${elementId(member.member, member.ref)}`}
                value={panel.opened}
                label={`Score of ${displayBin(member.member, 100)}`}
                onClose={() => setPanel(undefined)}
                onReload={reload(`member:${elementId(member.member, member.ref)}`)}
                onSave={async (next, expect) => {
                  if (
                    next.enc !== "utf8" ||
                    !/^[-+]?(?:\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|inf)$/.test(
                      next.data,
                    )
                  )
                    throw new Error("Enter a numeric score.");
                  // The member must still have the score this editor opened (compare-and-set, review r3).
                  await keyOperation(db.id, {
                    op: "zset.add",
                    key: details.key,
                    members: [{ member: member.member, score: next.data }],
                    expect: expect ?? { type: details.type, sha256: digestBin(panel.opened!) },
                  });
                  await refresh();
                }}
              />
            ) : undefined,
          }))}
        />
      );
      break;
    case "stream":
      result = (
        <>
          <StreamInspector keyName={details.key} refresh={refresh} />
          <dl className="inline-facts">
            <dt>Entries</dt>
            <dd>{value.total.toLocaleString()}</dd>
            <dt>Consumer groups</dt>
            <dd>{value.groups}</dd>
            <dt>Last ID</dt>
            <dd>
              <code>{value.lastId}</code>
            </dd>
          </dl>
          <ValueTable
            columns={["Entry ID", "Field", "Value"]}
            empty="No entries on this page."
            rows={value.entries.flatMap((entry) => entry.fields.map((field, index) => ({
              id: `${entry.id}:${index}`,
              cells: [
                <span className="stream-id">
                  <code>{entry.id}</code>
                  {epochLabel(entry.id) && <small><IsoTime iso={epochLabel(entry.id)!} /></small>}
                </span>,
                cell(field.field, field.truncated, field.ref, "identity"),
                cell(field.value, field.truncated, field.ref, "value", true),
              ],
              actions: index === 0 ? removeButton({
                op: "stream.delete",
                key: details.key,
                ids: [entry.id],
              }) : undefined,
            })))}
          />
        </>
      );
      break;
    case "timeseries":
      result = (
        <>
          <Chart
            label="TimeSeries value"
            color="--type-timeseries"
            samples={value.samples.map(([t, v]) => [t, Number(v)])}
          />
          <ValueTable
            columns={["Timestamp", "Value"]}
            numeric={[1]}
            firstShare={40}
            empty="This series has no samples in the read range."
            rows={value.samples.map(([t, v]) => ({
              cells: [<code><IsoTime iso={new Date(t).toISOString()} /></code>, v],
            }))}
          />
          <details className="disclosure">
            <summary>Series metadata (TS.INFO)</summary>
            <pre className="data">
              {visibleText(JSON.stringify(value.info, null, 2))}
            </pre>
          </details>
        </>
      );
      break;
    case "vectorset":
      result = <VectorSetDetail details={details} value={value} refresh={refresh} />;
      break;
    // v0.4 arrays: the array inspector pages, searches and edits by index (ArrayDetail.tsx).
    case "array":
      result = <ArrayDetail details={details} value={value} refresh={refresh} cell={(bin, cut, ref) => cell(bin, cut, ref, "value", true)} />;
      break;
    case "unsupported": {
      // Module types are named for people, with the read-only commands that describe them; others keep the
      // server's message.
      const known = UNSUPPORTED_TYPES[details.type];
      result = known ? (
        <Empty title={`${known.name} values are not shown in the key browser.`}>
          <span>Use the console to describe it, for example <code>{known.hint}</code>.</span>
        </Empty>
      ) : (
        <Empty title={value.message}>
          {!hasTypeHint(details.type) && (
            <span>
              The key browser does not read this type yet. Use the console for the
              commands your role allows.
            </span>
          )}
        </Empty>
      );
      break;
    }
  }
  const truncated =
    value.type === "hash"
      ? value.entries.some((entry) => entry.truncated)
      : value.type === "list"
        ? value.items.some((item) => item.truncated)
        : value.type === "set"
          ? !!value.truncatedMembers
          : value.type === "zset"
            ? value.members.some((member) => member.truncated)
            : value.type === "stream"
              ? value.entries.some((entry) =>
                  entry.fields.some((field) => field.truncated),
                )
              : false;
  return (
    <>
      <ErrorState error={error} />
      {changed && <p role="status" className="notice warning">{changed}</p>}
      {truncated && (
        <div className="notice warning">
          Some elements are truncated previews, so actions that need their full
          bytes are hidden for them. Open a value and choose Load full element (server capped).
        </div>
      )}
      {["hash", "list", "set", "zset", "stream", "array"].includes(value.type) && <label className="collection-format-control">Collection value format <select aria-label="Collection value format" value={format} onChange={e => setFormat(e.target.value as ValueFormat)}>{FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</select></label>}
      <ColumnWidths value={onColumnWidth ? { width: columnWidth, set: onColumnWidth } : null}>{result}</ColumnWidths>
      {inspected && (
        <Modal
          title="Value inspector"
          className="value-modal"
          onClose={() => setInspected(undefined)}
          testId="value-inspector-dialog"
        >
          {inspected.truncated && (
            <p className="notice warning">
              Truncated preview: the server sent only the first bytes of this element. Structured views are off and
              Copy copies the preview. Load the full element within the server cap to decode, copy or download it.
            </p>
          )}
          {inspected.ref && inspected.truncated && <button type="button" data-testid="element-load-full" disabled={fullBusy} onClick={() => {
            const target = inspected;
            setFullBusy(true); setFullError(undefined);
            void request<KeyElementResponse>(dbPath(db.id, "/key/element"), { method: "POST", body: { key: details.key, ref: target.ref } })
              .then(full => setInspected(current => current === target ? { ...target, value: target.part === "identity" ? full.identity ?? full.value : full.value, identity: full.identity, score: full.score, truncated: false } : current))
              .catch(setFullError).finally(() => setFullBusy(false));
          }}>{fullBusy ? "Loading…" : "Load full element (server capped)"}</button>}
          <ErrorState error={fullError} />
          {!inspected.truncated && writable && inspected.part !== "identity" && inspected.ref && (inspected.ref.kind === "list" || inspected.ref.kind === "array" || ((inspected.ref.kind === "hash" || inspected.ref.kind === "scan") && inspected.identity && details.type === "hash") || details.type === "zset" && inspected.identity && inspected.score !== undefined) && <>
            <button type="button" onClick={() => setEditingFull(!editingFull)}>Edit full element</button>
            {editingFull && <InlineEdit value={details.type === "zset" ? binFromString(inspected.score!) : inspected.value} label="Full element value" onClose={() => setEditingFull(false)} onReload={() => { setInspected(undefined); void refresh(); }} onSave={async (next, expect) => {
              let op: KeyOp;
              if (details.type === "hash") op = { op: "hash.set", key: details.key, entries: [{ field: inspected.identity!, value: next }], expect: expect ?? { type: "hash", sha256: digestBin(inspected.value) } };
              else if (details.type === "zset") {
                if (next.enc !== "utf8" || !/^[-+]?(?:\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|inf)$/.test(next.data)) throw new Error("Enter a numeric score.");
                op = { op: "zset.add", key: details.key, members: [{ member: inspected.identity!, score: next.data }], expect: expect ?? { type: "zset", sha256: digestBin(binFromString(inspected.score!)) } };
              } else if (inspected.ref!.kind === "list") op = { op: "list.set", key: details.key, index: inspected.ref!.index, value: next, expect: expect ?? { type: "list", sha256: digestBin(inspected.value) } };
              // v0.4 arrays: the element at its index, compared with the full bytes this inspector loaded.
              else if (inspected.ref!.kind === "array") op = { op: "array.set", key: details.key, index: inspected.ref!.index, value: next, expect: expect ?? { type: "array", sha256: digestBin(inspected.value) } };
              else throw new Error("This element cannot be edited here.");
              await keyOperation(db.id, op); setInspected(undefined); setEditingFull(false); await refresh();
            }} />}
          </>}

          <ValueViewer key={`${inspected.value.enc}:${inspected.value.data.slice(0, 32)}:${bytesFromBin(inspected.value).length}`} value={inspected.value} truncated={inspected.truncated} preview={inspected.truncated} />
        </Modal>
      )}
    </>
  );
}

/** Formatting stays in the table; expansion mounts the richer formatter only for that row. */
function CollectionCell({ value, truncated, format, open, expandedOnly = false }: { value: Bin; truncated: boolean; format: ValueFormat; open: () => void; expandedOnly?: boolean }) {
  const row = useContext(RowExpansion);
  const [expanded, setExpanded] = useState(false);
  let text: string;
  try { text = truncated && !["text", "hex", "base64"].includes(format) ? `${displayBin(value, 2000)}\nTruncated preview; load the full element to decode.` : formatValue(value, format, 2000); }
  catch (error) { text = `Cannot format as ${format}: ${(error as Error).message}`; }
  if (expandedOnly) return <ValueViewer value={value} truncated={truncated} preferred={format} />;
  return <div className="collection-cell">
    <button type="button" className="value-cell data" onClick={open} title="Open in the value inspector" data-testid="value-cell-open"><span>{text}</span>{value.enc === "utf8" && epochLabel(value.data) && <small className="muted"> · Timestamp hint: {epochLabel(value.data)}</small>}</button>
    {row ? <button type="button" className="collection-expand" aria-expanded={row.selected === row.column} onClick={row.toggle}>Expand {row.noun}</button> : <details onToggle={e => setExpanded(e.currentTarget.open)}><summary>Expand value</summary>{expanded && <ValueViewer key={format} value={value} truncated={truncated} preferred={format} />}</details>}
  </div>;
}
