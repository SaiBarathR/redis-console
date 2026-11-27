// Lucide icons (ISC license, https://lucide.dev), inlined as SVG at build time so the site loads nothing at runtime.
import fs from 'node:fs';
import path from 'node:path';

const iconDir = path.resolve(process.cwd(), 'node_modules/lucide-static/icons');

// Brand marks aren't in Lucide. GitHub's mark is from Octicons (MIT).
const brands: Record<string, string> = {
  github:
    '<path fill="currentColor" stroke="none" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/>',
};
const cache = new Map<string, string>();

/** An inline Lucide icon. A missing name fails the build, so a typo can't ship an empty square. */
export function icon(name: string, size = 20, label?: string): string {
  if (brands[name]) {
    const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ${a11y}>${brands[name]}</svg>`;
  }
  let inner = cache.get(name);
  if (inner === undefined) {
    const raw = fs.readFileSync(path.join(iconDir, name + '.svg'), 'utf8');
    inner = raw.replace(/<!--[\s\S]*?-->/, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
    cache.set(name, inner);
  }
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="lucide" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${inner}</svg>`;
}
