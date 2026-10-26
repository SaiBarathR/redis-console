/** Pure keyboard decisions for the Console and Workbench (unit tested; the components only wire them up). */

/** ↑/↓ recall history only from the first/last line of an unselected draft with no completion open. */
export function historyBoundary(state: {
  direction: -1 | 1;
  line: number;
  lines: number;
  selectionEmpty: boolean;
  completionOpen: boolean;
}) {
  if (state.completionOpen || !state.selectionEmpty) return false;
  return state.direction < 0 ? state.line === 1 : state.line === state.lines;
}

/**
 * History cursor that keeps the unfinished draft: stepping past the newest entry restores it.
 * `index === history.length` means "the draft".
 */
export function historyStep(
  history: readonly string[],
  index: number,
  direction: -1 | 1,
  current: string,
  draft: string,
) {
  const savedDraft = index === history.length ? current : draft;
  const next = Math.max(0, Math.min(history.length, index + direction));
  return {
    index: next,
    draft: savedDraft,
    value: next === history.length ? savedDraft : (history[next] ?? ""),
  };
}

/**
 * Ctrl+C: cancel a running request; with text selected on Windows/Linux let the browser copy it
 * (as Windows Terminal and VS Code do); otherwise clear the Console line. In the Workbench an idle
 * Ctrl+C never clears the script.
 */
export function interruptAction(state: {
  busy: boolean;
  mac: boolean;
  hasSelection: boolean;
  workbench: boolean;
}): "cancel" | "copy" | "clear" | "none" {
  if (!state.mac && state.hasSelection) return "copy";
  if (state.busy) return "cancel";
  return state.workbench ? "none" : "clear";
}

/** Esc: close the completion list or grey suggestion first; only the Console prompt then clears. */
export function escapeAction(state: {
  completionOpen: boolean;
  suggestion: boolean;
  empty: boolean;
  multiline: boolean;
}): "dismiss" | "clear" | "none" {
  if (state.completionOpen || state.suggestion) return "dismiss";
  if (state.multiline || state.empty) return "none";
  return "clear";
}

/**
 * Alt+↑/↓ between result blocks. In the Console the prompt sits below the newest block, in the
 * Workbench the editor sits above the newest run, so moving past that edge returns to the editor.
 */
export function blockTarget(
  count: number,
  current: number,
  direction: -1 | 1,
  layout: "console" | "workbench",
): number | "editor" | undefined {
  if (!count) return undefined;
  if (current < 0)
    return layout === "console"
      ? direction < 0
        ? count - 1
        : undefined
      : direction > 0
        ? 0
        : undefined;
  const next = current + direction;
  if (next >= count) return layout === "console" ? "editor" : count - 1;
  if (next < 0) return layout === "workbench" ? "editor" : 0;
  return next;
}
