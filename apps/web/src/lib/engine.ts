import type { DatabaseSummary } from "@rconsole/shared";

/**
 * What a database server is, for display. Redis-compatible servers that are not Redis (Valkey) report a compatibility
 * `redis_version`; show their own name and version, and keep the compatibility version as a tooltip. Feature checks
 * keep using `server.version`.
 */
export function serverProduct(
  server: DatabaseSummary["server"],
  fallback?: string,
): { name: string; version: string | undefined; title?: string } {
  if (server?.engine) {
    return { name: server.engine.name, version: server.engine.version, title: `Reports Redis ${server.version} for compatibility` };
  }
  return { name: "Redis", version: server?.version ?? fallback };
}
