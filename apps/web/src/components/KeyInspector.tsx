import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import {
  Clock,
  Info,
  Maximize2,
  Minimize2,
  Pencil,
  RefreshCw,
  TextCursorInput,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  binFromString,
  keyToParam,
  type Bin,
  type EditConflict,
  type EditExpect,
  type KeyDetails,
  type KeyOp,
} from "@rconsole/shared";
import { dbPath, request, RequestError } from "../lib/api.ts";
import { canWrite, useDatabase } from "../lib/context.tsx";
import {
  bytesLabel,
  cliBin,
  namespaceRecipe,
  ttlLabel,
  visibleText,
  type ValueFormat,
} from "../lib/format.ts";
import { useMemorySlot } from "../lib/memory.tsx";
import { keyExpect } from "../lib/expect.ts";
import { keyOperation } from "../lib/operations.ts";
import { KeyName, TtlFuse, TypeGlyph } from "./anatomy.tsx";
import { ConflictNotice, conflictOf, HandledError } from "./Conflict.tsx";
import { CollectionLookup, type CollectionCriteria } from "./CollectionLookup.tsx";
import { MultiEntryAdd } from "./MultiEntryAdd.tsx";
import { KeyContent } from "./KeyContent.tsx";
import { KeyEditor } from "./KeyOperations.tsx";
import {
  ActionForm,
  CopyButton,
  Empty,
  ErrorState,
  Field,
  Loading,
  Modal,
} from "./ui.tsx";
import { MakeSearchableButton } from "./MakeSearchable.tsx";

/** The redis-cli command that reads this key's value (shown, copied and sent to the console). */
export function readCommand(details: KeyDetails) {
  const key = cliBin(details.key);
  switch (details.value.type) {
    case "string":
      return `GET ${key}`;
    case "hash":
      return `HSCAN ${key} 0 COUNT 100`;
    case "list":
      return `LRANGE ${key} 0 99`;
    case "set":
      return `SSCAN ${key} 0 COUNT 100`;
    case "zset":
      return `ZRANGE ${key} 0 99 WITHSCORES`;
    case "stream":
      return `XRANGE ${key} - + COUNT 100`;
    case "json":
      return `JSON.GET ${key} $`;
    case "timeseries":
      return `TS.RANGE ${key} - +`;
    default:
      return `TYPE ${key}`;
  }
}

/** Actual default inspector read sequence; GETRANGE is bounded by the server preview limit. */
export function inspectCommands(key: Bin, details?: KeyDetails) {
  const k = cliBin(key);
  const common = `TYPE ${k}\nTTL ${k}\nOBJECT ENCODING ${k}\nMEMORY USAGE ${k}`;
  if (!details)
    return (
      common +
      "\n# Then the matching type read:\n" +
      [
        `STRLEN ${k}; GETRANGE ${k} 0 65535`,
        `HLEN ${k}; HSCAN ${k} 0 COUNT 100`,
        `LLEN ${k}; LRANGE ${k} 0 99`,
        `SCARD ${k}; SSCAN ${k} 0 COUNT 100`,
        `ZCARD ${k}; ZRANGE ${k} 0 99 WITHSCORES`,
        `XLEN ${k}; XINFO STREAM ${k}; XREVRANGE ${k} + - COUNT 100`,
        `JSON.GET ${k}`,
        `TS.INFO ${k}; TS.REVRANGE ${k} - + COUNT 100`,
      ].join("\n")
    );
  const reads: Record<string, string> = {
    string: `STRLEN ${k}\n${details.length === 0 ? "# Empty string; no value read" : `GETRANGE ${k} 0 ${Math.max(0, Math.min(details.length ?? 65536, 65536) - 1)}`}`,
    hash: `HLEN ${k}\nHSCAN ${k} 0 COUNT 100`,
    list: `LLEN ${k}\nLRANGE ${k} 0 99`,
    set: `SCARD ${k}\nSSCAN ${k} 0 COUNT 100`,
    zset: `ZCARD ${k}\nZRANGE ${k} 0 99 WITHSCORES`,
    stream: `XLEN ${k}\nXINFO STREAM ${k}\nXREVRANGE ${k} + - COUNT 100`,
    json: `JSON.GET ${k}`,
    timeseries: `TS.INFO ${k}\nTS.REVRANGE ${k} - + COUNT 100`,
  };
  return (
    common + "\n" + (reads[details.value.type] ?? "# No supported value reader")
  );
}

