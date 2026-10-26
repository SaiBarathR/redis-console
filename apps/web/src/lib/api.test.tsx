import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { friendlyMessage, post, query, READ_RETRY, request, RequestError, retriesOnRateLimit, retryAfterMs, retryDelayMs } from "./api.ts";
import { workbenchLineError } from "../pages/Console.tsx";
import { Login } from "../pages/Auth.tsx";

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("no Redis data in URLs", () => {
  it.each(["k", "key", "keys", "match", "pattern", "patterns", "channel", "channels", "group", "query", "q", "Key"])(
    "refuses to build a query string with %s",
    (name) => {
      expect(() => query({ [name]: "x" })).toThrow(/request body/);
    },
  );
  it("still builds harmless parameters", () => {
    expect(query({ seconds: 30, sub: "abc", before: undefined })).toBe("?seconds=30&sub=abc");
  });
});

describe("friendly limit errors", () => {
  it("adds the server hint for 413 too_large", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "too_large", message: "Reply would exceed 100000 elements", hint: "Use HSCAN key 0 COUNT 100" } }, 413)));
    const error = (await post("/databases/db/cli", { line: "HGETALL big" }).catch((e: unknown) => e)) as RequestError;
    expect(error).toBeInstanceOf(RequestError);
    expect(error.status).toBe(413);
    expect(error.message).toBe("Reply would exceed 100000 elements. Use HSCAN key 0 COUNT 100");
  });
  it("explains 429 and 504", () => {
    expect(friendlyMessage({ code: "rate_limited", message: "A workbench script is already running" })).toBe(
      "A workbench script is already running. Too many requests at once. Wait a moment, then try again.",
    );
    expect(friendlyMessage({ code: "timeout", message: "Command timed out" })).toMatch(/did not answer in time/);
  });
  it("never shows machine hints", () => {
    expect(friendlyMessage({ code: "forbidden", message: "You must change your password first.", hint: "password_change_required" })).toBe(
      "You must change your password first.",
    );
  });
  it("labels workbench lines that were not run", () => {
    expect(workbenchLineError({ code: "too_large", message: "Workbench output budget used up; this command was not run." }).message).toMatch(/^Not run: the script's reply budget/);
    expect(workbenchLineError({ code: "timeout", message: "Workbench time budget (30000 ms) used up; this command was not run." }).message).toMatch(/^Not run: the script's time budget/);
    expect(workbenchLineError({ code: "too_large", message: "Reply too large", hint: "Use SSCAN" }).message).toBe("Reply too large. Use SSCAN");
  });
});

describe("session ends cleanly", () => {
  it("broadcasts the server reason on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "unauthenticated", message: "Your account changed; sign in again." } }, 401)));
    const seen: unknown[] = [];
    const listener = (event: Event) => seen.push((event as CustomEvent).detail);
    window.addEventListener("session-expired", listener);
    await request("/databases").catch(() => undefined);
    window.removeEventListener("session-expired", listener);
    expect(seen).toEqual(["Your account changed; sign in again."]);
  });
  it("does not treat a failed sign-in as an ended session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "unauthenticated", message: "Invalid username or password" } }, 401)));
    const listener = vi.fn();
    window.addEventListener("session-expired", listener);
    await post("/auth/login", { username: "a", password: "b" }).catch(() => undefined);
    window.removeEventListener("session-expired", listener);
    expect(listener).not.toHaveBeenCalled();
  });
  it("tells the user why on the sign-in page", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ oidc: { enabled: false, displayName: "" }, local: { enabled: true } })));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Login notice="Your account changed; sign in again." onLogin={async () => undefined} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("session-ended")).toHaveTextContent("Your account changed. Sign in again to continue.");
  });
  it("explains a generic 401 in plain terms", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ oidc: { enabled: false, displayName: "" }, local: { enabled: true } })));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Login notice="Not signed in." onLogin={async () => undefined} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("session-ended")).toHaveTextContent(/session has ended.*account was changed by an administrator\. Sign in again/);
  });
});

