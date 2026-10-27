/**
 * Redis-compatible servers that are not Redis (Valkey, for one) report a Redis version for compatibility in
 * `redis_version` and their own name and version in `server_name` / `<name>_version`. Feature checks keep using the
 * compatibility version; this is only for showing what the server is.
 */
const NAMES: Record<string, string> = { valkey: 'Valkey' };
const MAX = 32;

export function serverEngine(info: Record<string, Record<string, string>>): { name: string; version: string } | undefined {
  const s = info.server ?? {};
  const id = s.server_name?.trim().toLowerCase();
  if (!id || id === 'redis') return undefined;
  const version = s[`${id}_version`] ?? s.redis_version ?? '';
  return { name: (NAMES[id] ?? id).slice(0, MAX), version: version.slice(0, MAX) };
}
