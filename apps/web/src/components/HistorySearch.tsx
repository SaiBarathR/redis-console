import { useEffect, useRef, useState } from "react";
import { useShortcuts } from "../lib/keyboard/useShortcuts.ts";
import { hint } from "../lib/keyboard/registry.ts";
import { cliDisplayLine, visibleText } from "../lib/format.ts";
/** Matches newest first, like bash/zsh reverse-i-search (case-insensitive substring). */
export function historyMatches(history: readonly string[], query: string) {
  const needle = query.toLowerCase();
  return [...new Set([...history].reverse())].filter((line) =>
    line.toLowerCase().includes(needle),
  );
}
function Highlight({ text, query }: { text: string; query: string }) {
  text = cliDisplayLine(text);
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{visibleText(text)}</>;
  return (
    <>
      {visibleText(text.slice(0, at))}
      <mark>{visibleText(text.slice(at, at + query.length))}</mark>
      {visibleText(text.slice(at + query.length))}
    </>
  );
}
export function HistorySearch({
  history,
  onChoose,
  onClose,
}: {
  history: string[];
  onChoose: (line: string) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const matches = historyMatches(history, query);
  const choose = () => {
    if (matches[index] !== undefined) onChoose(matches[index]);
  };
  const move = (step: number) =>
    setIndex((value) =>
      matches.length
        ? Math.max(0, Math.min(matches.length - 1, value + step))
        : 0,
    );
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);
  useShortcuts(
    "history-search",
    {
      // Ctrl+R again cycles to an older match, wrapping like readline.
      search: () =>
        setIndex((value) =>
          matches.length ? (value + 1) % matches.length : 0,
        ),
      searchMove: (event) => move(event.key === "ArrowUp" ? -1 : 1),
      searchAccept: choose,
      searchClose: onClose,
    },
    root,
    "scope",
  );
  return (
    <div
      ref={root}
      className="console-history-search"
      data-testid="history-search"
    >
      <div className="history-search-bar">
        <label className="history-search-field">
          <span>History search</span>
          <input
            autoFocus
            aria-label="Search command history"
            role="combobox"
            aria-expanded="true"
            aria-controls="history-matches"
            aria-activedescendant={
              matches[index] !== undefined ? `history-match-${index}` : undefined
            }
            placeholder="Type part of a command"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
          />
        </label>
        <span role="status" className="history-count">
          {matches.length
            ? `${index + 1} of ${matches.length} ${matches.length === 1 ? "match" : "matches"}`
            : history.length
              ? "No matching commands"
              : "No commands in this tab yet"}
        </span>
        <span className="history-search-keys">
          <button
            type="button"
            className="key-hint"
            onClick={choose}
            disabled={matches[index] === undefined}
          >
            <kbd>Enter</kbd>
            <span>use</span>
          </button>
          <button
            type="button"
            className="key-hint"
            onClick={() => move(1)}
            disabled={matches.length < 2}
          >
            <kbd>{hint("search")}</kbd>
            <span>older</span>
          </button>
          <button type="button" className="key-hint" onClick={onClose}>
            <kbd>Esc</kbd>
            <span>close</span>
          </button>
        </span>
      </div>
      {matches.length > 0 && (
        <ul
          ref={list}
          id="history-matches"
          className="history-matches"
          role="listbox"
          aria-label="Matching commands, newest first"
        >
          {matches.slice(0, 200).map((line, i) => (
            <li
              key={line}
              id={`history-match-${i}`}
              role="option"
              aria-selected={i === index}
              className="data"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChoose(line)}
            >
              <Highlight text={line} query={query} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
