# Buffer Underrun Detection (AudioPlaybackStats)

Issue #258. Detect audio dropouts (buffer underruns) via the Web Audio playback
stats API, stop the engine, suspend the context, and show a dialog so the user
can fix or reconnect their audio device.

## API (verified in Chrome)

Chrome exposes the spec name `AudioContext.playbackStats` (`AudioPlaybackStats`).
Confirmed via the debug probe, `toJSON()` returns:

```json
{
  "underrunDuration": 0,
  "underrunEvents": 0,
  "totalDuration": 37.052068,
  "averageLatency": 0.023835,
  "minimumLatency": 0,
  "maximumLatency": 0.027067
}
```

So the field names are the spec names, not the older `fallbackFrames*`. The
dropout counter we trigger on is **`underrunEvents`**. `underrunDuration` (seconds
lost) and `totalDuration` are useful for the dialog text (glitch ratio =
`underrunDuration / totalDuration`). Use `playbackStats` directly, no fallback.

Constraints from the spec: stats update at most once per second, and only while
the document is visible (or microphone permission is held). During playback the
tab is visible, so this is fine.

## No casts

`lib.dom` does not type `playoutStats`. Type it with a global declaration merge,
not an `as` cast:

```ts
interface AudioContextPlayoutStats {
    readonly fallbackFramesEvents: number
    readonly fallbackFramesDuration: number
    readonly totalFramesDuration: number
}
declare global {
    interface AudioContext {
        readonly playoutStats?: AudioContextPlayoutStats
    }
}
```

Then `audioContext.playoutStats` is typed `Optional<AudioContextPlayoutStats>`
with zero casts. Source the context from `ProjectEnv.audioContext`, which is
already typed `AudioContext`. Never go through `AudioWorklets.context`, that is a
`BaseAudioContext` and would force the cast.

(Find the right place for the `declare global` block, an existing ambient types
file if one exists, otherwise the detector module.)

## Detection (location to revisit)

NOT in `EngineWorklet`. The worklet is driven by a `BaseAudioContext`, not an
`AudioContext`, and `playoutStats` only exists on `AudioContext`. Putting it there
would force the exact `BaseAudioContext as AudioContext` cast we are avoiding.

So detection must run wherever a properly typed `AudioContext` is available. The
candidate is the main thread, polling `service.audioContext` (or
`ProjectEnv.audioContext`, both typed `AudioContext`) on a roughly 1 Hz tick. The
stats only update once per second anyway. Pick a concrete owner later, options:

- A small detector owned by `StudioService`, started once, watching
  `engine.isPlaying`.
- Hook into an existing main thread ticker (`AnimationFrame`) with a 1 s gate.

Detection rules (wherever it lands):

- Read `audioContext.playbackStats`, feature detect with `isDefined`. On non Chrome
  it is absent and detection is a no op.
- Baseline `lastUnderrunEvents` from the current `underrunEvents`. The counter is
  cumulative since context creation and the context outlives project reloads, so a
  fresh baseline avoids false triggers.
- Fire only when the event count increases AND the engine is playing. Advance the
  baseline on every increase so dropouts that happened while stopped do not fire
  later.

Open: exact owner and ticker for the main thread poll. Revisit after the Chrome
verification (debug menu entry "Show Playbackstats...") confirms the API works.

## Handling

`Project.handleBufferUnderrun()`, sibling of `handleCpuOverload()`:

```ts
handleBufferUnderrun(): void {
    this.engine.sleep()
    this.#env.audioContext.suspend().finally()
    RuntimeNotifier.info({
        headline: "Audio Dropout Detected",
        message: "Playback has been stopped because the audio device could not keep up. "
            + "Check or reconnect your audio device, then press play to resume."
    }).finally()
}
```

- `engine.sleep()` halts the DSP. The processor returns early before `render()`
  when the control flag is set (`EngineProcessor.ts:352`), so this is a real stop,
  not just a transport stop.
- `audioContext.suspend()` releases the output device so the user can swap or
  reconnect it. No cast, `#env.audioContext` is `AudioContext`.

## Recovery

Already wired. `EngineFacade.play()` resumes a suspended context and calls
`wake()`, so pressing play after fixing the device restores both. No change.

## Open questions for André

1. Preference gate? `handleCpuOverload` gates on
   `engine["stop-playback-when-overloading"]`. Underrun could be always on or get
   its own setting.
2. Detection site: a main thread poller (the worklet is ruled out, it runs on a
   `BaseAudioContext`). Owner and ticker still to decide, see Detection section.
3. Forward compat: also probe `playbackStats` (spec name) so non Chrome browsers
   work once they ship the renamed API, or stay Chrome only for now.

## Status

- Done: Chrome verification probe. Debug menu entry "Show Playbackstats..." in
  `packages/app/studio/src/service/DebugMenu.ts` dumps every `playoutStats` field
  via a dialog, with the `declare global` augmentation (no cast).

## Files touched (implementation, not yet done)

- Detection: a main thread poller, owner to be decided (not `EngineWorklet`).
- `packages/studio/core/src/project/Project.ts`: `handleBufferUnderrun()`.
