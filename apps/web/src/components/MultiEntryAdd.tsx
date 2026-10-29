import { useState } from "react";
import { binEquals, binFromString, bytesFromBin, type Bin, type EditConflict, type EditExpect, type KeyDetails, type KeyOp } from "@rconsole/shared";
import { canWrite, useDatabase } from "../lib/context.tsx";
import { digestBin } from "../lib/expect.ts";
import { displayBin } from "../lib/format.ts";
import { keyOperation } from "../lib/operations.ts";
import { ConflictNotice, conflictOf } from "./Conflict.tsx";
import { inputBin } from "./KeyOperations.tsx";
import { ErrorState, Modal } from "./ui.tsx";

type Draft = { field: string; value: string; score: string; encoding: "utf8" | "base64"; fieldEncoding: "utf8" | "base64" };
const blank = (): Draft => ({ field: "", value: "", score: "0", encoding: "utf8", fieldEncoding: "utf8" });
export function entryOperations(details: KeyDetails, rows: Draft[], end: "head" | "tail"): KeyOp[] {
  if (!rows.length || rows.length > 50) throw new Error("Add between 1 and 50 entries.");
  const seen = new Set<string>();
  let bytes = 0;
  const values = rows.map(row => {
    const v = inputBin(row.value, row.encoding), f = inputBin(row.field, row.fieldEncoding);
    bytes += bytesFromBin(v).length + (details.type === "hash" ? bytesFromBin(f).length : 0);
    const identity = digestBin(details.type === "hash" ? f : v);
    if (details.type !== "list" && seen.has(identity)) throw new Error("Duplicate fields or members are not allowed in one form.");
    seen.add(identity);
    return { row, v, f };
  });
  if (bytes > 4 * 1024 * 1024) throw new Error("Entries together must fit within 4 MiB.");
  const key = details.key;
  if (details.type === "list") return [{ op: "list.push", key, end, values: values.map(x => x.v) }];
  if (details.type === "set") return [{ op: "set.add", key, members: values.map(x => x.v) }];
  return values.map(({ row, v, f }) => {
    if (details.value.type === "hash") {
      const previous = details.value.entries.find(x => binEquals(x.field, f) && !x.fieldTruncated);
      if (previous?.truncated) throw new Error("Load the full existing field before replacing its truncated value.");
      return { op: "hash.set", key, entries: [{ field: f, value: v }], expect: { type: details.type, sha256: previous ? digestBin(previous.value) : null } };
    }
    if (details.value.type === "zset") {
      if (!/^[-+]?(?:\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|inf)$/.test(row.score)) throw new Error("Every sorted-set score must be numeric.");
      const previous = details.value.members.find(x => !x.truncated && binEquals(x.member, v));
      return { op: "zset.add", key, members: [{ member: v, score: row.score }], expect: { type: details.type, sha256: previous ? digestBin(binFromString(previous.score)) : null } };
    }
    throw new Error("This collection does not support multi-entry additions.");
  });
}

