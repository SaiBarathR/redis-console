/**
 * Redis's glob matcher (`stringmatchlen` in `util.c`), on bytes: `*`, `?`, `[…]` with `^` negation, `a-z` ranges and
 * `\` escapes, with Redis's cut for patterns with several `*` (once the rest of the pattern matches nowhere in the
 * string, longer matches for an earlier `*` are not tried) and its nesting guard. NOCASE folds ASCII letters only, as
 * Redis's `tolower` does in the C locale. Bytes compare unsigned (Redis built where `char` is signed compares bytes
 * above 0x7f in `[a-z]` ranges differently; plain bytes, `?` and `*` are unaffected).
 *
 * The array inspector's search matches on the server over bounded reads (review v0.4 r2 H2), so its GLOB must mean
 * what ARGREP GLOB means; `integration/array.test.ts` compares the two on Redis.
 */
export function globMatch(pattern: Uint8Array, value: Uint8Array, nocase: boolean): boolean {
  return match(pattern, 0, pattern.length, value, 0, value.length, nocase, { longer: false }, 0);
}

/** ASCII `tolower`. */
export const lower = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c);

const STAR = 42, QUESTION = 63, OPEN = 91, CLOSE = 93, CARET = 94, BACKSLASH = 92, DASH = 45;

function match(p: Uint8Array, pi: number, pl: number, s: Uint8Array, si: number, sl: number, nocase: boolean, skip: { longer: boolean }, nesting: number): boolean {
  if (nesting > 1000) return false;
  const eq = (a: number | undefined, b: number | undefined) => (a !== undefined && b !== undefined && (nocase ? lower(a) === lower(b) : a === b));
  while (pl > 0 && sl > 0) {
    const c = p[pi];
    if (c === STAR) {
      while (pl > 1 && p[pi + 1] === STAR) { pi++; pl--; }
      if (pl === 1) return true;
      while (sl > 0) {
        if (match(p, pi + 1, pl - 1, s, si, sl, nocase, skip, nesting + 1)) return true;
        if (skip.longer) return false;
        si++; sl--;
      }
      skip.longer = true;
      return false;
    } else if (c === QUESTION) {
      si++; sl--;
    } else if (c === OPEN) {
      pi++; pl--;
      const not = pl > 0 && p[pi] === CARET;
      if (not) { pi++; pl--; }
      let hit = false;
      for (;;) {
        if (pl >= 2 && p[pi] === BACKSLASH) {
          pi++; pl--;
          if (p[pi] === s[si]) hit = true;
        } else if (pl > 0 && p[pi] === CLOSE) {
          break;
        } else if (pl === 0) {
          // An unterminated class: step back so the shared advance below lands at the pattern's end.
          pi--; pl++;
          break;
        } else if (pl >= 3 && p[pi + 1] === DASH) {
          let start = p[pi]!, end = p[pi + 2]!, ch = s[si]!;
          if (start > end) [start, end] = [end, start];
          if (nocase) { start = lower(start); end = lower(end); ch = lower(ch); }
          pi += 2; pl -= 2;
          if (ch >= start && ch <= end) hit = true;
        } else if (eq(p[pi], s[si])) {
          hit = true;
        }
        pi++; pl--;
      }
      if (not) hit = !hit;
      if (!hit) return false;
      si++; sl--;
    } else {
      if (c === BACKSLASH && pl >= 2) { pi++; pl--; }
      if (!eq(p[pi], s[si])) return false;
      si++; sl--;
    }
    pi++; pl--;
    if (sl === 0) {
      while (pl > 0 && p[pi] === STAR) { pi++; pl--; }
      break;
    }
  }
  return pl === 0 && sl === 0;
}
