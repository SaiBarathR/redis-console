import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { CornerDownLeft, LockKeyhole, Play, TriangleAlert } from "lucide-react";
import {
  type ApiError,
  type Bin,
  type CliResponse,
  type CommandDoc,
  type WorkbenchCancelResponse,
  type WorkbenchResponse,
} from "@rconsole/shared";
import {
  collection,
  dbPath,
  endSession,
  friendlyMessage,
  request,
} from "../lib/api.ts";
import { useMemorySlot } from "../lib/memory.tsx";
import { getPreferences } from "../lib/preferences.ts";
import { useDatabase } from "../lib/context.tsx";
import {
  CATALOG_ERROR_HINT,
  LOADING_HINT,
  commandPolicy,
  type CatalogState,
} from "../lib/policy.ts";
import { cliArg, visibleText } from "../lib/format.ts";
import { commandDoc } from "../lib/console/language.ts";
import {
  blockTarget,
  historyStep,
  interruptAction,
} from "../lib/console/keymap.ts";
import {
  hint,
  isMac,
  shortcut,
  type ShortcutId,
} from "../lib/keyboard/registry.ts";
import { useShortcuts } from "../lib/keyboard/useShortcuts.ts";
import {
  Editor,
  lineMarkerLabel,
  type EditorHandle,
} from "../components/Editor.tsx";
import {
  ConsoleResultBlock,
  RunningBlock,
  replySummary,
  resultStatus,
  resultText,
  scanKeys,
  type ConsoleResult,
} from "../components/ConsoleResult.tsx";
import {
  CommandDocumentation,
  ConsoleAssist,
} from "../components/ConsoleAssist.tsx";
import { HistorySearch } from "../components/HistorySearch.tsx";
import { Badge, EnvBadge, ErrorState, Modal, PageTitle } from "../components/ui.tsx";
import "./Console.css";
export function useCommandDocs() {
  const db = useDatabase();
  return useQuery({
    queryKey: ["commands", db.id],
    queryFn: async ({ signal }) =>
      collection<CommandDoc>(
        await request<CommandDoc[] | Record<string, unknown>>(
          dbPath(db.id, "/commands"),
          { signal },
        ),
        "commands",
      ),
    staleTime: 300000,
  });
}
/** The command catalog's state for commandPolicy: a refetch after an error counts as loading again. */
export function catalogState(query: {
  data?: unknown;
  isError: boolean;
  isFetching: boolean;
}): CatalogState {
  return query.data ? "ready" : query.isFetching || !query.isError ? "loading" : "error";
}
const NOT_RUN: Partial<Record<string, string>> = {
  too_large: "Not run: the script's reply budget was used up.",
  timeout: "Not run: the script's time budget was used up.",
  unauthenticated: "Not run: your session ended or your account changed.",
};
/** Per-line workbench error with guidance; lines the server skipped say so first. */
export function workbenchLineError(error: ApiError["error"]) {
  const lead = NOT_RUN[error.code];
  const message = friendlyMessage(error);
  return new Error(
    lead && /not (been )?run|was not run|were not run/i.test(error.message)
      ? `${lead} ${error.message}`
      : message,
  );
}
/** Policy for the draft before it runs: class, destructive, blocked or needs confirmation, and why. */
export function PolicyBadge({
  line,
  docs,
  id,
  catalog = "ready",
  held = false,
}: {
  line: string;
  docs: CommandDoc[];
  id?: string;
  catalog?: CatalogState;
  /** Enter was pressed before the catalog loaded: the command runs when it arrives. */
  held?: boolean;
}) {
  const db = useDatabase();
  const policy = commandPolicy(line, docs, db, catalog);
  const confirmation =
    policy.allowed &&
    (policy.destructive ||
      (db.environment === "prod" && policy.class !== "read"));
  return (
    <div className="policy" data-testid="policy-badge" id={id}>
      <Badge
        tone={
          policy.class === "idle" || policy.pending
            ? ""
            : !policy.allowed || policy.destructive
              ? "red"
              : policy.class === "read"
                ? "blue"
                : "amber"
        }
      >
        {policy.class === "idle"
          ? "Ready"
          : policy.pending
            ? policy.class
            : `${policy.class}${policy.destructive ? " · destructive" : ""}${!policy.allowed && policy.class !== "blocked" ? " · blocked" : confirmation ? " · needs confirmation" : ""}`}
      </Badge>
      <span title={policy.hint}>
        {policy.pending && held && policy.class === "loading"
          ? `${LOADING_HINT} The command runs as soon as it has loaded.`
          : policy.hint}
      </span>
    </div>
  );
}
/** How long a Workbench cancel waits for the server's answer before closing the request instead. */
const CANCEL_GRACE_MS = 2000;
const isCommand = (line: string) => !!line.trim() && !/^\s*(#|\/\/)/.test(line);
const EMPTY_DOCS: CommandDoc[] = [];
/** A quiet, clickable key hint: the visible UI equivalent of a shortcut. */
function KeyHint({
  id,
  label,
  onClick,
  keys,
  disabled,
  ariaLabel,
  keepLabel,
}: {
  id: ShortcutId;
  label?: string;
  onClick: () => void;
  keys?: string;
  disabled?: boolean;
  ariaLabel?: string;
  /** Keep the label on narrow screens too. */
  keepLabel?: boolean;
}) {
  return (
    <button
      type="button"
      className={keepLabel ? "key-hint keep-label" : "key-hint"}
      onClick={onClick}
      disabled={disabled}
      title={shortcut(id).label}
      aria-label={ariaLabel}
    >
      <kbd>{keys ?? hint(id)}</kbd>
      {label && <span>{label}</span>}
    </button>
  );
}
/** The prompt: which database, its environment colour, your effective role (redis-cli's host:port>). */
export function Prompt({ id }: { id: string }) {
  const db = useDatabase();
  return (
    <div
      className="console-prompt"
      id={id}
      data-testid="console-prompt"
      data-environment={db.environment}
      data-readonly={db.readOnly ? "true" : undefined}
      title={`${db.name} · ${db.environment} · ${db.effectiveRole}${db.readOnly ? " · read-only" : ""}`}
    >
      <span className="prompt-db data">{visibleText(db.id)}</span>
      <span className="sr-only">{visibleText(db.name)}, </span>
      <EnvBadge environment={db.environment} />
      <span className="prompt-role">
        <span className="sr-only">role </span>
        {db.effectiveRole}
      </span>
      {db.readOnly && (
        <span className="prompt-readonly">
          <LockKeyhole size={11} aria-hidden="true" />
          read-only
        </span>
      )}
      <span className="prompt-caret" aria-hidden="true">
        ›
      </span>
    </div>
  );
}
interface Example {
  command: string;
  label: string;
}
function examples(recent: Bin[], workbench: boolean): Example[] {
  const key = recent.find((item) => item.enc === "utf8");
  const namespace = key?.data.includes(":")
    ? key.data.split(":")[0]
    : undefined;
  return [
    { command: "PING", label: "Check the connection" },
    { command: "DBSIZE", label: "Count keys" },
    {
      command: workbench ? "INFO keyspace" : "SCAN 0 COUNT 20",
      label: workbench ? "Keys and expiries per database" : "Browse a small batch of keys",
    },
    ...(namespace
      ? [
          {
            command: `SCAN 0 MATCH ${cliArg(`${namespace}:*`)} COUNT 100`,
            label: `Find keys under ${visibleText(namespace)}:`,
          },
        ]
      : []),
    ...(key
      ? [
          {
            command: `TYPE ${cliArg(key.data)}`,
            label: "What the key you last inspected holds",
          },
          { command: `TTL ${cliArg(key.data)}`, label: "Seconds until it expires" },
        ]
      : workbench
        ? []
        : [{ command: "INFO keyspace", label: "Keys and expiries per database" }]),
  ];
}
function Welcome({
  workbench,
  recent,
  onExample,
}: {
  workbench: boolean;
  recent: Bin[];
  onExample: (command: string) => void;
}) {
  const db = useDatabase();
  return (
    <div className="console-welcome">
      <h2>{workbench ? "Run several commands in order" : "Start with a safe read"}</h2>
      <p>
        {workbench ? (
          <>
            Write one command per line, then run the whole script with{" "}
            <kbd>{hint("runAll")}</kbd> or the current line with{" "}
            <kbd>{hint("runSelection")}</kbd>. Each line is checked against your
            role before anything runs.
          </>
        ) : (
          <>
            Commands run on <strong className="data">{visibleText(db.id)}</strong>{" "}
            as <strong>{db.effectiveRole}</strong>.{" "}
            {db.readOnly
              ? "This database is read-only, so only reads are allowed."
              : "Reads change nothing. Writes show their policy before you run them, and destructive commands ask you to confirm the exact keys."}
          </>
        )}
      </p>
      <ul className="console-examples">
        {examples(recent, workbench).map(({ command, label }) => (
          <li key={command}>
            <button type="button" onClick={() => onExample(command)}>
              <code>{visibleText(command)}</code>
              <span>{label}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="console-welcome-note">
        {workbench
          ? "Choosing an example adds it to the script."
          : "Choosing an example puts it on the prompt; press Enter to run it."}{" "}
        History and results live only in this tab's memory and are gone when
        you sign out or reload.
      </p>
    </div>
  );
}
function groupRuns(results: ConsoleResult[]) {
  // Stored newest first; a Workbench run is shown as one group in script order.
  const groups: ConsoleResult[][] = [];
  for (const result of results) {
    const last = groups.at(-1);
    if (last && result.runId && last[0]?.runId === result.runId)
      last.push(result);
    else groups.push([result]);
  }
  return groups.map((group) => group.reverse());
}
/** What a cancelled run did, line by line: finished, sent and maybe run, never sent. */
export function cancelledRunSummary(group: ConsoleResult[]) {
  const run = group[0]?.run;
  if (run?.cancelled === "declined") return "cancelled at the confirmation · nothing ran";
  if (run?.cancelled === "unknown") return "cancelled · which lines ran is unknown";
  const inFlight = group.find((item) => item.cancelled && item.lineNumber !== undefined);
  const finished = group.filter((item) => !item.cancelled).length;
  const notRun = (run?.total ?? group.length) - finished - (inFlight ? 1 : 0);
  return [
    "cancelled",
    `${finished} finished`,
    ...(inFlight ? [`line ${inFlight.lineNumber} may have run`] : []),
    `${notRun} not run`,
  ].join(" · ");
}
function RunHeader({ group }: { group: ConsoleResult[] }) {
  const errors = group.filter((item) => resultStatus(item) === "error").length;
  const cancelled = !!group[0]?.run?.cancelled || group.some((item) => item.cancelled);
  const total = group[0]?.run?.total ?? group.length;
  const notRun = total - group.length;
  const at = new Date(group[0]!.timestamp);
  return (
    <div className="run-header">
      <span>
        Run at{" "}
        {at.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
      </span>
      <span>
        {total} {total === 1 ? "command" : "commands"}
      </span>
      {cancelled ? (
        <span className="run-cancelled">{cancelledRunSummary(group)}</span>
      ) : errors ? (
        <span className="run-errors">
          {errors} {errors === 1 ? "error" : "errors"}
          {notRun > 0 ? ` · ${notRun} not run` : ""}
        </span>
      ) : (
        <span className="run-ok">all succeeded</span>
      )}
    </div>
  );
}
/**
 * The Console and Workbench pages. `docked`: the Console inside the bottom tools drawer (F27). It shares this
 * database's in-memory draft, history and results with the Console page, registers its shortcuts in its own scope
 * and uses its own test ids, and has a compact toolbar instead of the page title.
 */
export function Console({
  workbench = false,
  docked = false,
}: {
  workbench?: boolean;
  docked?: boolean;
}) {
  const db = useDatabase();
  const navigate = useNavigate();
  const commandDocs = useCommandDocs();
  const docs = commandDocs.data ?? EMPTY_DOCS;
  const catalog = catalogState(commandDocs);
  /** Enter before the command catalog loaded (v0.3 follow-up 7): run this once it arrives, unless the draft changed. */
  const held = useRef<{ input: string; fromLine: number; draft: string } | null>(null);
  const [holding, setHolding] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorHandle>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const promptId = useId();
  const policyId = useId();
  const memoryKey = `${db.id}:${workbench ? "workbench" : "console"}`;
  const [recentKeys] = useMemorySlot<Bin[]>(`${db.id}:recent-keys`, []);
  const [line, setLine] = useMemorySlot(
    memoryKey + ":draft",
    workbench ? "# Inspect this database\nPING\nDBSIZE" : "",
  );
  const [, setWorkbenchDraft] = useMemorySlot(
    `${db.id}:workbench:draft`,
    "# Inspect this database\nPING\nDBSIZE",
  );
  const [history, setHistory] = useMemorySlot<string[]>(
    memoryKey + ":history",
    [],
  );
  const [results, setResults] = useMemorySlot<ConsoleResult[]>(
    memoryKey + ":results",
    [],
  );
  const [snippets, setSnippets] = useMemorySlot<
    { name: string; script: string }[]
  >(`${db.id}:snippets`, []);
  // Key completion: keys seen in the key browser plus keys this page's SCANs returned (memory only).
  const completionKeys = useMemo(() => {
    const seen = new Set<string>();
    const out: Bin[] = [];
    for (const key of [
      ...results.flatMap((result) => scanKeys(result.response)),
      ...recentKeys,
    ]) {
      const id = `${key.enc}:${key.data}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(key);
      if (out.length >= 2000) break;
    }
    return out;
  }, [results, recentKeys]);
  const historyIndex = useRef(history.length);
  const draft = useRef("");
  const controller = useRef<AbortController | null>(null);
  /** Workbench: asks the server to stop the running script before its next line. */
  const stopRun = useRef<(() => void) | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cursorNumber, setCursorNumber] = useState(1);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState({ line: "", count: 0 });
  const [started, setStarted] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [cursorLine, setCursorLine] = useState("");
  const [cursorCommand, setCursorCommand] = useState("");
  const [view, setView] = useState<"terminal" | "tree">("terminal");
  const [search, setSearch] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [stopOnError, setStopOnError] = useState(true);
  const [lineStatuses, setLineStatuses] = useState<Record<number, string>>({});
  const policy = commandPolicy(line, docs, db, catalog);
  const scriptLines = line.split(/\r?\n/);
  const policies = scriptLines
    .map((value, index) => ({ value, number: index + 1 }))
    .filter((item) => isCommand(item.value))
    .map((item) => ({ ...item, ...commandPolicy(item.value, docs, db, catalog) }));
  const blocked = policies.find((item) => !item.allowed && !item.pending);
  /** Some command is still waiting for the catalog: Enter and Run hold it instead of refusing it. */
  const awaitingCatalog = (workbench ? policies : [policy]).some((item) => item.pending);
  const cursorPolicy = policies.find((item) => item.number === cursorNumber);
  const runnable = workbench
    ? !!policies.length && policies.length <= 100 && !blocked && !awaitingCatalog
    : policy.allowed;
  const destructive = (
    workbench ? policies : [{ ...policy, value: line, number: 1 }]
  ).filter((item) => item.allowed && item.destructive);
  const danger = destructive.length > 0;
  const prodWrite =
    db.environment === "prod" &&
    (workbench ? policies : [policy]).some(
      (item) => item.allowed && item.class !== "read",
    );
  const documentation = commandDoc(
    cursorCommand || (workbench ? (line.split("\n")[0] ?? "") : line),
    docs,
  );
  useEffect(() => {
    mounted.current = true;
    // Arriving by Option+2, the palette or a page load leaves nothing focused: be ready to type (UX R1).
    // Focus someone placed deliberately (a rail link, a field) stays where it is.
    if (!document.activeElement || document.activeElement === document.body)
      editor.current?.focus();
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    const waiting = held.current;
    if (!waiting || catalog === "loading") return;
    release();
    if (catalog === "error") setAnnouncement(`Not run. ${CATALOG_ERROR_HINT}`);
    else if (waiting.draft !== line)
      setAnnouncement("Command info has loaded. The command line changed, so nothing ran.");
    else void run(waiting.input, waiting.fromLine);
    // Runs when the catalog settles; `run` and `line` are read from that render.
  }, [catalog]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setElapsed(Date.now() - started), 100);
    return () => clearInterval(timer);
  }, [busy, started]);
  // The newest output sits next to the editor: at the bottom in the Console, at the top in the Workbench.
  useEffect(() => {
    const node = transcript.current;
    if (!node) return;
    node.scrollTop = workbench ? 0 : node.scrollHeight;
  }, [results, busy, view, workbench]);
  const focusEditor = () => editor.current?.focus();
  const release = () => {
    if (!held.current) return;
    held.current = null;
    setHolding(false);
  };
  const edit = (value: string) => {
    release();
    setLine(value);
    setCursorLine(value.split("\n").at(-1) ?? "");
    setCursorCommand(value.split("\n").at(-1) ?? "");
    setLineStatuses({});
    historyIndex.current = history.length;
  };
  const historyMove = (direction: -1 | 1) => {
    const step = historyStep(
      history,
      historyIndex.current,
      direction,
      line,
      draft.current,
    );
    historyIndex.current = step.index;
    draft.current = step.draft;
    setLine(step.value);
  };
  const clear = () => {
    if (transcript.current?.contains(document.activeElement)) focusEditor();
    setResults([]);
    setAnnouncement("Screen cleared. History is kept.");
  };
  /** Ctrl+C (with its key event) or the visible control (without): cancel, clear, or let copy happen. */
  const cancel = (event?: KeyboardEvent) => {
    const action = interruptAction({
      busy: !!controller.current,
      mac: isMac(),
      // Only the key press defers to copying a selection; the on-screen control always acts.
      hasSelection:
        !!event &&
        (!!editor.current?.hasSelection() ||
          (document.getSelection()?.toString().length ?? 0) > 0),
      workbench,
    });
    if (action === "copy" || action === "none") return false;
    if (action === "cancel") stopRunning();
    else {
      edit("");
      setAnnouncement("Command line cleared.");
    }
    focusEditor();
  };
  function stopRunning() {
    if (stopRun.current) stopRun.current();
    else controller.current?.abort();
  }
  const blocks = () => [
    ...(transcript.current?.querySelectorAll<HTMLElement>(
      '[data-testid="console-result"]',
    ) ?? []),
  ];
  const focusBlock = (direction: -1 | 1) => {
    const all = blocks();
    const target = blockTarget(
      all.length,
      all.findIndex(
        (block) =>
          block === document.activeElement ||
          block.contains(document.activeElement),
      ),
      direction,
      workbench ? "workbench" : "console",
    );
    if (target === "editor") focusEditor();
    else if (target !== undefined) {
      all[target]?.focus();
      all[target]?.scrollIntoView({ block: "nearest" });
    }
  };
  const copy = () => {
    const result = results[0];
    if (!result) {
      setAnnouncement("No result to copy yet.");
      return;
    }
    void navigator.clipboard
      .writeText(resultText(result))
      .then(() => setAnnouncement("Last result copied."))
      .catch(() =>
        setAnnouncement(
          "Clipboard unavailable. Select the result text to copy it.",
        ),
      );
  };
  useShortcuts(
    workbench ? "workbench-page" : docked ? "console-drawer" : "console-page",
    {
      clear,
      cancel: (event) => cancel(event),
      blockPrevious: () => focusBlock(-1),
      blockNext: () => focusBlock(1),
      copy,
    },
    root,
  );
  const run = async (input = line, fromLine = 1) => {
    if (controller.current || !input.trim()) return;
    const scriptLines = input
      .split(/\r?\n/)
      .map((value, index) => ({ value, number: fromLine + index }))
      .filter((item) => isCommand(item.value));
    const inputPolicies = workbench
      ? scriptLines.map((item) => commandPolicy(item.value, docs, db, catalog))
      : [commandPolicy(input, docs, db, catalog)];
    if (!inputPolicies.length) return;
    if (inputPolicies.length > 100) {
      setAnnouncement("Scripts are limited to 100 commands.");
      return;
    }
    // Before the catalog has loaded a command without a shared rule has no class yet: hold it and run it when the
    // catalog arrives, never refuse it as "unavailable" (v0.3 follow-up 7). The server decides either way.
    if (inputPolicies.some((item) => item.pending)) {
      held.current = { input, fromLine, draft: line };
      setHolding(true);
      if (catalog === "error") void commandDocs.refetch();
      setAnnouncement(`${LOADING_HINT} The command runs as soon as it has loaded.`);
      return;
    }
    release();
    const denied = inputPolicies.find((item) => !item.allowed);
    if (denied) {
      setAnnouncement(`Not run. ${denied.hint}`);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    const timestamp = Date.now();
    const runId = crypto.randomUUID();
    const runInfo = { total: scriptLines.length };
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (fallback !== undefined || abort.signal.aborted) return;
      setCancelling(true);
      setAnnouncement("Cancelling. No further line will be sent.");
      // The server answers at once with what ran. If it cannot be told, or does not answer, close the
      // request: the server also stops before the next line when its client goes away.
      fallback = setTimeout(() => abort.abort(), CANCEL_GRACE_MS);
      request<WorkbenchCancelResponse>(dbPath(db.id, "/workbench/cancel"), {
        method: "POST",
        body: {},
      }).catch(() => abort.abort());
    };
    if (workbench) stopRun.current = stop;
    setStarted(timestamp);
    setElapsed(0);
    setPending({ line: workbench ? (scriptLines[0]?.value ?? input) : input, count: scriptLines.length });
    setBusy(true);
    setAnnouncement(
      workbench ? `Running ${scriptLines.length} commands.` : "Command running.",
    );
    if (workbench)
      setLineStatuses(
        Object.fromEntries(scriptLines.map((item) => [item.number, "running"])),
      );
    setHistory((previous) => {
      const next = [...previous.filter((item) => item !== input), input].slice(
        -200,
      );
      historyIndex.current = next.length;
      return next;
    });
    draft.current = "";
    try {
      const response = await request<CliResponse | WorkbenchResponse>(
        dbPath(db.id, workbench ? "/workbench" : "/cli"),
        {
          method: "POST",
          body: workbench ? { script: input, stopOnError } : { line: input },
          signal: abort.signal,
        },
      );
      if (abort.signal.aborted) throw new DOMException("Request cancelled", "AbortError");
      if ("results" in response) {
        const statuses: Record<number, string> = Object.fromEntries(
          scriptLines.map((item) => [item.number, "not run"]),
        );
        const run: ConsoleResult["run"] = response.cancelled
          ? { ...runInfo, cancelled: "stopped" }
          : runInfo;
        const entries = response.results.map((result, index): ConsoleResult => {
          const error =
            "error" in result ? workbenchLineError(result.error) : undefined;
          const status =
            error || ("reply" in result && result.reply.t === "err")
              ? "error"
              : "success";
          if (scriptLines[index]) statuses[scriptLines[index]!.number] = status;
          return {
            id: crypto.randomUUID(),
            runId,
            run,
            lineNumber: scriptLines[index]?.number,
            timestamp,
            durationMs: Date.now() - timestamp,
            line:
              scriptLines[index]?.value ??
              ("line" in result ? result.line : result.argv.join(" ")),
            ...("reply" in result ? { response: result } : { error }),
          };
        });
        const finished = entries.length;
        // Cancelled: the line after the finished ones may have been running; nothing after it was sent.
        const inFlight = response.cancelled?.inFlight
          ? scriptLines[finished]
          : undefined;
        if (inFlight) statuses[inFlight.number] = "may have run";
        if (response.cancelled && (inFlight || !finished))
          entries.push({
            id: crypto.randomUUID(),
            runId,
            run,
            lineNumber: inFlight?.number,
            timestamp,
            durationMs: Date.now() - timestamp,
            line: inFlight?.value ?? input,
            cancelled: true,
            cancelNote: inFlight
              ? "Cancelled while this command was running. Redis may have run it: check before running it again. No later line was sent."
              : "Cancelled before the first line was sent. Nothing ran.",
          });
        setLineStatuses(statuses);
        setResults((previous) =>
          [...[...entries].reverse(), ...previous].slice(0, 100),
        );
        const errors = entries.filter(
          (item) => resultStatus(item) === "error",
        ).length;
        const skipped = scriptLines.length - entries.length;
        // Preference (F26): a whole script that ran without errors leaves an empty editor. A selection never does.
        if (getPreferences().clearWorkbenchAfterRun && !response.cancelled && !errors && skipped <= 0)
          setLine((previous) => (previous === input ? "" : previous));
        setAnnouncement(
          response.cancelled
            ? `Cancelled. ${finished} of ${scriptLines.length} finished${inFlight ? `; line ${inFlight.number} was running and may have run` : ""}; ${scriptLines.length - finished - (inFlight ? 1 : 0)} not run.`
            : `${entries.length} of ${scriptLines.length} commands ran. ${errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : "No errors"}${skipped > 0 ? `; ${skipped} not run` : ""}.`,
        );
        const ended = response.results.find(
          (result) =>
            "error" in result && result.error.code === "unauthenticated",
        );
        if (ended && "error" in ended) endSession(ended.error.message);
      } else {
        setResults((previous) =>
          [
            {
              id: crypto.randomUUID(),
              line: input,
              response,
              timestamp,
              durationMs: Date.now() - timestamp,
            },
            ...previous,
          ].slice(0, 100),
        );
        // Do not discard a new draft the user typed while the request was in flight.
        setLine((previous) => (previous === input ? "" : previous));
        setAnnouncement(
          response.reply.t === "err"
            ? `Redis returned an error in ${response.durationMs.toFixed(2)} ms: ${replySummary(response.reply)}`
            : `Completed in ${response.durationMs.toFixed(2)} ms: ${replySummary(response.reply)}`,
        );
      }
    } catch (error) {
      // The transcript is session memory: record uncertain outcomes even after navigation unmounts this view.
      // Aborted in flight, or declined at the confirmation (nothing was sent then).
      const aborted = abort.signal.aborted;
      const cancelled =
        aborted || (error instanceof Error && /cancelled/i.test(error.message));
      const cancelNote = !cancelled
        ? undefined
        : !aborted
          ? "Cancelled at the confirmation. Nothing was run."
          : workbench
            ? "Cancelled before the server answered, so which lines ran is unknown. No line is sent after the server sees the request gone; lines already sent may have run. Check with a read before running the script again."
            : "Request cancelled before the server answered. Redis may still complete a command it already received; check with a read before running it again.";
      setResults((previous) =>
        [
          {
            id: crypto.randomUUID(),
            runId: workbench ? runId : undefined,
            run: workbench
              ? {
                  ...runInfo,
                  ...(cancelled
                    ? { cancelled: aborted ? ("unknown" as const) : ("declined" as const) }
                    : {}),
                }
              : undefined,
            line: input,
            timestamp,
            durationMs: Date.now() - timestamp,
            error: cancelled ? undefined : error,
            cancelled,
            cancelNote,
          },
          ...previous,
        ].slice(0, 100),
      );
      if (workbench)
        setLineStatuses(
          Object.fromEntries(
            scriptLines.map((item) => [
              item.number,
              !cancelled ? "error" : aborted ? "unknown" : "not run",
            ]),
          ),
        );
      setAnnouncement(
        !cancelled
          ? `Not completed: ${error instanceof Error ? error.message : "the request failed"}`
          : !aborted
            ? "Cancelled at the confirmation. Nothing was run."
            : workbench
              ? "Cancelled. Which lines ran is unknown; no further line is sent."
              : "Request cancelled. Redis may still complete a command it already received.",
      );
    } finally {
      clearTimeout(fallback);
      if (stopRun.current === stop) stopRun.current = null;
      if (controller.current === abort) controller.current = null;
      if (mounted.current) {
        setBusy(false);
        setCancelling(false);
        if (document.activeElement === document.body) focusEditor();
      }
    }
  };
  const closeSearch = () => {
    setSearch(false);
    focusEditor();
  };
  const insertExample = (command: string) => {
    if (workbench) edit(line.trim() ? `${line.replace(/\n+$/, "")}\n${command}` : command);
    else edit(command);
    focusEditor();
  };
  const runSelection = () => {
    const selected = editor.current?.selection();
    if (selected) void run(selected.text, selected.fromLine);
  };
  const ordered = workbench
    ? groupRuns(results)
    : [[...results].reverse()];
  const cancelHint = hint("cancel");
  const runningBlock = busy ? (
    <RunningBlock
      line={pending.line}
      count={workbench ? pending.count : undefined}
      docs={docs}
      elapsed={elapsed}
      cancelHint={cancelHint}
      cancelling={cancelling}
      onCancel={() => {
        stopRunning();
        focusEditor();
      }}
    />
  ) : null;
  const dangerMessage = danger ? (
    <p className="console-danger-message" role="status">
      <TriangleAlert size={14} aria-hidden="true" />
      <span>
        {workbench
          ? `${destructive.length === 1 ? "Line" : "Lines"} ${destructive.map((item) => item.number).join(", ")} ${destructive.length === 1 ? "is" : "are"} destructive. `
          : "Destructive command. "}
        {destructive.some((item) => item.doc?.name === "FLUSHDB")
          ? "You will type the database name to confirm before anything is deleted."
          : "The server lists exactly what will change and asks you to confirm before it runs."}
      </span>
    </p>
  ) : prodWrite ? (
    <p className="console-danger-message is-prod" role="status">
      <TriangleAlert size={14} aria-hidden="true" />
      <span>
        Production database. Every change asks for a confirmation and a reason.
      </span>
    </p>
  ) : null;
  const assist = (
    <ConsoleAssist
      line={line}
      cursorLine={cursorLine}
      cursorFull={cursorCommand}
      docs={docs}
      workbench={workbench}
      status={announcement}
      onEdit={(value) => {
        edit(value);
        focusEditor();
      }}
      onDocs={() => setShowDocs(true)}
      onWorkbench={
        workbench
          ? undefined
          : () => {
              setWorkbenchDraft(line);
              navigate(`/db/${encodeURIComponent(db.id)}/workbench`);
            }
      }
    />
  );
  const editorElement = (
    <Editor
      value={line}
      onChange={edit}
      onRun={() => {
        void run();
      }}
      onRunSelection={(selection) => {
        void run(selection.text, selection.fromLine);
      }}
      docs={docs}
      keys={completionKeys}
      history={history}
      editorRef={editor}
      onCursor={(before, fullLine, lineNumber) => {
        setCursorLine(before);
        setCursorCommand(fullLine);
        setCursorNumber(lineNumber);
      }}
      multiline={workbench}
      label={workbench ? "Workbench script" : "Redis command"}
      describedBy={`${promptId} ${policyId}${workbench ? ` ${policyId}-line` : ""}`}
      testId={workbench ? "workbench-editor" : docked ? "drawer-console-editor" : "console-editor"}
      onHistory={historyMove}
      onSearch={() => setSearch(true)}
      onDocs={() => setShowDocs(true)}
      linePolicy={(value) => commandPolicy(value, docs, db, catalog)}
      lineStatuses={lineStatuses}
    />
  );
  const runButton = (
    <button
      className={`primary console-run-button ${danger || prodWrite ? "danger" : ""}`.trim()}
      onClick={() => {
        void run();
      }}
      disabled={busy || !line.trim() || (!runnable && !awaitingCatalog)}
      data-testid={workbench ? "workbench-run" : docked ? "drawer-console-run" : "console-run"}
      title={
        danger || prodWrite
          ? "Runs after you confirm in the next step"
          : undefined
      }
    >
      {workbench ? (
        <Play size={14} aria-hidden="true" />
      ) : (
        <CornerDownLeft size={14} aria-hidden="true" />
      )}
      {workbench ? "Run script" : "Run"}
      {danger || prodWrite ? "…" : ""}
      <kbd>{hint(workbench ? "runAll" : "run")}</kbd>
    </button>
  );
  const resultsCount = results.length;
  const toolbarActions = (
    <>
            <div
              className="console-reply-view segmented"
              role="group"
              aria-label="Reply view"
            >
              <button
                type="button"
                aria-pressed={view === "terminal"}
                onClick={() => setView("terminal")}
                data-testid="reply-view-terminal"
              >
                Transcript
              </button>
              <button
                type="button"
                aria-pressed={view === "tree"}
                onClick={() => setView("tree")}
                data-testid="reply-view-tree"
              >
                Tree / table
              </button>
            </div>
            <span className="toolbar-sep" aria-hidden="true" />
            <KeyHint
              id="blockPrevious"
              keys={hint("blockPrevious")}
              label="previous"
              ariaLabel="Previous result"
              onClick={() => focusBlock(-1)}
              disabled={!resultsCount}
            />
            <KeyHint
              id="blockNext"
              keys={hint("blockNext")}
              label="next"
              ariaLabel="Next result"
              onClick={() => focusBlock(1)}
              disabled={!resultsCount}
            />
            <KeyHint
              id="copy"
              label="copy last"
              ariaLabel="Copy last result"
              onClick={copy}
              disabled={!resultsCount}
            />
            <span className="toolbar-sep" aria-hidden="true" />
            <button
              type="button"
              className="ghost"
              onClick={clear}
              data-testid="console-clear"
              title="Clear the screen; history is kept"
            >
              Clear screen <kbd>{hint("clear")}</kbd>
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                clear();
                setHistory([]);
                historyIndex.current = 0;
                setAnnouncement("Screen and history cleared.");
              }}
            >
              Clear history
            </button>
    </>
  );
  return (
    <div
      ref={root}
      className={`workspace console-view ${workbench ? "is-workbench" : "is-console"}${docked ? " is-docked" : ""}`}
      data-danger={danger || undefined}
    >
      {docked ? (
        <div className="console-docked-bar" role="toolbar" aria-label="Console">
          <span className="meta" data-testid="drawer-console-meta" title="Shared with the Console page and kept in this tab's memory only">
            {resultsCount} {resultsCount === 1 ? "result" : "results"} · {history.length} in history · shared with the
            Console page
          </span>
          <span className="actions">
            {toolbarActions}
          </span>
        </div>
      ) : (
        <PageTitle
        title={workbench ? "Workbench" : "Console"}
        description={
          workbench
            ? "Runs line by line; changes from earlier lines stay if a later line fails."
            : `${resultsCount} ${resultsCount === 1 ? "result" : "results"} · ${history.length} in history · kept in this tab's memory only`
        }
        actions={
          <>
            {toolbarActions}
          </>
        }
      />
      )}
      {workbench && (
        <section
          className={`workbench-pane ${danger ? "is-danger" : ""}`.trim()}
          aria-label="Script"
        >
          <header className="pane-head workbench-head">
            <Prompt id={promptId} />
            <div
              className="policy script-policy"
              data-testid="workbench-policy"
              id={policyId}
            >
              <Badge tone={blocked ? "red" : danger ? "red" : "blue"}>
                {policies.length} {policies.length === 1 ? "command" : "commands"}
              </Badge>
              <span>
                {policies.length > 100
                  ? "Scripts are limited to 100 commands."
                  : blocked
                    ? `Line ${blocked.number}: ${blocked.hint}`
                    : awaitingCatalog
                      ? holding
                        ? `${LOADING_HINT} The script runs as soon as it has loaded.`
                        : catalog === "error"
                          ? CATALOG_ERROR_HINT
                          : LOADING_HINT
                      : summary(policies)}
              </span>
            </div>
            <div className="workbench-snippets">
              <label className="sr-only" htmlFor={`${promptId}-snippets`}>
                Session snippets
              </label>
              <select
                id={`${promptId}-snippets`}
                aria-label="Session snippets"
                value=""
                onChange={(event) => {
                  const snippet = snippets[Number(event.target.value)];
                  if (snippet) edit(snippet.script);
                }}
              >
                <option value="" disabled>
                  {snippets.length
                    ? `Snippets (${snippets.length})`
                    : "No snippets yet"}
                </option>
                {snippets.map((snippet, index) => (
                  <option key={index} value={index}>
                    {snippet.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ghost"
                disabled={!line.trim() || snippets.length >= 10}
                onClick={() => {
                  setSnippets((previous) => [
                    ...previous,
                    { name: `Snippet ${previous.length + 1}`, script: line },
                  ]);
                  setAnnouncement(
                    `Saved as snippet ${snippets.length + 1} (this tab only).`,
                  );
                }}
                title="Kept in this tab's memory only"
              >
                Save snippet
              </button>
              <button
                type="button"
                className="ghost"
                disabled={!snippets.length}
                onClick={() => setSnippets([])}
              >
                Clear snippets
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => navigate("../guided?tab=tutorials")}
                title="Offline tutorials and recipes whose commands you can insert here"
                data-testid="workbench-tutorials"
              >
                Tutorials
              </button>
            </div>
          </header>
          {editorElement}
          {/* The gutter is aria-hidden (CodeMirror); its per-line policy and status are read from here. */}
          <p className="sr-only" id={`${policyId}-line`} data-testid="workbench-cursor-line">
            {cursorPolicy
              ? `Line ${cursorPolicy.number}: ${lineMarkerLabel(lineStatuses[cursorPolicy.number], cursorPolicy)}`
              : `Line ${cursorNumber}: no command.`}
          </p>
          <ol
            className="sr-only"
            aria-label="Script lines and their status"
            data-testid="workbench-line-status"
          >
            {policies.map((item) => (
              <li key={item.number}>
                Line {item.number}, {visibleText(item.value.trim().slice(0, 80))}:{" "}
                {lineMarkerLabel(lineStatuses[item.number], item)}
              </li>
            ))}
          </ol>
          {dangerMessage}
          {assist}
          <footer className="workbench-foot">
            <span className="key-hints">
              <KeyHint
                id="complete"
                label="complete"
                onClick={() => {
                  editor.current?.complete();
                  focusEditor();
                }}
              />
              <KeyHint
                id="accept"
                label="accept"
                onClick={() => {
                  editor.current?.accept();
                  focusEditor();
                }}
              />
              <KeyHint
                id="escape"
                label="dismiss"
                onClick={() => {
                  editor.current?.dismiss();
                  focusEditor();
                }}
              />
            </span>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={stopOnError}
                onChange={(event) => setStopOnError(event.target.checked)}
              />
              Stop on first error
            </label>
            {busy && (
              <button
                type="button"
                className="ghost"
                onClick={() => cancel()}
                data-testid="console-cancel"
              >
                Cancel request <kbd>{cancelHint}</kbd>
              </button>
            )}
            <button
              type="button"
              onClick={runSelection}
              disabled={busy || !line.trim()}
            >
              Run line / selection <kbd>{hint("runSelection")}</kbd>
            </button>
            {runButton}
          </footer>
        </section>
      )}
      <ErrorState error={commandDocs.error} />
      <div
        ref={transcript}
        className={`console-transcript view-${view}`}
        data-testid={docked ? "drawer-console-results" : "console-results"}
        aria-label="Results"
        role="region"
        onKeyDown={(event) => {
          // Esc on a focused result, or on any action inside it, returns to the editor (the result keeps
          // its place). A control that handles Esc itself prevents the default first.
          if (
            event.key === "Escape" &&
            !event.defaultPrevented &&
            event.target instanceof Element &&
            event.target.closest('[data-testid="console-result"]')
          ) {
            event.preventDefault();
            focusEditor();
          }
        }}
      >
        {workbench && runningBlock}
        {resultsCount ? (
          ordered.map((group) =>
            workbench ? (
              <div className="run-group" key={group[0]!.id}>
                <RunHeader group={group} />
                {group.map((result) => (
                  <ConsoleResultBlock
                    key={result.id}
                    result={result}
                    view={view}
                    docs={docs}
                    busy={busy}
                    onRerun={(value) => {
                      void run(value, result.lineNumber ?? 1);
                    }}
                  />
                ))}
              </div>
            ) : (
              group.map((result) => (
                <ConsoleResultBlock
                  key={result.id}
                  result={result}
                  view={view}
                  docs={docs}
                  busy={busy}
                  onRerun={(value) => {
                    void run(value);
                  }}
                  onDraft={(value) => {
                    edit(value);
                    focusEditor();
                  }}
                />
              ))
            ),
          )
        ) : busy ? null : (
          <Welcome
            workbench={workbench}
            recent={recentKeys}
            onExample={insertExample}
          />
        )}
        {!workbench && runningBlock}
      </div>
      {!workbench && (
        <section
          className={`console-dock ${danger ? "is-danger" : ""} ${prodWrite ? "is-prod" : ""}`.trim()}
          aria-label="Command prompt"
        >
          {search && (
            <HistorySearch
              history={history}
              onChoose={(value) => {
                edit(value);
                closeSearch();
              }}
              onClose={closeSearch}
            />
          )}
          {assist}
          {dangerMessage}
          <div className="console-prompt-row">
            <Prompt id={promptId} />
            {editorElement}
            {runButton}
          </div>
          <footer className="console-dock-foot">
            <PolicyBadge line={line} docs={docs} id={policyId} catalog={catalog} held={holding} />
            <span className="key-hints">
              <KeyHint
                id="newline"
                label="newline"
                onClick={() => {
                  editor.current?.newline();
                  focusEditor();
                }}
              />
              <span className="key-hint-pair">
                <KeyHint
                  id="previous"
                  ariaLabel="Previous command in history"
                  onClick={() => {
                    historyMove(-1);
                    focusEditor();
                  }}
                  disabled={!history.length}
                />
                <KeyHint
                  id="next"
                  ariaLabel="Next command in history"
                  label="history"
                  onClick={() => {
                    historyMove(1);
                    focusEditor();
                  }}
                  disabled={!history.length}
                />
              </span>
              <KeyHint
                id="search"
                label="search"
                keepLabel
                onClick={() => setSearch(true)}
              />
              <KeyHint
                id="complete"
                label="complete"
                onClick={() => {
                  editor.current?.complete();
                  focusEditor();
                }}
              />
              <KeyHint
                id="accept"
                label="accept"
                onClick={() => {
                  editor.current?.accept();
                  focusEditor();
                }}
              />
              <KeyHint
                id="escape"
                label="dismiss / clear"
                onClick={() => {
                  editor.current?.dismiss();
                  focusEditor();
                }}
              />
              <button
                type="button"
                className={`key-hint keep-label ${busy ? "is-active" : ""}`.trim()}
                onClick={() => cancel()}
                data-testid="console-cancel"
                title={shortcut("cancel").label}
              >
                <kbd>{cancelHint}</kbd>
                <span>{busy ? "cancel request" : "clear line"}</span>
              </button>
            </span>
          </footer>
        </section>
      )}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="console-announcement"
      >
        {announcement}
      </p>
      {showDocs && (
        <Modal
          title="Command documentation"
          testId="command-docs-dialog"
          onClose={() => {
            setShowDocs(false);
            requestAnimationFrame(focusEditor);
          }}
        >
          {documentation ? (
            <CommandDocumentation
              doc={documentation}
              policy={commandPolicy(
                cursorCommand || documentation.name,
                docs,
                db,
                catalog,
              )}
            />
          ) : (
            <p>
              Type a command, or choose a completion, to see its arguments,
              complexity and what the policy allows here.
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                setShowDocs(false);
                requestAnimationFrame(focusEditor);
              }}
            >
              Back to the editor <kbd>Esc</kbd>
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
/** "2 read · 1 write" — what the script will do, before it runs. */
function summary(policies: { class: string }[]): ReactNode {
  if (!policies.length) return "Write one command per line.";
  const counts = new Map<string, number>();
  for (const item of policies)
    counts.set(item.class, (counts.get(item.class) ?? 0) + 1);
  return `${[...counts].map(([name, count]) => `${count} ${name}`).join(" · ")}. Every line is checked against your role and database.`;
}
