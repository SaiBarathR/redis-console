import { useState } from "react";
import type { Bin, KeyDetails } from "@rconsole/shared";
import { dbPath, request } from "../lib/api.ts";
import { keyOperation } from "../lib/operations.ts";
import { useDatabase, canWrite } from "../lib/context.tsx";
import { ErrorState } from "./ui.tsx";

/** HTTL is batched on each inspector page; this row edits HEXPIRE / HPERSIST through typed policy ops. */
export function HashExpiry({ keyName, field, initialTtl, refresh, onClose }: { keyName: Bin; field: Bin; initialTtl?: number; refresh?: () => Promise<unknown>; onClose: () => void }) {
  const db = useDatabase();
  const [seconds, setSeconds] = useState(String(initialTtl && initialTtl > 0 ? initialTtl : 3600));
  const [ttl, setTtl] = useState(initialTtl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const run = async (command: "read" | "expire" | "persist") => {
    if (command === "expire" && (!Number.isSafeInteger(Number(seconds)) || Number(seconds) <= 0)) { setError(new Error("Enter a positive whole number of seconds.")); return; }
    setBusy(true); setError(undefined);
    try {
      if (command !== "read") await keyOperation(db.id, command === "persist" ? { op: "hash.persist", key: keyName, fields: [field] } : { op: "hash.expire", key: keyName, fields: [field], ttl: Number(seconds) });
      const detail = await request<KeyDetails>(dbPath(db.id, "/key/read"), { method: "POST", body: { key: keyName, exact: field } });
      if (detail.hashFieldExpiry?.supported === false) throw new Error(detail.hashFieldExpiry.reason);
      setTtl(detail.value.type === "hash" ? detail.value.entries[0]?.ttl ?? -2 : -2);
      if (command !== "read") await refresh?.();
    } catch (caught) { setError(caught); }
    finally { setBusy(false); }
  };
  return <div className="row-panel" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <div className="actions"><button type="button" disabled={busy} onClick={() => { void run("read"); }}>Read field TTL</button>
      {canWrite(db) && <><label className="inline-field">Seconds <input aria-label="Field TTL seconds" type="number" min={1} step={1} value={seconds} onChange={e => setSeconds(e.target.value)} /></label><button type="button" disabled={busy} onClick={() => { void run("expire"); }}>Set field TTL</button><button type="button" disabled={busy} onClick={() => { void run("persist"); }}>Remove field expiry</button></>}
      <button type="button" className="ghost" onClick={onClose}>Close</button>
    </div><ErrorState error={error} />
    {ttl !== undefined && <p role="status">Field TTL: {ttl === -1 ? "-1 (no expiry)" : ttl === -2 ? "-2 (missing field)" : `${ttl} seconds`}</p>}
    <small>HTTL / HEXPIRE / HPERSIST require Redis 7.4 or later.</small>
  </div>;
}
