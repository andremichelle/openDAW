# Native Plugins (VST3, CLAP) in the desktop app

Started 2026-10-16. Desktop only: native plugins run inside the native engine (`packages/app/desktop/engine`), next to the
engine wasm in V8. The model mirrors WebCLAP (`plans/webclap.md`): device boxes with a plugin id, state and a parameter
hub, an editor with "Open UI", missing-plugin recovery. What is new is the native host and native plugin windows.

## Facts

- VST3 SDK is MIT since 3.8 (2025-10-20), no agreement with Steinberg needed. VST2 is not licensable, out of scope.
- Rust: `vst3` 0.3 (coupler-rs, raw COM bindings, MIT/Apache-2.0), `clack-host` 0.2 for CLAP. AU (macOS) later.
- Native CLAP is the same API as WebCLAP, so the host logic of `wclap-bridge.ts` (events, params, state) carries over.
- Test plugins on this machine: `/Library/Audio/Plug-Ins/VST3/ABL3x.vst3` (AudioRealism ABL3, instrument, universal
  arm64/x86_64, has `moduleinfo.json`), Attracktive, FFOSSO, Cardinal (VST3 and CLAP).
- `moduleinfo.json` is not strict JSON: ABL3x writes trailing commas. The scanner needs a lenient parser.

## Architecture

- **Audio:** a device crate `device-native-plugin` (effect) and an instrument twin, mirroring `device-wclap` and
  `wclap-common`, call `host_plugin_*` imports. `engine-host.js` routes them to Rust functions registered on the V8
  isolate, which call the plugin's process on the same (audio) thread. Buffers are copied from and to wasm memory.
- **Bridge:** `NativePluginBridges` in the engine host JS mirrors `WclapBridges`: create, load, process, note, param,
  state, open/close GUI, status. The studio side reuses the WebCLAP message shapes (`status`, `params`, `state`).
- **Windows:** a plugin editor must live in the plugin's process, so the engine sidecar opens native windows.
  macOS needs the main thread with a run loop (NSApplication), so V8 and audio move off the main thread.
  Windows: a top-level HWND. Linux: X11 embedding (VST3 `IRunLoop`, CLAP posix fd support).
- **Crashes:** in process first, a plugin crash takes the engine down. Later an optional sandbox process per plugin.
- **Export:** the mixdown renders in the webview today, which cannot run native plugins. Projects with native plugins
  render in the native engine (`plans/native-engine.md` "native render").
- **Web:** a project with a native plugin opened in the browser keeps the device, shows "not available here" and
  passes audio through. Nothing is dropped.

## Scanning

Default folders, plus user folders in the settings:

| | VST3 | CLAP |
|---|---|---|
| macOS | `/Library/Audio/Plug-Ins/VST3`, `~/Library/Audio/Plug-Ins/VST3` | `/Library/Audio/Plug-Ins/CLAP`, `~/Library/Audio/Plug-Ins/CLAP` |
| Windows | `C:\Program Files\Common Files\VST3` | `C:\Program Files\Common Files\CLAP`, `%LOCALAPPDATA%\Programs\Common\CLAP` |
| Linux | `~/.vst3`, `/usr/lib/vst3`, `/usr/local/lib/vst3` | `~/.clap`, `/usr/lib/clap` |

- A VST3 bundle with `Contents/Resources/moduleinfo.json` is described without loading it (classes, CID, categories).
- Otherwise the engine binary runs as a scan process (`--scan <path>`), so a broken plugin cannot crash the engine.
- Cache keyed by path and modification time, "Rescan" in the plugin browser.
- Identity: VST3 class CID, CLAP plugin id. A project stores the id, not the path, so it opens on another machine.

## Phases

0. **Spike (macOS):** a standalone Rust binary loads ABL3x, sends a note, renders audio to a WAV, and opens its editor
   in an NSWindow. Settles the window question before anything else is built.
1. Scanner + catalogue endpoint on the engine socket, plugin browser in the studio.
2. Effects: device crate, bridge, state, bypass on failure.
3. Parameters + automation (reuse `WclapParameterBox` or a generalised parameter box).
4. Instruments + MIDI (note events, `IEventList` / `clap_event_note`).
5. Engine on a non-main thread, native windows in the sidecar (macOS run loop), "Open UI".
6. Native render for export.
7. Windows and Linux windows, CLAP via `clack-host`.
8. Sandbox process per plugin (optional).

## To test

- A VST3 audio effect: audio in and out through the effect chain (only instruments are hosted so far, effects need
  their own device and box, audio input buses and bypass).
