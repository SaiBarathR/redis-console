/** In-memory token buckets and concurrency slots (single instance). */
import { isIPv4, isIPv6 } from 'node:net';

/** Most buckets kept; above this, full (idle) buckets are dropped first, then the least recently used. */
export const MAX_BUCKETS = 100_000;

interface Bucket { tokens: number; at: number; perSecond: number; burst: number }

/**
 * The network a client address is limited as: IPv4 as is, IPv6 by prefix (`bits`, default /64), because one
 * host usually holds a whole /64 and could otherwise rotate through addresses to dodge per-IP limits.
 * IPv4-mapped IPv6 (::ffff:a.b.c.d) is IPv4. Anything unparseable is used verbatim.
 */
export function clientNet(ip: string, bits = 64): string {
  const bare = ip.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped) return mapped[1]!;
  if (isIPv4(bare) || !isIPv6(bare)) return bare;
  const groups = expandIPv6(bare);
  const keep = Math.max(1, Math.min(8, Math.ceil(bits / 16)));
  return `${groups.slice(0, keep).join(':')}::/${keep * 16}`;
}

/** Eight 16-bit groups (lower-case, no leading zeros) of a valid IPv6 address. */
function expandIPv6(ip: string): string[] {
  let addr = ip.toLowerCase();
  // An embedded IPv4 tail (::1.2.3.4, 64:ff9b::1.2.3.4) becomes two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    addr = addr.slice(0, v4.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = addr.includes('::') ? (addr.split('::') as [string, string]) : [addr, undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array<string>(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16).toString(16));
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;
  readonly #max: number;
  #lastGc = 0;
  constructor(now: () => number = Date.now, maxBuckets = MAX_BUCKETS) {
    this.#now = now;
    this.#max = maxBuckets;
  }

  /** Take one token from bucket `key` refilled at `perSecond`, holding at most `burst`. */
  take(key: string, perSecond: number, burst = perSecond): boolean {
    const now = this.#now();
    let b = this.#buckets.get(key);
    if (b) {
      b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
      b.at = now;
      // Most recently used last, so eviction (oldest first) hits idle buckets.
      this.#buckets.delete(key);
    } else {
      b = { tokens: burst, at: now, perSecond, burst };
      if (this.#buckets.size >= this.#max) this.#gc(now);
    }
    b.perSecond = perSecond;
    b.burst = burst;
    this.#buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  get size(): number {
    return this.#buckets.size;
  }

  #gc(now: number) {
    // A bucket that has refilled completely is the same as no bucket: dropping it changes nothing. That sweep
    // is O(n), so it runs at most once a second; in between (and when that is not enough) the least recently
    // used buckets go, which keeps the map bounded whatever the number of client addresses.
    if (now - this.#lastGc >= 1000) {
      this.#lastGc = now;
      for (const [k, b] of this.#buckets) if (b.tokens + ((now - b.at) / 1000) * b.perSecond >= b.burst) this.#buckets.delete(k);
    }
    const target = Math.floor(this.#max * 0.9);
    if (this.#buckets.size < this.#max) return;
    for (const k of this.#buckets.keys()) {
      if (this.#buckets.size <= target) break;
      this.#buckets.delete(k);
    }
  }
}

export class Slots {
  readonly #used = new Map<string, number>();
  /** Acquire a slot; returns a release function, or null when `max` are in use. */
  acquire(key: string, max: number): (() => void) | null {
    const n = this.#used.get(key) ?? 0;
    if (n >= max) return null;
    this.#used.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const m = (this.#used.get(key) ?? 1) - 1;
      if (m <= 0) this.#used.delete(key);
      else this.#used.set(key, m);
    };
  }
  count(key: string): number {
    return this.#used.get(key) ?? 0;
  }
}
