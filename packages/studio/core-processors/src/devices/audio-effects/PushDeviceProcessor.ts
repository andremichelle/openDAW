import {int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioEffectDeviceAdapter, PushDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {AudioBuffer, dbToGain, gainToDb, Ramp} from "@opendaw/lib-dsp"
import {AudioProcessor} from "../../AudioProcessor"

const RELEASE_IN_SECONDS = 0.2
const LOOK_AHEAD_SECONDS = 0.005
const MAGIC_HEADROOM = -0.1

export class PushDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = PushDeviceProcessor.ID++

    readonly #adapter: PushDeviceBoxAdapter
    readonly #output: AudioBuffer
    readonly #inputPeaks: PeakBroadcaster
    readonly #outputPeaks: PeakBroadcaster

    readonly parameterThreshold: AutomatableParameter<number>
    readonly #buffer: [Float32Array, Float32Array]
    readonly #releaseCoeff: number
    readonly #lookAheadFrames: int
    readonly #threshold: Ramp<number> = Ramp.linear(sampleRate, 0.010)
    readonly #reductionValue = new Float32Array(1)

    #position: int = 0 | 0
    #envelope: number = 0.0
    #peakHold: number = 0.0
    #peakHoldCounter: int = 0 | 0
    #lookahead: boolean = true
    #processed: boolean = false
    #reductionMin: number = 0.0

    #source: Option<AudioBuffer> = Option.None

    constructor(context: EngineContext, adapter: PushDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#inputPeaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address.append(1)))
        this.#outputPeaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#releaseCoeff = Math.exp(-1.0 / (sampleRate * RELEASE_IN_SECONDS))
        this.#lookAheadFrames = Math.ceil(LOOK_AHEAD_SECONDS * sampleRate) | 0
        this.#buffer = [
            new Float32Array(this.#lookAheadFrames),
            new Float32Array(this.#lookAheadFrames)
        ]

        const {threshold} = adapter.namedParameter
        this.parameterThreshold = this.own(this.bindParameter(threshold))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing),
            context.broadcaster.broadcastFloats(adapter.address.append(0),
                this.#reductionValue, () => {
                    this.#reductionValue[0] = this.#reductionMin
                    this.#reductionMin = 0.0
                }),
            adapter.box.lookahead.catchupAndSubscribe(() => {
                this.#lookahead = adapter.box.lookahead.getValue()
                this.#position = 0 | 0
                this.#envelope = 0.0
            })
        )
        this.readAllParameters()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#processed = false
        this.#inputPeaks.clear()
        this.#outputPeaks.clear()
        this.#output.clear()
        this.eventInput.clear()
        this.#position = 0 | 0
        this.#envelope = 0.0
        this.#peakHold = 0.0
        this.#peakHoldCounter = 0 | 0
        this.#buffer[0].fill(0.0)
        this.#buffer[1].fill(0.0)
        this.#reductionMin = 0.0
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
        if (this.#lookahead) {
            const buffer = this.#buffer
            const frames = this.#lookAheadFrames
            const buffer0 = buffer[0]
            const buffer1 = buffer[1]
            for (let i = fromIndex; i < toIndex; i++) {
                const inp0 = srcL[i]
                const inp1 = srcR[i]
                const peak = Math.max(Math.abs(inp0), Math.abs(inp1))
                // Peak hold: track max peak for L samples (while it's in the lookahead buffer)
                if (peak > this.#peakHold) {
                    this.#peakHold = peak
                    this.#peakHoldCounter = this.#lookAheadFrames
                } else if (this.#peakHoldCounter > 0) {
                    this.#peakHoldCounter--
                } else {
                    this.#peakHold = peak
                }
                // Envelope ramps towards peak hold (not current peak)
                if (this.#envelope < this.#peakHold) {
                    this.#envelope = Math.min(this.#peakHold, this.#envelope + this.#peakHold / this.#lookAheadFrames)
                } else {
                    this.#envelope = this.#peakHold + this.#releaseCoeff * (this.#envelope - this.#peakHold)
                }
                const threshold = this.#threshold.moveAndGet()
                const reductionDb = Math.min(0.0, threshold - gainToDb(this.#envelope))
                const gain = dbToGain(reductionDb) * dbToGain(MAGIC_HEADROOM - threshold)
                const out0 = buffer0[this.#position] * gain
                const out1 = buffer1[this.#position] * gain
                outL[i] = out0
                outR[i] = out1
                buffer0[this.#position] = inp0
                buffer1[this.#position] = inp1
                this.#position = (this.#position + 1) % frames
                if (reductionDb < this.#reductionMin) {this.#reductionMin = reductionDb}
            }
        } else {
            for (let i = fromIndex; i < toIndex; i++) {
                const inp0 = srcL[i]
                const inp1 = srcR[i]
                const peak = Math.max(Math.abs(inp0), Math.abs(inp1))
                // Peak hold: track max peak for L samples (while it's in the lookahead buffer)
                if (peak > this.#peakHold) {
                    this.#peakHold = peak
                    this.#peakHoldCounter = this.#lookAheadFrames
                } else if (this.#peakHoldCounter > 0) {
                    this.#peakHoldCounter--
                } else {
                    this.#peakHold = peak
                }
                // Envelope ramps towards peak hold (not current peak)
                if (this.#envelope < this.#peakHold) {
                    this.#envelope = Math.min(this.#peakHold, this.#envelope + this.#peakHold / this.#lookAheadFrames)
                } else {
                    this.#envelope = this.#peakHold + this.#releaseCoeff * (this.#envelope - this.#peakHold)
                }
                const threshold = this.#threshold.moveAndGet()
                const reductionDb = Math.min(0.0, threshold - gainToDb(this.#envelope))
                const gain = dbToGain(reductionDb) * dbToGain(MAGIC_HEADROOM - threshold)
                const out0 = inp0 * gain
                const out1 = inp1 * gain
                outL[i] = out0
                outR[i] = out1
                if (reductionDb < this.#reductionMin) {this.#reductionMin = reductionDb}
            }
        }
        this.#inputPeaks.process(srcL, srcR, fromIndex, toIndex)
        this.#outputPeaks.process(outL, outR, fromIndex, toIndex)
        this.#processed = true
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterThreshold) {
            this.#threshold.set(this.parameterThreshold.getValue(), this.#processed)
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})}`}
}
