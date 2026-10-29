import { LockKeyhole } from "lucide-react";
import type { DatabaseSummary, Me } from "@rconsole/shared";
import { shellMetrics, useDatabaseStats, useLiveSample } from "../lib/dbstats.ts";
import { bytesLabel } from "../lib/format.ts";
import { ageLabel, formatDateTime } from "../lib/preferences.ts";
import { countdown, useNow } from "./anatomy.tsx";
import { serverProduct } from "../lib/engine.ts";

const POLL_MS = 30000;

/** One server-wide figure; "—" with the reason in the tooltip when it is not known yet or not available. */
function Metric({
  label,
  value,
  title,
  testId,
  className,
}: {
  label: string;
  value: string | undefined;
  title: string;
  testId: string;
  className?: string;
}) {
  return (
    <span className={`metric ${className ?? ""}`.trim()} title={title} data-testid={testId}>
      {label} <strong>{value ?? "—"}</strong>
    </span>
  );
}

/**
 * Persistent status bar: connection, server, environment, role, the configured logical database and its keys, then
 * server-wide CPU, ops/s, memory and clients with their freshness (F5, F13), round trip and session.
 * The figures come from the INFO reading the landing already uses (every 30 s, shared cache) or, while the Overview
 * page streams, from that stream: the status bar adds no polling loop of its own.
 */
export function StatusBar({
  db,
  me,
}: {
  db: DatabaseSummary | undefined;
  me: Me;
}) {
  const stats = useDatabaseStats(db, POLL_MS, { warmup: true });
  const sample = useLiveSample(db?.id);
  const now = useNow();
  const session = Math.max(
    0,
    Math.floor((Date.parse(me.sessionExpiresAt) - now) / 1000),
  );
  const s = stats.data;
  const m = shellMetrics(s, sample);
  const age = m ? now - m.readAt : 0;
  // Two missed polls (or a stalled stream) make the figures stale; say so instead of showing them as current.
  const stale = !!m && age > (m.source === "live" ? 10_000 : POLL_MS * 2 + 5000);
  const unavailable = db?.status === "error" || (!!stats.error && !m);
  const scope = "Server-wide (INFO): every logical database and client on this Redis server";
  const freshness = m
    ? `${m.source === "live" ? "Live sample from the Overview stream" : "INFO read"} at ${formatDateTime(m.readAt)}`
    : "";
  return (
    <footer className="statusbar" aria-label="Status" tabIndex={0}>
      {db ? (
        <>
          <span className="connection" title={db.statusMessage ?? db.status}>
            <span className={`connection-dot ${db.status}`} />
            {db.status === "connected"
              ? "Connected"
              : db.status === "connecting"
                ? "Connecting"
                : "Unreachable"}
          </span>
          <span className="wide-xl" title={serverProduct(db.server).title}>
            {serverProduct(db.server).name}{" "}
            <strong>{serverProduct(db.server, s?.version).version ?? "—"}</strong>
            <span className="wide">{db.server?.mode ?? ""}</span>
          </span>
          <span>
            <strong>
              {db.environment === "prod" ? "Production" : db.environment}
            </strong>
          </span>
          <span title="Your effective role on this database">
            Role <strong>{db.effectiveRole}</strong>
          </span>
          {db.readOnly && (
            <span>
              <LockKeyhole size={11} aria-hidden="true" />
              <strong>Read-only</strong>
            </span>
          )}
          <span
            className="db-scope"
            data-testid="status-keys"
            title={
              s
                ? s.dbKnown
                  ? `Keys in logical database ${s.db} (configured by the server; it cannot be changed here). ${s.serverKeys.toLocaleString()} keys on the whole server across ${s.logicalDatabases || 1} logical ${s.logicalDatabases === 1 ? "database" : "databases"}.`
                  : `Across ${s.logicalDatabases} logical databases (this server does not report which one is configured)`
                : unavailable
                  ? "Key count unavailable: the database cannot be read right now."
                  : "Reading INFO keyspace…"
            }
          >
            {db.db !== undefined && <span className="db-index">db {db.db}</span>}
            <strong>{s ? s.keys.toLocaleString() : "—"}</strong>{" "}
            {s && !s.dbKnown && s.logicalDatabases > 1 ? "keys on server" : "keys"}
          </span>
          <span
            className={`server-metrics ${stale ? "stale" : ""} ${unavailable ? "unavailable" : ""}`.trim()}
            data-testid="status-metrics"
            aria-label="Server-wide metrics"
          >
            <span className="scope-label" title={scope}>
              server
            </span>
            <Metric
              label="CPU"
              testId="status-cpu"
              value={m && m.cpuPercent !== null ? `${m.cpuPercent.toFixed(m.cpuPercent >= 10 ? 0 : 1)}%` : undefined}
              title={
                m && m.cpuPercent !== null
                  ? `Redis CPU (system + user) as a share of one core, ${m.source === "live" ? "over the last 2 s" : "since the previous INFO reading"}. ${scope}.`
                  : unavailable
                    ? "CPU unavailable: the database cannot be read right now."
                    : "CPU needs two INFO readings a few seconds apart; the second follows shortly."
              }
            />
            <Metric
              label="ops/s"
              testId="status-ops"
              value={m ? m.opsPerSec.toLocaleString() : undefined}
              title={`instantaneous_ops_per_sec. ${scope}.`}
            />
            <Metric
              label="mem"
              testId="status-memory"
              value={m ? bytesLabel(m.memory) : undefined}
              title={`used_memory${m && m.maxmemory ? ` of ${bytesLabel(m.maxmemory)} maxmemory` : " (no maxmemory limit)"}. ${scope}.`}
            />
            <Metric
              label="clients"
              testId="status-clients"
              value={m ? m.clients.toLocaleString() : undefined}
              title={`connected_clients, including this console's own connections. ${scope}.`}
            />
            <span
              className="freshness"
              data-testid="status-freshness"
              title={unavailable ? "The figures cannot be read right now." : freshness}
            >
              {unavailable
                ? "unavailable"
                : !m
                  ? "reading…"
                  : m.source === "live"
                    ? stale
                      ? `stale · ${ageLabel(m.readAt, now)}`
                      : "live"
                    : stale
                      ? `stale · ${ageLabel(m.readAt, now)}`
                      : ageLabel(m.readAt, now)}
            </span>
          </span>
          <span
            className="wide"
            title="Round trip of the last status read (browser → server → Redis)"
          >
            <strong>{s ? `${s.rttMs} ms` : "—"}</strong> round trip
          </span>
        </>
      ) : (
        <span>No database open</span>
      )}
      <span className="spacer" />
      <span className="wide">
        {me.displayName}
        <span className="muted-inherit">
          {me.source === "oidc" ? " · SSO" : " · local"}
        </span>
      </span>
      <span title={new Date(me.sessionExpiresAt).toLocaleString()}>
        Session {countdown(session)}
      </span>
    </footer>
  );
}
