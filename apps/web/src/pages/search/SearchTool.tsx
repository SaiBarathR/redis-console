import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { SearchIndexSummary } from "@rconsole/shared";
import { canWrite, useDatabase } from "../../lib/context.tsx";
import { collection, dbPath, request } from "../../lib/api.ts";
import { visibleText } from "../../lib/format.ts";
import { useMemorySlot } from "../../lib/memory.tsx";
import { DataTable, Empty, ErrorState, Loading } from "../../components/ui.tsx";
import { RefreshButton, ToolHead } from "../../components/toolChrome.tsx";
import { IndexDetail } from "./IndexDetail.tsx";
import { IndexWizard } from "./IndexWizard.tsx";
import { QueryPanel } from "./QueryPanel.tsx";
import { EMPTY_FORM, searchSlots, type QueryForm } from "./state.ts";
import "../../styles/insight.css";

type Panel = "query" | "indexes" | "create";
const PANELS: { id: Panel; label: string }[] = [
  { id: "query", label: "Query" },
  { id: "indexes", label: "Indexes" },
  { id: "create", label: "New index" },
];

/**
 * Search (RediSearch): query workflow, index list and details, and the "Make searchable" index wizard.
 * The sub-view is in the URL (`?panel=`, a fixed word); index names, prefixes and queries stay in session memory.
 */
export function SearchTool() {
  const db = useDatabase();
  const [params, setParams] = useSearchParams();
  const panel: Panel = (["indexes", "create"] as const).find((p) => p === params.get("panel")) ?? "query";
  const go = (p: Panel) => setParams(p === "query" ? {} : { panel: p }, { replace: false });
  const slots = searchSlots(db.id);
  const [selected, setSelected] = useMemorySlot<string>(slots.selected, "");
  const [, setForm] = useMemorySlot<QueryForm>(slots.form, EMPTY_FORM);
  const indexes = useQuery({
    queryKey: ["search-indexes", db.id],
    queryFn: async () => collection<SearchIndexSummary>(await request(dbPath(db.id, "/search/indexes")), "indexes"),
  });
  const queryIndex = (index: string) => {
    setForm((f) => (f.index === index ? f : { ...EMPTY_FORM, index }));
    go("query");
  };
  const details = (index: string) => {
    setSelected(index);
    go("indexes");
  };
  return (
    <>
      <ToolHead
        title="Search"
        meta={indexes.data ? `${indexes.data.length} ${indexes.data.length === 1 ? "index" : "indexes"} · FT._LIST` : undefined}
      >
        <RefreshButton busy={indexes.isFetching} onClick={() => void indexes.refetch()} />
      </ToolHead>
      <div className="pane-body">
        <nav className="search-subnav segmented" aria-label="Search views">
          {PANELS.map((p) => (
            <button key={p.id} type="button" aria-pressed={panel === p.id} onClick={() => go(p.id)} data-testid={`search-panel-${p.id}`}>
              {p.label}
            </button>
          ))}
        </nav>
        <ErrorState error={indexes.error} onRetry={() => void indexes.refetch()} />
        {panel === "query" && <QueryPanel indexes={indexes.data} indexListError={!!indexes.error} onDetails={details} />}
        {panel === "indexes" && (
          <>
            <section className="section first">
              <header>
                <h2>Indexes</h2>
                <span className="meta">Choose an index for its details</span>
                <div className="actions">
                  <button type="button" onClick={() => go("create")} data-testid="search-new-index">
                    New index
                  </button>
                </div>
              </header>
              {indexes.isPending ? (
                <Loading label="Reading indexes…" />
              ) : indexes.error ? (
                <Empty compact title="The index list is not available to your role.">
                  <span>
                    The Redis user for your role may not run <code>FT._LIST</code>. Type the index name in the query view if you know
                    it, or ask an administrator to grant <code>FT._LIST</code>.
                  </span>
                </Empty>
              ) : (
                <DataTable
                  className="dense"
                  columns={["Index", <span className="num">Documents</span>, "Status", "Prefixes", "Fields"]}
                  rows={(indexes.data ?? []).map((row) => [
                    <button
                      type="button"
                      className={`ghost data group-button ${row.name === selected ? "selected" : ""}`}
                      aria-pressed={row.name === selected}
                      onClick={() => setSelected(row.name)}
                    >
                      {visibleText(row.name)}
                    </button>,
                    <span className="num tabular">{row.numDocs.toLocaleString()}</span>,
                    row.indexing ? "Indexing" : "Ready",
                    <span className="data">{row.prefixes.map(visibleText).join("  ·  ")}</span>,
                    <span className="fields">
                      {row.fields.map((field) => (
                        <code key={field.name}>
                          {visibleText(field.name)} <span className="muted">{field.type}</span>
                        </code>
                      ))}
                    </span>,
                  ])}
                  empty={
                    <>
                      <strong>No search indexes on this database.</strong>
                      <span>
                        {canWrite(db) ? (
                          <>
                            Create one with the{" "}
                            <button type="button" className="link-button" onClick={() => go("create")}>
                              index wizard
                            </button>
                            , or with <code>FT.CREATE</code> in the console.
                          </>
                        ) : (
                          "An operator or admin can create one with the index wizard."
                        )}
                      </span>
                    </>
                  }
                />
              )}
            </section>
            {selected && (
              <IndexDetail
                key={selected}
                index={selected}
                onQuery={() => queryIndex(selected)}
                onDropped={() => setSelected("")}
              />
            )}
          </>
        )}
        {panel === "create" && (
          <IndexWizard
            onCreated={(index) => {
              setSelected(index);
              go("indexes");
            }}
          />
        )}
      </div>
    </>
  );
}
