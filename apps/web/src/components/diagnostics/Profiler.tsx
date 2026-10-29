import { useState } from "react";
import { Ident } from "../Ident.tsx";
import { useQuery } from "@tanstack/react-query";
import { Download, Pause, Play, Trash2 } from "lucide-react";
import type { ClientInfo, ProfilerEvent } from "@rconsole/shared";
import { canAdmin, useDatabase } from "../../lib/context.tsx";
import { collection, dbPath, query, request } from "../../lib/api.ts";
import { cliArg, visibleText } from "../../lib/format.ts";
import { useLive, useLiveSessions } from "../../lib/live.tsx";
import { formatDateTime, formatTime, usePreferences } from "../../lib/preferences.ts";
import { useNow } from "../anatomy.tsx";
import { CopyButton, DataTable, Empty, Field } from "../ui.tsx";
import { CommandLine, ToolHead } from "./common.tsx";

/** One line per command, oldest first, as redis-cli MONITOR would print it (copied only on request). */
export function profilerText(events: ProfilerEvent[]) {
  return events
    .map((event) => `${formatDateTime(event.t)} [${event.db} ${event.client}] ${event.argv.map(cliArg).join(" ")}`)
    .join("\n");
}

/** Static name of the profiler log download: nothing from Redis (key, client, database) goes into it. */
export const PROFILER_LOG_FILENAME = "redis-profiler.log";

/**
 * Saves the shown commands (the same text as Copy, from the already bounded buffer) as a local file
 * (review v0.2.1 web L4): an opaque Blob URL, revoked right after, and a static filename. Nothing is captured
 * beyond what the session already kept, and nothing leaves the browser.
 */
