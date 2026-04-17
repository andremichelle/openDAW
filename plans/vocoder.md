# Vocoder Audio Effect Device

## Context

A classic analysis/synthesis vocoder. Two stereo inputs are needed:

- **Modulator** — usually voice or drums; the source whose spectral envelope is captured
- **Carrier** — usually a synth pad; the source that gets shaped by that envelope

The signal is split into N parallel band-pass filter pairs. For each band, the modulator filter feeds an envelope follower whose output drives the gain of the same-band carrier filter. The sum is the carrier "speaking" through the modulator.

The reference implementation lives in `~/Repositories/andre.michelle/neutrons/modules/vocoder.js`, wired up in `~/Repositories/andre.michelle/neutrons/vocoder.html`. It uses WebAudio `BiquadFilterNode` (bandpass) + a custom `EnvelopeFollower` AudioWorklet. We reproduce the same DSP using `BiquadCoeff` from `@opendaw/lib-dsp` and an inlined per-sample biquad runner.

The openDAW host is the **carrier** by convention (signal flowing through the device chain). The **modulator** is selectable via a dropdown (see "Modulator source" below), defaulting to internal pink noise so the device produces a recognisable vocoder sound the moment it's dropped in — no routing required.

**Unique feature worth highlighting**: carrier and modulator frequency ranges are completely independent parameters. This allows arbitrary mappings between modulator energy and carrier bands, including **spectrum reversal** (drive the carrier's high bands from the modulator's low bands, and vice versa). Most vocoders lock the two ranges together — this one doesn't.

## Modulator source

The modulator slot can be one of:

- **Noise — White** (flat spectrum, mono)
- **Noise — Pink** (−3 dB/oct, default; matches the spectral envelope of most musical material)
- **Noise — Brown** (−6 dB/oct, bassier)
- **Self** (carrier modulates itself — turns the device into a true multi-band gate)
- **External: <track>** (any project audio output, exactly like the existing `SidechainButton` menu)

This subsumes the existing sidechain mechanism. When the user picks an external source, the box's `sideChain` PointerField is set just like `CompressorDeviceBox`; when they pick a noise color or self, `sideChain` is cleared in the same `editing.modify(...)` block. Mode switches always clear the sidechain pointer (undo takes care of accidental losses).

## Signal Flow

```
host audio (carrier)  ─→  [N × carrier bandpass] ─┐
                                                  ×  ─→ Σ ─→ wet ─┐
modulator             ─→  envelope follower       │               + ─→ output
                                                  │               │
                          host audio (carrier) ───┴───→ dry ──────┘

modulator = noise(white|pink|brown) | carrier-filtered (self) | sidechain buffer (external)
```

- Band count is **user-selectable 8 / 12 / 16** (default 16). DSP allocates state for 16 once and uses the first N at runtime.
- Per band, both filters share the same Q, computed by exponential interpolation between `qMin` and `qMax`.
- Carrier band frequencies are exponentially spread between `carrierMinFreq` and `carrierMaxFreq`. Modulator frequencies likewise. They can intentionally diverge — that's the "transform" the display visualises.
- Envelope follower is a one-pole peak follower with separate attack/release coefficients. Attack is fixed at **5 ms**; release is user-controlled.
- In **Self** mode the per-band modulator biquads are skipped entirely — the envelope follower runs on the band's *own carrier-filtered* output, which acts as a multi-band gate.

## Schema

`packages/studio/forge-boxes/src/schema/devices/audio-effects/VocoderDeviceBox.ts`

```typescript
import {BoxSchema} from "@opendaw/lib-box-forge"
import {Pointers} from "@opendaw/studio-enums"
import {DeviceFactory} from "../../std/DeviceFactory"
import {ParameterPointerRules} from "../../std/Defaults"

export const VocoderDeviceBox: BoxSchema<Pointers> = DeviceFactory.createAudioEffect("VocoderDeviceBox", {
    10: {type: "float32", name: "carrier-min-freq", pointerRules: ParameterPointerRules,
         value: 80.0,    constraints: {min: 20.0, max: 20000.0, scaling: "exponential"}, unit: "Hz"},
    11: {type: "float32", name: "carrier-max-freq", pointerRules: ParameterPointerRules,
         value: 12000.0, constraints: {min: 20.0, max: 20000.0, scaling: "exponential"}, unit: "Hz"},
    12: {type: "float32", name: "modulator-min-freq", pointerRules: ParameterPointerRules,
         value: 80.0,    constraints: {min: 20.0, max: 20000.0, scaling: "exponential"}, unit: "Hz"},
    13: {type: "float32", name: "modulator-max-freq", pointerRules: ParameterPointerRules,
         value: 12000.0, constraints: {min: 20.0, max: 20000.0, scaling: "exponential"}, unit: "Hz"},
    14: {type: "float32", name: "q-min",       pointerRules: ParameterPointerRules,
         value: 2.0,     constraints: {min: 1.0,  max: 60.0,    scaling: "exponential"}, unit: ""},
    15: {type: "float32", name: "q-max",       pointerRules: ParameterPointerRules,
         value: 20.0,    constraints: {min: 1.0,  max: 60.0,    scaling: "exponential"}, unit: ""},
    16: {type: "float32", name: "env-release", pointerRules: ParameterPointerRules,
         value: 30.0,    constraints: {min: 1.0,  max: 1000.0,  scaling: "exponential"}, unit: "ms"},
    17: {type: "float32", name: "mix",         pointerRules: ParameterPointerRules,
         value: 1.0,     constraints: "unipolar", unit: "%"},
    18: {type: "int32",  name: "band-count", value: 16},
    19: {type: "string", name: "modulator-source", value: "noise-pink"},
    30: {type: "pointer", name: "side-chain", pointerType: Pointers.SideChain, mandatory: false}
})
```

Notes on non-automatable fields:

- **`modulator-source`** is a plain `StringField`. Valid values: `"noise-white" | "noise-pink" | "noise-brown" | "self" | "external"`. The processor defaults to `"noise-pink"` on any unknown value read from the box.
- **`band-count`** is a plain `Int32Field`. Allowed values are **8 / 12 / 16**. The processor ignores any other value (defensive guard), so a stray save-file edit can't crash the DSP.
- Both are changed via UI controls that wrap the writes in `editing.modify(...)` for proper undo behaviour.

