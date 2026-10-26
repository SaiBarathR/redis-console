/**
 * One catalogue drives dispatch, platform labels, visible kbd hints and the `?` overlay.
 * Chords use `Mod` for ⌘ on macOS and Ctrl elsewhere; `Ctrl` is the literal Control key on every
 * platform (terminal conventions such as Ctrl+R, Ctrl+L and Ctrl+C).
 */
export const contexts = [
  "Global",
  "Console prompt",
  "Console and Workbench editors",
  "Workbench editor",
  "Console and Workbench",
  "Result block",
  "History search",
  "Key browser",
  "Databases",
  "Dialogs",
] as const;
export type ShortcutContext = (typeof contexts)[number];
export interface Shortcut {
  readonly id: string;
  readonly group: ShortcutContext;
  readonly label: string;
  readonly keys: readonly string[];
  /** Handled by the page's own key handler or the browser (listed in help, not dispatched here). */
  readonly page?: boolean;
}
export const shortcuts = [
  { id: "palette", group: "Global", label: "Command palette", keys: ["Mod+k"] },
  {
    id: "help",
    group: "Global",
    label: "Keyboard shortcuts (outside text fields)",
    keys: ["?"],
  },
  { id: "keys", group: "Global", label: "Open the key browser", keys: ["Alt+1"] },
  { id: "console", group: "Global", label: "Open the Console", keys: ["Alt+2"] },
  {
    id: "drawer",
    group: "Global",
    label: "Open or close the tools drawer (Console, Command helper, Profiler)",
    keys: ["Ctrl+`"],
  },
  {
    id: "run",
    group: "Console prompt",
    label: "Run the command (or accept the highlighted completion)",
    keys: ["Enter"],
  },
  {
    id: "newline",
    group: "Console prompt",
    label: "Continue the command on a new line",
    keys: ["Shift+Enter"],
  },
  {
    id: "previous",
    group: "Console prompt",
    label: "Previous command (on the first line)",
    keys: ["ArrowUp"],
  },
  {
    id: "next",
    group: "Console prompt",
    label: "Next command (on the last line)",
    keys: ["ArrowDown"],
  },
  {
    id: "search",
    group: "Console prompt",
    label: "Search history (press again for an older match)",
    keys: ["Ctrl+r"],
  },
  {
    id: "complete",
    group: "Console and Workbench editors",
    label: "Show completions",
    keys: ["Ctrl+Space"],
  },
  {
    id: "accept",
    group: "Console and Workbench editors",
    label: "Accept the completion or grey history suggestion",
    keys: ["Tab", "ArrowRight"],
  },
  {
    id: "escape",
    group: "Console and Workbench editors",
    label: "Dismiss a suggestion; in the Console, then clear the line",
    keys: ["Escape"],
  },
  {
    id: "docs",
    group: "Console and Workbench editors",
    label: "Documentation for the command at the cursor",
    keys: ["F1", "Mod+/"],
  },
  {
    id: "runAll",
    group: "Workbench editor",
    label: "Run the whole script",
    keys: ["Mod+Enter"],
  },
  {
    id: "runSelection",
    group: "Workbench editor",
    label: "Run the selection or the current line",
    keys: ["Shift+Enter"],
  },
  {
    id: "clear",
    group: "Console and Workbench",
    label: "Clear the screen (history is kept)",
    keys: ["Ctrl+l"],
  },
  {
    id: "cancel",
    group: "Console and Workbench",
    label:
      "Cancel the running request; otherwise clear the Console line (Windows/Linux: copies a selection)",
    keys: ["Ctrl+c"],
  },
  {
    id: "blockPrevious",
    group: "Console and Workbench",
    label: "Focus the previous result",
    keys: ["Alt+ArrowUp"],
  },
  {
    id: "blockNext",
    group: "Console and Workbench",
    label: "Focus the next result (past the end: back to the editor)",
    keys: ["Alt+ArrowDown"],
  },
  {
    id: "copy",
    group: "Console and Workbench",
    label: "Copy the last result",
    keys: ["Mod+Shift+c"],
  },
  {
    id: "resultActions",
    group: "Result block",
    label: "Reach collapse, copy, re-run and key links",
    keys: ["Tab"],
    page: true,
  },
  {
    id: "resultKeys",
    group: "Result block",
    label: "Move between the keys of a SCAN reply (one Tab stop)",
    keys: ["ArrowUp", "ArrowDown"],
    page: true,
  },
  {
    id: "resultBack",
    group: "Result block",
    label: "Back to the editor (from the block or any action in it)",
    keys: ["Escape"],
    page: true,
  },
  {
    id: "searchAccept",
    group: "History search",
    label: "Put the match on the prompt (does not run it)",
    keys: ["Enter"],
  },
  {
    id: "searchMove",
    group: "History search",
    label: "Choose a newer or older match",
    keys: ["ArrowUp", "ArrowDown"],
  },
  {
    id: "searchClose",
    group: "History search",
    label: "Close the search and keep your draft",
    keys: ["Escape"],
  },
  {
    id: "keysMove",
    group: "Key browser",
    label: "Move through the list",
    keys: ["ArrowUp", "ArrowDown"],
    page: true,
  },
  {
    id: "keysFolder",
    group: "Key browser",
    label: "Open or close a namespace",
    keys: ["ArrowRight", "ArrowLeft"],
    page: true,
  },
  {
    id: "keysInspect",
    group: "Key browser",
    label: "Inspect the key",
    keys: ["Enter"],
    page: true,
  },
  {
    id: "keysSelect",
    group: "Key browser",
    label: "Select for bulk actions",
    keys: ["Space"],
    page: true,
  },
  {
    id: "keysPattern",
    group: "Key browser",
    label: "Edit the pattern (outside text fields)",
    keys: ["/"],
    page: true,
  },
  {
    id: "landingMove",
    group: "Databases",
    label: "Choose a database",
    keys: ["ArrowUp", "ArrowDown"],
    page: true,
  },
  {
    id: "landingOpen",
    group: "Databases",
    label: "Open the database",
    keys: ["Enter"],
    page: true,
  },
  {
    id: "landingPosition",
    group: "Databases",
    label: "Open by position",
    keys: ["1–9"],
    page: true,
  },
  {
    id: "dialogClose",
    group: "Dialogs",
    label: "Close the dialog or cancel the confirmation",
    keys: ["Escape"],
    page: true,
  },
] as const satisfies readonly Shortcut[];
export type ShortcutId = (typeof shortcuts)[number]["id"];
/** Ids the registry dispatches; page-handled entries are documentation only. */
export type DispatchId = Exclude<
  (typeof shortcuts)[number],
  { page: true }
