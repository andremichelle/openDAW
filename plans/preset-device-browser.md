# Preset Device Browser

## Motivation

The current DevicesBrowser lists devices as flat lists in three categories (Instruments, Audio Effects, MIDI Effects). There is no built-in preset library. Presets exist only as `.odp` files the user manually saves/loads via the file picker. This plan introduces a preset system integrated into the device browser, two new categories (Audio Units, Effect Chains), collapsible sections, and a cloud/local preset storage backed by OPFS.

---

## Current State

### DevicesBrowser (`packages/app/studio/src/ui/browse/DevicesBrowser.tsx`)
- Three sections: Instruments (green), Audio Effects (blue), MIDI Effects (orange)
- Each device is a `<li>` with icon, name, brief description
- Instruments: click to create, drag to replace
- Effects: click to append to selected audio unit, drag to insert at index
- DragAndDrop via `DragAndDrop.installSource()` with `DragDevice` data

### Preset System (`packages/studio/adapters/src/preset/`)
- `PresetEncoder.encode(audioUnitBox)` serializes an AudioUnit (instrument + effects) to binary `.odp`
- `PresetDecoder.decode(bytes, target)` imports a preset into a project
- `PresetDecoder.replaceAudioUnit(arrayBuffer, targetAudioUnitBox, options)` replaces a device in-place
- Header: magic `0x4F505245` + version 1
- Currently only accessible via right-click context menu on devices

### OPFS Storage (`packages/lib/fusion/src/opfs/`, `packages/studio/core/src/Storage.ts`)
- Worker-based access via `Workers.Opfs` (read/write/delete/list/exists)
- Folder pattern: `{type}/{version}/{uuid}/` with `meta.json` + binary data
- Used for: `projects/v1/`, `samples/v2/`, `soundfont/`
- Abstract `Storage<>` base class with list, delete, trash management

### Cloud API Pattern (`packages/studio/core/src/samples/OpenSampleAPI.ts`)
- API at `https://api.opendaw.studio/{type}/`
- Assets at `https://assets.opendaw.studio/{type}/`
- List endpoint returns metadata array, download by UUID with progress streaming

---

## Plan

### 1. Preset Storage in OPFS

Two folders for presets, following the existing storage pattern:

```
presets/cloud/{device-key}/{uuid}/
    preset.odp          (binary preset data)
    meta.json           (PresetMeta: name, device, tags, timestamp)

presets/user/{device-key}/{uuid}/
    preset.odp
    meta.json
```

The `{device-key}` subfolder (e.g. `Vaporisateur`, `Compressor`) groups presets by device for fast lookup. This avoids scanning all presets when expanding a single device's preset list.

**PresetMeta schema:**
```typescript
type PresetMeta = {
    uuid: UUID.String
    name: string
    device: string           // device key (e.g. "Vaporisateur", "Delay")
    category: "instrument" | "audio-effect" | "midi-effect" | "audio-unit" | "effect-chain"
    author: string
    description: string
    created: number          // epoch ms
}
```

**New class:** `PresetStorage` extending `Storage` with:
- `listForDevice(deviceKey: string): Promise<ReadonlyArray<PresetMeta>>`
- `save(preset: { uuid, name, device, category, data: ArrayBuffer }): Promise<void>`
- `load(uuid: UUID.Bytes): Promise<ArrayBuffer>`
- `delete(uuid: UUID.Bytes): Promise<void>`
- Two instances: `PresetStorage.cloud("presets/cloud")` and `PresetStorage.user("presets/user")`

### 2. Server API for Cloud Presets

New API endpoint following the samples/soundfonts pattern:

```
GET  https://api.opendaw.studio/presets/list.json
     -> Array<PresetMeta>

GET  https://assets.opendaw.studio/presets/{uuid}
     -> binary .odp file
```

**New class:** `OpenPresetAPI` (in `packages/studio/core/src/presets/`)
- `all(): Promise<ReadonlyArray<PresetMeta>>` - fetches the full list
- `load(uuid: UUID.Bytes, progress): Promise<ArrayBuffer>` - downloads a single preset with progress

### 3. Preset Download Flow (User-Initiated)

Instead of auto-downloading all presets on boot, the browser shows a **"Download Presets"** banner at the top of the device browser when cloud presets have not been downloaded yet.

**Behavior:**
- On first load (no `presets/cloud/` in OPFS), show a banner: `"Download Presets"` link + dismiss (X) button
- Clicking the link fetches the preset list from the server, then downloads all `.odp` files into `presets/cloud/{device-key}/{uuid}/`
- Progress shown via `RuntimeNotifier.progress()` (same pattern as sample uploads)
- The dismiss button hides the banner for the session. A flag in `localStorage` (`presets-banner-dismissed`) persists the dismissal across sessions
- After download completes, the device browser refreshes and shows the triangles with preset counts
- Subsequent loads skip the banner if `presets/cloud/` already has content
- A "Re-download Presets" option in a settings or context menu allows refreshing the cloud presets later

