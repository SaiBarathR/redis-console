import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";
import { bytesFromBin, type Bin, type EditConflict, type EditExpect } from "@rconsole/shared";
import { RequestError } from "../lib/api.ts";
import { bytesLabel, displayBin, visibleText } from "../lib/format.ts";

/** The 409 `conflict` of a compare-and-set edit, if `error` is one. */
export function conflictOf(error: unknown): EditConflict | undefined {
  return error instanceof RequestError ? error.conflict : undefined;
}

/** Already shown by the component that caught it (e.g. a conflict notice); forms should not repeat it. */
export class HandledError extends Error {
  readonly quiet = true;
}

const DIFF_MAX_CHARS = 20_000;
const DIFF_MAX_LINES = 400;

/**
 * A line diff of two short UTF-8 values (LCS), or undefined when it would not be cheap or meaningful: binary values,
 * large values, or a current value that is only a preview.
 */
export function lineDiff(opened: Bin, current: Bin): string | undefined {
  if (opened.enc !== "utf8" || current.enc !== "utf8") return undefined;
  if (opened.data.length > DIFF_MAX_CHARS || current.data.length > DIFF_MAX_CHARS) return undefined;
  const a = opened.data.split("\n"), b = current.data.split("\n");
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) return undefined;
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; }
    else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { out.push(`- ${a[i]}`); i++; }
    else { out.push(`+ ${b[j]}`); j++; }
  }
  return visibleText(out.join("\n"));
}

function reasonText(conflict: EditConflict) {
  const { expected, current } = conflict;
  const withArticle = (type: string) => `${/^[aeiou]/i.test(type) ? "an" : "a"} ${type}`;
  if (conflict.reason === "type")
    return current.type === "none"
      ? "The key no longer exists."
      : expected.type === "none"
        ? `The key was created since you opened it (it is now ${withArticle(current.type)}). Reload to edit it as it is now.`
        : `It is now ${withArticle(current.type)} (you opened ${withArticle(expected.type)}). Reload to edit it as it is now.`;
  if (current.value === undefined && current.type === expected.type && current.totalBytes === undefined)
    return "What you opened is no longer there.";
  if (expected.sha256 === null) return "It has a value now that you have not seen.";
  return "Another client wrote it after you opened it.";
}

/**
 * "This value changed since you opened it": shown instead of saving when the server answers 409 `conflict`, or when
 * a refresh shows the editor's snapshot is out of date. It shows what Redis holds now (and a diff when that is
 * cheap) and offers Reload or, when the current state can be compared, Overwrite anyway, which sends a new
 * expectation for exactly that state: it never skips the check.
 */
export function ConflictNotice({
  conflict,
  opened,
  title = "This value changed since you opened it.",
  overwriteLabel = "Overwrite anyway",
  onReload,
  onOverwrite,
  busy = false,
}: {
  conflict: EditConflict;
  /** What the editor opened, for the diff. */
  opened?: Bin;
  title?: string;
  overwriteLabel?: string;
  onReload: () => void;
  onOverwrite?: (expect: EditExpect) => void;
  busy?: boolean;
}) {
  const { current } = conflict;
  const value = current.value;
  const box = useRef<HTMLDivElement>(null);
  // It replaces a save: bring it into view (it may open below a long form).
  useEffect(() => { box.current?.scrollIntoView?.({ block: "nearest" }); }, [conflict]);
  const diff = opened && value && !current.truncated ? lineDiff(opened, value) : undefined;
  const size = value ? bytesLabel(current.totalBytes ?? bytesFromBin(value).length) : current.totalBytes !== undefined ? bytesLabel(current.totalBytes) : undefined;
  return (
    <div ref={box} className="notice warning conflict" role="alert" data-testid="edit-conflict">
      <AlertTriangle size={15} aria-hidden="true" />
      <div className="conflict-body">
        <strong>{title}</strong>
        <p>{reasonText(conflict)} Nothing was written.</p>
        {value !== undefined && (
          <div className="conflict-current">
            <span className="muted">
              Current value{size ? ` (${size}${current.truncated ? `, first ${bytesLabel(bytesFromBin(value).length)} shown` : ""})` : ""}
            </span>
            <pre className="data" data-testid="edit-conflict-current">{displayBin(value, 4000)}</pre>
          </div>
        )}
        {value === undefined && current.totalBytes !== undefined && (
          <p className="muted">The current value has {bytesLabel(current.totalBytes)}, more than an editor can hold. Read it in the console.</p>
        )}
        {diff !== undefined && (
          <details open className="conflict-diff">
            <summary>Changes since you opened it</summary>
            <pre className="data" data-testid="edit-conflict-diff">{diff}</pre>
          </details>
        )}
        <div className="actions">
          <button type="button" className="primary" onClick={onReload} disabled={busy} data-testid="edit-conflict-reload">
            Reload
          </button>
          {onOverwrite && current.expect && (
            <button type="button" className="danger-text" onClick={() => onOverwrite(current.expect!)} disabled={busy} data-testid="edit-conflict-overwrite">
              {busy ? "Working…" : overwriteLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
