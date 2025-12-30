import {int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioEffectDeviceAdapter, BrickDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {AudioBuffer, dbToGain, gainToDb, Ramp} from "@opendaw/lib-dsp"
import {AudioProcessor} from "../../AudioProcessor"

const RELEASE_IN_SECONDS = 0.1
const LOOK_AHEAD_SECONDS = 0.005
// Magic headroom found empirically to make the limiter brick-wall
// Only tested for 5ms look-ahead
const MAGIC_HEADROOM = -0.41

export class BrickDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = BrickDeviceProcessor.ID++

    readonly #adapter: BrickDeviceBoxAdapter
    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster

    readonly parameterThreshold: AutomatableParameter<number>

    #source: Option<AudioBuffer> = Option.None
    #processed: boolean = false

    readonly #buffer: [Float32Array, Float32Array]
    readonly #releaseCoeff: number = 0.0
    readonly #lookAheadFrames: int = 0 | 0
    readonly #threshold: Ramp<number> = Ramp.linear(sampleRate, 0.1)

    #position: int = 0 | 0
    #envelope: number = 0.0
    #lookahead: boolean = true

    constructor(context: EngineContext, adapter: BrickDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
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
        this.#peaks.clear()
        this.#output.clear()
        this.eventInput.clear()
        this.#position = 0 | 0
        this.#envelope = 0.0
        this.#buffer[0].fill(0.0)
        this.#buffer[1].fill(0.0)
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
                if (this.#envelope < peak) {
                    this.#envelope = peak
                } else {
                    this.#envelope = peak + this.#releaseCoeff * (this.#envelope - peak)
                }
                const threshold = this.#threshold.moveAndGet()
                const gain = dbToGain(Math.min(0.0, threshold - gainToDb(this.#envelope)))
                    * dbToGain(MAGIC_HEADROOM - threshold)
                outL[i] = buffer0[this.#position] * gain
                outR[i] = buffer1[this.#position] * gain
                buffer0[this.#position] = inp0
                buffer1[this.#position] = inp1
                this.#position = (this.#position + 1) % frames
            }
        } else {
            for (let i = fromIndex; i < toIndex; i++) {
                const inp0 = srcL[i]
                const inp1 = srcR[i]
                const peak = Math.max(Math.abs(inp0), Math.abs(inp1))
                if (this.#envelope < peak) {
                    this.#envelope = peak
                } else {
                    this.#envelope = peak + this.#releaseCoeff * (this.#envelope - peak)
                }
                const threshold = this.#threshold.moveAndGet()
                const gain = dbToGain(Math.min(0.0, threshold - gainToDb(this.#envelope)))
                    * dbToGain(MAGIC_HEADROOM - threshold)
                outL[i] = inp0 * gain
                outR[i] = inp1 * gain
            }
        }
        this.#peaks.process(outL, outR, fromIndex, toIndex)
        this.#processed = true
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterThreshold) {
            this.#threshold.set(this.parameterThreshold.getValue(), this.#processed)
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})}`}
}
