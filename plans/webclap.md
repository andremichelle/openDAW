# WCLAP (WebCLAP) hosting in openDAW

**Status 2026-09-30**: plan only, nothing implemented. Goal: the user browses WCLAP plugins (online
registry, URL, local file), the bundle is cached in OPFS and included in the cloud backup, and the plugin
runs as an instrument or audio effect with automation, modulation, presets and a canvas GUI drawn from a
plugin command buffer (no iframe, decision 2026-09-30, see "GUI: three tiers").

## What a WCLAP is

A CLAP plugin compiled to wasm32 (Emscripten or wasi-sdk via clap-wrapper's wasm target). The module
exports `clap_entry` and `malloc`, owns its linear memory, imports `wasi_snapshot_preview1`. A bundle is a
directory or `.tar.gz` holding `module.wasm` plus optional presets and GUI resources. One module can expose
several plugins through the CLAP factory (id, name, features = instrument/audio-effect/note-effect).

Signalsmith Basics (`basics.wclap.tar.gz`, 217 KB): `module.wasm` (651 KB), `html/index.html`,
`html/matsui-bundle.min.js`, `html/cbor.min.js`. This is the reference plugin for every phase.

| Source | Licence | Use |
|---|---|---|
| free-audio/clap headers | MIT | struct layouts, extension ids (`clap.params`, `clap.state`, `clap.webview/3`, ...) |
| free-audio/web-clap | MIT | WCLAP conventions (bundle, `.tar.gz`, registry idea) |
| WebCLAP/wasi.wasm, wclap-host-cpp | MIT | reference for the WASI shim and host struct handling |
| WebCLAP/wclap-host-js, Signalsmith browser-test-host | NO licence file | read for architecture only, no code taken (ask Geraint Luff if we want to vendor) |
| WebCLAP/wclap-bridge | BSL-1.0 | native bridge, registry format will be defined here |
| WebCLAP/examples (Basics) | MIT | test plugin |

Decision: homebrew host in TS + Rust (as with every stock device), no `host.wasm` from the browser host.
The CLAP C ABI on wasm32 (ILP32, 4-byte pointers, 8-byte aligned doubles/u64) is the whole contract.

## Architecture

```
main thread                              worklet (engine memory)            plugin instance (own memory)
WclapBrowser / WclapService              device-wclap side module           module.wasm (CLAP)
WclapStorage (OPFS wclap/<uuid>/)  --->  WclapLoader RPC (bytes)   --->     WebAssembly.Module cache
WclapDeviceBox + WclapParameterBox       WclapBridges (JS, like NamBridges) clap_plugin (per device uuid)
editor: canvas (tier 1) or generic       host_wclap_* env imports           WASI shim
UI instance (model A) / shared (model B)
```

The plugin cannot join the engine memory (own memory, Emscripten/WASI layout), so it runs as its own
`WebAssembly.Instance` next to the engine, exactly the NeuralAmp pattern (`nam-bridge.ts`): the Rust
side-module does the openDAW side (parameter binding, event pull, sub-blocks) and calls `host_wclap_*`
imports, the JS bridge marshals into the plugin memory. Per 128-frame chunk two memcpy per channel.

### Storage and browsing (main thread)

- `WclapStorage extends Storage` (`packages/studio/core/src/wclap/`), OPFS folder `wclap/<uuid>/`:
  `bundle.tar.gz` (as fetched, the backup unit), unpacked files (`module.wasm`, `html/...`), `meta.json`.
  `uuid = sha256(module.wasm)` (content-addressed like soundfonts).
- `WclapMeta`: name, vendor, version, url (origin for re-fetch), license, size, `plugins: [{clapId, name,
  features, hasGui}]` read once by instantiating the module off-thread (worker) at import time.
- Import paths: URL to a `.tar.gz` (CORS required), local `.tar.gz`, local directory (`showDirectoryPicker`).
  Unpack homebrew: `DecompressionStream("gzip")` + a ~60 line ustar reader. No dependency.
- `WclapService extends AssetService` (like `SoundfontService`): local list, remote catalog, import,
  delete with trash ids.
- Browser: `BrowseScope.Plugins`, `WclapBrowser` on `ResourceBrowser` like `SoundfontBrowser`.
  Online tree = `FactoryCatalog.plugins()`, first an openDAW-hosted `index.json` (curated, MIT/GPL-clear
  plugins), later the free-audio registry when its JSON format exists. Drag a plugin onto a track or the
  effect chain, or "Add from URL..." in the add-device menus.
- Cloud backup: `CloudBackupWclaps` mirroring `CloudBackupSoundfonts` (upload `bundle.tar.gz` per uuid,
  `wclaps/index.json`, tombstones), wired into `CloudBackup.backupWithHandler`.
- Project load with a missing plugin: the device box carries `uuid`, `url`, `clapId`; the service
  re-fetches from `url`, else the device stays a silent placeholder (Unknown-device style) keeping its
  state blob and parameter boxes so nothing is lost.

### Box model

- `WclapAudioEffectBox` (`DeviceFactory.createAudioEffect`) and `WclapInstrumentBox`, fields:
  `plugin` (string uuid), `clapId` (string), `url` (string), `state` (`bytes`, the `clap_plugin_state`
  blob), `parameters` (field accepting `Pointers.Parameter`, the Werkstatt pattern),
  `latency` (int32, reported by the plugin).
- `WclapParameterBox` like `WerkstattParameterBox` plus `clapParamId` (int32), `min`, `max`, `flags`
  (automatable, modulatable, stepped, hidden). `value` is the automatable float in plain CLAP units.
- The parameter list is created when the plugin first instantiates (worklet -> main message with the
  `clap_param_info` list) and reconciled by `clapParamId` on every later load. `params.rescan` from the
  plugin updates the boxes, orphaned automation stays on its box (same as every DAW).
- Adapter: `ParameterAdapterSet` over the collection (as `ScriptDeclaration.subscribeScriptParams`),
  value mapping from `min/max/stepped`, labels via `value_to_text` cached from the plugin.
- Presets: the existing device preset system stores the box, so the state blob + parameter values come
  for free. Bundle presets (`clap.preset-load`) listed in the device menu.

### Engine

- `crates/stock-devices/device-wclap-effect` and `device-wclap-instrument` (a device exports ONE kind),
  sharing `crates/wclap-common`. State: bridge handle, param ids from `observe_param_collection_field`,
  scratch buffers. `process` pulls events, splits sub-blocks at events and update-clock positions, and calls
  `host_wclap_process(handle, in_ptrs, out_ptrs, frames, events_ptr, event_count, block_ptr)`.
- Event records translated by the bridge: `EVENT_NOTE_ON/OFF` -> `clap_event_note`, `cent` -> tuning
  note expression, `EVENT_CHOKE` -> `CLAP_EVENT_NOTE_CHOKE`, `EVENT_PARAM` and the resolved
  `(value, modulation)` pairs -> `CLAP_EVENT_PARAM_VALUE` + `CLAP_EVENT_PARAM_MOD` (mod only for
  `IS_MODULATABLE`, otherwise folded into the value), Block -> `clap_event_transport`.
- `WclapBridges` (`packages/studio/core-wasm/src/wclap-bridge.ts`): per plugin uuid one compiled
  `WebAssembly.Module` (bytes via `WclapLoader` RPC, main thread reads OPFS), per device uuid one instance:
  WASI shim (`fd_write` -> console, `random_get`, `clock_time_get`, `proc_exit`, the rest ENOSYS),
  `clap_entry.init/get_factory/create_plugin/init/activate(sampleRate, 128, 128)/start_processing`.
  Host callbacks: the `clap_host` struct lives in plugin memory, its function pointers are JS closures
  installed into the plugin's exported function table (`table.grow` + `set`). Struct layouts in ONE table
  (`wclap-abi.ts`) with a unit test against offsets printed by a wasi-sdk compiled C snippet.
- Output events (`clap_output_events`): parameter changes from the plugin GUI or internal -> main thread
  -> box field write (undoable, like MIDI learn). `request_restart`/`request_flush` honoured between chunks.
- Rebind keeps the instance (keyed by device uuid, as NAM), `terminate` destroys it. State save on
  every project save through `clap_plugin_state.save` (worklet -> main, into the `state` field).
- Single-threaded only: `clap.thread-pool` not offered, shared-memory plugins rejected at import with a
  message. Plugin memory maximum from the module's own declared limit.

### GUI: three tiers, decided 2026-09-30

Decision: no iframe. CLAP plugins must tolerate a host that does not offer an extension, so a host that
never answers `clap.webview/3` still loads, plays, automates and saves every WCLAP, only its web page is not
shown. The webview GUI story is a draft with no installed base yet, so we push a display-list GUI instead.
The webview relay (~100 lines: iframe `postMessage` <-> worklet port <-> `plugin.receive`/`host.send`,
bundle files served from OPFS via `blob:` URLs) is documented in git history and can return as the lowest
tier if real plugins demand it. Not before phases 0 to 4 shipped and usage says so.

Tier 1: `opendaw.canvas-gui/1`, a CLAP extension (draft, proposed upstream once it runs)
- The plugin exports a UI surface: `ui_create(width, height, dpr)`, `ui_draw() -> (cmd_ptr, cmd_len)`,
  `ui_pointer(x, y, buttons, kind)`, `ui_key(code, mods, kind)`, `ui_wheel(dx, dy)`, `ui_resize(w, h)`,
  `ui_destroy()`. `ui_draw` writes a COMMAND BUFFER in plugin memory (u32/f32 words: move/line/cubic/arc,
  rect, fill/stroke with colour, line width, clip push/pop, transform push/pop, `text(x, y, font_id,
  str_ptr, len)`, `image(handle, ...)`, `hit_region(x, y, w, h, clap_param_id)`), the host replays it onto
  Canvas2D (later WebGPU). Text is rasterized by the host, so no font engine in the plugin. Every command is
  bounds-checked, the plugin never touches DOM, network or script: the sandbox is by construction.
- Host integration is the point: `hit_region` binds a widget to a `clapParamId`, so right-click automation,
  modulation, MIDI learn, value display and reset gesture are openDAW's, identical across plugins, and the
  editor lives in the device panel like a stock device (minimize, zoom, theme).
- Deliverables: `wclap-abi.ts` command replayer + input routing (~1k lines), a C header and a Rust crate
  (`opendaw-canvas-gui`) with a minimal widget kit (knob, slider, button, label, meter), needed anyway
  for our own future wasm devices.
- Toolkit backends make "any CLAP" possible: JUCE `LowLevelGraphicsContext` and VSTGUI `CDrawContext` are
  already display lists (fill path, draw image, set font, draw text, clip). One backend per toolkit that
  emits our command buffer and feeds `ui_pointer`/`ui_key` into the component tree gives every JUCE or
  VSTGUI CLAP a canvas UI without touching the plugin. Written once, lives outside this repo.

Tier 2: `WclapGenericEditor`, built from the parameter boxes with `ControlBuilder` knobs (house style).
This is every plugin without tier 1, so it must be good: groups from `clap.params` module paths, stepped
values as menus, `value_to_text` labels, `clap.remote-controls` pages as tabs when offered.

Tier 3 (not planned): webview iframe, see above.

### Threads: the real constraint behind "compile any CLAP"

A WCLAP is ONE `module.wasm` holding DSP and GUI code (there is no second wasm for the UI, the webview
GUI is HTML/JS next to the module). Natively both run in one address space on two threads and JUCE
editors reach into the processor object directly. In the browser audio runs in the worklet and the UI on
the main thread, different contexts. Two models:

A. Two instances of the same module, one per context, talking only through the host (param events,
   state blob, broadcast slots for meters). Clean, matches the CLAP philosophy, cheap to host. Breaks any
   plugin whose editor touches the processor directly, i.e. most JUCE plugins.
B. One instance over SHARED memory with wasm threads (Emscripten pthreads model, wclap-host-js `shared`
   mode): the module is instantiated in both contexts over one shared `WebAssembly.Memory`, the main
   thread runs the GUI exports, the worklet runs `process`, exactly like native. Needs the plugin built
   with `-pthread`/shared memory, its own allocator and atomics, and our cross-origin isolation (already
   in place for SharedArrayBuffer). Harder host, but the only path that makes "any CLAP" true instead of
   "any well-behaved CLAP".

Decision: the host supports both, chosen per plugin from the module's memory import (shared or not).
Model A is the phase 3 baseline (Basics is not built shared). Model B is a phase 0 question and a phase 5
deliverable. The canvas extension is a pure drawing contract either way, threading stays the plugin's own.

## Phases

0. Spike (lab page, `packages/app/lab`): fetch + unpack Basics, instantiate in a worklet with the WASI
   shim, enumerate plugins and params, run `process` on a test tone, play it. Answers: does the module
   import or export memory, is the function table exported and growable (host callbacks), SIMD ok,
   allocation during process, cost per instance. Second question: rebuild Basics (MIT, source available)
   with `-pthread` and instantiate it over one shared `Memory` in main thread AND worklet (model B), call
   a main-thread export while `process` runs in the worklet. Nothing else starts before Basics plays.
1. Storage + import + browser + `FactoryCatalog.plugins()` with a first `index.json` (Basics).
2. Box model, adapters, factories, generic editor (tier 2), add-device menu entries. Silent until phase 3.
3. Engine bridge, model A: notes, audio, params, transport, state save/load, presets. Basics plays in a
   project.
4. Automation/modulation/gesture events, plugin param feedback into the box, `latency` field.
5. Canvas GUI (tier 1): `opendaw.canvas-gui/1` header + Rust crate + widget kit, host replayer and input
   routing, a canvas build of Basics as the proof. Model B host (shared memory) if phase 0 said yes.
6. Cloud backup, missing-plugin recovery, offline render + freeze parity (perf worker uses the same
   bridge through `device-linker.ts`).
7. Later: plugin delay compensation in the engine (does not exist for any device today), sidechain ports
   (`clap.audio-ports` aux -> `bind_sidechain`), note expressions beyond tuning, `clap.remote-controls`
   for macro pages, registry integration, `wasm64` when Basics ships one.

## Risks

- `opendaw.canvas-gui/1` is our own draft: until adopted upstream, only plugins built for openDAW (or
  through the toolkit backends) get a tier 1 UI. Tier 2 must carry everything else.
- CLAP struct layouts hand-derived: mitigated by the offset unit test in phase 0/3.
- Plugins allocating inside `process` (Emscripten malloc) can jank. Their problem, but we log it in the lab.
- No WCLAP host library has a usable licence yet, hence homebrew.
- Model B (shared memory + threads) is the hardest host piece and unproven in any browser WCLAP host we
  know of beyond wclap-host-js's `shared` flag. If phase 0 says no, "any CLAP" narrows to plugins whose
  GUI talks to the DSP only through CLAP params and state (model A).
- Surge XT is not a WCLAP today (surge issue #8581 explores it, `process()` locks and spawns a patch
  thread). This plan makes openDAW ready for it without any Surge-specific code.

## Reference: how the WCLAP webview UI works (tier 3, not built)

The plugin does not draw anything. It ships an HTML/JS page in its bundle and implements
`clap.webview/3`: `get_uri()` names the start page (relative into the bundle, or `data:`), `get_resource
(path)` streams any bundle file with its MIME type, `receive(buffer)` takes a message from the page. The
host implements `send(buffer)`, which pushes a message to the page. The host opens the page in a webview
(browser: an iframe) and relays: a page message arrives as `window.parent.postMessage(bytes)` and is handed
to `plugin.receive`, a `host.send` becomes a `MessageEvent` with an `ArrayBuffer` in the page. Both
directions are opaque binary, the protocol is the plugin's own (Basics: CBOR "merge" objects for parameter
values and meters, a `"ready"` handshake on load). The page has no access to the plugin memory, the host
or the DAW. Everything is declared main-thread in CLAP, in a single-threaded instance that means "between
process calls in the worklet". Kept here so the tier 3 decision can be revisited with the facts at hand.

## Why the iframe was dropped (discussion 2026-09-30)

- A webview UI is foreign to the device panel: no shared knobs, no right-click automation/modulation/MIDI
  learn, own focus and keyboard handling, per-plugin look, an iframe per instance.
- The canvas extension gives a stricter sandbox (command buffer, no script) AND host integration
  (`hit_region` -> `clapParamId`).
- Compatibility cost is bounded: today's WCLAPs are few, their UIs are drafts, Basics' own page is a
  generic parameter list, and tier 2 covers small plugins. Large synths would need tier 1, which we make
  cheap with the widget kit and toolkit backends.
- Surge XT is not a WCLAP today (surge issue #8581 explores it, `process()` locks and spawns a patch
  thread). Model B (shared memory + threads) is what a Surge build would need, another reason to answer
  it in phase 0.
