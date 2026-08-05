# Plan: Obsolete Sample Cleanup

## Status: FULLY IMPLEMENTED

## Problem
- Recorded and imported samples are stored in OPFS via SampleStorage
- When an AudioFileBox is deleted (because no region references it), the box is removed from the BoxGraph
- However, the physical sample file remains in OPFS (SampleStorage)
- OPFS gets crowded over time with orphaned sample files

## Requirements
1. ✅ Track which samples are user-created (recorded/imported) vs preset/library
2. ✅ When a tracked AudioFileBox is deleted, delete the physical file from SampleStorage
3. ✅ Prompt user for confirmation before deletion
4. ✅ Add StudioPreference to auto-delete without dialog

## Design Decision: Option B - Track in Project

### Why Not Option A (Field on AudioFileBox)
Adding a `source` field to AudioFileBox schema doesn't work because:
- The field would be persisted when saving/loading the project
- After save/load, even library samples would have the source field set
- No way to distinguish between "originally imported" vs "loaded from saved project"

### Option B: Track UUIDs in Project (Chosen)
- Project maintains a `SortedSet<UUID.Bytes>` of user-created sample UUIDs
- This set is NOT persisted with the project (runtime-only)
- Only NEWLY created samples are tracked:
  - Recordings (new audio captured)
  - File imports from outside (drag from filesystem, file picker)
- NOT tracked:
  - Samples dragged from already stored samples (library/browser)
- When an AudioFileBox is deleted and its UUID is in the set, delete from SampleStorage

## Implementation Summary

### Files Modified

1. **`packages/studio/core/src/project/Project.ts`**
   - Added `#userCreatedSamples: SortedSet<UUID.Bytes, UUID.Bytes>` field
   - Added `trackUserCreatedSample(uuid: UUID.Bytes): void` public method
   - Added `#deleteUserCreatedSample(uuid: UUID.Bytes): void` private method
   - Updated `subscribeToAllUpdates` to call `#deleteUserCreatedSample` on AudioFileBox deletion
   - Checks `StudioPreferences.settings.storage["auto-delete-orphaned-samples"]`
   - Shows confirmation dialog via `RuntimeNotifier.approve()` if not auto-delete

2. **`packages/studio/core/src/StudioSettings.ts`**
   - Added `storage` section with `auto-delete-orphaned-samples` boolean (default: false)

3. **`packages/app/studio/src/ui/pages/PreferencesPageLabels.ts`**
   - Added labels for "Storage" section and "Auto-delete orphaned samples" preference

4. **`packages/studio/core/src/capture/RecordAudio.ts`**
   - Subscribe to recordingWorklet state changes
   - When state becomes "loaded", call `project.trackUserCreatedSample(originalUuid)`

5. **`packages/app/studio/src/ui/devices/SampleSelector.ts`**
   - In `browse()`: Track sample after successful import
   - In `configureDrop()`: Track sample when dropping file (not when dropping existing sample)

6. **`packages/app/studio/src/ui/timeline/tracks/audio-unit/TimelineDragAndDrop.ts`**
   - In `drop()`: Track sample when dropping file (not when dropping existing sample)

7. **`packages/app/studio/src/ui/pages/CodeEditorPage.tsx`**
   - In `addSample()`: Track sample after import if project exists

## Edge Cases
- Multiple regions referencing same AudioFileBox: AudioFileBox is only deleted when ALL references are gone (handled by BoxGraph)
- Undo/redo: If deletion is undone, AudioFileBox is recreated but physical file may be gone. App handles missing samples gracefully (no crash).
