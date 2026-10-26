import { useEffect, useRef, useImperativeHandle, type Ref } from "react";
import { EditorState, StateEffect, Annotation } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  placeholder,
  Decoration,
  WidgetType,
  ViewPlugin,
  gutter,
  GutterMarker,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, isolateHistory } from "@codemirror/commands";
import {
  autocompletion,
  completionKeymap,
  completionStatus,
  acceptCompletion,
  closeCompletion,
  selectedCompletion,
  startCompletion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { insertNewline } from "@codemirror/commands";
import { useShortcuts } from "../lib/keyboard/useShortcuts.ts";
import {
  analyzeCommand,
  historySuggestion,
  optionTokens,
} from "../lib/console/language.ts";
import { escapeAction, historyBoundary } from "../lib/console/keymap.ts";
import { visibleText } from "../lib/format.ts";
import { cliKey } from "../lib/format.ts";
import {
  tokenizeCommandLine,
  type Bin,
  type CommandDoc,
} from "@rconsole/shared";
export interface EditorHandle {
  focus: () => void;
  complete: () => void;
  accept: () => boolean;
  newline: () => void;
  dismiss: () => void;
  selection: () => { text: string; fromLine: number };
  /** True when the user has text selected in the editor (Ctrl+C then copies on Windows/Linux). */
  hasSelection: () => boolean;
}
/** One Workbench line's policy and run status, as the gutter marker and the accessible line list read it. */
export function lineMarkerLabel(
  status: string | undefined,
  policy?: { class: string; hint: string; destructive?: boolean },
) {
  return `${status ?? "pending"}: ${policy?.class ?? "unknown"}${policy?.destructive ? "; confirmation required" : ""}; ${policy?.hint ?? ""}`;
}
/**
 * Enter on an open completion list runs the command when accepting the highlighted entry would not change
 * it (an exact command such as PING, or a key typed in full); otherwise Enter accepts it.
 */
function completionIsNoop(instance: EditorView) {
  const selected = selectedCompletion(instance.state);
  if (!selected) return false;
  const head = instance.state.selection.main.head;
  const line = instance.state.doc.lineAt(head);
  const before = line.text.slice(0, head - line.from);
  const start = before.length - selected.label.length;
  if (start < 0 || (start > 0 && !/\s/.test(before[start - 1]!))) return false;
  const typed = before.slice(start);
  // Command names and option tokens are case-insensitive in Redis; key names are not.
  return selected.type === "keyword"
    ? typed.toUpperCase() === selected.label.toUpperCase()
    : typed === selected.label;
}
const refresh = StateEffect.define<null>();
const externalChange = Annotation.define<boolean>();
class Ghost extends WidgetType {
  readonly text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  override eq(other: Ghost) {
    return this.text === other.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "console-ghost";
    span.textContent = visibleText(this.text);
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  override ignoreEvent() {
    return true;
  }
}
class PolicyMarker extends GutterMarker {
  readonly label: string;
  readonly tone: string;
  constructor(label: string, tone: string) {
    super();
    this.label = label;
    this.tone = tone;
  }
  override eq(other: PolicyMarker) {
    return this.label === other.label && this.tone === other.tone;
  }
  override toDOM() {
    const span = document.createElement("span");
    const status = this.label.split(":")[0] ?? "pending";
    span.className = `console-line-marker tone-${this.tone} status-${status.replace(/\s+/g, "-")}`;
    span.title = this.label;
    span.setAttribute("aria-label", this.label);
    span.textContent =
      status === "error"
        ? "!"
        : status === "success"
          ? "✓"
          : status === "running"
            ? "…"
            : status === "not run"
              ? "–"
              : status === "cancelled"
                ? "■"
                : status === "may have run" || status === "unknown"
                  ? "?"
                  : this.tone === "blocked"
                  ? "×"
                  : this.tone === "danger"
                    ? "▲"
                    : "●";
    return span;
  }
}
export function Editor({
  value,
  onChange,
  onRun,
  docs = [],
  multiline = false,
  onHistory,
  keys = [],
  onCursor,
  label = "Redis command",
  describedBy,
  testId = "console-editor",
  editorRef,
  history: commandHistory = [],
  onSearch,
  onDocs,
  onRunSelection,
  linePolicy,
  lineStatuses = {},
}: {
  editorRef?: Ref<EditorHandle>;
  history?: string[];
  onSearch?: () => void;
  onRunSelection?: (selection: { text: string; fromLine: number }) => void;
  onDocs?: () => void;
  linePolicy?: (line: string) => {
    class: string;
    hint: string;
    allowed: boolean;
    destructive?: boolean;
    /** Classified once the command catalog has loaded: neither allowed nor refused yet. */
    pending?: boolean;
  };
  lineStatuses?: Record<number, string>;
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  docs?: CommandDoc[];
  keys?: Bin[];
  onCursor?: (before: string, fullLine: string, lineNumber: number) => void;
  multiline?: boolean;
  onHistory?: (direction: -1 | 1) => void;
  label?: string;
  /** Ids of the prompt and policy elements, read after the editor's name. */
  describedBy?: string;
  testId?: string;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const latest = useRef({
    onChange,
    onRun,
    onHistory,
    docs,
    keys,
    onCursor,
    commandHistory,
    onSearch,
    onDocs,
    onRunSelection,
    linePolicy,
    lineStatuses,
  });
  latest.current = {
    onChange,
    onRun,
    onHistory,
    docs,
    keys,
    onCursor,
    commandHistory,
    onSearch,
    onDocs,
    onRunSelection,
    linePolicy,
    lineStatuses,
  };
  const dismissed = useRef("");
  const ghost = () => {
    const instance = view.current;
    if (
      !instance ||
      multiline ||
      !instance.state.selection.main.empty ||
      instance.state.selection.main.head !== instance.state.doc.length
    )
      return "";
    const text = instance.state.doc.toString();
    return dismissed.current === text
      ? ""
      : historySuggestion(text, latest.current.commandHistory);
  };
  const accept = () => {
    const instance = view.current;
    if (!instance) return false;
    if (acceptCompletion(instance)) return true;
    const suggestion = ghost();
    if (!suggestion) return false;
    instance.dispatch({
      changes: { from: instance.state.doc.length, insert: suggestion },
      selection: { anchor: instance.state.doc.length + suggestion.length },
    });
    return true;
  };
  /** Esc: dismiss first; only the single-command Console prompt then clears its line. */
  const dismiss = () => {
    const instance = view.current;
    if (!instance) return false;
    const action = escapeAction({
      completionOpen: completionStatus(instance.state) !== null,
      suggestion: !!ghost(),
      empty: !instance.state.doc.length,
      multiline,
    });
    if (action === "dismiss") {
      closeCompletion(instance);
      dismissed.current = instance.state.doc.toString();
      instance.dispatch({ effects: refresh.of(null) });
      return true;
    }
    if (action === "clear") {
      instance.dispatch({
        annotations: isolateHistory.of("full"),
        changes: { from: 0, to: instance.state.doc.length, insert: "" },
      });
      return true;
    }
    return false;
  };
  const selection = () => {
    const instance = view.current;
    if (!instance) return { text: "", fromLine: 1 };
    const range = instance.state.selection.main;
    return {
      text: range.empty
        ? instance.state.doc.lineAt(range.head).text
        : instance.state.sliceDoc(range.from, range.to),
      fromLine: instance.state.doc.lineAt(range.from).number,
    };
  };
  /** ↑/↓ recall history only at the first/last line, as in shells and the DevTools console. */
  const recall = (direction: -1 | 1) => {
    const instance = view.current;
    if (
      !instance ||
      !historyBoundary({
        direction,
        line: instance.state.doc.lineAt(instance.state.selection.main.head)
          .number,
        lines: instance.state.doc.lines,
        selectionEmpty: instance.state.selection.main.empty,
        completionOpen: completionStatus(instance.state) === "active",
      })
    )
      return false;
    latest.current.onHistory?.(direction);
  };
  useImperativeHandle(editorRef, () => ({
    focus: () => view.current?.focus(),
    complete: () => {
      if (view.current) startCompletion(view.current);
    },
    accept,
    newline: () => {
      if (view.current) insertNewline(view.current);
    },
    dismiss: () => {
      dismiss();
    },
    selection,
    hasSelection: () => !!view.current && !view.current.state.selection.main.empty,
  }));
  useShortcuts(
    testId,
    {
      ...(multiline
        ? {
            runAll: () => {
              latest.current.onRun?.();
            },
            runSelection: () => {
              latest.current.onRunSelection?.(selection());
            },
          }
        : {
            run: () => {
              if (
                view.current &&
                completionStatus(view.current.state) === "active"
              ) {
                if (!completionIsNoop(view.current))
                  return acceptCompletion(view.current);
                closeCompletion(view.current);
              }
              latest.current.onRun?.();
            },
            newline: () => {
              if (view.current) {
                closeCompletion(view.current);
                insertNewline(view.current);
              }
            },
            previous: () => recall(-1),
            next: () => recall(1),
            search: () => {
              latest.current.onSearch?.();
            },
          }),
      complete: () => {
        if (view.current) startCompletion(view.current);
      },
      accept: (event) => {
        if (
          event.key === "ArrowRight" &&
          view.current &&
          !view.current.state.selection.main.empty
        )
          return false;
        return accept();
      },
      escape: () => dismiss(),
      docs: () => {
        latest.current.onDocs?.();
      },
    },
    parent,
  );

  useEffect(() => {
    if (!parent.current) return;
    const complete = (context: CompletionContext) => {
      const word = context.matchBefore(/[\w. -]*/);
      if (!word || (!context.explicit && word.from === word.to)) return null;
      const line = context.state.doc.lineAt(context.pos);
      const prefix = line.text.slice(0, context.pos - line.from).toUpperCase();
      const matching = latest.current.docs.filter((doc) =>
        doc.name.toUpperCase().startsWith(prefix.trimStart()),
      );
      if (!matching.length) {
        const before = line.text.slice(0, context.pos - line.from);
        const keyWord = /(?:^|\s)([^\s]*)$/.exec(before);
        if (!keyWord) return null;
        const typed = keyWord[1]!;
        const analysis = analyzeCommand(before, latest.current.docs);
        // An empty argument lists suggestions only on request (Ctrl+Space), so typing a space opens nothing.
        if (!typed && !context.explicit) return null;
        if (analysis.active?.type !== "key") {
          // Option tokens the command accepts and the line does not use yet, on request only.
          if (!context.explicit || !analysis.doc) return null;
          const used = new Set(analysis.tokens.map((token) => token.text.toUpperCase()));
          const tokens = optionTokens(analysis.doc).filter(
            (token) => token.startsWith(typed.toUpperCase()) && !used.has(token),
          );
          return tokens.length
            ? {
                from: context.pos - typed.length,
                options: tokens.map((token) => ({
                  label: token,
                  type: "keyword",
                  detail: "option",
                })),
              }
            : null;
        }
        // A key typed with an opening quote still matches; the completion supplies the quoting.
        const keyPrefix = typed.replace(/^["']/, "");
        return {
          from: context.pos - typed.length,
          options: latest.current.keys
            .filter(
              (key) => key.enc === "utf8" && key.data.startsWith(keyPrefix),
            )
            .slice(0, 100)
            .map((key) => ({
              label: cliKey(key),
              type: "variable",
              detail: "Seen in a scan · memory only",
            })),
        };
      }
      return {
        from: line.from + (line.text.length - line.text.trimStart().length),
        options: matching.map((doc) => ({
          label: doc.name,
          type: "keyword",
          detail: `${doc.class}${doc.allowed ? "" : " · restricted"}`,
          info: `${doc.summary}\n${doc.arguments.map((arg) => arg.token ?? arg.name).join(" ")}\n${doc.complexity ?? ""}${doc.since ? ` · Since ${doc.since}` : ""}${doc.hint ? `\n${doc.hint}` : ""}`,
        })),
      };
    };
    const instance = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          EditorView.cspNonce.of(
            document.querySelector<HTMLMetaElement>(
              'meta[name="csp-nonce"]:not([content=""])',
            )?.content ?? "",
          ),
          EditorView.contentAttributes.of({
            "aria-label": label,
            "data-testid": `${testId}-input`,
            "aria-multiline": String(multiline),
            ...(describedBy ? { "aria-describedby": describedBy } : {}),
            spellcheck: "false",
          }),
          EditorView.lineWrapping,
          // Chromium preserves the colour/weight of a selected syntax span by synthesising
          // inline style attributes during native replacement. Insert plain text as a CM
          // transaction before that DOM edit; keep IME composition on CodeMirror's path.
          EditorView.domEventHandlers({
            beforeinput: (event, instance) => {
              if (
                event.inputType !== "insertText" ||
                event.isComposing ||
                event.data === null
              )
                return false;
              event.preventDefault();
              // Native selection can precede CodeMirror's selectionchange observer (e.g.
              // select-all replacement or accessibility tools). Honour the actual range.
              const main = instance.state.selection.main;
              let from = main.from,
                to = main.to;
              const range = event.getTargetRanges?.()[0];
              if (
                range &&
                instance.contentDOM.contains(range.startContainer) &&
                instance.contentDOM.contains(range.endContainer)
              ) {
                from = instance.posAtDOM(
                  range.startContainer,
                  range.startOffset,
                );
                to = instance.posAtDOM(range.endContainer, range.endOffset);
              } else {
                const selection = instance.dom.ownerDocument.getSelection();
                if (
                  selection?.anchorNode &&
                  selection.focusNode &&
                  instance.contentDOM.contains(selection.anchorNode) &&
                  instance.contentDOM.contains(selection.focusNode)
                ) {
                  const anchor = instance.posAtDOM(
                    selection.anchorNode,
                    selection.anchorOffset,
                  );
                  const head = instance.posAtDOM(
                    selection.focusNode,
                    selection.focusOffset,
                  );
                  from = Math.min(anchor, head);
                  to = Math.max(anchor, head);
                }
              }
              const change =
                from === main.from && to === main.to
                  ? instance.state.replaceSelection(event.data)
                  : {
                      changes: { from, to, insert: event.data },
                      selection: { anchor: from + event.data.length },
                    };
              instance.dispatch(change, {
                userEvent: "input.type",
                scrollIntoView: true,
              });
              return true;
            },
          }),
          history(),
          ...(multiline ? [lineNumbers()] : []),
          placeholder(
            multiline
              ? "# One command per line; lines starting with # are comments\nPING\nDBSIZE"
              : "Type a Redis command",
          ),
          ViewPlugin.fromClass(
            class {
              decorations: DecorationSet;
              constructor(instance: EditorView) {
                this.decorations = this.build(instance);
              }
              update(update: { view: EditorView }) {
                this.decorations = this.build(update.view);
              }
              build(instance: EditorView) {
                const ranges = [];
                for (let n = 1; n <= instance.state.doc.lines; n++) {
                  const line = instance.state.doc.line(n);
                  if (/^\s*(#|\/\/)/.test(line.text)) {
                    if (line.length)
                      ranges.push(
                        Decoration.mark({
                          class: "console-token-comment",
                        }).range(line.from, line.to),
                      );
                    continue;
                  }
                  const analysis = analyzeCommand(line.text, latest.current.docs);
                  for (const token of analysis.tokens)
                    ranges.push(
                      Decoration.mark({
                        class: [
                          `console-token-${token.role}`,
                          token.role === "key" && analysis.family
                            ? `t-${analysis.family}`
                            : "",
                          token.invalid ? "console-token-invalid" : "",
                        ]
                          .filter(Boolean)
                          .join(" "),
                      }).range(line.from + token.from, line.from + token.to),
                    );
                }
                const suggestion = ghost();
                if (suggestion)
                  ranges.push(
                    Decoration.widget({
                      widget: new Ghost(suggestion),
                      side: 1,
                    }).range(instance.state.doc.length),
                  );
                return Decoration.set(ranges, true);
              }
            },
            { decorations: (plugin) => plugin.decorations },
          ),
          ...(multiline
            ? [
                gutter({
                  class: "console-policy-gutter",
                  lineMarker: (instance, block) => {
                    const line = instance.state.doc.lineAt(block.from);
                    if (!line.text.trim() || /^\s*(#|\/\/)/.test(line.text))
                      return null;
                    const policy = latest.current.linePolicy?.(line.text);
                    const status = latest.current.lineStatuses[line.number];
                    return new PolicyMarker(
                      lineMarkerLabel(status, policy),
                      status !== "error" && policy?.pending
                        ? "pending"
                        : status === "error" || !policy?.allowed
                        ? "blocked"
                        : policy?.destructive
                          ? "danger"
                          : (policy?.class ?? "read"),
                    );
                  },
                  lineMarkerChange: () => true,
                }),
              ]
            : []),
          keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
          autocompletion({ override: [complete], interactionDelay: 0 }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              dismissed.current = "";
              if (
                !update.transactions.some((transaction) =>
                  transaction.annotation(externalChange),
                )
              )
                latest.current.onChange(update.state.doc.toString());
            }
            if (update.docChanged || update.selectionSet) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              latest.current.onCursor?.(
                line.text.slice(0, head - line.from),
                line.text,
                line.number,
              );
            }
          }),
          EditorView.theme({
            "&": {
              backgroundColor: "transparent",
              color: "var(--text)",
              fontSize: "var(--editor-font-size, 13px)",
            },
            ".cm-content": {
              fontFamily: "var(--mono)",
              padding: multiline ? "10px 0" : "11px 0",
              minHeight: multiline ? "100%" : "20px",
              lineHeight: "20px",
            },
            ".cm-line": { padding: multiline ? "0 12px" : "0 10px 0 4px" },
            ".cm-gutters": {
              backgroundColor: "var(--pane)",
              color: "var(--graphite)",
              borderRight: "1px solid var(--rule)",
            },
            // The prompt row / editor pane draws the 2px focus ring (:focus-within).
            "&.cm-focused": { outline: "none" },
            ".cm-cursor": { borderLeftColor: "var(--accent)" },
            ".cm-tooltip": {
              backgroundColor: "var(--pane)",
              color: "var(--ink)",
              border: "1px solid var(--rule-strong)",
              borderRadius: "var(--radius)",
              boxShadow: "var(--shadow-dialog)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-meta)",
            },
            ".cm-tooltip.cm-completionInfo": {
              fontFamily: "var(--font-ui)",
              whiteSpace: "pre-wrap",
              maxWidth: "420px",
              padding: "6px 9px",
            },
            ".cm-completionDetail": {
              color: "var(--graphite)",
              fontStyle: "normal",
              marginLeft: "1em",
            },
            ".cm-tooltip-autocomplete ul li[aria-selected]": {
              backgroundColor: "var(--accent-soft)",
              color: "var(--text)",
            },
            ".cm-selectionBackground": {
              backgroundColor: "var(--accent-soft) !important",
            },
          }),
        ],
      }),
    });
    view.current = instance;
    return () => {
      instance.destroy();
      view.current = undefined;
    };
    // The document and callbacks synchronize separately; avoid recreating editors while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiline, label, testId]);
  useEffect(() => {
    const instance = view.current;
    if (instance && instance.state.doc.toString() !== value)
      instance.dispatch({
        annotations: [externalChange.of(true), isolateHistory.of("full")],
        changes: { from: 0, to: instance.state.doc.length, insert: value },
        selection: { anchor: value.length },
      });
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({ effects: refresh.of(null) });
  }, [docs, commandHistory, lineStatuses]);
  return <div className="editor" ref={parent} data-testid={testId} />;
}