>["id"];
export const shortcut = (id: ShortcutId): Shortcut =>
  shortcuts.find((item) => item.id === id)!;
/**
 * The platform the keyboard events come from. `navigator.platform` follows the real OS even when a
 * user-agent override (device emulation) changes `userAgentData`, so labels match the keys pressed.
 */
export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);
const LABELS: Record<string, [mac: string, other: string]> = {
  Mod: ["⌘", "Ctrl"],
  Ctrl: ["Ctrl", "Ctrl"],
  Alt: ["Option", "Alt"],
  Shift: ["Shift", "Shift"],
  ArrowUp: ["↑", "↑"],
  ArrowDown: ["↓", "↓"],
  ArrowLeft: ["←", "←"],
  ArrowRight: ["→", "→"],
  Space: ["Space", "Space"],
  Escape: ["Esc", "Esc"],
};
export function shortcutLabel(key: string, mac = isMac()) {
  return key
    .split("+")
    .map(
      (part) =>
        LABELS[part]?.[mac ? 0 : 1] ??
        (part.length === 1 ? part.toUpperCase() : part),
    )
    .join("+");
}
/** Visible kbd hint for a catalogue entry on this platform ("F1 / ⌘+/"). */
export function hint(id: ShortcutId, mac = isMac()) {
  return shortcut(id)
    .keys.map((key) => shortcutLabel(key, mac))
    .join(" / ");
}
export function matches(event: KeyboardEvent, chord: string, mac = isMac()) {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const ctrl = parts.includes("Ctrl") || (parts.includes("Mod") && !mac);
  const meta = parts.includes("Meta") || (parts.includes("Mod") && mac);
  // Option+digit produces symbols on macOS; navigation retains the physical digit.
  const sameKey =
    (parts.includes("Alt") &&
      /^\d$/.test(key) &&
      event.code === `Digit${key}`) ||
    event.key.toLowerCase() === (key === "Space" ? " " : key.toLowerCase());
  // '?' already carries Shift on many layouts. Use event.key for the produced character.
  return (
    sameKey &&
    event.ctrlKey === ctrl &&
    event.metaKey === meta &&
    event.altKey === parts.includes("Alt") &&
    (key === "?" || event.shiftKey === parts.includes("Shift"))
  );
}
export const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest(
    'input, textarea, select, [contenteditable="true"], [role="textbox"]',
  );
