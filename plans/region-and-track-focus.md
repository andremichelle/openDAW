# Region and Track Focus System

## Problem

The current copy/paste implementation has two issues:

1. **Selection order is undefined**: `regionSelection.selected()[0]` returns an arbitrary region, not the one the user interacted with
2. **Cut breaks paste**: After cut deletes regions, there's no way to determine the target track for paste

## Concept: Focus vs Selection

| Aspect | Selection | Focus |
|--------|-----------|-------|
| Cardinality | Multiple items | Single item |
| Purpose | Batch operations (delete, move, copy) | Anchor point for operations |
| Persistence | Cleared on click elsewhere | Persists until explicitly changed |
| Visual | Highlight/border | Different indicator (e.g., thicker border, glow) |

## Design

### Focus Hierarchy

```
TrackFocus (always set when in regions area)
└── RegionFocus (optional, set when a region is clicked)
```

- **TrackFocus**: The track that will receive pasted regions (offset 0 anchor)
- **RegionFocus**: The specific region that was last interacted with

### Focus Behavior

| Action | Track Focus | Region Focus |
|--------|-------------|--------------|
| Click on region | Set to region's track | Set to region |
| Click on track (empty area) | Set to track | Clear |
| Click on track header | Set to track | Clear |
| Delete focused region | Keep track focus | Clear |
| Cut regions | Keep track focus | Clear |
| Paste regions | Unchanged | Set to first pasted region |
| Click outside regions area | Clear | Clear |

### Copy/Paste with Focus

**Copy/Cut:**
- Uses `TrackFocus` as the anchor track (offset 0)
- All other tracks get offsets relative to the focused track
- After cut: `TrackFocus` remains, `RegionFocus` is cleared

**Paste:**
- Uses `TrackFocus` to determine target track index
- Regions paste at `focusedTrackIndex + metadata.offset`
- After paste: First pasted region gets focus

---

## Implementation

### New Types

```typescript
// In a new file: packages/studio/core/src/ui/timeline/TimelineFocus.ts

import {DefaultObservableValue, Option, Terminable} from "@opendaw/lib-std"
import {AnyRegionBoxAdapter, TrackBoxAdapter} from "@opendaw/studio-adapters"

export class TimelineFocus implements Terminable {
    readonly #track = new DefaultObservableValue<Option<TrackBoxAdapter>>(Option.None)
    readonly #region = new DefaultObservableValue<Option<AnyRegionBoxAdapter>>(Option.None)

    get track(): Option<TrackBoxAdapter> {return this.#track.getValue()}
    get region(): Option<AnyRegionBoxAdapter> {return this.#region.getValue()}

    get trackObservable() {return this.#track}
    get regionObservable() {return this.#region}

    focusTrack(track: TrackBoxAdapter): void {
        this.#track.setValue(Option.wrap(track))
        this.#region.setValue(Option.None)
    }

    focusRegion(region: AnyRegionBoxAdapter): void {
        region.trackBoxAdapter.ifSome(track => this.#track.setValue(Option.wrap(track)))
        this.#region.setValue(Option.wrap(region))
    }

    clearRegionFocus(): void {
        this.#region.setValue(Option.None)
    }

    clear(): void {
        this.#track.setValue(Option.None)
        this.#region.setValue(Option.None)
    }

    terminate(): void {
        this.#track.terminate()
        this.#region.terminate()
    }
}
```

### Integration Points

#### 1. Timeline/Project Level
```typescript
// In Project or Timeline
readonly timelineFocus = new TimelineFocus()
```

#### 2. RegionsArea.tsx - Focus on Click
```typescript
// When clicking on a region (in Dragging.attach or similar)
timelineFocus.focusRegion(target.region)

// When clicking on track empty area
timelineFocus.focusTrack(target.track.trackBoxAdapter)
```

#### 3. Track Header - Focus on Click
```typescript
// In TrackHeader.tsx
onClick={() => timelineFocus.focusTrack(trackBoxAdapter)
```

#### 4. RegionsClipboardHandler - Use Focus
```typescript
// Change context
readonly getFocusedTrack: Provider<Option<TrackBoxAdapter>>

// In copy:
const anchorTrack = getFocusedTrack()
if (anchorTrack.isEmpty()) {return Option.None}
// Calculate offsets relative to anchorTrack

// In paste:
const targetTrack = getFocusedTrack()
if (targetTrack.isEmpty()) {return}
```

#### 5. Region Deletion - Clear Region Focus
```typescript
// When deleting regions
if (timelineFocus.region.contains(deletedRegion)) {
    timelineFocus.clearRegionFocus()
}
```

### Visual Feedback

#### Track Focus Indicator
```css
.track[data-focused="true"] {
    /* Subtle left border or background tint */
    border-left: 2px solid var(--accent-color);
}
```

#### Region Focus Indicator
```css
.region[data-focused="true"] {
    /* Distinct from selection - e.g., thicker border or glow */
    box-shadow: 0 0 0 2px var(--focus-color);
}
```

---

## Implementation Checklist

- [ ] Create `TimelineFocus` class
- [ ] Add `timelineFocus` to Project or appropriate scope
- [ ] Update `RegionsArea.tsx` to set focus on region click
- [ ] Update `RegionsArea.tsx` to set focus on track click (empty area)
- [ ] Update track headers to set focus on click
- [ ] Update `RegionsClipboardHandler` to use `getFocusedTrack` instead of `getSelectedTrack`
- [ ] Clear region focus when focused region is deleted
- [ ] Add visual indicators for focused track and region
- [ ] Ensure focus persists after cut operation

---

## Files to Create/Modify

### New Files
```
packages/studio/core/src/ui/timeline/TimelineFocus.ts
```

### Modify
```
packages/studio/core/src/ui/index.ts - export TimelineFocus
packages/studio/core/src/project/Project.ts - add timelineFocus
packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionsArea.tsx - set focus on clicks
packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/TrackHeader.tsx - set focus on click
packages/studio/core/src/ui/clipboard/types/RegionsClipboardHandler.ts - use getFocusedTrack
```
