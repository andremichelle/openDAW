# Audio Region Fade-In/Fade-Out Implementation Plan

## Status: IMPLEMENTED ✓

All phases complete. Fading uses PPQN durations (not ratios).

---

## Overview

Fade-in and fade-out for audio regions using PPQN durations with configurable slopes.

### Key Behaviors
- **Fade-in (`in`)**: PPQN duration from region start (0 = no fade)
- **Fade-out (`out`)**: PPQN duration counted backwards from region end (0 = no fade)
- **Overlap handling**: `Math.min(fadeInGain, fadeOutGain)`
- **Slope control**: `Curve.walk(slope, ...)` where 0.5 = linear
- **Fading applies to region position/duration only** - loops are ignored

---

## Implementation Summary

### 1. Schema (`AudioRegionBox.ts`)

```typescript
18: {
    type: "object", name: "fading", class: {
        name: "Fading",
        fields: {
            1: {type: "float32", name: "in", value: 0.0, constraints: "positive", unit: "ppqn"},
            2: {type: "float32", name: "out", value: 0.0, constraints: "positive", unit: "ppqn"},
            3: {type: "float32", name: "in-slope", value: 0.5, constraints: "unipolar", unit: "ratio"},
            4: {type: "float32", name: "out-slope", value: 0.5, constraints: "unipolar", unit: "ratio"}
        }
    }
}
```

### 2. FadingEnvelope (`packages/lib/dsp/src/fading.ts`)

```typescript
export namespace FadingEnvelope {
    export interface Config {
        readonly in: ppqn      // duration from start
        readonly out: ppqn     // duration from end (backwards)
        readonly inSlope: unitValue
        readonly outSlope: unitValue
    }

    export const hasFading = (config: Config): boolean => config.in > 0.0 || config.out > 0.0

    export const fillGainBuffer = (
        gainBuffer: Float32Array,
        startPpqn: ppqn,
        endPpqn: ppqn,
        durationPpqn: ppqn,
        sampleCount: int,
        config: Config
    ): void => { /* ... */ }
}
```

### 3. FadingAdapter (`packages/studio/adapters/src/timeline/region/FadingAdapter.ts`)

```typescript
export class FadingAdapter implements FadingEnvelope.Config {
    get in(): ppqn { /* PPQN from start */ }
    get out(): ppqn { /* PPQN from end */ }
    get inSlope(): unitValue
    get outSlope(): unitValue
    get hasFading(): boolean { return FadingEnvelope.hasFading(this) }
    get inField(): MutableObservableValue<number>
    get outField(): MutableObservableValue<number>
    reset(): void { /* sets in=0, out=0 */ }
}
```

### 4. TapeDeviceProcessor

**`#processPassPitch`**:
```typescript
if (isInstanceOf(adapter, AudioRegionBoxAdapter) && adapter.fading.hasFading) {
    const regionPosition = adapter.position
    const regionDuration = adapter.duration
    const startPpqn = cycle.resultStart - regionPosition
    const endPpqn = cycle.resultEnd - regionPosition
    FadingEnvelope.fillGainBuffer(this.#fadingGainBuffer, startPpqn, endPpqn, regionDuration, bpn, adapter.fading)
}
```

**`#processPassTimestretch`** signature:
```typescript
#processPassTimestretch(lane, block, cycle, data, timeStretch, transients, waveformOffset,
    fadingConfig: FadingEnvelope.Config | null,
    regionPosition: number,
    regionDuration: number): void
```

### 5. Voice Updates

All voice types accept `fadingGainBuffer: Float32Array` in `process()`:
- `DirectVoice.ts`
- `PitchVoice.ts`
- `OnceVoice.ts`
- `RepeatVoice.ts`
- `PingpongVoice.ts`
- `TimeStretchSequencer.ts`

### 6. Visual Rendering (`audio.ts`)

```typescript
export const renderFading = (
    context: CanvasRenderingContext2D,
    range: TimelineRange,
    fading: FadingEnvelope.Config,
    {top, bottom}: RegionBound,
    startPPQN: number,
    endPPQN: number,
    color: string,
    handleColor: string,
): void => {
    // fadeIn: draws shadow from startPPQN to startPPQN + fadeIn
    // fadeOut: draws shadow from endPPQN - fadeOut to endPPQN
    // Circle handles at fade positions
}
```

### 7. Hit Detection (`RegionCapturing.ts`)