- A VST3 MIDI effect: notes in and notes out (output events from `ProcessData.outputEvents` back into the chain).

## Before testers (DEV)

1. The DEV deploy builds the desktop devices (`packages/app/desktop/devices/build.sh`, nightly + rust-src in CI),
   else the desktop build has no native device and every plugin stays silent. Rerun the failed DEV deploy.
2. First run of `desktop.yml`: installers have never been built, Windows and Linux have never compiled.
3. A small macOS group gets unsigned builds with instructions (Gatekeeper blocks or calls the app damaged).

## Finding plugins and plugin types (next, in this order)

**Finding plugins**
1. Folders: the system defaults plus the user's own folders, kept by the studio, sent with every scan request.
2. Scan process: bundles without `moduleinfo.json` are described by the engine binary run as `--scan <bundle>`, a
   separate process with a timeout. A plugin that crashes it is marked "failed", the engine is never at risk.
3. Scan cache in the app data folder (path + modification time), only new or changed bundles are scanned again.
4. Architecture check from the binary header: an Intel-only plugin on Apple Silicon is "not compatible".
5. A plugin that took the engine down while loading is marked "crashed" (a marker written before loading, cleared
   after), until it is rescanned.
6. "Manage Plugins…" (desktop): folders (add, remove), Rescan, every plugin with its status.
7. The Plugins menu: Instruments and Effects, grouped by vendor.
8. Scanning never runs on the engine thread: requests and results travel on the `/native` socket.

**Types**
- Instrument: VST3 sub-category "Instrument". Effect: "Fx". MIDI effect: no category of its own, recognised by its
  buses (events in and out, no audio), which the scan records.
- Audio effects: `NativeEffectBox`, adapter, desktop effect device (audio through the plugin, passthrough while not
  ready), browser keeps a silent placeholder with all its boxes (check the browser engine passes an unknown effect).
- MIDI effects: `NativeMidiEffectBox`, the plugin's output events (with sample offsets) go back into the chain.
- Latency: shown first, compensated later (engine-wide delay compensation).

## Gaps that change things

1. **Signing vs. plugins (macOS):** a signed, notarized app runs with the hardened runtime, which refuses third-party
   code unless the engine carries `com.apple.security.cs.disable-library-validation`. Signing, notarization and that
   entitlement decide whether plugins load at all in a public build. Windows: SmartScreen trust.
   2026-10-17: test builds are ad-hoc signed without the hardened runtime (`signingIdentity: "-"`,
   `hardenedRuntime: false`), so macOS asks "Open Anyway" instead of calling the app damaged. With the hardened
   runtime the engine dies at once (V8 cannot reserve its JIT code range), so notarization needs the runtime with
   `allow-jit`, `allow-unsigned-executable-memory` and `disable-library-validation` on the engine.
2. **Export is silent for plugins:** mixdown and stems render in the webview engine, which has no native plugins.
   Export must render in the native engine (phase 6) before plugins are usable.
   **Done 2026-10-17:** offline renders run in the engine process (a thread and an isolate per render, the unchanged
   offline worker), plugins render through a copy per render with the live instance's current state, VST3 offline mode.
3. **A plugin crash kills the engine, no recovery:** the studio must notice, restart the engine and mark the plugin
   that crashed. Much earlier than the optional sandbox (phase 8).
   **Done 2026-10-17, like the browser:** the shell starts a new engine process, the studio shows "Audio-Engine Error"
   with "Restart Engine". A plugin that crashes on load crashes the engine again, as in the browser. Not marked yet.
4. **Plugins without `moduleinfo.json` are invisible:** older VST3 bundles ship none, a scan process that loads them
   safely is needed (phase 1).
5. **Intel-only plugins on Apple Silicon:** an arm64 engine cannot load x86_64-only binaries, the scan checks the
   architecture and reports "not compatible" instead of failing silently.
6. **No plugin windows on Windows and Linux:** loading is written but untested there, "Open UI" does nothing.
   **Written 2026-10-17, compiles, never run:** Windows: a Win32 window per editor (`HWND`), a message loop on the
   engine's main thread (`MsgWaitForMultipleObjects`, 5 ms), DPI aware with `setContentScaleFactor`, topmost while the
   studio or the engine is in front and no studio dialog is open (the shell passes `OPENDAW_SHELL_PID`). Linux: an X11
   window per editor (libX11 via `x11-dl` at runtime, `X11EmbedWindowID`), the frame offers `Linux::IRunLoop`, the main
   thread polls the X11 connection and the plugins' descriptors and fires their timers. No staying in front on Linux,
   no shortcut forwarding from plugin windows on either. CI also builds ARM64 Linux (testable in UTM).
