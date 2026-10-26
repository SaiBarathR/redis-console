import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ProfilerEvent, PubSubMessage } from "@rconsole/shared";
import { readStream } from "./sse.ts";

export type LiveStatus = "idle" | "connecting" | "live" | "closed" | "error";

export interface LiveState<T> {
  status: LiveStatus;
  /** Oldest first, at most `limit`. */
  events: T[];
  /** Events received since the session started (also those that rolled out of `events`). */
  received: number;
  dropped: number;
  message: string;
  startedAt?: number;
  /** When the server will end the session (its own time limit). */
  endsAt?: number;
  /** Frozen display: a copy of `events` taken when the user paused the view. Arrivals continue underneath. */
  frozen?: { events: T[]; received: number };
}

/**
 * One live server-sent-event session, owned by the database layout rather than a page, so it keeps running while the
 * user moves between that database's pages (F22, F27). Events stay in memory only and are bounded by `limit`; the
 * server keeps its own time limits and caps (pub/sub 15 minutes, profiler 60 seconds, per-user stream count).
 */
export class LiveSession<T> {
  private state: LiveState<T>;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
    this.state = { status: "idle", events: [], received: 0, dropped: 0, message: "" };
  }

  snapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(change: Partial<LiveState<T>>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach((listener) => listener());
  }

  get active() {
    return this.state.status === "connecting" || this.state.status === "live";
  }

  /** Opens `path`; `maxMs` ends the session on the client too, in case the server's end event is lost. */
  start(path: string, maxMs: number) {
    this.stop("");
    const controller = new AbortController();
    this.controller = controller;
    const startedAt = Date.now();
    this.set({
      status: "connecting",
      events: [],
      received: 0,
      dropped: 0,
      message: "",
      startedAt,
      endsAt: startedAt + maxMs,
      frozen: undefined,
    });
    this.timer = setTimeout(() => this.stop("Time limit reached."), maxMs + 1000);
    void readStream<T>(path, controller.signal, {
      open: () => {
        if (this.controller === controller) this.set({ status: "live" });
      },
      event: (payload) => {
        if (this.controller !== controller) return;
        this.set({
          events: [...this.state.events.slice(-(this.limit - 1)), payload],
          received: this.state.received + 1,
        });
      },
      dropped: (count) => {
        if (this.controller === controller) this.set({ dropped: this.state.dropped + count });
      },
      end: (reason) => {
        if (this.controller !== controller) return;
        this.finish();
        this.set({ status: "closed", message: reason || "The server ended the session." });
      },
    }).catch((error: unknown) => {
      if (controller.signal.aborted || this.controller !== controller) return;
      this.finish();
      this.set({
        status: "error",
        message: error instanceof Error ? error.message : "Stream disconnected. Start again to reconnect.",
      });
    });
  }

  private finish() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = null;
  }

  /** Ends the session; kept events stay visible until cleared. */
  stop(message = "Stopped.") {
    const wasActive = this.active;
    this.finish();
    if (wasActive) this.set({ status: "closed", message });
  }

  clear() {
    this.set({
      events: [],
      received: 0,
      dropped: 0,
      frozen: this.state.frozen ? { events: [], received: 0 } : undefined,
    });
  }

  freeze(on: boolean) {
    this.set({
      frozen: on ? { events: this.state.events, received: this.state.received } : undefined,
    });
  }

  /** Called when the database layout unmounts (switching database, leaving database pages, signing out). */
  dispose() {
    this.finish();
  }
}

export function useLive<T>(session: LiveSession<T>) {
  return useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
}

/** What the Pub/Sub tool listens to; kept with the session so the form shows it after navigation. */
export interface PubSubTopics {
  channels: string[];
  patterns: string[];
}

interface LiveSessions {
  pubsub: LiveSession<PubSubMessage>;
  pubsubTopics: { current: PubSubTopics };
  profiler: LiveSession<ProfilerEvent>;
}

const Context = createContext<LiveSessions | null>(null);

/** The same bounds the pages used before (messages can be 64 KiB previews each). */
export const PUBSUB_LIMIT = 200;
export const PROFILER_LIMIT = 300;

/** Mounted by the database layout and keyed by database id: sessions never outlive or cross their database. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [sessions] = useState<LiveSessions>(() => ({
    pubsub: new LiveSession<PubSubMessage>(PUBSUB_LIMIT),
    pubsubTopics: { current: { channels: [], patterns: [] } },
    profiler: new LiveSession<ProfilerEvent>(PROFILER_LIMIT),
  }));
  useEffect(
    () => () => {
      sessions.pubsub.dispose();
      sessions.profiler.dispose();
    },
    [sessions],
  );
  return <Context value={sessions}>{children}</Context>;
}

export function useLiveSessions() {
  const value = useContext(Context);
  if (!value) throw new Error("Live sessions are only available on database pages.");
  return value;
}
