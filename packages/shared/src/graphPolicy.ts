/** v0.4 graph: a conservative Cypher guard, not a parser or a read/write classifier. */
export const GRAPH_TIMEOUT_MS = 1000;
export const GRAPH_QUERY_COMMANDS = new Set(['GRAPH.QUERY', 'GRAPH.RO_QUERY', 'GRAPH.EXPLAIN', 'GRAPH.PROFILE']);
const READ_PROCEDURES = new Set(['DB.LABELS', 'DB.RELATIONSHIPTYPES', 'DB.PROPERTYKEYS']);

/** Strip literals/comments and retain token boundaries, including quoted identifiers. Fail closed on bad quoting. */
function tokens(query: string): string[] | undefined {
  const out: string[] = [];
  for (let i = 0; i < query.length;) {
    const c = query[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (query.startsWith('//', i)) {
      i += 2;
      while (i < query.length && query[i] !== '\n' && query[i] !== '\r') {
        // Treat unfamiliar line separators conservatively rather than hiding later code in a comment.
        const c = query.charCodeAt(i);
        if (c > 126 || (c < 32 && c !== 9)) return undefined;
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
        if (query[i] === '\\') { i += 2; continue; }
        if (query[i++] === quote) {
          if (query[i] === quote) { i++; continue; }
          closed = true; break;
        }
      }
      if (!closed) return undefined;
      out.push(quote === '`' ? '#identifier' : '#literal');
      continue;
    }
    if (c.charCodeAt(0) > 126) return undefined;
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
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] === '(' && !allowedCalls.has(i) && (ts[i - 2] === '.' || ts[i - 1] === '#identifier')) {
      return 'Namespaced and quoted function calls are disabled (user-defined code).';
    }
  }
  return undefined;
}
