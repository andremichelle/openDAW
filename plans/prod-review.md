# PROD review of `tauri-desktop-app` (2026-10-17)

Four reviews (shared code, desktop studio TS, desktop Rust, engine entry points) against merge base 98efab88f. The
blockers were re-checked by reading the code. Order of work: blockers 1-7 and 10, a Windows test build, then 8, 9 and
the engine refactoring.

## Blockers

1. **Windows: the installed app never starts the engine.** `desktop/src/main.rs` `engine_binary` looks for
   `opendaw-engine` without `.exe`, debug builds bypass the check.
2. **Windows: console windows.** No `windows_subsystem = "windows"` on the shell, the engine and the scan processes
   are spawned without `CREATE_NO_WINDOW`. Closing the shell's console kills the app.
3. **Shell endpoints without token.** `/__close`, `/__quit`, `/__key`, `/__drag`, `/__resize`, `/__cycle-home`
   (`desktop/src/main.rs` `serve`): any website can destroy the main window past the unsaved-work guard or inject keys.
4. **Engine socket.** The `script` envelope runs code in the engine process, the WebSocket has no Origin check and an
   empty token would pass.
5. **An offline render releases live plugins.** `take_loaded` drains the global `LOADED` from every thread's
   `process()`, an offline thread releases entries of the engine thread.
6. **Quick plugin swaps terminate the new instance.** `EDITORS` is keyed by handle only, the stale generation's
   release terminates the new Editor.
7. **A failed engine start hangs the project load.** `EngineHost` closes cleanly (1005) when `create` fails, the
   studio only treats 1006 as lost, `EngineWorklet.isReady` never settles.
8. **Update integrity.** Manifest sha256 comes from the same server as the files, nothing is signed; component names
   reach file paths unsanitized, also through the unauthenticated `/__update/choose`. (Reported, not yet re-checked.)
   Re-checked 2026-10-17: signing is the same trust as the web studio (the server runs the code either way), downgraded
   to should fix. `/__update/choose` now keeps only names the manifest lists (uncommitted).
9. **`/install` ships to PROD at merge** with dead buttons, the installers exist on DEV only.
10. **Missing-sample dialogs offline.** Since the offline fix a failed catalogue fetch is an empty catalogue, the
    missing-file check then asks to browse for every uncached cloud sample. Skip the check when the catalogue is
    unavailable.
