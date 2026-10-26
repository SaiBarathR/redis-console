/**
 * Generates THIRD-PARTY-NOTICES: every production dependency of apps/server (shipped in the container image's
 * node_modules) and apps/web (bundled into the SPA), transitively, with its licence and the licence texts the package
 * ships, plus the self-hosted fonts and their SIL Open Font License texts.
 *
 *   node scripts/third-party-notices.ts           write THIRD-PARTY-NOTICES
 *   node scripts/third-party-notices.ts --check   exit 1 if THIRD-PARTY-NOTICES is not up to date (CI)
 *
 * Reproducible: it reads only the installed packages (`pnpm install --frozen-lockfile`), follows `dependencies` (not
 * dev, peer or platform-specific optional ones), sorts everything and writes no dates or absolute paths.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'THIRD-PARTY-NOTICES');
const APPS = [
  { dir: 'apps/server', label: 'server' },
  { dir: 'apps/web', label: 'web' },
] as const;
const FONTS = [
  {
    name: 'Atkinson Hyperlegible Next',
    files: 'apps/web/src/assets/fonts/atkinson-hyperlegible-next-*.woff2',
    license: 'apps/web/src/assets/fonts/OFL-AtkinsonHyperlegibleNext.txt',
  },
  {
    name: 'Atkinson Hyperlegible Mono',
    files: 'apps/web/src/assets/fonts/atkinson-hyperlegible-mono-*.woff2',
    license: 'apps/web/src/assets/fonts/OFL-AtkinsonHyperlegibleMono.txt',
  },
];
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;
/** Licences we accept in production dependencies; anything else fails the generator (and CI) for review. */
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);
/** Upstream licence texts for packages that ship none (scripts/third-party-licenses/README.md). */
const NODE_REDIS = 'scripts/third-party-licenses/node-redis.txt';
const OVERRIDES: Record<string, string> = {
  redis: NODE_REDIS,
  '@redis/bloom': NODE_REDIS,
  '@redis/client': NODE_REDIS,
  '@redis/json': NODE_REDIS,
  '@redis/search': NODE_REDIS,
  '@redis/time-series': NODE_REDIS,
  'qrcode-generator': 'scripts/third-party-licenses/qrcode-generator.txt',
  'abstract-logging': 'scripts/third-party-licenses/abstract-logging.txt',
};

interface Manifest {
  name: string;
  version: string;
  license?: string | { type?: string };
  licenses?: { type?: string }[];
  repository?: string | { url?: string };
  homepage?: string;
  dependencies?: Record<string, string>;
}
interface Pkg { name: string; version: string; dir: string; manifest: Manifest; usedBy: Set<string> }

const readManifest = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Manifest;

/** Node's lookup: `node_modules/<name>` in the package's directory and every parent (pnpm keeps deps as siblings). */
function resolve(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dir === path.dirname(dir) || !dir.startsWith(ROOT)) return undefined;
  }
}

function collect(): Pkg[] {
  const found = new Map<string, Pkg>();
  for (const app of APPS) {
    const start = path.join(ROOT, app.dir);
    const queue: string[] = [start];
    const seen = new Set<string>();
    while (queue.length) {
      const dir = queue.shift()!;
      if (seen.has(dir)) continue;
      seen.add(dir);
      const manifest = readManifest(dir);
      const ours = dir === start || manifest.name.startsWith('@rconsole/');
      if (!ours) {
        const key = `${manifest.name}@${manifest.version}`;
        const pkg = found.get(key) ?? { name: manifest.name, version: manifest.version, dir, manifest, usedBy: new Set<string>() };
        pkg.usedBy.add(app.label);
        found.set(key, pkg);
      }
      for (const dep of Object.keys(manifest.dependencies ?? {}).sort()) {
        const target = resolve(dep, dir);
        if (!target) throw new Error(`${manifest.name} depends on ${dep}, which is not installed: run pnpm install --frozen-lockfile`);
        queue.push(target);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));
}

function licenseOf(m: Manifest): string {
  if (typeof m.license === 'string') return m.license;
  if (m.license?.type) return m.license.type;
  if (m.licenses?.length) return m.licenses.map((l) => l.type).filter(Boolean).join(' OR ');
  return 'UNKNOWN';
}

function source(m: Manifest): string | undefined {
  const repo = typeof m.repository === 'string' ? m.repository : m.repository?.url;
  const url = repo ?? m.homepage;
  return url?.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://');
}

const clean = (text: string) => `${text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim()}\n`;

function texts(dir: string): { file: string; text: string }[] {
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => ({ file: f, text: clean(readFileSync(path.join(dir, f), 'utf8')) }));
}

