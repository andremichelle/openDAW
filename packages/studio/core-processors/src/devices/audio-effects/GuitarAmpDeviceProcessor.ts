import {int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioEffectDeviceAdapter, GuitarAmpDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {AudioBuffer, TimeDomainConvolver, FrequencyDomainConvolver, dbToGain, RenderQuantum} from "@opendaw/lib-dsp"
import {AudioProcessor} from "../../AudioProcessor"

export class GuitarAmpDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = GuitarAmpDeviceProcessor.ID++
    readonly #adapter: GuitarAmpDeviceBoxAdapter
    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #timeDomainL: TimeDomainConvolver
    readonly #timeDomainR: TimeDomainConvolver
    readonly #freqDomainL: FrequencyDomainConvolver
    readonly #freqDomainR: FrequencyDomainConvolver
    readonly #ir: Float32Array

    readonly parameterMix: AutomatableParameter<number>
    readonly parameterOutput: AutomatableParameter<number>

    #source: Option<AudioBuffer> = Option.None
    #mix: number = 1.0
    #outputGain: number = 1.0
    #lowLatency: boolean = true

    constructor(context: EngineContext, adapter: GuitarAmpDeviceBoxAdapter) {
        super(context)
        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#ir = this.#createSyntheticIR()
        this.#timeDomainL = new TimeDomainConvolver(2048)
        this.#timeDomainR = new TimeDomainConvolver(2048)
        this.#freqDomainL = new FrequencyDomainConvolver(2048, RenderQuantum)
        this.#freqDomainR = new FrequencyDomainConvolver(2048, RenderQuantum)
        this.#timeDomainL.setImpulseResponse(this.#ir)
        this.#timeDomainR.setImpulseResponse(this.#ir)
        this.#freqDomainL.setImpulseResponse(this.#ir)
        this.#freqDomainR.setImpulseResponse(this.#ir)
        const {mix, output} = adapter.namedParameter
        this.parameterMix = this.own(this.bindParameter(mix))
        this.parameterOutput = this.own(this.bindParameter(output))
        this.own(adapter.lowLatency.catchupAndSubscribe(owner => {
            this.#lowLatency = owner.getValue()
            this.#clearConvolvers()
        }))
        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing)
        )
        this.readAllParameters()
    }

    #createSyntheticIR(): Float32Array {
        const sampleRate = 48000
        const length = 512
        const ir = new Float32Array(length)
        const cutoffHz = 4500.0
        const resonanceHz = 3200.0
        const resonanceQ = 8.0
        const normalized = cutoffHz / sampleRate
        const halfLength = Math.floor(length / 2)
        for (let i = 0; i < length; i++) {
            const n = i - halfLength
            if (n === 0) {
                ir[i] = 2.0 * normalized
            } else {
                const x = 2.0 * Math.PI * normalized * n
                ir[i] = Math.sin(x) / (Math.PI * n)
            }
            const window = 0.54 - 0.46 * Math.cos((2.0 * Math.PI * i) / (length - 1))
            ir[i] *= window
        }
        const omega = (2.0 * Math.PI * resonanceHz) / sampleRate
        for (let i = 0; i < length; i++) {
            const resonance = Math.sin(omega * i) * Math.exp(-i / (sampleRate / resonanceHz / resonanceQ)) * 0.3
            ir[i] += resonance
        }
        let sum = 0.0
        for (let i = 0; i < length; i++) {
            sum += ir[i]
        }
        if (Math.abs(sum) > 0.0) {
            for (let i = 0; i < length; i++) {
                ir[i] /= sum
            }
        }
        return ir
    }

    #clearConvolvers(): void {
        this.#timeDomainL.clear()
        this.#timeDomainR.clear()
        this.#freqDomainL.clear()
        this.#freqDomainR.clear()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#clearConvolvers()
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
        const input = this.#source.unwrap()
        const inL = input.getChannel(0)
        const inR = input.getChannel(1)
        const outL = this.#output.getChannel(0)
        const outR = this.#output.getChannel(1)
        if (this.#lowLatency) {
            this.#timeDomainL.process(inL, outL, fromIndex, toIndex)
            this.#timeDomainR.process(inR, outR, fromIndex, toIndex)
        } else {
            this.#freqDomainL.process(inL, outL, fromIndex, toIndex)
            this.#freqDomainR.process(inR, outR, fromIndex, toIndex)
        }
        const mix = this.#mix
        const dry = 1.0 - mix
        const gain = this.#outputGain
        for (let i = fromIndex; i < toIndex; i++) {
            outL[i] = (dry * inL[i] + mix * outL[i]) * gain
            outR[i] = (dry * inR[i] + mix * outR[i]) * gain
        }
        this.#peaks.process(outL, outR, fromIndex, toIndex)
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterMix) {
            this.#mix = this.parameterMix.getValue()
        } else if (parameter === this.parameterOutput) {
            this.#outputGain = dbToGain(this.parameterOutput.getValue())
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})`}
}
