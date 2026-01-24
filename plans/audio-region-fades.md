# Audio Region Fade-In/Fade-Out Implementation Plan

## Overview

Implement fade-in and fade-out functionality for audio regions. Fades are defined as normalized ratios (0.0-1.0) representing the percentage of the region duration, with configurable slopes using the existing Curve system for smooth exponential transitions.

### Key Behaviors
- **Fade-in**: 0.0 = no fade, 0.25 = 25% of region duration fades in from silence
- **Fade-out**: 0.75 = fade-out starts at 75% and reaches silence at 100%
- **Overlap handling**: When fades overlap, take `Math.min(fadeInGain, fadeOutGain)`
- **Slope control**: Uses `Curve.normalizedAt(x, slope)` where 0.5 = linear, <0.5 = logarithmic, >0.5 = exponential

---

## 1. Schema Changes

### File: `packages/studio/forge-boxes/src/schema/std/timeline/AudioRegionBox.ts`

Add a `fading` object field containing the four fade properties:

```typescript
export const AudioRegionBox: BoxSchema<Pointers> = {
    type: "box",
    class: {
        name: "AudioRegionBox",
        fields: {
            // ... existing fields 1-17 ...
            18: {
                type: "object", name: "fading", class: {
                    name: "Fading",
                    fields: {
                        1: {type: "float32", name: "in", value: 0.0, constraints: "unipolar", unit: "ratio"},
                        2: {type: "float32", name: "out", value: 1.0, constraints: "unipolar", unit: "ratio"},
                        3: {type: "float32", name: "in-slope", value: 0.5, constraints: "unipolar", unit: "ratio"},
                        4: {type: "float32", name: "out-slope", value: 0.5, constraints: "unipolar", unit: "ratio"}
                    }
                }
            }
        }
    },
    // ...
}
```

**Field Definitions:**
- `fading.in` (1): Ratio 0.0-1.0, percentage of duration for fade-in (default: 0.0 = no fade)
- `fading.out` (2): Ratio 0.0-1.0, position where fade-out starts (default: 1.0 = no fade)
- `fading.in-slope` (3): Curve slope 0.0-1.0 (default: 0.5 = linear)
- `fading.out-slope` (4): Curve slope 0.0-1.0 (default: 0.5 = linear)

The `unipolar` constraint already exists in `Defaults.ts` and constrains values to 0.0-1.0.

---

## 2. Box Type Generation

After schema changes, regenerate box types:

```bash
pnpm --filter @opendaw/studio-boxes forge
```

This will update `packages/studio/boxes/src/AudioRegionBox.ts` with the new fields.

---

## 3. Adapter Changes

### 3.1 Create FadingAdapter

#### File: `packages/studio/adapters/src/timeline/region/FadingAdapter.ts` (new file)

The `Fading` class will be auto-generated with field accessors. Create a `FadingAdapter` to wrap it with convenience methods:

```typescript
import {Fading} from "@opendaw/studio-boxes"
import {FadingEnvelope} from "@opendaw/lib-dsp"
import {MutableObservableValue, unitValue} from "@opendaw/lib-std"

/**
 * Adapter for the generated Fading object.
 * Implements FadingEnvelope.Config so it can be passed directly to DSP functions.
 */
export class FadingAdapter implements FadingEnvelope.Config {
    readonly #fading: Fading

    constructor(fading: Fading) {
        this.#fading = fading
    }

    // Direct field accessors (postfix "Field") for subscriptions/mutations
    get inField(): MutableObservableValue<number> {return this.#fading.in}
    get outField(): MutableObservableValue<number> {return this.#fading.out}
    get inSlopeField(): MutableObservableValue<number> {return this.#fading.inSlope}
    get outSlopeField(): MutableObservableValue<number> {return this.#fading.outSlope}

    // FadingEnvelope.Config implementation - value getters
    get in(): unitValue {return this.#fading.in.getValue()}
    get out(): unitValue {return this.#fading.out.getValue()}
    get inSlope(): unitValue {return this.#fading.inSlope.getValue()}
    get outSlope(): unitValue {return this.#fading.outSlope.getValue()}

    // Check if any fading is active
    get hasFading(): boolean {
        return this.in > 0.0 || this.out < 1.0
    }

    // Delegate to FadingEnvelope for gain calculation
    gainAt(normalizedPosition: unitValue): number {
        return FadingEnvelope.gainAt(normalizedPosition, this)
    }

    // Fill a gain buffer with fading envelope (delegates to FadingEnvelope)
    fillGainBuffer(gainBuffer: Float32Array, startNormalized: number, endNormalized: number, sampleCount: number): void {
        FadingEnvelope.fillGainBuffer(gainBuffer, startNormalized, endNormalized, sampleCount, this)
    }

    // Copy values to another Fading object
    copyTo(target: Fading): void {
        target.in.setValue(this.in)
        target.out.setValue(this.out)
        target.inSlope.setValue(this.inSlope)
        target.outSlope.setValue(this.outSlope)
    }

    // Reset to defaults (no fading)
    reset(): void {
        this.#fading.in.setValue(0.0)
        this.#fading.out.setValue(1.0)
        this.#fading.inSlope.setValue(0.5)
        this.#fading.outSlope.setValue(0.5)
    }
}
```

### 3.2 Update AudioRegionBoxAdapter

#### File: `packages/studio/adapters/src/timeline/region/AudioRegionBoxAdapter.ts`

Minimal changes - just add a getter that returns a `FadingAdapter`:

```typescript
import {FadingAdapter} from "./FadingAdapter"

export class AudioRegionBoxAdapter implements ... {
    readonly #fadingAdapter: FadingAdapter

    constructor(context: BoxAdaptersContext, box: AudioRegionBox) {
        // ... existing code ...
        this.#fadingAdapter = new FadingAdapter(box.fading)
    }

    // Return the FadingAdapter
    get fading(): FadingAdapter {return this.#fadingAdapter}

    // Update copyTo method
    copyTo(params?: CopyToParams): AudioRegionBoxAdapter {
        // ... existing code ...
        const adapter = this.#context.boxAdapters.adapterFor(
            AudioRegionBox.create(this.#context.boxGraph, UUID.generate(), box => {
                // ... existing field copies ...
                this.#fadingAdapter.copyTo(box.fading)
            }), AudioRegionBoxAdapter)
        // ...
    }
}
```
```

---

## 4. Audio Processing Changes

### 4.1 Create Fading Envelope Helper

#### File: `packages/lib/dsp/src/fading.ts` (new file)

```typescript
import {Curve, int, unitValue} from "@opendaw/lib-std"

export namespace FadingEnvelope {
    /**
     * Interface for fading configuration.
     * FadingAdapter implements this interface directly.
     */
    export interface Config {
        readonly in: unitValue       // 0.0-1.0: normalized end of fade-in
        readonly out: unitValue      // 0.0-1.0: normalized start of fade-out
        readonly inSlope: unitValue  // 0.5 = linear
        readonly outSlope: unitValue
    }

    /**
     * Calculate fade gain at a normalized position within region (0.0-1.0)
     * Returns gain multiplier 0.0-1.0
     */
    export const gainAt = (normalizedPosition: unitValue, config: Config): number => {
        const {in: fadeIn, out: fadeOut, inSlope, outSlope} = config

        let fadeInGain = 1.0
        let fadeOutGain = 1.0

        if (fadeIn > 0.0 && normalizedPosition < fadeIn) {
            fadeInGain = Curve.normalizedAt(normalizedPosition / fadeIn, inSlope)
        }

        if (fadeOut < 1.0 && normalizedPosition > fadeOut) {
            const progress = (normalizedPosition - fadeOut) / (1.0 - fadeOut)
            fadeOutGain = 1.0 - Curve.normalizedAt(progress, outSlope)
        }

        return Math.min(fadeInGain, fadeOutGain)
    }

