import {AudioEffectDeviceAdapter, CompressorDeviceBoxAdapter} from "@opendaw/studio-adapters"
import {int, Option, Terminable, UUID} from "@opendaw/lib-std"
import {AudioBuffer, dbToGain, Event, gainToDb, Ramp, RenderQuantum} from "@opendaw/lib-dsp"
import {EngineContext} from "../../EngineContext"
import {Block, Processor} from "../../processing"
import {PeakBroadcaster} from "../../PeakBroadcaster"
import {AudioProcessor} from "../../AudioProcessor"
import {AutomatableParameter} from "../../AutomatableParameter"
import {AudioEffectDeviceProcessor} from "../../AudioEffectDeviceProcessor"
import {
    decibelsToGain,
    DelayLine,
    GainComputer,
    LevelDetector,
    LookAhead,
    SmoothingFilter
} from "@opendaw/lib-dsp/ctagdrc"

/**
 * Ported from https://github.com/p-hlp/CTAGDRC
 * More information in 'packages/lib/dsp/src/ctagdrc/readme.md'
 */
export class CompressorDeviceProcessor extends AudioProcessor implements AudioEffectDeviceProcessor {
    static readonly PEAK_DECAY_PER_SAMPLE = Math.exp(-1.0 / (sampleRate * 0.500))
    static readonly REDUCTION_DECAY_PER_SAMPLE = RenderQuantum / sampleRate * 0.050

    static ID: int = 0 | 0

    readonly #id: int = CompressorDeviceProcessor.ID++
    readonly #adapter: CompressorDeviceBoxAdapter

    readonly parameterLookahead: AutomatableParameter<boolean>
    readonly parameterAutomakeup: AutomatableParameter<boolean>
    readonly parameterAutoattack: AutomatableParameter<boolean>
    readonly parameterAutorelease: AutomatableParameter<boolean>
    readonly parameterInputgain: AutomatableParameter<number>
    readonly parameterThreshold: AutomatableParameter<number>
    readonly parameterRatio: AutomatableParameter<number>
    readonly parameterKnee: AutomatableParameter<number>
    readonly parameterAttack: AutomatableParameter<number>
    readonly parameterRelease: AutomatableParameter<number>
    readonly parameterMakeup: AutomatableParameter<number>
    readonly parameterMix: AutomatableParameter<number>

    readonly #output: AudioBuffer
    readonly #peaks: PeakBroadcaster

    readonly #ballistics: LevelDetector
    readonly #gainComputer: GainComputer
    readonly #delay: DelayLine
    readonly #lookaheadProcessor: LookAhead
    readonly #smoothedAutoMakeup: SmoothingFilter

    readonly #sidechainSignal: Float32Array
    readonly #originalSignal: readonly [Float32Array, Float32Array]
    readonly #lookaheadDelay: number = 0.005
    readonly #editorValues: Float32Array
    readonly #smoothInputGain: Ramp<number>

    #source: Option<AudioBuffer> = Option.None
    #sideChain: Option<AudioBuffer> = Option.None

    #lookahead: boolean = false
    #automakeup: boolean = false
    #autoattack: boolean = false
    #autorelease: boolean = false
    #threshold: number = -10.0
    #ratio: number = 2.0
    #knee: number = 6.0
    #attack: number = 2.0
    #release: number = 140.0
    #makeup: number = 0.0
    #mix: number = 1.0

    #autoMakeup: number = 0.0

    #inpMax: number = 0.0
    #outMax: number = 0.0
    #redMin: number = 0.0

    #processing: boolean = false

