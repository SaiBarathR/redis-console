import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Columns3,
  Filter,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import {
  keyToParam,
  type Bin,
  type Reply,
  type ScanResponse,
  type WorkbenchResponse,
} from "@rconsole/shared";
import { dbPath, post, request } from "../lib/api.ts";
import { jobSummary, useBulkJob, type BulkJobInfo } from "../lib/bulkjob.ts";
import { canWrite, useDatabase } from "../lib/context.tsx";
import { bytesLabel, cliBin, displayBin, sizeMeasured, visibleText } from "../lib/format.ts";
import { useKeyMeta, type MetaEntry } from "../lib/keymeta.ts";
import {
  buildKeyIndex,
  canonicalKey,
  compareEntries,
  flattenTree,
  folderPattern,
  folderStats,
  keyId,
  keysUnder,
  keyCollator,
  type FolderNode,
  type FolderRow,
  type KeyEntry,
  type TreeOrder,
  type TreeRow,
} from "../lib/keytree.ts";
import {
  SCAN_CAP,
  SCAN_COUNT_CHOICES,
  useKeyScan,
  useScanCount,
  type ScanFilter,
} from "../lib/keyscan.ts";
import { useMemorySlot } from "../lib/memory.tsx";
import { keyOperation } from "../lib/operations.ts";
import { KeyName, TtlFuse, TypeGlyph, useNow } from "../components/anatomy.tsx";
import { KeyInspector, keyCopyText } from "../components/KeyInspector.tsx";
import { KeyEditor } from "../components/KeyOperations.tsx";
import {
  ActionForm,
  CopyButton,
  Empty,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageTitle,
} from "../components/ui.tsx";

export { KeyContent } from "../components/KeyContent.tsx";
export { inspectCommands, readCommand } from "../components/KeyInspector.tsx";

const ROW = 26;
/** Above this many keys in the first page, folders start collapsed. */
const COLLAPSE_ABOVE = 150;
const MAX_SELECTION = 1000;
const MAX_TTL_BATCH = 100;
const TYPES = [
  "string",
  "hash",
  "list",
  "set",
  "zset",
  "stream",
  "ReJSON-RL",
  "TSDB-TYPE",
  "MBbloom--",
  "MBbloomCF",
  "vectorset",
  "array",
];
type SortBy = "name" | "type" | "ttl" | "size";
interface SortSpec {
  by: SortBy;
  /** Reverses the sort's natural order (name A→Z, type A→Z, TTL soonest first, size largest first). */
  desc: boolean;
}
interface Columns {
  type: boolean;
  ttl: boolean;
  size: boolean;
}
const AUTO_REFRESH = [0, 5, 10, 30, 60, 300];

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']");

const keyCollatorCompare = (a: FolderNode, b: FolderNode) => keyCollator.compare(a.segment, b.segment);

/** Share of the results, compact for the row and precise for the tooltip. */
function share(count: number, total: number) {
  const pct = total ? (count / total) * 100 : 0;
  return {
    short:
      count === total && total ? "100%" : pct >= 99.5 ? ">99%" : pct >= 10 ? `${Math.round(pct)}%` : pct >= 1 ? `${pct.toFixed(1)}%` : pct > 0 ? "<1%" : "0%",
    precise: `${pct.toFixed(2)}%`,
  };
}

/** "now", "45 s", "3 min", "2 h": how long ago the list was read from Redis. */
function RefreshAge({ at }: { at: number }) {
  const now = useNow();
  const s = Math.max(0, Math.round((now - at) / 1000));
  const text = s < 5 ? "now" : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
      {text}
    </time>
  );
}

/** Drag or arrow-key handle between the list and the inspector; the width lives in session memory only. */
function Resizer({
  width,
  onChange,
}: {
  width: number;
  onChange: (width: number) => void;
}) {
  const clamp = (value: number, host: HTMLElement | null) =>
    Math.round(Math.min(Math.max(300, value), Math.max(320, (host?.clientWidth ?? 1200) - 380)));
  return (
    <div
      className="split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize key list"
      aria-valuenow={width}
      aria-valuemin={300}
      tabIndex={0}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 64 : 16;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          onChange(clamp(width + (event.key === "ArrowLeft" ? -step : step), event.currentTarget.parentElement));
        }
      }}
      onPointerDown={(event) => {
        const handle = event.currentTarget;
        const host = handle.parentElement;
        const left = host?.getBoundingClientRect().left ?? 0;
        handle.setPointerCapture(event.pointerId);
        const move = (next: PointerEvent) => onChange(clamp(next.clientX - left, host));
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
      }}
    />
  );
}

/** A column header that sorts; pressing the active one reverses it. */
function SortHeader({
  by,
  label,
  sort,
  onSort,
  className,
}: {
  by: SortBy;
  label: string;
  sort: SortSpec;
  onSort: (next: SortSpec) => void;
  className: string;
}) {
  const active = sort.by === by;
  const order: Record<SortBy, [string, string]> = {
    name: ["A to Z", "Z to A"],
    type: ["A to Z", "Z to A"],
    ttl: ["soonest expiry first", "latest expiry first"],
    size: ["largest first", "smallest first"],
  };
  const Arrow = sort.desc ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      className={`col-head ${className} ${active ? "active" : ""}`}
      aria-pressed={active}
      title={active ? `Sorted by ${label.toLowerCase()}, ${order[by][sort.desc ? 1 : 0]}. Press to reverse.` : `Sort by ${label.toLowerCase()}`}
      onClick={() => onSort({ by, desc: active ? !sort.desc : false })}
      data-testid={`key-sort-${by}`}
    >
      {label}
      {active && <Arrow size={11} aria-hidden="true" />}
      <span className="sr-only">{active ? `, ${order[by][sort.desc ? 1 : 0]}` : ""}</span>
    </button>
  );
}

/** Which metadata columns the list shows (session memory). Hidden columns are not requested from Redis. */
function ColumnsMenu({ columns, onChange }: { columns: Columns; onChange: (next: Columns) => void }) {
  return (
    <details className="columns-menu">
      <summary aria-label="Choose columns" title="Choose columns" data-testid="key-columns">
        <Columns3 size={13} aria-hidden="true" />
      </summary>
      <fieldset>
        <legend>Columns</legend>
        {(["type", "ttl", "size"] as const).map((name) => (
          <label key={name} className="checkbox">
            <input
              type="checkbox"
              checked={columns[name]}
              onChange={(e) => onChange({ ...columns, [name]: e.target.checked })}
              data-testid={`key-column-${name}`}
            />
            {name === "type" ? "Type" : name === "ttl" ? "TTL" : "Size"}
          </label>
        ))}
        <small>Hidden columns are not read from Redis.</small>
      </fieldset>
    </details>
  );
}

