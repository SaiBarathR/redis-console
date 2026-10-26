import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowDown, ArrowUp, LockKeyhole, RefreshCw } from "lucide-react";
import type { Bin, DatabaseSummary } from "@rconsole/shared";
import { useAllDatabaseStats, useDatabaseStats, type DatabaseStats } from "../lib/dbstats.ts";
import { setPreferences, usePreferences, type Preferences } from "../lib/preferences.ts";
import { bytesLabel, uptimeLabel, visibleText } from "../lib/format.ts";
import { useMemorySlot } from "../lib/memory.tsx";
import { EnvBadge, PageTitle } from "../components/ui.tsx";
import { KeyName } from "../components/anatomy.tsx";

/** Last used first, then by name; production sorts last unless it was used last. */
export function landingOrder(
  databases: DatabaseSummary[],
  lastDatabaseId: string,
) {
  return [...databases].sort(
    (a, b) =>
      Number(b.id === lastDatabaseId) - Number(a.id === lastDatabaseId) ||
      Number(a.environment === "prod") - Number(b.environment === "prod") ||
      a.name.localeCompare(b.name),
  );
}

export type LandingSort = Preferences["landingSort"];

const METRIC: Partial<Record<LandingSort, (s: DatabaseStats) => number | null>> = {
  keys: (s) => s.keys,
  memory: (s) => s.memory,
  ops: (s) => s.opsPerSec,
  clients: (s) => s.clients,
  hitRate: (s) => s.hitRate,
  uptime: (s) => s.uptimeSeconds,
};

/**
 * The landing order for a chosen column (F21). "default" keeps last used first, then name. Metric sorts put rows
 * without a figure (unreachable, still loading) last in either direction, then fall back to name.
 */
export function sortDatabases(
  databases: DatabaseSummary[],
  lastDatabaseId: string,
  sort: LandingSort,
  descending: boolean,
  stats: Map<string, DatabaseStats | undefined>,
) {
  if (sort === "default") return landingOrder(databases, lastDatabaseId);
  const direction = descending ? -1 : 1;
  const byName = (a: DatabaseSummary, b: DatabaseSummary) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  if (sort === "name") return [...databases].sort((a, b) => direction * byName(a, b));
  const pick = METRIC[sort]!;
  const value = (db: DatabaseSummary) => {
    const s = stats.get(db.id);
    return s ? pick(s) : null;
  };
  return [...databases].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null || y === null) return Number(x === null) - Number(y === null) || byName(a, b);
    return direction * (x - y) || byName(a, b);
  });
}

/** Read-only capability badges from what the server reports: modules and server-allowed tools. Display only. */
export function capabilities(db: DatabaseSummary) {
  const names = (db.server?.modules ?? []).map((module) => module.name.toLowerCase());
  const has = (...needles: string[]) => names.some((name) => needles.some((needle) => name.includes(needle)));
  const out: { label: string; title: string }[] = [];
  if (has("search", "ft")) out.push({ label: "Search", title: "RediSearch / Query Engine module" });
  if (has("rejson", "json")) out.push({ label: "JSON", title: "RedisJSON module" });
  if (has("timeseries")) out.push({ label: "TimeSeries", title: "RedisTimeSeries module" });
  if (has("bf", "bloom")) out.push({ label: "Probabilistic", title: "Bloom, Cuckoo and other probabilistic types" });
  if (has("vectorset")) out.push({ label: "Vector sets", title: "Vector set type" });
  if (db.server && db.server.mode !== "standalone") out.push({ label: db.server.mode === "cluster" ? "Cluster" : "Sentinel", title: "Topology" });
  if (db.features.profiler) out.push({ label: "Profiler", title: "You may use the profiler here (admin, allowed environment)" });
  return out;
}

