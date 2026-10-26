import { useSyncExternalStore } from "react";

/**
 * Presentation preferences (F26). Stored in localStorage under one key, as a small object of enumerated values only:
 * never Redis data (no key names, channel names, commands or values) and never deployment policy (limits, roles and
 * timeouts stay server configuration). Anything that does not validate falls back to the default.
 */
export interface Preferences {
  /** How timestamps are shown: the browser's time zone or UTC (incident timelines). */
  timeZone: "local" | "utc";
  /** Clock: 24-hour or 12-hour. */
  hourCycle: "h23" | "h12";
  /** Dates: the browser's locale style, or ISO 8601 (2026-10-24 14:03:09). */
  dateStyle: "locale" | "iso";
  /** Formatter a string value opens with when it is not a whole JSON document: text, hex for binary values only, or hex. */
  valueFormat: "text" | "binary-hex" | "hex";
  /** Default auto-refresh for the slow log and the Pub/Sub channel list (seconds; 0 = manual). */
  toolRefreshSeconds: 0 | 5 | 15 | 30 | 60;
  /** Editor font size in the Console, Workbench and drawer (px). */
  editorFontSize: 12 | 13 | 14 | 16;
  /** Workbench: clear the script after it ran without errors. */
  clearWorkbenchAfterRun: boolean;
  /** The bottom tools drawer: open state, tab and height. */
  drawerOpen: boolean;
  drawerTab: "console" | "helper" | "profiler";
  drawerHeight: number;
  /** Console beside the Command helper or Profiler instead of one tool at a time (review v0.2.1 web L5). */
  drawerSplit: boolean;
  /** Landing sort (column and direction). */
  landingSort:
    | "default"
    | "name"
    | "keys"
    | "memory"
    | "ops"
    | "clients"
    | "hitRate"
    | "uptime";
  landingDescending: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  timeZone: "local",
  hourCycle: "h23",
  dateStyle: "locale",
  valueFormat: "text",
  toolRefreshSeconds: 0,
  editorFontSize: 13,
  clearWorkbenchAfterRun: false,
  drawerOpen: false,
  drawerTab: "console",
  drawerHeight: 320,
  drawerSplit: false,
  landingSort: "default",
  landingDescending: false,
};

export const DRAWER_MIN = 160;
export const DRAWER_MAX_SHARE = 0.75;

const CHOICES: { [K in keyof Preferences]: readonly Preferences[K][] | "boolean" | [number, number] } = {
  timeZone: ["local", "utc"],
  hourCycle: ["h23", "h12"],
  dateStyle: ["locale", "iso"],
  valueFormat: ["text", "binary-hex", "hex"],
  toolRefreshSeconds: [0, 5, 15, 30, 60],
  editorFontSize: [12, 13, 14, 16],
  clearWorkbenchAfterRun: "boolean",
  drawerOpen: "boolean",
  drawerTab: ["console", "helper", "profiler"],
  drawerHeight: [DRAWER_MIN, 2000],
  drawerSplit: "boolean",
  landingSort: ["default", "name", "keys", "memory", "ops", "clients", "hitRate", "uptime"],
  landingDescending: "boolean",
};

const KEY = "rconsole.preferences";

/** Keeps only known fields with allowed values; everything else becomes the default. */
export function sanitizePreferences(input: unknown): Preferences {
  const out: Record<string, unknown> = { ...DEFAULT_PREFERENCES };
  if (!input || typeof input !== "object" || Array.isArray(input)) return out as unknown as Preferences;
  const record = input as Record<string, unknown>;
  for (const [name, rule] of Object.entries(CHOICES)) {
    if (!Object.hasOwn(record, name)) continue;
    const value = record[name];
    if (rule === "boolean") {
      if (typeof value === "boolean") out[name] = value;
    } else if (rule.length === 2 && typeof rule[0] === "number" && typeof rule[1] === "number" && name === "drawerHeight") {
      if (typeof value === "number" && Number.isFinite(value))
        out[name] = Math.round(Math.min(rule[1], Math.max(rule[0], value)));
    } else if ((rule as readonly unknown[]).includes(value)) out[name] = value;
  }
  return out as unknown as Preferences;
}

