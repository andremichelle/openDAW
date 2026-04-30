# Standalone Manual App Mounted at `/manuals/*`

> **Status:** Parked. Plan documented for future reference, not active work. Decision pending on whether to commit the time. The dry run below caught more friction than expected (especially around `Manuals.ts` factory imports and the action-link coupling), so revisit the audit findings before starting.

## Goal

Drop the in-studio manual page entirely. Keep the existing URLs (`https://opendaw.studio/manuals/devices/audio/dattorro-reverb`, etc.) but have those paths served by a separate, lightweight static app instead of loading the full studio bundle. Same origin, no new subdomain. Look identical to the current in-studio manual minus the back-to-studio button and back-arrow.

## Why a separate app rather than a flag in studio

The studio bundle is large (audio engine, boxes, P2P, processors, …). Visitors who only want to read docs should not pay that cost. A dedicated app loads in well under a second on a cold cache. It also lets us link to manuals from external sites (Discord, GitHub README, search engines) without dragging users into the editor. Inbound links keep working unchanged because the URL shape is preserved.

## Audit findings (dry run)

Things that broke when I walked through the implementation in detail:

1. **`Manuals.ts` drags in `studio-core` and `studio-adapters`.** It uses `EffectFactories.X.defaultIcon` and `InstrumentFactories.X.defaultIcon` to populate the navigation tree's `icon` field. Moving `Manuals.ts` as-is into `packages/manuals/` would force the manual app to depend on the audio engine and processors, which kills the whole reason for a separate app.
   **Fix:** rewrite `Manuals.ts` to use raw `IconSymbol.Compressor` etc. instead of `EffectFactories.Compressor.defaultIcon`. Loses the indirection (factory icons must stay in sync manually) but kills the heavy deps. `packages/manuals/` then only depends on `studio-enums`.

2. **`IconLibrary` must be mounted in the DOM.** The studio mounts `<IconLibrary/>` in `Surface.tsx:143`. The Icon component renders `<svg><use href="#name"/></svg>`, which only resolves if a `<symbol id="name">` exists in the document. The manual app needs to mount `<IconLibrary/>` once at the root, otherwise every icon renders blank.

3. **`ManualPage`'s signature uses `PageContext<StudioService>`.** The standalone manual app has no `StudioService`. The page factory shape needs to change. The only studio-service touch is `service.buildInfo.uuid` for the markdown cache-busting query string. We can drop that and rely on `cache: "no-store"` (same approach we just used for room stats).

4. **`Markdown.tsx` SPA-routes ALL same-origin links.** `Markdown.tsx:42-50` does `RouteLocation.get().navigateTo(url.pathname)` for any same-origin link. Inside the manual app, that's correct for in-manual cross-references like `/manuals/automation`, but wrong for links into the studio like `/preferences`. After mounting the manual at `/manuals/*`, the rewriter needs to distinguish: same-prefix → SPA navigate within manual; otherwise → full navigation. Cleanest: only SPA-route links whose pathname starts with `/manuals/`.

5. **Action links are tied to studio internals.** `ManualPage.tsx:55-58` injects three handlers: `open-preferences` (RouteLocation), `backup-google-drive` (`CloudBackup.backup`), `backup-dropbox` (same). `CloudBackup` lives in `studio-core`. The manual app cannot take that dep. Two choices:
   - Strip `action://` from markdown sources, replace with regular `<a href="/preferences">` etc. The studio host serves those, so a regular link from the manual app does a full navigation into the studio.
   - Keep the `action://` syntax but have the manual app's handler do `window.location.assign(...)` for the studio routes.
   First is simpler and survives reading the markdown raw on GitHub.

6. **In-studio links to manuals are in more places than I called out.** Found via grep:
   - `ShadertoyPreview.tsx:28` (`LocalLink`)
   - `devices/menu-items.ts:81` "Visit '${name}' Manual..." menu items
   - `audio/AudioDevices.ts:67` `window.open("/manuals/permissions", "_blank")` already does a hard navigation, leave alone
   - `service/StudioMenu.ts:113` `RouteLocation.get().navigateTo("/manuals/cloud-backup")` (help menu)
   All of the `LocalLink`/`navigateTo` ones need to become regular `<a href>` so they trigger full navigation that hits the Apache rewrite.

7. **Existing `.htaccess` already has SPA fallback and a comment about `/manuals/`.**
   `packages/app/studio/public/.htaccess` ends with:
   ```
   RewriteCond %{REQUEST_FILENAME} !-f
   RewriteRule ^ index.html [L]
   ```
   The `/manuals/*` rewrite must be inserted **before** this generic rule, otherwise it'll never fire. The existing comment about needing to handle `/manuals/` because the folder exists becomes obsolete and should be removed when the folder is removed from studio's `public/`.