    constructor(context: EngineContext, adapter: CompressorDeviceBoxAdapter) {
        super(context)

        this.#adapter = adapter
        this.#output = new AudioBuffer()
        this.#peaks = this.own(new PeakBroadcaster(context.broadcaster, adapter.address))
        this.#editorValues = new Float32Array([Number.NEGATIVE_INFINITY, 0.0, Number.NEGATIVE_INFINITY])
        this.#smoothInputGain = Ramp.linear(sampleRate)

        const {
            lookahead, automakeup, autoattack, autorelease,
            inputgain, threshold, ratio, knee, attack, release, makeup, mix
        } = adapter.namedParameter

        this.parameterLookahead = this.own(this.bindParameter(lookahead))
        this.parameterAutomakeup = this.own(this.bindParameter(automakeup))
        this.parameterAutoattack = this.own(this.bindParameter(autoattack))
        this.parameterAutorelease = this.own(this.bindParameter(autorelease))
        this.parameterInputgain = this.own(this.bindParameter(inputgain))
        this.parameterThreshold = this.own(this.bindParameter(threshold))
        this.parameterRatio = this.own(this.bindParameter(ratio))
        this.parameterKnee = this.own(this.bindParameter(knee))
        this.parameterAttack = this.own(this.bindParameter(attack))
        this.parameterRelease = this.own(this.bindParameter(release))
        this.parameterMakeup = this.own(this.bindParameter(makeup))
        this.parameterMix = this.own(this.bindParameter(mix))

        this.#ballistics = new LevelDetector(sampleRate)
        this.#gainComputer = new GainComputer()
        this.#delay = new DelayLine(sampleRate, 0.005, RenderQuantum, 2)
        this.#lookaheadProcessor = new LookAhead(sampleRate, this.#lookaheadDelay, RenderQuantum)
        this.#smoothedAutoMakeup = new SmoothingFilter(sampleRate)
        this.#smoothedAutoMakeup.setAlpha(0.03)

        this.#sidechainSignal = new Float32Array(RenderQuantum)
        this.#originalSignal = [
            new Float32Array(RenderQuantum),
            new Float32Array(RenderQuantum)
        ]

