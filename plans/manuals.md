# Standalone Manual App at `/manuals/*`

> **Status:** Implemented for #243. `@opendaw/manual` at `packages/app/manual/` is its own Vite app and the only
> manual viewer. It owns the nav tree and the markdown content. The studio has no manual page, no manual data and no
> dependency on the manual app, it only carries `href`s under `/manuals/` that open the manual in a separate
> `manuals` browser tab. The manual app is **not** embedded into the studio build, it is built and deployed on its
> own (deploy still to be wired up, see Open).

## Goal

Keep the existing URLs (`https://opendaw.studio/manuals/devices/audio/dattorro-reverb`, etc.) but have them served
by a separate, lightweight static app instead of loading the full studio bundle. Same visual style as the studio.

## Why a separate app rather than a flag in studio

The studio bundle is large (audio engine, boxes, P2P, processors, …). Visitors who only want to read docs should
not pay that cost. A dedicated app loads in well under a second on a cold cache. It also lets us link to manuals
from external sites (Discord, GitHub README, search engines) without dragging users into the editor — and without
hitting the studio's `Browser.isMobile()` desktop-only gate.

## What shipped

- `@opendaw/studio-icons` and `@opendaw/studio-markdown` (monorepo-internal, **not** in `@opendaw/studio-sdk`),
  shared by the studio and the manual app so icons and markdown render identically in both.
- `@opendaw/manual`: Vite app, `base: "/manuals/"`, mounts `IconLibrary`, no `StudioService`. Contains
  `src/Manuals.ts` (nav tree with raw `IconSymbol` values, no factory imports) and `public/` with the markdown,
  images, `.htaccess` and Rubik fonts, so it runs without the studio and needs no custom Vite plugin. A page at
  `/manuals/<path>` loads `/manuals/<path>.md`.
- `/manuals/` is the introduction (`content/index.md`). The sidebar is a tree in the preset-browser style
  (triangle, guide line, device icons), pages open in place, deep links and hard refresh work.
- Studio: `ui/manuals.ts` has `openManual(path)` = `window.open(path, "manuals")`. Help button, dashboard tiles
  and rail, backup and Nextcloud help, device "Visit Manual", latency warning, Shadertoy and the permissions dialog
  all go through it or through `<a href="/manuals/…" target="manuals">`. The studio imports nothing from the
  manual app.
- Studio re-exports `Icon` / `IconLibrary` from the old paths so the 60+ studio import sites did not churn.
- `action://` links removed from markdown and from `Markdown.tsx` (`/preferences` for the shortcut manager;
  cloud-backup actions became prose, since those handlers live in `studio-core`).
- Markdown link rewriter only intercepts `/manuals/*`. Other same-origin links do a full navigation.
- Local: `npm run dev:manual` (port 8081). The studio `vite` dev server proxies `/manuals/*` to port 8081, so
  run both when testing manual links from the studio.

## Open

1. Deploy: `deploy/run.ts` uploads only the studio dist, and the root `.htaccess` on the server routes every
   `opendaw.studio` path into the current studio release folder. The manual app needs its own upload target and a
   root rewrite for `/manuals/` that wins over the studio release routing (or its own host, then the studio hrefs
   must become absolute).

## Follow-ups

1. Migrate remaining `@/ui/components/Icon` imports to `@opendaw/studio-icons` and drop the re-exports.
2. Keep `Manuals.ts` icons in sync with `EffectFactories` / `InstrumentFactories` `defaultIcon` by hand (the
   indirection is gone on purpose).
