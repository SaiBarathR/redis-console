/** v0.4 graph: a conservative Cypher guard, not a parser or a read/write classifier. */
export const GRAPH_TIMEOUT_MS = 1000;
export const GRAPH_QUERY_COMMANDS = new Set(['GRAPH.QUERY', 'GRAPH.RO_QUERY', 'GRAPH.EXPLAIN', 'GRAPH.PROFILE']);
const READ_PROCEDURES = new Set(['DB.LABELS', 'DB.RELATIONSHIPTYPES', 'DB.PROPERTYKEYS']);

/**
 * Strip literals/comments and retain token boundaries, including quoted identifiers. Fail closed on bad quoting.
 *
 * Comments end where FalkorDB 6.0.3 ends them: a `//` comment at LF only (CR LF is fine; a lone CR is refused, since
 * FalkorDB keeps it inside the comment and a guard that ended the comment there could be shown code the engine treats
 * as comment, and the reverse; review v0.4 r2 graph H1). Outside strings, comments and quoted identifiers only ASCII
 * space, tab, CR and LF are whitespace and every other control or non-ASCII character is refused, so the browser (a JS
 * string) and the server (the argument's bytes as latin1) read a query the same way (graph L2).
 */
function tokens(query: string): string[] | undefined {
  const out: string[] = [];
  for (let i = 0; i < query.length;) {
    const c = query[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (query.startsWith('//', i)) {
      i += 2;
      while (i < query.length && query[i] !== '\n') {
        const code = query.charCodeAt(i);
        if (code === 13 && query[i + 1] === '\n') { i++; continue; }
        // A lone CR, other control characters and unfamiliar line separators: refuse rather than guess the end.
        if (code > 126 || (code < 32 && code !== 9)) return undefined;
        i++;
      }
      continue;
    }
    if (query.startsWith('/*', i)) { const end = query.indexOf('*/', i + 2); if (end < 0) return undefined; i = end + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      let closed = false;
      while (i < query.length) {
        // Cypher escapes identifier backticks by doubling them. Backslashes are literal there.
        if (query[i] === '\\' && quote !== '`') { i += 2; continue; }
        if (query[i++] === quote) {
          if (query[i] === quote) { i++; continue; }
          closed = true; break;
        }
      }
      if (!closed) return undefined;
      out.push(quote === '`' ? '#identifier' : '#literal');
      continue;
    }
    if (c.charCodeAt(0) > 126 || c.charCodeAt(0) < 32) return undefined;
    const word = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(query.slice(i))?.[0];
    if (word) { out.push(word.toUpperCase()); i += word.length; }
    else { out.push(c); i++; }
  }
  return out;
}

/** Refuse host I/O, unreviewed procedures and namespaced/quoted function calls (including preloaded JS UDFs). */
export function graphQueryRefusal(query: string): string | undefined {
  if (query.length > 65_536) return 'Graph queries are limited to 64 KiB.';
  const ts = tokens(query);
  if (!ts) return 'Graph queries must have balanced strings, identifiers and comments.';
  const allowedCalls = new Set<number>();
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] === 'LOAD') return 'LOAD CSV is disabled: it can read files or fetch URLs from the Redis host.';
    if (ts[i] !== 'CALL') continue;
    const name = ts.slice(i + 1, i + 4).join('');
    if (!READ_PROCEDURES.has(name) || ts[i + 4] !== '(' || ts[i + 5] !== ')') {
      return 'Only CALL db.labels(), db.relationshipTypes() and db.propertyKeys() are allowed.';
    }
    allowedCalls.add(i + 4);
  }
  // A dot is a namespace separator only after a name: `[0..size(x)]` is a range, `lib.fn(` and `` `lib`.fn( `` are calls.
  const name = (t: string | undefined) => t === '#identifier' || (t !== undefined && /^[A-Z_][A-Z_0-9]*$/.test(t));
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] === '(' && !allowedCalls.has(i) && ((ts[i - 2] === '.' && name(ts[i - 3])) || ts[i - 1] === '#identifier')) {
      return 'Namespaced and quoted function calls are disabled (user-defined code).';
    }
  }
  return undefined;
}
