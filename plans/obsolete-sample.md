# Plan: Obsolete Sample Cleanup

## Problem
- Recorded and imported samples persist in OPFS indefinitely
- When a region is deleted, orphaned samples remain in storage
- OPFS gets crowded over time with unused samples

## Requirements
1. Identify which samples are deletable (recorded/imported vs preset/library)
2. Detect when samples become orphaned (no regions reference them)
3. Prompt user for deletion or auto-delete based on preference
4. Add StudioPreference to auto-delete without dialog

## Design Considerations

### How to mark samples as "deletable"?

**Option A: Add field to AudioFileBox schema**
- Add `source: "recorded" | "imported" | "preset"` field
- Pro: Intrinsic property, travels with the box
- Con: Schema migration needed for existing projects

**Option B: Track UUIDs separately in Project/RootBox**
- Maintain a Set of deletable sample UUIDs
- Pro: No schema change
- Con: Separate data structure, could get out of sync

### When to trigger cleanup check?
- When `AudioRegionBox` is deleted
- Verify no other regions reference the same `AudioFileBox`
- Could live in `BoxAdapters` deletion handling or dedicated manager

### Where to orchestrate?

**Project** makes sense since it:
- Already owns `boxGraph` and knows all references
- Has access to `SampleStorage` via `env`
- Already handles region deletion workflows

## Recommendation

1. Add a `source` field to `AudioFileBox` (Option A) - cleaner, source is truly a property of the sample

2. Create `SampleCleanupManager` owned by Project:
   - Listens to `DeleteUpdate` for `AudioFileBox`
   - Checks if source is recorded/imported
   - Checks for remaining references via boxGraph
   - Shows dialog or auto-deletes based on StudioPreference

3. Add StudioPreference: `auto-delete-orphaned-samples: boolean`

## Files to Modify
- `packages/studio/forge-boxes/src/schema/std/AudioFileBox.ts` - add source field
- `packages/studio/core/src/project/Project.ts` - own SampleCleanupManager
- `packages/studio/core/src/samples/SampleCleanupManager.ts` - new file
- `packages/studio/core/src/samples/SampleStorage.ts` - add delete method
- `packages/studio/core/src/StudioPreferences.ts` - add preference
