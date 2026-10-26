import { describe, expect, it } from "vitest";
import { binFromBytes, binFromString, type Bin } from "@rconsole/shared";
import {
  buildKeyIndex,
  canonicalKey,
  flattenTree,
  folderPattern,
  folderStats,
  keyId,
  keysUnder,
  naturalKey,
  type FolderNode,
  type TreeRow,
} from "./keytree.ts";

const names = (...list: string[]): Bin[] => list.map(binFromString);
const tree = (list: Bin[], delimiter = ":", toggled = new Set<string>(), collapsed = false, desc = false) =>
  flattenTree(buildKeyIndex(list, delimiter), toggled, collapsed, { desc });
const shape = (rows: TreeRow[]) =>
  rows.map((row) => (row.kind === "folder" ? `${row.id}${row.open ? "+" : "-"}${row.count}` : row.key.data));

describe("namespace tree index (v0.2.1)", () => {
  it("groups by a configurable delimiter without changing key bytes; counts every key below a folder", () => {
    const rows = tree(names("app:user:1", "app:user:2", "app:cfg", "plain"));
    expect(shape(rows)).toEqual(["app:+3", "app:user:+2", "app:user:1", "app:user:2", "app:cfg", "plain"]);
    const multi = tree(names("a::b::c", "a::d"), "::");
    expect(shape(multi)).toEqual(["a::+2", "a::b::+1", "a::b::c", "a::d"]);
  });
  it("collapses a folder and its descendants; toggling flips the default", () => {
    expect(shape(tree(names("app:user:1", "plain"), ":", new Set(["app:"])))).toEqual(["app:-1", "plain"]);
    const rows = tree(names("app:cache:a:1", "app:cache:b:1", "app:cache:b:2"), ":", new Set(), true);
    // Collapsed start opens single-child chains down to the first branch.
    expect(shape(rows)).toEqual(["app:+3", "app:cache:+3", "app:cache:a:-1", "app:cache:b:-2"]);
    const opened = tree(names("app:cache:a:1", "app:cache:b:1"), ":", new Set(["app:cache:b:"]), true);
    expect(opened.at(-1)).toMatchObject({ kind: "key", prefix: "app:cache:b:" });
  });
  it("keeps binary keys as root leaves and supports a flat list and empty segments", () => {
    const binary = binFromBytes(new Uint8Array([255, 58, 0]));
    expect(tree([binary])[0]).toMatchObject({ kind: "key", key: binary, depth: 0 });
    expect(tree(names("a:b"), "")).toHaveLength(1);
    expect(tree(names(":b"))[0]).toMatchObject({ label: "(empty prefix)", id: ":" });
  });
  it("sorts naturally (2 before 10, case-insensitive), descending on request, folders before keys", () => {
    const list = names("u:10", "u:2", "u:1", "U:3", "u:a", "k");
    expect(tree(list, "").map((row) => row.kind === "key" && row.key.data)).toEqual(["k", "u:1", "u:2", "U:3", "u:10", "u:a"]);
    expect(tree(list, "", new Set(), false, true).map((row) => row.kind === "key" && row.key.data)).toEqual(["u:a", "u:10", "U:3", "u:2", "u:1", "k"]);
    expect(shape(tree(names("b:1", "a:1", "z")))).toEqual(["a:+1", "a:1", "b:+1", "b:1", "z"]);
    expect(shape(tree(names("b:1", "a:1", "z"), ":", new Set(), false, true))).toEqual(["b:+1", "b:1", "a:+1", "a:1", "z"]);
    expect(naturalKey("x9") < naturalKey("x10")).toBe(true);
    expect(tree(names("cfg2", "cfg", "cfg10", "cfga"), "").map((row) => row.kind === "key" && row.key.data)).toEqual(["cfg", "cfg2", "cfg10", "cfga"]);
  });
  it("orders sibling folders by a custom comparison (sizes when sorting by size), reversed with desc", () => {
    const index = buildKeyIndex(names("a:1", "b:1", "b:2", "c:1"), ":");
    const sums = folderStats(index, (entry) => ({ "a:1": 5, "b:1": 1, "b:2": 1, "c:1": 50 })[entry.text!]);
    const bySize = (a: FolderNode, b: FolderNode) => sums.get(b)!.bytes - sums.get(a)!.bytes;
    const top = (desc: boolean) =>
      flattenTree(index, new Set(), false, { compareFolders: bySize, desc }).filter((row) => row.kind === "folder").map((row) => row.id);
    expect(top(false)).toEqual(["c:", "a:", "b:"]);
    expect(top(true)).toEqual(["b:", "a:", "c:"]);
  });
  it("sets tree positions for assistive technology", () => {
    const rows = tree(names("a:1", "a:2", "b"));
    expect(rows[0]).toMatchObject({ kind: "folder", count: 2, pos: 1, size: 2 });
    expect(rows.at(-1)).toMatchObject({ kind: "key", pos: 2, size: 2, depth: 0 });
  });
  it("sums folder sizes from the metadata loaded so far and says when a sum is complete", () => {
    const index = buildKeyIndex(names("a:x:1", "a:x:2", "a:y", "b"), ":");
    const sizes: Record<string, number> = { "a:x:1": 10, "a:x:2": 5 };
    const stats = folderStats(index, (entry) => sizes[entry.text!]);
    expect(stats.get(index.folders.get("a:x:")!)).toEqual({ bytes: 15, sized: 2 });
    expect(stats.get(index.folders.get("a:")!)).toEqual({ bytes: 15, sized: 2 });
    expect(index.folders.get("a:")!.count).toBe(3);
  });
  it("lists every key under a folder and builds its SCAN pattern with glob characters escaped", () => {
    const index = buildKeyIndex(names("s:1", "s:x:2", "t"), ":");
    expect(keysUnder(index.folders.get("s:")!).map((entry) => entry.text).sort()).toEqual(["s:1", "s:x:2"]);
    expect(folderPattern("a*b?[c]\\:")).toBe("a\\*b\\?\\[c\\]\\\\:*");
  });
  it("gives the same id to the same bytes whatever the encoding", () => {
    const text = binFromString("user:1");
    const base64 = { enc: "base64" as const, data: btoa("user:1") };
    expect(keyId(base64)).toBe(keyId(text));
    expect(canonicalKey(base64)).toEqual(text);
    expect(keyId(binFromBytes(new Uint8Array([255])))).not.toBe(keyId(binFromString("�")));
  });
  it("stays fast with 100k keys: index once, list only open folders", () => {
    const list: Bin[] = [];
    for (let i = 0; i < 100_000; i++) list.push(binFromString(`app:${["img", "meta", "user", "sess"][i % 4]}:${i % 997}:${i}`));
    let t = performance.now();
    const index = buildKeyIndex(list, ":");
    const build = performance.now() - t;
    t = performance.now();
    const collapsed = flattenTree(index, new Set(), true);
    const flatten = performance.now() - t;
    expect(collapsed.length).toBeLessThan(10);
    expect(index.root.count).toBe(100_000);
    t = performance.now();
    const all = flattenTree(buildKeyIndex(list, ""), new Set());
    const flat = performance.now() - t;
    expect(all).toHaveLength(100_000);
    // Generous bounds for CI; locally these are about 60, 1 and 250 ms.
    expect(build).toBeLessThan(1500);
    expect(flatten).toBeLessThan(100);
    expect(flat).toBeLessThan(4000);
  });
});
