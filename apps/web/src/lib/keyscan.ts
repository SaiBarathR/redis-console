import { useEffect, useRef, useState } from "react";
import {
  KEY_NAMES_MAX_COUNT,
  type Bin,
  type KeyNamesResponse,
} from "@rconsole/shared";
import { dbPath, request, RequestError, writeCount } from "./api.ts";
import { canonicalKey, keyId } from "./keytree.ts";
import { useMemorySlot } from "./memory.tsx";

export interface ScanFilter {
  match: string;
  type: string;
}
/**
 * The key browser's inventory of one database (v0.2.1): key names only, kept in session memory (never storage).
 * Metadata for the rows on screen lives in `useKeyMeta`.
 */
export interface ScanState {
  filter: ScanFilter;
  /** Key names in scan order, no duplicates (canonical encoding). */
  keys: Bin[];
  cursor: string;
  /** The cursor returned to 0: every key matching the filter is listed (as of the scan). */
  done: boolean;
  /** Keyspace slots examined for this filter (all requests). */
  scanned: number;
  dbSize: number;
  /** The scan threshold the server applied to the last request ("Keys to scan", possibly clamped). */
  threshold: number;
  /** Results of the first page, which decides whether the tree starts collapsed. */
  firstPage: number;
  /** When the list was last read from Redis (a scan or a refresh finished). */
  loadedAt: number;
  /** This tab's write count on the database that the list accounts for (see `outdated`). */
  writes: number;
  /** A change the browser could not apply to the list (for example a key outside the filter). */
  changed?: boolean;
  /** The pattern had no glob characters: the server looked the key up directly. */
  exact?: boolean;
}
export type ScanBusy = "first" | "more" | "all" | "refresh" | null;

/** Keys held in memory at most; "Scan to end" stops here. */
export const SCAN_CAP = 200_000;
/** "Keys to scan" bounds in the browser (the server clamps to its own `keyScanThresholdMax`). */
export const SCAN_COUNT_MIN = 500;
export const SCAN_COUNT_MAX = 100_000;
export const SCAN_COUNT_DEFAULT = 10_000;
/** The choices offered for "Keys to scan". */
export const SCAN_COUNT_CHOICES = [500, 1_000, 5_000, 10_000, 20_000, 50_000, 100_000];
const PREF = "rconsole.keyScanCount";
/** A 429 (rate limit or the server's two-scans-per-user limit) waits this long, at most this many times. */
const RETRY_MS = 1000;
const RETRIES = 5;

/** "Keys to scan": a preference in localStorage (a number, never key data). */
export function readScanCount(): number {
  try {
    const n = Number(localStorage.getItem(PREF));
    return Number.isSafeInteger(n) && n >= SCAN_COUNT_MIN && n <= SCAN_COUNT_MAX ? n : SCAN_COUNT_DEFAULT;
  } catch {
    return SCAN_COUNT_DEFAULT;
  }
}
export function useScanCount() {
  const [count, setCount] = useState(readScanCount);
  const set = (value: number) => {
    const n = Math.round(Math.min(SCAN_COUNT_MAX, Math.max(SCAN_COUNT_MIN, value)));
    setCount(n);
    try {
      if (n === SCAN_COUNT_DEFAULT) localStorage.removeItem(PREF);
      else localStorage.setItem(PREF, String(n));
    } catch {
      // Storage unavailable: the setting lasts for this page only.
    }
  };
  return [count, set] as const;
}

function merge(state: ScanState, page: KeyNamesResponse, ids: Set<string>): ScanState {
  let keys = state.keys;
  for (const raw of page.keys) {
    const key = canonicalKey(raw);
    const id = keyId(key);
    if (ids.has(id)) continue;
    if (keys === state.keys) keys = keys.slice();
    ids.add(id);
    keys.push(key);
  }
  return {
    ...state,
    keys,
    cursor: page.cursor,
    done: page.cursor === "0",
    scanned: state.scanned + page.scanned,
    dbSize: page.dbSize,
    threshold: page.threshold,
    ...(page.exact ? { exact: true } : {}),
  };
}

const aborted = (caught: unknown) => caught instanceof DOMException && caught.name === "AbortError";
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

/**
 * Names-only SCAN state for the key browser, per database, in session memory. Opening the browser scans up to
 * "Keys to scan" slots (the server loops SCAN COUNT 2000 within its time budget; this hook continues with the cursor
 * until the threshold is covered), then builds the whole tree from the names. "Scan more" covers another threshold;
 * "Scan to end" drains the cursor with progress and Stop. The browser patches its own changes and rescans only when
 * asked or on the opt-in auto-refresh; it never re-runs on every write.
 */
