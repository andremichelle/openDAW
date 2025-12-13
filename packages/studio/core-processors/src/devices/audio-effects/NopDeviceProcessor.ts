import {int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioEffectDeviceAdapter} from "@opendaw/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {ProcessInfo, Processor} from "../../processing"
import {AbstractProcessor} from "../../AbstractProcessor"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {AudioBuffer, RenderQuantum} from "@opendaw/lib-dsp"

export class NopDeviceProcessor extends AbstractProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = NopDeviceProcessor.ID++

    readonly #adapter: AudioEffectDeviceAdapter
    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster

    #source: Option<AudioBuffer> = Option.None

    constructor(context: EngineContext, adapter: AudioEffectDeviceAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing)
        )
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
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

    process(_processInfo: ProcessInfo): void {
        if (this.#source.isEmpty()) {return}
        const input = this.#source.unwrap()
        const [inpL, inpR] = input.channels()
        const [outL, outR] = this.#output.channels()
        for (let i = 0; i < RenderQuantum; i++) {
            outL[i] = inpL[i]
            outR[i] = inpR[i]
        }
        this.#peaks.process(outL, outR)
    }

    parameterChanged(_parameter: AutomatableParameter): void {}

    toString(): string {return `{${this.constructor.name} (${this.#id})`}
}