        this.ownAll(
            context.registerProcessor(this),
            context.broadcaster.broadcastFloats(adapter.address.append(0),
                this.#editorValues, (_hasSubscribers) => {
                    this.#editorValues[0] = gainToDb(this.#inpMax)
                    this.#editorValues[1] = this.#redMin
                    this.#editorValues[2] = gainToDb(this.#outMax)
                })
        )
        this.readAllParameters()
    }

    get incoming(): Processor {return this}
    get outgoing(): Processor {return this}

    reset(): void {
        this.#processing = false
        this.#output.clear()
        this.#peaks.clear()
        this.eventInput.clear()
        this.#sidechainSignal.fill(0.0)
        this.#originalSignal[0].fill(0.0)
        this.#originalSignal[1].fill(0.0)
        this.#autoMakeup = 0.0
        this.#inpMax = 0.0
        this.#outMax = 0.0
        this.#redMin = 0.0
    }

    get uuid(): UUID.Bytes {return this.#adapter.uuid}
    get audioOutput(): AudioBuffer {return this.#output}

    setAudioSource(source: AudioBuffer): Terminable {
        this.#source = Option.wrap(source)
        return {terminate: () => this.#source = Option.None}
    }

    setSideChainSource(source: AudioBuffer): Terminable {
        this.#sideChain = Option.wrap(source)
        return {terminate: () => this.#sideChain = Option.None}
    }

    index(): int {return this.#adapter.indexField.getValue()}
    adapter(): AudioEffectDeviceAdapter {return this.#adapter}

    handleEvent(_event: Event): void {}

    processAudio(_block: Block, from: int, to: int): void {
        if (this.#source.isEmpty()) return
        const source = this.#source.unwrap()

        const srcL = source.getChannel(0)
        const srcR = source.getChannel(1)
        const outL = this.#output.getChannel(0)
        const outR = this.#output.getChannel(1)

        for (let i = from; i < to; i++) {
            const g = this.#smoothInputGain.moveAndGet()
            const l = outL[i] = srcL[i] * g
            const r = outR[i] = srcR[i] * g
            const peak = Math.max(Math.abs(l), Math.abs(r))
            if (this.#inpMax <= peak) {
                this.#inpMax = peak
            } else {
                this.#inpMax *= CompressorDeviceProcessor.PEAK_DECAY_PER_SAMPLE
            }
        }

        // TODO If sideChain is connected use that to run the envelope follower instead of the input signal

        // Clear sidechain and original signal buffers
        this.#sidechainSignal.fill(0.0, from, to)

        // Get max L/R amplitude values and fill sidechain signal
        for (let i = from; i < to; i++) {
            this.#sidechainSignal[i] = Math.max(Math.abs(outL[i]), Math.abs(outR[i]))
        }

        // Calculate crest factor on max amplitude values
        this.#ballistics.processCrestFactor(this.#sidechainSignal, from, to)

        // Compute attenuation - converts sidechain from linear to logarithmic
        this.#gainComputer.applyCompressionToBuffer(this.#sidechainSignal, from, to)

        // Smooth attenuation - still logarithmic
        this.#ballistics.applyBallistics(this.#sidechainSignal, from, to)

        // Get minimum = max gain reduction from a sidechain signal
        for (let i = from; i < to; i++) {
            const peak = this.#sidechainSignal[i]
            if (this.#redMin >= peak) {
                this.#redMin = peak
            } else {
                this.#redMin += CompressorDeviceProcessor.REDUCTION_DECAY_PER_SAMPLE
            }
        }

        // Calculate auto makeup
        this.#autoMakeup = this.#calculateAutoMakeup(this.#sidechainSignal, from, to)

        // Do lookahead if enabled
        if (this.#lookahead) {
            // Delay input buffer
            this.#delay.process(this.#output, from, to)

            // Process sidechain (delay + gain reduction fade in)
            this.#lookaheadProcessor.process(this.#sidechainSignal, from, to)
        }

        // Add makeup gain and convert sidechain to a linear domain
        for (let i = from; i < to; i++) {
            this.#sidechainSignal[i] = decibelsToGain(
                this.#sidechainSignal[i] + this.#makeup + this.#autoMakeup
            )
        }

        // Copy buffer to the original signal for dry/wet mixing
        for (let i = from; i < to; i++) {
            this.#originalSignal[0][i] = outL[i]
            this.#originalSignal[1][i] = outR[i]
        }

        // Multiply attenuation with buffer - apply compression
        for (let i = from; i < to; i++) {
            outL[i] *= this.#sidechainSignal[i]
            outR[i] *= this.#sidechainSignal[i]
        }

        // Mix dry and wet signal
        for (let i = from; i < to; i++) {
            const l = outL[i] * this.#mix + this.#originalSignal[0][i] * (1.0 - this.#mix)
            const r = outR[i] * this.#mix + this.#originalSignal[1][i] * (1.0 - this.#mix)
            const peak = Math.max(Math.abs(l), Math.abs(r))
            if (this.#outMax <= peak) {
                this.#outMax = peak
            } else {
                this.#outMax *= CompressorDeviceProcessor.PEAK_DECAY_PER_SAMPLE
            }
            outL[i] = l
            outR[i] = r
        }

        this.#peaks.process(outL, outR, from, to)
        this.#processing = true
    }

    #calculateAutoMakeup(src: Float32Array, fromIndex: int, toIndex: int): number {
        let sum = 0.0
        for (let i = fromIndex; i < toIndex; i++) {
            sum += src[i]
        }
        this.#smoothedAutoMakeup.process(-sum / (toIndex - fromIndex))
        return this.#automakeup ? this.#smoothedAutoMakeup.getState() : 0.0
    }

    parameterChanged(parameter: AutomatableParameter): void {
        if (parameter === this.parameterLookahead) {
            this.#lookahead = this.parameterLookahead.getValue()
        } else if (parameter === this.parameterAutomakeup) {
            this.#automakeup = this.parameterAutomakeup.getValue()
        } else if (parameter === this.parameterAutoattack) {
            this.#autoattack = this.parameterAutoattack.getValue()
            this.#ballistics.setAutoAttack(this.#autoattack)
            if (!this.#autoattack) {
                this.#ballistics.setAttack(this.#attack * 0.001) // Convert ms to seconds
            }
        } else if (parameter === this.parameterAutorelease) {
            this.#autorelease = this.parameterAutorelease.getValue()
            this.#ballistics.setAutoRelease(this.#autorelease)
            if (!this.#autorelease) {
                this.#ballistics.setRelease(this.#release * 0.001) // Convert ms to seconds
            }
        } else if (parameter === this.parameterInputgain) {
            this.#smoothInputGain.set(dbToGain(this.parameterInputgain.getValue()), this.#processing)
        } else if (parameter === this.parameterThreshold) {
            this.#threshold = this.parameterThreshold.getValue()
            this.#gainComputer.setThreshold(this.#threshold)
        } else if (parameter === this.parameterRatio) {
            this.#ratio = this.parameterRatio.getValue()
            this.#gainComputer.setRatio(this.#ratio)
        } else if (parameter === this.parameterKnee) {
            this.#knee = this.parameterKnee.getValue()
            this.#gainComputer.setKnee(this.#knee)
        } else if (parameter === this.parameterAttack) {
            this.#attack = this.parameterAttack.getValue()
            if (!this.#autoattack) {
                this.#ballistics.setAttack(this.#attack * 0.001) // Convert ms to seconds
            }
        } else if (parameter === this.parameterRelease) {
            this.#release = this.parameterRelease.getValue()
            if (!this.#autorelease) {
                this.#ballistics.setRelease(this.#release * 0.001) // Convert ms to seconds
            }
        } else if (parameter === this.parameterMakeup) {
            this.#makeup = this.parameterMakeup.getValue()
        } else if (parameter === this.parameterMix) {
            this.#mix = this.parameterMix.getValue()
        }
    }

    toString(): string {return `{${this.constructor.name} (${this.#id})}`}
}