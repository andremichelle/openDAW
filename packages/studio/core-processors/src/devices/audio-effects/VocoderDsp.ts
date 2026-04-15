import {BiquadCoeff, RenderQuantum} from "@opendaw/lib-dsp"
import {int} from "@opendaw/lib-std"

const EMPHASIS_FREQ_HZ = 3000  // classic speech intelligibility center

export type NoiseColor = "white" | "pink" | "brown"

const NOISE_SEED = 0xF123F42

export class NoiseGenerator {
    #seed: number = NOISE_SEED
    #b0 = 0
    #b1 = 0
    #b2 = 0
    #b3 = 0
    #b4 = 0
    #b5 = 0
    #b6 = 0
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
            case "pink": {
                let b0 = this.#b0, b1 = this.#b1, b2 = this.#b2, b3 = this.#b3
                let b4 = this.#b4, b5 = this.#b5, b6 = this.#b6
                for (let i = fromIndex; i < toIndex; i++) {
                    let t = seed += 0x6D2B79F5
                    t = Math.imul(t ^ t >>> 15, t | 1)
                    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
                    const white = (((t ^ t >>> 14) >>> 0) / 4294967296) * 2 - 1
                    b0 = 0.99886 * b0 + white * 0.0555179
                    b1 = 0.99332 * b1 + white * 0.0750759
                    b2 = 0.96900 * b2 + white * 0.1538520
                    b3 = 0.86650 * b3 + white * 0.3104856
                    b4 = 0.55000 * b4 + white * 0.5329522
                    b5 = -0.7616 * b5 - white * 0.0168980
                    target[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11
                    b6 = white * 0.115926
                }
                this.#b0 = b0; this.#b1 = b1; this.#b2 = b2; this.#b3 = b3
                this.#b4 = b4; this.#b5 = b5; this.#b6 = b6
                break
            }
            case "brown": {
                let brown = this.#brown
                for (let i = fromIndex; i < toIndex; i++) {
                    let t = seed += 0x6D2B79F5
                    t = Math.imul(t ^ t >>> 15, t | 1)
                    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
                    const white = (((t ^ t >>> 14) >>> 0) / 4294967296) * 2 - 1
                    brown = (brown + 0.02 * white) / 1.02
                    target[i] = brown * 3.5
                }
                this.#brown = brown
                break
            }
        }
        this.#seed = seed
    }

    reset(): void {
        this.#seed = NOISE_SEED
        this.#b0 = this.#b1 = this.#b2 = this.#b3 = this.#b4 = this.#b5 = this.#b6 = 0
        this.#brown = 0
    }
}

/**
 * Vocoder DSP. Carrier passes through the device as the main input; the modulator
 * can be synthesised noise, the carrier itself (multi-band gate), or an external
 * sidechain signal.
 *
 * Hot loop is specialised on modulator mode (stereo / mono / self) so the inner
 * per-sample loop has zero branches. Band state lives in flat Float32Arrays and is
 * hoisted into locals for each band iteration.
 *
 * Coefficients are interpolated geometrically every SUB_BLOCK samples. Band-count
 * changes are click-free via a per-band fade scalar.
 */
export class VocoderDsp {
    static readonly MAX_BANDS = 16
    /** Reference-faithful compensation for narrow-bandpass attenuation.
     *  Alternative if wide bands sound hot: BAND_GAIN = k / sqrt(q) per band. */
    static readonly BAND_GAIN = 120.0
    /** Coefficient interpolation stride (2 sub-blocks per 128-sample render quantum). */
    static readonly SUB_BLOCK = 64
    /** Per-sub-block geometric lerp factor.
     *  0.25 → ≈ 4.6 ms τ @ 48 kHz (default, close to reference's 5 ms ramp).
     *  Alternatives: 0.5 → ≈ 1.8 ms (snappier), 0.15 → ≈ 8 ms (smoother but laggier). */
    static readonly COEFF_LERP = 0.25
    /** Click-suppression fade for band-count changes. Short enough to feel instant. */
    static readonly BAND_FADE_SECONDS = 0.003
    static readonly COLD_THRESHOLD = 1e-4

    readonly #sampleRate: number

