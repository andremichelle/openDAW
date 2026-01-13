import {RenderQuantum} from "@moises-ai/lib-dsp"
import {Communicator, Messenger} from "@moises-ai/lib-runtime"
import {Protocol} from "./protocol"
import {Waveform} from "./waveform"
import {Oscillator} from "./oscillator"

registerProcessor("proc-osc-polyblip", class ProcOscPolyblip extends AudioWorkletProcessor {
    readonly #oscillator: Oscillator

    constructor() {
        super()

        this.#oscillator = new Oscillator(sampleRate)

        Communicator.executor<Protocol>(Messenger.for(this.port), {
            setWaveform: (value: Waveform) => this.#oscillator.setWaveform(value),
            setFrequency: (value: number) => this.#oscillator.setFrequency(value)
        })
    }

    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        const [[mono]] = outputs
        for (let i = 0; i < RenderQuantum; i++) {
            mono[i] = this.#oscillator.process()
        }
        return true
    }
})