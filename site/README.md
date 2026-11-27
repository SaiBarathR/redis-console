# Redis Console website

The site at https://saibarathr.github.io/redis-console/, built with [Astro](https://astro.build) into plain static files.
The only JavaScript on the pages is one small script (theme, mobile menu, copy buttons, video fallback). It is not
part of the pnpm workspace: it has its own `package-lock.json`.

```sh
cd site
npm ci
npm run dev       # http://localhost:4321/redis-console/
npm run build     # static site in site/dist
npm run preview   # serve site/dist
```

`.github/workflows/pages.yml` builds and deploys it on every push to `main` that touches `site/`, `docs/` or
`apps/server/package.json`.

## Where the content comes from

| Page | Source |
| --- | --- |
| Home, Security | `src/pages/index.astro`, `src/pages/security.astro` (the threat summary follows `docs/SECURITY.md`) |
| Docs | `docs/INSTALL.md`, `USER-GUIDE.md`, `OPERATIONS.md`, `SECURITY.md`, `ARCHITECTURE.md`, `DECISIONS.md`, rendered as they are |
| Changelog | every `docs/RELEASE-NOTES-v*.md`, newest first |
| Version | `apps/server/package.json` |

`src/lib/rehype-site.mjs` rewrites links in the Markdown: links between the published documents go to their pages,
release notes to the changelog, every other relative link to the file on GitHub, and relative images to the raw files.
A new document needs an entry there, in `src/lib/docs.ts`, in the sidebar (`src/layouts/Docs.astro`) and in
`src/pages/sitemap.xml.ts`.

## Images and video

- `public/images/<name>-light.webp` and `-dark.webp`: product screenshots, the app at 1440 × 900 (2x) scaled to
  1600 × 1000, taken on the local sandbox with demo data only (never real data). The page shows the one that matches
  the site's theme.
- `public/media/promo.mp4` and `promo-poster.webp`: the promo video (Remotion, rendered outside the repo).
- `public/og.png` (1200 × 630) and the icons are rendered from `src/assets/rc-mark.svg`.

The palette is neutral greys with a solid amber accent: no purple and no gradients.
