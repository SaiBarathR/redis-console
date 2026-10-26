import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  binFromString,
  type AnalysisReport,
  type Bin,
  type ClientInfo,
  type DatabaseSummary,
  type SearchIndexSummary,
  type SearchResult,
  type StreamGroupInfo,
  type StreamPendingEntry,
  type TimeSeriesRange,
} from "@rconsole/shared";
import { canAdmin, canWrite, useDatabase } from "../lib/context.tsx";
import { collection, dbPath, post, query, request } from "../lib/api.ts";
import {
  bytesLabel,
  visibleText,
} from "../lib/format.ts";
import { useMemorySlot } from "../lib/memory.tsx";
import {
  ActionForm,
  DataTable,
  Empty,
  ErrorState,
  Field,
  JsonTree,
  Loading,
  PageTitle,
  Readout,
} from "../components/ui.tsx";
import {
  KeyName,
  TtlFuse,
  TypeGlyph,
  typeInfo,
} from "../components/anatomy.tsx";
import { ReplyView } from "../components/Reply.tsx";
import { executeCli, keyOperation } from "../lib/operations.ts";
import { Chart } from "../components/Chart.tsx";
import {
  InlineAction,
  RefreshButton,
  ToolHead,
  dateTimeFormat,
  durationLabel,
  msLabel,
} from "../components/diagnostics/common.tsx";
import { Slowlog } from "../components/diagnostics/Slowlog.tsx";
import { PubSub } from "../components/diagnostics/PubSub.tsx";
import { Profiler } from "../components/diagnostics/Profiler.tsx";
import { Analysis } from "./analysis/AnalysisTool.tsx";
import { SearchTool } from "./search/SearchTool.tsx";

/** Diagnostics tools. `command` names what each tool runs, so the list teaches the CLI too. */
const TOOLS = [
  {
    id: "slowlog",
    title: "Slow log",
    description: "Commands that ran longer than the slow log threshold.",
    command: "SLOWLOG GET",
  },
  {
    id: "analysis",
    title: "Memory analysis",
    description: "Sample key sizes by type, namespace and expiry.",
    command: "MEMORY USAGE",
  },
  {
    id: "pubsub",
    title: "Pub/Sub",
    description: "Listen to channels and publish messages.",
    command: "SUBSCRIBE · PUBLISH",
  },
  {
    id: "streams",
    title: "Streams",
    description: "Consumer groups, consumers and pending entries.",
    command: "XINFO · XPENDING",
  },
  {
    id: "clients",
    title: "Clients",
    description: "Open connections, what they run and how long they idle.",
    command: "CLIENT LIST",
    admin: true,
  },
  {
    id: "profiler",
    title: "Profiler",
    description: "Every command the server receives, for up to 60 seconds.",
    command: "MONITOR",
    admin: true,
    /** Server-computed availability (role + policy.profilerAllowedEnvironments). */
    feature: "profiler" as const,
  },
  {
    id: "search",
    title: "Search",
    description: "Indexes, queries, query plans and profiles.",
    command: "FT.SEARCH",
    module: "search",
  },
  {
    id: "timeseries",
    title: "TimeSeries",
    description: "Chart a series and aggregate time ranges.",
    command: "TS.RANGE",
    module: "timeseries",
  },
];
type Tool = (typeof TOOLS)[number];

/** Why a tool is unavailable to this user on this database. */
function unavailableReason(item: Tool, db: DatabaseSummary) {
  if (item.admin && db.effectiveRole !== "admin")
    return db.readOnly
      ? "Read-only database: your role here is viewer."
      : "Needs the admin role on this database.";
  if ("feature" in item && item.feature && !db.features[item.feature])
    return `Turned off by server policy for ${db.environment === "prod" ? "production" : db.environment} databases.`;
  return `Needs the Redis ${item.module} module on this database.`;
}
function toolAvailable(item: Tool, db: DatabaseSummary) {
  return (
    (!item.admin || db.effectiveRole === "admin") &&
    (!("feature" in item) || !item.feature || db.features[item.feature]) &&
    (!item.module ||
      !!db.server?.modules.some((module) =>
        module.name.toLowerCase().includes(item.module!),
      ))
  );
}

