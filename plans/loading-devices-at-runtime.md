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

- **Single AudioWorklet**: All processors are classes inside one `EngineProcessor`. Device processor code must be available in the worklet context. Dynamic `import()` inside the worklet is the target mechanism.
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
  delay/
    manifest.json                       # Metadata and entry points
    adapter.ts                          # BoxAdapter class
    processor.ts                        # DSP processor class
    editor.tsx                          # UI component
    editor.sass                         # Styles
    manual.md                           # Documentation
  compressor/
    manifest.json
    adapter.ts
    processor.ts
    editor.tsx
    editor.sass
    manual.md
  ...
```

### devices.json

```json
{
  "version": 1,
  "devices": [
    {"path": "delay", "enabled": true},
    {"path": "compressor", "enabled": true},
    {"path": "dattorro-reverb", "enabled": true}
  ]
}
```

### manifest.json

```json
{
  "id": "opendaw.delay",
  "version": "1.0.0",
  "name": "Delay",
  "vendor": "openDAW",
  "icon": "Time",
  "description": "Echoes the input signal with time-based repeats",
  "type": "audio-effect",
  "manualUrl": "manual.md",
  "entry": {
    "adapter": "adapter.ts",
    "processor": "processor.ts",
    "editor": "editor.tsx"
  },
  "parameters": {
    "floats": [
      {"slot": 0, "name": "time", "min": 0.01, "max": 2.0, "default": 0.5, "unit": "s", "scaling": "exponential"},
      {"slot": 1, "name": "feedback", "min": 0.0, "max": 0.99, "default": 0.5, "scaling": "linear"},
      {"slot": 2, "name": "mix", "min": 0.0, "max": 1.0, "default": 0.5, "scaling": "linear"}
    ],
    "booleans": [
      {"slot": 0, "name": "sync", "default": false}
    ]
  }
}
```

### Shared Device SDK

Devices import shared infrastructure from a public SDK:

```typescript
import {ControlBuilder, ParameterLabelKnob, DevicePeakMeter, Column} from "@opendaw/device-sdk/ui"
import {AudioProcessor, AutomatableParameter, PeakBroadcaster} from "@opendaw/device-sdk/dsp"
import {ParameterAdapterSet, BoxAdaptersContext} from "@opendaw/device-sdk/adapters"
import {ValueMapping, StringMapping} from "@opendaw/lib-std"
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
- Standard device fields + `deviceId` string field + parameter slots (generous fixed-size: 64 float32 + 16 boolean, all with `pointerRules: ParameterPointerRules` for automation support)
- Regenerate box-forge output, adding visitor methods for the generic types

**Parameter slot design**: The manifest's `parameters` section maps semantic names to slot indices. Slot 0 in the manifest maps to `param0` on the generic box. This preserves the existing automation and pointer system without any changes.

**Files to create**:
- `packages/studio/forge-boxes/src/schema/devices/audio-effects/GenericAudioEffectDeviceBox.ts`
- `packages/studio/forge-boxes/src/schema/devices/midi-effects/GenericMidiEffectDeviceBox.ts`
- `packages/studio/forge-boxes/src/schema/devices/instruments/GenericInstrumentDeviceBox.ts`

**Verification**: Build succeeds. Visitor includes `visitGenericAudioEffectDeviceBox` etc.

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

### Step 8: Create the Device SDK Package

**Goal**: Extract shared resources into a clean SDK so device folders can import them without depending on internal packages.

**What changes**:
- Create `packages/studio/device-sdk/`
- Re-export UI controls: `ControlBuilder`, `ParameterLabelKnob`, `Column`, `DevicePeakMeter`, `Checkbox`, knob components
- Re-export DSP base classes: `AudioProcessor`, `AutomatableParameter`, `PeakBroadcaster`, `AudioBuffer`
- Re-export adapter utilities: `ParameterAdapterSet`, `BoxAdaptersContext`, `ValueMapping`, `StringMapping`

**Verification**: Fold device can be rewritten to import exclusively from `@opendaw/device-sdk`.

---

### Step 9: Implement Runtime Loading from Device Folders

**Goal**: Implement the file-based discovery and dynamic loading system.

**What changes**:
- Create `DeviceLoader` that:
  1. Fetches `devices.json` from a configured path
  2. For each enabled entry, fetches its `manifest.json`
  3. Uses `import()` to load the device's adapter and editor modules (main thread)
  4. Sends processor module URLs to the worklet, which uses `import()` to load them
  5. Registers each loaded device in the `DeviceRegistry`
- The loader runs during app startup, before the project is opened
- Error handling: if a device fails to load, log a warning and skip it

**Worklet processor loading**: The `EngineProcessor` already runs in a module worklet (loaded via `addModule()`). Module worklets support `import()`. The main thread tells the worklet "load processor from this URL" via `MessagePort`, the worklet does `import(url)` and registers the processor factory. This is straightforward -- no eval, no blob URLs, no separate worklet instances.

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

**Goal**: Take the Fold device and physically restructure it into the target folder layout, loaded via `devices.json`.

**What changes**:
- Create `devices/fold/` with manifest.json, adapter.ts, processor.ts, editor.tsx, editor.sass
- Add `{"path": "fold", "enabled": true}` to `devices.json`
- Remove Fold's registration from `registerBuiltinDevices.ts` -- it's now loaded dynamically
- The backward-compatibility shim for old `FoldDeviceBox` projects remains

**Verification**: Fold loads entirely from its folder. Removing the folder entry from `devices.json` makes Fold disappear from menus.

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

### Low Risk: Dynamic `import()` in Worklet
Module worklets support `import()` in modern browsers. The app already requires modern browser features (SharedArrayBuffer, COEP/COOP). If a browser doesn't support worklet `import()`, the fallback is to pre-bundle processor code at build time.

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
| 8 | Device SDK package | Low | 4-5 files |
| 9 | Runtime loading from folders | Low | 3-4 files |
| 10 | Move Fold to device folder | Low | 5-6 files |
| 11 | Migrate all remaining devices | Medium | ~100 files total |
| 12 | Clean up legacy code | Low | 5-10 files |

Each step leaves the application in a working state. Steps 1-4 are purely additive. Steps 5-6 introduce generic device infrastructure. Step 7 proves it end-to-end. Steps 8-9 enable the folder-based loading. Steps 10-12 complete the migration.