8. **The studio's `.htaccess` also configures Brotli and cache headers**. The manual app should inherit a similar `.htaccess` (its own copy under its deploy directory) so deep links and `index.html` cache-busting behave the same.

9. **Fonts and shared origin.** The manual references Rubik via the studio's `/fonts/...`. Same-origin deploy makes this work without copying, as long as the manual's CSS uses absolute paths (`/fonts/...`) not relative. If we ever wanted the manual deployable on a different host, we'd need its own font copies. For now: absolute paths, single host.

10. **`build-info.json` is studio-specific.** Currently used by `ManualPage` for cache-busting markdown URLs. The manual app would have its own build, or we just drop the cache-busting param. Drop it.

11. **`Markdown` exports two things: the JSX `Markdown` wrapper (used by `ManualPage`) and the imperative `renderMarkdown` function (used by `NotePadPanel.tsx:9`).** Both move to `studio-markdown`. The `actions` param is only used by `ManualPage`. After we strip actions per finding 5, the `Markdown` API becomes simpler and `NotePadPanel` is unaffected.

12. **`Manuals.ts` `Manual` type uses `icon?: IconSymbol`.** That's fine; `studio-enums` is light (depends only on `lib-std`). `packages/manuals/` only needs `studio-enums` after we remove the factory-icon indirection.

13. **`packages/studio-icons/` and `packages/studio-markdown/` must NOT be added to `@opendaw/studio-sdk`'s `dependencies` in `package.json`.** The SDK does export its deps transitively (it lists `studio-adapters`, `studio-boxes`, `studio-core`, `studio-enums` today). Anyone installing the SDK pulls those. Keeping the new icon/markdown packages out of that list keeps them monorepo-internal. If we want them available to SDK consumers later we can add them; for now we don't.

## Current state

