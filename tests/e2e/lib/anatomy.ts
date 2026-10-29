/**
 * Control anatomy lint. Page screenshots and between-element overlap checks miss defects *inside* a control (a
 * select's arrow on its border, a label touching a chip's edge), so this measures the inside of every control and
 * painted surface with layout APIs: border boxes, computed padding/border, Range client rects for text, and SVG/img
 * rects for icons. Every checkpoint sweeps the page's scroll containers, records measurements and 2x crops of every
 * distinct control style, then tabs through the page to check focus rings.
 */
import type { Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './env.ts';
import { contactSheets } from './anatomy-sheets.ts';
import { focusAnatomy } from './anatomy-focus.ts';

export interface Rect { x: number; y: number; width: number; height: number }
export interface AnatomyIssue {
  checkpoint: string;
  check: string;
  selector: string;
  testid: string | null;
  measured: string;
  rect: Rect;
  allowed?: string;
  crop?: string;
}
export interface AllowEntry { selector: string; check: string; reason: string }

/**
 * Reviewed exceptions. Each entry names one element kind and one check; it does not excuse any other check on the
 * same element. Keep this list tiny: fix the control instead whenever the exception is not inherent to its kind.
 */
export const ANATOMY_ALLOWLIST: AllowEntry[] = [
  {
    selector: 'mark',
    check: 'text-inset',
    reason: 'A text highlight inside running text (history and grammar matches). Horizontal padding would shift the '
      + 'highlighted characters away from their neighbours; it is not a control and has no border.',
  },
];

/** Thresholds from the brief (CSS px). Measured values are compared with a 0.1 px tolerance for subpixel layout. */
export const LIMITS = {
  insetX: 6, insetY: 2, borderGap: 2, selectPadding: 22, chevronInset: 6, iconGap: 4, centre: 1, rowHeight: 1,
} as const;

export interface AnatomyRun {
  width: number;
  theme: string;
  group: string;
  dir: string;
  seen: Set<string>;
  crops: { label: string; file: string; checkpoint: string }[];
  issues: AnatomyIssue[];
  checkpoints: string[];
}

export function anatomyRun(group: string, width: number, theme: string): AnatomyRun {
  const dir = path.join(REPO_ROOT, '.qa/ui/anatomy', process.env.ANATOMY_PHASE ?? 'final', `${width}-${theme}`, group);
  mkdirSync(dir, { recursive: true });
  return { width, theme, group, dir, seen: new Set(), crops: [], issues: [], checkpoints: [] };
}

interface Measured { issues: Omit<AnatomyIssue, 'checkpoint'>[]; styles: { selector: string; signature: string; rect: Rect }[] }

/**
 * Runs in the page (serialized by Playwright): every helper lives inside. Returns violations and one entry per
 * measured element for the contact sheets.
 */
function measurePage({ limits, allowlist }: { limits: typeof LIMITS; allowlist: AllowEntry[] }): Measured {
  const T = 0.1;
  const issues: Measured['issues'] = [];
  const styles: Measured['styles'] = [];
  const alpha = (c: string): number => {
    if (!c || c === 'transparent') return 0;
    const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c);
    if (slash) return parseFloat(slash[1]!) / (slash[2] ? 100 : 1);
    const m = /^rgba\(([^)]+)\)$/.exec(c);
    if (m) return parseFloat(m[1]!.split(',')[3] ?? '1');
    return 1;
  };
  const cs = (e: Element) => getComputedStyle(e);
  const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
  /** Inset arrays are [left, right, top, bottom]. */
  const INSET_ORDER: string[] = ['Left', 'Right', 'Top', 'Bottom'];
  const borderSides = (s: CSSStyleDeclaration) => sides.filter(k =>
    parseFloat(s.getPropertyValue(`border-${k.toLowerCase()}-width`)) > 0
    && !['none', 'hidden'].includes(s.getPropertyValue(`border-${k.toLowerCase()}-style`))
    && alpha(s.getPropertyValue(`border-${k.toLowerCase()}-color`)) > 0.05);
  const bgBehind = (e: Element | null): string => {
    for (let n = e; n; n = n.parentElement) { const c = cs(n).backgroundColor; if (alpha(c) > 0.05) return c; }
    return 'rgb(255, 255, 255)';
  };
  const filled = (e: Element, s: CSSStyleDeclaration) => alpha(s.backgroundColor) > 0.05 && s.backgroundColor !== bgBehind(e.parentElement);
  const shadowRing = (s: CSSStyleDeclaration) => s.boxShadow !== 'none' && !/^rgba\(0, 0, 0, 0\)/.test(s.boxShadow);
  const CONTROL = 'button,summary,a.button,a[href]:has(> svg),input:not([type="hidden"]),select,textarea,[role="tab"],[role="switch"],'
    + '[role="checkbox"],.badge,.chip,.tag,kbd,.env-badge,.toggle,.type-glyph,.topic-chip,.db-tag,.role-tag,.policy-tag,.outcome-tag';
  const isControl = (e: Element) => e.matches(CONTROL);
  const scrolls = (s: CSSStyleDeclaration) => ['auto', 'scroll'].includes(s.overflowX) || ['auto', 'scroll'].includes(s.overflowY);
  const clips = (s: CSSStyleDeclaration) => s.overflowX !== 'visible' || s.overflowY !== 'visible';
  const modal = document.querySelector('dialog:modal, [aria-modal="true"]:not([hidden])');
  const inScope = (e: Element) => !modal || modal.contains(e);
  const sel = (e: Element): string => {
    const parts: string[] = [];
    for (let n: Element | null = e; n && n !== document.body; n = n.parentElement) {
      const id = n.getAttribute('data-testid');
      if (id) { parts.unshift(`[data-testid="${id}"]`); break; }
      const cls = Array.from(n.classList).filter(c => /^[a-z][\w-]*$/i.test(c)).slice(0, 2).map(c => `.${c}`).join('');
      parts.unshift(`${n.tagName.toLowerCase()}${cls}:nth-child(${Array.from(n.parentElement?.children ?? []).indexOf(n) + 1})`);
    }
    return parts.join(' > ');
  };
  const box = (r: DOMRect | Rect): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height });
  const inter = (a: { l: number; t: number; r: number; b: number }, b: { l: number; t: number; r: number; b: number }) =>
    ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) });
  const ltrb = (r: DOMRect) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  const paddingBox = (e: Element) => {
    const r = e.getBoundingClientRect(), s = cs(e);
    return { l: r.left + parseFloat(s.borderLeftWidth), t: r.top + parseFloat(s.borderTopWidth), r: r.right - parseFloat(s.borderRightWidth), b: r.bottom - parseFloat(s.borderBottomWidth) };
  };
  /** Ancestors whose overflow clips `e` (CSS containing-block rules for absolute and fixed boxes, top layer). */
  const clipChain = (e: Element): Element[] => {
    const out: Element[] = [];
    let waitFor: 'positioned' | null = null;
    for (let n: Element | null = e; n; n = n.parentElement) {
      const s = cs(n);
      if (n !== e) {
        const positioned = s.position !== 'static' || s.transform !== 'none';
        if (!waitFor || positioned) { if (clips(s) && n !== document.documentElement && n !== document.body) out.push(n); }
        if (waitFor && positioned) waitFor = null;
      }
      if (n.matches('dialog:modal') || s.position === 'fixed') break;
      if (s.position === 'absolute') waitFor = 'positioned';
    }
    return out;
  };
  const viewport = { l: 0, t: 0, r: innerWidth, b: innerHeight };
  const visibleArea = (e: Element) => {
    let a = inter(ltrb(e.getBoundingClientRect()), viewport);
    for (const c of clipChain(e)) a = inter(a, paddingBox(c));
    return a;
  };
  const fullyVisible = (e: Element) => {
    const r = e.getBoundingClientRect(), a = visibleArea(e);
    return a.l <= r.left + 0.5 && a.t <= r.top + 0.5 && a.r >= r.right - 0.5 && a.b >= r.bottom - 0.5;
  };
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (!e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    return !e.closest('.sr-only,[aria-hidden="true"] .sr-only');
  };
  const allowed = (e: Element, check: string) => allowlist.find(a => a.check === check && e.matches(a.selector))?.reason;
  const seen = new Set<string>();
  const add = (e: Element, check: string, measured: string, rect?: Rect) => {
    const selector = sel(e), k = `${check}|${selector}`;
    if (seen.has(k)) return; seen.add(k);
    const reason = allowed(e, check);
    issues.push({ check, selector, testid: e.getAttribute('data-testid') ?? e.closest('[data-testid]')?.getAttribute('data-testid') ?? null, measured, rect: rect ?? box(e.getBoundingClientRect()), ...(reason ? { allowed: reason } : {}) });
  };
  const f = (n: number) => n.toFixed(1);

  const all = Array.from(document.querySelectorAll<HTMLElement>('body *'))
    .filter(e => inScope(e) && !e.closest('svg') && !['SCRIPT', 'STYLE', 'OPTION', 'TEMPLATE', 'BR', 'svg'].includes(e.tagName) && shown(e));
  const kind = new Map<Element, { control: boolean; boxed: boolean; sides: string[]; surface: boolean }>();
  for (const e of all) {
    const s = cs(e), b = borderSides(s);
    const control = isControl(e), fill = filled(e, s), ring = shadowRing(s);
    const boxed = b.length === 4 || fill || ring;
    kind.set(e, { control, boxed, sides: b, surface: boxed || b.length > 0 });
  }
  const owns = (e: Element) => { const k = kind.get(e); return !!k && (k.control || k.surface); };
  /** The control or surface whose padding a text node or icon must keep, and the clip rect on the way to it. */
  const ownerOf = (leafParent: Element) => {
    let clip = { l: -1e9, t: -1e9, r: 1e9, b: 1e9 };
    let clipper: Element | null = null;
    for (let n: Element | null = leafParent; n && n !== document.body; n = n.parentElement) {
      const s = cs(n);
      if (owns(n)) return { owner: n, clip, clipper };
      if (scrolls(s)) return null; // a scroll container owns its own overflow
      if (clips(s)) { clip = inter(clip, paddingBox(n)); clipper ??= n; }
      if (s.position === 'fixed' || n.matches('dialog:modal')) return null;
    }
    return null;
  };

  // Text: inset from the owner's border box, overflow out of it, clipping without an ellipsis.
  const texts = new Map<Element, { rects: { l: number; t: number; r: number; b: number }[]; raw: DOMRect[] }>();
  const allText: { r: DOMRect; el: Element }[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || !n.textContent?.trim() || !inScope(parent) || parent.closest('svg,.sr-only') || !shown(parent)) continue;
    const range = document.createRange();
    const text = n.textContent!;
    range.setStart(n, text.length - text.trimStart().length);
    range.setEnd(n, text.trimEnd().length);
    const raw = Array.from(range.getClientRects()).filter(r => r.width > 0.5 && r.height > 0.5);
    if (!raw.length) continue;
    // Clipping: the innermost clipping ancestor the text actually exceeds must show an ellipsis (or line clamp).
    let anc: Element | null = parent, legend = !!parent.closest('legend');
    for (; anc && anc !== document.body; anc = anc.parentElement) {
      const s = cs(anc);
      if (s.position === 'fixed' || anc.matches('dialog:modal')) break;
      if (!clips(s)) continue;
      const p = paddingBox(anc);
      const out = (list: DOMRect[]) => [list.some(r => r.right > p.r + 1 || r.left < p.l - 1), list.some(r => r.bottom > p.b + 2 || r.top < p.t - 2)];
      if (!out(raw).some(Boolean)) continue;
      // Preserved spaces hang past a wrap point invisibly (pre-wrap): only ink, word by word, counts as clipped.
      const words: DOMRect[] = [];
      for (const m of text.matchAll(/\S+/g)) {
        const w = document.createRange(); w.setStart(n, m.index!); w.setEnd(n, m.index! + m[0].length);
        words.push(...Array.from(w.getClientRects()).filter(r => r.width > 0.5));
      }
      const [overX, overY] = out(words);
      if (!overX && !overY) continue;
      const visible = raw.some(r => r.right > p.l && r.left < p.r && r.bottom > p.t && r.top < p.b);
      const sc = scrolls(s);
      if (visible && !sc && !legend && fullyVisible(anc)) {
        if (overX && s.textOverflow !== 'ellipsis' && s.overflowX !== 'visible') add(anc, 'clipped-text', `text runs ${f(Math.max(...words.map(r => r.right)) - p.r)}px past the clip edge without an ellipsis`);
        if (overY && s.getPropertyValue('-webkit-line-clamp') === 'none' && s.overflowY !== 'visible' && s.textOverflow !== 'ellipsis') add(anc, 'clipped-text', `text cut ${f(Math.max(...words.map(r => r.bottom)) - p.b)}px at the bottom without an ellipsis or line clamp`);
      }
      break;
    }
    if (!legend) {
      // Clamped to what is painted: an ellipsized label's range runs on past its clip edge.
      const va = visibleArea(parent);
      for (const r of raw) {
        const c = inter(ltrb(r), va);
        if (c.r - c.l > 0.5 && c.b - c.t > 0.5) allText.push({ r: new DOMRect(c.l, c.t, c.r - c.l, c.b - c.t), el: parent });
      }
    }
    const o = ownerOf(parent);
    if (!o || legend) continue;
    const entry = texts.get(o.owner) ?? { rects: [], raw: [] };
    for (const r of raw) {
      const c = inter(ltrb(r), o.clip);
      if (c.r - c.l < 0.5 || c.b - c.t < 0.5) continue;
      entry.rects.push(c);
      if (!o.clipper) entry.raw.push(r);
    }
    texts.set(o.owner, entry);
  }

  const icons = new Map<Element, DOMRect[]>();
  for (const icon of Array.from(document.querySelectorAll('svg, img')).filter(i => !i.parentElement?.closest('svg') && inScope(i) && shown(i))) {
    const o = ownerOf(icon.parentElement!);
    if (!o || o.clipper) continue;
    const list = icons.get(o.owner) ?? [];
    list.push(icon.getBoundingClientRect());
    icons.set(o.owner, list);
  }

  for (const e of all) {
    const k = kind.get(e)!;
    if (!k.control && !k.surface) continue;
    if (!fullyVisible(e)) continue;
    const s = cs(e), r = e.getBoundingClientRect(), rect = box(r);
    const selector = sel(e);
    styles.push({ selector, rect, signature: [e.tagName, s.fontFamily, s.fontSize, s.fontWeight, s.lineHeight, s.padding, s.borderWidth, s.borderStyle, s.borderColor, s.borderRadius, s.backgroundColor, s.color, s.display, s.gap, Math.round(r.height), s.backgroundImage, s.boxShadow].join('|') });
    const isScroller = scrolls(s) && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1);
    // A control wider than its table cell runs over the neighbouring column.
    const cell = k.control ? e.parentElement?.closest('td, th') : null;
    if (cell) {
      const c = cell.getBoundingClientRect();
      if (r.right > c.right + 1 || r.left < c.left - 1) add(e, 'control-overflow', `runs ${f(Math.max(r.right - c.right, c.left - r.left))}px out of its table cell`);
    }
    const t = texts.get(e);
    const textOk = (b: { l: number; t: number; r: number; b: number }) => !isScroller || (b.t >= r.top && b.b <= r.bottom && b.l >= r.left && b.r <= r.right);
    if (t) {
      for (const b of t.rects.filter(textOk)) {
        const ins = [b.l - r.left, r.right - b.r, b.t - r.top, r.bottom - b.b];
        // Scrolled content meets the scrollport edge by design on the axis it scrolls; padding applies at rest only.
        if (isScroller && e.scrollHeight > e.clientHeight + 1 && e.scrollTop > 0) ins[2] = Infinity;
        if (isScroller && e.scrollHeight > e.clientHeight + 1 && e.scrollTop + e.clientHeight < e.scrollHeight - 1) ins[3] = Infinity;
        if (isScroller && e.scrollWidth > e.clientWidth + 1 && e.scrollLeft > 0) ins[0] = Infinity;
        if (isScroller && e.scrollWidth > e.clientWidth + 1 && e.scrollLeft + e.clientWidth < e.scrollWidth - 1) ins[1] = Infinity;
        const txt = `left ${f(ins[0]!)}, right ${f(ins[1]!)}, top ${f(ins[2]!)}, bottom ${f(ins[3]!)}`;
        if (k.boxed) {
          if (ins[0]! < limits.insetX - T || ins[1]! < limits.insetX - T || ins[2]! < limits.insetY - T || ins[3]! < limits.insetY - T) add(e, 'text-inset', txt);
        } else {
          const bad = k.sides.filter(side => ins[INSET_ORDER.indexOf(side)]! < limits.borderGap - T);
          if (bad.length) add(e, 'text-inset', `${txt} (border ${bad.join('/').toLowerCase()})`);
        }
      }
      if (!isScroller && !clips(s)) for (const b of t.raw) {
        if (b.left < r.left - 1 || b.right > r.right + 1 || b.top < r.top - 1.5 || b.bottom > r.bottom + 1.5) add(e, 'text-overflow', `text box ${f(b.left - r.left)}..${f(b.right - r.left)} x ${f(b.top - r.top)}..${f(b.bottom - r.top)} in ${f(r.width)} x ${f(r.height)}`);
      }
    }
    const ic = icons.get(e) ?? [];
    for (const a of ic) {
      const ins = [a.left - r.left, r.right - a.right, a.top - r.top, r.bottom - a.bottom];
      const txt = `left ${f(ins[0]!)}, right ${f(ins[1]!)}, top ${f(ins[2]!)}, bottom ${f(ins[3]!)}`;
      if (k.boxed && (ins[0]! < limits.insetX - T || ins[1]! < limits.insetX - T || ins[2]! < limits.insetY - T || ins[3]! < limits.insetY - T)) add(e, 'icon-inset', txt);
      else if (!k.boxed && k.sides.some(side => ins[INSET_ORDER.indexOf(side)]! < limits.borderGap - T)) add(e, 'icon-inset', `${txt} (border)`);
      // The nearest text on the same line: gap and vertical centring.
      const line = (t?.rects ?? []).filter(b => Math.min(b.b, a.bottom) - Math.max(b.t, a.top) > Math.min(b.b - b.t, a.height) * 0.5);
      if (!line.length) continue;
      const near = line.map(b => ({ b, gap: Math.max(b.l - a.right, a.left - b.r) })).sort((x, y) => x.gap - y.gap)[0]!;
      if (near.gap > 16) continue; // not this icon's label: an unrelated text further along the row
      if (near.gap < limits.iconGap - T) add(e, 'icon-gap', `${f(near.gap)}px between icon and label`);
      const tops = (t?.rects ?? []).map(b => b.t);
      const oneLine = Math.max(...tops) - Math.min(...tops) < 2;
      const delta = Math.abs((a.top + a.bottom) / 2 - (near.b.t + near.b.b) / 2);
      if (oneLine && delta > limits.centre + T) add(e, 'icon-center', `icon centre ${f(delta)}px off the label centre`);
    }
    // Native fields expose no text ranges: their content box is where text goes.
    if (e.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]),textarea,select')) {
      const px = (p: string) => parseFloat(s.getPropertyValue(p));
      let left = px('border-left-width') + px('padding-left'), right = px('border-right-width') + px('padding-right');
      const lh = s.lineHeight === 'normal' ? px('font-size') * 1.2 : px('line-height');
      let top = e.tagName === 'TEXTAREA' ? px('border-top-width') + px('padding-top') : (r.height - lh) / 2;
      // A bare field inside a painted wrapper (composite search box): its text keeps the wrapper's padding.
      let frame: Element | null = k.surface ? e : null;
      for (let p = e.parentElement, d = 0; !frame && p && d < 3; p = p.parentElement, d++) if (kind.get(p)?.boxed) frame = p;
      if (frame && frame !== e) {
        const w = frame.getBoundingClientRect();
        left += r.left - w.left; right += w.right - r.right; top += r.top - w.top;
      }
      if (frame && (left < limits.insetX - T || right < limits.insetX - T || top < limits.insetY - T)) add(e, 'input-inset', `text inset left ${f(left)}, right ${f(right)}, top ${f(top)}${frame !== e ? ' (in its painted wrapper)' : ''}`);
      // Icons or buttons drawn over the field must not sit on its text.
      // Overlays live in the field's own wrapper: an ancestor no taller than the field.
      const wrappers = [e.parentElement, e.parentElement?.parentElement].filter((p): p is HTMLElement => !!p && p.getBoundingClientRect().height <= r.height + 8);
      const near = wrappers.flatMap(p => Array.from(p.querySelectorAll('svg, button')))
        .filter(x => !e.contains(x) && !x.parentElement?.closest('svg') && shown(x));
      for (const x of new Set(near)) {
        const b = x.getBoundingClientRect();
        // Only boxes drawn inside the field (an inline icon or clear button), not neighbours touching its edge.
        if (b.left < r.left - 1 || b.right > r.right + 1 || Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top) < b.height * 0.5) continue;
        const contentL = r.left + left, contentR = r.right - right;
        const leftSide = (b.left + b.right) / 2 < (r.left + r.right) / 2;
        const gap = leftSide ? contentL - b.right : b.left - contentR;
        if (gap < limits.iconGap - T) add(e, 'input-icon-overlap', `${x.tagName.toLowerCase()} ${f(gap)}px from the field's text area`);
      }
    }
    if (e.matches('select:not([multiple])') && (!e.hasAttribute('size') || e.getAttribute('size') === '1')) {
      const pr = parseFloat(s.paddingRight), br = parseFloat(s.borderRightWidth);
      if (pr < limits.selectPadding - T) add(e, 'select-padding', `padding-right ${f(pr)}px`);
      const pos = s.backgroundPositionX;
      const m = /^right\s+(-?[\d.]+)px$/.exec(pos) ?? /^calc\(100% - ([\d.]+)px\)$/.exec(pos);
      const inset = m ? parseFloat(m[1]!) : pos === '100%' || pos === 'right' ? 0 : NaN;
      const size = parseFloat(s.backgroundSize) || 12;
      if (s.appearance !== 'none' || s.backgroundImage === 'none' || !(inset >= limits.chevronInset - T)) add(e, 'select-chevron', `appearance ${s.appearance}, image ${s.backgroundImage === 'none' ? 'none' : 'set'}, position ${pos}`);
      else {
        const chevronLeft = r.right - br - inset - size, contentRight = r.right - br - pr;
        if (contentRight > chevronLeft - 2 + T) add(e, 'select-chevron', `text area ends ${f(contentRight - chevronLeft)}px under the chevron`);
      }
    }
  }

  // Chips and controls laid out as flex/grid items keep a gap to the text beside them (a glyph wider than its grid
  // track ran up to 2 px from the key name).
  for (const e of all) {
    const k = kind.get(e)!;
    if (!k.boxed || !e.parentElement || !/flex|grid/.test(cs(e.parentElement).display) || !fullyVisible(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.height > 40 || r.width > 320) continue;
    for (const { r: b, el } of allText) {
      if (e.contains(el) || el.contains(e)) continue;
      if (Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top) < Math.min(b.height, r.height) * 0.5) continue;
      const gap = Math.max(b.left - r.right, r.left - b.right);
      if (!(gap < limits.iconGap - T && gap > -Math.min(b.width, r.width))) continue;
      // Only text actually painted there: content scrolled under a sticky bar or covered by a popover is not beside it.
      const hit = document.elementFromPoint(Math.min(Math.max(b.left + b.width / 2, 0), innerWidth - 1), Math.min(Math.max(b.top + b.height / 2, 0), innerHeight - 1));
      if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) continue;
      const self = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1));
      if (!self || !(self === e || e.contains(self))) continue;
      add(e, 'outside-gap', `${f(gap)}px to the text beside it`); break;
    }
  }

  // Checkbox and radio labels: gap and centring with the first line of the label.
  for (const cb of all.filter(e => e.matches('input[type="checkbox"], input[type="radio"]') && fullyVisible(e))) {
    const label = cb.closest('label') ?? (cb.id ? document.querySelector(`label[for="${CSS.escape(cb.id)}"]`) : null);
    if (!label) continue;
    const a = cb.getBoundingClientRect();
    const rects: DOMRect[] = [];
    const w = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.textContent?.trim() || !n.parentElement || !shown(n.parentElement)) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      rects.push(...Array.from(range.getClientRects()).filter(r => r.width > 0.5));
    }
    const line = rects.filter(b => Math.min(b.bottom, a.bottom) - Math.max(b.top, a.top) > 2 && b.left >= a.right - 1).sort((x, y) => x.left - y.left)[0];
    if (!line) continue;
    if (line.left - a.right < limits.iconGap - T) add(cb, 'icon-gap', `${f(line.left - a.right)}px between checkbox and label`);
    const delta = Math.abs((a.top + a.bottom) / 2 - (line.top + line.bottom) / 2);
    if (delta > limits.centre + 0.6) add(cb, 'icon-center', `checkbox centre ${f(delta)}px off the label's first line`);
  }

  // Controls on one flex/grid line share a height and a centre line.
  const ROW_CONTROL = 'button,a.button,input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"]),select,[role="tab"]';
  for (const parent of all) {
    const ps = cs(parent);
    if (!['flex', 'inline-flex', 'grid', 'inline-grid'].includes(ps.display)) continue;
    if (ps.display.endsWith('flex') && ps.flexDirection.startsWith('column')) continue;
    const peers: Element[] = [];
    for (const child of Array.from(parent.children)) {
      if (!shown(child) || !fullyVisible(child)) continue;
      if (child.matches(ROW_CONTROL)) { peers.push(child); continue; }
      // A transparent wrapper (label, span) around exactly one control stands for that control.
      const k = kind.get(child);
      if (k?.surface || k?.control) continue;
      const inner = Array.from(child.querySelectorAll(ROW_CONTROL)).filter(x => shown(x));
      if (inner.length === 1 && cs(child).display !== 'contents') {
        const ir = inner[0]!.getBoundingClientRect(), cr = child.getBoundingClientRect();
        if (ir.height >= cr.height - 2) peers.push(inner[0]!);
      }
    }
    for (let i = 1; i < peers.length; i++) {
      const a = peers[i - 1]!.getBoundingClientRect(), b = peers[i]!.getBoundingClientRect();
      if (Math.min(a.bottom, b.bottom) <= Math.max(a.top, b.top)) continue;
      const delta = Math.abs((a.top + a.bottom - b.top - b.bottom) / 2);
      if (Math.abs(a.height - b.height) > limits.rowHeight + T || delta > limits.centre + T) add(peers[i]!, 'row-alignment', `heights ${f(a.height)}/${f(b.height)} beside ${sel(peers[i - 1]!).split(' > ').pop()}, centres ${f(delta)}px apart`);
    }
  }
  return { issues, styles };
}