function SortHeader({
  id,
  children,
  className,
  sort,
  descending,
}: {
  id: LandingSort;
  children: ReactNode;
  className?: string;
  sort: LandingSort;
  descending: boolean;
}) {
  const active = sort === id;
  const numeric = id !== "name";
  return (
    <th className={className} aria-sort={active ? (descending ? "descending" : "ascending") : undefined}>
      <button
        type="button"
        className={`sort-header ${active ? "active" : ""}`.trim()}
        data-testid={`landing-sort-${id}`}
        title={active ? "Sorted; click to reverse, again to restore the default order" : `Sort by ${typeof children === "string" ? children.toLowerCase() : id}`}
        onClick={() => {
          // Numbers start largest first; names A–Z. A third click returns to last used first.
          if (!active) setPreferences({ landingSort: id, landingDescending: numeric });
          else if (descending === numeric) setPreferences({ landingDescending: !descending });
          else setPreferences({ landingSort: "default", landingDescending: false });
        }}
      >
        {children}
        {active &&
          (descending ? <ArrowDown size={11} aria-hidden="true" /> : <ArrowUp size={11} aria-hidden="true" />)}
      </button>
    </th>
  );
}

function StatusCell({ db }: { db: DatabaseSummary }) {
  const label =
    db.status === "connected"
      ? "Connected"
      : db.status === "connecting"
        ? "Connecting"
        : "Unreachable";
  return (
    <span className="connection" title={db.statusMessage ?? label}>
      <span className={`connection-dot ${db.status}`} />
      {label}
    </span>
  );
}

function DatabaseRow({
  db,
  index,
  last,
}: {
  db: DatabaseSummary;
  index: number;
  last: boolean;
}) {
  const stats = useDatabaseStats(db, 30000);
  const [lastKey] = useMemorySlot<Bin | undefined>(
    `${db.id}:selected-key`,
    undefined,
  );
  const s = stats.data;
  const href = `/db/${encodeURIComponent(db.id)}/overview`;
  const pending = stats.isPending && db.status !== "error";
  const missing = pending ? "…" : "—";
  return (
    <tr data-env={db.environment} className={last ? "last-used" : undefined}>
      <td className="env-cell">
        <EnvBadge environment={db.environment} />
      </td>
      <td className="name-cell">
        <Link
          to={href}
          className="db-link"
          data-row={index}
          aria-describedby={`db-${index}-meta`}
        >
          {visibleText(db.name)}
        </Link>
        <span className="db-sub" id={`db-${index}-meta`}>
          <code>{visibleText(db.id)}</code>
          {db.db !== undefined && (
            <span className="db-index-inline" data-testid="landing-db-index" title="Logical database, set in the server configuration">
              db {db.db}
            </span>
          )}
          {last && <span className="last-tag">last used</span>}
          {db.readOnly && (
            <span className="ro-tag">
              <LockKeyhole size={11} aria-hidden="true" />
              Read-only
            </span>
          )}
          {db.tags?.map((tag) => (
            <span key={tag} className="db-tag" data-testid="db-tag">
              {visibleText(tag)}
            </span>
          ))}
          {capabilities(db).map((item) => (
            <span key={item.label} className="db-capability" title={item.title} data-testid="db-capability">
              {item.label}
            </span>
          ))}
          {db.description && (
            <span className="db-description" title={db.description}>
              {visibleText(db.description)}
            </span>
          )}
        </span>
        {lastKey && (
          <Link
            className="last-key"
            to={`/db/${encodeURIComponent(db.id)}/keys`}
            title="Open the last key you inspected here"
          >
            <span className="muted">Last key</span>
            <KeyName name={lastKey} limit={160} />
          </Link>
        )}
        {db.status === "error" && db.statusMessage && (
          <span className="db-error">{visibleText(db.statusMessage)}</span>
        )}
        {stats.error && (
          <span className="db-error">
            Statistics unavailable: {visibleText(stats.error.message)}. Open the
            database to see more, or refresh.
          </span>
        )}
      </td>
      <td>
        <StatusCell db={db} />
      </td>
      <td className="mono">
        {db.server?.version ?? s?.version ?? missing}
        {db.server?.mode && db.server.mode !== "standalone" && (
          <small> {db.server.mode}</small>
        )}
      </td>
      <td
        className="num"
        data-testid="landing-keys"
        title={
          s?.dbKnown
            ? `Keys in logical database ${s.db}. ${s.serverKeys.toLocaleString()} on the server across ${Math.max(1, s.logicalDatabases)} logical ${s.logicalDatabases === 1 ? "database" : "databases"}.`
            : undefined
        }
      >
        {s ? s.keys.toLocaleString() : missing}
        {s && !s.dbKnown && s.logicalDatabases > 1 && (
          <small title={`Server total across ${s.logicalDatabases} logical databases`}> all dbs</small>
        )}
        {s && s.dbKnown && s.serverKeys !== s.keys && (
          <small title="Keys on the whole server, all logical databases"> / {s.serverKeys.toLocaleString()} server</small>
        )}
        {s && s.expires > 0 && (s.dbKnown || s.logicalDatabases <= 1) && (
          <small title="Keys with an expiry">
            {" "}
            {Math.round((s.expires / Math.max(1, s.keys)) * 100)}% ttl
          </small>
        )}
      </td>
      <td className="num">
        {s ? bytesLabel(s.memory) : missing}
        {s && s.maxmemory > 0 && (
          <small title="Share of maxmemory">
            {" "}
            {Math.round((s.memory / s.maxmemory) * 100)}%
          </small>
        )}
      </td>
      <td className="num">{s ? s.opsPerSec.toLocaleString() : missing}</td>
      <td className="num hide-narrow">
        {s ? (s.hitRate === null ? "—" : `${(s.hitRate * 100).toFixed(s.hitRate > 0.995 ? 0 : 1)}%`) : missing}
      </td>
      <td className="num hide-narrow">{s ? s.clients.toLocaleString() : missing}</td>
      <td className="num hide-narrow">{s ? uptimeLabel(s.uptimeSeconds) : missing}</td>
      <td>
        <span className="role-tag">{db.effectiveRole}</span>
      </td>
      <td className="num kbd-cell" aria-hidden="true">
        {index < 9 && <kbd>{index + 1}</kbd>}
      </td>
    </tr>
  );
}

