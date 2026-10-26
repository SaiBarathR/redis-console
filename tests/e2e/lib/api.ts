/**
 * Thin API client over Playwright's APIRequestContext (own cookie jar).
 * - adds X-CSRF-Token + same-origin Origin on non-GET requests by default
 * - scans every response body for secret leaks (see leak.ts)
 */
import { request as pwRequest, expect, type APIRequestContext } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_URL, STATE_DIR } from './env.ts';
import { recordScan } from './leak.ts';
import { freshTotp } from './totp.ts';
import { loginThrottle } from './throttle.ts';

export const API = '/api/v1';

export interface ApiResponse<T = any> {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: T;
}

export interface ReqOpts {
  csrf?: string | null; // null = omit header; undefined = session token
  origin?: string | null; // null = omit; undefined = BASE_URL
  headers?: Record<string, string>;
  /** Skip the leak scan (only for deliberately raw/huge payloads; never for auth). */
  noScan?: boolean;
  /** Skip the client-side sign-in pacing (rate-limit tests only). */
  noThrottle?: boolean;
  /** Return 429 responses instead of backing off and retrying (rate-limit tests only). */
  noRetry?: boolean;
}

export interface Account { username: string; password: string; totpSecret?: string; role: 'viewer' | 'operator' | 'admin' }
export type Accounts = Record<string, Account>;
export const ACCOUNTS_FILE = path.join(STATE_DIR, 'accounts.json');

export function loadAccounts(): Accounts {
  if (!existsSync(ACCOUNTS_FILE)) throw new Error('accounts.json missing: the "setup" project must run first');
  return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
}
export function saveAccount(key: string, acc: Account): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const cur: Accounts = existsSync(ACCOUNTS_FILE) ? JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')) : {};
  cur[key] = acc;
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(cur, null, 1), { mode: 0o600 });
}
export const storageFile = (key: string) => path.join(STATE_DIR, `storage-${key}.json`);

export function assertNoLeaks(text: string, source: string): void {
  const f = recordScan(text, source);
  expect(f, `secret leak in ${source}: ${JSON.stringify(f)}`).toEqual([]);
}

export class Api {
  csrf = '';
  me: any = null;
  ctx: APIRequestContext;
  constructor(ctx: APIRequestContext) { this.ctx = ctx; }

