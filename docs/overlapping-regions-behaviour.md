# Overlapping Regions Behaviour - Implementation Notes

## Overview

Add a preference `overlapping-regions-behaviour` that controls how region overlaps are handled:
- **"clip"** (default): Truncate/clip existing regions
- **"push-existing"**: Push existing overlapped regions to track below (incoming wins)
- **"keep-existing"**: Push incoming region to track below (existing wins)

## Current State

### What's Already Implemented
1. **Preference in StudioSettings.ts** - `editing.overlapping-regions-behaviour` with options `["clip", "push-to-new-track"]`
2. **Labels in PreferencesPageLabels.ts** - UI labels for the preference
3. **RegionPushResolver.ts** - Core logic class (needs revision)
4. **Export in ui/index.ts** - RegionPushResolver is exported

### What's NOT Working
The integration into the 6 usage locations is broken. Attempts to move regions using `box.regions.refer()` after creation don't work properly.

---

## Key Learnings

### 1. Region Creation and Track Attachment
Regions are attached to tracks during creation via `box.regions.refer(targetTrack.regions)` inside `AudioContentFactory`. This happens atomically during the `BoxGraph` transaction.

### 2. Moving Regions Between Tracks
The pattern `adapter.box.regions.refer(newTrack.box.regions)` is used throughout the codebase to move regions. This DOES work when:
- Called inside an `editing.modify()` transaction
- The region already exists and is fully initialized

### 3. The Transaction Requirement
All box graph modifications MUST happen inside `editing.modify(() => { ... })`. Track creation via `ProjectApi.createAudioTrack()` modifies the graph, so it must be inside the transaction.

### 4. The Core Problem with Our Approach
When checking for overlaps, we were sometimes:
- Detecting the region being moved as "overlapping with itself"
- Not properly excluding the moving region from sibling track checks
- Creating tracks outside transactions

---

## The 6 Usage Locations

| Location | Operation | Current Behavior |
|----------|-----------|------------------|
| `RegionDragAndDrop.ts` | Drop sample onto timeline | Creates region, then clips overlaps |
| `ProjectApi.ts:duplicateRegion` | Duplicate region (Cmd+D) | Copies region, then clips overlaps |
| `RegionMoveModifier.ts` | Drag region to move | Moves region, then clips overlaps |
| `RegionDurationModifier.ts` | Drag region end to resize | Resizes region, then clips overlaps |
| `RegionStartModifier.ts` | Drag region start to resize | Resizes region, then clips overlaps |
| `RegionLoopDurationModifier.ts` | Drag loop end | Resizes loop, then clips overlaps |

---

## How RegionClipResolver Works (Current "clip" Behavior)

```typescript
// Called BEFORE the transaction with read-only state
const solver = RegionClipResolver.fromSelection(modifiedTracks, adapters, strategy, deltaIndex)

// Inside transaction: apply changes, then call solver
editing.modify(() => {
    // Apply position/track changes to regions
    adapters.forEach(adapter => { ... })
    // Solver clips any overlapping regions
    solver()
})
```

Key insight: `RegionClipResolver.fromSelection()` captures the BEFORE state, computes what needs to be clipped, and returns a function that applies the clips inside the transaction.

---

## Implementation Architecture

### Unified Class: RegionOverlapResolver

Single class on `Project` that handles both "clip" and "push-to-new-track" based on preference.

```typescript
// In Project:
readonly overlapResolver: RegionOverlapResolver

// Usage in modifiers (simple!):
project.overlapResolver.apply(adapters, strategy, deltaIndex, () => {
    // Apply position/track changes
})

// For range-based operations (drop, duplicate):
project.overlapResolver.applyRange(track, from, to, excludeRegion, () => {
    // Create region
})
```

### RegionOverlapResolver Class

```typescript
class RegionOverlapResolver {
    readonly #project: Project

    constructor(project: Project) {
        this.#project = project
    }

    // For selection-based operations (move, resize)
    apply(
        adapters: ReadonlyArray<AnyRegionBoxAdapter>,
        strategy: RegionModifyStrategies,
        deltaIndex: int,
        changes: () => void
    ): void {
        const behaviour = StudioPreferences.settings.editing["overlapping-regions-behaviour"]
        // Derive tracks from adapters
        // Capture overlapped regions before changes
        this.#project.editing.modify(() => {
            changes()
            if (behaviour === "push-to-new-track") {
                // Move overlapped regions to tracks below
            } else {
                // Clip overlapped regions
            }
        })
    }

    // For range-based operations (drop, duplicate)
    applyRange(
        track: TrackBoxAdapter,
        from: ppqn,
        to: ppqn,
        excludeRegion: Optional<AnyRegionBoxAdapter>,
        changes: () => void
    ): void
}
```

