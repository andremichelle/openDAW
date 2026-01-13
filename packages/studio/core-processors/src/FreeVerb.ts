import {int, nextPowOf2} from "@moises-ai/lib-std"
import {AudioBuffer} from "@moises-ai/lib-dsp"

export class FreeVerb {
    roomSize: number
    damp: number
    predelayInSamples: int
    wetGain: number
    dryGain: number

    readonly #buf0 = new Float32Array(2048)
    readonly #buf1 = new Float32Array(2048)
    readonly #buf2 = new Float32Array(2048)
    readonly #buf3 = new Float32Array(2048)
    readonly #buf4 = new Float32Array(2048)
    readonly #buf5 = new Float32Array(2048)
    readonly #buf6 = new Float32Array(2048)
    readonly #buf7 = new Float32Array(2048)
    readonly #buf8 = new Float32Array(1024)
    readonly #buf9 = new Float32Array(512)
    readonly #buf10 = new Float32Array(512)
    readonly #buf11 = new Float32Array(256)
    readonly #buf12 = new Float32Array(2048)
    readonly #buf13 = new Float32Array(2048)
    readonly #buf14 = new Float32Array(2048)
    readonly #buf15 = new Float32Array(2048)
    readonly #buf16 = new Float32Array(2048)
    readonly #buf17 = new Float32Array(2048)
    readonly #buf18 = new Float32Array(2048)
    readonly #buf19 = new Float32Array(2048)
    readonly #buf20 = new Float32Array(1024)
    readonly #buf21 = new Float32Array(512)
    readonly #buf22 = new Float32Array(512)
    readonly #buf23 = new Float32Array(256)

    readonly #delaySize: int
    readonly #delayBuffer: Float32Array

    #v9_1: number = 0.0
    #v8_1: number = 0.0
    #v11_1: number = 0.0
    #v10_1: number = 0.0
    #v13_1: number = 0.0
    #v12_1: number = 0.0
    #v15_1: number = 0.0
    #v14_1: number = 0.0
    #v17_1: number = 0.0
    #v16_1: number = 0.0
    #v19_1: number = 0.0
    #v18_1: number = 0.0
    #v21_1: number = 0.0
    #v20_1: number = 0.0
    #v23_1: number = 0.0
    #v22_1: number = 0.0
    #v6_1: number = 0.0
    #v4_1: number = 0.0
    #v2_1: number = 0.0
    #v0_1: number = 0.0
    #v33_1: number = 0.0
    #v32_1: number = 0.0
    #v35_1: number = 0.0
    #v34_1: number = 0.0
    #v37_1: number = 0.0
    #v36_1: number = 0.0
    #v39_1: number = 0.0
    #v38_1: number = 0.0
    #v41_1: number = 0.0
    #v40_1: number = 0.0
    #v43_1: number = 0.0
    #v42_1: number = 0.0
    #v45_1: number = 0.0
    #v44_1: number = 0.0
    #v47_1: number = 0.0
    #v46_1: number = 0.0
    #v30_1: number = 0.0
    #v28_1: number = 0.0
    #v26_1: number = 0.0
    #v24_1: number = 0.0

    #index: int = 0
    #delayPosition: int = 0

    constructor(MaxPreDelaySec: number = 0.500) {
        this.#delaySize = nextPowOf2(Math.ceil(MaxPreDelaySec * sampleRate))
        this.#delayBuffer = new Float32Array(this.#delaySize << 1)

        this.damp = 0.
        this.roomSize = 0.5
        this.wetGain = 0.3333
        this.dryGain = 1.0 - this.wetGain
        this.#index = 0
        this.#delayPosition = 0
        this.predelayInSamples = 0.008 * sampleRate

        this.clearHistory()
    }

    clear(): void {
        this.#index = 0
        this.#delayPosition = 0

        this.clearHistory()
        this.clearBuffers()
    }

