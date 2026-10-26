import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { CommandDoc } from "@rconsole/shared";
import { useDatabase } from "../../lib/context.tsx";
import { commandPolicy } from "../../lib/policy.ts";
import { useCommandDocs } from "../../pages/Console.tsx";
import { CommandDocumentation } from "../ConsoleAssist.tsx";
import { Badge, ErrorState, Loading } from "../ui.tsx";

export type PolicyFilter = "all" | "allowed" | "not-allowed";

/** "sorted-set" → "Sorted set". COMMAND DOCS groups are lower-case identifiers. */
export function groupLabel(group: string) {
  const text = (group || "other").replace(/[-_]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The catalog filtered by a search (name first, then summary words), a group and the caller's policy verdict,
 * grouped by COMMAND DOCS group in name order. Pure, so it is unit tested.
 */
export function filterCatalog(docs: CommandDoc[], search: string, group: string, policy: PolicyFilter) {
  const needle = search.trim().toLowerCase();
  const matched = docs.filter(
    (doc) =>
      (!group || doc.group === group) &&
      (policy === "all" || (policy === "allowed") === doc.allowed) &&
      (!needle || doc.name.toLowerCase().includes(needle) || doc.summary.toLowerCase().includes(needle)),
  );
  // Names that start with the search come first, so "get" finds GET before HGETALL's summary match.
  const rank = (doc: CommandDoc) =>
    !needle ? 0 : doc.name.toLowerCase().startsWith(needle) ? 0 : doc.name.toLowerCase().includes(needle) ? 1 : 2;
  const groups = new Map<string, CommandDoc[]>();
  for (const doc of [...matched].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))) {
    const list = groups.get(doc.group) ?? [];
    list.push(doc);
    groups.set(doc.group, list);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Command helper (F25): a searchable, grouped catalog of every command the server documents (COMMAND DOCS), each
 * annotated with what the server policy allows for this user on this database. Reading it runs nothing; the server
 * still decides when a command is run.
 */
export function CommandHelper({ onInsert }: { onInsert: (command: string) => void }) {
  const db = useDatabase();
  const docs = useCommandDocs();
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search);
  const [group, setGroup] = useState("");
  const [policy, setPolicy] = useState<PolicyFilter>("all");
  const [selected, setSelected] = useState<string>();
  const all = docs.data ?? [];
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const doc of all) counts.set(doc.group, (counts.get(doc.group) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  }, [all]);
  const shown = useMemo(() => filterCatalog(all, deferred, group, policy), [all, deferred, group, policy]);
  const visible = useMemo(() => shown.flatMap(([, list]) => list), [shown]);
  const count = visible.length;
  // The detail (and Insert) always belongs to a listed command: a selection the filters hide falls back to the first
  // result and is forgotten, so clearing the search later does not bring back a command picked before
  // (review v0.2.1 web L1).
  const current = visible.find((doc) => doc.name === selected) ?? visible[0];
  const hidden = selected !== undefined && !visible.some((doc) => doc.name === selected);
  useEffect(() => {
    if (hidden) setSelected(undefined);
  }, [hidden]);
  if (docs.isPending) return <Loading label="Reading COMMAND DOCS…" />;
  return (
    <div className="command-helper" data-testid="command-helper">
      <ErrorState error={docs.error} onRetry={() => void docs.refetch()} />
      <div className="helper-filters" role="search">
        <input
          type="search"
          className="data"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search commands, e.g. HGET or expire"
          aria-label="Search commands"
          data-testid="command-helper-search"
          maxLength={64}
        />
        <select
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          aria-label="Command group"
          data-testid="command-helper-group"
        >
          <option value="">All groups ({all.length})</option>
          {groups.map(([name, n]) => (
            <option key={name} value={name}>
              {groupLabel(name)} ({n})
            </option>
          ))}
        </select>
        <select
          value={policy}
          onChange={(e) => setPolicy(e.target.value as PolicyFilter)}
          aria-label="Policy"
          data-testid="command-helper-policy"
        >
          <option value="all">Any policy</option>
          <option value="allowed">Allowed for me here</option>
          <option value="not-allowed">Not allowed for me here</option>
        </select>
        <span className="meta" role="status" data-testid="command-helper-count">
          {count} of {all.length} commands · as {db.effectiveRole}
          {db.readOnly ? " · read-only database" : ""}
        </span>
      </div>
      <div className="helper-body">
        <div className="helper-list" role="listbox" aria-label="Commands" tabIndex={-1}>
          {shown.length ? (
            shown.map(([name, list]) => (
              <div key={name} role="group" aria-label={groupLabel(name)}>
                <div className="helper-group">{groupLabel(name)}</div>
                {list.map((doc) => (
                  <button
                    key={doc.name}
                    type="button"
                    role="option"
                    aria-selected={current?.name === doc.name}
                    className={`helper-item ${doc.allowed ? "" : "not-allowed"}`.trim()}
                    onClick={() => setSelected(doc.name)}
                    data-testid="command-helper-item"
                  >
                    <code>{doc.name}</code>
                    <span className="helper-summary">{doc.summary}</span>
                    <span className={`helper-class class-${doc.class}`}>{doc.allowed ? doc.class : "not allowed"}</span>
                  </button>
                ))}
              </div>
            ))
          ) : (
            <p className="muted helper-empty">
              No command matches. Clear the search or choose another group.
            </p>
          )}
        </div>
        <div className="helper-detail" data-testid="command-helper-detail" aria-live="polite">
          {current ? (
            <>
              <header>
                <h3>
                  <code>{current.name}</code>
                </h3>
                <Badge tone={!current.allowed ? "red" : current.class === "read" ? "blue" : "amber"}>
                  {current.allowed ? `${current.class} · allowed` : `${current.class} · not allowed`}
                </Badge>
                <button
                  type="button"
                  className="primary"
                  disabled={!current.allowed}
                  title={current.allowed ? "Put the command on the Console prompt (it does not run)" : current.hint}
                  onClick={() => onInsert(`${current.name} `)}
                  data-testid="command-helper-insert"
                >
                  Insert in Console
                </button>
              </header>
              <CommandDocumentation doc={current} policy={commandPolicy(current.name, all, db)} />
            </>
          ) : (
            <p className="muted">Choose a command to see its syntax, complexity and policy.</p>
          )}
        </div>
      </div>
    </div>
  );
}
