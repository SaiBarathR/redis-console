import { useEffect, useRef, useState } from "react";
import {
  IMPORT_CHUNK_SIZE,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_COMMANDS,
  type ImportPlan,
  type ImportStatus,
} from "@rconsole/shared";
import { canImport, useDatabase } from "../../lib/context.tsx";
import { dbPath, post, request } from "../../lib/api.ts";
import { bytesLabel, visibleText } from "../../lib/format.ts";
import { useMemorySlot } from "../../lib/memory.tsx";
import { Badge, DataTable, ErrorState, Field } from "../../components/ui.tsx";
import "../../styles/insight.css";

const POLL_MS = 500;
const DONE: Record<ImportStatus["state"], string> = {
  planned: "Not started",
  running: "Running",
  done: "Finished",
  cancelled: "Cancelled",
  stopped: "Stopped",
  failed: "Stopped",
};

/** Lines a file would import (blank and # / // comment lines are skipped, like the workbench). */
export function countCommands(text: string): number {
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l && !l.startsWith("#") && !l.startsWith("//")) n++;
  }
  return n;
}

/**
 * Bulk import (v0.2.1, RI parity F10): a file of redis-cli commands is checked by the server's command policy line
 * by line (counts by class, refused lines listed), then runs after one confirmation in chunks, with progress, cancel
 * and a per-command failure summary. Every command runs through the same policy, role, actor checks and audit as
 * the workbench; the file never leaves this tab except to the server.
 */
export function ImportPanel() {
  const db = useDatabase();
  // Guided mode hides the tab for a viewer; the server refuses one too.
  if (!canImport(db)) {
    return (
      <section className="guided-pane import-pane" data-testid="import-panel">
        <p className="notice" role="status">Importing a command file needs the operator role on this database (yours is {db.effectiveRole}).</p>
      </section>
    );
  }
  return <ImportForm />;
}

