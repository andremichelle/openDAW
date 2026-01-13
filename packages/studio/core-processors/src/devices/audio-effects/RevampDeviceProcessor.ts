import {Arrays, int, Option, Terminable, UUID} from "@moises-ai/lib-std"
import {AudioAnalyser, AudioBuffer, BiquadCoeff, BiquadMono, BiquadProcessor, BiquadStack} from "@moises-ai/lib-dsp"
import {AudioEffectDeviceAdapter, RevampDeviceBoxAdapter} from "@moises-ai/studio-adapters"
import {EngineContext} from "../../EngineContext"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AudioProcessor} from "../../AudioProcessor"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"

export class RevampDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static ID: int = 0 | 0

    readonly #id: int = RevampDeviceProcessor.ID++

    readonly #adapter: RevampDeviceBoxAdapter
    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster
    readonly #audioAnalyser: AudioAnalyser
    readonly #spectrum: Float32Array

    readonly #biquadCoeff: ReadonlyArray<BiquadCoeff>
    readonly #biquadLowPassProcessors: [BiquadStack, BiquadStack]
    readonly #biquadHighPassProcessors: [BiquadStack, BiquadStack]
    readonly #biquadProcessors: Array<[BiquadProcessor, BiquadProcessor]>
    readonly #enabled: Array<boolean>
    readonly #parameterHighPassEnabled: AutomatableParameter<boolean>
    readonly #parameterHighPassFrequency: AutomatableParameter<number>
    readonly #parameterHighPassQ: AutomatableParameter<number>
    readonly #parameterHighPassOrder: AutomatableParameter<int>
    readonly #parameterLowShelfEnabled: AutomatableParameter<boolean>
    readonly #parameterLowShelfFrequency: AutomatableParameter<number>
    readonly #parameterLowShelfGain: AutomatableParameter<number>
    readonly #parameterLowBellEnabled: AutomatableParameter<boolean>
    readonly #parameterLowBellFrequency: AutomatableParameter<number>
    readonly #parameterLowBellGain: AutomatableParameter<number>
    readonly #parameterLowBellQ: AutomatableParameter<number>
    readonly #parameterMidBellEnabled: AutomatableParameter<boolean>
    readonly #parameterMidBellFrequency: AutomatableParameter<number>
    readonly #parameterMidBellGain: AutomatableParameter<number>
    readonly #parameterMidBellQ: AutomatableParameter<number>
    readonly #parameterHighBellEnabled: AutomatableParameter<boolean>
    readonly #parameterHighBellFrequency: AutomatableParameter<number>
    readonly #parameterHighBellGain: AutomatableParameter<number>
    readonly #parameterHighBellQ: AutomatableParameter<number>
    readonly #parameterHighShelfEnabled: AutomatableParameter<boolean>
    readonly #parameterHighShelfFrequency: AutomatableParameter<int>
    readonly #parameterHighShelfGain: AutomatableParameter<number>
    readonly #parameterLowPassEnabled: AutomatableParameter<boolean>
    readonly #parameterLowPassFrequency: AutomatableParameter<number>
    readonly #parameterLowPassQ: AutomatableParameter<number>
    readonly #parameterLowPassOrder: AutomatableParameter<number>

    #source: Option<AudioBuffer> = Option.None
    #needsSpectrum: boolean = false

    constructor(context: EngineContext, adapter: RevampDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#audioAnalyser = new AudioAnalyser()
        this.#spectrum = new Float32Array(this.#audioAnalyser.numBins())

        this.#biquadCoeff = Arrays.create(() => new BiquadCoeff(), 7)
        this.#biquadLowPassProcessors = [new BiquadStack(4), new BiquadStack(4)]
        this.#biquadHighPassProcessors = [new BiquadStack(4), new BiquadStack(4)]
        this.#biquadProcessors = [
            this.#biquadHighPassProcessors,
            [new BiquadMono(), new BiquadMono()],
            [new BiquadMono(), new BiquadMono()],
            [new BiquadMono(), new BiquadMono()],
            [new BiquadMono(), new BiquadMono()],
            [new BiquadMono(), new BiquadMono()],
            this.#biquadLowPassProcessors
        ]
        this.#enabled = Arrays.create(() => true, 7)

        const namedParameter = this.#adapter.namedParameter
        this.#parameterHighPassEnabled = this.own(this.bindParameter(namedParameter.highPass.enabled))
        this.#parameterHighPassQ = this.own(this.bindParameter(namedParameter.highPass.q))
        this.#parameterHighPassFrequency = this.own(this.bindParameter(namedParameter.highPass.frequency))
        this.#parameterHighPassOrder = this.own(this.bindParameter(namedParameter.highPass.order))
        this.#parameterLowShelfEnabled = this.own(this.bindParameter(namedParameter.lowShelf.enabled))
        this.#parameterLowShelfFrequency = this.own(this.bindParameter(namedParameter.lowShelf.frequency))
        this.#parameterLowShelfGain = this.own(this.bindParameter(namedParameter.lowShelf.gain))
        this.#parameterLowBellEnabled = this.own(this.bindParameter(namedParameter.lowBell.enabled))
        this.#parameterLowBellFrequency = this.own(this.bindParameter(namedParameter.lowBell.frequency))
        this.#parameterLowBellGain = this.own(this.bindParameter(namedParameter.lowBell.gain))
        this.#parameterLowBellQ = this.own(this.bindParameter(namedParameter.lowBell.q))
        this.#parameterMidBellEnabled = this.own(this.bindParameter(namedParameter.midBell.enabled))
        this.#parameterMidBellFrequency = this.own(this.bindParameter(namedParameter.midBell.frequency))
        this.#parameterMidBellGain = this.own(this.bindParameter(namedParameter.midBell.gain))
        this.#parameterMidBellQ = this.own(this.bindParameter(namedParameter.midBell.q))
        this.#parameterHighBellEnabled = this.own(this.bindParameter(namedParameter.highBell.enabled))
        this.#parameterHighBellFrequency = this.own(this.bindParameter(namedParameter.highBell.frequency))
        this.#parameterHighBellGain = this.own(this.bindParameter(namedParameter.highBell.gain))
        this.#parameterHighBellQ = this.own(this.bindParameter(namedParameter.highBell.q))
        this.#parameterHighShelfEnabled = this.own(this.bindParameter(namedParameter.highShelf.enabled))
        this.#parameterHighShelfFrequency = this.own(this.bindParameter(namedParameter.highShelf.frequency))
        this.#parameterHighShelfGain = this.own(this.bindParameter(namedParameter.highShelf.gain))
        this.#parameterLowPassEnabled = this.own(this.bindParameter(namedParameter.lowPass.enabled))
        this.#parameterLowPassFrequency = this.own(this.bindParameter(namedParameter.lowPass.frequency))
        this.#parameterLowPassQ = this.own(this.bindParameter(namedParameter.lowPass.q))
        this.#parameterLowPassOrder = this.own(this.bindParameter(namedParameter.lowPass.order))

        this.ownAll(
            context.registerProcessor(this),
            context.audioOutputBufferRegistry.register(adapter.address, this.#output, this.outgoing),
            context.broadcaster.broadcastFloats(adapter.spectrum, this.#spectrum, (hasSubscribers) => {
                this.#needsSpectrum = hasSubscribers
                if (!hasSubscribers) {return}
                this.#spectrum.set(this.#audioAnalyser.bins())
                this.#audioAnalyser.decay = true
            })
        )
        this.readAllParameters()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#peaks.clear()
        this.#output.clear()
        this.#biquadProcessors.forEach(pair => pair.forEach(processor => processor.reset()))
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

    processAudio(_block: Block, fromIndex: int, toIndex: int) {
        if (this.#source.isEmpty()) {return}
        const [outL, outR] = this.#output.channels()
        const input = this.#source.unwrap()
        if (this.#enabled.some(b => b)) {
            let [inpL, inpR] = input.channels()
            this.#biquadCoeff.forEach((coeff, index) => {
                if (this.#enabled[index]) {
                    const [fltL, fltR] = this.#biquadProcessors[index]
                    fltL.process(coeff, inpL, outL, fromIndex, toIndex)
                    fltR.process(coeff, inpR, outR, fromIndex, toIndex)
                    inpL = outL
                    inpR = outR
                }
            })
        } else {
            const [inpL, inpR] = input.channels()
            for (let i = fromIndex; i < toIndex; i++) {
                outL[i] = inpL[i]
                outR[i] = inpR[i]
            }
        }
        this.#peaks.process(outL, outR, fromIndex, toIndex)
        if (this.#needsSpectrum) {
            this.#audioAnalyser.process(outL, outR, fromIndex, toIndex)
        }
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.#parameterLowPassOrder) {
            const zeroBasedOrder = this.#parameterLowPassOrder.getValue()
            const order = zeroBasedOrder + 1
            this.#biquadLowPassProcessors[0].order = order
            this.#biquadLowPassProcessors[1].order = order
        } else if (parameter === this.#parameterHighPassOrder) {
            const zeroBasedOrder = this.#parameterHighPassOrder.getValue()
            const order = zeroBasedOrder + 1
            this.#biquadHighPassProcessors[0].order = order
            this.#biquadHighPassProcessors[1].order = order
        } else if (parameter === this.#parameterHighPassFrequency || parameter === this.#parameterHighPassQ) {
            const frequency = this.#parameterHighPassFrequency.getValue()
            const q = this.#parameterHighPassQ.getValue()
            this.#biquadCoeff[0].setHighpassParams(frequency / sampleRate, q)
        } else if (parameter === this.#parameterLowShelfFrequency || parameter === this.#parameterLowShelfGain) {
            const frequency = this.#parameterLowShelfFrequency.getValue()
            const gain = this.#parameterLowShelfGain.getValue()
            this.#biquadCoeff[1].setLowShelfParams(frequency / sampleRate, gain)
        } else if (parameter === this.#parameterLowBellFrequency || parameter === this.#parameterLowBellGain || parameter === this.#parameterLowBellQ) {
            const frequency = this.#parameterLowBellFrequency.getValue()
            const gain = this.#parameterLowBellGain.getValue()
            const q = this.#parameterLowBellQ.getValue()
            this.#biquadCoeff[2].setPeakingParams(frequency / sampleRate, q, gain)
        } else if (parameter === this.#parameterMidBellFrequency || parameter === this.#parameterMidBellGain || parameter === this.#parameterMidBellQ) {
            const frequency = this.#parameterMidBellFrequency.getValue()
            const gain = this.#parameterMidBellGain.getValue()
            const q = this.#parameterMidBellQ.getValue()
            this.#biquadCoeff[3].setPeakingParams(frequency / sampleRate, q, gain)
        } else if (parameter === this.#parameterHighBellFrequency || parameter === this.#parameterHighBellGain || parameter === this.#parameterHighBellQ) {
            const frequency = this.#parameterHighBellFrequency.getValue()
            const gain = this.#parameterHighBellGain.getValue()
            const q = this.#parameterHighBellQ.getValue()
            this.#biquadCoeff[4].setPeakingParams(frequency / sampleRate, q, gain)
        } else if (parameter === this.#parameterHighShelfFrequency || parameter === this.#parameterHighShelfGain) {
            const frequency = this.#parameterHighShelfFrequency.getValue()
            const gain = this.#parameterHighShelfGain.getValue()
            this.#biquadCoeff[5].setHighShelfParams(frequency / sampleRate, gain)
        } else if (parameter === this.#parameterLowPassFrequency || parameter === this.#parameterLowPassQ) {
            const frequency = this.#parameterLowPassFrequency.getValue()
            const q = this.#parameterLowPassQ.getValue()
            this.#biquadCoeff[6].setLowpassParams(frequency / sampleRate, q)
        } else if (parameter === this.#parameterHighPassEnabled) {
            this.#enabled[0] = this.#parameterHighPassEnabled.getValue()
        } else if (parameter === this.#parameterLowShelfEnabled) {
            this.#enabled[1] = this.#parameterLowShelfEnabled.getValue()
        } else if (parameter === this.#parameterLowBellEnabled) {
            this.#enabled[2] = this.#parameterLowBellEnabled.getValue()
        } else if (parameter === this.#parameterMidBellEnabled) {
            this.#enabled[3] = this.#parameterMidBellEnabled.getValue()
        } else if (parameter === this.#parameterHighBellEnabled) {
            this.#enabled[4] = this.#parameterHighBellEnabled.getValue()
        } else if (parameter === this.#parameterHighShelfEnabled) {
            this.#enabled[5] = this.#parameterHighShelfEnabled.getValue()
        } else if (parameter === this.#parameterLowPassEnabled) {
            this.#enabled[6] = this.#parameterLowPassEnabled.getValue()
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})`}
}