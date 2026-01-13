import {int, Option, Terminable, UUID} from "@moises-ai/lib-std"
import {AudioBuffer, dbToGain} from "@moises-ai/lib-dsp"
import {AudioEffectDeviceAdapter, ReverbDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {FreeVerb} from "../../FreeVerb"
import {AudioProcessor} from "../../AudioProcessor"
import {AutomatableParameter} from "../../AutomatableParameter"
import {Processor} from "../../processing"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"

export class ReverbDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = ReverbDeviceProcessor.ID++

    readonly #adapter: ReverbDeviceBoxAdapter
    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #reverb: FreeVerb
    readonly #parameterDecay: AutomatableParameter<number>
    readonly #parameterPreDelay: AutomatableParameter<number>
    readonly #parameterDamp: AutomatableParameter<number>
    readonly #parameterWet: AutomatableParameter<number>
    readonly #parameterDry: AutomatableParameter<number>

    #source: Option<AudioBuffer> = Option.None

    constructor(context: EngineContext, adapter: ReverbDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#reverb = new FreeVerb()

        const {decay, preDelay, damp, wet, dry} = this.#adapter.namedParameter
        this.#parameterDecay = this.own(this.bindParameter(decay))
        this.#parameterPreDelay = this.own(this.bindParameter(preDelay))
        this.#parameterDamp = this.own(this.bindParameter(damp))
        this.#parameterWet = this.own(this.bindParameter(wet))
        this.#parameterDry = this.own(this.bindParameter(dry))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing)
        )
        this.readAllParameters()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#peaks.clear()
        this.#reverb.clear()
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

    processAudio(_block: Readonly<{}>, fromIndex: number, toIndex: number) {
        if (this.#source.isEmpty()) {return}
        this.#reverb.process(this.#output, this.#source.unwrap(), fromIndex, toIndex)
        const [outL, outR] = this.#output.channels()
        this.#peaks.process(outL, outR, fromIndex, toIndex)
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (this.#parameterDecay === parameter) {
            this.#reverb.roomSize = this.#parameterDecay.getValue()
        } else if (this.#parameterPreDelay === parameter) {
            this.#reverb.predelayInSamples = Math.ceil(this.#parameterPreDelay.getValue() * sampleRate)
        } else if (this.#parameterDamp === parameter) {
            this.#reverb.damp = this.#parameterDamp.getValue()
        } else if (this.#parameterWet === parameter) {
            this.#reverb.wetGain = dbToGain(this.#parameterWet.getValue())
        } else if (this.#parameterDry === parameter) {
            this.#reverb.dryGain = dbToGain(this.#parameterDry.getValue())
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})`}
}