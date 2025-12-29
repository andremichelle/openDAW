const TAU = 2.0 * Math.PI
const PI = Math.PI

const DefaultCarrierFrequency = 10000.0
const DefaultModulationIndex = 5.0
const DefaultFrequencyOffset = 0.0
const DefaultOffsetRange = 500.0
const DefaultNoiseAmount = 0.8
const IQLowpassCutoff = 5000.0
const DCBlockCutoff = 20.0

class FMRadioProcessor extends AudioWorkletProcessor {
    readonly #invSampleRate: number
    readonly #iqLowpassCoeff: number
    readonly #dcBlockCoeff: number

    #carrierPhase = 0.0
    #loPhase = 0.0
    #modIntegral = 0.0
    #iState = 0.0
    #qState = 0.0
    #prevPhase = 0.0
    #dcState = 0.0
    #dcPrev = 0.0
    #lfsr = 1

    constructor() {
        super()
        this.#invSampleRate = 1.0 / sampleRate
        this.#iqLowpassCoeff = Math.exp(-TAU * IQLowpassCutoff * this.#invSampleRate)
        this.#dcBlockCoeff = 1.0 - (TAU * DCBlockCutoff * this.#invSampleRate)
    }

    static get parameterDescriptors() {
        return [
            {name: "frequencyOffset", defaultValue: DefaultFrequencyOffset, minValue: 0.0, maxValue: 1.0, automationRate: "k-rate"},
            {name: "carrierFrequency", defaultValue: DefaultCarrierFrequency, minValue: 1000.0, maxValue: 20000.0, automationRate: "k-rate"},
            {name: "modulationIndex", defaultValue: DefaultModulationIndex, minValue: 0.1, maxValue: 20.0, automationRate: "k-rate"},
            {name: "offsetRange", defaultValue: DefaultOffsetRange, minValue: 10.0, maxValue: 2000.0, automationRate: "k-rate"},
            {name: "noiseAmount", defaultValue: DefaultNoiseAmount, minValue: 0.0, maxValue: 1.0, automationRate: "k-rate"}
        ]
    }

    #noise(): number {
        const bit = this.#lfsr & 1
        this.#lfsr >>>= 1
        if (bit) {this.#lfsr ^= 0xB400}
        return (this.#lfsr / 0x7FFF) * 2.0 - 1.0
    }

    #wrapPhase(p: number): number {
        while (p > PI) {p -= TAU}
        while (p < -PI) {p += TAU}
        return p
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
        const input = inputs[0]?.[0]
        const outL = outputs[0]?.[0]
        const outR = outputs[0]?.[1]
        if (!input || !outL) {return true}

        const offset = parameters.frequencyOffset[0]
        const carrierFreq = parameters.carrierFrequency[0]
        const modIndex = parameters.modulationIndex[0]
        const offsetRange = parameters.offsetRange[0]
        const noiseAmt = parameters.noiseAmount[0]

        const loFreq = carrierFreq + offset * offsetRange
        const carrierInc = TAU * carrierFreq * this.#invSampleRate
        const loInc = TAU * loFreq * this.#invSampleRate
        const noiseLevel = offset * noiseAmt
        const demodGain = 1.0 / modIndex

        for (let i = 0; i < input.length; i++) {
            const inp = input[i]

            // FM modulation: phase = carrier + modIndex * integral(input)
            this.#modIntegral += inp
            const fmSignal = Math.cos(this.#carrierPhase + modIndex * this.#modIntegral)

            this.#carrierPhase += carrierInc
            if (this.#carrierPhase > TAU) {
                this.#carrierPhase -= TAU
                this.#modIntegral = 0.0 // reset to prevent overflow
            }

            // I/Q demodulation
            const iMix = fmSignal * Math.cos(this.#loPhase)
            const qMix = fmSignal * Math.sin(this.#loPhase)

            this.#loPhase += loInc
            if (this.#loPhase > TAU) {this.#loPhase -= TAU}

            // Lowpass I/Q
            this.#iState = iMix + this.#iqLowpassCoeff * (this.#iState - iMix)
            this.#qState = qMix + this.#iqLowpassCoeff * (this.#qState - qMix)

            // Phase detection and differentiation
            const phase = Math.atan2(this.#qState, this.#iState)
            let phaseDiff = this.#wrapPhase(phase - this.#prevPhase)
            this.#prevPhase = phase

            // Demodulated = phaseDiff / modIndex (recovers original signal)
            let demod = phaseDiff * demodGain

            // DC block
            const dc = demod - this.#dcPrev + this.#dcBlockCoeff * this.#dcState
            this.#dcPrev = demod
            this.#dcState = dc
            demod = dc

            // Add noise
            const out = demod + this.#noise() * noiseLevel

            outL[i] = out
            if (outR) {outR[i] = out}
        }
        return true
    }
}

registerProcessor("fm-radio-processor", FMRadioProcessor)