After adding the schema, register it in `packages/studio/forge-boxes/src/schema/devices/index.ts` `DeviceDefinitions` array, then regenerate by running `npm run build` from `packages/studio/forge-boxes`.

## Adapter

`packages/studio/adapters/src/devices/audio-effects/VocoderDeviceBoxAdapter.ts`

Mirror `CompressorDeviceBoxAdapter`. Expose `sideChain` getter. Add a `ModulatorMode` type export that the editor and processor both import:

```typescript
export type ModulatorMode = "noise-white" | "noise-pink" | "noise-brown" | "self" | "external"
```

Wrap the 8 automatable parameters:

```typescript
#wrapParameters(box: VocoderDeviceBox) {
    const freq = ValueMapping.exponential(20.0, 20000.0)
    const freqStr = StringMapping.numeric({unit: "Hz", fractionDigits: 0})
    const qMap = ValueMapping.exponential(1.0, 60.0)
    const qStr = StringMapping.numeric({fractionDigits: 1})
    return {
        carrierMinFreq:   this.#parametric.createParameter(box.carrierMinFreq,   freq, freqStr, "Carrier Min"),
        carrierMaxFreq:   this.#parametric.createParameter(box.carrierMaxFreq,   freq, freqStr, "Carrier Max"),
        modulatorMinFreq: this.#parametric.createParameter(box.modulatorMinFreq, freq, freqStr, "Mod Min"),
        modulatorMaxFreq: this.#parametric.createParameter(box.modulatorMaxFreq, freq, freqStr, "Mod Max"),
        qMin:             this.#parametric.createParameter(box.qMin, qMap, qStr, "Q Min"),
        qMax:             this.#parametric.createParameter(box.qMax, qMap, qStr, "Q Max"),
        envRelease:       this.#parametric.createParameter(
            box.envRelease,
            ValueMapping.exponential(1.0, 1000.0),
            StringMapping.numeric({unit: "ms", fractionDigits: 0}),
            "Release"),
        mix:              this.#parametric.createParameter(
            box.mix, ValueMapping.unipolar(), StringMapping.percent(), "Mix")
    } as const
}
```

Export the adapter and `ModulatorMode` from `packages/studio/adapters/src/index.ts`.

## Processor

`packages/studio/core-processors/src/devices/audio-effects/VocoderDeviceProcessor.ts`

Mirror `CompressorDeviceProcessor` for sidechain wiring.

Responsibilities:

- Bind the 8 automatable parameters via `bindParameter`.
- Hold `#source: Option<AudioBuffer>` (carrier from host) and `#sideChain: Option<AudioBuffer>` (external modulator). Subscribe `adapter.sideChain` and resolve in `ProcessPhase.Before` using the same pattern as `CompressorDeviceProcessor` (subscribe callback marks dirty, phase callback resolves and calls `context.registerEdge(output.processor, this.incoming)`).
- Hold `#modulatorMode: ModulatorMode`, owned `NoiseGenerator`, and a stereo scratch buffer pair `#modScratchL/R` of length `RenderQuantum` for the synthesised modulator path.
- Subscribe `adapter.box.modulatorSource.catchupAndSubscribe(...)` to update `#modulatorMode`. Fall back to `"noise-pink"` for any unknown string.
- Subscribe `adapter.box.bandCount.catchupAndSubscribe(...)` and call `this.#dsp.bandCount = value` (the setter handles 8/12/16 validation).
- Construct the DSP: `this.#dsp = new VocoderDsp(sampleRate)` using the AudioWorklet global `sampleRate`.
- `processAudio(_block: Block, fromIndex: int, toIndex: int)` — uses the current processor signature from `creating-a-device.md` step 5:
  - If `#source.isEmpty()` return.
  - Decide the modulator source based on `#modulatorMode`:
    - `"noise-white" | "noise-pink" | "noise-brown"` → `noiseGen.fill(color, #modScratchL, fromIndex, toIndex)`. Pass `#modScratchL` as the mono modulator into `VocoderDsp.processMonoMod`.
    - `"self"` → call `VocoderDsp.processSelf`, which doesn't take a modulator buffer.
    - `"external"` → if sidechain is resolved, pass its L/R channels to `VocoderDsp.processStereoMod`. If not yet resolved (one-block race), write zeros into `#modScratchL/R` and pass those — effectively silence for that one block.
  - Update `#peaks`.
- `parameterChanged`: forward each parameter to the corresponding DSP setter (plain assignment, no dirty-flag needed — the DSP interpolates toward the new target on the next sub-block boundary).
- `reset()` clears `#dsp`, `#output`, `#peaks`, and `noiseGen`.

## DSP

`packages/studio/core-processors/src/devices/audio-effects/VocoderDsp.ts`

Pure DSP, no framework references. Optimised for raw throughput: inlined biquad recurrence in the hot loop, flat Float32Array state, three specialised inner loops dispatched on modulator mode.

### Class skeleton

