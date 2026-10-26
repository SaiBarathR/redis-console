import type { Bin, SearchOn } from "@rconsole/shared";

/**
 * Session-memory slots of the Search tool (MemoryProvider: this tab's memory only; never device storage or URLs).
 * Index names, prefixes and queries are Redis data, so they travel between views here, not in the address bar.
 */
export const searchSlots = (db: string) => ({
  /** What "Make searchable" hands to the index wizard. */
  handoff: `${db}:search:handoff`,
  /** The query form (index, query text, options) so it survives navigation. */
  form: `${db}:search:form`,
  saved: `${db}:search:saved`,
  recent: `${db}:search:recent`,
  /** The index whose details are open. */
  selected: `${db}:search:selected`,
});

export interface WizardHandoff {
  on: SearchOn;
  /** The prefix to start with, and the other folder levels of the key it came from. */
  prefix: string;
  prefixes: string[];
  key?: Bin;
}

export type QueryMode = "search" | "aggregate";

export interface QueryForm {
  index: string;
  query: string;
  mode: QueryMode;
  /** FT.AGGREGATE pipeline arguments (redis-cli syntax), e.g. GROUPBY 1 @category REDUCE COUNT 0 AS n. */
  pipeline: string;
  sortBy: string;
  sortOrder: "ASC" | "DESC";
  returnFields: string[];
  limit: number;
  dialect: number | undefined;
}

export const EMPTY_FORM: QueryForm = {
  index: "",
  query: "*",
  mode: "search",
  pipeline: "",
  sortBy: "",
  sortOrder: "ASC",
  returnFields: [],
  limit: 20,
  dialect: undefined,
};

export interface SavedQuery {
  name: string;
  form: QueryForm;
  savedAt: number;
}

/** Saved queries and recent history are bounded (memory only). */
export const MAX_SAVED = 20;
export const MAX_RECENT = 15;

/** Folder prefixes of a key name, shortest first: a:b:c -> ["a:", "a:b:"]. */
export function folderPrefixes(name: string, delimiter: string): string[] {
  if (!delimiter) return [];
  const out: string[] = [];
  let at = name.indexOf(delimiter);
  while (at > 0) {
    out.push(name.slice(0, at + delimiter.length));
    at = name.indexOf(delimiter, at + delimiter.length);
  }
  return out;
}

/** A default index name for a prefix: idx:<prefix without its trailing delimiter>, restricted to the allowed set. */
export function defaultIndexName(prefix: string): string {
  const base = prefix.replace(/[^A-Za-z0-9_.:-]+/g, "_").replace(/[:_.-]+$/, "").replace(/^[^A-Za-z0-9]+/, "");
  return `idx:${base || "keys"}`.slice(0, 128);
}
