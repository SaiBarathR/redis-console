import {
  Fragment,
  useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { LockKeyhole, ShieldAlert } from "lucide-react";
import type {
  Confirmation,
  ConfirmationChallenge,
  DatabaseSummary,
} from "@rconsole/shared";
import { setConfirmHandler, type ConfirmContext } from "../lib/api.ts";
import { displayBin, visibleText } from "../lib/format.ts";
import { plural, previewArgText } from "../lib/preview.ts";
import { Badge, Field, Modal } from "./ui.tsx";

/** The user dismissed the confirmation: not a failure, so ErrorState shows it as a neutral status. */
function cancelled(message: string) {
  const error = new Error(message);
  error.name = "ActionCancelled";
  return error;
}
type Pending = {
  challenge: ConfirmationChallenge;
  database?: DatabaseSummary;
  databaseId?: string;
  note?: string;
  resolve: (value: Confirmation) => void;
  reject: (error: Error) => void;
};
export function environmentTone(environment: DatabaseSummary["environment"]) {
  return environment === "prod"
    ? "red production"
    : environment === "staging" || environment === "test"
      ? "amber"
      : "green";
}
/** The database, environment and effective role a challenge applies to. */
function ChallengeTarget({
  database,
  databaseId,
}: {
  database?: DatabaseSummary;
  databaseId?: string;
}) {
  if (!database)
    return databaseId ? (
      <div className="confirm-target" data-testid="confirmation-target">
        <span className="muted">Database</span>
        <strong className="data">{visibleText(databaseId)}</strong>
      </div>
    ) : null;
  const prod = database.environment === "prod";
  return (
    <div
      className={`confirm-target ${prod ? "prod" : ""}`}
      data-testid="confirmation-target"
    >
      <span className="muted">Database</span>
      <strong>{visibleText(database.name)}</strong>
      <Badge tone={environmentTone(database.environment)}>
        {prod && <LockKeyhole size={11} />}
        {prod ? "Production" : database.environment}
      </Badge>
      <span className="muted">as</span>
      <Badge tone="blue">{database.effectiveRole}</Badge>
    </div>
  );
}
/** Server-built list of exactly what will run. Rendered as text only. */
export function ChallengeDetails({
  challenge,
}: {
  challenge: ConfirmationChallenge;
}) {
  const { preview, impact } = challenge;
  const listId = useId();
  const bulk = preview?.bulk;
  const keys = impact?.keys ?? bulk?.keys;
  const sample = impact?.sample?.length ? impact.sample : bulk?.sample;
  const incomplete = bulk?.complete === false;
  return (
    <>
      {preview && (
        <section className="confirm-section" aria-labelledby={listId}>
          <h3 id={listId}>
            What will run
            <span className="muted" data-testid="confirmation-total">
              {plural(preview.total, "command")}
            </span>
          </h3>
          {bulk && (
            <dl className="confirm-facts" data-testid="confirmation-bulk">
              <dt>Pattern</dt>
              <dd className="data">{visibleText(displayBin(bulk.match, 1100))}</dd>
              {bulk.type && (
                <>
                  <dt>Type</dt>
                  <dd className="data">{visibleText(bulk.type)}</dd>
                </>
              )}
            </dl>
          )}
          <div
            className="confirm-preview"
            role="region"
            aria-label="Commands that will run"
            tabIndex={0}
            data-testid="confirmation-preview"
          >
            <ol>
              {preview.commands.map((command, i) => (
                <li key={i} data-testid="confirmation-command">
                  {command.argv.map((arg, j) => (
                    <Fragment key={j}>
                      {j > 0 && " "}
                      <span className={`arg ${arg.kind}`}>
                        {previewArgText(arg)}
                      </span>
                    </Fragment>
                  ))}
                  {!!command.moreArgs && (
                    <>
                      {" "}
                      <span className="arg more">
                        +{plural(command.moreArgs, "more argument")}
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ol>
            {!!preview.more && (
              <p className="confirm-more" data-testid="confirmation-more">
                +{plural(preview.more, "more command")} not listed
              </p>
            )}
          </div>
          {bulk && (
            <p className="hint">
              Keys are deleted in batches as SCAN finds them. Keys written while
              this runs may also match.
            </p>
          )}
        </section>
      )}
      {(keys !== undefined || !!sample?.length) && (
        <section className="confirm-section" data-testid="confirmation-impact">
          <h3>Impact</h3>
          <p>
            {keys === undefined
              ? "Unknown number of keys affected"
              : `${incomplete ? "At least " : ""}${plural(keys, "key")} affected`}
            {incomplete && (
              <span className="muted"> · count stopped at its scan budget</span>
            )}
          </p>
          {!!sample?.length && (
            <ul className="confirm-sample" aria-label="Sample of affected keys">
              {sample.map((key, i) => (
                <li key={i} className="data">
                  {displayBin(key, 1100)}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const client = useContext(QueryClientContext);
  const [pending, setPending] = useState<Pending>();
  const current = useRef<Pending | undefined>(undefined);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const summaryId = useId();
  const lookup = useRef(client);
  lookup.current = client;
  useEffect(() => {
    setConfirmHandler(
      (challenge, context: ConfirmContext) =>
        new Promise((resolve, reject) => {
          if (current.current) {
            reject(new Error("Finish the current confirmation first."));
            return;
          }
          const database = context.databaseId
            ? lookup.current
                ?.getQueryData<DatabaseSummary[]>(["databases"])
                ?.find((db) => db.id === context.databaseId)
            : undefined;
          const next = {
            challenge,
            database,
            databaseId: context.databaseId,
            note: context.note,
            resolve,
            reject,
          };
          current.current = next;
          setTyped("");
          setReason("");
          setPending(next);
        }),
    );
    return () => {
      setConfirmHandler(undefined);
      current.current?.reject(cancelled("Confirmation cancelled."));
      current.current = undefined;
    };
  }, []);
  const close = () => {
    pending?.reject(cancelled("Action cancelled. No changes were made."));
    current.current = undefined;
    setPending(undefined);
  };
  const challenge = pending?.challenge;
  const prod = pending?.database?.environment === "prod";
  const blocked =
    !!challenge &&
    ((challenge.level === "typed" &&
      (!challenge.expectedText || typed !== challenge.expectedText)) ||
      (challenge.reasonRequired && reason.trim().length < 3));
  return (
    <>
      {children}
      {pending && challenge && (
        <Modal
          title={prod ? "Confirm production change" : "Confirm this action"}
          onClose={close}
          testId="confirmation-dialog"
          className={`confirm-modal ${prod ? "prod" : ""}`}
          describedBy={summaryId}
        >
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              if (blocked) return;
              pending.resolve({
                token: challenge.token,
                ...(challenge.level === "typed" ? { typed } : {}),
                ...(challenge.reasonRequired ? { reason: reason.trim() } : {}),
              });
              current.current = undefined;
              setPending(undefined);
            }}
          >
            <ChallengeTarget
              database={pending.database}
              databaseId={pending.databaseId}
            />
            <div className="notice warning">
              <ShieldAlert size={18} />
              <p id={summaryId}>{visibleText(challenge.summary)}</p>
            </div>
            {pending.note && (
              <p className="confirm-note" data-testid="confirmation-note">
                {visibleText(pending.note)}
              </p>
            )}
            <ChallengeDetails challenge={challenge} />
            {challenge.level === "typed" && (
              <Field
                label={`Type “${visibleText(challenge.expectedText ?? "confirmation unavailable")}” to continue`}
              >
                <input
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  data-testid="confirmation-typed"
                />
              </Field>
            )}
            {challenge.reasonRequired && (
              <Field
                label="Reason for this change"
                hint="Required for production writes. Recorded in the audit log."
              >
                <textarea
                  required
                  minLength={3}
                  maxLength={500}
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  data-testid="confirmation-reason"
                />
              </Field>
            )}
            <div className="actions end">
              <button type="button" onClick={close}>
                Cancel
              </button>
              <button
                type="submit"
                className="danger"
                disabled={blocked}
                data-testid="confirmation-submit"
              >
                {prod ? "Confirm on production" : "Confirm action"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
