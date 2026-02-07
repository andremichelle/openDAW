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

`box.accept(visitor)` calls the matching `visit*` method. Every new device requires regenerating the visitor, adding entries to all four registries, and rebuilding. Runtime-loaded devices cannot use this mechanism, so a generic box type with a `deviceId` field is needed.

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
      box.ts                            # Generated typed field accessors
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

Running `device-forge` reads the schema and produces two outputs:

**`generated/box.ts`** — Typed field accessor class:

```typescript
// auto-generated by device-forge | do not edit
import {GenericAudioEffectDeviceBox} from "@opendaw/studio-boxes"
import {Float32Field, Int32Field} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"

type PP = Pointers.Modulation | Pointers.Automation | Pointers.MIDIControl

export const DEVICE_ID = "opendaw.fold"

export class FoldDeviceBox {
    constructor(readonly box: GenericAudioEffectDeviceBox) {}
    get drive(): Float32Field<PP> {return this.box.getField(10)}
    get overSampling(): Int32Field {return this.box.getField(11)}
    get volume(): Float32Field<PP> {return this.box.getField(12)}
}
```

**`manifest.json`** — Generated from the schema for the runtime loader:

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
  "fields": {
    "10": {"type": "float32", "name": "drive", "min": 0.0, "max": 30.0, "default": 0.0, "unit": "dB", "scaling": "linear"},
    "11": {"type": "int32", "name": "over-sampling", "length": 3, "default": 0},
    "12": {"type": "float32", "name": "volume", "min": -18.0, "max": 0.0, "default": 0.0, "unit": "dB", "scaling": "linear"}
  }
}
```

**Why this works**: The generated `FoldDeviceBox` class wraps a `GenericAudioEffectDeviceBox` and delegates `getField()` calls to it. At runtime, the box graph only ever sees `GenericAudioEffectDeviceBox` instances — a type the serializer already knows. The `deviceId` string field on the generic box identifies which device it represents. But during development, the typed wrapper provides full IntelliSense and compile-time safety.

**Why NOT generate a full Box subclass**: The serializer (`BoxIO.create`) is a generated switch statement over known class names. The visitor interface (`BoxVisitor`) is generated with one method per box type. Both are compile-time artifacts. A runtime device cannot extend either. By wrapping `GenericDeviceBox`, we sidestep both constraints — the generic box handles serialization and visitor dispatch, while the typed wrapper handles developer ergonomics.

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
1. Write schema.ts          → Define fields, constraints, metadata
2. Run device-forge          → Generates typed box.ts + manifest.json
3. Write adapter/editor/processor using generated types
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

### Step 1: Introduce a DeviceDescriptor Interface

**Goal**: Define a unified interface that captures device metadata, decoupled from the visitor pattern.

**What changes**:
- Create a `DeviceDescriptor` type in `studio/core`
- Pure addition, no existing code changes

**Files to create**:
- `packages/studio/core/src/DeviceDescriptor.ts`

```typescript
import {IconSymbol} from "@opendaw/studio-enums"