```typescript
import {BiquadCoeff} from "@opendaw/lib-dsp"

export class VocoderDsp {
    static readonly MAX_BANDS = 16
    static readonly ATTACK_SECONDS = 0.005
    static readonly BAND_GAIN = 120.0          // reference-faithful, compensates bandpass attenuation
                                                // alternative: bandGain = k / sqrt(q) for self-balancing wide bands
    static readonly SUB_BLOCK = 64             // coeff-interpolation stride (2 sub-blocks per 128-sample render quantum)
    static readonly COEFF_LERP = 0.25          // per sub-block geometric lerp, ≈ 4.6 ms τ @ 48 kHz, 64-sample stride
                                                // alternatives: 0.5 → ~1.8 ms (snappier), 0.15 → ~8 ms (smoother)
    static readonly BAND_FADE_SECONDS = 0.003  // click-suppression fade, essentially inaudible
    static readonly COLD_THRESHOLD = 1e-4

    readonly #sampleRate: number

    // ── Band-count fade state (per-sample inside hot loop) ────────────────
    readonly #targetActive: Int8Array          // length MAX_BANDS, 0 or 1
    readonly #bandGainCurrent: Float32Array    // length MAX_BANDS, smoothed 0..1
    #fadeCoeff: number = 0.0                   // exp(-1 / (sr · BAND_FADE_SECONDS))
    #processedBands: number = 16               // upper iteration bound; shrinks as fade-outs complete
    #targetBandCount: 8 | 12 | 16 = 16

    // ── Target parameter values (written by setters) ──────────────────────
    #targetCarrierMinFreq:   number = 80.0
    #targetCarrierMaxFreq:   number = 12000.0
    #targetModulatorMinFreq: number = 80.0
    #targetModulatorMaxFreq: number = 12000.0
    #targetQMin:             number = 2.0
    #targetQMax:             number = 20.0

    // ── Current (lerped) per-band frequencies & Q ─────────────────────────
    readonly #curCarrierFreq:   Float32Array   // length MAX_BANDS, Hz
    readonly #curModulatorFreq: Float32Array
    readonly #curCarrierQ:      Float32Array
    readonly #curModulatorQ:    Float32Array   // shared with carrier for now, stored twice for cache locality

    // ── Envelope follower state (per band) ────────────────────────────────
    readonly #envelope: Float32Array           // length MAX_BANDS
    #attackCoeff: number = 0.0
    #releaseCoeff: number = 0.0

    // ── Coefficient storage: flat Float32Array(5 · MAX_BANDS) per side ────
    // Layout per band i: [b0, b1, b2, a1, a2] at offset i*5
    readonly #carrierCoeffs:   Float32Array    // length 5 * MAX_BANDS
    readonly #modulatorCoeffs: Float32Array    // length 5 * MAX_BANDS

    // Scratch BiquadCoeff instances used only by #interpolateCoeffs
    readonly #scratchCarrierCoeff   = new BiquadCoeff()
    readonly #scratchModulatorCoeff = new BiquadCoeff()

    // ── Biquad state (flat arrays, one per state variable) ────────────────
    // Carrier: stereo. 8 state arrays.
    readonly #carCxL1: Float32Array; readonly #carCxL2: Float32Array
    readonly #carCyL1: Float32Array; readonly #carCyL2: Float32Array
    readonly #carCxR1: Float32Array; readonly #carCxR2: Float32Array
    readonly #carCyR1: Float32Array; readonly #carCyR2: Float32Array
    // Modulator: may be mono (noise) or stereo (external). Always allocate stereo.
    // The mono-mod inner loop uses only the L slots.
    readonly #modMxL1: Float32Array; readonly #modMxL2: Float32Array
    readonly #modMyL1: Float32Array; readonly #modMyL2: Float32Array
    readonly #modMxR1: Float32Array; readonly #modMxR2: Float32Array
    readonly #modMyR1: Float32Array; readonly #modMyR2: Float32Array

    // ── Derived mix gains ─────────────────────────────────────────────────
    #wetGain: number = 1.0
    #dryGain: number = 0.0

    constructor(sampleRate: number) {
        this.#sampleRate = sampleRate
        const N = VocoderDsp.MAX_BANDS
        const alloc = () => new Float32Array(N)
        this.#targetActive    = new Int8Array(N)
        this.#bandGainCurrent = alloc()
        this.#curCarrierFreq   = alloc(); this.#curModulatorFreq = alloc()
        this.#curCarrierQ      = alloc(); this.#curModulatorQ    = alloc()
        this.#envelope         = alloc()
        this.#carrierCoeffs    = new Float32Array(5 * N)
        this.#modulatorCoeffs  = new Float32Array(5 * N)
        this.#carCxL1 = alloc(); this.#carCxL2 = alloc(); this.#carCyL1 = alloc(); this.#carCyL2 = alloc()
        this.#carCxR1 = alloc(); this.#carCxR2 = alloc(); this.#carCyR1 = alloc(); this.#carCyR2 = alloc()
        this.#modMxL1 = alloc(); this.#modMxL2 = alloc(); this.#modMyL1 = alloc(); this.#modMyL2 = alloc()
        this.#modMxR1 = alloc(); this.#modMxR2 = alloc(); this.#modMyR1 = alloc(); this.#modMyR2 = alloc()

        // Mark all bands active up to default count, and snap current freq/Q to target
        // so the first #interpolateCoeffs call doesn't divide by zero in the geometric lerp.
        for (let i = 0; i < 16; i++) this.#targetActive[i] = 1
        for (let i = 0; i < N; i++) this.#bandGainCurrent[i] = 1.0
        this.#computeBandTargets()
        for (let i = 0; i < N; i++) {
            this.#curCarrierFreq[i]   = this.#tmpTargetCarrierFreq[i]
            this.#curModulatorFreq[i] = this.#tmpTargetModulatorFreq[i]
            this.#curCarrierQ[i]      = this.#tmpTargetQ[i]
            this.#curModulatorQ[i]    = this.#tmpTargetQ[i]
        }
        this.#fadeCoeff   = Math.exp(-1 / (sampleRate * VocoderDsp.BAND_FADE_SECONDS))
        this.#attackCoeff = Math.exp(-1 / (sampleRate * VocoderDsp.ATTACK_SECONDS))
        this.setReleaseSeconds(0.030)
        this.#writeAllCoefficients()
    }

    // ── Parameter setters — plain assignment, DSP interpolates on next sub-block ──

    set carrierMinFreq(hz: number)   { this.#targetCarrierMinFreq = hz }
    set carrierMaxFreq(hz: number)   { this.#targetCarrierMaxFreq = hz }
    set modulatorMinFreq(hz: number) { this.#targetModulatorMinFreq = hz }
    set modulatorMaxFreq(hz: number) { this.#targetModulatorMaxFreq = hz }
    set qMin(q: number)              { this.#targetQMin = q }
    set qMax(q: number)              { this.#targetQMax = q }

    set mix(value: number) {
        // Equal-power crossfade: 0 → full dry, 1 → full wet.
        const angle = value * Math.PI * 0.5
        this.#dryGain = Math.cos(angle)
        this.#wetGain = Math.sin(angle)
    }

    setReleaseSeconds(seconds: number): void {
        this.#releaseCoeff = Math.exp(-1 / (this.#sampleRate * seconds))
    }

    set bandCount(count: number) {
        // Defensive guard — the box field is int32, a corrupt save can land anywhere.
        if (count !== 8 && count !== 12 && count !== 16) return
        if (count === this.#targetBandCount) return
        this.#targetBandCount = count
        for (let i = 0; i < VocoderDsp.MAX_BANDS; i++) {
            this.#targetActive[i] = i < count ? 1 : 0
        }
        // For newly-active cold bands, reset biquad state and snap current freq/Q
        // to the target layout so the fade-in starts clean.
        this.#computeBandTargets()
        for (let i = 0; i < VocoderDsp.MAX_BANDS; i++) {
            if (this.#targetActive[i] === 1 && this.#bandGainCurrent[i] < VocoderDsp.COLD_THRESHOLD) {
                this.#resetBandState(i)
                this.#curCarrierFreq[i]   = this.#tmpTargetCarrierFreq[i]
                this.#curModulatorFreq[i] = this.#tmpTargetModulatorFreq[i]
                this.#curCarrierQ[i]      = this.#tmpTargetQ[i]
                this.#curModulatorQ[i]    = this.#tmpTargetQ[i]
            }
        }
        // Upper iteration bound covers anything still ringing out; process loop shrinks it.
        this.#processedBands = VocoderDsp.MAX_BANDS
    }

    reset(): void {
        // Clear biquad/envelope state but preserve target/current freq & Q so the
        // first block after transport restart doesn't sweep from zero.
        for (let i = 0; i < VocoderDsp.MAX_BANDS; i++) this.#resetBandState(i)
    }

    // ── Entry point ───────────────────────────────────────────────────────

    processMonoMod(carL: Float32Array, carR: Float32Array, mod: Float32Array,
                   outL: Float32Array, outR: Float32Array, fromIndex: int, toIndex: int): void { /* sub-block walk */ }

    processStereoMod(carL: Float32Array, carR: Float32Array, modL: Float32Array, modR: Float32Array,
                     outL: Float32Array, outR: Float32Array, fromIndex: int, toIndex: int): void { /* sub-block walk */ }

    processSelf(carL: Float32Array, carR: Float32Array,
                outL: Float32Array, outR: Float32Array, fromIndex: int, toIndex: int): void { /* sub-block walk */ }

    // ── Internals ─────────────────────────────────────────────────────────
    #computeBandTargets(): void          { /* fills #tmpTargetCarrierFreq, #tmpTargetModulatorFreq, #tmpTargetQ */ }
    #interpolateCoeffs(): void           { /* geometric lerp cur→target, then writes #carrierCoeffs/#modulatorCoeffs */ }
    #writeAllCoefficients(): void        { /* bypasses lerp, writes target values directly — constructor only */ }
    #resetBandState(i: int): void        { /* clears biquad state and envelope for band i */ }

    // Scratch arrays for band targets, populated by #computeBandTargets and read by #interpolateCoeffs.
    // Preallocated Float32Arrays, not new-ed per call.
    readonly #tmpTargetCarrierFreq   = new Float32Array(VocoderDsp.MAX_BANDS)
    readonly #tmpTargetModulatorFreq = new Float32Array(VocoderDsp.MAX_BANDS)
    readonly #tmpTargetQ             = new Float32Array(VocoderDsp.MAX_BANDS)
}
```