```typescript
// Handle Y position matches renderer (device pixel calculation)
const dpr = devicePixelRatio
const labelHeightDp = Math.ceil(9 * dpr * 1.5)
const handleYFromTrackTop = (labelHeightDp + 1.0 + 5 * dpr) / dpr
const handleY = track.position + handleYFromTrackTop

// X positions use PPQN
const fadeInX = range.unitToX(region.position + fading.in)
const fadeOutX = range.unitToX(region.position + region.duration - fading.out)
```

### 8. Drag Handling (`RegionsArea.tsx`)

```typescript
case "fading-in":
case "fading-out": {
    const audioRegion = target.region
    const isFadeIn = target.part === "fading-in"
    const originalValue = isFadeIn ? audioRegion.fading.in : audioRegion.fading.out
    const field = isFadeIn ? audioRegion.fading.inField : audioRegion.fading.outField
    return Option.wrap({
        update: (dragEvent: Dragging.Event) => {
            const pointerPpqn = range.xToUnit(dragEvent.clientX - clientRect.left)
            editing.modify(() => {
                if (isFadeIn) {
                    // fadeIn = distance from region start
                    const fadeInPpqn = clamp(pointerPpqn - regionPosition, 0, regionDuration - audioRegion.fading.out)
                    field.setValue(fadeInPpqn)
                } else {
                    // fadeOut = distance from region end (backwards)
                    const fadeOutPpqn = clamp(regionPosition + regionDuration - pointerPpqn, 0, regionDuration - audioRegion.fading.in)
                    field.setValue(fadeOutPpqn)
                }
            }, false)
        },
        approve: () => editing.mark(),
        cancel: () => editing.modify(() => field.setValue(originalValue))
    })
}
```

---

## Files Modified

| File | Change |
|------|--------|
| `packages/studio/forge-boxes/src/schema/std/timeline/AudioRegionBox.ts` | Added `fading` object with PPQN fields |
| `packages/lib/dsp/src/fading.ts` | Created FadingEnvelope namespace with PPQN-based API |
| `packages/lib/dsp/src/index.ts` | Export FadingEnvelope and ppqn type |
| `packages/studio/adapters/src/timeline/region/FadingAdapter.ts` | Created adapter implementing Config |
| `packages/studio/adapters/src/timeline/region/AudioRegionBoxAdapter.ts` | Added fading getter |
| `packages/lib/std/src/geom.ts` | Added `Geom.isInsideCircle` |
| `packages/studio/core-processors/src/devices/instruments/TapeDeviceProcessor.ts` | Added gain buffer, updated both process methods |
| `packages/studio/core-processors/src/devices/instruments/Tape/DirectVoice.ts` | Accept fadingGainBuffer |
| `packages/studio/core-processors/src/devices/instruments/Tape/PitchVoice.ts` | Accept fadingGainBuffer |
| `packages/studio/core-processors/src/devices/instruments/Tape/OnceVoice.ts` | Accept fadingGainBuffer |
| `packages/studio/core-processors/src/devices/instruments/Tape/RepeatVoice.ts` | Accept fadingGainBuffer |
| `packages/studio/core-processors/src/devices/instruments/Tape/PingpongVoice.ts` | Accept fadingGainBuffer |
| `packages/studio/core-processors/src/devices/instruments/Tape/TimeStretchSequencer.ts` | Accept fadingGainBuffer |
| `packages/app/studio/src/ui/timeline/renderer/audio.ts` | Added renderFading with Curve.walk |
| `packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionRenderer.ts` | Call renderFading for audio regions |
| `packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionCapturing.ts` | Added fading-in/fading-out capture targets |
| `packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionsArea.tsx` | Added drag handling with editing.modify |

---

## Key Design Decisions

1. **PPQN instead of ratios**: Fade durations are absolute PPQN values, not percentages. This is more intuitive for users and works consistently regardless of region duration.

2. **fadeOut counts from end**: `out` is the duration before the region end where fade-out starts, not a position. This makes it independent of region resizing.

3. **Fading ignores loops**: Fade envelope is calculated from `region.position` to `region.position + region.duration`, regardless of loop settings.

4. **Shared gain buffer**: TapeDeviceProcessor owns a single `#fadingGainBuffer` that's filled once per region and passed to all voices.

5. **editing.modify for undo/redo**: All drag operations use `editing.modify(() => ..., false)` during drag and `editing.mark()` on approve.

---

## Future Enhancements

- [ ] Slope adjustment via UI (currently only via code/API)
- [ ] Context menu "Reset Fading" option
- [ ] Keyboard modifiers for constrained dragging