function ImportForm() {
  const db = useDatabase();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");
  const [plan, setPlan] = useState<ImportPlan>();
  const [stopOnError, setStopOnError] = useState(false);
  const [skipBlocked, setSkipBlocked] = useState(false);
  // The running import's id is in session memory so progress resumes after navigating away and back.
  const [jobId, setJobId] = useMemorySlot<string>(`${db.id}:import:job`, "");
  const [status, setStatus] = useState<ImportStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const file = useRef<HTMLInputElement>(null);
  const bytes = new TextEncoder().encode(text).length;
  const commands = countCommands(text);
  const tooBig = bytes > MAX_IMPORT_BYTES || commands > MAX_IMPORT_COMMANDS;

  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await request<ImportStatus>(dbPath(db.id, `/import/${encodeURIComponent(jobId)}`), { background: true });
        if (stop) return;
        setStatus(s);
        if (s.state === "running") timer = setTimeout(tick, POLL_MS);
      } catch (e) {
        if (!stop) {
          setError(e);
          setJobId("");
        }
      }
    };
    timer = setTimeout(tick, 50);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [jobId, db.id]);

  const check = async () => {
    setError(undefined);
    setPlan(undefined);
    setStatus(undefined);
    setJobId("");
    setBusy(true);
    try {
      setPlan(await post<ImportPlan>(dbPath(db.id, "/import"), { script: text, ...(fileName ? { fileName } : {}) }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!plan) return;
    setError(undefined);
    setBusy(true);
    try {
      const s = await post<ImportStatus>(
        dbPath(db.id, `/import/${encodeURIComponent(plan.id)}/start`),
        { stopOnError, skipBlocked },
        `${plan.total.toLocaleString()} commands from ${plan.fileName ?? "the pasted text"}; the import plan lists them by class.`,
      );
      setStatus(s);
      setJobId(plan.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const running = status?.state === "running";
  const finished = status && status.state !== "running" && status.state !== "planned";
  const blocked = plan?.counts.blocked ?? 0;
  return (
    <section className="guided-pane import-pane" aria-labelledby="import-title" data-testid="import-panel">
      <header className="pane-head">
        <h2 id="import-title">Import commands from a file</h2>
        <span className="meta">
          redis-cli syntax, one command per line · at most {MAX_IMPORT_COMMANDS.toLocaleString()} commands and {bytesLabel(MAX_IMPORT_BYTES)}
        </span>
      </header>
      <div className="pane-body">
        <p className="task-description">
          Every line is checked against your role and this database's policy before anything runs. Writes need one confirmation
          {db.environment === "prod" ? ", the typed database name and a reason" : ""}; commands then run one by one in chunks of{" "}
          {IMPORT_CHUNK_SIZE}, each audited like a workbench line. Scripting, admin and blocked commands are refused here too.
          The file is read as UTF-8 text: write other bytes as <code>\xHH</code> inside double quotes, as redis-cli does.
        </p>
        {db.readOnly && (
          <p className="notice warning" role="status">
            This database is read-only: write commands in a file are refused; only reads can run.
          </p>
        )}
        <div className="import-drop">
          <input
            ref={file}
            type="file"
            accept=".txt,.redis,.cli,.cmd,text/plain"
            data-testid="import-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setPlan(undefined);
              setStatus(undefined);
              if (f.size > MAX_IMPORT_BYTES) {
                setError(new Error(`The file is ${bytesLabel(f.size)}; imports are limited to ${bytesLabel(MAX_IMPORT_BYTES)}. Split it.`));
                return;
              }
              setError(undefined);
              setFileName(f.name.slice(0, 256));
              void f.text().then(setText, setError);
            }}
          />
          <span className="muted">or paste commands below</span>
        </div>
        <Field label={fileName ? `Commands (${visibleText(fileName)})` : "Commands"}>
          <textarea
            className="data"
            rows={8}
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setPlan(undefined);
            }}
            placeholder={'SET app:feature:dark-mode on\nHSET app:user:1 name "Ada" plan pro\nEXPIRE app:user:1 3600'}
            data-testid="import-text"
          />
        </Field>
        <p className="muted">
          {commands.toLocaleString()} {commands === 1 ? "command" : "commands"} · {bytesLabel(bytes)}
          {tooBig && <span className="warn-text"> · over the limit</span>}
        </p>
        <div className="actions">
          <button type="button" className="primary" disabled={busy || running || !commands || tooBig} onClick={() => void check()} data-testid="import-check">
            Check against the policy
          </button>
        </div>
        <ErrorState error={error} />
        {plan && (
          <section className="section" aria-label="Import plan" data-testid="import-plan">
            <header>
              <h2>Plan</h2>
              <span className="meta">
                {plan.total.toLocaleString()} commands · nothing has run yet
              </span>
            </header>
            <div className="import-counts">
              <Badge tone="blue">{plan.counts.read.toLocaleString()} read</Badge>
              <Badge tone="amber">{plan.counts.write.toLocaleString()} write</Badge>
              {plan.counts.admin > 0 && <Badge tone="red">{plan.counts.admin.toLocaleString()} admin</Badge>}
              {plan.destructive > 0 && <Badge tone="red">{plan.destructive.toLocaleString()} destructive</Badge>}
              <Badge tone={blocked ? "red" : "green"}>{blocked.toLocaleString()} refused</Badge>
            </div>
            {blocked > 0 && (
              <>
                <p className="notice warning" role="status">
                  {blocked === 1 ? "One line is" : `${blocked.toLocaleString()} lines are`} refused by the policy for your role on this database. Remove{" "}
                  {blocked === 1 ? "it" : "them"} from the file, or skip refused lines.
                </p>
                <DataTable
                  className="dense"
                  columns={["Line", "Command", "Why"]}
                  rows={plan.blocked.map((b) => [
                    <span className="num tabular">{b.line}</span>,
                    <code className="data">{visibleText(b.command)}</code>,
                    visibleText(b.reason),
                  ])}
                />
                {plan.blocked.length < blocked && <p className="muted">The first {plan.blocked.length} refused lines are listed.</p>}
              </>
            )}
            <div className="actions">
              <label className="checkbox">
                <input type="checkbox" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} data-testid="import-stop-on-error" />
                Stop at the first failure
              </label>
              {blocked > 0 && (
                <label className="checkbox">
                  <input type="checkbox" checked={skipBlocked} onChange={(e) => setSkipBlocked(e.target.checked)} data-testid="import-skip-blocked" />
                  Skip refused lines
                </label>
              )}
              <button
                type="button"
                className={plan.confirmation === "none" ? "primary" : "primary danger"}
                disabled={busy || running || !!finished || (blocked > 0 && !skipBlocked) || plan.total - (skipBlocked ? blocked : 0) === 0}
                onClick={() => void start()}
                data-testid="import-start"
              >
                {plan.confirmation === "none" ? "Run import" : "Run import…"}
              </button>
            </div>
            {plan.confirmation !== "none" && (
              <p className="muted">The server asks you to confirm{plan.confirmation === "typed" ? " and type the database name" : ""} before the first command runs.</p>
            )}
          </section>
        )}
        {status && status.state !== "planned" && (
          <section className="section" aria-label="Import progress" data-testid="import-status" data-state={status.state}>
            <header>
              <h2>{DONE[status.state]}</h2>
              <span className="meta">
                chunk {Math.min(status.chunks.done + (running ? 1 : 0), status.chunks.total)} of {status.chunks.total}
              </span>
              {running && (
                <div className="actions">
                  <button
                    type="button"
                    className="ghost"
                    data-testid="import-cancel"
                    onClick={() => void post<ImportStatus>(dbPath(db.id, `/import/${encodeURIComponent(status.id)}/cancel`), {}).then(setStatus, setError)}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </header>
            <div className="progress-row" role="status">
              <span className="progress-bar" aria-hidden="true">
                <span style={{ transform: `scaleX(${status.total ? (status.processed + status.skipped) / status.total : 0})` }} />
              </span>
              <span data-testid="import-counts">
                {status.processed.toLocaleString()} of {status.total.toLocaleString()} sent · {status.succeeded.toLocaleString()} succeeded ·{" "}
                {status.failed.toLocaleString()} failed · {status.skipped.toLocaleString()} not sent
              </span>
            </div>
            {status.stopReason && <p className="notice warning">{visibleText(status.stopReason)}</p>}
            {status.failures.length > 0 && (
              <DataTable
                className="dense"
                columns={["Command", "Failures", "Error", "Lines"]}
                rows={status.failures.map((f) => [
                  <code className="data">{visibleText(f.command)}</code>,
                  <span className="num tabular">{f.count.toLocaleString()}</span>,
                  <span className="data">
                    {visibleText(f.code)}: {visibleText(f.message)}
                  </span>,
                  <span className="tabular">
                    {f.lines.join(", ")}
                    {f.count > f.lines.length ? ", …" : ""}
                  </span>,
                ])}
              />
            )}
            {finished && status.failed === 0 && !status.stopReason && <p className="success" role="status">Every command succeeded.</p>}
          </section>
        )}
      </div>
    </section>
  );
}
