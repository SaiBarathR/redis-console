import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { DatabaseOverview, MetricsSample } from "@rconsole/shared";
import { useDatabase } from "../lib/context.tsx";
import { dbPath, request } from "../lib/api.ts";
import { useSSE } from "../lib/sse.ts";
import { publishLiveSample } from "../lib/dbstats.ts";
import { bytesLabel, ttlLabel, uptimeLabel, visibleText } from "../lib/format.ts";
import {
  DataTable,
  ErrorState,
  Loading,
  PageTitle,
  Readout,
} from "../components/ui.tsx";
import { Chart } from "../components/Chart.tsx";
import { serverLabel, serverProduct } from "../lib/engine.ts";

function splitBytes(bytes: number) {
  const [value, unit] = bytesLabel(bytes).split(" ");
  return { value: value ?? "—", unit: unit ?? "" };
}

function percent(value: number) {
  return `${(value * 100).toFixed(value >= 0.995 || value === 0 ? 0 : 1)}%`;
}

export function Dashboard() {
  const db = useDatabase();
  const overview = useQuery({
    queryKey: ["overview", db.id],
    queryFn: ({ signal }) =>
      request<DatabaseOverview>(dbPath(db.id, "/overview"), { signal, background: true }),
    refetchInterval: 15000,
  });
  const metrics = useSSE<MetricsSample>(dbPath(db.id, "/metrics/stream"));
  const [infoFilter, setInfoFilter] = useState("");
  const data = overview.data;
  const events = metrics.events;
  const live = events.at(-1);
  // The status bar shows these samples while this stream runs (F5). The first sample has no CPU delta yet.
  const shared = events.length >= 2 && metrics.status === "live" ? live : undefined;
  useEffect(() => {
    publishLiveSample(db.id, shared);
  }, [db.id, shared]);
  useEffect(() => () => publishLiveSample(db.id, undefined), [db.id]);
  const series = (pick: (sample: MetricsSample) => number) =>
    events.map((sample) => pick(sample));
  const infoRows = useMemo(() => {
    if (!data) return [];
    const needle = infoFilter.trim().toLowerCase();
    return Object.entries(data.info).flatMap(([section, fields]) =>
      Object.entries(fields)
        .filter(
          ([key, value]) =>
            !needle ||
            key.toLowerCase().includes(needle) ||
            section.toLowerCase().includes(needle) ||
            value.toLowerCase().includes(needle),
        )
        .map(([key, value]) => [section, key, value] as const),
    );
  }, [data, infoFilter]);
  const status =
    metrics.status === "live"
      ? { tone: "ok", label: "Live, every 2 s" }
      : metrics.status === "error"
        ? { tone: "error", label: "Live samples unavailable" }
        : metrics.status === "connecting"
          ? { tone: "wait", label: "Connecting to live samples" }
          : { tone: "wait", label: "Live samples paused" };
  return (
    <>
      <PageTitle
        title="Overview"
        description={data ? `INFO read at ${new Date(overview.dataUpdatedAt).toLocaleTimeString()}, refreshed every 15 s` : undefined}
        actions={
          <>
            <span className={`live-status ${status.tone}`} role="status">
              <span className="connection-dot" aria-hidden="true" />
              {status.label}
            </span>
            <button
              type="button"
              onClick={() => {
                void overview.refetch();
                if (metrics.status !== "live") metrics.reconnect();
              }}
            >
              <RefreshCw
                size={13}
                className={overview.isFetching ? "spin" : undefined}
                aria-hidden="true"
              />
              Refresh
            </button>
          </>
        }
      />
      <ErrorState
        error={overview.error}
        onRetry={() => {
          void overview.refetch();
        }}
      />
      {metrics.status === "error" && metrics.message && (
        <ErrorState
          error={`Live samples stopped: ${metrics.message}`}
          onRetry={metrics.reconnect}
          retryLabel="Reconnect"
        />
      )}
      {overview.isPending ? (
        <Loading label="Reading INFO from the server…" />
      ) : (
        data && (
          <OverviewBody
            data={data}
            live={live}
            series={series}
            events={events}
            infoRows={infoRows}
            infoFilter={infoFilter}
            setInfoFilter={setInfoFilter}
          />
        )
      )}
    </>
  );
}