/** Scroll containers to sweep, largest first (the document included). */
async function scrollers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const modal = document.querySelector('dialog:modal, [aria-modal="true"]:not([hidden])');
    const list = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(e => {
      if (modal && !modal.contains(e)) return false;
      const s = getComputedStyle(e);
      if (!['auto', 'scroll'].includes(s.overflowY) || e.scrollHeight <= e.clientHeight + 40 || e.clientHeight < 150) return false;
      const r = e.getBoundingClientRect();
      return r.width > 200 && r.bottom > 0 && r.top < innerHeight;
    }).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight).slice(0, 3);
    return list.map((e, i) => { e.dataset.anatomyScroller = String(i); return `[data-anatomy-scroller="${i}"]`; });
  });
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
}

/** Measures one page state: scroll sweep, crops, violations, then the keyboard focus walk. */
export async function anatomy(page: Page, run: AnatomyRun, checkpoint: string, opts: { focus?: boolean; sweep?: boolean } = {}): Promise<void> {
  if (await page.evaluate(() => devicePixelRatio) !== 2) throw new Error('Anatomy evidence requires deviceScaleFactor 2');
  run.checkpoints.push(checkpoint);
  await page.mouse.move(0, 0);
  await settle(page);
  const found = new Map<string, AnatomyIssue>();
  const vp = page.viewportSize()!;
  const shoot = async (r: Rect, file: string, pad: number, corner: boolean) => {
    let { x, y, width, height } = r;
    if (corner && (width > 520 || height > 260)) { width = Math.min(width, 360); height = Math.min(height, 150); }
    x = Math.max(0, x - pad); y = Math.max(0, y - pad);
    width = Math.min(width + pad * 2, vp.width - x); height = Math.min(height + pad * 2, vp.height - y);
    if (width < 1 || height < 1) return false;
    await page.screenshot({ path: path.join(run.dir, file), clip: { x, y, width, height }, animations: 'disabled', caret: 'hide' });
    return true;
  };
  const pass = async () => {
    const m = await page.evaluate(measurePage, { limits: LIMITS, allowlist: ANATOMY_ALLOWLIST });
    for (const item of m.styles) {
      if (run.seen.has(item.signature)) continue;
      run.seen.add(item.signature);
      const file = `${checkpoint}-${run.crops.length}.png`;
      if (await shoot(item.rect, file, 4, true)) run.crops.push({ label: `${checkpoint}: ${item.selector.split(' > ').slice(-2).join(' > ')}`, file, checkpoint });
    }
    for (const i of m.issues) {
      const key = `${i.check}|${i.selector}`;
      if (found.has(key)) continue;
      const issue: AnatomyIssue = { checkpoint, ...i };
      const file = `violation-${checkpoint}-${found.size}.png`;
      if (await shoot(i.rect, file, 8, false)) issue.crop = path.relative(REPO_ROOT, path.join(run.dir, file));
      found.set(key, issue);
    }
  };
  await pass();
  if (opts.sweep !== false) {
    for (const s of await scrollers(page)) {
      const el = page.locator(s).first();
      const steps = await el.evaluate(e => Math.min(4, Math.ceil((e.scrollHeight - e.clientHeight) / (e.clientHeight * 0.85))));
      for (let i = 1; i <= steps; i++) {
        await el.evaluate((e, i) => { e.scrollTop = Math.round(e.clientHeight * 0.85 * i); }, i);
        await page.waitForTimeout(120);
        await settle(page);
        await pass();
      }
      await el.evaluate(e => { e.scrollTop = 0; delete e.dataset.anatomyScroller; });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  if (opts.focus !== false) {
    for (const i of await focusAnatomy(page, run.dir, checkpoint)) {
      const key = `${i.check}|${i.selector}`;
      if (!found.has(key)) found.set(key, { checkpoint, ...i });
    }
  }
  run.issues.push(...found.values());
  writeFileSync(path.join(run.dir, `${checkpoint}.json`), JSON.stringify({ url: page.url(), issues: [...found.values()] }, null, 2));
}

/** Writes the contact sheets and the run summary; returns the violations that are not allowlisted. */
export async function finishRun(page: Page, run: AnatomyRun): Promise<AnatomyIssue[]> {
  await contactSheets(page, run.dir, `${run.width} ${run.theme} ${run.group}`, run.crops);
  const counts: Record<string, number> = {};
  for (const i of run.issues) if (!i.allowed) counts[i.check] = (counts[i.check] ?? 0) + 1;
  writeFileSync(path.join(run.dir, 'summary.json'), JSON.stringify({ width: run.width, theme: run.theme, group: run.group, checkpoints: run.checkpoints, counts, crops: run.crops.length, issues: run.issues }, null, 2));
  return run.issues.filter(i => !i.allowed);
}

export const formatIssues = (issues: AnatomyIssue[]) => issues.map(i => `${i.check} @ ${i.checkpoint}: ${i.selector} [${i.testid ?? '-'}] ${i.measured}${i.crop ? ` (${i.crop})` : ''}`).join('\n');
