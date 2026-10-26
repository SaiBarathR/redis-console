import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  binFromString,
  keyToParam,
  type Bin,
  type KeyDetails,
  type ScanResponse,
  type CliResponse,
} from "@rconsole/shared";
import { useDatabase, canImport, canWrite } from "../lib/context.tsx";
import { dbPath, request } from "../lib/api.ts";
import { bytesLabel, cliArg, visibleText } from "../lib/format.ts";
import { executeCli } from "../lib/operations.ts";
import { useMemorySlot } from "../lib/memory.tsx";
import type { ScanFilter } from "../lib/keyscan.ts";
import { KeyContent, inspectCommands } from "./Keys.tsx";
import { Tutorials } from "./guided/Tutorials.tsx";
import { ImportPanel } from "./guided/ImportPanel.tsx";
import { replyExplanation } from "../components/ConsoleResult.tsx";
import { ReplyView } from "../components/Reply.tsx";
import { KeyName, TtlFuse, TypeGlyph } from "../components/anatomy.tsx";
import {
  ActionForm,
  CopyButton,
  Empty,
  Field,
  PageTitle,
} from "../components/ui.tsx";

const TASKS = [
  {
    id: "find",
    name: "Find keys",
    description:
      "List keys that match a pattern. SCAN reads in small steps, so it does not block Redis the way KEYS does.",
    command: "SCAN",
    read: true,
  },
  {
    id: "inspect",
    name: "Inspect a value",
    description: "Read a key's type, expiry, encoding and contents.",
    command: "TYPE + GET",
    read: true,
  },
  {
    id: "edit",
    name: "Set a string value",
    description: "Create a string key, or replace the value of an existing one.",
    command: "SET",
    read: false,
  },
  {
    id: "ttl",
    name: "Set an expiry",
    description: "Make Redis remove a key after a number of seconds.",
    command: "EXPIRE",
    read: false,
  },
  {
    id: "stream",
    name: "Add a stream entry",
    description: "Append an entry with one field and value to a stream.",
    command: "XADD",
    read: false,
  },
  {
    id: "publish",
    name: "Publish a message",
    description: "Send a message to everyone subscribed to a channel.",
    command: "PUBLISH",
    read: false,
  },
  {
    id: "counter",
    name: "Increment a counter",
    description: "Add to an integer value in one atomic step.",
    command: "INCRBY",
    read: false,
  },
  {
    id: "set",
    name: "Add to a set",
    description: "Add a member to a set. Sets ignore duplicates.",
    command: "SADD",
    read: false,
  },
  {
    id: "zset",
    name: "Add to a sorted set",
    description: "Add a member with a score. Members stay ordered by score.",
    command: "ZADD",
    read: false,
  },
] as const;

type GuidedTab = "tasks" | "tutorials" | "import";
const GUIDED_TABS: { id: GuidedTab; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "tutorials", label: "Tutorials" },
  { id: "import", label: "Import" },
];

/**
 * Guided mode: task forms, offline tutorials and recipes (F12), and command-file import (F10, operator and above:
 * hidden for a viewer). `?tab=` is a fixed word.
 */
export function Guided() {
  const db = useDatabase();
  const [params, setParams] = useSearchParams();
  const tabs = GUIDED_TABS.filter((t) => t.id !== "import" || canImport(db));
  const tab: GuidedTab = tabs.find((t) => t.id === params.get("tab"))?.id ?? "tasks";
  return (
    <div className="workspace guided">
      <PageTitle
        title="Guided mode"
        description={
          tab === "tasks"
            ? "Common tasks as forms. Each shows the exact command before it runs."
            : tab === "tutorials"
              ? "Offline tutorials and recipes. Insert their commands into the workbench and run them after review."
              : "Import a file of redis-cli commands through the same policy, confirmations and audit as the workbench."
        }
        actions={
          <nav className="segmented guided-tabs" aria-label="Guided mode views">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={tab === t.id}
                onClick={() => setParams(t.id === "tasks" ? {} : { tab: t.id })}
                data-testid={`guided-tab-${t.id}`}
              >
                {t.label}
              </button>
            ))}
          </nav>
        }
      />
      {tab === "tasks" ? <GuidedTasks /> : tab === "tutorials" ? <Tutorials /> : <ImportPanel />}
    </div>
  );
}

