# Standalone Manual App Mounted at `/manuals/*`

> **Status:** Implemented for #243. A lightweight Vite app at `packages/app/manual/` is embedded into the studio
> deploy at `/manuals/`. In-studio `ManualPage` is kept so desktop help-menu links still SPA-navigate without a
> full reload. External links and hard-refresh on `/manuals/*` load the standalone app (no studio boot, works on
> mobile). Follow-up: drop the in-studio page and turn remaining `LocalLink`/`navigateTo` manuals links into
> plain `<a href>` once that is wanted.

## Goal

Keep the existing URLs (`https://opendaw.studio/manuals/devices/audio/dattorro-reverb`, etc.) but have hard-refresh
and inbound links served by a separate, lightweight static app instead of loading the full studio bundle. Same
origin, no new subdomain. Same visual style as the in-studio manual.

## Why a separate app rather than a flag in studio

The studio bundle is large (audio engine, boxes, P2P, processors, …). Visitors who only want to read docs should
not pay that cost. A dedicated app loads in well under a second on a cold cache. It also lets us link to manuals
from external sites (Discord, GitHub README, search engines) without dragging users into the editor — and without
hitting the studio's `Browser.isMobile()` desktop-only gate.

## What shipped

- `@opendaw/studio-icons` and `@opendaw/studio-markdown` (monorepo-internal, **not** in `@opendaw/studio-sdk`).
- `@opendaw/manuals`: nav tree (`Manuals.ts` uses raw `IconSymbol` values, no factory imports) plus `content/`.
- `@opendaw/manual`: Vite app, `base: "/manuals/"`, mounts `IconLibrary`, no `StudioService`.
- Studio re-exports `Icon` / `IconLibrary` from the old paths so the 60+ studio import sites did not churn.
- `action://` links stripped from markdown (`/preferences` for the shortcut manager; cloud-backup actions became
  prose, since those handlers live in `studio-core`).
- Markdown SPA rewriter only intercepts `/manuals/*`. Other same-origin links do a full navigation.
- Production: studio `.htaccess` rewrites unmatched `/manuals/*` to `manuals/index.html` **before** the studio SPA
  fallback. `app-studio` build embeds `@opendaw/manual`'s `dist/` into `dist/manuals/`.
- Local: `npm run dev:manual` (port 8081). Studio `vite` still serves markdown from `packages/manuals/content` so
  the in-studio page keeps working during `dev:studio`.

## Follow-ups

1. Remove in-studio `ManualPage` / `/manuals/*` route and convert help-menu + "Visit Manual" entries to `<a href>`.
2. Migrate remaining `@/ui/components/Icon` imports to `@opendaw/studio-icons` and drop the re-exports.
3. Keep `Manuals.ts` icons in sync with `EffectFactories` / `InstrumentFactories` `defaultIcon` by hand (the
   indirection is gone on purpose).
