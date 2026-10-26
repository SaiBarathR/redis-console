import { useEffect, useRef, useState } from "react";
import {
  KEY_META_MAX_KEYS,
  type Bin,
  type KeyMetaResponse,
  type RedisType,
} from "@rconsole/shared";
import { dbPath, request, RequestError } from "./api.ts";
import { useMemorySlot } from "./memory.tsx";

/** What the key list knows about one key. `readAt` anchors the TTL fuse; `asked` says which fields were requested. */
export interface MetaEntry {
  type: RedisType;
  ttl?: number;
  size?: number;
  readAt: number;
  asked: { ttl: boolean; size: boolean };
}
interface MetaStore {
  entries: Map<string, MetaEntry>;
  /** Entries read before this time are shown but read again when their row is on screen (refresh). */
  staleBefore: number;
}
export interface MetaFields {
  ttl: boolean;
  size: boolean;
}
export interface WantedKey {
  id: string;
  key: Bin;
}

/** Debounce for rows coming into view, and the longest a scrolling list waits for its batch. */
const DEBOUNCE_MS = 80;
const MAX_WAIT_MS = 300;
/** Key bytes per batch (besides KEY_META_MAX_KEYS), well under the route's body limit. */
const BATCH_BYTES = 512 * 1024;
/** A failed batch is not asked for again for this long. */
const RETRY_AFTER_MS = 3000;
/** Pause between batches of an explicit "load all" (sorting by size, "No TTL"), under the server's rate limit. */
const LOAD_ALL_GAP_MS = 110;
/** Requests without a user scroll this recent are background requests (they do not extend the session). */
const USER_ACTIVITY_MS = 3000;

/**
 * Lazy key metadata (type, TTL, size) for the key browser, cached per key in session memory for the database.
 *
 * The list reports the rows on screen through `want`; after a short debounce one batch (at most 500 keys) of the rows
 * still missing metadata goes to `keys/meta`, one request at a time. Edits patch entries (`set`, `drop`); a refresh
 * marks everything stale (`invalidate`) so rows on screen are read again while still showing their last values.
 */