export function Diagnostics() {
  const { tool } = useParams();
  const db = useDatabase();
  const base = `/db/${encodeURIComponent(db.id)}/diagnostics`;
  const available = TOOLS.filter((item) => toolAvailable(item, db));
  const unavailable = TOOLS.filter((item) => !toolAvailable(item, db));
  // The view opens on the slow log so it starts with data, not a menu.
  const shown = tool ?? "slowlog";
  const current = TOOLS.find((item) => item.id === shown);
  return (
    <div className="workspace diagnostics">
      <PageTitle
        title="Diagnostics"
        description={`${available.length} of ${TOOLS.length} tools available as ${db.effectiveRole}`}
      />
      <div className="split diag-split">
        <nav className="side-list" aria-label="Diagnostics tools">
          {available.map((item) => (
            <Link
              key={item.id}
              to={`${base}/${item.id}`}
              className={item.id === shown ? "active" : undefined}
              aria-current={item.id === shown ? "page" : undefined}
              data-testid={`diagnostics-${item.id}`}
            >
              <span>{item.title}</span>
              <code>{item.command}</code>
              <small>{item.description}</small>
            </Link>
          ))}
          {unavailable.length > 0 && (
            <>
              <div className="side-list-label" id="diag-unavailable">
                Not available here
              </div>
              {unavailable.map((item) => (
                <div
                  key={item.id}
                  className="unavailable"
                  aria-describedby="diag-unavailable"
                >
                  <span>{item.title}</span>
                  <code>{item.command}</code>
                  <small>{unavailableReason(item, db)}</small>
                </div>
              ))}
            </>
          )}
        </nav>
        <section className="diag-pane" aria-label={current?.title ?? "Tool"}>
          {!current ? (
            <Empty
              title="This diagnostics tool does not exist."
              action={<Link to={base}>Open the slow log</Link>}
            >
              Choose a tool from the list.
            </Empty>
          ) : !available.includes(current) ? (
            <Empty
              title={`${current.title} is not available here.`}
              action={<Link to={base}>Open the slow log</Link>}
            >
              {unavailableReason(current, db)}
            </Empty>
          ) : shown === "slowlog" ? (
            <Slowlog />
          ) : shown === "clients" ? (
            <Clients />
          ) : shown === "analysis" ? (
            <Analysis />
          ) : shown === "pubsub" ? (
            <PubSub />
          ) : shown === "streams" ? (
            <Streams />
          ) : shown === "profiler" ? (
            <Profiler />
          ) : shown === "search" ? (
            <SearchTool />
          ) : (
            <TimeSeries />
          )}
        </section>
      </div>
    </div>
  );
}


function Clients() {
  const db = useDatabase();
  const [error, setError] = useState<unknown>();
  const data = useQuery({
    queryKey: ["clients", db.id],
    queryFn: async () =>
      collection<ClientInfo>(
        await request(dbPath(db.id, "/clients")),
        "clients",
      ),
  });
  const clients = data.data ?? [];
  const own = clients.filter((entry) => entry.name.startsWith("rconsole-"));
  return (
    <>
      <ToolHead
        title="Clients"
        meta={
          data.data
            ? `${clients.length} connections · ${own.length} from Redis Console`
            : undefined
        }
      >
        <RefreshButton
          busy={data.isFetching}
          onClick={() => {
            void data.refetch();
          }}
        />
      </ToolHead>
      <div className="pane-body">
        <ErrorState error={error} />
        <ErrorState
          error={data.error}
          onRetry={() => {
            void data.refetch();
          }}
        />
        {data.isPending ? (
          <Loading label="Reading connected clients…" />
        ) : (
          <DataTable
            className="dense"
            columns={[
              <span className="num">ID</span>,
              "Address and name",
              "User",
              <span className="num">Age</span>,
              <span className="num">Idle</span>,
              "Last command",
              "Flags",
              <span className="sr-only">Actions</span>,
            ]}
            rows={clients.map((entry) => {
              const ownConnection = entry.name.startsWith("rconsole-");
              return [
                <code className="num">{entry.id}</code>,
                <span className="client-cell">
                  {entry.addr && entry.addr !== "<hidden>" ? (
                    <code>{visibleText(entry.addr)}</code>
                  ) : (
                    <span className="muted">Address hidden</span>
                  )}
                  {entry.name && <small>{visibleText(entry.name)}</small>}
                </span>,
                <code>{visibleText(entry.user)}</code>,
                <span className="num tabular nowrap">
                  {durationLabel(entry.age)}
                </span>,
                <span className="num tabular nowrap">
                  {durationLabel(entry.idle)}
                </span>,
                <code>{visibleText(entry.cmd || "—")}</code>,
                <code className="muted">{visibleText(entry.flags)}</code>,
                ownConnection ? (
                  <span
                    className="protected"
                    title="Redis Console uses this connection, so it cannot be killed here."
                  >
                    This console
                  </span>
                ) : (
                  canAdmin(db) && (
                  <InlineAction
                    label="Kill"
                    danger
                    subtle
                    title={`Close connection ${entry.id}`}
                    testId="client-kill"
                    onError={setError}
                    onRun={async () => {
                      await post(
                        dbPath(db.id, "/clients/kill"),
                        { id: entry.id },
                        `Connection ${entry.id}${entry.name ? ` (${entry.name})` : ""}, running ${entry.cmd || "no command"}.`,
                      );
                      await data.refetch();
                    }}
                  />
                  )
                ),
              ];
            })}
            empty="No clients are connected."
          />
        )}
      </div>
    </>
  );
}