function read(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    return sanitizePreferences(raw ? JSON.parse(raw) : undefined);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

let current: Preferences | undefined;
const listeners = new Set<() => void>();
const snapshot = () => (current ??= read());

export function getPreferences() {
  return snapshot();
}

export function setPreferences(change: Partial<Preferences> | ((previous: Preferences) => Partial<Preferences>)) {
  const previous = snapshot();
  const next = sanitizePreferences({ ...previous, ...(typeof change === "function" ? change(previous) : change) });
  if (Object.entries(next).every(([name, value]) => previous[name as keyof Preferences] === value)) return;
  current = next;
  try {
    // Only values that differ from the defaults are stored, so an untouched browser stores nothing.
    const diff = Object.fromEntries(
      Object.entries(next).filter(([name, value]) => DEFAULT_PREFERENCES[name as keyof Preferences] !== value),
    );
    if (Object.keys(diff).length) localStorage.setItem(KEY, JSON.stringify(diff));
    else localStorage.removeItem(KEY);
  } catch {
    /* Preferences are optional. */
  }
  listeners.forEach((listener) => listener());
}

export function resetPreferences() {
  current = { ...DEFAULT_PREFERENCES };
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* Preferences are optional. */
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab changed the preferences.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return;
    current = read();
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function usePreferences() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test hook: forget the cached copy so the next read comes from storage again. */
export function reloadPreferences() {
  current = undefined;
}

// ---------------------------------------------------------------------------
// Time display

type TimeOptions = Pick<Preferences, "timeZone" | "hourCycle" | "dateStyle">;
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function parts(ms: number, utc: boolean) {
  const d = new Date(ms);
  return utc
    ? { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() }
    : { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function intl(key: string, options: Intl.DateTimeFormatOptions) {
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    formatters.set(key, formatter);
  }
  return formatter;
}

/** Wall-clock time of day (14:03:09), following the time preferences. UTC adds a "Z" marker. */
export function formatTime(ms: number, o: TimeOptions = getPreferences()) {
  if (!Number.isFinite(ms)) return "—";
  const utc = o.timeZone === "utc";
  if (o.dateStyle === "iso" && o.hourCycle === "h23") {
    const p = parts(ms, utc);
    return `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${utc ? "Z" : ""}`;
  }
  const text = intl(`t:${o.timeZone}:${o.hourCycle}`, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: o.hourCycle,
    ...(utc ? { timeZone: "UTC" } : {}),
  }).format(new Date(ms));
  return utc ? `${text} UTC` : text;
}

/** Date and time (Oct 24, 14:03:09 or 2026-10-24 14:03:09). */
export function formatDateTime(ms: number, o: TimeOptions = getPreferences()) {
  if (!Number.isFinite(ms)) return "—";
  const utc = o.timeZone === "utc";
  if (o.dateStyle === "iso") {
    const p = parts(ms, utc);
    const time =
      o.hourCycle === "h23"
        ? `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`
        : `${pad(((p.h + 11) % 12) + 1)}:${pad(p.mi)}:${pad(p.s)} ${p.h < 12 ? "AM" : "PM"}`;
    return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${time}${utc ? "Z" : ""}`;
  }
  const text = intl(`dt:${o.timeZone}:${o.hourCycle}`, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: o.hourCycle,
    ...(utc ? { timeZone: "UTC" } : {}),
  }).format(new Date(ms));
  return utc ? `${text} UTC` : text;
}

/** "just now", "12 s ago", "3 min ago" — for freshness labels. */
export function ageLabel(ms: number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 3) return "just now";
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

/** The format a value opens with when it is not a JSON document (F26). */
export function defaultValueFormat(encoding: "utf8" | "base64", preference: Preferences["valueFormat"]) {
  return preference === "hex" || (preference === "binary-hex" && encoding === "base64") ? "hex" : "text";
}
