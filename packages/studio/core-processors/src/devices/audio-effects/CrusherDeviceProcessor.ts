import {int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioEffectDeviceAdapter, CrusherDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {AudioBuffer, Crusher, StereoMatrix} from "@opendaw/lib-dsp"
import {AudioProcessor} from "../../AudioProcessor"

export class CrusherDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = CrusherDeviceProcessor.ID++

    readonly #adapter: CrusherDeviceBoxAdapter
    readonly #output: AudioBuffer
    readonly #dsp: Crusher
    readonly #peaks: PeakBroadcaster

    readonly parameterCrusherRate: AutomatableParameter<number>
    readonly parameterBitDepth: AutomatableParameter<number>
    readonly parameterBoost: AutomatableParameter<number>
    readonly parameterMix: AutomatableParameter<number>

    #source: Option<AudioBuffer> = Option.None

    constructor(context: EngineContext, adapter: CrusherDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#dsp = new Crusher(sampleRate)
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))

        const {crush, bits, boost, mix} = adapter.namedParameter
        this.parameterCrusherRate = this.own(this.bindParameter(crush))
        this.parameterBitDepth = this.own(this.bindParameter(bits))
        this.parameterBoost = this.own(this.bindParameter(boost))
        this.parameterMix = this.own(this.bindParameter(mix))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing)
        )
        this.readAllParameters()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#dsp.reset()
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
        this.#dsp.process(
            input.channels() as StereoMatrix.Channels,
            this.#output.channels() as StereoMatrix.Channels,
            fromIndex, toIndex)
        this.#peaks.process(
            this.#output.getChannel(0),
            this.#output.getChannel(1),
            fromIndex, toIndex)
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterCrusherRate) {
            this.#dsp.setCrush(1.0 - this.parameterCrusherRate.getValue())
        } else if (parameter === this.parameterBitDepth) {
            this.#dsp.setBitDepth(this.parameterBitDepth.getValue())
        } else if (parameter === this.parameterBoost) {
            this.#dsp.setBoost(this.parameterBoost.getValue())
        } else if (parameter === this.parameterMix) {
            this.#dsp.setMix(this.parameterMix.getValue())
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})`}
}