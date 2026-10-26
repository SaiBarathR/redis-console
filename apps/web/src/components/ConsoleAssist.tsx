import { Fragment, type ReactNode } from "react";
import { BookOpen } from "lucide-react";
import type { CommandArg, CommandDoc } from "@rconsole/shared";
import {
  analyzeCommand,
  commandDoc,
  commandSuggestions,
  keyFamily,
  lex,
} from "../lib/console/language.ts";
import { hint } from "../lib/keyboard/registry.ts";
import { visibleText } from "../lib/format.ts";

/**
 * redis.io-style grammar ("key value [NX | XX] [EX seconds]") with the argument at the cursor
 * marked, so the signature reads the way the Redis documentation does.
 */
export function CommandGrammar({
  doc,
  active,
}: {
  doc: CommandDoc;
  active?: CommandArg;
}) {
  const family = keyFamily(doc);
  const render = (arg: CommandArg, nested: boolean): ReactNode => {
    let body: ReactNode;
    if (arg.type === "oneof")
      body = (arg.arguments ?? []).map((child, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="grammar-punct"> | </span>}
          {render(child, true)}
        </Fragment>
      ));
    else if (arg.type === "block")
      body = (arg.arguments ?? []).map((child, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          {render(child, true)}
        </Fragment>
      ));
    else
      body = (
        <span
          className={[
            "grammar-arg",
            arg.type === "key" ? "console-token-key" : "",
            arg.type === "key" && family ? `t-${family}` : "",
            arg.token ? "grammar-token" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {arg.token && <span className="console-token-flag">{arg.token}</span>}
          {arg.token && arg.type !== "pure-token" && " "}
          {arg.type !== "pure-token" && arg.name}
        </span>
      );
    const content = (
      <>
        {body}
        {arg.multiple && <span className="grammar-punct"> …</span>}
      </>
    );
    const wrapped = arg.optional ? (
      <>
        <span className="grammar-punct">[</span>
        {content}
        <span className="grammar-punct">]</span>
      </>
    ) : arg.type === "oneof" && !nested ? (
      <>
        <span className="grammar-punct">(</span>
        {content}
        <span className="grammar-punct">)</span>
      </>
    ) : (
      content
    );
    return arg === active ? (
      <mark aria-current="true" className="grammar-active">
        {wrapped}
      </mark>
    ) : (
      wrapped
    );
  };
  return (
    <>
      <span className="console-token-command">{doc.name}</span>
      {doc.arguments.map((arg, i) => (
        <Fragment key={i}> {render(arg, false)}</Fragment>
      ))}
    </>
  );
}
export function CommandDocumentation({
  doc,
  policy,
}: {
  doc: CommandDoc;
  policy?: { class: string; hint: string; allowed: boolean };
}) {
  return (
    <div className="command-doc" data-testid="command-docs-full">
      <p className="command-doc-grammar data">
        <CommandGrammar doc={doc} />
      </p>
      <p>{doc.summary}</p>
      <dl className="command-doc-facts">
        <dt>Complexity</dt>
        <dd>{doc.complexity ?? "Not provided"}</dd>
        {doc.since && (
          <>
            <dt>Since</dt>
            <dd>Redis {doc.since}</dd>
          </>
        )}
        <dt>Group</dt>
        <dd>{doc.group}</dd>
        {policy && (
          <>
            <dt>Policy here</dt>
            <dd>
              {policy.class}
              {policy.allowed ? "" : " · not allowed for you on this database"}
              {". "}
              {policy.hint}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
/** SCAN suggestion that keeps the user's KEYS pattern. */
export function keysToScan(line: string) {
  // Reuse the pattern exactly as typed (quotes and \xHH escapes included): re-encoding the decoded text
  // would turn raw bytes into different UTF-8 and the suggested SCAN would match nothing.
  const token = lex(line)[1];
  return `SCAN 0 MATCH ${token ? line.slice(token.from, token.to) : "*"} COUNT 100`;
}
/**
 * One calm line above the prompt: the most useful thing to know about the draft right now.
 * Priority: unknown command, KEYS, multi-line note, the signature at the cursor, then status.
 */
export function ConsoleAssist({
  line,
  cursorLine,
  cursorFull,
  docs,
  workbench,
  status,
  onEdit,
  onDocs,
  onWorkbench,
}: {
  line: string;
  /** Text before the caret on the caret's line (signature position). */
  cursorLine: string;
  /** The whole line the caret is on (identifies the command even with the caret at its start). */
  cursorFull: string;
  docs: CommandDoc[];
  workbench: boolean;
  /** Shown when there is nothing to say about the draft (last announcement). */
  status?: string;
  onEdit: (value: string) => void;
  onDocs: () => void;
  onWorkbench?: () => void;
}) {
  const command = workbench ? cursorFull : line;
  const before = analyzeCommand(cursorLine, docs);
  const doc = before.doc ?? commandDoc(cursorFull, docs);
  const active = before.doc === doc ? before.active : undefined;
  const word = lex(line)[0];
  // While the command word is still being typed and some command starts with it, stay quiet.
  const typing =
    !!word &&
    !/\s/.test(line.slice(word.to)) &&
    docs.some((item) => item.name.toUpperCase().startsWith(word.text.toUpperCase()));
  const suggestions =
    workbench || typing ? [] : commandSuggestions(line, docs);
  const multi = !workbench && line.includes("\n");
  let content: ReactNode;
  let testId: string | undefined;
  if (docs.length && suggestions.length) {
    testId = "command-suggestions";
    const token = lex(line)[0];
    content = (
      <>
        <span>
          Unknown command{" "}
          <code>{visibleText((token?.text ?? "").slice(0, 40))}</code>. Did you
          mean
        </span>
        {suggestions.map((name) => (
          <button
            type="button"
            className="assist-action data"
            key={name}
            onClick={() => onEdit(name + (token ? line.slice(token.to) : ""))}
          >
            {name}
          </button>
        ))}
        <span>?</span>
      </>
    );
  } else if (!workbench && /^\s*KEYS(?:\s|$)/i.test(line)) {
    testId = "keys-guidance";
    content = (
      <>
        <span>
          KEYS walks every key in one call and can block Redis for everyone.
          SCAN returns the same keys in small batches.
        </span>
        <button
          type="button"
          className="assist-action"
          onClick={() => onEdit(keysToScan(line))}
        >
          Use <code>{visibleText(keysToScan(line))}</code>
        </button>
      </>
    );
  } else if (multi) {
    content = (
      <>
        <span>
          These lines run as one command. To run several commands in order, use
          the Workbench.
        </span>
        {onWorkbench && (
          <button
            type="button"
            className="assist-action"
            onClick={onWorkbench}
          >
            Open in Workbench
          </button>
        )}
      </>
    );
  } else if (doc) {
    testId = "command-docs";
    content = (
      <>
        <span className="assist-signature data" data-testid="command-signature">
          <CommandGrammar doc={doc} active={active} />
        </span>
        <span className="assist-summary">{doc.summary}</span>
        {doc.complexity && (
          <span
            className="assist-complexity data"
            title={`Complexity: ${doc.complexity}`}
          >
            {/O\([^)]*\)/.exec(doc.complexity)?.[0] ??
              doc.complexity.split(/[.;]/)[0]}
          </span>
        )}
      </>
    );
  } else if (!command.trim() && status) {
    content = <span className="assist-status">{status}</span>;
  } else if (!command.trim()) {
    content = (
      <span className="assist-status">
        {workbench
          ? "One command per line. The cursor line's arguments appear here."
          : "Arguments and documentation for the command appear here as you type."}
      </span>
    );
  }
  return (
    <div className="console-assist">
      <div className="assist-content" data-testid={testId}>
        {content}
      </div>
      <button
        type="button"
        className="key-hint"
        onClick={onDocs}
        data-testid="console-docs-open"
        title="Documentation for the command at the cursor"
      >
        <BookOpen size={12} aria-hidden="true" />
        <span>Docs</span>
        <kbd>{hint("docs")}</kbd>
      </button>
    </div>
  );
}