export function Keys() {
  const db = useDatabase();
  const writable = canWrite(db);
  const [scanCount, setScanCount] = useScanCount();
  const scan = useKeyScan(db.id, scanCount);
  const state = scan.state;
  const [pattern, setPattern] = useState(state?.filter.match ?? "*");
  const [type, setType] = useState(state?.filter.type ?? "");
  const [delimiter, setDelimiter] = useMemorySlot(`${db.id}:key-delimiter`, ":");
  const [view, setView] = useMemorySlot<"tree" | "list">(`${db.id}:key-view`, "tree");
  const [columns, setColumns] = useMemorySlot<Columns>("keys:columns", { type: true, ttl: true, size: true });
  const [toggled, setToggled] = useMemorySlot(`${db.id}:key-folders`, new Set<string>());
  const [sort, setSort] = useMemorySlot<SortSpec>(`${db.id}:key-sort-order`, { by: "name", desc: false });
  const [autoRefresh, setAutoRefresh] = useMemorySlot(`${db.id}:key-auto-refresh`, 0);
  const [noExpiry, setNoExpiry] = useState(false);
  const [selected, setSelected] = useMemorySlot<Bin | undefined>(`${db.id}:selected-key`, undefined);
  const [, setRecentKeys] = useMemorySlot<Bin[]>(`${db.id}:recent-keys`, []);
  const [listWidth, setListWidth] = useMemorySlot("keys:list-width", 0);
  const [inspectorWide] = useMemorySlot("keys:inspector-wide", false);
  const [checked, setChecked] = useState<Map<string, Bin>>(new Map());
  const [focus, setFocus] = useState(0);
  const anchor = useRef<number | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [batchTtl, setBatchTtl] = useState("3600");
  const [batchError, setBatchError] = useState<unknown>();
  const [batchMessage, setBatchMessage] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [bulk, setBulk] = useState<ScanFilter | undefined>();
  const [metaLoad, setMetaLoad] = useState<{ done: number; total: number } | undefined>();
  const [sortEpoch, setSortEpoch] = useState(0);
  const [refreshError, setRefreshError] = useState<unknown>();
  const patternInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);

  const filter = state?.filter ?? { match: "*", type: "" };
  const treeDelimiter = view === "tree" ? delimiter : "";
  const metaSorted = sort.by !== "name" || noExpiry;
  const meta = useKeyMeta(db.id, {
    ttl: columns.ttl || sort.by === "ttl" || noExpiry,
    size: columns.size || sort.by === "size",
  });
  /** Type glyphs need no metadata when a type filter already says what every key is. */
  const metaNeeded = columns.ttl || columns.size || (columns.type && !filter.type) || metaSorted;

  const refreshList = async (background = false) => {
    setRefreshError(undefined);
    await scan.refresh({ background });
    meta.invalidate();
  };
  const job = useBulkJob(db.id, (info: BulkJobInfo) => {
    if (info.job.deleted > 0) void refreshList();
  });

  // A pattern handed over from Guided mode's Find (session memory, never the URL).
  const [requested, setRequested] = useMemorySlot<ScanFilter | undefined>(`${db.id}:key-scan-request`, undefined);
  useEffect(() => {
    if (requested) {
      setRequested(undefined);
      setPattern(requested.match);
      setType(requested.type);
      runScan(requested);
    } else if (!state) void scan.start({ match: "*", type: "" });
    // Only on first visit to this database in the session, or when Guided mode hands over a pattern.
  }, []);
  const keys = useMemo(() => state?.keys ?? [], [state?.keys]);
  useEffect(() => {
    setRecentKeys(keys.slice(-200));
  }, [keys]);

  // "/" focuses the pattern (outside inputs and dialogs), as in many developer tools.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      patternInput.current?.focus();
      patternInput.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** The namespace trie: rebuilt only when the names or the delimiter change. */
  const index = useMemo(() => buildKeyIndex(keys, treeDelimiter), [keys, treeDelimiter]);
  useEffect(() => meta.prune((id) => index.byId.has(id), index.entries.length), [index]);

  // Sorting by metadata or "No TTL" needs metadata of every loaded key: load it once, explicitly, with progress.
  useEffect(() => {
    if (!metaSorted || !index.entries.length) {
      setMetaLoad(undefined);
      return;
    }
    const abort = new AbortController();
    void meta
      .loadAll(index.entries, abort.signal, (done, total) => setMetaLoad(done < total ? { done, total } : undefined))
      .catch(() => setMetaLoad(undefined))
      .finally(() => {
        if (!abort.signal.aborted) setSortEpoch((n) => n + 1);
      });
    return () => abort.abort();
  }, [metaSorted, index]);

  const order = useMemo((): TreeOrder => {
    const m = (entry: KeyEntry) => meta.get(entry.id);
    const ttlRank = (entry: KeyEntry) => {
      const ttl = m(entry)?.ttl;
      return ttl === undefined ? Number.MAX_VALUE : ttl === -2 ? 0 : ttl < 0 ? Number.MAX_VALUE / 2 : ttl;
    };
    const compare: Record<SortBy, TreeOrder["compare"]> = {
      name: undefined,
      type: (a, b) => (m(a)?.type ?? "￿").localeCompare(m(b)?.type ?? "￿") || compareEntries(a, b),
      ttl: (a, b) => ttlRank(a) - ttlRank(b) || compareEntries(a, b),
      size: (a, b) => (m(b)?.size ?? -1) - (m(a)?.size ?? -1) || compareEntries(a, b),
    };
    // Sorting by size also orders folders by their byte sums, largest first: where the memory is.
    const sums = sort.by === "size" ? folderStats(index, (entry) => m(entry)?.size) : undefined;
    return {
      desc: sort.desc,
      compare: compare[sort.by],
      ...(sums
        ? { compareFolders: (a: FolderNode, b: FolderNode) => (sums.get(b)?.bytes ?? 0) - (sums.get(a)?.bytes ?? 0) || keyCollatorCompare(a, b) }
        : {}),
      ...(noExpiry ? { filter: (entry: KeyEntry) => m(entry)?.ttl === -1 } : {}),
    };
    // Re-sorted when the metadata for sorting finished loading (sortEpoch), not on every batch.
  }, [sort, noExpiry, sortEpoch, index]);
  const collapsedByDefault = (state?.firstPage ?? 0) > COLLAPSE_ABOVE;
  const rows = useMemo(
    () => flattenTree(index, toggled, collapsedByDefault, order),
    [index, toggled, collapsedByDefault, order],
  );
  const stats = useMemo(
    () => (columns.size ? folderStats(index, (entry) => meta.get(entry.id)?.size) : undefined),
    [index, meta.version, columns.size],
  );
  const selectedId = selected ? keyId(selected) : undefined;
  const focusIndex = Math.min(focus, Math.max(0, rows.length - 1));
  // A different view of the keys (Tree/List, delimiter, a new pattern) starts at the top, not at the old offset.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (listRef.current) listRef.current.scrollTop = 0;
    setFocus(0);
  }, [view, treeDelimiter, state?.filter]);

  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW,
    overscan: 12,
  });
  const visibleItems = virtual.getVirtualItems();
  const firstVisible = visibleItems[0]?.index ?? 0;
  const lastVisible = visibleItems.at(-1)?.index ?? -1;
  // Metadata for the rows on screen (plus overscan), batched and debounced by useKeyMeta.
  useEffect(() => {
    if (!metaNeeded) return meta.want([]);
    const wanted = [];
    for (let i = firstVisible; i <= lastVisible; i++) {
      const row = rows[i];
      if (row?.kind === "key") wanted.push({ id: row.id, key: row.key });
    }
    meta.want(wanted);
  }, [firstVisible, lastVisible, rows, metaNeeded, columns.ttl, columns.size]);

  // Opt-in auto-refresh of the list; it pauses while a dialog, an edit, a selection or a delete is in progress.
  const pausedBy = creating
    ? "the key editor is open"
    : bulk || job.running
      ? "a delete by pattern is open or running"
      : checked.size
        ? "keys are selected"
        : undefined;
  const pausedRef = useRef(pausedBy);
  pausedRef.current = pausedBy;
  const busyRef = useRef(scan.busy);
  busyRef.current = scan.busy;
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      if (document.hidden || busyRef.current || pausedRef.current || document.querySelector("dialog[open]") || typing(document.activeElement)) return;
      void refreshList(true).catch(setRefreshError);
    }, autoRefresh * 1000);
    return () => clearInterval(timer);
  }, [autoRefresh, db.id]);

  const runScan = (next: ScanFilter) => {
    setToggled(new Set());
    setChecked(new Map());
    setFocus(0);
    anchor.current = undefined;
    // A new scan reads the details of the rows on screen again too (cached values show until then).
    meta.invalidate();
    void scan.start(next);
  };
  const filterTo = (row: FolderRow) => {
    const next = { match: folderPattern(row.id), type: filter.type };
    setPattern(next.match);
    setType(next.type);
    runScan(next);
  };
  const toggleFolder = (id: string) =>
    setToggled((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const setCheckedKeys = (list: Bin[], on: boolean) =>
    setChecked((previous) => {
      const next = new Map(previous);
      for (const key of list) {
        const id = keyId(key);
        if (on && next.size < MAX_SELECTION) next.set(id, key);
        else if (!on) next.delete(id);
      }
      return next;
    });
  const range = (from: number, to: number) =>
    rows.slice(Math.min(from, to), Math.max(from, to) + 1).flatMap((row) => (row.kind === "key" ? [row.key] : []));
  const moveFocus = (target: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, target));
    setFocus(next);
    virtual.scrollToIndex(next, { align: "auto" });
  };
  const openKey = (row: TreeRow, at: number) => {
    if (row.kind !== "key") return;
    setSelected(row.key);
    anchor.current = at;
  };
  const onRowClick = (event: MouseEvent, row: TreeRow, at: number) => {
    setFocus(at);
    if (row.kind === "folder") {
      toggleFolder(row.id);
      return;
    }
    if (event.shiftKey && anchor.current !== undefined) {
      event.preventDefault();
      setCheckedKeys(range(anchor.current, at), true);
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      setCheckedKeys([row.key], !checked.has(row.id));
      anchor.current = at;
      return;
    }
    openKey(row, at);
  };
  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    meta.touch();
    const row = rows[focusIndex];
    if (!row) return;
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? ROW * 10) / ROW) - 1);
    const handlers: Record<string, () => void> = {
      ArrowDown: () => moveFocus(focusIndex + 1),
      ArrowUp: () => moveFocus(focusIndex - 1),
      PageDown: () => moveFocus(focusIndex + page),
      PageUp: () => moveFocus(focusIndex - page),
      Home: () => moveFocus(0),
      End: () => moveFocus(rows.length - 1),
      ArrowRight: () => {
        if (row.kind === "folder") return row.open ? moveFocus(focusIndex + 1) : toggleFolder(row.id);
        openKey(row, focusIndex);
      },
      ArrowLeft: () => {
        if (row.kind === "folder" && row.open) return toggleFolder(row.id);
        const parent = rows.findIndex((item) => item.kind === "folder" && item.id === row.parent);
        if (parent >= 0) moveFocus(parent);
      },
      Enter: () => (row.kind === "folder" ? toggleFolder(row.id) : openKey(row, focusIndex)),
      " ": () => {
        if (row.kind === "key") {
          // Shift extends from the anchor, which stays where the range started.
          if (event.shiftKey && anchor.current !== undefined) setCheckedKeys(range(anchor.current, focusIndex), true);
          else {
            setCheckedKeys([row.key], !checked.has(row.id));
            anchor.current = focusIndex;
          }
        } else {
          const under = keysUnder(row.node).map((entry) => entry.key);
          const all = under.every((key) => checked.has(keyId(key)));
          setCheckedKeys(under, !all);
        }
      },
      f: () => {
        if (row.kind === "folder") filterTo(row);
      },
      Delete: () => {
        if (row.kind === "folder" && writable) setBulk({ match: folderPattern(row.id), type: filter.type });
      },
      Escape: () => {
        if (checked.size) setChecked(new Map());
      },
    };
    const run = handlers[event.key];
    if (!run || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    run();
  };

  const removeLocal = (list: Bin[], deleted = list.length) => {
    setBatchMessage(`Deleted ${deleted} ${deleted === 1 ? "key" : "keys"}.`);
    const gone = new Set(list.map(keyId));
    scan.patch((current) => current.filter((key) => !gone.has(keyId(key))), -deleted);
    meta.drop(gone);
    setChecked((previous) => {
      const next = new Map(previous);
      for (const id of gone) next.delete(id);
      return next;
    });
    if (selectedId && gone.has(selectedId)) setSelected(undefined);
  };
  const deleteChecked = () => {
    setBatchError(undefined);
    setBatchBusy(true);
    const list = [...checked.values()];
    void keyOperation(db.id, { op: "key.delete", keys: list })
      .then(({ result }) =>
        removeLocal(list, (result as Reply | undefined)?.t === "int" ? Number((result as { v: string }).v) : list.length),
      )
      .catch(setBatchError)
      .finally(() => setBatchBusy(false));
  };
  const ttlChecked = async () => {
    const seconds = Number(batchTtl);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("Enter a positive whole number of seconds.");
    const list = [...checked.values()];
    const script = list.map((key) => `EXPIRE ${cliBin(key)} ${seconds}`).join("\n");
    const response = await post<WorkbenchResponse>(dbPath(db.id, "/workbench"), { script, stopOnError: true });
    const failed = response.results.find((result) => "error" in result || result.reply.t === "err");
    if (failed) throw new Error("Some expiries were not set. Rescan and check the selected keys before you retry.");
    const updated = response.results.filter((result) => "reply" in result && result.reply.t === "int" && result.reply.v === "1").length;
    setBatchMessage(`TTL set on ${updated} of ${list.length} keys (${seconds} seconds).`);
    for (const key of list) {
      const id = keyId(key);
      const current = meta.get(id);
      if (current) meta.set(id, { type: current.type, ttl: seconds, ...(current.size !== undefined ? { size: current.size } : {}) });
    }
    setChecked(new Map());
  };

  const busy = scan.busy;
  const results = keys.length;
  const filtered = filter.match !== "*" || !!filter.type;
  /** Keys "Select all" can pick: every loaded key, or those without a TTL under "No TTL". */
  const selectable = useMemo(
    () => (noExpiry ? index.entries.filter((entry) => meta.get(entry.id)?.ttl === -1).length : index.entries.length),
    [index, noExpiry, noExpiry ? meta.version : 0],
  );
  /** "Select all": the loaded keys in list order (all folders open), up to the selection limit. */
  const selectAll = () =>
    setCheckedKeys(
      flattenTree(index, new Set(), false, order).flatMap((row) => (row.kind === "key" ? [row.key] : [])).slice(0, MAX_SELECTION),
      true,
    );
  const allChecked = selectable > 0 && checked.size >= Math.min(selectable, MAX_SELECTION);
  const ttlBatchBlocked = checked.size > MAX_TTL_BATCH || [...checked.values()].some((key) => key.enc !== "utf8");
  const capped = results >= SCAN_CAP;
  const complete = !!state?.done;
  const denominator = complete ? "matching keys" : "loaded matches";
  const scannedShown = state ? (state.done ? state.dbSize : Math.min(state.scanned, state.dbSize)) : 0;
  const progress = state && state.dbSize ? Math.min(1, scannedShown / state.dbSize) : 0;

  const empty = () => {
    if (!state || (busy === "first" && !results)) return <Loading label="Scanning keys…" />;
    if (scan.error && !results) return null;
    if (results && noExpiry)
      return (
        <Empty
          title={metaLoad ? "Loading TTLs…" : `None of the ${results.toLocaleString()} loaded keys is persistent.`}
          action={
            <button type="button" onClick={() => setNoExpiry(false)}>
              Show all keys
            </button>
          }
        >
          <span>{metaLoad ? "The list shows keys without an expiry once every loaded key's TTL is known." : "Every loaded key has a TTL. Scan more keys or show them all."}</span>
        </Empty>
      );
    if (!filtered && state.done && state.dbSize === 0)
      return (
        <Empty
          title="This database has no keys."
          action={
            writable && (
              <button type="button" className="primary" onClick={() => setCreating(true)}>
                <Plus size={13} aria-hidden="true" />
                Add key
              </button>
            )
          }
        >
          <span>Keys appear here when an application writes them{writable ? ", or add one yourself." : "."}</span>
        </Empty>
      );
    if (state.done)
      return (
        <Empty
          title={
            <>
              No keys match <code>{visibleText(filter.match)}</code>
              {filter.type && <> of type {filter.type}</>}.
            </>
          }
          action={
            <button
              type="button"
              onClick={() => {
                setPattern("*");
                setType("");
                runScan({ match: "*", type: "" });
              }}
            >
              Clear the pattern
            </button>
          }
        >
          <span>
            {state.exact
              ? "The pattern has no wildcard, so the key was looked up directly. "
              : `The scan covered all ${state.dbSize.toLocaleString()} keys. `}
            Patterns use glob syntax: <code>*</code> any characters, <code>?</code> one, <code>[ab]</code> a set.
          </span>
        </Empty>
      );
    return (
      <Empty
        title={`No matches in the first ${scannedShown.toLocaleString()} keys scanned.`}
        action={
          <>
            <button type="button" onClick={() => void scan.more()} disabled={!!busy}>
              Scan more
            </button>
            <button type="button" onClick={() => void scan.all()} disabled={!!busy}>
              Scan to end
            </button>
          </>
        }
      >
        <span>SCAN works through the keyspace in steps, and matches can be further on.</span>
      </Empty>
    );
  };

  const keyColumns = `14px var(--indent) ${columns.type ? "30px " : ""}minmax(0, 1fr)${columns.ttl ? " 96px" : ""}${columns.size ? " 56px" : ""}`;
  const folderColumns = `var(--indent) 14px minmax(0, 1fr) auto 44px 40px${columns.size ? " 64px" : ""}`;

  const renderFolder = (row: FolderRow, at: number, style: Record<string, string | number>) => {
    const s = share(row.count, results);
    const sum = stats?.get(row.node);
    const sumComplete = !!sum && sum.sized === row.count;
    const pattern = folderPattern(row.id);
    const bytes = !sum ? "" : sumComplete ? bytesLabel(sum.bytes) : `≥ ${bytesLabel(sum.bytes)}`;
    return (
      <div
        key={`f-${row.id}`}
        id={`ktr-${at}`}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-setsize={row.size}
        aria-posinset={row.pos}
        aria-expanded={row.open}
        aria-label={`${visibleText(row.id)} ${row.count.toLocaleString()} keys, ${s.precise} of ${denominator}`}
        className={`tree-row key-folder ${at === focusIndex ? "focused" : ""}`}
        style={{ ...style, gridTemplateColumns: folderColumns }}
        onClick={(event) => onRowClick(event, row, at)}
        title={`${visibleText(pattern)}\n${row.count.toLocaleString()} keys · ${s.precise} of ${denominator}${
          sum ? `\n${sumComplete ? "" : "at least "}${bytesLabel(sum.bytes)}${sumComplete ? "" : ` (sizes of ${sum.sized.toLocaleString()} of ${row.count.toLocaleString()} keys loaded)`}` : ""
        }`}
        data-testid="key-folder"
      >
        <span className="tree-indent" aria-hidden="true" />
        <ChevronRight size={13} className="twisty" aria-hidden="true" />
        <span className="folder-name">
          {row.label}
          <span className="ka-d">{visibleText(index.delimiter)}</span>
        </span>
        <span className="folder-actions">
          <button
            type="button"
            className="icon-button"
            tabIndex={-1}
            aria-label={`Filter to ${visibleText(pattern)} (F)`}
            title={`Filter to this folder: scan ${visibleText(pattern)}`}
            onClick={(event) => {
              event.stopPropagation();
              filterTo(row);
            }}
            data-testid="folder-filter"
          >
            <Filter size={12} aria-hidden="true" />
          </button>
          {writable && (
            <button
              type="button"
              className="icon-button danger-text"
              tabIndex={-1}
              aria-label={`Delete keys in ${visibleText(row.id)}… (Delete)`}
              title={`Delete keys in this folder… (${visibleText(pattern)}, with the server's count and confirmation)`}
              onClick={(event) => {
                event.stopPropagation();
                setBulk({ match: pattern, type: filter.type });
              }}
              data-testid="folder-delete"
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          )}
        </span>
        <span className="folder-count">{row.count.toLocaleString()}</span>
        <span className="folder-share" aria-hidden="true">
          {s.short}
        </span>
        {columns.size && (
          <span className={`folder-bytes ${sumComplete ? "" : "partial"}`} aria-hidden="true">
            {bytes}
          </span>
        )}
      </div>
    );
  };

  const renderKey = (row: Extract<TreeRow, { kind: "key" }>, at: number, style: Record<string, string | number>) => {
    const m: MetaEntry | undefined = meta.get(row.id);
    const isChecked = checked.has(row.id);
    const typeName = m?.type ?? (filter.type || undefined);
    const gone = m?.type === "none";
    return (
      <div
        key={`k-${row.id}`}
        id={`ktr-${at}`}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-setsize={row.size}
        aria-posinset={row.pos}
        aria-selected={row.id === selectedId}
        className={`tree-row key-row ${row.id === selectedId ? "selected" : ""} ${isChecked ? "checked" : ""} ${at === focusIndex ? "focused" : ""} ${gone ? "gone" : ""}`}
        style={{ ...style, gridTemplateColumns: keyColumns }}
        onClick={(event) => onRowClick(event, row, at)}
        data-testid="key-row"
        data-meta={m ? "loaded" : "pending"}
      >
        <input
          type="checkbox"
          tabIndex={-1}
          aria-label={`Select key ${displayBin(row.key, 200)}`}
          checked={isChecked}
          disabled={!isChecked && checked.size >= MAX_SELECTION}
          onClick={(event) => {
            // No preventDefault here: on a controlled checkbox it leaves the drawn state stale.
            event.stopPropagation();
            setFocus(at);
            if (event.shiftKey && anchor.current !== undefined) setCheckedKeys(range(anchor.current, at), true);
            else {
              setCheckedKeys([row.key], !isChecked);
              anchor.current = at;
            }
          }}
          onChange={() => undefined}
        />
        <span className="tree-indent" aria-hidden="true" />
        {columns.type &&
          (typeName ? (
            <TypeGlyph type={typeName} />
          ) : (
            <span className="type-glyph placeholder" title="Type loading">
              <span aria-hidden="true">···</span>
              <span className="sr-only">type loading</span>
            </span>
          ))}
        <KeyName name={row.key} delimiter={index.delimiter || ":"} prefix={row.prefix} limit={300} />
        {columns.ttl &&
          (m?.ttl !== undefined ? (
            <TtlFuse ttl={m.ttl} readAt={m.readAt} />
          ) : (
            <span className="ttl-fuse placeholder" aria-hidden="true">
              <span className="fuse-track" />
            </span>
          ))}
        {columns.size && (
          <span
            className={`key-size ${m?.size === undefined ? "placeholder" : ""}`}
            title={m && !sizeMeasured(m.type) ? "Not measured: MEMORY USAGE does not cover graph data" : undefined}
          >
            {m?.size !== undefined ? bytesLabel(m.size) : m?.asked.size ? "—" : ""}
          </span>
        )}
      </div>
    );
  };

  const jobInfo = job.info;
  return (
    <div className="workspace keys-view">
      <PageTitle
        title="Keys"
        actions={
          writable && (
            <>
              <button type="button" className="ghost danger-text" onClick={() => setBulk({ match: "", type: "" })} data-testid="bulk-delete">
                <Trash2 size={13} aria-hidden="true" />
                Delete by pattern
              </button>
              <button type="button" className="primary" onClick={() => setCreating(true)} data-testid="key-add">
                <Plus size={14} aria-hidden="true" />
                Add key
              </button>
            </>
          )
        }
      >
        <form
          className="scan-form"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            runScan({ match: pattern || "*", type });
          }}
        >
          <div className="pattern-field">
            <Search size={14} aria-hidden="true" />
            <input
              ref={patternInput}
              aria-label="Key pattern"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="Pattern, e.g. session:*"
              spellCheck={false}
              autoComplete="off"
              data-testid="key-pattern"
            />
            <kbd aria-hidden="true" title="Press / to focus the pattern">
              /
            </kbd>
          </div>
          <select aria-label="Key type" value={type} onChange={(e) => setType(e.target.value)} data-testid="key-type-filter">
            <option value="">All types</option>
            {TYPES.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <button type="submit" className="primary" data-testid="key-scan">
            Scan
          </button>
          <div className="segmented" role="group" aria-label="Key list view">
            {(["tree", "list"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                onClick={() => setView(mode)}
                data-testid={`key-view-${mode}`}
                title={mode === "tree" ? "Group keys into folders by the delimiter" : "One flat list of key names"}
              >
                {mode === "tree" ? "Tree" : "List"}
              </button>
            ))}
          </div>
          {view === "tree" && (
            <label className="inline-field delimiter-field" title="Tree delimiter">
              <span>Delimiter</span>
              <input
                value={delimiter}
                maxLength={4}
                onChange={(e) => setDelimiter(e.target.value)}
                data-testid="key-delimiter"
                aria-label="Tree delimiter"
                placeholder="none"
                spellCheck={false}
              />
            </label>
          )}
        </form>
      </PageTitle>
      <div
        // The list is hidden only while a key is open, so it can always be brought back.
        className={`split keys-split ${inspectorWide && selected ? "inspector-wide" : ""}`}
        ref={splitRef}
        style={listWidth ? { ["--split" as string]: `${listWidth}px` } : undefined}
      >
        <section className="key-pane" aria-label="Key list">
          {checked.size > 0 ? (
            <div className="pane-head selection-bar" role="region" aria-label="Selected keys">
              <input
                type="checkbox"
                aria-label={allChecked ? "Clear selection" : "Select all loaded keys"}
                checked={allChecked}
                ref={(element) => {
                  if (element) element.indeterminate = !allChecked && checked.size > 0;
                }}
                onChange={() => (allChecked ? setChecked(new Map()) : selectAll())}
              />
              <strong>{checked.size.toLocaleString()} selected</strong>
              {checked.size >= MAX_SELECTION && <small>(limit {MAX_SELECTION})</small>}
              <span className="actions">
                {writable && (
                  <>
                    <form
                      className="inline-ttl"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (batchBusy) return;
                        setBatchBusy(true);
                        setBatchError(undefined);
                        void ttlChecked()
                          .catch(setBatchError)
                          .finally(() => setBatchBusy(false));
                      }}
                    >
                      <input
                        aria-label="TTL in seconds for the selected keys"
                        type="number"
                        min={1}
                        step={1}
                        required
                        value={batchTtl}
                        onChange={(e) => setBatchTtl(e.target.value)}
                      />
                      <button
                        type="submit"
                        disabled={batchBusy || ttlBatchBlocked}
                        title={ttlBatchBlocked ? `Set TTL works on up to ${MAX_TTL_BATCH} UTF-8 keys at a time.` : "Runs EXPIRE for each selected key"}
                      >
                        Set TTL
                      </button>
                      <span>seconds</span>
                    </form>
                    {ttlBatchBlocked && <small role="status">Set TTL supports up to {MAX_TTL_BATCH} UTF-8 keys at a time.</small>}
                    <button type="button" className="ghost danger-text" disabled={batchBusy} onClick={deleteChecked} data-testid="selection-delete">
                      <Trash2 size={13} aria-hidden="true" />
                      Delete
                    </button>
                  </>
                )}
                <CopyButton text={[...checked.values()].map(keyCopyText).join("\n")} label="Copy names" />
                <button type="button" className="ghost" onClick={() => setChecked(new Map())}>
                  Clear
                </button>
              </span>
            </div>
          ) : (
            <div className="pane-head list-head">
              <input
                type="checkbox"
                aria-label="Select all loaded keys"
                checked={false}
                disabled={!selectable}
                onChange={selectAll}
              />
              <span
                className="count-line"
                aria-live="polite"
                data-testid="key-scan-summary"
                data-done={complete ? "true" : "false"}
                data-results={results}
                data-scanned={scannedShown}
                data-total={state?.dbSize ?? 0}
                title={
                  state
                    ? `${results.toLocaleString()} keys ${filtered ? "match the filter" : "listed"}; SCAN examined ${scannedShown.toLocaleString()} of the ${state.dbSize.toLocaleString()} keys in the database${complete ? " (complete)" : ""}. Folder percentages are of ${denominator}.`
                    : undefined
                }
              >
                {!state ? (
                  "Scanning…"
                ) : state.exact ? (
                  <>
                    <strong>Results {results.toLocaleString()}</strong> · exact key lookup
                  </>
                ) : (
                  <>
                    <strong>Results {results.toLocaleString()}</strong> · Scanned {scannedShown.toLocaleString()} / {state.dbSize.toLocaleString()}
                    {busy === "first" || busy === "more" ? " · scanning…" : ""}
                  </>
                )}
              </span>
              <label className="checkbox no-ttl" title="Show only keys without an expiry (loads the TTL of every listed key)">
                <input type="checkbox" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} />
                No TTL
              </label>
              <span className="last-refresh" data-testid="key-last-refresh">
                {state?.loadedAt ? (
                  <>
                    <span className="wide-only">Refreshed </span>
                    <RefreshAge at={state.loadedAt} />
                  </>
                ) : null}
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="Refresh the key list"
                title="Refresh: read the key names again (as far as the list reached) and the details of the rows on screen"
                disabled={!state || !!busy}
                onClick={() => void refreshList().catch(setRefreshError)}
                data-testid="key-refresh"
              >
                <RefreshCw size={13} className={busy === "refresh" ? "spin" : undefined} aria-hidden="true" />
              </button>
              <select
                className="auto-refresh"
                aria-label="Auto-refresh the key list"
                value={autoRefresh}
                onChange={(e) => setAutoRefresh(Number(e.target.value))}
                title={
                  autoRefresh && pausedBy
                    ? `Auto-refresh is paused while ${pausedBy}.`
                    : "Refresh the key list automatically. Pauses while a dialog is open, keys are selected or you are typing."
                }
                data-testid="key-auto-refresh"
              >
                {AUTO_REFRESH.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds === 0 ? "Auto: off" : seconds < 60 ? `Auto: ${seconds} s` : `Auto: ${seconds / 60} min`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="list-columns" style={{ gridTemplateColumns: keyColumns.replace("var(--indent) ", "") }}>
            <span />
            {columns.type && <SortHeader by="type" label="Type" sort={sort} onSort={setSort} className="c-type" />}
            <span className="c-name">
              <SortHeader by="name" label="Key" sort={sort} onSort={setSort} className="" />
              {view === "tree" && treeDelimiter && (
                <span className="share-note" title="The percentage on each folder row" data-testid="key-share-note">
                  folder % of {denominator}
                </span>
              )}
              <ColumnsMenu columns={columns} onChange={setColumns} />
            </span>
            {columns.ttl && <SortHeader by="ttl" label="TTL" sort={sort} onSort={setSort} className="c-ttl" />}
            {columns.size && <SortHeader by="size" label="Size" sort={sort} onSort={setSort} className="c-size" />}
          </div>
          {metaLoad && (
            <div className="notice scan-progress" role="status">
              <span>
                Loading {sort.by === "name" ? "TTLs" : sort.by === "ttl" ? "TTLs" : sort.by === "size" ? "sizes" : "types"} of {metaLoad.total.toLocaleString()} keys
                to {noExpiry ? "filter" : "sort"} the list… {metaLoad.done.toLocaleString()} / {metaLoad.total.toLocaleString()}
              </span>
              <progress max={metaLoad.total} value={metaLoad.done} />
              <button type="button" onClick={() => (noExpiry ? setNoExpiry(false) : setSort({ by: "name", desc: false }))}>
                Stop
              </button>
            </div>
          )}
          {scan.outdated && busy !== "first" && (
            <div className="notice warning scan-changed" role="status" data-testid="key-scan-changed">
              <span>
                {state?.changed
                  ? "Some of your changes may not fit this list (a key outside the pattern or type, or a rename)."
                  : "Keys were changed on another page after this scan."}{" "}
                Rescan to update the list and counts.
              </span>
              <button type="button" onClick={() => void refreshList().catch(setRefreshError)}>
                Rescan
              </button>
            </div>
          )}
          {jobInfo && !bulk && (
            <div className={`notice ${jobInfo.job.state === "running" ? "" : jobInfo.job.state === "done" ? "success" : "warning"} bulk-job-line`} role="status" data-testid="bulk-job-status">
              <span>
                <code>{visibleText(jobInfo.filter.match)}</code>: {jobSummary(jobInfo.job)}
              </span>
              {jobInfo.job.state === "running" ? (
                <button type="button" onClick={() => void job.cancel()}>
                  Stop
                </button>
              ) : null}
              <button type="button" className="ghost" onClick={() => (jobInfo.job.state === "running" ? setBulk(jobInfo.filter) : job.dismiss())}>
                {jobInfo.job.state === "running" ? "Show" : "Dismiss"}
              </button>
            </div>
          )}
          {batchMessage && <p role="status">{batchMessage}</p>}
          <ErrorState error={batchError} />
          <ErrorState error={refreshError} />
          <ErrorState error={meta.error} />
          <ErrorState
            error={scan.error}
            onRetry={() => (results ? void scan.more() : runScan(filter))}
            retryLabel={results ? "Scan more" : "Scan again"}
          />
          {rows.length && !(busy === "first" && !results) ? (
            <div
              className="key-list"
              ref={listRef}
              role="tree"
              aria-label={view === "tree" ? "Keys by namespace" : "Keys"}
              tabIndex={0}
              aria-activedescendant={rows[focusIndex] ? `ktr-${focusIndex}` : undefined}
              onKeyDown={onListKey}
              onScroll={meta.touch}
              onPointerDown={meta.touch}
              data-testid="key-list"
              data-meta-pending={meta.pending ? "true" : "false"}
            >
              <div className="virtual-space" style={{ height: virtual.getTotalSize() }}>
                {visibleItems.map((virtualRow) => {
                  const at = virtualRow.index;
                  const row = rows[at];
                  if (!row) return null;
                  const style = { transform: `translateY(${virtualRow.start}px)`, ["--depth"]: row.depth };
                  return row.kind === "folder" ? renderFolder(row, at, style) : renderKey(row, at, style);
                })}
              </div>
            </div>
          ) : (
            <div className="key-list-empty">{empty()}</div>
          )}
          <footer className="scan-foot">
            {busy === "all" ? (
              <>
                <button type="button" onClick={scan.halt} data-testid="key-scan-stop">
                  Stop
                </button>
                <progress max={1} value={progress} aria-label="Scan progress" />
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={!state || state.done || !!busy || capped}
                  onClick={() => void scan.more()}
                  data-testid="key-load-more"
                  title={`Scan ${scanCount.toLocaleString()} more keys of the keyspace from the cursor`}
                >
                  {busy === "more" ? "Scanning…" : state?.done ? "Scan complete" : "Scan more"}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={!state || state.done || !!busy || capped}
                  onClick={() => void scan.all()}
                  title="Keep scanning until the cursor returns to 0 (names only; Stop keeps what was found)"
                  data-testid="key-scan-all"
                >
                  Scan to end
                </button>
              </>
            )}
            <label className="inline-field scan-count" title="Keyspace slots each scan examines before it stops (a preference kept in this browser)">
              <span>Keys to scan</span>
              <select
                value={scanCount}
                onChange={(e) => setScanCount(Number(e.target.value))}
                aria-label="Keys to scan"
                data-testid="key-scan-count"
              >
                {[...new Set([...SCAN_COUNT_CHOICES, scanCount])].sort((a, b) => a - b).map((n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <small aria-live="polite">
              {busy === "all"
                ? `Scanning… ${results.toLocaleString()} found · ${scannedShown.toLocaleString()} / ${(state?.dbSize ?? 0).toLocaleString()} scanned`
                : capped
                  ? `Stopped at ${SCAN_CAP.toLocaleString()} keys. Narrow the pattern to see the rest.`
                  : state?.done
                    ? "Cursor returned to 0"
                    : state && state.threshold < scanCount
                      ? `This server scans at most ${state.threshold.toLocaleString()} keys per step`
                      : ""}
            </small>
          </footer>
        </section>
        <Resizer width={listWidth || 480} onChange={setListWidth} />
        {selected ? (
          <KeyInspector
            key={keyToParam(selected)}
            selected={selected}
            delimiter={delimiter}
            onDeleted={() => {
              removeLocal([selected]);
              setSelected(undefined);
            }}
            onRenamed={(from, to) => {
              const id = keyId(from);
              const moved = meta.get(id);
              // The browser does not match glob patterns itself: under a pattern the new name may not match.
              if (filter.match === "*") scan.patch((list) => list.map((key) => (keyId(key) === id ? canonicalKey(to) : key)));
              else {
                scan.patch((list) => list.filter((key) => keyId(key) !== id));
                scan.markChanged();
              }
              meta.drop([id]);
              if (moved) meta.set(keyId(to), { type: moved.type, ...(moved.ttl !== undefined ? { ttl: moved.ttl } : {}), ...(moved.size !== undefined ? { size: moved.size } : {}), readAt: moved.readAt });
              setChecked(new Map());
              setSelected(to);
            }}
            onRead={(details) => {
              const id = keyId(details.key);
              const current = meta.get(id);
              if (current && current.ttl === details.ttl && current.size === details.size && current.type === details.type) return;
              meta.set(id, { type: details.type, ttl: details.ttl, ...(details.size !== undefined ? { size: details.size } : {}) });
            }}
          />
        ) : (
          <section className="inspector" data-testid="key-detail" aria-label="Key inspector">
            <Empty title="Select a key to inspect it.">
              <span>
                The inspector shows the value with formatter tabs, the TTL as it burns down, the encoding and memory, and the
                commands that read it.
              </span>
              <dl className="key-browser-hints">
                <dt>
                  <kbd>↑</kbd> <kbd>↓</kbd>
                </dt>
                <dd>Move through the list</dd>
                <dt>
                  <kbd>→</kbd> <kbd>←</kbd>
                </dt>
                <dd>Open or close a namespace</dd>
                <dt>
                  <kbd>Enter</kbd>
                </dt>
                <dd>Inspect the key</dd>
                <dt>
                  <kbd>Space</kbd>
                </dt>
                <dd>Select for bulk actions (Shift extends)</dd>
                <dt>
                  <kbd>F</kbd>
                </dt>
                <dd>Filter to the folder</dd>
                {writable && (
                  <>
                    <dt>
                      <kbd>Delete</kbd>
                    </dt>
                    <dd>Delete keys in the folder…</dd>
                  </>
                )}
                <dt>
                  <kbd>/</kbd>
                </dt>
                <dd>Edit the pattern</dd>
              </dl>
            </Empty>
          </section>
        )}
      </div>
      {creating && (
        <KeyEditor
          onClose={() => setCreating(false)}
          onSaved={async (created) => {
            if (!created) return;
            const key = canonicalKey(created.key);
            const id = keyId(key);
            // Only an unfiltered list surely contains the new key; otherwise it opens in the inspector and the
            // list says it needs a refresh (the browser does not match glob patterns itself).
            if (filter.match === "*" && (!filter.type || filter.type === created.type))
              scan.patch((list) => (list.some((item) => keyId(item) === id) ? list : [...list, key]), 1);
            else {
              scan.patch((list) => list, 1);
              scan.markChanged();
            }
            meta.set(id, { type: created.type, ttl: created.ttl });
            setSelected(created.key);
          }}
        />
      )}
      {bulk && (
        <BulkDelete
          initial={bulk}
          job={job}
          onClose={() => setBulk(undefined)}
          delimiter={delimiter}
        />
      )}
    </div>
  );
}

/**
 * Delete by pattern: a read-only SCAN sample first, then the server's impact challenge (count, sample, typed name,
 * reason on production), then a job whose counts update live and which Stop ends between batches.
 */
function BulkDelete({
  initial,
  job,
  onClose,
  delimiter,
}: {
  initial: ScanFilter;
  job: ReturnType<typeof useBulkJob>;
  onClose: () => void;
  delimiter: string;
}) {
  const db = useDatabase();
  const [match, setMatch] = useState(initial.match);
  const [type, setType] = useState(initial.type);
  const [preview, setPreview] = useState<ScanResponse>();
  const version = useRef(0);
  const [reviewed, setReviewed] = useState<ScanFilter>();
  const [stopError, setStopError] = useState<unknown>();
  /** The job this dialog started (its report stays until "New delete"); a job still running is always shown. */
  const [startedId, setStartedId] = useState<string>();
  const info = job.info;
  const current = info && (info.job.state === "running" || info.job.id === startedId) ? info : undefined;
  const reset = () => {
    version.current++;
    setPreview(undefined);
    setReviewed(undefined);
  };
  const expected = current?.job.expected;
  return (
    <Modal title="Delete keys by pattern" onClose={onClose} testId="bulk-delete-dialog">
      {current ? null : (
        <ActionForm
          label="Preview matches"
          testId="bulk-delete-preview"
          disabled={!match.trim() || /^[*?]+$/.test(match) || job.running}
          onSubmit={async () => {
            const currentVersion = version.current;
            const page = await request<ScanResponse>(dbPath(db.id, "/keys/scan"), {
              method: "POST",
              body: { match, type: type || undefined, cursor: "0", count: 200 },
            });
            if (currentVersion !== version.current) throw new Error("The pattern or type changed. Preview again before deleting.");
            setPreview(page);
            setReviewed({ match, type });
          }}
        >
          <p className="dialog-lead">
            First preview a read-only sample. Then review: the server counts the keys again and asks you to confirm
            before anything is deleted. The delete runs as a job you can watch and stop.
          </p>
          <div className="form-row">
            <Field label="Pattern" hint="A scoped glob pattern. A pattern of only * or ? is refused.">
              <input
                required
                autoFocus
                className="data"
                value={match}
                maxLength={512}
                spellCheck={false}
                onChange={(e) => {
                  reset();
                  setMatch(e.target.value);
                }}
                data-testid="bulk-delete-pattern"
              />
            </Field>
            <Field label="Type">
              <select
                aria-label="Bulk delete type"
                value={type}
                onChange={(e) => {
                  reset();
                  setType(e.target.value);
                }}
              >
                <option value="">All types</option>
                {TYPES.slice(0, 8).map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </Field>
          </div>
        </ActionForm>
      )}
      {preview && reviewed && !current && (
        <section className="bulk-preview">
          <h3>
            Preview sample · {preview.keys.length.toLocaleString()} matches in {preview.scanned.toLocaleString()} keys scanned
          </h3>
          <p className="muted">
            {preview.cursor !== "0" ? "This is a partial scan; more matches may exist." : "The scan covered the whole database."} Keys can
            change before deletion.
          </p>
          {preview.keys.length ? (
            <ul className="key-sample">
              {preview.keys.slice(0, 20).map((item, i) => (
                <li key={i}>
                  <TypeGlyph type={item.type} />
                  <KeyName name={item.key} delimiter={delimiter || ":"} />
                </li>
              ))}
              {preview.keys.length > 20 && <li className="muted">+{(preview.keys.length - 20).toLocaleString()} more in this sample</li>}
            </ul>
          ) : (
            <p>No keys matched in this sample.</p>
          )}
          <ActionForm
            danger
            label="Review and delete…"
            testId="bulk-delete-review"
            disabled={job.running}
            onSubmit={async () => {
              setStartedId((await job.start(reviewed)).id);
              setPreview(undefined);
              setReviewed(undefined);
            }}
          >
            {job.running && <p className="muted">Another delete by pattern is still running. Wait for it or stop it first.</p>}
          </ActionForm>
        </section>
      )}
      {current && (
        <section className="bulk-job" data-testid="bulk-job" data-state={current.job.state} aria-live="polite">
          <h3>
            <code>{visibleText(current.filter.match)}</code>
            {current.filter.type && <> · {current.filter.type}</>}
          </h3>
          {current.job.state === "running" && (
            <progress
              max={expected || undefined}
              value={expected ? Math.min(expected, current.job.deleted + current.job.failed) : undefined}
              aria-label="Delete progress"
            />
          )}
          <dl className="bulk-counts">
            <dt>Deleted</dt>
            <dd data-testid="bulk-job-deleted">{current.job.deleted.toLocaleString()}</dd>
            <dt>Scanned</dt>
            <dd>{current.job.scanned.toLocaleString()}</dd>
            {expected !== undefined && (
              <>
                <dt>Counted at confirmation</dt>
                <dd>{expected.toLocaleString()}</dd>
              </>
            )}
            <dt>Failed</dt>
            <dd>{current.job.failed.toLocaleString()}</dd>
            <dt>Time</dt>
            <dd>{(current.job.elapsedMs / 1000).toFixed(1)} s</dd>
          </dl>
          {current.job.errors.length > 0 && (
            <ul className="bulk-errors" aria-label="Errors by code">
              {current.job.errors.map((e) => (
                <li key={e.code}>
                  <code>{e.code}</code> × {e.count.toLocaleString()}
                </li>
              ))}
            </ul>
          )}
          <p role="status" className={`notice ${current.job.state === "done" ? "success" : current.job.state === "running" ? "" : "warning"}`}>
            {jobSummary(current.job)}
          </p>
          <ErrorState error={stopError} />
          <div className="actions">
            {current.job.state === "running" ? (
              <>
                <button
                  type="button"
                  className="danger"
                  onClick={() => void job.cancel().catch(setStopError)}
                  data-testid="bulk-job-stop"
                >
                  Stop
                </button>
                <small className="muted">Closing this dialog does not stop the delete; Stop does, between batches.</small>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  job.dismiss();
                  setStartedId(undefined);
                  reset();
                }}
              >
                New delete
              </button>
            )}
          </div>
        </section>
      )}
    </Modal>
  );
}
