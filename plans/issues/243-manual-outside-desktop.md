# Make the Manual Accessible Outside Desktop Computers (#243)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — a full plan already exists in `plans/manuals.md`, mostly package-extraction work with no unsolved design questions
**Type:** documentation, ux
**Scope:** medium

## What is asked
A version of the manual that keeps the current visual style but does not boot the full studio, so it works on mobile/tablet (and loads fast from external links like Discord/GitHub/search).

## Current behaviour / relevant code
The manual is served in-app only, at the cost of loading the entire studio bundle (audio engine, boxes, adapters, P2P, worklets):
- Markdown sources: `packages/app/studio/public/manuals/*.md` (+ `.webp`, `devices/**`).
- Navigation tree: `packages/app/studio/src/ui/pages/Manuals.ts` — imports `EffectFactories`/`InstrumentFactories` for icons, which pulls in `studio-core`/`studio-adapters`.
- Renderer: `packages/app/studio/src/ui/Markdown.tsx` (markdown-it + `{icon:Name}` substitution + action-link handler + internal-link SPA rewriter).
- Page shell: `packages/app/studio/src/ui/pages/ManualPage.tsx` (sidebar nav, `PageContext<StudioService>`-typed, back button).
- Icons: `packages/app/studio/src/ui/components/Icon.tsx` + `IconLibrary.tsx`, resolved via `@opendaw/studio-enums::IconSymbol`.
- Route: `packages/app/studio/src/ui/App.tsx:47` — `{path: "/manuals/*", factory: ManualPage}`.
- In-app links into the manual: `ShadertoyPreview.tsx:28`, `devices/menu-items.ts:81`, `service/StudioMenu.ts:113`, `audio/AudioDevices.ts:67`.

There is already `wiki/`-style content and a Note Pad markdown renderer (`NotePadPanel.tsx`) sharing `Markdown.tsx`, so the renderer cannot simply be deleted from studio.

## Plan
Follow `plans/manuals.md` (status: parked, plan documented, decision pending) — it already contains a full audit and step-by-step order. Summary of the approach:
1. Extract three packages: `packages/manuals/` (markdown + `Manuals.ts` nav, source-only), `packages/studio-icons/` (Icon/IconLibrary, sibling to `studio-enums`), `packages/studio-markdown/` (Markdown renderer, depends on `studio-icons`).
2. Rewrite `Manuals.ts` to reference raw `IconSymbol` values instead of `EffectFactories.X.defaultIcon`, dropping the `studio-core`/`studio-adapters` dependency.
3. Strip `action://` links (open-preferences, backup-google-drive, backup-dropbox) from manual markdown, replace with plain `<a href>` into the studio.
4. Scaffold a new lightweight Vite app `packages/app/manual/` (mirrors `packages/app/lab/`), `base: "/manuals/"`, mounts `<IconLibrary/>` at root, uses `studio-markdown` + `studio-icons`, no `StudioService` dependency.
5. Update deploy (`.htaccess`/Apache rewrite) so `/manuals/*` is served by the new app's `dist/`, ordered before the studio's generic SPA fallback.
6. Remove the in-studio `ManualPage.tsx`, `Manuals.ts`, and the `/manuals/*` route from `App.tsx`; replace in-app `LocalLink`/`RouteLocation.navigateTo` manual links with plain `<a href>` so they trigger full navigation to the new app.
7. Keep `studio-markdown` as a studio dependency for `NotePadPanel.tsx` (Note Pad / Project Info still needs `renderMarkdown`).

`plans/manuals.md` has a suggested execution order (9 steps) with per-step verification and a "Testing" section (local dev at a spare port, combined-origin Apache/static-server realism check, deep-link hard-refresh checks both inside and outside `/manuals/`).

## Risks / open questions
- The plan's own audit found real friction (`Manuals.ts` factory-icon coupling, action-link coupling, link-rewriter SPA-boundary logic) — already resolved on paper in `plans/manuals.md`, not yet implemented or verified against the current source tree at time of writing this plan (re-check for drift before starting, since Werkstatt and other devices have been added since).
- Open decision left in the source plan: whether `studio-icons` + `studio-markdown` should be two packages or folded into one `studio-ui` package. Pick before scaffolding.
- Confirm the production host actually uses Apache (`.htaccess`) and not nginx/CDN-edge rewriting, since the whole deploy step assumes `RewriteRule` semantics.
- Fonts (`/fonts/...` Rubik) are assumed same-origin; only works if both apps deploy to the same host, which the issue's "outside desktop computers" (mobile/tablet) framing does not preclude but is worth confirming as the deployment model.
