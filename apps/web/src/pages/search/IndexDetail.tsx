import { useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Bin, SearchIndexDetail, SearchIndexDropResponse } from "@rconsole/shared";
import { canAdmin, useDatabase } from "../../lib/context.tsx";
import { dbPath, post, request } from "../../lib/api.ts";
import { visibleText } from "../../lib/format.ts";
import { useMemorySlot } from "../../lib/memory.tsx";
import { DataTable, ErrorState, Loading } from "../../components/ui.tsx";
import { KeyName } from "../../components/anatomy.tsx";
import { RefreshButton } from "../../components/toolChrome.tsx";

/** FT.INFO of one index (index name in the request body, never the URL). */
export function useIndexDetail(index: string) {
  const db = useDatabase();
  return useQuery<SearchIndexDetail>({
    queryKey: ["search-index-info", db.id, index],
    enabled: !!index,
    // While Redis indexes existing keys, keep the progress current.
    refetchInterval: (q) => (q.state.data?.indexing ? 1500 : false),
    queryFn: ({ signal }) =>
      request<SearchIndexDetail>(dbPath(db.id, "/search/index/info"), { method: "POST", body: { index }, signal, background: true }),
  });
}

/** Field names a query refers to (the attribute, i.e. the alias), with type and whether SORTBY can use it. */
export function queryFields(detail: SearchIndexDetail | undefined) {
  return (detail?.fields ?? []).map((f) => ({
    name: f.attribute || f.identifier,
    type: f.type,
    sortable: f.options.some((o) => /^SORTABLE\b/i.test(o)),
  }));
}

const mb = (n: number) => (n >= 1 ? `${n.toFixed(2)} MB` : n > 0 ? `${(n * 1024).toFixed(1)} KB` : "0");

