import fs from 'node:fs';
import path from 'node:path';

/** The version in ../apps/server/package.json at build time. */
export const APP_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '..', 'apps/server/package.json'), 'utf8')).version;
  } catch {
    return '0.4.3';
  }
})();

export const SITE = {
  name: 'Redis Console',
  url: 'https://saibarathr.github.io/redis-console/',
  repo: 'https://github.com/SaiBarathR/redis-console',
  releases: 'https://github.com/SaiBarathR/redis-console/releases',
  latestRelease: 'https://github.com/SaiBarathR/redis-console/releases/latest',
  image: 'ghcr.io/saibarathr/redis-console',
  description:
    'A self-hosted, browser-based Redis console: credentials stay on the server, every command passes a fail-closed policy and a per-role Redis ACL user, and everything is audited. Free and open source.',
};

/** Prefix a site path with the base path (/redis-console/). */
export function url(p = ''): string {
  const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
  return base + p.replace(/^\//, '');
}

/** A repository file on GitHub (blob view), at main. */
export const repoFile = (p: string) => `${SITE.repo}/blob/main/${p.replace(/^\//, '')}`;
