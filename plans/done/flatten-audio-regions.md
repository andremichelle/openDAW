# Consolidate Audio Clips (Issue #162)

## Context

Audio regions on a track can have different time bases, pitch/time stretching, fading, and gain. Users need to combine multiple selected audio regions into a single region. Unlike note regions (which can be flattened synchronously by copying events), audio consolidation requires **offline rendering** of the TapeDeviceProcessor's dry output, then replacing the original regions with one region referencing the new audio file.

The "Flatten" context menu item already exists but `canFlatten` returns `false` for audio regions. We'll reuse it, branching to an async path for audio regions.

---

## Step 1: Add `useInstrumentOutput` to `ExportStemConfiguration`

**File:** `packages/studio/adapters/src/EngineProcessorAttachment.ts`

Add `useInstrumentOutput: boolean` to the type. This taps the instrument output directly (before effects/channel strip).

**File:** `packages/studio/core-processors/src/AudioUnitOptions.ts`

Add `useInstrumentOutput: false` to `Default`.

## Step 2: Wire `useInstrumentOutput` in `EngineProcessor`

**File:** `packages/studio/core-processors/src/EngineProcessor.ts`

- Change `#stemExports` from `ReadonlyArray<AudioUnit>` to `ReadonlyArray<{unit: AudioUnit, useInstrumentOutput: boolean}>`
- Update construction (~line 320) to extract the flag from configuration
- Update render output (~line 374): when `useInstrumentOutput` is true, read from `unit.input().unwrap().audioOutput` (dry signal) instead of `unit.audioOutput()` (wet signal)

## Step 3: Add `setPosition()` and `waitForLoading()` to `OfflineEngineRenderer`

**File:** `packages/studio/core/src/OfflineEngineRenderer.ts`

Add two public methods:

```typescript
setPosition(position: ppqn): void {
    this.#engineCommands.setPosition(position)
}

async waitForLoading(): Promise<void> {
    while (!await this.#engineCommands.queryLoadingComplete()) {
        await Wait.timeSpan(TimeSpan.millis(100))
    }
}
```

This enables the consolidation service to use the `step()` API (exact frame count, no silence detection/trimming) instead of `render()`.

## Step 4: Add `flattenAudioRegions` to `Mixdowns.ts`

**File:** `packages/app/studio/src/service/Mixdowns.ts`

Add a new exported function alongside `exportMixdown` and `exportStems`:

```
async flattenAudioRegions(project, sampleService, regions):
  1. Validate: all AudioRegionBoxAdapter, same track
  2. Sort regions, compute rangeMin/rangeMax (ppqn)
  3. Get AudioUnit UUID: track.audioUnit.address.uuid
  4. Copy project: project.copy()
  5. Build ExportStemsConfiguration:
     { [uuid]: { includeAudioEffects: false, includeSends: false,
                 useInstrumentOutput: true, fileName: "flatten" } }
  6. Compute duration:
     durationSeconds = project.tempoMap.intervalToSeconds(rangeMin, rangeMax)
     numSamples = Math.ceil(durationSeconds * sampleRate)
  7. Show progress dialog (RuntimeNotifier.progress)
  8. Create OfflineEngineRenderer with config
  9. renderer.waitForLoading() → renderer.setPosition(rangeMin)
     → renderer.play() → renderer.step(numSamples)
  10. Build AudioData from Float32Array[] (stereo)
  11. Encode to WAV: WavFile.encodeFloats(audioData)
  12. Import via sampleService.importFile({name, arrayBuffer})
      → returns Sample with uuid, duration, etc.
  13. Terminate renderer, dismiss dialog
  14. Inside project.editing.modify():
      a. AudioFileBoxFactory.createModifier() → AudioFileBox
      b. Delete original region boxes
      c. AudioContentFactory.createNotStretchedRegion() → new region at rangeMin
      d. project.trackUserCreatedSample(uuid)
  15. Select the new region
```

Key reusable APIs:
- `OfflineEngineRenderer.create()` + `step()` — `packages/studio/core/src/OfflineEngineRenderer.ts`
- `SampleService.importFile()` — `packages/studio/core/src/samples/SampleService.ts`
- `AudioFileBoxFactory.createModifier()` — `packages/studio/core/src/project/audio/AudioFileBoxFactory.ts`
- `AudioContentFactory.createNotStretchedRegion()` — `packages/studio/core/src/project/audio/AudioContentFactory.ts`
- `WavFile.encodeFloats()` — `packages/studio/core/src/WavFile.ts`
- `Project.trackUserCreatedSample()` — `packages/studio/core/src/project/Project.ts`
- `RuntimeNotifier.progress()` — progress dialog (already used in Mixdowns)

## Step 5: Update `AudioRegionBoxAdapter.canFlatten()`

**File:** `packages/studio/adapters/src/timeline/region/AudioRegionBoxAdapter.ts`

Update `canFlatten` (~line 267) to return `true` when:
- `regions.length > 0`
- All regions are `AudioRegionBoxAdapter`
- All on same track (`Arrays.satisfy` pattern from NoteRegionBoxAdapter)

Leave `flatten()` returning `Option.None` — the async work happens in `Mixdowns.flattenAudioRegions()`.

## Step 6: Wire in RegionContextMenu

**File:** `packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionContextMenu.ts`

Replace the Flatten trigger procedure (~line 94-96) with branching logic:

```typescript
MenuItem.default({label: "Flatten", selectable: region.canFlatten(selection.selected())})
    .setTriggerProcedure(() => {
        if (region instanceof AudioRegionBoxAdapter) {
            // Async path: offline render → import sample → replace regions
            Mixdowns.flattenAudioRegions(project, service.sampleService, selection.selected())
        } else {
            // Sync path: note/value region flattening (existing behavior)
            editing.modify(() =>
                region.flatten(selection.selected()).ifSome(box => project.selection.select(box)))
        }
    })
```

- Audio path is fire-and-forget (progress dialog handles user feedback)
- `service: StudioService` is already in the menu's `Construct` type → `service.sampleService`
- Import `AudioRegionBoxAdapter` and `Mixdowns` at the top of the file

---

## Files to modify

| File | Change |
|------|--------|
| `packages/studio/adapters/src/EngineProcessorAttachment.ts` | Add `useInstrumentOutput` to `ExportStemConfiguration` |
| `packages/studio/core-processors/src/AudioUnitOptions.ts` | Add `useInstrumentOutput: false` to `Default` |
| `packages/studio/core-processors/src/EngineProcessor.ts` | Wire `useInstrumentOutput` in stem exports + render |
| `packages/studio/core/src/OfflineEngineRenderer.ts` | Add `setPosition()` and `waitForLoading()` |
| `packages/studio/adapters/src/timeline/region/AudioRegionBoxAdapter.ts` | Update `canFlatten` |
| `packages/app/studio/src/service/Mixdowns.ts` | Add `flattenAudioRegions` function |
| `packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionContextMenu.ts` | Branch to async for audio flatten |

## Verification

1. Type-check all modified packages with `npx tsc --noEmit`
2. Existing stem export should still work (`useInstrumentOutput` defaults to `false`)
3. Manual test: select multiple audio regions on same track → right-click → Flatten → progress dialog appears → new single region created with rendered audio
