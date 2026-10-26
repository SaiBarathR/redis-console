import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { visibleText } from "../../lib/format.ts";

export interface QueryField {
  /** The name a query uses (`@name`): the attribute (alias) of the index field. */
  name: string;
  type: string;
}

export interface Completion {
  label: string;
  /** Text inserted in place of the word being typed; `|` marks where the cursor goes. */
  insert: string;
  detail: string;
}

/** Query syntax a RediSearch query can use (FT.SEARCH / FT.AGGREGATE query string). */
const OPERATORS: Completion[] = [
  { label: "*", insert: "*", detail: "every document" },
  { label: '"exact phrase"', insert: '"|"', detail: "words in this order" },
  { label: "-term", insert: "-|", detail: "NOT: exclude matches" },
  { label: "a | b", insert: "(| | )", detail: "OR" },
  { label: "~term", insert: "~|", detail: "optional: boosts, does not filter" },
  { label: "prefix*", insert: "|*", detail: "words starting with" },
  { label: "%fuzzy%", insert: "%|%", detail: "one spelling mistake allowed" },
];

/** FT.AGGREGATE pipeline steps. */
const PIPELINE: Completion[] = [
  { label: "LOAD", insert: "LOAD 1 @|", detail: "load fields from the documents" },
  { label: "GROUPBY", insert: "GROUPBY 1 @| REDUCE COUNT 0 AS count", detail: "group by fields, then reduce" },
  { label: "REDUCE COUNT", insert: "REDUCE COUNT 0 AS |count", detail: "rows per group" },
  { label: "REDUCE SUM", insert: "REDUCE SUM 1 @| AS total", detail: "sum of a numeric field" },
  { label: "REDUCE AVG", insert: "REDUCE AVG 1 @| AS average", detail: "average of a numeric field" },
  { label: "REDUCE MIN", insert: "REDUCE MIN 1 @| AS min", detail: "minimum" },
  { label: "REDUCE MAX", insert: "REDUCE MAX 1 @| AS max", detail: "maximum" },
  { label: "REDUCE COUNT_DISTINCT", insert: "REDUCE COUNT_DISTINCT 1 @| AS distinct", detail: "distinct values" },
  { label: "REDUCE TOLIST", insert: "REDUCE TOLIST 1 @| AS values", detail: "distinct values as a list" },
  { label: "SORTBY", insert: "SORTBY 2 @| DESC", detail: "sort rows" },
  { label: "APPLY", insert: 'APPLY "|" AS computed', detail: "computed field (expression)" },
  { label: "FILTER", insert: 'FILTER "|"', detail: "keep rows matching an expression" },
  { label: "LIMIT", insert: "LIMIT 0 |10", detail: "offset and count" },
];

/** What a field completes to: the field reference plus the syntax its type takes. */
export function fieldCompletion(f: QueryField): Completion {
  const at = `@${f.name}`;
  switch (f.type.toUpperCase()) {
    case "TAG":
      return { label: at, insert: `${at}:{|}`, detail: "TAG · exact values" };
    case "NUMERIC":
      return { label: at, insert: `${at}:[| +inf]`, detail: "NUMERIC · range [min max]" };
    case "GEO":
      return { label: at, insert: `${at}:[| 0 10 km]`, detail: "GEO · [lon lat radius unit]" };
    case "VECTOR":
      return { label: at, insert: `${at}`, detail: "VECTOR · KNN needs PARAMS (use the workbench)" };
    default:
      return { label: at, insert: `${at}:|`, detail: `${f.type} · words` };
  }
}

/** The word before the cursor and where it starts (words: letters, digits, @, _, ., $). */
export function wordAt(text: string, cursor: number): { word: string; from: number } {
  let from = cursor;
  while (from > 0 && /[@\w.$]/.test(text[from - 1]!)) from--;
  return { word: text.slice(from, cursor), from };
}

/** Completions for the word at the cursor (`@` lists fields; `force` lists everything). */
export function completionsFor(text: string, cursor: number, fields: QueryField[], kind: "query" | "pipeline", force = false): { items: Completion[]; from: number } {
  const { word, from } = wordAt(text, cursor);
  const lower = word.toLowerCase();
  const fieldItems = fields.map(fieldCompletion);
  if (word.startsWith("@")) return { items: fieldItems.filter((c) => c.label.toLowerCase().startsWith(lower)), from };
  // Plain words only complete on request (Ctrl+Space), so Enter keeps running the query while typing.
  if (!force) return { items: [], from };
  const pool = kind === "pipeline" ? [...PIPELINE, ...fieldItems] : [...fieldItems, ...OPERATORS];
  const items = word ? pool.filter((c) => c.label.toLowerCase().replace(/^@/, "").startsWith(lower)) : pool;
  return { items, from };
}

/**
 * A one-line query editor with completion (fields of the chosen index, query operators, aggregate pipeline steps).
 * Enter runs; Shift+Enter adds a line; Ctrl+Space lists every completion; ↑/↓, Enter or Tab, Esc.
 */
export function QueryEditor({
  value,
  onChange,
  onRun,
  fields,
  kind = "query",
  label,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  fields: QueryField[];
  kind?: "query" | "pipeline";
  label: string;
  placeholder?: string;
  testId?: string;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [open, setOpen] = useState<{ items: Completion[]; from: number } | null>(null);
  const [active, setActive] = useState(0);
  const cursorAfter = useRef<number | null>(null);
  const refresh = (text: string, cursor: number, force = false) => {
    const next = completionsFor(text, cursor, fields, kind, force);
    setOpen(next.items.length ? next : null);
    setActive(0);
  };
  const accept = (c: Completion) => {
    const el = input.current;
    if (!el || !open) return;
    const cursor = el.selectionStart;
    const marker = c.insert.indexOf("|");
    const text = c.insert.replace("|", "");
    const next = value.slice(0, open.from) + text + value.slice(cursor);
    // The cursor goes inside the inserted syntax once the new value has rendered (see the layout effect).
    cursorAfter.current = open.from + (marker >= 0 ? marker : text.length);
    setOpen(null);
    onChange(next);
  };
  useLayoutEffect(() => {
    const at = cursorAfter.current;
    if (at === null || !input.current) return;
    cursorAfter.current = null;
    input.current.focus();
    input.current.setSelectionRange(at, at);
  }, [value]);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === " " && e.ctrlKey) {
      e.preventDefault();
      refresh(value, e.currentTarget.selectionStart, true);
      return;
    }
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + open.items.length) % open.items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(open.items[active]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onRun();
    }
  };
  return (
    <div className="query-editor">
      <textarea
        ref={input}
        className="data"
        rows={1}
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={!!open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        data-testid={testId}
        onChange={(e) => {
          onChange(e.target.value);
          refresh(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKey}
        onBlur={() => setTimeout(() => setOpen(null), 150)}
      />
      {open && (
        <ul className="query-completions" role="listbox" id={listId} aria-label={`${label} completions`} data-testid={testId ? `${testId}-completions` : undefined}>
          {open.items.slice(0, 50).map((c, i) => (
            <li
              key={`${c.label}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                accept(c);
              }}
            >
              <code className="data">{visibleText(c.label)}</code>
              <small>{c.detail}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