export interface DeviceDescriptor {
    readonly id: string
    readonly name: string
    readonly vendor: string
    readonly icon: IconSymbol
    readonly description: string
    readonly type: "audio-effect" | "midi-effect" | "instrument"
    readonly manualPage: string
}
```

**Verification**: Build succeeds, no behavioral changes.

---

### Step 2: Create a DeviceRegistry

**Goal**: Central, mutable registry where device descriptors and their factory functions can be registered at runtime.

**What changes**:
- Create `DeviceRegistry` class in `studio/core` storing registrations keyed by device id
- Holds: descriptor + adapter factory + editor factory + processor factory + box creation factory
- Existing static factories remain unchanged

**Files to create**:
- `packages/studio/core/src/DeviceRegistry.ts`

**Verification**: Build succeeds. Registry exists but is not yet consumed.

---

### Step 3: Register All Existing Devices in the DeviceRegistry

**Goal**: Populate the registry with all 26 existing devices. The visitor-based dispatch remains the actual runtime path.

**What changes**:
- Create registration functions wrapping current factory logic
- Call at app startup
- No code paths change yet

**Files to create**:
- `packages/studio/core/src/registerBuiltinDevices.ts`

**Files to modify**:
- `packages/app/studio/src/boot.ts` (initialize registry)

**Verification**: Build succeeds. `DeviceRegistry` contains all devices. App behavior unchanged.

---

### Step 4: Make Effect/Instrument Menus Read from the Registry

**Goal**: UI menus read from `DeviceRegistry` instead of static `EffectFactories.AudioList` / `MidiList`.

**What changes**:
- Replace menu data sources with `deviceRegistry.allEffects()` etc.
- Menu items are now driven by registry contents

**Verification**: Menus show same devices. Removing a registration hides a device from menus.

---

### Step 5: Introduce GenericDeviceBox Types

**Goal**: Create generic box types that can represent any runtime-loaded device via a `deviceId` string field + parameter slots.

**What changes**:
- Define `GenericAudioEffectDeviceBox`, `GenericMidiEffectDeviceBox`, `GenericInstrumentDeviceBox` schemas in forge-boxes
- Standard device fields (keys 1-5) + `deviceId` string field (key 10) + parameter slots (keys 11+)
- Parameter slots: 64 float32 (keys 11-74) + 16 int32 (keys 75-90) + 16 boolean (keys 91-106), all float32/int32 with `pointerRules: ParameterPointerRules` for automation support
- Regenerate box-forge output, adding visitor methods for the generic types

**Field key layout for GenericAudioEffectDeviceBox**:
```
Keys 1-5:    Standard device attributes (host, index, label, enabled, minimized)
Keys 6-9:    Reserved
Key 10:      deviceId (string) — identifies the device registration
Keys 11-74:  float32 parameter slots (64 slots, automatable)
Keys 75-90:  int32 parameter slots (16 slots, automatable)
Keys 91-106: boolean parameter slots (16 slots)
```

**How it connects to device-forge**: The `device-forge` CLI generates a typed wrapper class (see Target Architecture > Stage 2) that maps semantic field names to these slot keys. For example, Fold's `get drive()` maps to `getField(11)` (float32 slot 0 → key 11). The mapping is deterministic from the device schema: the developer's field key 10 maps to generic key 11 (float32 slot 0), field key 11 maps to generic key 75 (int32 slot 0), etc. The `device-forge` tool handles this translation.

**Files to create**:
- `packages/studio/forge-boxes/src/schema/devices/audio-effects/GenericAudioEffectDeviceBox.ts`
- `packages/studio/forge-boxes/src/schema/devices/midi-effects/GenericMidiEffectDeviceBox.ts`
- `packages/studio/forge-boxes/src/schema/devices/instruments/GenericInstrumentDeviceBox.ts`

**Verification**: Build succeeds. Visitor includes `visitGenericAudioEffectDeviceBox` etc. BoxIO can create and serialize generic device boxes.

---

### Step 6: Generic Adapter, Processor, and Editor Delegation

**Goal**: Implement the generic visitors that look up device behavior from the registry.

**Adapter**: `GenericAudioEffectDeviceBoxAdapter` reads `deviceId`, looks up the registration, delegates parameter wrapping to the registered adapter factory.

**Processor**: `GenericAudioEffectDeviceProcessor` reads `deviceId`, looks up the registration, delegates to the registered processor factory. The processor is a plain class instantiated inside the existing `EngineProcessor` -- no different from any other device processor.

**Editor**: `visitGenericAudioEffectDeviceBox` in `DeviceEditorFactory.tsx` reads `deviceId`, looks up and calls the registered editor factory.

**Files to create**:
- `packages/studio/adapters/src/devices/audio-effects/GenericAudioEffectDeviceBoxAdapter.ts` (+ midi, instrument)
- `packages/studio/core-processors/src/devices/GenericAudioEffectDeviceProcessor.ts` (+ midi, instrument)

**Files to modify**:
- `packages/studio/adapters/src/BoxAdapters.ts` (add generic visitor entries)
- `packages/studio/core-processors/src/DeviceProcessorFactory.ts` (add generic visitor entries)
- `packages/app/studio/src/ui/devices/DeviceEditorFactory.tsx` (add generic visitor entries)

**Verification**: Generic devices can be created, processed, and rendered if a matching registration exists.

---

### Step 7: Migrate One Device End-to-End (Proof of Concept)

**Goal**: Migrate **Fold** (2 parameters: drive, mix) from hardcoded visitor pattern to registry-based generic system.

**What changes**:
- Register Fold via the `DeviceRegistry` with its descriptor, adapter factory, processor factory, and editor factory
- New Fold instances use `GenericAudioEffectDeviceBox` with `deviceId = "opendaw.fold"`
- Old `FoldDeviceBox` visitor entries stay as backward-compatibility shims (delegate to generic adapter internally)
- Fold's processor, editor, and adapter code remain unchanged -- only the dispatch path changes

**Verification**:
- New Fold instances use GenericAudioEffectDeviceBox
- Old projects with FoldDeviceBox still load and work
- DSP, UI, automation all function identically
- Save -> reload round-trip works

---

### Step 8: Create the Device SDK, Forge, and Bundle Tools

**Goal**: Provide everything a device developer needs: shared libraries, code generation, and bundling.

**What changes**:

**A) `@opendaw/device-sdk`** — Shared library re-exports:
- `device-sdk/ui`: `ControlBuilder`, `ParameterLabelKnob`, `Column`, `DevicePeakMeter`, `Checkbox`, knob components
- `device-sdk/adapters`: `ParameterAdapterSet`, `BoxAdaptersContext`, `ValueMapping`, `StringMapping`
- `device-sdk/processor`: `AudioProcessor`, `AutomatableParameter`, `PeakBroadcaster`, `AudioBuffer` (worklet-safe)

**B) `@opendaw/device-forge`** — CLI code generation tool:
- Reads a device's `schema.ts`
- Generates `generated/box.ts` (typed wrapper around GenericDeviceBox)
- Generates `manifest.json` (metadata + field definitions for the runtime loader)
- Uses the same `ts-morph` approach as `box-forge` but generates wrappers instead of full Box subclasses
- Provides `DeviceSchema.audioEffect()`, `.midiEffect()`, `.instrument()` helper functions for schema authoring

**C) `@opendaw/device-bundle`** — CLI bundling tool:
- Uses esbuild to produce `dist/adapter.js`, `dist/editor.js`, `dist/processor.js`
- Marks all `@opendaw/*` imports as external
- For processor bundles: rewrites `@opendaw/device-sdk/processor` imports to `globalThis.openDAW` property access
- For main-thread bundles: externals are resolved by the host app's module system

**Files to create**:
- `packages/studio/device-sdk/` (package with sub-path exports)
- `packages/tools/device-forge/` (CLI tool)
- `packages/tools/device-bundle/` (CLI tool)

**Verification**: Fold device can be authored using `device-forge` + `device-bundle` and import exclusively from `@opendaw/device-sdk`.

---

### Step 9: Implement Runtime Loading from Device Folders

**Goal**: Implement the file-based discovery and dynamic loading system.

**What changes**:
- Create `DeviceLoader` that:
  1. Fetches `devices.json` from a configured path
  2. For each enabled entry, fetches its `manifest.json`
  3. Uses `import()` to load the device's adapter and editor modules (main thread)
  4. Calls `audioContext.audioWorklet.addModule(processorUrl)` for each device's processor module
  5. Registers each loaded device in the `DeviceRegistry`
- The loader runs during app startup, before the project is opened
- Error handling: if a device fails to load, log a warning and skip it

**Worklet processor loading**: `AudioWorkletGlobalScope` does **not** support dynamic `import()`, `fetch()`, or `importScripts()`. The only mechanism to load code into the worklet is `audioContext.audioWorklet.addModule(url)` called from the **main thread**. Each device's processor module is loaded this way. Multiple `addModule()` calls share the same `AudioWorkletGlobalScope`, so all processors end up in the same worklet context.

Shared processor infrastructure (`AudioProcessor`, `AutomatableParameter`, `PeakBroadcaster`, etc.) is exposed by the main `processors.js` bundle on `globalThis.openDAW`. Device processor modules (built by `device-bundle`) access shared code via this global — bare specifiers like `@opendaw/device-sdk/processor` are rewritten to `globalThis.openDAW` property lookups at bundle time. The loaded processor module registers its factory function on `globalThis.openDAW.deviceProcessors[deviceId]`, which the `EngineProcessor` reads when instantiating a generic device.

**Loading order matters**: `addModule()` calls must complete before the engine attempts to instantiate the processor. The `DeviceLoader` awaits all `addModule()` promises before signaling that devices are ready.

**Files to create**:
- `packages/studio/core/src/DeviceLoader.ts`
- `packages/app/studio/public/devices/devices.json`

**Files to modify**:
- `packages/app/studio/src/boot.ts` (add DeviceLoader initialization)
- `packages/studio/core-processors/src/EngineProcessor.ts` (add message handler for dynamic processor registration)

**Verification**:
- App loads, reads `devices.json`, loads manifests and modules
- Devices appear in menus
- Disabling a device in `devices.json` removes it from menus
- App starts correctly even if a device folder is missing/broken

---

### Step 10: Move Fold Device to Its Own Folder

**Goal**: Take the Fold device and physically restructure it into the target folder layout, built and loaded via the device build pipeline.

**What changes**:
- Create `devices/fold/schema.ts` defining Fold's fields
- Run `device-forge` to generate `devices/fold/generated/box.ts` and `devices/fold/manifest.json`
- Move Fold's adapter, processor, editor, and styles into `devices/fold/`, rewriting imports to use the generated `FoldDeviceBox` wrapper and `@opendaw/device-sdk`
- Run `device-bundle` to produce `devices/fold/dist/adapter.js`, `editor.js`, `processor.js`
- Add `{"path": "fold", "enabled": true}` to `devices.json`
- Remove Fold's registration from `registerBuiltinDevices.ts` — it's now loaded dynamically
- The backward-compatibility shim for old `FoldDeviceBox` visitor entries remains

**This is the first full exercise of the build pipeline** (schema → forge → develop → bundle → load).

**Verification**: Fold loads entirely from its folder via `devices.json`. Build pipeline produces working bundles. Removing the entry from `devices.json` makes Fold disappear from menus.

---

### Step 11: Migrate All Remaining Devices

**Goal**: Systematically migrate every remaining device to the folder structure.

**Migration order** (simplest first):

**Phase A - Simple audio effects** (2-4 parameters):
1. Crusher, 2. StereoTool, 3. Maximizer, 4. Gate, 5. Tidal

**Phase B - Medium audio effects** (5-10 parameters):
6. Compressor, 7. Reverb, 8. DattorroReverb, 9. Delay

**Phase C - Complex audio effects**:
10. Revamp, 11. NeuralAmp, 12. Modular

**Phase D - MIDI effects**:
13. Pitch, 14. Velocity, 15. Arpeggio, 16. Zeitgeist

**Phase E - Instruments**:
17. Nano, 18. Soundfont, 19. Tape, 20. Playfield, 21. Vaporisateur, 22. MIDIOutput, 23. AudioBus

After each migration:
- Old Box type's visitor entry becomes a backward-compatibility shim
- Device folder is self-contained

**After all migrations**:
- The four dispatch tables contain only: generic box handlers + legacy shims
- `EffectFactories` and `InstrumentFactories` are removed or become thin registry wrappers
- New devices can be added by creating a folder without touching any core files

**Verification per device**: Create instance, verify DSP, verify UI, verify automation, load old project, save/reload round-trip.

---

### Step 12: Clean Up Legacy Code

**Goal**: Remove the scaffolding that is no longer needed.

**What changes**:
- Remove `registerBuiltinDevices.ts` (all devices load from folders)
- Simplify `DeviceProcessorFactory`, `DeviceEditorFactory`, `BoxAdapters` to only handle generic box types + legacy shims
- Remove `EffectFactories.AudioNamed`, `MidiNamed` and related static lists
- Consider whether legacy box type shims can be removed (depends on how old saved projects need to be supported)

---

## Risk Analysis

### Medium Risk: Box Serialization Backward Compatibility
Old projects contain specific box types (e.g., `DelayDeviceBox`). When devices migrate to `GenericAudioEffectDeviceBox`, legacy visitor entries must convert old types. Mitigation: keep old visitor entries as shims indefinitely.

### Medium Risk: Parameter Slot Limits
Generic boxes use fixed parameter slots. Devices with many parameters (Revamp ~20+ EQ bands) need enough slots. Mitigation: allocate generously (64 float + 16 boolean).

### Low Risk: Multiple `addModule()` Calls
Each device processor requires an `addModule()` call from the main thread. Multiple `addModule()` calls are supported and share the same `AudioWorkletGlobalScope`. The calls are async and return promises that must be awaited before the engine starts. For many devices, parallel `Promise.all()` can keep startup fast. If a processor module fails to load, the device is skipped without affecting others.

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

| Step | Description | Risk | Scope |
|------|-------------|------|-------|
| 1 | DeviceDescriptor interface | None | 1 file |
| 2 | DeviceRegistry class | None | 1 file |
| 3 | Register existing devices | Low | 2-3 files |
| 4 | Menus read from registry | Low | 2-3 files |
| 5 | GenericDeviceBox types | Medium | 3-5 files + forge rebuild |
| 6 | Generic adapter/processor/editor delegation | Medium | 5-8 files |
| 7 | Migrate Fold (proof of concept) | Medium | 5-8 files |
| 8 | Device SDK + device-forge + device-bundle | Medium | 3 packages |
| 9 | Runtime loading from folders | Low | 3-4 files |
| 10 | Move Fold to device folder (full pipeline exercise) | Low | 5-6 files |
| 11 | Migrate all remaining devices | Medium | ~100 files total |
| 12 | Clean up legacy code | Low | 5-10 files |

Each step leaves the application in a working state. Steps 1-4 are purely additive. Steps 5-6 introduce generic device infrastructure. Step 7 proves it end-to-end. Step 8 provides the build tools (forge + bundle). Step 9 enables runtime loading. Step 10 exercises the full pipeline (schema → forge → develop → bundle → load). Steps 11-12 complete the migration.
