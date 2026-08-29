# openDAW Introduction

This document maps every component of the repository and how they depend on each other. It is meant as the entry
point for anyone who wants to understand the codebase before touching it. For installation and prerequisites see
[README.md](README.md).

Deployment and server components are intentionally left out here.

---

## Bird's Eye View

openDAW is a monorepo with two build systems living side by side.

1. A **npm workspace** (`packages/**`) driven by [turborepo](https://turborepo.com), holding all TypeScript.
2. A **cargo workspace** (`crates/`) holding the Rust audio engine and every stock device, compiled to WebAssembly.

The TypeScript side is organised in four layers. Each layer may only depend on the layers above it.

```
   config        build tooling shared by every package
     |
   lib/*         generic, DAW-agnostic libraries (std, dom, jsx, dsp, box, ...)
     |
   studio/*      DAW domain: box schemas, adapters, project model, engines
     |
   app/*         deployable applications (studio, lab, desktop Tauri shell)
```

The Rust side mirrors the same idea. Small leaf crates (`math`, `dsp`, `value`) feed shared infrastructure
(`engine-env`, `processors`), which feeds the `engine` cdylib and the `stock-devices/*` cdylibs.

The bridge between both worlds is `@opendaw/studio-core-wasm`. It compiles the cargo workspace, wraps the resulting
`.wasm` modules, and exposes them to the app as an audio worklet processor.

---

## Repository Layout

| Path | Content |
|------|---------|
| `packages/config` | Shared eslint and tsconfig bases |
| `packages/lib` | Generic libraries, published to npm under `@opendaw/lib-*` |
| `packages/studio` | DAW domain packages, published under `@opendaw/studio-*` |
| `packages/app` | Web applications, not published |
| `crates` | Cargo workspace, WASM audio engine and devices |
| `docs` | Deep dives on single subsystems |
| `plans` | Design documents written while implementing features |
| `errors` | Captured production error reports |
| `scripts` | Maintenance scripts (certificates, sample conversion, model download) |
| `assets`, `assets.opendaw.studio` | Static assets and inference model metadata |
| `test-files` | Fixtures for tests and manual verification |

---

## Layer 0: Config

### @opendaw/typescript-config
No dependencies. Provides the `tsconfig` bases every other package extends.

### @opendaw/eslint-config
No dependencies. Provides the shared eslint rules.

Both are devDependencies everywhere and never end up in a bundle.

---

## Layer 1: Libraries (`packages/lib`)

These packages know nothing about music production. They are reusable in any web project.

| Package | Depends on | Purpose |
|---------|-----------|---------|
| `lib-std` | none | The foundation. `Option`, `Optional`, `Nullable`, `Terminable`, observables, notifiers, `UUID`, `Arrays`, `Bits`, color, geometry, curves, hashing, sorted collections, `tryCatch`. Every other package builds on it. |
| `lib-runtime` | `lib-std` | Async and cross-thread plumbing. `Messenger`, `Communicator` (typed RPC over `MessagePort`), promises, timers, network helpers. |
| `lib-dom` | `lib-std`, `lib-runtime` | Everything that touches the DOM. Events, dragging, keyboard and shortcut management, file access, clipboard, fonts, SVG and canvas helpers, `Terminator` bindings for DOM listeners. |
| `lib-jsx` | `lib-std`, `lib-dom` | The homebrew JSX runtime. `createElement` producing real DOM nodes, no virtual DOM, plus `Inject` for reactive slots and a small router. |
| `lib-dsp` | `lib-std` | Pure DSP and music theory. Oscillators, biquads, ADSR, FFT, convolution, resampling, RMS, transient detection, waveshaping, note and chord models, PPQN and SMPTE time bases, tempo maps, WAV encoding, plus the ported CTAGDRC compressor. |
| `lib-box` | `lib-std`, `lib-runtime` | The object graph that backs every project. Boxes are typed records with addressable fields, pointer fields form the edges. Transactional editing with undo, an update protocol, and `sync-source` / `sync-target` for mirroring a graph across threads or peers. |
| `lib-box-forge` | `lib-std`, `lib-runtime`, `lib-dom`, `lib-box`, `ts-morph` | Code generator. Takes box schema definitions and writes both TypeScript box classes and a Rust registry. Build-time only. |
| `lib-fusion` | `lib-std`, `lib-runtime`, `lib-dom`, `lib-box` | Browser runtime services. OPFS worker for file storage, waveform peak generation and painting, `LiveStream` for lock-free telemetry from the audio thread to the UI, and the preferences host/client pair. |
| `lib-midi` | `lib-std`, `lib-dsp` | Standard MIDI file decoding, events, channel and control types. |
| `lib-xml` | `lib-std` | Schema-driven XML parsing and serialisation. |
| `lib-dawproject` | `lib-runtime`, `lib-dsp`, `lib-xml`, `jszip` | Read and write the [DAWproject](https://github.com/bitwig/dawproject) interchange format. |
| `lib-inference` | `lib-std`, `lib-runtime`, `lib-fusion`, `onnxruntime-web` | ONNX model runner in a worker. Model store with SHA-256 verified downloads, task registry, tensor helpers. Tasks are tempo detection, stem separation and basic pitch. |

The internal dependency order inside this layer is:

```
std -> runtime -> dom -> jsx
 |        |        |
 |        +--------+---> fusion (also needs box)
 |
 +-> dsp -> midi
 +-> xml -> dawproject (also needs dsp, runtime)
 +-> box -> box-forge
```

---

## Layer 2: Studio (`packages/studio`)

This is where the DAW domain lives.

### @opendaw/studio-enums
Depends on `lib-std`.

Frozen enumerations shared across every layer and mirrored in Rust. `Pointers` (the edge types of the box graph),
`AudioUnitType`, `IconSymbol`, `Colors`, `VoicingMode`, `AudioPlayback`, `AudioSendRouting`. Because the WASM engine
mirrors several of these, they must be changed in lockstep with their Rust counterparts.

### @opendaw/studio-forge-boxes
Depends on `lib-box`, `lib-dsp`, `lib-runtime`, `lib-std`, `studio-enums`.

The schema definitions for every box in the DAW: devices, timeline objects, modular modules. It is not a library that
gets imported at runtime. Its `build` script runs `lib-box-forge` over the schemas and writes generated code into two
places.

1. `packages/studio/boxes/src/**` (TypeScript box classes)
2. `crates/studio-boxes/src/registry.rs` (the matching Rust registry)

Both outputs are gitignored, so a fresh clone must run `npm run build` before anything type-checks.

### @opendaw/studio-boxes
Depends on `lib-box`, `lib-std`, `studio-enums`. Build-depends on `studio-forge-boxes`.

The generated box classes. Nothing here is hand-written.

### @opendaw/studio-adapters
Depends on `lib-box`, `lib-dsp`, `lib-fusion`, `lib-midi`, `lib-runtime`, `lib-std`, `studio-boxes`, `studio-enums`,
`soundfont2`.

Adapters wrap raw boxes into usable domain objects. A box is a dumb record, an adapter gives it behaviour: parameter
value mappings, sorted collections of children, note and clip sequencing, engine addresses, validation. This package
is the shared vocabulary between the UI, the TypeScript engine and the WASM engine, which is why both engines depend
on it. Its `src/index.ts` is generated by `generate-exports.mjs` at build time.

Automation value mappings live in the `*BoxAdapter` `createParameter` calls, not in the box schema.

### @opendaw/studio-core
Depends on `lib-box`, `lib-dawproject`, `lib-dom`, `lib-dsp`, `lib-fusion`, `lib-midi`, `lib-runtime`, `lib-std`,
`nam-wasm`, `studio-adapters`, `studio-boxes`, `studio-enums`, `dropbox`, `yjs`, `y-websocket`, `zod`. Peer-depends on
`@ffmpeg/ffmpeg`.

The headless heart of the DAW, everything except the user interface.

- `project/` holds `Project`, `ProjectApi` (all graph mutations), bundles, storage, migration, validation and recovery
- `samples/`, `soundfont/`, `presets/` handle asset import, storage and lookup
- `cloud/` connects Dropbox, Nextcloud and friends
- `capture/` covers audio and MIDI recording
- `dawproject/`, `midi/`, `ffmpeg/` handle import and export
- `ysync/` and `sync-log/` implement collaborative editing on top of yjs
- `Engine`, `EngineFacade`, `EngineVariant`, `EngineWorklet`, `OfflineEngineRenderer` abstract over which engine is running
- `Mixer`, `EffectFactories`, `FactoryCatalog`, `AutoEq`, `AudioUnitFreeze` and the worklets round it out

### @opendaw/studio-core-processors
Depends on `lib-box`, `lib-dsp`, `lib-runtime`, `lib-std`, `studio-adapters`, `studio-boxes`, `studio-enums`.

The AudioWorklet side of the TypeScript engine. Metering, recording, peak broadcasting, high resolution clock and MIDI
sending. It is bundled with esbuild directly into `packages/studio/core/dist/processors.js`, so a change here needs a
rebuild of that bundle before the studio app sees it.

### @opendaw/studio-core-workers
Depends on `lib-box`, `lib-dsp`, `lib-runtime`, `lib-std`, `studio-adapters`, `studio-boxes`, `studio-enums`.

The worker side. BPM detection, audio material analysis (pad versus drum classification) and the `stretch_wasm`
binding for time stretching. Bundled into `packages/studio/core/dist/workers-main.js`.

### @opendaw/studio-core-wasm
Depends on `lib-box`, `lib-dsp`, `lib-fusion`, `lib-runtime`, `lib-std`, `nam-wasm`, `studio-adapters`,
`studio-boxes`, `studio-core`, `soundfont2`.

The bridge to the Rust engine and the default engine since mid 2026.

- `build-wasm.sh` compiles the whole cargo workspace and copies the modules to `dist/wasm/`
- `boot.ts`, `engine-modules.ts` and `device-linker.ts` instantiate `engine.wasm` and dynamically link every
  `device_*.wasm` side module into the shared memory and function table
- `sync/` mirrors the box graph into the engine using `lib-box` sync sources
- `processor.ts` and `offline-worker.ts` are esbuild bundles for the worklet and for offline rendering
- `nam-bridge.ts` and `script-bridge.ts` expose host functionality back to Rust

This package is the reason Rust is a hard prerequisite. Without a toolchain, `dist` never appears and the studio app
fails to resolve the import.

### @opendaw/studio-p2p
Depends on `lib-dsp`, `lib-runtime`, `lib-std`, `studio-adapters`, `jszip`.

Peer to peer asset exchange for collaborative sessions. Signaling, chunked transfer over WebRTC data channels, and
chained providers that fall back from local storage to peers.

### @opendaw/studio-scripting
Depends on `lib-box`, `lib-dsp`, `lib-runtime`, `lib-std`, `studio-adapters`, `studio-boxes`, `studio-enums`.

The scripting layer behind the programmable devices Werkstatt, Apparat and Spielwerk. Defines the user-facing API,
compiles and runs scripts in a worker, and generates `api.declaration.d.ts` at build time so the in-app Monaco editor
can offer completions.

### @opendaw/studio-sdk
Depends on essentially every published package.

A meta package with no code of its own. Installing it pulls the whole toolchain in one step, which is what
[openDAW-headless](https://github.com/andremichelle/opendaw-headless) consumes.

---

## Layer 3: Applications (`packages/app`)

### @opendaw/app-studio
Depends on `lib-box`, `lib-dom`, `lib-dsp`, `lib-inference`, `lib-jsx`, `lib-midi`, `lib-runtime`, `lib-std`,
`studio-adapters`, `studio-boxes`, `studio-core`, `studio-core-wasm`, `studio-enums`, `studio-p2p`,
`studio-scripting`, plus `jszip`, `markdown-it`, `d3-force`, `monaco-editor`, `mediabunny`, `dropbox`.

The actual DAW at [opendaw.studio](https://opendaw.studio). Built with Vite and the homebrew JSX runtime, styled with
Sass. The interesting subtrees under `src/ui`:

- `timeline/` with its region editors and track list
- `devices/`, `composite/`, `modular/` for the device chain and its editors
- `mixer/`, `meter/`, `monitoring/` for the console and metering
- `piano-panel/`, `browse/`, `spotlight/`, `menu/`, `header/`, `dashboard/` for the surrounding shell
- `code-editor/` wrapping Monaco for the scriptable devices

`src/service/StudioService.ts` is the central runtime object wiring project, engine, storage and UI together.

### @opendaw/lab
Depends on `lib-box`, `lib-dom`, `lib-dsp`, `lib-jsx`, `lib-runtime`, `lib-std`, `studio-adapters`, `studio-boxes`,
`studio-core`, `studio-enums`.

A scratch app for isolated DSP experiments with an oscilloscope and sliders.

### @opendaw/app-desktop
A Tauri 2 macOS shell that loads `@opendaw/app-studio` in a webview. No DAW code of its own.
See [`plans/tauri-macos.md`](plans/tauri-macos.md).

---

## The Rust Workspace (`crates`)

Every crate is `publish = false`. The workspace release profile is size optimised (`opt-level = "z"`, LTO,
`panic = "abort"`), with the hot DSP crates overridden back to `opt-level = 3`.

### Leaf crates

| Crate | Depends on | Purpose |
|-------|-----------|---------|
| `math` | `libm` | Scalar math shared by everything, the Rust counterpart of the numeric parts of `lib-std`. |
| `dsp` | `math`, `libm` | Filters, oscillators, envelopes, delay lines. The mirror of `lib-dsp`. Operation order matters, it must match the TypeScript side float for float. |
| `boxgraph` | none | Runtime representation of the synced box graph inside the engine. |
| `value` | `math` | Automatable parameter values and their interpolation. |
| `abi` | `math` | The host boundary. Every import and export crossing the JavaScript to WASM line is declared here. |

### Infrastructure crates

| Crate | Depends on | Purpose |
|-------|-----------|---------|
| `studio-boxes` | `boxgraph` | Generated Rust box registry, written by `studio-forge-boxes`. |
| `bindings` | `boxgraph`, `value`, `math` | Resolves box fields to engine parameters. |
| `transport` | `value`, `engine-env` | Playback position, tempo map, loop handling. |
| `engine-env` | `abi`, `boxgraph`, `value`, `math`, `dsp` | The standard library every device links against. Block model, buffers, event handling, parameter access. |
| `voicing` | `abi`, `libm` | Polyphonic voice allocation shared by the instruments. |
| `processors` | `math`, `dsp`, `value`, `transport`, `engine-env` | Reusable processing blocks used by the engine and the devices. |
| `signalsmith` | `libm` (dev: `signalsmith-stretch`) | Self-contained pure Rust port of Signalsmith Stretch, `no_std` plus alloc, with its own FFT. The native C++ crate is a dev dependency used only as the parity oracle. |
| `stretch` | `math`, `dsp`, `libm` | The time stretching implementation used by the analysis path. |

### Compiled artifacts (cdylib)

| Crate | Output | Notes |
|-------|--------|-------|
| `engine` | `engine.wasm` | The host module and dynamic linker. Imports memory and the function table so device modules can install their `process` and be called through `call_indirect`. Uses `talc` as allocator. Depends on nearly every other crate. |
| `stock-devices/device-*` | `device_*.wasm` | 27 position independent side modules, one per device. Each depends only on `abi`, `math`, `dsp` and sometimes `voicing`, which keeps them around 2 KB after pruning. |
| `stretch-wasm` | `stretch_wasm.wasm` | Standalone analysis module for the core worker. Owns its own memory, never runs on the audio thread. |
| `sine` | `sine.wasm` | Minimal reference module. |

The device modules are built with a nightly toolchain because `core` itself has to be recompiled position independent
(`-Zbuild-std=core`). The engine and `sine` build on stable. `wasm-opt` from binaryen is applied when available and
skipped otherwise.

Two crates are excluded from the workspace. `stretch-lab` path-depends on a sibling checkout that does not exist in
CI, and `signalsmith-wasmbench` is a benchmark harness.

---

## Generated Code

Four artifacts are generated and gitignored. A clone that skips `npm run build` will fail to type-check.

| Output | Produced by | Trigger |
|--------|-------------|---------|
| `packages/studio/boxes/src/**` | `lib-box-forge` via `studio-forge-boxes` | `npm run build` |
| `crates/studio-boxes/src/registry.rs` | same run of `studio-forge-boxes` | `npm run build` |
| `packages/studio/adapters/src/index.ts` | `generate-exports.mjs` | `studio-adapters` build |
| `packages/studio/scripting/src/api.declaration.d.ts` | `scripts/generate-api.ts` | `studio-scripting` build |

---

## Build Pipeline

`npm run build` runs `turbo build`. Beyond the usual topological order, `turbo.json` encodes these extra edges.

```
studio-forge-boxes ──▶ studio-boxes            (schemas generate the box classes)
studio-core-workers ─▶ studio-core             (bundles into core/dist/workers-main.js)
studio-core-processors ▶ studio-core           (bundles into core/dist/processors.js)
crates/**            ──▶ studio-core-wasm      (declared as an input, so Rust edits invalidate the cache)
```

Useful entry points:

- `npm run build` builds everything
- `npm run build-wasm` rebuilds only the Rust modules
- `npm run dev:studio` starts the studio on https://localhost:8080
- `npm run dev:lab` starts the DSP scratch app
- `npm run test` runs the vitest suites, one package at a time
- `npm run clean` removes every `node_modules` and `dist`

A common trap: `studio-core-processors` and `studio-core-workers` are prebuilt bundles inside `studio-core/dist`.
Editing their sources without rebuilding leaves the running studio on the old code.

---

## Runtime Topology

At runtime the studio spreads across four contexts.

**Main thread**
`app-studio` renders the UI with `lib-jsx`, owns the authoritative box graph through `studio-core`, and applies every
edit as a transaction in `lib-box`.

**AudioWorklet**
Either the TypeScript engine (`studio-core-processors`) or, by default, the WASM engine
(`studio-core-wasm/wasm-processor.js` hosting `engine.wasm` plus the linked device modules). The graph is mirrored in
through the `lib-box` sync protocol, so the audio thread never reads main thread state directly.

**Workers**
`studio-core-workers` for analysis and stretching, `lib-fusion` for OPFS and peak generation, `lib-inference` for ONNX
models, `studio-scripting` for user scripts.

**Peers and cloud**
`studio-p2p` over WebRTC for assets, yjs over a websocket for collaborative graph edits, `studio-core/cloud` for the
storage providers.

Telemetry travels the other way. `lib-fusion`'s `LiveStream` carries meters, spectra and note activity from the audio
thread to the UI without locks.

---

## Where To Start Reading

If you want to change the UI, start at `packages/app/studio/src/service/StudioService.ts` and follow it into
`src/ui`.

If you want to change the project model, start at `packages/studio/core/src/project/Project.ts` and `ProjectApi.ts`.

If you want to change how a device sounds, find its crate under `crates/stock-devices/` and its box schema under
`packages/studio/forge-boxes/src/schema/devices`.

If you want to add a device, you touch the schema, the adapter, the effect or instrument factory in `studio-core`, the
Rust crate, and the crate list in `packages/studio/core-wasm/build-wasm.sh`.
