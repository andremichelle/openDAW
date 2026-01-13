import {EngineContext} from "./EngineContext"
import {AudioInput, Block, Processor} from "./processing"
import {Option, Terminable} from "@moises-ai/lib-std"
import {AuxSendBoxAdapter} from "@moises-ai/studio-adapters"
import {AudioBuffer, dbToGain, Ramp} from "@moises-ai/lib-dsp"
import {AutomatableParameter} from "./AutomatableParameter"
import {AudioProcessor} from "./AudioProcessor"

export class AuxSendProcessor extends AudioProcessor implements Processor, AudioInput {
    readonly #adapter: AuxSendBoxAdapter

    readonly #audioOutput: AudioBuffer
    readonly #rampGainL: Ramp<number>
    readonly #rampGainR: Ramp<number>

    readonly #parameterSendGain: AutomatableParameter<number>
    readonly #parameterSendPan: AutomatableParameter<number>

    #source: Option<AudioBuffer> = Option.None
    #needsUpdate: boolean = true
    #processing: boolean = false

    constructor(context: EngineContext, adapter: AuxSendBoxAdapter) {
        super(context)

        this.#adapter = adapter

        this.#audioOutput = new AudioBuffer()
        this.#rampGainL = Ramp.linear(sampleRate)
        this.#rampGainR = Ramp.linear(sampleRate)
        this.#parameterSendGain = this.own(this.bindParameter(adapter.sendGain))
        this.#parameterSendPan = this.own(this.bindParameter(adapter.sendPan))

        this.own(context.registerProcessor(this))
        this.readAllParameters()
    }

    reset(): void {this.#audioOutput.clear()}

    get adapter(): AuxSendBoxAdapter {return this.#adapter}

    setAudioSource(source: AudioBuffer): Terminable {
        this.#source = Option.wrap(source)
        return {terminate: () => this.#source = Option.None}
    }

    get audioOutput(): AudioBuffer {return this.#audioOutput}

    processAudio(_block: Block, fromIndex: number, toIndex: number): void {
        if (this.#source.isEmpty()) {return}
        if (this.#needsUpdate) {
            const gain = dbToGain(this.#parameterSendGain.getValue())
            const panning = this.#parameterSendPan.getValue()
            this.#rampGainL.set((1.0 - Math.max(0.0, panning)) * gain, this.#processing)
            this.#rampGainR.set((1.0 + Math.min(0.0, panning)) * gain, this.#processing)
            this.#needsUpdate = false
        }
        const outL = this.#audioOutput.getChannel(0)
        const outR = this.#audioOutput.getChannel(1)
        const source = this.#source.unwrap()
        const srcL = source.getChannel(0)
        const srcR = source.getChannel(1)
        if (this.#rampGainL.isInterpolating() || this.#rampGainR.isInterpolating()) {
            for (let i = fromIndex; i < toIndex; i++) {
                outL[i] = srcL[i] * this.#rampGainL.moveAndGet()
                outR[i] = srcR[i] * this.#rampGainR.moveAndGet()
            }
        } else {
            const gainL = this.#rampGainL.get()
            const gainR = this.#rampGainR.get()
            for (let i = fromIndex; i < toIndex; i++) {
                outL[i] = srcL[i] * gainL
                outR[i] = srcR[i] * gainR
            }
        }
        this.#processing = true
    }

    parameterChanged(_parameter: AutomatableParameter): void {
        this.#needsUpdate = true
    }
}