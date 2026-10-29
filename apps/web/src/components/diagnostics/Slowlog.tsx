import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SlowlogConfigResponse, SlowlogResponse } from "@rconsole/shared";
import { canAdmin, useDatabase } from "../../lib/context.tsx";
import { dbPath, post, query, request } from "../../lib/api.ts";
import { visibleText } from "../../lib/format.ts";
import { ageLabel, formatDateTime, usePreferences } from "../../lib/preferences.ts";
import { useNow } from "../anatomy.tsx";
import { DataTable, ErrorState, Loading } from "../ui.tsx";
import { CommandLine, InlineAction, RefreshButton, ToolHead } from "./common.tsx";

export const SLOWLOG_COUNTS = [10, 25, 50, 100, 250, 500, 1000] as const;
export const SLOWLOG_REFRESH = [0, 5, 15, 30, 60] as const;
type Units = "ms" | "us";

/** A duration in microseconds, in the chosen unit. */
export function durationText(micros: number, units: Units) {
  return units === "us" ? `${micros.toLocaleString()} µs` : `${(micros / 1000).toFixed(2)} ms`;
}

/** What `slowlog-log-slower-than` means in words (negative disables the log, 0 records every command). */
export function thresholdText(micros: number) {
  if (micros < 0) return "Slow log off (slowlog-log-slower-than is negative)";
  if (micros === 0) return "Records every command (threshold 0)";
  return `Records commands slower than ${micros >= 1000 ? `${(micros / 1000).toLocaleString()} ms` : `${micros} µs`}`;
}

function ConfigLine({ config, count }: { config: SlowlogConfigResponse | undefined; count: number }) {
  if (!config) return <span className="muted">Reading the slow log settings…</span>;
  if (!config.available)
    return (
      <span className="muted" data-testid="slowlog-config-unavailable">
        Threshold and length not shown: {visibleText(config.reason)} Redis defaults are 10 ms and 128 entries, but
        this server may differ.
      </span>
    );
  return (
    <span data-testid="slowlog-config">
      <strong>{thresholdText(config.slowerThanMicros)}</strong>
      <code title="CONFIG GET slowlog-log-slower-than"> slowlog-log-slower-than {config.slowerThanMicros}</code>
      {" · "}
      keeps the latest <strong>{config.maxLen.toLocaleString()}</strong>
      <code title="CONFIG GET slowlog-max-len"> slowlog-max-len</code>
      {count > config.maxLen && (
        <span className="muted"> · asking for {count} cannot return more than {config.maxLen}</span>
      )}
    </span>
  );
}

export function Slowlog() {
  const db = useDatabase();
  const prefs = usePreferences();
  const now = useNow();
  const [error, setError] = useState<unknown>();
  const [count, setCount] = useState<number>(100);
  const [refresh, setRefresh] = useState<number>(prefs.toolRefreshSeconds);
  const [units, setUnits] = useState<Units>("ms");
  const data = useQuery({
    queryKey: ["slowlog", db.id, count],
    queryFn: ({ signal }) =>
      request<SlowlogResponse>(dbPath(db.id, "/slowlog") + query({ count }), {
        signal,
        background: refresh > 0,
      }),
    refetchInterval: refresh > 0 ? refresh * 1000 : false,
    placeholderData: (previous) => previous,
  });
  const config = useQuery({
    queryKey: ["slowlog-config", db.id],
    queryFn: ({ signal }) =>
      request<SlowlogConfigResponse>(dbPath(db.id, "/slowlog/config"), { signal, background: true }),
    staleTime: 60_000,
  });
  const entries = data.data?.entries ?? [];
  const slowest = entries.reduce((max, entry) => Math.max(max, entry.durationMicros), 0);
  return (
    <>
      <ToolHead
        title="Slow log"
        meta={
          data.data ? (
            <span data-testid="slowlog-meta">
              {entries.length} {entries.length === 1 ? "entry" : "entries"} shown of {data.data.len.toLocaleString()}{" "}
              recorded · newest first
              {entries.length ? ` · slowest ${durationText(slowest, units)}` : ""}
              {" · "}
              <span title={formatDateTime(data.dataUpdatedAt, prefs)} data-testid="slowlog-freshness">
                read {ageLabel(data.dataUpdatedAt, now)}
              </span>
            </span>
          ) : undefined
        }
      >
        <label className="inline-select">
          <span>Show</span>
          <select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            aria-label="Entries to read"
            data-testid="slowlog-count"
          >
            {SLOWLOG_COUNTS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-select">
          <span>Refresh</span>
          <select
            value={refresh}
            onChange={(e) => setRefresh(Number(e.target.value))}
            aria-label="Refresh interval"
            data-testid="slowlog-refresh"
          >
            {SLOWLOG_REFRESH.map((n) => (
              <option key={n} value={n}>
                {n ? `every ${n} s` : "manual"}
              </option>
            ))}
          </select>
        </label>
        <div className="segmented" role="group" aria-label="Duration units">
          <button type="button" aria-pressed={units === "ms"} onClick={() => setUnits("ms")}>
            ms
          </button>
          <button type="button" aria-pressed={units === "us"} onClick={() => setUnits("us")}>
            µs
          </button>
        </div>
        <RefreshButton
          busy={data.isFetching}
          onClick={() => {
            void data.refetch();
            void config.refetch();
          }}
        />
        {canAdmin(db) && (
          <InlineAction
            label="Reset slow log"
            danger
            testId="slowlog-reset"
            onError={setError}
            onRun={async () => {
              await post(
                dbPath(db.id, "/slowlog/reset"),
                {},
                "Recorded slow commands will be removed.",
              );
              await data.refetch();
            }}
          />
        )}
      </ToolHead>
      <div className="pane-body">
        <p className="slowlog-config">
          <ConfigLine config={config.data} count={count} />
        </p>
        <ErrorState error={error} />
        <ErrorState error={config.error} />
        <ErrorState
          error={data.error}
          onRetry={() => {
            void data.refetch();
          }}
        />
        {data.isPending ? (
          <Loading label="Reading the slow log…" />
        ) : (
          <DataTable
            className="dense slowlog-table"
            columns={[
              <span className="num">ID</span>,
              "Time",
              <span className="num">Duration</span>,
              "Command",
              "Client",
            ]}
            rows={entries.map((entry) => [
              <span className="num tabular">{entry.id}</span>,
              <span className="tabular nowrap" title={new Date(entry.timestamp * 1000).toISOString()}>
                {formatDateTime(entry.timestamp * 1000, prefs)}
              </span>,
              <span className={`num tabular nowrap ${entry.durationMicros >= 100_000 ? "slow" : ""}`}>
                {durationText(entry.durationMicros, units)}
              </span>,
              <CommandLine argv={entry.argv} />,
              <span className="client-cell">
                <code>{visibleText(entry.client ?? "—")}</code>
                {entry.clientName && <small>{visibleText(entry.clientName)}</small>}
              </span>,
            ])}
            empty={
              <>
                <strong>No slow commands recorded.</strong>
                <span>
                  {config.data?.available
                    ? `${thresholdText(config.data.slowerThanMicros)}. Run the workload again, then refresh.`
                    : "Redis records commands slower than slowlog-log-slower-than. Run the workload again, then refresh."}
                </span>
              </>
            }
          />
        )}
      </div>
    </>
  );
}
