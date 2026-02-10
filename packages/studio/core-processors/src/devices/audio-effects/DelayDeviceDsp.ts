import {bipolar, int, nextPowOf2, panic, unitValue, ValueMapping} from "@opendaw/lib-std"
import {BiquadCoeff, BiquadMono, BiquadProcessor, Delay, Smooth, StereoMatrix} from "@opendaw/lib-dsp"

const LIMITER_ATTACK_MS = 50.0
const LIMITER_RELEASE_MS = 250.0

export class DelayDeviceDsp {
    static readonly FilterMapping: ValueMapping<number> = ValueMapping.exponential(20.0 / sampleRate, 20000.0 / sampleRate)

    readonly #delaySize: int
    readonly #delayMask: int
    readonly #delayBuffer: StereoMatrix.Channels
    readonly #biquad: [BiquadProcessor, BiquadProcessor]
    readonly #biquadCoeff: BiquadCoeff
    readonly #interpolationLength: int

    readonly #preDelayL: Delay
    readonly #preDelayR: Delay
    readonly #preDelayBuf: [Float32Array, Float32Array]
    readonly #lfoDepthSmoother: Smooth
    readonly #envelopeAttack: number
    readonly #envelopeRelease: number

    #currentOffset: number = 0.0
    #delayLinePosition: int = 0 | 0
    #targetOffset: number = 0.0
    #deltaOffset: number = 0.0
    #alphaPosition: int = 0 | 0
    #envelope: number = 0.0
    feedback: unitValue = 0.5
    cross: unitValue = 0.0
    lfoPhaseIncr: number = 0.0
    #lfoPhase: number = 0.0
    lfoDepth: number = 0.0
    wet: number = 0.75
    dry: number = 0.75
    #processed: boolean = false

    constructor(maxFrames: int) {
        const pow2Size = nextPowOf2(maxFrames)

        this.#delaySize = pow2Size
        this.#delayMask = pow2Size - 1
        this.#delayBuffer = [new Float32Array(pow2Size), new Float32Array(pow2Size)]
        this.#biquad = [new BiquadMono(), new BiquadMono()]
        this.#biquadCoeff = new BiquadCoeff()
        this.#interpolationLength = Math.floor(0.250 * sampleRate)
        this.#preDelayL = new Delay(maxFrames, this.#interpolationLength)
        this.#preDelayR = new Delay(maxFrames, this.#interpolationLength)
        this.#preDelayBuf = [new Float32Array(128), new Float32Array(128)]
        this.#lfoDepthSmoother = new Smooth(0.003, sampleRate)
        this.#envelopeAttack = Math.exp(-1.0 / (sampleRate * LIMITER_ATTACK_MS))
        this.#envelopeRelease = Math.exp(-1.0 / (sampleRate * LIMITER_RELEASE_MS))
    }

    reset(): void {
        this.#delayLinePosition = 0
        this.#preDelayL.clear()
        this.#preDelayR.clear()
        if (this.#processed) {
            this.#biquad.forEach(biquad => biquad.reset())
            this.#delayBuffer.forEach(delay => delay.fill(0.0))
            this.#processed = false
            this.#envelope = 0.0
            this.#lfoPhase = 0.0
        }
        this.#initDelayTime()
    }

    set preDelayLeftOffset(value: number) {
        this.#preDelayL.offset = Math.max(0, Math.min(value, this.#delaySize - 1))
    }

    set preDelayRightOffset(value: number) {
        this.#preDelayR.offset = Math.max(0, Math.min(value, this.#delaySize - 1))
    }

