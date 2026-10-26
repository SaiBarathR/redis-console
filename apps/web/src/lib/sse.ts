import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "@rconsole/shared";
import { endSession } from "./api.ts";
export interface StreamHandlers<T> {
  open: () => void;
  event: (payload: T, name: string) => void;
  dropped: (count: number) => void;
  end: (reason: string) => void;
  /** Named `ready` event (pub/sub: subscribed channels, profiler: seconds). */
  ready?: (payload: unknown) => void;
}

/**
 * Reads one server-sent event stream with fetch (which exposes admission errors such as HTTP 429) until it ends,
 * the signal aborts, or it fails (the promise rejects with a user-facing message).
 */
export async function readStream<T>(
  path: string,
  signal: AbortSignal,
  handlers: StreamHandlers<T>,
) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "text/event-stream", "X-RC-Background": "1" },
    signal,
  });
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => undefined);
    const detail =
      error && typeof error === "object" && "error" in error
        ? error.error
        : undefined;
    const text =
      detail &&
      typeof detail === "object" &&
      "message" in detail &&
      typeof detail.message === "string"
        ? detail.message
        : undefined;
    if (response.status === 401) endSession(text);
    throw new Error(
      `Live stream refused (HTTP ${response.status}). ${text ?? "Close another live view and try again."}`,
    );
  }
  if (
    !response.headers.get("content-type")?.includes("text/event-stream") ||
    !response.body
  )
    throw new Error("Invalid stream response.");
  handlers.open();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 4 * 1024 * 1024)
        throw new Error("Stream event exceeds the display safety limit.");
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = frame.split(/\r?\n/);
        const name =
          lines
            .find((line) => line.startsWith("event:"))
            ?.slice(6)
            .trim() ?? "message";
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const payload = JSON.parse(data) as T & {
          reason?: string;
          dropped?: number;
        };
        if (name === "end" || name === "done") {
          handlers.end(payload.reason ?? "Session ended.");
          return;
        }
        if (name === "error") {
          const detail = payload as { message?: unknown };
          throw new Error(
            typeof detail.message === "string"
              ? detail.message
              : "The server ended this stream with an error.",
          );
        }
        if (name === "dropped") {
          if (Number.isFinite(payload.dropped))
            handlers.dropped(payload.dropped ?? 0);
          continue;
        }
        if (name === "ready") {
          handlers.ready?.(payload);
          continue;
        }
        if (
          ["message", "metrics", "sample", "command", "profiler"].includes(name)
        )
          handlers.event(payload, name);
      }
    }
    if (!signal.aborted) handlers.end("");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Bounded, explicit-lifetime streams. Fetch exposes admission errors (e.g. HTTP 429). */
export function useSSE<T>(path: string | null, limit = 120) {
  const [events, setEvents] = useState<T[]>([]);
  const [status, setStatus] = useState<
    "connecting" | "live" | "closed" | "error"
  >("closed");
  const [dropped, setDropped] = useState(0);
  const [message, setMessage] = useState("");
  const [generation, setGeneration] = useState(0);
  const reconnect = useCallback(() => setGeneration((value) => value + 1), []);
  useEffect(() => {
    if (!path) {
      setStatus("closed");
      return;
    }
    const controller = new AbortController();
    setEvents([]);
    setDropped(0);
    setMessage("");
    setStatus("connecting");
    const run = () =>
      readStream<T>(path, controller.signal, {
        open: () => setStatus("live"),
        event: (payload) =>
          setEvents((previous) => [...previous.slice(-(limit - 1)), payload]),
        dropped: (count) => setDropped((previous) => previous + count),
        end: (reason) => {
          setMessage(reason);
          setStatus("closed");
        },
      });
    void run().catch((error) => {
      if (!controller.signal.aborted) {
        setStatus("error");
        setMessage(
          error instanceof Error
            ? error.message
            : "Stream disconnected. Start again to reconnect.",
        );
      }
    });
    return () => controller.abort();
  }, [path, limit, generation]);
  return { events, status, dropped, message, reconnect };
}
