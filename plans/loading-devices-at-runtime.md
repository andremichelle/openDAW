# Loading Devices at Runtime

## Executive Summary

This plan transforms openDAW's device system from compile-time hardcoded devices to truly runtime-loadable device packages. Each device becomes a self-contained folder with a manifest, DSP code, UI editor, adapter, and assets. A central `devices.json` registry tells the app which device folders to load at startup via dynamic `import()` -- no rebuild required to add or remove devices.

All 26 existing devices will eventually be migrated to this system.

---

## Current Architecture Analysis

### How Devices Work Today

A device consists of **7 tightly-coupled, statically-imported components** spread across 6 packages:

| Component | Package | Purpose |
|---|---|---|
| **Schema** (BoxSchema) | `studio/forge-boxes` | Defines fields, types, constraints |
| **Box** (generated class) | `studio/boxes` | Runtime data container with visitor method |
| **Adapter** | `studio/adapters` | Wraps box fields for automation/UI binding |
| **Processor** | `studio/core-processors` | DSP logic (plain class inside the single EngineProcessor) |
| **Editor** (UI) | `app/studio` | JSX component with knobs, controls |
| **Factory** | `studio/core` | Creates device instances, provides metadata |

### Audio Engine Architecture

All device processors run inside a **single AudioWorklet** (`EngineProcessor`). There is one `AudioWorkletNode` for the entire engine. Device processors are plain TypeScript classes instantiated by `DeviceProcessorFactory` and called during the engine's processing loop. They are **not** separate worklets.

The worklet code is bundled via esbuild: `core-processors/src/register.ts` -> `core/dist/processors.js`, loaded once via `audioWorklet.addModule()`.

### The Four Hardcoded Registries

Every device must be manually added to **four visitor-pattern dispatch tables**:

1. **`BoxAdapters.ts`** (`studio/adapters`) - Maps Box -> Adapter via `BoxVisitor`
2. **`DeviceProcessorFactory.ts`** (`studio/core-processors`) - Maps Box -> Processor via `BoxVisitor`
3. **`DeviceEditorFactory.tsx`** (`app/studio`) - Maps Box -> Editor UI via `BoxVisitor`
4. **`EffectFactories.ts`** (`studio/core`) - Named factory objects + lists for menus

### The Visitor Pattern Constraint

The `BoxVisitor` is **code-generated** from box-forge schemas:

```typescript
interface BoxVisitor<T> {
    visitDelayDeviceBox?(box: DelayDeviceBox): T
    visitCompressorDeviceBox?(box: CompressorDeviceBox): T
    // ... one method per box type
}
```

`box.accept(visitor)` calls the matching `visit*` method. Every new device requires regenerating the visitor, adding entries to all four registries, and rebuilding. Runtime-loaded devices solve this by routing through a single shared `visitRuntimeDeviceBox` method, with the `DeviceRegistry` dispatching by box class name.

### Current Device Inventory

**Audio Effects (14):** StereoTool, Compressor, Gate, Maximizer, Delay, DattorroReverb, Reverb, Revamp, Crusher, Fold, Tidal, NeuralAmp, Modular, UnknownAudioEffect (NOP fallback)

**Instruments (7):** Vaporisateur, Tape, Nano, Playfield, Soundfont, MIDIOutput, AudioBus

**MIDI Effects (5):** Arpeggio, Pitch, Velocity, Zeitgeist, UnknownMidiEffect (fallback)

### Key Technical Constraints

- **Single AudioWorklet**: All processors are classes inside one `EngineProcessor`. Device processor code must be available in the worklet context. `AudioWorkletGlobalScope` does **not** support `import()`, `fetch()`, or `importScripts()`. The only way to load code into the worklet is `audioContext.audioWorklet.addModule(url)` from the main thread. Modules loaded this way support static `import` statements.
- **Custom JSX**: UI uses `@opendaw/lib-jsx`. `Html.adoptStyleSheet()` handles styles via constructable stylesheets.
- **Box graph serialization**: Boxes are serialized/deserialized via the box-forge system. Unknown box types need graceful handling for backward compatibility.
- **Cross-origin isolation**: The app uses COEP/COOP headers for `SharedArrayBuffer`. Device resources loaded from other origins need CORS.

