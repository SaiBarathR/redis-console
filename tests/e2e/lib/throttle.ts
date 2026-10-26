/**
 * The server rate-limits sign-in endpoints (login, TOTP verify, password change, TOTP confirm, recovery codes)
 * per client IP: burst 10, refill 10/minute. Every test client is 127.0.0.1, so the suite paces
 * itself with a mirror of that token bucket (shared across workers via a state file).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './env.ts';

const FILE = path.join(STATE_DIR, 'login-bucket.json');
const BURST = 9; // one below the server's 10, as a safety margin
const PER_MS = 1 / 6500; // slightly slower than the server's 1 per 6 s

function load(): { tokens: number; at: number } {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { tokens: BURST, at: Date.now() }; }
}
function save(b: { tokens: number; at: number }) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(b));
}

/** Waits until a sign-in request may be sent without hitting the server's per-IP limit. */
export async function loginThrottle(n = 1): Promise<void> {
  for (;;) {
    const b = load();
    const now = Date.now();
    b.tokens = Math.min(BURST, b.tokens + (now - b.at) * PER_MS);
    b.at = now;
    if (b.tokens >= n) {
      b.tokens -= n;
      save(b);
      return;
    }
    await new Promise((r) => setTimeout(r, Math.ceil((n - b.tokens) / PER_MS) + 50));
  }
}

/** Call after deliberately exhausting the server's bucket (rate-limit tests). */
export function loginBucketExhausted(): void {
  save({ tokens: -1, at: Date.now() });
}
