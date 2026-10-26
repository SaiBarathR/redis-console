import { describe, expect, it, vi } from "vitest";
import {
  activeContexts,
  catalogueConflicts,
  contexts,
  hint,
  matches,
  shortcutLabel,
  shortcuts,
  ShortcutRegistry,
  type Shortcut,
} from "./registry.ts";
import { viewContexts } from "./ShortcutHelp.tsx";
const event = (key: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
describe("platform keymap", () => {
  it("distinguishes literal Control from platform Mod on macOS", () => {
    expect(matches(event("r", { ctrlKey: true }), "Ctrl+r", true)).toBe(true);
    expect(matches(event("k", { metaKey: true }), "Mod+k", true)).toBe(true);
    expect(matches(event("k", { ctrlKey: true }), "Mod+k", true)).toBe(false);
  });
  it("maps Mod to Control on Windows/Linux, rejecting extra modifiers", () => {
    expect(
      matches(
        event("C", { ctrlKey: true, shiftKey: true }),
        "Mod+Shift+c",
        false,
      ),
    ).toBe(true);
    expect(matches(event("c", { ctrlKey: true }), "Mod+Shift+c", false)).toBe(
      false,
    );
    expect(
      matches(event("c", { ctrlKey: true, altKey: true }), "Ctrl+c", false),
    ).toBe(false);
  });
  it("handles space and shifted question mark", () => {
    expect(matches(event(" ", { ctrlKey: true }), "Ctrl+Space", false)).toBe(
      true,
    );
    expect(matches(event("?", { shiftKey: true }), "?", false)).toBe(true);
    expect(matches(event("?", { altKey: true }), "?", false)).toBe(false);
  });
  it("keeps Option+digit navigation working when macOS produces a symbol", () => {
    expect(
      matches(event("¡", { code: "Digit1", altKey: true }), "Alt+1", true),
    ).toBe(true);
    expect(
      matches(event("™", { code: "Digit2", altKey: true }), "Alt+2", true),
    ).toBe(true);
  });
  it("labels both platforms without changing literal Ctrl", () => {
    expect(shortcutLabel("Mod+Shift+c", true)).toBe("⌘+Shift+C");
    expect(shortcutLabel("Mod+Shift+c", false)).toBe("Ctrl+Shift+C");
    expect(shortcutLabel("Alt+ArrowUp", true)).toBe("Option+↑");
    expect(shortcutLabel("Ctrl+r", true)).toBe("Ctrl+R");
  });
});
describe("scoped registry", () => {
  it("detects duplicate chords and allows disjoint scopes and cleanup", () => {
    const registry = new ShortcutRegistry();
    const binding = {
      id: "one",
      scope: "editor",
      keys: ["Ctrl+r"],
      run: vi.fn(),
    };
    const dispose = registry.register(binding);
    expect(() => registry.register({ ...binding, id: "two" })).toThrow(
      "Shortcut conflict",
    );
    registry.register({ ...binding, scope: "other-editor" });
    dispose();
    expect(() => registry.register(binding)).not.toThrow();
  });
  it("never steals shortcuts from unrelated text inputs", () => {
    const registry = new ShortcutRegistry();
    const run = vi.fn();
    registry.register({ id: "clear", scope: "global", keys: ["Ctrl+l"], run });
    const disconnect = registry.connect(window);
    const input = document.createElement("input");
    document.body.append(input);
    const key = event("l", { ctrlKey: true });
    input.dispatchEvent(key);
    expect(run).not.toHaveBeenCalled();
    expect(key.defaultPrevented).toBe(false);
    input.remove();
    disconnect();
  });
  it("allows scoped editor actions and rejects composition and modal escape leakage", () => {
    const registry = new ShortcutRegistry();
    const run = vi.fn();
    const root = document.createElement("div");
    const input = document.createElement("div");
    input.className = "cm-content";
    input.setAttribute("contenteditable", "true");
    root.append(input);
    document.body.append(root);
    registry.register({
      id: "clear",
      scope: "page",
      root: () => root,
      typing: "editor",
      keys: ["Ctrl+l"],
      run,
    });
    const disconnect = registry.connect(window);
    const key = event("l", { ctrlKey: true });
    input.dispatchEvent(key);
    expect(run).toHaveBeenCalledTimes(1);
    expect(key.defaultPrevented).toBe(true);
    input.dispatchEvent(event("l", { ctrlKey: true, isComposing: true }));
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    dialog.append(input);
    root.append(dialog);
    input.dispatchEvent(event("l", { ctrlKey: true }));
    expect(run).toHaveBeenCalledTimes(1);
    root.remove();
    disconnect();
  });
  it("falls through when a handler declines so Tab can leave the editor", () => {
    const registry = new ShortcutRegistry();
    registry.register({
      id: "accept",
      scope: "global",
      keys: ["Tab"],
      run: () => false,
    });
    const key = event("Tab");
    expect(registry.dispatch(key)).toBe(false);
    expect(key.defaultPrevented).toBe(false);
  });
});

describe("catalogue", () => {
  const all = shortcuts as readonly Shortcut[];
  it("has unique ids, known contexts and a label and key for every entry", () => {
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    for (const item of all) {
      expect(contexts).toContain(item.group);
      expect(item.label.length).toBeGreaterThan(3);
      expect(item.keys.length).toBeGreaterThan(0);
    }
  });
  it("uses only modifiers the matcher understands", () => {
    for (const item of all)
      for (const key of item.keys) {
        const parts = key.split("+");
        parts.pop();
        for (const part of parts)
          expect(["Mod", "Ctrl", "Alt", "Shift", "Meta"]).toContain(part);
      }
  });
  it("has no chord that two dispatched shortcuts share in one context set, on either platform", () => {
    expect(catalogueConflicts(true)).toEqual([]);
    expect(catalogueConflicts(false)).toEqual([]);
  });
  it("finds a conflict when one is introduced", () => {
    const original = [...shortcuts];
    (shortcuts as unknown as Shortcut[]).push({
      id: "duplicate-clear",
      group: "Console and Workbench",
      label: "Duplicate",
      keys: ["Ctrl+l"],
    });
    try {
      expect(catalogueConflicts(true)).toEqual([
        "console: ctrl+l (clear / duplicate-clear)",
        "workbench: ctrl+l (clear / duplicate-clear)",
        "historySearch: ctrl+l (clear / duplicate-clear)",
      ]);
    } finally {
      (shortcuts as unknown as Shortcut[]).splice(original.length);
    }
  });
  it("covers every brief shortcut with the expected chord", () => {
    const keys = Object.fromEntries(all.map((item) => [item.id, item.keys]));
    expect(keys).toMatchObject({
      run: ["Enter"],
      newline: ["Shift+Enter"],
      previous: ["ArrowUp"],
      next: ["ArrowDown"],
      search: ["Ctrl+r"],
      accept: ["Tab", "ArrowRight"],
      complete: ["Ctrl+Space"],
      escape: ["Escape"],
      clear: ["Ctrl+l"],
      cancel: ["Ctrl+c"],
      blockPrevious: ["Alt+ArrowUp"],
      blockNext: ["Alt+ArrowDown"],
      copy: ["Mod+Shift+c"],
      docs: ["F1", "Mod+/"],
      help: ["?"],
      palette: ["Mod+k"],
      runAll: ["Mod+Enter"],
      runSelection: ["Shift+Enter"],
    });
  });
  it("labels every chord for macOS and for Windows/Linux", () => {
    expect(hint("copy", true)).toBe("⌘+Shift+C");
    expect(hint("copy", false)).toBe("Ctrl+Shift+C");
    expect(hint("docs", true)).toBe("F1 / ⌘+/");
    expect(hint("docs", false)).toBe("F1 / Ctrl+/");
    expect(hint("blockPrevious", true)).toBe("Option+↑");
    expect(hint("blockPrevious", false)).toBe("Alt+↑");
    expect(hint("runAll", true)).toBe("⌘+Enter");
    expect(hint("runAll", false)).toBe("Ctrl+Enter");
    // Terminal chords are the literal Control key on every platform.
    expect(hint("search", true)).toBe("Ctrl+R");
    expect(hint("cancel", true)).toBe("Ctrl+C");
    expect(hint("clear", false)).toBe("Ctrl+L");
    for (const item of all)
      for (const key of item.keys) {
        expect(shortcutLabel(key, true)).not.toMatch(/Mod|Alt\b|Escape|Arrow/);
        expect(shortcutLabel(key, false)).not.toMatch(/Mod|⌘|Option|Escape|Arrow/);
      }
  });
  it("defines active context sets only from known contexts", () => {
    for (const groups of Object.values(activeContexts))
      for (const group of groups) expect(contexts).toContain(group);
  });
  it("lists the current view's contexts first in the overlay", () => {
    expect(viewContexts("/db/snapshot/console")[0]).toBe("Console prompt");
    expect(viewContexts("/db/x/workbench")[0]).toBe("Workbench editor");
    expect(viewContexts("/db/x/keys")).toEqual(["Key browser"]);
    expect(viewContexts("/")).toEqual(["Databases"]);
    expect(viewContexts("/account")).toEqual([]);
  });
});
describe("keymap matching per platform", () => {
  it("matches Mod+Enter, Alt+arrows and F1 the way each platform sends them", () => {
    expect(matches(event("Enter", { metaKey: true }), "Mod+Enter", true)).toBe(true);
    expect(matches(event("Enter", { ctrlKey: true }), "Mod+Enter", false)).toBe(true);
    expect(matches(event("Enter", { ctrlKey: true }), "Mod+Enter", true)).toBe(false);
    expect(matches(event("ArrowUp", { altKey: true }), "Alt+ArrowUp", true)).toBe(true);
    expect(matches(event("ArrowUp"), "Alt+ArrowUp", true)).toBe(false);
    expect(matches(event("F1"), "F1", false)).toBe(true);
    expect(matches(event("/", { metaKey: true }), "Mod+/", true)).toBe(true);
    expect(matches(event("Enter", { shiftKey: true }), "Enter", true)).toBe(false);
    expect(matches(event("Enter", { shiftKey: true }), "Shift+Enter", true)).toBe(true);
  });
  it("keeps literal Ctrl chords on macOS distinct from ⌘", () => {
    expect(matches(event("c", { metaKey: true }), "Ctrl+c", true)).toBe(false);
    expect(matches(event("c", { ctrlKey: true }), "Ctrl+c", true)).toBe(true);
    expect(matches(event("l", { ctrlKey: true }), "Ctrl+l", false)).toBe(true);
  });
});
describe("dispatch precedence", () => {
  it("prefers the innermost scope, then page scopes, then global bindings", () => {
    const registry = new ShortcutRegistry();
    const page = document.createElement("div");
    const panel = document.createElement("div");
    const input = document.createElement("input");
    panel.append(input);
    page.append(panel);
    document.body.append(page);
    const calls: string[] = [];
    registry.register({
      id: "global",
      scope: "global",
      keys: ["Ctrl+r"],
      run: () => {
        calls.push("global");
      },
    });
    registry.register({
      id: "page",
      scope: "page",
      root: () => page,
      typing: "scope",
      keys: ["Ctrl+r"],
      run: () => {
        calls.push("page");
      },
    });
    registry.register({
      id: "panel",
      scope: "panel",
      root: () => panel,
      typing: "scope",
      keys: ["Ctrl+r"],
      run: () => {
        calls.push("panel");
      },
    });
    const disconnect = registry.connect(window);
    input.dispatchEvent(event("r", { ctrlKey: true }));
    page.dispatchEvent(event("r", { ctrlKey: true }));
    document.body.dispatchEvent(event("r", { ctrlKey: true }));
    expect(calls).toEqual(["panel", "page", "global"]);
    page.remove();
    disconnect();
  });
  it("ignores already handled events and IME composition", () => {
    const registry = new ShortcutRegistry();
    const run = vi.fn();
    registry.register({ id: "help", scope: "global", keys: ["?"], run });
    const handled = event("?");
    handled.preventDefault();
    expect(registry.dispatch(handled)).toBe(false);
    expect(registry.dispatch(event("Process"))).toBe(false);
    expect(registry.dispatch(event("?", { isComposing: true }))).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(registry.dispatch(event("?"))).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("never fires a global shortcut inside a select, textarea or contenteditable outside editors", () => {
    const registry = new ShortcutRegistry();
    const run = vi.fn();
    registry.register({ id: "help", scope: "global", keys: ["?"], run });
    const disconnect = registry.connect(window);
    for (const tag of ["select", "textarea", "div"]) {
      const node = document.createElement(tag);
      if (tag === "div") node.setAttribute("contenteditable", "true");
      document.body.append(node);
      node.dispatchEvent(event("?"));
      node.remove();
    }
    expect(run).not.toHaveBeenCalled();
    disconnect();
  });
});
