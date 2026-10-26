import { createContext, useContext } from "react";
import type { DatabaseSummary, Me } from "@rconsole/shared";
export interface SessionContextValue {
  me: Me;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
}
export const SessionContext = createContext<SessionContextValue | null>(null);
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("Session unavailable.");
  return value;
}
export const DatabaseContext = createContext<DatabaseSummary | null>(null);
export function useDatabase() {
  const value = useContext(DatabaseContext);
  if (!value) throw new Error("Choose a database first.");
  return value;
}
export function canWrite(db: DatabaseSummary) {
  return !db.readOnly && db.effectiveRole !== "viewer";
}
/** Command-file imports are an operator feature (the server refuses a viewer, also on read-only databases). */
export function canImport(db: DatabaseSummary) {
  return db.effectiveRole !== "viewer";
}
export function canAdmin(db: DatabaseSummary) {
  return !db.readOnly && db.effectiveRole === "admin";
}
