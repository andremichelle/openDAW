# Region Copy & Paste

> **Prerequisite**: This plan builds upon the infrastructure defined in `copy-and-paste.md`, specifically:
> - `resource` property on BoxSchema (`"external"` | `"internal"`)
> - `stopAtResources` option in `BoxGraph.dependenciesOf()`
> - `CopyBuffer` structure for serialization

## Overview

Copy/paste regions within the same project. Follows standard DAW conventions: paste goes to the **focused track** (not source track), with relative track offsets preserved when copying from multiple tracks.

**Scope**: Same project only. Cross-browser paste is not supported for regions.

## Design Principles

1. **Paste to focus** - Regions paste to currently focused track, not source track
2. **Relative positioning** - When copying from multiple tracks, vertical spacing is preserved
3. **Clipboard independence** - Clipboard data is self-contained; deleting source tracks has no effect
4. **Type compatibility** - ALL regions must match target track types, or entire paste is skipped
5. **Focus vs Selection** - Focus is single anchor point for paste; Selection is multiple items for batch operations

---

## Timeline Focus System

### Why Focus Instead of Selection?

Selection is unordered and can contain multiple items. When pasting, we need a single anchor point. The "focused" track/region is the most recently clicked item, which persists even after cut operations delete the selected regions.

### Implementation

```typescript
// packages/studio/core/src/ui/timeline/TimelineFocus.ts
export class TimelineFocus implements Terminable {
    readonly #track: MutableObservableOption<TrackBoxAdapter>
    readonly #region: MutableObservableOption<AnyRegionBoxAdapter>

    focusTrack(track: TrackBoxAdapter): void
    focusRegion(region: AnyRegionBoxAdapter): void
    clearRegionFocus(): void
    clear(): void
}
```

### Focus Lifecycle

- **Set on click**: Clicking a track header or region lane sets track focus
- **Set on region click**: Clicking a region sets both region and track focus
- **Cleared on deletion**: Uses `Box.subscribeDeletion()` to clear focus when the focused box is deleted
- **Visual feedback**: Focused track's RegionLane gets `.focused` class for highlighting

### Box.subscribeDeletion

New method on `Box` that subscribes to deletion events:

```typescript
// packages/lib/box/src/box.ts
subscribeDeletion(listener: Exec): Subscription {
    return this.graph.subscribeDeletion(this.address.uuid, listener)
}
```

Deletion listeners are stored in `BoxGraph.#deletionListeners` and notified during `unstageBox()`.

---

## Data Model

### What Gets Copied

#### NoteRegionBox
```
NoteRegionBox
├── events → NoteEventCollectionBox (mandatory)
│   └── NoteEventBox(es)
└── position, duration, loopOffset, loopDuration, eventOffset, mute, label, hue
```

#### AudioRegionBox
```
AudioRegionBox
├── file → AudioFileBox (EXTERNAL - keep UUID)
│   └── TransientMarkerBox(es) - field-level children
├── events → ValueEventCollectionBox (optional automation)
│   └── ValueEventBox(es)
├── playMode → AudioPlayModeBox (optional)
└── position, duration, loopOffset, loopDuration, waveformOffset, gain, fading, mute, label, hue
```

#### ValueRegionBox
```
ValueRegionBox
├── events → ValueEventCollectionBox (mandatory)
│   └── ValueEventBox(es)
└── position, duration, loopOffset, loopDuration, eventOffset, mute, label, hue
```

### Metadata Structure

```typescript
type RegionsClipboardMetadata = {
  minPosition: ppqn
  maxPosition: ppqn

  // Relative track info for each region (source-independent)
  regions: Array<{
    regionUuid: UUID.Bytes
    trackOffset: number    // 0 = topmost track, 1 = next, etc.
    trackType: TrackType   // Notes, Audio, or Value
  }>
}
```

---

## Copy Behavior

### Single Track Selection
```
Copy regions A, B from Track 3:

metadata.regions = [
  { regionUuid: A, trackOffset: 0, trackType: Notes },
  { regionUuid: B, trackOffset: 0, trackType: Notes }
]
```

### Multiple Track Selection
```
Copy from:
  Track 2: region A (Notes)
  Track 5: region B (Audio)
  Track 6: region C (Audio)

Topmost = Track 2, so offsets are relative to it:

metadata.regions = [
  { regionUuid: A, trackOffset: 0, trackType: Notes },
  { regionUuid: B, trackOffset: 3, trackType: Audio },
  { regionUuid: C, trackOffset: 4, trackType: Audio }
]
```

### Track Offset Calculation