const SORT_LABELS: Record<LandingSort, string> = {
  default: "last used first",
  name: "by name",
  keys: "by keys",
  memory: "by memory",
  ops: "by ops/s",
  clients: "by clients",
  hitRate: "by hit rate",
  uptime: "by uptime",
};
function sortLabel(sort: LandingSort, descending: boolean) {
  if (sort === "default") return SORT_LABELS.default;
  return `${SORT_LABELS[sort]}, ${sort === "name" ? (descending ? "Z–A" : "A–Z") : descending ? "largest first" : "smallest first"}`;
}

export function Landing({
  databases,
  lastDatabaseId,
  onRefresh,
}: {
  databases: DatabaseSummary[];
  lastDatabaseId: string;
  onRefresh: () => void;
}) {
  const navigate = useNavigate();
  const [filter, setFilter] = useState("");
  const table = useRef<HTMLTableElement>(null);
  const prefs = usePreferences();
  const sort = prefs.landingSort;
  const descending = prefs.landingDescending;
  // Only a metric sort needs every row's figures here; they come from the rows' shared cache entries.
  const allStats = useAllDatabaseStats(METRIC[sort] ? databases : []);
  const statsById = new Map(
    (METRIC[sort] ? databases : []).map((db, index) => [db.id, allStats[index]?.data]),
  );
  const statsKey = [...statsById.values()].map((s) => (s ? `${s.readAt}` : "-")).join(",");
  const ordered = useMemo(
    () => sortDatabases(databases, lastDatabaseId, sort, descending, statsById),
    // The figures enter through their read times, not the map identity.
    [databases, lastDatabaseId, sort, descending, statsKey],
  );
  const shown = ordered.filter((db) =>
    `${db.name} ${db.id} ${db.environment} ${db.description ?? ""} ${(db.tags ?? []).join(" ")}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );
  const connected = databases.filter((db) => db.status === "connected").length;
  useEffect(() => {
    table.current?.querySelector<HTMLAnchorElement>("a.db-link")?.focus();
  }, []);
  const links = () => [
    ...(table.current?.querySelectorAll<HTMLAnchorElement>("a.db-link") ?? []),
  ];
  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const all = links();
    const current = all.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        current < 0
          ? 0
          : Math.max(
              0,
              Math.min(
                all.length - 1,
                current + (event.key === "ArrowDown" ? 1 : -1),
              ),
            );
      all[next]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      all[event.key === "Home" ? 0 : all.length - 1]?.focus();
    }
  };
  // 1–9 open a database by position from anywhere on the landing, except while typing or in a dialog.
  const latest = useRef(shown);
  latest.current = shown;
  useEffect(() => {
    const onDigit = (event: globalThis.KeyboardEvent) => {
      if (
        !/^[1-9]$/.test(event.key) ||
        event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.defaultPrevented ||
        document.querySelector("dialog[open]") ||
        (event.target instanceof HTMLElement &&
          event.target.closest("input, textarea, select, [contenteditable='true']"))
      )
        return;
      const target = latest.current[Number(event.key) - 1];
      if (!target) return;
      event.preventDefault();
      navigate(`/db/${encodeURIComponent(target.id)}/overview`);
    };
    window.addEventListener("keydown", onDigit);
    return () => window.removeEventListener("keydown", onDigit);
  }, [navigate]);
  return (
    <div className="landing" data-testid="database-landing">
      <PageTitle
        title="Databases"
        description={`${databases.length} configured · ${connected} connected · ${sortLabel(sort, descending)}`}
        actions={
          <>
            <input
              type="search"
              className="landing-filter"
              aria-label="Filter databases"
              placeholder="Filter by name, id or environment"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh database status"
              title="Refresh database status"
              onClick={onRefresh}
            >
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          </>
        }
      />
      <div className="table-wrap landing-table">
        <table ref={table} onKeyDown={onKeyDown}>
          <caption className="sr-only">
            Configured databases. Use the arrow keys to move between rows and
            Enter to open one.
          </caption>
          <thead>
            <tr>
              <th>Environment</th>
              <SortHeader id="name" sort={sort} descending={descending}>Database</SortHeader>
              <th>Status</th>
              <th>Version</th>
              <SortHeader id="keys" className="num" sort={sort} descending={descending}>Keys</SortHeader>
              <SortHeader id="memory" className="num" sort={sort} descending={descending}>Memory</SortHeader>
              <SortHeader id="ops" className="num" sort={sort} descending={descending}>Ops/s</SortHeader>
              <SortHeader id="hitRate" className="num hide-narrow" sort={sort} descending={descending}>Hit rate</SortHeader>
              <SortHeader id="clients" className="num hide-narrow" sort={sort} descending={descending}>Clients</SortHeader>
              <SortHeader id="uptime" className="num hide-narrow" sort={sort} descending={descending}>Uptime</SortHeader>
              <th>Your role</th>
              <th className="num">
                <span className="sr-only">Shortcut</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((db, index) => (
              <DatabaseRow
                key={db.id}
                db={db}
                index={index}
                last={db.id === lastDatabaseId}
              />
            ))}
          </tbody>
        </table>
        {!shown.length && (
          <div className="empty compact">
            <strong>No database matches “{visibleText(filter)}”.</strong>
            <span>Clear the filter to see all {databases.length} databases.</span>
            <button onClick={() => setFilter("")}>Clear filter</button>
          </div>
        )}
      </div>
      <p className="landing-help">
        <kbd>↑</kbd> <kbd>↓</kbd> choose · <kbd>Enter</kbd> open ·{" "}
        <kbd>1</kbd>–<kbd>9</kbd> open by position. Column headings sort. Statistics come from{" "}
        <code>INFO</code> and refresh every 30 seconds; keys count the configured logical database (
        <code>db N</code>), the other figures are for the whole server.
      </p>
    </div>
  );
}