---

## WebCLAP Analysis

### What is WebCLAP?

WebCLAP brings the CLAP (CLever Audio Plugin) standard to WebAssembly. Plugins export `clap_entry` from a `.wasm` module. A single binary runs in native DAWs and browsers. Developed primarily by Geraint Luff (Signalsmith Audio), presented at WAC/IRCAM, with iPlug3 expressing interest.

### Recommendation: Do Not Adopt Now

1. **Architecture mismatch**: openDAW devices are TypeScript/JSX with deep box-graph integration (automation, undo/redo, collaboration). WebCLAP's WASM+C-ABI model would require an entirely separate hosting layer.

2. **UI incompatibility**: openDAW devices use shared controls (`ControlBuilder.createKnob`, `ParameterLabelKnob`, `DevicePeakMeter`) integrated with box editing and MIDI learning. WebCLAP uses isolated iframe UIs.

3. **Unnecessary overhead**: WebCLAP requires a C++ WASM host module that loads plugin WASM modules. This dual-WASM layer adds complexity when devices are authored in TypeScript.

4. **Maturity risk**: Early alpha, single developer, placeholder browser host implementations, draft specification.

5. **Wrong problem**: openDAW needs internal device modularity. WebCLAP solves third-party native plugin hosting.

**Future consideration**: Once runtime loading exists, a WebCLAP host could be added as a special device type (similar to NeuralAmp loading WASM).

---

## Target Architecture

### Device Package Structure

```
devices/
  devices.json                          # Registry pointing to all device folders
  fold/
    schema.ts                           # Device schema (source of truth)
    manifest.json                       # Generated from schema by device-forge
    generated/
      FoldDeviceBox.ts                  # Generated Box subclass (real Box, not a wrapper)
    adapter.ts                          # BoxAdapter class
    processor.ts                        # DSP processor class
    editor.tsx                          # UI component
    editor.sass                         # Styles
    manual.md                           # Documentation
    dist/                               # Build output (device-bundle)
      adapter.js                        # Bundled for main thread (import())
      editor.js                         # Bundled for main thread (import())
      processor.js                      # Bundled for worklet (addModule())
      manifest.json                     # Copied from source
```

### devices.json

```json
{
  "version": 1,
  "devices": [
    {"path": "fold", "enabled": true},
    {"path": "compressor", "enabled": true},
    {"path": "dattorro-reverb", "enabled": true}
  ]
}
```

### Device Build Pipeline

A device is built in three stages: **schema → forge → bundle**.

#### Stage 1: Schema Definition

The developer writes `schema.ts` — the single source of truth for the device's identity and parameters. The schema uses the same field-key conventions as `forge-boxes` (keys 1-5 are standard device attributes added automatically, 6-9 reserved, 10+ are device-specific):

```typescript
import {DeviceSchema} from "@opendaw/device-forge"

export default DeviceSchema.audioEffect({
    id: "opendaw.fold",
    name: "Fold",
    vendor: "openDAW",
    icon: "Fold",
    description: "Folds the signal back into audio-range",
    fields: {
        10: {type: "float32", name: "drive", min: 0.0, max: 30.0, default: 0.0, unit: "dB", scaling: "linear"},
        11: {type: "int32", name: "over-sampling", length: 3, default: 0},
        12: {type: "float32", name: "volume", min: -18.0, max: 0.0, default: 0.0, unit: "dB", scaling: "linear"}
    }
})
```

This mirrors the existing `DeviceFactory.createAudioEffect()` pattern in forge-boxes but as a standalone declaration.

#### Stage 2: Code Generation (`device-forge`)

Running `device-forge` reads the schema and generates a **real Box subclass** — identical in structure to what `box-forge` generates for built-in devices. The device's Box extends `Box` directly, has typed field accessors, proper `initializeFields()`, and full serialization support.

**`generated/FoldDeviceBox.ts`** — A real Box class (simplified):