7. **Latency compensation:** plugins with latency (effects) play late, the engine has no delay compensation for them. Planned for the browser and desktop alike: `plans/latency-compensation.md`.
8. **Effects and MIDI effects** (see "To test").
9. **Unresolved: studio keys in plugin windows.** Keys a plugin leaves unused reach the studio only if its window passes
   them on (JUCE does). DPF/pugl windows (Cardinal) keep every key, so the software keyboard and shortcuts stop while
   such a window has focus. No signal fits all plugins: DPF answers `IPlugView::onKeyDown` truthfully but never passes
   keys on, JUCE passes keys on but answers `onKeyDown` with kResultFalse even while typing into its own text field.
   Ideas so far (both rejected for now): software keyboard keys win while its panel is open, or a per-window switch
   "keys go to openDAW / to the plugin" (Reaper).
10. **Unresolved: studio menus under plugin windows.** Context menus and in-page dropdowns are HTML inside the main
    window, a plugin window is a native window floating above it, so a menu opened where a plugin window overlaps stays
    hidden behind it. Lowering plugin windows (like for dialogs) is not wanted for menus, they open constantly. Idea so
    far (rejected for now): show `MenuItem` trees as native popup menus on desktop (default items map one to one,
    headers as macOS section headers via AppKit, menus with an `input-value` slider such as the metronome stay HTML).
11. **Follow up if it happens again: Surge XT presets silent on Windows.** Seen once 2026-10-17 in the Windows VM
    (x64 build under emulation, desktop-test-9/10): switching a preset changed Surge's window, the sound stayed the
    default patch, sliders and pitch worked. Fine on macOS, and on the next try in the VM too. Suspect a race: after the
    preset change the engine reads the new state, an older state from the studio arriving then is applied again
    (`set_state` / `apply_later`, `is_known`). Needs a log first (Windows discards the engine output, no log file yet).

Order: devices in the deploy + `desktop.yml` + unsigned macOS builds for a small group, in parallel signing and
notarization with the entitlement and engine crash recovery; native render for export is the biggest feature gap
before a wider test.

## Progress
- 2026-10-16 phase 0 (scratchpad spike, `vst3` 0.3 + libloading + objc2-app-kit, ~300 lines): ABL3x loads
  (`bundleEntry` with a CFBundle, `GetPluginFactory`, separate controller class, connection points), takes note
  events through a Rust `IEventList`, renders 3 s in 65 ms (58 µs per 128-frame block, debug host), peak 0.42.
  `setBusArrangements(stereo)` answers kResultFalse, the default stereo out works anyway. Editor: NSView supported,
  1508x552, `attached` to an NSWindow content view on the main thread with `NSApplication.run`. No IMessage /
  IAttributeList support in the host yet (`IHostApplication.createInstance` returns kNotImplemented), ABL3x does not need it.
- Spike findings: with `kPlaying` in the ProcessContext ABL3x runs its own pattern sequencer and ignores note events,
  with the transport stopped it plays the host's notes on time. The real host must report the actual transport state.
  The editor margins are drawn by ABL3x itself (same in Bitwig), the view fills the window exactly.
  Closing must be handled by the host: the spike had no window delegate and no app menu, so neither the close button
  nor Cmd+Q ended it. The real host needs a window delegate (`removed()`, release the view) and must never take the
  engine down with a closed editor.
- 2026-10-16 phase 2 slice (instrument, UNCOMMITTED, app-untested):
  - Shared, by decision: `NativeInstrumentBox` (format, plugin-id, state, parameters, plugin-name, vendor) in the
    schema + Rust registry, `NativeInstrumentBoxAdapter`, `NativeDeviceEditors` strategy whose default is the browser
    placeholder ("VST not available in the browser"), `WasmEngineAttachment.hostImports` (generic, only the desktop
    host sets it). The browser engine has no device for the box type, the unit is torn down silent, boxes are kept.
  - Desktop only: `packages/app/desktop/devices` (own workspace, `device-native-instrument`, own `host_native_*`
    imports, `build.sh` -> `dist/`, copied by the desktop vite build to `wasm-engine/wasm/desktop/`),
    `EngineHost` + `NativePlugins.ts` (device module + imports, notices, scan, gui envelopes), engine `plugins.rs`
    (scan via moduleinfo.json, load/edit on main thread, process on the engine thread writing straight into wasm
    memory, state = "ODV3" + component state + controller state, base64 in the box, saved 300 ms after an edit and
    on window close), macOS main thread runs NSApplication with a 5 ms CFRunLoopTimer for the main requests,
    `NativePluginHost` + `NativeInstrumentEditor` + "Plugins" menu in the native menu bar.
  - Web build checked: no desktop code, only the placeholder text and the box type name.
  - Open: `devices/build.sh` is not part of the DEV deploy / desktop workflow yet (needs nightly + rust-src);
    scanning runs on the engine thread; plugin windows are plain windows (no floating level).
