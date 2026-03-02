import {int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioEffectDeviceAdapter, WaveshaperDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {AudioBuffer, dbToGain, Ramp, Waveshaper} from "@opendaw/lib-dsp"
import {AudioProcessor} from "../../AudioProcessor"

export class WaveshaperDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = WaveshaperDeviceProcessor.ID++

    readonly #adapter: WaveshaperDeviceBoxAdapter
    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster

    readonly parameterInputGain: AutomatableParameter<number>
    readonly parameterOutputGain: AutomatableParameter<number>
    readonly parameterMix: AutomatableParameter<number>

    #source: Option<AudioBuffer> = Option.None
    #processed: boolean = false
    #equation: Waveshaper.Equation = "tanh"
    #smoothInputGain: Ramp<number>
    #smoothOutputGain: Ramp<number>
    #smoothMix: Ramp<number>

    constructor(context: EngineContext, adapter: WaveshaperDeviceBoxAdapter) {
        super(context)
        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        const {inputGain, outputGain, mix} = adapter.namedParameter
        this.parameterInputGain = this.own(this.bindParameter(inputGain))
        this.parameterOutputGain = this.own(this.bindParameter(outputGain))
        this.parameterMix = this.own(this.bindParameter(mix))
        this.#smoothInputGain = Ramp.linear(sampleRate)
        this.#smoothOutputGain = Ramp.linear(sampleRate)
        this.#smoothMix = Ramp.linear(sampleRate)
        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing),
            adapter.box.equation.catchupAndSubscribe(owner => {
                const value = owner.getValue()
                this.#equation = value === "" ? "tanh" : value as Waveshaper.Equation
            })
        )
        this.readAllParameters()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#processed = false
        this.#peaks.clear()
        this.#output.clear()
        this.eventInput.clear()
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get audioOutput(): AudioBuffer {return this.#output}

    setAudioSource(source: AudioBuffer): Terminable {
        this.#source = Option.wrap(source)
        return {terminate: () => this.#source = Option.None}
    }

    index(): int {return this.#adapter.indexField.getValue()}
    adapter(): AudioEffectDeviceAdapter {return this.#adapter}

    processAudio(_block: Block, fromIndex: int, toIndex: int): void {
        if (this.#source.isEmpty()) {return}
        const source = this.#source.unwrap()
        const srcL = source.getChannel(0)
        const srcR = source.getChannel(1)
        const outL = this.#output.getChannel(0)
        const outR = this.#output.getChannel(1)
        for (let i = fromIndex; i < toIndex; i++) {
            outL[i] = srcL[i]
            outR[i] = srcR[i]
        }
        for (let i = fromIndex; i < toIndex; i++) {
            const gain = this.#smoothInputGain.moveAndGet()
            outL[i] *= gain
            outR[i] *= gain
        }
        Waveshaper.process(this.#output.channels() as [Float32Array, Float32Array], this.#equation, fromIndex, toIndex)
        for (let i = fromIndex; i < toIndex; i++) {
            const gain = this.#smoothOutputGain.moveAndGet()
            const wet = this.#smoothMix.moveAndGet()
            const dry = 1.0 - wet
            outL[i] = srcL[i] * dry + outL[i] * gain * wet
            outR[i] = srcR[i] * dry + outR[i] * gain * wet
        }
        this.#peaks.process(outL, outR, fromIndex, toIndex)
        this.#processed = true
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterInputGain) {
            this.#smoothInputGain.set(dbToGain(this.parameterInputGain.getValue()), this.#processed)
        } else if (parameter === this.parameterOutputGain) {
            this.#smoothOutputGain.set(dbToGain(this.parameterOutputGain.getValue()), this.#processed)
        } else if (parameter === this.parameterMix) {
            this.#smoothMix.set(this.parameterMix.getValue(), this.#processed)
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})`}
}