    // ── Band-count fade state ─────────────────────────────────────────────
    readonly #targetActive: Int8Array
    readonly #bandGainCurrent: Float32Array
    #fadeCoeff: number = 0.0
    #processedBands: number = VocoderDsp.MAX_BANDS
    #targetBandCount: number = 16

    // ── Target parameter values (written by setters) ──────────────────────
    #targetCarrierMinFreq: number = 80.0
    #targetCarrierMaxFreq: number = 12000.0
    #targetModulatorMinFreq: number = 80.0
    #targetModulatorMaxFreq: number = 12000.0
    #targetQMin: number = 2.0
    #targetQMax: number = 20.0

    // ── Current (lerped) per-band frequencies & Q ─────────────────────────
    readonly #curCarrierFreq: Float32Array
    readonly #curModulatorFreq: Float32Array
    readonly #curCarrierQ: Float32Array
    readonly #curModulatorQ: Float32Array

    // ── Scratch for band target computation ───────────────────────────────
    readonly #tmpTargetCarrierFreq: Float32Array
    readonly #tmpTargetModulatorFreq: Float32Array
    readonly #tmpTargetQ: Float32Array

    // ── Envelope follower state (per band, mono) ──────────────────────────
    readonly #envelope: Float32Array
    #attackCoeff: number = 0.0
    #releaseCoeff: number = 0.0

    // ── Pre-emphasis (high-shelf on modulator path) ──────────────────────
    readonly #preEmphasisCoeffs = new Float32Array(5)  // [b0, b1, b2, a1, a2]
    readonly #emphScratchL = new Float32Array(RenderQuantum)
    readonly #emphScratchR = new Float32Array(RenderQuantum)
    #emphasisDb: number = 0
    #emphXL1 = 0; #emphXL2 = 0; #emphYL1 = 0; #emphYL2 = 0
    #emphXR1 = 0; #emphXR2 = 0; #emphYR1 = 0; #emphYR2 = 0

    // ── Coefficient storage: flat Float32Array(5 * MAX_BANDS) per side ────
    // Layout per band i: [b0, b1, b2, a1, a2] at offset i*5
    readonly #carrierCoeffs: Float32Array
    readonly #modulatorCoeffs: Float32Array

    // Scratch BiquadCoeff instances used only during interpolation
    readonly #scratchCarrierCoeff: BiquadCoeff
    readonly #scratchModulatorCoeff: BiquadCoeff

    // ── Carrier biquad state (stereo, flat arrays) ────────────────────────
    readonly #carCxL1: Float32Array; readonly #carCxL2: Float32Array
    readonly #carCyL1: Float32Array; readonly #carCyL2: Float32Array
    readonly #carCxR1: Float32Array; readonly #carCxR2: Float32Array
    readonly #carCyR1: Float32Array; readonly #carCyR2: Float32Array

    // ── Modulator biquad state (stereo; mono variant uses only L slots) ───
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

        this.#targetActive = new Int8Array(N)
        this.#bandGainCurrent = alloc()

        this.#curCarrierFreq = alloc()
        this.#curModulatorFreq = alloc()
        this.#curCarrierQ = alloc()
        this.#curModulatorQ = alloc()

        this.#tmpTargetCarrierFreq = alloc()
        this.#tmpTargetModulatorFreq = alloc()
        this.#tmpTargetQ = alloc()

        this.#envelope = alloc()

        this.#carrierCoeffs = new Float32Array(5 * N)
        this.#modulatorCoeffs = new Float32Array(5 * N)
        this.#scratchCarrierCoeff = new BiquadCoeff()
        this.#scratchModulatorCoeff = new BiquadCoeff()

        this.#carCxL1 = alloc(); this.#carCxL2 = alloc(); this.#carCyL1 = alloc(); this.#carCyL2 = alloc()
        this.#carCxR1 = alloc(); this.#carCxR2 = alloc(); this.#carCyR1 = alloc(); this.#carCyR2 = alloc()
        this.#modMxL1 = alloc(); this.#modMxL2 = alloc(); this.#modMyL1 = alloc(); this.#modMyL2 = alloc()
        this.#modMxR1 = alloc(); this.#modMxR2 = alloc(); this.#modMyR1 = alloc(); this.#modMyR2 = alloc()

        // Start with all bands active up to the default count, fully faded in.
        for (let i = 0; i < this.#targetBandCount; i++) {
            this.#targetActive[i] = 1
            this.#bandGainCurrent[i] = 1.0
        }