/** One reviewable form; replacing commands remain individual CAS operations with honest partial results. */
export function MultiEntryAdd({ details, onClose, refresh }: { details: KeyDetails; onClose: () => void; refresh: () => Promise<unknown> }) {
  const db = useDatabase();
  const [opened] = useState(details);
  const [rows, setRows] = useState<Draft[]>([blank()]);
  const [end, setEnd] = useState<"head" | "tail">("tail");
  const [review, setReview] = useState<KeyOp[]>();
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [conflict, setConflict] = useState<EditConflict>();
  const run = async (override?: EditExpect) => {
    if (!review || busy || !canWrite(db)) return;
    setBusy(true); setError(undefined); setConflict(undefined);
    try {
      for (let i = done; i < review.length; i++) {
        let op = review[i]!;
        if (i === done && override && (op.op === "hash.set" || op.op === "zset.add")) op = { ...op, expect: override };
        await keyOperation(db.id, op);
        setDone(i + 1);
        if (i + 1 < review.length) await new Promise(resolve => setTimeout(resolve, 60));
      }
      await refresh();
    } catch (caught) { const found = conflictOf(caught); if (found) setConflict(found); else setError(caught); }
    finally { setBusy(false); }
  };
  const patch = (at: number, update: Partial<Draft>) => setRows(current => current.map((row, i) => i === at ? { ...row, ...update } : row));
  // Closing waits only while commands are being sent: once every command has run, the key's refresh may finish behind
  // the closed dialog (as "Reload" after a conflict does), so a close click is never silently dropped.
  const sending = busy && !!review && done < review.length;
  return <Modal title="Add multiple entries" onClose={sending ? () => {} : onClose} testId="multi-entry-dialog">
    <p className="dialog-subject data">{displayBin(opened.key)}</p>
    {!review ? <form onSubmit={e => { e.preventDefault(); setError(undefined); try { setReview(entryOperations(opened, rows, end)); } catch (caught) { setError(caught); } }}>
      {opened.type === "list" && <label>Insert at <select aria-label="List insertion end" value={end} onChange={e => setEnd(e.target.value as typeof end)}><option value="tail">Tail (RPUSH)</option><option value="head">Head (LPUSH, reverses entered order)</option></select></label>}
      {rows.map((row, i) => <fieldset key={i}><legend>Entry {i + 1}</legend>
        {/* Each input sits beside its own encoding, so the pair reads as one row rather than two stacked controls. */}
        {opened.type === "hash" && <div className="entry-part"><label>Field <input aria-label={`Field ${i + 1}`} value={row.field} onChange={e => patch(i, { field: e.target.value })} /></label><label className="entry-encoding">Encoding <select aria-label={`Field encoding ${i + 1}`} value={row.fieldEncoding} onChange={e => patch(i, { fieldEncoding: e.target.value as Draft['fieldEncoding'] })}><option value="utf8">UTF-8</option><option value="base64">Base64</option></select></label></div>}
        <div className="entry-part"><label>{opened.type === "hash" || opened.type === "list" ? "Value" : "Member"}<textarea aria-label={`Value ${i + 1}`} value={row.value} onChange={e => patch(i, { value: e.target.value })} /></label>
        <label className="entry-encoding">Encoding <select aria-label={`Value encoding ${i + 1}`} value={row.encoding} onChange={e => patch(i, { encoding: e.target.value as Draft['encoding'] })}><option value="utf8">UTF-8</option><option value="base64">Base64</option></select></label></div>
        {opened.type === "zset" && <label className="entry-score">Score <input aria-label={`Score ${i + 1}`} value={row.score} onChange={e => patch(i, { score: e.target.value })} /></label>}
        {rows.length > 1 && <div className="actions end"><button type="button" className="ghost danger-text" onClick={() => setRows(current => current.filter((_, j) => i !== j))}>Remove entry {i + 1}</button></div>}
      </fieldset>)}
      <div className="actions"><button type="button" disabled={rows.length >= 50} onClick={() => setRows(current => [...current, blank()])}>Add another entry</button><button type="submit">Review entries</button></div>
    </form> : <>
      <p>{rows.length} entries · {review.length} command{review.length === 1 ? "" : "s"}. {review.filter(op => "expect" in op && op.expect?.sha256).length} expected replacements. Other hash fields / scores are expected absent; an unseen existing element stops with a conflict.</p>
      <p>Commands run sequentially. Earlier successes remain if a later command fails. Set members already present are unchanged. {opened.type === "list" && (end === "head" ? "Head insertion reverses entered order." : "Tail insertion preserves entered order.")}</p>
      <ol>{rows.map((row, i) => <li key={i}><code>{opened.type === "hash" ? `${row.fieldEncoding}: ${displayBin(inputBin(row.field, row.fieldEncoding), 150)} → ` : ""}{displayBin(inputBin(row.value, row.encoding), 250)}{opened.type === "zset" ? ` (score ${row.score})` : ""}</code></li>)}</ol>
      <p role="status" data-testid="multi-entry-summary">{done} of {review.length} commands completed{busy ? "…" : ""}. {review.length - done} not completed.</p>
      {conflict && <ConflictNotice conflict={conflict} onReload={() => { onClose(); void refresh(); }} onOverwrite={expect => { void run(expect); }} overwriteLabel="Overwrite this entry and continue" busy={busy} />}
      <div className="actions"><button type="button" disabled={busy || !!conflict || done === review.length || !canWrite(db)} onClick={() => { void run(); }}>Apply entries</button>{done === 0 && !busy && <button type="button" onClick={() => { setReview(undefined); setConflict(undefined); }}>Edit entries</button>}</div>
    </>}
    <ErrorState error={error} />
  </Modal>;
}
