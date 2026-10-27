/**
 * Prints the GitHub release page body for a release tag, built from `docs/RELEASE-NOTES-<tag>.md`.
 *
 *   node scripts/release-page.ts <tag> <owner/repo> [image digest]
 *
 * The notes file's title is dropped (the release has its own), its relative links are pinned to the tagged docs, and
 * an "Install" section names the published image tags, its digest when given, and how to verify its provenance. The
 * release workflow runs this after the image is pushed; it fails when the notes file is missing, so a tag without
 * notes is noticed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

export function releasePage(notes: string, tag: string, repo: string, digest = ''): string {
  const version = tag.replace(/^v/, '');
  const full = /^\d+\.\d+$/.test(version) ? `${version}.0` : version;
  const minor = full.split('.').slice(0, 2).join('.');
  const image = `ghcr.io/${repo.toLowerCase()}`;
  const docs = `https://github.com/${repo}/blob/${tag}/docs/`;
  const body = notes
    .replace(/^# [^\n]*\n+/, '')
    .replace(/\]\((?![a-z][a-z0-9+.-]*:|#|\/)([^)\s]+)\)/gi, (_, target: string) => `](${new URL(target, docs).href})`)
    .trimEnd();
  const install = [
    '## Install',
    '',
    `The image is published for linux/amd64 and linux/arm64 as \`${image}:${full}\` (also tagged \`${minor}\` and`,
    '`latest`), with an SBOM and a signed build provenance attestation.',
    '',
    '```sh',
    `docker pull ${image}:${full}`,
    `gh attestation verify oci://${image}:${full} --repo ${repo}`,
    '```',
    ...(digest ? ['', `Digest: \`${digest}\``] : []),
    '',
    `Setup, configuration and upgrades: [INSTALL.md](${docs}INSTALL.md).`,
  ];
  return `${body}\n\n${install.join('\n')}\n`;
}

if (import.meta.main) {
  const [tag, repo, digest] = process.argv.slice(2);
  if (!tag || !repo) {
    console.error('usage: node scripts/release-page.ts <tag> <owner/repo> [image digest]');
    process.exit(2);
  }
  const notes = readFileSync(path.join(ROOT, 'docs', `RELEASE-NOTES-${tag}.md`), 'utf8');
  process.stdout.write(releasePage(notes, tag, repo, digest));
}