function OverviewBody({
  data,
  live,
  series,
  events,
  infoRows,
  infoFilter,
  setInfoFilter,
}: {
  data: DatabaseOverview;
  live: MetricsSample | undefined;
  series: (pick: (sample: MetricsSample) => number) => number[];
  events: MetricsSample[];
  infoRows: (readonly [string, string, string])[];
  infoFilter: string;
  setInfoFilter: (value: string) => void;
}) {
  const db = useDatabase();
  const keys = data.keyspace.reduce((sum, space) => sum + space.keys, 0);
  const expiring = data.keyspace.reduce((sum, space) => sum + space.expires, 0);
  const used = live?.usedMemory ?? data.memory.used;
  const memory = splitBytes(used);
  const share = data.memory.maxmemory ? used / data.memory.maxmemory : undefined;
  const hitRate = live?.hitRate ?? data.stats.hitRate;
  const info = data.info;
  const role = info.replication?.role;
  const replicas = info.replication?.connected_slaves;
  const persistence = info.persistence;
  return (
    <div className="overview">
      <div className="readouts" aria-label="Server readouts">
        <Readout
          label={data.keyspace.length > 1 ? "Keys on this server" : "Keys"}
          value={keys.toLocaleString()}
          sub={
            data.keyspace.length > 1
              ? `In ${data.keyspace.length} logical databases · ${expiring.toLocaleString()} with a TTL`
              : keys
                ? `${expiring.toLocaleString()} with a TTL (${percent(expiring / keys)})`
                : "No keys yet"
          }
        />
        <Readout
          label="Memory used"
          value={memory.value}
          unit={memory.unit}
          meter={share}
          tone={share === undefined ? undefined : share > 0.95 ? "danger" : share > 0.8 ? "warn" : undefined}
          trend={share === undefined ? series((s) => s.usedMemory) : undefined}
          sub={
            data.memory.maxmemory
              ? `${percent(share ?? 0)} of ${bytesLabel(data.memory.maxmemory)} · ${data.memory.policy}`
              : `Peak ${bytesLabel(data.memory.peak)} · no limit`
          }
        />
        <Readout
          label="Commands / s"
          value={(live?.opsPerSec ?? data.stats.opsPerSec).toLocaleString()}
          trend={series((s) => s.opsPerSec)}
          sub={`${data.stats.totalCommands.toLocaleString()} since start`}
        />
        <Readout
          label="Clients"
          value={(live?.connectedClients ?? data.clients.connected).toLocaleString()}
          trend={series((s) => s.connectedClients)}
          sub={`${data.clients.blocked.toLocaleString()} blocked`}
        />
        <Readout
          label="Hit rate"
          value={hitRate === null ? "—" : percent(hitRate)}
          trend={series((s) => s.hitRate ?? 0)}
          trendMax={1}
          sub={
            hitRate === null
              ? "No key reads yet"
              : `${data.stats.evictedKeys.toLocaleString()} evicted · ${data.stats.expiredKeys.toLocaleString()} expired`
          }
        />
        <Readout
          label="CPU"
          value={live ? (live.cpuSys + live.cpuUser).toFixed(1) : "—"}
          unit={live ? "%" : undefined}
          trend={series((s) => s.cpuSys + s.cpuUser)}
          trendMax={5}
          sub={
            live
              ? `Net ${live.netInputKbps.toFixed(1)} in · ${live.netOutputKbps.toFixed(1)} out kB/s`
              : "Waiting for live samples"
          }
        />
        <Readout
          label="Uptime"
          value={uptimeLabel(data.uptimeSeconds)}
          sub={`Since ${new Date(Date.now() - data.uptimeSeconds * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`}
        />
      </div>

      <div className="grid-2">
        <section className="section">
          <header>
            <h2>Commands per second</h2>
            <span className="meta">instantaneous_ops_per_sec</span>
          </header>
          <Chart
            label="Commands per second"
            samples={events.map((sample) => [sample.t, sample.opsPerSec])}
            waiting="Collecting live samples. The line starts with the second sample, 2 seconds after the first."
          />
        </section>
        <section className="section">
          <header>
            <h2>Memory used</h2>
            <span className="meta">MiB · used_memory</span>
          </header>
          <Chart
            label="Memory used"
            unit=" MiB"
            samples={events.map((sample) => [
              sample.t,
              Math.round((sample.usedMemory / 1024 ** 2) * 100) / 100,
            ])}
            waiting="Collecting live samples. The line starts with the second sample, 2 seconds after the first."
          />
        </section>
      </div>

      <div className="grid-2">
        <section className="section">
          <header>
            <h2>Keyspace</h2>
            <span className="meta">
              {data.keyspace.length === 1
                ? "1 logical database"
                : `${data.keyspace.length} logical databases`}
            </span>
            <span className="actions">
              <Link className="button ghost" to="../keys">
                Browse keys
              </Link>
              <Link className="button ghost" to="../diagnostics/analysis">
                Analyze memory
              </Link>
            </span>
          </header>
          <DataTable
            columns={[
              "Database",
              <span className="num-head">Keys</span>,
              <span className="num-head">With TTL</span>,
              <span className="num-head">Average TTL</span>,
            ]}
            empty="The keyspace is empty: no logical database holds keys yet."
            className="numeric-table"
            rows={data.keyspace.map((space) => [
              <code>db{space.db}</code>,
              space.keys.toLocaleString(),
              space.expires.toLocaleString(),
              space.expires && space.avgTtl > 0
                ? ttlLabel(Math.round(space.avgTtl / 1000))
                : "—",
            ])}
          />
        </section>
        <section className="section">
          <header>
            <h2>Server</h2>
            <span className="meta">from INFO</span>
          </header>
          <dl className="facts server-facts">
            <dt>Version</dt>
            <dd title={serverProduct(db.server).title}>
              {serverLabel(db.server, info.server?.redis_version) ?? "—"}{" "}
              <span className="muted">{db.server?.mode ?? "standalone"}</span>
            </dd>
            {role && (
              <>
                <dt>Replication</dt>
                <dd>
                  {role}
                  {replicas && replicas !== "0" ? ` · ${replicas} replicas` : ""}
                </dd>
              </>
            )}
            <dt>Memory limit</dt>
            <dd>
              {data.memory.maxmemory
                ? bytesLabel(data.memory.maxmemory)
                : "None (maxmemory 0)"}{" "}
              <span className="muted">policy {data.memory.policy}</span>
            </dd>
            <dt>Fragmentation</dt>
            <dd>{data.memory.fragmentationRatio.toFixed(2)}×</dd>
            {persistence && (
              <>
                <dt>Persistence</dt>
                <dd>
                  {persistence.aof_enabled === "1" ? "AOF on" : "AOF off"}
                  {persistence.rdb_last_save_time &&
                    ` · last RDB save ${new Date(Number(persistence.rdb_last_save_time) * 1000).toLocaleString()}`}
                </dd>
              </>
            )}
            <dt>Modules</dt>
            <dd className="chips">
              {db.server?.modules.length
                ? db.server.modules.map((module) => (
                    <span key={module.name} className="chip">
                      {module.name} <span className="muted">{module.version}</span>
                    </span>
                  ))
                : "None (core Redis)"}
            </dd>
          </dl>
        </section>
      </div>

      <details className="section info-all">
        <summary>
          <h2>All INFO fields</h2>
          <span className="meta">
            {Object.values(info).reduce((sum, fields) => sum + Object.keys(fields).length, 0)} fields in {Object.keys(info).length} sections
          </span>
        </summary>
        <input
          type="search"
          className="info-filter"
          aria-label="Filter INFO fields"
          placeholder="Filter by field, section or value"
          value={infoFilter}
          onChange={(event) => setInfoFilter(event.target.value)}
        />
        <DataTable
          columns={["Section", "Field", "Value"]}
          empty={`No INFO field matches “${visibleText(infoFilter)}”.`}
          rows={infoRows.map(([section, key, value]) => [
            <span className="muted">{section}</span>,
            <code>{key}</code>,
            <code>{visibleText(value)}</code>,
          ])}
        />
      </details>
    </div>
  );
}
