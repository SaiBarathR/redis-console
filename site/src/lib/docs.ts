// Page titles and descriptions for the documents the site publishes from ../docs. The Markdown files are the
// repository's own documentation, rendered as they are; only their links are rewritten (src/lib/rehype-site.mjs).
const META: Record<string, { title: string; description: string }> = {
  INSTALL: {
    title: 'Install',
    description:
      'Deploy Redis Console with Docker, Docker Compose, Kubernetes or Node and systemd: secrets, Redis ACL users, configuration, a TLS proxy, sign-in and a hardening checklist.',
  },
  'USER-GUIDE': {
    title: 'User guide',
    description:
      'Using Redis Console day to day: the key browser, inspectors, console, workbench, guided mode, diagnostics, and why a command can be blocked.',
  },
  OPERATIONS: {
    title: 'Operations',
    description: 'The configuration reference and day-2 operations: TLS, ACL users per tier, secrets, backups, upgrades and audit logs.',
  },
  SECURITY: {
    title: 'Security',
    description: 'The threat model, the controls that answer it and the tests that hold them, known limitations, and how to report a vulnerability.',
  },
  ARCHITECTURE: {
    title: 'Architecture',
    description: 'How Redis Console is built: the request lifecycle, command policy, measured transport, authentication, audit and the web app.',
  },
  DECISIONS: {
    title: 'Design decisions',
    description: 'Why Redis Console works the way it does, one decision at a time, with the alternatives that were rejected.',
  },
};

export function docMeta(name: string) {
  const meta = META[name];
  if (!meta) throw new Error(`no page metadata for docs/${name}.md`);
  return meta;
}
