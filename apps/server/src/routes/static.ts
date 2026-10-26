/**
 * Serves the built SPA (apps/web/dist) from the same origin. index.html gets the per-request CSP nonce
 * as <meta name="csp-nonce">. Unknown non-API GETs fall back to index.html; /api never falls back.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.ts';
import { errorBody } from '../http/errors.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

/**
 * Put the per-request nonce into index.html: exactly one `<meta name="csp-nonce" content="...">` first in
 * <head> (the SPA ships a placeholder with an empty content, which is dropped), and `nonce` on every <style>.
 * One linear pass over the tags (no backtracking regexes).
 */
export function injectNonce(html: string, nonce: string): string {
  const meta = `<meta name="csp-nonce" content="${nonce}">`;
  let out = '';
  let pos = 0;
  let headDone = false;
  for (;;) {
    const lt = html.indexOf('<', pos);
    if (lt < 0) break;
    const gt = html.indexOf('>', lt);
    if (gt < 0) break;
    const tag = html.slice(lt, gt + 1);
    const name = /^<([a-zA-Z]+)/.exec(tag)?.[1]?.toLowerCase();
    out += html.slice(pos, lt);
    if (name === 'meta' && /\bname\s*=\s*["']?csp-nonce\b/i.test(tag)) {
      // drop the placeholder
    } else if (name === 'style' && !/\bnonce\s*=/i.test(tag)) {
      out += `<style nonce="${nonce}"${tag.slice(6)}`;
    } else if (name === 'head' && !headDone) {
      out += tag + meta;
      headDone = true;
    } else {
      out += tag;
    }
    pos = gt + 1;
  }
  out += html.slice(pos);
  return headDone ? out : meta + out;
}

export function registerStatic(app: FastifyInstance, ctx: AppContext) {
  const root = ctx.config.server.webDist;
  const indexPath = path.join(root, 'index.html');
  const hasDist = existsSync(indexPath);
  const realRoot = hasDist ? realpathSync(root) : root;
  /**
   * index.html resolved like any asset: a symlink must stay inside dist (review L2). The resolved path is what
   * gets read, so swapping the link afterwards cannot redirect this read. Null when missing or outside.
   */
  const indexFile = (): string | null => {
    try {
      const real = realpathSync(indexPath);
      return real.startsWith(realRoot + path.sep) && statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  };
  let indexTemplate: string | undefined;
  const index = (): string | undefined => {
    // Production reads it once; development re-reads so a rebuilt SPA is picked up without restarting.
    if (indexTemplate !== undefined && ctx.config.production) return indexTemplate;
    const f = indexFile();
    if (!f) {
      ctx.log.warn('web UI index.html is missing or resolves outside webDist; not serving it');
      return (indexTemplate = undefined);
    }
    return (indexTemplate = readFileSync(f, 'utf8'));
  };

  const sendIndex = (req: FastifyRequest, reply: FastifyReply) => {
    const html = index();
    if (html === undefined) return reply.code(404).type('text/plain; charset=utf-8').send('The web UI is not available.');
    return reply.code(200).header('cache-control', 'no-store').type('text/html; charset=utf-8').send(injectNonce(html, req.nonce));
  };

  const resolveFile = (urlPath: string): string | null => {
    let rel: string;
    try {
      rel = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    if (rel.includes('\0')) return null;
    const segments = rel.split('/').filter(Boolean);
    if (segments.some((s) => s.startsWith('.'))) return null; // no dotfiles, no traversal
    const file = path.resolve(root, ...segments);
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    try {
      // Symlinks inside dist must not lead outside it.
      const real = realpathSync(file);
      if (!real.startsWith(realRoot + path.sep)) return null;
      return statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  };

  app.setNotFoundHandler((req, reply) => {
    const urlPath = req.url.split('?')[0]!;
    if (urlPath === '/api' || urlPath.startsWith('/api/')) return reply.code(404).send(errorBody('not_found', 'Unknown API route.'));
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(404).send(errorBody('not_found', 'Not found.'));
    if (!hasDist) {
      return reply.code(404).type('text/plain; charset=utf-8').send('Redis Console API is running. The web UI is not built (apps/web/dist missing).');
    }
    if (urlPath === '/' || urlPath === '/index.html') return sendIndex(req, reply);
    const file = resolveFile(urlPath);
    if (file) {
      const ext = path.extname(file).toLowerCase();
      if (ext === '.html') return sendIndex(req, reply);
      const type = TYPES[ext] ?? 'application/octet-stream';
      const immutable = urlPath.startsWith('/assets/');
      return reply
        .code(200)
        .type(type)
        .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
        .send(readFileSync(file));
    }
    // SPA fallback only for "page" URLs (no file extension); missing assets are real 404s.
    if (!path.extname(urlPath)) return sendIndex(req, reply);
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  });
}
