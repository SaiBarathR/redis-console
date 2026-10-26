import type { DatabaseSummary } from "@rconsole/shared";

const hasModule = (db: DatabaseSummary, name: RegExp) => !!db.server?.modules.some((m) => name.test(m.name));

/**
 * Direct command-palette destinations for the Insight tools (v0.2.1, RI parity F8/F4/F10/F12). Paths carry only
 * fixed words (`?panel=`, `?tab=`); index names and queries never go into a URL.
 */
export function insightPaletteEntries(base: string, db: DatabaseSummary): { label: string; path: string }[] {
  const search = hasModule(db, /search/i);
  return [
    ...(search
      ? [
          { label: "Search: query an index", path: `${base}/diagnostics/search` },
          { label: "Search: indexes and details", path: `${base}/diagnostics/search?panel=indexes` },
          { label: "Search: make keys searchable (new index)", path: `${base}/diagnostics/search?panel=create` },
        ]
      : []),
    { label: "Memory analysis and recommendations", path: `${base}/diagnostics/analysis` },
    { label: "Tutorials and recipes", path: `${base}/guided?tab=tutorials` },
    // Imports are an operator feature.
    ...(db.effectiveRole !== "viewer" ? [{ label: "Import commands from a file", path: `${base}/guided?tab=import` }] : []),
  ];
}
