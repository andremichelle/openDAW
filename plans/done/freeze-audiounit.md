# Freeze AudioUnit

## Context

Freezing an audio unit renders its complete output offline into an `AudioData` buffer. While frozen, the unit plays from this cached audio instead of processing instruments, effects, and sends — saving CPU. The user can unfreeze to resume normal live processing.

## Overview of Changes

### 1. FrozenPlaybackProcessor (new)
`packages/studio/core-processors/src/FrozenPlaybackProcessor.ts`

A simplified processor modeled after `DirectVoice` (no-stretch playback):
- Extends `AbstractProcessor`, implements `AudioGenerator`
- Holds reference to `AudioData` and owns an `AudioBuffer` for output
- During `process({blocks})`, for each block where `transporting && playing`:
  - On **discontinuous** blocks, recalculate read position: `context.tempoMap.intervalToSeconds(0, p0) * data.sampleRate`
  - Copy samples from `data.frames[0/1]` at `readPosition` into `audioOutput` for range `s0..s1`
  - Advance `readPosition` by `s1 - s0`
  - Clamp to silence when `readPosition` exceeds `data.numberOfFrames`
- Registered with the engine's audio graph when frozen

### 2. AudioUnit changes
`packages/studio/core-processors/src/AudioUnit.ts`

- Add `#frozen: Option<{data: AudioData, processor: FrozenPlaybackProcessor}>` field (default `Option.None`)
- Add `setFrozenAudio(data: Option<AudioData>)`:
  - When `Some`: create `FrozenPlaybackProcessor`, set `#frozen` to `Option.wrap({data, processor})`
  - When `None`: terminate existing processor, set `#frozen` to `Option.None`
  - Invalidate wiring in both cases
- Add `get frozen(): Option<{data: AudioData, processor: FrozenPlaybackProcessor}>` getter (for AudioDeviceChain to check)
- `audioOutput()` stays unchanged — the channel strip output is still the final output

### 3. AudioDeviceChain wiring changes
`packages/studio/core-processors/src/AudioDeviceChain.ts`

In `#wire()`, add a frozen check at the top (after the `optInput.isEmpty()` guard):
```
if audioUnit.frozen is Some:
  wire: frozenProcessor → channelStrip → output bus (skip instrument and effects only)
  return
```

This means:
- **Instrument and effects are bypassed** (CPU saved)
- **Channel strip still active** — volume, pan, mute, solo, aux sends all work on the frozen audio
- The frozen audio is the post-effects, pre-channel-strip signal (captured during render)

Additionally, for the **offline freeze render**, add `skipChannelStrip?: boolean` (optional, defaults to `false`) to `AudioUnitOptions`:
- `packages/studio/core-processors/src/AudioUnitOptions.ts` — add optional field
- `packages/studio/adapters/src/EngineProcessorAttachment.ts` — add optional field to `ExportStemConfiguration`
- Backwards compatible: existing SDK users passing `ExportStemConfiguration` without this field get the current behavior
- In `AudioDeviceChain.#wire()`: when `skipChannelStrip` is true, wire effects → output bus directly (no channel strip, no sends)
- In `AudioUnit.audioOutput()`: when `skipChannelStrip`, return the pre-channel-strip source instead of `channelStrip.audioOutput`
  - Store the last effect's output as `#preChannelStripSource` during wiring

This ensures the freeze render captures the raw post-effects signal without channel strip processing baked in.

### 4. EngineCommands — new command
`packages/studio/adapters/src/protocols.ts`

Add to `EngineCommands` interface:
```typescript
setFrozenAudio(uuid: UUID.Bytes, audioData: Nullable<AudioData>): void
```

Implement in:
- **EngineProcessor** (`packages/studio/core-processors/src/EngineProcessor.ts`): handler calls `audioUnit.setFrozenAudio(Option.wrap(audioData))`
- **EngineWorklet** (`packages/studio/core/src/EngineWorklet.ts`): sender dispatches via `dispatcher.dispatchAndForget`
- **OfflineEngineRenderer** (`packages/studio/core/src/OfflineEngineRenderer.ts`): add no-op sender for interface compliance

AudioData uses `SharedArrayBuffer`, so it transfers through `MessagePort` without copying.

### 5. Freeze service
`packages/app/studio/src/service/AudioUnitFreeze.ts`

Namespace `AudioUnitFreeze` with:

**`hasSidechainDependents(rootBoxAdapter, audioUnitBoxAdapter): boolean`**

Pre-flight check before freezing. Returns `true` if any device in other audio units has a sidechain pointing to a device in the target unit:
1. Collect all device addresses from the target audio unit (instrument + audio effects) via `audioUnitBoxAdapter.labeledAudioOutputs()`
2. Iterate through ALL other audio units' effect chains (`rootBoxAdapter.audioUnits`)
3. For each Compressor/Gate device (those with a `sideChain` field), check if `sideChain.targetAddress` matches any address in our collected set
4. Return `true` if any match found

