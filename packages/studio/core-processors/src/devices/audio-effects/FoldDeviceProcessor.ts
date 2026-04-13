import {int, Option, Terminable, UUID} from "@moises-ai/lib-std"
import {AudioEffectDeviceAdapter, FoldDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {AudioBuffer, dbToGain, Ramp, RenderQuantum, ResamplerStereo, StereoMatrix} from "@moises-ai/lib-dsp"
import {AudioProcessor} from "../../AudioProcessor"

const oversamplingValues = [2, 4, 8] as const
const maxOversampleFactor = 8 as const

export class FoldDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = FoldDeviceProcessor.ID++

    readonly #adapter: FoldDeviceBoxAdapter
    readonly #output: AudioBuffer
    readonly #buffer: StereoMatrix.Channels
    readonly #peaks: PeakBroadcaster

    readonly parameterDrive: AutomatableParameter<number>
    readonly parameterVolume: AutomatableParameter<number>

    #source: Option<AudioBuffer> = Option.None
    #processed: boolean = false

    // will be set in contructor callback: 'catchupAndSubscribe'
    #resampler!: ResamplerStereo
    #oversamplingFactor!: int
    #smoothInputGain!: Ramp<number>
    #smoothOutputGain!: Ramp<number>

    constructor(context: EngineContext, adapter: FoldDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#buffer = [
            new Float32Array(RenderQuantum * maxOversampleFactor),
            new Float32Array(RenderQuantum * maxOversampleFactor)]
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))

        const {drive, volume} = adapter.namedParameter
        this.parameterDrive = this.own(this.bindParameter(drive))
        this.parameterVolume = this.own(this.bindParameter(volume))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing),
            adapter.box.overSampling.catchupAndSubscribe(owner => {
                const factor = oversamplingValues[owner.getValue()]
                this.#resampler = new ResamplerStereo(factor)
                this.#smoothInputGain = Ramp.linear(sampleRate * factor)
                this.#smoothInputGain.set(dbToGain(this.parameterDrive.getValue()), this.#processed)
                this.#smoothOutputGain = Ramp.linear(sampleRate * factor)
                this.#smoothOutputGain.set(dbToGain(this.parameterVolume.getValue()), this.#processed)
                this.#oversamplingFactor = factor
            })
        )
        this.readAllParameters()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        console.debug("reset")
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

    processAudio({s0, s1}: Block): void {
        if (this.#source.isEmpty()) {return}
        this.#resampler.upsample(this.#source.unwrap().channels() as StereoMatrix.Channels, this.#buffer, s0, s1)
        const oversampledLength = (s1 - s0) * this.#oversamplingFactor
        const [oversampledL, oversampledR] = this.#buffer
        if (this.#smoothInputGain.isInterpolating() || this.#smoothOutputGain.isInterpolating()) {
            for (let i = 0; i < oversampledLength; i++) {
                const gain = this.#smoothOutputGain.moveAndGet()
                const amount = this.#smoothInputGain.moveAndGet()
                const sL = 0.25 * oversampledL[i] * amount + 0.25
                const sR = 0.25 * oversampledR[i] * amount + 0.25
                oversampledL[i] = 4.0 * (Math.abs(sL - Math.floor(sL + 0.5)) - 0.25) * gain
                oversampledR[i] = 4.0 * (Math.abs(sR - Math.floor(sR + 0.5)) - 0.25) * gain
            }
        } else {
            const gain = this.#smoothOutputGain.get()
            const amount = this.#smoothInputGain.get()
            for (let i = 0; i < oversampledLength; i++) {
                const sL = 0.25 * oversampledL[i] * amount + 0.25
                const sR = 0.25 * oversampledR[i] * amount + 0.25
                oversampledL[i] = 4.0 * (Math.abs(sL - Math.floor(sL + 0.5)) - 0.25) * gain
                oversampledR[i] = 4.0 * (Math.abs(sR - Math.floor(sR + 0.5)) - 0.25) * gain
            }
        }
        this.#resampler.downsample(this.#buffer, this.#output.channels() as StereoMatrix.Channels, s0, s1)
        this.#peaks.process(this.#output.getChannel(0), this.#output.getChannel(1), s0, s1)
        this.#processed = true
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterDrive) {
            this.#smoothInputGain.set(dbToGain(this.parameterDrive.getValue()), this.#processed)
        } else if (parameter === this.parameterVolume) {
            this.#smoothOutputGain.set(dbToGain(this.parameterVolume.getValue()), this.#processed)
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})`}
}