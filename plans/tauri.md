# Tauri Desktop App

A thin native shell around the regular studio build. The shell holds no studio code. On launch it downloads the current web build (html, js, css, wasm, fonts, images) when none is installed or a newer one exists, then serves it locally and runs it fully offline. The shell updates itself through the Tauri updater. Cloud assets are off in phase 1. Phase 2 adds opt-in downloads of presets and WCLAP plugins. Uninstalling removes everything the app has written.

## Current facts (must integrate with)

- The studio build is Vite, output `packages/app/studio/dist/`, and every chunk is named `[name].{uuid}.[ext]` (`vite.config.ts`).
- CI builds use `base = /{main|dev}/releases/{uuid}/` and the root `.htaccess` rewrites to the current release (`deploy/run.ts`). `https://opendaw.studio/build-info.json` always resolves to the current release's `{date, uuid, env}`.
- `dist/` is 145 MB, but without `*.map` (61 MB) and `*.br` duplicates it is about 79 MB and roughly 330 files. That is what one install downloads.
- The studio aborts unless `crossOriginIsolated` is true (`main.ts:31`). It needs COOP/COEP on every response, SharedArrayBuffer, AudioWorklet, module workers, and OPFS (`boot.ts` OPFS probe).
- `boot.ts` polls `build-info.json` every 5 s for updates and runs a cache uuid guard plus an extensions check, but only when `env === "production" && !isLocalHost()`.
- WCLAP plugins run in a cross-origin frame (`VITE_WCLAP_ORIGIN`, `WclapWindows.tsx:25`) served by a service worker (`public/wclap-sw.js`).
- Cloud dependencies are `assets.opendaw.studio` (samples, soundfonts), `api.opendaw.studio` (lists, publish, wclap catalogue), Dropbox and Google Drive auth, `logs.opendaw.studio`, and the live rooms.
- All user data (projects, samples, presets, WCLAP bundles) lives in OPFS, which is keyed by origin.

## Architecture

```
openDAW.app / .exe / AppImage          (shell, Rust, ~10 MB, self-updating)
 └─ app-data/{identifier}/
     ├─ web/{uuid}/...                 (downloaded studio builds, current + previous)
     ├─ web/current                    (text file: active uuid)
     ├─ data/...                       (user content via the file storage strategy)
     ├─ store.json                     (key-value storage strategy)
     └─ webview/                       (webview caches and permissions)
```

1. The shell opens a window showing its own bundled splash page (no network needed).
2. The shell resolves the active build: read `web/current` and check online for a newer one (see Version flow).
3. The shell serves `web/{uuid}/` on a **stable origin** with COOP/COEP/CORP headers and correct MIME types (`application/wasm`, `text/javascript`).
4. The window navigates to that origin's `/index.html`.

### Serving: a stable origin
With the file storage strategy (see Platform strategies), user data lives in the shell's data dir, not in OPFS, so the origin no longer guards projects. A stable origin is still required for anything the webview itself keys by origin (permissions such as microphone). Every version is served at `/` of the same origin, and the build uuid is never part of the origin or the path.

Two options. The spike (phase 0) decides between them.

- **A: Tauri custom protocol** (`register_asynchronous_uri_scheme_protocol`, `opendaw://localhost` on macOS/Linux and `http://opendaw.localhost` on Windows). The origin is stable by construction and needs no port. Risks: WKWebView and WebKitGTK may not treat a custom scheme as a secure context, which means no SAB and no `crossOriginIsolated`.
- **B: Loopback HTTP server** on a fixed port (`http://127.0.0.1:<fixed>`, inside the shell via `tiny_http`/`axum`). `http://localhost` is a secure context in all three engines. Risk: the port can be taken. In that case the app must refuse to start with a clear message and must never fall back to another port, because a different port means a different origin and lost permissions. Bind to loopback only and require a per-launch token, so other local processes cannot read user data through the `/fs` endpoints.

My current lean is **B**, because workers reach the `/fs` endpoints over plain HTTP. WCLAP no longer needs a service worker or a second port (see WCLAP plugin windows), so A is viable if it passes the secure-context check. The spike decides.

## SDK consumer notes (to report when step 1 ships)

**Required action: none.**
- Every existing export keeps its signature and default behaviour.
- All new behaviour is opt-in.

**New, optional APIs**
- **`@opendaw/lib-dom` `Platform`:** `install(partial)` replaces host strategies:
  - `isDevelopment`;
  - `hasStorage` and `storage` (key-value store, default `localStorage`);
  - `saveFile`, `openFiles`, `canSaveStream` and `saveStream`;
  - `writeClipboardText` and `readClipboardText`;
  - `isFullscreenAvailable`, `requestFullscreen`, `fullscreenElement` and `exitFullscreen`;
  - `alert`, `reload` and `guardClose`. `guardClose` registers the unsaved-work guard; the browser default prompts on unsaved work or when offline.

  The defaults are the previous browser code, so nothing changes for consumers who don't call `install`.
- **`@opendaw/lib-dom` `Files.canSaveStream()` and `Files.saveStream(options)`:** stream a large export straight into a user-picked file. `Option.None` means the picker was cancelled or refused.
- **`@opendaw/studio-core` `Workers.installOpfs(protocol)`:** supplies an own `OpfsProtocol` implementation (file storage) instead of the OPFS worker.

**Behaviour notes, only relevant for consumers who use the new APIs**
- Call `Platform.install` before importing or using `lib-fusion` `Preferences`. `Preferences` checks once, at module load, whether storage exists (as it did before with `localStorage`).
- Call `Workers.installOpfs` before the first `Workers.Opfs` access. A later call throws, so storage cannot switch midway.
- `lib-dom` now exports a symbol named `Platform`. A consumer with its own `Platform` identifier imported in the same scope would need an alias.

**Internal, no effect on consumers**
- `Browser.isLocalHost()` is unchanged. The studio app now asks `Platform.isDevelopment()`, whose default is `Browser.isLocalHost()`.
- `Preferences`, `Browser.id()`, `Clipboard`, `Fullscreen`, `Files`, `ShortcutValidator` and the `lib-jsx` `Router` route through `Platform`, with identical defaults.

## Split: thin shell, desktop entry in the studio build

**Goal:** the Tauri app rarely needs an update. Studio releases, including menu and strategy changes, never require a new shell unless the shell contract changes.

**Shell (Rust): generic primitives only, no studio policy**
- Downloads, verifies and switches studio builds, with rollback.
- Serves them on loopback with COOP/COEP, plus `/fs` for the file storage strategy.
- Window primitives: linked popouts through `on_new_window`, URL routing to app windows or the system browser, WCLAP plugin windows and their message relay, close handling.
- File dialogs and writable file handles.
- `setMenu(description)`: builds the native menu from a serialisable description received over IPC, and sends back the id of the clicked item.
- Key-value store, single instance, file associations and deep links (forwarded to the page), self-update.
- Exposes `SHELL_API`, an integer that is bumped only when a primitive is added or changed.

**Desktop entry: in `packages/app/studio`, downloaded with every studio build**
- `index-desktop.html` plus `src/main-desktop.ts` is a second Vite entry, built only by `build:desktop`.
  - It runs first: it installs the `Platform` strategies (storage, files, catalogue, lifecycle and so on, under `src/platform/desktop/`), builds `DesktopStudioMenu` and sends it to the shell, subscribes to menu clicks, and only then calls the shared `boot()`.
  - The strategies must be installed before `boot.ts` evaluates, because its unload-guard check reads storage at module load.
- The web `index.html` and `main.ts` never import anything from `src/platform/desktop/` or `main-desktop.ts`, so the web bundle and its behaviour are unchanged.
- `build-info.json` of the desktop build carries `shellApi`. If it is above the running shell's `SHELL_API`, the shell keeps the installed build and updates itself first.

**Rule of thumb:** if a desktop change can be expressed with existing primitives, it ships with the studio build. Only a new primitive costs a shell release.

## Version flow (web build)

### Build side
- Add a Tauri variant of the studio build: `npm run build:tauri` with `base = "/"` and `VITE_TARGET=tauri`. Same sources, same uuid naming.
- The build writes `manifest.json` into the release with `{uuid, date, shellApi, files: [{path, size, sha256}]}`. It excludes `*.map` and `*.br`.
- `BuildInfo` gains `shellApi: number`, the minimum shell API the build needs.
- CI uploads the variant to `/tauri/releases/{uuid}/` and updates a stable pointer `https://opendaw.studio/tauri/build-info.json` (same `.htaccess` mechanism as `main`/`dev`). The browser deploy is unchanged.
- **For now DEV only** (2026-10-16): desktop work deploys to `dev.opendaw.studio`, PROD stays untouched.
  - `deploy.yml` builds the desktop variant whenever the deploy targets DEV (`to_dev` or a branch other than `main`).
  - `deploy/run.ts` then uploads `dist-desktop` to `/dev/tauri/releases/{uuid}/`, and writes `/dev/tauri/build-info.json` last (no-cache via `/dev/tauri/.htaccess`), so the pointer never names a partial release. `deployDesktop` refuses the main environment.
  - The root `.htaccess` routes `https://dev.opendaw.studio/tauri/…` to `/dev/tauri/…`. PROD routing is unchanged.
  - The web deploy now reads its uuid from `dist/build-info.json`, because `public/build-info.json` is rewritten by the desktop build.
  - Shell URLs: `https://dev.opendaw.studio/tauri/build-info.json` and `https://dev.opendaw.studio/tauri/releases/{uuid}/manifest.json`.
  - Old desktop releases are not pruned yet.

