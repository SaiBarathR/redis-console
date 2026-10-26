import type { CommandKeySpec } from "@rconsole/shared";
/** Exact positions for supported complete Redis specs, bounded by the current argument vector. */
export function commandKeyPositions(
  argv: readonly string[],
  specs: readonly CommandKeySpec[] | undefined,
): Set<number> | undefined {
  if (!specs?.length) return undefined;
  const keys = new Set<number>();
  for (const { begin, find } of specs) {
    let start: number;
    if (begin.type === "index") start = begin.index;
    else {
      const direction = begin.startfrom < 0 ? -1 : 1;
      let at =
        begin.startfrom < 0 ? argv.length + begin.startfrom : begin.startfrom;
      while (
        at >= 0 &&
        at < argv.length &&
        argv[at]?.toUpperCase() !== begin.keyword.toUpperCase()
      )
        at += direction;
      if (at < 0 || at >= argv.length) continue; // optional keyword is absent
      start = at + 1;
    }
    if (start <= 0 || start >= argv.length) continue;
    let first = start,
      last: number;
    if (find.type === "keynum") {
      const raw = argv[start + find.keynumidx];
      if (!raw || !/^\d+$/.test(raw)) return undefined;
      const count = Number(raw);
      if (!Number.isSafeInteger(count) || count > argv.length) return undefined;
      first = start + find.firstkey;
      last = first + (count - 1) * find.keystep;
      if (count === 0) continue;
      if (last >= argv.length) return undefined;
    } else {
      last =
        find.lastkey >= 0 ? start + find.lastkey : argv.length + find.lastkey;
      if (find.lastkey === -1 && find.limit > 1) {
        const remaining = argv.length - start;
        if (remaining % find.limit) return undefined; // still typing parallel key/ID lists
        last = start + remaining / find.limit - 1;
      }
    }
    if (find.keystep <= 0 || !Number.isSafeInteger(find.keystep))
      return undefined;
    for (
      let index = first;
      index <= Math.min(last, argv.length - 1);
      index += find.keystep
    )
      keys.add(index);
  }
  return keys;
}
