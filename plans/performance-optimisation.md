# Performance Optimisation Plan

## Context

CPU load has roughly doubled across projects over the last weeks. The HRClock performance meter now makes
this visible. Three areas of avoidable overhead have been identified in the audio-thread hot path.

Additionally, `AnimationFrame` was running at 120fps on ProMotion displays — now throttled to 60fps.

---

## 1. BlockRenderer: Eliminate allocation in render loop [DONE]

**File:** `packages/studio/core-processors/src/BlockRenderer.ts:118`

Replaced `Array.from(Iterables.take(markerTrack.events.iterateFrom(p0), 2))` with direct
`floorLastIndex` + `optAt` lookups. Zero allocations.

---

## 2. Scriptable Device Processors: Pre-allocate and reduce per-block waste [DONE]

**Files:**
- `packages/studio/core-processors/src/devices/audio-effects/WerkstattDeviceProcessor.ts`
- `packages/studio/core-processors/src/devices/instruments/ApparatDeviceProcessor.ts`
- `packages/studio/core-processors/src/devices/midi-effects/SpielwerkDeviceProcessor.ts`

**Changes applied:**
- **Werkstatt**: Reuse `#io` instance field instead of allocating `UserIO` per block.
- **Apparat**: Dirty-flag on sample slots; `#pollSamples` only runs when `#samplesDirty` is set.
- **Spielwerk**: Reuse `#events` array (clear via `length = 0`) and `#userBlock` instance field.
  Iterator uses index-based traversal instead of closure over `events[Symbol.iterator]()`.
- **All three**: `parseUpdate()` regex replaced with cached `#pendingUpdate` set by code subscription.
  No regex in the hot path.

**Not applied (deferred):**
- `validateOutput` opt-in countdown — kept for safety; can revisit if profiling shows it matters.

---

## 3. Maximizer: Reduce per-sample transcendental calls [DONE]

**File:** `packages/studio/core-processors/src/devices/audio-effects/MaximizerDeviceProcessor.ts`

Cached `dbToGain(MAGIC_HEADROOM - threshold)` as `#headroomGain`. Updated in `parameterChanged()`.
Per-sample loop uses the cached value when the threshold ramp is not interpolating (steady state, 99.9%
of the time). During the brief 10ms ramp, the per-sample computation is preserved for correctness.

---

## Further Investigation Needed

These changes address GC pressure and unnecessary computation, but the user reports the regression is
not GC-related — it is a **general** slowdown (consistent higher CPU, not spiky). The root cause of the
~2x CPU increase across all projects remains unidentified and requires deeper profiling.