- 2026-10-16 drop-outs measured (`stats.rs`, engine prints `[stats]` once per second on underruns or skipped plugin
  blocks): the plugin took ~120 µs, the whole render peaked at 3.6-7.7 ms exactly in the seconds with a state save.
  Cause: every knob turn saved the plugin state (getState 8-9 ms on the main thread, harmless) and wrote the big base64
  string into the box, which the engine applies on its audio thread. Fix: edits only mark the state dirty, it is read
  and written when the editor window closes and before a project save (`ProjectProfileService.addBeforeSave`, a
  neutral hook, desktop registers `NativePluginHost.flush` -> "native-save" -> engine saves dirty plugins -> "saved").
  Open: why one large string field costs the engine milliseconds (affects WebCLAP states as well).
- 2026-10-16 windows (A): plugin windows float (level 3) while the studio or the engine is the frontmost app, normal
  level otherwise (polled every 100 ms in the main tick). Cmd+` (key code 50 = left of 1 on US, left of Y on ISO) is
  caught by a local key monitor in both processes: the shell cycles its own windows, then writes "cycle" to the
  engine's stdin; the engine cycles its plugin windows, then calls `/__cycle-home` and activates the shell.
- 2026-10-16 crash on project load: JUCE (ABL3x) calls `IComponentHandler` from inside `setComponentState`, the handler
  borrowed the editor map the caller held -> RefCell panic inside an `extern "system"` callback -> engine abort.
  Fix: the editor map holds `Rc<Editor>` and is never borrowed across a plugin call, dirty flags live in their own
  set, plugin callbacks run inside `catch_unwind`.
- Parameters (phase 3) follow WebCLAP: one parameter box per VST3 parameter (id, value, range), automation and
  modulation resolved in the engine and passed to the plugin through `IParameterChanges` per block, never via the
  state blob. Box writes only happen for hand edits of a single value.
- 2026-10-16 phase 3 (parameters, UNCOMMITTED, app-untested): the engine reads the controller's parameters on load
  (`read_params`, VST3 flags mapped onto the WclapParamInfo/CLAP bits, range 0..1 or 0..stepCount) and reports them,
  the studio reconciles WclapParameterBoxes on the native box's hub (`WclapParameters.reconcileHub/applyHub`, additive).
  Host values reach the plugin as an `IParameterChanges` list (one point at offset 0, the engine splits blocks at every
  change, so it is sample exact), base values go to the editor through `setParamNormalized` from the main tick.
  Editor edits (`performEdit`) go to the processor at once and to their box, the echo is skipped (`reported`).
  Split: a lone `setDirty` (`IComponentHandler2`, not within 300 ms of an edit) marks only the state, a preset switch
  (`restartComponent` values/titles changed) re-reads every value into the boxes and marks the state.
  Values arriving before the plugin is ready are kept and applied after load, so the boxes win over the saved state.
- 2026-10-16 ABL3x reports 2103 parameters: 22 knobs, Bypass, and 2080 hidden "MIDI CC ch|n" parameters JUCE adds
  (16 channels x 130) because VST3 has no MIDI CC events. Only automatable parameters are reported now.
  The load and state spikes were the notice path: the parameter list (~200 KB JSON) and the base64 state were parsed and
  forwarded by the JS host on the engine thread. Notices now go to the studio over their own socket (`/native`),
  written by its connection thread; known states are tracked in Rust (`KNOWN_STATES`). Delete/Backspace no longer
  navigates back in the desktop webview (`DesktopLifecycle.blockBackNavigation`).
- 2026-10-16 measured with the host's slow-message log: the studio's checksum verification (at most 1/s after any
  transaction, `CHECKSUM_INTERVAL_MS`) cost the engine 8.5 ms on the audio thread, a full re-serialisation of every
  field (1.5 MB here, the plugin state included). Fix in `crates/boxgraph` (shared, web too): each box's 32-byte fold
  and length mod 32 is cached and rotated into place (the rolling XOR is linear), invalidated on set/create/remove.
  Bit-identical, `tests/checksum_cache.rs` checks it against the full fold through creates, edits, deletes, rollback.
- Plugin windows forward the keys their plugin leaves unhandled (own content view at the end of the responder chain,
  Cmd+W closes the window) to the shell (`/__key`), which replays them in the studio, so Space and Cmd+S work.
- 2026-10-16 large string fields (shared `crates/boxgraph`, identical bytes): strings fold straight into the checksum
  (ASCII units are (0, byte), 16 chars per 32-byte block), other bytes fold block-wise, strings serialize and decode
  in one pass with an ASCII fast path, `ByteReader::take` is overflow safe. A 1.1 MB state folds in 0.88 ms instead
  of 8.9 ms (native). `tests/checksum_cache.rs` checks against a naive byte-by-byte reference and round-trips strings.
- 2026-10-16 an editor edit of a modulated parameter: the edit becomes the base at once with the parameter's latest
  modulation added (`Slot.modulation`), host values that still carry the old base use the edited base until its box
  confirms it, at most 1 s (`Slot.edits`). Before, the engine modulated around the old base until the box echo arrived.
- 2026-10-16 the plugin state is a bytes field (`NativeInstrumentBox.state`, ByteArrayField), raw end to end:
  abi `FIELD_KIND_BYTES` + `FieldValue::Bytes` (additive), the engine delivers bytes fields to devices, the device
  passes pointer + length, the host copies the ArrayBuffer, saved states reach the studio as binary messages on
  `/native` (36-char uuid + bytes). No base64 anywhere. `core-wasm/test/bytes-field-checksum.test.ts` proves the
  TS and engine checksums agree for 0 to 600 KB states. Projects saved before this change hold a string there.
- 2026-10-16 opening a project marked it unsaved: loading the saved state made JUCE report all values changed, the
  handler wrote them into the boxes (`editing.modify(.., false)` counts as a change). The handler now ignores
  `restartComponent` while the host itself applies a state (`apply_state_quietly`).
- Native editor looks like the WebCLAP editor (same styles, duplicated with a note): plugin box (name, vendor or
  status), Load Plugin (installed instruments, a switch clears the state), Open UI, Parameters. The Parameters menu
  moved into the shared `ui/devices/ParametersMenu.tsx`, used by both editors (WebCLAP behaviour unchanged).
- 2026-10-17 finding plugins (UNCOMMITTED, app-untested): `engine/src/scan.rs`. Bundles without moduleinfo.json are
  described by `opendaw-engine --scan <bundle>` (a separate process, 20 s timeout, its printed result counts even if
  the plugin crashes while the process exits, e.g. Cardinal, exit 139). Bundles with only private classes (Yamaha DSP,
  category "Private") are not listed. Cache `~/Library/Caches/openDAW/plugins.json` (path + modification time),
  architecture check from the Mach-O header, crash marker set while a plugin loads (`scan::Loading`, cleared on drop).
  Scan requests and results travel on `/native`, never the engine thread. This machine: 3 plugins before, 33 now
  (12 instruments, 21 effects), full rescan ~2 s, cached ~12 ms. Studio: Plugins ▸ Instruments ▸ vendor ▸ plugin,
  "Manage Plugins…" dialog (own folders via the shell's `pick-folder`, Rescan, every plugin with type and status).
- 2026-10-17 BA-1 loads its default preset only when its editor is created and tells the host nothing (probe: 20 of
  46 values change on `createView`), the default box values then overwrote the preset in the processor. A plugin's
  parameters are read again right after its window opens and 500 ms later, changes go to their boxes like a preset
  switch. New plugins (VST and WebCLAP) open their window once ready. Cmd+Q in a plugin window goes to the shell
  (`/__quit`, with the unsaved-changes question), the studio's main window takes the focus back when the last plugin
  window closes. Bundle binaries are found via Info.plist (`CFBundleExecutable`), other bundles (.app) are not searched.
- 2026-10-17 host completeness: output parameter changes (`ProcessData.outputParameterChanges`, 64 parameters x 16
  points, preallocated, cleared per block, dropped for now) and output events (`outputEvents`, 64, dropped for now),
  DPF asserted on every block without them. `IHostApplication.createInstance` creates `IMessage` with an
  `IAttributeList`, DPF plugin windows talk to their audio part through them.