**`freeze(service, audioUnitBoxAdapter)`:**
1. Run `hasSidechainDependents()` — if true, show info dialog: "Cannot freeze: this audio unit is used as a sidechain source by another device" and return
2. Copy project with `project.copy()`
3. Build `ExportStemsConfiguration` targeting the audio unit:
   ```typescript
   { [uuid]: { includeAudioEffects: true, includeSends: false, useInstrumentOutput: false, skipChannelStrip: true, fileName: "freeze" } }
   ```
   - `includeAudioEffects: true` — bake effects into frozen audio
   - `includeSends: false` — sends will be handled live by channel strip during frozen playback
   - `useInstrumentOutput: false` — process through effects chain
   - `skipChannelStrip: true` — capture post-effects, pre-channel-strip signal
4. Show progress dialog via `RuntimeNotifier.progress()`
5. Render via `OfflineEngineRenderer.start(copiedProject, config, progress, abortSignal)`
6. Extract stereo `AudioData` from the render result (first 2 channels of the stem)
7. Send to engine: `engine.commands.setFrozenAudio(uuid, audioData)`
8. Track frozen state in a local `Map<string, AudioData>` for UI reactivity

**`unfreeze(service, audioUnitBoxAdapter)`:**
1. Send to engine: `engine.commands.setFrozenAudio(uuid, null)`
2. Remove from frozen state map

### 6. TrackHeaderMenu — menu items
`packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/TrackHeaderMenu.ts`

Add before the "Delete" section (with `separatorBefore: true`):
- **"Freeze AudioUnit"**: visible when not frozen, triggers `AudioUnitFreeze.freeze()`
- **"Unfreeze AudioUnit"**: visible when frozen, triggers `AudioUnitFreeze.unfreeze()`

The `hidden` property toggles based on the frozen state from the service.

### 7. Frozen UI state
`packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/TrackHeader.tsx`

- Subscribe to the freeze service's observable frozen state
- When frozen, add CSS class `frozen` to the track content area
- CSS class: `opacity: 0.5; pointer-events: none`
- The header (with menu button) remains interactive so the user can unfreeze

### 8. Engine access
Need to expose `setFrozenAudio` on the `Engine` interface so the service can call it.

`packages/studio/core/src/Engine.ts` — add `setFrozenAudio(uuid, audioData)` method that delegates to `#commands.setFrozenAudio()`.

## Key Files to Modify

| File | Change |
|------|--------|
| `packages/studio/core-processors/src/FrozenPlaybackProcessor.ts` | **New** — simplified no-stretch audio playback processor |
| `packages/studio/core-processors/src/AudioUnit.ts` | Add `#frozen` field + `setFrozenAudio()` + `skipChannelStrip` in `audioOutput()` |
| `packages/studio/core-processors/src/AudioUnitOptions.ts` | Add optional `skipChannelStrip` field |
| `packages/studio/adapters/src/EngineProcessorAttachment.ts` | Add optional `skipChannelStrip` to `ExportStemConfiguration` |
| `packages/studio/core-processors/src/AudioDeviceChain.ts` | Frozen wiring path + `skipChannelStrip` path in `#wire()` |
| `packages/studio/adapters/src/protocols.ts` | Add `setFrozenAudio` to `EngineCommands` |
| `packages/studio/core-processors/src/EngineProcessor.ts` | Handle `setFrozenAudio` command |
| `packages/studio/core/src/EngineWorklet.ts` | Add sender for `setFrozenAudio` |
| `packages/studio/core/src/OfflineEngineRenderer.ts` | Add no-op sender |
| `packages/studio/core/src/Engine.ts` | Expose `setFrozenAudio` |
| `packages/app/studio/src/service/AudioUnitFreeze.ts` | **New** — freeze/unfreeze orchestration |
| `packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/TrackHeaderMenu.ts` | Add Freeze/Unfreeze menu items |
| `packages/app/studio/src/ui/timeline/tracks/audio-unit/headers/TrackHeader.tsx` | Frozen CSS class toggle |

## Reusable Components

- `OfflineEngineRenderer.start()` — offline rendering with stem config (`packages/studio/core/src/OfflineEngineRenderer.ts`)
- `ExportStemsConfiguration` — stem routing config (`packages/studio/adapters/src/EngineProcessorAttachment.ts`)
- `AudioData.create()` — audio buffer allocation (`packages/lib/dsp/src/audio-data.ts`)
- `DirectVoice` — reference for no-stretch playback pattern (`packages/studio/core-processors/src/devices/instruments/Tape/DirectVoice.ts`)
- `AbstractProcessor` — base class for processors (`packages/studio/core-processors/src/AbstractProcessor.ts`)
- `RuntimeNotifier.progress()` — progress dialog pattern (`AudioConsolidation.flatten()` as reference)
- `Promises.tryCatch()` — async error handling

## Verification

1. Open a project with an instrument track that has audio effects
2. Right-click track header → "Freeze AudioUnit"
3. Verify progress dialog appears and rendering completes
4. Verify track content area becomes semi-transparent (`opacity: 0.5`) with no pointer events
5. Play the project — frozen track should produce the same audio as before freezing
6. Verify CPU load drops (instruments/effects not processing)
7. Seek/loop — frozen audio should stay in sync with timeline
8. Right-click header → "Unfreeze AudioUnit"
9. Verify track returns to normal appearance and live processing resumes
10. **Sidechain test**: Set up a compressor on Track B sidechained to Track A. Try to freeze Track A → should show blocking dialog
11. Freeze Track B instead (which receives the sidechain) → should succeed
