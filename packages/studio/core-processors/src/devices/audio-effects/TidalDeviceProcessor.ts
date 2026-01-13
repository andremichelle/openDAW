import {Bits, int, Option, Terminable, UUID} from "@moises-ai/lib-std"
import {TidalDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {Block, BlockFlag, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {AudioBuffer, Fraction, PPQN, Smooth, TidalComputer} from "@moises-ai/lib-dsp"
import {AudioProcessor} from "../../AudioProcessor"

export class TidalDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = TidalDeviceProcessor.ID++

    readonly #adapter: TidalDeviceBoxAdapter
    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #computer: TidalComputer
    readonly #smoothGainL: Smooth
    readonly #smoothGainR: Smooth

    readonly #pRate: AutomatableParameter<number>
    readonly #pDepth: AutomatableParameter<number>
    readonly #pSlope: AutomatableParameter<number>
    readonly #pSymmetry: AutomatableParameter<number>
    readonly #pOffset: AutomatableParameter<number>
    readonly #pChannelOffset: AutomatableParameter<number>

    #source: Option<AudioBuffer> = Option.None
    #needsUpdate: boolean = true
    #phase: number = 0.0

    constructor(context: EngineContext, adapter: TidalDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#computer = new TidalComputer()
        this.#smoothGainL = new Smooth(0.003, sampleRate)
        this.#smoothGainR = new Smooth(0.003, sampleRate)

        const {rate, depth, slope, symmetry, offset, channelOffset} = adapter.namedParameter

        this.#pRate = this.bindParameter(rate)
        this.#pDepth = this.bindParameter(depth)
        this.#pSlope = this.bindParameter(slope)
        this.#pSymmetry = this.bindParameter(symmetry)
        this.#pOffset = this.bindParameter(offset)
        this.#pChannelOffset = this.bindParameter(channelOffset)

        this.ownAll(
            context.broadcaster.broadcastFloat(adapter.address.append(0), () => this.#phase),
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing)
        )
        this.readAllParameters()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#phase = 0.0
        this.#needsUpdate = true
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
    adapter(): TidalDeviceBoxAdapter {return this.#adapter}

    processAudio({p0, bpm, flags}: Block, fromIndex: int, toIndex: int): void {
        if (this.#source.isEmpty()) {return}
        const input = this.#source.unwrap()
        const [inpL, inpR] = input.channels()
        const [outL, outR] = this.#output.channels()
        if (this.#needsUpdate) {
            this.#computer.set(this.#pDepth.getValue(), this.#pSlope.getValue(), this.#pSymmetry.getValue())
            this.#needsUpdate = false
        }
        const {RateFractions} = TidalDeviceBoxAdapter
        const delta = PPQN.samplesToPulses(1, bpm, sampleRate)
        const ratePulses = Fraction.toPPQN(RateFractions[this.#pRate.getValue()])
        const rateInvPulses = 1.0 / ratePulses
        const offset0 = this.#pOffset.getValue() / 360.0
        const offset1 = offset0 + this.#pChannelOffset.getValue() / 360.0
        for (let i = fromIndex; i < toIndex; i++) {
            const phaseL = (p0 + i * delta) * rateInvPulses + offset0
            const phaseR = (p0 + i * delta) * rateInvPulses + offset1
            outL[i] = inpL[i] * this.#smoothGainL.process(this.#computer.compute(phaseL - Math.floor(phaseL)))
            outR[i] = inpR[i] * this.#smoothGainR.process(this.#computer.compute(phaseR - Math.floor(phaseR)))
        }
        this.#peaks.process(outL, outR)
        if (Bits.every(flags, BlockFlag.transporting | BlockFlag.playing)) {
            this.#phase = (p0 + (toIndex - fromIndex) * delta) * rateInvPulses
        }
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.#pDepth || parameter === this.#pSlope || parameter === this.#pSymmetry) {
            this.#needsUpdate = true
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})`}
}