### Shell side, at every launch
1. Fetch `tauri/build-info.json` with a short timeout (about 3 s).
2. **Nothing installed and offline**: show "first launch needs internet" and offer Retry.
3. **Installed and (offline or same uuid)**: launch the installed build.
4. **Newer uuid**:
   - If `shellApi > SHELL_API`, keep the installed build, and the shell update (below) must happen first.
   - Otherwise download `manifest.json` into `web/{uuid}.partial/`. Files whose sha256 already exists in the current build are copied locally (fonts, images, unchanged wasm devices), and only the rest are fetched. Every file is verified by size and hash. Then rename to `web/{uuid}/`, write `web/current` atomically, and delete every build except current and previous.
   - The splash shows progress. When a build is already installed, a "Skip Update" button stops the download and starts the installed build; the download resumes on the next launch.
5. A failed or interrupted download leaves `.partial` behind and it is retried or wiped on the next launch. The active build is never touched before the switch.
6. If the new build fails to boot (no ready signal within N seconds), roll back to the previous build and mark the failed uuid as bad.

### Shell side, progress (2026-10-16, `src/update.rs`, uncommitted)
- Done: steps 1 to 6 above.
  - Builds live in `<app data>/web/{uuid}/` (macOS `~/Library/Application Support/studio.opendaw/web`). Next to them are `current`, `previous` (written atomically), `pending` and `bad`.
  - The download goes to `{uuid}.partial/`. Each file is verified by size and sha256. A partial file left by an earlier attempt that verifies is kept, and a file whose sha256 exists in the current build is copied locally. On success the folder is renamed, `current` and `previous` are switched and every other build is deleted.
  - Boot signal: the studio's first `/__shell/guard` call clears `pending`. If `pending` is still set at the next launch, or 90 s after a switch in the same session, the build goes on `bad` and `previous` becomes current again. A bad uuid is never downloaded again.
  - The dummy splash (`/__splash`) shows progress, "Skip Update" while downloading over an installed build, and Retry when offline on first launch or after an error. The main window opens on the splash and moves to `/` once a build is chosen. Until then the studio paths answer 503.
  - Development: `OPENDAW_DIST`, or a debug build without `OPENDAW_UPDATE`, serves the local `dist-desktop` and skips all of this, so `npm run desktop` is unchanged.
  - Tested locally against a fake origin (`OPENDAW_UPDATE_ORIGIN=http://127.0.0.1:8099 OPENDAW_UPDATE=1`): first install (221 files, 82 MB), update with one changed file (only that file fetched), rollback after a failed boot, offline first launch.
  - Compressed downloads (2026-10-16): the shell asks for brotli (ureq `brotli` feature), the release folder's `.htaccess` answers with the `.br` file, and size and sha256 are checked on the decoded bytes. The manifest records each file's `download` size (the `.br` where one exists; the manifest waits for the compression plugin, both run in `closeBundle`), and the splash and the log count those. Measured against a local brotli server: 51.1 MB of files, 33.2 MB downloaded (154 files compressed). 27 MB of that is the ONNX runtime, which has no `.br`; without it the studio download is 6.2 MB.
  - Open: a real splash design, the periodic recheck and "Update available, restart?" while running, pruning old releases on the server.

