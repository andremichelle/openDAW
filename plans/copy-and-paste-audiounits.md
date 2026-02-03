# AudioUnit Copy & Paste

> **Prerequisite**: This plan builds upon the infrastructure defined in `copy-and-paste.md`, specifically:
> - `resource` property on BoxSchema (`"external"` | `"internal"`)
> - `stopAtResources` option in `BoxGraph.dependenciesOf()`
> - `ClipboardManager` and `ClipboardHandler` interface
> - `ClipboardUtils` for serialization/deserialization

## Overview

Copy/paste entire audio units (instruments/buses) including all their content: tracks, regions, clips, devices (instrument + effects), and automation. Uses the existing `UserEditingManager.audioUnit` context to determine which audio unit is being edited/focused.

**Scope**: Single audio unit copy/paste. Same project and cross-project paste supported via system clipboard.

> **Future**: Multi-selection copy/paste is out of scope for now (only one audio unit can be in edit mode).

## Design Principles

1. **Complete copy** - AudioUnit includes all tracks, regions, notes, automation, instrument, and effects
2. **Exclude aux sends** - Aux sends reference bus routing which is project-specific
3. **Exclude MIDI controllers** - MIDI mappings are project-specific
4. **Preserve relative track order** - Tracks maintain their relative ordering within the audio unit
5. **Insert after current** - Pasted audio unit is inserted right after the currently edited audio unit, then all indices are updated while respecting type ordering (Instruments → Buses → Output)
6. **External resources preserved** - AudioFileBox, SoundfontFileBox keep their UUIDs
7. **Single Output constraint** - Output can be copied, but pasting replaces the existing Output's devices and tracks (no duplicate outputs)

---

## What Gets Copied

### AudioUnitBox Complete Structure

```
AudioUnitBox (new UUID)
├── collection pointer → RootBox.audio-units (remapped to target RootBox)
├── output pointer → AudioBusBox (remapped to target primary bus)
│
├── TrackBox(es) (new UUID)
│   │   via: mandatory pointer to AudioUnitBox.tracks field
│   │
│   ├── AudioRegionBox(es) (new UUID)
│   │   │   via: mandatory pointer to TrackBox.regions field
│   │   │
│   │   ├── AudioFileBox (EXTERNAL - keep UUID)
│   │   │   └── TransientMarkerBox(es) (new UUID) - field-level children
│   │   │
│   │   └── ValueEventCollectionBox (new UUID) - automation
│   │       └── ValueEventBox(es) (new UUID)
│   │           └── ValueEventCurveBox(es) (new UUID) - optional
│   │
│   ├── NoteRegionBox(es) (new UUID)
│   │   │   via: mandatory pointer to TrackBox.regions field
│   │   │
│   │   └── NoteEventCollectionBox (new UUID)
│   │       └── NoteEventBox(es) (new UUID)
│   │
│   └── ValueRegionBox(es) (new UUID)
│       │   via: mandatory pointer to TrackBox.regions field
│       │
│       └── ValueEventCollectionBox (new UUID)
│           └── ValueEventBox(es) (new UUID)
│               └── ValueEventCurveBox(es) (new UUID) - optional
│
├── InstrumentDevice (new UUID)
│   │   via: mandatory host pointer to AudioUnitBox.input field
│   │
│   └── SoundfontFileBox? (EXTERNAL - keep UUID if present)
│
├── AudioEffectDevices (new UUID)
│       via: mandatory host pointer to AudioUnitBox.audio-effects field
│
├── MidiEffectDevices (new UUID)
│       via: mandatory host pointer to AudioUnitBox.midi-effects field
│
├── CaptureBox (new UUID)
│       via: mandatory pointer to AudioUnitBox.capture field
│
└── EXCLUDED:
    ├── AuxSendBox(es) - would pull in bus routing system
    └── MIDIControllerBox(es) - MIDI mappings are project-specific
```

### Metadata Structure

```typescript
type AudioUnitClipboardMetadata = {
    readonly uuid: UUID.Bytes
    readonly type: AudioUnitType  // Instrument, Bus, or Output
}
```

---

## Context: UserEditingManager

The `UserEditingManager` manages editing contexts for different parts of the UI:

```typescript
// packages/studio/adapters/src/editing/UserEditingManager.ts
export class UserEditingManager implements Terminable {
    get modularSystem(): UserEditing  // For modular system editing
    get timeline(): UserEditing       // For timeline region editing
    get audioUnit(): UserEditing      // For device chain editing ← THIS IS OUR CONTEXT
}
```

