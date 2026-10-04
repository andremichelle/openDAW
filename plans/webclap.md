# WCLAP (WebCLAP) hosting in openDAW

**Status 2026-10-04**: implemented on branch `webclap` (effect + instrument, webview GUI in a floating
window, state, parameters, automation, modulation, OPFS bundles, cloud backup, `.odb`). NOT production ready,
see "PROD readiness review (2026-10-04)" at the end. The GUI was re-scoped on 2026-09-30 to the webview
iframe (tier 3) in its own window, the canvas tiers below are the long-term direction, not the current state.

Original goal: the user browses WCLAP plugins (online registry, URL, local file), the bundle is cached in OPFS
and included in the cloud backup, and the plugin runs as an instrument or audio effect with automation,
modulation, presets and a canvas GUI drawn from a plugin command buffer.

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
- Live rooms: a bundle travels between peers exactly like samples and soundfonts. `AssetServer` gets a
  third asset type `wclap` (`hasWclap(sha256)` / `readWclap(sha256)` in the `AssetReader`, served from
  `WclapStorage`), `ChainedWclapProvider` next to `ChainedSampleProvider` / `ChainedSoundfontProvider`
  (local OPFS, then a peer, then the bundle's `url`), and `WclapBundles.fetch` resolves `opfs:<sha256>`
  through that chain. Content addressing by `sha256(bundle.tar.gz)` makes the transfer idempotent and
  keeps a peer's browsed-from-disk bundle usable by everyone in the room without a public url. Chunking,
  traffic metering and zip framing are the existing `ChunkProtocol` / `AssetZip`, nothing new on the wire.

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

Superseded the same day: the webview iframe ships first, in its own floating window (see "Production
hardening"). The text below is kept as the long-term direction.

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
6. Cloud backup, missing-plugin recovery, live-room bundle exchange (`wclap` asset type over the
   sample/soundfont peer transfer), offline render + freeze parity (perf worker uses the same bridge
   through `device-linker.ts`).
7. Later: plugin delay compensation in the engine (does not exist for any device today), sidechain ports
   (`clap.audio-ports` aux -> `bind_sidechain`), note expressions beyond tuning, `clap.remote-controls`
   for macro pages, registry integration, `wasm64` when Basics ships one.

## Production hardening (2026-09-30, after the review)

- The plugin page runs in a host frame (`public/wclap-frame.html`) that owns the service worker and relays
  messages, keys, right-clicks and double-clicks. Served from `VITE_WCLAP_ORIGIN` (a second domain such as
  `plugins.opendaw.studio` pointing at the same deployment, CORP `cross-origin` is already set globally) a
  third-party page is origin-isolated from the studio. Empty = the studio's origin, dev default.
- Plugin faults are contained per instance (trap, throw, `proc_exit`, bad function pointers, oversized
  streams): the instance is dropped, the device passes through, the editor shows the reason. Memory is
  capped (256 MB initial, 1 GB maximum), console output is muted after 200 lines.
- Loads join the host's pending resources, so exports and the first render wait for the plugin.
- Parameter boxes are the host's truth: values queued before the plugin is up reach it with the first
  process call, `reconcile` never overwrites them, range changes update mappings in place (links survive),
  and after page traffic the bridge polls `get_value` once (Cmajor emits no parameter events).
- `activate(1..128)` for the engine's sub-chunks, PARAM_MOD cleared when the sum returns to 0, params and
  notes in separate event budgets, echo suppression in f32, transport event (tempo, beats, playing),
  `clap.host-params` (rescan, request_flush), state save between quanta via `wclapRequestSave`, the
  plugin's canonical serialisation as the known state, teardown keeps the state for a re-instantiation.
- `opfs:` bundles travel in `.odb` project bundles and in the cloud backup (`wclaps/<sha256>.tar.gz`).
- The window lives in `WclapWindows` (per device, survives editor rebuilds, closes with the device or the
  project). Open UI toggles, the editor shows loading, ready (vendor) and failed (reason).
- Tests: `core-wasm/test/wclap-bridge.test.ts` over the Basics fixture (`test/assets/basics.wclap.tar.gz`).
- Open: the instantiate chain and `describe` still run on the audio thread (a worker would need its own
  bridge instance), no `clap.latency`, no watchdog for an infinite loop inside a plugin.

### Pointing at a control inside the page (self-enabling, inert with today's plugins)

Right-click and double-click on a control INSIDE the plugin window open openDAW's parameter menu and value
entry, exactly as on a stock device's knob — but ONLY for a plugin that says which control the pointer is
on. The host cannot find that out by itself:

- `clap.param-hovered/1` is the official answer and the bridge offers it as a host extension. No tested
  plugin calls it (Basics, Slide, MNO, Tapa, Clap Saw Demo and Pro54 all carry the clap-helpers string and
  never use it), so the host is told "nothing hovered" forever.
- Reading the page's DOM instead does not work. A plugin's element ids are its own endpoint names while the
  CLAP parameters carry display names: measured on Pro54, 20 of 68 ids match a parameter name exactly and
  fuzzy matching picks confident wrong hits (`OscAPW` scores highest on "Oscillator B Triangle"). Learning a
  binding from the parameter that changes after a click works but needs every control moved once first, and
  an id shared with a container answers for every control. Both were tried and removed.

So the plugin ENABLES it by proving support: the first `update(param_id)` it reports makes the studio hand
right-click and double-click inside its page over to openDAW (`wclap-pointer-enable` to the host frame). A
plugin that never reports keeps its page's own context menu and double-click, and nothing in openDAW is
guessed. WebCLAP plugin authors: call `update(param_id)` on hover and `CLAP_INVALID_ID` on leave, that is
the whole integration.

The openDAW-side handles that always work are the device editor's "Parameters" dropdown (every parameter
grouped by its CLAP module, with automate / modulate / MIDI learn / Enter Percentage) and the automation
lanes.

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

## PROD readiness review (2026-10-04)

Verdict: not ready. `npm run build` and `npm test` green (52 tasks). `npm run lint` fails in `lib-jsx`
(eslint parses `dist/*.d.ts`, not touched by this branch) and stops before the other packages, this branch
included, so they are unlinted. No browser check in this review.

### Blockers

1. Plugin page isolation is not deployed. `VITE_WCLAP_ORIGIN` is set nowhere (no `.env`, nothing in
   `deploy/run.ts`), so a PROD build runs every plugin page on the studio origin with full access to its
   storage, OPFS and cloud session. Needs the second domain (e.g. `plugins.opendaw.studio`) on the same
   deployment with COOP/COEP/CORP headers, `wclap-frame.html` + `wclap-sw.js` served from it, and the env
   variable in the build.
2. No watchdog. Plugin code runs on the audio thread without a time limit, an infinite loop silences the
   whole studio until reload. The instantiate chain (`init`, `activate`, state load) and `describe` also run
   on the audio thread, a heavy plugin drops out the audio while loading.
3. Examples load from mutable upstream urls (`raw.githubusercontent.com/.../main/...`). A changed bundle
   silently alters saved projects, a removed repo breaks them. Pin to commit hashes or mirror on
   `assets.opendaw.studio`.

### Bugs

4. Shared projects (YSync), likely, needs a repro test. Every client's engine runs
   `WclapParameters.reconcile`, which creates `WclapParameterBox`es with `UUID.generate()`, so peers create
   duplicates. Every client also writes `state` via `WclapStates.store` ~100 ms after a change, so peers
   overwrite each other. Only one client (the owner or the editing client) should write.
5. `opfs:` bundles exist only on the machine that browsed them. Without a cloud backup or `.odb` the plugin
   fails elsewhere. The live-room bundle transfer (phase 6, `wclap` asset type) is not built.
6. Browse stores the file in OPFS before `describe` validates it, a non-bundle file stays and cloud backup
   uploads it. Validate first, store after.
7. `pendingParams` is capped at `MAX_PARAM_EVENTS` (128) distinct ids per chunk, including the values queued
   before the plugin is up. A plugin with more than 128 parameters loses the rest at project load (the state
   blob probably restores them).
8. After a contained fault the instance does not retry: `#load` returns early while url and clapId are
   unchanged, recovery needs a url/clapId change or a project reload.

### Plan items not done

Re-scoped on purpose: canvas GUI tiers 1/2 (webview window instead), generic knob editor (Parameters menu
instead), model B shared-memory threading.

Missing:
- `clap.latency`, the `latency` field and delay compensation
- plugin browser (`WclapService`, `WclapBrowser`, `BrowseScope.Plugins`), `FactoryCatalog.plugins()`
  `index.json`, "Add from URL...", drag onto a track
- bundle presets (`clap.preset-load`)
- `EVENT_CHOKE` and `cent` tuning note expressions
- a missing-plugin placeholder (today the device passes through and the editor shows "Failed")
- cloud backup tombstones (deleting a bundle does not sync)

### Housekeeping

- Commit `16d9ea995` ("fix tests") carries an unrelated rollup bump in `package-lock.json`.
- Multi-line comments in `WclapWindows.tsx`, `wclap-bridge.ts` and `WclapDeviceEditor.tsx` break the
  CLAUDE.md comment rule.
- `main` is 3 commits ahead, merge before the PR.