### 4. PassthroughDevice (No-Op Instrument for Effect Chains)

Effect chain presets need a valid AudioUnit in the BoxGraph, but have no real instrument. We introduce a **PassthroughDeviceBox** — a minimal instrument that passes audio through unchanged.

**Schema** (`packages/studio/forge-boxes/src/schema/devices/instruments/PassthroughDeviceBox.ts`):
```typescript
export const PassthroughDeviceBox: BoxSchema<Pointers> =
    DeviceFactory.createInstrument("PassthroughDeviceBox", "audio", {})
```

No custom fields — just the standard instrument attributes (host, label, icon, enabled, minimized).

**Processor**: Reuse the existing `NopDeviceProcessor` pattern (already used for `UnknownAudioEffectDevice` and `ModularDeviceBox`). Create a `PassthroughDeviceProcessor` that implements `InstrumentDeviceProcessor` the same way — copies input to output, returns `Option.None` for `noteEventTarget`.

**Registration**:
- Add `PassthroughDeviceBox` to `DeviceDefinitions` in `forge-boxes/src/schema/devices/index.ts`
- Add `visitPassthroughDeviceBox` to `InstrumentDeviceProcessorFactory` in `DeviceProcessorFactory.ts`
- Add `PassthroughDeviceBoxAdapter` to the adapters package
- Add a `PassthroughFactory` to `InstrumentFactories` (internal only, not shown in the Instruments list)

**Usage**: When saving an effect chain preset, the encoder wraps the audio effects in an AudioUnit with a Passthrough instrument. When loading, `PresetDecoder.replaceAudioUnit` with `keepMIDIEffects: true` extracts only the audio effects. The Passthrough device itself is discarded during import — it never appears in the user's project.

### 5. New Device Browser Categories

Expand from 3 to 5 categories:

| Category | Color | Content |
|---|---|---|
| **Audio Units** | purple/white | Full audio-unit presets (instrument + MIDI effects + audio effects) |
| **Instruments** | green | Instruments only (as today) |
| **Audio Effects** | blue | Audio effects only (as today) |
| **MIDI Effects** | orange | MIDI effects only (as today) |
| **Effect Chains** | cyan/teal | Audio-effect-only presets (Passthrough instrument + audio effects chain) |

**Audio Units** contain complete `.odp` presets that include an instrument with its full signal chain. These are dragged onto an existing audio unit to replace it, or clicked to create a new one.

**Effect Chains** contain `.odp` presets with a PassthroughDevice as the instrument and only audio effects in the chain. On import, the Passthrough is stripped and only the audio effects are inserted.

### 5. Collapsible Sections

Each category section gets a collapse/expand toggle:

- Click on the `<h1>` header to toggle collapse
- Collapsed state stored per-category in `localStorage` (`device-browser-collapsed:{category}`)
- Default: all expanded
- Animation: CSS transition on `max-height` or use the `hidden` class for simplicity

### 6. Disclosure Triangles for Device Presets

Each device `<li>` gets a disclosure triangle (CSS triangle or SVG chevron) in front of the icon:

```
  > [icon] Vaporisateur    Subtractive Synth
```

- **Triangle closed (>)**: default state, device row only
- **Triangle open (v)**: expands an indented preset list below the device

**Preset list rendering:**
```
  v [icon] Vaporisateur    Subtractive Synth
       Fat Bass Lead
       Warm Pad
       Pluck Arp
       + Save Current...
```

- Each preset row is draggable (same DragAndDrop system, new `DragPreset` data type)
- Click a preset to apply it to the selected audio unit (via `PresetDecoder.replaceAudioUnit`)
- Drag a preset to the device panel (same targets as devices, but loads the preset instead of creating a default device)
- Cloud presets shown first, then a separator, then user presets
- "Save Current..." row (only visible when an audio unit is selected) saves the current device state as a user preset via `PresetEncoder.encode`

### 8. New Drag Data Types

**Individual presets** (from disclosure triangle lists):
```typescript
type DragPreset = {
    type: "preset"
    category: "instrument" | "audio-effect" | "midi-effect" | "audio-unit"
    uuid: UUID.String
    device: string
}
```

**Effect chain presets** get their own drag type because they behave like dragging a single audio effect (insert marker, index-based positioning) but create multiple effects at the drop index:
```typescript
type DragEffectChain = {
    type: "effect-chain"
    uuid: UUID.String
}
```

**Drop handling in `DevicePanelDragAndDrop`:**

- `DragPreset` with `category: "instrument"` or `"audio-unit"`: replace the current instrument via `PresetDecoder.replaceAudioUnit`
- `DragPreset` with `category: "audio-effect"`: insert a single effect at drop index (load preset, decode, insert)
- `DragPreset` with `category: "midi-effect"`: insert a single MIDI effect at drop index
- `DragEffectChain`: uses the **same drag UX as a single audio effect** — shows an insert marker in `audioEffectsContainer`, computes the drop index via `DragAndDrop.findInsertLocation`. On drop:
  1. Load the `.odp` preset from OPFS
  2. Decode the AudioUnit via `PresetDecoder` into a temporary skeleton
  3. Extract all audio effect boxes from the source AudioUnit (skip the Passthrough instrument)
  4. Insert them sequentially into the target AudioUnit's `audioEffects` field starting at the drop index
  5. Each effect gets `index = dropIndex + i` and existing effects at `>= dropIndex` are shifted up

