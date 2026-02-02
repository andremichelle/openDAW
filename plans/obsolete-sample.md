# Plan: Obsolete Sample Cleanup

## Problem
- Recorded and imported samples are stored in OPFS via SampleStorage
- When an AudioFileBox is deleted (because no region references it), the box is removed from the BoxGraph
- However, the physical sample file remains in OPFS (SampleStorage)
- OPFS gets crowded over time with orphaned sample files

## Requirements
1. Track which samples are user-created (recorded/imported) vs preset/library
2. When a tracked AudioFileBox is deleted, delete the physical file from SampleStorage
3. Prompt user for confirmation before deletion (dialog exists)
4. Add StudioPreference to auto-delete without dialog

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

### Why It Doesn't Go Out of Sync
- The trigger is `BoxGraph.subscribeToAllUpdates` with `DeleteUpdate` for AudioFileBox
- Project already has this subscription (see `#unregisterSample`)
- When the AudioFileBox is deleted, we check if its UUID is in our tracked set
- If yes → prompt for deletion (or auto-delete based on preference)
- If no → the sample is from a saved project or library, leave it alone

## Existing Infrastructure

### Project already subscribes to AudioFileBox deletions:
```typescript
this.#terminator.own(this.boxGraph.subscribeToAllUpdates({
    onUpdate: (update) => {
        if (update instanceof NewUpdate && update.name === AudioFileBox.ClassName) {
            this.#registerSample(update.uuid)
        } else if (update instanceof DeleteUpdate && update.name === AudioFileBox.ClassName) {
            this.#unregisterSample(update.uuid)
        }
    }
}))
```

### Storage already has deleteItem method:
```typescript
// In Storage.ts base class
async deleteItem(uuid: UUID.Bytes): Promise<void> {
    const path = `${this.folder}/${UUID.toString(uuid)}`
    const uuids = await this.loadTrashedIds()
    uuids.push(UUID.toString(uuid))
    await this.saveTrashedIds(uuids)
    await Workers.Opfs.delete(path)
}
```

## Implementation

### 1. Add tracking set to Project
```typescript
// In Project class
readonly #userCreatedSamples: SortedSet<UUID.Bytes, UUID.Bytes> = UUID.newSet(uuid => uuid)

trackUserCreatedSample(uuid: UUID.Bytes): void {
    this.#userCreatedSamples.add(uuid)
}

isUserCreatedSample(uuid: UUID.Bytes): boolean {
    return this.#userCreatedSamples.hasKey(uuid)
}
```

### 2. Update deletion handler in Project
```typescript
// In the existing subscribeToAllUpdates callback
} else if (update instanceof DeleteUpdate && update.name === AudioFileBox.ClassName) {
    this.#unregisterSample(update.uuid)
    if (this.isUserCreatedSample(update.uuid)) {
        this.#promptOrDeleteSample(update.uuid)
    }
}
```

### 3. Add deletion logic
```typescript
async #promptOrDeleteSample(uuid: UUID.Bytes): Promise<void> {
    const autoDelete = StudioPreferences.settings.storage["auto-delete-orphaned-samples"]
    if (autoDelete) {
        await this.sampleManager.storage.deleteItem(uuid)
    } else {
        // Show confirmation dialog
        // If confirmed, delete
    }
    this.#userCreatedSamples.delete(UUID.toString(uuid))
}
```

### 4. Call trackUserCreatedSample after SampleStorage.save
- Called right after `SampleStorage.save()` completes successfully
- This is the safest single point for both recordings and file imports
- NOT called when dragging from stored samples (library/browser) - these don't go through save()

### 5. Add StudioPreference
```typescript
// In StudioPreferences schema
storage: {
    "auto-delete-orphaned-samples": false
}
```

## Files to Modify
- `packages/studio/core/src/project/Project.ts` - add tracking set and deletion logic
- `packages/studio/core/src/RecordingWorklet.ts` - call trackUserCreatedSample after save (line ~121, in #finalize)
- `packages/studio/core/src/samples/SampleService.ts` - call trackUserCreatedSample after save (line ~54)
- `packages/studio/core/src/StudioPreferences.ts` - add preference

## Edge Cases
- Multiple regions referencing same AudioFileBox: AudioFileBox is only deleted when ALL references are gone (handled by BoxGraph)
- Undo/redo: If deletion is undone, AudioFileBox is recreated but physical file may be gone. App handles missing samples gracefully (no crash).
