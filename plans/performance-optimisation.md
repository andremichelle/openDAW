# Performance Optimisation Plan

## Context

CPU load has roughly doubled across projects over the last weeks. The HRClock performance meter now makes
this visible.

Additionally, `AnimationFrame` was running at 120fps on ProMotion displays — now throttled to 60fps.

---

## 0. ROOT CAUSE: UUID.toString in TapeDeviceProcessor hot path [DONE]

**Primary cause of the ~2x regression.**

### 0a. UUID.toString recreates 256-element hex lookup table on every call

**File:** `packages/lib/std/src/uuid.ts:39-40`

`UUID.toString()` had the hex lookup table (`Arrays.create(... , 256)`) declared INSIDE the function
body. Every call allocated a 256-element string array + 256 intermediate strings. This function is
called in many places but became critical when TapeDeviceProcessor started using it in the per-block
hot path.

**Fix:** Hoisted the `hex` table to module scope — computed once, reused forever.

### 0b. TapeDeviceProcessor: Set\<string\> + UUID.toString per block per lane

**File:** `packages/studio/core-processors/src/devices/instruments/TapeDeviceProcessor.ts`

The voice management refactoring (switching from `instanceof`-based to UUID-based voice tracking)
introduced per-block hot-path calls:

```ts
const visitedUuids: Set<string> = new Set()        // allocation per block per lane
visitedUuids.add(UUID.toString(region.uuid))        // per region
visitedUuids.has(UUID.toString(voice.sourceUuid))   // per voice
```

For a project with 8 tracks × 2 regions × 375 quanta/sec, that was ~6,000 UUID.toString calls/sec,
each creating 258 objects (256-string hex table + array + result string) = ~1.5M allocations/sec.

**Fix:** Replaced `Set<string>` with a reusable `Array<UUID.Bytes>` instance field. Lookups use
`UUID.equals()` (16-byte comparison, zero allocation). The array is cleared via `length = 0` each
block.

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
- **Apparat**: `parseUpdate()` regex replaced with cached `#pendingUpdate` set by code subscription.
- **Spielwerk**: Reuse `#events` array (clear via `length = 0`) and `#userBlock` instance field.
  Iterator uses index-based traversal instead of closure over `events[Symbol.iterator]()`.
- **All three**: `parseUpdate()` regex replaced with cached `#pendingUpdate` set by code subscription.
  No regex in the hot path.

**Not applied (deferred):**
- `validateOutput` opt-in countdown — kept for safety; can revisit if profiling shows it matters.
- Apparat `#pollSamples` debounce — reverted, async sample loading requires per-block polling.

---

## 3. Maximizer: Reduce per-sample transcendental calls [DONE]

**File:** `packages/studio/core-processors/src/devices/audio-effects/MaximizerDeviceProcessor.ts`

Cached `dbToGain(MAGIC_HEADROOM - threshold)` as `#headroomGain`. Updated in `parameterChanged()`.
Per-sample loop uses the cached value when the threshold ramp is not interpolating (steady state, 99.9%
of the time). During the brief 10ms ramp, the per-sample computation is preserved for correctness.
