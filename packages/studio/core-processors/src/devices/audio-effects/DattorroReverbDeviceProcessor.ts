import {AudioEffectDeviceAdapter, DattorroReverbDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {int, Option, Terminable, UUID} from "@moises-ai/lib-std"
import {AudioBuffer, dbToGain, Event, StereoMatrix} from "@moises-ai/lib-dsp"
import {EngineContext} from "../../EngineContext"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AudioProcessor} from "../../AudioProcessor"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {DattorroReverbDsp} from "./DattorroReverbDsp"

export class DattorroReverbDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = DattorroReverbDeviceProcessor.ID++

    readonly #adapter: DattorroReverbDeviceBoxAdapter

    readonly parameterPreDelay: AutomatableParameter<number>
    readonly parameterBandwidth: AutomatableParameter<number>
    readonly parameterInputDiffusion1: AutomatableParameter<number>
    readonly parameterInputDiffusion2: AutomatableParameter<number>
    readonly parameterDecay: AutomatableParameter<number>
    readonly parameterDecayDiffusion1: AutomatableParameter<number>
    readonly parameterDecayDiffusion2: AutomatableParameter<number>
    readonly parameterDamping: AutomatableParameter<number>
    readonly parameterExcursionRate: AutomatableParameter<number>
    readonly parameterExcursionDepth: AutomatableParameter<number>
    readonly parameterWet: AutomatableParameter<number>
    readonly parameterDry: AutomatableParameter<number>

    readonly #dsp: DattorroReverbDsp

    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster

    #source: Option<AudioBuffer> = Option.None

    constructor(context: EngineContext, adapter: DattorroReverbDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#dsp = new DattorroReverbDsp(sampleRate)

        const {
            preDelay, bandwidth, inputDiffusion1, inputDiffusion2, decay,
            decayDiffusion1, decayDiffusion2, damping, excursionRate, excursionDepth,
            wet, dry
        } = adapter.namedParameter
        this.parameterPreDelay = this.own(this.bindParameter(preDelay))
        this.parameterBandwidth = this.own(this.bindParameter(bandwidth))
        this.parameterInputDiffusion1 = this.own(this.bindParameter(inputDiffusion1))
        this.parameterInputDiffusion2 = this.own(this.bindParameter(inputDiffusion2))
        this.parameterDecay = this.own(this.bindParameter(decay))
        this.parameterDecayDiffusion1 = this.own(this.bindParameter(decayDiffusion1))
        this.parameterDecayDiffusion2 = this.own(this.bindParameter(decayDiffusion2))
        this.parameterDamping = this.own(this.bindParameter(damping))
        this.parameterExcursionRate = this.own(this.bindParameter(excursionRate))
        this.parameterExcursionDepth = this.own(this.bindParameter(excursionDepth))
        this.parameterWet = this.own(this.bindParameter(wet))
        this.parameterDry = this.own(this.bindParameter(dry))

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
        this.#output.clear()
        this.#peaks.clear()
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

    handleEvent(_event: Event): void {}

    processAudio(_block: Block, from: number, to: number): void {
        if (this.#source.isEmpty()) {return}
        const source = this.#source.unwrap()
        this.#dsp.process(source.channels() as StereoMatrix.Channels, this.#output.channels() as StereoMatrix.Channels, from, to)
        this.#peaks.process(this.#output.getChannel(0), this.#output.getChannel(1), from, to)
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterPreDelay) {
            this.#dsp.preDelayMs = this.parameterPreDelay.getValue()
        } else if (parameter === this.parameterBandwidth) {
            this.#dsp.bandwidth = this.parameterBandwidth.getValue()
        } else if (parameter === this.parameterInputDiffusion1) {
            this.#dsp.inputDiffusion1 = this.parameterInputDiffusion1.getValue()
        } else if (parameter === this.parameterInputDiffusion2) {
            this.#dsp.inputDiffusion2 = this.parameterInputDiffusion2.getValue()
        } else if (parameter === this.parameterDecay) {
            this.#dsp.decay = this.parameterDecay.getValue()
        } else if (parameter === this.parameterDecayDiffusion1) {
            this.#dsp.decayDiffusion1 = this.parameterDecayDiffusion1.getValue()
        } else if (parameter === this.parameterDecayDiffusion2) {
            this.#dsp.decayDiffusion2 = this.parameterDecayDiffusion2.getValue()
        } else if (parameter === this.parameterDamping) {
            this.#dsp.damping = this.parameterDamping.getValue()
        } else if (parameter === this.parameterExcursionRate) {
            this.#dsp.excursionRate = this.parameterExcursionRate.getValue()
        } else if (parameter === this.parameterExcursionDepth) {
            this.#dsp.excursionDepth = this.parameterExcursionDepth.getValue()
        } else if (parameter === this.parameterWet) {
            this.#dsp.wetGain = dbToGain(this.parameterWet.getValue())
        } else if (parameter === this.parameterDry) {
            this.#dsp.dryGain = dbToGain(this.parameterDry.getValue())
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})}`}
}