The `audioUnit` context tracks which audio unit is currently being edited via `UserInterfaceBox.editingDeviceChain`. This is set when the user clicks on an audio unit header or device chain.

---

## Implementation

### File Structure

```
packages/studio/core/src/ui/clipboard/types/AudioUnitsClipboardHandler.ts  (NEW)
```

### Content Type

`"audio-units"`

### Handler Context

```typescript
export namespace AudioUnitsClipboard {
    export type Context = {
        readonly getEnabled: Provider<boolean>
        readonly editing: BoxEditing
        readonly boxGraph: BoxGraph
        readonly boxAdapters: BoxAdapters
        readonly rootBoxAdapter: RootBoxAdapter
        readonly getEditedAudioUnit: Provider<Option<AudioUnitBoxAdapter>>
    }
}
```

### Copy Implementation

```typescript
const copyAudioUnit = (): Option<ClipboardAudioUnits> => {
    const optAudioUnit = getEditedAudioUnit()
    if (optAudioUnit.isEmpty()) {return Option.None}

    const audioUnitAdapter = optAudioUnit.unwrap()
    const audioUnitBox = audioUnitAdapter.box

    // Collect dependencies using existing infrastructure
    const dependencies = Array.from(audioUnitBox.graph.dependenciesOf(audioUnitBox, {
        alwaysFollowMandatory: true,
        stopAtResources: true,
        excludeBox: (box: Box) => {
            if (box.ephemeral) return true
            if (box.name === AuxSendBox.ClassName) return true
            if (box.name === MIDIControllerBox.ClassName) return true
            return false
        }
    }).boxes)

    // Build metadata
    const metadata: AudioUnitClipboardMetadata = {
        uuid: audioUnitBox.address.uuid,
        type: audioUnitAdapter.type
    }

    const allBoxes = [audioUnitBox, ...dependencies]
    const data = ClipboardUtils.serializeBoxes(allBoxes, encodeMetadata(metadata))
    return Option.wrap({type: "audio-units", data})
}
```

### Paste Implementation

