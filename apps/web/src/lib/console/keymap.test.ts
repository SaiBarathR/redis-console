import { describe, expect, it } from "vitest";
import {
  blockTarget,
  escapeAction,
  historyBoundary,
  historyStep,
  interruptAction,
} from "./keymap.ts";
describe("history boundaries (↑/↓)", () => {
  const at = (line: number, lines: number, extra = {}) => ({
    line,
    lines,
    selectionEmpty: true,
    completionOpen: false,
    ...extra,
  });
  it("recalls history only from the first line going up and the last line going down", () => {
    expect(historyBoundary({ direction: -1, ...at(1, 1) })).toBe(true);
    expect(historyBoundary({ direction: 1, ...at(1, 1) })).toBe(true);
    expect(historyBoundary({ direction: -1, ...at(2, 2) })).toBe(false);
    expect(historyBoundary({ direction: 1, ...at(1, 2) })).toBe(false);
    expect(historyBoundary({ direction: 1, ...at(2, 2) })).toBe(true);
  });
  it("leaves arrows to the completion list and to a selection", () => {
    expect(
      historyBoundary({ direction: -1, ...at(1, 1, { completionOpen: true }) }),
    ).toBe(false);
    expect(
      historyBoundary({ direction: -1, ...at(1, 1, { selectionEmpty: false }) }),
    ).toBe(false);
  });
});
describe("history cursor", () => {
  const history = ["PING", "DBSIZE", "GET a"];
  it("walks back from the draft and restores the unfinished draft at the end", () => {
    let state = { index: 3, draft: "" };
    const step = (direction: -1 | 1, current: string) => {
      const next = historyStep(history, state.index, direction, current, state.draft);
      state = { index: next.index, draft: next.draft };
      return next.value;
    };
    expect(step(-1, "SCAN 0")).toBe("GET a");
    expect(step(-1, "GET a")).toBe("DBSIZE");
    expect(step(-1, "DBSIZE")).toBe("PING");
    expect(step(-1, "PING")).toBe("PING"); // clamps at the oldest entry
    expect(step(1, "PING")).toBe("DBSIZE");
    expect(step(1, "DBSIZE")).toBe("GET a");
    expect(step(1, "GET a")).toBe("SCAN 0"); // the draft comes back
    expect(step(1, "SCAN 0")).toBe("SCAN 0");
  });
  it("does nothing useful but stays safe with empty history", () => {
    expect(historyStep([], 0, -1, "draft", "")).toEqual({
      index: 0,
      draft: "draft",
      value: "draft",
    });
  });
});
describe("Ctrl+C", () => {
  const base = { busy: false, mac: true, hasSelection: false, workbench: false };
  it("cancels a running request on every platform", () => {
    expect(interruptAction({ ...base, busy: true })).toBe("cancel");
    expect(interruptAction({ ...base, busy: true, mac: false })).toBe("cancel");
  });
  it("clears the Console line when idle, never the Workbench script", () => {
    expect(interruptAction(base)).toBe("clear");
    expect(interruptAction({ ...base, workbench: true })).toBe("none");
  });
  it("lets Windows/Linux copy a selection, as terminals do; macOS copies with ⌘C", () => {
    expect(
      interruptAction({ ...base, mac: false, hasSelection: true }),
    ).toBe("copy");
    expect(
      interruptAction({ ...base, mac: false, hasSelection: true, busy: true }),
    ).toBe("copy");
    expect(interruptAction({ ...base, hasSelection: true })).toBe("clear");
  });
});
describe("Esc", () => {
  const base = { completionOpen: false, suggestion: false, empty: false, multiline: false };
  it("dismisses a completion list or grey suggestion first", () => {
    expect(escapeAction({ ...base, completionOpen: true })).toBe("dismiss");
    expect(escapeAction({ ...base, suggestion: true })).toBe("dismiss");
    expect(escapeAction({ ...base, suggestion: true, multiline: true })).toBe(
      "dismiss",
    );
  });
  it("then clears the Console line, but never a Workbench script", () => {
    expect(escapeAction(base)).toBe("clear");
    expect(escapeAction({ ...base, multiline: true })).toBe("none");
    expect(escapeAction({ ...base, empty: true })).toBe("none");
  });
});
describe("Alt+↑/↓ between result blocks", () => {
  it("Console: the prompt is below the newest block", () => {
    expect(blockTarget(3, -1, -1, "console")).toBe(2);
    expect(blockTarget(3, -1, 1, "console")).toBeUndefined();
    expect(blockTarget(3, 2, -1, "console")).toBe(1);
    expect(blockTarget(3, 0, -1, "console")).toBe(0);
    expect(blockTarget(3, 2, 1, "console")).toBe("editor");
  });
  it("Workbench: the editor is above the newest run", () => {
    expect(blockTarget(3, -1, 1, "workbench")).toBe(0);
    expect(blockTarget(3, -1, -1, "workbench")).toBeUndefined();
    expect(blockTarget(3, 0, -1, "workbench")).toBe("editor");
    expect(blockTarget(3, 2, 1, "workbench")).toBe(2);
  });
  it("does nothing without results", () => {
    expect(blockTarget(0, -1, -1, "console")).toBeUndefined();
  });
});
