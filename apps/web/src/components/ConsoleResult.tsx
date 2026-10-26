import { parseJson } from "../lib/json.ts";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  RotateCw,
} from "lucide-react";
import {
  type Bin,
  type CliResponse,
  type CommandDoc,
  type Reply,
  binFromBytes,
  tokenizeCommandLineBytes,
} from "@rconsole/shared";
import { copyCode } from "../lib/console/copyCode.ts";
import { KeyName } from "./anatomy.tsx";
import { ErrorState, JsonTree } from "./ui.tsx";
import { cliReply, ReplyView } from "./Reply.tsx";
import { commandPolicy } from "../lib/policy.ts";
import { analyzeCommand, lex } from "../lib/console/language.ts";
import { bytesLabel, cliDisplayLine, cliKey, displayBin, visibleText } from "../lib/format.ts";
import { useMemorySlot } from "../lib/memory.tsx";
import { useDatabase } from "../lib/context.tsx";
import { RICH_LABEL, richKind } from "../lib/richReply.ts";
import { RichReply } from "./RichReply.tsx";
export interface ConsoleResult {
  id: string;
  line: string;
  timestamp: number;
  durationMs: number;
  response?: CliResponse;
  error?: unknown;
  cancelled?: boolean;
  /** What a cancelled block says happened (default: the single-command abort note). */
  cancelNote?: string;
  /** Workbench: results of one script run share a run id and keep their script line number. */
  runId?: string;
  lineNumber?: number;
  /**
   * Workbench: the run's command count and how it was cancelled: by the server between lines ("stopped",
   * exact), before the server answered ("unknown": which lines ran is not known), or at the confirmation.
   */
  run?: { total: number; cancelled?: "stopped" | "unknown" | "declined" };
}
export type ResultStatus = "success" | "error" | "cancelled";
export function resultStatus(result: ConsoleResult): ResultStatus {
  return result.cancelled
    ? "cancelled"
    : result.error || result.response?.reply.t === "err"
      ? "error"
      : "success";
}
/** Commands whose text reply redis-cli prints raw (line by line) rather than as a quoted string. */
const RAW_TEXT =
  /^(INFO|LOLWUT|(CLIENT (LIST|INFO))|(CLUSTER (INFO|NODES))|((MEMORY|LATENCY) DOCTOR))$/;
export function isRawText(argv: readonly string[]) {
  const name = (argv[0] ?? "").toUpperCase();
  return RAW_TEXT.test(name) || RAW_TEXT.test(`${name} ${(argv[1] ?? "").toUpperCase()}`);
}
/** The reply as redis-cli shows it; INFO-style text keeps its lines (invisible characters escaped). */
export function replyText(response: CliResponse) {
  const reply = response.reply;
  return isRawText(response.argv) && reply.t === "str" && reply.v.enc === "utf8"
    ? visibleText(reply.v.data.replace(/\r\n/g, "\n").replace(/\n$/, ""))
    : cliReply(reply);
}
export function resultText(result: ConsoleResult) {
  return result.cancelled
    ? (result.cancelNote ??
        "Cancelled. The request was aborted; a command already received by Redis may still complete.")
    : result.response
      ? replyText(result.response)
      : result.error instanceof Error
        ? result.error.message
        : String(result.error ?? "");
}
/** One short line about a reply, for the collapsed header and screen-reader announcements. */
export function replySummary(reply: Reply): string {
  switch (reply.t) {
    case "arr":
    case "set":
      return reply.v.length
        ? `${reply.t === "set" ? "set" : "array"} of ${reply.v.length.toLocaleString()}${reply.more ? "+" : ""} ${reply.v.length === 1 ? "item" : "items"}`
        : `empty ${reply.t === "set" ? "set" : "array"}`;
    case "map":
      return reply.v.length
        ? `map of ${reply.v.length.toLocaleString()}${reply.more ? "+" : ""} ${reply.v.length === 1 ? "pair" : "pairs"}`
        : "empty map";
    default: {
      const text = cliReply(reply).replace(/\s+/g, " ");
      return text.length > 120 ? `${text.slice(0, 119)}…` : text;
    }
  }
}
const ABSENT_KEY = "The key does not exist.";
/**
 * A quiet explanation of replies whose meaning is a Redis convention ((nil), TTL -1/-2, an empty XINFO
 * GROUPS). The raw reply stays as it is; this only says what it means.
 */
