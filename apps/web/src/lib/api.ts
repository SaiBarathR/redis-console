import {
  API_BASE,
  type ApiError,
  type Confirmation,
  type ConfirmationChallenge,
  type EditConflict,
} from "@rconsole/shared";

/** Successful writes per database from this tab (a counter, no data), so a key scan can tell it is older. */
const writes = new Map<string, number>();
export const writeCount = (database: string) => writes.get(database) ?? 0;
/** Query parameter names the server rejects with 400 (Redis data must never travel in URLs). */
export const FORBIDDEN_QUERY_PARAMS = new Set([
  "k",
  "key",
  "keys",
  "match",
  "pattern",
  "patterns",
  "channel",
  "channels",
  "group",
  "query",
  "q",
]);
const GUIDANCE: Partial<Record<ApiError["error"]["code"], string>> = {
  too_large:
    "The reply would be too large to return. Use a ranged or SCAN-family command instead.",
  rate_limited: "Too many requests at once. Wait a moment, then try again.",
  timeout: "Redis did not answer in time. Narrow the command and try again.",
  unavailable: "The database is unavailable right now. Try again shortly.",
};
/**
 * Server message plus actionable guidance for limits. Hints are appended only for codes whose hint is text for
 * people (machine hints such as `password_change_required` are not shown).
 */
export function friendlyMessage(error: Pick<ApiError["error"], "code" | "message" | "hint">) {
  const parts = [error.message.trim()];
  if (error.hint && (error.code === "too_large" || error.code === "command_blocked"))
    parts.push(error.hint.trim());
  else if (GUIDANCE[error.code]) parts.push(GUIDANCE[error.code]!);
  // Punctuate everything but the last part: a hint may end in a command, which must stay copyable as-is.
  return parts
    .filter(Boolean)
    .map((part, i, all) => (i === all.length - 1 || /[.!?]$/.test(part) ? part : `${part}.`))
    .join(" ");
}
export class RequestError extends Error {
  status: number;
  code: string;
  hint?: string;
  challenge?: ConfirmationChallenge;
  /** 409 `conflict`: the compare-and-set expectation did not hold; what Redis holds now. */
  conflict?: EditConflict;
  constructor(status: number, error: ApiError["error"]) {
    super(friendlyMessage(error));
    this.name = "RequestError";
    this.status = status;
    this.code = error.code;
    this.hint = error.hint;
    this.challenge = error.confirmation;
    if (error.code === "conflict" && error.conflict) this.conflict = error.conflict;
  }
}
/** Ends the client session view; `reason` is shown on the sign-in page. */
export function endSession(reason?: string) {
  window.dispatchEvent(new CustomEvent("session-expired", { detail: reason }));
}
/** Where a challenge came from, so the dialog can name the database it applies to. */
export interface ConfirmContext {
  databaseId?: string;
  /** Client-side context shown beside (never instead of) the server summary and preview. */
  note?: string;
}
export type ConfirmHandler = (
  challenge: ConfirmationChallenge,
  context: ConfirmContext,
) => Promise<Confirmation>;
let csrfToken = "";
let confirmHandler: ConfirmHandler | undefined;
export function setCsrfToken(token: string) {
  csrfToken = token;
}
export function setConfirmHandler(handler: ConfirmHandler | undefined) {
  confirmHandler = handler;
}
export const dbPath = (id: string, path: string) =>
  `/databases/${encodeURIComponent(id)}${path}`;
export function query(params: Record<string, string | number | undefined>) {
  const result = new URLSearchParams();
  for (const name of Object.keys(params))
    if (FORBIDDEN_QUERY_PARAMS.has(name.toLowerCase()))
      throw new Error(`"${name}" cannot be sent in a URL. Send it in the request body.`);
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) result.set(key, String(value));
  return `?${result}`;
}
/**
 * POST routes that only read: Redis data travels in bodies, never URLs (D15), so these reads are POSTs. Every other
 * POST or PATCH may change something and is never retried.
 */
const READ_POSTS =
  /^\/databases\/[^/]+\/(keys\/(scan|names|meta)|key\/(read|element)|streams\/(groups|pending)|timeseries\/range|search\/(query|index\/info|sample)|pubsub\/channels)$/;
