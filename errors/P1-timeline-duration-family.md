# Timeline duration family

- **status:** #1003 FIXED (confirmed) · recording origin guarded · detectors kept · **priority:** P1
- **occurrences:** 4 · **ids:** [933, 982, 998, 1003]
- **assessment:** TWO distinct origins, both now closed (see 2026-06 update). (1) **Clip-resolver float boundary (#1003, confirmed):** seconds-based audio regions carry double-precision ppqn drift; a duration-drag whose end lands on a neighbour's drifted boundary made `createTasksFromMasks` emit a `start`/`complete` task with a sub-ulp remainder that float32-truncates to 0 → `validateTrack` panic. (2) **Recording (#998 suspect):** `RecordAudio.finalizeTake` could persist a non-positive recomputed take length. The detector panics (validateTrack / createTasksFromMasks / RegionEditing.clip) are kept as safety nets (softening them is a band-aid).
- **note:** the stale memory claiming "validateTrack non-fatal" is wrong — it still panics (softening was reverted).

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

## Update (2026-06) — #1003 confirmed & fixed; recording origin guarded

**#1003 root cause CONFIRMED from its logtail (id 1003, `error.php?id=1003`).** Fresh project, drag-resizing audio regions (not recording). Track 1 had 8 packed audio regions with double-precision ppqn drift (`2080.0000000000005`, `2079.999999999999`, `2080.000000000002`, …). User dragged the selected region's end to exactly `15520`; the last region ended at `15520.000000000002` (2e-12 past). `RegionClipResolver.createTasksFromMasks` used **exact** `region.complete <= complete`, so the last region was judged to extend past the mask → a `start` task moved its start to `15520`, leaving `duration = 15520.000000000002 − 15520 ≈ 2e-12`, stored in a **float32** field → **exactly 0.0** → `validateTrack` panic `duration(0) must be positive`. Stack: `validateTrack ← RegionOverlapResolver.apply ← RuntimeNotifier.approve ← keydown capture`.

Why not rounding: ppqn is integer only for *musical* regions; seconds-audio ppqn is genuinely fractional and sample-meaningful (1 ppqn ≈ 25 samples @120bpm/48k). Rounding stored ppqn would shift audio by up to ~0.5 ppqn and not scale with project length.

**Fix shipped (clip resolver):** `RegionClipResolver` `positionIn`/`completeIn` now use a magnitude-aware `boundaryTolerance(value) = |value|·2⁻²³ + 1e-3` (≈ one float32 ulp at the boundary, scales with project length, musically nil). A region within tolerance of fully covered → `delete` instead of a zero-width `start`/`complete`. This also keeps the `separate` parts > tolerance, so the `RegionEditing.clip` `<=0` panic (#667 path via the resolver) can't fire either. Regression test `RegionClipResolver.test.ts` › "float boundary tolerance (#1003)" — RED (`start` → float32 0) → GREEN (`delete`); all 56 existing clip tests unaffected.

**Fix shipped (recording, defensive):** `RecordAudio.finalizeTake` now drops (deletes) a take whose recomputed `durationInSeconds <= 0` (loop-wrap path that bypasses the live-update pre-check) instead of persisting a 0-duration region. This is the suspected #982/#998 origin — defensive, not reproduced.

**Status:** #1003 fixed+tested. #933/#982/#998 are detector panics whose two known creation paths (clip-FP, recording-finalize) are now closed; residual unknown creators would still surface them (kept as safety nets). #667 addressed via the resolver path; `RegionEditing.clip` retains its own exact `<=0` check for any direct caller.