### Coefficient storage & interpolation

Every `SUB_BLOCK = 64` samples, before the inner loop, we recompute per-band targets from the current parameter values, geometrically lerp `#curCarrierFreq[i]` / `#curModulatorFreq[i]` / `#curCarrierQ[i]` / `#curModulatorQ[i]` toward them, and overwrite both coefficient tables:

```typescript
#interpolateCoeffs(): void {
    this.#computeBandTargets()
    const N = VocoderDsp.MAX_BANDS
    const α = VocoderDsp.COEFF_LERP
    const sr = this.#sampleRate
    const cc = this.#scratchCarrierCoeff
    const mc = this.#scratchModulatorCoeff
    const carCoeffs = this.#carrierCoeffs
    const modCoeffs = this.#modulatorCoeffs
    for (let i = 0; i < this.#processedBands; i++) {
        if (this.#targetActive[i] === 0) continue // leave fading-out bands at their old freq/Q
        // Geometric (multiplicative) lerp:
        //   cur = cur · (target/cur)^α
        // Safe because cur is always > 0 (constructor snaps, set bandCount snaps on cold activate)
        this.#curCarrierFreq[i]   *= Math.pow(this.#tmpTargetCarrierFreq[i]   / this.#curCarrierFreq[i],   α)
        this.#curModulatorFreq[i] *= Math.pow(this.#tmpTargetModulatorFreq[i] / this.#curModulatorFreq[i], α)
        this.#curCarrierQ[i]      *= Math.pow(this.#tmpTargetQ[i]             / this.#curCarrierQ[i],      α)
        this.#curModulatorQ[i]    *= Math.pow(this.#tmpTargetQ[i]             / this.#curModulatorQ[i],    α)

        cc.setBandpassParams(this.#curCarrierFreq[i]   / sr, this.#curCarrierQ[i])
        mc.setBandpassParams(this.#curModulatorFreq[i] / sr, this.#curModulatorQ[i])
        const o = i * 5
        carCoeffs[o+0] = cc.b0; carCoeffs[o+1] = cc.b1; carCoeffs[o+2] = cc.b2
        carCoeffs[o+3] = cc.a1; carCoeffs[o+4] = cc.a2
        modCoeffs[o+0] = mc.b0; modCoeffs[o+1] = mc.b1; modCoeffs[o+2] = mc.b2
        modCoeffs[o+3] = mc.a1; modCoeffs[o+4] = mc.a2
    }
}
```

`#computeBandTargets()` spreads the N active bands exponentially across the current min/max ranges. Target slot `i` for the i-th active band (active slots are always `0..N-1` because we never leave holes):

```typescript
#computeBandTargets(): void {
    const N = this.#targetBandCount
    const cfLog = Math.log(this.#targetCarrierMaxFreq   / this.#targetCarrierMinFreq)
    const mfLog = Math.log(this.#targetModulatorMaxFreq / this.#targetModulatorMinFreq)
    const qLog  = Math.log(this.#targetQMax             / this.#targetQMin)
    for (let i = 0; i < N; i++) {
        const x = N === 1 ? 0 : i / (N - 1)
        this.#tmpTargetCarrierFreq[i]   = this.#targetCarrierMinFreq   * Math.exp(x * cfLog)
        this.#tmpTargetModulatorFreq[i] = this.#targetModulatorMinFreq * Math.exp(x * mfLog)
        this.#tmpTargetQ[i]             = this.#targetQMin             * Math.exp(x * qLog)
    }
    // slots N..MAX_BANDS-1 keep their stale targets; #interpolateCoeffs skips them via targetActive check
}
```

