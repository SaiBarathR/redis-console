/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) with ±1 step window and replay protection. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD = 30;

export function base32Encode(buf: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const code = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD);
}

export function totpCode(secretBase32: string, nowMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs));
}

/**
 * Verify a code. Returns the matched time step, or null. A step <= lastUsedStep is rejected
 * (replay protection): store the returned step and pass it as lastUsedStep next time.
 */
export function verifyTotp(secretBase32: string, code: string, lastUsedStep: number, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretBase32);
  const now = totpStep(nowMs);
  let matched: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    const expected = Buffer.from(hotp(key, step));
    // Compare every candidate (no early exit) to keep timing flat.
    if (timingSafeEqual(expected, Buffer.from(code)) && step > lastUsedStep && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUrl(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  // encodeURIComponent (not URLSearchParams): some authenticator apps show '+' literally instead of a space.
  const q = Object.entries({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: String(TOTP_PERIOD) })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `otpauth://totp/${label}?${q}`;
}
