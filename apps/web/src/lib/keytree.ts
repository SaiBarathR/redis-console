import { binFromBytes, bytesFromBin, type Bin } from "@rconsole/shared";
import { visibleText } from "./format.ts";

/**
 * The key browser's namespace tree (v0.2.1).
 *
 * `buildKeyIndex` turns the scanned key names into a trie once per name list and delimiter: O(total name length),
 * every folder knows how many keys are below it. `flattenTree` then lists only what is visible (open folders), sorting
 * each folder's children once and caching the order on the folder. Nothing walks the whole list per render, so 100k
 * keys stay responsive. Folder byte sums come from `folderStats`, one pass over the keys with metadata.
 */

/** One loaded key: canonical id (see `keyId`), the name as sent by the server, and its UTF-8 text when it has one. */
export interface KeyEntry {
  id: string;
  key: Bin;
  /** The name as text (UTF-8 keys only). */
  text: string | undefined;
  /** The folder the key is listed in (the root for binary keys or names without the delimiter). */
  folder: FolderNode;
  /** Natural sort key, computed on first use. */
  sort?: string;
}
export interface FolderNode {
  /** Folder path including the trailing delimiter, e.g. `session:9f2a:`; "" for the root. */
  id: string;
  /** The segment, as typed (shown escaped through `visibleText`). */
  segment: string;
  depth: number;
  parent: FolderNode | undefined;
  /** Keys below this folder, all levels. */
  count: number;
  folders: Map<string, FolderNode>;
  keys: KeyEntry[];
  /** Child order caches, filled when the folder is first listed. */
  sortedFolders?: FolderNode[];
  sortedKeys?: { asc: KeyEntry[]; desc?: KeyEntry[] };
}
export interface KeyIndex {
  root: FolderNode;
  /** Every folder by id. */
  folders: Map<string, FolderNode>;
  entries: KeyEntry[];
  byId: Map<string, KeyEntry>;
  delimiter: string;
}

export interface FolderRow {
  kind: "folder";
  /** Folder path including the trailing delimiter, e.g. `session:9f2a:`. */
  id: string;
  label: string;
  depth: number;
  /** Loaded keys below this folder (all levels). */
  count: number;
  node: FolderNode;
  open: boolean;
  /** Parent folder id, or "" at the root. */
  parent: string;
  /** 1-based position among siblings and the sibling count (aria-posinset / aria-setsize). */
  pos: number;
  size: number;
}
export interface KeyRow {
  kind: "key";
  id: string;
  entry: KeyEntry;
  key: Bin;
  depth: number;
  /** Folder path shown by the tree, hidden in the row label but kept in its accessible text. */
  prefix: string;
  parent: string;
  pos: number;
  size: number;
}
export type TreeRow = FolderRow | KeyRow;

/** Folders nest at most this deep; longer names list their rest as the key label. */
export const MAX_DEPTH = 8;
/** Natural order for namespace segments: user:2 sorts before user:10. */
export const keyCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "variant",
});

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/**
 * Canonical id of a key name in the browser: the same bytes always give the same id, whichever encoding the `Bin`
 * uses (a key typed as base64 that is valid UTF-8 equals the server's UTF-8 form). Cheap for UTF-8 names.
 */
export function keyId(key: Bin): string {
  if (key.enc === "utf8") return `u${key.data}`;
  const bytes = bytesFromBin(key);
  try {
    return `u${decoder.decode(bytes)}`;
  } catch {
    return `b${key.data}`;
  }
}
/** The server's canonical `Bin` for a key (UTF-8 when the bytes are valid UTF-8). */
export const canonicalKey = (key: Bin): Bin =>
  key.enc === "utf8" ? key : binFromBytes(bytesFromBin(key));

/**
 * A sort key that orders with plain string comparison like a natural, case-insensitive collation: digit runs
 * compare by value (`2` < `10`), letters ignore case. Much cheaper than `Intl.Collator` for large folders.
 */
export function naturalKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, (run) => {
      const digits = run.replace(/^0+(?=\d)/, "");
      // \u0001 sorts digit runs before letters and after the end of a shorter name (\u0000 ends the sort key).
      return `\u0001${String.fromCharCode(0x21 + Math.min(digits.length, 0xffdd))}${digits}`;
    });
}
const sortKey = (entry: KeyEntry) =>
  (entry.sort ??= entry.text !== undefined ? `${naturalKey(entry.text)}\u0000${entry.text}` : `￿${entry.key.data}`);
/** Natural name order of two keys (what the tree uses by default; ties of metadata sorts fall back to it). */
export const compareEntries = (a: KeyEntry, b: KeyEntry) => {
  const x = sortKey(a), y = sortKey(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

function folder(id: string, segment: string, depth: number, parent: FolderNode | undefined): FolderNode {
  return { id, segment, depth, parent, count: 0, folders: new Map(), keys: [] };
}

/** The namespace trie of `keys`, grouped by `delimiter` ("" = a flat list). O(total name length). */
export function buildKeyIndex(keys: readonly Bin[], delimiter: string): KeyIndex {
  const root = folder("", "", -1, undefined);
  const folders = new Map<string, FolderNode>();
  const entries: KeyEntry[] = new Array(keys.length);
  const byId = new Map<string, KeyEntry>();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const text = key.enc === "utf8" ? key.data : undefined;
    let node = root;
    root.count++;
    if (delimiter && text !== undefined) {
      let start = 0;
      for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const end = text.indexOf(delimiter, start);
        if (end < 0) break;
        const segment = text.slice(start, end);
        let next = node.folders.get(segment);
        if (!next) {
          next = folder(`${node.id}${segment}${delimiter}`, segment, depth, node);
          node.folders.set(segment, next);
          folders.set(next.id, next);
        }
        next.count++;
        node = next;
        start = end + delimiter.length;
      }
    }
    const entry: KeyEntry = { id: keyId(key), key, text, folder: node };
    node.keys.push(entry);
    entries[i] = entry;
    byId.set(entry.id, entry);
  }
  return { root, folders, entries, byId, delimiter };
}