export function render(): string {
  const pkgs = collect();
  const rule = '='.repeat(100);
  const out: string[] = [];
  out.push(
    'THIRD-PARTY NOTICES',
    '',
    'Redis Console is licensed under the Apache License, Version 2.0 (LICENSE; NOTICE). The container image and the',
    'built web application also include the third-party software listed below, under the licences shown. For each',
    'package the licence and notice files it ships are reproduced in full.',
    '',
    'Generated by scripts/third-party-notices.ts from the installed production dependencies of apps/server (the',
    'image\'s node_modules) and apps/web (bundled into the SPA). Do not edit; regenerate with',
    '`node scripts/third-party-notices.ts` after changing dependencies. CI checks that it is up to date.',
    '',
    `Fonts (${FONTS.length}) and packages (${pkgs.length}):`,
    '',
  );
  for (const f of FONTS) out.push(`  ${f.name.padEnd(48)} OFL-1.1        web (fonts)`);
  for (const p of pkgs) out.push(`  ${`${p.name} ${p.version}`.padEnd(48)} ${licenseOf(p.manifest).padEnd(14)} ${[...p.usedBy].sort().join(', ')}`);
  out.push('');
  for (const f of FONTS) {
    out.push(rule, `${f.name} (fonts: ${f.files})`, 'License: SIL Open Font License, Version 1.1 (OFL-1.1)', 'Used by: web (self-hosted fonts)', rule, '');
    out.push(clean(readFileSync(path.join(ROOT, f.license), 'utf8')));
  }
  const problems: string[] = [];
  for (const p of pkgs) {
    const license = licenseOf(p.manifest);
    if (!ALLOWED.has(license)) problems.push(`${p.name} ${p.version}: licence "${license}" is not in the allowlist; review it, then extend ALLOWED`);
    const files = texts(p.dir);
    const src = source(p.manifest);
    out.push(rule, `${p.name} ${p.version}`, `License: ${license}`, `Used by: ${[...p.usedBy].sort().join(', ')}`, ...(src ? [`Source: ${src}`] : []), rule, '');
    if (!files.length) {
      const override = OVERRIDES[p.name];
      if (!override) {
        problems.push(`${p.name} ${p.version} ships no licence file; add its upstream text to scripts/third-party-licenses and OVERRIDES`);
        continue;
      }
      out.push(`The package ships no licence file; this is the upstream licence (${override.replace('scripts/third-party-licenses/', '')}).`, '');
      out.push(clean(readFileSync(path.join(ROOT, override), 'utf8')));
    }
    for (const f of files) out.push(`--- ${f.file} ---`, '', f.text);
  }
  if (problems.length) throw new Error(`Cannot generate THIRD-PARTY-NOTICES:\n  ${problems.join('\n  ')}`);
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

if (import.meta.main) {
  const text = render();
  if (process.argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (current !== text) {
      console.error('THIRD-PARTY-NOTICES is out of date. Run: node scripts/third-party-notices.ts');
      process.exit(1);
    }
    console.log('THIRD-PARTY-NOTICES is up to date.');
  } else {
    writeFileSync(OUT, text);
    console.log(`Wrote ${path.relative(ROOT, OUT)} (${text.length} bytes).`);
  }
}
