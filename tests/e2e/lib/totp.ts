/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), computed in the test. */
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './env.ts';

export function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = alphabet.indexOf(c);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totpAt(secretBase32: string, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const off = h[h.length - 1]! & 0x0f;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
  return code;
}

export const counterNow = (): number => Math.floor(Date.now() / 1000 / 30);

const usedFile = path.join(STATE_DIR, 'totp-used.json');
function loadUsed(): Record<string, number> {
  try { return JSON.parse(readFileSync(usedFile, 'utf8')); } catch { return {}; }
}

/**
 * Returns a code that has not been used before for this secret (the server is
 * replay-protected), waiting for the next 30 s step when necessary.
 */
export async function freshTotp(secretBase32: string): Promise<string> {
  const used = loadUsed();
  const last = used[secretBase32] ?? -1;
  let c = counterNow();
  while (c <= last) {
    const msToNext = 30_000 - (Date.now() % 30_000) + 250;
    await new Promise((r) => setTimeout(r, msToNext));
    c = counterNow();
  }
  // Avoid handing out a code that expires mid-request.
  if (30_000 - (Date.now() % 30_000) < 1500) {
    await new Promise((r) => setTimeout(r, 1600));
    c = counterNow();
  }
  used[secretBase32] = c;
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(usedFile, JSON.stringify(used));
  return totpAt(secretBase32, c);
}
