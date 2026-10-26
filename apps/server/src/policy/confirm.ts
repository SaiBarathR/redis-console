/**
 * Confirmation challenges for destructive actions: 428 + single-use token bound to the session and a
 * hash of the exact request; expires after 2 minutes. Typed confirmations must match the database
 * name; prod writes also need a reason (which lands in the audit log).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Confirmation, ConfirmationChallenge } from '@rconsole/shared';
import { HttpError } from '../http/errors.ts';
import { hashToken, randomToken } from '../store/sessions.ts';
import type { ConfirmSpec } from './policy.ts';

export const CONFIRM_TTL_MS = 2 * 60_000;
const MAX_PENDING = 10_000;
/** Outstanding challenges per session; older ones of that session are dropped (never other users'). */
export const MAX_PENDING_PER_SESSION = 20;

interface Pending {
  sessionHash: string;
  requestHash: string;
  spec: ConfirmSpec;
  expiresAt: number;
}

/** Canonical JSON (sorted keys) so the hash does not depend on key order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Hash of the request identity: route + database + body without the `confirmation` field. */
export function requestHash(route: string, dbId: string, body: unknown): string {
  let b = body;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const { confirmation: _c, ...rest } = b as Record<string, unknown>;
    b = rest;
  }
  return createHash('sha256').update(`${route}\n${dbId}\n${canonical(b)}`).digest('hex');
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** A confirmation that held: the audit reason (prod writes) and, for a bulk delete, the impact count it showed. */
export interface Confirmed {
  reason?: string;
  confirmedKeys?: { keys: number; complete: boolean };
}

export class Confirmations {
  readonly #pending = new Map<string, Pending>();
  /** sessionHash -> token hashes in issue order. */
  readonly #bySession = new Map<string, string[]>();
  readonly #now: () => number;
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issue(sessionHash: string, reqHash: string, spec: ConfirmSpec): ConfirmationChallenge {
    this.#sweep();
    const token = randomToken(32);
    const key = hashToken(token);
    const mine = (this.#bySession.get(sessionHash) ?? []).filter((k) => this.#pending.has(k));
    while (mine.length >= MAX_PENDING_PER_SESSION) this.#pending.delete(mine.shift()!);
    mine.push(key);
    this.#bySession.set(sessionHash, mine);
    this.#pending.set(key, { sessionHash, requestHash: reqHash, spec, expiresAt: this.#now() + CONFIRM_TTL_MS });
    const ch: ConfirmationChallenge = { token, level: spec.level, reasonRequired: spec.reasonRequired, summary: spec.summary, preview: spec.preview };
    if (spec.expectedText !== undefined) ch.expectedText = spec.expectedText;
    if (spec.impact) ch.impact = spec.impact;
    return ch;
  }

  /**
   * Require a valid confirmation. Without one (or with an invalid/expired/mismatched one) this throws
   * 428 with a fresh challenge. Returns the audit reason on success. Tokens are consumed on any use.
   */
  require(sessionHash: string, reqHash: string, spec: ConfirmSpec, c: Confirmation | undefined): Confirmed {
    if (!c) throw this.#challenge(sessionHash, reqHash, spec, 'Confirmation required.');
    const key = hashToken(c.token);
    const p = this.#pending.get(key);
    this.#pending.delete(key);
    if (!p || p.expiresAt <= this.#now()) throw this.#challenge(sessionHash, reqHash, spec, 'Confirmation expired or invalid; confirm again.');
    if (!eq(p.sessionHash, sessionHash) || !eq(p.requestHash, reqHash)) {
      throw this.#challenge(sessionHash, reqHash, spec, 'Confirmation does not match this request; confirm again.');
    }
    // The spec in force is the one issued with the token (it cannot be weakened by the resubmission).
    const s = p.spec;
    if (s.level === 'typed' && (c.typed ?? '') !== s.expectedText) {
      throw this.#challenge(sessionHash, reqHash, spec, 'Typed confirmation text does not match the database name.');
    }
    if (s.reasonRequired && !c.reason) throw this.#challenge(sessionHash, reqHash, spec, 'A reason is required for changes to production databases.');
    const out: Confirmed = {};
    if (c.reason) out.reason = c.reason;
    // What the user was shown and confirmed (a bulk delete's counted keys), for progress reports.
    if (s.preview.bulk?.keys !== undefined) out.confirmedKeys = { keys: s.preview.bulk.keys, complete: s.preview.bulk.complete !== false };
    return out;
  }

  #challenge(sessionHash: string, reqHash: string, spec: ConfirmSpec, message: string): HttpError {
    return new HttpError('confirmation_required', message, { confirmation: this.issue(sessionHash, reqHash, spec) });
  }

  #sweep() {
    const now = this.#now();
    if (this.#pending.size < 1000 && Math.random() > 0.05) return;
    for (const [k, p] of this.#pending) if (p.expiresAt <= now) this.#pending.delete(k);
    for (const [s, keys] of this.#bySession) {
      const live = keys.filter((k) => this.#pending.has(k));
      if (live.length) this.#bySession.set(s, live);
      else this.#bySession.delete(s);
    }
    // Hard cap: drop the oldest entries.
    while (this.#pending.size >= MAX_PENDING) {
      const first = this.#pending.keys().next().value;
      if (first === undefined) break;
      this.#pending.delete(first);
    }
  }

  get size() {
    return this.#pending.size;
  }
}