```typescript
paste: (entry: ClipboardEntry): void => {
    if (entry.type !== "audio-units" || !getEnabled()) {return}

    const metadata = decodeMetadata(ClipboardUtils.extractMetadata(entry.data))
    const {boxGraph} = rootBoxAdapter
    const rootBox = rootBoxAdapter.box
    const primaryBusUUID = rootBoxAdapter.primaryAudioBus.uuid
    const currentAudioUnit = getEditedAudioUnit()

    // Check if we're pasting an Output
    const isOutputPaste = metadata.type === AudioUnitType.Output

    editing.modify(() => {
        if (isOutputPaste) {
            // OUTPUT PASTE: Replace existing output's content
            pasteOutputReplacement(entry.data, boxGraph, rootBoxAdapter)
        } else {
            // NORMAL PASTE: Create new audio unit after current
            pasteNewAudioUnit(entry.data, boxGraph, rootBox, primaryBusUUID, currentAudioUnit)
        }
    })
}

const pasteOutputReplacement = (
    data: ArrayBufferLike,
    boxGraph: BoxGraph,
    rootBoxAdapter: RootBoxAdapter
): void => {
    const outputAdapter = rootBoxAdapter.audioUnits.adapters().find(a => a.isOutput)
    if (!outputAdapter) return

    const outputBox = outputAdapter.box

    // Delete existing tracks and devices from output
    outputAdapter.tracks.collection.adapters().forEach(track => track.box.delete())
    outputAdapter.input.adapter().ifSome(instrument => instrument.box.delete())
    outputAdapter.midiEffects.adapters().forEach(effect => effect.box.delete())
    outputAdapter.audioEffects.adapters().forEach(effect => effect.box.delete())

    // Deserialize clipboard content, remapping to existing output
    ClipboardUtils.deserializeBoxes(
        data,
        boxGraph,
        {
            mapPointer: (pointer, address) => {
                // Remap track collection to existing output's tracks
                if (pointer.pointerType === Pointers.TrackCollection) {
                    return Option.wrap(outputBox.tracks.address)
                }
                // Remap instrument host to existing output's input
                if (pointer.pointerType === Pointers.InstrumentHost) {
                    return Option.wrap(outputBox.input.address)
                }
                // Remap effect hosts to existing output
                if (pointer.pointerType === Pointers.MIDIEffectHost) {
                    return Option.wrap(outputBox.midiEffects.address)
                }
                if (pointer.pointerType === Pointers.AudioEffectHost) {
                    return Option.wrap(outputBox.audioEffects.address)
                }
                return Option.None
            },
            excludeBox: box => box.name === AudioUnitBox.ClassName  // Don't create new AudioUnitBox
        }
    )
}

const pasteNewAudioUnit = (
    data: ArrayBufferLike,
    boxGraph: BoxGraph,
    rootBox: RootBox,
    primaryBusUUID: UUID.Bytes,
    currentAudioUnit: Option<AudioUnitBoxAdapter>
): void => {
    // Determine insert position: right after current audio unit
    const insertIndex = currentAudioUnit
        .map(adapter => adapter.indexField.getValue() + 1)
        .unwrapOrElse(() => 0)

    const boxes = ClipboardUtils.deserializeBoxes(
        data,
        boxGraph,
        {
            mapPointer: (pointer, address) => {
                if (pointer.pointerType === Pointers.AudioUnitCollection) {
                    return Option.wrap(rootBox.audioUnits.address)
                }
                if (pointer.pointerType === Pointers.AudioOutput) {
                    return address.map(addr => addr.moveTo(primaryBusUUID))
                }
                return Option.None
            }
        }
    )

    const pastedAudioUnit = boxes.find(box => box.name === AudioUnitBox.ClassName) as AudioUnitBox
    if (!pastedAudioUnit) return

    // Reorder: insert after current, then respect type ordering
    reorderAudioUnitsAfterPaste(pastedAudioUnit, insertIndex, rootBox)
}

const reorderAudioUnitsAfterPaste = (
    pastedAudioUnit: AudioUnitBox,
    desiredIndex: number,
    rootBox: RootBox
): void => {
    const allAudioUnits = IndexedBox.collectIndexedBoxes(rootBox.audioUnits, AudioUnitBox)
    const pastedType = pastedAudioUnit.type.getValue()

    // Sort: respect type ordering, but within same type, place pasted unit at desired position
    allAudioUnits.toSorted((a, b) => {
        const orderA = AudioUnitOrdering[a.type.getValue()]
        const orderB = AudioUnitOrdering[b.type.getValue()]
        const orderDiff = orderA - orderB
        if (orderDiff !== 0) return orderDiff

        // Same type: pasted unit goes to desired position
        if (a === pastedAudioUnit) return desiredIndex - b.index.getValue()
        if (b === pastedAudioUnit) return a.index.getValue() - desiredIndex
        return a.index.getValue() - b.index.getValue()
    }).forEach((box, index) => box.index.setValue(index))
}
```

---

## Installation Point

The clipboard handler should be installed on the audio unit timeline area where audio unit selection/focus occurs.

### Option A: HeadersArea (Recommended)

Install in `packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/HeadersArea.tsx`:

```typescript
lifecycle.own(ClipboardManager.install(element, AudioUnitsClipboard.createHandler({
    getEnabled: () => true,
    editing: service.project.editing,
    boxGraph: service.project.api.boxGraph,
    boxAdapters: service.project.api.boxAdapters,
    rootBoxAdapter: service.project.rootBoxAdapter,
    getEditedAudioUnit: () => {
        const vertex = service.project.editingManager.audioUnit.get()
        return vertex.flatMap(v => {
            if (v.box.name === AudioUnitBox.ClassName) {
                return Option.wrap(service.project.api.boxAdapters
                    .adapterFor(v.box as AudioUnitBox, AudioUnitBoxAdapter))
            }
            return Option.None
        })
    }
})))
```

### Option B: AudioUnitsTimeline

Install in `packages/app/studio/src/ui/timeline/tracks/audio-unit/AudioUnitsTimeline.tsx` if broader scope is needed.

---

## Edge Cases

### No AudioUnit Focused
- `canCopy()` returns false
- Copy operation silently skipped

### Output AudioUnit
- Can be copied (useful for backup/transfer scenarios)
- On paste: **replaces** existing Output's devices and tracks (project can only have one Output)
- Does NOT create a new AudioUnitBox for Output
- Existing Output's instrument, effects, and tracks are deleted and replaced with clipboard content

