/**
 * Request-body budget (review v0.2 r6 H1). Work slots are taken after a body has been parsed, so a stalled upload
 * never holds one (review r5 H1). That left the bodies themselves unbounded: many concurrent near-limit uploads
 * were buffered and parsed before any gate decided, and could exhaust the heap. This budget is reserved when the
 * headers have arrived, before any body byte is read, and held until the response has been serialized or the
 * connection closes (parse failure, receive timeout, disconnect). It therefore covers raw buffers, parsed bodies
 * waiting for a work slot and the handler. It never waits: a full budget is a prompt 429.
 *
 * Every body takes one of its user's and one of the server's body counts. A body larger than SMALL_BODY_BYTES also
 * reserves its size (Content-Length, or the route's body limit for a chunked body) from the user's and the server's
 * byte budgets, so large uploads cannot crowd out ordinary small requests; small bodies are bounded by the counts.
 */
import { HttpError } from '../http/errors.ts';

/** Bodies up to this size take a count only (at most `bodies` × this many bytes together). */
export const SMALL_BODY_BYTES = 64 * 1024;

export interface BodyBudgetLimits {
  /** Request bodies being received or handled at once, server-wide and per user. */
  bodies: number;
  userBodies: number;
  /** Bytes of large bodies at once, server-wide and per user. */
  bytes: number;
  userBytes: number;
}

/** Per-user shares of the configured server-wide limits: an eighth of the bodies, half of the bytes. */
export function bodyBudgetLimits(maxBodies: number, maxBytes: number, bodyLimit: number): BodyBudgetLimits {
  return {
    bodies: maxBodies,
    userBodies: Math.max(1, Math.ceil(maxBodies / 8)),
    bytes: maxBytes,
    // One user can always send one body of the largest route limit.
    userBytes: Math.min(maxBytes, Math.max(bodyLimit, Math.floor(maxBytes / 2))),
  };
}

const mib = (n: number) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MiB`;

export class BodyBudget {
  readonly limits: BodyBudgetLimits;
  #bodies = 0;
  #bytes = 0;
  readonly #users = new Map<string, { bodies: number; bytes: number }>();
  constructor(limits: BodyBudgetLimits) {
    this.limits = limits;
  }

  /** Reserve one body of `size` bytes for `who`; returns its (idempotent) release, or throws 429 naming the limit. */
  reserve(who: string, size: number): () => void {
    const l = this.limits;
    const bytes = size > SMALL_BODY_BYTES ? size : 0;
    const u = this.#users.get(who) ?? { bodies: 0, bytes: 0 };
    if (u.bodies >= l.userBodies) {
      throw new HttpError('rate_limited', `You have too many requests being sent at once (limit ${l.userBodies} request bodies); try again shortly.`);
    }
    if (bytes && u.bytes + bytes > l.userBytes) {
      throw new HttpError('rate_limited', `Your uploads in progress already use your request-body budget (${mib(l.userBytes)}); wait for them to finish.`);
    }
    if (this.#bodies >= l.bodies) {
      throw new HttpError('rate_limited', `The server is receiving too many request bodies (limit ${l.bodies}); try again shortly.`);
    }
    if (bytes && this.#bytes + bytes > l.bytes) {
      throw new HttpError('rate_limited', `Uploads in progress use the server's request-body budget (${mib(l.bytes)}); try again shortly.`);
    }
    u.bodies++;
    u.bytes += bytes;
    this.#users.set(who, u);
    this.#bodies++;
    this.#bytes += bytes;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      u.bodies--;
      u.bytes -= bytes;
      if (u.bodies === 0 && this.#users.get(who) === u) this.#users.delete(who);
      this.#bodies--;
      this.#bytes -= bytes;
    };
  }

  /** What is reserved now, server-wide or for one user (tests, diagnostics). */
  usage(who?: string): { bodies: number; bytes: number } {
    if (who === undefined) return { bodies: this.#bodies, bytes: this.#bytes };
    const u = this.#users.get(who);
    return { bodies: u?.bodies ?? 0, bytes: u?.bytes ?? 0 };
  }
}