```typescript
// auto-generated by device-forge | do not edit
import {Box, BoxConstruct, BoxGraph, Float32Field, Int32Field, ...} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"

export class FoldDeviceBox extends Box<...> {
    static create(graph: BoxGraph, uuid: UUID.Bytes, constructor?: Procedure<FoldDeviceBox>): FoldDeviceBox {
        return graph.stageBox(new FoldDeviceBox({uuid, graph, name: "FoldDeviceBox", ...}), constructor)
    }
    static readonly ClassName = "FoldDeviceBox"

    accept<R>(visitor: BoxVisitor<R>): Maybe<R> {
        return safeExecute(visitor.visitRuntimeDeviceBox, this)
    }

    get host(): PointerField<Pointers.AudioEffectHost> {return this.getField(1)}
    get index(): Int32Field {return this.getField(2)}
    get label(): StringField {return this.getField(3)}
    get enabled(): BooleanField {return this.getField(4)}
    get minimized(): BooleanField {return this.getField(5)}
    get drive(): Float32Field<PP> {return this.getField(10)}
    get overSampling(): Int32Field {return this.getField(11)}
    get volume(): Float32Field<PP> {return this.getField(12)}

    initializeFields() { /* creates all fields with proper constraints, defaults, pointer rules */ }
}
```

This is the same output `box-forge` produces for built-in devices, with one key difference: `accept()` calls `visitor.visitRuntimeDeviceBox` instead of a device-specific visitor method. All runtime devices share this single visitor entry point, and the `DeviceRegistry` dispatches by class name.

**Complex devices work too.** A device like Playfield can define multiple boxes in its schema — the main device box plus companion boxes (e.g., `PlayfieldSampleBox` with pointer fields, collection fields, nested effects chains). `device-forge` generates all of them as proper Box subclasses. There are no fixed parameter slots; the schema supports the full range of field types: `float32`, `int32`, `boolean`, `string`, `pointer`, `field` (collections), `bytes`, arrays, and objects — the same types `box-forge` supports.

**`manifest.json`** — Also generated from the schema for the runtime loader:

```json
{
  "id": "opendaw.fold",
  "version": "1.0.0",
  "name": "Fold",
  "vendor": "openDAW",
  "icon": "Fold",
  "description": "Folds the signal back into audio-range",
  "type": "audio-effect",
  "manualUrl": "manual.md",
  "entry": {
    "adapter": "dist/adapter.js",
    "processor": "dist/processor.js",
    "editor": "dist/editor.js"
  },
  "boxes": ["FoldDeviceBox"]
}
```

**How serialization works at runtime**: `BoxIO.create` is a generated switch over known class names. For runtime devices, it gets a fallback path:

```typescript
default:
    return DeviceBoxRegistry.create(name, graph, uuid, constructor)
        ?? panic(`Unknown box class '${name}'`)
```

When a device is loaded, its Box classes register themselves in `DeviceBoxRegistry` so the deserializer can find them. This is a small, one-time extension to the generated `io.ts`.

**How the visitor works**: The generated `BoxVisitor` gets one new method — `visitRuntimeDeviceBox`. All runtime device boxes route through it. The handler reads the box's class name, looks up the registered adapter/processor/editor factory in the `DeviceRegistry`, and delegates.

#### Stage 3: Bundling (`device-bundle`)

Uses esbuild to produce three bundles from the device's source files:

```
device-bundle fold/
  → dist/adapter.js    (ESM, for main thread, loaded via import())
  → dist/editor.js     (ESM, for main thread, loaded via import())
  → dist/processor.js  (ESM, for worklet, loaded via addModule())
```

All `@opendaw/*` imports are marked as **external** — the host app provides them at runtime. This keeps device bundles small and ensures shared resources (knobs, controls, DSP utilities) are actually shared.

**Worklet shared code**: The processor bundle needs access to `AudioProcessor`, `AutomatableParameter`, `PeakBroadcaster`, etc. inside the `AudioWorkletGlobalScope`. Since static `import` in `addModule()` modules resolves relative to the module's URL, and since bare specifiers (`@opendaw/...`) don't work in worklets (no import maps), the main `processors.js` bundle exposes shared processor infrastructure on `globalThis.openDAW`:

```typescript
// In processors.js (the main worklet bundle):
globalThis.openDAW = {AudioProcessor, AutomatableParameter, PeakBroadcaster, AudioBuffer, ...}
```

Device processor modules access shared code via this global:

