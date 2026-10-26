import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pause, Play, Trash2, X } from "lucide-react";
import {
  binFromString,
  type PubSubChannels,
  type PubSubMessage,
  type PubSubSubscription,
  type PublishResponse,
} from "@rconsole/shared";
import { canWrite, useDatabase } from "../../lib/context.tsx";
import { dbPath, post, query, request } from "../../lib/api.ts";
import { bytesLabel, formatValue, visibleText } from "../../lib/format.ts";
import { useLive, useLiveSessions, type LiveState, type PubSubTopics } from "../../lib/live.tsx";
import { ageLabel, formatDateTime, formatTime, usePreferences } from "../../lib/preferences.ts";
import { useNow } from "../anatomy.tsx";
import { ActionForm, CopyButton, DataTable, ErrorState, Field } from "../ui.tsx";
import { RefreshButton, ToolHead } from "./common.tsx";

/** The server allows at most this many channels and patterns per subscription. */
export const MAX_TOPICS = 10;
const PUBSUB_MAX_MS = 15 * 60_000;
export type MessageFormat = "text" | "json" | "hex" | "msgpack";
const FORMATS: { id: MessageFormat; label: string }[] = [
  { id: "text", label: "Text" },
  { id: "json", label: "JSON" },
  { id: "msgpack", label: "MsgPack" },
  { id: "hex", label: "Hex" },
];

/** A message in the chosen format; a payload that is not in that format falls back to text and says so. */
export function formatMessage(event: PubSubMessage, format: MessageFormat, limit = 5000) {
  if (format === "text") return { text: formatValue(event.message, "text", limit) };
  try {
    return { text: formatValue(event.message, format, format === "hex" ? limit * 4 : limit) };
  } catch {
    return {
      text: formatValue(event.message, "text", limit),
      note: `Not ${format === "json" ? "JSON" : "MessagePack"}${event.truncated ? " (or cut by the server preview)" : ""}; shown as text.`,
    };
  }
}

/** Plain-text export of the shown messages, oldest first: time, channel, pattern, message. Explicit user action only. */
export function messagesText(events: PubSubMessage[], format: MessageFormat) {
  return events
    .map((event) =>
      [
        formatDateTime(event.t),
        event.channel,
        event.pattern ?? "",
        formatMessage(event, format, 100_000).text,
      ].join("\t"),
    )
    .join("\n");
}

/** Adds a topic unless it is empty, already listed, or the total would pass the server's limit. */
export function addTopic(topics: PubSubTopics, kind: keyof PubSubTopics, value: string): PubSubTopics | string {
  if (!value) return "Type a channel or pattern first.";
  if (topics[kind].includes(value)) return `${value} is already in the list.`;
  if (topics.channels.length + topics.patterns.length >= MAX_TOPICS)
    return `At most ${MAX_TOPICS} channels and patterns per session.`;
  return { ...topics, [kind]: [...topics[kind], value] };
}

function LiveBadge({ state }: { state: LiveState<unknown> }) {
  const now = useNow();
  if (state.status === "idle") return <>Not listening. Sessions stop after 15 minutes.</>;
  const live = state.status === "live" || state.status === "connecting";
  return (
    <span className={`live-status ${state.status}`} data-testid="pubsub-status">
      <span className="dot" aria-hidden="true" />
      {state.status === "live"
        ? "Listening"
        : state.status === "connecting"
          ? "Connecting"
          : state.status === "error"
            ? "Disconnected"
            : "Stopped"}
      {live && state.endsAt && (
        <small className="muted-inherit">
          {" "}
          · ends in {Math.max(0, Math.ceil((state.endsAt - now) / 60_000))} min · keeps running while you use other pages
        </small>
      )}
    </span>
  );
}