This means 8 → 12 → 16 transitions re-spread the active bands across the full range, so band 0 always sits at `minFreq` and band `N-1` at `maxFreq` regardless of `N`. Rapid 16→8→16 mid-fade resolves cleanly: every active band lerps toward the current target layout, fading-out bands freeze at their last position.

### Hot loop — three specialisations

Three inner-loop implementations, dispatched once per sub-block by the appropriate entry point. Zero branches inside the per-sample loops. Each loads all band state into locals, runs the tight per-sample loop, and stores state back.

**Common skeleton** (applies to all three):

```typescript
// Walk the block in SUB_BLOCK-sample chunks
let from = fromIndex
while (from < toIndex) {
    const to = Math.min(from + VocoderDsp.SUB_BLOCK, toIndex)
    this.#interpolateCoeffs()
    this.#innerLoop(/* buffers */, from, to)
    from = to
}
// After the entire block: shrink #processedBands by trimming trailing bands
// whose target is 0 AND bandGainCurrent[i] < COLD_THRESHOLD. Once shrunk, the
// next block skips them entirely (zero steady-state cost).
for (let i = this.#processedBands - 1; i >= 0; i--) {
    if (this.#targetActive[i] === 1 || this.#bandGainCurrent[i] >= VocoderDsp.COLD_THRESHOLD) break
    this.#processedBands = i
}
```

**Variant A — `#innerStereoMod`** (external modulator, full 4-biquad-per-band work):

```typescript
#innerStereoMod(carL, carR, modL, modR, outL, outR, from, to) {
    // 1. Dry pass
    const dry = this.#dryGain
    for (let i = from; i < to; i++) { outL[i] = carL[i] * dry; outR[i] = carR[i] * dry }

    const wet = this.#wetGain, bandG = VocoderDsp.BAND_GAIN
    const aCoeff = this.#attackCoeff, rCoeff = this.#releaseCoeff, fade = this.#fadeCoeff
    const upper = this.#processedBands
    const carC = this.#carrierCoeffs, modC = this.#modulatorCoeffs

    for (let i = 0; i < upper; i++) {
        const o = i * 5
        const cb0 = carC[o+0], cb1 = carC[o+1], cb2 = carC[o+2], ca1 = carC[o+3], ca2 = carC[o+4]
        const mb0 = modC[o+0], mb1 = modC[o+1], mb2 = modC[o+2], ma1 = modC[o+3], ma2 = modC[o+4]

        // 16 biquad state locals (4 biquads × 4 state vars)
        let cxL1 = this.#carCxL1[i], cxL2 = this.#carCxL2[i], cyL1 = this.#carCyL1[i], cyL2 = this.#carCyL2[i]
        let cxR1 = this.#carCxR1[i], cxR2 = this.#carCxR2[i], cyR1 = this.#carCyR1[i], cyR2 = this.#carCyR2[i]
        let mxL1 = this.#modMxL1[i], mxL2 = this.#modMxL2[i], myL1 = this.#modMyL1[i], myL2 = this.#modMyL2[i]
        let mxR1 = this.#modMxR1[i], mxR2 = this.#modMxR2[i], myR1 = this.#modMyR1[i], myR2 = this.#modMyR2[i]

        let env  = this.#envelope[i]
        let gain = this.#bandGainCurrent[i]
        const tgt = this.#targetActive[i]

        for (let s = from; s < to; s++) {
            // Band-fade one-pole
            gain = tgt + fade * (gain - tgt)

            // Modulator bandpass (stereo)
            const mxL = modL[s]
            const myL = (mb0*mxL + mb1*mxL1 + mb2*mxL2 - ma1*myL1 - ma2*myL2) + 1e-18 - 1e-18
            mxL2 = mxL1; mxL1 = mxL; myL2 = myL1; myL1 = myL
            const mxR = modR[s]
            const myR = (mb0*mxR + mb1*mxR1 + mb2*mxR2 - ma1*myR1 - ma2*myR2) + 1e-18 - 1e-18
            mxR2 = mxR1; mxR1 = mxR; myR2 = myR1; myR1 = myR

            // Envelope follower on max(|L|, |R|)
            const peak = Math.max(Math.abs(myL), Math.abs(myR))
            env = env < peak ? peak + aCoeff * (env - peak) : peak + rCoeff * (env - peak)

            // Carrier bandpass (stereo)
            const cxL = carL[s]
            const cyL = (cb0*cxL + cb1*cxL1 + cb2*cxL2 - ca1*cyL1 - ca2*cyL2) + 1e-18 - 1e-18
            cxL2 = cxL1; cxL1 = cxL; cyL2 = cyL1; cyL1 = cyL
            const cxR = carR[s]
            const cyR = (cb0*cxR + cb1*cxR1 + cb2*cxR2 - ca1*cyR1 - ca2*cyR2) + 1e-18 - 1e-18
            cxR2 = cxR1; cxR1 = cxR; cyR2 = cyR1; cyR1 = cyR

            const k = env * bandG * wet * gain
            outL[s] += cyL * k
            outR[s] += cyR * k
        }

        // Store all 16 state locals back
        this.#carCxL1[i] = cxL1; this.#carCxL2[i] = cxL2; this.#carCyL1[i] = cyL1; this.#carCyL2[i] = cyL2
        this.#carCxR1[i] = cxR1; this.#carCxR2[i] = cxR2; this.#carCyR1[i] = cyR1; this.#carCyR2[i] = cyR2
        this.#modMxL1[i] = mxL1; this.#modMxL2[i] = mxL2; this.#modMyL1[i] = myL1; this.#modMyL2[i] = myL2
        this.#modMxR1[i] = mxR1; this.#modMxR2[i] = mxR2; this.#modMyR1[i] = myR1; this.#modMyR2[i] = myR2
        this.#envelope[i] = env
        this.#bandGainCurrent[i] = gain
    }
}
```

**Variant B — `#innerMonoMod`**: noise modes. Mono modulator source, **one** modulator biquad per band (L slot only), envelope follower on `|myL|`. Saves half the modulator biquad work versus variant A.

**Variant C — `#innerSelf`**: self mode. **Zero** modulator biquads. The envelope follower runs on `max(|cyL|, |cyR|)` — the carrier's own bandpassed output. Turns the device into a true multi-band gate.

Notes on the inlined recurrence:

- `(b0*x + b1*x1 + b2*x2 - a1*y1 - a2*y2) + 1e-18 - 1e-18` is the denormal-killer trick from `BiquadMono.process`. Bandpass filters ring out into subnormal territory fast; keep this.
- Coefficients are read as locals at the top of each band loop — one load of 5 numbers per band per sub-block, which cascades into register allocations inside the inner loop.
- When switching between stereo/mono/self modes, **we do not clear** the state slots that become dormant. Stale state may cause a brief click when switching back; accepted trade.

### Band-count fade

Each band carries a smoothed scalar `bandGainCurrent[i]` that ramps toward `targetActive[i] ∈ {0, 1}` at a ~3 ms time constant. The scalar multiplies the band's wet contribution, so adding bands fades them in from silence and removing bands fades them out — both essentially inaudible.

- Bands fading **in** from cold (`bandGainCurrent < 1e-4` at the moment `targetActive` flips 0→1) get their biquad state cleared and their `curFreq`/`curQ` snapped to the current target layout. This prevents stale-tail bleed and audible "sweep-in" from a ghost position.
- Bands fading **out** continue processing at decreasing gain until they reach the cold threshold, at which point `#processedBands` shrinks past them and the next block skips them entirely.
- Rapid click-click 8→16→8 within the fade window is accepted; the fade may produce a faint ripple but no guard logic is added.

### Noise generators

Deterministic PRNG so renders are bit-identical across sessions. Uses the Mulberry32 algorithm from `@opendaw/lib-std/random.ts`, inlined directly into each fill loop to avoid any closure/call overhead.

```typescript
import {Mulberry32} from "@opendaw/lib-std"

export type NoiseColor = "white" | "pink" | "brown"

const SEED = 0xF123F42  // matches Random.create() default in lib-std

export class NoiseGenerator {
    #seed: number = SEED
    // Paul Kellet pink filter state
    #b0 = 0; #b1 = 0; #b2 = 0; #b3 = 0; #b4 = 0; #b5 = 0; #b6 = 0
    // brown integrator state
    #brown = 0

    fill(color: NoiseColor, target: Float32Array, fromIndex: int, toIndex: int): void {
        let seed = this.#seed
        switch (color) {
            case "white":
                for (let i = fromIndex; i < toIndex; i++) {
                    let t = seed += 0x6D2B79F5
                    t = Math.imul(t ^ t >>> 15, t | 1)
                    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
                    target[i] = (((t ^ t >>> 14) >>> 0) / 4294967296) * 2 - 1
                }
                break
            case "pink":
                for (let i = fromIndex; i < toIndex; i++) {
                    let t = seed += 0x6D2B79F5
                    t = Math.imul(t ^ t >>> 15, t | 1)
                    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
                    const white = (((t ^ t >>> 14) >>> 0) / 4294967296) * 2 - 1
                    this.#b0 = 0.99886 * this.#b0 + white * 0.0555179
                    this.#b1 = 0.99332 * this.#b1 + white * 0.0750759
                    this.#b2 = 0.96900 * this.#b2 + white * 0.1538520
                    this.#b3 = 0.86650 * this.#b3 + white * 0.3104856
                    this.#b4 = 0.55000 * this.#b4 + white * 0.5329522
                    this.#b5 = -0.7616 * this.#b5 - white * 0.0168980
                    target[i] = (this.#b0 + this.#b1 + this.#b2 + this.#b3
                                 + this.#b4 + this.#b5 + this.#b6 + white * 0.5362) * 0.11
                    this.#b6 = white * 0.115926
                }
                break
            case "brown":
                for (let i = fromIndex; i < toIndex; i++) {
                    let t = seed += 0x6D2B79F5
                    t = Math.imul(t ^ t >>> 15, t | 1)
                    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
                    const white = (((t ^ t >>> 14) >>> 0) / 4294967296) * 2 - 1
                    this.#brown = (this.#brown + 0.02 * white) / 1.02
                    target[i] = this.#brown * 3.5
                }
                break
        }
        this.#seed = seed
    }

    reset(): void {
        this.#seed = SEED
        this.#b0 = this.#b1 = this.#b2 = this.#b3 = this.#b4 = this.#b5 = this.#b6 = 0
        this.#brown = 0
    }
}
```

`reset()` restores the seed and all filter state so transport restart produces bit-identical audio — required for deterministic offline rendering.

## Editor UI

```
packages/app/studio/src/ui/devices/audio-effects/VocoderDeviceEditor.tsx
packages/app/studio/src/ui/devices/audio-effects/VocoderDeviceEditor.sass
packages/app/studio/src/ui/devices/audio-effects/Vocoder/VocoderTransform.tsx
packages/app/studio/src/ui/devices/audio-effects/Vocoder/VocoderTransform.sass
packages/app/studio/src/ui/devices/audio-effects/Vocoder/ModulatorSourceMenu.tsx
```

### Layout

```
+-----------------------+-----------+
|        DISPLAY        |  Source   |
|                       |  Bands    |
| K  K  K  K  K  K  K   |   Mix     |
+-----------------------+-----------+
```

Two-column CSS grid; the side panel spans both rows of the left column.

- **Display** (top-left): `VocoderTransform` canvas. Width matches the knob row below. The device row's exact pixel height is inherited from `DeviceEditor.sass`; measure it against `CompressorDeviceEditor` before fixing the canvas height in the sass file. Avoid hardcoding 140px without confirming.
- **Knob row** (bottom-left): 7 knobs via `ControlBuilder.createKnob({lifecycle, editing, midiLearning, adapter, parameter})` from `@/ui/devices/ControlBuilder`. Order: **Carrier Min, Carrier Max, Mod Min, Mod Max, Q Min, Q Max, Release**. Use `justify-content: space-between` on the row so the knobs spread evenly under the wider display rather than clustering left.
- **Side panel** (right column, full height):
  1. `ModulatorSourceMenu` button
  2. `RadioGroup` for band count (8 / 12 / 16), bound via `EditWrapper.forValue(editing, adapter.box.bandCount)`
  3. **Mix** knob via the same `ControlBuilder.createKnob` helper, styled slightly larger to make it the visual focus

`ControlBuilder.createKnob` already renders its own parameter label, so the editor's sass doesn't need a `.cell > span` override.

### Modulator source menu

`ModulatorSourceMenu.tsx` — clone of `SidechainButton.tsx` (~55 lines) with extra leading entries.