    /**
     * Fill a gain buffer with the fading envelope.
     * Uses Curve.walk for efficient envelope generation without per-sample pow() calls.
     * The gain buffer can then be applied to audio by voices.
     *
     * @param gainBuffer - Float32Array to fill with gain values (length = RenderQuantum)
     * @param startNormalized - Normalized position at block start (0.0-1.0)
     * @param endNormalized - Normalized position at block end (0.0-1.0)
     * @param sampleCount - Number of samples to fill
     * @param config - Fading configuration (FadingAdapter implements this)
     */
    export const fillGainBuffer = (
        gainBuffer: Float32Array,
        startNormalized: number,
        endNormalized: number,
        sampleCount: int,
        config: Config
    ): void => {
        const {in: fadeIn, out: fadeOut, inSlope, outSlope} = config

        // Initialize to 1.0 (no attenuation)
        gainBuffer.fill(1.0, 0, sampleCount)

        // No fading active - buffer already filled with 1.0
        if (fadeIn <= 0.0 && fadeOut >= 1.0) {return}

        // Block entirely in unity region - buffer already filled with 1.0
        if (startNormalized >= fadeIn && endNormalized <= fadeOut) {return}

        const normalizedPerSample = (endNormalized - startNormalized) / sampleCount

        // Fill fade-in region using Curve.walk
        if (fadeIn > 0.0 && startNormalized < fadeIn) {
            const fadeInEndNorm = Math.min(endNormalized, fadeIn)
            const fadeInEndSample = Math.min(
                sampleCount,
                Math.ceil((fadeInEndNorm - startNormalized) / normalizedPerSample)
            )

            if (fadeInEndSample > 0) {
                const startProgress = startNormalized / fadeIn
                const endProgress = fadeInEndNorm / fadeIn
                const iterator = Curve.walk(inSlope, fadeInEndSample, startProgress, endProgress)
                for (let i = 0; i < fadeInEndSample; i++) {
                    gainBuffer[i] = iterator.next().value
                }
            }
        }

        // Fill fade-out region using Curve.walk
        if (fadeOut < 1.0 && endNormalized > fadeOut) {
            const fadeOutStartNorm = Math.max(startNormalized, fadeOut)
            const fadeOutStartSample = Math.max(
                0,
                Math.floor((fadeOutStartNorm - startNormalized) / normalizedPerSample)
            )
            const steps = sampleCount - fadeOutStartSample

            if (steps > 0) {
                const startProgress = (fadeOutStartNorm - fadeOut) / (1.0 - fadeOut)
                const endProgress = (endNormalized - fadeOut) / (1.0 - fadeOut)
                // Walk from 1.0 down to 0.0 (inverted)
                const iterator = Curve.walk(outSlope, steps, 1.0 - startProgress, 1.0 - endProgress)
                for (let i = fadeOutStartSample; i < sampleCount; i++) {
                    gainBuffer[i] = Math.min(gainBuffer[i], iterator.next().value)
                }
            }
        }

        // Handle overlap region (already handled by Math.min above)
    }
}
```

### 4.2 Update TapeDeviceProcessor

#### File: `packages/studio/core-processors/src/devices/instruments/TapeDeviceProcessor.ts`

Add a shared gain buffer and compute fading envelope once per region:

```typescript
import {RenderQuantum} from "@opendaw/lib-dsp"
import {FadingEnvelope} from "@opendaw/lib-dsp"

export class TapeDeviceProcessor extends AbstractProcessor implements DeviceProcessor, AudioGenerator {
    // Shared gain buffer - reused each block to avoid allocations
    readonly #fadingGainBuffer: Float32Array = new Float32Array(RenderQuantum)

    // ...

    #processBlock(lane: Lane, block: Block): void {
        // ...
        for (const region of adapter.regions.collection.iterateRange(p0, p1)) {
            if (region.mute || !isInstanceOf(region, AudioRegionBoxAdapter)) {continue}

            const {fading} = region

            // Compute fading envelope into shared gain buffer (once per region)
            if (fading.hasFading) {
                const startNormalized = /* compute from cycle */
                const endNormalized = /* compute from cycle */
                FadingEnvelope.fillGainBuffer(
                    this.#fadingGainBuffer,
                    startNormalized,
                    endNormalized,
                    fading
                )
            }

            // Pass gain buffer to voice processing
            // Voices apply: buffer[i] *= gainBuffer[i] for both channels
        }
    }
}
```

### 4.3 Update DirectVoice

#### File: `packages/studio/core-processors/src/devices/instruments/Tape/DirectVoice.ts`

Update `process` method to accept an optional gain buffer:

```typescript
export class DirectVoice {
    // ... existing fields ...