export function replyExplanation(response: CliResponse): string | undefined {
  const [name = "", sub = ""] = response.argv.map((word) => word.toUpperCase());
  const reply = response.reply;
  if (reply.t === "nil") {
    if (["GET", "GETDEL", "GETEX", "GETRANGE", "JSON.GET", "DUMP"].includes(name))
      return ABSENT_KEY;
    if (["HGET", "HGETDEL", "HGETEX"].includes(name))
      return "The field or the key does not exist.";
    if (["LPOP", "RPOP", "LINDEX", "SPOP", "SRANDMEMBER", "LMOVE", "RPOPLPUSH"].includes(name))
      return "Nothing there: the key is empty or does not exist.";
    if (/^B(L|R|Z)(POP|MPOP|MOVE)|^BRPOPLPUSH$|^BZPOP(MIN|MAX)$/.test(name))
      return "Timed out with nothing to pop.";
    if (name === "ZSCORE" || name === "ZRANK" || name === "ZREVRANK")
      return "The member or the key does not exist.";
    return undefined;
  }
  if (reply.t === "int" && /^(P?TTL|P?EXPIRETIME)$/.test(name))
    return reply.v === "-1"
      ? "The key exists and has no expiry."
      : reply.v === "-2"
        ? ABSENT_KEY
        : undefined;
  if (name === "TYPE" && reply.t === "str" && reply.v.data === "none")
    return ABSENT_KEY;
  if (name === "XINFO" && sub === "GROUPS" && reply.t === "arr" && !reply.v.length)
    return "The stream has no consumer groups.";
  return undefined;
}
/** The command as typed, coloured by argument role like the editor (text nodes only). */
export function CommandEcho({
  line,
  docs,
  limit = 500,
}: {
  line: string;
  docs: CommandDoc[];
  limit?: number;
}) {
  const display = cliDisplayLine(line);
  const shown = display.length > limit ? display.slice(0, limit) : display;
  const analysis = analyzeCommand(shown, docs);
  const parts: ReactNode[] = [];
  let at = 0;
  analysis.tokens.forEach((token, index) => {
    if (token.from > at) parts.push(visibleText(shown.slice(at, token.from)));
    parts.push(
      <span
        key={index}
        className={[
          `console-token-${token.role}`,
          token.role === "key" && analysis.family ? `t-${analysis.family}` : "",
          token.invalid ? "console-token-invalid" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {visibleText(shown.slice(token.from, token.to))}
      </span>,
    );
    at = token.to;
  });
  if (at < shown.length) parts.push(visibleText(shown.slice(at)));
  if (shown.length < display.length) parts.push("…");
  return <>{parts}</>;
}
/** Keys named in the command's key positions (COMMAND key specs / docs), binary-safe. */
function commandKeys(line: string, docs: CommandDoc[]) {
  const keys: Bin[] = [];
  try {
    const argv = tokenizeCommandLineBytes(line);
    analyzeCommand(line, docs).tokens.forEach((token, i) => {
      if (token.role === "key" && argv[i]) keys.push(binFromBytes(argv[i]!));
    });
  } catch {
    /* No key navigation for an invalid draft. */
  }
  return keys;
}
/** Keys a SCAN reply returned (for completion; kept in session memory like the results). */
export function scanKeys(response?: CliResponse): Bin[] {
  return scanReply(response)?.keys ?? [];
}
function scanReply(response?: CliResponse) {
  if (
    response?.argv[0]?.toUpperCase() !== "SCAN" ||
    response.reply.t !== "arr" ||
    response.reply.v[0]?.t !== "str" ||
    response.reply.v[1]?.t !== "arr"
  )
    return undefined;
  return {
    cursor: response.reply.v[0].v.data,
    keys: response.reply.v[1].v.flatMap((item) =>
      item.t === "str" ? [item.v] : [],
    ),
  };
}
const unique = (keys: Bin[]) =>
  keys.filter(
    (key, i) =>
      keys.findIndex(
        (other) => other.enc === key.enc && other.data === key.data,
      ) === i,
  );
/** The draft that continues a SCAN from the cursor Redis returned (never run automatically). */
export function continueScanLine(line: string, cursor: string) {
  const second = lex(line)[1];
  return second && /^\d+$/.test(cursor)
    ? line.slice(0, second.from) + cursor + line.slice(second.to)
    : undefined;
}
const FOLD_LINES = 40;
const FOLDED_LINES = 24;
const FOLD_CHARS = 6000;
const FOLDED_CHARS = 2400;
/** "Show all" renders at most this many characters; the rest is named, and Copy result still copies everything. */
export const SHOW_ALL_CHARS = 2_000_000;
export function TranscriptReply({ response }: { response: CliResponse }) {
  const [all, setAll] = useState(false);
  const reply = response.reply;
  const text = replyText(response);
  const lines = text.split("\n");
  const byLines = lines.length > FOLD_LINES;
  const folded = !all && (byLines || text.length > FOLD_CHARS);
  const shown = byLines
    ? lines.slice(0, FOLDED_LINES).join("\n")
    : `${text.slice(0, FOLDED_CHARS)}…`;
  const capped = text.length > SHOW_ALL_CHARS;
  const whole = capped
    ? `${text.slice(0, SHOW_ALL_CHARS)}\n… ${(text.length - SHOW_ALL_CHARS).toLocaleString()} more characters not shown (Copy result copies all)`
    : text;
  return (
    <>
      <pre
        className={`data cli-reply ${reply.t === "err" ? "error-text" : ""}`.trim()}
      >
        {folded ? shown : whole}
      </pre>
      {folded && (
        <button
          type="button"
          className="result-more"
          onClick={() => setAll(true)}
        >
          {capped
            ? `Show the first ${SHOW_ALL_CHARS.toLocaleString()} of ${text.length.toLocaleString()} characters`
            : byLines
              ? `Show all ${lines.length.toLocaleString()} lines`
              : `Show all ${text.length.toLocaleString()} characters`}
        </button>
      )}
    </>
  );
}
/** A string reply that is one whole JSON object or array (cached API payloads), parsed as data only. */
export function jsonDocument(reply: Reply): unknown {
  if (reply.t !== "str" || reply.v.enc !== "utf8") return undefined;
  const text = reply.v.data.replace(/^[ \t\r\n]+/, "");
  if (text.length > 512 * 1024 || !/^[[{]/.test(text)) return undefined;
  try {
    return parseJson(text);
  } catch {
    return undefined;
  }
}
function TreeReply({ reply }: { reply: Reply }) {
  const json = jsonDocument(reply);
  return json === undefined ? (
    <ReplyView reply={reply} />
  ) : (
    <div className="result-json">
      <span className="result-keys-label">JSON string, shown as a tree</span>
      <JsonTree value={json} />
    </div>
  );
}
function KeyLink({
  name,
  onOpen,
  tabIndex,
  onFocus,
}: {
  name: Bin;
  onOpen: (key: Bin) => void;
  tabIndex?: number;
  onFocus?: () => void;
}) {
  // Binary keys read as their escaped bytes (\xff…), exactly as the inspector shows them.
  const text = displayBin(name, 200);
  return (
    <button
      type="button"
      className="key-link data"
      aria-label={`Open key ${text}`}
      title="Open in the key browser"
      onClick={() => onOpen(name)}
      tabIndex={tabIndex}
      onFocus={onFocus}
    >
      <KeyName name={name} limit={200} />
    </button>
  );
}
function ScanTranscript({
  scan,
  onOpen,
}: {
  scan: { cursor: string; keys: Bin[] };
  onOpen: (key: Bin) => void;
}) {
  const [all, setAll] = useState(false);
  // One Tab stop for the whole key list; ↑/↓, Home and End move within it (review round 1, UX 3).
  const [current, setCurrent] = useState(0);
  const shown = all ? scan.keys : scan.keys.slice(0, 50);
  const move = (event: KeyboardEvent<HTMLOListElement>) => {
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity };
    if (!(event.key in step) || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const links = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".key-link")];
    const at = links.indexOf(event.target as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    links[Math.max(0, Math.min(links.length - 1, at + step[event.key]!))]?.focus();
  };
  return (
    <div className="data cli-reply scan-reply">
      <div>1) &quot;{visibleText(scan.cursor)}&quot;</div>
      <div>2) {scan.keys.length ? "" : "(empty array)"}</div>
      {scan.keys.length > 0 && (
        <ol className="scan-keys" aria-label="Keys in this batch" onKeyDown={move}>
          {shown.map((key, i) => (
            <li key={i}>
              <span className="scan-index" aria-hidden="true">
                {i + 1})
              </span>
              <KeyLink
                name={key}
                onOpen={onOpen}
                tabIndex={i === Math.min(current, shown.length - 1) ? 0 : -1}
                onFocus={() => setCurrent(i)}
              />
            </li>
          ))}
        </ol>
      )}
      {shown.length < scan.keys.length && (
        <button
          type="button"
          className="result-more"
          onClick={() => setAll(true)}
        >
          Show all {scan.keys.length.toLocaleString()} keys
        </button>
      )}
    </div>
  );
}
/** A text action whose short visible label is backed by a complete accessible name. */
function Action({
  label,
  short,
  icon,
  onClick,
  disabled,
  title,
}: {
  label: string;
  short: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="result-action"
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
    >
      {icon}
      <span aria-hidden="true">{short}</span>
    </button>
  );
}
function CopyAction({
  text,
  label,
  short,
  icon,
}: {
  text: string;
  label: string;
  short: string;
  icon: ReactNode;
}) {
  const [state, setState] = useState<"" | "copied" | "failed">("");
  return (
    <>
      <Action
        label={label}
        short={state === "copied" ? "Copied" : short}
        title={
          state === "failed"
            ? "Clipboard unavailable. Select the text to copy it."
            : label
        }
        icon={
          state === "copied" ? (
            <Check size={12} aria-hidden="true" />
          ) : (
            icon
          )
        }
        onClick={() => {
          void navigator.clipboard
            .writeText(text)
            .then(() => {
              setState("copied");
              setTimeout(() => setState(""), 1600);
            })
            .catch(() => setState("failed"));
        }}
      />
      {state && (
        <span role="status" className="sr-only">
          {state === "copied"
            ? `${label}: copied`
            : "Clipboard unavailable. Select the text to copy it."}
        </span>
      )}
    </>
  );
}
function elapsedLabel(ms: number) {
  return ms < 10000
    ? `${(ms / 1000).toFixed(1)} s`
    : ms < 60000
      ? `${Math.floor(ms / 1000)} s`
      : `${Math.floor(ms / 60000)} min ${Math.floor((ms % 60000) / 1000)} s`;
}
/** The block for a request in flight: the command, elapsed time and its own cancel control. */
export function RunningBlock({
  line,
  docs,
  elapsed,
  onCancel,
  cancelHint,
  count,
  cancelling = false,
}: {
  line: string;
  docs: CommandDoc[];
  elapsed: number;
  onCancel: () => void;
  cancelHint: string;
  count?: number;
  /** Workbench: the server was asked to stop before the next line and has not answered yet. */
  cancelling?: boolean;
}) {
  return (
    <div
      className="console-result console-result--running"
      data-testid="console-running"
    >
      <header className="result-head">
        <span className="result-status" aria-hidden="true">
          <span className="result-spinner" />
        </span>
        <code className="result-command">
          {count && count > 1 ? (
            `${count} commands`
          ) : (
            <CommandEcho line={line} docs={docs} limit={200} />
          )}
        </code>
        <span className="result-meta">
          <span>
            {cancelling ? "Cancelling…" : "Running…"} {elapsedLabel(elapsed)}
          </span>
        </span>
        <span className="result-actions">
          <button
            type="button"
            className="result-action"
            onClick={onCancel}
            disabled={cancelling}
          >
            Cancel <kbd>{cancelHint}</kbd>
          </button>
        </span>
      </header>
    </div>
  );
}
export function ConsoleResultBlock({
  result,
  view,
  docs,
  onRerun,
  onDraft,
  busy,
}: {
  result: ConsoleResult;
  busy: boolean;
  view: "terminal" | "tree";
  docs: CommandDoc[];
  onRerun: (line: string) => void;
  /** Puts a follow-up command on the prompt (never runs it). */
  onDraft?: (line: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  /** Command-aware view (F11): follows the page's Tree / table choice until this result's own toggle is used. */
  const [richChoice, setRichChoice] = useState<boolean>();
  const db = useDatabase();
  const [, setSelectedKey] = useMemorySlot<Bin | undefined>(
    `${db.id}:selected-key`,
    undefined,
  );
  const navigate = useNavigate();
  const response = result.response;
  const kind = response ? richKind(response.argv, response.reply) : undefined;
  const showRich = kind !== undefined && (richChoice ?? view === "tree");
  const status = resultStatus(result);
  const scan = scanReply(response);
  const argumentKeys = response ? unique(commandKeys(result.line, docs)) : [];
  const linkKeys =
    view === "tree" && scan
      ? unique([...argumentKeys, ...scan.keys.slice(0, 200)])
      : argumentKeys;
  const bytes = new TextEncoder().encode(
    response ? JSON.stringify(response.reply) : resultText(result),
  ).length;
  const open = (key: Bin) => {
    setSelectedKey(key);
    navigate("../keys");
  };
  const time = new Date(result.timestamp);
  const nextScan =
    scan && scan.cursor !== "0"
      ? continueScanLine(result.line, scan.cursor)
      : undefined;
  const allowed = commandPolicy(result.line, docs, db).allowed;
  const explanation = response && replyExplanation(response);
  const wrongType =
    response?.reply.t === "err" &&
    response.reply.v.startsWith("WRONGTYPE") &&
    argumentKeys.length > 0;
  return (
    <section
      className={`console-result console-result--${status}`}
      tabIndex={0}
      aria-label={`${status}: ${visibleText(result.line.slice(0, 120))}`}
      data-testid="console-result"
      data-status={status}
    >
      <header className="result-head">
        <button
          type="button"
          className="result-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand" : "Collapse"}
          title={collapsed ? "Expand" : "Collapse"}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? (
            <ChevronRight size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          )}
        </button>
        <span className="result-status" aria-hidden="true">
          {status === "success" ? "✓" : status === "error" ? "!" : "■"}
        </span>
        <code className="result-command">
          {result.lineNumber !== undefined && (
            <span className="result-line">line {result.lineNumber}</span>
          )}
          <CommandEcho line={result.line} docs={docs} />
        </code>
        <span className="result-meta">
          <time
            dateTime={time.toISOString()}
            title={time.toLocaleString()}
          >
            {time.toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </time>
          <span
            title={
              response
                ? `Time in Redis. Round trip ${result.durationMs.toFixed(0)} ms.`
                : "Round trip"
            }
          >
            {(response?.durationMs ?? result.durationMs).toFixed(2)} ms
          </span>
          <span title="Reply size as received">{bytesLabel(bytes)}</span>
          {response && (
            <span className="result-class" data-class={response.commandClass}>
              {response.commandClass}
            </span>
          )}
        </span>
        <span className="result-actions">
          <CopyAction
            text={resultText(result)}
            label="Copy result"
            short="Copy"
            icon={<Copy size={12} aria-hidden="true" />}
          />
          {response && (
            <>
              <CopyAction
                text={JSON.stringify(response.reply, null, 2)}
                label="Copy JSON"
                short="JSON"
                icon={<Braces size={12} aria-hidden="true" />}
              />
              <CopyAction
                text={copyCode(result.line)}
                label="Copy as code"
                short="Code"
                icon={<Code2 size={12} aria-hidden="true" />}
              />
            </>
          )}
          <Action
            label="Re-run"
            short="Re-run"
            title={
              allowed
                ? "Run again (policy and confirmation are checked again)"
                : "Not allowed for your role on this database"
            }
            icon={<RotateCw size={12} aria-hidden="true" />}
            disabled={busy || !allowed}
            onClick={() => onRerun(result.line)}
          />
        </span>
      </header>
      {collapsed ? (
        <p className="result-preview data">
          {response
            ? isRawText(response.argv) && response.reply.t === "str"
              ? visibleText(replyText(response).split("\n").slice(0, 2).join(" · "))
              : replySummary(response.reply)
            : visibleText(resultText(result).slice(0, 160))}
        </p>
      ) : (
        <div className="result-body">
          {response && kind && (
            <div className="rich-toggle segmented" role="group" aria-label="Result view" data-testid="result-rich-toggle">
              <button type="button" aria-pressed={showRich} onClick={() => setRichChoice(true)}>
                {RICH_LABEL[kind]}
              </button>
              <button type="button" aria-pressed={!showRich} onClick={() => setRichChoice(false)}>
                {view === "tree" ? "Tree" : "Reply"}
              </button>
            </div>
          )}
          {response &&
            (showRich ? (
              <RichReply kind={kind!} reply={response.reply} argv={response.argv} onOpen={open} onRaw={() => setRichChoice(false)} />
            ) : view === "tree" ? (
              <div className="result-tree">
                <TreeReply reply={response.reply} />
              </div>
            ) : scan ? (
              <ScanTranscript scan={scan} onOpen={open} />
            ) : (
              <TranscriptReply response={response} />
            ))}
          {result.cancelled ? (
            <p className="result-note">{resultText(result)}</p>
          ) : (
            <ErrorState error={result.error} />
          )}
          {explanation && (
            <p className="result-note" data-testid="result-explanation">
              {explanation}
            </p>
          )}
          {scan && (
            <p className="result-note">
              {scan.cursor === "0" ? (
                <>Scan complete. {scan.keys.length.toLocaleString()} keys in this batch.</>
              ) : (
                <>
                  Cursor {visibleText(scan.cursor)}, {scan.keys.length.toLocaleString()} keys in
                  this batch. SCAN returns keys in batches; continue from the
                  cursor to see more.{" "}
                  {nextScan && onDraft && (
                    <button
                      type="button"
                      className="result-more"
                      onClick={() => onDraft(nextScan)}
                      title="Puts the next SCAN on the prompt"
                    >
                      Continue scan
                    </button>
                  )}
                </>
              )}
            </p>
          )}
          {wrongType && onDraft && (
            <p className="result-note">
              The key holds a different type than {visibleText(response!.argv[0] ?? "")}{" "}
              works on.{" "}
              <button
                type="button"
                className="result-more"
                onClick={() => onDraft(`TYPE ${cliKey(argumentKeys[0]!)}`)}
                title="Puts TYPE on the prompt"
              >
                Check its type
              </button>
            </p>
          )}
          {linkKeys.length > 0 && (
            <div className="result-keys">
              <span className="result-keys-label">Open in key browser</span>
              {linkKeys.map((key, i) => (
                <KeyLink key={i} name={key} onOpen={open} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