```typescript
type Construct = {
    editing: Editing
    rootBoxAdapter: RootBoxAdapter
    adapter: VocoderDeviceBoxAdapter  // needs box.modulatorSource + box.sideChain
}
```

Menu construction:

```typescript
const createMenu = (parent: MenuItem) => {
    const mode = (adapter.box.modulatorSource.getValue() ?? "noise-pink") as ModulatorMode
    const setMode = (next: ModulatorMode, target: Option<Address>) =>
        editing.modify(() => {
            adapter.box.modulatorSource.setValue(next)
            adapter.box.sideChain.targetAddress = target  // cleared on every mode switch
        })

    parent.addMenuItem(MenuItem.header({label: "Noise"}))
    parent.addMenuItem(MenuItem.default({label: "White", checked: mode === "noise-white"})
        .setTriggerProcedure(() => setMode("noise-white", Option.None)))
    parent.addMenuItem(MenuItem.default({label: "Pink",  checked: mode === "noise-pink"})
        .setTriggerProcedure(() => setMode("noise-pink",  Option.None)))
    parent.addMenuItem(MenuItem.default({label: "Brown", checked: mode === "noise-brown"})
        .setTriggerProcedure(() => setMode("noise-brown", Option.None)))
    parent.addMenuItem(MenuItem.default({label: "Self",  checked: mode === "self"})
        .setTriggerProcedure(() => setMode("self", Option.None)))
    parent.addMenuItem(MenuItem.header({label: "Tracks", icon: IconSymbol.OpenDAW, color: Colors.orange}))
    for (const output of rootBoxAdapter.labeledAudioOutputs()) {
        parent.addMenuItem(createSelectableItem(output, mode, setMode))
    }
}
```

`createSelectableItem` mirrors the recursive group/leaf builder in `SidechainButton.tsx`; the leaf trigger calls `setMode("external", Option.wrap(output.address))` and its `checked` state is `mode === "external" && sideChain.targetAddress.equals(output.address)`.

Button label reflects the current selection (`Pink`, `Self`, `<TrackName>`, …); subscribe both `box.modulatorSource` and `box.sideChain` to update it.

### VocoderTransform component

Follows the **Revamp editor pattern** (`packages/app/studio/src/ui/devices/audio-effects/Revamp/Curves.ts`): import `BiquadCoeff` and `gainToDb` from `@opendaw/lib-dsp`, allocate a single shared `BiquadCoeff` instance, and call `setBandpassParams(...)` + `getFrequencyResponse(...)` per band per repaint. **Importing from `lib-dsp` is fine; importing from any processor (`VocoderDsp`, `VocoderDeviceProcessor`, core-processors) is not.**

Inputs:

- `lifecycle`
- `adapter: VocoderDeviceBoxAdapter` — for parameter values and subscriptions, plus `box.bandCount.getValue()`
- `service: StudioService` — for `service.audioContext.sampleRate`

Module-level setup:

```typescript
import {BiquadCoeff, gainToDb} from "@opendaw/lib-dsp"
const biquad = new BiquadCoeff()  // shared scratch, single allocation per component instance
```

Preallocate scratch buffers for the repaint closure (not per `requestUpdate`):

```typescript
const MAX_BANDS = 16
const carrierFreq   = new Float32Array(MAX_BANDS)
const modulatorFreq = new Float32Array(MAX_BANDS)
const qs            = new Float32Array(MAX_BANDS)
let frequency:    Float32Array | null = null
let magResponse:  Float32Array | null = null
let phaseResponse: Float32Array | null = null
```

Painter logic (port of `VocoderSpectrum.update()` via `CanvasPainter` like `Compressor/CompressionCurve.tsx`):

1. On resize, reallocate `frequency`, `magResponse`, `phaseResponse` to `width + 1`. Prefill `frequency[k] = (20 * Math.pow(1000, k / width)) / sampleRate` — X axis spans **20 Hz to 20 kHz** regardless of the actual Nyquist, so the display is sample-rate-invariant.
2. Read parameters: `cfMin, cfMax, mfMin, mfMax, qMin, qMax`, plus `N = box.bandCount.getValue()`.
3. Fill the preallocated band arrays with exponentially-spread centers for the active `N`:
   ```typescript
   const cfLog = Math.log(cfMax / cfMin)
   const mfLog = Math.log(mfMax / mfMin)
   const qLog  = Math.log(qMax  / qMin)
   for (let i = 0; i < N; i++) {
       const x = N === 1 ? 0 : i / (N - 1)
       carrierFreq[i]   = cfMin * Math.exp(x * cfLog)
       modulatorFreq[i] = mfMin * Math.exp(x * mfLog)
       qs[i]            = qMin  * Math.exp(x * qLog)
   }
   ```
4. Two passes with `globalCompositeOperation = "screen"` for the overlay look:
   - **Carrier (bottom half):** for each of N bands, `biquad.setBandpassParams(carrierFreq[i] / sampleRate, qs[i])`, call `getFrequencyResponse`, map `gainToDb(mag)` → Y with `(db + 18) / 18 · (height/5) · 2`, paint filled+stroked path using `hsl(i/N · 360, 50%, 50%)`.
   - **Modulator (top half):** same with `modulatorFreq[i]`, mirrored vertically.
5. Dashed connection lines from each modulator filter peak to the matching carrier peak.
6. Background grid + frequency labels (20 Hz / 100 Hz / 1 kHz / 10 kHz / 20 kHz) drawn once in `onResize`.

Subscriptions:

```typescript
lifecycle.ownAll(
    adapter.namedParameter.carrierMinFreq.catchupAndSubscribe(()   => canvasPainter.requestUpdate()),
    adapter.namedParameter.carrierMaxFreq.catchupAndSubscribe(()   => canvasPainter.requestUpdate()),
    adapter.namedParameter.modulatorMinFreq.catchupAndSubscribe(() => canvasPainter.requestUpdate()),
    adapter.namedParameter.modulatorMaxFreq.catchupAndSubscribe(() => canvasPainter.requestUpdate()),
    adapter.namedParameter.qMin.catchupAndSubscribe(()             => canvasPainter.requestUpdate()),
    adapter.namedParameter.qMax.catchupAndSubscribe(()             => canvasPainter.requestUpdate()),
    adapter.box.bandCount.catchupAndSubscribe(()                    => canvasPainter.requestUpdate())
)
```

Band-count changes are **instant** in the display: the subscription fires, curves snap to the new `N`. The audio's ~3 ms fade is invisible here by design.

