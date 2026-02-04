# NeuralAmpModelBox Resource Plan

## Summary

This plan introduces `NeuralAmpModelBox` to store NAM model data as a shared resource. Unlike audio files and soundfonts that store data externally in OPFS, NAM models will be embedded directly in the box using a StringField. This enables:

1. **Content-addressable storage** - UUID derived from SHA256 of model content
2. **Deduplication** - Same model content always produces same UUID
3. **Portable copying** - Models travel with devices during copy/paste
4. **Sharing** - Multiple devices can reference the same model box

### Why No Compression

We store the JSON uncompressed because:
- **AudioWorklet limitations** - `CompressionStream`/`DecompressionStream` APIs are **not available** in AudioWorklet context (verified by testing)
- **Simplicity** - No need for main-thread decompression and message passing
- **Acceptable size** - NAM models are 40KB-400KB, manageable without compression
- **Project-level compression** - The binary project format can apply compression if needed

## Current State

The existing `NeuralAmpDeviceBox` stores the model JSON directly in its `modelJson` StringField:

```typescript
// packages/studio/forge-boxes/src/schema/devices/audio-effects/NeuralAmpDeviceBox.ts
export const NeuralAmpDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("NeuralAmpDeviceBox", {
    10: {type: "string", name: "model-json"},  // Currently stores full model JSON
    // ... parameters
})
```

### Problems with Current Approach

1. **No sharing** - If multiple NeuralAmpDeviceBox instances use the same model, the JSON is duplicated in each device
2. **No deduplication** - Same model imported twice creates duplicate data
3. **Large project files** - NAM models are ~40KB-400KB of JSON each
4. **Copy/paste bloat** - Copying devices includes full model JSON in each device

## Proposed Solution

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  CURRENT STRUCTURE                                                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  NeuralAmpDeviceBox A                  NeuralAmpDeviceBox B              │
│  ├── modelJson: "{...full json...}"   ├── modelJson: "{...full json...}"│
│  ├── inputGain: -6.0                  ├── inputGain: 0.0                │
│  └── outputGain: 3.0                  └── outputGain: -3.0              │
│                                                                          │
│  (Same model duplicated in both devices)                                │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘

                              ↓ BECOMES ↓

┌─────────────────────────────────────────────────────────────────────────┐
│  PROPOSED STRUCTURE                                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  NeuralAmpModelBox (UUID from SHA256 of content)                        │
│  ├── label: "Fender Twin"                                               │
│  └── model: "{...NAM model JSON...}"                                     │
│           ▲                                                              │
│           │ (pointer)                                                    │
│  ┌────────┴────────┐                                                    │
│  │                 │                                                    │
│  NeuralAmpDeviceBox A              NeuralAmpDeviceBox B                 │
│  ├── model: → NeuralAmpModelBox    ├── model: → NeuralAmpModelBox       │
│  ├── inputGain: -6.0               ├── inputGain: 0.0                   │
│  └── outputGain: 3.0               └── outputGain: -3.0                 │
│                                                                          │
│  (Model stored once, referenced by multiple devices)                    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Content-Addressable UUID

Similar to how `SampleService` and `SoundfontService` use `UUID.sha256(arrayBuffer)` to create content-addressable IDs:

```typescript
// packages/studio/core/src/samples/SampleService.ts:27-28
uuid ??= await UUID.sha256(arrayBuffer) // Must run before decodeAudioData
```

For NAM models, we hash the original (uncompressed) JSON:

```typescript
const jsonString = await file.text()
const jsonBuffer = new TextEncoder().encode(jsonString)
const uuid = await UUID.sha256(jsonBuffer)
```

## Implementation

### Phase 1: Add Pointer Type

Add `NeuralAmpModel` to the Pointers enum:

```typescript
// packages/studio/enums/src/Pointers.ts
export enum Pointers {
    // ... existing pointers ...
    NeuralAmpModel,  // NEW
}
```

### Phase 2: Create NeuralAmpModelBox Schema

```typescript
// packages/studio/forge-boxes/src/schema/std/NeuralAmpModelBox.ts
import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"

export const NeuralAmpModelBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "NeuralAmpModelBox",
        fields: {
            1: {type: "string", name: "label"},
            2: {type: "string", name: "model"}  // Uncompressed NAM JSON
        }
    },
    pointerRules: {accepts: [Pointers.NeuralAmpModel], mandatory: true},
    resource: "preserved"  // Content-addressable, keeps UUID during copy
}
```

**Why `resource: "preserved"`:**
- UUID is content-derived (SHA256), so same content = same UUID
- During copy/paste, the box is included as a dependency
- UUID is preserved (not remapped) since it represents the content identity
- This matches how AudioFileBox and SoundfontFileBox work

