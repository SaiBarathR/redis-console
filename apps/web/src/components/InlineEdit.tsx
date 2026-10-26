import { editableBin } from "../lib/format.ts";
import { useState } from "react";
import type { Bin, EditConflict, EditExpect } from "@rconsole/shared";
import { inputBin } from "./KeyOperations.tsx";
import { ConflictNotice, conflictOf } from "./Conflict.tsx";
import { ErrorState } from "./ui.tsx";

/**
 * Edits one collection element in place (opened from the row's Edit action). The editor is bound to the bytes it
 * opened: their encoding (UTF-8 or Base64) is fixed for the draft's lifetime, whatever later reads show (web review
 * v0.2 r3 H1), and the save carries them as its compare-and-set expectation. A 409 shows what Redis holds now.
 */
export function InlineEdit({
  value,
  label,
  onSave,
  onClose,
  onReload,
}: {
  /** The element as it was when the editor opened. */
  value: Bin;
  label: string;
  /** `expect` is set only for "Overwrite anyway": the expectation of the state the conflict showed. */
  onSave: (value: Bin, expect?: EditExpect) => Promise<unknown>;
  onClose: () => void;
  /** Re-read the key and reopen the editor on the current value. */
  onReload?: () => void;
}) {
  const [opened] = useState(() => ({ source: value, editable: editableBin(value) }));
  const editable = opened.editable;
  const [draft, setDraft] = useState(editable.data);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [conflict, setConflict] = useState<EditConflict>();
  const save = (expect?: EditExpect) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    void Promise.resolve()
      .then(() => (expect ? onSave(inputBin(draft, editable.enc), expect) : onSave(inputBin(draft, editable.enc))))
      .then(onClose)
      .catch((caught: unknown) => {
        const found = conflictOf(caught);
        if (found) setConflict(found);
        else setError(caught);
      })
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="row-panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (!conflict) save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <label className="field">
        <span>
          {label} <small>({editable.enc === "utf8" ? "UTF-8" : "base64; preserves CR / CRLF bytes"})</small>
        </span>
        <textarea
          className="data"
          aria-label={label}
          autoFocus
          rows={Math.min(8, Math.max(2, draft.split("\n").length))}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      {conflict && (
        <ConflictNotice
          conflict={conflict}
          opened={opened.source}
          busy={busy}
          onReload={() => (onReload ? onReload() : onClose())}
          // Never across types: a deleted or retyped key is reloaded, not recreated from a row editor.
          onOverwrite={conflict.reason === "type" ? undefined : (expect) => save(expect)}
        />
      )}
      <ErrorState error={error} />
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || !!conflict}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
