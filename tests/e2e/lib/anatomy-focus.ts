import type { Page } from '@playwright/test';
import path from 'node:path';
import type { AnatomyIssue } from './anatomy.ts';
import { ANATOMY_ALLOWLIST } from './anatomy.ts';
import { REPO_ROOT } from './env.ts';

type FocusResult = Omit<AnatomyIssue, 'checkpoint'> | { check: 'ok'; selector: string; editor: boolean };

/**
 * Walks the real keyboard order (programmatic focus would not prove :focus-visible) and checks that each focused
 * control shows a ring (outline, a signal-coloured box-shadow or fill, on itself, a pseudo-element or a
 * :focus-within ancestor) and that no ancestor's overflow clips it.
 */
export async function focusAnatomy(page: Page, dir: string, checkpoint: string): Promise<Omit<AnatomyIssue, 'checkpoint'>[]> {
  const count = Math.min(220, await page.locator('button,a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])').count());
  const seen = new Set<string>();
  const issues: Omit<AnatomyIssue, 'checkpoint'>[] = [];
  let last = '';
  for (let i = 0; i < count + 2; i++) {
    await page.keyboard.press('Tab');
    const result: FocusResult | null = await page.evaluate((allowlist) => {
      const e = document.activeElement;
      if (!(e instanceof HTMLElement) || e === document.body) return null;
      const alpha = (c: string): number => {
        if (!c || c === 'transparent') return 0;
        const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c);
        if (slash) return parseFloat(slash[1]!) / (slash[2] ? 100 : 1);
        const m = /^rgba\(([^)]+)\)$/.exec(c);
        return m ? parseFloat(m[1]!.split(',')[3] ?? '1') : 1;
      };
      const parts: string[] = [];
      for (let n: Element | null = e; n && n !== document.body; n = n.parentElement) {
        const id = n.getAttribute('data-testid');
        if (id) { parts.unshift(`[data-testid="${id}"]`); break; }
        const cls = Array.from(n.classList).filter(c => /^[a-z][\w-]*$/i.test(c)).slice(0, 2).map(c => `.${c}`).join('');
        parts.unshift(`${n.tagName.toLowerCase()}${cls}:nth-child(${Array.from(n.parentElement?.children ?? []).indexOf(n) + 1})`);
      }
      const selector = parts.join(' > ');
      const editor = !!e.closest('.cm-editor');
      const probe = document.createElement('span');
      probe.style.color = 'var(--signal)';
      document.body.append(probe);
      const signal = getComputedStyle(probe).color;
      probe.remove();
      // Candidates: the element, its pseudo-elements, then up to three :focus-within ancestors (composite fields).
      const cands: Element[] = [e];
      for (let p = e.parentElement, k = 0; p && k < 5 && p !== document.body; p = p.parentElement, k++) {
        if (p.matches('dialog, main, [role="dialog"]')) break;
        cands.push(p);
      }
      let ring: { el: Element; spread: number; how: string } | null = null;
      for (const c of cands) {
        for (const pseudo of [null, '::before', '::after']) {
          const s = getComputedStyle(c, pseudo);
          if (pseudo && (s.content === 'none' || s.content === 'normal')) continue;
          // An ancestor's ring only counts in the focus colour: it then exists for the focused descendant.
          if (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 1 && alpha(s.outlineColor) > 0.3 && (c === e || s.outlineColor === signal)) {
            ring = { el: c, spread: Math.max(0, parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset)), how: 'outline' }; break;
          }
          if (s.boxShadow.includes(signal)) {
            const outer = !/inset/.test(s.boxShadow);
            const spread = outer ? Math.max(...Array.from(s.boxShadow.matchAll(/(-?[\d.]+)px/g)).map(m => parseFloat(m[1]!))) : 0;
            ring = { el: c, spread, how: 'box-shadow' }; break;
          }
          if (pseudo && (s.backgroundColor === signal || s.backgroundImage.includes(signal))) { ring = { el: c, spread: 0, how: 'pseudo fill' }; break; }
          if (!pseudo && c === e && s.backgroundColor === signal) { ring = { el: c, spread: 0, how: 'fill' }; break; }
        }
        if (ring) break;
      }
      const r = (ring?.el ?? e).getBoundingClientRect();
      const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
      const testid = e.getAttribute('data-testid') ?? e.closest('[data-testid]')?.getAttribute('data-testid') ?? null;
      const allowed = (check: string) => allowlist.find(a => a.check === check && e.matches(a.selector))?.reason;
      if (!ring) {
        const s = getComputedStyle(e);
        const reason = allowed('focus-ring');
        return { check: 'focus-ring', selector, testid, rect, measured: `no visible ring (outline ${s.outlineStyle} ${s.outlineWidth}, box-shadow ${s.boxShadow})`, ...(reason ? { allowed: reason } : {}) };
      }
      // Clipping: overflow ancestors (containing-block aware; the top layer and fixed boxes escape them).
      let waitFor = false;
      // A ring larger than an inner scroll container on an axis cannot fit anywhere on that axis; outer clips on it
      // are then the scroll container's business.
      let skipX = false, skipY = false;
      for (let n: Element | null = ring.el, first = true; n; n = n.parentElement, first = false) {
        const s = getComputedStyle(n);
        if (!first) {
          const positioned = s.position !== 'static' || s.transform !== 'none';
          if ((!waitFor || positioned) && n !== document.documentElement && n !== document.body && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) {
            const b = n.getBoundingClientRect();
            const bl = b.left + parseFloat(s.borderLeftWidth), br = b.right - parseFloat(s.borderRightWidth);
            const bt = b.top + parseFloat(s.borderTopWidth), bb = b.bottom - parseFloat(s.borderBottomWidth);
            const dx = s.overflowX !== 'visible' && (r.left - ring.spread < bl - 0.5 || r.right + ring.spread > br + 0.5);
            const dy = s.overflowY !== 'visible' && (r.top - ring.spread < bt - 0.5 || r.bottom + ring.spread > bb + 0.5);
            // A ring scrolled partly out of a scroll container is the browser's scroll-into-view margin, not a clip,
            // unless the container cannot scroll on that axis.
            const scrollX = ['auto', 'scroll'].includes(s.overflowX) && n.scrollWidth > n.clientWidth;
            const scrollY = ['auto', 'scroll'].includes(s.overflowY) && n.scrollHeight > n.clientHeight;
            if ((dx && !scrollX && !skipX) || (dy && !scrollY && !skipY)) {
              const reason = allowed('focus-clipped');
              return { check: 'focus-clipped', selector, testid, rect, measured: `${ring.how} (spread ${ring.spread}px) clipped by ${n.tagName.toLowerCase()}.${Array.from(n.classList).join('.')} overflow ${s.overflowX}/${s.overflowY}`, ...(reason ? { allowed: reason } : {}) };
            }
            if (dx && scrollX) skipX = true;
            if (dy && scrollY) skipY = true;
          }
          if (waitFor && positioned) waitFor = false;
        }
        if (n.matches('dialog:modal') || s.position === 'fixed') break;
        if (s.position === 'absolute') waitFor = true;
      }
      return { check: 'ok', selector, editor };
    }, ANATOMY_ALLOWLIST);
    if (!result) continue;
    if (result.selector === last && 'editor' in result && result.editor) {
      // CodeMirror keeps Tab for indentation; Escape then Tab moves focus on (its documented tab-focus escape).
      await page.keyboard.press('Escape');
      continue;
    }
    if (seen.has(result.selector)) break;
    seen.add(result.selector);
    last = result.selector;
    if (result.check !== 'ok') {
      const issue = result as Omit<AnatomyIssue, 'checkpoint'>;
      const file = path.join(dir, `focus-${checkpoint}-${issues.length}.png`);
      const vp = page.viewportSize()!;
      const x = Math.max(0, issue.rect.x - 12), y = Math.max(0, issue.rect.y - 12);
      const width = Math.min(issue.rect.width + 24, vp.width - x), height = Math.min(issue.rect.height + 24, vp.height - y);
      if (width > 1 && height > 1) { await page.screenshot({ path: file, clip: { x, y, width, height } }); issue.crop = path.relative(REPO_ROOT, file); }
      issues.push(issue);
    }
  }
  // Leave no focus behind: the next checkpoint starts from the document.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return issues;
}
