/**
 * v0.3 follow-up 6: on a slow machine the stream inspector's refresh after an acknowledge hit the server's
 * four-typed-reads-per-user limit (429). The screen showed the error and did not recover. Reads are now retried after
 * Retry-After with jittered backoff, so the refresh completes; the acknowledge (a write) is sent exactly once.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binFromString, type DatabaseSummary } from "@rconsole/shared";
import { DatabaseContext } from "../lib/context.tsx";
import { MemoryProvider } from "../lib/memory.tsx";
import { StreamInspector } from "./StreamInspector.tsx";

const db: DatabaseSummary = { id: "db", name: "DB", environment: "test", readOnly: false, effectiveRole: "operator", features: { profiler: false }, status: "connected" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("stream inspector refresh after an acknowledge (v0.3 follow-up 6)", () => {
  it("recovers from a 429 on the refresh: the pending list updates and no error stays on screen", async () => {
    let acked = false;
    let limitedOnce = false;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      const path = String(url).replace(/^\/api\/v1\/databases\/db/, "");
      calls.push(path);
      if (path === "/streams/groups") return json({ groups: [{ name: "g", nameBin: binFromString("g"), consumers: [{ name: "c", pending: acked ? 0 : 1, idleMs: 5 }], pending: acked ? 0 : 1, lastDeliveredId: "1-0" }] });
      if (path === "/streams/pending") {
        if (acked && !limitedOnce) {
          limitedOnce = true;
          return json({ error: { code: "rate_limited", message: "At most four data reads can run at once per user." } }, 429, { "Retry-After": "1" });
        }
        return json(acked ? { total: 0, pending: [] } : { total: 1, pending: [{ id: "1-0", consumer: "c", idleMs: 5, deliveries: 1 }] });
      }
      if (path === "/ops") {
        expect(JSON.parse(String(init.body))).toMatchObject({ op: "stream.ack", ids: ["1-0"] });
        acked = true;
        return json({ ok: true, result: { t: "int", v: "1" } });
      }
      return json({});
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><MemoryProvider><DatabaseContext value={db}>
          <StreamInspector keyName={binFromString("orders")} refresh={async () => {}} />
        </DatabaseContext></MemoryProvider></MemoryRouter>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByText("Consumer groups, consumers and pending messages"));
    await userEvent.click(await screen.findByLabelText("Select pending 1-0"));
    await userEvent.click(screen.getByText("Acknowledge selected (confirm)"));
    await waitFor(() => expect(screen.getByText(/0 matching pending messages on this page/)).toBeInTheDocument(), { timeout: 4000 });
    expect(limitedOnce).toBe(true);
    expect(screen.queryByText(/At most four data reads/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls.filter((p) => p === "/ops")).toHaveLength(1);
  });
});