    set offset(value: number) {
        if (value < 0 || value >= this.#delaySize) {
            panic(`DelayDeviceDsp offset ${value} out of bounds [0, ${this.#delaySize})`)
        }
        if (this.#targetOffset === value) {return}
        this.#targetOffset = value
        if (this.#processed) {
            this.#updateDelayTime()
        } else {
            this.#initDelayTime()
        }
    }
    get offset(): number {return this.#targetOffset}

    set filter(value: bipolar) {
        if (value === 0.0) {
            this.#biquadCoeff.identity()
        } else if (value > 0.0) {
            this.#biquadCoeff.setHighpassParams(DelayDeviceDsp.FilterMapping.y(value))
        } else if (value < 0.0) {
            this.#biquadCoeff.setLowpassParams(DelayDeviceDsp.FilterMapping.y(1.0 + value))
        }
    }

    setLfoDepth(value: number): void {this.lfoDepth = value}

    process(input: StereoMatrix.Channels, output: StereoMatrix.Channels, fromIndex: int, toIndex: int): void {
        const iL = input[0]
        const iR = input[1]
        const oL = output[0]
        const oR = output[1]

        this.#preDelayL.process(this.#preDelayBuf[0], iL, fromIndex, toIndex)
        this.#preDelayR.process(this.#preDelayBuf[1], iR, fromIndex, toIndex)

        const cross = this.cross
        const pass = 1.0 - cross

        const delayMask = this.#delayMask
        const delaySize = this.#delaySize
        const feedback = this.feedback
        const pWetLevel = this.wet
        const pDryLevel = this.dry
        const biquadCoeff = this.#biquadCoeff
        const [biquadL, biquadR] = this.#biquad
        const [delayBufL, delayBufR] = this.#delayBuffer
        const [preDelayBufL, preDelayBufR] = this.#preDelayBuf

        for (let i = fromIndex; i < toIndex; ++i) {
            if (this.#alphaPosition > 0) {
                this.#currentOffset += this.#deltaOffset
                this.#alphaPosition--
            } else {
                this.#currentOffset = this.#targetOffset
            }
            const lfoDepth = this.#lfoDepthSmoother.process(this.lfoDepth)
            const lfoValue = 2.0 * Math.abs(this.#lfoPhase - 0.5) * lfoDepth
            this.#lfoPhase += this.lfoPhaseIncr
            if (this.#lfoPhase >= 1.0) {
                this.#lfoPhase -= 1.0
            }
            let readFloat = this.#delayLinePosition - (this.#currentOffset + lfoDepth - lfoValue)
            if (readFloat < 0.0) {readFloat += delaySize}
            const readInt0 = readFloat | 0
            const readInt1 = (readInt0 + 1) & delayMask
            const alpha = readFloat - readInt0
            const l0 = delayBufL[readInt0 & delayMask]
            const r0 = delayBufR[readInt0 & delayMask]
            let readDelayL = l0 + alpha * (delayBufL[readInt1] - l0)
            let readDelayR = r0 + alpha * (delayBufR[readInt1] - r0)
            const abs = Math.max(Math.abs(readDelayL), Math.abs(readDelayR))
            this.#envelope = abs > this.#envelope
                ? this.#envelopeAttack * (this.#envelope - abs) + abs
                : this.#envelopeRelease * (this.#envelope - abs) + abs
            if (this.#envelope > 1.0) {
                readDelayL /= this.#envelope
                readDelayR /= this.#envelope
            }
            const processedL = biquadL.processFrame(biquadCoeff, (readDelayL * pass + readDelayR * cross) * 0.96)
            const processedR = biquadR.processFrame(biquadCoeff, (readDelayR * pass + readDelayL * cross) * 0.96)
            delayBufL[this.#delayLinePosition] = preDelayBufL[i] + processedL * feedback + 1.0e-18 - 1.0e-18
            delayBufR[this.#delayLinePosition] = preDelayBufR[i] + processedR * feedback + 1.0e-18 - 1.0e-18
            oL[i] = iL[i] * pDryLevel + processedL * pWetLevel
            oR[i] = iR[i] * pDryLevel + processedR * pWetLevel
            this.#delayLinePosition = (this.#delayLinePosition + 1) & delayMask
            delayBufL[this.#delayLinePosition] = 0.0
            delayBufR[this.#delayLinePosition] = 0.0
        }
        this.#processed = true
    }

    #initDelayTime(): void {
        this.#currentOffset = this.#targetOffset
        this.#alphaPosition = 0
    }

    #updateDelayTime(): void {
        if (this.#targetOffset !== this.#currentOffset) {
            this.#alphaPosition = this.#interpolationLength
            this.#deltaOffset = (this.#targetOffset - this.#currentOffset) / this.#alphaPosition
        }
    }
}