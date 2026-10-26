/** Helpers for auth / SSE / OIDC integration tests. */
import type { FastifyInstance } from 'fastify';
import type { Role } from '@rconsole/shared';
import { hashPassword } from '../../src/security/password.ts';
import { anonymous, type Client, type TestApp } from '../helpers.ts';

export const PASSWORD = 'correct horse battery staple';

export async function createUser(t: TestApp, username: string, role: Role, opts: { password?: string; mustChangePassword?: boolean } = {}) {
  return t.ctx.users.create({
    username,
    displayName: username,
    role,
    passwordHash: await hashPassword(opts.password ?? PASSWORD),
    mustChangePassword: opts.mustChangePassword ?? false,
  });
}

/** Log in over HTTP; returns the client (cookie + csrf updated) and the response. */
export async function login(t: TestApp, username: string, password = PASSWORD, client: Client = anonymous(t)) {
  const r = await client.req('POST', '/api/v1/auth/login', { username, password });
  return { c: client, r };
}

export function setCookies(headers: Record<string, unknown>): string[] {
  const sc = headers['set-cookie'];
  return Array.isArray(sc) ? (sc as string[]) : sc ? [String(sc)] : [];
}

// ---------------------------------------------------------------------------
// SSE over a real socket

export interface SseEvent {
  event: string;
  data: any;
}

export interface SseConn {
  status: number;
  headers: Headers;
  events: SseEvent[];
  /** Resolves when the server ends the stream. */
  ended: Promise<void>;
  isEnded(): boolean;
  waitFor(pred: (e: SseEvent) => boolean, timeoutMs?: number): Promise<SseEvent>;
  close(): void;
  /** JSON body for non-SSE responses (errors). */
  json?: any;
}

export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return `http://127.0.0.1:${addr.port}`;
}

export async function openSse(base: string, path: string, cookie: string): Promise<SseConn> {
  const ac = new AbortController();
  const r = await fetch(base + path, { headers: { cookie, accept: 'text/event-stream' }, signal: ac.signal });
  const events: SseEvent[] = [];
  const waiters: { pred: (e: SseEvent) => boolean; resolve: (e: SseEvent) => void }[] = [];
  let ended = false;
  const conn: SseConn = {
    status: r.status,
    headers: r.headers,
    events,
    ended: Promise.resolve(),
    isEnded: () => ended,
    waitFor(pred, timeoutMs = 8000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: (e: SseEvent) => { clearTimeout(timer); resolve(e); } };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timed out waiting for SSE event; got ${JSON.stringify(events).slice(0, 500)}`));
        }, timeoutMs);
        waiters.push(w);
      });
    },
    close: () => ac.abort(),
  };
  if (!(r.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    conn.json = await r.json().catch(() => undefined);
    ended = true;
    return conn;
  }
  conn.ended = (async () => {
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (!data.length) continue;
          const ev = { event, data: JSON.parse(data.join('\n')) };
          events.push(ev);
          for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
        }
      }
    } catch {
      /* aborted */
    } finally {
      ended = true;
    }
  })();
  return conn;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Open a pub/sub stream the way the browser does: POST /pubsub/subscriptions with the channels in the body,
 * then GET /pubsub/stream?sub=<id>. When the POST fails, its status and body are returned as the SseConn.
 */
export async function openPubSub(base: string, c: Client, db: string, channels: string[], patterns: string[] = []): Promise<SseConn> {
  const r = await c.req('POST', `/api/v1/databases/${db}/pubsub/subscriptions`, { channels, patterns });
  if (r.status !== 200) {
    const never = new Promise<void>(() => {});
    return { status: r.status, headers: new Headers(), events: [], ended: never, isEnded: () => true, waitFor: () => Promise.reject(new Error(`subscription failed: ${r.status}`)), close() {}, json: r.json };
  }
  return openSse(base, `/api/v1/databases/${db}/pubsub/stream?sub=${encodeURIComponent(r.json.id)}`, c.cookie);
}
