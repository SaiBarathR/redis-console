/** Minimal cookie parsing/serialization (avoids a dependency). */
export function parseCookies(header: string | undefined): Record<string, string> {
  // Null prototype: names like __proto__ or constructor are plain keys.
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    let value = part.slice(i + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax';
  path?: string;
  maxAgeSeconds?: number;
}

export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('invalid cookie name');
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${o.path ?? '/'}`];
  if (o.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(o.maxAgeSeconds)}`);
  if (o.httpOnly !== false) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  parts.push(`SameSite=${o.sameSite ?? 'Strict'}`);
  return parts.join('; ');
}
