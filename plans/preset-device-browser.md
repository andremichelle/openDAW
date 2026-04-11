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

### 4. New Device Browser Categories

Expand from 3 to 5 categories:

| Category | Color | Content |
|---|---|---|
| **Audio Units** | purple/white | Full audio-unit presets (instrument + MIDI effects + audio effects) |
| **Instruments** | green | Instruments only (as today) |
| **Audio Effects** | blue | Audio effects only (as today) |
| **MIDI Effects** | orange | MIDI effects only (as today) |
| **Effect Chains** | cyan/teal | Audio-effect-only presets (no instrument, just a chain of audio effects) |

**Audio Units** contain complete `.odp` presets that include an instrument with its full signal chain. These are dragged onto an existing audio unit to replace it, or clicked to create a new one.

**Effect Chains** contain `.odp` presets that have no instrument, only a chain of audio effects. These can be dragged into the audio effects container to insert the entire chain at once.

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

### 7. New Drag Data Type

Extend `AnyDragData` with:
```typescript
type DragPreset = {
    type: "preset"
    category: "instrument" | "audio-effect" | "midi-effect" | "audio-unit" | "effect-chain"
    uuid: UUID.String
    device: string
}
```

Update `DevicePanelDragAndDrop` to handle `DragPreset`:
- For `"instrument"` / `"audio-unit"`: replace the current instrument (same as `replaceAudioUnit`)
- For `"audio-effect"` / `"effect-chain"`: insert effect(s) at drop index
- For `"midi-effect"`: insert MIDI effect at drop index

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
- `packages/studio/core/src/presets/PresetStorage.ts` - OPFS storage for presets
- `packages/studio/core/src/presets/PresetMeta.ts` - metadata type + zod schema
- `packages/studio/core/src/presets/OpenPresetAPI.ts` - cloud preset API
- `packages/studio/core/src/presets/PresetService.ts` - combines cloud + user storage, manages download state

### Modified Files
- `packages/app/studio/src/ui/browse/DevicesBrowser.tsx` - collapsible sections, triangles, preset lists, new categories, download banner
- `packages/app/studio/src/ui/browse/DevicesBrowser.sass` - triangle column, collapse animation, preset rows, banner styling
- `packages/app/studio/src/ui/AnyDragData.ts` - add `DragPreset` type
- `packages/app/studio/src/ui/devices/DevicePanelDragAndDrop.ts` - handle `DragPreset` drops
- `packages/app/studio/src/ui/devices/menu-items.ts` - user preset save/rename/delete/export/import
- `packages/app/studio/src/boot.ts` - create `PresetService` and pass to `StudioService`
- `packages/app/studio/src/service/StudioService.ts` - accept and expose `PresetService`

---

## Implementation Order

1. **PresetMeta + PresetStorage** - data layer (OPFS read/write/list for presets)
2. **OpenPresetAPI** - server list + download
3. **PresetService** - combines cloud + user, manages download state
4. **Boot integration** - wire PresetService into StudioService
5. **DevicesBrowser UI** - collapsible sections, disclosure triangles, preset lists, download banner
6. **New categories** - Audio Units and Effect Chains sections
7. **DragPreset + drop handling** - drag presets from browser to device panel
8. **User preset management** - save/rename/delete/export/import via context menus

---

## Open Questions

- Server-side: Does `api.opendaw.studio` need a new `/presets/` endpoint, or can we reuse an existing deployment pattern?
- Should effect-chain presets store just the effect boxes, or a full AudioUnit with no instrument?
- Should the "Audio Units" category show presets grouped by instrument type, or flat?
- How to handle preset compatibility when device schemas evolve (version mismatch)?
- Should cloud preset metadata include a preview/thumbnail or tags for filtering?