  static async anonymous(): Promise<Api> {
    // Explicit empty state: inside a test, request.newContext() would otherwise inherit the test's
    // `use.storageState` (e.g. the admin cookie), and logging in from that jar replaces the admin session.
    return new Api(await pwRequest.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } }));
  }

  static async fromStorage(key: string): Promise<Api> {
    const api = new Api(await pwRequest.newContext({ baseURL: BASE_URL, storageState: storageFile(key) }));
    const me = await api.get(`${API}/auth/me`);
    expect(me.status, `stored session for ${key} is no longer valid`).toBe(200);
    api.me = me.json;
    api.csrf = me.json.csrfToken;
    return api;
  }

  /** Full local login (password, then TOTP when required). */
  static async login(acc: Pick<Account, 'username' | 'password' | 'totpSecret'>): Promise<Api> {
    const api = await Api.anonymous();
    await api.loginWith(acc);
    return api;
  }

  async loginWith(acc: Pick<Account, 'username' | 'password' | 'totpSecret'>): Promise<ApiResponse> {
    const r = await this.post(`${API}/auth/login`, { username: acc.username, password: acc.password }, { csrf: null });
    if (r.status !== 200) throw new Error(`login ${acc.username} failed: ${r.status} ${r.text.slice(0, 200)}`);
    if (r.json.totpRequired) {
      if (!acc.totpSecret) throw new Error(`login ${acc.username}: TOTP required but no secret known`);
      const code = await freshTotp(acc.totpSecret);
      const v = await this.post(`${API}/auth/totp/verify`, { code }, { csrf: null });
      if (v.status !== 200) throw new Error(`totp verify ${acc.username} failed: ${v.status} ${v.text.slice(0, 200)}`);
    }
    await this.refreshMe();
    return r;
  }

  async refreshMe(): Promise<any> {
    const me = await this.get(`${API}/auth/me`);
    if (me.status === 200) { this.me = me.json; this.csrf = me.json.csrfToken; }
    return me;
  }

  async saveStorage(key: string): Promise<void> {
    await this.ctx.storageState({ path: storageFile(key) });
  }

  private headersFor(method: string, o: ReqOpts = {}): Record<string, string> {
    const h: Record<string, string> = { ...(o.headers ?? {}) };
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = o.origin === undefined ? BASE_URL : o.origin;
      if (origin !== null) h.Origin = origin;
      const csrf = o.csrf === undefined ? this.csrf : o.csrf;
      if (csrf) h['X-CSRF-Token'] = csrf;
    }
    return h;
  }

  async req<T = any>(method: string, url: string, body?: unknown, o: ReqOpts = {}): Promise<ApiResponse<T>> {
    if (method === 'POST' && !o.noThrottle && /\/auth\/(login|password|totp\/verify|totp\/confirm|recovery-codes)$/.test(url)) await loginThrottle();
    const headers = this.headersFor(method, o);
    const init: Parameters<APIRequestContext['fetch']>[1] = { method, headers, maxRedirects: 0, failOnStatusCode: false };
    if (body !== undefined) {
      init.data = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Type'] ??= 'application/json';
    }
    let res = await this.ctx.fetch(url, init);
    // Per-user rate limits (CLI 20/s, scan 10/s, sign-in per IP) are tested explicitly in
    // rate-limit.spec.ts; everywhere else a 429 just means "slow down", so back off and retry.
    for (let attempt = 0; res.status() === 429 && !o.noRetry && attempt < 8; attempt++) {
      await res.body().catch(() => undefined);
      await new Promise((r) => setTimeout(r, /\/auth\//.test(url) ? 7000 : 1100));
      res = await this.ctx.fetch(url, init);
    }
    const buf = await res.body().catch(() => Buffer.alloc(0));
    const text = buf.toString('utf8');
    if (!o.noScan) assertNoLeaks(text + '\n' + JSON.stringify(res.headers()), `${method} ${url} -> ${res.status()}`);
    let json: any = undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
    return { status: res.status(), headers: res.headers(), text, json };
  }

  get<T = any>(url: string, o?: ReqOpts) { return this.req<T>('GET', url, undefined, o); }
  post<T = any>(url: string, body?: unknown, o?: ReqOpts) { return this.req<T>('POST', url, body ?? {}, o); }
  patch<T = any>(url: string, body?: unknown, o?: ReqOpts) { return this.req<T>('PATCH', url, body ?? {}, o); }

  /** Cookie header for native fetch (SSE). */
  async cookieHeader(): Promise<string> {
    const st = await this.ctx.storageState();
    return st.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /**
   * Opens an SSE stream and collects JSON events until `until` returns true,
   * `maxEvents` is reached or `timeoutMs` passes. Returns status + events.
   */
  async sse<E = any>(url: string, opts: { timeoutMs?: number; maxEvents?: number; until?: (e: E, all: E[]) => boolean; onOpen?: () => Promise<void> | void } = {}): Promise<{ status: number; contentType: string; events: E[]; raw: string }> {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
    const events: E[] = [];
    let raw = '';
    let status = 0;
    let contentType = '';
    try {
      const res = await fetch(BASE_URL + url, { headers: { Cookie: await this.cookieHeader(), Accept: 'text/event-stream' }, signal: ac.signal, redirect: 'manual' });
      status = res.status;
      contentType = res.headers.get('content-type') ?? '';
      if (!res.ok || !res.body) {
        raw = await res.text();
        assertNoLeaks(raw, `SSE ${url} -> ${status}`);
        return { status, contentType, events, raw };
      }
      if (opts.onOpen) await opts.onOpen();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let pending = '';
      outer: for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        raw += chunk;
        pending += chunk;
        let idx: number;
        while ((idx = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, idx);
          pending = pending.slice(idx + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let ev: E;
          try { ev = JSON.parse(data); } catch { continue; }
          events.push(ev);
          if ((opts.maxEvents && events.length >= opts.maxEvents) || opts.until?.(ev, events)) break outer;
        }
      }
      ac.abort();
    } catch (e) {
      if (!(e instanceof Error && e.name === 'AbortError')) throw e;
    } finally {
      clearTimeout(timeout);
    }
    assertNoLeaks(raw, `SSE ${url}`);
    return { status, contentType, events, raw };
  }

  async dispose(): Promise<void> { await this.ctx.dispose(); }
}

/** Database-scoped path helper. */
export const dbPath = (db: string, sub: string) => `${API}/databases/${encodeURIComponent(db)}/${sub}`;

/** Bin helpers (mirror packages/shared/src/bin.ts without importing app code). */
export const utf8 = (s: string) => ({ enc: 'utf8' as const, data: s });
export const b64 = (b: Buffer) => ({ enc: 'base64' as const, data: b.toString('base64') });
/** Bin for a key given as text or raw bytes (utf8 when valid, else base64). */
export function bin(k: string | Buffer): { enc: 'utf8' | 'base64'; data: string } {
  if (!Buffer.isBuffer(k)) return utf8(k);
  try { return utf8(new TextDecoder('utf-8', { fatal: true }).decode(k)); } catch { return b64(k); }
}
/** POST /key/read body helper. */
export const keyRead = (k: string | Buffer, extra: Record<string, unknown> = {}) => ({ key: bin(k), ...extra });
export const keyParam = (k: string | Buffer) => (Buffer.isBuffer(k) ? k : Buffer.from(k, 'utf8')).toString('base64url');
export function binToBuffer(b: { enc: 'utf8' | 'base64'; data: string }): Buffer {
  return b.enc === 'utf8' ? Buffer.from(b.data, 'utf8') : Buffer.from(b.data, 'base64');
}