**Why StringField (not ByteArrayField):**
- NAM JSON is text, naturally stored as string
- No compression = no need for binary storage
- Simpler to debug and inspect
- `ByteArrayField` would be appropriate if we were compressing

### Phase 3: Update NeuralAmpDeviceBox Schema

Add a new pointer field while keeping the old string field deprecated for migration:

```typescript
// packages/studio/forge-boxes/src/schema/devices/audio-effects/NeuralAmpDeviceBox.ts
import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {ParameterPointerRules} from "../../std/Defaults"
import {DeviceFactory} from "../../std/DeviceFactory"

export const NeuralAmpDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("NeuralAmpDeviceBox", {
    10: {type: "string", name: "model-json", deprecated: true},  // Keep for migration
    11: {
        type: "float32", name: "input-gain", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "decibel", unit: "dB"
    },
    12: {
        type: "float32", name: "output-gain", pointerRules: ParameterPointerRules,
        value: 0.0, constraints: "decibel", unit: "dB"
    },
    13: {type: "boolean", name: "mono", value: true},
    14: {
        type: "float32", name: "mix", pointerRules: ParameterPointerRules,
        value: 1.0, constraints: {min: 0.0, max: 1.0, scaling: "linear"}, unit: "%"
    },
    20: {
        type: "field", name: "model",
        pointerRules: {accepts: [Pointers.NeuralAmpModel], mandatory: false}
    }
})
```

**Migration strategy:**
- Field 10 (`model-json`) is deprecated but still readable
- Field 20 (`model`) is the new mandatory pointer
- On project load, if field 10 has content but field 20 is empty:
  1. Create a `NeuralAmpModelBox` with the JSON from field 10
  2. Point field 20 to the new model box
  3. Field 10 will not be written on save (deprecated)
- The field name can change without breaking stored projects (only field ID matters)

### Phase 4: Create NeuralAmpModelBoxAdapter

```typescript
// packages/studio/adapters/src/nam/NeuralAmpModelBoxAdapter.ts
import {NeuralAmpModelBox} from "@opendaw/studio-boxes"
import {UUID} from "@opendaw/lib-std"
import {Address, Field} from "@opendaw/lib-box"
import {BoxAdaptersContext} from "../BoxAdaptersContext"
import {BoxAdapter} from "../BoxAdapter"

export class NeuralAmpModelBoxAdapter implements BoxAdapter {
    readonly #context: BoxAdaptersContext
    readonly #box: NeuralAmpModelBox

    constructor(context: BoxAdaptersContext, box: NeuralAmpModelBox) {
        this.#context = context
        this.#box = box
    }

    get box(): NeuralAmpModelBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get labelField(): Field {return this.#box.label}
    get modelField(): Field {return this.#box.model}

    getModelJson(): string {
        return this.#box.model.getValue()
    }

    terminate(): void {}
}
```

### Phase 5: Create NeuralAmpModelService

Service for importing NAM models and managing the model boxes:

```typescript
// packages/studio/core/src/nam/NeuralAmpModelService.ts
import {isDefined, Option, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {NeuralAmpModelBox} from "@opendaw/studio-boxes"

export class NeuralAmpModelService {
    readonly #boxGraph: BoxGraph

    constructor(boxGraph: BoxGraph) {
        this.#boxGraph = boxGraph
    }

    async importModel(file: File): Promise<NeuralAmpModelBox> {
        const jsonString = await file.text()
        const jsonBuffer = new TextEncoder().encode(jsonString)
        const uuid = await UUID.sha256(jsonBuffer)
        const existing = this.findByUuid(uuid)
        if (isDefined(existing)) {
            return existing
        }
        const label = file.name.replace(/\.nam$/i, "")
        const box = NeuralAmpModelBox.create(this.#boxGraph, uuid)
        box.label.setValue(label)
        box.model.setValue(jsonString)
        return box
    }

    findByUuid(uuid: UUID.Bytes): Option<NeuralAmpModelBox> {
        for (const box of this.#boxGraph.boxesOfType(NeuralAmpModelBox)) {
            if (UUID.equals(box.address.uuid, uuid)) {
                return Option.wrap(box)
            }
        }
        return Option.None
    }
}
```

### Phase 6: Update NeuralAmpDeviceBoxAdapter

Update the adapter to use the new pointer field:

