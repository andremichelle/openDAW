import {assert, int, nextPowOf2, unitValue, ValueMapping} from "@opendaw/lib-std"
import {BiquadCoeff, BiquadMono, BiquadProcessor, StereoMatrix} from "@opendaw/lib-dsp"

export class DelayDeviceDsp {
    static readonly #FilterMapping: ValueMapping<number> = ValueMapping.exponential(20.0 / sampleRate, 20000.0 / sampleRate)

    readonly #delaySize: int
    readonly #delayBuffer: StereoMatrix.Channels
    readonly #biquad: [BiquadProcessor, BiquadProcessor]
    readonly #biquadCoeff: BiquadCoeff
    readonly #interpolationLength: int

    feedback: unitValue = 0.7
    cross: unitValue = 0.0
    wet: number = 0.75
    dry: number = 0.75

    #deltaOffset = 0.0
    #writePosition: int = 0 | 0
    #currentOffset: int = 0 | 0
    #targetOffset = 0.0
    #alphaPosition = 0 | 0
    #processed = false
    #interpolating = false

    constructor(maxFrames: int, interpolationLength: int) {
        const pow2Size = nextPowOf2(maxFrames)

        this.#delaySize = pow2Size
        this.#delayBuffer = [new Float32Array(pow2Size), new Float32Array(pow2Size)]
        this.#biquad = [new BiquadMono(), new BiquadMono()]
        this.#biquadCoeff = new BiquadCoeff()
        this.#interpolationLength = interpolationLength
    }

    reset(): void {
        this.#writePosition = 0
        if (this.#processed) {
            this.#biquad.forEach(biquad => biquad.reset())
            this.#delayBuffer.forEach(delay => delay.fill(0.0))
            this.#processed = false
            this.#interpolating = false
        }
        this.#initDelayTime()
    }

    set offset(value: number) {
        assert(0 <= value && value < this.#delaySize, "Out of bounds")
        if (this.#targetOffset === value) {return}
        this.#targetOffset = value
        if (this.#processed) {
            this.#updateDelayTime()
        } else {
            this.#initDelayTime()
        }
    }
    get offset(): number {return this.#targetOffset}

    set filter(value: number) {
        if (value === 0.0) {
            this.#biquadCoeff.identity()
        } else if (value > 0.0) {
            this.#biquadCoeff.setHighpassParams(DelayDeviceDsp.#FilterMapping.y(value))
        } else if (value < 0.0) {
            this.#biquadCoeff.setLowpassParams(DelayDeviceDsp.#FilterMapping.y(1.0 + value))
        }
    }

    process(input: StereoMatrix.Channels, output: StereoMatrix.Channels, fromIndex: int, toIndex: int): void {
        if (this.#interpolating) {
            this.#processInterpolate(input, output, fromIndex, toIndex)
        } else {
            this.#processSteady(input, output, fromIndex, toIndex)
        }
        this.#processed = true
    }

    #processSteady(input: StereoMatrix.Channels, output: StereoMatrix.Channels, fromIndex: int, toIndex: int): void {
        const delayMask = this.#delaySize - 1
        const delayBuffer = this.#delayBuffer
        const feedback = this.feedback
        const pWetLevel = this.wet
        const pDryLevel = this.dry
        let writePosition = this.#writePosition
        let readPosition: int = writePosition - Math.floor(this.#currentOffset)
        if (readPosition < 0) {readPosition += this.#delaySize}
        const iL = input[0]
        const iR = input[1]
        const oL = output[0]
        const oR = output[1]
        const bL = this.#biquad[0]
        const bR = this.#biquad[1]
        const dL = delayBuffer[0]
        const dR = delayBuffer[1]
        for (let i: int = fromIndex; i < toIndex; ++i) {
            const inpL = iL[i]
            const inpR = iR[i]
            // the magic number prevents filter from getting unstable (beginner's fix)
            const dReadL = bL.processFrame(this.#biquadCoeff, dL[readPosition] * 0.96)
            const dReadR = bR.processFrame(this.#biquadCoeff, dR[readPosition] * 0.96)
            const diff = this.cross * (dReadR - dReadL)
            const crossL = dReadL + diff
            const crossR = dReadR - diff
            dL[writePosition] = (inpL + crossL) * feedback + 1.0e-18 - 1.0e-18
            dR[writePosition] = (inpR + crossR) * feedback + 1.0e-18 - 1.0e-18
            oL[i] = crossL * pWetLevel + inpL * pDryLevel
            oR[i] = crossR * pWetLevel + inpR * pDryLevel
            readPosition = ++readPosition & delayMask
            writePosition = ++writePosition & delayMask
        }
        this.#writePosition = writePosition
    }

    #processInterpolate(input: StereoMatrix.Channels, output: StereoMatrix.Channels, fromIndex: int, toIndex: int): void {
        const delayMask = this.#delaySize - 1
        const delayBuffer = this.#delayBuffer
        const feedback = this.feedback
        const pWetLevel = this.wet
        const pDryLevel = this.dry
        let writePosition = this.#writePosition
        for (let i: int = fromIndex; i < toIndex; ++i) {
            if (0 < this.#alphaPosition) {
                this.#currentOffset += this.#deltaOffset
                this.#alphaPosition--
            } else {
                this.#currentOffset = this.#targetOffset
                this.#interpolating = false
            }
            let readPosition: int = writePosition - this.#currentOffset
            if (readPosition < 0) {
                readPosition += this.#delaySize
            }
            const readPositionInt = readPosition | 0
            const alpha = readPosition - readPositionInt
            const inpL = input[0][i]
            const inpR = input[1][i]
            const d00 = delayBuffer[0][readPositionInt]
            const d10 = delayBuffer[1][readPositionInt]
            const d0 = this.#biquad[0].processFrame(this.#biquadCoeff,
                (d00 + alpha * (delayBuffer[0][(readPositionInt + 1) & delayMask] - d00)) * 0.96)
            const d1 = this.#biquad[1].processFrame(this.#biquadCoeff,
                (d10 + alpha * (delayBuffer[1][(readPositionInt + 1) & delayMask] - d10)) * 0.96)
            delayBuffer[0][writePosition] = inpL + d0 * feedback + 1.0e-18 - 1.0e-18
            delayBuffer[1][writePosition] = inpR + d0 * feedback + 1.0e-18 - 1.0e-18
            output[0][i] = d0 * pWetLevel + inpL * pDryLevel
            output[1][i] = d1 * pWetLevel + inpR * pDryLevel
            writePosition = ++writePosition & delayMask
        }
        this.#writePosition = writePosition
    }

    #initDelayTime(): void {
        this.#currentOffset = this.#targetOffset
        this.#alphaPosition = 0
        this.#interpolating = false
    }

    #updateDelayTime(): void {
        if (this.#targetOffset !== this.#currentOffset) {
            this.#alphaPosition = this.#interpolationLength
            this.#deltaOffset = (this.#targetOffset - this.#currentOffset) / this.#alphaPosition
            this.#interpolating = true
        }
    }
}