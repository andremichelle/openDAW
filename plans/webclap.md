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

1. IN PROGRESS 2026-10-06. Code ready: `VITE_WCLAP_ORIGIN=https://opendaw-plugins.studio` in the
   `deploy.yml` build step (declared in `turbo.json` `globalEnv`, else turbo filters it), and the root
   `.htaccess` (`deploy/run.ts`) answers 403 on that host for anything but `wclap-frame.html`, `wclap-sw.js`
   and `wclap/` inside a release folder. Release paths are versioned (`BASE_URL` = `/<env>/releases/<uuid>/`),
   so main and dev need no extra routing. Hosting DONE 2026-10-06: the domain serves from the studio's
   webspace (it had to move into the hosting package before STRATO could assign the certificate), HTTPS live
   with a Sectigo certificate for `opendaw-plugins.studio` + `www`, valid until 2027-04-04. Open: a dev
   deploy of this branch to test the plugin window on the new origin.
   Original finding: plugin page isolation is not deployed. `VITE_WCLAP_ORIGIN` is set nowhere (no `.env`, nothing in
   `deploy/run.ts`), so a PROD build runs every plugin page on the studio origin with full access to its
   storage, OPFS and cloud session. Needs the second domain (e.g. `plugins.opendaw.studio`) on the same
   deployment with COOP/COEP/CORP headers, `wclap-frame.html` + `wclap-sw.js` served from it, and the env
   variable in the build.
2. NOT YET DONE, skipped 2026-10-06, out of scope for PROD (decided 2026-10-07). No watchdog. Plugin code runs on the audio thread without a time
   limit, an infinite loop silences the whole studio until reload. The instantiate chain (`init`, `activate`,
   state load) and `describe` also run on the audio thread, a heavy plugin drops out the audio while loading.
   Ruled out: a plugin worker behind a SharedArrayBuffer (output must arrive in the same block, no latency).
   Candidates if picked up: fuel metering (rewrite `module.wasm` at load so loops and function entries
   decrement a budget and trap, caught by `#contain`, overhead to be measured in node on Basics + Pro54), or
   main-thread hang detection that offers a reload with the device disabled.
3. FIXED 2026-10-06. Examples saved the mutable upstream url (`raw.githubusercontent.com/.../main/...`)
   in the box. Picking an example now downloads the archive once, stores it with `WclapStorage.store` and
   saves `opfs:<sha256>`, like Browse. Another machine needs the bundle via backup, `.odb` or live room (bug 5).

### Bugs

4. FIXED 2026-10-06. Shared projects (YSync): engines reporting the parameters at once created every
   `WclapParameterBox` twice (`UUID.generate()`). Parameter box uuids are now derived from the device uuid
   XOR the clap id, so peers create the same box. 2026-10-07: clap id 0 (Slide) produced the device's own
   uuid ("already staged"), the last byte is now always flipped too. Concurrent `state` writes were fine (last write wins, the
   bridge does not echo a loaded state). Test: `core/src/wclap/WclapParameters.collab.test.ts`.
5. FIXED 2026-10-06 for live rooms. `opfs:` bundles existed only on the machine that stored them. The p2p
   asset path now carries a fourth type `wclap` (raw `.tar.gz`, no zip): `AssetReader.hasWclap/readWclap`,
   `PeerAssetProvider.fetchWclap`, `ChainedWclapProvider` (peer only, no cloud source), attached in
   `P2PSession`. `WclapStorage.load` reads OPFS, else asks the installed remote (`installRemote`, wired in
   `boot.ts`), accepts the archive only if its sha256 url matches and stores it. `.odb` export loads through
   the same path. Outside a room a missing bundle still fails (no cloud source). Tests:
   `p2p/src/__tests__/AssetServer.test.ts`, `ChainedProviders.test.ts`, `core/src/wclap/WclapStorage.test.ts`.
   Not tried between two browsers.
6. FIXED 2026-10-06. Browse stored the file in OPFS before `describe` validated it. Now the archive is
   registered in memory under its `opfs:<sha256>` url (`WclapBundles.register`), described, and written to
   OPFS only once a plugin of the device's kind was chosen.
