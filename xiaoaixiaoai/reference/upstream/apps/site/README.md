# Herdr Pocket website

The project's showcase site and intro film. A static Vite + TypeScript page
(three.js hero, GSAP scroll scenes, Lenis smooth scrolling) and a Remotion
film in `video/`. Both are standalone installs, kept out of the root pnpm
workspace so the server install stays light.

Chinese is the source language (in `index.html`); English lives in
`src/i18n.ts`. Repository slug, example server and every shell command shown on
the page come from one constant: `src/config.ts`.

## Develop

```sh
cd apps/site
pnpm install
pnpm dev          # http://127.0.0.1:5180
pnpm typecheck
```

## Build

```sh
pnpm build        # -> dist/
pnpm preview      # serve dist/ on http://127.0.0.1:5181
```

The build uses a relative base (`./`), so the same `dist/` works at a domain
root and under a sub-path. Set `SITE_BASE=/some/path/` to pin an absolute base.

Link previews (Open Graph, X/Twitter cards) need an absolute image URL. Set
`SITE_URL` to the address the site is served from, e.g.
`SITE_URL=https://pocket.example.com/ pnpm build`; the build then rewrites
`og:image` to an absolute URL and adds a canonical link. Without it the
relative `og.jpg` is kept, which most link-preview crawlers ignore.

## Deploy

Cloudflare Pages: create a Pages project from the repository with root
directory `apps/site`, build command `pnpm install && pnpm build`, output
directory `dist`. Or upload a local build:

```sh
pnpm build && npx wrangler pages deploy dist --project-name herdr-pocket
```

GitHub Pages: publish `apps/site/dist` with the official Pages actions, for
example in a workflow job:

```yaml
- uses: pnpm/action-setup@v4
- run: pnpm install && pnpm build
  working-directory: apps/site
- uses: actions/upload-pages-artifact@v3
  with: { path: apps/site/dist }
- uses: actions/deploy-pages@v4
```

## Assets

`public/assets` holds compressed copies of the app's mascot, call faces, vendor
avatars and logo. Regenerate them (needs python3 with numpy and Pillow, ffmpeg,
cwebp, img2webp, magick):

```sh
pnpm assets
```

The animated hero mascot (`mascot/idle.webp`, `tap.webp`, `idle-poster.webp`)
is keyed from green-screen source clips that are not in the repository; without
them the script keeps the committed files and regenerates everything else.

Fonts in `src/fonts` are subsets of Nunito, ZCOOL KuaiLe and Maple Mono (SIL
OFL 1.1, licenses alongside). After changing page or film text, re-subset so
new Chinese characters are included (reads the fonts from `apps/mobile`'s
installed packages):

```sh
pnpm fonts
```

## Intro film

```sh
cd video
pnpm install
pnpm assets       # copies ../public/assets and ../src/fonts into video/public
pnpm studio       # live preview in the browser
pnpm render       # -> ../public/video/intro.mp4, intro-720.mp4, intro-poster.webp, ../public/og.jpg
```

Rendering uses an installed Google Chrome when found (or the browser in
`REMOTION_BROWSER`), so Remotion does not need to download its headless shell.
`CONCURRENCY` sets parallel tabs (default 4). The film reuses the site's
`src/styles/phone.css`, so phone screens look the same in both.

## License

AGPL-3.0-only, like the rest of the repository. Under the section 7
additional permission in the root README, the site may use GSAP and the film
may use Remotion under their own terms; they do not fall under the AGPL.
Remotion requires a paid company license for larger teams, so check its
license before rendering for an organisation.