/** Text to copy for a key name: the name itself, or its escaped redis-cli form for binary keys. */
export function keyCopyText(key: Bin) {
  return key.enc === "utf8" ? key.data : cliBin(key);
}

function sizeFacts(details: KeyDetails) {
  const length = details.length;
  if (length === undefined) return undefined;
  const unit: Record<string, [string, string]> = {
    string: ["byte", "bytes"],
    hash: ["field", "fields"],
    list: ["item", "items"],
    set: ["member", "members"],
    zset: ["member", "members"],
    stream: ["entry", "entries"],
  };
  const [one, many] = unit[details.value.type] ?? ["element", "elements"];
  return `${length.toLocaleString()} ${length === 1 ? one : many}`;
}

function editLabel(details: KeyDetails) {
  switch (details.value.type) {
    case "hash":
      return "Set field";
    case "list":
      return "Add item";
    case "set":
    case "zset":
      return "Add member";
    case "stream":
      return "Add entry";
    case "timeseries":
      return "Add sample";
    default:
      return "Edit value";
  }
}

/** The inspector pane: key anatomy, TTL fuse, facts, actions, formatter tabs or element tables, paging. */
export function KeyInspector({
  selected,
  delimiter,
  onDeleted,
  onRead,
  onRenamed,
}: {
  selected: Bin;
  delimiter: string;
  onDeleted: () => void;
  /** Every successful read, so the list row can show the same TTL, size and type. */
  onRead?: (details: KeyDetails) => void;
  /** After a successful rename, so the browser can follow the key to its new name. */
  onRenamed?: (from: Bin, to: Bin) => void;
}) {
  const db = useDatabase();
  const writable = canWrite(db);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [cursor, setCursor] = useState("0");
  const [offset, setOffset] = useState(0);
  const [streamSeen, setStreamSeen] = useState(0);
  const [full, setFull] = useState(false);
  const [collectionFormat, setCollectionFormat] = useMemorySlot<ValueFormat>(`${db.id}:collection:format:${keyToParam(selected)}`, "text");
  const [columnWidth, setColumnWidth] = useMemorySlot(`${db.id}:collection:width:${keyToParam(selected)}`, 35);
  const [criteria, setCriteria] = useState<CollectionCriteria>({});
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [, setConsoleDraft] = useMemorySlot(`${db.id}:console:draft`, "");
  /** Full-width inspector (the key list is hidden); session memory only, read by the key browser's split. */
  const [wide, setWide] = useMemorySlot("keys:inspector-wide", false);
  const [refreshInterval, setRefreshInterval] = useState(0);
  const [action, setAction] = useState<"ttl" | "rename" | null>(null);
  const [ttl, setTtl] = useState("3600");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<unknown>();
  const [explain, setExplain] = useState(false);
  /** Remounts the editor on the current read (Reload after a conflict). */
  const [editorKey, setEditorKey] = useState(0);
  /** A delete or rename refused because the key changed since it was read (compare-and-set, review r3). */
  const [keyConflict, setKeyConflict] = useState<{ action: "delete" | "rename"; conflict: EditConflict }>();
  const [deciding, setDeciding] = useState(false);
  const queryKey = ["key", db.id, keyToParam(selected), cursor, offset, full, criteria];
  const detail = useQuery({
    queryKey,
    refetchInterval: refreshInterval || false,
    queryFn: ({ signal }) =>
      request<KeyDetails>(dbPath(db.id, "/key/read"), {
        method: "POST",
        body: {
          ...criteria,
          key: selected,
          cursor: cursor === "0" ? undefined : cursor,
          offset,
          count: 100,
          full,
        },
        signal,
        background: true,
      }),
  });
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["keys", db.id] });
    await client.invalidateQueries({
      queryKey: ["key", db.id, keyToParam(selected)],
    });
  };
  const data = detail.data;
  useEffect(() => {
    if (data) onRead?.(data);
  }, [data]);
  const editable = (d: KeyDetails | undefined) =>
    !!d && d.value.type !== "unsupported" && !((d.value.type === "string" || d.value.type === "json") && d.value.truncated);
  /** Delete this key, expecting what the inspector last read (or, after a conflict, what the conflict showed). */
  const deleteKey = (expect?: EditExpect) => {
    if (!data) return;
    setError(undefined);
    setDeciding(true);
    void keyOperation(db.id, { op: "key.delete", keys: [selected], expect: expect ?? keyExpect(data) })
      .then(async () => {
        setKeyConflict(undefined);
        onDeleted();
        await refresh();
      })
      .catch((caught: unknown) => {
        const conflict = conflictOf(caught);
        if (conflict) setKeyConflict({ action: "delete", conflict });
        else setError(caught);
      })
      .finally(() => setDeciding(false));
  };
  const rename = async (expect?: EditExpect) => {
    const body: KeyOp = { op: "key.rename", key: selected, newKey: binFromString(newName), nx: true, expect: expect ?? keyExpect(data!) };
    try {
      await keyOperation(db.id, body);
    } catch (caught) {
      const conflict = conflictOf(caught);
      if (!conflict) throw caught;
      setKeyConflict({ action: "rename", conflict });
      throw new HandledError("conflict");
    }
    setKeyConflict(undefined);
    setAction(null);
    onRenamed?.(selected, body.newKey);
  };
  const missing =
    detail.error instanceof RequestError && detail.error.status === 404;
  const firstPage = cursor === "0" && offset === 0;
  return (
    <section
      className="inspector"
      data-testid="key-detail"
      aria-label="Key inspector"
    >
      {missing ? (
        <Empty
          title="This key no longer exists."
          action={
            <button
              type="button"
              onClick={() => {
                onDeleted();
                void refresh();
              }}
            >
              Close and rescan
            </button>
          }
        >
          <span>
            It expired or was deleted after the scan listed it. Close it and
            rescan to refresh the list.
          </span>
        </Empty>
      ) : (
        <ErrorState
          error={detail.error}
          onRetry={() => {
            void detail.refetch();
          }}
        />
      )}
      {wide && !data && !detail.isPending && (
        <p className="actions">
          <button type="button" onClick={() => setWide(false)}>
            Show the key list
          </button>
        </p>
      )}
      {detail.isPending && <Loading label="Reading key…" />}
      {data && !missing && (
        <>
          <header className="inspector-head">
            <div className="inspector-title">
              <TypeGlyph type={data.type} />
              <h2 className="key-title" dir="ltr">
                <KeyName
                  name={data.key}
                  delimiter={delimiter || ":"}
                  className="wrap"
                />
              </h2>
              <CopyButton
                text={keyCopyText(data.key)}
                label="Copy key name"
                iconOnly
              />
              <button
                type="button"
                className="icon-button inspector-wide-toggle"
                aria-pressed={wide}
                aria-label={wide ? "Show the key list" : "Maximize inspector"}
                title={wide ? "Show the key list" : "Maximize inspector"}
                onClick={() => setWide(!wide)}
                data-testid="inspector-wide"
              >
                {wide ? (
                  <Minimize2 size={14} aria-hidden="true" />
                ) : (
                  <Maximize2 size={14} aria-hidden="true" />
                )}
              </button>
            </div>
            <div className="inspector-facts">
              <TtlFuse
                ttl={data.ttl}
                readAt={detail.dataUpdatedAt}
                size="full"
              />
              <span title="MEMORY USAGE">{bytesLabel(data.size)}</span>
              {data.encoding && (
                <span title="OBJECT ENCODING">{data.encoding}</span>
              )}
              {sizeFacts(data) && <span>{sizeFacts(data)}</span>}
            </div>
            <div className="inspector-actions" role="toolbar" aria-label="Key actions">
              {writable && (
                <div className="action-group">
                  {data.value.type !== "unsupported" &&
                    !(
                      (data.value.type === "string" ||
                        data.value.type === "json") &&
                      data.value.truncated
                    ) && (
                      <button
                        type="button"
                        onClick={() => setEditing(true)}
                        data-testid="key-edit"
                      >
                        <Pencil size={13} aria-hidden="true" />
                        {editLabel(data)}
                      </button>
                    )}
                  {["hash", "list", "set", "zset"].includes(data.value.type) && <button type="button" onClick={() => setAdding(true)} data-testid="collection-add">Add multiple entries</button>}
                  <button
                    type="button"
                    onClick={() => {
                      setTtl(data.ttl > 0 ? String(data.ttl) : "3600");
                      setAction("ttl");
                    }}
                    data-testid="key-ttl"
                  >
                    <Clock size={13} aria-hidden="true" />
                    TTL
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setNewName(selected.enc === "utf8" ? selected.data : "");
                      setAction("rename");
                    }}
                    data-testid="key-rename"
                  >
                    <TextCursorInput size={13} aria-hidden="true" />
                    Rename
                  </button>
                  <button
                    type="button"
                    className="ghost danger-text"
                    disabled={deciding}
                    onClick={() => deleteKey()}
                    data-testid="key-delete"
                    aria-label="Delete key"
                    title="Delete key (asks the server for confirmation)"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    Delete
                  </button>
                </div>
              )}
              <div className="action-group end">
                <CopyButton text={readCommand(data)} label="Copy CLI" />
                <MakeSearchableButton keyName={data.key} type={data.type} delimiter={delimiter} />
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setConsoleDraft(readCommand(data));
                    navigate("../console");
                  }}
                  title="Open the read command in the console"
                >
                  <Terminal size={13} aria-hidden="true" />
                  Console
                </button>
                <button
                  type="button"
                  className="ghost"
                  aria-pressed={explain}
                  onClick={() => setExplain(!explain)}
                  data-testid="key-explain"
                >
                  <Info size={13} aria-hidden="true" />
                  Explain
                </button>
                <label className="refresh-select" title="Re-read this key on an interval">
                  <span className="sr-only">Auto refresh</span>
                  <select
                    aria-label="Key refresh interval"
                    value={refreshInterval}
                    onChange={(e) => setRefreshInterval(Number(e.target.value))}
                  >
                    <option value={0}>Auto refresh off</option>
                    <option value={5000}>Every 5 s</option>
                    <option value={15000}>Every 15 s</option>
                    <option value={30000}>Every 30 s</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Refresh key"
                  title="Refresh key"
                  onClick={() => {
                    void detail.refetch();
                  }}
                >
                  <RefreshCw
                    size={14}
                    className={detail.isFetching ? "spin" : undefined}
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>
            <ErrorState error={error} />
            {keyConflict?.action === "delete" && (
              <ConflictNotice
                conflict={keyConflict.conflict}
                title="This key changed since you read it."
                overwriteLabel="Delete anyway"
                busy={deciding}
                onReload={() => {
                  setKeyConflict(undefined);
                  void detail.refetch();
                }}
                onOverwrite={(expect) => deleteKey(expect)}
              />
            )}
          </header>
          {explain && (
            <aside className="explain-panel" aria-label="Explain this key">
              <dl className="facts">
                <dt>Type</dt>
                <dd>{data.type}</dd>
                <dt>Encoding</dt>
                <dd>{data.encoding ?? "Unavailable"}</dd>
                <dt>Memory</dt>
                <dd>{bytesLabel(data.size)}</dd>
                <dt>Length</dt>
                <dd>{sizeFacts(data) ?? "—"}</dd>
                <dt>Expiry</dt>
                <dd>{ttlLabel(data.ttl)}</dd>
              </dl>
              <div className="explain-commands">
                <h3>Read it with redis-cli</h3>
                <pre className="data">{visibleText(readCommand(data))}</pre>
                <h3>What the inspector ran</h3>
                <pre className="data">
                  {visibleText(inspectCommands(data.key, data))}
                </pre>
              </div>
            </aside>
          )}
          {namespaceRecipe(data.key) && (
            <p className="notice">
              {namespaceRecipe(data.key)}. Read it with{" "}
              <code>{visibleText(readCommand(data))}</code>.
            </p>
          )}
          {["hash", "list", "set", "zset", "stream"].includes(data.value.type) && <CollectionLookup key={data.value.type} type={data.value.type} initial={criteria} offset={offset} apply={(next, at = 0) => { setCriteria(next); setCursor("0"); setOffset(at); setStreamSeen(0); setEditing(false); setAdding(false); }} />}
          {data.filter && <p className="notice" data-testid="collection-filter-count">{data.filter.totalMatches === undefined ? `${data.filter.matches} filter matches on this page (scan count is a hint; total matches unknown)` : `${data.filter.totalMatches} filter matches · ${data.filter.matches} on this page`}. Collection total: {data.length?.toLocaleString()}.</p>}
          <div className="inspector-body">
            {/* Keyed by page: changing page (even to a cached one) closes any open row editor. */}
            <KeyContent
              key={`${cursor}|${offset}|${full}|${JSON.stringify(criteria)}`}
              details={data}
              refresh={refresh}
              valueFormat={collectionFormat} onValueFormat={setCollectionFormat}
              columnWidth={columnWidth} onColumnWidth={setColumnWidth}
            />
          </div>
          <footer className="inspector-foot">
            {!firstPage && (
              <button
                type="button"
                onClick={() => {
                  setCursor("0");
                  setOffset(0);
                  setStreamSeen(0);
                }}
              >
                First page
              </button>
            )}
            {(data.value.type === "hash" || data.value.type === "set" || (data.value.type === "zset" && data.value.cursor !== undefined)) &&
              !(firstPage && data.value.cursor === "0") && (
              <button
                type="button"
                disabled={data.value.cursor === "0"}
                onClick={() => {
                  if (data.value.type === "hash" || data.value.type === "set" || (data.value.type === "zset" && data.value.cursor !== undefined))
                    setCursor(data.value.cursor ?? "0");
                }}
                data-testid="key-next-page"
              >
                Next page
              </button>
            )}
            {offset > 0 && (data.value.type === "list" || (data.value.type === "zset" && data.value.cursor === undefined)) && <button type="button" onClick={() => setOffset(Math.max(0, offset - 100))}>Previous page</button>}
            {(data.value.type === "list" || (data.value.type === "zset" && data.value.cursor === undefined)) &&
              !(firstPage && hasNoMore(data)) && (
              <button
                type="button"
                disabled={
                  data.value.type === "list"
                    ? !data.value.items.length ||
                      data.value.offset + data.value.items.length >=
                        data.value.total
                    : !data.value.members.length ||
                      data.value.offset + data.value.members.length >=
                        (data.value.matchedTotal ?? data.value.total)
                }
                onClick={() => {
                  if (data.value.type === "list")
                    setOffset(data.value.offset + data.value.items.length);
                  else if (data.value.type === "zset")
                    setOffset(data.value.offset + data.value.members.length);
                }}
                data-testid="key-next-page"
              >
                Next page
              </button>
            )}
            {data.value.type === "stream" && (
              <button
                type="button"
                disabled={
                  !data.value.entries.length ||
                  streamSeen + data.value.entries.length >= data.value.total
                }
                onClick={() => {
                  if (data.value.type === "stream") {
                    const id = data.value.entries.at(-1)?.id;
                    if (id) {
                      const count = data.value.entries.length;
                      setStreamSeen((previous) => previous + count);
                      setCursor(id);
                    }
                  }
                }}
                data-testid="key-next-page"
              >
                Older entries
              </button>
            )}
            {(data.value.type === "string" || data.value.type === "json") &&
              data.value.truncated &&
              !full && (
                <button
                  type="button"
                  onClick={() => setFull(true)}
                  data-testid="key-load-full"
                >
                  Load full value (server capped)
                </button>
              )}
            <span className="page-note">{pageNote(data, streamSeen)}</span>
          </footer>
          {adding && <MultiEntryAdd details={data} onClose={() => setAdding(false)} refresh={refresh} />}
          {editing && (
            <KeyEditor
              key={editorKey}
              details={data}
              current={data}
              onClose={() => setEditing(false)}
              onSaved={refresh}
              onReload={() => {
                // Reopen on the fresh read; a key that is gone or no longer editable closes the editor.
                void refresh().then(() => {
                  const state = client.getQueryState<KeyDetails>(queryKey);
                  if (state?.status === "success" && editable(state.data)) setEditorKey((n) => n + 1);
                  else setEditing(false);
                });
              }}
            />
          )}
          {action && (
            <Modal
              title={action === "ttl" ? "Set expiry" : "Rename key"}
              onClose={() => {
                setAction(null);
                setKeyConflict(undefined);
              }}
              testId={`key-${action}-dialog`}
            >
              <p className="dialog-subject">
                <TypeGlyph type={data.type} />
                <KeyName name={data.key} delimiter={delimiter || ":"} className="wrap" />
              </p>
              <ActionForm
                label={action === "ttl" ? "Set expiry" : "Rename key"}
                testId={`key-${action}-submit`}
                disabled={action === "rename" && keyConflict?.action === "rename"}
                onSubmit={async () => {
                  if (action === "rename") return rename();
                  const body: KeyOp =
                    ttl === "-1"
                      ? { op: "key.persist", key: selected }
                      : { op: "key.expire", key: selected, ttl: Number(ttl) };
                  await keyOperation(db.id, body);
                  setAction(null);
                  await refresh();
                }}
              >
                {action === "ttl" ? (
                  <Field
                    label="TTL in seconds"
                    hint="Positive whole seconds set an expiry (EXPIRE). -1 removes it (PERSIST)."
                  >
                    <input
                      type="number"
                      required
                      autoFocus
                      value={ttl}
                      onChange={(e) => setTtl(e.target.value)}
                      data-testid="key-ttl-input"
                    />
                  </Field>
                ) : (
                  <Field
                    label="New key name"
                    hint="Uses RENAMENX: the rename fails if the new name already exists."
                  >
                    <input
                      required
                      autoFocus
                      className="data"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      data-testid="key-rename-input"
                    />
                  </Field>
                )}
                {action === "rename" && keyConflict?.action === "rename" && (
                  <ConflictNotice
                    conflict={keyConflict.conflict}
                    title="This key changed since you read it."
                    overwriteLabel="Rename anyway"
                    busy={deciding}
                    onReload={() => {
                      setKeyConflict(undefined);
                      void detail.refetch();
                    }}
                    onOverwrite={(expect) => {
                      setDeciding(true);
                      void rename(expect)
                        .catch((caught: unknown) => { if (!(caught instanceof HandledError)) setError(caught); })
                        .finally(() => setDeciding(false));
                    }}
                  />
                )}
              </ActionForm>
            </Modal>
          )}
        </>
      )}
    </section>
  );
}

