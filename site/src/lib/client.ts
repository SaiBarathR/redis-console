// The site's only shared script (theme, menu, copy buttons, screenshot tabs, video fallback). No framework.

const root = document.documentElement;

// Theme: follow the system until the visitor picks one.
document.querySelectorAll<HTMLButtonElement>('.theme-toggle').forEach((btn) => {
  btn.addEventListener('click', () => {
    const dark = root.dataset.theme
      ? root.dataset.theme === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('rconsole-site-theme', next); } catch { /* private mode */ }
  });
});

// Mobile menu.
const menuBtn = document.querySelector<HTMLButtonElement>('.menu-toggle');
const nav = document.getElementById('site-nav');
if (menuBtn && nav) {
  const close = () => { nav.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); };
  menuBtn.addEventListener('click', () => {
    const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.addEventListener('resize', () => { if (window.innerWidth > 720) close(); });
}

// Copy buttons: on every highlighted code block in prose, and on [data-copy-target] buttons.
const COPY_ICONS =
  '<svg class="idle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>' +
  '<svg class="done" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function flash(btn: HTMLElement, label: string) {
  btn.classList.add('copied');
  const status = btn.querySelector('.copy-label');
  const before = status?.textContent;
  if (status) status.textContent = 'Copied';
  btn.setAttribute('aria-label', label.startsWith('Copy snippet') ? 'Copied snippet' : 'Copied');
  setTimeout(() => {
    btn.classList.remove('copied');
    if (status && before) status.textContent = before;
    btn.setAttribute('aria-label', label);
  }, 1600);
}

document.querySelectorAll<HTMLPreElement>('.prose pre.astro-code, pre.astro-code[data-copy]').forEach((pre) => {
  // Diagrams and plain-text samples are for reading, not pasting: only code gets a copy button.
  if (pre.dataset.language === 'plaintext' || pre.dataset.language === 'text') return;
  if (pre.parentElement?.classList.contains('code-block')) return;
  const wrap = document.createElement('div');
  wrap.className = 'code-block';
  pre.replaceWith(wrap);
  wrap.appendChild(pre);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy-btn';
  btn.setAttribute('aria-label', 'Copy code');
  btn.innerHTML = COPY_ICONS;
  btn.addEventListener('click', async () => {
    if (await copyText(pre.innerText.replace(/\n$/, ''))) flash(btn, 'Copy code');
  });
  wrap.appendChild(btn);
});

document.querySelectorAll<HTMLButtonElement>('[data-copy-target]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = document.getElementById(btn.dataset.copyTarget!);
    const text = target instanceof HTMLTemplateElement ? target.content.textContent ?? '' : target?.textContent ?? '';
    if (await copyText(text)) flash(btn, btn.getAttribute('aria-label') ?? 'Copy');
  });
});

document.querySelectorAll<HTMLVideoElement>('video[data-fallback]').forEach((video) => {
  const fail = () => video.closest('.video-frame')?.classList.add('is-missing');
  const source = video.querySelector('source');
  (source ?? video).addEventListener('error', fail);
  if (video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) fail();
});
