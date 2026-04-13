# Performance Changelog

## 2026-04-11: Performance test suite (`/performance`)

Added a `/performance` page that benchmarks every device processor using the real audio engine.

**How it works:**
- Each device runs in its own project rendered offline via `OfflineEngineRenderer` (Worker)
- Audio effects: Tape instrument + sine wave sample + the effect under test
- Instruments: the instrument with note regions (arpeggios) or audio regions
- A JIT warmup render runs first to avoid cold-start bias
- The main AudioContext is suspended during benchmarks to avoid CPU contention
- Results show render time, marginal cost (vs empty engine baseline), and per-quantum cost
- Each row includes an `<audio>` element to verify the rendered output

**Files:**
- `packages/app/studio/src/perf/DeviceBenchmark.ts` — project creation + rendering
- `packages/app/studio/src/perf/measure.ts` — result types
- `packages/app/studio/src/perf/benchmarks.ts` — public exports
- `packages/app/studio/src/ui/pages/PerformancePage.tsx` — UI
- `packages/app/studio/src/ui/pages/PerformancePage.sass` — styling

## 2026-04-11: Resampler — bitmask circular buffer indexing

`packages/lib/dsp/src/resampler.ts`

The `Resampler2xMono` used `% buffer.length` (modulo) for circular buffer indexing in the
upsample and downsample inner loops. Modulo is ~10x slower than bitmasking on modern CPUs.

**Fix:** Padded buffer sizes from 12→16 and 31→32 (power-of-2). Replaced all `%` with `& mask`.
Hoisted `#upIndex`/`#downIndex` to local variables to avoid repeated private field access.

Snapshot tests added to verify sample-exact output is unchanged after optimisation.

## 2026-04-11: Dattorro Reverb — flatten delay structure, cache references

`packages/studio/core-processors/src/devices/audio-effects/DattorroReverbDsp.ts`

The per-sample loop accessed delays through `this.#delays[n][0][this.#delays[n][2]]` — three
levels of dereference, 40+ times per sample.

**Fix:**
- Flattened `Array<[Float32Array, int, int, int]>` into parallel arrays
  (`#delayBuffers`, `#delayWrites`, `#delayReads`, `#delayMasks`)
- Cached all 12 delay buffer references and masks as local variables
- Hoisted `#lp1`, `#lp2`, `#lp3`, `#excPhase`, `#preDelayWrite` to locals
- Inlined the two cubic interpolation reads (`#readDelayCAt`)
- Made pre-delay buffer power-of-2, replaced `% preDelayLength` with `& mask`

## 2026-04-11: Fold — optimise wavefold + resampler inner loop

`packages/lib/dsp/src/functions.ts`, `packages/studio/core-processors/src/devices/audio-effects/FoldDeviceProcessor.ts`

**wavefold:** Replaced `Math.round` with `Math.floor(x + 0.5)`. `Math.floor` maps to a single
CPU instruction; `Math.round` does not.

**FoldDeviceProcessor:** Split the oversampled inner loop into two paths:
- Steady state (99.9%): fixed `gain`/`amount`, no `ramp.moveAndGet()` per sample
- Interpolating: per-sample ramp evaluation (only during parameter changes)

Inlined the `wavefold` function body to eliminate function call overhead at 256+ calls per block.

## 2026-04-11: AnimationFrame throttle

`packages/lib/dom/src/frames.ts`

`AnimationFrame` was running at the display's native refresh rate (120fps on ProMotion Macs),
doubling UI rendering work for all 31+ subscribers (meters, canvas painters, live stream readers).
Throttled to ~60fps by skipping frames within 16ms of the previous.

## 2026-04-11: UUID.toString hex table hoisted

`packages/lib/std/src/uuid.ts`

`UUID.toString()` recreated a 256-element hex lookup table on every call — 256 string allocations
plus a 256-element array. Hoisted the table to module scope (created once).

## 2026-04-11: TapeDeviceProcessor — eliminate string allocations in hot path

`packages/studio/core-processors/src/devices/instruments/TapeDeviceProcessor.ts`

Replaced `Set<string>` + `UUID.toString()` per block per lane with a reusable
`Array<UUID.Bytes>` + `UUID.equals()`. Zero string allocation in the hot path.

## 2026-04-11: BlockRenderer — eliminate iterator/array allocation

`packages/studio/core-processors/src/BlockRenderer.ts`

Replaced `Array.from(Iterables.take(markerTrack.events.iterateFrom(p0), 2))` with direct
`floorLastIndex` + `optAt` lookups. Zero allocations per render quantum.

## 2026-04-11: Scriptable device processors — reduce per-block waste

- **Werkstatt**: Reuse `#io` instance field instead of allocating `UserIO` per block.
- **Spielwerk**: Reuse `#events` array and `#userBlock` instance field.
  Index-based iterator instead of closure over `events[Symbol.iterator]()`.
- **All three** (Werkstatt, Apparat, Spielwerk): `parseUpdate()` regex replaced with cached
  `#pendingUpdate` set by code subscription. No regex in the audio-thread hot path.

## 2026-04-11: Maximizer — cache headroom gain

`packages/studio/core-processors/src/devices/audio-effects/MaximizerDeviceProcessor.ts`

Cached `dbToGain(MAGIC_HEADROOM - threshold)` as `#headroomGain`, updated in `parameterChanged()`.
Eliminates one `Math.exp` per sample on the master bus during steady state (~99.9% of the time).