```typescript
// In device processor.js (loaded via addModule()):
const {AudioProcessor, AutomatableParameter} = globalThis.openDAW
```

The `device-bundle` tool handles this rewriting automatically — the developer writes normal imports, the bundler rewrites `@opendaw/device-sdk/processor` references to `globalThis.openDAW` lookups.

### Developer Workflow Summary

```
1. Write schema.ts          → Define fields, constraints, metadata (supports all field types)
2. Run device-forge          → Generates real Box subclass(es) + manifest.json
3. Write adapter/editor/processor using generated Box classes
4. Run device-bundle         → Produces dist/*.js bundles
5. Add to devices.json       → App loads it at next startup
```

### Shared Device SDK

Devices import shared infrastructure from a public SDK:

```typescript
// Main thread (adapter, editor)
import {ControlBuilder, ParameterLabelKnob, DevicePeakMeter, Column} from "@opendaw/device-sdk/ui"
import {ParameterAdapterSet, BoxAdaptersContext} from "@opendaw/device-sdk/adapters"
import {ValueMapping, StringMapping} from "@opendaw/lib-std"

// Worklet (processor) — rewritten to globalThis.openDAW by device-bundle
import {AudioProcessor, AutomatableParameter, PeakBroadcaster} from "@opendaw/device-sdk/processor"
```

---

## Incremental Refactoring Steps

### Phase 1: Decouple Device Boxes from the Core Box System

This is the foundational work. Everything else — SDK, folders, runtime loading — is trivial once device boxes are decoupled from `visitor.ts` and `io.ts`.

---

### Step 1: Add Runtime Box Infrastructure (additive, nothing breaks)

**Goal**: Add the extension points that allow device boxes to be registered and dispatched at runtime, without changing any existing behavior.

**What changes**:

**A) Add `visitRuntimeDeviceBox` to the visitor**:
- Modify `box-forge` to emit one additional method: `visitRuntimeDeviceBox?(box: Box): R`
- This is the shared visitor entry point ALL runtime devices will use
- Regenerate boxes — existing per-device visitor methods still exist, no code changes needed

**B) Create `DeviceBoxRegistry`**:
- A simple runtime map: `className → { create(graph, uuid, constructor?) → Box }`
- Lives in `packages/studio/boxes/src/DeviceBoxRegistry.ts`

**C) Add fallback in `BoxIO.create` and `BoxIO.deserialize`**:
- In the generated `switch` default case, check `DeviceBoxRegistry` before panicking
- This is a small manual edit to the generated `io.ts` (or a modification to `box-forge` to emit it)

**Files to create**:
- `packages/studio/boxes/src/DeviceBoxRegistry.ts`

**Files to modify**:
- `packages/lib/box-forge/src/forge.ts` (emit `visitRuntimeDeviceBox` in visitor, emit registry fallback in io.ts)

**Verification**: Build succeeds. All tests pass. `visitRuntimeDeviceBox` exists in the visitor. `DeviceBoxRegistry` exists but is empty. App behavior is unchanged.

---

### Step 2: Create the DeviceRegistry (additive, nothing breaks)

**Goal**: Central registry where device factories can be registered, keyed by box class name.

**What changes**:
- Create `DeviceRegistry` holding: descriptor (name, icon, description, type) + adapter factory + processor factory + editor factory + box creation factory
- Create `DeviceDescriptor` interface

**Files to create**:
- `packages/studio/core/src/DeviceRegistry.ts`
- `packages/studio/core/src/DeviceDescriptor.ts`

**Verification**: Build succeeds. Registry exists but is not yet consumed.

---

### Step 3: Register All Existing Devices and Add Runtime Dispatch Handlers (additive, nothing breaks)

**Goal**: Populate the registry with all existing devices AND add `visitRuntimeDeviceBox` handlers in the dispatch tables. At this point, both paths exist in parallel — the old per-device visitor methods AND the new runtime dispatch. Nothing uses the runtime path yet.

**What changes**:

**A) Register all devices**:
- Create registration module that wraps each existing device's adapter/processor/editor factory and registers it in `DeviceRegistry` keyed by box class name (e.g., `"FoldDeviceBox"`)
- Call during app startup