    /**
     * Renders audio samples to the output buffer.
     * @param bufferStart - Start position in the output buffer
     * @param bufferCount - Number of samples to process
     * @param fadingGainBuffer - Pre-computed fading gain buffer (filled with 1.0 if no fading)
     */
    process(bufferStart: int, bufferCount: int, fadingGainBuffer: Float32Array): void {
        const [outL, outR] = this.#output.channels()
        const {frames, numberOfFrames} = this.#data
        const framesL = frames[0]
        const framesR = frames.length === 1 ? frames[0] : frames[1]
        // ... existing state variables ...

        for (let i = 0; i < bufferCount; i++) {
            // ... existing amplitude calculation (voice fade-in/fade-out) ...

            if (readPosition >= 0 && readPosition < numberOfFrames) {
                const finalAmplitude = amplitude * fadingGainBuffer[i]
                outL[j] += framesL[readPosition] * finalAmplitude
                outR[j] += framesR[readPosition] * finalAmplitude
            }
            // ... rest of processing ...
        }
    }
}
```

Apply similar changes to `PitchVoice.ts` and the time-stretch sequencer.

---

## 5. Visual Rendering

### 5.1 Render Fading Overlay on Regions

#### File: `packages/app/studio/src/ui/timeline/renderer/audio.ts`

Add fading rendering after waveform:

```typescript
import {Curve} from "@opendaw/lib-std"

export const renderFading = (
    context: CanvasRenderingContext2D,
    range: TimelineRange,
    fadeIn: number,
    fadeOut: number,
    fadeInSlope: number,
    fadeOutSlope: number,
    {top, bottom}: RegionBound,
    startPPQN: number,
    endPPQN: number,
    color: string
) => {
    const height = bottom - top
    const dpr = devicePixelRatio

    // Render fading in curve
    if (fadeIn > 0) {
        const fadeInEndPPQN = startPPQN + (endPPQN - startPPQN) * fadeIn
        const x0 = range.unitToX(startPPQN) * dpr
        const x1 = range.unitToX(fadeInEndPPQN) * dpr

        context.beginPath()
        context.moveTo(x0, bottom)

        const steps = Math.max(10, Math.abs(x1 - x0) / 2)
        for (let i = 0; i <= steps; i++) {
            const t = i / steps
            const x = x0 + (x1 - x0) * t
            const gain = Curve.normalizedAt(t, fadeInSlope)
            const y = bottom - height * gain
            context.lineTo(x, y)
        }

        context.lineTo(x0, bottom)
        context.closePath()
        context.fillStyle = color
        context.fill()
    }

    // Render fading out curve
    if (fadeOut < 1) {
        const fadeOutStartPPQN = startPPQN + (endPPQN - startPPQN) * fadeOut
        const x0 = range.unitToX(fadeOutStartPPQN) * dpr
        const x1 = range.unitToX(endPPQN) * dpr

        context.beginPath()
        context.moveTo(x0, top)

        const steps = Math.max(10, Math.abs(x1 - x0) / 2)
        for (let i = 0; i <= steps; i++) {
            const t = i / steps
            const x = x0 + (x1 - x0) * t
            const gain = 1.0 - Curve.normalizedAt(t, fadeOutSlope)
            const y = top + height * (1 - gain)
            context.lineTo(x, y)
        }

        context.lineTo(x1, bottom)
        context.lineTo(x0, bottom)
        context.closePath()
        context.fillStyle = color
        context.fill()
    }
}
```

### 5.2 Update Region Renderer

#### File: `packages/app/studio/src/ui/timeline/tracks/audio-unit/regions/RegionRenderer.ts`

Call `renderFading` after rendering the waveform, using a semi-transparent overlay color.

---

## 6. Editor Implementation

### 6.1 Fading Handle Capturing

#### File: `packages/app/studio/src/ui/timeline/editors/audio/AudioCapturing.ts`

Add capture targets for fading circle handles:

```typescript
export type AudioCaptureTarget =
    | {type: "loop-duration", reader: AudioEventOwnerReader}
    | {type: "fading-in", reader: AudioEventOwnerReader}
    | {type: "fading-out", reader: AudioEventOwnerReader}
    | {type: "fading-in-slope", reader: AudioEventOwnerReader}
    | {type: "fading-out-slope", reader: AudioEventOwnerReader}