function hasNoMore(details: KeyDetails) {
  const value = details.value;
  if (value.type === "list")
    return value.offset + value.items.length >= value.total;
  if (value.type === "zset")
    return value.offset + value.members.length >= (value.matchedTotal ?? value.total);
  return true;
}

function pageNote(details: KeyDetails, streamSeen: number) {
  const value = details.value;
  switch (value.type) {
    case "hash":
      return `${value.entries.length} of ${value.total.toLocaleString()} fields on this page (HSCAN).`;
    case "set":
      return `${value.members.length} of ${value.total.toLocaleString()} members on this page (SSCAN).`;
    case "list":
      return value.items.length
        ? `Items ${value.offset}–${value.offset + value.items.length - 1} of ${value.total.toLocaleString()}.`
        : `No items at offset ${value.offset}.`;
    case "zset":
      if (value.cursor !== undefined) return `${value.members.length} members on this page of ${value.total.toLocaleString()} total (ZSCAN; scan order).`;
      return value.members.length
        ? `Members ${value.offset}–${value.offset + value.members.length - 1} of ${(value.matchedTotal ?? value.total).toLocaleString()}, ${value.reverse ? "highest" : "lowest"} score first.`
        : `No members at offset ${value.offset}.`;
    case "stream":
      return `Entries ${streamSeen + 1}–${streamSeen + value.entries.length} of ${value.total.toLocaleString()}, newest first.`;
    default:
      return "Values are shown as text; control and bidirectional characters are escaped.";
  }
}
