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

## Version flow (web build)

### Build side
- Add a Tauri variant of the studio build: `npm run build:tauri` with `base = "/"` and `VITE_TARGET=tauri`. Same sources, same uuid naming.
- The build writes `manifest.json` into the release with `{uuid, date, shellApi, files: [{path, size, sha256}]}`. It excludes `*.map` and `*.br`.
- `BuildInfo` gains `shellApi: number`, the minimum shell API the build needs.
- CI uploads the variant to `/tauri/releases/{uuid}/` and updates a stable pointer `https://opendaw.studio/tauri/build-info.json` (same `.htaccess` mechanism as `main`/`dev`). The browser deploy is unchanged.

### Shell side, at every launch
1. Fetch `tauri/build-info.json` with a short timeout (about 3 s).
2. **Nothing installed and offline**: show "first launch needs internet" and offer Retry.
3. **Installed and (offline or same uuid)**: launch the installed build.
4. **Newer uuid**:
   - If `shellApi > SHELL_API`, keep the installed build, and the shell update (below) must happen first.
   - Otherwise download `manifest.json` into `web/{uuid}.partial/`. Files whose sha256 already exists in the current build are copied locally (fonts, images, unchanged wasm devices), and only the rest are fetched. Every file is verified by size and hash. Then rename to `web/{uuid}/`, write `web/current` atomically, and delete every build except current and previous.
   - The splash shows progress. When a build is already installed, a "Start current version" button skips the update for this launch.
5. A failed or interrupted download leaves `.partial` behind and it is retried or wiped on the next launch. The active build is never touched before the switch.
6. If the new build fails to boot (no ready signal within N seconds), roll back to the previous build and mark the failed uuid as bad.

### Web side (`VITE_TARGET === "tauri"`)
- The 5 s `build-info.json` poll, the cache guard and the extensions check are skipped. The shell owns updates.
- The shell exposes a small IPC surface with `shellVersion`, `shellApi`, `checkForUpdates()`, and `restart()`. The studio uses it for an "Update available, restart?" message during long sessions, so the shell can recheck periodically while the studio is running.
- Cloud features are hidden or disabled: cloud sample and soundfont browsers, the cloud preset and WCLAP catalogue, Dropbox/Drive, publish, live rooms. `OpenSampleAPI`/`OpenSoundfontAPI` lookups fail fast with "not available offline" instead of hanging. A project referencing a cloud sample that is not stored locally loads with that sample marked missing, which is the existing missing-sample path.
- Error reporting to `logs.opendaw.studio` stays when online (needs your decision, see open questions).

## Platform strategies

Every feature that talks to the browser goes through a strategy interface. The browser build keeps today's code as its strategy, so its behaviour stays bit-identical. The Tauri build plugs in native implementations. Nothing outside the strategy layer may touch these browser APIs directly or check `VITE_TARGET`.

- **Where it lives:** a `Platform` namespace in `@opendaw/lib-dom` with an `install(strategies)` call once at boot (`main.ts`). The browser strategies are the default, so tests and other apps (`app/manual`) need no setup. The Tauri strategies live in the studio under `src/platform/tauri/` and talk to the shell via `@tauri-apps/api` IPC.
- **Selection:** at build time via `VITE_TARGET`, so the browser bundle contains no Tauri code.

### Strategies and their current call sites

1. **Windows** (popouts, auth popups, WCLAP plugin windows)
   - Browser: `window.open`.
   - Tauri: popouts are real native windows that stay scriptable by the opener (see Popout windows below). Auth popups and other URLs follow the external-link rule.
   - Sites: `Surface.tsx` popouts, `FloatingWindow.tsx:256` (pop out), `WclapWindows.tsx`, `CloudAuthManager.ts:86,177`, `NamTone3000.ts:145`.
   - `PanelPlaceholder.tsx:141` currently hides "Popout" when `Browser.isTauriApp()`. That gate goes once popouts work.
   - WCLAP plugin GUIs are not popouts. They get their own OS windows, see below.
2. **External links** (manuals, docs, GitHub, sponsors, credits)
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
- **The rule:** every WCLAP plugin GUI opens in its own OS window with its own webview. It is never part of the studio DOM: no `FloatingWindow`, no `<iframe>`, no `wclap-frame.html` relay.
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

## Native audio engine (later phase)

**Goal:** the shell talks to the sound card directly and runs the engine in its own scope, outside the webview.

**Audio and MIDI I/O**
- Audio goes through `cpal`: CoreAudio, WASAPI, ASIO, ALSA and JACK.
- MIDI goes through `midir`. This also replaces Web MIDI, which WKWebView and WebKitGTK do not have.

**Engine hosting**
- The existing wasm engine and devices run inside the shell with `wasmtime`, driven by the audio callback. It is the same binary as in the browser, so behaviour is bit-identical and the device ABI is untouched.
- macOS needs the `allow-jit` entitlement.
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
1. **`IndexFetch.fetchIndex` retries forever**
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

### D. Cloud-only features hidden in the desktop app (phase 1)
- **Publish and live rooms:** publish music, live rooms and `/join/*`, WebRTC STUN/TURN, room telemetry, chat.
- **Cloud backup:** Dropbox and Google Drive. OAuth redirects to `location.origin/auth-callback.html`, which cannot work on a local origin without a deep-link or loopback redirect registered with each provider. Nextcloud could stay, because the server is user-supplied.
- **Tone3000 browser:** same OAuth problem. Local `.nam` import stays.
- **Uploads:** sample and preset upload (`/upload`, `AccessKey`).
- **Dashboard and stats pages:** stats, errors, sponsors, contributors, demo projects, `/open-bundle/*`.
- **Telemetry and updates:** visitor beacon, error POSTs (keep when online, open question), and the update poll, which the shell owns.

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
   - The in-page `MenuButton` header menu stays for Windows and Linux, or goes, which needs a decision.
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
2. **Web target**: `build:tauri`, `manifest.json`, `shellApi` in `BuildInfo`, cloud features gated by `VITE_TARGET`, update poll skipped. Deploy to `/tauri/releases/`.
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
8. **Header menu**: does the in-page studio menu stay next to the native menu bar on Windows and Linux?
9. **Script engine for the native engine**: is a V8 embed (about 30 MB) acceptable for scriptable devices?