        // Snap cur = target for every slot so the first geometric lerp has a valid
        // non-zero denominator. Use fallback values that mirror the defaults.
        this.#computeBandTargets()
        for (let i = 0; i < N; i++) {
            const t = Math.min(i, this.#targetBandCount - 1)
            this.#curCarrierFreq[i] = this.#tmpTargetCarrierFreq[t]
            this.#curModulatorFreq[i] = this.#tmpTargetModulatorFreq[t]
            this.#curCarrierQ[i] = this.#tmpTargetQ[t]
            this.#curModulatorQ[i] = this.#tmpTargetQ[t]
        }

        this.#fadeCoeff = Math.exp(-1 / (sampleRate * VocoderDsp.BAND_FADE_SECONDS))
        this.setAttackSeconds(0.005)
        this.setReleaseSeconds(0.030)
        this.#updateEmphasisCoeffs()
        this.#writeAllCoefficients()
    }

    // ── Parameter setters ─────────────────────────────────────────────────

    set carrierMinFreq(hz: number) { this.#targetCarrierMinFreq = hz }
    set carrierMaxFreq(hz: number) { this.#targetCarrierMaxFreq = hz }
    set modulatorMinFreq(hz: number) { this.#targetModulatorMinFreq = hz }
    set modulatorMaxFreq(hz: number) { this.#targetModulatorMaxFreq = hz }
    set qMin(q: number) { this.#targetQMin = q }
    set qMax(q: number) { this.#targetQMax = q }

    set mix(value: number) {
        const angle = value * Math.PI * 0.5
        this.#dryGain = Math.cos(angle)
        this.#wetGain = Math.sin(angle)
    }

    setAttackSeconds(seconds: number): void {
        this.#attackCoeff = Math.exp(-1 / (this.#sampleRate * seconds))
    }

    setReleaseSeconds(seconds: number): void {
        this.#releaseCoeff = Math.exp(-1 / (this.#sampleRate * seconds))
    }

    set emphasis(db: number) {
        if (this.#emphasisDb === db) return
        this.#emphasisDb = db
        this.#updateEmphasisCoeffs()
    }

    #updateEmphasisCoeffs(): void {
        const cc = this.#scratchCarrierCoeff  // reuse as scratch
        cc.setHighShelfParams(EMPHASIS_FREQ_HZ / this.#sampleRate, this.#emphasisDb)
        this.#preEmphasisCoeffs[0] = cc.b0
        this.#preEmphasisCoeffs[1] = cc.b1
        this.#preEmphasisCoeffs[2] = cc.b2
        this.#preEmphasisCoeffs[3] = cc.a1
        this.#preEmphasisCoeffs[4] = cc.a2
    }

    set bandCount(count: number) {
        // Defensive guard — stray save-file value won't crash the DSP.
        if (count !== 8 && count !== 12 && count !== 16) return
        if (count === this.#targetBandCount) return
        this.#targetBandCount = count
        for (let i = 0; i < VocoderDsp.MAX_BANDS; i++) {
            this.#targetActive[i] = i < count ? 1 : 0
        }
        // For bands fading in from a cold start, reset biquad state and snap
        // their cur freq/Q to the target layout so the fade-in begins cleanly.
        this.#computeBandTargets()
        for (let i = 0; i < VocoderDsp.MAX_BANDS; i++) {
            if (this.#targetActive[i] === 1 && this.#bandGainCurrent[i] < VocoderDsp.COLD_THRESHOLD) {
                this.#resetBandState(i)
                this.#curCarrierFreq[i] = this.#tmpTargetCarrierFreq[i]
                this.#curModulatorFreq[i] = this.#tmpTargetModulatorFreq[i]
                this.#curCarrierQ[i] = this.#tmpTargetQ[i]
                this.#curModulatorQ[i] = this.#tmpTargetQ[i]
            }
        }
        // Cover any band still ringing out; process loop shrinks this back.
        this.#processedBands = VocoderDsp.MAX_BANDS
    }

    reset(): void {
        // Clear biquad + envelope + band-fade state but preserve target/current
        // freq & Q so transport restart doesn't sweep from zero.
        for (let i = 0; i < VocoderDsp.MAX_BANDS; i++) {
            this.#resetBandState(i)
            this.#bandGainCurrent[i] = this.#targetActive[i]
        }
        this.#processedBands = this.#targetBandCount
        this.#emphXL1 = this.#emphXL2 = this.#emphYL1 = this.#emphYL2 = 0
        this.#emphXR1 = this.#emphXR2 = this.#emphYR1 = this.#emphYR2 = 0
    }

    // ── Entry points ──────────────────────────────────────────────────────

    processStereoMod(carL: Float32Array, carR: Float32Array,
                     modL: Float32Array, modR: Float32Array,
                     outL: Float32Array, outR: Float32Array,
                     fromIndex: int, toIndex: int): void {
        if (this.#emphasisDb > 0.01) {
            this.#applyEmphasisStereo(modL, modR, fromIndex, toIndex)
            modL = this.#emphScratchL
            modR = this.#emphScratchR
        }
        let from = fromIndex
        while (from < toIndex) {
            const to = Math.min(from + VocoderDsp.SUB_BLOCK, toIndex)
            this.#interpolateCoeffs()
            this.#innerStereoMod(carL, carR, modL, modR, outL, outR, from, to)
            from = to
        }
        this.#trimProcessedBands()
    }

    processMonoMod(carL: Float32Array, carR: Float32Array, mod: Float32Array,
                   outL: Float32Array, outR: Float32Array,
                   fromIndex: int, toIndex: int): void {
        if (this.#emphasisDb > 0.01) {
            this.#applyEmphasisMono(mod, fromIndex, toIndex)
            mod = this.#emphScratchL
        }
        let from = fromIndex
        while (from < toIndex) {
            const to = Math.min(from + VocoderDsp.SUB_BLOCK, toIndex)
            this.#interpolateCoeffs()
            this.#innerMonoMod(carL, carR, mod, outL, outR, from, to)
            from = to
        }
        this.#trimProcessedBands()
    }

    processSelf(carL: Float32Array, carR: Float32Array,
                outL: Float32Array, outR: Float32Array,
                fromIndex: int, toIndex: int): void {
        let from = fromIndex
        while (from < toIndex) {
            const to = Math.min(from + VocoderDsp.SUB_BLOCK, toIndex)
            this.#interpolateCoeffs()
            this.#innerSelf(carL, carR, outL, outR, from, to)
            from = to
        }
        this.#trimProcessedBands()
    }

    // ── Internals: band target spread & coefficient interpolation ────────

    #computeBandTargets(): void {
        const N = this.#targetBandCount
        const cfMin = this.#targetCarrierMinFreq
        const mfMin = this.#targetModulatorMinFreq
        const cfLog = Math.log(this.#targetCarrierMaxFreq / cfMin)
        const mfLog = Math.log(this.#targetModulatorMaxFreq / mfMin)
        const qMin = this.#targetQMin
        const qLog = Math.log(this.#targetQMax / qMin)
        const denom = N === 1 ? 1 : N - 1
        for (let i = 0; i < N; i++) {
            const x = N === 1 ? 0 : i / denom
            this.#tmpTargetCarrierFreq[i] = cfMin * Math.exp(x * cfLog)
            this.#tmpTargetModulatorFreq[i] = mfMin * Math.exp(x * mfLog)
            this.#tmpTargetQ[i] = qMin * Math.exp(x * qLog)
        }
        // Slots [N..MAX_BANDS) retain stale targets but are skipped by the
        // interpolation / process loops via the targetActive check.
    }

    #interpolateCoeffs(): void {
        this.#computeBandTargets()
        const alpha = VocoderDsp.COEFF_LERP
        const sr = this.#sampleRate
        const cc = this.#scratchCarrierCoeff
        const mc = this.#scratchModulatorCoeff
        const carC = this.#carrierCoeffs
        const modC = this.#modulatorCoeffs
        const upper = this.#processedBands
        for (let i = 0; i < upper; i++) {
            // Leave fading-out bands (target 0) at their last freq/Q. Their wet
            // contribution is scaled to zero by bandGainCurrent anyway.
            if (this.#targetActive[i] !== 0) {
                // Geometric lerp: cur *= (target / cur) ** alpha
                this.#curCarrierFreq[i] *=
                    Math.pow(this.#tmpTargetCarrierFreq[i] / this.#curCarrierFreq[i], alpha)
                this.#curModulatorFreq[i] *=
                    Math.pow(this.#tmpTargetModulatorFreq[i] / this.#curModulatorFreq[i], alpha)
                this.#curCarrierQ[i] *=
                    Math.pow(this.#tmpTargetQ[i] / this.#curCarrierQ[i], alpha)
                this.#curModulatorQ[i] *=
                    Math.pow(this.#tmpTargetQ[i] / this.#curModulatorQ[i], alpha)
            }
            cc.setBandpassParams(this.#curCarrierFreq[i] / sr, this.#curCarrierQ[i])
            mc.setBandpassParams(this.#curModulatorFreq[i] / sr, this.#curModulatorQ[i])
            const o = i * 5
            carC[o + 0] = cc.b0; carC[o + 1] = cc.b1; carC[o + 2] = cc.b2
            carC[o + 3] = cc.a1; carC[o + 4] = cc.a2
            modC[o + 0] = mc.b0; modC[o + 1] = mc.b1; modC[o + 2] = mc.b2
            modC[o + 3] = mc.a1; modC[o + 4] = mc.a2
        }
    }

    #writeAllCoefficients(): void {
        // Constructor-time initial write using the already-snapped cur values.
        const sr = this.#sampleRate
        const cc = this.#scratchCarrierCoeff
        const mc = this.#scratchModulatorCoeff
        const carC = this.#carrierCoeffs
        const modC = this.#modulatorCoeffs
        for (let i = 0; i < VocoderDsp.MAX_BANDS; i++) {
            cc.setBandpassParams(this.#curCarrierFreq[i] / sr, this.#curCarrierQ[i])
            mc.setBandpassParams(this.#curModulatorFreq[i] / sr, this.#curModulatorQ[i])
            const o = i * 5
            carC[o + 0] = cc.b0; carC[o + 1] = cc.b1; carC[o + 2] = cc.b2
            carC[o + 3] = cc.a1; carC[o + 4] = cc.a2
            modC[o + 0] = mc.b0; modC[o + 1] = mc.b1; modC[o + 2] = mc.b2
            modC[o + 3] = mc.a1; modC[o + 4] = mc.a2
        }
    }

    #resetBandState(i: int): void {
        this.#carCxL1[i] = 0; this.#carCxL2[i] = 0; this.#carCyL1[i] = 0; this.#carCyL2[i] = 0
        this.#carCxR1[i] = 0; this.#carCxR2[i] = 0; this.#carCyR1[i] = 0; this.#carCyR2[i] = 0
        this.#modMxL1[i] = 0; this.#modMxL2[i] = 0; this.#modMyL1[i] = 0; this.#modMyL2[i] = 0
        this.#modMxR1[i] = 0; this.#modMxR2[i] = 0; this.#modMyR1[i] = 0; this.#modMyR2[i] = 0
        this.#envelope[i] = 0
    }

    #applyEmphasisStereo(inL: Float32Array, inR: Float32Array, from: int, to: int): void {
        const pe = this.#preEmphasisCoeffs
        const b0 = pe[0], b1 = pe[1], b2 = pe[2], a1 = pe[3], a2 = pe[4]
        const outL = this.#emphScratchL
        const outR = this.#emphScratchR
        let xL1 = this.#emphXL1, xL2 = this.#emphXL2, yL1 = this.#emphYL1, yL2 = this.#emphYL2
        let xR1 = this.#emphXR1, xR2 = this.#emphXR2, yR1 = this.#emphYR1, yR2 = this.#emphYR2
        for (let s = from; s < to; s++) {
            const xL = inL[s]
            const yL = (b0 * xL + b1 * xL1 + b2 * xL2 - a1 * yL1 - a2 * yL2) + 1e-18 - 1e-18
            xL2 = xL1; xL1 = xL; yL2 = yL1; yL1 = yL
            outL[s] = yL
            const xR = inR[s]
            const yR = (b0 * xR + b1 * xR1 + b2 * xR2 - a1 * yR1 - a2 * yR2) + 1e-18 - 1e-18
            xR2 = xR1; xR1 = xR; yR2 = yR1; yR1 = yR
            outR[s] = yR
        }
        this.#emphXL1 = xL1; this.#emphXL2 = xL2; this.#emphYL1 = yL1; this.#emphYL2 = yL2
        this.#emphXR1 = xR1; this.#emphXR2 = xR2; this.#emphYR1 = yR1; this.#emphYR2 = yR2
    }

    #applyEmphasisMono(input: Float32Array, from: int, to: int): void {
        const pe = this.#preEmphasisCoeffs
        const b0 = pe[0], b1 = pe[1], b2 = pe[2], a1 = pe[3], a2 = pe[4]
        const out = this.#emphScratchL
        let x1 = this.#emphXL1, x2 = this.#emphXL2, y1 = this.#emphYL1, y2 = this.#emphYL2
        for (let s = from; s < to; s++) {
            const x = input[s]
            const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) + 1e-18 - 1e-18
            x2 = x1; x1 = x; y2 = y1; y1 = y
            out[s] = y
        }
        this.#emphXL1 = x1; this.#emphXL2 = x2; this.#emphYL1 = y1; this.#emphYL2 = y2
    }

    #trimProcessedBands(): void {
        for (let i = this.#processedBands - 1; i >= 0; i--) {
            if (this.#targetActive[i] === 1 || this.#bandGainCurrent[i] >= VocoderDsp.COLD_THRESHOLD) {
                this.#processedBands = i + 1
                return
            }
        }
        this.#processedBands = 0
    }

    // ── Hot loops: three specialisations ─────────────────────────────────

    #innerStereoMod(carL: Float32Array, carR: Float32Array,
                    modL: Float32Array, modR: Float32Array,
                    outL: Float32Array, outR: Float32Array,
                    from: int, to: int): void {
        const dry = this.#dryGain
        for (let i = from; i < to; i++) {
            outL[i] = carL[i] * dry
            outR[i] = carR[i] * dry
        }

        const wet = this.#wetGain
        const bandG = VocoderDsp.BAND_GAIN
        const aCoeff = this.#attackCoeff
        const rCoeff = this.#releaseCoeff
        const fade = this.#fadeCoeff
        const upper = this.#processedBands
        const carC = this.#carrierCoeffs
        const modC = this.#modulatorCoeffs

        for (let i = 0; i < upper; i++) {
            const o = i * 5
            const cb0 = carC[o + 0], cb1 = carC[o + 1], cb2 = carC[o + 2]
            const ca1 = carC[o + 3], ca2 = carC[o + 4]
            const mb0 = modC[o + 0], mb1 = modC[o + 1], mb2 = modC[o + 2]
            const ma1 = modC[o + 3], ma2 = modC[o + 4]

            let cxL1 = this.#carCxL1[i], cxL2 = this.#carCxL2[i]
            let cyL1 = this.#carCyL1[i], cyL2 = this.#carCyL2[i]
            let cxR1 = this.#carCxR1[i], cxR2 = this.#carCxR2[i]
            let cyR1 = this.#carCyR1[i], cyR2 = this.#carCyR2[i]
            let mxL1 = this.#modMxL1[i], mxL2 = this.#modMxL2[i]
            let myL1 = this.#modMyL1[i], myL2 = this.#modMyL2[i]
            let mxR1 = this.#modMxR1[i], mxR2 = this.#modMxR2[i]
            let myR1 = this.#modMyR1[i], myR2 = this.#modMyR2[i]

            let env = this.#envelope[i]
            let gain = this.#bandGainCurrent[i]
            const tgt = this.#targetActive[i]

            for (let s = from; s < to; s++) {
                gain = tgt + fade * (gain - tgt)

                // Modulator bandpass (stereo)
                const mxL = modL[s]
                const myL = (mb0 * mxL + mb1 * mxL1 + mb2 * mxL2 - ma1 * myL1 - ma2 * myL2) + 1e-18 - 1e-18
                mxL2 = mxL1; mxL1 = mxL; myL2 = myL1; myL1 = myL
                const mxR = modR[s]
                const myR = (mb0 * mxR + mb1 * mxR1 + mb2 * mxR2 - ma1 * myR1 - ma2 * myR2) + 1e-18 - 1e-18
                mxR2 = mxR1; mxR1 = mxR; myR2 = myR1; myR1 = myR

                // Envelope follower on max(|L|, |R|)
                const aL = myL < 0 ? -myL : myL
                const aR = myR < 0 ? -myR : myR
                const peak = aL > aR ? aL : aR
                env = env < peak
                    ? peak + aCoeff * (env - peak)
                    : peak + rCoeff * (env - peak)

                // Carrier bandpass (stereo)
                const cxL = carL[s]
                const cyL = (cb0 * cxL + cb1 * cxL1 + cb2 * cxL2 - ca1 * cyL1 - ca2 * cyL2) + 1e-18 - 1e-18
                cxL2 = cxL1; cxL1 = cxL; cyL2 = cyL1; cyL1 = cyL
                const cxR = carR[s]
                const cyR = (cb0 * cxR + cb1 * cxR1 + cb2 * cxR2 - ca1 * cyR1 - ca2 * cyR2) + 1e-18 - 1e-18
                cxR2 = cxR1; cxR1 = cxR; cyR2 = cyR1; cyR1 = cyR

                const k = env * bandG * wet * gain
                outL[s] += cyL * k
                outR[s] += cyR * k
            }

            this.#carCxL1[i] = cxL1; this.#carCxL2[i] = cxL2
            this.#carCyL1[i] = cyL1; this.#carCyL2[i] = cyL2
            this.#carCxR1[i] = cxR1; this.#carCxR2[i] = cxR2
            this.#carCyR1[i] = cyR1; this.#carCyR2[i] = cyR2
            this.#modMxL1[i] = mxL1; this.#modMxL2[i] = mxL2
            this.#modMyL1[i] = myL1; this.#modMyL2[i] = myL2
            this.#modMxR1[i] = mxR1; this.#modMxR2[i] = mxR2
            this.#modMyR1[i] = myR1; this.#modMyR2[i] = myR2
            this.#envelope[i] = env
            this.#bandGainCurrent[i] = gain
        }
    }

    #innerMonoMod(carL: Float32Array, carR: Float32Array, mod: Float32Array,
                  outL: Float32Array, outR: Float32Array,
                  from: int, to: int): void {
        const dry = this.#dryGain
        for (let i = from; i < to; i++) {
            outL[i] = carL[i] * dry
            outR[i] = carR[i] * dry
        }

        const wet = this.#wetGain
        const bandG = VocoderDsp.BAND_GAIN
        const aCoeff = this.#attackCoeff
        const rCoeff = this.#releaseCoeff
        const fade = this.#fadeCoeff
        const upper = this.#processedBands
        const carC = this.#carrierCoeffs
        const modC = this.#modulatorCoeffs

        for (let i = 0; i < upper; i++) {
            const o = i * 5
            const cb0 = carC[o + 0], cb1 = carC[o + 1], cb2 = carC[o + 2]
            const ca1 = carC[o + 3], ca2 = carC[o + 4]
            const mb0 = modC[o + 0], mb1 = modC[o + 1], mb2 = modC[o + 2]
            const ma1 = modC[o + 3], ma2 = modC[o + 4]

            let cxL1 = this.#carCxL1[i], cxL2 = this.#carCxL2[i]
            let cyL1 = this.#carCyL1[i], cyL2 = this.#carCyL2[i]
            let cxR1 = this.#carCxR1[i], cxR2 = this.#carCxR2[i]
            let cyR1 = this.#carCyR1[i], cyR2 = this.#carCyR2[i]
            // Mono modulator: only L slots used.
            let mxL1 = this.#modMxL1[i], mxL2 = this.#modMxL2[i]
            let myL1 = this.#modMyL1[i], myL2 = this.#modMyL2[i]

            let env = this.#envelope[i]
            let gain = this.#bandGainCurrent[i]
            const tgt = this.#targetActive[i]

            for (let s = from; s < to; s++) {
                gain = tgt + fade * (gain - tgt)

                // Single modulator bandpass
                const mx = mod[s]
                const my = (mb0 * mx + mb1 * mxL1 + mb2 * mxL2 - ma1 * myL1 - ma2 * myL2) + 1e-18 - 1e-18
                mxL2 = mxL1; mxL1 = mx; myL2 = myL1; myL1 = my

                const peak = my < 0 ? -my : my
                env = env < peak
                    ? peak + aCoeff * (env - peak)
                    : peak + rCoeff * (env - peak)

                // Carrier bandpass (stereo)
                const cxL = carL[s]
                const cyL = (cb0 * cxL + cb1 * cxL1 + cb2 * cxL2 - ca1 * cyL1 - ca2 * cyL2) + 1e-18 - 1e-18
                cxL2 = cxL1; cxL1 = cxL; cyL2 = cyL1; cyL1 = cyL
                const cxR = carR[s]
                const cyR = (cb0 * cxR + cb1 * cxR1 + cb2 * cxR2 - ca1 * cyR1 - ca2 * cyR2) + 1e-18 - 1e-18
                cxR2 = cxR1; cxR1 = cxR; cyR2 = cyR1; cyR1 = cyR

                const k = env * bandG * wet * gain
                outL[s] += cyL * k
                outR[s] += cyR * k
            }

            this.#carCxL1[i] = cxL1; this.#carCxL2[i] = cxL2
            this.#carCyL1[i] = cyL1; this.#carCyL2[i] = cyL2
            this.#carCxR1[i] = cxR1; this.#carCxR2[i] = cxR2
            this.#carCyR1[i] = cyR1; this.#carCyR2[i] = cyR2
            this.#modMxL1[i] = mxL1; this.#modMxL2[i] = mxL2
            this.#modMyL1[i] = myL1; this.#modMyL2[i] = myL2
            this.#envelope[i] = env
            this.#bandGainCurrent[i] = gain
        }
    }

    #innerSelf(carL: Float32Array, carR: Float32Array,
               outL: Float32Array, outR: Float32Array,
               from: int, to: int): void {
        const dry = this.#dryGain
        for (let i = from; i < to; i++) {
            outL[i] = carL[i] * dry
            outR[i] = carR[i] * dry
        }

        const wet = this.#wetGain
        const bandG = VocoderDsp.BAND_GAIN
        const aCoeff = this.#attackCoeff
        const rCoeff = this.#releaseCoeff
        const fade = this.#fadeCoeff
        const upper = this.#processedBands
        const carC = this.#carrierCoeffs

        for (let i = 0; i < upper; i++) {
            const o = i * 5
            const cb0 = carC[o + 0], cb1 = carC[o + 1], cb2 = carC[o + 2]
            const ca1 = carC[o + 3], ca2 = carC[o + 4]

            let cxL1 = this.#carCxL1[i], cxL2 = this.#carCxL2[i]
            let cyL1 = this.#carCyL1[i], cyL2 = this.#carCyL2[i]
            let cxR1 = this.#carCxR1[i], cxR2 = this.#carCxR2[i]
            let cyR1 = this.#carCyR1[i], cyR2 = this.#carCyR2[i]

            let env = this.#envelope[i]
            let gain = this.#bandGainCurrent[i]
            const tgt = this.#targetActive[i]

            for (let s = from; s < to; s++) {
                gain = tgt + fade * (gain - tgt)

                // Carrier bandpass (stereo) — the envelope follows this directly.
                const cxL = carL[s]
                const cyL = (cb0 * cxL + cb1 * cxL1 + cb2 * cxL2 - ca1 * cyL1 - ca2 * cyL2) + 1e-18 - 1e-18
                cxL2 = cxL1; cxL1 = cxL; cyL2 = cyL1; cyL1 = cyL
                const cxR = carR[s]
                const cyR = (cb0 * cxR + cb1 * cxR1 + cb2 * cxR2 - ca1 * cyR1 - ca2 * cyR2) + 1e-18 - 1e-18
                cxR2 = cxR1; cxR1 = cxR; cyR2 = cyR1; cyR1 = cyR

                // Envelope follower on the band's own carrier energy — multi-band gate.
                const aL = cyL < 0 ? -cyL : cyL
                const aR = cyR < 0 ? -cyR : cyR
                const peak = aL > aR ? aL : aR
                env = env < peak
                    ? peak + aCoeff * (env - peak)
                    : peak + rCoeff * (env - peak)

                const k = env * bandG * wet * gain
                outL[s] += cyL * k
                outR[s] += cyR * k
            }

            this.#carCxL1[i] = cxL1; this.#carCxL2[i] = cxL2
            this.#carCyL1[i] = cyL1; this.#carCyL2[i] = cyL2
            this.#carCxR1[i] = cxR1; this.#carCxR2[i] = cxR2
            this.#carCyR1[i] = cyR1; this.#carCyR2[i] = cyR2
            this.#envelope[i] = env
            this.#bandGainCurrent[i] = gain
        }
    }
}
