import type { ApiError, ConfirmationChallenge, EditConflict } from '@rconsole/shared';

export type ErrorCode = ApiError['error']['code'];

export const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  csrf: 403,
  not_found: 404,
  validation: 400,
  command_blocked: 403,
  confirmation_required: 428,
  conflict: 409,
  read_only: 403,
  rate_limited: 429,
  too_large: 413,
  timeout: 504,
  redis_error: 502,
  unavailable: 503,
  internal: 500,
};

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly extra: { confirmation?: ConfirmationChallenge; hint?: string; conflict?: EditConflict; details?: unknown };
  /** 429: whole seconds a client should wait before trying again, sent as `Retry-After` (RFC 9110 § 10.2.3). */
  retryAfterSeconds?: number;
  constructor(code: ErrorCode, message: string, extra: HttpError['extra'] = {}) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.extra = extra;
    // Most limits are concurrency slots or per-second budgets that free up within a second.
    if (code === 'rate_limited') this.retryAfterSeconds = 1;
  }
  /** Ask for a longer wait (a slowly refilling budget such as sign-ins). */
  retryAfter(seconds: number): this {
    this.retryAfterSeconds = Math.max(1, Math.ceil(seconds));
    return this;
  }
  toBody(): ApiError {
    return { error: { code: this.code, message: this.message, ...this.extra } };
  }
}

export const errorBody = (code: ErrorCode, message: string, extra: HttpError['extra'] = {}): ApiError => ({ error: { code, message, ...extra } });