7. FIXED 2026-10-06. `pendingParams` dropped every id beyond 128, including the values queued before the
   plugin is up. The queue is now unbounded (one entry per id), each chunk writes at most `MAX_PARAM_EVENTS`
   parameters and the rest go out in the next chunks, unknown ids do not count. Test in
   `wclap-bridge.test.ts` (the carry-over across chunks is untested, Basics has too few parameters).
8. FIXED 2026-10-06. After a failed load or a contained fault, `#load` returned early while url and clapId
   were unchanged. It now returns early only while the plugin is loaded or loading, so a rebind (the device
   re-sends its fields) reloads it. Tests in `wclap-bridge.test.ts`. A "Reload" button in the editor's
   failed state would need a new engine command, not done.

### Failure handling (FIXED 2026-10-06)

- A failed load showed only in the device editor. `WclapFailures.report` (called from `EngineWorklet` on every
  status) now toasts once per failure with device label, clap id and reason. Test `WclapFailures.test.ts`.
- In a live room a bundle no peer holds kept the request pending forever, the device stayed "loading" and
  `queryLoadingComplete` (export, offline render) never resolved. `wclap` requests now fail after
  `WCLAP_DISCOVERY_TIMEOUT_MS` (5 s) without an inventory answer, re-armed on retry, other asset types
  unchanged. Test `p2p/src/__tests__/WclapDiscoveryTimeout.test.ts`.
- `.odb` export failed as a whole on a bundle missing from OPFS. It now leaves missing bundles out and
  toasts how many. Test `core/src/project/ProjectBundle.wclap.test.ts`.
- Cloud backup: every bundle in OPFS (examples and peer-received ones included) is uploaded and restored.
  A downloaded bundle is now stored only if its sha256 matches its id. Tests `CloudBackupWclaps.test.ts`.

### Bundle library + deletion (2026-10-06)

- Dashboard tab "WebCLAP" (`ui/browse/WclapBrowser.tsx`, in `dashboard/Resources.tsx`): every stored
  bundle with its plugin names and vendor, size, a search field (same filter row as the other browsers),
  right-click "Delete Forever…" with a confirm that warns projects will pass through. Names come from
  `createWclapDescriber` (exported by `studio-core-wasm`), a bridge on the main thread that runs only entry
  init and the descriptor walk, since the dashboard has no engine.
- Delete is for good, no trash. Newest action wins: `wclap/<id>/meta.json` holds `storedAt` (store, peer
  receive, `.odb` import, cloud restore keeps the cloud time), `wclap/tombstones.json` holds `deletedAt` per
  id (`WclapStorage.remove`). Backup merges local and remote tombstones (`wclaps/tombstones.json`, max per
  id), the catalog `wclaps/index.json` is now `{id: storedAt}` (an old id array reads as stored at 0), and a
  bundle is dead where `deletedAt >= storedAt`: dropped locally (`discard`), deleted in the cloud, never
  restored. Re-adding the same file later revives it everywhere.
- `.odb` import now verifies each bundle's sha256 before storing it.
- Tests: `WclapStorage.test.ts`, `CloudBackupWclaps.test.ts`, `ProjectBundle.wclap.test.ts`. The tab itself
  is untested in the browser.

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
- offline render waits for every WebCLAP plugin to finish initializing, if it needs to: today
  `offline-worker.ts` only awaits the bridge's tracked load promises (`pending`, `queryLoadingComplete`),
  a plugin that is instantiated but still starting up (e.g. a Cmajor patch building its engine) may render
  silence or passthrough into the first blocks of the export (not yet verified). Needs a per-plugin "ready" signal from the
  bridge that the render loop awaits before the first block, with a timeout that fails the export loudly

### Plugin origin (blocker 1)

Use a separate registrable domain, not a subdomain of `opendaw.studio`, `opendaw-plugins.studio` (the
`githubusercontent.com` / `googleusercontent.com` pattern, the name itself is free):
- Chrome's site isolation is per site (eTLD+1). A subdomain shares the studio's renderer process, and since
  the studio is cross-origin isolated (SharedArrayBuffer, precise timers), a hostile page next to it is the
  worst case for Spectre-style reads.
- A subdomain can set cookies for `.opendaw.studio` (cookie tossing) and counts as same-site, so
  `SameSite` does not protect against it.
- The name tells users and reviewers the code there is third-party, not openDAW's.
- Do not reuse `assets.opendaw.studio`.
The domain needs the same COOP/COEP/CORP headers, serves only `wclap-frame.html` and `wclap-sw.js`, and the
build sets `VITE_WCLAP_ORIGIN`. A subdomain is still far better than today's same origin if a second domain
is not possible.