### Internal Logic

1. **Derive tracks** from `adapters` - no need to pass explicitly
2. **Capture phase** (before `editing.modify`):
   - Find regions that will overlap with new bounds
   - Exclude the regions being moved/resized
3. **Execute phase** (inside `editing.modify`):
   - Call `changes()` lambda
   - Based on preference:
     - **"clip"**: truncate/split overlapped existing regions
     - **"push-existing"**: move overlapped existing regions to track below
     - **"keep-existing"**: move incoming region(s) to track below

---

## Critical Details

### Track Types
- `TrackType.Audio` - Audio regions
- `TrackType.Notes` - MIDI/Note regions
- `TrackType.Value` - Automation (should NOT use push behavior)

### Finding Sibling Tracks
```typescript
const siblingTracks = audioUnit.tracks.pointerHub.incoming()
    .map(vertex => vertex.box as TrackBox)
    .filter(trackBox => trackBox.type.getValue() === trackType)
    .sort((a, b) => a.index.getValue() - b.index.getValue())
```

### Creating New Tracks
```typescript
// Must be inside transaction!
projectApi.createAudioTrack(audioUnit, insertIndex)  // Returns TrackBox
projectApi.createNoteTrack(audioUnit, insertIndex)   // Returns TrackBox
```

### Track Index vs List Index
- `track.indexField.getValue()` - The track's index within its audio unit
- `track.listIndex` - The track's visual index in the timeline (used by TracksManager)

---

## Test Scenarios

1. **Drop on empty track** - No overlap, region stays on target track
2. **Drop on occupied position** - Overlap detected, region goes to new/existing track below
3. **Move to empty position** - No overlap, region moves normally
4. **Move to occupied position** - Overlap detected, region goes to new/existing track
5. **Move back to original position** - Region should return to original track if space available
6. **Resize into occupied space** - Region should be pushed to new track
7. **Duplicate into occupied space** - Duplicate should go to new track

---

## Code Style Guidelines

1. **Compact code** - Minimize verbosity, keep it tight
2. **Single `editing.modify()` call** - Both behaviors should use one transaction
3. **Use built-in copy methods** - Leverage `region.copyTo()` from adapters
4. **Clear code blocks** - Distinct if/else for "clip" vs "push-to-new-track"
5. **Extract if heavy** - If logic is complex, extract to `RegionMoveModifierApprover.ts` or similar

### Target Structure (RegionMoveModifier.approve example)
```typescript
approve(editing: BoxEditing): void {
    // ... validation ...

    const behaviour = StudioPreferences.settings.editing["overlapping-regions-behaviour"]
    if (behaviour === "push-to-new-track") {
        // Clear, self-contained block for push behavior
        editing.modify(() => {
            // All push logic here
        })
    } else {
        // Clear, self-contained block for clip behavior
        editing.modify(() => {
            // All clip logic here
        })
    }
}
```

---

## Resolved Specification

### Three Modes

| Mode | Who moves? | Use case |
|------|------------|----------|
| **clip** | Nobody moves, existing gets truncated | Traditional DAW behavior |
| **push-existing** | Existing regions move down | "My action wins" - incoming stays where I put it |
| **keep-existing** | Incoming region moves down | "Don't touch my arrangement" - existing stays |

### Rules (for push modes)
1. **Direction**: Always push to tracks BELOW
2. **Track selection**: Look at ALL existing tracks of same type below for available space, otherwise create new track directly below
3. **Entire regions**: Push the complete region, no clipping/truncating
4. **Multiple overlaps**: All overlapping regions go to the same target track
5. **No cascade**: Pushed regions go to tracks with guaranteed space (existing with room, or new)

### Behavior by Operation (push-existing)
| Operation | What happens |
|-----------|--------------|
| Drop sample | Sample lands at drop position, overlapped regions pushed down |
| Move region | Region goes to drag destination, overlapped regions pushed down |
| Resize region | Region extends/contracts, newly overlapped regions pushed down |
| Duplicate | Duplicate lands at target position, overlapped regions pushed down |
| Copy (Cmd+drag) | Copy lands at drag destination, overlapped regions pushed down |

### Behavior by Operation (keep-existing)
| Operation | What happens |
|-----------|--------------|
| Drop sample | If overlap, sample goes to track below |
| Move region | If overlap at destination, moved region goes to track below |
| Resize region | If overlap after resize, resized region goes to track below |
| Duplicate | If overlap, duplicate goes to track below |
| Copy (Cmd+drag) | If overlap, copy goes to track below |