function TopicChips({
  topics,
  onRemove,
}: {
  topics: PubSubTopics;
  onRemove?: (kind: keyof PubSubTopics, value: string) => void;
}) {
  const all = [
    ...topics.channels.map((value) => ({ kind: "channels" as const, value })),
    ...topics.patterns.map((value) => ({ kind: "patterns" as const, value })),
  ];
  if (!all.length) return null;
  return (
    <ul className="topic-chips" aria-label="Channels and patterns" data-testid="pubsub-topics">
      {all.map(({ kind, value }) => (
        <li key={`${kind}:${value}`} className={`topic-chip ${kind}`}>
          <span className="topic-kind">{kind === "channels" ? "channel" : "pattern"}</span>
          <code className="data">{visibleText(value)}</code>
          {onRemove && (
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove ${kind === "channels" ? "channel" : "pattern"} ${visibleText(value)}`}
              onClick={() => onRemove(kind, value)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function PubSub() {
  const db = useDatabase();
  const prefs = usePreferences();
  const { pubsub, pubsubTopics } = useLiveSessions();
  const state = useLive(pubsub);
  const [topics, setTopicsState] = useState<PubSubTopics>(pubsubTopics.current);
  const setTopics = (next: PubSubTopics) => {
    pubsubTopics.current = next;
    setTopicsState(next);
  };
  const [channel, setChannel] = useState("");
  const [pattern, setPattern] = useState("");
  const [topicError, setTopicError] = useState("");
  const [publishChannel, setPublishChannel] = useState("");
  const [message, setMessage] = useState("");
  const [subscribers, setSubscribers] = useState<PublishResponse>();
  const [format, setFormat] = useState<MessageFormat>("text");
  const [channelsRefresh, setChannelsRefresh] = useState<number>(prefs.toolRefreshSeconds || 15);
  const now = useNow();
  const channels = useQuery({
    queryKey: ["pubsub-channels", db.id],
    queryFn: () => request<PubSubChannels>(dbPath(db.id, "/pubsub/channels"), { method: "POST", body: {}, background: true }),
    refetchInterval: channelsRefresh * 1000,
  });
  const listening = pubsub.active;
  const add = (kind: keyof PubSubTopics, value: string) => {
    const next = addTopic(topics, kind, value);
    if (typeof next === "string") {
      setTopicError(next);
      return false;
    }
    setTopicError("");
    setTopics(next);
    if (kind === "channels") setChannel("");
    else setPattern("");
    return true;
  };
  const shown = state.frozen ? state.frozen.events : state.events;
  const arrivedWhileFrozen = state.frozen ? state.received - state.frozen.received : 0;
  // Refresh the channel list right after a session starts, so the new subscriber shows up.
  useEffect(() => {
    if (state.status === "live") void channels.refetch();
  }, [state.status]);
  return (
    <>
      <ToolHead title="Pub/Sub" meta={<LiveBadge state={state} />} />
      <div className="pane-body">
        <div className="grid-2 pubsub-forms">
          <section className="section">
            <header>
              <h2>Listen</h2>
              <span className="meta">SUBSCRIBE / PSUBSCRIBE · up to {MAX_TOPICS}</span>
            </header>
            {listening ? (
              <div className="listening">
                <TopicChips topics={topics} />
                <button type="button" onClick={() => pubsub.stop()} data-testid="pubsub-stop">
                  Stop listening
                </button>
              </div>
            ) : (
              <ActionForm
                label={`Start listening${topics.channels.length + topics.patterns.length > 1 ? ` to ${topics.channels.length + topics.patterns.length}` : ""}`}
                testId="pubsub-subscribe"
                onSubmit={async () => {
                  // Text still in the fields counts, so a single channel needs no extra Add.
                  let next = topics;
                  for (const [kind, value] of [
                    ["channels", channel],
                    ["patterns", pattern],
                  ] as const) {
                    if (!value) continue;
                    const added = addTopic(next, kind, value);
                    if (typeof added === "string") {
                      if (!next[kind].includes(value)) throw new Error(added);
                    } else next = added;
                  }
                  if (!next.channels.length && !next.patterns.length)
                    throw new Error("Enter a channel or a pattern to listen to.");
                  const subscription = await post<PubSubSubscription>(dbPath(db.id, "/pubsub/subscriptions"), next);
                  setTopics(next);
                  setChannel("");
                  setPattern("");
                  setTopicError("");
                  pubsub.start(dbPath(db.id, "/pubsub/stream") + query({ sub: subscription.id }), PUBSUB_MAX_MS);
                }}
              >
                <div className="form-row topic-row">
                  <Field label="Channel">
                    <input
                      className="data"
                      value={channel}
                      onChange={(e) => setChannel(e.target.value)}
                      maxLength={1024}
                      placeholder="orders.events"
                      data-testid="pubsub-channel"
                    />
                  </Field>
                  <button type="button" className="ghost" onClick={() => add("channels", channel)} data-testid="pubsub-add-channel">
                    Add channel
                  </button>
                </div>
                <div className="form-row topic-row">
                  <Field label="Pattern (optional)">
                    <input
                      className="data"
                      value={pattern}
                      onChange={(e) => setPattern(e.target.value)}
                      maxLength={1024}
                      placeholder="orders.*"
                      data-testid="pubsub-pattern"
                    />
                  </Field>
                  <button type="button" className="ghost" onClick={() => add("patterns", pattern)} data-testid="pubsub-add-pattern">
                    Add pattern
                  </button>
                </div>
                <TopicChips
                  topics={topics}
                  onRemove={(kind, value) => setTopics({ ...topics, [kind]: topics[kind].filter((item) => item !== value) })}
                />
                {topicError && (
                  <small className="field-error" role="alert">
                    {visibleText(topicError)}
                  </small>
                )}
              </ActionForm>
            )}
          </section>
          <section className="section">
            <header>
              <h2>Publish</h2>
              <span className="meta">PUBLISH</span>
            </header>
            <ActionForm
              label="Publish"
              testId="pubsub-publish"
              disabled={!canWrite(db)}
              onSubmit={async () => {
                setSubscribers(
                  await post(dbPath(db.id, "/pubsub/publish"), {
                    channel: publishChannel,
                    message: binFromString(message),
                  }),
                );
              }}
            >
              <Field label="Channel">
                <input
                  className="data"
                  required
                  value={publishChannel}
                  onChange={(e) => setPublishChannel(e.target.value)}
                  data-testid="publish-channel"
                  maxLength={1024}
                />
              </Field>
              <Field label="Message">
                <textarea
                  className="data"
                  rows={2}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  data-testid="publish-message"
                />
              </Field>
              {!canWrite(db) && (
                <small>
                  {db.readOnly
                    ? "This database is read-only, so publishing is off."
                    : "Publishing needs the operator or admin role."}
                </small>
              )}
              {subscribers !== undefined && (
                <small role="status">
                  Delivered to {subscribers.receivers}{" "}
                  {subscribers.receivers === 1 ? "subscriber" : "subscribers"}.
                </small>
              )}
            </ActionForm>
          </section>
        </div>
        <section className="section">
          <header>
            <h2>Messages</h2>
            <span className="meta" data-testid="pubsub-count">
              {shown.length} of {pubsub.limit} kept · newest first
              {state.received > shown.length && !state.frozen ? ` · ${state.received} received` : ""}
            </span>
            <div className="actions">
              <label className="inline-select">
                <span>Format</span>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as MessageFormat)}
                  data-testid="pubsub-format"
                >
                  {FORMATS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="ghost"
                aria-pressed={!!state.frozen}
                onClick={() => pubsub.freeze(!state.frozen)}
                data-testid="pubsub-freeze"
                title="Stop the table moving while you read; messages keep arriving underneath"
              >
                {state.frozen ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
                {state.frozen ? `Resume${arrivedWhileFrozen ? ` (${arrivedWhileFrozen} new)` : ""}` : "Freeze"}
              </button>
              <CopyButton
                label="Copy shown messages"
                text={() => messagesText(shown, format)}
              />
              <button
                type="button"
                className="ghost"
                onClick={() => pubsub.clear()}
                disabled={!state.events.length && !shown.length}
                data-testid="pubsub-clear"
              >
                <Trash2 size={13} aria-hidden="true" />
                Clear
              </button>
            </div>
          </header>
          {state.frozen && (
            <p className="notice" role="status" data-testid="pubsub-frozen">
              Display frozen. {arrivedWhileFrozen} {arrivedWhileFrozen === 1 ? "message" : "messages"} arrived since;
              Resume shows the latest {pubsub.limit}.
            </p>
          )}
          {state.dropped > 0 && (
            <p className="notice warning">
              The server dropped {state.dropped} messages to stay under its rate cap.
            </p>
          )}
          {state.status === "closed" && state.message && (
            <p className="muted">{visibleText(state.message)}</p>
          )}
          {state.status === "error" && (
            <p className="notice warning">
              The subscription ended or could not connect: {visibleText(state.message)} Start listening again to
              reconnect.
            </p>
          )}
          <DataTable
            className="dense pubsub-messages"
            columns={["Time", "Channel", "Pattern", "Message"]}
            rows={[...shown].reverse().map((event) => {
              const formatted = formatMessage(event, format);
              return [
                <span className="tabular nowrap" title={`${formatDateTime(event.t)} · ${ageLabel(event.t, now)}`}>
                  {formatTime(event.t, prefs)}
                </span>,
                <code className="data">{visibleText(event.channel)}</code>,
                <code className="muted">{visibleText(event.pattern ?? "—")}</code>,
                <div>
                  <code className={`data message ${format !== "text" ? "preformatted" : ""}`.trim()}>{formatted.text}</code>
                  {formatted.note && <small>{formatted.note}</small>}
                  {event.truncated && <small>Server preview · {bytesLabel(event.totalBytes)} total</small>}
                </div>,
              ];
            })}
            empty={
              listening
                ? "Listening. Messages appear here as they arrive."
                : "Start listening to one or more channels or patterns to see messages."
            }
          />
        </section>
        <section className="section">
          <header>
            <h2>Active channels</h2>
            <span className="meta">
              {channels.data
                ? `${channels.data.channels.length} channels · ${channels.data.patterns} pattern subscriptions${channels.dataUpdatedAt ? ` · ${ageLabel(channels.dataUpdatedAt, now)}` : ""}`
                : "PUBSUB CHANNELS"}
            </span>
            <div className="actions">
              <label className="inline-select">
                <span>Refresh</span>
                <select
                  value={channelsRefresh}
                  onChange={(e) => setChannelsRefresh(Number(e.target.value))}
                  aria-label="Active channels refresh interval"
                >
                  {[5, 15, 30, 60].map((seconds) => (
                    <option key={seconds} value={seconds}>
                      every {seconds} s
                    </option>
                  ))}
                </select>
              </label>
              <RefreshButton
                busy={channels.isFetching}
                onClick={() => {
                  void channels.refetch();
                }}
              />
            </div>
          </header>
          <ErrorState
            error={channels.error}
            onRetry={() => {
              void channels.refetch();
            }}
          />
          <DataTable
            className="dense"
            columns={["Channel", <span className="num">Subscribers</span>]}
            rows={(channels.data?.channels ?? []).map((row) => [
              <span className="channel-cell">
                <code className="data">{visibleText(row.name)}</code>
                {!listening && !topics.channels.includes(row.name) && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => add("channels", row.name)}
                    aria-label={`Add ${visibleText(row.name)} to the channels to listen to`}
                  >
                    Add
                  </button>
                )}
              </span>,
              <span className="num tabular">{row.subscribers}</span>,
            ])}
            empty="No channel has subscribers right now."
          />
        </section>
      </div>
    </>
  );
}
