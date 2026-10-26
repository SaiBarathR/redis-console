import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { binFromString, type Bin } from "@rconsole/shared";
import { useKeyMeta, type MetaFields } from "./keymeta.ts";
import { keyId } from "./keytree.ts";
import { MemoryProvider } from "./memory.tsx";

afterEach(() => vi.unstubAllGlobals());
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/** A fake keys/meta endpoint: every key is a hash with TTL 60 and size 100 (when asked). */
function server(o: { fail?: boolean; delay?: number } = {}) {
  const bodies: { keys: Bin[]; ttl?: boolean; size?: boolean }[] = [];
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (o.delay) await new Promise((r) => setTimeout(r, o.delay));
    if (o.fail) return json({ error: { code: "redis_error", message: "boom" } }, 502);
    return json({
      keys: body.keys.map((key: Bin) => ({
        key,
        type: "hash",
        ...(body.ttl === false ? {} : { ttl: 60 }),
        ...(body.size === false ? {} : { size: 100 }),
      })),
    });
  });
  vi.stubGlobal("fetch", fetch);
  return { bodies, fetch };
}
let meta: ReturnType<typeof useKeyMeta>;
function Probe({ fields }: { fields: MetaFields }) {
  meta = useKeyMeta("db-m", fields);
  return null;
}
const mount = (fields: MetaFields = { ttl: true, size: true }) =>
  render(
    <MemoryProvider>
      <Probe fields={fields} />
    </MemoryProvider>,
  );
const rows = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => {
    const key = binFromString(`k:${from + i}`);
    return { id: keyId(key), key };
  });

describe("lazy key metadata (v0.2.1)", () => {
  it("loads only the rows on screen, in one debounced batch, and caches them", async () => {
    const { bodies } = server();
    mount();
    act(() => meta.want(rows(0, 30)));
    act(() => meta.want(rows(5, 40)));
    await waitFor(() => expect(meta.get(keyId(binFromString("k:39")))).toBeDefined());
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.keys).toHaveLength(35);
    expect(bodies[0]).not.toHaveProperty("ttl");
    expect(meta.get(keyId(binFromString("k:5")))).toMatchObject({ type: "hash", ttl: 60, size: 100 });
    // The batch was for the rows on screen when it was sent (5–39); showing them again loads nothing.
    act(() => meta.want(rows(10, 40)));
    await new Promise((r) => setTimeout(r, 150));
    expect(bodies).toHaveLength(1);
    expect(meta.pending).toBe(false);
    // Scrolling up to rows that were skipped while scrolling loads just those.
    act(() => meta.want(rows(0, 20)));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]!.keys).toHaveLength(5);
  });
  it("asks at most 500 keys per request and one request at a time", async () => {
    const { bodies } = server({ delay: 30 });
    mount();
    act(() => meta.want(rows(0, 1200)));
    await waitFor(() => expect(meta.get(keyId(binFromString("k:1199")))).toBeDefined(), { timeout: 3000 });
    expect(bodies.map((b) => b.keys.length)).toEqual([500, 500, 200]);
  });
  it("skips PTTL and MEMORY USAGE for hidden columns", async () => {
    const { bodies } = server();
    mount({ ttl: false, size: false });
    act(() => meta.want(rows(0, 3)));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ ttl: false, size: false });
    await waitFor(() => expect(meta.get(keyId(binFromString("k:0")))).toEqual(expect.objectContaining({ type: "hash", asked: { ttl: false, size: false } })));
  });
  it("refresh reads the rows on screen again but keeps their values meanwhile; edits patch the cache", async () => {
    const { bodies } = server();
    mount();
    act(() => meta.want(rows(0, 3)));
    await waitFor(() => expect(bodies).toHaveLength(1));
    await waitFor(() => expect(meta.pending).toBe(false));
    act(() => meta.invalidate());
    expect(meta.get(keyId(binFromString("k:0")))).toBeDefined();
    await waitFor(() => expect(bodies).toHaveLength(2));
    const id = keyId(binFromString("k:1"));
    act(() => meta.set(id, { type: "string", ttl: 5 }));
    expect(meta.get(id)).toMatchObject({ type: "string", ttl: 5 });
    act(() => meta.drop([id]));
    expect(meta.get(id)).toBeUndefined();
  });
  it("a failed batch is reported and not asked again at once", async () => {
    const { bodies } = server({ fail: true });
    mount();
    act(() => meta.want(rows(0, 3)));
    await waitFor(() => expect(meta.error).toBeDefined());
    act(() => meta.want(rows(0, 3)));
    await new Promise((r) => setTimeout(r, 200));
    expect(bodies).toHaveLength(1);
  });
  it("loadAll fetches TTL and size of every key for sorting, with progress, and stops on abort", async () => {
    const { bodies } = server();
    mount({ ttl: false, size: false });
    const progress: number[] = [];
    const abort = new AbortController();
    await act(() => meta.loadAll(rows(0, 1100), abort.signal, (done) => progress.push(done)));
    expect(bodies.map((b) => [b.keys.length, b.ttl, b.size])).toEqual([[500, undefined, undefined], [500, undefined, undefined], [100, undefined, undefined]]);
    expect(progress).toEqual([0, 500, 1000, 1100]);
    const stopped = new AbortController();
    stopped.abort();
    await act(() => meta.loadAll(rows(2000, 3000), stopped.signal, () => {}));
    expect(bodies).toHaveLength(3);
  });
});