This means the drag feedback (insert marker between existing effects) is identical to dragging a single effect, but the drop creates the full chain in one editing transaction.

### 8. Panel Width

- Expand the minimum width of the browser panel to accommodate the wider preset list
- The `grid-template-columns: auto auto 1fr` in `DevicesBrowser.sass` already allows flexible width
- Add a triangle column: `grid-template-columns: auto auto auto 1fr`
- Consider increasing the panel's base width from the current flexible layout to ~280px minimum

### 9. User Preset Management

- **Save**: "Save Current..." in the expanded preset list, or right-click context menu on a device in the panel
- **Rename**: right-click context menu on user preset
- **Delete**: right-click context menu on user preset (cloud presets cannot be deleted)
- **Export**: right-click context menu -> "Export as .odp" (file picker save)
- **Import**: right-click context menu on device -> "Import Preset..." (file picker open, saves to user folder)

---

## File Changes

### New Files
- `packages/studio/forge-boxes/src/schema/devices/instruments/PassthroughDeviceBox.ts` - no-op instrument schema (zero custom fields)
- `packages/studio/core-processors/src/devices/instruments/PassthroughDeviceProcessor.ts` - passthrough audio processor (copies input to output, `noteEventTarget: Option.None`)
- `packages/studio/core/src/presets/PresetStorage.ts` - OPFS storage for presets
- `packages/studio/core/src/presets/PresetMeta.ts` - metadata type + zod schema
- `packages/studio/core/src/presets/OpenPresetAPI.ts` - cloud preset API
- `packages/studio/core/src/presets/PresetService.ts` - combines cloud + user storage, manages download state

### Modified Files
- `packages/studio/forge-boxes/src/schema/devices/index.ts` - add `PassthroughDeviceBox` to `DeviceDefinitions`
- `packages/studio/core-processors/src/DeviceProcessorFactory.ts` - add `visitPassthroughDeviceBox` to `InstrumentDeviceProcessorFactory`
- `packages/studio/adapters/src/factories/InstrumentFactories.ts` - add internal `Passthrough` factory (not exported in `Named`)
- `packages/studio/adapters/src/preset/PresetEncoder.ts` - add `encodeEffectChain(audioEffectsField)` that wraps effects in a Passthrough AudioUnit
- `packages/studio/adapters/src/preset/PresetDecoder.ts` - add `insertEffectChain(arrayBuffer, targetAudioUnit, insertIndex)` that strips the Passthrough and inserts only audio effects at the given index
- `packages/app/studio/src/ui/browse/DevicesBrowser.tsx` - collapsible sections, triangles, preset lists, new categories, download banner
- `packages/app/studio/src/ui/browse/DevicesBrowser.sass` - triangle column, collapse animation, preset rows, banner styling
- `packages/app/studio/src/ui/AnyDragData.ts` - add `DragPreset` and `DragEffectChain` types
- `packages/app/studio/src/ui/devices/DevicePanelDragAndDrop.ts` - handle `DragPreset` and `DragEffectChain` drops (effect chain uses same insert-marker UX as single audio effect)
- `packages/app/studio/src/ui/devices/menu-items.ts` - user preset save/rename/delete/export/import
- `packages/app/studio/src/boot.ts` - create `PresetService` and pass to `StudioService`
- `packages/app/studio/src/service/StudioService.ts` - accept and expose `PresetService`

---

## Implementation Order

1. **PassthroughDeviceBox** - schema, processor, adapter, factory (internal-only instrument)
2. **PresetMeta + PresetStorage** - data layer (OPFS read/write/list for presets)
3. **OpenPresetAPI** - server list + download
4. **PresetService** - combines cloud + user, manages download state
5. **PresetEncoder/Decoder extensions** - `encodeEffectChain` and `insertEffectChain` using Passthrough
6. **Boot integration** - wire PresetService into StudioService
7. **DevicesBrowser UI** - collapsible sections, disclosure triangles, preset lists, download banner
8. **New categories** - Audio Units and Effect Chains sections
9. **DragPreset + DragEffectChain + drop handling** - effect chain drag uses same insert-marker UX as single effect, creates full chain at drop index
10. **User preset management** - save/rename/delete/export/import via context menus

---

## Open Questions

- Server-side: Does `api.opendaw.studio` need a new `/presets/` endpoint, or can we reuse an existing deployment pattern?
- Should the "Audio Units" category show presets grouped by instrument type, or flat?
- How to handle preset compatibility when device schemas evolve (version mismatch)?
- Should cloud preset metadata include a preview/thumbnail or tags for filtering?
