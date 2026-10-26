/**
 * v0.3 follow-up 5: the root `pnpm dev` started the server on 4000 while Vite proxied /api to 4300. Both now take their
 * ports from scripts/dev-ports.ts: RCONSOLE_PORT (environment, then .env), else the dev config's server.port, else
 * 4000; Vite RCONSOLE_WEB_PORT or 5173. The server launcher's local publicUrl follows RCONSOLE_PORT.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WEB_PORT, devConfigFile, devPublicUrl, devServerPort, devWebPort, REPO_ROOT } from '../../../../scripts/dev-ports.ts';

function repo(files: { dev?: unknown; local?: unknown; env?: string } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'rconsole-devports-'));
  mkdirSync(path.join(root, 'config'));
  writeFileSync(path.join(root, 'config', 'rconsole.dev.json'), JSON.stringify(files.dev ?? { server: { port: 4000, publicUrl: 'http://localhost:4000' } }));
  if (files.local) writeFileSync(path.join(root, 'config', 'rconsole.local.json'), JSON.stringify(files.local));
  if (files.env !== undefined) writeFileSync(path.join(root, '.env'), files.env);
  return root;
}

describe('dev ports (v0.3 follow-up 5)', () => {
  it('Vite proxies to the port the server listens on: the generic dev config says 4000, as the server does', () => {
    const port = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'config', 'rconsole.dev.json'), 'utf8')) as { server: { port: number } }).server.port;
    const generic = repo({ dev: { server: { port, publicUrl: `http://localhost:${port}` } } });
    expect(devServerPort({}, generic, generic)).toBe(port);
    expect(devWebPort({}, generic)).toBe(DEFAULT_WEB_PORT);
    const vite = readFileSync(path.join(REPO_ROOT, 'apps', 'web', 'vite.config.ts'), 'utf8');
    expect(vite).toContain('proxy: { "/api": `http://127.0.0.1:${devServerPort()}` }');
    expect(vite).not.toMatch(/localhost:4300|:4300/);
  });

  it('RCONSOLE_PORT wins (environment, then .env), then the config in use (local before dev), then 4000', () => {
    const root = repo({ local: { server: { port: 4700 } }, env: 'RCONSOLE_PORT=4800\nRCONSOLE_WEB_PORT=5175\nOTHER=x\n' });
    expect(devServerPort({ RCONSOLE_PORT: '4600' }, root, root)).toBe(4600);
    expect(devServerPort({}, root, root)).toBe(4800);
    expect(devWebPort({}, root)).toBe(5175);
    expect(devWebPort({ RCONSOLE_WEB_PORT: '5176' }, root)).toBe(5176);
    const noEnv = repo({ local: { server: { port: 4700 } } });
    expect(devServerPort({}, noEnv, noEnv)).toBe(4700);
    expect(devConfigFile({}, noEnv, noEnv)).toBe(path.join(noEnv, 'config', 'rconsole.local.json'));
    const custom = path.join(noEnv, 'custom.json');
    writeFileSync(custom, JSON.stringify({ server: { port: 4900 } }));
    expect(devServerPort({ RCONSOLE_CONFIG: 'custom.json' }, noEnv, noEnv)).toBe(4900);
    expect(devServerPort({}, repo({ dev: { server: {} } }), '/')).toBe(4000);
    expect(() => devServerPort({ RCONSOLE_PORT: 'x' }, noEnv, noEnv)).toThrow(/RCONSOLE_PORT must be a port number/);
    expect(() => devWebPort({ RCONSOLE_WEB_PORT: '70000' }, noEnv)).toThrow(/RCONSOLE_WEB_PORT/);
  });

  it('a local publicUrl follows RCONSOLE_PORT unless RCONSOLE_PUBLIC_URL is set or the URL is not local http', () => {
    const root = repo();
    expect(devPublicUrl({ RCONSOLE_PORT: '4600' }, root, root)).toBe('http://localhost:4600');
    expect(devPublicUrl({}, root, root)).toBeUndefined();
    expect(devPublicUrl({ RCONSOLE_PORT: '4600', RCONSOLE_PUBLIC_URL: 'http://localhost:5176' }, root, root)).toBeUndefined();
    const remote = repo({ dev: { server: { port: 4000, publicUrl: 'https://console.example.com' } } });
    expect(devPublicUrl({ RCONSOLE_PORT: '4600' }, remote, remote)).toBeUndefined();
  });
});
