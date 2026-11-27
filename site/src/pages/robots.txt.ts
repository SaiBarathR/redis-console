import type { APIRoute } from 'astro';

// A project site is served under /redis-console/, so this file is only used if the site ever moves to a root domain;
// it still documents where the sitemap is.
export const GET: APIRoute = ({ site }) => {
  const sitemap = new URL(import.meta.env.BASE_URL.replace(/\/?$/, '/') + 'sitemap.xml', site).href;
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap}\n`, { headers: { 'Content-Type': 'text/plain' } });
};