export function downloadProfilerLog(events: ProfilerEvent[]) {
  const blob = new Blob([`${profilerText(events)}\n`], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = PROFILER_LOG_FILENAME;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Events to show: optionally without this console's own connections, and matching a command-name filter. */
export function profilerShown(events: ProfilerEvent[], own: Set<string>, hideOwn: boolean, filter: string) {
  const needle = filter.trim().toLowerCase();
  return events.filter(
    (event) =>
      (!hideOwn || !own.has(event.client)) &&
      (!needle || (event.argv[0] ?? "").toLowerCase().startsWith(needle)),
  );
}

/**
 * MONITOR, time-boxed (1–60 s, server enforced) and admin-only on non-production databases (server enforced; the
 * tool is not offered otherwise). The session belongs to the database layout, so it keeps recording while the user
 * moves between pages, and the Diagnostics page and the tools drawer show the same session.
 */
export function Profiler({ compact = false }: { compact?: boolean }) {
  const db = useDatabase();
  const prefs = usePreferences();
  const { profiler } = useLiveSessions();
  const state = useLive(profiler);
  const now = useNow();
  const [seconds, setSeconds] = useState("15");
  const [hideConsole, setHideConsole] = useState(true);
  const [filter, setFilter] = useState("");
  const clients = useQuery({
    queryKey: ["clients", db.id],
    queryFn: async () =>
      collection<ClientInfo>(await request(dbPath(db.id, "/clients")), "clients"),
    enabled: canAdmin(db) && db.features.profiler,
  });
  if (!db.features.profiler)
    return (
      <Empty title="The profiler is off for this database.">
        It needs the admin role, and server policy turns it off for{" "}
        {db.environment} databases.
      </Empty>
    );
  const ownAddresses = new Set(
    (clients.data ?? [])
      .filter((client) => client.name.startsWith("rconsole-") && client.addr !== "<hidden>")
      .map((client) => client.addr),
  );
  const active = profiler.active;
  const source = state.frozen ? state.frozen.events : state.events;
  const events = profilerShown(source, ownAddresses, hideConsole, filter);
  const arrived = state.frozen ? state.received - state.frozen.received : 0;
  const remaining = active && state.endsAt ? Math.max(0, Math.ceil((state.endsAt - now) / 1000)) : 0;
  return (
    <>
      {!compact && (
        <ToolHead
          title="Profiler"
          meta={
            active ? (
              <span className={`live-status ${state.status}`}>
                <span className="dot" aria-hidden="true" />
                {state.status === "live" ? `Recording · ${remaining} s left` : "Connecting"}
              </span>
            ) : (
              "Stopped"
            )
          }
        />
      )}
      <div className={compact ? "profiler-compact" : "pane-body"} data-testid={compact ? "drawer-profiler" : undefined}>
        {!compact && (
          <div className="notice warning">
            <span>
              The profiler shows every command's arguments and adds load to the
              server. Keep sessions short.
            </span>
          </div>
        )}
        <form
          className="inline-form profiler-controls"
          onSubmit={(event) => {
            event.preventDefault();
            const n = Number(seconds);
            if (!Number.isInteger(n) || n < 1 || n > 60) return;
            profiler.start(dbPath(db.id, "/profiler/stream") + query({ seconds: n }), n * 1000);
          }}
        >
          <Field label={compact ? "Seconds (max 60)" : "Session length (seconds, max 60)"}>
            <input
              type="number"
              min={1}
              max={60}
              required
              value={seconds}
              disabled={active}
              onChange={(e) => setSeconds(e.target.value)}
              data-testid={compact ? "drawer-profiler-seconds" : "profiler-seconds"}
            />
          </Field>
          {/* Distinct keys: reusing one element would turn the Stop click into a submit of the Start button. */}
          {active ? (
            <button
              key="stop"
              type="button"
              className="stop-button"
              onClick={() => profiler.stop()}
              data-testid={compact ? "drawer-profiler-stop" : "profiler-stop"}
            >
              Stop profiler{compact && state.status === "live" ? ` · ${remaining} s` : ""}
            </button>
          ) : (
            <button
              key="start"
              type="submit"
              className="primary"
              data-testid={compact ? "drawer-profiler-start" : "profiler-start"}
            >
              Start profiler
            </button>
          )}
          <button
            type="button"
            className="ghost"
            aria-pressed={!!state.frozen}
            disabled={!active && !state.frozen}
            onClick={() => profiler.freeze(!state.frozen)}
            data-testid={compact ? "drawer-profiler-pause" : "profiler-pause"}
            title="Pause the view; recording continues until the session ends"
          >
            {state.frozen ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
            {state.frozen ? `Resume view${arrived ? ` (${arrived} new)` : ""}` : "Pause view"}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!source.length && !state.events.length}
            onClick={() => profiler.clear()}
            data-testid={compact ? "drawer-profiler-clear" : "profiler-clear"}
          >
            <Trash2 size={13} aria-hidden="true" />
            Clear
          </button>
          <CopyButton label="Copy shown commands" text={() => profilerText(events)} />
          <button
            type="button"
            className="ghost"
            disabled={!events.length}
            onClick={() => downloadProfilerLog(events)}
            title={`Save the ${events.length} shown commands as ${PROFILER_LOG_FILENAME} (a local file; nothing more is recorded)`}
            data-testid={compact ? "drawer-profiler-download" : "profiler-download"}
          >
            <Download size={13} aria-hidden="true" />
            Download shown commands
          </button>
        </form>
        <section className={compact ? undefined : "section"}>
          <header className={compact ? "drawer-subhead" : undefined}>
            {!compact && <h2>Commands</h2>}
            <span className="meta" data-testid={compact ? "drawer-profiler-count" : "profiler-count"}>
              {events.length} shown of {source.length} kept (max {profiler.limit}) · newest first
              {state.frozen ? " · view paused" : ""}
            </span>
            <label className="inline-select">
              <span>Command</span>
              <input
                className="data"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="e.g. HGET"
                maxLength={64}
                aria-label="Show only commands starting with"
              />
            </label>
            <label className="checkbox header-check">
              <input
                type="checkbox"
                checked={hideConsole}
                onChange={(e) => setHideConsole(e.target.checked)}
              />
              Hide this console's own connections
            </label>
          </header>
          {state.dropped > 0 && (
            <p className="notice warning">
              The server dropped {state.dropped} events to stay under its rate cap.
            </p>
          )}
          {state.message && state.status !== "live" && (
            <p className={state.status === "error" ? "notice warning" : "muted"}>{visibleText(state.message)}</p>
          )}
          <DataTable
            className="dense profiler-events"
            columns={["Time", <span className="num">DB</span>, "Client", "Command"]}
            rows={events
              .slice()
              .reverse()
              .map((event) => [
                <span className="tabular nowrap" title={formatDateTime(event.t, prefs)}>
                  {formatTime(event.t, prefs)}
                </span>,
                <span className="num tabular">{event.db}</span>,
                <Ident text={event.client} />,
                <CommandLine argv={event.argv} />,
              ])}
            empty={
              active
                ? "Recording. Commands appear here as Redis receives them."
                : "Start a session to record commands."
            }
          />
        </section>
      </div>
    </>
  );
}