**B) Add `visitRuntimeDeviceBox` handlers in the four dispatch tables**:
- `BoxAdapters.ts`: `visitRuntimeDeviceBox` looks up `box.name` in registry, calls registered adapter factory
- `DeviceProcessorFactory.ts`: same pattern for processors
- `DeviceEditorFactory.tsx`: same pattern for editors
- `EffectFactories.ts`: menu creation reads from registry

Each handler is a single function that dispatches any device via the registry. No per-device code.

**Files to create**:
- `packages/studio/core/src/registerBuiltinDevices.ts`

**Files to modify**:
- `packages/app/studio/src/boot.ts` (initialize registry at startup)
- `packages/studio/adapters/src/BoxAdapters.ts` (add `visitRuntimeDeviceBox`)
- `packages/studio/core-processors/src/DeviceProcessorFactory.ts` (add `visitRuntimeDeviceBox`)
- `packages/app/studio/src/ui/devices/DeviceEditorFactory.tsx` (add `visitRuntimeDeviceBox`)

**Verification**: Build succeeds. App still uses the old per-device visitor methods. The `visitRuntimeDeviceBox` handlers exist but are never called yet. Registry contains all devices.

---

### Step 4: Switch Device Boxes to Runtime Dispatch

**Goal**: Change all device box `accept()` methods to call `visitRuntimeDeviceBox` instead of their per-device visitor methods. This is the actual switch-over — after this, devices route through the registry.

**What changes**:
- For each device box in `forge-boxes/src/schema/devices/`, mark it as a "runtime device" so `box-forge` generates `accept()` calling `visitRuntimeDeviceBox` instead of the per-device method
- Register all device boxes in `DeviceBoxRegistry` so `BoxIO` can still create them
- Regenerate all boxes

This can be done all at once (since Step 3 already has the runtime dispatch handlers ready) or incrementally one device at a time.

**Files to modify**:
- `packages/studio/forge-boxes/src/forge.ts` (or schema definitions — flag device boxes as runtime)
- `packages/studio/forge-boxes/src/schema/devices/` (all device schemas)

**Verification**: App works identically. All device creation, processing, editing, serialization, and automation work through the `visitRuntimeDeviceBox` → registry path. Old per-device visitor methods in the dispatch tables are now dead code.

---

### Step 5: Remove Device Boxes from Core Generation

**Goal**: Clean out the per-device visitor methods and io.ts cases. The visitor and io.ts become device-free.

**What changes**:
- Remove `DeviceDefinitions` and `ModuleDefinitions` from `forge.ts` boxes array
- Regenerate: `visitor.ts` now only has ~37 core methods + `visitRuntimeDeviceBox`; `io.ts` only has ~37 core cases + registry fallback
- Device box `.ts` files still exist in `packages/studio/boxes/src/` (they were generated in Step 4 and are still needed), but they are no longer part of the forge pass
- Remove per-device visitor entries from `BoxAdapters.ts`, `DeviceProcessorFactory.ts`, `DeviceEditorFactory.tsx` (they are dead code after Step 4)
- Remove static `EffectFactories` lists; menus now read from registry

**Files to modify**:
- `packages/studio/forge-boxes/src/forge.ts` (remove device schemas from input)
- `packages/studio/adapters/src/BoxAdapters.ts` (remove per-device visitor entries)
- `packages/studio/core-processors/src/DeviceProcessorFactory.ts` (remove per-device visitor entries)
- `packages/app/studio/src/ui/devices/DeviceEditorFactory.tsx` (remove per-device visitor entries)
- Menu code that reads from `EffectFactories` → read from `DeviceRegistry`

**Verification**: `visitor.ts` is clean — only core boxes + `visitRuntimeDeviceBox`. `io.ts` is clean — only core boxes + registry fallback. All devices still work via the registry. App compiles and runs.

---

### Phase 2: Device Build Pipeline and Runtime Loading

With devices decoupled from the core box system, building the external infrastructure is straightforward.

---

### Step 6: Create the Device SDK, Forge, and Bundle Tools

**Goal**: Provide everything a device developer needs: shared libraries, code generation, and bundling.

