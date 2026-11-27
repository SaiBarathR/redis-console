// @ts-check
import { defineConfig } from 'astro/config';
import { rehypeHeadingIds, unified } from '@astrojs/markdown-remark';
import { rehypeSite } from './src/lib/rehype-site.mjs';
import { codeThemes } from './src/lib/code-themes.mjs';

// GitHub Pages project site: every URL lives under /redis-console/.
export default defineConfig({
  site: 'https://saibarathr.github.io',
  base: '/redis-console',
  trailingSlash: 'always',
  // Astro 7's HTML compression drops the space between a line of text and an inline element on the next line.
  compressHTML: false,
  build: { format: 'directory', inlineStylesheets: 'auto' },
  markdown: {
    shikiConfig: { themes: codeThemes, defaultColor: false, wrap: false },
    processor: unified({ rehypePlugins: [rehypeHeadingIds, rehypeSite] }),
  },
  vite: {
    // The docs and release notes live in ../docs, outside site/.
    server: { fs: { allow: ['..'] } },
  },
});