/** Full detail of one index: definition, schema, status, errors, memory and other FT.INFO facts; drop for admins. */
export function IndexDetail({ index, onQuery, onDropped }: { index: string; onQuery: () => void; onDropped: () => void }) {
  const db = useDatabase();
  const client = useQueryClient();
  const navigate = useNavigate();
  const detail = useIndexDetail(index);
  const [, setSelectedKey] = useMemorySlot<Bin | undefined>(`${db.id}:selected-key`, undefined);
  const [deleteDocs, setDeleteDocs] = useState(false);
  const [error, setError] = useState<unknown>();
  const [dropping, setDropping] = useState(false);
  const d = detail.data;
  const pct = d?.percentIndexed;
  return (
    <section className="section index-detail" aria-label={`Index ${index}`} data-testid="search-index-detail">
      <header>
        <h2 className="data">{visibleText(index)}</h2>
        <span className="meta">FT.INFO</span>
        <div className="actions">
          <RefreshButton busy={detail.isFetching} onClick={() => void detail.refetch()} />
          <button type="button" onClick={onQuery} data-testid="search-index-query">
            Query this index
          </button>
        </div>
      </header>
      {detail.isPending ? (
        <Loading label="Reading the index…" />
      ) : (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      )}
      {d && (
        <>
          <dl className="facts">
            <dt>Keys</dt>
            <dd>{d.on === "JSON" ? "JSON documents" : d.on === "HASH" ? "Hashes" : visibleText(d.on)}</dd>
            <dt>Prefixes</dt>
            <dd className="data">{d.prefixes.length ? d.prefixes.map((p) => visibleText(p || '""')).join("  ·  ") : "(every key)"}</dd>
            {d.filter && (
              <>
                <dt>Filter</dt>
                <dd className="data">{visibleText(d.filter)}</dd>
              </>
            )}
            {d.language && (
              <>
                <dt>Language</dt>
                <dd>{visibleText(d.language)}</dd>
              </>
            )}
            {d.options.length > 0 && (
              <>
                <dt>Options</dt>
                <dd className="data">{d.options.map(visibleText).join(" ")}</dd>
              </>
            )}
            <dt>Documents</dt>
            <dd className="tabular" data-testid="search-index-docs">{d.numDocs.toLocaleString()}</dd>
            <dt>Status</dt>
            <dd>
              {d.indexing ? `Indexing${pct !== undefined ? ` · ${(pct * 100).toFixed(0)}%` : ""}` : "Ready"}
              {pct !== undefined && d.indexing && (
                <span className="progress-bar" aria-hidden="true">
                  <span style={{ transform: `scaleX(${Math.min(1, Math.max(0, pct))})` }} />
                </span>
              )}
            </dd>
            <dt>Indexing failures</dt>
            <dd className={d.indexingFailures ? "warn-text" : undefined}>{d.indexingFailures.toLocaleString()}</dd>
            {d.lastError && (
              <>
                <dt>Last error</dt>
                <dd>
                  <span className="data">{visibleText(d.lastError.message)}</span>
                  {d.lastError.key && (
                    <>
                      {" "}
                      on{" "}
                      <button
                        type="button"
                        className="key-link data"
                        aria-label="Open the key of the last indexing error"
                        onClick={() => {
                          setSelectedKey(d.lastError!.key);
                          navigate(`/db/${encodeURIComponent(db.id)}/keys`);
                        }}
                      >
                        <KeyName name={d.lastError.key} limit={200} />
                      </button>
                    </>
                  )}
                </dd>
              </>
            )}
          </dl>
          <h3 className="section-heading">Schema</h3>
          <DataTable
            className="dense"
            columns={["Field", "Name in queries", "Type", "Options"]}
            rows={d.fields.map((f) => [
              <code className="data">{visibleText(f.identifier)}</code>,
              <code className="data">@{visibleText(f.attribute)}</code>,
              f.type,
              <span className="data">{f.options.map(visibleText).join(" · ") || "—"}</span>,
            ])}
            empty="This index has no fields."
          />
          <div className="grid-2">
            <section className="section">
              <header>
                <h2>Memory</h2>
                <span className="meta">as FT.INFO reports it</span>
              </header>
              <DataTable
                className="dense"
                columns={["Part", <span className="num">Size</span>]}
                rows={d.memory.map((m) => [<code>{visibleText(m.name)}</code>, <span className="num tabular">{mb(m.mb)}</span>])}
                empty="No memory facts reported."
              />
            </section>
            <section className="section">
              <header>
                <h2>Other facts</h2>
              </header>
              <DataTable
                className="dense"
                columns={["Fact", "Value"]}
                rows={d.stats.map((s) => [<code>{visibleText(s.name)}</code>, <span className="data">{visibleText(s.value)}</span>])}
                empty="No other facts reported."
              />
            </section>
          </div>
          {canAdmin(db) && (
            <section className="section danger-zone">
              <header>
                <h2>Drop index</h2>
                <span className="meta">admins only · asks you to type the index name</span>
              </header>
              <p className="muted">
                Removes the index. The indexed keys stay unless you also delete them, which the server allows only when its
                policy says so.
              </p>
              <div className="actions">
                <label className="checkbox">
                  <input type="checkbox" checked={deleteDocs} onChange={(e) => setDeleteDocs(e.target.checked)} data-testid="search-drop-dd" />
                  Also delete the indexed keys (FT.DROPINDEX … DD)
                </label>
                <button
                  type="button"
                  className="danger"
                  disabled={dropping}
                  data-testid="search-index-drop"
                  onClick={() => {
                    setError(undefined);
                    setDropping(true);
                    post<SearchIndexDropResponse>(dbPath(db.id, "/search/index/drop"), { index, deleteDocuments: deleteDocs })
                      .then(async () => {
                        await client.invalidateQueries({ queryKey: ["search-indexes", db.id] });
                        onDropped();
                      })
                      .catch(setError)
                      .finally(() => setDropping(false));
                  }}
                >
                  Drop index…
                </button>
              </div>
              <ErrorState error={error} />
            </section>
          )}
        </>
      )}
    </section>
  );
}