**A) `@opendaw/device-sdk`** — Shared library re-exports:
- `device-sdk/ui`: `ControlBuilder`, `ParameterLabelKnob`, `Column`, `DevicePeakMeter`, `Checkbox`, knob components
- `device-sdk/adapters`: `ParameterAdapterSet`, `BoxAdaptersContext`, `ValueMapping`, `StringMapping`
- `device-sdk/processor`: `AudioProcessor`, `AutomatableParameter`, `PeakBroadcaster`, `AudioBuffer` (worklet-safe)

**B) `@opendaw/device-forge`** — CLI code generation tool:
- Reads a device's `schema.ts`
- Generates real Box subclasses (same output as `box-forge`, with `accept()` routing to `visitRuntimeDeviceBox`)
- Generates companion boxes (e.g., `PlayfieldSampleBox`) if the schema defines them
- Generates `manifest.json` (metadata + box class names for the runtime loader)
- Uses the same `ts-morph` approach as `box-forge`
- Provides `DeviceSchema.audioEffect()`, `.midiEffect()`, `.instrument()` helper functions
- Supports the full range of field types: float32, int32, boolean, string, pointer, field (collections), bytes, arrays, objects

**C) `@opendaw/device-bundle`** — CLI bundling tool:
- Uses esbuild to produce `dist/adapter.js`, `dist/editor.js`, `dist/processor.js`
- Marks all `@opendaw/*` imports as external
- For processor bundles: rewrites `@opendaw/device-sdk/processor` imports to `globalThis.openDAW` property access
- For main-thread bundles: externals are resolved by the host app's module system

**Files to create**:
- `packages/studio/device-sdk/` (package with sub-path exports)
- `packages/tools/device-forge/` (CLI tool)
- `packages/tools/device-bundle/` (CLI tool)

**Verification**: A device can be authored using `device-forge` + `device-bundle` importing exclusively from `@opendaw/device-sdk`.

---

### Step 7: Implement Runtime Loading from Device Folders

**Goal**: Implement the file-based discovery and dynamic loading system.

**What changes**:
- Create `DeviceLoader` that:
  1. Fetches `devices.json` from a configured path
  2. For each enabled entry, fetches its `manifest.json`
  3. Uses `import()` to load the device's adapter and editor modules (main thread)
  4. Calls `audioContext.audioWorklet.addModule(processorUrl)` for each device's processor module
  5. Registers each loaded device in `DeviceRegistry` + `DeviceBoxRegistry`
- The loader runs during app startup, before the project is opened
- Error handling: if a device fails to load, log a warning and skip it

**Worklet processor loading**: `AudioWorkletGlobalScope` does **not** support dynamic `import()`, `fetch()`, or `importScripts()`. The only mechanism is `audioContext.audioWorklet.addModule(url)` from the **main thread**. Multiple `addModule()` calls share the same `AudioWorkletGlobalScope`.

Shared processor infrastructure is exposed by the main `processors.js` bundle on `globalThis.openDAW`. Device processor modules access shared code via this global — bare specifiers are rewritten to `globalThis.openDAW` lookups by `device-bundle`.

**Loading order matters**: All `addModule()` promises must resolve before the engine instantiates processors.

**Files to create**:
- `packages/studio/core/src/DeviceLoader.ts`
- `packages/app/studio/public/devices/devices.json`

**Files to modify**:
- `packages/app/studio/src/boot.ts` (add DeviceLoader initialization)
- `packages/studio/core-processors/src/EngineProcessor.ts` (expose shared processor infrastructure on globalThis)

**Verification**: App loads devices from `devices.json`. Disabling an entry hides the device. Missing/broken folders are skipped gracefully.

---

### Step 8: Move One Device to Its Own Folder (Proof of Concept)

**Goal**: Move **Fold** to the target folder layout, built and loaded via the full pipeline.

**What changes**:
- Create `devices/fold/schema.ts` defining Fold's fields
- Run `device-forge` → generates `devices/fold/generated/FoldDeviceBox.ts` + `manifest.json`
- Move Fold's adapter, processor, editor, styles into `devices/fold/`, rewriting imports to `@opendaw/device-sdk`
- Run `device-bundle` → produces `devices/fold/dist/adapter.js`, `editor.js`, `processor.js`
- Add `{"path": "fold", "enabled": true}` to `devices.json`
- Remove Fold from `registerBuiltinDevices.ts` — it's now loaded dynamically

