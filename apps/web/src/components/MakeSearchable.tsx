import { useNavigate } from "react-router";
import { Search } from "lucide-react";
import type { Bin, DatabaseSummary } from "@rconsole/shared";
import { useDatabase } from "../lib/context.tsx";
import { useMemorySlot } from "../lib/memory.tsx";
import { folderPrefixes, searchSlots, type WizardHandoff } from "../pages/search/state.ts";

export const hasSearchModule = (db: DatabaseSummary) =>
  !!db.server?.modules.some((m) => /search/i.test(m.name));

/**
 * "Make searchable" (v0.2.1, RI parity F7): opens the index wizard for a hash or JSON key, prefilled with the key's
 * folder as the prefix (every folder level of the key can be chosen there). The key and prefix travel in session
 * memory, never in the URL. Nothing is created until the wizard's reviewed FT.CREATE is confirmed.
 */
export function MakeSearchableButton({
  keyName,
  type,
  delimiter,
}: {
  keyName: Bin;
  type: string;
  delimiter: string;
}) {
  const db = useDatabase();
  const navigate = useNavigate();
  const [, setHandoff] = useMemorySlot<WizardHandoff | undefined>(searchSlots(db.id).handoff, undefined);
  const on = type === "hash" ? "HASH" : type === "ReJSON-RL" ? "JSON" : undefined;
  if (!on || !hasSearchModule(db) || keyName.enc !== "utf8") return null;
  const prefixes = folderPrefixes(keyName.data, delimiter || ":");
  return (
    <button
      type="button"
      className="ghost"
      data-testid="make-searchable"
      title="Create a search index for keys like this one (opens the index wizard; nothing runs until you confirm)"
      onClick={() => {
        setHandoff({ on, prefix: prefixes.at(-1) ?? keyName.data, prefixes, key: keyName });
        navigate(`/db/${encodeURIComponent(db.id)}/diagnostics/search?panel=create`);
      }}
    >
      <Search size={13} aria-hidden="true" />
      Make searchable
    </button>
  );
}
