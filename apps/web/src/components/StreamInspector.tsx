import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { binEquals, binFromString, type Bin, type StreamGroupsResponse, type StreamPendingResponse, type KeyDetails, type KeyElementResponse, type ElementRef } from "@rconsole/shared";
import { dbPath, request } from "../lib/api.ts";
import { canWrite, useDatabase } from "../lib/context.tsx";
import { cliArg, displayBin } from "../lib/format.ts";
import { keyOperation } from "../lib/operations.ts";
import { ValueViewer } from "./ValueViewer.tsx";
import { ErrorState, Loading, Modal } from "./ui.tsx";

/** Groups -> consumers -> pending stays attached to the inspected stream and its database. */
export function StreamInspector({ keyName, refresh }: { keyName: Bin; refresh: () => Promise<unknown> }) {
  const db = useDatabase();
  const [expanded, setExpanded] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<Bin>();
  const [consumer, setConsumer] = useState<Bin>();
  const [range, setRange] = useState({ start: "-", end: "+" });
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [idle, setIdle] = useState("60000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [outcome, setOutcome] = useState("");
  const [entryId, setEntryId] = useState<string>();
  const [newGroup, setNewGroup] = useState({ name: "", start: "$", id: "", mkstream: false });
  const groups = useQuery({ queryKey: ["stream-groups", db.id, keyName], enabled: expanded, queryFn: ({ signal }) => request<StreamGroupsResponse>(dbPath(db.id, "/streams/groups"), { method: "POST", body: { key: keyName }, signal }) });
  const group = selectedGroup ? groups.data?.groups.find(g => binEquals(g.nameBin ?? binFromString(g.name), selectedGroup)) : groups.data?.groups[0];
  // Bind even the initial choice to its bytes; a refreshed XINFO ordering must never retarget actions.
  if (!selectedGroup && group) setSelectedGroup(group.nameBin ?? binFromString(group.name));
  const groupIndex = group ? groups.data!.groups.indexOf(group) : -1;
  if (selectedGroup && groups.isSuccess && !group && selected.length) setSelected([]);
  const groupName = group?.nameBin ?? (group ? binFromString(group.name) : undefined);
  const pending = useQuery({ queryKey: ["stream-pending", db.id, keyName, groupName, consumer, range], enabled: expanded && !!groupName, queryFn: ({ signal }) => request<StreamPendingResponse>(dbPath(db.id, "/streams/pending"), { method: "POST", body: { key: keyName, group: groupName, consumer, ...range, count: 100 }, signal }) });
  const act = async (action: "ack" | "claim") => {
    if (!groupName || busy || !canWrite(db)) return;
    setBusy(true); setError(undefined); setOutcome("");
    try {
      if (!selected.length) throw new Error("Select at least one pending entry.");
      if (action === "claim" && (!target || !Number.isSafeInteger(Number(idle)) || Number(idle) < 0)) throw new Error("Enter a target consumer and a non-negative minimum idle time.");
      const response = await keyOperation(db.id, action === "ack" ? { op: "stream.ack", confirmAck: true, key: keyName, group: groupName, ids: selected } : { op: "stream.claim", key: keyName, group: groupName, consumer: target, minIdleMs: Number(idle), ids: selected });
      setOutcome(`Command completed: ${JSON.stringify(response.result)}. Claim eligibility is checked by Redis; entries below the minimum idle time remain with their current consumer.`);
      setSelected([]);
      await Promise.all([groups.refetch(), pending.refetch(), refresh()]);
    } catch (caught) { setError(caught); }
    finally { setBusy(false); }
  };
  // Group lifecycle and consumer delete (review v0.2.1 web L2): typed ops by exact bytes, server role and
  // confirmation. The pending counts are those of the last refresh; Redis reports what it actually dropped.
  const lifecycle = async (run: () => Promise<string>) => {
    if (busy || !canWrite(db)) return;
    setBusy(true); setError(undefined); setOutcome("");
    try {
      setOutcome(await run());
      setSelected([]);
      await Promise.all([groups.refetch(), refresh()]);
    } catch (caught) { setError(caught); }
    finally { setBusy(false); }
  };
  const count = (result: unknown) => (result && typeof result === "object" && "t" in result && result.t === "int" && "v" in result ? String(result.v) : "?");
  const deleteConsumer = (name: Bin, pendingCount: number) => lifecycle(async () => {
    if (!groupName) throw new Error("Choose a group first.");
    const response = await keyOperation(db.id, { op: "stream.consumer.delete", key: keyName, group: groupName, consumer: name },
      `Consumer ${displayBin(name)} of group ${displayBin(groupName)} had ${pendingCount} pending ${pendingCount === 1 ? "entry" : "entries"} at the last refresh. Deleting it drops them from the group's pending list: nobody can acknowledge or claim them afterwards. The stream entries themselves stay.`);
    if (consumer && binEquals(consumer, name)) setConsumer(undefined);
    void pending.refetch();
    return `Consumer ${displayBin(name)} deleted. Redis dropped ${count(response.result)} pending ${count(response.result) === "1" ? "entry" : "entries"}.`;
  });
  const destroyGroup = () => lifecycle(async () => {
    if (!group || !groupName) throw new Error("Choose a group first.");
    const response = await keyOperation(db.id, { op: "stream.group.destroy", key: keyName, group: groupName },
      `Group ${displayBin(groupName)} had ${group.consumerTotal ?? group.consumers.length} consumers and ${group.pending} pending entries at the last refresh. Destroying it removes them all; the stream entries stay.`);
    setSelectedGroup(undefined); setConsumer(undefined);
    return count(response.result) === "1" ? `Group ${displayBin(groupName)} destroyed.` : `Redis did not find group ${displayBin(groupName)}; nothing was destroyed.`;
  });
  const startId = newGroup.start === "id" ? newGroup.id.trim() : newGroup.start;
  const startValid = /^(\$|0|\d+(-\d+)?)$/.test(startId);
  const createArgs = ["XGROUP", "CREATE", displayBin(keyName), newGroup.name || "<name>", startId || "<id>", ...(newGroup.mkstream ? ["MKSTREAM"] : [])];
  const createGroup = () => lifecycle(async () => {
    if (!newGroup.name || !startValid) throw new Error("Enter a group name and a start ID ($, 0 or an entry ID).");
    await keyOperation(db.id, { op: "stream.group.create", key: keyName, group: newGroup.name, id: startId, mkstream: newGroup.mkstream });
    setSelectedGroup(binFromString(newGroup.name)); setConsumer(undefined);
    setNewGroup({ name: "", start: "$", id: "", mkstream: false });
    return `Group ${newGroup.name} created at ${startId}.`;
  });
  return <details className="stream-inspector" data-testid="stream-inspector" onToggle={e => setExpanded(e.currentTarget.open)}><summary>Consumer groups, consumers and pending messages</summary>
    {expanded && <div className="stream-inspector-body">
      <div className="stream-inspector-bar">
        <button type="button" onClick={() => { setSelected([]); void groups.refetch(); void pending.refetch(); }}>Refresh stream groups</button>
        {groups.data && <span className="muted">{groups.data.groups.length} of {groups.data.total ?? groups.data.groups.length} consumer groups shown (up to 100).</span>}
      </div>
      <ErrorState error={groups.error ?? pending.error ?? error} />
      {groups.isPending && <Loading label="Reading consumer groups…" />}
      {!!groups.data?.groups.length && <label className="field stream-group-field"><span>Group</span><select aria-label="Inspector consumer group" value={groupIndex < 0 ? "" : groupIndex} onChange={e => { const next = groups.data?.groups[Number(e.target.value)]; if (next) setSelectedGroup(next.nameBin ?? binFromString(next.name)); setConsumer(undefined); setSelected([]); setRange({ start: "-", end: "+" }); }}>
        {groupIndex < 0 && <option value="" disabled>Selected group not available</option>}
        {groups.data.groups.map((g, i) => <option key={i} value={i}>{displayBin(g.nameBin ?? binFromString(g.name))} · {g.pending} pending</option>)}
      </select></label>}
      {selectedGroup && groups.isSuccess && !group && <p role="status">The selected group was removed. Choose a group to continue.</p>}
      {group && <>
        <section className="stream-section" aria-label="Consumers">
          <div className="stream-section-head">
            <h4>Consumers</h4>
            <span className="muted">Last delivered <code>{group.lastDeliveredId}</code> · lag {group.lag ?? "unknown"} · {group.consumers.length} of {group.consumerTotal ?? group.consumers.length} consumers shown</span>
            {canWrite(db) && <button type="button" className="danger-text stream-section-action" disabled={busy} data-testid="stream-group-destroy" onClick={() => { void destroyGroup(); }}>Destroy group {displayBin(groupName!)}… ({group.pending} pending)</button>}
          </div>
          {group.consumers.length ? <div className="table-wrap"><table><thead><tr><th>Consumer</th><th className="num">Pending</th><th className="num">Idle ms</th><th>Messages</th>{canWrite(db) && <th>Delete</th>}</tr></thead><tbody>{group.consumers.map((c, i) => <tr key={i}><td className="data">{displayBin(c.nameBin ?? binFromString(c.name))}</td><td className="num">{c.pending}</td><td className="num">{c.idleMs}</td><td><button type="button" onClick={() => { setConsumer(c.nameBin ?? binFromString(c.name)); setSelected([]); }}>Pending for consumer {i + 1}</button></td>{canWrite(db) && <td><button type="button" className="danger-text" disabled={busy} data-testid="stream-consumer-delete" aria-label={`Delete consumer ${i + 1} (${c.pending} pending)`} onClick={() => { void deleteConsumer(c.nameBin ?? binFromString(c.name), c.pending); }}>Delete… ({c.pending} pending)</button></td>}</tr>)}</tbody></table></div>
            : <p className="muted stream-empty">No consumer has read from this group yet.</p>}
        </section>
        <section className="stream-section" aria-label="Pending messages">
          <div className="stream-section-head"><h4>Pending messages</h4>
            <span className="muted">{pending.data?.pending.length ?? 0} matching pending messages on this page · group total {pending.data?.total ?? group.pending}{consumer && <> · consumer {displayBin(consumer)}</>}</span></div>
          <form className="stream-row" onSubmit={e => { e.preventDefault(); setSelected([]); setRange({ start: start || "-", end: end || "+" }); }}>
            <label className="field"><span>Start ID</span><input className="data" aria-label="Pending start ID" placeholder="- or entry ID" value={start} onChange={e => setStart(e.target.value)} /></label>
            <label className="field"><span>End ID</span><input className="data" aria-label="Pending end ID" placeholder="+ or same ID" value={end} onChange={e => setEnd(e.target.value)} /></label>
            <button type="submit">Find pending IDs</button>
            <button type="button" onClick={() => { setConsumer(undefined); setSelected([]); }}>All consumers</button>
            {pending.data?.pending.length === 100 && <button type="button" onClick={() => { setSelected([]); setRange(current => ({ ...current, start: `(${pending.data!.pending.at(-1)!.id}` })); }}>Next pending page</button>}
          </form>
          {pending.data?.pending.length ? <div className="table-wrap"><table><thead><tr>{canWrite(db) && <th>Select</th>}<th>Entry ID</th><th>Consumer</th><th className="num">Idle ms</th><th className="num">Deliveries</th></tr></thead><tbody>{pending.data.pending.map(p => <tr key={p.id}>{canWrite(db) && <td><input type="checkbox" aria-label={`Select pending ${p.id}`} checked={selected.includes(p.id)} onChange={e => setSelected(current => e.target.checked ? [...current, p.id] : current.filter(id => id !== p.id))} /></td>}<td><button type="button" onClick={() => setEntryId(p.id)} aria-label={`Inspect pending entry ${p.id}`}><code>{p.id}</code></button></td><td className="data">{displayBin(p.consumerBin ?? binFromString(p.consumer))}</td><td className="num">{p.idleMs}</td><td className="num">{p.deliveries}</td></tr>)}</tbody></table></div>
            : <p className="muted stream-empty">{pending.isPending ? "Reading pending messages…" : "No pending messages in this range."}</p>}
          {canWrite(db) ? <div className="stream-row">
            <button type="button" disabled={busy || !selected.length} onClick={() => { void act("ack"); }}>Acknowledge selected (confirm)</button>
            <label className="field"><span>Claim for consumer</span><input className="data" aria-label="Claim target consumer" placeholder="Target consumer" value={target} onChange={e => setTarget(e.target.value)} /></label>
            <label className="field stream-idle"><span>Minimum idle (ms)</span><input aria-label="Claim minimum idle milliseconds" type="number" min={0} value={idle} onChange={e => setIdle(e.target.value)} /></label>
            <button type="button" disabled={busy || !selected.length} onClick={() => { void act("claim"); }}>Claim selected (confirm)</button>
          </div> : <p className="muted">Claim and acknowledgement require write access.</p>}
        </section>
      </>}
      {canWrite(db) && <form className="stream-section stream-group-new" aria-label="Create a consumer group" onSubmit={e => { e.preventDefault(); void createGroup(); }}>
        <div className="stream-section-head"><h4>Create a consumer group</h4></div>
        <div className="stream-row">
          <label className="field"><span>Group name</span><input className="data" aria-label="New group name" placeholder="Group name" maxLength={256} value={newGroup.name} onChange={e => setNewGroup({ ...newGroup, name: e.target.value })} data-testid="stream-new-group-name" /></label>
          <label className="field"><span>Start from</span><select aria-label="New group start" value={newGroup.start} onChange={e => setNewGroup({ ...newGroup, start: e.target.value })} data-testid="stream-new-group-start">
            <option value="$">New entries only ($)</option>
            <option value="0">Every entry (0)</option>
            <option value="id">After an entry ID…</option>
          </select></label>
          {newGroup.start === "id" && <label className="field"><span>Entry ID</span><input className="data" aria-label="New group start ID" placeholder="1700000000000-0" maxLength={64} value={newGroup.id} onChange={e => setNewGroup({ ...newGroup, id: e.target.value })} data-testid="stream-new-group-id" /></label>}
          <label className="checkbox"><input type="checkbox" checked={newGroup.mkstream} onChange={e => setNewGroup({ ...newGroup, mkstream: e.target.checked })} data-testid="stream-new-group-mkstream" />Create the stream if it is missing (MKSTREAM)</label>
          <button type="submit" disabled={busy || !newGroup.name || !startValid} data-testid="stream-new-group-create">Create group</button>
        </div>
        <p className="muted">Will run <code className="data" data-testid="stream-new-group-command">{createArgs.map((a, i) => (i < 2 ? a : cliArg(a))).join(" ")}</code></p>
      </form>}
      {outcome && <p role="status" data-testid="stream-lifecycle-outcome">{outcome}</p>}
      {entryId && <PendingPayload key={entryId} keyName={keyName} id={entryId} close={() => setEntryId(undefined)} />}
    </div>}
  </details>;
}

/** Payload lookup is bounded independently of the PEL; deleted payloads are reported as absent. */
function PendingPayload({ keyName, id, close }: { keyName: Bin; id: string; close: () => void }) {
  const db = useDatabase();
  const data = useQuery({ queryKey: ["pending-payload", db.id, keyName, id], queryFn: ({ signal }) => request<KeyDetails>(dbPath(db.id, "/key/read"), { method: "POST", body: { key: keyName, streamStart: id, streamEnd: id, count: 1 }, signal }) });
  const entry = data.data?.value.type === "stream" ? data.data.value.entries[0] : undefined;
  return <Modal title={`Stream entry ${id}`} onClose={close} testId="pending-entry-dialog">
    <ErrorState error={data.error} />{data.isPending && <Loading label="Reading stream entry…" />}
    {data.isSuccess && !entry && <p>The payload for this pending ID was deleted or trimmed.</p>}
    {entry?.fields.map((field, i) => <details key={i} open><summary>{displayBin(field.field)}</summary><PendingField value={field.value} truncated={!!field.truncated} keyName={keyName} reference={field.ref} /></details>)}
  </Modal>;
}
function PendingField({ value, truncated, keyName, reference }: { value: Bin; truncated: boolean; keyName: Bin; reference?: ElementRef }) {
  const db = useDatabase();
  const [full, setFull] = useState<Bin>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  return <><ValueViewer value={full ?? value} truncated={truncated && !full} />
    {truncated && !full && reference && <button type="button" disabled={busy} onClick={() => {
      setBusy(true); setError(undefined);
      void request<KeyElementResponse>(dbPath(db.id, "/key/element"), { method: "POST", body: { key: keyName, ref: reference } }).then(response => setFull(response.value)).catch(setError).finally(() => setBusy(false));
    }}>Load full pending value (server capped)</button>}<ErrorState error={error} /></>;
}
