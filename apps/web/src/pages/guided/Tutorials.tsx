import { useState } from "react";
import { useNavigate } from "react-router";
import type { DatabaseSummary } from "@rconsole/shared";
import { useDatabase } from "../../lib/context.tsx";
import { visibleText } from "../../lib/format.ts";
import { useMemorySlot } from "../../lib/memory.tsx";
import { commandPolicy } from "../../lib/policy.ts";
import { CopyButton } from "../../components/ui.tsx";
import { catalogState, useCommandDocs } from "../Console.tsx";
import { TUTORIALS, type Tutorial, type TutorialStep } from "../../content/tutorials.ts";
import "../../styles/insight.css";

const MODULE: Record<NonNullable<Tutorial["module"]>, { re: RegExp; name: string }> = {
  search: { re: /search/i, name: "Search (RediSearch)" },
  json: { re: /json/i, name: "JSON (RedisJSON)" },
  timeseries: { re: /timeseries/i, name: "TimeSeries" },
};
export const moduleAvailable = (t: Tutorial, db: DatabaseSummary) =>
  !t.module || !!db.server?.modules.some((m) => MODULE[t.module!].re.test(m.name));

/** The workbench draft's default (pages/Console.tsx), so inserting into a fresh tab keeps the same starting point. */
const WORKBENCH_DEFAULT = "# Inspect this database\nPING\nDBSIZE";

/** Appends a step's commands to the workbench draft under a comment naming the tutorial step. */
export function withInserted(draft: string, tutorial: Tutorial, step: TutorialStep): string {
  const block = `# ${tutorial.title} · ${step.title}\n${step.script ?? ""}`;
  return draft.trim() ? `${draft.replace(/\n+$/, "")}\n\n${block}` : block;
}

export function Tutorials() {
  const db = useDatabase();
  const navigate = useNavigate();
  const commandDocs = useCommandDocs();
  const docs = commandDocs.data ?? [];
  const catalog = catalogState(commandDocs);
  const [chosen, setChosen] = useMemorySlot<string>(`${db.id}:tutorials:open`, TUTORIALS[0]!.id);
  const [draft, setDraft] = useMemorySlot(`${db.id}:workbench:draft`, WORKBENCH_DEFAULT);
  const [inserted, setInserted] = useState("");
  const tutorial = TUTORIALS.find((t) => t.id === chosen) ?? TUTORIALS[0]!;
  const available = moduleAvailable(tutorial, db);
  const insert = (step: TutorialStep, go: boolean) => {
    setDraft(withInserted(draft, tutorial, step));
    setInserted(`${step.title} added to the workbench script.`);
    if (go) navigate(`/db/${encodeURIComponent(db.id)}/workbench`);
  };
  return (
    <div className="split guided-split tutorial-split">
      <nav className="side-list" aria-label="Tutorials">
        {TUTORIALS.map((t) => (
          <button key={t.id} type="button" aria-pressed={t.id === tutorial.id} onClick={() => setChosen(t.id)} data-testid={`tutorial-${t.id}`}>
            <span>{t.title}</span>
            <span className={`policy-tag ${moduleAvailable(t, db) ? "read" : "write"}`} title={t.module ? `Needs ${MODULE[t.module].name}` : undefined}>
              {t.kind === "Recipe" ? "recipe" : t.module ? (moduleAvailable(t, db) ? t.module : "no module") : "core"}
            </span>
            <small className="sub">{t.summary}</small>
          </button>
        ))}
      </nav>
      <section className="guided-pane" aria-labelledby="tutorial-title" data-testid="tutorial">
        <header className="pane-head">
          <h2 id="tutorial-title">{tutorial.title}</h2>
          <span className="meta">offline · reviewed text · nothing runs until you run it in the workbench</span>
        </header>
        <div className="pane-body">
          <p className="task-description">{tutorial.summary}</p>
          {!available && tutorial.module && (
            <p className="notice warning" role="status">
              This database does not have the {MODULE[tutorial.module].name} module, so these commands will fail here. Read along, or pick a
              database that has it.
            </p>
          )}
          {(db.readOnly || db.effectiveRole === "viewer") && (
            <p className="notice warning" role="status">
              {db.readOnly ? "This database is read-only:" : "Your role here is viewer:"} the workbench runs the reads below and refuses the
              writes.
            </p>
          )}
          {tutorial.steps.map((step, i) => (
            <article className="tutorial-step" key={step.title} data-testid="tutorial-step">
              <h3>
                {i + 1}. {step.title}
              </h3>
              {step.text.map((p, j) => (
                <p key={j}>{p}</p>
              ))}
              {step.code && (
                <div className="command-preview">
                  <header>
                    <span>{step.code.label} · for your application, not run here</span>
                    <CopyButton text={step.code.text} />
                  </header>
                  <pre className="data">{step.code.text}</pre>
                </div>
              )}
              {step.script && (
                <>
                  <ul className="tutorial-lines" aria-label="What each command does here">
                    {step.script
                      .split("\n")
                      .filter((l) => l.trim() && !l.trim().startsWith("#"))
                      .map((line, j) => {
                        const p = commandPolicy(line, docs, db, catalog);
                        return (
                          <li key={j}>
                            <span className={`policy-tag ${p.pending ? "" : p.allowed ? (p.class === "read" ? "read" : "write") : "write"}`.trim()} title={p.pending ? p.hint : undefined}>
                              {p.pending ? "…" : p.allowed ? p.class : "refused"}
                            </span>
                            <code className="data">{visibleText(line.length > 90 ? `${line.slice(0, 90)}…` : line)}</code>
                          </li>
                        );
                      })}
                  </ul>
                  <pre className="data" data-testid="tutorial-script">
                    {step.script}
                  </pre>
                  <div className="actions">
                    <button type="button" onClick={() => insert(step, true)} data-testid="tutorial-insert">
                      Insert into workbench
                    </button>
                    <button type="button" className="ghost" onClick={() => insert(step, false)}>
                      Add to script, stay here
                    </button>
                    <CopyButton text={step.script} label="Copy commands" />
                  </div>
                </>
              )}
            </article>
          ))}
          <p role="status" className="muted">
            {inserted}
          </p>
        </div>
      </section>
    </div>
  );
}
