import {SampleEffect} from "./sample-effect"

const CombTunings: ReadonlyArray<number> = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const AllpassTunings: ReadonlyArray<number> = [556, 441, 341, 225]
const StereoSpread = 23
const InputGain = 0.015

class Comb {
    readonly #buffer: Float32Array
    #position: number = 0
    #store: number = 0.0

    constructor(length: number) {this.#buffer = new Float32Array(length)}

    process(input: number, feedback: number, damping: number): number {
        const output = this.#buffer[this.#position]
        this.#store = output * (1.0 - damping) + this.#store * damping
        this.#buffer[this.#position] = input + this.#store * feedback
        if (++this.#position === this.#buffer.length) {this.#position = 0}
        return output
    }
}

class Allpass {
    readonly #buffer: Float32Array
    #position: number = 0

    constructor(length: number) {this.#buffer = new Float32Array(length)}

    process(input: number): number {
        const buffered = this.#buffer[this.#position]
        this.#buffer[this.#position] = input + buffered * 0.5
        if (++this.#position === this.#buffer.length) {this.#position = 0}
        return buffered - input
    }
}

export const Reverb: SampleEffect = {
    id: "reverb",
    name: "Reverb",
    parameters: [
        {name: "Room Size", min: 0, max: 100, defaultValue: 70, unit: "%"},
        {name: "Damping", min: 0, max: 100, defaultValue: 40, unit: "%"},
        {name: "Mix", min: 0, max: 100, defaultValue: 30, unit: "%"}
    ],
    wholeSample: false,
    accepts: SampleEffect.acceptsAny,
    process: (source, [roomPercent, dampingPercent, mixPercent], progress) => {
        const scale = source.sampleRate / 44100
        const feedback = roomPercent * 0.01 * 0.28 + 0.7
        const damping = dampingPercent * 0.01 * 0.4
        const wet = mixPercent * 0.01
        const dry = 1.0 - wet
        return SampleEffect.mapChannels(source, progress, (input, output, channel) => {
            const spread = channel * StereoSpread
            const combs = CombTunings.map(tuning => new Comb(Math.round((tuning + spread) * scale)))
            const allpasses = AllpassTunings.map(tuning => new Allpass(Math.round((tuning + spread) * scale)))
            for (let index = 0; index < input.length; index++) {
                const x = input[index]
                let sum = 0.0
                for (const comb of combs) {sum += comb.process(x * InputGain, feedback, damping)}
                for (const allpass of allpasses) {sum = allpass.process(sum)}
                output[index] = x * dry + sum * wet
            }
        })
    }
}
