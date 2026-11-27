// Rehype plugin for every Markdown file the site renders (docs/*.md and docs/RELEASE-NOTES-*.md):
//  - adds a "#" anchor link to h2–h4 (ids come from rehypeHeadingIds, which runs first, with GitHub's slugs)
//  - demotes headings in release notes by one level (their "# Redis Console v0.4.3" sits under the page's h1)
//  - links between the documents the site publishes go to their pages, release notes to the changelog, and every other
//    relative link to the file on GitHub; relative images load from the repository's raw files
//  - makes tables scroll horizontally on narrow screens instead of overflowing
const REPO = 'https://github.com/SaiBarathR/redis-console/blob/main/';
const RAW = 'https://github.com/SaiBarathR/redis-console/raw/main/';
const BASE = '/redis-console/';

export const docPages = {
  'INSTALL.md': 'docs/',
  'USER-GUIDE.md': 'docs/user-guide/',
  'OPERATIONS.md': 'docs/operations/',
  'SECURITY.md': 'docs/security/',
  'ARCHITECTURE.md': 'docs/architecture/',
  'DECISIONS.md': 'docs/decisions/',
};

function walk(node, fn, parent = null, index = 0) {
  fn(node, parent, index);
  if (node.children) node.children.slice().forEach((child) => walk(child, fn, node, node.children.indexOf(child)));
}

/** A path relative to the Markdown file, resolved to a repository path ("docs/x.md", "README.md"). */
function repoPath(sourceDir, rel) {
  const parts = (sourceDir + rel).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

export function rehypeSite() {
  return (tree, file) => {
    const path = String(file?.path || file?.history?.[0] || '');
    const isRelease = /RELEASE-NOTES-v[^/\\]+\.md$/.test(path);
    const sourceDir = /[\\/]docs[\\/]/.test(path) ? 'docs/' : '';

    walk(tree, (node, parent, index) => {
      if (node.type !== 'element') return;

      if (isRelease && /^h[1-5]$/.test(node.tagName)) node.tagName = 'h' + (Number(node.tagName[1]) + 1);

      if (/^h[2-4]$/.test(node.tagName) && node.properties?.id) {
        node.children.push({
          type: 'element',
          tagName: 'a',
          properties: { className: ['anchor'], href: '#' + node.properties.id, ariaLabel: 'Link to this section' },
          children: [{ type: 'text', value: '#' }],
        });
      }

      if (node.tagName === 'img' && typeof node.properties?.src === 'string' && !/^[a-z]+:|^\//i.test(node.properties.src)) {
        node.properties.src = RAW + repoPath(sourceDir, node.properties.src);
        node.properties.loading = 'lazy';
        node.properties.decoding = 'async';
      }

      if (node.tagName === 'a' && typeof node.properties?.href === 'string') {
        const href = node.properties.href;
        if (/^[a-z]+:/i.test(href) || href.startsWith('#') || href.startsWith('/')) {
          if (/^https?:/i.test(href)) node.properties.rel = ['noopener'];
          return;
        }
        const [rel, hash = ''] = href.split('#');
        const target = repoPath(sourceDir, rel);
        const name = target.split('/').pop();
        const release = target.match(/^docs\/RELEASE-NOTES-(v[^/]+)\.md$/);
        if (target.startsWith('docs/') && docPages[name] && !target.slice(5).includes('/')) {
          node.properties.href = BASE + docPages[name] + (hash ? '#' + hash : '');
        } else if (release) {
          node.properties.href = BASE + 'changelog/#' + release[1];
        } else {
          node.properties.href = REPO + target + (hash ? '#' + hash : '');
        }
      }

      // An empty header cell (e.g. "| | |") still needs a name for screen readers.
      if (node.tagName === 'th' && !node.children.some((c) => c.type !== 'text' || c.value.trim())) {
        node.children = [{ type: 'element', tagName: 'span', properties: { className: ['visually-hidden'] }, children: [{ type: 'text', value: 'Column' }] }];
      }

      if (node.tagName === 'table' && parent && parent.tagName !== 'div') {
        parent.children[index] = { type: 'element', tagName: 'div', properties: { className: ['table-wrap'], tabIndex: 0 }, children: [node] };
      }
    });
  };
}