```typescript
// packages/studio/adapters/src/devices/audio-effects/NeuralAmpDeviceBoxAdapter.ts
import {NeuralAmpDeviceBox} from "@opendaw/studio-boxes"
import {Option, StringMapping, UUID, ValueMapping} from "@opendaw/lib-std"
import {Address, BooleanField, Int32Field, PointerField, StringField} from "@opendaw/lib-box"
import {Pointers} from "@opendaw/studio-enums"
import {AudioEffectDeviceAdapter, DeviceHost, Devices} from "../../DeviceAdapter"
import {LabeledAudioOutput} from "../../LabeledAudioOutputsOwner"
import {BoxAdaptersContext} from "../../BoxAdaptersContext"
import {DeviceManualUrls} from "../../DeviceManualUrls"
import {ParameterAdapterSet} from "../../ParameterAdapterSet"
import {AudioUnitBoxAdapter} from "../../audio-unit/AudioUnitBoxAdapter"
import {NeuralAmpModelBoxAdapter} from "../../nam/NeuralAmpModelBoxAdapter"

export class NeuralAmpDeviceBoxAdapter implements AudioEffectDeviceAdapter {
    readonly type = "audio-effect"
    readonly accepts = "audio"
    readonly manualUrl = DeviceManualUrls.NeuralAmp

    readonly #context: BoxAdaptersContext
    readonly #box: NeuralAmpDeviceBox
    readonly #parametric: ParameterAdapterSet
    readonly namedParameter

    constructor(context: BoxAdaptersContext, box: NeuralAmpDeviceBox) {
        this.#context = context
        this.#box = box
        this.#parametric = new ParameterAdapterSet(this.#context)
        this.namedParameter = this.#wrapParameters(box)
    }

    get box(): NeuralAmpDeviceBox {return this.#box}
    get uuid(): UUID.Bytes {return this.#box.address.uuid}
    get address(): Address {return this.#box.address}
    get indexField(): Int32Field {return this.#box.index}
    get labelField(): StringField {return this.#box.label}
    get enabledField(): BooleanField {return this.#box.enabled}
    get minimizedField(): BooleanField {return this.#box.minimized}
    get host(): PointerField<Pointers.AudioEffectHost> {return this.#box.host}
    get modelField(): PointerField<Pointers.NeuralAmpModel> {return this.#box.model}
    get monoField(): BooleanField {return this.#box.mono}
    get spectrum(): Address {return this.#box.address.append(0xFFF)}

    getModelAdapter(): Option<NeuralAmpModelBoxAdapter> {
        const target = this.#box.model.targetVertex
        if (target.isEmpty()) {return Option.None}
        return Option.wrap(
            this.#context.boxAdapters.adapterFor(target.unwrap().box, NeuralAmpModelBoxAdapter)
        )
    }

    getModelJson(): string {
        const adapter = this.getModelAdapter()
        if (adapter.isEmpty()) {return ""}
        return adapter.unwrap().getModelJson()
    }

    deviceHost(): DeviceHost {
        return this.#context.boxAdapters
            .adapterFor(this.#box.host.targetVertex.unwrap("no device-host").box, Devices.isHost)
    }

    audioUnitBoxAdapter(): AudioUnitBoxAdapter {return this.deviceHost().audioUnitBoxAdapter()}

    * labeledAudioOutputs(): Iterable<LabeledAudioOutput> {
        yield {address: this.address, label: this.labelField.getValue(), children: () => Option.None}
    }

    terminate(): void {
        this.#parametric.terminate()
    }

    #wrapParameters(box: NeuralAmpDeviceBox) {
        return {
            inputGain: this.#parametric.createParameter(
                box.inputGain,
                ValueMapping.decibel(-72.0, 0.0, 12.0),
                StringMapping.numeric({unit: "dB", fractionDigits: 1}), "input"),
            outputGain: this.#parametric.createParameter(
                box.outputGain,
                ValueMapping.decibel(-72.0, 0.0, 12.0),
                StringMapping.numeric({unit: "dB", fractionDigits: 1}), "output"),
            mix: this.#parametric.createParameter(
                box.mix, ValueMapping.linear(0.0, 1.0),
                StringMapping.percent(), "Mix")
        } as const
    }
}
```

### Phase 7: Update NeuralAmpDeviceProcessor

The processor needs to react to model pointer changes. Since the JSON is stored uncompressed, access is synchronous:

```typescript
// packages/studio/core-processors/src/devices/audio-effects/NeuralAmpDeviceProcessor.ts

// In constructor, subscribe to model pointer changes:
this.ownAll(
    // ... existing subscriptions ...
    adapter.modelField.catchupAndSubscribe(field => {
        const json = adapter.getModelJson()  // Synchronous - no compression
        this.#onModelJsonChanged(json)
    })
)
```

The existing `#onModelJsonChanged` method handles the JSON string and loads it into the WASM module. No changes needed to the model loading logic itself.

### Phase 8: Export Schema and Update Index