export function useKeyScan(databaseId: string, threshold: number) {
  const [state, setState] = useMemorySlot<ScanState | undefined>(`${databaseId}:key-scan`, undefined);
  const [busy, setBusy] = useState<ScanBusy>(null);
  const [error, setError] = useState<unknown>();
  const controller = useRef<AbortController | undefined>(undefined);
  /** Each run owns a generation; stale runs never touch state. */
  const generation = useRef(0);
  const latest = useRef(state);
  latest.current = state;

  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    // Writes made by the key browser itself are patched into the list; only writes elsewhere make it outdated.
    const own = (event: Event) => {
      const current = latest.current;
      if (!(event instanceof CustomEvent) || event.detail !== databaseId || !current || current.writes !== writeCount(databaseId) - 1) return;
      const next = { ...current, writes: writeCount(databaseId) };
      latest.current = next;
      setState(next);
    };
    window.addEventListener("rconsole:database-updated", own);
    return () => window.removeEventListener("rconsole:database-updated", own);
  }, [databaseId]);

  const page = async (filter: ScanFilter, cursor: string, scanThreshold: number, count: number, signal: AbortSignal, background: boolean) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await request<KeyNamesResponse>(dbPath(databaseId, "/keys/names"), {
          method: "POST",
          body: { cursor, match: filter.match, ...(filter.type ? { type: filter.type } : {}), count, scanThreshold },
          signal,
          background,
        });
      } catch (caught) {
        if (!(caught instanceof RequestError && caught.status === 429) || attempt >= RETRIES) throw caught;
        await sleep(RETRY_MS, signal);
      }
    }
  };

  /**
   * Scans from `from` until `cover` more slots were examined (or the cursor returned to 0, the cap was reached or the
   * run was stopped). `commit` publishes progress after each request; a refresh publishes only the finished list.
   */
  const run = async (
    kind: Exclude<ScanBusy, null>,
    from: ScanState,
    cover: number,
    o: { commit: boolean; background?: boolean },
  ): Promise<void> => {
    const own = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(kind);
    setError(undefined);
    let current = from;
    const set = new Set(from.keys.map(keyId));
    let covered = 0;
    try {
      do {
        const left = Math.max(100, Math.min(cover - covered, 10_000_000));
        const count = Math.max(1, Math.min(KEY_NAMES_MAX_COUNT, SCAN_CAP - current.keys.length));
        const result = await page(current.filter, current.cursor, left, count, abort.signal, !!o.background);
        if (own !== generation.current) return;
        const first = current.loadedAt === 0;
        current = merge(current, result, set);
        if (first) current = { ...current, firstPage: current.keys.length };
        covered += result.scanned;
        if (o.commit) {
          current = { ...current, loadedAt: Date.now() };
          latest.current = current;
          setState(current);
        }
      } while (!current.done && covered < cover && current.keys.length < SCAN_CAP);
      current = { ...current, loadedAt: Date.now() };
      latest.current = current;
      setState(current);
    } catch (caught) {
      if (aborted(caught) || own !== generation.current) return;
      setError(caught);
      if (!latest.current || kind === "first") {
        const failed = { ...current, loadedAt: current.loadedAt || Date.now() };
        latest.current = failed;
        setState(failed);
      }
    } finally {
      if (own === generation.current) setBusy(null);
    }
  };

  const fresh = (filter: ScanFilter): ScanState => ({
    filter,
    keys: [],
    cursor: "0",
    done: false,
    scanned: 0,
    dbSize: latest.current?.dbSize ?? 0,
    threshold,
    firstPage: 0,
    loadedAt: 0,
    writes: writeCount(databaseId),
  });

  /** A new scan of `filter` from the start, up to "Keys to scan". */
  const start = (filter: ScanFilter) => {
    const initial = fresh(filter);
    latest.current = initial;
    setState(initial);
    return run("first", initial, threshold, { commit: true });
  };
  /** "Scan more": another "Keys to scan" from the cursor. */
  const more = () => {
    const current = latest.current;
    if (!current || current.done) return Promise.resolve();
    return run("more", current, threshold, { commit: true });
  };
  /** "Scan to end": drain the cursor (up to the cap), with progress; `halt` stops it. */
  const all = () => {
    const current = latest.current;
    if (!current || current.done) return Promise.resolve();
    return run("all", current, Infinity, { commit: true });
  };
  /**
   * Re-reads the inventory from cursor 0, covering as much of the keyspace as the list did (to the end when it was
   * complete), and replaces the list when done, so the tree does not flicker. Auto-refresh passes `background`.
   */
  const refresh = (o: { background?: boolean } = {}) => {
    const current = latest.current;
    if (!current) return Promise.resolve();
    const base = { ...fresh(current.filter), firstPage: current.firstPage, loadedAt: current.loadedAt || 1 };
    return run("refresh", base, current.done ? Infinity : Math.max(threshold, current.scanned), { commit: false, background: !!o.background });
  };
  const halt = () => {
    generation.current++;
    controller.current?.abort();
    setBusy(null);
  };

  /**
   * Applies the browser's own change to the loaded list without rescanning; `delta` is the change in the database's
   * key count (+1 for a created key, -n for deleted ones).
   */
  const patch = (update: (keys: Bin[]) => Bin[], delta = 0) => {
    const current = latest.current;
    if (!current) return;
    const keys = update(current.keys);
    if (keys === current.keys && !delta) return;
    const next = { ...current, keys, dbSize: Math.max(0, current.dbSize + delta) };
    latest.current = next;
    setState(next);
  };
  /** A change the list cannot show correctly without a rescan. */
  const markChanged = () => {
    const current = latest.current;
    if (!current || current.changed) return;
    const next = { ...current, changed: true };
    latest.current = next;
    setState(next);
  };
  const outdated = !!state && (!!state.changed || state.writes !== writeCount(databaseId));

  return { state, busy, error, start, more, all, refresh, halt, patch, markChanged, outdated };
}