export function useKeyMeta(databaseId: string, fields: MetaFields) {
  const [store] = useMemorySlot<MetaStore>(`${databaseId}:key-meta`, { entries: new Map(), staleBefore: 0 });
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const visible = useRef<WantedKey[]>([]);
  const inflight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const waitingSince = useRef(0);
  const failedUntil = useRef(new Map<string, number>());
  const touchedAt = useRef(0);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const again = useRef(false);
  const needs = (id: string, f: MetaFields = fieldsRef.current) => {
    const entry = store.entries.get(id);
    if (!entry || entry.readAt < store.staleBefore) return true;
    return (f.ttl && !entry.asked.ttl) || (f.size && !entry.asked.size);
  };

  /** One `keys/meta` request; stores the results. */
  const fetchBatch = async (batch: WantedKey[], background: boolean, f: MetaFields) => {
    const response = await request<KeyMetaResponse>(dbPath(databaseId, "/keys/meta"), {
      method: "POST",
      body: { keys: batch.map((item) => item.key), ...(f.ttl ? {} : { ttl: false }), ...(f.size ? {} : { size: false }) },
      background,
    });
    const readAt = Date.now();
    response.keys.forEach((item, i) => {
      const wanted = batch[i];
      if (!wanted) return;
      const entry: MetaEntry = { type: item.type, readAt, asked: { ttl: f.ttl, size: f.size } };
      if (item.ttl !== undefined) entry.ttl = item.ttl;
      if (item.size !== undefined) entry.size = item.size;
      store.entries.set(wanted.id, entry);
    });
  };

  const take = (from: Iterable<WantedKey>, f: MetaFields) => {
    const now = Date.now();
    const batch: WantedKey[] = [];
    let bytes = 0;
    for (const item of from) {
      if (!needs(item.id, f) || (failedUntil.current.get(item.id) ?? 0) > now) continue;
      const size = item.key.data.length;
      if (batch.length >= KEY_META_MAX_KEYS || (batch.length && bytes + size > BATCH_BYTES)) break;
      batch.push(item);
      bytes += size;
    }
    return batch;
  };

  const flush = async () => {
    timer.current = undefined;
    waitingSince.current = 0;
    if (inflight.current) {
      again.current = true;
      return;
    }
    again.current = false;
    const f = fieldsRef.current;
    const batch = take(visible.current, f);
    if (!batch.length) {
      setPending(false);
      return;
    }
    inflight.current = true;
    setPending(true);
    try {
      await fetchBatch(batch, Date.now() - touchedAt.current > USER_ACTIVITY_MS, f);
      setError(undefined);
    } catch (caught) {
      const until = Date.now() + RETRY_AFTER_MS;
      for (const item of batch) failedUntil.current.set(item.id, until);
      if (!(caught instanceof RequestError && caught.status === 429)) setError(caught);
      if (alive.current) timer.current = setTimeout(() => void flush(), RETRY_AFTER_MS + 50);
    } finally {
      inflight.current = false;
    }
    if (!alive.current) return;
    again.current = false;
    setVersion((v) => v + 1);
    // More rows may be waiting (a fast scroll, or more than one batch on screen).
    if (!timer.current) timer.current = setTimeout(() => void flush(), 0);
  };

  const schedule = () => {
    const now = Date.now();
    if (!waitingSince.current) waitingSince.current = now;
    clearTimeout(timer.current);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, waitingSince.current + MAX_WAIT_MS - now));
    timer.current = setTimeout(() => void flush(), wait);
  };

  /** The rows on screen (plus overscan), in display order. */
  const want = (rows: WantedKey[]) => {
    visible.current = rows;
    if (rows.some((row) => needs(row.id))) {
      setPending(true);
      schedule();
    }
  };

  /** Loads metadata of every key in `rows` (sorting by TTL/size/type, "No TTL"), batch by batch; `signal` stops it. */
  const loadAll = async (rows: WantedKey[], signal: AbortSignal, progress: (done: number, total: number) => void) => {
    const all = { ttl: true, size: true };
    const missing = rows.filter((row) => needs(row.id, all));
    let done = 0;
    progress(0, missing.length);
    try {
      while (done < missing.length && !signal.aborted) {
        while (inflight.current && !signal.aborted) await new Promise((r) => setTimeout(r, 50));
        if (signal.aborted) break;
        const batch = take(missing.slice(done, done + KEY_META_MAX_KEYS), all);
        if (batch.length) {
          inflight.current = true;
          try {
            await fetchBatch(batch, false, all);
          } catch (caught) {
            if (!(caught instanceof RequestError && caught.status === 429)) throw caught;
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          } finally {
            inflight.current = false;
          }
        }
        done = Math.min(missing.length, done + KEY_META_MAX_KEYS);
        progress(done, missing.length);
        if (alive.current) setVersion((v) => v + 1);
        await new Promise((r) => setTimeout(r, LOAD_ALL_GAP_MS));
      }
    } finally {
      if (alive.current && again.current) schedule();
    }
  };

  return {
    version,
    pending,
    error,
    get: (id: string) => store.entries.get(id),
    want,
    loadAll,
    /** A user scroll or keypress in the list: the next batches count as user activity. */
    touch: () => {
      touchedAt.current = Date.now();
    },
    /** What the browser learned itself (inspector read, created key, TTL change). */
    set: (id: string, entry: Omit<MetaEntry, "readAt" | "asked"> & { readAt?: number }) => {
      store.entries.set(id, {
        readAt: Date.now(),
        ...entry,
        asked: { ttl: entry.ttl !== undefined, size: entry.size !== undefined },
      });
      setVersion((v) => v + 1);
    },
    drop: (ids: Iterable<string>) => {
      for (const id of ids) store.entries.delete(id);
      setVersion((v) => v + 1);
      schedule();
    },
    /** Read every row on screen again (manual or automatic refresh); the old values stay until the new ones arrive. */
    invalidate: () => {
      store.staleBefore = Date.now();
      failedUntil.current.clear();
      setVersion((v) => v + 1);
      want(visible.current);
    },
    /** Drops cached entries of keys no longer listed, once the cache is much larger than the list. */
    prune: (listed: (id: string) => boolean, keys: number) => {
      if (store.entries.size <= Math.max(20_000, keys * 2)) return;
      for (const id of store.entries.keys()) if (!listed(id)) store.entries.delete(id);
    },
    /** Entries whose TTL, size and type are all known (for sorting and filters). */
    complete: (id: string) => {
      const entry = store.entries.get(id);
      return !!entry && entry.asked.ttl && entry.asked.size;
    },
  };
}