    process(outBuffer: AudioBuffer, inpBuffer: AudioBuffer, fromIndex: int, toIndex: int): void {
        const [inputL, inputR] = inpBuffer.channels()
        const [outputL, outputR] = outBuffer.channels()

        const p0 = (0.4 * this.damp)
        const p1 = (1.0 - p0)
        const p2 = (0.7 + (0.28 * this.roomSize))

        for (let i = fromIndex; i < toIndex; ++i) {
            const inpL = inputL[i]
            const inpR = inputR[i]

            let delayRead = this.#delayPosition - this.predelayInSamples
            if (delayRead < 0) delayRead += this.#delaySize

            let i2
            i2 = delayRead << 1
            const magic_gain = 0.01
            const readL = this.#delayBuffer[i2] * magic_gain
            const readR = this.#delayBuffer[i2 + 1] * magic_gain
            i2 = this.#delayPosition << 1
            this.#delayBuffer[i2] = inpL
            this.#delayBuffer[i2 + 1] = inpR
            this.#delayPosition = (this.#delayPosition + 1) & (this.#delaySize - 1)
            const p = this.#index & 2047
            this.#v9_1 = p1 * this.#v8_1 + p0 * this.#v9_1
            this.#buf0[p] = readL + p2 * this.#v9_1
            this.#v8_1 = this.#buf0[(this.#index - 1617) & 2047]
            this.#v11_1 = p1 * this.#v10_1 + p0 * this.#v11_1
            this.#buf1[p] = (readL + (p2 * this.#v11_1))
            this.#v10_1 = this.#buf1[(this.#index - 1557) & 2047]
            this.#v13_1 = p1 * this.#v12_1 + p0 * this.#v13_1
            this.#buf2[p] = readL + p2 * this.#v13_1
            this.#v12_1 = this.#buf2[(this.#index - 1491) & 2047]
            this.#v15_1 = p1 * this.#v14_1 + p0 * this.#v15_1
            this.#buf3[p] = readL + p2 * this.#v15_1
            this.#v14_1 = this.#buf3[(this.#index - 1422) & 2047]
            this.#v17_1 = p1 * this.#v16_1 + p0 * this.#v17_1
            this.#buf4[p] = readL + p2 * this.#v17_1
            this.#v16_1 = this.#buf4[(this.#index - 1356) & 2047]
            this.#v19_1 = p1 * this.#v18_1 + p0 * this.#v19_1
            this.#buf5[p] = readL + p2 * this.#v19_1
            this.#v18_1 = this.#buf5[(this.#index - 1277) & 2047]
            this.#v21_1 = p1 * this.#v20_1 + p0 * this.#v21_1
            this.#buf6[p] = readL + p2 * this.#v21_1
            this.#v20_1 = this.#buf6[(this.#index - 1188) & 2047]
            this.#v23_1 = p1 * this.#v22_1 + p0 * this.#v23_1
            this.#buf7[p] = readL + p2 * this.#v23_1
            this.#v22_1 = this.#buf7[(this.#index - 1116) & 2047]
            const lt0 = this.#v22_1 + this.#v20_1 + this.#v18_1 + this.#v16_1 + this.#v14_1 + this.#v12_1 + this.#v10_1 + this.#v8_1
            const lt1 = this.#v6_1 - lt0
            const lt2 = this.#v4_1 - lt1
            const lt3 = this.#v2_1 - lt2
            this.#buf8[this.#index & 1023] = lt0 + 0.5 * this.#v6_1
            this.#v6_1 = this.#buf8[(this.#index - 556) & 1023]
            this.#buf9[this.#index & 511] = lt1 + 0.5 * this.#v4_1
            this.#v4_1 = this.#buf9[(this.#index - 441) & 511]
            this.#buf10[this.#index & 511] = lt2 + 0.5 * this.#v2_1
            this.#v2_1 = this.#buf10[(this.#index - 341) & 511]
            this.#buf11[this.#index & 255] = lt3 + 0.5 * this.#v0_1
            this.#v0_1 = this.#buf11[(this.#index - 225) & 255]
            outputL[i] = this.dryGain * inpL + this.wetGain * (this.#v0_1 - lt3)
            this.#v33_1 = p1 * this.#v32_1 + p0 * this.#v33_1
            this.#buf12[p] = readR + p2 * this.#v33_1
            this.#v32_1 = this.#buf12[(this.#index - 1640) & 2047]
            this.#v35_1 = p1 * this.#v34_1 + p0 * this.#v35_1
            this.#buf13[p] = readR + p2 * this.#v35_1
            this.#v34_1 = this.#buf13[(this.#index - 1580) & 2047]
            this.#v37_1 = p1 * this.#v36_1 + p0 * this.#v37_1
            this.#buf14[p] = readR + p2 * this.#v37_1
            this.#v36_1 = this.#buf14[(this.#index - 1514) & 2047]
            this.#v39_1 = p1 * this.#v38_1 + p0 * this.#v39_1
            this.#buf15[p] = readR + p2 * this.#v39_1
            this.#v38_1 = this.#buf15[(this.#index - 1445) & 2047]
            this.#v41_1 = p1 * this.#v40_1 + p0 * this.#v41_1
            this.#buf16[p] = readR + p2 * this.#v41_1
            this.#v40_1 = this.#buf16[(this.#index - 1379) & 2047]
            this.#v43_1 = p1 * this.#v42_1 + p0 * this.#v43_1
            this.#buf17[p] = (readR + (p2 * this.#v43_1))
            this.#v42_1 = this.#buf17[(this.#index - 1300) & 2047]
            this.#v45_1 = p1 * this.#v44_1 + p0 * this.#v45_1
            this.#buf18[p] = readR + p2 * this.#v45_1
            this.#v44_1 = this.#buf18[(this.#index - 1211) & 2047]
            this.#v47_1 = p1 * this.#v46_1 + p0 * this.#v47_1
            this.#buf19[p] = readR + p2 * this.#v47_1
            this.#v46_1 = this.#buf19[(this.#index - 1139) & 2047]
            const rt0 = this.#v46_1 + this.#v44_1 + this.#v42_1 + this.#v40_1 + this.#v38_1 + this.#v36_1 + this.#v34_1 + this.#v32_1
            const rt1 = this.#v30_1 - rt0
            const rt2 = this.#v28_1 - rt1
            const rt3 = this.#v26_1 - rt2
            this.#buf20[this.#index & 1023] = rt0 + 0.5 * this.#v30_1
            this.#v30_1 = this.#buf20[(this.#index - 579) & 1023]
            this.#buf21[this.#index & 511] = rt1 + 0.5 * this.#v28_1
            this.#v28_1 = this.#buf21[(this.#index - 464) & 511]
            this.#buf22[this.#index & 511] = rt2 + 0.5 * this.#v26_1
            this.#v26_1 = this.#buf22[(this.#index - 364) & 511]
            this.#buf23[this.#index & 255] = rt3 + 0.5 * this.#v24_1
            this.#v24_1 = this.#buf23[(this.#index - 248) & 255]
            outputR[i] = this.dryGain * inpR + this.wetGain * (this.#v24_1 - rt3)
            this.#index++
        }
    }

    clearBuffers(): void {
        this.#buf0.fill(0.0)
        this.#buf1.fill(0.0)
        this.#buf2.fill(0.0)
        this.#buf3.fill(0.0)
        this.#buf4.fill(0.0)
        this.#buf5.fill(0.0)
        this.#buf6.fill(0.0)
        this.#buf7.fill(0.0)
        this.#buf8.fill(0.0)
        this.#buf9.fill(0.0)
        this.#buf10.fill(0.0)
        this.#buf11.fill(0.0)
        this.#buf12.fill(0.0)
        this.#buf13.fill(0.0)
        this.#buf14.fill(0.0)
        this.#buf15.fill(0.0)
        this.#buf16.fill(0.0)
        this.#buf17.fill(0.0)
        this.#buf18.fill(0.0)
        this.#buf19.fill(0.0)
        this.#buf20.fill(0.0)
        this.#buf21.fill(0.0)
        this.#buf22.fill(0.0)
        this.#buf23.fill(0.0)
        this.#delayBuffer.fill(0.0)
    }

    clearHistory() {
        this.#v9_1 = 0.0
        this.#v8_1 = 0.0
        this.#v11_1 = 0.0
        this.#v10_1 = 0.0
        this.#v13_1 = 0.0
        this.#v12_1 = 0.0
        this.#v15_1 = 0.0
        this.#v14_1 = 0.0
        this.#v17_1 = 0.0
        this.#v16_1 = 0.0
        this.#v19_1 = 0.0
        this.#v18_1 = 0.0
        this.#v21_1 = 0.0
        this.#v20_1 = 0.0
        this.#v23_1 = 0.0
        this.#v22_1 = 0.0
        this.#v6_1 = 0.0
        this.#v4_1 = 0.0
        this.#v2_1 = 0.0
        this.#v0_1 = 0.0
        this.#v33_1 = 0.0
        this.#v32_1 = 0.0
        this.#v35_1 = 0.0
        this.#v34_1 = 0.0
        this.#v37_1 = 0.0
        this.#v36_1 = 0.0
        this.#v39_1 = 0.0
        this.#v38_1 = 0.0
        this.#v41_1 = 0.0
        this.#v40_1 = 0.0
        this.#v43_1 = 0.0
        this.#v42_1 = 0.0
        this.#v45_1 = 0.0
        this.#v44_1 = 0.0
        this.#v47_1 = 0.0
        this.#v46_1 = 0.0
        this.#v30_1 = 0.0
        this.#v28_1 = 0.0
        this.#v26_1 = 0.0
        this.#v24_1 = 0.0
    }
}