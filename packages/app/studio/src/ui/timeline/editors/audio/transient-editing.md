# Transient Marker Editing Implementation

GitHub Issue: https://github.com/andremichelle/opendaw/issues/114

## Overview

Allow transients to be moved, added, and deleted. Since automatic transient detection can create false or misplaced transients, manual editing is needed.

## Implementation Model

Similar to `WarpMarkerEditing.ts` pattern.

## Key Constraints

- **Minimum distance**: 50ms (0.050 seconds) between transients
- **Capturing**: Use `TempoMap` for coordinate conversion (ppqn <-> seconds)

## Open Questions

### 1. TempoMap for capturing

Currently `TransientMarkerUtils.createCapturing` uses warp markers to convert between units (ppqn) and seconds.

Options:
- Replace warp marker-based conversion with `project.tempoMap.ppqnToSeconds()` / `project.tempoMap.secondsToPPQN()`
- Keep warp marker approach for time-stretch mode, use TempoMap as fallback

### 2. Selection support

`TransientMarkerBoxAdapter` currently doesn't implement `Selectable` like `WarpMarkerBoxAdapter` does.

Need to add:
- `isSelected: boolean`
- `onSelected(): void`
- `onDeselected(): void`

This enables multi-selection for bulk delete operations.

### 3. Transient ownership

Transients are owned by `AudioFileBox.transientMarkers` (shared across all regions using that audio file).

Warp markers are owned per `AudioPlayModeBox` (per region).

**Implication**: Editing a transient affects ALL regions using that audio file.

### 4. File structure

Create new `TransientMarkerEditing.ts` file (parallel to `WarpMarkerEditing.ts`) and integrate in `TransientMarkerEditor.tsx`.

## Technical Details

### TransientMarkerBox Schema

```typescript
// packages/studio/forge-boxes/src/schema/std/TransientMarkerBox.ts
{
  owner: Pointers.TransientMarkers,  // mandatory
  position: float32 (seconds, non-negative)
}
```

### Key Files

- `TransientMarkerBoxAdapter.ts` - adapter for transient markers
- `TransientMarkerUtils.ts` - capturing and coordinate conversion utilities
- `TransientMarkerEditor.tsx` - rendering component
- `WarpMarkerEditing.ts` - reference implementation for editing pattern
- `AudioFileBoxAdapter.ts` - owns transients collection

### Coordinate System

- Transient positions are in **seconds** (audio file time)
- Timeline positions are in **ppqn** (musical time)
- Need `TempoMap` to convert between them for UI interaction

### Operations

1. **Move**: Drag transient to new position (constrained by 50ms min distance)
2. **Add**: Double-click to create new transient (constrained by 50ms min distance)
3. **Delete**: Double-click on transient OR keyboard delete OR context menu