### Switching the plugin of a device with links (2026-10-07, TESTED by André in the browser)

Picking another plugin in a WebCLAP device that already has automation, modulation or MIDI learn on its
parameters. `WclapParameters.reconcile` deletes every `WclapParameterBox` whose clap id the new plugin does
not have, and those boxes are the targets of automation tracks, modulation and MIDI learn. Check with a
test first, then decide:
- whether deleting the parameter boxes takes the automation tracks, regions and modulation connections with
  them, leaves them dangling (a validation panic), or keeps them pointing at nothing
- whether undo of the plugin switch brings the parameter boxes and their links back intact
- what the user should get: a confirm dialog naming what will be lost, keeping links for clap ids both
  plugins share (same plugin, new version), or moving links to the new plugin where ids match
- the same for a plugin update that drops or renumbers parameter ids (`params.rescan`)

### openDAW cloud plugins (planned 2026-10-07)

Goal: the WebCLAP bundles we may redistribute live in the openDAW cloud, next to the stock samples and
soundfonts, instead of the mutable GitHub urls the Examples menu used.

- Hosting: `assets.opendaw.studio/wclaps/<id>.tar.gz` plus `assets.opendaw.studio/wclaps/index.json`.
  `<id>` is the same content id as everywhere else (`UUID.sha256` of the archive), so a cloud plugin picked
  in a project is stored as `opfs:<id>` like any other bundle.
- Index: the same folder tree as samples and soundfonts, `{version: 1, updatedAt, folders: [{name, folders?,
  wclaps?: [{uuid, name, size, url, license, plugins: [{clapId, name, vendor, features}]}]}]}`. `uuid` is the
  content id, `url` the source the bundle came from. Plugin names come from the describer at upload time, so
  the studio lists them without downloading anything.
- Only redistributable bundles (MIT/ISC, checked per bundle): Signalsmith Basics (6 plugins), Charlie
  Culbert's Slide, MNO, Tapa (ISC, per the char-wclaps README, the repo's MIT covers only its metadata) and
  the Surge team's Clap Saw Demo (MIT). Not hosted: Pro54 (Cmajor example, GPLv3/commercial, a port of
  Native Instruments' Pro-53).
- Uploading and curating happens in the admin tool (`admin.opendaw.studio`, its own repo), which gains two
  catalogues beside Samples: Soundfonts and WebCLAP. Its `AdminApi` and PHP already take a `catalogue`
  parameter. Per catalogue: an entry model, rows and columns, an upload path (WebCLAP: hash, describe with
  `createWclapDescriber`, store `wclaps/<uuid>.tar.gz`), delete, and a header switch.
- Loading: `WclapStorage.load` asks OPFS, then the cloud (when the index lists the id), then a peer in a live
  room. A project with a cloud plugin opens on any machine, no backup needed.
- Dashboard tab: a cloud / user filter like the sample and soundfont browsers. Cloud lists the index (no
  delete), user lists OPFS (with "Delete Forever…").
- Device editor: the Examples button and the user-folder button make way for one dropdown like the
  soundfont editor: "Cloud" (cloud icon) and "Local" (user-folder icon) submenus with the plugins of the
  device's kind, and "Import WebCLAP..." (the former Browse button).
- Status 2026-10-07: studio side DONE (tsc + tests, not browser-verified): `opendaw-api/WclapIndex.ts` +
  `OpenWclapAPI.ts` (a missing index is an empty catalogue, no endless retry), load chain OPFS → cloud →
  peer in `boot.ts`, tab filter, editor dropdown "Select Plugin". Admin catalogues next (new `soundfonts` and
  `wclaps` tables).
- The live soundfont index (`assets.opendaw.studio/soundfonts/index.json`, read by every studio) must not
  break. Rules for the admin work:
  1. The published shape stays byte-compatible with `SoundfontIndex` in the studio: leaf key `soundfonts`,
     entries `{uuid, name, size, url, license}`, nothing added or renamed.
  2. The admin's boot reconcile drops every index entry the database does not know. With a new, empty
     `soundfonts` table that would empty the catalogue on the next publish. So the table is seeded from the
     live index first (a migration that reads `index.json` and inserts every entry), and reconcile refuses
     to run, with a message, while the table is empty.
  3. The soundfont files on the asset host are never moved or renamed, the table only describes them.
  4. Before the first soundfont publish, the published file is compared against the live one: only the
     intended differences, otherwise no publish. `publish-index.php` keeps the previous file as
     `index.<timestamp>.json`, which is the rollback.
