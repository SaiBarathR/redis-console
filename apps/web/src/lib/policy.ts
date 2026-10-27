import {
  argumentRule,
  lookupRule,
  roleAtLeast,
  tokenizeCommandLine,
  CLASS_MIN_ROLE,
  type CommandDoc,
  type DatabaseSummary,
} from "@rconsole/shared";
/**
 * Whether the database's command catalog (GET …/commands) has loaded. Commands without a shared rule are classified
 * from it, so before it arrives their class is unknown, not "unavailable".
 */
export type CatalogState = "ready" | "loading" | "error";
export const LOADING_HINT = "Loading command info…";
export const CATALOG_ERROR_HINT =
  "Command info could not be loaded. Press Enter to try again.";
export function commandPolicy(
  line: string,
  docs: CommandDoc[],
  database: DatabaseSummary,
  catalog: CatalogState = "ready",
): {
  class: string;
  allowed: boolean;
  hint: string;
  doc?: CommandDoc;
  destructive?: boolean;
  /** The catalog has not loaded yet (or failed): the class is unknown, so the command is held, never refused. */
  pending?: boolean;
} {
  let argv: string[];
  try {
    argv = tokenizeCommandLine(line);
  } catch (error) {
    return {
      class: "blocked",
      allowed: false,
      hint: error instanceof Error ? error.message : "Invalid command syntax.",
    };
  }
  if (!argv.length)
    return {
      class: "idle",
      allowed: false,
      hint: "Enter a command to see its policy.",
    };
  const name = (argv[0] ?? "").toUpperCase();
  const pair = `${name} ${(argv[1] ?? "").toUpperCase()}`;
  const doc =
    docs.find((item) => item.name.toUpperCase() === pair) ??
    docs.find((item) => item.name.toUpperCase() === name);
  const rule = argumentRule(argv) ?? lookupRule(argv);
  // A shared rule for this exact argv decides, as it does on the server (authorize checks the rule's class against the
  // role, read-only and prod, all known here). The catalog classifies bare names, and a rule that refuses some argument
  // shapes (GRAPH.INFO without ObjectPool) marks the bare name blocked there, so its verdict and hint apply only to
  // commands without a shared rule (v0.4 r1 live QA).
  const verdict = rule ? undefined : doc;
  if (!rule && !doc && catalog !== "ready")
    return catalog === "loading"
      ? { class: "loading", allowed: false, pending: true, hint: LOADING_HINT }
      : { class: "unknown", allowed: false, pending: true, hint: CATALOG_ERROR_HINT };
  const commandClass = rule?.class ?? doc?.class ?? "blocked";
  const required =
    commandClass === "read" ||
    commandClass === "write" ||
    commandClass === "admin"
      ? CLASS_MIN_ROLE[commandClass]
      : undefined;
  const allowed =
    required !== undefined &&
    roleAtLeast(database.effectiveRole, required) &&
    !(database.readOnly && commandClass !== "read") &&
    verdict?.allowed !== false &&
    !(rule?.nonProdOnly && database.environment === "prod");
  const destructive = !!rule?.confirm && rule.confirm !== "none";
  const hint =
    (database.readOnly && (commandClass === "write" || commandClass === "admin")
      ? "This database is read-only. Writes are refused for every role."
      : undefined) ??
    rule?.hint ??
    verdict?.hint ??
    (database.readOnly && commandClass !== "read"
      ? "This database is read-only."
      : !allowed
        ? "This command is unavailable for your role or database."
        : commandClass === "read"
          ? "Reads data. Makes no changes."
          : "Changes data. Server policy and confirmation apply.");
  return { class: commandClass, allowed, hint, doc, destructive };
}
