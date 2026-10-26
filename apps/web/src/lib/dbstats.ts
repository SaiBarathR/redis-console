import { useSyncExternalStore } from "react";
import { useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { DatabaseOverview, DatabaseSummary, MetricsSample } from "@rconsole/shared";
import { dbPath, request } from "./api.ts";

/** Compact per-database figures for the landing table and the status bar. */
export interface DatabaseStats {
  /**
   * Keys in the configured logical database (F13). When the server did not say which logical database the
   * configuration uses (`dbKnown` false, servers before v0.2.1), the server total, as before.
   */
  keys: number;
  expires: number;
  /** The configured logical database index, when the server reports it. */
  db?: number;
  dbKnown: boolean;
  /** Keys across every logical database on the server (INFO keyspace). */
  serverKeys: number;
  logicalDatabases: number;
  memory: number;
  maxmemory: number;
  opsPerSec: number;
  clients: number;
  hitRate: number | null;
  uptimeSeconds: number;
  version?: string;
  /** Total CPU seconds (used_cpu_sys + used_cpu_user) Redis reported, for the next reading's delta. */
  cpuSeconds: number | null;
  /** Server CPU use between this reading and the previous one, in percent of one core; null on the first reading. */
  cpuPercent: number | null;
  /** Browser → server → Redis round trip of this read, in milliseconds. */
  rttMs: number;
  readAt: number;
}

const finite = (value: string | undefined) => {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : null;
};

/** CPU share between two cumulative readings, or null when it cannot be known (first read, restart, clock). */
export function cpuBetween(
  previous: Pick<DatabaseStats, "cpuSeconds" | "readAt" | "uptimeSeconds"> | undefined,
  current: Pick<DatabaseStats, "cpuSeconds" | "readAt" | "uptimeSeconds">,
) {
  if (!previous || previous.cpuSeconds === null || current.cpuSeconds === null) return null;
  const seconds = (current.readAt - previous.readAt) / 1000;
  const used = current.cpuSeconds - previous.cpuSeconds;
  // A restart resets the counters (uptime went down): no honest figure for this interval.
  if (seconds < 1 || used < 0 || current.uptimeSeconds < previous.uptimeSeconds) return null;
  return Math.round((used / seconds) * 1000) / 10;
}

export function summarizeOverview(
  overview: DatabaseOverview,
  rttMs: number,
  readAt = Date.now(),
  db?: number,
  previous?: DatabaseStats,
): DatabaseStats {
  const serverKeys = overview.keyspace.reduce((sum, space) => sum + space.keys, 0);
  const selected = db === undefined ? undefined : overview.keyspace.find((space) => space.db === db);
  const cpu = overview.info.cpu;
  const sys = finite(cpu?.used_cpu_sys);
  const user = finite(cpu?.used_cpu_user);
  const stats: DatabaseStats = {
    // A logical database without keys does not appear in INFO keyspace at all.
    keys: db === undefined ? serverKeys : (selected?.keys ?? 0),
    expires:
      db === undefined
        ? overview.keyspace.reduce((sum, space) => sum + space.expires, 0)
        : (selected?.expires ?? 0),
    dbKnown: db !== undefined,
    serverKeys,
    logicalDatabases: overview.keyspace.length,
    memory: overview.memory.used,
    maxmemory: overview.memory.maxmemory,
    opsPerSec: overview.stats.opsPerSec,
    clients: overview.clients.connected,
    hitRate: overview.stats.hitRate,
    uptimeSeconds: overview.uptimeSeconds,
    version: overview.info.server?.redis_version,
    cpuSeconds: sys === null || user === null ? null : sys + user,
    cpuPercent: null,
    rttMs,
    readAt,
  };
  if (db !== undefined) stats.db = db;
  stats.cpuPercent = cpuBetween(previous, stats);
  return stats;
}

/** The status query for one database: the landing and the status bar share this cache entry. */
export function statsQueryKey(id: string | undefined) {
  return ["status", id] as const;
}

async function readStats(db: DatabaseSummary, client: QueryClient, signal: AbortSignal) {
  const started = performance.now();
  const overview = await request<DatabaseOverview>(dbPath(db.id, "/overview"), { signal, background: true });
  return summarizeOverview(
    overview,
    Math.round(performance.now() - started),
    Date.now(),
    db.db,
    client.getQueryData<DatabaseStats>(statsQueryKey(db.id)),
  );
}

/**
 * Reads the existing overview endpoint (INFO, read-only) and keeps only the figures the shell needs.
 * Shared by the landing table and the status bar through the ["status", id] cache entry, so a
 * database-updated event refreshes both. `warmup`: read once more after 5 s when there is no CPU figure yet
 * (CPU is a difference of two readings); afterwards the normal interval.
 */
export function useDatabaseStats(
  db: DatabaseSummary | undefined,
  refetchInterval: number | false = 30000,
  { warmup = false }: { warmup?: boolean } = {},
) {
  const client = useQueryClient();
  return useQuery<DatabaseStats, Error, DatabaseStats, ReturnType<typeof statsQueryKey>>({
    queryKey: statsQueryKey(db?.id),
    enabled: !!db && db.status !== "error",
    refetchInterval: (query) =>
      warmup && refetchInterval && query.state.data && query.state.data.cpuPercent === null && query.state.data.cpuSeconds !== null && Date.now() - query.state.data.readAt < 60_000
        ? 5000
        : refetchInterval,
    staleTime: 10000,
    queryFn: ({ signal }) => readStats(db!, client, signal),
  });
}

// ---------------------------------------------------------------------------
// Live samples from the Overview page's metrics stream (every 2 s). The status bar shows them while that stream
// runs, so the Overview page needs no second source and the status bar adds no stream of its own.

const live = new Map<string, MetricsSample>();
const liveListeners = new Set<() => void>();

export function publishLiveSample(id: string, sample: MetricsSample | undefined) {
  if (sample) live.set(id, sample);
  else live.delete(id);
  liveListeners.forEach((listener) => listener());
}

export function useLiveSample(id: string | undefined) {
  return useSyncExternalStore(
    (listener) => {
      liveListeners.add(listener);
      return () => {
        liveListeners.delete(listener);
      };
    },
    () => (id ? live.get(id) : undefined),
    () => undefined,
  );
}

/** The figures the status bar shows: the newest of the INFO reading and a live sample. */
export interface ShellMetrics {
  cpuPercent: number | null;
  opsPerSec: number;
  memory: number;
  maxmemory: number;
  clients: number;
  readAt: number;
  source: "live" | "poll";
}

export function shellMetrics(stats: DatabaseStats | undefined, sample: MetricsSample | undefined): ShellMetrics | undefined {
  if (sample && (!stats || sample.t >= stats.readAt))
    return {
      cpuPercent: Math.round((sample.cpuSys + sample.cpuUser) * 10) / 10,
      opsPerSec: sample.opsPerSec,
      memory: sample.usedMemory,
      maxmemory: stats?.maxmemory ?? 0,
      clients: sample.connectedClients,
      readAt: sample.t,
      source: "live",
    };
  if (!stats) return undefined;
  return {
    cpuPercent: stats.cpuPercent,
    opsPerSec: stats.opsPerSec,
    memory: stats.memory,
    maxmemory: stats.maxmemory,
    clients: stats.clients,
    readAt: stats.readAt,
    source: "poll",
  };
}

/** Stats for several databases at once (landing sort): the same cache entries the rows read, so no extra requests. */
export function useAllDatabaseStats(databases: DatabaseSummary[], refetchInterval: number | false = 30000) {
  const client = useQueryClient();
  return useQueries({
    queries: databases.map((db) => ({
      queryKey: statsQueryKey(db.id),
      enabled: db.status !== "error",
      refetchInterval,
      staleTime: 10000,
      queryFn: ({ signal }: { signal: AbortSignal }) => readStats(db, client, signal),
    })),
  });
}