// v0.3 follow-up 6: a read refused with 429 (for example the four-typed-reads-per-user limit, hit by the stream
// inspector's refresh after an acknowledge) is retried with backoff and jitter, never sooner than Retry-After. Writes
// are never retried.
describe("429 retries for reads only", () => {
  const limited = (retryAfter?: string) =>
    new Response(JSON.stringify({ error: { code: "rate_limited", message: "At most four data reads can run at once per user." } }), {
      status: 429,
      headers: { "Content-Type": "application/json", ...(retryAfter ? { "Retry-After": retryAfter } : {}) },
    });
  afterEach(() => { vi.useRealTimers(); });

  it("classifies reads: GETs and the read-only POST routes; never ops, cli, workbench or other writes", () => {
    for (const p of ["/databases/d/streams/pending", "/databases/d/streams/groups", "/databases/d/keys/names", "/databases/d/keys/meta", "/databases/d/key/read", "/databases/d/key/element", "/databases/d/timeseries/range", "/databases/d/search/query", "/databases/d/pubsub/channels"])
      expect(retriesOnRateLimit("POST", p)).toBe(true);
    expect(retriesOnRateLimit("GET", "/databases/d/overview")).toBe(true);
    for (const p of ["/databases/d/ops", "/databases/d/cli", "/databases/d/workbench", "/databases/d/bulk-delete", "/databases/d/pubsub/publish", "/databases/d/analysis/jobs", "/databases/d/import", "/auth/login", "/databases/d/streams/pending/x"])
      expect(retriesOnRateLimit("POST", p)).toBe(false);
    expect(retriesOnRateLimit("PATCH", "/admin/users/1")).toBe(false);
  });

  it("parses Retry-After as seconds or an HTTP date, and jitters on top of it", () => {
    expect(retryAfterMs("2")).toBe(2000);
    expect(retryAfterMs(null)).toBe(0);
    expect(retryAfterMs("soon")).toBe(0);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 7_000)).toBe(3000);
    expect(retryDelayMs(0, 1000, () => 0)).toBe(1000);
    expect(retryDelayMs(0, 1000, () => 0.999)).toBe(1000 + 249);
    expect(retryDelayMs(10, 0, () => 0.5)).toBe(READ_RETRY.capMs / 2);
  });

  it("retries a rate-limited read after Retry-After and returns its answer", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValueOnce(limited("1")).mockResolvedValueOnce(response({ pending: [], total: 0 }));
    vi.stubGlobal("fetch", fetcher);
    const result = request("/databases/d/streams/pending", { method: "POST", body: { key: "k" } });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(READ_RETRY.baseMs + 1);
    await expect(result).resolves.toEqual({ pending: [], total: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget and reports the 429", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(async () => limited());
    vi.stubGlobal("fetch", fetcher);
    const result = request("/databases/d/overview").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = (await result) as RequestError;
    expect(error).toBeInstanceOf(RequestError);
    expect(error.status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(READ_RETRY.retries + 1);
  });

  it("never retries a write, and does not wait out a Retry-After longer than the budget", async () => {
    const fetcher = vi.fn().mockImplementation(async () => limited("1"));
    vi.stubGlobal("fetch", fetcher);
    for (const path of ["/databases/d/ops", "/databases/d/cli", "/databases/d/workbench"]) {
      const error = (await request(path, { method: "POST", body: {} }).catch((e: unknown) => e)) as RequestError;
      expect(error.status).toBe(429);
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockClear().mockImplementation(async () => limited("120"));
    expect(((await request("/databases/d/overview").catch((e: unknown) => e)) as RequestError).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the request is aborted", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(async () => limited("2"));
    vi.stubGlobal("fetch", fetcher);
    const abort = new AbortController();
    const result = request("/databases/d/key/read", { method: "POST", body: {}, signal: abort.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(500);
    abort.abort();
    expect(((await result) as Error).name).toBe("AbortError");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