/** Whether a 429 for this request may be retried: reads only, never writes (v0.3 follow-up 6). */
export function retriesOnRateLimit(method: string, path: string): boolean {
  return method === "GET" || (method === "POST" && READ_POSTS.test(path));
}
/** Retries of a rate-limited read: exponential backoff with full jitter, never earlier than `Retry-After`. */
export const READ_RETRY = { retries: 4, baseMs: 250, capMs: 4000, maxRetryAfterMs: 10_000 };
/** `Retry-After` as milliseconds (delta-seconds or an HTTP date); 0 when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return 0;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}
/** How long to wait before retry number `attempt` (0-based): what the server asked for, plus full jitter. */
export function retryDelayMs(attempt: number, retryAfter: number, random = Math.random): number {
  const ceiling = Math.min(READ_RETRY.capMs, READ_RETRY.baseMs * 2 ** attempt);
  return retryAfter + Math.floor(random() * ceiling);
}
function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
export async function request<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH";
    body?: unknown;
    signal?: AbortSignal;
    /** Extra context for a confirmation dialog, e.g. the client name behind an id. */
    note?: string;
    /** Automatic polls must not extend the server idle deadline. */
    background?: boolean;
  } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const originalBody = options.body;
  const retryable = retriesOnRateLimit(method, path);
  let rateLimited = 0;
  let confirmation: Confirmation | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = confirmation
      ? {
          ...(originalBody && typeof originalBody === "object"
            ? originalBody
            : {}),
          confirmation,
        }
      : originalBody;
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal,
      headers: {
        Accept: "application/json",
        ...(options.background ? { "X-RC-Background": "1" } : {}),
        ...(method !== "GET"
          ? { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }
          : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload: unknown =
      response.status === 204
        ? undefined
        : await response.json().catch(() => undefined);
    if (response.ok) {
      if (!options.background && !path.startsWith("/auth/"))
        window.dispatchEvent(new Event("rconsole:request-completed"));
      const mutation =
        /^\/databases\/([^/]+)\/(ops|cli|workbench|bulk-delete|pubsub\/publish|slowlog\/reset|clients\/kill)$/.exec(
          path,
        );
      const kind = mutation?.[2];
      const record =
        payload && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : undefined;
      const changed =
        kind === "cli"
          ? record?.commandClass !== "read"
          : kind === "workbench"
            ? Array.isArray(record?.results) &&
              record.results.some(
                (result) =>
                  result &&
                  typeof result === "object" &&
                  "commandClass" in result &&
                  result.commandClass !== "read",
              )
            : !!mutation;
      if (method !== "GET" && mutation?.[1] && changed) {
        const database = decodeURIComponent(mutation[1]);
        writes.set(database, (writes.get(database) ?? 0) + 1);
        window.dispatchEvent(
          new CustomEvent("rconsole:database-updated", { detail: database }),
        );
      }
      return payload as T;
    }
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? (payload as ApiError).error
        : {
            code: "internal" as const,
            message: `Request failed (${response.status}). Try again.`,
          };
    // A read refused by a limit (per-user slots, budgets) is retried with backoff and jitter, never sooner than the
    // server's Retry-After; a write never is, because it may have to be confirmed or may not be repeatable.
    if (response.status === 429 && retryable && rateLimited < READ_RETRY.retries) {
      const asked = retryAfterMs(response.headers.get("Retry-After"));
      if (asked <= READ_RETRY.maxRetryAfterMs) {
        await wait(retryDelayMs(rateLimited, asked), options.signal);
        rateLimited++;
        attempt--;
        continue;
      }
    }
    if (
      response.status === 428 &&
      error.code === "confirmation_required" &&
      error.confirmation &&
      confirmHandler &&
      attempt === 0
    ) {
      const database = /^\/databases\/([^/]+)\//.exec(path)?.[1];
      confirmation = await confirmHandler(error.confirmation, {
        databaseId: database ? decodeURIComponent(database) : undefined,
        note: options.note,
      });
      continue;
    }
    if (response.status === 401 && path !== "/auth/me" && !path.startsWith("/auth/login"))
      endSession(error.message);
    throw new RequestError(response.status, error);
  }
  throw new Error("Confirmation expired. Please try again.");
}
export const post = <T>(path: string, body: unknown = {}, note?: string) =>
  request<T>(path, { method: "POST", body, note });
/** Transitional envelope compatibility until all response envelopes are documented. */
export function collection<T>(
  data: T[] | Record<string, unknown>,
  key: string,
): T[] {
  if (Array.isArray(data)) return data;
  const items = data[key];
  if (!Array.isArray(items))
    throw new Error(
      "Unexpected response from the server. Refresh the view or check server compatibility.",
    );
  return items as T[];
}