```typescript
// packages/studio/forge-boxes/src/schema/std/index.ts
export {NeuralAmpModelBox} from "./NeuralAmpModelBox"

// packages/studio/forge-boxes/src/index.ts
// Ensure NeuralAmpModelBox is included in the forge generation
```

### Phase 9: Register Adapter

```typescript
// packages/studio/adapters/src/BoxAdapters.ts
import {NeuralAmpModelBoxAdapter} from "./nam/NeuralAmpModelBoxAdapter"
import {NeuralAmpModelBox} from "@opendaw/studio-boxes"

// In the adapter registration:
this.#register(NeuralAmpModelBox, (context, box) => new NeuralAmpModelBoxAdapter(context, box))
```

## Migration Strategy

The deprecated field 10 approach enables seamless migration:

1. **On project load**: Field 10 (`model-json`, deprecated) is still read if present
2. **Migration check**: After loading, check each `NeuralAmpDeviceBox`:
   - If field 10 has content AND field 20 (model pointer) is empty → needs migration
3. **Migration action**:
   - Hash the JSON to get UUID
   - Find or create `NeuralAmpModelBox` with that UUID
   - Set the model pointer (field 20) to point to the model box
4. **On project save**: Field 10 is not written (deprecated), only field 20

```typescript
// packages/studio/core/src/migration/ProjectMigration.ts
async migrateNeuralAmpDevices(boxGraph: BoxGraph): Promise<void> {
    for (const device of boxGraph.boxesOfType(NeuralAmpDeviceBox)) {
        const oldJson = device.modelJson.getValue()  // Deprecated field 10
        if (oldJson.length === 0) {continue}
        if (device.model.targetVertex.nonEmpty()) {continue}  // Already migrated
        const jsonBuffer = new TextEncoder().encode(oldJson)
        const uuid = await UUID.sha256(jsonBuffer)
        let model: Option<NeuralAmpModelBox> = Option.None
        for (const box of boxGraph.boxesOfType(NeuralAmpModelBox)) {
            if (UUID.equals(box.address.uuid, uuid)) {
                model = Option.wrap(box)
                break
            }
        }
        if (model.isEmpty()) {
            const box = NeuralAmpModelBox.create(boxGraph, uuid)
            box.label.setValue("Imported Model")
            box.model.setValue(oldJson)
            model = Option.wrap(box)
        }
        device.model.refer(model.unwrap())
    }
}
```

## File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `packages/studio/enums/src/Pointers.ts` | Modify | Add `NeuralAmpModel` pointer type |
| `packages/studio/forge-boxes/src/schema/std/NeuralAmpModelBox.ts` | Create | New box schema |
| `packages/studio/forge-boxes/src/schema/std/index.ts` | Modify | Export new schema |
| `packages/studio/forge-boxes/src/schema/devices/audio-effects/NeuralAmpDeviceBox.ts` | Modify | Replace modelJson with model pointer |
| `packages/studio/adapters/src/nam/NeuralAmpModelBoxAdapter.ts` | Create | New adapter |
| `packages/studio/adapters/src/nam/index.ts` | Create | Export adapter |
| `packages/studio/adapters/src/devices/audio-effects/NeuralAmpDeviceBoxAdapter.ts` | Modify | Use model pointer |
| `packages/studio/adapters/src/BoxAdapters.ts` | Modify | Register new adapter |
| `packages/studio/core/src/nam/NeuralAmpModelService.ts` | Create | Import and manage models |
| `packages/studio/core/src/migration/ProjectMigration.ts` | Modify | Add NAM device migration |
| `packages/studio/core-processors/src/devices/audio-effects/NeuralAmpDeviceProcessor.ts` | Modify | Subscribe to model changes |
| UI components | Modify | Update model loading UI |

## Size Comparison

| Scenario | Current (modelJson) | Proposed (NeuralAmpModelBox) |
|----------|---------------------|------------------------------|
| 1 device, 1 model (400KB) | 400KB | 400KB (same) |
| 3 devices, same model | 1.2MB | 400KB (shared) |
| 3 devices, 3 different models | 1.2MB | 1.2MB (same) |
| Copy/paste device | 400KB per copy | Pointer only (~100 bytes) |

The main benefit is **sharing** - multiple devices referencing the same model don't duplicate the data.

## Testing Strategy

1. **Unit tests**:
   - Verify UUID generation is deterministic (same JSON → same UUID)
   - Test model import creates box with correct fields

2. **Integration tests**:
   - Import same model twice → same UUID, no duplicate
   - Copy device → model included in clipboard
   - Paste device → model created or reused
   - Load/save project with NAM models
   - Migration: old project with modelJson field 10 → migrated to pointer field 20

3. **Edge cases**:
   - Device with no model assigned
   - Model box deleted while device references it
