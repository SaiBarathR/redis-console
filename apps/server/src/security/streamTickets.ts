/**
 * Single-use tickets for SSE streams that need sensitive parameters (channel names, patterns).
 *
 * EventSource can only GET, and URLs end up in reverse-proxy and load-balancer logs. The client POSTs the
 * parameters, gets an opaque id, and opens `GET ...?sub=<id>`. An id is: random (256 bit, only its hash is
 * stored), bound to the session and database that created it, consumed on first use, and valid for
 * `ttlMs` (60 s) to connect.
 */
import { timingSafeEqual } from 'node:crypto';
import { hashToken, randomToken } from '../store/sessions.ts';

export const MAX_TICKETS_PER_SESSION = 10;
const MAX_TICKETS = 10_000;

interface Ticket<T> {
  sessionHash: string;
  dbId: string;
  params: T;
  expiresAt: number;
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class StreamTickets<T> {
  readonly #tickets = new Map<string, Ticket<T>>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  constructor(ttlMs: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  issue(sessionHash: string, dbId: string, params: T): { id: string; expiresAt: number } {
    this.#sweep();
    // Per-session cap: drop that session's oldest tickets (never other users').
    const mine = [...this.#tickets].filter(([, t]) => t.sessionHash === sessionHash);
    for (let i = 0; i <= mine.length - MAX_TICKETS_PER_SESSION; i++) this.#tickets.delete(mine[i]![0]);
    while (this.#tickets.size >= MAX_TICKETS) {
      const first = this.#tickets.keys().next().value;
      if (first === undefined) break;
      this.#tickets.delete(first);
    }
    const id = randomToken(32);
    const expiresAt = this.#now() + this.#ttlMs;
    this.#tickets.set(hashToken(id), { sessionHash, dbId, params, expiresAt });
    return { id, expiresAt };
  }

  /** Consume a ticket. Returns its parameters, or null when unknown, expired, or not this session's/database's. */
  take(id: string, sessionHash: string, dbId: string): T | null {
    const key = hashToken(id);
    const t = this.#tickets.get(key);
    this.#tickets.delete(key);
    if (!t || t.expiresAt <= this.#now()) return null;
    if (!eq(t.sessionHash, sessionHash) || t.dbId !== dbId) return null;
    return t.params;
  }

  #sweep() {
    const now = this.#now();
    for (const [k, t] of this.#tickets) if (t.expiresAt <= now) this.#tickets.delete(k);
  }

  get size() {
    return this.#tickets.size;
  }
}