function Streams() {
  const db = useDatabase();
  const client = useQueryClient();
  const [key, setKey] = useState("");
  const [selectedKey, setSelectedKey] = useState("");
  const [group, setGroup] = useState("");
  const [ids, setIds] = useState("");
  const [createGroup, setCreateGroup] = useState("");
  const [error, setError] = useState<unknown>();
  const groups = useQuery({
    queryKey: ["stream-groups", db.id, selectedKey],
    enabled: !!selectedKey,
    queryFn: async () =>
      collection<StreamGroupInfo>(
        await request(dbPath(db.id, "/streams/groups"), {
          method: "POST",
          body: { key: binFromString(selectedKey) },
        }),
        "groups",
      ),
  });
  const pending = useQuery({
    queryKey: ["stream-pending", db.id, selectedKey, group],
    enabled: !!selectedKey && !!group,
    queryFn: async () =>
      collection<StreamPendingEntry>(
        await request(dbPath(db.id, "/streams/pending"), {
          method: "POST",
          body: { key: binFromString(selectedKey), group },
        }),
        "pending",
      ),
  });
  const selectedGroup = groups.data?.find((item) => item.name === group);
  return (
    <>
      <ToolHead
        title="Streams"
        meta={
          selectedKey ? (
            <KeyName name={binFromString(selectedKey)} limit={200} />
          ) : (
            "Inspect a stream's consumer groups"
          )
        }
      />
      <div className="pane-body">
        <form
          className="inline-form plain"
          onSubmit={(e) => {
            e.preventDefault();
            setSelectedKey(key);
            setGroup("");
          }}
        >
          <Field label="Stream key">
            <input
              className="data"
              required
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="orders:events"
              data-testid="stream-key"
            />
          </Field>
          <button
            type="submit"
            className="primary"
            data-testid="stream-inspect"
          >
            Inspect stream
          </button>
        </form>
        <ErrorState error={error} />
        <ErrorState
          error={groups.error}
          onRetry={() => {
            void groups.refetch();
          }}
        />
        {!selectedKey && (
          <Empty compact title="No stream selected.">
            Enter a stream key to list its consumer groups (
            <code>XINFO GROUPS</code>), consumers and pending entries (
            <code>XPENDING</code>).
          </Empty>
        )}
        {selectedKey && (
          <>
            <section className="section">
              <header>
                <h2>Consumer groups</h2>
                <span className="meta">Choose a group to see its consumers</span>
              </header>
              {groups.isPending ? (
                <Loading label="Reading consumer groups…" />
              ) : (
                <DataTable
                  className="dense"
                  columns={[
                    "Group",
                    <span className="num">Consumers</span>,
                    <span className="num">Pending</span>,
                    <span className="num">Lag</span>,
                    "Last delivered",
                    <span className="sr-only">Actions</span>,
                  ]}
                  rows={(groups.data ?? []).map((row) => [
                    <button
                      type="button"
                      className={`ghost data group-button ${row.name === group ? "selected" : ""}`}
                      aria-pressed={row.name === group}
                      onClick={() => setGroup(row.name)}
                    >
                      {visibleText(row.name)}
                    </button>,
                    <span className="num tabular">{row.consumers.length}</span>,
                    <span className="num tabular">{row.pending}</span>,
                    <span className="num tabular">{row.lag ?? "—"}</span>,
                    <code>{row.lastDeliveredId}</code>,
                    canWrite(db) && (
                      <InlineAction
                        label="Destroy"
                        danger
                        subtle
                        onError={setError}
                        onRun={async () => {
                          await keyOperation(db.id, {
                            op: "stream.group.destroy",
                            key: binFromString(selectedKey),
                            group: row.name,
                          });
                          if (row.name === group) setGroup("");
                          await groups.refetch();
                        }}
                      />
                    ),
                  ])}
                  empty={
                    <>
                      <strong>This stream has no consumer groups.</strong>
                      <span>
                        {canWrite(db)
                          ? "Create one below, or check the key name."
                          : "Check the key name, or ask an operator to create a group."}
                      </span>
                    </>
                  }
                />
              )}
            </section>
            {group && (
              <div className="grid-2">
                <section className="section">
                  <header>
                    <h2>
                      Consumers in <code>{visibleText(group)}</code>
                    </h2>
                  </header>
                  <DataTable
                    className="dense"
                    columns={[
                      "Consumer",
                      <span className="num">Pending</span>,
                      <span className="num">Idle</span>,
                      <span className="num">Inactive</span>,
                    ]}
                    rows={(selectedGroup?.consumers ?? []).map((consumer) => [
                      <code>{visibleText(consumer.name)}</code>,
                      <span className="num tabular">{consumer.pending}</span>,
                      <span className="num tabular">
                        {msLabel(consumer.idleMs)}
                      </span>,
                      <span className="num tabular">
                        {consumer.inactiveMs === undefined
                          ? "—"
                          : msLabel(consumer.inactiveMs)}
                      </span>,
                    ])}
                    empty="This group has no consumers yet."
                  />
                </section>
                <section className="section">
                  <header>
                    <h2>Pending entries</h2>
                    <span className="meta">delivered, not acknowledged</span>
                  </header>
                  <ErrorState
                    error={pending.error}
                    onRetry={() => {
                      void pending.refetch();
                    }}
                  />
                  {pending.isPending ? (
                    <Loading label="Reading pending entries…" />
                  ) : (
                    <DataTable
                      className="dense"
                      columns={[
                        "Entry ID",
                        "Consumer",
                        <span className="num">Idle</span>,
                        <span className="num">Deliveries</span>,
                      ]}
                      rows={(pending.data ?? []).map((row) => [
                        <code>{row.id}</code>,
                        <code>{visibleText(row.consumer)}</code>,
                        <span className="num tabular">
                          {msLabel(row.idleMs)}
                        </span>,
                        <span className="num tabular">{row.deliveries}</span>,
                      ])}
                      empty="No pending entries. Every delivered entry is acknowledged."
                    />
                  )}
                  <div className="inline-form">
                    <ActionForm
                      label="Acknowledge"
                      testId="stream-ack"
                      disabled={!canWrite(db)}
                      onSubmit={async () => {
                        await post(dbPath(db.id, "/ops"), {
                          op: "stream.ack",
                          key: binFromString(selectedKey),
                          group,
                          ids: ids.split(/[\s,]+/).filter(Boolean),
                        });
                        setIds("");
                        await client.invalidateQueries({
                          queryKey: ["stream-pending", db.id],
                        });
                        await groups.refetch();
                      }}
                    >
                      <Field
                        label="Entry IDs"
                        hint="Separate IDs with spaces or commas."
                      >
                        <input
                          className="data"
                          required
                          value={ids}
                          onChange={(e) => setIds(e.target.value)}
                          data-testid="stream-ack-ids"
                        />
                      </Field>
                    </ActionForm>
                  </div>
                </section>
              </div>
            )}
            {canWrite(db) && (
              <section className="section">
                <header>
                  <h2>Create a consumer group</h2>
                  <span className="meta">XGROUP CREATE … $ MKSTREAM</span>
                </header>
                <div className="inline-form">
                  <ActionForm
                    label="Create group"
                    testId="stream-group-create"
                    onSubmit={async () => {
                      await post(dbPath(db.id, "/ops"), {
                        op: "stream.group.create",
                        key: binFromString(selectedKey),
                        group: createGroup,
                        id: "$",
                        mkstream: true,
                      });
                      setCreateGroup("");
                      await groups.refetch();
                    }}
                  >
                    <Field label="Group name">
                      <input
                        className="data"
                        required
                        value={createGroup}
                        onChange={(e) => setCreateGroup(e.target.value)}
                        data-testid="stream-group-name"
                      />
                    </Field>
                  </ActionForm>
                </div>
                <small className="muted">
                  The group starts at the newest entry ($). Redis creates the
                  stream if it does not exist.
                </small>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}

function TimeSeries() {
  const db = useDatabase();
  const [key, setKey] = useState("");
  const [from, setFrom] = useState("-");
  const [to, setTo] = useState("+");
  const [bucket, setBucket] = useState("");
  const [agg, setAgg] = useState("avg");
  const [result, setResult] = useState<TimeSeriesRange>();
  const values = result?.samples.map(([, v]) => Number(v)) ?? [];
  return (
    <>
      <ToolHead title="TimeSeries" meta="TS.RANGE with optional aggregation" />
      <div className="pane-body">
        <div className="inline-form">
          <ActionForm
            label="Load range"
            testId="timeseries-run"
            onSubmit={async () =>
              setResult(
                await request<TimeSeriesRange>(
                  dbPath(db.id, "/timeseries/range"),
                  {
                    method: "POST",
                    body: {
                      key: binFromString(key),
                      from: from === "-" ? "-" : Number(from),
                      to: to === "+" ? "+" : Number(to),
                      bucketMs: bucket ? Number(bucket) : undefined,
                      agg: bucket ? agg : undefined,
                    },
                  },
                ),
              )
            }
          >
            <Field label="Series key">
              <input
                className="data wide"
                required
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="sensor:42:temperature"
                data-testid="timeseries-key"
              />
            </Field>
            <Field label="From (epoch ms or -)">
              <input
                className="data"
                required
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label="To (epoch ms or +)">
              <input
                className="data"
                required
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
            <Field label="Bucket (ms)">
              <input
                type="number"
                min={1}
                value={bucket}
                placeholder="none"
                onChange={(e) => setBucket(e.target.value)}
              />
            </Field>
            <Field label="Aggregation">
              <select
                value={agg}
                disabled={!bucket}
                onChange={(e) => setAgg(e.target.value)}
              >
                {["avg", "sum", "min", "max", "count", "first", "last"].map(
                  (a) => (
                    <option key={a}>{a}</option>
                  ),
                )}
              </select>
            </Field>
          </ActionForm>
        </div>
        {!result && (
          <Empty compact title="No series loaded.">
            Enter a TimeSeries key and load a range. Add a bucket to aggregate
            samples, for example 60000 for one-minute averages.
          </Empty>
        )}
        {result && (
          <>
            <div className="readouts">
              <Readout
                label="Samples"
                value={result.samples.length.toLocaleString()}
                sub={result.aggregation ? `aggregated: ${result.aggregation}` : "raw"}
              />
              <Readout
                label="Latest"
                value={values.length ? values.at(-1)!.toLocaleString() : "—"}
                sub={
                  result.samples.length
                    ? dateTimeFormat.format(new Date(result.samples.at(-1)![0]))
                    : "no samples"
                }
              />
              <Readout
                label="Minimum"
                value={values.length ? Math.min(...values).toLocaleString() : "—"}
              />
              <Readout
                label="Maximum"
                value={values.length ? Math.max(...values).toLocaleString() : "—"}
              />
            </div>
            <section className="section">
              <header>
                <h2>Chart</h2>
                <span className="meta">
                  <KeyName name={result.key} limit={200} />
                </span>
              </header>
              <Chart
                label="TimeSeries"
                color="--type-timeseries"
                samples={result.samples.map(([t, v]) => [t, Number(v)])}
                waiting="This range has fewer than two samples. Widen the range."
              />
            </section>
            <section className="section">
              <header>
                <h2>Samples</h2>
              </header>
              <DataTable
                className="dense"
                columns={["Timestamp", <span className="num">Value</span>]}
                rows={result.samples.map(([t, v]) => [
                  <span className="tabular" title={String(t)}>
                    {new Date(t).toLocaleString()}
                  </span>,
                  <span className="num tabular">{visibleText(v)}</span>,
                ])}
                empty="No samples in this range."
              />
            </section>
          </>
        )}
      </div>
    </>
  );
}