## Factory wiring

Per `creating-a-device.md`:

1. **`packages/studio/core/src/EffectFactories.ts`** — add `Vocoder` factory entry (mirror the `Compressor` block). Set `manualUrl: DeviceManualUrls.Vocoder`. Register in `AudioNamed`.
2. **`packages/studio/core/src/EffectBox.ts`** — add `VocoderDeviceBox` to the `EffectBox` union type.
3. **`packages/studio/adapters/src/BoxAdapters.ts`** — add `visitVocoderDeviceBox: box => new VocoderDeviceBoxAdapter(this.#context, box)`.
4. **`packages/studio/core-processors/src/DeviceProcessorFactory.ts`** — add `visitVocoderDeviceBox` returning `new VocoderDeviceProcessor(...)`.
5. **`packages/app/studio/src/ui/devices/DeviceEditorFactory.tsx`** — add `visitVocoderDeviceBox` returning `<VocoderDeviceEditor …/>`.
6. **`packages/studio/adapters/src/DeviceManualUrls.ts`** — add `export const Vocoder = "manuals/devices/audio/vocoder"`.
7. **`packages/app/studio/public/manuals/devices/audio/vocoder.md`** — see "Manual" below.

Icon: use any existing `IconSymbol` value as a placeholder (e.g. `IconSymbol.EQ`). The user will provide a dedicated vocoder icon later.

## Manual

`packages/app/studio/public/manuals/devices/audio/vocoder.md`

```markdown
# Vocoder

A classic analysis/synthesis vocoder. The device splits two signals — a **carrier**
(the main device input) and a **modulator** — into parallel band-pass filters, tracks
the modulator's per-band amplitude with envelope followers, and uses those envelopes
to drive the gain of the matching carrier bands. The output is the carrier "speaking"
through the modulator.

Unlike most vocoders, the carrier and modulator frequency ranges are **independent
parameters**. You can stretch, compress, invert, or completely reverse the mapping
between them — for example, driving the carrier's high bands from the modulator's
low bands produces a spectrum-reversed vocoder sound you won't find in many plugins.

## Parameters

### Carrier Min / Carrier Max
Low and high frequency bounds of the carrier filter bank. Bands are spread
exponentially between these two values.

### Mod Min / Mod Max
Low and high frequency bounds of the modulator filter bank. Swap or reverse these
relative to the carrier bounds to remap the spectral correspondence.

### Q Min / Q Max
Bandwidth range for the filters. Bands are spread exponentially between these two
Q values; narrow Q gives sharper formants, wide Q gives a smoother sound.

### Release
Release time of the envelope follower that tracks each modulator band. Short values
give a snappier, more intelligible result; long values smear and smooth.

### Mix
Dry/wet crossfade (equal-power). At 100 % the output is purely the vocoded signal;
at 0 % the carrier passes through unchanged.

### Band Count (8 / 12 / 16)
Number of filter bands. 8 is warm and analog-like, 12 is balanced, 16 is more
articulate. Changes are click-free — switching mid-playback is safe.

### Modulator Source
Choose the modulator signal:

- **Noise — White / Pink / Brown**: built-in deterministic noise generators. Pink
  is the default and gives an immediately recognisable vocoder sound the moment the
  device is added.
- **Self**: the carrier modulates itself. The device becomes a true multi-band gate.
- **<Track>**: any audio track in the project. Route a vocal or drum track here for
  classic vocoder work.

## Tips

- For **spectrum reversal**, swap Mod Min and Mod Max (set Min to 12000 Hz, Max to
  80 Hz) while keeping Carrier in the normal direction. You'll hear low-frequency
  modulator content drive the carrier's high bands and vice versa.
- **Self mode** on a bass line acts like a multi-band gate, tightening the transient
  shape of each frequency region independently.
- Use **16 bands** for intelligible vocals, **8 bands** for warmer or more vintage
  character.
```

## Implementation Order

1. **Schema + regenerate** — add `VocoderDeviceBox.ts` schema, register in `DeviceDefinitions`, run `npm run build` from `forge-boxes`. Verify the generated `packages/studio/boxes/src/VocoderDeviceBox.ts` matches the field map.
2. **DSP class** — write `VocoderDsp.ts` including inlined biquad recurrence, geometric coefficient interpolation, band-fade machinery, three inner-loop specialisations, and `NoiseGenerator`. Unit-test by feeding noise carrier + a sine burst modulator and verifying output rises around the burst frequency.
3. **Adapter** — write `VocoderDeviceBoxAdapter.ts`, export it and `ModulatorMode` from `adapters/src/index.ts`.
4. **Processor** — write `VocoderDeviceProcessor.ts`, mirroring Compressor's sidechain wiring. Use the `processAudio(_block, fromIndex, toIndex)` signature from the manual.
5. **Factory wiring** — register in all 6 factory/index files (steps 1–6 under Factory wiring). The device should now appear in the picker and produce sound.
6. **Editor + display** — write `VocoderDeviceEditor.tsx`, `Vocoder/VocoderTransform.tsx`, `Vocoder/ModulatorSourceMenu.tsx`, sass files. Wire into `DeviceEditorFactory.tsx`. Measure the standard device row height against `CompressorDeviceEditor` before settling on canvas dimensions.
7. **Manual** — write `manuals/devices/audio/vocoder.md` and add `DeviceManualUrls.Vocoder`.
8. **End-to-end check** — drop a Vocoder on a synth track, hear pink-noise modulation immediately. Switch source to a vocal audio track via the menu. Toggle band counts rapidly and confirm clicks are absent. Verify the display reacts to all parameter changes and snaps instantly on band-count switches.
9. **Type-check** affected packages with `--noEmit`.

## Notes

- **`bandGain` tuning**: kept constant at `BAND_GAIN = 120.0` for v1 (reference-faithful). If extreme Q settings sound unbalanced in practice, swap to `k / sqrt(q)` as a self-balancing alternative.
- **Coefficient interpolation τ**: `COEFF_LERP = 0.25` at 64-sample stride gives ~4.6 ms. Alternatives documented in-code: `0.5` (~1.8 ms snappy), `0.15` (~8 ms smooth).
- **Band fade τ**: 3 ms — just enough to suppress clicks, otherwise feels instant.
- **Icon**: reuse any existing `IconSymbol` as a placeholder; user will provide a dedicated one.
