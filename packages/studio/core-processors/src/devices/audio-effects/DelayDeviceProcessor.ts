import {AudioEffectDeviceAdapter, DelayDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {Bits, int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioBuffer, dbToGain, Event, Fraction, PPQN, StereoMatrix} from "@opendaw/lib-dsp"
import {EngineContext} from "../../EngineContext"
import {Block, BlockFlag, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AudioProcessor} from "../../AudioProcessor"
import {AutomatableParameter} from "../../AutomatableParameter"
import {DelayDeviceDsp} from "./DelayDeviceDsp"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"

export class DelayDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = DelayDeviceProcessor.ID++

    readonly #adapter: DelayDeviceBoxAdapter

    readonly parameterDelay: AutomatableParameter<number>
    readonly parameterFeedback: AutomatableParameter<number>
    readonly parameterCross: AutomatableParameter<number>
    readonly parameterFilter: AutomatableParameter<number>
    readonly parameterDry: AutomatableParameter<number>
    readonly parameterWet: AutomatableParameter<number>

    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #delayLines: DelayDeviceDsp

    #source: Option<AudioBuffer> = Option.None

    #updateDelayTime: boolean = true

    constructor(context: EngineContext, adapter: DelayDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))

        const {delay, feedback, cross, filter, dry, wet} = adapter.namedParameter
        this.parameterDelay = this.own(this.bindParameter(delay))
        this.parameterFeedback = this.own(this.bindParameter(feedback))
        this.parameterCross = this.own(this.bindParameter(cross))
        this.parameterFilter = this.own(this.bindParameter(filter))
        this.parameterDry = this.own(this.bindParameter(dry))
        this.parameterWet = this.own(this.bindParameter(wet))

        const maxFrames = PPQN.pulsesToSamples(Fraction.toPPQN(DelayDeviceBoxAdapter.OffsetFractions[0]), 30.0, sampleRate)
        const interpolationDuration = Math.floor(0.5 * sampleRate)
        this.#delayLines = new DelayDeviceDsp(maxFrames, interpolationDuration)

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing)
        )
        this.readAllParameters()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#output.clear()
        this.#delayLines.reset()
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

    processAudio({bpm, flags}: Block, from: number, to: number): void {
        if (this.#source.isEmpty()) {return}
        if (this.#updateDelayTime || Bits.some(flags, BlockFlag.tempoChanged)) {
            const offsetIndex = this.parameterDelay.getValue()
            const offsetInPulses = Fraction.toPPQN(DelayDeviceBoxAdapter.OffsetFractions[offsetIndex])
            this.#delayLines.offset = PPQN.pulsesToSamples(offsetInPulses, bpm, sampleRate)
            this.#updateDelayTime = false
        }
        const source = this.#source.unwrap()
        this.#delayLines.process(
            source.channels() as StereoMatrix.Channels,
            this.#output.channels() as StereoMatrix.Channels,
            from, to)
        this.#peaks.process(this.#output.getChannel(0), this.#output.getChannel(1), from, to)
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterDelay) {
            this.#updateDelayTime = true
        } else if (parameter === this.parameterFeedback) {
            this.#delayLines.feedback = this.parameterFeedback.getValue()
        } else if (parameter === this.parameterCross) {
            this.#delayLines.cross = this.parameterCross.getValue()
        } else if (parameter === this.parameterFilter) {
            this.#delayLines.filter = this.parameterFilter.getValue()
        } else if (parameter === this.parameterDry) {
            this.#delayLines.dry = dbToGain(this.parameterDry.getValue())
        } else if (parameter === this.parameterWet) {
            this.#delayLines.wet = dbToGain(this.parameterWet.getValue())
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})}`}
}