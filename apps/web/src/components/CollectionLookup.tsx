import { useState } from "react";
import type { KeyReadRequest } from "@rconsole/shared";
import { inputBin } from "./KeyOperations.tsx";
import { ErrorState } from "./ui.tsx";

export type CollectionCriteria = Pick<KeyReadRequest, "match" | "exact" | "reverse" | "scoreMin" | "scoreMax" | "streamStart" | "streamEnd">;
/** Criteria are applied together; the inspector resets every page cursor on each application. */
export function CollectionLookup({ type, initial = {}, offset = 0, apply }: { type: string; initial?: CollectionCriteria; offset?: number; apply: (criteria: CollectionCriteria, offset?: number) => void }) {
  const [mode, setMode] = useState(type === "list" ? "index" : type === "stream" ? "range" : initial.exact ? "exact" : initial.scoreMin !== undefined || initial.scoreMax !== undefined ? "score" : "match");
  const [text, setText] = useState(initial.exact?.data ?? initial.match ?? initial.scoreMin ?? initial.streamStart ?? (type === "list" ? String(offset) : ""));
  const [end, setEnd] = useState(initial.scoreMax ?? initial.streamEnd ?? "");
  const [encoding, setEncoding] = useState<"utf8" | "base64">(initial.exact?.enc ?? "utf8");
  const [reverse, setReverse] = useState(initial.reverse ?? false);
  const [error, setError] = useState<unknown>();
  return <form className="collection-lookup" data-testid="collection-lookup" onSubmit={event => {
    event.preventDefault(); setError(undefined);
    try {
      const criteria: CollectionCriteria = { reverse };
      let offset = 0;
      if (mode === "exact") criteria.exact = inputBin(text, encoding);
      else if (mode === "index") {
        offset = Number(text);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Enter a non-negative whole index.");
      } else if (mode === "score") { criteria.scoreMin = text || "-inf"; criteria.scoreMax = end || "+inf"; }
      else if (mode === "range") { criteria.streamStart = text || "-"; criteria.streamEnd = end || "+"; }
      else if (text) criteria.match = text;
      apply(criteria, offset);
    } catch (caught) { setError(caught); }
  }}>
    <label>Lookup <select aria-label="Collection lookup mode" value={mode} onChange={e => { setMode(e.target.value); setText(""); setEnd(""); }}>
      {type === "list" ? <option value="index">List index</option> : type === "stream" ? <option value="range">Entry ID / range</option> : <>
        <option value="match">MATCH pattern</option><option value="exact">Exact {type === "hash" ? "field" : "member"}</option>
        {type === "zset" && <option value="score">Score range</option>}
      </>}
    </select></label>
    <input aria-label={mode === "index" ? "List index" : mode === "score" ? "Minimum score" : mode === "range" ? "Start entry ID" : "Collection lookup"} value={text} onChange={e => setText(e.target.value)} placeholder={mode === "match" ? "Field/member glob, e.g. user:*" : mode === "range" ? "- or 123-0" : mode === "score" ? "-inf" : ""} />
    {(mode === "score" || mode === "range") && <input aria-label={mode === "score" ? "Maximum score" : "End entry ID"} value={end} onChange={e => setEnd(e.target.value)} placeholder={mode === "score" ? "+inf" : "+ (same ID for exact lookup)"} />}
    {mode === "exact" && <select aria-label="Lookup encoding" value={encoding} onChange={e => setEncoding(e.target.value as typeof encoding)}><option value="utf8">UTF-8</option><option value="base64">Base64</option></select>}
    {type === "zset" && <label><input type="checkbox" checked={reverse} onChange={e => setReverse(e.target.checked)} /> Highest score first (range reads)</label>}
    <button type="submit">Apply lookup</button>
    <button type="button" className="ghost" onClick={() => { setText(""); setEnd(""); setReverse(false); apply({}); }}>Reset lookup</button>
    <ErrorState error={error} />
  </form>;
}