**This is the first full exercise of the build pipeline** (schema → forge → develop → bundle → load).

**Verification**: Fold loads entirely from its folder. Build pipeline produces working bundles. Removing the entry from `devices.json` makes Fold disappear.

---

### Step 9: Migrate All Remaining Devices to Folders

**Goal**: Systematically migrate every remaining device to the folder structure.

**Migration order** (simplest first):

**Phase A - Simple audio effects** (2-4 parameters):
Crusher, StereoTool, Maximizer, Gate, Tidal

**Phase B - Medium audio effects** (5-10 parameters):
Compressor, Reverb, DattorroReverb, Delay

**Phase C - Complex audio effects**:
Revamp, NeuralAmp, Modular

**Phase D - MIDI effects**:
Pitch, Velocity, Arpeggio, Zeitgeist

**Phase E - Instruments**:
Nano, Soundfont, Tape, Playfield, Vaporisateur, MIDIOutput, AudioBus

**Verification per device**: Create instance, verify DSP, verify UI, verify automation, load old project, save/reload round-trip.

---

### Step 10: Clean Up Legacy Code

**Goal**: Remove scaffolding that is no longer needed.

**What changes**:
- Remove `registerBuiltinDevices.ts` (all devices load from folders)
- Remove device box `.ts` files from `packages/studio/boxes/src/` (they now live in device folders)
- Remove `EffectFactories.ts` and `InstrumentFactories` (fully replaced by registry)
- Consider whether backward-compatibility shims for old saved projects can be removed

---

## Risk Analysis

### Medium Risk: Step 4 (The Switch-Over)
Changing all device box `accept()` methods at once is the highest-risk moment. Mitigation: Step 3 ensures the runtime dispatch handlers are fully functional and tested before Step 4 flips the switch. Can also be done incrementally, one device at a time.

### Medium Risk: Box Serialization Backward Compatibility
Old projects contain specific box types (e.g., `DelayDeviceBox`). The box class name stays the same, so serialized data round-trips correctly as long as the box class is registered in `DeviceBoxRegistry`. The class name is the serialization key — not the visitor method.

### Low Risk: Multiple `addModule()` Calls
Each device processor requires an `addModule()` call from the main thread. Multiple calls share the same `AudioWorkletGlobalScope`. Parallel `Promise.all()` keeps startup fast. Individual failures are isolated.

### Low Risk: Performance
Registry lookup adds negligible overhead. The hot path (audio processing) is unaffected once the processor is instantiated.

---

## Open Questions

1. **Versioning**: How to handle manifest changes that alter parameter layouts? (Migration strategy for saved projects.)

2. **Third-party devices**: Should the manifest support loading from external URLs? (CORS, security.)

3. **Device dependencies**: Can a device declare dependencies (e.g., NeuralAmp needs `@opendaw/nam-wasm`)?

4. **Device categories/tags**: Should `devices.json` support categories beyond the type?

5. **Hot-reloading**: Should devices support live reload during development?

---

## Summary

| Step | Description | Risk | Phase |
|------|-------------|------|-------|
| 1 | Add runtime box infrastructure (visitor, registry, io.ts fallback) | Low | Decouple |
| 2 | Create DeviceRegistry + DeviceDescriptor | None | Decouple |
| 3 | Register all existing devices + add runtime dispatch handlers | Low | Decouple |
| 4 | Switch device box accept() to visitRuntimeDeviceBox | Medium | Decouple |
| 5 | Remove device boxes from core generation, clean dispatch tables | Low | Decouple |
| 6 | Device SDK + device-forge + device-bundle | Medium | Build pipeline |
| 7 | Runtime loading from device folders | Low | Build pipeline |
| 8 | Move Fold to its own folder (proof of concept) | Low | Migration |
| 9 | Migrate all remaining devices to folders | Medium | Migration |
| 10 | Clean up legacy code | Low | Migration |

Steps 1-3 are purely additive — nothing breaks. Step 4 is the switch-over. Step 5 cleans the core. Steps 6-7 build the external infrastructure. Steps 8-10 complete the migration.