function GuidedTasks() {
  const db = useDatabase();
  const navigate = useNavigate();
  const [, setSelectedKey] = useMemorySlot<Bin | undefined>(
    `${db.id}:selected-key`,
    undefined,
  );
  const [taskId, setTask] = useState<string>("find");
  const task = TASKS.find((t) => t.id === taskId) ?? TASKS[0];
  const [name, setName] = useState("");
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(0);
  const [value, setValue] = useState("");
  const [field, setField] = useState("");
  const [number, setNumber] = useState("1");
  const [result, setResult] = useState<KeyDetails | ScanResponse>();
  /** The pattern of the last Find, so "continue in the key browser" uses what ran, not the edited field. */
  const [found, setFound] = useState("*");
  const [readAt, setReadAt] = useState(0);
  const [reply, setReply] = useState<CliResponse>();
  const changed = () => { setResult(undefined); setReply(undefined); setRevision(++revisionRef.current); };
  const writable = canWrite(db);
  const blocked = !task.read && !writable;
  const blockedReason = db.readOnly
    ? "This database is read-only, so write tasks are off."
    : `Your role on this database is ${db.effectiveRole}. Write tasks need the operator or admin role.`;
  const argv =
    task.id === "find"
      ? ["SCAN", "0", "MATCH", name || "*", "COUNT", "200"]
      : task.id === "inspect"
        ? ["TYPE", name]
        : task.id === "edit"
          ? ["SET", name, value]
          : task.id === "ttl"
            ? ["EXPIRE", name, number]
            : task.id === "stream"
              ? ["XADD", name, "*", field, value]
              : task.id === "publish"
                ? ["PUBLISH", name, value]
                : task.id === "counter"
                  ? ["INCRBY", name, number]
                  : task.id === "set"
                    ? ["SADD", name, value]
                    : ["ZADD", name, number, value];
  const preview =
    task.id === "inspect"
      ? inspectCommands(
          binFromString(name),
          result && "value" in result ? result : undefined,
        )
      : argv.map((arg, i) => (i === 0 ? arg : cliArg(arg))).join(" ");
  const openKey = (key: Bin) => {
    setSelectedKey(key);
    navigate(`/db/${encodeURIComponent(db.id)}/keys`);
  };
  const [, requestScan] = useMemorySlot<ScanFilter | undefined>(
    `${db.id}:key-scan-request`,
    undefined,
  );
  /** Continues the Find task in the key browser with the same pattern (in session memory, not the URL). */
  const continueInKeys = (match: string) => {
    requestScan({ match, type: "" });
    navigate(`/db/${encodeURIComponent(db.id)}/keys`);
  };
  return (
    <div className="split guided-split">
      <nav className="side-list" aria-label="Tasks">
        {TASKS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={task.id === t.id}
            onClick={() => {
              setTask(t.id);
              changed();
              setNumber(t.id === "ttl" ? "3600" : "1");
            }}
            data-testid={`guided-${t.id}`}
          >
            <span>{t.name}</span>
            <span
              className={`policy-tag ${t.read ? "read" : "write"}`}
              title={
                t.read
                  ? "Reads only"
                  : writable
                    ? "Changes data"
                    : `Changes data. ${blockedReason}`
              }
            >
              {t.read ? "read" : "write"}
            </span>
            <code className="sub">{t.command}</code>
          </button>
        ))}
      </nav>
      <section className="guided-pane" aria-labelledby="guided-task-title">
        <header className="pane-head">
          <h2 id="guided-task-title">{task.name}</h2>
          <span className={`policy-tag ${task.read ? "read" : "write"}`}>
            {task.read ? "read" : "write"}
          </span>
        </header>
        <div className="pane-body guided-form">
          <p className="task-description">{task.description}</p>
          {blocked && (
            <p className="notice warning" role="status">
              {blockedReason}
            </p>
          )}
          <ActionForm
            key={task.id}
            resetKey={revision}
            label={task.id === "find" ? "Find keys" : task.name}
            testId="guided-run"
            disabled={blocked}
            onSubmit={async () => {
              const submittedRevision = revisionRef.current;
              const showResult = (value: KeyDetails | ScanResponse) => { if (revisionRef.current === submittedRevision) setResult(value); };
              setResult(undefined);
              setReply(undefined);
              if (task.id === "find") {
                const match = name || "*";
                showResult(
                  await request(dbPath(db.id, "/keys/scan"), {
                    method: "POST",
                    body: { match, cursor: "0", count: 200 },
                  }),
                );
                setFound(match);
              }
              else if (task.id === "inspect")
                showResult(
                  await request(dbPath(db.id, "/key/read"), {
                    method: "POST",
                    body: { key: binFromString(name), count: 100 },
                  }),
                );
              else { const next = await executeCli(db.id, { argv }); if (revisionRef.current === submittedRevision) setReply(next); }
              setReadAt(Date.now());
            }}
          >
            <div className="form-row">
              <Field
                label={
                  task.id === "find"
                    ? "Key pattern"
                    : task.id === "publish"
                      ? "Channel"
                      : "Key name"
                }
                hint={
                  task.id === "find"
                    ? "* matches any characters, ? matches one character."
                    : undefined
                }
              >
                <input
                  className="data"
                  required={task.id !== "find"}
                  value={name}
                  onChange={(e) => { setName(e.target.value); changed(); }}
                  placeholder={
                    task.id === "find"
                      ? "e.g. session:*"
                      : task.id === "publish"
                        ? "e.g. orders.events"
                        : "e.g. app:visits"
                  }
                  data-testid="guided-key"
                  autoComplete="off"
                />
              </Field>
              {["ttl", "counter", "zset"].includes(task.id) && (
                <Field
                  label={
                    task.id === "ttl"
                      ? "Expire after (seconds)"
                      : task.id === "counter"
                        ? "Increment by"
                        : "Score"
                  }
                >
                  <input
                    className="number-input"
                    type="number"
                    required
                    min={task.id === "ttl" ? 1 : undefined}
                    step={task.id === "zset" ? "any" : 1}
                    value={number}
                    onChange={(e) => { setNumber(e.target.value); changed(); }}
                    data-testid="guided-number"
                  />
                </Field>
              )}
            </div>
            {task.id === "stream" && (
              <Field label="Field name">
                <input
                  className="data"
                  required
                  value={field}
                  onChange={(e) => { setField(e.target.value); changed(); }}
                  data-testid="guided-field"
                />
              </Field>
            )}
            {["edit", "stream", "publish", "set", "zset"].includes(
              task.id,
            ) && (
              <Field
                label={
                  task.id === "set" || task.id === "zset"
                    ? "Member"
                    : task.id === "publish"
                      ? "Message"
                      : "Value"
                }
              >
                <textarea
                  rows={3}
                  className="data"
                  value={value}
                  onChange={(e) => { setValue(e.target.value); changed(); }}
                  data-testid="guided-value"
                  autoComplete="off"
                />
              </Field>
            )}
            <div className="command-preview">
              <header>
                <span>
                  {task.id === "inspect"
                    ? "Commands the inspector runs"
                    : "Command you'll run"}
                </span>
                <CopyButton text={preview} />
              </header>
              <pre className="data" data-testid="guided-command">
                {visibleText(preview)}
              </pre>
              {task.id === "find" && (
                <small>
                  {!name && "Empty pattern matches every key (*). "}Reads one SCAN page of up to 200 keys. Continue in the key
                  browser for more.
                </small>
              )}
            </div>
          </ActionForm>
          {reply && (
            <div className="guided-result">
              <h3>
                Result
                <span className="muted">
                  {" "}
                  · {reply.durationMs.toFixed(2)} ms
                </span>
              </h3>
              <p role="status">{replyExplanation(reply) ?? (
                reply.reply.t === "err" ? "Redis refused this command; check the error below." :
                task.id === "ttl" ? reply.reply.t === "int" && reply.reply.v === "0" ? "The key does not exist; nothing changed." : "The expiry was set in seconds." :
                task.id === "counter" ? "The reply is the counter's new value." :
                task.id === "stream" ? "The reply is the new stream entry ID." :
                task.id === "set" || task.id === "zset" ? "The reply counts newly added members; existing members are not counted." :
                task.id === "edit" ? "The string value was saved." : "The reply counts subscribers who received the message."
              )}</p>
              {task.id === "publish" && reply.reply.t === "int" ? (
                <p>
                  Delivered to {reply.reply.v}{" "}
                  {reply.reply.v === "1" ? "subscriber" : "subscribers"}.
                </p>
              ) : (
                <div className="reply-box">
                  <ReplyView reply={reply.reply} />
                </div>
              )}
            </div>
          )}
          {result !== undefined && (
            <div className="guided-result">
              {"value" in result ? (
                <>
                  <h3 className="inspect-title">
                    <TypeGlyph type={result.type} />
                    <KeyName name={result.key} limit={500} />
                  </h3>
                  <dl className="facts inspect-facts">
                    <dt>Type</dt>
                    <dd>{result.type}</dd>
                    <dt>Expiry</dt>
                    <dd>
                      <TtlFuse ttl={result.ttl} readAt={readAt} />
                    </dd>
                    <dt>Encoding</dt>
                    <dd>{result.encoding ?? "Unavailable"}</dd>
                    <dt>Memory</dt>
                    <dd>{bytesLabel(result.size)}</dd>
                  </dl>
                  <div className="actions">
                    <button type="button" onClick={() => openKey(result.key)}>
                      Open in key browser
                    </button>
                  </div>
                  <KeyContent
                    key={keyToParam(result.key)}
                    details={result}
                    refresh={async () => {
                      setResult(
                        await request<KeyDetails>(
                          dbPath(db.id, "/key/read"),
                          {
                            method: "POST",
                            body: { key: result.key, count: 100 },
                          },
                        ),
                      );
                      setReadAt(Date.now());
                    }}
                  />
                </>
              ) : (
                <>
                  <h3>
                    {result.keys.length.toLocaleString()}{" "}
                    {result.keys.length === 1 ? "key" : "keys"} found
                    <span className="muted">
                      {" "}
                      · {result.scanned.toLocaleString()} examined ·{" "}
                      {result.cursor === "0"
                        ? "scan complete"
                        : "more keys may match"}
                    </span>
                  </h3>
                  <p className="actions">
                    <button
                      type="button"
                      onClick={() => continueInKeys(found)}
                      data-testid="guided-continue-keys"
                    >
                      Scan <code>{visibleText(found)}</code> in the key
                      browser
                    </button>
                  </p>
                  {result.keys.length ? (
                    <ul className="found-keys">
                      {[...result.keys]
                        .sort((a, b) => a.key.data.localeCompare(b.key.data))
                        .map((item) => (
                        <li key={keyToParam(item.key)}>
                          <button
                            type="button"
                            className="found-key"
                            onClick={() => openKey(item.key)}
                            title="Open in the key browser"
                          >
                            <TypeGlyph type={item.type} />
                            <KeyName name={item.key} limit={500} />
                            <TtlFuse ttl={item.ttl} readAt={readAt} />
                            <span className="size">
                              {bytesLabel(item.size)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Empty compact title="No keys matched in this page.">
                      {result.cursor === "0"
                        ? "Try a broader pattern, for example user:*."
                        : "SCAN can return empty pages. Continue in the key browser to read further."}
                    </Empty>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