// Use Geom.isInsideCircle for hit detection (see geom.ts addition below)
// Fading in handle: circle at (fadeIn position, top of curve)
// Fading out handle: circle at (fadeOut position, top of curve)
// Slope handles: circles on the curve midpoint for bending
```

#### File: `packages/lib/std/src/geom.ts`

Add circle hit detection to the Geom namespace:

```typescript
export namespace Geom {
    // ... existing code ...

    export const isInsideCircle = (x: number, y: number, cx: number, cy: number, radius: number): boolean => {
        const dx = x - cx
        const dy = y - cy
        return dx * dx + dy * dy <= radius * radius
    }
}
```

### 6.2 Fading Editor Integration

#### File: `packages/app/studio/src/ui/timeline/editors/audio/AudioEditorCanvas.tsx`

Add draggable fading circle handles:

```typescript
// In the canvas render callback:
const {fading} = reader.audioContent

// Render fading curves and circle handles
if (fading.hasFading) {
    renderFading(context, range,
        fading.in, fading.out,
        fading.inSlope, fading.outSlope,
        {top: 0, bottom: actualHeight},
        reader.offset,
        reader.offset + reader.loopDuration,
        `hsla(${reader.hue}, 60%, 30%, 0.5)`)

    // Render circle handles at fading positions
    const handleRadius = 5 * devicePixelRatio
    if (fading.in > 0) {
        const x = range.unitToX(reader.offset + reader.loopDuration * fading.in) * devicePixelRatio
        context.beginPath()
        context.arc(x, top, handleRadius, 0, Math.PI * 2)
        context.fill()
    }
    if (fading.out < 1) {
        const x = range.unitToX(reader.offset + reader.loopDuration * fading.out) * devicePixelRatio
        context.beginPath()
        context.arc(x, top, handleRadius, 0, Math.PI * 2)
        context.fill()
    }
}

// Add dragging handlers for fading circle handles
Dragging.attach(canvas, event => {
    const target = capturing.captureEvent(event)
    if (target?.type === "fading-in") {
        // Drag horizontally to adjust fading.in ratio
    }
    if (target?.type === "fading-out") {
        // Drag horizontally to adjust fading.out ratio
    }
})
```

### 6.3 Region Context Menu

Add fading options to the region context menu for quick access:

```typescript
MenuItem.default({label: "Reset Fades"})
    .setTriggerProcedure(() => editing.modify(() => region.fading.reset()))