/** How keys are ordered inside a folder. Folders sort by name (descending with `desc`) unless `compareFolders` is set. */
export interface TreeOrder {
  desc?: boolean;
  /** Orders keys by metadata (TTL, size, type); `undefined` = by name. Must be total (ties by name). */
  compare?: (a: KeyEntry, b: KeyEntry) => number;
  /** Orders sibling folders (e.g. by their byte sums when sorting by size); `desc` reverses it too. */
  compareFolders?: (a: FolderNode, b: FolderNode) => number;
  /** Lists only the keys that pass (e.g. "no TTL"); folders keep their counts of loaded keys. */
  filter?: (entry: KeyEntry) => boolean;
}

function sortedFolders(node: FolderNode): FolderNode[] {
  return (node.sortedFolders ??= [...node.folders.values()].sort((a, b) => keyCollator.compare(a.segment, b.segment)));
}
function sortedKeys(node: FolderNode, order: TreeOrder): KeyEntry[] {
  let keys: KeyEntry[];
  if (order.compare) {
    const compare = order.compare;
    keys = node.keys.slice().sort(order.desc ? (a, b) => compare(b, a) : compare);
  } else {
    const cache = (node.sortedKeys ??= { asc: node.keys.slice().sort(compareEntries) });
    keys = order.desc ? (cache.desc ??= cache.asc.slice().reverse()) : cache.asc;
  }
  return order.filter ? keys.filter(order.filter) : keys;
}

/**
 * The visible rows of the tree. `toggled` holds folders the user flipped from their default state. With
 * `defaultCollapsed` false every folder starts open; with it true folders start closed, except a folder that is the
 * only child of its parent and has no sibling keys, so single-child chains such as `example:group:` open down to the
 * first real branch. Cost: the rows listed plus one sort per newly opened folder.
 */
export function flattenTree(
  index: KeyIndex,
  toggled: ReadonlySet<string>,
  defaultCollapsed = false,
  order: TreeOrder = {},
): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (node: FolderNode, depth: number) => {
    const children = sortedFolders(node);
    const compareFolders = order.compareFolders;
    const folders = compareFolders
      ? children.slice().sort(order.desc ? (a, b) => compareFolders(b, a) : compareFolders)
      : order.desc
        ? children.slice().reverse()
        : children;
    const keys = sortedKeys(node, order);
    const size = folders.length + keys.length;
    const onlyChild = folders.length === 1 && node.keys.length === 0;
    let pos = 0;
    for (const child of folders) {
      const open = (!defaultCollapsed || onlyChild) !== toggled.has(child.id);
      rows.push({
        kind: "folder",
        id: child.id,
        label: visibleText(child.segment) || "(empty prefix)",
        depth,
        count: child.count,
        node: child,
        open,
        parent: node.id,
        pos: ++pos,
        size,
      });
      if (open) visit(child, depth + 1);
    }
    for (const entry of keys)
      rows.push({
        kind: "key",
        id: entry.id,
        entry,
        key: entry.key,
        depth,
        prefix: node.id,
        parent: node.id,
        pos: ++pos,
        size,
      });
  };
  visit(index.root, 0);
  return rows;
}

/** Every loaded key below a folder (all levels), for selecting a whole namespace. */
export function keysUnder(node: FolderNode): KeyEntry[] {
  const out: KeyEntry[] = [];
  const walk = (n: FolderNode) => {
    for (const entry of n.keys) out.push(entry);
    for (const child of n.folders.values()) walk(child);
  };
  walk(node);
  return out;
}

/** Bytes of the keys below a folder whose size is known, and how many keys that is. */
export interface FolderStats {
  bytes: number;
  sized: number;
}
/**
 * Folder byte sums from the metadata loaded so far: one pass over the keys, each adding its size to its folder
 * chain (O(keys × depth)). A sum is complete when `sized` equals the folder's `count`.
 */
export function folderStats(
  index: KeyIndex,
  sizeOf: (entry: KeyEntry) => number | undefined,
): Map<FolderNode, FolderStats> {
  const stats = new Map<FolderNode, FolderStats>();
  for (const entry of index.entries) {
    const size = sizeOf(entry);
    if (size === undefined) continue;
    for (let node: FolderNode | undefined = entry.folder; node && node.parent; node = node.parent) {
      const s = stats.get(node);
      if (s) {
        s.bytes += size;
        s.sized++;
      } else stats.set(node, { bytes: size, sized: 1 });
    }
  }
  return stats;
}

/** Escapes glob metacharacters so a folder path can be used as a literal SCAN prefix. */
export const globEscape = (text: string) => text.replace(/[*?[\]\\]/g, (c) => `\\${c}`);
/** The SCAN pattern of every key below a folder. */
export const folderPattern = (folderId: string) => `${globEscape(folderId)}*`;