export interface Binding {
  id: string;
  keys: readonly string[];
  scope: string;
  root?: () => HTMLElement | null;
  /** Editors opt in. A page/global binding still ignores unrelated input fields. */
  typing?: "editor" | "scope";
  run: (event: KeyboardEvent) => boolean | void;
}
export class ShortcutRegistry {
  private bindings = new Set<Binding>();
  register(binding: Binding) {
    for (const existing of this.bindings) {
      if (
        existing.scope === binding.scope &&
        existing.keys.some((a) =>
          binding.keys.some((b) => a === b || canonical(a) === canonical(b)),
        )
      )
        throw new Error(
          `Shortcut conflict in ${binding.scope}: ${existing.id} / ${binding.id}`,
        );
    }
    this.bindings.add(binding);
    return () => {
      this.bindings.delete(binding);
    };
  }
  dispatch(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.key === "Process")
      return false;
    const target = event.target;
    // Scoped bindings win over global ones; the innermost root wins among scoped ones.
    const candidates = [...this.bindings]
      .map((binding) => ({ binding, root: binding.root?.() ?? null }))
      .sort((a, b) => depth(b.root) - depth(a.root));
    for (const { binding, root } of candidates) {
      if (
        binding.root &&
        (!root || !(target instanceof Node) || !root.contains(target))
      )
        continue;
      // Modal content cannot trigger page shortcuts behind the dialog.
      if (
        target instanceof Element &&
        target.closest("dialog[open]") &&
        !root?.closest("dialog[open]")
      )
        continue;
      if (
        isTyping(target) &&
        !(binding.typing === "scope" && root) &&
        !(
          binding.typing === "editor" &&
          target instanceof Element &&
          target.closest(".cm-content")
        )
      )
        continue;
      if (!binding.keys.some((key) => matches(event, key))) continue;
      if (binding.run(event) === false) continue;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  }
  connect(target: Window) {
    const handler = (event: KeyboardEvent) => {
      this.dispatch(event);
    };
    target.addEventListener("keydown", handler, true);
    return () => target.removeEventListener("keydown", handler, true);
  }
}
function depth(node: Node | null) {
  if (!node) return -1;
  let count = 0;
  for (let at: Node | null = node; at; at = at.parentNode) count++;
  return count;
}
function canonical(chord: string) {
  return chord.replace("Mod", isMac() ? "Meta" : "Ctrl").toLowerCase();
}
/** Context sets that can be active at the same time; their dispatched chords must not collide. */
export const activeContexts: Record<string, readonly ShortcutContext[]> = {
  console: [
    "Global",
    "Console prompt",
    "Console and Workbench editors",
    "Console and Workbench",
  ],
  workbench: [
    "Global",
    "Console and Workbench editors",
    "Workbench editor",
    "Console and Workbench",
  ],
  historySearch: ["Global", "History search", "Console and Workbench"],
};
/** Chords that two dispatched shortcuts share inside one active context set (should be none). */
export function catalogueConflicts(mac: boolean) {
  const conflicts: string[] = [];
  for (const [name, groups] of Object.entries(activeContexts)) {
    const seen = new Map<string, string>();
    for (const item of shortcuts as readonly Shortcut[]) {
      if (item.page || !groups.includes(item.group)) continue;
      for (const key of item.keys) {
        const chord = key.replace("Mod", mac ? "Meta" : "Ctrl").toLowerCase();
        const owner = seen.get(chord);
        if (owner && owner !== item.id)
          conflicts.push(`${name}: ${chord} (${owner} / ${item.id})`);
        else seen.set(chord, item.id);
      }
    }
  }
  return conflicts;
}
export const keyboard = new ShortcutRegistry();
