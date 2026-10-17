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