- Markdown sources: `packages/app/studio/public/manuals/*.md` (and `.webp` assets, `devices/` subfolder).
- Navigation list: `packages/app/studio/src/ui/pages/Manuals.ts` (typed tree of pages and folders).
- Renderer: `packages/app/studio/src/ui/Markdown.tsx` (uses `markdown-it`, `markdown-it-table`, custom `{icon:Name}` syntax replaced via the studio's `Icon` component, action-link handler, internal-link rewriter).
- Page shell: `packages/app/studio/src/ui/pages/ManualPage.tsx` (sidebar nav + Await-driven markdown fetch + back button).
- Icon system: `packages/app/studio/src/ui/components/Icon.tsx` plus `packages/app/studio/src/ui/IconLibrary.tsx`, ultimately resolving names through `@opendaw/studio-enums::IconSymbol`. The Markdown renderer uses `IconSymbol.fromName(name)` so any manual referencing `{icon:Foo}` requires the same icon registry.
- Routing entry: `packages/app/studio/src/ui/App.tsx:47` declares `{path: "/manuals/*", factory: ManualPage}`.
- In-studio links: `Manuals.ts` paths and `LocalLink href="/manuals/..."` in places like `ShadertoyPreview.tsx:28`. Plus the Help menu entry that opens the manual.

## Architecture

Three pieces:

1. **Shared markdown assets** `packages/manuals/` (source-only, no build):
   - `manuals/*.md`, `manuals/*.webp`, `manuals/devices/**`, plus the navigation list `Manuals.ts`.
   - Moved out of `packages/app/studio/public/manuals/`. Studio's other public assets (`images/`, `fonts/`, `build-info.json`, `sponsors.json`, etc.) stay where they are.

2. **Icon package** `packages/studio-icons/` (new, sister to `studio-enums`):
   - `Icon.tsx`, `IconLibrary.tsx`, plus the SASS for them.
   - App-agnostic: any app or package in the monorepo can consume it. Studio depends on it instead of keeping those files in `packages/app/studio/src/ui/`. The manual app also depends on it.
   - `IconSymbol` stays in `studio-enums` where it already lives; nothing changes there.
   - Treat this as a refactor of existing studio code, not new code. Behavior unchanged; files move.
   - **Not exported from `@opendaw/studio-sdk`**. It's a monorepo-internal package consumed by app builds. The SDK's `src/index.ts` only re-exports `OPENDAW_SDK_VERSION` today; we leave it that way and don't add the icons.

3. **Markdown package** `packages/studio-markdown/` (new):
   - `Markdown.tsx` (and the `renderMarkdown` named export it provides), plus `Markdown.sass`.
   - Required because the studio still uses Markdown rendering even after the manual page is removed: `packages/app/studio/src/ui/NotePadPanel.tsx:9,39` calls `renderMarkdown` for the Project Info / Note Pad. So we cannot leave `Markdown.tsx` inside the manual app.
   - Depends on `studio-icons` (for the `{icon:Name}` substitution) and `studio-enums` (for `IconSymbol`). Pulls in `markdown-it` and `markdown-it-table` as runtime deps.
   - **Not exported from `@opendaw/studio-sdk`** for the same reason as `studio-icons`.

4. **New Vite app** `packages/app/manual/`:
   - Mirrors the layout of `packages/app/lab/`.
   - Vite config: `base: "/manuals/"` so all asset URLs (`/manuals/assets/...`, `/manuals/index.html`) match the deploy path.
   - Renders only the manual route. Minimal `App.tsx` with one route handling `/manuals/*`.
   - Sources the markdown via `vite-plugin-static-copy` from `packages/manuals/` into `dist/manuals/` (relative to the app's `base`, so the final URL is still `/manuals/audio-bus.md`).
   - Imports `Markdown` from `studio-markdown`, and (transitively) `Icon`/`IconLibrary` from `studio-icons`.

   Fonts and other top-level assets the manual references (e.g. Rubik via `/fonts/...`) need to be available at the manual app's origin. Either copy them into the manual app's `public/` so they ship as `/manuals/fonts/...` (then update CSS), or rely on the studio's deployment under the same origin so the manual can reference them at `/fonts/...` directly. The second is simpler given the shared origin.

## Removing the in-studio manual page

After the manual app is live:

- Delete `packages/app/studio/src/ui/pages/ManualPage.tsx` and `ManualPage.sass`.
- Delete `packages/app/studio/src/ui/pages/Manuals.ts` (move to `packages/manuals/Manuals.ts`).
- Remove the `{path: "/manuals/*", factory: ManualPage}` route from `App.tsx`. With Apache routing `/manuals/*` to the manual app, the studio bundle never receives those paths anyway, but the dead route is worth removing.
- Replace every internal `LocalLink href="/manuals/..."` (e.g. `ShadertoyPreview.tsx:28`) and every help-menu entry with an `<a href="/manuals/...">`. Same URL, different element: a regular link triggers a full navigation that Apache routes to the manual app instead of the SPA-internal `LocalLink` route. Optional `target="_blank"` if we want the manual to open in a new tab.
- Studio keeps `markdown-it` and `markdown-it-table` indirectly via `studio-markdown` (the `NotePadPanel` still needs them).
- Remove `packages/app/studio/public/manuals/` (now moved to `packages/manuals/`).

## Sharing markdown across builds

`packages/manuals/` becomes the canonical location. The new manual app uses `vite-plugin-static-copy` to ingest it into its own `dist/`. Studio no longer needs it. If we ever want a fallback in studio (e.g. an offline copy), we wire the same plugin into studio's vite config without changing `publicDir`.

## Build

- `pnpm --filter @opendaw/manual build` produces a static `dist/` whose internal asset URLs are prefixed with `/manuals/` thanks to `base: "/manuals/"` in vite config.
- Add to `turbo.json` pipeline so it builds in CI alongside studio and lab.

## Deploy

Both the studio and the manual ship to the same host, same origin. The Apache vhost for `opendaw.studio` needs three rules in this order:

1. Anything matching `^/manuals(/|$)` → serve from the manual app's deploy directory. SPA fallback within that subtree: any path under `/manuals/*` that does not match a real file falls back to the manual app's `index.html` (which the router then resolves).
2. Any other path that does not match a real file → studio's `index.html` (existing SPA fallback, unchanged).
3. Real files served as-is for both bundles.

Concrete `.htaccess`-style sketch (subject to whatever the existing studio config looks like):

```
RewriteEngine On

# Manual app subtree
RewriteCond %{REQUEST_URI} ^/manuals(/|$)
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /manuals/index.html [L]

# Studio SPA fallback (existing; keep last so the manual rule wins)
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.html [L]
```

Deployment can either be:
- Both bundles uploaded to the same server: studio at the doc root, manual at `<docroot>/manuals/`. Files coexist on disk.
- Or two separate `Alias`/`DocumentRoot`-style mappings if the existing deploy script prefers that.

No DNS, no extra TLS, no CORS work.

## Testing

- Local dev: `pnpm --filter @opendaw/manual dev` starts a Vite dev server with `base: "/manuals/"`. Navigate to `https://localhost:8081/manuals/audio-bus` (port matches `lab`'s pattern; pick whichever port is unused). Verify each page in `Manuals.ts` renders, `{icon:Name}` substitutions resolve, internal cross-links inside markdown still work, images load, code blocks copy on click.
- Production preview: `pnpm --filter @opendaw/manual build && pnpm --filter @opendaw/manual preview`.
- Combined-origin realism: stand up a local Apache (or use a small Node static server with the same rewrite rules) that serves studio's `dist/` at `/` and manual's `dist/` at `/manuals/`, then visit `https://localhost/manuals/audio-bus` and confirm:
  - Hard-refreshing on a deep manual URL works (no studio bundle loaded; the manual app boots).
  - Hard-refreshing on a non-manual deep URL still works (studio loads, no manual app interference).
  - A click on a manual link inside the studio triggers a full navigation, not a router-internal `LocalLink` resolution.
- Studio side: after removing the in-app manual page, click every help-menu entry and every contextual "Visit Manual" link and confirm they leave the studio and load the manual app.

## Open questions / decisions

Most original open questions were closed during the dry run (see Audit findings). What's left:

1. **Package name.** `studio-icons` matches the existing `studio-enums` / `studio-adapters` convention. Alternative is `lib-icons` if we view icons as framework-level rather than studio-domain. Picking `studio-icons` for now.
2. **Whether to keep two separate packages** (`studio-icons` and `studio-markdown`) or fold them together as `studio-ui`. Two separate is cleaner per-concern; one combined cuts package count. Pick before scaffolding.
3. **Confirm Apache is the actual rewrite layer.** Studio's `.htaccess` exists and uses `RewriteRule`, so this is almost certainly the case, but worth confirming the production host runs Apache and not nginx/CDN edge rewriting.

## Suggested order of execution

1. **Rewrite `Manuals.ts` to use raw `IconSymbol` values** instead of `EffectFactories.X.defaultIcon` and `InstrumentFactories.X.defaultIcon`. Verify the in-studio manual nav still renders the same icons. This decouples manuals data from studio-core/studio-adapters and is a precondition for moving the file. Independent step.
2. **Strip `action://` from manual markdown sources.** Audit the `*.md` files for `action://open-preferences|backup-google-drive|backup-dropbox` and replace each with a regular link to `/preferences` or wherever. Drop the `actions?` param from `Markdown.tsx`'s API; the in-studio `ManualPage` no longer needs to pass handlers. `NotePadPanel` was never affected. Independent step.
3. **Create `packages/studio-icons/`** and move `IconLibrary.tsx`, `Icon.tsx`, plus their SASS, out of `packages/app/studio/src/ui/`. Update studio imports (`Surface.tsx:21`, all the device UI files, etc.). Verify studio still builds and looks identical. Do **not** add to `@opendaw/studio-sdk`'s `dependencies`.
4. **Create `packages/studio-markdown/`** and move `Markdown.tsx` + `Markdown.sass` out of `packages/app/studio/src/ui/`. Update `NotePadPanel.tsx:9,39` and `ManualPage.tsx:6,55` to import from there. Same SDK exclusion as `studio-icons`. Verify Project Info and the in-studio manual still render.
5. **Create `packages/manuals/`** and move `public/manuals/**` and `Manuals.ts` into it. Studio's vite config gets a temporary `vite-plugin-static-copy` step so it keeps serving `/manuals/*.md` until step 8.
6. **Scaffold `packages/app/manual/`** based on `packages/app/lab/`. Set `base: "/manuals/"` in vite config. Mount `<IconLibrary/>` at the root (per audit finding 2). Add the manual page (port from `ManualPage.tsx` with the studio-service dep removed and the back button gone). Depend on `studio-markdown` and `studio-icons`. Wire the static copy of the markdown. Get it serving locally with the same URL shape as the existing route. Adjust `Markdown.tsx` link rewriter to only SPA-route links whose pathname starts with `/manuals/` (per audit finding 4).
7. **Update the deploy config.** Add the `/manuals/*` rewrite rule to studio's `.htaccess` (or to the host config) **before** the generic SPA fallback. Add a separate `.htaccess` under the manual's deploy directory with its own SPA fallback for `/manuals/*` and the same Brotli/cache-header setup studio has. Deploy the manual bundle to `<docroot>/manuals/`. Test that `/manuals/audio-bus` loads the manual app and `/` still loads the studio.
8. **Remove the in-studio manual.** Delete `ManualPage.tsx`/`.sass`, `Manuals.ts` (now in `packages/manuals/`), the `/manuals/*` route from `App.tsx`, and `public/manuals/`. Drop the temporary `vite-plugin-static-copy` step from studio's config. Update the obsolete comment in studio's `.htaccess`. Studio keeps depending on `studio-markdown` for the Note Pad.
9. **Update in-studio links** to manuals: `ShadertoyPreview.tsx:28`, `devices/menu-items.ts:81`, `service/StudioMenu.ts:113`. Replace `LocalLink`/`RouteLocation.navigateTo` with regular `<a href="/manuals/...">` (optionally `target="_blank"`) so they trigger full navigation that the rewrite catches. `audio/AudioDevices.ts:67` already uses `window.open` and stays as is.
