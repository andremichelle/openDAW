# Timeline duration family

- **status:** OPEN · **priority:** P1
- **occurrences:** 3 · **ids:** [933, 982, 998]
- **assessment:** Same 0-duration corruption surfacing at two panics: validateTrack ('duration must be positive', #982/#998) and createTasksFromMasks:134 ('Invalid duration', #933). #998's softening was reverted on purpose - validators panic by design so reports keep surfacing. Root cause unproven; band-aids forbidden.
- **action:** Find the 0-duration creation site (recording suspect) and fix there. See investigation below.

[< back to index](error-triage.md)

## Reports

### Error: duration(N) must be positive
- **occurrences:** 2 · **ids:** [982, 998] · **span:** 2026-05-25->2026-06-03 · **builds:** 2 · **browsers:** Chrome/CrOS, Chrome/Win
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at nt (../../../lib/std/dist/lang.js:51:67 (panic))`
  - `at Ba.validateTrack (main.af113c5a-f111-458d-b696-0aae95c95d2d.js:80:124900)`
  - `at Ba.validateTracks (main.af113c5a-f111-458d-b696-0aae95c95d2d.js:80:124786)`

### Error: Invalid duration(N)
- **occurrences:** 1 · **ids:** [933] · **span:** 2026-04-23->2026-04-23 · **builds:** 1 · **browsers:** Chrome/macOS
- **stack:**
  - `at h (../../../lib/std/dist/lang.js:49:38)`
  - `at Ca.createTasksFromMasks (main.d6fa9f56-2884-462b-9f96-1a90cb1386e3.js:55:119115)`
  - `at #r (main.d6fa9f56-2884-462b-9f96-1a90cb1386e3.js:55:120247)`
  - `at Ca.fromRange (main.d6fa9f56-2884-462b-9f96-1a90cb1386e3.js:55:118406)`


## Investigation log - 0-duration region origin

**Status: root cause NOT fixed - strong hypothesis, no fix shipped (no band-aids; validators panic by design so reports keep surfacing).**

Shared symptom of #933 (`Invalid duration`, createTasksFromMasks:134), #982/#998 (`duration must be positive`, validateTrack) and #667: a region reaches `duration === 0` and a post-commit invariant check panics. The validators run after the edit commits, so softening them is a band-aid - the real fix is to stop 0-duration regions from being created. (The #998 softening was reverted for this reason.)

**Ruled out - interactive resize modifiers (all clamp to a positive minimum):**
- `RegionDurationModifier` floors at `Math.max(Math.min(snap, duration), ...)`.
- `RegionLoopDurationModifier` floors at `Math.min(SemiQuaver, loopDuration)`.
- `RegionStartModifier.computeClampedDelta` -> new duration >= `min(duration, snap)`.
- `RegionContentStartModifier.update()` clamps delta to `duration - SemiQuaver`.
None can turn a positive region into 0; they only preserve an existing 0.

**Strong suspect - recording path (`packages/studio/core/src/capture/RecordAudio.ts`):**
- `createTakeRegion` (69-78) creates the AudioRegionBox WITHOUT setting duration/loopDuration -> starts at Float32 default until the first live update.
- Live update (270-283) writes `duration.setValue(takeSeconds)` with `takeSeconds = totalSeconds - currentWaveformOffset`, which is <= 0 early in a take / with large count-in+latency offset. Writes the box field directly, bypassing the clamped adapter setter.
- Known-fragile: line 177 comment "fixes #840: short recordings (e.g. count-in) can leave zero-duration regions"; delete-guards on stop (178-191) and loop-take transition (221-225) do not cover every slip-through.
- Corroboration: #998's session log is full of `createTakeRegion` + a `[RecordAudio] abort`; the offending `d:0` region predated the modifier that surfaced it.

**Why no fix shipped:** the recording timing/latency logic is delicate; a clamp could mask the real slip-through or break offset compensation, and the exact escaping branch is unproven.

**Next step before fixing:** reproduce short/count-in/looped takes, or add low-noise instrumentation capturing `new Error().stack` only on a non-positive duration write (e.g. at finalizeTake / the live update), to confirm the branch. Then fix at source (refuse to persist a take with duration<=0, or clamp takeSeconds). Tracked in memory project-zero-duration-region-origin.
