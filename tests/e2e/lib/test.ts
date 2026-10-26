/**
 * Shared Playwright fixtures for UI specs.
 *
 * Every page automatically:
 *  - records `securitypolicyviolation` events (CSP + Trusted Types) and fails the test on any
 *  - records console errors / uncaught page errors and fails the test on any
 *    (except "Failed to load resource" for expected 4xx API answers)
 *  - records JS dialogs (alert/confirm/prompt) and fails the test on any unexpected one
 *  - scans every JSON/HTML response and every SSE event (fetch streams and EventSource) for secret leaks
 */
import { test as base, expect, type Page, type Response } from '@playwright/test';
import { assertNoLeaks, storageFile } from './api.ts';

export interface PageGuards {
  cspViolations(): Promise<{ directive: string; blocked: string; sample: string }[]>;
  consoleErrors: string[];
  dialogs: string[];
  /** Allow console errors matching this regexp for the current test. */
  allowConsole(re: RegExp): void;
  /** Allow (and auto-accept) JS dialogs for the current test (only native confirm() UIs). */
  allowDialogs(): void;
}

const INIT_SCRIPT = `
(() => {
  window.__rcCsp = [];
  window.__rcSse = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__rcCsp.push({ directive: e.violatedDirective, blocked: String(e.blockedURI || ''), sample: String(e.sample || '').slice(0, 200) });
  }, true);
  // The SPA reads SSE with fetch(); tee event-stream bodies so the leak scan sees every event.
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await origFetch(...args);
    try {
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/event-stream') || !res.body) return res;
      const [forApp, forScan] = res.body.tee();
      (async () => {
        const reader = forScan.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ done: true }));
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\\n\\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            if (window.__rcSse.length < 5000) window.__rcSse.push(block.slice(0, 200000));
          }
        }
      })();
      const wrapped = new Response(forApp, { status: res.status, statusText: res.statusText, headers: res.headers });
      Object.defineProperty(wrapped, 'url', { value: res.url });
      return wrapped;
    } catch { return res; }
  };
  const Orig = window.EventSource;
  if (Orig) {
    class Wrapped extends Orig {
      constructor(u, c) {
        super(u, c);
        const push = (ev) => { try { if (window.__rcSse.length < 5000) window.__rcSse.push(String(ev.data).slice(0, 200000)); } catch {} };
        this.addEventListener('message', push);
        const origAdd = this.addEventListener.bind(this);
        this.addEventListener = (type, fn, opts) => { if (type !== 'message' && type !== 'open' && type !== 'error') origAdd(type, push); return origAdd(type, fn, opts); };
      }
    }
    window.EventSource = Wrapped;
  }
})();
`;

const EXPECTED_CONSOLE = [
  /Failed to load resource: the server responded with a status of (400|401|403|404|409|413|422|423|428|429)/,
];

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

async function scanResponse(r: Response): Promise<void> {
  const ct = r.headers()['content-type'] ?? '';
  if (!/json|html|text\/plain/.test(ct)) return;
  if (r.request().method() === 'OPTIONS') return;
  let body: Buffer;
  try {
    const b = await withTimeout(r.body(), 5000, null);
    if (!b) return; // navigated away / still streaming
    body = b;
  } catch { return; }
  assertNoLeaks(body.toString('utf8') + '\n' + JSON.stringify(r.headers()), `page ${r.request().method()} ${r.url()} -> ${r.status()}`);
}

export const test = base.extend<{ guards: PageGuards; role: string | null }>({
  role: [null, { option: true }],
  storageState: async ({ role }, use) => {
    await use(role ? storageFile(role) : { cookies: [], origins: [] });
  },
  page: async ({ page }, use, testInfo) => {
    const consoleErrors: string[] = [];
    const dialogs: string[] = [];
    const allowed: RegExp[] = [...EXPECTED_CONSOLE];
    let allowDialogs = false;
    const pendingScans: Promise<void>[] = [];
    await page.addInitScript(INIT_SCRIPT);
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('dialog', async (d) => {
      dialogs.push(`${d.type()}: ${d.message()}`);
      if (allowDialogs && d.type() === 'confirm') await d.accept().catch(() => {});
      else await d.dismiss().catch(() => {});
    });
    page.on('response', (r) => { pendingScans.push(scanResponse(r)); });
    (page as Page & { __guards?: PageGuards }).__guards = {
      cspViolations: () => page.evaluate(() => (window as any).__rcCsp ?? []).catch(() => []),
      consoleErrors,
      dialogs,
      allowConsole: (re) => { allowed.push(re); },
      allowDialogs: () => { allowDialogs = true; },
    };

    await use(page);

    // Post-test checks (only when the test itself has not failed already).
    const sse: string[] = await withTimeout(page.evaluate(() => (window as any).__rcSse ?? []).catch(() => []), 5000, []);
    for (const [i, s] of sse.entries()) assertNoLeaks(s, `page EventSource message #${i}`);
    await withTimeout(Promise.allSettled(pendingScans), 10_000, []);
    const csp = await withTimeout(page.evaluate(() => (window as any).__rcCsp ?? []).catch(() => []), 5000, []);
    if (testInfo.status === 'passed') {
      expect(csp, 'CSP / Trusted Types violations').toEqual([]);
      const unexpected = consoleErrors.filter((t) => !allowed.some((re) => re.test(t)));
      expect(unexpected, 'console errors').toEqual([]);
      if (!allowDialogs) expect(dialogs, 'unexpected JS dialogs').toEqual([]);
    }
  },
  guards: async ({ page }, use) => {
    await use((page as Page & { __guards?: PageGuards }).__guards!);
  },
});

export { expect };

/** Asserts that none of the XSS fixtures executed or injected DOM. */
export async function expectNoXss(page: Page): Promise<void> {
  const r = await page.evaluate(() => ({
    flag: (window as any).__xss ?? null,
    imgs: document.querySelectorAll('img[src="x"], img[onerror]').length,
    scripts: [...document.querySelectorAll('script')].filter((s) => !s.src || new URL(s.src).origin !== location.origin).length,
    iframes: document.querySelectorAll('iframe').length,
    svgOnload: document.querySelectorAll('svg[onload]').length,
    anchors: document.querySelectorAll('#xss-anchor, a[href^="javascript:"]').length,
    bold: document.querySelectorAll('#xss-bold').length,
    styles: [...document.querySelectorAll('style')].filter((s) => s.textContent?.includes('evil.invalid')).length,
  }));
  expect(r).toEqual({ flag: null, imgs: 0, scripts: 0, iframes: 0, svgOnload: 0, anchors: 0, bold: 0, styles: 0 });
}
