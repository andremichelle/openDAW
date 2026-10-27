# Allow defining mixdown region (#434)

**Doability:** ⭐⭐⭐⭐☆ (4/5) — range plumbing half exists, the new part is a sample-exact frame-count render path
**Type:** feature
**Scope:** medium

## What is asked
The mixdown dialog gets a "Section" dropdown:
- Entire song (today's behavior, bit-identical)
- Loop Area
- Loop Area (two passes)
- one entry per marker (label + position), section = marker to next marker, last marker to song end + tail

Every choice except Entire song and the last marker renders sample-exact to the section end, no tail.
Two passes renders the looped section twice and keeps only the second pass, so delay/reverb tails from the
end wrap into the start.

## Current behaviour / relevant code
- `packages/app/studio/src/service/Mixdowns.ts` `exportMixdown`: dialog = `AudioFormatSelector`, render =
  `OfflineEngineRenderer.start(project, Option.None, ...)`
- `packages/studio/core/src/OfflineEngineRenderer.ts` `start`: disables the loop area in the copy, takes
  `ExportConfiguration.range` (`"full" | {start, end}`, `EngineProcessorAttachment.ts:26`, no UI sets it),
  `setPosition(start)`, then `protocol.render` which stops on 10 s silence or `end + 30 s`. So a range today
  still renders a tail, never ends sample-exact.
- `packages/studio/core-wasm/src/offline-worker.ts` `step(numSamples)`: exact frame count, but a call that is
  not a multiple of `RenderQuantum` discards the rest of its last quantum, so consecutive steps must be
  quantum multiples except the final one.
- Markers: `TimelineBoxAdapter.markerTrack` (`MarkerTrackAdapter`), `MarkerBoxAdapter.position/label/plays`.
  Engine honours `plays` (jump back at section end, `crates/transport/tests/markers.rs`), `plays == 0` loops forever.

## Plan
1. `OfflineEngineRenderer`: new static `renderSection(source, section, progress, abortSignal, sampleRate)`,
   `start` untouched.
   - `section = {start: ppqn, end: ppqn, passes: 1 | 2}`
   - copy-side setup in one transaction, restored after: loop area `enabled = passes === 2`, for two passes
     `from/to = start/end`; marker track disabled so `plays` never jumps
   - `numFrames = round(tempoMap.intervalToSeconds(start, end) * sampleRate)`
   - `create`, wait for loading, `setPosition(start)`, `play()`, then `step` in chunks of
     `RenderQuantum * 375` (48000 frames) up to `passes * numFrames`, progress + abort checked per chunk
   - keep the last `numFrames` frames (two passes: frames `[numFrames, 2 * numFrames)`)
2. `packages/app/studio/src/ui/components/MixdownSectionSelector.tsx` (or a row inside the mixdown dialog
   next to `AudioFormatSelector`): `DropDown` over the sections, built from the project at dialog open.
   Model kept like `mixdownFormat` (module scope), falls back to Entire song if the chosen marker is gone.
3. `Mixdowns.exportMixdown`: Entire song keeps `OfflineEngineRenderer.start` unchanged, all others call
   `renderSection`. Suggested file name gets the section label (`name - Verse.wav`, `name - Loop.wav`).
4. Section list helper (pure, testable): loop area `from/to`, markers sorted by position, end of each =
   next marker position, last = `lastRegionAction()`. Skip zero/negative length sections.
5. Tests: section helper (markers unsorted, duplicate positions, last marker past song end), frame count for
   a tempo-automated section, two-pass slicing length.

## Decisions (2026-10-19)
- Stems export gets the same Section dropdown in this issue. `renderSection` takes the
  `Option<ExportConfiguration>` like `start`, `Mixdowns.exportStems` routes through it the same way.
- The last marker section keeps the tail: `section.tail = true` renders from the marker through the existing
  silence-detecting `protocol.render` (as Entire song does from 0), marker track still disabled.
  Every other marker section and both loop entries end sample-exact.
- Loop Area entries are offered even when the loop area is disabled in the project.

## Risks / open questions
- Loop wrap is at ppqn resolution, the second pass may start a fraction of a sample off `numFrames`.
  Inaudible, but the two-pass file is not bit-identical to a single-pass render of the same section.
- Scripting `project.mixdown()` could take the same section later, not in this issue.