- Status 2026-10-07: admin catalogues built, UNCOMMITTED in `admin.opendaw.studio` (tsc + vite build green,
  not run against PHP or the database). `sql/catalogues.sql`, endpoints `list-catalogue.php`,
  `upload-asset.php` (checks the content id), `update-asset.php`, `delete-asset.php`,
  `seed-soundfonts.php`, `publish-index.php` with per-catalogue leaf keys, `src/model/Catalogue.ts`, header
  switch, `AssetRow`, `AssetEditor`, `AssetUploadDialog`, `WclapDescribe` (copy). Verified: the live sample
  index (1062 entries) + trash and the live soundfont index (7) round-trip identically through the new model.
  The reconcile refuses to run on an empty table next to a published index and offers the soundfont seed.
- FIXED 2026-10-07: cloud downloads failed "does not match its id". Apache served `.tar.gz` as
  `Content-Type: application/x-tar` + `Content-Encoding: gzip`, so `fetch` unpacked it and the studio hashed
  the raw tar. The host adds that encoding at server level (`RemoveEncoding` and `Header unset` in
  `wclaps/.htaccess` had no effect), so bundles are now stored as `wclaps/<uuid>.wclap`: the admin uploads
  under that name and renames old `*.tar.gz` on publish (`migrate_bundle_extension`), `OpenWclapAPI.load`
  requests `.wclap`. The two `.htaccess` blocks on the server are dead, remove them by hand.
- The admin carries a minimal copy of the describer (WASI shim + descriptor walk) because the published
  `@opendaw/studio-core-wasm` (0.0.18) predates `createWclapDescriber`. TODO after the next SDK publish:
  replace the copy with `createWclapDescriber` from the package and delete it.
- WebCLAP ids in the admin use the lib-std rule (`UUID.sha256`: first 16 digest bytes with the version-4
  and variant bits set). The admin's `SampleUpload.hashUuid` takes the raw digest, so its sample ids differ
  from what the studio computes for the same file. Samples are left as they are, to be decided separately.

### SDK impact

`studio-core`, `studio-core-wasm` and `studio-adapters` are published and carry the whole audio side (boxes,
engine bridge, `WclapBundles`, `WclapStorage`, the `wclap*` calls on `EngineFacade`). The window
(`WclapWindows.tsx`, `wclap-frame.html`, `wclap-sw.js`, `VITE_WCLAP_ORIGIN`) lives in the private
`app-studio`.
1. Headless audio is unaffected by blocker 1. The plugin runs in the worklet in its own memory and only
   reaches the WASI shim (console, random, clock) and our host callbacks: no DOM, network or storage.
2. Blocker 2 applies to SDK users as well: a hanging plugin freezes their audio thread, loading can drop out.
3. A plugin window means rebuilding `WclapWindows`, the frame and the service worker. Served from their own
   origin they inherit blocker 1. To support it, publish frame + worker as package assets and document that
   a separate plugin origin is required.
4. `EngineWorklet` writes `WclapParameterBox`es and the `state` field into the box graph by itself (no undo
   mark). Code observing or syncing the graph sees writes it did not make, bug 4 hits SDK sync too.
5. Loading a project fetches the bundle urls in its device boxes, an untrusted project can make the app
   request arbitrary urls (tracking beacon).
6. The `wclap*` `EngineFacade` methods and the RPC types in `protocols.ts` become public API on the next
   publish. Mark them experimental or hold them back from that release.
7. `@opendaw/studio-p2p` is published: `AssetReader` (`hasWclap`, `readWclap`) and `P2PSessionContext`
   (`chainedWclapProvider`) gained required members, a breaking change for SDK code that builds a session.

### Housekeeping

- Commit `16d9ea995` ("fix tests") carries an unrelated rollup bump in `package-lock.json`.
- Multi-line comments in `WclapWindows.tsx`, `wclap-bridge.ts` and `WclapDeviceEditor.tsx` break the
  CLAUDE.md comment rule.
- `main` is 3 commits ahead, merge before the PR.