### Optional components (2026-10-16, built, app-untested)
- The desktop build copies FFmpeg (`ffmpeg/`, @ffmpeg/core 0.12.6 fetched once from the mirror into `.cache`, pinned by sha256, its wasm brotli'd once), the manual app (`manuals/`) and the scripting docs (`docs/scripting/`) into `dist-desktop`. The manifest tags those files and the ONNX runtime with a component (`ffmpeg`, `manuals`, `docs`, `neural`) and lists the components with label, description and default selection.
- Download sizes: core 6.2 MB, FFmpeg 6.9, manuals 2.8, docs 2.6, Neural Demux runtime 27 MB plus about 566 MB of models (two stem models 250 and 304 MB, tempo 11.7 MB, pitch 0.2 MB).
- First launch: the splash lists the components (everything selected except Neural Demux) with sizes and a total; Install downloads the core and the selected ones (18.5 MB by default, verified against a local brotli server). Selected components come with every update; the others are offered on first use (`ComponentHost.ensure`, `installFFmpegSource`, `installInferenceHost`, and a click interceptor for links into `/manuals/` and `/docs/`), offline the user is told the download needs internet.
- Neural Demux: the runtime comes with the build, the models are downloaded by the shell from their URLs into `<app data>/components/neural` (sha256 checked, kept across updates) and handed to the studio through `InferenceConfig.modelSource`/`modelHosted`; chosen in the installer, they download once the studio runs (the studio has the model list, `Inference.taskKeys()`).
- The shell serves folder index pages and extensionless `.html` pages for the manuals and docs.

### Optional component: Neural Demux (2026-10-16, superseded by the section above)
- The user decides at installation whether Neural Demux is installed: the ONNX runtime (27 MB) plus the models (stems 250 MB, tempo 304 MB). The first-launch splash shows the choice with the size, and Preferences can change it later. We pick no default for them.
- The desktop manifest marks those files as `component: "neural"`. The core download skips them unless the component is chosen. A chosen component is kept up to date with every studio update.
- Not installed and used: online, the shell downloads it on demand with progress. Offline, a dialog says Neural Demux needs an internet connection to download its components.
- The models are cached in OPFS by the web side today (`inference/models/`), which the shell cannot write. A shell-installed model must be served by the shell (e.g. `/__components/models/...`) and the studio's model loader must look there first.
- Size: the ONNX runtime wasm shipped twice (the `/spike-test` research page imported it on the main thread). The page is deleted, the build went from 78.5 MB to 51.1 MB and the inference worker keeps the one copy (27 MB). Downloading the existing `.br` files would roughly halve the JS.
- The browser is unchanged.

### Web side (`VITE_TARGET === "tauri"`)
- The 5 s `build-info.json` poll, the cache guard and the extensions check are skipped. The shell owns updates.
- The shell exposes a small IPC surface with `shellVersion`, `shellApi`, `checkForUpdates()`, and `restart()`. The studio uses it for an "Update available, restart?" message during long sessions, so the shell can recheck periodically while the studio is running.
- Online features stay (see Audit D). While offline, `OpenSampleAPI`/`OpenSoundfontAPI` lookups fail fast with "not available offline" instead of hanging. A project referencing a cloud sample that is not stored locally loads with that sample marked missing, which is the existing missing-sample path.
- Error reporting to `logs.opendaw.studio` stays when online (needs your decision, see open questions).

## Platform strategies

Every feature that talks to the browser goes through a strategy interface. The browser build keeps today's code as its strategy, so its behaviour stays bit-identical. The Tauri build plugs in native implementations. Nothing outside the strategy layer may touch these browser APIs directly or check `VITE_TARGET`.

- **Where it lives:** a `Platform` namespace in `@opendaw/lib-dom` with an `install(strategies)` call once at boot (`main.ts`). The browser strategies are the default, so tests and other apps (`app/manual`) need no setup. The Tauri strategies live in the studio under `src/platform/tauri/` and talk to the shell via `@tauri-apps/api` IPC.
- **Selection:** at build time via `VITE_TARGET`, so the browser bundle contains no Tauri code.

### Progress (step 1, browser-only, on `main`, uncommitted)
- Done: `Platform` in `lib-dom` (`platform.ts`, `platform.test.ts`).
  - `Platform.isDevelopment()` replaces all 11 `Browser.isLocalHost()` call sites.
  - `Platform.storage()` and `hasStorage()` replace every `localStorage` access: `Preferences`, `Browser.id`, boot, shortcuts, access key, room awareness, Tone3000, Nextcloud, Tubular audition, and the manual app.
  - Browser defaults are the previous code. All suites stay green: lib-dom, lib-fusion, studio-core, app-studio, app-manual.
- Done: catalogue slice. `OpenDAWCloud` in the app's `opendaw-api` folder is enabled by default. Once disabled, the sample, soundfont, preset and WebCLAP indexes are empty at once, and remote loads fail fast (`OpenDAWCloud.test.ts`, 7 tests). `FactoryCatalog` and the SDK are untouched.
- Done: minimal desktop entry.
  - `vite build --mode desktop` (`npm run build:desktop`) builds the same `index.html` into `dist-desktop/`, with the entry swapped to `src/main-desktop.ts` by a `pre` `transformIndexHtml` hook.
  - The body of `main.ts` moved unchanged into `start()` (`src/start.ts`). The web `main.ts` calls `start()`; `main-desktop.ts` calls `OpenDAWCloud.disable()` first, then `start()`.
  - The order is explicit, because Rollup merges both entries' modules into one chunk.
  - Verified in the shell: zero `assets.opendaw.studio` requests.
- Done: files slice.
  - Platform strategies `saveFile`, `openFiles`, `canSaveStream` and `saveStream`. The browser defaults are the former `Files` code, moved unchanged into the internal `files-browser.ts` (verified identical).
  - `Files` keeps every export and signature, and gains `canSaveStream()` and `saveStream()`. The re-entry guard applies to every strategy.
  - Video export uses the stream seam instead of `window.showSaveFilePicker`, with the same semantics.
  - SyncLog (debug menu) stays browser-only: it relies on handle permissions and append seeks, and it is already disabled where the picker API is missing.
  - 6 new tests.
- Done: clipboard and fullscreen slice.
  - New strategies: `writeClipboardText`, `readClipboardText`, `isFullscreenAvailable`, `requestFullscreen`, `fullscreenElement` and `exitFullscreen`.
  - Browser defaults are the exact former calls.
  - `Clipboard` and `Fullscreen` keep the dialogs and the synchronous-throw guard.
  - The two diagnostic pages no longer call `navigator.clipboard` directly.
  - 3 new tests.
- Done: file storage seam.
  - `studio-core` `Workers.installOpfs(protocol)` is an additive SDK API. Without it, `Workers.Opfs` is the OPFS worker as before; installing after first use is refused.
  - `StorageInspector` has app-level strategies (`scan`, `folderSize`, `estimate`), with the old code as default. `StoragePage` no longer calls `navigator.storage.estimate()` directly.
  - Kept as is: `features.ts` (the webviews provide OPFS and IndexedDB) and the Firefox-only persist dialog.
  - 5 new tests.
- Done: lifecycle slice.
  - New strategies `alert`, `reload` and `guardClose(hasUnsavedWork)`.
    - The browser `guardClose` is the former `beforeunload` listener, including the offline rule.
    - `StudioService` passes only its unsaved-changes predicate.
  - All 5 `alert()` and 4 `location.reload()` sites are routed, including `lib-jsx` `Router` and `lib-dom` `ShortcutValidator`.
  - The update poll needs no seam: on desktop it reads the installed build's own `build-info.json`, so it never fires.
  - Note: `ShortcutValidator` runs at module load, before a desktop entry installs strategies, so its alert stays the browser one. This is a dev-only conflict check.
  - 4 new tests.
- **Step 1 complete.** Committed as `43bc963d6` on `tauri-desktop-app`.
- Step 2 started: the spike moved to `packages/app/desktop/`.
  - It contains a Cargo crate `opendaw`, `tauri.conf.json`, the icons, `src/main.rs` (loopback server, linked popouts with close handling) and `src/wclap.rs` with `wclap-frame-desktop.html`.
  - Probes and the custom-protocol mode are dropped.
  - It serves `../studio/dist-desktop` by default; `OPENDAW_DIST` overrides it.
  - It deliberately has **no `package.json`** yet. The root workspace glob `packages/**/*` would make it an npm workspace, which changes the lockfile and pulls it into turbo builds and lerna.
- Manifest done: `build:desktop` writes `dist-desktop/manifest.json` with `{uuid, date, shellApi, files: [{path, size, sha256}]}`.
  - It excludes `*.map`, `*.br` and dotfiles (`.htaccess`, `.DS_Store`). That leaves about 220 files and 82 MB.
  - `BuildInfo` gains an optional `shellApi`. Only the desktop build writes it, so the web `build-info.json` is unchanged.
  - The minimum shell API is `DESKTOP_SHELL_API = 1` in `vite.config.ts`.
- The shell has `SHELL_API = 1` in `main.rs`. At launch it reads `shellApi` from the served `build-info.json` and logs when the build needs a newer shell. It still launches that build, since there is no installed-build switch yet.
- Root scripts: `npm run build:desktop` and `npm run desktop` (`cargo run` of the shell).
- Desktop files strategy (browser-unverified): `src/platform/desktop/DesktopFiles.ts`, installed by `main-desktop.ts`, implements `saveFile`, `openFiles`, `canSaveStream` and `saveStream`.
  - Transport is the loopback server, not Tauri IPC: `POST /__shell/{save,open,read,stream,write,seek,truncate,close,abort}` in `src/files.rs`. It needs no remote-URL capability, streams large bodies and also works from workers.
  - Every call carries `X-Shell-Token`, a random token the shell injects into the main window as `window.__OPENDAW_SHELL__ = {token, api}`. Other origins cannot read it.
  - Dialogs come from `tauri-plugin-dialog` and are parented to the main window. A cancelled save or open rejects with `AbortError`, as in the browser. A cancelled stream save returns `Option.None`.
  - The stream accepts mediabunny's `{type: "write", data, position}` chunks, plus seek and truncate. Abort deletes the partial file.
  - Only files the user picked can be read, each once, by id.
- Native menu bar (browser-unverified): `DesktopStudioMenu.ts` (next to `StudioMenu.ts`) defines the layout: openDAW, File, Edit, View, Tools, Window, Help, built from `MenuItem` plus native roles.
  - `platform/desktop/DesktopMenu.ts` turns it into a description and posts it to `/__shell/menu`. `src/menu.rs` builds the Tauri menu. Clicks come back via `window.__OPENDAW_SHELL__.menu(id)`.
  - The bar is rebuilt after every click and on every project profile change, which keeps enabled and checked state current. Toggling the MIDI keyboard by shortcut leaves the check stale until the next rebuild.
  - `NativeMenu` (`src/service/NativeMenu.ts`, web-safe) is the hook. `boot.ts` attaches it after the service exists, and `Header.tsx` hides the in-page menu button while it is active. In the browser it is never installed.
  - Neural Demux moved from Import to Tools.
  - Measured 2026-10-15 (macOS): WKWebView gives a Cmd key to the page first. Cmd+M toggles the metronome despite Minimize, Cmd+A selects regions, Cmd+C/V copy regions. A menu accelerator only fires where the page leaves the key alone.
  - So studio items show their shortcut as a native accelerator (`DesktopStudioMenu.shortcuts`): Preferences, Open, Save, Save As, Show MIDI-Keyboard. Only Cmd/Ctrl shortcuts qualify, so plain-key shortcuts (Shift+digit screens) never take keys away from text fields. Undo and Redo carry none, so Cmd+Z stays with text fields. Custom shortcuts show after the next menu rebuild.
  - On macOS the webview has no reload, zoom or find accelerators of its own. Turning them off is a WebView2 (Windows) task.
- Close guard (browser-unverified): `platform/desktop/DesktopLifecycle.ts` implements `guardClose`. It registers `window.__OPENDAW_SHELL__.close` and calls `/__shell/guard`.
  - Quit (`Cmd+Q`, now a custom menu item) and closing the main window go to `request_quit` in the shell. Once guarded, the shell asks the page, which quits through `/__shell/quit` directly or after an in-app "Quit anyway?" dialog when the project has unsaved changes. Before the page is guarded, the shell quits at once.
  - The "Quit anyway?" question and `alert` are native message dialogs (`/__shell/confirm`, `/__shell/alert`), so plugin windows never cover them. macOS: unparented app-modal alert (a sheet would sit below the floating plugin windows). Windows and Linux: owned by the main window like the plugin windows, the active dialog comes first (uncompiled: `cargo check --target x86_64-pc-windows-msvc` needs `llvm-rc`, untested until the machines arrive).
  - Open: Dock "Quit" and logout go through `NSApp terminate:` and bypass the guard. A frozen page cannot answer, so only Force Quit ends the app.
- Alerts (browser-unverified): wry implements no `runJavaScriptAlertPanel`, so `window.alert` did nothing on macOS. `DesktopLifecycle` installs `alert`, which posts the message to `/__shell/alert` for a native message dialog. The `ShortcutValidator` conflict alert runs at module load, before strategies install, and stays silent on desktop (dev-only check). `location.reload()` works as is in the webview. It becomes a shell restart with the update flow.
- Window title (browser-unverified): `platform/desktop/DesktopTitle.ts` sets the main window title to the project name ("openDAW" without a project, "Untitled" for an empty name) via `/__shell/title`.
  - Unsaved changes show as the macOS `documentEdited` dot (`objc2-app-kit`, already in the tree), and as a trailing `*` on Windows and Linux.
  - Unsaved state has no notification, so it is sampled every 500 ms and sent only on change. A notification in `Editing` would avoid that but changes SDK behaviour.
  - `NativeMenu.install` in `main-desktop.ts` now attaches both the menu and the title.
- WCLAP windows (browser-unverified), option B: `main-desktop.ts` calls `WclapWindows.openAsPopout()`, so the plugin `FloatingWindow` is created with `popoutOnly`.
  - `popoutOnly` (web never sets it): no in-page phase, no popout toggle, closing the popout closes the window, a failed popout closes too. `Surface.new` gains `utility`, which opens `popout.html?utility`.
  - The shell opens `?utility` popouts without decorations and in front of the studio, as plugin windows in other DAWs: on macOS at floating level with `hidesOnDeactivate` (they vanish while another app is active), on Windows and Linux owned by the main window (that branch is not compiled yet, no Windows target installed). Every popout accepts the first click (`accept_first_mouse`), so a dial in an unfocused plugin window turns on the first click. Utility windows are never user-resizable (macOS cannot exclude single edges, and the top must stay free for dragging). Zoom still resizes them through `resizeBy`. A future resizable popout-only window would need FloatingWindow's right, bottom and corner grips shown in popout mode, routed through `resizeBy`. Its popout script now also routes `window.resizeBy` to `/__resize` and pointerdown on `[data-window-drag]` (the popout-only header) to `/__drag` (`start_dragging`).
  - The desktop build defines `VITE_WCLAP_ORIGIN = http://127.0.0.1:47111` and `VITE_WCLAP_FRAME_QUERY = ?host=shell`. With `host=shell`, `wclap-frame.html` uploads the bundle to `/__wclap/file` instead of registering the service worker, and releases it on `pagehide`.
  - The plugin port serves only `wclap-frame.html`, the uploads and `/wclap/{uuid}/…`. The studio port no longer handles `/__wclap`. The earlier relay (`open`, `send`, `poll`, `close`, injected bridge, `DesktopWclap.ts`, `WclapNativeWindows.ts`) is removed.
  - Resize, context menu, double-click entry, keys, wheel and zoom go through the unchanged browser code.

### Strategies and their current call sites

1. **Windows** (popouts, auth popups, WCLAP plugin windows). **No web-side strategy:** every `window.open` and `target="_blank"` reaches the shell's `on_new_window` handler, which routes by URL (same-origin `popout.html` gets a linked window, manuals and docs get an app window, the rest goes to the system browser). The bullets below describe the routing.
   - Browser: `window.open`.
   - Tauri: popouts are real native windows that stay scriptable by the opener (see Popout windows below). Auth popups and other URLs follow the external-link rule.
   - Sites: `Surface.tsx` popouts, `FloatingWindow.tsx:256` (pop out), `WclapWindows.tsx`, `CloudAuthManager.ts:86,177`, `NamTone3000.ts:145`.
   - `PanelPlaceholder.tsx:141` currently hides "Popout" when `Browser.isTauriApp()`. That gate goes once popouts work.
   - WCLAP plugin GUIs are not popouts. They get their own OS windows, see below.
2. **External links** (manuals, docs, GitHub, sponsors, credits). **No web-side strategy** either: routed by the same `on_new_window` handler.
   - Browser: `window.open(url, "_blank")` and `<a target="_blank">`.
   - Tauri: the system browser via `tauri-plugin-opener`. In-app paths (`/docs/scripting/`, manuals) open in a Tauri window when bundled, otherwise go to the online URL.
   - Sites: `manuals.ts`, `dialogs.tsx:375`, `CodeEditorPage.tsx:321`, `WclapDeviceEditor.tsx:75`, plus every `target="_blank"` anchor in `ui/dashboard/*`, `WclapBrowser.tsx` and `DashboardPage.tsx`, which become a shared `ExternalLink` component.
3. **Files** (open, save, download)
   - Browser: `Files.save`/`Files.open` in `lib/dom/src/files.ts` (File System Access API with the anchor-download fallback).
   - Tauri: native dialogs via `tauri-plugin-dialog` plus a write through the shell. This also fixes WebKit, which has no `showSaveFilePicker`. The direct `window.showSaveFilePicker` uses in `VideoRenderer.ts`, `VideoExportDialog.tsx`, `SyncLogService.ts` and `DebugMenu.ts` move behind `Files` first.
4. **Key-value storage** (preferences and small state)
   - Browser: `localStorage`.
   - Tauri: a JSON store in the shell's app-data dir (`tauri-plugin-store`), read synchronously from a snapshot injected at boot and written asynchronously.
   - Sites: `Preferences.ts` and the other `localStorage` users (`StudioShortcutManager`, `RoomAwareness`, `AccessKey`, `NextcloudDialogs`, `TubularAudition`, `WasmEngine`, `polyfill.ts`, `boot.ts`).
5. **File storage** (projects, samples, presets, WCLAP bundles)
   - Browser: OPFS through `OpfsProtocol` (`lib/fusion/src/opfs/`). All 25 consumers already go through `Workers.Opfs`, so this is one seam.
   - Tauri: an `OpfsProtocol` implementation backed by a directory under the shell's app-data dir. IPC is not available inside workers, so the implementation calls the shell's loopback server (`/fs/*` endpoints, token-guarded, paths confined to the data root). This is another reason to prefer serving option B.
   - Result: user data no longer depends on the webview origin, which removes the "origin change loses projects" risk, and uninstall cleanup becomes one known directory.
   - `StorageInspector.ts` and `storage-worker.ts` call `navigator.storage.getDirectory()` directly and move onto the protocol.
6. **Fullscreen, clipboard and lifecycle**
   - Fullscreen: `lib/dom/src/fullscreen.ts`. The Tauri strategy uses the native window fullscreen.
   - Clipboard: `lib/dom/src/clipboard.ts`. The Tauri strategy uses `tauri-plugin-clipboard-manager` (WebKit restricts async clipboard reads).
   - Lifecycle: today `beforeunload` (4 sites). The Tauri strategy uses the shell's window close-requested event, so unsaved-changes prompts work with the native close button.
   - Persistence: `navigator.storage.persist` is a no-op on Tauri.
7. **Unchanged (no strategy):** Web Audio, `getUserMedia`, `setSinkId`, Web MIDI and `BroadcastChannel`. The webview provides these, and the spike verifies them (`setSinkId` and Web MIDI are missing in WebKit, so that is a gap on macOS and Linux, not a strategy).

### Popout windows
In-window DOM windows are not an option, so every popout must be a native window.

**How popouts work today (`Surface.tsx:192-345`)**
- `window.open(popout.html)` returns a `WindowProxy` in the same realm. The opener then does all of the following directly:
  - polls `owner.document.readyState`;
  - clones `<head>` and snapshots `adoptedStyleSheets` into `<style>`;
  - creates every DOM node with the opener's `document` (`lib/jsx` `createElement`) and appends it into the popout (cross-document adoption);
  - attaches pointer, key, wheel, contextmenu, beforeunload and visibilitychange listeners on the popout `Window`;
  - hands the single `AnimationFrame` driver between windows.
- There is no `postMessage` at all. The popout is a second view of one JS realm, not a second app.

**Primary strategy: opener-linked native windows**
- All three engines can create a new native window whose webview is *related* to the opener, so `window.open` returns a live, scriptable `WindowProxy`:
  - WKWebView: `WKUIDelegate createWebViewWith` with the passed configuration.
  - WebView2: `NewWindowRequested` with `put_NewWindow`.
  - WebKitGTK: the `create` signal returning a related view.
- This is how Safari, Edge and Epiphany implement `window.open`. Tauri 2 exposes it through the new-window handler on the webview builder (`on_new_window`, creating the window from the request's features so the opener link survives).
- The shell intercepts the request:
  - same-origin `popout.html`: creates an opener-linked native window, applies native chrome (title, min size), and persists its frame per panel id;
  - any other URL: hands it to the system browser.
- `Surface` then runs unchanged. It is one realm and one process, so it also shares the `SharedArrayBuffer`s and the engine.
- Shell duties for these windows:
  - disable background throttling (Tauri `backgroundThrottling`), so the `AnimationFrame` driver and meters keep running when the main window is occluded;
  - forward native close to `beforeunload` so `Surface` cleans up;
  - add the popouts to the native Window menu.
- This is go/no-go item 1 of the spike, per platform.

**Fallback if one platform cannot relate windows: one project, several realms**
- Each native window boots its own studio UI realm, which binds to the main window's project through the existing sync machinery: the box graph sync already used for live rooms, plus the engine attachment.
- Each window becomes a full client of the same project, not a remote DOM.
- This is much more work than the primary strategy, and it is only worth it if a platform fails the spike.

### WCLAP plugin windows
- **The rule (revised 2026-10-15):** every WCLAP plugin GUI opens in its own OS window and is never part of the studio page. That window is a popout-only `FloatingWindow` (frameless, its header is the thin title bar) with the plugin in `wclap-frame.html` on the plugin-only origin.
- **Serving and isolation**
  - The shell serves the plugin's bundle files straight from the data dir on a plugin-only origin (`wclap://<sha256>/…`, or the plugin port when serving option B is used).
  - Bundles are content-addressed, so each plugin gets its own origin and is isolated from the studio and from other plugins.
  - `wclap-sw.js` and the second-origin deploy (`VITE_WCLAP_ORIGIN`) are not needed on desktop.
- **Messaging**
  - Today the frame and studio talk over a `MessagePort`: `wclap-open`, `wclap-message`, `wclap-key`, `wclap-contextmenu`, `wclap-wheel`, `wclap-dblclick`, `wclap-pointer-enable`, `wclap-error`.
  - Desktop keeps the same message set over a shell-routed channel: plugin window ↔ shell ↔ studio main window ↔ engine. With the native engine it becomes plugin window ↔ shell ↔ engine.
  - The plugin page gets a small injected bridge script that exposes the same API the frame provides today, so plugin code is unchanged.
- **Window duties**
  - Size comes from the plugin.
  - The title is the device name. The window is a child of the main window: it stays on top of it and minimises with it.
  - Frames are persisted per device.
  - The window closes when the device is deleted or the project closes.
- **Keys and menus**
  - Keys the plugin does not consume (transport, undo, save) are forwarded as today.
  - `wclap-contextmenu` opens a *native* context menu built from the studio's menu items over IPC, because the studio DOM is not in that window.
- **Cost:** a small layer between `WclapWindows.tsx` and the shell. The browser path stays as is.

### Sample storage on OS file paths (later phase)
- Samples are no longer copied into internal storage. A sample references its original OS file path, and only `meta.json` and `peaks.bin` stay in the data dir.
- This builds on the file storage strategy: `SampleStorage` gains a sample source that is either "stored" (today) or "linked" (Tauri: an absolute path plus size and modified-time fingerprint). The audio is read via the shell's `/fs` endpoint with an allow-list of linked paths.
- Missing or changed files go through the existing missing-sample path, with a "Locate…" action that re-links by path. Sample folders the user picks can be watched by the shell (`notify` crate) to pick up new files.
- Projects store the link, so a project moved to another machine needs a "collect samples" export (copy linked files into a bundle). `.odb` bundles already do this.
- Interaction with `plans/local-folders.md`: linked samples appear in the same local folder tree.

## Shell self-update

- Use `tauri-plugin-updater` with a minisign key pair (private key as a CI secret). The endpoint is `https://opendaw.studio/tauri/latest.json` (or GitHub Releases).
- The shell checks at launch (before the web version check) and while running. It downloads in the background and asks "Restart to update" before installing.
- Per platform:
  - **macOS**: the `.app` is replaced in place. Requires an Apple Developer ID for signing and notarization, otherwise Gatekeeper blocks the app and updates.
  - **Windows**: an NSIS installer, updated via the updater. An Authenticode certificate is strongly advised (SmartScreen).
  - **Linux**: AppImage supports the updater, `.deb` does not. A Flatpak would be updated by Flathub instead.
- `SHELL_API` is bumped only when the IPC surface or the serving contract changes. Most studio releases never need a new shell.

### Two versions, two deploys (2026-10-16)
- **Studio build for desktop** (`dist-desktop`): versioned by its build uuid in `tauri/build-info.json`. It changes with every studio change, ships with the regular studio deploy (DEV only for now), and the installed shell fetches and switches to it at launch (Phase 3). Users never download it.
- **Shell** (the Tauri app): versioned by `version` in `tauri.conf.json` and the updater's `latest.json`. It changes rarely, only with native code. Its own workflow `desktop.yml` runs on a tag `desktop-v*` (macOS, Windows, Linux), never on a studio deploy. It updates through the Tauri updater, independently of the studio.
- `shellApi` links them: a studio build needing a newer shell waits until the shell has updated.
- **Download:** the tag workflow publishes a GitHub Release. A `/download` subpage on opendaw.studio offers macOS, Windows and Linux, linking each to the latest release asset (detected platform first).
  - The page explains the size: the installer is only the shell, small because it uses the system webview (WebKit on macOS and Linux, WebView2 on Windows) instead of bundling a browser. On first launch the shell downloads the studio itself (about 82 MB today, the same files as the web app) and keeps it for offline use. Later updates fetch only changed files. The native engine phase adds embedded V8 (about 30 MB) to the installer.
  - Exact numbers are measured from the release artifacts and the manifest when the page is written.
  - Done (2026-10-16, uncommitted): `DownloadPage.tsx` at `/download`, macOS only, Windows and Linux "Coming soon". It links `https://github.com/andremichelle/openDAW/releases/latest/download/openDAW-macos.dmg`, so the release workflow must publish that asset name (404 until the first release). Sizes on the page: app about 40 MB since the native engine is bundled (universal dmg, 20 MB for one architecture), studio about 51 MB, Neural Demux models about 580 MB. It explains the first launch (studio download, then the question about the models) and the "Open Anyway" step while the app is not notarized.
  - Done: `.github/workflows/desktop.yml`. A tag `desktop-v<version>` (must equal the `tauri.conf.json` version) builds the universal dmg on `macos-latest` with `cargo tauri build --target universal-apple-darwin --bundles dmg`, renames it `openDAW-macos.dmg` and publishes it with `gh release create --latest`. A manual run only builds and keeps the dmg as a workflow artifact. `OPENDAW_UPDATE_ORIGIN` is DEV in the workflow for now. Unsigned (open question 1). The existing SDK releases are pre-releases, so they never take `latest`, and that must stay so for the page link.
  - Release builds all three platforms (2026-10-16): `desktop.yml` is a matrix of macOS (`macos-latest`; since 2026-10-16 two builds instead of one universal: `aarch64-apple-darwin` as `openDAW-macos-arm64.dmg` and `x86_64-apple-darwin` as `openDAW-macos-intel.dmg`, about 20 MB each instead of 40, a step fails the build unless every binary has exactly its architecture; the page offers Apple Silicon first and Intel as a link, browsers cannot tell the two apart), Windows (`windows-latest`, NSIS installer for `x86_64-pc-windows-msvc`) and Linux (`ubuntu-22.04`, AppImage and deb, with the webkit2gtk, ALSA and D-Bus dev packages). A final job publishes `openDAW-macos-arm64.dmg`, `openDAW-macos-intel.dmg`, `openDAW-windows-setup.exe`, `openDAW-linux.AppImage` and `openDAW-linux.deb` in one release. The sidecar script runs through `bash` (present on all runners). Windows and Linux have never been compiled: run the workflow manually once (artifacts only) before the first tag. The download page links all four files (redesigned: centred platform cards with Simple Icons glyphs, the three explanations in three columns that collapse to one below 60em).
  - The engine picks a fixed buffer only within the device's supported range, otherwise the device default (WASAPI shared mode often refuses fixed sizes).
  - The question about the models is the optional Neural Demux component, not built yet. Once the ONNX runtime moves into that component, the studio download drops to about 24 MB and the page text follows.
- **Update origin:** `UPDATE_ORIGIN` in `main.rs` (done) is the server the shell checks, `<origin>/tauri/build-info.json`. It defaults to `https://dev.opendaw.studio`. The release build sets `OPENDAW_UPDATE_ORIGIN=https://opendaw.studio` at compile time, no code edit. The updater's `latest.json` follows the same origin.
- **Public release:** PROD then needs the same `/tauri/` deploy as DEV (today `deployDesktop` refuses the main environment).

## Uninstall: delete everything

All app-written files must sit under the shell's own identifier directories: downloaded builds in `app_local_data_dir/web`, user data (the file storage strategy) in `app_local_data_dir/data`, key-value storage in `app_local_data_dir/store.json`, and the webview's own data dir set explicitly to a subfolder of the same root. Linked samples (later phase) are the user's own files and are never deleted.

- **Windows (NSIS)**: an `NSIS_HOOK_POSTUNINSTALL` hook deletes `%LOCALAPPDATA%\{id}` and `%APPDATA%\{id}` (including WebView2 `EBWebView`) unconditionally, not via the optional "delete app data" checkbox. Ship NSIS only, no MSI.
- **macOS**: no uninstall event exists. Dragging the `.app` to the Trash leaves `~/Library/Application Support/{id}`, `~/Library/WebKit/{id}`, `~/Library/Caches/{id}` and `~/Library/HTTPStorages/{id}` behind. This cannot be fully automatic. Mitigation: an in-app "Uninstall openDAW…" menu item that wipes those paths and moves the bundle to the Trash, documented as the way to uninstall.
- **Linux**: a `.deb` `postrm` runs as root and does not know which user homes to clean. AppImage has no uninstall at all. **Flatpak** solves this (`flatpak uninstall --delete-data` removes `~/.var/app/{id}`). Recommendation: Flatpak plus AppImage, with the same in-app uninstall item for AppImage.

**Warning:** the data dir holds the user's projects and samples. Deleting everything means projects are lost unless they were exported. The in-app uninstall offers "Export all projects first". The Windows uninstaller shows a warning page before deleting.

## Phase 2: offline content downloads

- A settings page "Offline Content" in the studio (Tauri target only) lists the cloud presets, sample and soundfont packs, and WCLAP plugins from `api.opendaw.studio`.
- Selected items are downloaded through the existing storages (`WclapStorage`, preset storage, `SampleStorage`), which write through the file storage strategy into the data dir. After that they behave like local content and need no network, and uninstall cleanup already covers them.
- This re-enables exactly the API calls needed for listing and downloading, and only when the user triggers them.
- "Download all" (2026-10-16): one option fetches every cloud preset and every WCLAP plugin at once, so the app has the complete library offline. It shows the total size first and keeps the set up to date when the cloud adds items. Implemented later as a strategy (an offline content strategy beside the catalogue strategy), the browser keeps fetching on demand.

## Native audio engine (later phase)

**Goal:** the shell talks to the sound card directly and runs the engine in its own scope, outside the webview.

**Audio and MIDI I/O**
- Audio goes through `cpal`: CoreAudio, WASAPI, ASIO, ALSA and JACK.
- MIDI goes through `midir`. This also replaces Web MIDI, which WKWebView and WebKitGTK do not have.
  - Done 2026-10-16: studio-core `MidiAccess` strategy (Web MIDI by default), `NativeMidi` installs the desktop one. The engine always sends a first device list (also empty) and pumps the CoreMIDI run loop, so devices plugged in while the app runs appear within 2 seconds.

**Engine hosting (revised 2026-10-16: V8, not wasmtime)**
- The shell embeds V8 (`rusty_v8` / `deno_core`) and runs the existing engine host JS as is: the engine wasm, the device side-modules and all three JS bridges. V8 runs WebAssembly itself, so no bridge is ported to Rust and behaviour stays that of Chrome.
- The `cpal` audio callback drives the render function, the way `offline-worker.ts` drives the engine today.
- Why not `wasmtime`: three devices depend on JS, not only the scriptable ones.
  - Werkstatt, Apparat, Spielwerk: `script-bridge.ts`, 9 `host_script_*` imports carrying only numbers and memory offsets, user code arrives as a wrapped string (`ScriptCompiler.wrap`) that fills `globalThis.openDAW.<registry>`.
  - NeuralAmp: `nam-bridge.ts` hosts its own Emscripten module from JS.
  - WCLAP: `wclap-bridge.ts` hosts the plugin wasm modules from JS (WASI shim, trampolines).
  - With `wasmtime` all three need Rust ports plus V8 for the scripts anyway.
- Proof it leaves the worklet: `offline-worker.ts` already runs the full engine with the script bridge in a plain Worker. It sets the `sampleRate` global itself and loads scripts with `new Function(code)` instead of `addModule`.
- Needed: a shim for the worklet globals (`sampleRate`, `self`/`location` as in `worklet-scope.ts`, `registerProcessor` is not used), and the new UI and engine link (below), since the processor talks over `MessagePort` and SAB rings today.
- Cost: about 30 MB of binary and a V8 build or prebuilt in CI. macOS needs the `allow-jit` entitlement.
- Compiling the engine natively is a possible later optimisation, not the first step.

**UI and engine link**
- There is no shared memory across processes. Box graph transactions, transport and commands use the existing serialized sync format over a binary local channel: a loopback WebSocket, or Tauri channels.
- Live data (meters, FFT, scope, Werkstatt telemetry, `LiveStream`) is streamed the same way at frame rate.
- The engine becomes one more platform strategy: worklet engine in the browser, native engine in Tauri.

**Samples, recording and render**
- The native engine reads samples straight from the data dir or the linked OS paths (no copy through the UI).
- Recording runs native with exact input and output latency, which fixes the WebKit `outputLatency`-undefined fallbacks.
- Mixdown, stems and video audio render natively.

**Scriptable devices (Werkstatt, Apparat, Spielwerk)**
- Resolved by the V8 engine host above: the bridge runs unchanged in the shell's isolate. The analysis below led there.
- Today these run user JavaScript as DSP on the audio thread. The engine calls synchronous `host_script_*` imports (`core-wasm/src/script-bridge.ts`, `plans/wasm-audio/scriptable-devices.md`).
  - The script is compiled in the worklet realm at setup and runs JIT'd in V8, with zero-copy `Float32Array` views on engine memory.
  - The offline render worker uses the same bridges.
- A native engine has no JS, so `wasmtime` alone breaks these devices. Options:
  1. **Embed V8 in the engine process via `rusty_v8`** (recommended). It is JIT'd, so it matches today's real-time performance and float behaviour, which keeps the existing parity tests meaningful.
     - The engine implements the same `host_script_*` imports against an isolate per engine, with buffers exposed as external `ArrayBuffer`s over wasmtime memory, so there is still no copy.
     - Cost: about 30 MB of binary and a V8 build in CI.
     - Script compile and recompile stay off the audio thread, as today.
  2. JavaScriptCore (system framework on macOS, available on Linux): JIT and no extra binary. But it is a different engine per OS, and there is no JSC on Windows.
  3. QuickJS or Boa: already rejected in `scriptable-devices.md` (interpreters, too slow for per-sample loops).
  4. Keep scripts in the webview worklet and ship their audio across processes: adds a round-trip per block. Rejected.
- Only the DSP scripts move. The TypeScript compile (`ScriptCompiler`, Monaco) and the project scripting API (`ScriptHost` worker, Api facades) stay in the webview.
- In the wrapper phase (worklet engine in the webview), scripts run on JavaScriptCore on macOS and Linux and on V8 in WebView2. JSC has a JIT in worklets. But `Math.sin`, `exp` and similar functions are not bit-specified across engines, so the scriptable parity tests must run on JSC too.

**Plugins**
- CLAP comes first, via the `clack` host crates, because WCLAP already exists.
- VST3 is possible later. Check the SDK licence first; I believe it is now MIT.
- Plugins run in a sandbox process, so a crashing plugin does not take the engine down.
- Plugin editors are native windows parented by the shell. macOS and Windows are fine. Linux X11 is fine, Wayland is limited.

**Desktop audio duties**
- Disable macOS App Nap while the engine runs.
- Use a real-time thread priority (`audio_thread_priority`).
- Report device sample-rate and buffer changes back to the UI.

**What it solves**
- Output device selection: today `setSinkId` is missing in WebKit, so macOS and Linux webviews cannot pick an output at all.
- MIDI on macOS and Linux.
- Low latency.
- Browser power throttling.

**Cost:** the largest piece of the whole effort. It comes after the wrapper ships.

## Audit: what breaks or feels like a web page (2026-10-15, code read, nothing run)

### A. Boot blockers inside a webview
1. **`build-info.json`**
   - `boot.ts:52` fetches `/build-info.json`. Failure means `alert` and a dead app. The shell must serve it.
2. **Feature gate and OPFS probe**
   - `features.ts` requires `indexedDB`, `navigator.storage.getDirectory`, SAB, `AudioWorkletNode`, WASM SIMD and `crypto.subtle`.
   - The boot OPFS probe (`boot.ts:176`) aborts with "Storage Unavailable".
   - Both must ask the active storage strategy instead of probing OPFS.
3. **`Browser.isLocalHost()` is true for `tauri://localhost`, `http://tauri.localhost` and `127.0.0.1`/`localhost` loopback**
   - It is just `location.host.includes("localhost")`. In the desktop build this silently:
     - disables the production checks;
     - **unhides debug-only features** (`StudioMenu.ts:80` JSON export, `ContentEditor.tsx:82`, `RegionContextMenu.ts:195,208`, `TrackHeaderMenu.ts:132`, `TubularDeviceEditor.tsx:105`, `DebugMenu.ts:58`, `dialogs.tsx:366`);
     - changes the `beforeunload` guard.
   - Fix: replace it with an explicit `Platform.isDevelopment` flag, never derived from the origin.
4. **`new AudioContext({sampleRate: 48000})`** (`boot.ts:79`)
   - Only Firefox is exempt. The spike checks that WebKit accepts it on 44.1 kHz hardware. `AudioContexts.#probeHardwareSampleRate` exists for this case.
5. **Microphone permission blocks output listing**
   - `navigator.permissions.query({name: "microphone"})` (`audio/AudioDevices.ts:61`) rejects on some WebKit builds. That aborts the device request, which also blocks *output* device listing.
6. **The webview must grant media permissions**
   - macOS needs `NSMicrophoneUsageDescription` and the `audio-input` entitlement.
   - WebKitGTK `permission-request` and WebView2 `PermissionRequested` must be answered by the shell.
   - Autoplay policy must be off, so the click-to-resume hack (`boot.ts:104`) becomes moot.

### B. Silent hangs offline (worst class)
1. **`IndexFetch.fetchIndex` retries forever** (mitigated today by `OpenDAWCloud.disable()`, the proper fix is in Audit D)
   - It is used for the sample and soundfont indexes (`OpenSampleAPI`, `OpenSoundfontAPI`). `FactoryCatalog` waits on it, so on desktop these never resolve:
     - `SampleService.ts:94`
     - `SoundfontService.ts:27,88`
     - project load (`[ProjectLoad] sample catalogue requested`)
     - the sample and soundfont browsers
     - `SampleSelection`, `SoundfontSelection`
     - `ConvolverImpulseResponseMenu.ts:16`
   - Needs a catalogue strategy: offline means an empty index or the downloaded offline content.
2. **`network.defaultFetch`** shows a "No Internet Connection, Retry" dialog (`network.ts:35`). Preset and WCLAP indexes retry before degrading to empty.
3. **`beforeunload`** (`StudioService.ts:568`) always prompts when `!navigator.onLine`. Offline is the normal state on desktop, so this check goes.

### C. Remote assets the offline app still needs
| Asset | Today | Desktop |
|---|---|---|
| FFmpeg core (~30 MB) for MP3 and FLAC export | `package.opendaw.studio` at use (`FFmpegWorker.ts:68`) | ship in the Tauri manifest, or encode natively in the shell |
| Manuals app (`app/manual`, `/manuals/*`) | separate build, not in studio `dist` | merge into the Tauri build. It reads `localStorage["preferences"]`, so it needs the key-value strategy too |
| Scripting docs (`/docs/scripting/`) | separate build | merge into the Tauri build |
| ONNX models (stems 250 MB, tempo 304 MB) | `assets.opendaw.studio/models`, cached in OPFS | offline content download |
| Factory samples, soundfonts, presets, WCLAPs, IRs, demo projects | `assets.` and `api.opendaw.studio` | offline content download. Demo projects are not shown |
| Sample preview | `<audio src>` on the remote file (`SamplePlayback.ts:78`) | local files only |
| VU meter font | Google Fonts CSS (`VUMeter.tsx:21`) | bundle |
| Absolute `/…` fetches (`/tubular`, `/cover.png`, `/fonts`, `/images`, `/sponsors.json`) | assume the site root | fine with `base "/"`. The server needs an SPA fallback for router paths (`/stats` reload) |

### D. Online features in the desktop app (later, after a working app)
Nothing is hidden because it is the desktop app. An online feature stays and works while the network is up, and fails fast with a clear message while offline. What blocks them today is the origin `http://127.0.0.1:47110`, which the servers do not accept yet. The fixed port is part of this contract: it must never change.
- **Catalogues, samples, soundfonts, presets, WCLAP:** `assets.opendaw.studio` and the API servers reject the loopback origin (CORS). Allow `http://127.0.0.1:47110` on the servers. `OpenDAWCloud.disable()` exists only because of this. It becomes an "openDAW servers reachable right now" check.
  - Checked 2026-10-16: `assets.opendaw.studio` sends `Access-Control-Allow-Origin` for `https://opendaw.studio`, `https://dev.opendaw.studio` and `https://localhost:808x`, nothing for the loopback origin.
  - Done (not uploaded): the root `.htaccess` template in `deploy/run.ts` allows `http://127.0.0.1:47110`. Uploaded once by hand, it takes effect without a deploy. It does not cover `assets.`: that host has its own `.htaccess`, kept locally (gitignored) at `packages/server/assets.opendaw.studio/.htaccess` and uploaded by hand, the desktop origin was added there 2026-10-16. Verify with `curl -sI -H "Origin: http://127.0.0.1:47110" https://assets.opendaw.studio/samples/index.json`.
  - Open: the api repo (`../api.opendaw.studio`): `is_allowed_origin` in `samples/connect.php` (sample metadata `get.php`, uploads) and the allow-lists in `latency`, `rooms`, `soundfonts` and `users` `.htaccess`.
  - Done 2026-10-16 (api repo, not deployed): `http://127.0.0.1:47110` in `samples/connect.php`, `presets/upload.php`, `users/count.php`, `latency/report.php` and the `rooms`, `soundfonts`, `users`, `latency` `.htaccess` files. The root `.htaccess` (`deploy/run.ts`) goes live with the next successful DEV deploy.
  - Done 2026-10-16 (studio): `OpenDAWCloud.followNetwork()` replaces `disable()` on desktop. The cloud is available while `navigator.onLine`, offline catalogues are empty and remote loads fail at once without a request. Only a fetched index is kept, so back online each catalogue is fetched on its next use. The web is unchanged.
  - Later: refresh open catalogues (sample, soundfont, preset, WCLAP browsers) on the `online` event instead of on their next use.
  - Open: online but the servers unreachable behaves like the web (index retried indefinitely).
  - Open: `logs.opendaw.studio` still rejects the desktop origin (403). Its deployed code differs from the local `opendaw-logs` repo.
  - Open (lib-runtime, affects the web): `Promises.retry` without an option shares one `IntervalRetryOption`, whose counter stops only at exactly 3. After the first exhausted retry anywhere, every default retry retries forever every 3 s. Fix = a fresh option per call, which makes flaky downloads fail after 3 attempts instead of eventually succeeding. Needs a decision.
- **Dropbox and Google Drive:** OAuth redirects to `location.origin/auth-callback.html` and the result returns through a `BroadcastChannel`. Register `http://127.0.0.1:47110/auth-callback.html` with both providers (both accept loopback redirects). Verify the `BroadcastChannel` reaches the main window from the linked auth window. Nextcloud needs nothing.
- **Tone3000:** same as Dropbox/Drive with `tone3000-callback.html`.
- **Done 2026-10-16, Dropbox, Google Drive, Tone3000:** providers refuse logins inside a webview, so `Platform.openAuthWindow` (lib-dom, default `window.open`) opens the login in the system browser on desktop (`DesktopBrowser`, shell `browse`). The callback page, served by the shell, posts its message to `/__auth-callback` (same Origin only), the shell replays it on the studio's BroadcastChannel and focuses the main window. `http://127.0.0.1:47110/auth-callback.html` is registered with Dropbox and Google, Tone3000 needs no registration. Windows the page opens get a 1000×800 default size, open windows of their own, and close natively on a foreign page.
- **Publish, live rooms, `/join/*`, uploads (`/upload`, `AccessKey`):** most likely the same CORS change. Test each, including WebRTC STUN/TURN in WKWebView.
- **Live rooms (2026-10-16):** a room did not connect from desktop because the Yjs sync socket of `live.opendaw.studio` only accepts listed origins (`yjs-server/utils.js`). Signaling has no origin check.
  - Done (server, not deployed): `http://127.0.0.1:47110` in both origin lists. Gentle limits for both sockets: at most 32 connections per IP (429 on upgrade), a message rate of 2000 burst refilling at 500 per second, over it the connection is closed (never dropped, the client reconnects). No new size limit, `ws` keeps its 100 MB default so big transactions pass.
  - Later: room keys against strangers flooding a room (an Origin header protects nothing, any non-browser client sends any). Built once and tested locally, then dropped for now. The design: the creator gets a random key, the invite link is `/join/<room>#<key>` (the fragment never reaches a server), the client sends it with the Yjs socket (`WebsocketProvider` params) and the signaling URL. The first connection that opens a new room with a key claims it (sha256 in memory, forgotten with the room), later connections need the same key or are closed with 4403, which the studio shows as "join it with its invite link" instead of a 10 s timeout. Rooms opened without a key stay open, so older studios keep working. Each browser remembers the key per room name. Rollout: server first, PROD studios drop the fragment until they update.
  - Later: joining an existing room on desktop. No address bar, and an invite link opens the browser. Let the dialog's room name field accept a pasted invite link (room plus key), and later an `opendaw://join/...` deep link (Tauri deep-link plugin, scheme registered per installer).
  - Done 2026-10-16: invite links on desktop are built from `https://opendaw.studio` (`VITE_SHARE_ORIGIN` in the desktop build).
  - Later: protection against bad edits from someone inside a room. The server relays updates without understanding them, so only the clients can reject a change that breaks the project. Start from how the studio handles a broken incoming change today.
- **Dashboard pages:** stats, errors, sponsors, contributors, demo projects, `/open-bundle/*`. Same CORS change, test each.
- **Telemetry:** visitor beacon and error POSTs stay when online (open question 4).
- **Only hidden:** the update poll, because the shell owns updates.

### E. Desktop behaviour
1. **Native menu bar**
   - Mirror `StudioMenu.ts` (`populateStudioMenu`) into a Tauri `Menu`:
     - macOS app menu (About, Preferences `Cmd+,`, Hide, Quit `Cmd+Q`);
     - File (New, Open, Recent, Save, Save As, Import, Export);
     - **Edit** (Undo, Redo, Cut, Copy, Paste, Select All);
     - Window (popouts);
     - Help (manuals).
   - Without an Edit menu, `Cmd+C/V` does not work in WKWebView text fields.
   - The menu reflects the studio's enabled and checked state through IPC.
   - **Decided: the openDAW menu moves into the native menu bar on every platform.** The in-page `MenuButton` header menu (`Header.tsx:72`) is hidden on the desktop target.
   - The desktop menu is structured differently from the web menu, so it gets its own definition: a separate `DesktopStudioMenu` next to `StudioMenu.ts`, built from the same `MenuItem` API and the same service actions, but arranged in native menus. `StudioMenu.ts` stays unchanged for the web.
   - A menu strategy turns that `MenuItem` tree into a Tauri `Menu`: labels, separators, submenus, checked state (for example "Show MIDI-Keyboard"), enabled state and accelerators from `Shortcut.format()`.
   - The tree is rebuilt or patched whenever it changes (the project opens or closes, checked state flips). Native clicks come back over IPC and call the item's trigger procedure.
   - Menu layout is defined in `DesktopStudioMenu` (to be designed). Platform conventions still apply:
     - macOS: the app menu holds About, Preferences and Quit; Edit and Window are standard.
     - Windows and Linux: a window menu bar.
   - Native accelerators replace the browser-reserved shortcut handling for menu actions, and stay in sync with the user's custom shortcuts (`localStorage["shortcuts"]`, via the key-value strategy).
2. **Shortcuts**
   - The webview's own accelerators must be off: reload `Cmd/Ctrl+R` and `F5`, zoom `Cmd/Ctrl +/-/0`, find, print, devtools in production. On WebView2 this is `AreBrowserAcceleratorKeysEnabled=false`.
   - Collisions:
     - `Mod+R` (restart recording) is reload in the webview;
     - `Mod+M` (metronome) is macOS Minimize;
     - `Mod+K`, `Mod+D`, `Mod+O`, `Mod+S` are fine once the accelerators are off.
   - `Mod+W` and `Mod+Q` must route to close-requested with the unsaved-changes dialog.
   - `shortcut-definitions.ts:47` uses `alert()` on a conflict.
3. **Window lifecycle**
   - The `beforeunload` native prompt is replaced by the shell's close-requested event and an in-app dialog.
   - `alert()` sites (`main.ts:40`, `boot.ts:64`, `ErrorHandler.ts:330`, `Router.tsx:88`, `shortcut-definitions.ts:47`) go to in-app or native dialogs.
   - `location.reload()` sites (`dialogs.tsx:361,369,410`, `UpdateMessage.tsx:15`) become a shell restart.
4. **Title**
   - The static SEO `<title>` ("Web-Based DAW for Music Education") is never updated.
   - Desktop: the window title is the project name plus an unsaved marker (macOS `documentEdited` dot).
   - Favicon swapping is irrelevant on desktop.
5. **Project model**
   - There is no project-on-disk concept today: projects live in storage by uuid, and `.od`/`.odb` files are copies (`loadFile` gives a fresh uuid, `saved=false`).
   - Desktop users expect Save to a file, double-click to open, and Recent files.
   - Decision needed: keep the internal library and add file associations for import, or make a project a file or folder on disk through the file storage strategy.
   - Autosave: only a crash-time recovery backup exists (`Recovery.ts`). A desktop app should autosave or at least snapshot periodically.
6. **OS integration**
   - File associations: `.od`, `.odb`, `.opb`, `.odp`, `.dawproject`, `.odsl`.
   - An `opendaw://` deep link replaces `/open-project#…`.
   - Single instance (`tauri-plugin-single-instance`): two instances would write the same data dir, which is the desktop form of two tabs. Today nothing coordinates that (no Web Locks).
7. **Drag and drop**
   - Tauri's native file-drop handler must be disabled (`dragDropEnabled: false`), otherwise HTML5 drops of files into the timeline and browser stop working, notably on Windows.
   - Drag-out to the desktop does not exist today. That is a nice-to-have through the shell.
8. **Detection**
   - `Browser.isChrome()` is false in every webview (WebView2's UA has `Edg/`), so pointer-lock knob dragging (`StudioService.ts:587`) is off everywhere. Switch it to feature detection.
   - `isMobile` and `isMacOS` are fine.
9. **Web wording**
   - "Popout into new browser window", "Chrome is recommended" (`VideoExportDialog.tsx:154`), "Chrome and Firefox do" (`NoMidiSupport.tsx`), "check your browser permissions" (`clipboard.ts`), "Private Browsing" (`boot.ts` storage dialog), and `MissingFeature.tsx`. Each gets platform-specific copy.
10. **Links**
    - Every `target="_blank"` anchor and `linkify` (`lib/jsx`) goes through the external-link strategy.
    - The Markdown link rule (`Markdown.tsx:41`) treats `/docs/` as external, so docs stay in-app on desktop.

### F. Webview capability gaps (WKWebView and WebKitGTK unless noted)
| Gap | Effect | Answer |
|---|---|---|
| `setSinkId` (context and media element) | no output device choice, no monitoring routing | native engine. Until then: system default only |
| Web MIDI | no MIDI in or out at all | MIDI strategy via `midir` in the shell, feeding the same SAB ring (`MIDIReceiver.ts`) |
| `outputLatency` undefined | recording latency compensation falls back to 10 or 20 ms guesses | native engine. Until then: measured latency setting |
| `showSaveFilePicker`, `createWritable` | video streaming export falls back to memory (`VideoRenderer.ts:42`). Sync log is unavailable (`SyncLogService.ts`) | Files strategy with a native writable handle (append, seek) |
| WebCodecs `VideoEncoder`/`AudioEncoder` | video and Opus export hidden if missing (feature-detected) | spike per platform. Native encode via the shell as fallback |
| `decodeAudioData` codecs | WebKitGTK depends on installed GStreamer plugins, so MP3/FLAC/OGG import may fail on Linux | native decode in the shell (`symphonia`) as a decode strategy |
| `DecompressionStream("deflate-raw")` | `/open-project` payload | replaced by deep link anyway |
| `navigator.clipboard.readText` | restricted in WebKit | clipboard strategy |
| `playbackStats` | underrun detector off | fine, optional |
| Service workers | none on custom schemes | not needed: WCLAP GUIs are served by the shell in their own OS windows |
| Background throttling | occluded windows throttle rAF and timers | `backgroundThrottling: disabled` per window |
| Output latency (macOS, seen 2026-10-15) | audible latency far above the shown 15.4 ms, and much worse after loading a bundle. Same machine and project are fine in the browser, so it is WKWebView. Output device runs at 48 kHz, no resampling | open. Measure first: `outputLatency`, `currentTime - getOutputTimestamp().contextTime` over time, engine load. Long term: native engine |

### G. Storage details for the file storage strategy
- `OpfsProtocol` consumers:
  - projects, templates, samples, soundfonts, presets and scripts;
  - `wclap` (sha-keyed, `opfs:` URLs);
  - `.backup`, `tone3000`, `inference/models`;
  - bundle import, cloud backup, and live-room asset exchange.
- All relative paths go through `Workers.Opfs`.
- Bypasses: `StorageInspector.ts:26`, `storage-worker.ts:17`, `features.ts`, `StorageScan` (`opfs:` and `presets/user/` assumptions), and `StoragePage` `navigator.storage.estimate()`.
- Semantics to keep:
  - per-path serialisation (the in-worker promise locks in `OpfsWorker`);
  - `delete("")` wipes the root (`DebugMenu.ts:97`).
- `localStorage` keys move to the key-value strategy:
  - `preferences`, `engine-preferences`, `shortcuts`;
  - `browser-id` (cloud backup lock);
  - `access-key`;
  - `opendaw:user:name`, `opendaw:user:color`;
  - `tone3000_*`;
  - `nextcloud.server-url`;
  - `tubular-audition-keepers`;
  - `opendaw-suppress-unload-guard`.
- `sessionStorage` is used only by the stats page (hidden on desktop).

## Spike results (macOS, 2026-10-15, Tauri 2.12.4, `spike/tauri/`, uncommitted)

**Serving**
- Loopback `http://127.0.0.1:<port>`: the studio boots (145 ms), with `crossOriginIsolated`, SAB, AudioWorklet, WASM SIMD and OPFS all working.
- Custom protocol `opendaw://`: `crossOriginIsolated` reports true, but SAB is undefined, so the studio is dead. **Option B is decided.**

**Popouts**
- Opener-linked native windows work (`on_new_window` plus `window_features`).
- A real panel popout from the studio's own menu works: full panel, styles, 61 fps, and live edits in both directions (one realm).
- Panels dock back on close.
- Required shell fixes:
  - wry ignores `window.close()` on linked windows, so the shell replaces `close` in each popout to fire `beforeunload` and destroy the window;
  - the native close button is routed through the same path (`CloseRequested`, `prevent_close`, then `beforeunload`, then destroy).

**WCLAP**
- The GUI runs in its own child OS window on a plugin-only origin (`127.0.0.1:<plugin port>`), served by the shell from the uploaded bundle.
- An injected bridge replaces `window.parent.postMessage` and the incoming `message` events.
- Traffic flowed both ways through the shell, and window close was detected.
- Done 2026-10-15: the in-page `FloatingWindow` placeholder is gone on desktop (see Progress).

**WKWebView capabilities**
- Missing: `setSinkId`, Web MIDI, FS Access pickers, `playbackStats`.
- `outputLatency` is 0.
- Present: WebCodecs (Opus, AVC), `deflate-raw`, pointer lock.
- The native file open dialog (`<input type=file>`) works.

**Cloud from the desktop origin**
- `assets.opendaw.studio` sends no CORS header for `127.0.0.1:<port>`, so catalogues never resolve. This confirms the need for the catalogue strategy (empty or offline content).

**Still open:**
- a Werkstatt script on JSC;
- the mic permission prompt (needs the Info.plist key);
- HTML5 file drop;
- accelerator suppression;
- Windows and Linux.

## Repo layout

- `packages/app/desktop/` holds the Tauri project (`src-tauri/` plus the splash page). It is **outside** the root Cargo workspace, because the workspace targets wasm32 devices and Tauri pulls in a native dependency tree.
- `.github/workflows/desktop.yml` runs on tag `desktop-v*`: a matrix of macOS universal, Windows and Ubuntu builds via `tauri-action`, with signing, a GitHub Release and `latest.json`.
- `deploy/run.ts` gains the `tauri` release folder and pointer.

## Phases

0. **Spike (go/no-go, about 2 days)**: a minimal shell serving the current `dist/` (built with base `/`) via A and via B on macOS, Windows and Linux.
   - Check:
     - **opener-linked popouts** (`Surface` popout works unchanged), which is go/no-go;
     - `crossOriginIsolated`, SAB, AudioWorklet plus the wasm engine;
     - **a Werkstatt script on JSC**;
     - module workers, the `/fs` round-trip from a worker;
     - a WCLAP plugin GUI in its own OS window, served by the shell, with the message bridge;
     - mic permission, the 48 kHz context on 44.1 kHz hardware;
     - WebCodecs, MP3 `decodeAudioData` on WebKitGTK;
     - accelerator suppression, `dragDropEnabled: false` HTML5 file drops, background throttling off.
   - Output: the serving choice and a confirmed gap list (Audit F).
1. **Strategy seams (browser only)**: introduce `Platform` with browser strategies and move every call site listed above behind it. This lands on `main` before any Tauri code and must be behaviour-neutral (existing tests untouched).
2. **Web target**: `build:tauri`, `manifest.json`, `shellApi` in `BuildInfo`, update poll skipped (online features stay, see Audit D). Deploy to `/tauri/releases/`.
3. **Shell core**: splash, version check, verified incremental download, atomic switch, rollback, local server with headers and `/fs` endpoints, IPC surface.
4. **Tauri strategies**: windows, popouts, external links, files, key-value store, file storage, catalogue (offline index), MIDI (`midir`), decode, clipboard, fullscreen, lifecycle.
4b. **Desktop behaviour**: native menu bar with Edit menu, accelerator suppression, close-requested flow, window title, file associations, deep link, single instance, web wording, `isLocalHost` replaced by `Platform.isDevelopment`, FFmpeg core, manuals and docs bundled (Audit A to E).
5. **Shell update and distribution**: updater keys, signing and notarization, CI workflow, `latest.json`.
6. **Uninstall**: NSIS hook, in-app uninstall (macOS, AppImage), Flatpak manifest, export-before-uninstall.
7. **Offline content**: presets and WCLAP downloads (see Phase 2 section).
8. **Linked samples**: samples referenced by OS file path (see above).
9. **Native audio engine**: `cpal` and `midir` I/O, `wasmtime`-hosted engine, V8-hosted scriptable devices, binary UI link, native render.
10. **Native plugins**: CLAP host in a sandbox process with native editor windows, then VST3.

## Open questions

1. **Signing**: is there (or will there be) an Apple Developer ID and a Windows code-signing certificate? Without them, distribution on macOS is effectively blocked.
2. **Projects on uninstall**: confirm that user projects really go too, and not only the downloaded builds.
3. **Channel**: should the shell follow `main` only, or offer a `dev` channel setting?
4. **Telemetry**: keep error reporting to `logs.opendaw.studio` when online, or turn it off entirely in the desktop app?
5. **Linux packaging**: is Flatpak plus AppImage acceptable, or is a `.deb` required?
6. **Data portability**: browser OPFS and the desktop data dir are separate, so there is no automatic migration. Project export/import is the bridge. Is that enough?
7. **Project model**: keep the internal project library (as in the browser) or move to project files and folders on disk with Save, Recent and double-click open?
8. **Script engine for the native engine**: is a V8 embed (about 30 MB) acceptable for scriptable devices?