```typescript
const calculateTrackOffsets = (
  regions: ReadonlyArray<AnyRegionBoxAdapter>,
  allTracks: ReadonlyArray<TrackBoxAdapter>
): Map<UUID.Bytes, number> => {
  // Get track indices for all regions
  const trackIndices = new Map<TrackBoxAdapter, number>()
  allTracks.forEach((track, index) => trackIndices.set(track, index))

  // Find minimum track index (topmost track with copied regions)
  const regionTrackIndices = regions
    .map(r => trackIndices.get(r.trackBoxAdapter!))
    .filter(isDefined)
  const minTrackIndex = Math.min(...regionTrackIndices)

  // Calculate offsets relative to topmost
  const offsets = new Map<UUID.Bytes, number>()
  regions.forEach(region => {
    const trackIndex = trackIndices.get(region.trackBoxAdapter!)!
    offsets.set(region.box.address.uuid, trackIndex - minTrackIndex)
  })

  return offsets
}
```

---

## Paste Behavior

### Target Resolution

1. User selects a track (or has one focused)
2. Paste anchors to that track (offset 0)
3. Other regions paste to tracks at their relative offsets

```
Clipboard:
  region A: trackOffset 0, type Notes
  region B: trackOffset 3, type Audio
  region C: trackOffset 4, type Audio

Paste with Track 5 selected (index 5):
  region A → Track 5 (5 + 0) if Notes type ✓
  region B → Track 8 (5 + 3) if Audio type ✓
  region C → Track 9 (5 + 4) if Audio type ✓
```

### Type Compatibility Check

```typescript
const canPasteToTrack = (trackType: TrackType, regionType: TrackType): boolean => {
  return trackType === regionType
}
```

| Region Type | Compatible Track Types |
|-------------|------------------------|
| NoteRegionBox | TrackType.Notes |
| AudioRegionBox | TrackType.Audio |
| ValueRegionBox | TrackType.Value |

### Skip Entire Paste on Type Mismatch

If ANY target track doesn't exist or isn't compatible, **skip entire paste**:

```
Paste with Track 5 focused (Notes track):
  region A → Track 5 (Notes) ✓
  region B → Track 8 (doesn't exist) ✗
  region C → Track 9 (exists but is Notes, not Audio) ✗

Result: Entire paste skipped (no partial paste)
```

This ensures we never create orphaned dependency boxes (clips, event collections) that would have invalid mandatory pointer requirements.

---

## Implementation

### Content Type

`"regions"`

### Copy

```typescript
const copyRegions = (
  regions: ReadonlyArray<AnyRegionBoxAdapter>,
  allTracks: ReadonlyArray<TrackBoxAdapter>,
  boxGraph: BoxGraph
): CopyBuffer => {
  const boxes = regions.map(r => r.box)

  // Collect dependencies (events, audio files, etc.)
  const dependencies = boxes.flatMap(box =>
    Array.from(boxGraph.dependenciesOf(box, {
      alwaysFollowMandatory: true,
      stopAtResources: true,
      excludeBox: box => box.ephemeral
    }).boxes))

  // Calculate track offsets
  const trackOffsets = calculateTrackOffsets(regions, allTracks)

  // Build metadata
  const positions = regions.map(r => r.position)
  const completes = regions.map(r => r.complete)

  const metadata: RegionsClipboardMetadata = {
    minPosition: Math.min(...positions),
    maxPosition: Math.max(...completes),
    regions: regions.map(r => ({
      regionUuid: r.box.address.uuid,
      trackOffset: trackOffsets.get(r.box.address.uuid)!,
      trackType: r.trackBoxAdapter!.type
    }))
  }

  return {
    version: 1,
    contentType: "regions",
    metadata: encodeMetadata(metadata),
    boxes: deduplicateByUUID([...boxes, ...dependencies]).map(box => ({
      uuid: box.address.uuid,
      name: box.name,
      data: box.toArrayBuffer(),
      resource: box.resource
    }))
  }
}
```

### Paste