### AudioUnit with Aux Sends
- Aux sends are excluded from copy
- Pasted audio unit has no aux sends (user must recreate)

### AudioUnit with MIDI Controllers
- MIDI controllers are excluded from copy
- MIDI mappings are project-specific and shouldn't transfer

### External Resources (AudioFile, Soundfont)
- UUIDs preserved across copy/paste
- If external resource exists in target project, skip creation
- If external resource doesn't exist, create with same UUID

### Cross-Project Paste
- External resources are created with same UUID
- Audio files/soundfonts may not be available in target project
- Standard behavior: audio won't play until files are imported

---

## Cut Operation

Cut = Copy + Delete source audio unit.

**Output cannot be cut** (only copied). `canCut()` returns false for Output.

```typescript
canCut: (): boolean => {
    const optAudioUnit = getEditedAudioUnit()
    if (optAudioUnit.isEmpty()) return false
    // Output can be copied but not cut
    return !optAudioUnit.unwrap().isOutput
}

cut: (): Option<ClipboardAudioUnits> => {
    const optAudioUnit = getEditedAudioUnit()
    if (optAudioUnit.isEmpty()) return Option.None

    const audioUnit = optAudioUnit.unwrap()
    if (audioUnit.isOutput) return Option.None  // Safety check

    const result = copyAudioUnit()
    result.ifSome(() => {
        editing.modify(() => {
            audioUnit.box.delete()
            // Reindex remaining audio units
            rootBoxAdapter.audioUnits.reindex()
        })
    })
    return result
}
```

---

## Comparison with Existing Handlers

| Handler | Content Type | What's Copied | Context Source |
|---------|-------------|---------------|----------------|
| `DevicesClipboard` | `"devices"` | Instrument + Effects | `FilteredSelection<DeviceBoxAdapter>` |
| `RegionsClipboard` | `"regions"` | Regions + Events | `Selection<AnyRegionBoxAdapter>` |
| `NotesClipboard` | `"notes"` | NoteEvents | `Selection<NoteEventBoxAdapter>` |
| `ValuesClipboard` | `"values"` | ValueEvents | `Selection<ValueEventBoxAdapter>` |
| **`AudioUnitsClipboard`** | `"audio-units"` | Complete AudioUnit | `UserEditingManager.audioUnit` |

---

## Implementation Checklist

- [ ] Create `AudioUnitsClipboardHandler.ts` in `packages/studio/core/src/ui/clipboard/types/`
- [ ] Define `AudioUnitClipboardMetadata` type
- [ ] Implement `encodeMetadata()` / `decodeMetadata()`
- [ ] Implement `canCopy()` - audio unit is edited/focused
- [ ] Implement `canCut()` - audio unit is edited/focused AND not output
- [ ] Implement `canPaste()` - content type is "audio-units"
- [ ] Implement `copy()` - serialize with dependency collection
- [ ] Implement `cut()` - copy + delete (skip output)
- [ ] Implement `paste()` with two paths:
  - [ ] Normal paste: insert after current audio unit, reorder by type
  - [ ] Output paste: replace existing output's devices and tracks
- [ ] Add `reorderAudioUnitsAfterPaste()` helper
- [ ] Add `pasteOutputReplacement()` helper
- [ ] Install handler in HeadersArea or AudioUnitsTimeline
- [ ] Export from `packages/studio/core/src/ui/index.ts`
- [ ] Add context menu items (Cut/Copy/Paste) to audio unit header menu

---

## Files to Create/Modify

### New Files
```
packages/studio/core/src/ui/clipboard/types/AudioUnitsClipboardHandler.ts
```

### Modified Files
```
packages/studio/core/src/ui/index.ts - export AudioUnitsClipboard
packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/HeadersArea.tsx - install handler
packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/TrackHeaderMenu.ts - add Cut/Copy/Paste menu items (optional)
```

---

## Notes

### Reusing ProjectUtils

The `ProjectUtils.extractAudioUnits` function already handles the core logic of:
- Dependency collection with `stopAtResources: true`
- UUID remapping for external resources
- Output pointer remapping
- Audio unit reordering

Consider refactoring to share code between `ProjectUtils` and `AudioUnitsClipboardHandler`, or have the clipboard handler delegate to `ProjectUtils`.

### Single AudioUnit Scope

Only one audio unit can be in edit mode at a time (`UserEditingManager.audioUnit`), so multi-selection copy/paste is deferred to a future enhancement.

