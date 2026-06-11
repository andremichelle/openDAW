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

`lib.dom` does not type `playbackStats`. Type it with an ambient global interface
merge, not an `as` cast. Lives in both packages that touch the API (separate
compilations):

- `packages/studio/core/src/env.d.ts` (next to the existing `MediaTrackSettings`
  augment), for the detector.
- `packages/app/studio/src/global.d.ts`, for the footer and the debug probe.

```ts
interface AudioPlaybackStats {
    readonly underrunDuration: number
    readonly underrunEvents: number
    readonly totalDuration: number
    readonly averageLatency: number
    readonly minimumLatency: number
    readonly maximumLatency: number
    resetLatency(): void
    toJSON(): object
}
interface AudioContext {
    readonly playbackStats?: AudioPlaybackStats
}
```

`audioContext.playbackStats` is then `AudioPlaybackStats | undefined`, no casts.
The worklet is ruled out: it runs on a `BaseAudioContext`, which has no
`playbackStats`, so reading it there would force the `BaseAudioContext as
AudioContext` cast we are avoiding.

## Detector (implemented)

`packages/studio/core/src/BufferUnderrunDetector.ts`, a `Terminable` class in core.

- Constructor `(playbackStats: AudioPlaybackStats, engine: EngineFacade)`. No
  `StudioService` and no `AudioContext` dependency, which is why it can live in core.
- Feature detection lives at the call site in `boot.ts`:
  `if (isDefined(context.playbackStats)) { new BufferUnderrunDetector(context.playbackStats, service.engine) }`.
  Absent (non Chrome) means the detector is never constructed.
- Polls `underrunEvents` every 1 s. Counts consecutive tick over tick increases,
  an isolated bump resets the streak to 0.
- On 3 consecutive increases (`CONSECUTIVE_THRESHOLD`) it treats the situation as a
  permanent overload, resets the streak, and runs the response.

Gated on the `engine["stop-playback-when-overloading"]` preference (default true),
the same setting `handleCpuOverload` uses, checked at fire time so a runtime toggle
is respected.

Response (only while `engine.isPlaying`), mirrors `Project.handleCpuOverload`:

- `engine.sleep()` is the whole stop. `EngineWorklet.sleep()` halts the DSP (the
  processor returns early before `render()`, `EngineProcessor.ts:352`), sets
  `isPlaying` false, AND issues `commands.stop(true)`, so the engine is stopped, not
  just paused. Recovery is the normal play button: `engine.play()` -> `wake()`
  clears the flag.
- `RuntimeNotifier.info(...)` tells the user to check the device and press play.

NO `context.suspend()`. It was tried and broke playback: the `stop(true)` that
`sleep()` dispatches is delivered asynchronously to the audio render thread, and
suspending freezes that thread before the command lands, stranding the transport in
a half-stopped state. The working CPU-overload path never suspends, so we don't
either. Releasing the output device would need a different mechanism (suspend only
after the engine has confirmed stop, plus resume-on-play) and is out of scope.

## Footer indicator (implemented, independent)

`packages/app/studio/src/ui/Footer.tsx`, an "Underruns" `FooterItem`. It keeps its
own 1 s poll and the same 3 consecutive increase rule, latches the number red, and
a click resets the streak and clears the colour. Deliberately independent of the
detector (separate poller, display only).

## Recovery

Pressing play calls `engine.play()` -> `worklet.play()` -> `wake()` (clears the
sleep flag), and the processor resumes `render()`.

Two fixes were needed to make recovery actually work:

1. Detector re-trigger loop. `underrunEvents` is a monotonic browser counter, and
   the audio system keeps registering fallback events while it catches up after a
   glitch. Unlike CPU load (which reads 0 once asleep, removing its own trigger),
   our counter kept climbing and re-fired the sleep. Fix: the detector polls only
   while `engine.isPlaying`, stops the instant it sleeps, and re-arms re-baselined
   when the engine plays again, so the catch-up burst is absorbed.

2. Play button stuck on "playing". The engine only broadcasts transport state from
   `render()` (`#stateSender.tryWrite()` at `EngineProcessor.ts:414`), which is
   skipped while asleep, so the stopped state never reached the UI. The play button
   stayed active, and its toggle (`if (isPlaying) stop() else play()`) called
   `stop()` instead of `play()`, so the engine never woke. Fix: the processor's
   sleep branch now calls `#stateSender.tryWrite()` before returning, reporting the
   stopped transport without doing DSP. Benefits the CPU-overload stop identically.

## Status

- Done: Chrome verification probe (`DebugMenu.ts`, "Show Playbackstats..."), dumps
  `playbackStats` via `toJSON()`. Verified the spec field names in Chrome.
- Done: footer "Underruns" indicator with 3 in a row red latch and click reset.
- Done: `BufferUnderrunDetector` in core, wired in `boot.ts`, sleep + suspend +
  dialog on overload.

## Open questions for André

1. The detector and footer poll independently with no shared state. Fine for now,
   could later share one source if it matters.
2. Forward compat / cross browser: Chrome only for now (the augment is optional, so
   other browsers are a clean no op).