11. **SEVERE, open (2026-10-17): Linux does not start, "crossOriginIsolated must be enabled".** The studio's start
    check needs `window.crossOriginIsolated`. `fb6c67e9c` turns on WebKitGTK's CrossOriginOpenerPolicy and
    CrossOriginEmbedderPolicy features (2.42+ API, looked up at runtime, `desktop/src/isolation.rs`) on an
    `about:blank` webview before loading the studio, and logs `[openDAW] WebKitGTK x.y ...`. Still not isolated in
    the VM. Next: that log line (`~/.local/share/studio.opendaw/logs/openDAW.log`) and AppImage or .deb. Suspects:
    (1) WebKitGTK older than 2.42 (the .deb uses the system's, Ubuntu 22.04 / Debian 12 may ship older, the AppImage
    bundles the build machine's), (2) the features are on but that WebKitGTK still does not isolate, (3) fallback:
    `JSC_useSharedArrayBuffer=1` in the shell's environment before WebKit starts, and a desktop start check that
    accepts an existing SharedArrayBuffer instead of `crossOriginIsolated` (changes the start check, last resort).
    Update 2026-10-18: two Linux users now get "SharedArrayBuffer not available" from `features.ts`, which runs only
    after the `crossOriginIsolated` check passed, so `fb6c67e9c` isolates the page. WebKitGTK keeps SharedArrayBuffer
    hidden on isolated pages until WebKit 104506c (321889@main), its message names `JSC_useSharedArrayBuffer=true`.
    Fix: the shell sets `JSC_useSharedArrayBuffer=1` on Linux before anything starts (unless set), the web process
    inherits it. Start check unchanged. Unverified on Linux. Next possible blocker: `AudioWorkletNode` in the same check.

12. **Done (2026-10-18): the engine ships with every deploy, no new installer** (`plans/engine-updates.md`). The
    release carries an engine per platform (built by `deploy.yml`), the shell runs its release's engine, shell API 2.
13. **Done (2026-10-18): the app updates itself** (`plans/shell-updates.md`). `plans/tauri.md` promised the Tauri
    updater, it never existed. A tagged build signs its update files, `/install/openDAW-latest.json` is the feed, the
    app downloads in the background and asks to restart. `desktop-v` releases
    publish their feed, uninstall from Tools (phase 6) removes what the app wrote, the projects only when asked.

14. **Fixed (2026-10-18): engine errors every few minutes on Windows.** The engine polled its sockets with read
    timeouts. Windows leaves a socket undefined after one (`SO_RCVTIMEO`), reads failed with os error 997 and the
    connection to the studio ended. All five loops now poll non-blocking sockets (`engine/src/poll.rs`), a full socket
    queues instead of ending the connection (test: large messages both ways with a slow reader).
15. **Windows latency (2026-10-18, 90 ms reported).** WASAPI shared mode plus a reserve of two callbacks. The engine
    logs the split (`[latency]` line). WASAPI exclusive mode (`engine/src/exclusive.rs`, the `wasapi` crate) is a Mode
    in the Audio Output dialog on Windows, shared stays the default, a card refusing it falls back to shared. ASIO
    needs the Steinberg SDK license, not now. Unverified on Windows hardware.

## One engine, thin entry points

Shared: DSP, mixing, metering, scripts, WebCLAP, MIDI drain, transport (the desktop runs the unchanged
wasm-processor and wasm-offline-worker bundles). Not thin:
- `EngineHost.ts` re-implements the input path the web does with Web Audio nodes and the recording worklet: capture,
  direct monitoring (own pan law), effects monitoring map, recording planes, input peaks.
- Duplicated contracts: the HRClock layout (`#stampClock`), the MIDISender ring decode (`MidiOutRelay`).
- Bridge relay (sync state, live stream, port linking) four times: `EngineHost`, `OfflineHost`, `NativeEnginePort`,
  `NativeOfflineWorker`. Native device module merge twice (`EngineHost`, `OfflineHost`).
- Communicator wire format used directly: the forged `updateMonitoringMap` message, the `setupMIDI` rewrite, the
  `initialize` sniffing in `OfflineHost`, the synthetic rejects in `NativeOfflineWorker`.

Recommended, by value:
1. Input capture, monitoring, recording and peaks into the shared engine (core-wasm processor or crates), web and
   desktop on one implementation. High value, must keep the web bit-identical or opt-in.
2. Typed calls instead of copied wire formats: the studio sends `updateMonitoringMap` itself, MIDI setup as an
   explicit bridge envelope, the sync buffer passed through the worker factory.
3. One bridge relay helper (`BridgeRelays`) for both hosts and both ports.
4. A typed offline extension hook instead of `globalThis.extendEngineModules`, `hostImports` out of the
   structured-clone `WasmEngineAttachment`, one `NativePlugins.extend(modules, base)`.

## Should fix

- Real time: `notify()` and `LOADED.lock()` take Mutexes and allocate on the engine render thread, `queue_param` grows
  HashMaps, the event list can grow past 64.
- COM: `into_raw()` of Host, ComponentHandler and Frame leaks one reference per editor and window.
- ComponentHandler uses RefCell/Cell, plugins may call `performEdit`/`restartComponent` from the audio thread.
- A 60 s offline load timeout leaves the late Editor alive.
- macOS tick timer runs in common modes and can release a plugin inside its own modal loop (unverified).
- Audio device: `expect("no output device")` crash-loops, ring sized from the requested buffer.
  Done 2026-10-17 (uncommitted): 48 kHz is asked of every output, a card that refuses opens at its own rate
  (`REQUESTED_RATE`, `build_output`), `SAMPLE_RATE` follows and reaches the studio on `/audio` (`sampleRate`), plugins
  and the input use it. New engines start at that rate (`NativeOutput.sampleRate`), a running engine at another rate
  restarts without the error dialog (`EngineRestartRequest`). The fallback path cannot be reached on macOS (CoreAudio
  accepts 48 kHz), first real check on Windows.
  One rate (uncommitted): `EngineVariant.sampleRate` (optional) names the engine's rate, `EngineWorklet.sampleRate` keeps
  it (CPU budget), `EngineFacade.sampleRate` and `StudioService.sampleRate` report it, the native variant passes the
  card's rate. Native recordings, footer, performance display, vocoder display, script previews, convolver limit,
  consolidation, freeze and video export follow it. The browser has no variant rate, nothing changes there. Left on
  the AudioContext rate on purpose: boot log, debug menu, resume diagnostics, the browser's own RecordingWorklet.
- Scan: stdout read after exit deadlocks big bundles, `find()` miss runs a full scan on the main thread and drops user
  folders, single-file Windows `.vst3` reported incompatible.
  Done 2026-10-17 (uncommitted): `output_of` reads while the scan process runs (tests), `find()` no longer rescans, an
  unknown plugin loads as failed.
- Windows: the message loop starves in modal loops (drag, plugin dialogs), DPI per system not per monitor,
  no `OleInitialize`.
- Second app instance on the fixed ports (`tauri-plugin-single-instance`).
- Token in `initialization_script` without a navigation guard; `CLOSE_GUARDED` not reset on page reload.
- Desktop bridge: offline `postMessage` after close hangs, rejected loads cached forever (`EngineHost` modules,
  `NativePlugins.deviceModule`), live relay guesses its buffers and sorts every tick, MIDI/output reconnect counters
  never reset, save timeout skips plugin states silently, download dialog stays on error, vite only warns when the
  device wasm or manuals are missing in CI.
- `DesktopBrowser` also sends same-origin `_blank` links to the system browser (`/docs`, `/manuals`), `browse` could
  then take https only again (unverified double open).
- Shared: `WasmEngineAttachment.hostImports` (a function) in a structured-clone type, untyped `extendEngineModules`.
- Missing tests: WebAudioInputs/CaptureAudio after the refactor, MidiAccess, the OfflineEngineRenderer worker factory,
  the ScriptCompiler loader, the EngineWorklet port hook, the zero-box early return in `replaceMissingFiles`, the odd
  cursor path of `write_ascii_units`.

## Done after the blockers (2026-10-17, uncommitted)

- Output reserve follows the card's callback size (`raised_ring_target`, test): WASAPI/ALSA callbacks larger than the
  requested buffer no longer underrun every time.
- Single-file Windows `.vst3` plugins: `scan::windows_binary` and a PE machine check (`pe_machine`, test) in
  `compatible`.
- One openDAW at a time: the shell binds its port first, a second start asks the running one to show its window
  (`/__show`) and ends, before the engine or anything else starts.
- Deploy: dists go up in 16 MB chunks, each unpacked before the next under the one name `extract.php` accepts, a failed
  chunk is sent again up to 3 times (`deploy/chunks.ts`, test; local pack/unpack of dist-desktop identical, 12 chunks).
  The server's `tar` exit 9 (killed) stays unexplained: `extract.php` sends `2>&1` only for `rm`, tar's own message is
  lost.

- Installer and updates: files download 8 at a time with 3 attempts each (`in_parallel`, `with_retries`, tests), the
  server takes about 100 ms per request. Docs and manuals (832 files) measured 102 s one by one, 15 s with 8. Temporary
  names keep the extension (`main.js.download`), two files differing only in it no longer share one.

- Log file: release builds write the shell's and the engine's output to `<app data>/logs/openDAW.log` (the session
  before as `openDAW.previous.log`), Tools > Show Log Files opens the folder. The studio's own console is not in it.

- Microtonic crashed the engine on its first block, every restart again: it declares a second output bus (default
  active) and the engine passed buffers for the first only. Every audio bus now gets buffers, the extra ones a scratch
  or silence buffer (`Buses`). Probe test `probe_a_plugin` (ignored, `OPENDAW_PROBE`): crashed before, passes now, all
  installed plugins process a block (Cardinal aborts in the probe during initialize, a probe limit, it runs in the app).
- Crash loop: the crash marker stays set through a plugin's first second of audio (`Loading::keep`, `end_trial`), a
  plugin marked crashed is not loaded until a rescan or a bundle update. Not tested end to end (needs a crashing plugin).

## Pre-merge review (2026-10-17, after desktop-test-12)

Three reviews: changes since 49c014fa6, browser and SDK safety (98efab88f..HEAD), open plan items.

Before the merge into main (PROD web, SDK):
- `/install` reaches opendaw.studio with dead buttons (installers on DEV only, `desktop.yml` release notes link it).
  Proposed: register the route on DEV only until the public desktop release. Decision pending.
- Web recording moved into `WebAudioInputs` (logic compared identical, no tests, no browser recording since). Record
  audio and MIDI once by hand in the web build before merging.
- Live rooms during the deploy: bytes fields now travel as `Uint8Array` in Yjs, an old tab in a room with a new client
  drops them (`ByteArrayField.fromJSON`) until it reloads. Temporary, note at deploy time.
- Decide knowingly: `http://127.0.0.1:47110` in the shared root `.htaccess` CORS list (already live), DEV deploys no
  longer post to Discord, `hostImports` and untyped `extendEngineModules` become public SDK API once merged.
- Browser and SDK check: no blockers, desktop code gated, no existing box changed, SDK changes additive.

Bugs in the last changes (desktop, DEV), fixed 2026-10-17 (uncommitted), least intrusive each:
1. Crash marker trial reads as a crash: a scan in a plugin's first second keeps it "crashed" for the session, quitting
   within a second blocks the plugin until a rescan. Fix: a separate `trial` flag in the cache, `settle_trials` turns
   leftovers into `crashed` at engine start, `end_trials` on a clean exit, the shell closes the engine's stdin and waits
   up to 1 s before killing it (test `a_plugin_on_trial_counts_as_crashed_only_at_the_next_start`).
2. An open audio input keeps its rate when the output reopens at another one, recordings play at the wrong pitch.
   Fix: the input reopens at the new rate after the output.
3. Deploy retries miss thrown network errors (`sftp.put`, `fetch`), temp files stay behind. Fix: a thrown error is a
   failed attempt (the temp files only matter on the CI runner, left).
4. A plugin that failed to load is not retried once the startup scan lists it. Fix: a finished scan sets
   `RETRY_FAILED`, the engine thread loads its failed slots again.
5. Another program on the shell's port: openDAW exits silently. Fix: only a 204 to `/__show` counts as openDAW,
   otherwise the start panics as before the single instance change.
6. Retried component downloads count their progress twice. Fix: a failed attempt takes back its bytes.

## Refactoring

- `plugins.rs` (2056 lines) into `plugins/{com, handler, instance, slots, process, notices, window/{macos, windows,
  linux, none}}.rs`.
- Engine main loop one file per platform, one V8 bootstrap shared by `main.rs` and `offline.rs`.
- `DesktopStudioMenu` from `service/` to `platform/desktop/`.
- One typed host hooks record installed before boot instead of many `install*` singletons.
- Style: multi-line comments, `=== null`, `as` casts, unguarded `JSON.parse`, ad-hoc `{name, channels}` types.

## Decisions taken, flagged by the review

- The WebCLAP window opens after picking a plugin, in the browser too (asked for).
- "Open Bundle File from Disk" replaces Import > Project Bundle (asked for).
- Back buttons and layouts on Privacy, Imprint, Manifesto, Download (asked for).
- Open question: DEV deploys no longer post to Discord, intended?

## Progress

- 2026-10-17: plan written, fixing blockers 1-7 and 10 with tests.
- 2026-10-17, blockers 1-7 and 10 fixed (uncommitted):
  1. `engine_file_name()` with `EXE_SUFFIX` (test `engine_file_name_has_the_platform_suffix`).
  2. `windows_subsystem = "windows"` on the shell in release, the engine and the scan processes start with
     `CREATE_NO_WINDOW`.
  3. `/__drag`, `/__resize`, `/__quit`, `/__key`, `/__cycle-home`, `/__close` need the token (403 otherwise). The popout
     script carries it and only runs on `about:blank` and the shell's own pages, the engine sends it via `tell_shell`
     (tests `shell_endpoints_need_the_token`, `only_own_pages_get_the_popout_script`).
  4. The engine socket accepts only `Origin: http://127.0.0.1:47110` with a non-empty matching token, the engine exits
     without a token (test `only_the_studio_with_the_token_connects`).
  5. `take_loaded` returns at once on offline threads (test `an_offline_render_leaves_the_engine_threads_loads_alone`,
     fails without the fix).
  6. Editors carry their generation, `release_on_main(handle, generation)` only terminates its own, a replaced Editor
     is terminated at once. No automated test (needs a real plugin).
  7. `EngineHost` sends `{type: "failed", reason}` before closing, `NativeEnginePort` raises the engine error with the
     reason (`NativeEnginePort.test.ts`: failed start, clean close stays quiet, broken connection).
  10. `OpenSampleAPI/OpenSoundfontAPI.catalogue()` fails when unavailable or unreachable, `FactoryCatalog` uses it, the
     browsers keep `all()`/`tree()` with the empty fallback, `SoundfontService` lists local soundfonts without the stock
     catalogue (3 tests in `OpenDAWCloud.test.ts`, zero-file case in `AssetServiceCatalogUnreachable.test.ts`).