```typescript
const pasteRegions = (
  buffer: CopyBuffer,
  pastePosition: ppqn,
  selectedTrack: TrackBoxAdapter,
  allTracks: ReadonlyArray<TrackBoxAdapter>,
  boxGraph: BoxGraph,
  editing: BoxEditing
): void => {
  const metadata = decodeMetadata(buffer.metadata) as RegionsClipboardMetadata
  const positionOffset = pastePosition - metadata.minPosition

  // Find selected track index
  const selectedTrackIndex = allTracks.indexOf(selectedTrack)
  if (selectedTrackIndex === -1) return

  // Build target track map: regionUuid → target TrackBox (or undefined if skip)
  const targetTracks = new Map<UUID.Bytes, TrackBox | undefined>()
  for (const regionInfo of metadata.regions) {
    const targetIndex = selectedTrackIndex + regionInfo.trackOffset
    const targetTrack = allTracks[targetIndex]

    if (targetTrack && canPasteToTrack(targetTrack.type, regionInfo.trackType)) {
      targetTracks.set(regionInfo.regionUuid, targetTrack.box)
    } else {
      targetTracks.set(regionInfo.regionUuid, undefined)  // Skip this region
    }
  }

  // Build UUID map
  const uuidMap = new Map<UUID.Bytes, UUID.Bytes>()
  buffer.boxes.forEach(({ uuid, resource }) => {
    if (resource === "external") {
      uuidMap.set(uuid, uuid)
    } else {
      uuidMap.set(uuid, UUID.generate())
    }
  })

  // Determine which regions to actually create
  const regionsToCreate = new Set(
    metadata.regions
      .filter(r => targetTracks.get(r.regionUuid) !== undefined)
      .map(r => r.regionUuid)
  )

  editing.modify(() => {
    // Filter boxes: skip external resources that exist, skip regions without target
    const boxesToCreate = buffer.boxes.filter(({ uuid, resource, name }) => {
      // Skip existing external resources
      if (resource === "external" && boxGraph.findBox(uuid).nonEmpty()) {
        return false
      }
      // Skip regions without valid target track
      if (name.endsWith("RegionBox") && !regionsToCreate.has(uuid)) {
        return false
      }
      return true
    })

    PointerField.decodeWith({
      mapPointer: (pointer) => {
        if (pointer.pointerType === Pointers.RegionCollection) {
          // Find the region this belongs to and get its target track
          const regionInfo = metadata.regions.find(r =>
            UUID.equals(uuidMap.get(r.regionUuid), pointer.sourceUuid)
          )
          if (regionInfo) {
            const targetTrack = targetTracks.get(regionInfo.regionUuid)
            if (targetTrack) {
              return Option.wrap(targetTrack.regions.address)
            }
          }
        }
        return Option.None
      },
      mapUUID: (uuid) => uuidMap.get(uuid) ?? uuid
    }, () => {
      boxesToCreate.forEach(({ name, data }) => {
        const box = boxGraph.createBoxFromBuffer(name, data)

        // Adjust region positions
        if (box instanceof NoteRegionBox || box instanceof AudioRegionBox || box instanceof ValueRegionBox) {
          box.position.setValue(box.position.getValue() + positionOffset)
        }
      })
    })
  })
}
```

---

## Edge Cases

### No Track Focused
- Silently skip paste

### Any Track Type Mismatch
- Silently skip entire paste
- No partial pastes to avoid orphaned dependency boxes

### Audio File Not in Project
- AudioFileBox created with same UUID
- Audio won't play until file is available
- Existing behavior, not a paste-specific issue

### Cut Operation
- Copy + delete source regions
- Track focus persists (not cleared by deletion of selected regions)
- Paste works because focus remained on the track

### Focused Track Deleted
- `TimelineFocus` subscribes via `Box.subscribeDeletion()`
- Focus automatically cleared when tracked box is deleted
- Works for both tracks and regions

---

## Implementation Checklist

- [x] Create `RegionsClipboardHandler` in `clipboard/types/`
- [x] Implement `canCopy()` - regions selected
- [x] Implement `canCut()` - regions selected
- [x] Implement `canPaste()` - content type is "regions" and engine not playing
- [x] Implement `copy()` - serialize with track offsets and types
- [x] Implement `cut()` - copy + delete
- [x] Implement `paste()` - deserialize with offset resolution, skip on type mismatch
- [x] Create `TimelineFocus` for track/region focus management
- [x] Add `Box.subscribeDeletion()` for cleanup on box deletion
- [x] Visual feedback - `.focused` class on RegionLane
- [x] Integrate `RegionOverlapResolver` for paste positioning
- [x] Selection after paste (select pasted regions)
- [x] Move playhead to paste end position

---

## Files Created/Modified

### New Files
```
packages/studio/core/src/ui/clipboard/types/RegionsClipboardHandler.ts
packages/studio/core/src/ui/timeline/TimelineFocus.ts
```

### Modified
```
packages/studio/core/src/project/Project.ts - added timelineFocus
packages/lib/box/src/box.ts - added subscribeDeletion()
packages/lib/box/src/graph.ts - added #deletionListeners and subscribeDeletion()
packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionsArea.tsx - focus handling, clipboard integration
packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionLane.tsx - focus visual feedback
packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionLane.sass - .focused styling
packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/TrackHeader.tsx - focus on click
```