```

---

## 7. Implementation Order

### Phase 1: Schema & Types
1. Add `fading` object to `AudioRegionBox.ts` schema
2. Run `pnpm --filter @opendaw/studio-boxes forge`
3. Create `FadingAdapter.ts` with convenience methods and `gainAt()`
4. Update `AudioRegionBoxAdapter.ts` with `fading` getter

### Phase 2: Audio Processing
4. Create `FadeEnvelope` helper in `packages/lib/dsp/src/fade.ts`
5. Export from `packages/lib/dsp/src/index.ts`
6. Update `DirectVoice.ts` to apply fade envelope
7. Update `PitchVoice.ts` to apply fade envelope
8. Update `TapeDeviceProcessor.ts` to pass fade config

### Phase 3: Visual Rendering
9. Add `renderFading` function in `audio.ts`
10. Integrate into region rendering pipeline
11. Update waveform rendering to visually reflect fades

### Phase 4: Editor
12. Add fade capture targets
13. Implement fade handle dragging
14. Add context menu options

### Phase 5: Testing & Polish
15. Test with various fade combinations
16. Test overlap behavior (min of both fades)
17. Verify playback accuracy
18. Verify visual accuracy

---

## 8. Files to Modify

| File | Change |
|------|--------|
| `packages/studio/forge-boxes/src/schema/std/timeline/AudioRegionBox.ts` | Add `fading` object with 4 fields |
| `packages/studio/adapters/src/timeline/region/FadingAdapter.ts` | Create new file implementing FadingEnvelope.Config |
| `packages/studio/adapters/src/timeline/region/AudioRegionBoxAdapter.ts` | Add `fading` getter returning FadingAdapter |
| `packages/lib/dsp/src/fading.ts` | Create new file with FadingEnvelope namespace |
| `packages/lib/dsp/src/index.ts` | Export FadingEnvelope |
| `packages/lib/std/src/geom.ts` | Add `isInsideCircle` to Geom namespace |
| `packages/studio/core-processors/src/devices/instruments/Tape/DirectVoice.ts` | Add fadingGainBuffer parameter |
| `packages/studio/core-processors/src/devices/instruments/Tape/PitchVoice.ts` | Add fadingGainBuffer parameter |
| `packages/studio/core-processors/src/devices/instruments/TapeDeviceProcessor.ts` | Add shared gain buffer, fill and pass to voices |
| `packages/app/studio/src/ui/timeline/renderer/audio.ts` | Add renderFading |
| `packages/app/studio/src/ui/timeline/editors/audio/AudioEditorCanvas.tsx` | Add fading circle handles and editing |
| `packages/app/studio/src/ui/timeline/editors/audio/AudioCapturing.ts` | Add fading circle capture targets |

---

## 9. API Summary

### Fading Gain Calculation

```typescript
// Single sample (for UI/debugging):
const gain = region.fading.gainAt(normalizedPosition)

// Block processing (efficient, uses Curve.walk):
// 1. TapeDeviceProcessor fills shared gain buffer once per region
region.fading.fillGainBuffer(gainBuffer, startNormalized, endNormalized, sampleCount)

// 2. Pass to voices - they multiply both channels by gainBuffer
voice.process(bufferStart, bufferCount, gainBuffer)
```

The underlying calculation:
- Fading in: ramps 0.0 → 1.0 over `in` percentage using Curve.walk
- Fading out: ramps 1.0 → 0.0 from `out` to end using Curve.walk
- Overlap: takes `Math.min(fadeInGain, fadeOutGain)`

### Default Values (via FadingAdapter)
- `fading.in`: 0.0 (no fading in)
- `fading.out`: 1.0 (no fading out)
- `fading.inSlope`: 0.5 (linear)
- `fading.outSlope`: 0.5 (linear)

### Field Access (for subscriptions/mutations)
- `fading.inField` - MutableObservableValue for fading in
- `fading.outField` - MutableObservableValue for fading out
- `fading.inSlopeField` - MutableObservableValue for fading in slope
- `fading.outSlopeField` - MutableObservableValue for fading out slope

### Block Processing
FadingAdapter can be passed directly to FadingEnvelope functions (implements Config):
```typescript
// Fill gain buffer efficiently using Curve.walk (computed once per region)
region.fading.fillGainBuffer(gainBuffer, startNormalized, endNormalized, sampleCount)

// Or use FadingEnvelope directly
FadingEnvelope.fillGainBuffer(gainBuffer, startNormalized, endNormalized, sampleCount, region.fading)

// Pass gain buffer to voices for both channels
voice.process(bufferStart, bufferCount, gainBuffer)
```

---

## 10. Notes

### Looping Regions
Fades apply to each loop cycle independently. When a region loops, the fade-in and fade-out are computed relative to each individual loop iteration, not the total audible duration.

### Time Base
Fade ratios are independent of time base (Musical vs Seconds). They always represent a percentage of the current region/loop duration.

### Clips
Consider whether `AudioClipBoxAdapter` should also support fades. If so, the same pattern can be applied to clips for consistency.
