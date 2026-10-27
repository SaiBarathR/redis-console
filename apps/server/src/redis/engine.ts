/**
 * Redis-compatible servers that are not Redis (Valkey, for one) report a Redis version for compatibility in
 * `redis_version` and their own name and version in `server_name` / `<name>_version`. Feature checks keep using the
 * compatibility version; this is only for showing what the server is.
 */
const NAMES = new Map([['valkey', 'Valkey']]);
const MAX = 32;

/** The server's own name and version; `version` is empty when it reports none (not the compatibility version). */
export function serverEngine(info: Record<string, Record<string, string>>): { name: string; version: string } | undefined {
  const s = info.server ?? {};
  const reported = s.server_name?.trim();
  const id = reported?.toLowerCase();
  if (!reported || !id || id === 'redis') return undefined;
  const own = Object.hasOwn(s, `${reported}_version`) ? s[`${reported}_version`] : Object.hasOwn(s, `${id}_version`) ? s[`${id}_version`] : '';
  return { name: (NAMES.get(id) ?? reported).slice(0, MAX), version: (own ?? '').slice(0, MAX) };
}
