import {AudioEffectDeviceAdapter, DelayDeviceBoxAdapter, TempoRange} from "@opendaw/studio-adapters"
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

    readonly parameterPreSyncTimeLeft: AutomatableParameter<number>
    readonly parameterPreMillisTimeLeft: AutomatableParameter<number>
    readonly parameterPreSyncTimeRight: AutomatableParameter<number>
    readonly parameterPreMillisTimeRight: AutomatableParameter<number>
    readonly parameterDelay: AutomatableParameter<number>
    readonly parameterMillisTime: AutomatableParameter<number>
    readonly parameterFeedback: AutomatableParameter<number>
    readonly parameterCross: AutomatableParameter<number>
    readonly parameterLfoSpeed: AutomatableParameter<number>
    readonly parameterLfoDepth: AutomatableParameter<number>
    readonly parameterFilter: AutomatableParameter<number>
    readonly parameterDry: AutomatableParameter<number>
    readonly parameterWet: AutomatableParameter<number>

    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #delayLines: DelayDeviceDsp

    #source: Option<AudioBuffer> = Option.None

    #updateDelayTime: boolean = true
    #updatePreDelayTimeL: boolean = true
    #updatePreDelayTimeR: boolean = true

    constructor(context: EngineContext, adapter: DelayDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))

        const {namedParameter} = adapter
        this.parameterPreSyncTimeLeft = this.own(this.bindParameter(namedParameter.preSyncTimeLeft))
        this.parameterPreMillisTimeLeft = this.own(this.bindParameter(namedParameter.preMillisTimeLeft))
        this.parameterPreSyncTimeRight = this.own(this.bindParameter(namedParameter.preSyncTimeRight))
        this.parameterPreMillisTimeRight = this.own(this.bindParameter(namedParameter.preMillisTimeRight))
        this.parameterDelay = this.own(this.bindParameter(namedParameter.delay))
        this.parameterMillisTime = this.own(this.bindParameter(namedParameter.millisTime))
        this.parameterFeedback = this.own(this.bindParameter(namedParameter.feedback))
        this.parameterCross = this.own(this.bindParameter(namedParameter.cross))
        this.parameterLfoSpeed = this.own(this.bindParameter(namedParameter.lfoSpeed))
        this.parameterLfoDepth = this.own(this.bindParameter(namedParameter.lfoDepth))
        this.parameterFilter = this.own(this.bindParameter(namedParameter.filter))
        this.parameterDry = this.own(this.bindParameter(namedParameter.dry))
        this.parameterWet = this.own(this.bindParameter(namedParameter.wet))

        const {Fractions} = DelayDeviceBoxAdapter
        const maxFractionPPQN = Fraction.toPPQN(Fractions[Fractions.length - 1])
        const maxDelayFrames = PPQN.pulsesToSamples(maxFractionPPQN, TempoRange.min, sampleRate)
        const maxunsync = DelayDeviceBoxAdapter.MAX_MILLIS_TIME * 0.001 * sampleRate
        const maxLfoDepthFrames = DelayDeviceBoxAdapter.LFO_DEPTH_MAX * 0.001 * sampleRate
        const maxFrames = maxDelayFrames + maxunsync + maxLfoDepthFrames

        this.#delayLines = new DelayDeviceDsp(Math.ceil(maxFrames))

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
        const tempoChanged = Bits.some(flags, BlockFlag.bpmChanged)
        if (this.#updatePreDelayTimeL || tempoChanged) {
            const fractionIndex = this.parameterPreSyncTimeLeft.getValue()
            const fraction = DelayDeviceBoxAdapter.Fractions[fractionIndex]
            const sync = PPQN.pulsesToSamples(Fraction.toPPQN(fraction), bpm, sampleRate)
            const unsync = this.parameterPreMillisTimeLeft.getValue() * 0.001 * sampleRate
            this.#delayLines.preDelayLeftOffset = sync + unsync
            this.#updatePreDelayTimeL = false
        }
        if (this.#updatePreDelayTimeR || tempoChanged) {
            const fractionIndex = this.parameterPreSyncTimeRight.getValue()
            const fraction = DelayDeviceBoxAdapter.Fractions[fractionIndex]
            const sync = PPQN.pulsesToSamples(Fraction.toPPQN(fraction), bpm, sampleRate)
            const unsync = this.parameterPreMillisTimeRight.getValue() * 0.001 * sampleRate
            this.#delayLines.preDelayRightOffset = sync + unsync
            this.#updatePreDelayTimeR = false
        }
        if (this.#updateDelayTime || tempoChanged) {
            const offsetIndex = this.parameterDelay.getValue()
            const offsetInPulses = Fraction.toPPQN(DelayDeviceBoxAdapter.Fractions[offsetIndex])
            const sync = PPQN.pulsesToSamples(offsetInPulses, bpm, sampleRate)
            const unsync = this.parameterMillisTime.getValue() * 0.001 * sampleRate
            this.#delayLines.offset = sync + unsync
            this.#updateDelayTime = false
        }
        const source = this.#source.unwrap()
        const input = source.channels() as StereoMatrix.Channels
        const output = this.#output.channels() as StereoMatrix.Channels
        this.#delayLines.process(input, output, from, to)
        this.#peaks.process(output[0], output[1], from, to)
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterPreSyncTimeLeft || parameter === this.parameterPreMillisTimeLeft) {
            this.#updatePreDelayTimeL = true
        } else if (parameter === this.parameterPreSyncTimeRight || parameter === this.parameterPreMillisTimeRight) {
            this.#updatePreDelayTimeR = true
        } else if (parameter === this.parameterDelay || parameter === this.parameterMillisTime) {
            this.#updateDelayTime = true
        } else if (parameter === this.parameterFeedback) {
            this.#delayLines.feedback = this.parameterFeedback.getValue()
        } else if (parameter === this.parameterCross) {
            this.#delayLines.cross = this.parameterCross.getValue()
        } else if (parameter === this.parameterLfoSpeed) {
            this.#delayLines.lfoPhaseIncr = this.parameterLfoSpeed.getValue() / sampleRate
        } else if (parameter === this.parameterLfoDepth) {
            this.#delayLines.setLfoDepth(this.parameterLfoDepth.getValue() * 0.001 * sampleRate)
        } else if (parameter === this.parameterFilter) {
            this.#delayLines.filter = this.parameterFilter.getValue()
        } else if (parameter === this.parameterDry || parameter === this.parameterWet) {
            this.#delayLines.dry = dbToGain(this.parameterDry.getValue())
            this.#delayLines.wet = dbToGain(this.parameterWet.getValue())
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})}`}
}